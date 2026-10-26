//! One-shot desktop directory intent; paths never enter events or restoration.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use serde::Serialize;
#[cfg(desktop)]
use std::ffi::OsString;
use std::{path::PathBuf, sync::Mutex};
#[cfg(desktop)]
use tauri::{Emitter, Manager};

pub(crate) const UNAVAILABLE: &str = "LOCAL_LAUNCH_UNAVAILABLE";
#[cfg(desktop)]
const USAGE: &str =
    "Use -dir PATH or --dir PATH alone. Host and multiplexer launch options are not supported yet.";

#[cfg(desktop)]
fn directory_flag(value: &str) -> bool {
    matches!(value.split('=').next(), Some("-dir" | "--dir"))
}

#[cfg(desktop)]
pub(crate) fn parse(
    args: impl IntoIterator<Item = OsString>,
    cwd: impl FnOnce() -> std::io::Result<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    let mut args = args.into_iter().skip(1);
    let mut directory = None;
    let mut legacy = false;
    while let Some(arg) = args.next() {
        // ASCII option boundaries remain recognizable even if an inline path
        // contains non-Unicode bytes. Never treat that request as legacy startup.
        let head = arg
            .as_encoded_bytes()
            .split(|byte| *byte == b'=')
            .next()
            .unwrap();
        if matches!(head, b"-host" | b"--host" | b"-mux" | b"--mux") {
            return Err(USAGE.into());
        }
        if matches!(head, b"-dir" | b"--dir") {
            if legacy || directory.is_some() {
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
            if path.is_empty() || path.len() > 4096 || path.contains('\0') {
                return Err("Directory paths must contain 1–4096 UTF-8 bytes without NUL.".into());
            }
            directory = Some(PathBuf::from(value));
        } else {
            if directory.is_some() {
                return Err(USAGE.into());
            }
            // Preserve framework flags and existing desktop protocol ingress.
            legacy = true;
        }
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
    Ok(Some(path))
}

struct Directory {
    receipt: String,
    owner: Option<AccessLease>,
    #[cfg(desktop)]
    path: PathBuf,
}
#[derive(Clone, Serialize)]
pub(crate) struct Notice {
    receipt: String,
}
#[derive(Default)]
struct Pending {
    directory: Option<Directory>,
    notice: Option<Notice>,
}
#[derive(Default)]
pub(crate) struct LaunchState(Mutex<Pending>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub(crate) directory_receipt: Option<String>,
    notice: Option<Notice>,
}
impl LaunchState {
    #[cfg(test)]
    pub(crate) fn queued_receipt(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .directory
            .as_ref()
            .map(|value| value.receipt.clone())
    }
    pub(crate) fn new(path: Option<PathBuf>) -> Self {
        Self(Mutex::new(Pending {
            directory: path.map(|_path| Directory {
                receipt: uuid::Uuid::new_v4().to_string(),
                owner: None,
                #[cfg(desktop)]
                path: _path,
            }),
            notice: None,
        }))
    }
    #[cfg(desktop)]
    pub(crate) fn claim(&self, receipt: &str, request: &AccessLease) -> Result<PathBuf, String> {
        if uuid::Uuid::parse_str(receipt).is_err() {
            return Err(UNAVAILABLE.into());
        }
        request.check().map_err(String::from)?;
        // Clone under Pending, then release it before acquiring the authority.
        let owner = {
            let pending = self.0.lock().map_err(|_| UNAVAILABLE)?;
            pending
                .directory
                .as_ref()
                .filter(|value| value.receipt == receipt)
                .and_then(|value| value.owner.clone())
                .ok_or(UNAVAILABLE)?
        };
        if owner.generation() != request.generation() {
            return Err(UNAVAILABLE.into());
        }
        owner
            .with_current(|| {
                let mut pending = self.0.lock().map_err(|_| UNAVAILABLE)?;
                if pending
                    .directory
                    .as_ref()
                    .is_none_or(|value| value.receipt != receipt)
                {
                    return Err(UNAVAILABLE.into());
                }
                Ok(pending.directory.take().unwrap().path)
            })
            .map_err(String::from)?
    }
    pub(crate) fn read(&self, access: &AccessLease) -> Result<Snapshot, String> {
        access
            .with_current(|| {
                let mut pending = self.0.lock().map_err(|_| UNAVAILABLE)?;
                if pending
                    .directory
                    .as_ref()
                    .and_then(|value| value.owner.as_ref())
                    .is_some_and(|owner| owner.generation() != access.generation())
                {
                    pending.directory = None;
                }
                let directory_receipt = pending.directory.as_mut().and_then(|value| {
                    if value.owner.is_some() {
                        return None;
                    }
                    value.owner = Some(access.clone());
                    Some(value.receipt.clone())
                });
                Ok(Snapshot {
                    directory_receipt,
                    notice: pending.notice.clone(),
                })
            })
            .map_err(String::from)?
    }
    #[cfg(desktop)]
    fn reject_secondary(&self, args: &[String]) -> bool {
        if !args.iter().skip(1).any(|arg| directory_flag(arg)) {
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
        let state = LaunchState::new(Some(directory.path().to_owned()));
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
    #[test]
    fn literal_directory_forms_resolve_only_against_the_callers_directory() {
        let base = tempfile::tempdir().unwrap();
        let child = base.path().join("project 世界 $(touch NO) \"); literal");
        std::fs::create_dir(&child).unwrap();
        for flag in ["-dir", "--dir"] {
            let selected = parse(
                arguments(&[flag, child.file_name().unwrap().to_str().unwrap()]),
                || Ok(base.path().to_owned()),
            )
            .unwrap();
            assert_eq!(selected, Some(child.canonicalize().unwrap()));
        }
        let joined = format!("--dir={}", child.display());
        assert_eq!(
            parse(arguments(&[&joined]), || panic!(
                "absolute paths need no caller cwd"
            ))
            .unwrap(),
            Some(child.canonicalize().unwrap())
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
            vec!["--host", "saved"],
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
            Some(unicode.canonicalize().unwrap())
        );
        let invalid = base
            .path()
            .join(OsString::from_vec(b"project-\xff".to_vec()));
        std::fs::create_dir(&invalid).unwrap();
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
        let state = LaunchState::new(Some(base.path().to_owned()));
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
        let state = LaunchState::new(Some(base.path().to_owned()));
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
