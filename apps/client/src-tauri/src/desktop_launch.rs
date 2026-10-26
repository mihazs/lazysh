//! Bounded desktop intents; original access owns delivery and authentication.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::{Host, SshError};
use serde::Serialize;
#[cfg(desktop)]
use std::ffi::OsString;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
#[cfg(desktop)]
use tauri::{Emitter, Manager};

pub(crate) const UNAVAILABLE: &str = "LOCAL_LAUNCH_UNAVAILABLE";
pub(crate) const HOST_MISSING: &str = "HOST_LAUNCH_MISSING";
pub(crate) const HOST_AMBIGUOUS: &str = "HOST_LAUNCH_AMBIGUOUS";
pub(crate) const HOST_CHANGED: &str = "HOST_LAUNCH_CHANGED";
pub(crate) const HOST_BUSY: &str = "HOST_LAUNCH_BUSY";
pub(crate) const HOST_INVALID: &str = "HOST_LAUNCH_INVALID";
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LaunchTarget {
    Directory(PathBuf),
    Host(String),
}
#[cfg(desktop)]
const USAGE: &str =
    "Use -dir PATH / --dir PATH or -host SAVED_ID / --host SAVED_ID alone. Multiplexer launch options are not supported yet.";

#[cfg(desktop)]
fn owned_flag(value: &str) -> bool {
    matches!(
        value.split('=').next(),
        Some("-dir" | "--dir" | "-host" | "--host" | "-mux" | "--mux")
    )
}

#[cfg(desktop)]
pub(crate) fn parse(
    args: impl IntoIterator<Item = OsString>,
    cwd: impl FnOnce() -> std::io::Result<PathBuf>,
) -> Result<Option<LaunchTarget>, String> {
    let mut args = args.into_iter().skip(1);
    let mut directory = None;
    let mut host = None;
    let mut legacy = false;
    while let Some(arg) = args.next() {
        // ASCII option boundaries remain recognizable even if an inline path
        // contains non-Unicode bytes. Never treat that request as legacy startup.
        let head = arg
            .as_encoded_bytes()
            .split(|byte| *byte == b'=')
            .next()
            .unwrap();
        if matches!(head, b"-mux" | b"--mux") {
            return Err(USAGE.into());
        }
        if matches!(head, b"-dir" | b"--dir" | b"-host" | b"--host") {
            if legacy || directory.is_some() || host.is_some() {
                return Err(USAGE.into());
            }
            let text = arg
                .to_str()
                .ok_or("Directory paths must be valid Unicode.")?;
            let value = match text.split_once('=') {
                Some((_, value)) => OsString::from(value),
                None => args.next().ok_or(USAGE)?,
            };
            let path = value
                .to_str()
                .ok_or("Directory paths must be valid Unicode.")?;
            if matches!(head, b"-host" | b"--host") {
                if path.is_empty() || path.len() > 100 || path.chars().any(char::is_control) {
                    return Err(
                        "Saved host IDs must contain 1–100 UTF-8 bytes without control characters."
                            .into(),
                    );
                }
                host = Some(path.to_owned());
                continue;
            }
            if path.is_empty() || path.len() > 4096 || path.contains('\0') {
                return Err("Directory paths must contain 1–4096 UTF-8 bytes without NUL.".into());
            }
            directory = Some(PathBuf::from(value));
        } else {
            if directory.is_some() || host.is_some() {
                return Err(USAGE.into());
            }
            // Preserve framework flags and existing desktop protocol ingress.
            legacy = true;
        }
    }
    if let Some(host) = host {
        return Ok(Some(LaunchTarget::Host(host)));
    }
    let Some(mut path) = directory else {
        return Ok(None);
    };
    #[cfg(windows)]
    if !path.is_absolute()
        && matches!(
            path.components().next(),
            Some(std::path::Component::Prefix(_))
        )
    {
        return Err("Directory paths with a drive prefix must be absolute.".into());
    }
    if path.is_relative() {
        path = cwd().map_err(|error| error.to_string())?.join(path);
    }
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let canonical = path
        .to_str()
        .ok_or("Directory paths must be valid Unicode.")?;
    if canonical.len() > 4096 {
        return Err("The resolved directory path exceeds 4096 UTF-8 bytes.".into());
    }
    if !path.is_dir() {
        return Err("The requested local directory is not a directory.".into());
    }
    Ok(Some(LaunchTarget::Directory(path)))
}

struct Intent {
    receipt: String,
    owner: Option<AccessLease>,
    target: LaunchTarget,
    prepared: Option<PreparedHost>,
    connecting: bool,
}
#[derive(Clone, Serialize)]
pub(crate) struct PreparedHost {
    pub(crate) hosts: Vec<Host>,
}
impl PreparedHost {
    pub(crate) fn check_host(&self, host: &Host) -> crate::ssh::Result<()> {
        if self.hosts.iter().any(|expected| {
            expected.id == host.id && expected.credential_binding() == host.credential_binding()
        }) {
            Ok(())
        } else {
            Err(SshError::new(HOST_CHANGED, HOST_CHANGED))
        }
    }
}
#[derive(Clone, Serialize)]
pub(crate) struct Notice {
    receipt: String,
}
#[derive(Default)]
struct Pending {
    intent: Option<Intent>,
    notice: Option<Notice>,
}
#[derive(Clone, Default)]
pub(crate) struct LaunchState(Arc<Mutex<Pending>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub(crate) directory_receipt: Option<String>,
    pub(crate) host_receipt: Option<String>,
    notice: Option<Notice>,
}
impl LaunchState {
    #[cfg(test)]
    pub(crate) fn queued_receipt(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .intent
            .as_ref()
            .map(|value| value.receipt.clone())
    }
    pub(crate) fn new(target: Option<LaunchTarget>) -> Self {
        Self(Arc::new(Mutex::new(Pending {
            intent: target.map(|target| Intent {
                receipt: uuid::Uuid::new_v4().to_string(),
                owner: None,
                target,
                prepared: None,
                connecting: false,
            }),
            notice: None,
        })))
    }
    fn owner(&self, receipt: &str, request: &AccessLease) -> Result<AccessLease, String> {
        if uuid::Uuid::parse_str(receipt).is_err() {
            return Err(UNAVAILABLE.into());
        }
        request.check().map_err(String::from)?;
        let owner = {
            let pending = self.0.lock().map_err(|_| UNAVAILABLE)?;
            pending
                .intent
                .as_ref()
                .filter(|value| value.receipt == receipt)
                .and_then(|value| value.owner.clone())
                .ok_or(UNAVAILABLE)?
        };
        if owner.generation() != request.generation() {
            return Err(UNAVAILABLE.into());
        }
        Ok(owner)
    }
    fn with_owned<T>(
        &self,
        receipt: &str,
        request: &AccessLease,
        action: impl FnOnce(&mut Option<Intent>) -> Result<T, String>,
    ) -> Result<T, String> {
        let owner = self.owner(receipt, request)?;
        owner
            .with_current(|| {
                let mut pending = self.0.lock().map_err(|_| UNAVAILABLE)?;
                if pending
                    .intent
                    .as_ref()
                    .is_none_or(|value| value.receipt != receipt)
                {
                    return Err(UNAVAILABLE.into());
                }
                action(&mut pending.intent)
            })
            .map_err(String::from)?
    }
    #[cfg(desktop)]
    pub(crate) fn claim(&self, receipt: &str, request: &AccessLease) -> Result<PathBuf, String> {
        self.with_owned(receipt, request, |pending| {
            if !matches!(pending.as_ref().unwrap().target, LaunchTarget::Directory(_)) {
                return Err(UNAVAILABLE.into());
            }
            match pending.take().unwrap().target {
                LaunchTarget::Directory(path) => Ok(path),
                _ => unreachable!(),
            }
        })
    }
    pub(crate) fn read(&self, access: &AccessLease) -> Result<Snapshot, String> {
        access
            .with_current(|| {
                let mut pending = self.0.lock().map_err(|_| UNAVAILABLE)?;
                if pending
                    .intent
                    .as_ref()
                    .and_then(|value| value.owner.as_ref())
                    .is_some_and(|owner| owner.generation() != access.generation())
                {
                    pending.intent = None;
                }
                let mut directory_receipt = None;
                let mut host_receipt = None;
                if let Some(intent) = pending
                    .intent
                    .as_mut()
                    .filter(|value| value.owner.is_none())
                {
                    intent.owner = Some(access.clone());
                    match intent.target {
                        LaunchTarget::Directory(_) => {
                            directory_receipt = Some(intent.receipt.clone())
                        }
                        LaunchTarget::Host(_) => host_receipt = Some(intent.receipt.clone()),
                    }
                }
                Ok(Snapshot {
                    directory_receipt,
                    host_receipt,
                    notice: pending.notice.clone(),
                })
            })
            .map_err(String::from)?
    }
    pub(crate) fn prepare_host(
        &self,
        state: &crate::ssh::AppState,
        receipt: &str,
        access: &AccessLease,
    ) -> Result<PreparedHost, String> {
        let id = self.with_owned(receipt, access, |pending| {
            let intent = pending.as_ref().unwrap();
            match &intent.target {
                LaunchTarget::Host(id) if intent.prepared.is_none() && !intent.connecting => {
                    Ok(id.clone())
                }
                _ => Err(HOST_BUSY.into()),
            }
        })?;
        // Host/config reads never hold the intent or access mutex. The final commit
        // checks original ownership again; connect checks this immutable material.
        let hosts = match state.launch_hosts(&id) {
            Ok(hosts) => hosts,
            Err(error) => {
                let _ = self.cancel(receipt, access);
                return Err(error);
            }
        };
        self.with_owned(receipt, access, |pending| {
            let intent = pending.as_mut().unwrap();
            if intent.prepared.is_some() || intent.connecting {
                return Err(HOST_BUSY.into());
            }
            let prepared = PreparedHost { hosts };
            intent.prepared = Some(prepared.clone());
            Ok(prepared)
        })
    }
    pub(crate) fn cancel(&self, receipt: &str, access: &AccessLease) -> Result<(), String> {
        if uuid::Uuid::parse_str(receipt).is_err() {
            return Err(UNAVAILABLE.into());
        }
        access.check().map_err(String::from)?;
        if self
            .0
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .intent
            .as_ref()
            .is_none_or(|intent| intent.receipt != receipt)
        {
            return Ok(());
        }
        self.with_owned(receipt, access, |pending| {
            *pending = None;
            Ok(())
        })
    }
    pub(crate) fn begin_host(
        &self,
        receipt: &str,
        access: &AccessLease,
        host_id: &str,
    ) -> crate::ssh::Result<HostAttempt> {
        let owner = self
            .owner(receipt, access)
            .map_err(|code| SshError::new(UNAVAILABLE, code))?;
        let prepared = self
            .with_owned(receipt, access, |pending| {
                let intent = pending.as_mut().unwrap();
                if !matches!(&intent.target,LaunchTarget::Host(id) if id==host_id) {
                    return Err(HOST_CHANGED.into());
                }
                if intent.connecting {
                    return Err(HOST_BUSY.into());
                }
                let prepared = intent.prepared.clone().ok_or(UNAVAILABLE)?;
                intent.connecting = true;
                Ok(prepared)
            })
            .map_err(launch_error)?;
        Ok(HostAttempt {
            state: self.clone(),
            receipt: receipt.into(),
            owner,
            prepared,
            finished: false,
        })
    }
    pub(crate) fn trust_binding(
        &self,
        receipt: &str,
        access: &AccessLease,
        host_id: &str,
    ) -> crate::ssh::Result<Host> {
        self.with_owned(receipt, access, |pending| {
            let intent = pending.as_ref().unwrap();
            if intent.connecting {
                return Err(HOST_BUSY.into());
            }
            intent
                .prepared
                .as_ref()
                .and_then(|value| value.hosts.iter().find(|host| host.id == host_id))
                .cloned()
                .ok_or_else(|| HOST_CHANGED.into())
        })
        .map_err(launch_error)
    }
    pub(crate) fn accepted_trust(
        &self,
        receipt: &str,
        access: &AccessLease,
        host: &Host,
        fingerprint: &str,
    ) -> crate::ssh::Result<()> {
        self.with_owned(receipt, access, |pending| {
            let intent = pending.as_mut().unwrap();
            if intent.connecting {
                return Err(HOST_BUSY.into());
            }
            let prepared = intent.prepared.as_mut().ok_or(UNAVAILABLE)?;
            for expected in &mut prepared.hosts {
                if expected.hostname == host.hostname && expected.port == host.port {
                    expected.fingerprint = Some(fingerprint.into());
                }
            }
            Ok(())
        })
        .map_err(launch_error)
    }
    #[cfg(desktop)]
    fn reject_secondary(&self, args: &[String]) -> bool {
        if !args.iter().skip(1).any(|arg| owned_flag(arg)) {
            return false;
        }
        if let Ok(mut pending) = self.0.lock() {
            pending.notice.get_or_insert_with(|| Notice {
                receipt: uuid::Uuid::new_v4().to_string(),
            });
        }
        true
    }
}
fn launch_error(code: String) -> SshError {
    let kind = match code.as_str() {
        HOST_MISSING => HOST_MISSING,
        HOST_AMBIGUOUS => HOST_AMBIGUOUS,
        HOST_CHANGED => HOST_CHANGED,
        HOST_BUSY => HOST_BUSY,
        HOST_INVALID => HOST_INVALID,
        _ => UNAVAILABLE,
    };
    SshError::new(kind, kind)
}
pub(crate) struct HostAttempt {
    state: LaunchState,
    receipt: String,
    owner: AccessLease,
    prepared: PreparedHost,
    finished: bool,
}
impl HostAttempt {
    pub(crate) fn check_host(&self, host: &Host) -> crate::ssh::Result<()> {
        self.owner
            .check()
            .map_err(|_| SshError::new(UNAVAILABLE, UNAVAILABLE))?;
        if !self
            .state
            .0
            .lock()
            .map_err(|_| SshError::new(UNAVAILABLE, UNAVAILABLE))?
            .intent
            .as_ref()
            .is_some_and(|intent| intent.receipt == self.receipt && intent.connecting)
        {
            return Err(SshError::new(UNAVAILABLE, UNAVAILABLE));
        }
        self.prepared.check_host(host)
    }
    pub(crate) fn finish(mut self) {
        if let Ok(mut pending) = self.state.0.lock() {
            if pending
                .intent
                .as_ref()
                .is_some_and(|intent| intent.receipt == self.receipt)
            {
                pending.intent = None;
            }
        }
        self.finished = true;
    }
}
impl Drop for HostAttempt {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let current = self.owner.check().is_ok();
        if let Ok(mut pending) = self.state.0.lock() {
            if let Some(intent) = pending
                .intent
                .as_mut()
                .filter(|intent| intent.receipt == self.receipt)
            {
                if current {
                    intent.connecting = false;
                } else {
                    pending.intent = None;
                }
            }
        }
    }
}
#[tauri::command]
pub(crate) fn desktop_launch_prepare_host(
    state: tauri::State<'_, LaunchState>,
    hosts: tauri::State<'_, crate::ssh::AppState>,
    receipt: String,
    access: AccessLease,
) -> Result<Guarded<PreparedHost>, GuardedError<String>> {
    access.run_sync(|| state.prepare_host(&hosts, &receipt, &access))
}
#[tauri::command]
pub(crate) fn desktop_launch_cancel(
    state: tauri::State<'_, LaunchState>,
    receipt: String,
    access: AccessLease,
) -> Result<Guarded<()>, GuardedError<String>> {
    access.run_sync(|| state.cancel(&receipt, &access))
}

#[cfg(desktop)]
pub(crate) fn secondary(app: &tauri::AppHandle, args: Vec<String>) {
    if app.state::<LaunchState>().reject_secondary(&args) {
        let _ = app.emit("lazysh-desktop-launch", ());
    }
}

#[tauri::command]
pub(crate) fn desktop_launch_read(
    state: tauri::State<'_, LaunchState>,
    access: AccessLease,
) -> Result<Guarded<Snapshot>, GuardedError<String>> {
    access.run_sync(|| state.read(&access))
}
#[tauri::command]
pub(crate) fn desktop_launch_ack(
    state: tauri::State<'_, LaunchState>,
    receipt: String,
    access: AccessLease,
) -> Result<Guarded<()>, GuardedError<String>> {
    access.run_sync(|| {
        if uuid::Uuid::parse_str(&receipt).is_err() {
            return Err(UNAVAILABLE.into());
        }
        access
            .with_current(|| {
                let mut pending = state.0.lock().map_err(|_| UNAVAILABLE.to_owned())?;
                if pending
                    .notice
                    .as_ref()
                    .is_some_and(|value| value.receipt == receipt)
                {
                    pending.notice = None;
                }
                Ok(())
            })
            .map_err(String::from)?
    })
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use crate::ssh::test_support::host_offer;
    fn arguments(values: &[&str]) -> Vec<OsString> {
        std::iter::once("lazysh")
            .chain(values.iter().copied())
            .map(OsString::from)
            .collect()
    }
    #[test]
    fn a_read_admitted_directory_is_not_passively_offered_after_revoke_before_claim() {
        use crate::ssh::test_support::{ready_lease, unlocked_access};
        let directory = tempfile::tempdir().unwrap();
        let state = LaunchState::new(Some(LaunchTarget::Directory(directory.path().to_owned())));
        let authority = unlocked_access();
        let original = ready_lease(&authority);
        let receipt = state.read(&original).unwrap().directory_receipt.unwrap();
        authority.lock().unwrap();
        authority
            .authorize(authority.generation().unwrap())
            .unwrap();
        let fresh = ready_lease(&authority);
        assert!(
            state.read(&fresh).unwrap().directory_receipt.is_none(),
            "a new lease must not automatically retry preparation for an old admitted request"
        );
        assert!(
            state.claim(&receipt, &fresh).is_err(),
            "the revoked admission must not remain claimable"
        );
    }
    fn saved_hosts(ids: &[&str]) -> (tempfile::TempDir, crate::ssh::AppState) {
        let dir = tempfile::tempdir().unwrap();
        let hosts:Vec<_>=ids.iter().map(|id|serde_json::json!({"id":id,"name":"Same display name","hostname":"example.invalid","port":22,"username":"tester"})).collect();
        std::fs::write(
            dir.path().join("hosts.json"),
            serde_json::to_vec(&hosts).unwrap(),
        )
        .unwrap();
        let state = crate::ssh::AppState::new(dir.path().into()).unwrap();
        (dir, state)
    }
    #[test]
    fn saved_host_arguments_are_opaque_bounded_and_never_resolve_as_directories() {
        for id in [
            "legacy=host 世界",
            "'$(touch NO);",
            "-option",
            &"a".repeat(100),
        ] {
            for args in [
                arguments(&["--host", id]),
                arguments(&[&format!("-host={id}")]),
            ] {
                assert_eq!(
                    parse(args, || panic!("host selection must not read cwd")).unwrap(),
                    Some(LaunchTarget::Host(id.into()))
                );
            }
        }
        for args in [
            vec!["--host"],
            vec!["--host="],
            vec!["--host", "a", "--host", "b"],
            vec!["--host", "a", "--dir", "."],
            vec!["--dir", ".", "--host", "a"],
            vec!["--mux", "tmux"],
            vec!["--host", "a", "--mux", "herdr"],
            vec!["lazysh://theme?data=YWJj", "--host", "a"],
            vec!["--host", "line\nbreak"],
            vec!["--host", &"x".repeat(101)],
        ] {
            assert!(
                parse(arguments(&args), || panic!(
                    "malformed selectors need no cwd"
                ))
                .is_err(),
                "{args:?}"
            );
        }
    }
    #[test]
    fn host_delivery_resolves_exactly_one_id_and_never_guesses_a_display_name() {
        use crate::ssh::test_support::{ready_lease, unlocked_access};
        let access = unlocked_access();
        let lease = ready_lease(&access);
        for (ids, requested, error) in [
            (vec!["one"], "missing", HOST_MISSING),
            (vec!["one"], "Same display name", HOST_MISSING),
            (vec!["one", "one"], "one", HOST_AMBIGUOUS),
        ] {
            let (_dir, hosts) = saved_hosts(&ids);
            let (launch, receipt) = host_offer(requested, &lease);
            assert_eq!(
                launch
                    .prepare_host(&hosts, &receipt, &lease)
                    .err()
                    .as_deref(),
                Some(error)
            );
            assert!(launch.read(&lease).unwrap().host_receipt.is_none());
            assert!(launch.begin_host(&receipt, &lease, requested).is_err());
        }
    }
    #[test]
    fn host_explicit_retry_busy_cancel_and_success_keep_one_original_owner() {
        use crate::ssh::test_support::{ready_lease, unlocked_access};
        let access = unlocked_access();
        let lease = ready_lease(&access);
        let (_dir, hosts) = saved_hosts(&["legacy=host 世界"]);
        let (launch, receipt) = host_offer("legacy=host 世界", &lease);
        let prepared = launch.prepare_host(&hosts, &receipt, &lease).unwrap();
        let host = &prepared.hosts[0];
        assert!(launch.prepare_host(&hosts, &receipt, &lease).is_err());
        assert!(launch.begin_host(&receipt, &lease, "different").is_err());
        let attempt = launch.begin_host(&receipt, &lease, &host.id).unwrap();
        assert!(launch.begin_host(&receipt, &lease, &host.id).is_err());
        attempt.check_host(host).unwrap();
        drop(attempt);
        let retry = launch.begin_host(&receipt, &lease, &host.id).unwrap();
        retry.finish();
        assert!(launch.begin_host(&receipt, &lease, &host.id).is_err());
        launch.cancel(&receipt, &lease).unwrap();
        assert!(launch.read(&lease).unwrap().host_receipt.is_none());
        let (cancelled, cancel_receipt) = host_offer(&host.id, &lease);
        cancelled
            .prepare_host(&hosts, &cancel_receipt, &lease)
            .unwrap();
        let pending = cancelled
            .begin_host(&cancel_receipt, &lease, &host.id)
            .unwrap();
        cancelled.cancel(&cancel_receipt, &lease).unwrap();
        assert!(pending.check_host(host).is_err());
        drop(pending);
        cancelled.cancel(&cancel_receipt, &lease).unwrap();
        assert!(cancelled.read(&lease).unwrap().host_receipt.is_none());
    }
    #[test]
    fn prepared_host_and_bastion_freeze_every_credential_binding_field() {
        use crate::ssh::test_support::{ready_lease, unlocked_access};
        let access = unlocked_access();
        let lease = ready_lease(&access);
        let (_dir, hosts) = saved_hosts(&["target", "jump"]);
        let mut target = hosts.host("target").unwrap();
        target.jump_host_id = Some("jump".into());
        // Existing save validation is exercised elsewhere; fixture metadata is
        // written before native preparation to establish one immutable route.
        let path = _dir.path().join("hosts.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&[target, hosts.host("jump").unwrap()]).unwrap(),
        )
        .unwrap();
        let hosts = crate::ssh::AppState::new(_dir.path().into()).unwrap();
        let (launch, receipt) = host_offer("target", &lease);
        let prepared = launch.prepare_host(&hosts, &receipt, &lease).unwrap();
        for original in &prepared.hosts {
            let value = serde_json::to_value(original).unwrap();
            for (field, changed) in [
                ("id", serde_json::json!("another")),
                ("hostname", serde_json::json!("other.invalid")),
                ("port", serde_json::json!(23)),
                ("username", serde_json::json!("another")),
                ("fingerprint", serde_json::json!("SHA256:changed")),
                ("jumpHostId", serde_json::json!("other-route")),
                ("forwardAgent", serde_json::json!(true)),
                ("biometricUnlock", serde_json::json!(true)),
            ] {
                let mut changed_host = value.clone();
                changed_host[field] = changed;
                let changed_host: Host = serde_json::from_value(changed_host).unwrap();
                assert!(prepared.check_host(&changed_host).is_err(), "{field}");
            }
            let mut preferences = original.clone();
            preferences.name = "Renamed display label".into();
            preferences.transport = Some(crate::ssh::Transport::Auto);
            preferences.credentials_stored = true;
            prepared.check_host(&preferences).unwrap();
        }
    }
    #[test]
    fn host_revoke_before_or_after_preparation_cannot_rebind_after_unlock() {
        use crate::ssh::test_support::{ready_lease, unlocked_access};
        for prepared in [false, true] {
            let access = unlocked_access();
            let lease = ready_lease(&access);
            let (_dir, hosts) = saved_hosts(&["one"]);
            let (launch, receipt) = host_offer("one", &lease);
            if prepared {
                launch.prepare_host(&hosts, &receipt, &lease).unwrap();
            }
            access.lock().unwrap();
            access.authorize(access.generation().unwrap()).unwrap();
            let fresh = ready_lease(&access);
            assert!(launch.prepare_host(&hosts, &receipt, &lease).is_err());
            assert!(launch.begin_host(&receipt, &fresh, "one").is_err());
            assert!(launch.read(&fresh).unwrap().host_receipt.is_none());
        }
    }
    #[test]
    fn literal_directory_forms_resolve_only_against_the_callers_directory() {
        let base = tempfile::tempdir().unwrap();
        let child = base.path().join(if cfg!(windows) {
            "project 世界 $(touch NO) & literal"
        } else {
            "project 世界 $(touch NO) \"); literal"
        });
        std::fs::create_dir(&child).unwrap();
        for flag in ["-dir", "--dir"] {
            let selected = parse(
                arguments(&[flag, child.file_name().unwrap().to_str().unwrap()]),
                || Ok(base.path().to_owned()),
            )
            .unwrap();
            assert_eq!(
                selected,
                Some(LaunchTarget::Directory(child.canonicalize().unwrap()))
            );
        }
        let joined = format!("--dir={}", child.display());
        assert_eq!(
            parse(arguments(&[&joined]), || panic!(
                "absolute paths need no caller cwd"
            ))
            .unwrap(),
            Some(LaunchTarget::Directory(child.canonicalize().unwrap()))
        );
        assert!(!base.path().join("NO").exists());
    }
    #[test]
    fn malformed_owned_invocations_and_bad_directories_fail_without_partial_intent() {
        for values in [
            vec!["--dir"],
            vec!["--dir="],
            vec!["--dir", ".", "--dir", "."],
            vec!["--dir", ".", "--mux=tmux"],
            vec!["--host", "saved", "--dir", "."],
            vec!["--mux", "herdr"],
            vec!["lazysh://theme?data=YWJj", "--dir", "."],
        ] {
            assert!(
                parse(arguments(&values), || Ok(PathBuf::from("/"))).is_err(),
                "{values:?}"
            );
        }
        let base = tempfile::tempdir().unwrap();
        let file = base.path().join("plain-file");
        std::fs::write(&file, b"fixture").unwrap();
        for path in [file, base.path().join("missing")] {
            assert!(parse(
                arguments(&["--dir", path.to_str().unwrap()]),
                || unreachable!()
            )
            .is_err());
        }
        assert!(
            parse(arguments(&["--dir", "."]), || Err(std::io::Error::from(
                std::io::ErrorKind::NotFound
            )))
            .is_err()
        );
        assert!(parse(arguments(&["--dir", &"a".repeat(4097)]), || unreachable!()).is_err());
    }
    #[test]
    fn no_owned_option_preserves_framework_and_protocol_ingress_without_reading_cwd() {
        for values in [
            vec![],
            vec!["--tauri-debug", "opaque"],
            vec!["lazysh://theme?data=YWJj"],
            vec!["-psn_0_123"],
        ] {
            assert!(parse(arguments(&values), || panic!(
                "legacy startup must not read cwd"
            ))
            .unwrap()
            .is_none());
        }
    }
    #[cfg(unix)]
    #[test]
    fn non_unicode_is_rejected_without_confusing_a_real_replacement_character_path() {
        use std::os::unix::ffi::OsStringExt;
        let base = tempfile::tempdir().unwrap();
        let unicode = base.path().join("project-�");
        std::fs::create_dir(&unicode).unwrap();
        assert_eq!(
            parse(
                arguments(&["--dir", unicode.to_str().unwrap()]),
                || unreachable!()
            )
            .unwrap(),
            Some(LaunchTarget::Directory(unicode.canonicalize().unwrap()))
        );
        let invalid = base
            .path()
            .join(OsString::from_vec(b"project-\xff".to_vec()));
        // The raw argument must fail before touching the filesystem. A real
        // replacement-character directory above exposes accidental lossy decoding.
        assert!(parse(
            [
                OsString::from("lazysh"),
                OsString::from("--dir"),
                invalid.into_os_string()
            ],
            || unreachable!()
        )
        .is_err());
        assert!(parse(
            [
                OsString::from("lazysh"),
                OsString::from_vec(b"--dir=project-\xff".to_vec())
            ],
            || unreachable!()
        )
        .is_err());
        let invalid_cwd = base.path().join(OsString::from_vec(b"cwd-\xff".to_vec()));
        // Keep actual invalid-byte cwd coverage on Linux. The macOS runner's
        // temporary filesystem rejects its creation with EILSEQ; the synthetic
        // invalid cwd must still fail closed there.
        #[cfg(target_os = "linux")]
        std::fs::create_dir(&invalid_cwd).unwrap();
        assert!(parse(arguments(&["--dir", "."]), || Ok(invalid_cwd)).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_rejects_drive_relative_and_non_unicode_paths_before_resolution() {
        use std::os::windows::ffi::OsStringExt;
        assert!(parse(arguments(&["--dir", "C:ambiguous"]), || panic!(
            "drive-relative paths are not supported"
        ))
        .is_err());
        let invalid = OsString::from_wide(&[0xd800]);
        assert!(parse(
            ["lazysh".into(), "--dir".into(), invalid],
            || unreachable!()
        )
        .is_err());
    }
    #[test]
    fn cold_receipt_is_one_shot_and_warm_arguments_never_choose_or_overwrite_a_path() {
        use crate::ssh::test_support::{ready_lease, unlocked_access};
        let base = tempfile::tempdir().unwrap();
        let state = LaunchState::new(Some(LaunchTarget::Directory(base.path().to_owned())));
        let authority = unlocked_access();
        let access = ready_lease(&authority);
        let receipt = state.read(&access).unwrap().directory_receipt.unwrap();
        for args in [
            vec!["lazysh", "--dir", "lossy-�"],
            vec!["lazysh", "--dir=/another/path"],
        ] {
            assert!(state.reject_secondary(&args.into_iter().map(String::from).collect::<Vec<_>>()));
            assert_eq!(state.queued_receipt().as_deref(), Some(receipt.as_str()));
            assert!(state.read(&access).unwrap().directory_receipt.is_none());
        }
        let notice = state.read(&access).unwrap().notice.unwrap().receipt;
        assert!(state.reject_secondary(&["lazysh".into(), "-dir=third".into()]));
        assert_eq!(state.read(&access).unwrap().notice.unwrap().receipt, notice);
        assert!(!state.reject_secondary(&["lazysh".into(), "lazysh://theme?data=YWJj".into()]));
        assert_eq!(state.claim(&receipt, &access).unwrap(), base.path());
        assert!(state.claim(&receipt, &access).is_err());
        assert!(state.read(&access).unwrap().directory_receipt.is_none());
    }
    #[test]
    fn a_revoked_original_lease_cannot_claim_a_directory_after_unlock() {
        use crate::ssh::test_support::{ready_lease, unlocked_access};
        let base = tempfile::tempdir().unwrap();
        let state = LaunchState::new(Some(LaunchTarget::Directory(base.path().to_owned())));
        let access = unlocked_access();
        let lease = ready_lease(&access);
        let receipt = state.read(&lease).unwrap().directory_receipt.unwrap();
        access.lock().unwrap();
        access.authorize(access.generation().unwrap()).unwrap();
        let fresh = ready_lease(&access);
        assert!(state.claim(&receipt, &lease).is_err());
        assert!(state.claim(&receipt, &fresh).is_err());
        assert!(state.read(&fresh).unwrap().directory_receipt.is_none());
    }
}
