//! Explicit companion installation and positive-Unix-only executable resolution.
use crate::{
    app_lock::{AccessLease, Guarded, GuardedError},
    ssh::{self, AppState, Result, Session, SshError},
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tauri::{ipc::Channel, State};
pub mod hooks;
pub(crate) mod install;
mod release;
mod resolve;
mod transfer;
/// A connection's positive-Unix probe result (see `resolve::detect`), shared by every companion command on it.
#[derive(Default)]
pub(crate) struct HostProbe(tokio::sync::OnceCell<Option<resolve::Unix>>);
impl HostProbe {
    /// Runs `probe` unless this connection already has an answer. Concurrent first callers share one probe.
    async fn resolve<F, Fut>(&self, probe: F) -> Result<Option<resolve::Unix>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<resolve::Probed>>,
    {
        let answer = self
            .0
            .get_or_try_init(|| async {
                match probe().await {
                    Ok(resolve::Probed::Known(host)) => Ok(host),
                    Ok(resolve::Probed::Unknown) => Err(None),
                    Err(error) => Err(Some(error)),
                }
            })
            .await;
        match answer {
            Ok(host) => Ok(host.clone()),
            Err(None) => Ok(None),
            Err(Some(error)) => Err(error),
        }
    }
}
pub(crate) async fn positive_unix(session: &Session, lease: &AccessLease) -> Result<bool> {
    Ok(resolve::detect(session, lease).await?.is_some())
}
fn error(kind: &'static str, message: &'static str) -> SshError {
    SshError::new(kind, message)
}
pub(crate) async fn command(
    session: &Session,
    command: String,
    lease: &AccessLease,
) -> Result<String> {
    match resolve::detect(session, lease).await? {
        Some(unix) => unix.command(&command),
        None => Ok(command),
    }
}
// Only a positively identified Unix shell classifies absent/older companions.
pub(crate) const USAGE_COMPANION_REQUIRED: &str = "lazysh-account-usage-companion-required-v1";
pub(crate) async fn account_usage_command(
    session: &Session,
    lease: &AccessLease,
) -> Result<String> {
    required_command(
        session,
        "lazysh-agent account-usage --watch-channel".into(),
        USAGE_COMPANION_REQUIRED,
        lease,
    )
    .await
}
pub(crate) async fn required_command(
    session: &Session,
    original: String,
    marker: &str,
    lease: &AccessLease,
) -> Result<String> {
    match resolve::detect(session, lease).await? {
        Some(unix) => {
            let resolved = unix.command(&original)?;
            let script=format!("{resolved} 2>/dev/null; code=$?; case $code in 2|126|127) printf '%s\\n' {};; *) exit \"$code\";; esac",ssh::quote(marker));
            Ok(format!("sh -c {}", ssh::quote(&script)))
        }
        None => Ok(original),
    }
}

pub(crate) async fn exec(
    session: &Session,
    original: String,
    lease: &AccessLease,
) -> Result<String> {
    ssh::exec_for_access(session, command(session, original, lease).await?, lease).await
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Detecting,
    CheckingRelease,
    Downloading,
    Uploading,
    Verifying,
    SelfTesting,
    Installing,
    CheckingInstalled,
    CleaningUp,
}
/// A stage change; `bytes` and `total` only accompany `downloading`, which the host reports.
#[derive(Clone, Serialize)]
pub struct Progress {
    stage: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}
impl Progress {
    fn new(stage: Stage) -> Self {
        Self {
            stage,
            bytes: None,
            total: None,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    schema_version: u8,
    status: &'static str,
    version: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    cleanup: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cleanup_failure: Option<transfer::CleanupFailure>,
}
#[derive(Debug, Serialize)]
pub struct InstallFailure {
    #[serde(flatten)]
    error: SshError,
    phase: Option<Stage>,
    /// Why the host failed, from a closed list; never remote text.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'static str>,
}
impl From<SshError> for InstallFailure {
    fn from(error: SshError) -> Self {
        Self {
            error,
            phase: None,
            detail: None,
        }
    }
}
/// Installs or updates the companion with the host doing the download: the phone sends only a pin.
#[tauri::command]
pub async fn install_companion(
    state: State<'_, AppState>,
    session_id: String,
    progress: Channel<Progress>,
    access: AccessLease,
) -> std::result::Result<Guarded<Installed>, GuardedError<InstallFailure>> {
    install_from(state, session_id, progress, access, install::Route::Host).await
}
/// The labelled offline fallback for hosts that cannot reach GitHub: this device downloads the
/// companion and uploads it over SFTP. Nothing else calls the device download.
#[tauri::command]
pub async fn install_companion_from_device(
    access: AccessLease,
    progress: Channel<Progress>,
    session_id: String,
    state: State<'_, AppState>,
) -> std::result::Result<Guarded<Installed>, GuardedError<InstallFailure>> {
    install_from(state, session_id, progress, access, install::Route::Device).await
}
/// Restores the previous companion the host kept, through the host's own `update --rollback`.
#[tauri::command]
pub async fn rollback_companion(
    progress: Channel<Progress>,
    access: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
) -> std::result::Result<Guarded<Installed>, GuardedError<InstallFailure>> {
    install_from(
        state,
        session_id,
        progress,
        access,
        install::Route::Rollback,
    )
    .await
}
/// Compares the installed companion with the latest verified release. Reads only; the phone fetches metadata.
#[tauri::command]
pub async fn check_companion_update(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<install::Checked>, GuardedError<SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            install::check(session, &access, &release::Publisher::new()?).await
        })
        .await
}
async fn install_from(
    state: State<'_, AppState>,
    session_id: String,
    progress: Channel<Progress>,
    access: AccessLease,
    route: install::Route,
) -> std::result::Result<Guarded<Installed>, GuardedError<InstallFailure>> {
    access
        .run(async {
            let session = state
                .session(&session_id)
                .await
                .map_err(InstallFailure::from)?;
            install::run(session, &access, progress, route).await
        })
        .await
}

/// An owned release fixture: `binary` published as `version`. The metadata is the fixture's; everything
/// the route then does to the host is real. It counts what the client was asked to fetch.
#[cfg(all(test, unix))]
pub(crate) struct Owned(release::Publisher);
#[cfg(all(test, unix))]
impl Owned {
    pub(crate) fn new(binary: &std::path::Path, version: &str) -> Self {
        Self(release::Publisher::owned(
            std::fs::read(binary).unwrap(),
            version.into(),
        ))
    }
    /// How often the client asked for release metadata.
    pub(crate) fn selects(&self) -> usize {
        self.0.calls.selects()
    }
    /// How often the client downloaded the companion itself: only the offline fallback may.
    pub(crate) fn downloads(&self) -> usize {
        self.0.calls.downloads()
    }
    pub(crate) async fn install(
        &self,
        session: Arc<Session>,
        lease: &AccessLease,
        route: install::Route,
    ) -> std::result::Result<Installed, InstallFailure> {
        install::run_with(
            session,
            lease,
            Channel::new(|_| Err(std::io::Error::other("owned retired observer").into())),
            &self.0,
            route,
        )
        .await
    }
}
#[cfg(all(test, unix))]
impl Owned {
    /// **Check for updates** against this fixture's release.
    pub(crate) async fn check(
        &self,
        session: Arc<Session>,
        lease: &AccessLease,
    ) -> Result<install::Checked> {
        install::check(session, lease, &self.0).await
    }
}
#[cfg(all(test, unix))]
impl InstallFailure {
    pub(crate) fn kind(&self) -> &str {
        self.error.kind()
    }
    pub(crate) fn detail(&self) -> Option<&'static str> {
        self.detail
    }
}
#[cfg(test)]
mod probe_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn linux() -> resolve::Unix {
        resolve::Unix {
            os: "linux",
            arch: "x64",
            uid: 1000,
            home: "/home/owner".into(),
            data: "/home/owner/.local/share".into(),
        }
    }
    async fn known(asked: &AtomicUsize, host: Option<resolve::Unix>) -> Result<resolve::Probed> {
        asked.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        Ok(resolve::Probed::Known(host))
    }
    #[tokio::test]
    async fn a_connection_is_probed_once_even_when_commands_start_together() {
        let (probe, asked) = (HostProbe::default(), AtomicUsize::new(0));
        let (a, b, c) = tokio::join!(
            probe.resolve(|| known(&asked, Some(linux()))),
            probe.resolve(|| known(&asked, Some(linux()))),
            probe.resolve(|| known(&asked, Some(linux())))
        );
        for answer in [a, b, c] {
            assert_eq!(answer.unwrap().unwrap().uid, 1000);
        }
        assert_eq!(
            probe
                .resolve(|| known(&asked, None))
                .await
                .unwrap()
                .unwrap()
                .home,
            "/home/owner"
        );
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn a_host_that_is_not_positive_unix_is_remembered_too() {
        let (probe, asked) = (HostProbe::default(), AtomicUsize::new(0));
        assert!(probe
            .resolve(|| known(&asked, None))
            .await
            .unwrap()
            .is_none());
        assert!(probe
            .resolve(|| known(&asked, Some(linux())))
            .await
            .unwrap()
            .is_none());
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn a_probe_that_did_not_answer_or_failed_is_asked_again() {
        let (probe, asked) = (HostProbe::default(), AtomicUsize::new(0));
        let unanswered = probe
            .resolve(|| async { Ok(resolve::Probed::Unknown) })
            .await;
        assert!(unanswered.unwrap().is_none());
        let failed = probe
            .resolve(|| async {
                Err::<resolve::Probed, _>(error("disconnected", "Session closed"))
            })
            .await;
        assert_eq!(failed.unwrap_err().kind(), "disconnected");
        assert!(probe
            .resolve(|| known(&asked, Some(linux())))
            .await
            .unwrap()
            .is_some());
        assert!(probe
            .resolve(|| known(&asked, None))
            .await
            .unwrap()
            .is_some());
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }
}
