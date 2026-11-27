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

        /// A `loginctl` that answers like logind does and records the arguments it was given.
        /// A child `sh` writes and closes the script: a descriptor opened by this test process could be
        /// inherited by a concurrent `fork` in this binary and make `exec` fail with ETXTBSY.
        fn fake(directory: &std::path::Path, session: &str, locked: &str) -> String {
            let path = directory.join("loginctl");
            let script = format!(
                "#!/bin/sh\necho \"$@\" >> '{log}'\n\
                 case \"$1\" in\n\
                 show-user) echo Display={session};;\n\
                 show-session) printf 'Remote=no\\nType=wayland\\nActive=yes\\nLockedHint={locked}\\n';;\n\
                 esac\n",
                log = directory.join("calls").display()
            );
            let written = Command::new("sh")
                .args([
                    "-c",
                    "printf '%s' \"$2\" > \"$1\" && chmod 700 \"$1\"",
                    "sh",
                ])
                .arg(&path)
                .arg(script)
                .status()
                .unwrap();
            assert!(written.success());
            path.to_str().unwrap().to_owned()
        }

        /// Asserts the verdict and, on a mismatch, names why the program could not answer.
        #[track_caller]
        fn assert_desktop(program: &str, expected: Desktop) {
            let actual = desktop(program, 1000);
            assert_eq!(
                actual,
                expected,
                "spawn: {:?}",
                Command::new(program).arg("show-user").output().map(|_| ())
            );
        }

        #[test]
        fn logind_hint_decides_and_an_unusable_answer_is_unknown() {
            let directory = tempfile::tempdir().unwrap();
            let unlocked = fake(directory.path(), "9", "no");
            assert_desktop(&unlocked, Desktop::Unlocked);
            let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
            assert!(calls.contains("show-user 1000 -p Display"));
            assert!(calls.contains("show-session 9 -p Type -p Remote -p Active -p LockedHint"));
            assert_desktop(&fake(directory.path(), "9", "yes"), Desktop::Locked);
            assert_desktop(&fake(directory.path(), "9", "maybe"), Desktop::Unknown);
            // No display session, or one shaped like an option, is never passed on.
            for session in ["", "-p", "9;rm"] {
                assert_desktop(&fake(directory.path(), session, "no"), Desktop::Unknown);
            }
            // A host without logind notifies.
            assert_eq!(desktop("/nonexistent/loginctl", 1000), Desktop::Unknown);
        }

        #[test]
        fn a_fresh_stub_runs_while_other_threads_spawn_processes() {
            // The spawner threads fork without pause, and in the shared test binary a fork can hold
            // another case's lock descriptor open, so the storm runs in a child of this binary.
            const STORM: &str = "LAZYSH_LOGIND_FORK_STORM";
            let name = "desktop_lock::logind::tests::a_fresh_stub_runs_while_other_threads_spawn_processes";
            if std::env::var_os(STORM).is_none() {
                let child = Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", name, "--test-threads=1"])
                    .env(STORM, "1")
                    .output()
                    .unwrap();
                let report = String::from_utf8_lossy(&child.stdout);
                assert!(child.status.success(), "{report}");
                assert!(
                    report.contains("1 passed"),
                    "the child ran no case: {report}"
                );
                return;
            }
            let busy = Arc::new(AtomicBool::new(true));
            let spawners: Vec<_> = (0..4)
                .map(|_| {
                    let busy = busy.clone();
                    std::thread::spawn(move || {
                        while busy.load(std::sync::atomic::Ordering::Relaxed) {
                            let _ = Command::new("true").status();
                        }
                    })
                })
                .collect();
            let directory = tempfile::tempdir().unwrap();
            for _ in 0..300 {
                assert_desktop(&fake(directory.path(), "9", "no"), Desktop::Unlocked);
            }
            busy.store(false, std::sync::atomic::Ordering::Relaxed);
            for spawner in spawners {
                spawner.join().unwrap();
            }
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
