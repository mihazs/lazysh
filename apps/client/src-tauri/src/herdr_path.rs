//! Resolve Herdr in the remote command environment without changing normal PATH precedence.
use crate::ssh::quote;

// The official installer defaults to ~/.local/bin. Only admit that fallback on
// positively identified Unix hosts when the entire path is owner-controlled.
// A pre-existing PATH command always wins. No renderer value enters this script.
const ADMIT: &str = r#"
if ! command -v herdr >/dev/null 2>&1; then
  candidate_ok=1
  case ${HOME-} in ''|/|*[[:cntrl:]]*|*:*|*/./*|*/../*|*/.|*/..) candidate_ok=0;; /*) ;; *) candidate_ok=0;; esac
  case $(/usr/bin/uname -s 2>/dev/null) in Linux) stat_format=linux;; Darwin) stat_format=darwin;; *) candidate_ok=0;; esac
  uid=$(/usr/bin/id -u 2>/dev/null) || candidate_ok=0
  case "$uid" in ''|*[!0-9]*) candidate_ok=0;; esac
  info_for() {
    if [ "$stat_format" = linux ]; then /usr/bin/stat -c '%u %a %h' "$1" 2>/dev/null
    else /usr/bin/stat -f '%u %Lp %l' "$1" 2>/dev/null; fi
  }
  candidate="$HOME/.local/bin/herdr"
  path="$candidate"
  while [ "$candidate_ok" = 1 ] && [ "$path" != / ]; do
    [ ! -L "$path" ] || { candidate_ok=0; break; }
    if [ "$path" = "$candidate" ]; then [ -f "$path" ] && [ -x "$path" ] || candidate_ok=0
    else [ -d "$path" ] && [ -x "$path" ] || candidate_ok=0; fi
    info=$(info_for "$path") || { candidate_ok=0; break; }
    owner=${info%% *}; fields=${info#* }; mode=${fields%% *}; links=${fields#* }
    case "$owner" in ''|*[!0-9]*) candidate_ok=0; break;; esac
    case "$mode" in ''|*[!0-7]*) candidate_ok=0; break;; esac
    case "$links" in ''|*[!0-9]*) candidate_ok=0; break;; esac
    if [ "$path" = "$candidate" ]; then
      [ "$owner" = "$uid" ] && [ "$links" = 1 ] && [ "$((0$mode & 022))" = 0 ] || candidate_ok=0
    else
      [ "$owner" = "$uid" ] || [ "$owner" = 0 ] || candidate_ok=0
      if [ "$((0$mode & 022))" != 0 ]; then
        [ "$owner" = 0 ] && [ "$((0$mode & 01000))" != 0 ] || candidate_ok=0
      fi
    fi
    path=${path%/*}; [ -n "$path" ] || path=/
  done
  if [ "$candidate_ok" = 1 ]; then PATH="${PATH:+$PATH:}$HOME/.local/bin"; export PATH; fi
fi
"#;

fn check_live(
    session: &crate::ssh::Session,
    lease: &crate::app_lock::AccessLease,
) -> crate::ssh::Result<()> {
    lease.check()?;
    if *session.cancel.borrow() {
        return Err(crate::ssh::SshError::new("disconnected", "Session closed"));
    }
    Ok(())
}

// Per-SSH-handle host evidence: unknown until probed, then reused for the life
// of that connection. A reconnect creates a new handle and probes again.
const UNKNOWN: u8 = 0;
const UNIX: u8 = 1;
const NOT_UNIX: u8 = 2;

pub(crate) fn new_cache() -> std::sync::atomic::AtomicU8 {
    std::sync::atomic::AtomicU8::new(UNKNOWN)
}

/// The cached probe result for this SSH handle, if the host was already probed.
pub(crate) fn cached(handle: &crate::ssh::SshHandle) -> Option<bool> {
    match handle.herdr_unix.load(std::sync::atomic::Ordering::Acquire) {
        UNIX => Some(true),
        NOT_UNIX => Some(false),
        _ => None,
    }
}

pub(crate) async fn admit(
    session: &crate::ssh::Session,
    lease: &crate::app_lock::AccessLease,
) -> crate::ssh::Result<bool> {
    check_live(session, lease)?;
    if let Some(known) = cached(&session.handle) {
        return Ok(known);
    }
    let probed = crate::companion::positive_unix(session, lease).await;
    // Only a completed probe is cached; a transport error is retried next time.
    let definitive = probed.is_ok();
    let positive = optional_probe(probed)?;
    check_live(session, lease)?;
    if definitive {
        session.handle.herdr_unix.store(
            if positive { UNIX } else { NOT_UNIX },
            std::sync::atomic::Ordering::Release,
        );
    }
    Ok(positive)
}

fn optional_probe(result: crate::ssh::Result<bool>) -> crate::ssh::Result<bool> {
    match result {
        Err(error) if matches!(error.kind(), "cancelled" | "disconnected" | "app_locked") => {
            Err(error)
        }
        Err(_) => Ok(false),
        success => success,
    }
}

pub(crate) fn select(command: &str, positive_unix: bool) -> String {
    if positive_unix {
        with_path(command)
    } else {
        command.into()
    }
}

pub(crate) fn with_path(command: &str) -> String {
    format!("sh -c {}", quote(&format!("{ADMIT}\n{command}")))
}

#[cfg(all(test, unix))]
mod tests {
    use super::{optional_probe, select, with_path};
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};

    fn run(home: &str, path: &str, command: &str) -> std::process::Output {
        Command::new("/bin/sh")
            .args(["-c", &with_path(command)])
            .env_clear()
            .env("HOME", home)
            .env("PATH", path)
            .output()
            .unwrap()
    }
    fn executable(path: &std::path::Path, content: &str) {
        fs::write(path, content).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[test]
    fn optional_probe_falls_back_without_swallowing_retired_sessions() {
        use crate::ssh::SshError;
        assert!(!optional_probe(Err(SshError::new("ssh_error", "denied"))).unwrap());
        for kind in ["cancelled", "disconnected", "app_locked"] {
            assert_eq!(
                optional_probe(Err(SshError::new(kind, "retired")))
                    .unwrap_err()
                    .kind(),
                kind
            );
        }
        assert!(optional_probe(Ok(true)).unwrap());
    }
    #[test]
    fn unknown_or_non_unix_preserves_the_original_command() {
        let raw = "herdr --session 'literal' api snapshot";
        assert_eq!(select(raw, false), raw);
        assert_ne!(select(raw, true), raw);
    }
    #[test]
    fn trusted_default_is_found_after_path_and_hostile_paths_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        // macOS TMPDIR is below the /var -> /private/var symlink, which the
        // admission walk rejects by design; use the canonical directory.
        let home = fs::canonicalize(temp.path()).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let local = home.join(".local/bin");
        fs::create_dir_all(&local).unwrap();
        let fallback = local.join("herdr");
        executable(
            &fallback,
            "#!/bin/sh\nif [ \"${1-}\" = fd ]; then printf receipt >&3; else printf fallback; fi",
        );
        let home = home.to_str().unwrap();
        let result = run(home, "/usr/bin:/bin", "herdr --version");
        assert!(result.status.success());
        assert_eq!(result.stdout, b"fallback");
        let nested = run(home, "/usr/bin:/bin", "sh -c 'herdr --version'");
        assert!(nested.status.success());
        assert_eq!(nested.stdout, b"fallback");
        let fd = run(home, "/usr/bin:/bin", "herdr fd 3>&1");
        assert!(fd.status.success());
        assert_eq!(fd.stdout, b"receipt");
        let preferred = local.join("preferred");
        fs::create_dir(&preferred).unwrap();
        executable(&preferred.join("herdr"), "#!/bin/sh\nprintf preferred");
        let result = run(
            home,
            &format!("{}:/usr/bin:/bin", preferred.display()),
            "herdr --version",
        );
        assert!(result.status.success());
        assert_eq!(result.stdout, b"preferred");
        for invalid in [
            "relative",
            "/tmp/bad:segment",
            "/tmp/bad\nline",
            "/tmp/../home",
        ] {
            assert!(!run(invalid, "/usr/bin:/bin", "herdr --version")
                .status
                .success());
        }
        fs::set_permissions(&local, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!run(home, "/usr/bin:/bin", "herdr --version")
            .status
            .success());
        fs::set_permissions(&local, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_file(&fallback).unwrap();
        std::os::unix::fs::symlink(preferred.join("herdr"), &fallback).unwrap();
        assert!(!run(home, "/usr/bin:/bin", "herdr --version")
            .status
            .success());
    }
}
