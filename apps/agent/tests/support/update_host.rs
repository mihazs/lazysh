//! The real `lazysh-agent` as an old companion on a host with an isolated home, beside a fake HTTPS
//! release server: what the app-driven and the scheduled update tests run against. Linux only: the
//! old companion is this build stripped to a publishable size, which macOS cannot run again once its
//! signature is gone. Built with the `update-test-endpoint` seam.
pub use self::fixture::{companion, release_of, NAME};
use self::fixture::{mode, Fixture};
use lazysh_companion_release::fake::Release;
#[path = "update_fixture.rs"]
#[allow(dead_code)]
pub mod fixture;
#[path = "update_stub.rs"]
#[allow(dead_code)]
pub mod stub;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

pub const NEW: &str = "99.0.0";

/// The real agent stripped under the 64 MiB publication cap: what `update` agrees to install over.
fn old_companion() -> &'static [u8] {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    BYTES.get_or_init(|| {
        let scratch = tempfile::tempdir().unwrap();
        let copy = scratch.path().join("lazysh-agent");
        fs::copy(env!("CARGO_BIN_EXE_lazysh-agent"), &copy).unwrap();
        assert!(Command::new("strip").arg(&copy).status().unwrap().success());
        let bytes = fs::read(copy).unwrap();
        assert!(bytes.len() <= 64 << 20, "a stripped build is under the cap");
        bytes
    })
}
/// Run `command` with `stdin`. A binary that was written a moment ago can still be held open by a
/// sibling test's fork, which makes it briefly busy to execute.
fn exec(mut command: Command, stdin: &[u8]) -> Output {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = (0..100)
        .find_map(|_| match command.spawn() {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                thread::sleep(Duration::from_millis(50));
                None
            }
            result => Some(result.unwrap()),
        })
        .expect("the binary stayed busy");
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

/// What a scheduled check that has just run leaves in `update-state.json`.
pub fn recent_check() -> Value {
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    json!({"at":at,"latest":null,"available":false,"error":null})
}

/// A host whose managed companion is the real binary under test (an old one next to `NEW`).
pub struct Host {
    pub fixture: Fixture,
    pub old: Vec<u8>,
    /// Tools of the system the companion may call, ahead of the system's own, when a test stands one in.
    pub tools: Option<PathBuf>,
}
impl Host {
    /// A host that was checked a moment ago, so only a newer app can ask for an update now.
    pub fn with(releases: &[Release]) -> Self {
        let host = Self::due_with(releases);
        host.write_state(
            "update-state.json",
            &json!({"schemaVersion":1,"lastCheck":recent_check()}),
        );
        host
    }
    pub fn new() -> Self {
        Self::with(&[release_of(NEW, &companion(NEW))])
    }
    /// A host nothing has checked yet: a scheduled check is due.
    pub fn due_with(releases: &[Release]) -> Self {
        let fixture = Fixture::new(releases);
        let old = old_companion().to_vec();
        fixture.managed_binary(&old);
        fs::write(fixture.root.path().join("ca.pem"), &fixture.server.ca_pem).unwrap();
        Self {
            fixture,
            old,
            tools: None,
        }
    }
    pub fn due() -> Self {
        Self::due_with(&[release_of(NEW, &companion(NEW))])
    }
    pub fn state(&self) -> PathBuf {
        self.fixture.state()
    }
    /// `lazysh-agent <args>` as the app would run it on the host: the managed companion, the app's
    /// version in the environment when there is one.
    pub fn run(&self, app: Option<&str>, args: &[&str]) -> Output {
        self.run_with(app, args, b"")
    }
    pub fn run_with(&self, app: Option<&str>, args: &[&str], stdin: &[u8]) -> Output {
        let mut command = Command::new(self.fixture.managed().join(NAME));
        command.env_clear().args(args).envs(self.environment(app));
        exec(command, stdin)
    }
    /// What the app's exec leaves in the companion's environment on the host.
    pub fn environment(&self, app: Option<&str>) -> Vec<(&'static str, String)> {
        let path = |p: PathBuf| p.to_str().unwrap().to_owned();
        let root = self.fixture.root.path();
        let mut environment = vec![
            ("HOME", path(root.into())),
            ("XDG_DATA_HOME", path(root.join("data"))),
            ("LAZYSH_STATE_DIR", path(self.state())),
            // The host's local time, which an update window is read in.
            ("TZ", "UTC".to_owned()),
            (
                "LAZYSH_UPDATE_TEST_ENDPOINT",
                self.fixture.server.api.clone(),
            ),
            ("LAZYSH_UPDATE_TEST_CA", path(root.join("ca.pem"))),
        ];
        if let Some(app) = app {
            environment.push(("LAZYSH_APP_VERSION", app.to_owned()));
        }
        if let Some(tools) = &self.tools {
            environment.push(("PATH", format!("{}:/usr/bin:/bin", path(tools.clone()))));
        }
        environment
    }
    /// A hook reporting `state`, the way an agent's hook reports to the companion.
    pub fn ingest(&self, state: &str) {
        let event = json!({"schemaVersion":1,"sessionId":"s1","agent":"Test Agent","project":"/work/app","state":state,"summary":"A turn","paneId":"%1"});
        let output = self.run_with(
            None,
            &["ingest", "--agent", "generic"],
            event.to_string().as_bytes(),
        );
        assert!(output.status.success(), "{output:?}");
    }
    /// The `update` field the companion put in its `snapshot` reply to `app`.
    pub fn connect(&self, app: &str) -> Option<Value> {
        let output = self.run(Some(app), &["snapshot", "--limit", "5"]);
        assert!(output.status.success(), "{output:?}");
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["schemaVersion"], 1);
        reply.get("update").cloned()
    }
    pub fn record(&self) -> Option<Value> {
        fs::read(self.state().join("app-update.json"))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }
    /// Waits for the detached runner to leave `running` and returns what it recorded.
    pub fn settled(&self) -> Value {
        self.settled_for(NEW)
    }
    pub fn settled_for(&self, to: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            match self.record() {
                Some(record) if record["to"] == to && record["state"] != "running" => {
                    return record
                }
                _ if Instant::now() > deadline => panic!("the update never settled"),
                _ => thread::sleep(Duration::from_millis(50)),
            }
        }
    }
    pub fn assert_outcome(record: &Value, state: &str, reason: &str) {
        assert_eq!(
            (record["state"].as_str(), record["reason"].as_str()),
            (Some(state), Some(reason))
        );
    }
    pub fn write_state(&self, name: &str, value: &Value) {
        fs::create_dir_all(self.state()).unwrap();
        mode(&self.state(), 0o700);
        let path = self.state().join(name);
        fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        mode(&path, 0o600);
    }
    pub fn installed_version(&self) -> String {
        let output = self.run(None, &["--version"]);
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
    /// Nothing was asked of the release host.
    pub fn assert_offline(&self) {
        assert_eq!(self.fixture.server.requests(), vec![]);
    }
}
