//! Shared by the `update` test targets: a fake HTTPS release host beside an isolated user home, and
//! the real `lazysh-agent update` process. The binary is built with the `update-test-endpoint` seam.
use lazysh_companion_release::{
    fake::{Release, Server},
    TARGETS,
};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
#[cfg(unix)]
use std::{
    os::{fd::FromRawFd, unix::fs::PermissionsExt},
    ptr::{null, null_mut},
};

pub const THIS: &str = env!("CARGO_PKG_VERSION");
pub const BINARY: &[u8] = b"companion bytes";
pub const NAME: &str = if cfg!(windows) {
    "lazysh-agent.exe"
} else {
    "lazysh-agent"
};
pub const PREVIOUS: &str = if cfg!(windows) {
    "lazysh-agent.exe.previous"
} else {
    "lazysh-agent.previous"
};

pub struct Fixture {
    pub root: tempfile::TempDir,
    pub server: Server,
}
pub struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}
impl Run {
    pub fn lines(&self) -> Vec<Value> {
        self.stdout
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    pub fn result(&self) -> Value {
        let lines = self.lines();
        let last = lines.last().unwrap().clone();
        assert_eq!(last["event"], "result");
        assert_eq!(last["schemaVersion"], 1);
        assert_eq!(last["exitCode"], self.code);
        last
    }
    /// The `stage` names, in order, without repeats of `downloading`.
    pub fn stages(&self) -> Vec<String> {
        let mut stages = self
            .lines()
            .iter()
            .filter(|line| line["event"] == "stage")
            .map(|line| line["stage"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        stages.dedup();
        stages
    }
}
pub fn release(version: &str) -> Release {
    release_of(version, BINARY)
}
pub fn release_of(version: &str, bytes: &[u8]) -> Release {
    TARGETS
        .iter()
        .fold(Release::new(version), |release, target| {
            release.binary(target, bytes)
        })
}
/// A shell script that answers like a companion: its version, and the generic lifecycle round trip
/// the self-test performs. `--version` shows `shown` the first time only when `once` names a marker.
pub fn companion(version: &str) -> Vec<u8> {
    format!(
        r#"#!/bin/sh
case "$1" in
  --version) echo "lazysh-agent {version}" ;;
  ingest) mkdir -p "$LAZYSH_STATE_DIR" && cat > "$LAZYSH_STATE_DIR/event" ;;
  snapshot) [ -s "$LAZYSH_STATE_DIR/event" ] && echo '{{"schemaVersion":1,"sessions":[{{"sessionId":"lazysh-update-selftest"}}]}}' ;;
  *) exit 2 ;;
esac
"#
    )
    .into_bytes()
}
/// Names the host's `ls` would show, sorted.
pub fn listing(path: &Path) -> Vec<String> {
    let mut names = fs::read_dir(path)
        .map(|entries| {
            entries
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    names.sort();
    names
}
#[cfg(unix)]
/// A pseudo-terminal as (master, slave): a child given the slave as stdin sees a terminal, and bytes
/// written to the master are what it reads.
pub fn pty() -> (fs::File, fs::File) {
    let (mut master, mut slave) = (0, 0);
    // SAFETY: openpty fills in two descriptors that the returned files then own.
    unsafe {
        assert_eq!(
            libc::openpty(&mut master, &mut slave, null_mut(), null(), null()),
            0
        );
        (fs::File::from_raw_fd(master), fs::File::from_raw_fd(slave))
    }
}
#[cfg(unix)]
pub fn mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}
impl Fixture {
    pub fn new(releases: &[Release]) -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
            server: Server::start(releases.to_vec()),
        }
    }
    pub fn state(&self) -> PathBuf {
        self.root.path().join("state")
    }
    pub fn managed(&self) -> PathBuf {
        let data = if cfg!(target_os = "macos") {
            self.root.path().join("Library/Application Support")
        } else {
            self.root.path().join("data")
        };
        data.join("lazysh/companion")
    }
    pub fn command(&self, args: &[&str]) -> Command {
        self.command_of(Path::new(env!("CARGO_BIN_EXE_lazysh-agent")), args)
    }
    /// `program update <args>`, with the isolated home and the fake release host.
    pub fn command_of(&self, program: &Path, args: &[&str]) -> Command {
        let mut command = Command::new(program);
        command
            .env_clear()
            .args(["update"])
            .args(args)
            .env("HOME", self.root.path())
            .env("XDG_DATA_HOME", self.root.path().join("data"))
            .env("LAZYSH_STATE_DIR", self.state())
            .env("LAZYSH_UPDATE_TEST_ENDPOINT", &self.server.api)
            .env("LAZYSH_UPDATE_TEST_CA", self.root.path().join("ca.pem"))
            .stdin(std::process::Stdio::null());
        // Windows resolves the user data folder through the shell, so the seam names it instead.
        #[cfg(windows)]
        {
            command.env("LAZYSH_UPDATE_TEST_DATA_DIR", self.root.path().join("data"));
            if let Some(root) = std::env::var_os("SystemRoot") {
                command.env("SystemRoot", root);
            }
        }
        fs::write(self.root.path().join("ca.pem"), &self.server.ca_pem).unwrap();
        command
    }
    pub fn run(&self, args: &[&str]) -> Run {
        self.finish(self.command(args))
    }
    pub fn finish(&self, mut command: Command) -> Run {
        let output = command.output().unwrap();
        Run {
            code: output.status.code().unwrap(),
            stdout: String::from_utf8(output.stdout).unwrap(),
            stderr: String::from_utf8(output.stderr).unwrap(),
        }
    }
    /// An installed managed companion: a private directory holding one owner-only executable.
    pub fn managed_binary(&self, script: &[u8]) {
        let path = self.managed().join(NAME);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            mode(path.parent().unwrap(), 0o700);
            mode(&path, 0o700);
        }
    }
    pub fn installed(&self) -> Vec<u8> {
        fs::read(self.managed().join(NAME)).unwrap()
    }
    pub fn previous(&self) -> Option<Vec<u8>> {
        fs::read(self.managed().join(PREVIOUS)).ok()
    }
    /// The recorded `update-state.json`, if any.
    pub fn recorded(&self) -> Option<Value> {
        let path = self.state().join("update-state.json");
        fs::read(&path).ok().map(|bytes| {
            #[cfg(unix)]
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            serde_json::from_slice(&bytes).unwrap()
        })
    }
    /// Nothing under the isolated home, state or managed namespace was created.
    pub fn assert_untouched(&self) {
        assert_eq!(
            listing(self.root.path()),
            ["ca.pem"],
            "this run must not create state"
        );
    }
}
