//! One closed choice between the host's own Herdr and the managed derivative.
//!
//! A connection captures it once, on its first Herdr use, and every native call reads that capture:
//! discovery, list, tree and actions, SSH and Mosh startup, guard capabilities and RPCs, restoration
//! and the connection-owned actor. A second, different choice is refused and never re-resolved, and
//! no renderer value is an executable path or command.
use crate::{
    app_lock::AccessLease,
    ssh::{AccessResult, AppState, Result, Session, SshError, SshHandle},
};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HerdrBackend {
    /// The `herdr` the host's own PATH (or the official installer's directory) provides.
    #[default]
    System,
    /// The attributed derivative at its one fixed path, which never shadows the system Herdr.
    Managed,
}

/// Held by one SSH connection; a reconnect creates a new one and chooses again.
pub(crate) type Capture = std::sync::OnceLock<HerdrBackend>;

fn already_captured() -> SshError {
    SshError::new(
        "herdr_backend_captured",
        "This connection already uses the other Herdr. Reconnect to choose a different one.",
    )
}

fn unsupported_host() -> SshError {
    SshError::new(
        "herdr_managed_unsupported_host",
        "The managed Herdr runs only on a positively identified Linux or macOS host",
    )
}

impl HerdrBackend {
    pub(crate) fn is_system(&self) -> bool {
        matches!(self, Self::System)
    }
    /// `command`, whose `herdr` word runs as this backend, for a POSIX host.
    pub(crate) fn wrap(self, command: &str, positive_unix: bool) -> Result<String> {
        self.wrap_or(
            command,
            positive_unix,
            crate::herdr_path::MANAGED_UNAVAILABLE,
        )
    }
    /// Like [`Self::wrap`], with `unavailable` as the script that runs when the managed executable
    /// cannot be used; the system backend reports a missing Herdr itself.
    pub(crate) fn wrap_or(
        self,
        command: &str,
        positive_unix: bool,
        unavailable: &str,
    ) -> Result<String> {
        match (self, positive_unix) {
            (Self::System, _) => Ok(crate::herdr_path::select(command, positive_unix)),
            (Self::Managed, true) => Ok(crate::herdr_path::managed_with_path(command, unavailable)),
            (Self::Managed, false) => Err(unsupported_host()),
        }
    }
}

impl HerdrBackend {
    /// The script lines that make `herdr` mean this backend inside a larger `sh` script. Empty for
    /// the system Herdr, which is whatever `herdr` the host's own PATH already names.
    pub(crate) fn prelude(self, positive_unix: bool, unavailable: &str) -> Result<String> {
        match (self, positive_unix) {
            (Self::System, _) => Ok(String::new()),
            (Self::Managed, true) => Ok(crate::herdr_path::managed_script(unavailable)),
            (Self::Managed, false) => Err(unsupported_host()),
        }
    }
}

/// Fixes this connection's backend to `requested` unless it is already fixed to the other one.
pub(crate) fn capture(handle: &SshHandle, requested: HerdrBackend) -> Result<HerdrBackend> {
    match *handle.herdr_backend.get_or_init(|| requested) {
        backend if backend == requested => Ok(backend),
        _ => Err(already_captured()),
    }
}

/// The backend a call runs on: the one it names, captured now, or else the connection's own.
pub(crate) fn choose(handle: &SshHandle, requested: Option<HerdrBackend>) -> Result<HerdrBackend> {
    requested.map_or_else(|| Ok(captured(handle)), |backend| capture(handle, backend))
}

/// The connection's backend; a first use that chose nothing captures the system Herdr.
pub(crate) fn captured(handle: &SshHandle) -> HerdrBackend {
    *handle.herdr_backend.get_or_init(HerdrBackend::default)
}

/// `command` wrapped for this connection's backend once the host is known to be POSIX.
pub(crate) async fn resolve(
    session: &Session,
    lease: &AccessLease,
    command: &str,
) -> Result<String> {
    let backend = captured(&session.handle);
    backend.wrap(command, crate::herdr_path::admit(session, lease).await?)
}

/// Like [`resolve`] for a connection already admitted, as the guard's owned RPC channel is.
pub(crate) fn resolve_cached(handle: &SshHandle, command: &str) -> Result<String> {
    captured(handle).wrap(command, crate::herdr_path::cached(handle) == Some(true))
}

#[tauri::command]
pub async fn herdr_backend_select(
    state: State<'_, AppState>,
    session_id: String,
    backend: HerdrBackend,
    access: AccessLease,
) -> AccessResult<HerdrBackend> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            capture(&session.handle, backend)
        })
        .await
}

/// Two fake Herdr executables, the host's own and the managed one, so a test can tell which one a
/// composed command reaches. Each prints, and logs, its name and arguments.
#[cfg(all(test, unix))]
pub(crate) mod sandbox {
    use super::HerdrBackend;
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};

    /// Asserts, for each backend in turn, that every command runs only that backend's executable.
    pub(crate) fn assert_both_backends<S: AsRef<str>>(commands: &[S]) {
        let sandbox = Sandbox::new(true);
        for backend in [HerdrBackend::System, HerdrBackend::Managed] {
            sandbox.assert_reaches(backend, commands);
        }
    }

    pub(crate) struct Sandbox {
        _directory: tempfile::TempDir,
        home: String,
        path: String,
        log: std::path::PathBuf,
    }
    fn script(path: &std::path::Path, name: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = format!(
            "#!/bin/sh\nline=\"{name} $*\"\nprintf '%s\\n' \"$line\"\nprintf '%s\\n' \"$line\" >> \"$LAZYSH_FAKE_LOG\"\n"
        );
        fs::write(path, body).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    impl Sandbox {
        pub(crate) fn new(managed: bool) -> Self {
            let directory = tempfile::tempdir().unwrap();
            // macOS TMPDIR sits below a symlink, which the ownership walk rejects by design.
            let root = fs::canonicalize(directory.path()).unwrap();
            let home = root.join("home");
            fs::create_dir(&home).unwrap();
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
            script(&root.join("bin/herdr"), "system");
            if managed {
                script(&home.join(crate::herdr_path::MANAGED_EXECUTABLE), "managed");
            }
            Self {
                home: home.to_str().unwrap().into(),
                path: format!("{}:/usr/bin:/bin", root.join("bin").display()),
                log: root.join("invocations"),
                _directory: directory,
            }
        }
        /// Stdout and success of `command` run the way the SSH exec channel runs it.
        pub(crate) fn run(&self, backend: HerdrBackend, command: &str) -> (String, bool) {
            self.run_wrapped(&backend.wrap(command, true).unwrap())
        }
        /// The host environment of the sandbox for a command the caller starts itself.
        pub(crate) fn configure(&self, command: &mut Command) {
            command
                .env_clear()
                .env("HOME", &self.home)
                .env("PATH", &self.path)
                .env("LAZYSH_FAKE_LOG", &self.log);
        }
        pub(crate) fn run_wrapped(&self, wrapped: &str) -> (String, bool) {
            let mut command = Command::new("/bin/sh");
            self.configure(&mut command);
            let output = command.args(["-c", wrapped]).output().unwrap();
            (
                String::from_utf8(output.stdout).unwrap(),
                output.status.success(),
            )
        }
        pub(crate) fn managed_executable(&self) -> std::path::PathBuf {
            std::path::Path::new(&self.home).join(crate::herdr_path::MANAGED_EXECUTABLE)
        }
        /// The fake executables' invocations since the last call, oldest first.
        pub(crate) fn invocations(&self) -> Vec<String> {
            let log = fs::read_to_string(&self.log).unwrap_or_default();
            let _ = fs::remove_file(&self.log);
            log.lines().map(str::to_owned).collect()
        }
        /// Asserts every already wrapped command ran, and ran only the executable the backend names.
        pub(crate) fn assert_ran<S: AsRef<str>>(&self, backend: HerdrBackend, wrapped: &[S]) {
            let want = match backend {
                HerdrBackend::System => "system ",
                HerdrBackend::Managed => "managed ",
            };
            for command in wrapped {
                self.invocations();
                let (_, ok) = self.run_wrapped(command.as_ref());
                let ran = self.invocations();
                assert!(
                    ok && !ran.is_empty() && ran.iter().all(|line| line.starts_with(want)),
                    "{:?} ran {ran:?}",
                    command.as_ref()
                );
            }
        }
        /// [`Self::assert_ran`] for commands the backend still has to wrap.
        pub(crate) fn assert_reaches<S: AsRef<str>>(&self, backend: HerdrBackend, commands: &[S]) {
            let wrapped: Vec<String> = commands
                .iter()
                .map(|command| backend.wrap(command.as_ref(), true).unwrap())
                .collect();
            self.assert_ran(backend, &wrapped);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{sandbox::Sandbox, *};
    use std::{fs::Permissions, os::unix::fs::PermissionsExt};

    #[test]
    fn each_backend_runs_only_its_own_executable_even_from_a_nested_shell() {
        let sandbox = Sandbox::new(true);
        for command in [
            "herdr --version",
            "sh -c 'herdr --version'",
            "command herdr --version",
        ] {
            assert_eq!(
                sandbox.run(HerdrBackend::System, command),
                ("system --version\n".into(), true),
                "{command}"
            );
            assert_eq!(
                sandbox.run(HerdrBackend::Managed, command),
                ("managed --version\n".into(), true),
                "{command}"
            );
        }
    }

    #[test]
    fn a_missing_or_untrusted_managed_executable_never_falls_back_to_the_system_one() {
        let unusable = (String::new(), false);
        assert_eq!(
            Sandbox::new(false).run(HerdrBackend::Managed, "herdr --version"),
            unusable
        );
        let hostile = Sandbox::new(true);
        let executable = hostile.managed_executable();
        let mode = |bits| std::fs::set_permissions(&executable, Permissions::from_mode(bits));
        mode(0o777).unwrap();
        assert_eq!(
            hostile.run(HerdrBackend::Managed, "herdr --version"),
            unusable
        );
        mode(0o755).unwrap();
        let replacement = executable.with_file_name("elsewhere");
        std::fs::rename(&executable, &replacement).unwrap();
        std::os::unix::fs::symlink(&replacement, &executable).unwrap();
        assert_eq!(
            hostile.run(HerdrBackend::Managed, "herdr --version"),
            unusable
        );
    }

    #[test]
    fn an_unusable_managed_executable_runs_the_callers_own_fallback() {
        let wrapped = HerdrBackend::Managed
            .wrap_or(
                "printf 'herdr\\t1\\n'",
                true,
                "printf 'herdr\\t0\\n'; exit 0",
            )
            .unwrap();
        assert_eq!(
            Sandbox::new(false).run_wrapped(&wrapped),
            ("herdr\t0\n".into(), true)
        );
    }

    #[test]
    fn the_managed_backend_needs_a_positively_identified_unix_host() {
        assert_eq!(
            HerdrBackend::Managed
                .wrap("herdr --version", false)
                .unwrap_err()
                .kind(),
            "herdr_managed_unsupported_host"
        );
        assert_eq!(
            HerdrBackend::System.wrap("herdr --version", false).unwrap(),
            "herdr --version"
        );
    }

    #[test]
    fn the_choice_is_closed_to_two_names_and_carries_no_command() {
        assert_eq!(
            serde_json::from_str::<HerdrBackend>("\"managed\"").unwrap(),
            HerdrBackend::Managed
        );
        for rejected in [
            "\"/opt/herdr\"",
            "\"herdr\"",
            "\"Managed\"",
            "{\"path\":\"/x\"}",
            "7",
        ] {
            assert!(
                serde_json::from_str::<HerdrBackend>(rejected).is_err(),
                "{rejected}"
            );
        }
    }
}
