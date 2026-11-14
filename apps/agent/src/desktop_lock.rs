//! Whether the user sits at an unlocked desktop on this host. Anything not known for certain is `Unknown`.
//! Only Linux (logind) is implemented; macOS and Windows report `Unknown`, so they always notify.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desktop {
    Unlocked,
    Locked,
    Unknown,
}

pub(crate) fn system() -> Desktop {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: geteuid has no preconditions.
        logind::desktop("loginctl", unsafe { libc::geteuid() })
    }
    #[cfg(not(target_os = "linux"))]
    Desktop::Unknown
}

#[cfg(target_os = "linux")]
mod logind {
    use super::Desktop;
    use std::{
        process::Command,
        sync::{atomic::AtomicBool, Arc},
        time::Duration,
    };

    fn value<'a>(output: &'a str, key: &str) -> Option<&'a str> {
        output
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
    }

    fn query(program: &str, arguments: &[&str]) -> Option<String> {
        let mut command = Command::new(program);
        command.args(arguments);
        let bytes = crate::devices::bounded_command(
            command,
            4096,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
        .ok()?;
        String::from_utf8(bytes).ok()
    }

    /// The graphical session logind names as this user's display, read through `program` (`loginctl`).
    /// Unlocked only for a local, active X11/Wayland/Mir session whose `LockedHint` is `no`. A remote or
    /// inactive session shows no desktop to this user, and a locker that never sets the hint reads as unlocked.
    pub(super) fn desktop(program: &str, uid: u32) -> Desktop {
        let Some(shown) = query(program, &["show-user", &uid.to_string(), "-p", "Display"]) else {
            return Desktop::Unknown;
        };
        let session = value(&shown, "Display").unwrap_or_default();
        // The id is passed to loginctl as an argument, so it must not look like an option.
        if session.is_empty()
            || session.len() > 32
            || !session.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Desktop::Unknown;
        }
        let properties = ["Type", "Remote", "Active", "LockedHint"];
        let mut arguments = vec!["show-session", session];
        for property in properties {
            arguments.extend(["-p", property]);
        }
        query(program, &arguments).map_or(Desktop::Unknown, |shown| classify(&shown))
    }

    fn classify(session: &str) -> Desktop {
        let graphical = matches!(value(session, "Type"), Some("x11" | "wayland" | "mir"));
        if !graphical
            || value(session, "Remote") != Some("no")
            || value(session, "Active") != Some("yes")
        {
            return Desktop::Unknown;
        }
        match value(session, "LockedHint") {
            Some("no") => Desktop::Unlocked,
            Some("yes") => Desktop::Locked,
            _ => Desktop::Unknown,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// A `loginctl` that answers like logind does and records the arguments it was given.
        fn fake(directory: &std::path::Path, session: &str, locked: &str) -> String {
            let path = directory.join("loginctl");
            std::fs::write(
                &path,
                format!(
                    "#!/bin/sh\necho \"$@\" >> '{log}'\n\
                     case \"$1\" in\n\
                     show-user) echo Display={session};;\n\
                     show-session) printf 'Remote=no\\nType=wayland\\nActive=yes\\nLockedHint={locked}\\n';;\n\
                     esac\n",
                    log = directory.join("calls").display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            path.to_str().unwrap().to_owned()
        }

        #[test]
        fn logind_hint_decides_and_an_unusable_answer_is_unknown() {
            let directory = tempfile::tempdir().unwrap();
            let unlocked = fake(directory.path(), "9", "no");
            assert_eq!(desktop(&unlocked, 1000), Desktop::Unlocked);
            let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
            assert!(calls.contains("show-user 1000 -p Display"));
            assert!(calls.contains("show-session 9 -p Type -p Remote -p Active -p LockedHint"));
            assert_eq!(
                desktop(&fake(directory.path(), "9", "yes"), 1000),
                Desktop::Locked
            );
            assert_eq!(
                desktop(&fake(directory.path(), "9", "maybe"), 1000),
                Desktop::Unknown
            );
            // No display session, or one shaped like an option, is never passed on.
            for session in ["", "-p", "9;rm"] {
                assert_eq!(
                    desktop(&fake(directory.path(), session, "no"), 1000),
                    Desktop::Unknown
                );
            }
            // A host without logind notifies.
            assert_eq!(desktop("/nonexistent/loginctl", 1000), Desktop::Unknown);
        }

        #[test]
        fn only_a_local_active_graphical_session_can_be_unlocked() {
            let session = |kind, remote, active| {
                classify(&format!(
                    "Type={kind}\nRemote={remote}\nActive={active}\nLockedHint=no\n"
                ))
            };
            assert_eq!(session("x11", "no", "yes"), Desktop::Unlocked);
            assert_eq!(session("tty", "no", "yes"), Desktop::Unknown);
            assert_eq!(session("wayland", "yes", "yes"), Desktop::Unknown);
            assert_eq!(session("wayland", "no", "no"), Desktop::Unknown);
            assert_eq!(classify("LockedHint=no\n"), Desktop::Unknown);
        }
    }
}
