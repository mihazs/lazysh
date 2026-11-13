#![cfg(target_os = "linux")]
//! A lazysh app newer than the companion updates it: the real `lazysh-agent` is the old companion on
//! a host with an isolated home, the new release is published on a local fake HTTPS release server,
//! and the app is whatever `LAZYSH_APP_VERSION` says. Built with the `update-test-endpoint` seam.
//! Linux only: the old companion is this build stripped to a publishable size, which macOS cannot
//! run again once its signature is gone.
use lazysh_companion_release::fake::{Fault, Release};
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
#[path = "support/update_fixture.rs"]
#[allow(dead_code)]
mod fixture;
#[path = "support/update_stub.rs"]
#[allow(dead_code)]
mod stub;
use fixture::{companion, listing, mode, release_of, Fixture, NAME, THIS};
#[path = "support/openssh.rs"]
mod openssh;

const NEW: &str = "99.0.0";

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

/// A host whose managed companion is the real binary under test (an old one next to `NEW`).
struct Host {
    fixture: Fixture,
    old: Vec<u8>,
}
impl Host {
    fn with(releases: &[Release]) -> Self {
        let fixture = Fixture::new(releases);
        let old = old_companion().to_vec();
        fixture.managed_binary(&old);
        fs::write(fixture.root.path().join("ca.pem"), &fixture.server.ca_pem).unwrap();
        Self { fixture, old }
    }
    fn new() -> Self {
        Self::with(&[release_of(NEW, &companion(NEW))])
    }
    fn state(&self) -> PathBuf {
        self.fixture.state()
    }
    /// `lazysh-agent <args>` as the app would run it on the host: the managed companion, the app's
    /// version in the environment when there is one.
    fn run(&self, app: Option<&str>, args: &[&str]) -> Output {
        self.run_with(app, args, b"")
    }
    fn run_with(&self, app: Option<&str>, args: &[&str], stdin: &[u8]) -> Output {
        let mut command = Command::new(self.fixture.managed().join(NAME));
        command.env_clear().args(args).envs(self.environment(app));
        exec(command, stdin)
    }
    /// What the app's exec leaves in the companion's environment on the host.
    fn environment(&self, app: Option<&str>) -> Vec<(&'static str, String)> {
        let path = |p: PathBuf| p.to_str().unwrap().to_owned();
        let root = self.fixture.root.path();
        let mut environment = vec![
            ("HOME", path(root.into())),
            ("XDG_DATA_HOME", path(root.join("data"))),
            ("LAZYSH_STATE_DIR", path(self.state())),
            (
                "LAZYSH_UPDATE_TEST_ENDPOINT",
                self.fixture.server.api.clone(),
            ),
            ("LAZYSH_UPDATE_TEST_CA", path(root.join("ca.pem"))),
        ];
        if let Some(app) = app {
            environment.push(("LAZYSH_APP_VERSION", app.to_owned()));
        }
        environment
    }
    /// A hook reporting `state`, the way an agent's hook reports to the companion.
    fn ingest(&self, state: &str) {
        let event = json!({"schemaVersion":1,"sessionId":"s1","agent":"Test Agent","project":"/work/app","state":state,"summary":"A turn","paneId":"%1"});
        let output = self.run_with(
            None,
            &["ingest", "--agent", "generic"],
            event.to_string().as_bytes(),
        );
        assert!(output.status.success(), "{output:?}");
    }
    /// The `update` field the companion put in its `snapshot` reply to `app`.
    fn connect(&self, app: &str) -> Option<Value> {
        let output = self.run(Some(app), &["snapshot", "--limit", "5"]);
        assert!(output.status.success(), "{output:?}");
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["schemaVersion"], 1);
        reply.get("update").cloned()
    }
    fn record(&self) -> Option<Value> {
        fs::read(self.state().join("app-update.json"))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }
    /// Waits for the detached runner to leave `running` and returns what it recorded.
    fn settled(&self) -> Value {
        self.settled_for(NEW)
    }
    fn settled_for(&self, to: &str) -> Value {
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
    fn assert_outcome(record: &Value, state: &str, reason: &str) {
        assert_eq!(
            (record["state"].as_str(), record["reason"].as_str()),
            (Some(state), Some(reason))
        );
    }
    fn write_state(&self, name: &str, value: &Value) {
        fs::create_dir_all(self.state()).unwrap();
        mode(&self.state(), 0o700);
        let path = self.state().join(name);
        fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        mode(&path, 0o600);
    }
    fn installed_version(&self) -> String {
        let output = self.run(None, &["--version"]);
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
    /// Nothing was asked of the release host.
    fn assert_offline(&self) {
        assert_eq!(self.fixture.server.requests(), vec![]);
    }
}

#[test]
fn a_newer_app_updates_the_companion_once_however_many_connect_at_once() {
    let host = Host::new();
    let connects: Vec<_> = thread::scope(|scope| {
        let all: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| host.run(Some(NEW), &["snapshot", "--limit", "5"])))
            .collect();
        all.into_iter().map(|run| run.join().unwrap()).collect()
    });
    for output in &connects {
        assert!(output.status.success(), "{output:?}");
    }
    // The ones that reached the old companion were told what is going on, and nothing else changed.
    let told: Vec<Value> = connects
        .iter()
        .filter_map(|output| serde_json::from_slice::<Value>(&output.stdout).ok())
        .filter_map(|reply| reply.get("update").cloned())
        .collect();
    assert!(!told.is_empty());
    for update in &told {
        assert!(["started", "running"].contains(&update["state"].as_str().unwrap()));
        assert_eq!(update["from"], THIS);
        assert_eq!(update["to"], NEW);
    }
    assert_eq!(host.settled()["state"], "done");
    assert_eq!(host.installed_version(), format!("lazysh-agent {NEW}"));
    assert_eq!(host.fixture.previous().unwrap(), host.old, "rollback copy");
    assert_eq!(host.fixture.server.companion_downloads(), 1, "one update");
    // The runner is finished with the managed folder: no staging left behind.
    let leftovers: Vec<_> = listing(&host.fixture.managed())
        .into_iter()
        .filter(|name| name.starts_with(".update-"))
        .collect();
    assert_eq!(leftovers, Vec::<String>::new());
}

#[test]
fn the_reply_comes_back_before_the_update_ends() {
    // `Command::output` waits for the pipes to close: a runner that kept the exec channel's
    // descriptors would hold this call open until it finished.
    let host = Host::new();
    let started = Instant::now();
    let update = host.connect(NEW).unwrap();
    assert_eq!(update["state"], "started");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(host.settled()["state"], "done");
}

#[test]
fn the_app_that_waited_for_an_update_is_told_it_finished() {
    let host = Host::new();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let done = |finished: &str| json!({"schemaVersion":1,"from":"0.1.0","to":THIS,"state":"done","finishedAt":finished});
    host.write_state("app-update.json", &done(&now));
    let update = host.connect(THIS).unwrap();
    assert_eq!(
        (
            update["state"].as_str(),
            update["from"].as_str(),
            update["to"].as_str()
        ),
        (Some("done"), Some("0.1.0"), Some(THIS))
    );
    // Only for a while: later the companion is simply up to date.
    host.write_state("app-update.json", &done("2000-01-01T00:00:00Z"));
    assert_eq!(host.connect(THIS), None);
    host.assert_offline();
}

#[test]
fn an_app_that_is_not_newer_changes_nothing() {
    let host = Host::new();
    for app in [THIS, "0.0.9"] {
        assert_eq!(host.connect(app), None, "{app}");
    }
    host.assert_offline();
    assert_eq!(host.record(), None);
    assert_eq!(host.run(None, &["--version"]).status.code(), Some(0));
    assert!(!host.state().join("auto-update.json").exists());
}

#[test]
fn an_app_version_that_is_not_a_stable_release_is_ignored() {
    let host = Host::new();
    for app in ["1.2", "banana", "99.0.0-rc1", "099.0.0", "99.0.0 ", ""] {
        let update = host.connect(app).unwrap();
        assert_eq!(update["state"], "skipped", "{app:?}");
        assert_eq!(update["reason"], "invalidAppVersion");
        // What the app sent is not repeated back.
        assert_eq!(update["to"], THIS);
    }
    host.assert_offline();
}

#[test]
fn off_and_notify_never_update_and_install_is_the_default() {
    let host = Host::new();
    let status = host.run(None, &["auto-update", "status"]);
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(
        (status["policy"].clone(), status["revision"].clone()),
        (json!("install"), json!(0))
    );
    assert!(
        !host.state().join("auto-update.json").exists(),
        "reading the default creates nothing"
    );
    for (revision, policy, reason) in [(0, "off", "policyOff"), (1, "notify", "policyNotify")] {
        let set = host.run(
            None,
            &[
                "auto-update",
                "set",
                "--expected-revision",
                &revision.to_string(),
                "--policy",
                policy,
            ],
        );
        assert!(set.status.success(), "{set:?}");
        let update = host.connect(NEW).unwrap();
        assert_eq!(
            (update["state"].as_str(), update["reason"].as_str()),
            (Some("skipped"), Some(reason))
        );
    }
    host.assert_offline();
    assert_eq!(host.record(), None);
    assert_eq!(host.installed_version(), format!("lazysh-agent {THIS}"));
    // A stale revision does not overwrite what another session set.
    let conflict = host.run(
        None,
        &[
            "auto-update",
            "set",
            "--expected-revision",
            "0",
            "--policy",
            "install",
        ],
    );
    assert!(!conflict.status.success());
    // Turning it back on is what lets the next newer app update.
    let on = host.run(
        None,
        &[
            "auto-update",
            "set",
            "--expected-revision",
            "2",
            "--policy",
            "install",
        ],
    );
    assert!(on.status.success());
    assert_eq!(host.connect(NEW).unwrap()["state"], "started");
    assert_eq!(host.settled()["state"], "done");
}

#[test]
fn a_policy_file_that_cannot_be_read_blocks_updates() {
    let host = Host::new();
    for contents in [
        json!({"schemaVersion": 1, "revision": 0, "policy": "always"}),
        json!([]),
    ] {
        host.write_state("auto-update.json", &contents);
        let update = host.connect(NEW).unwrap();
        assert_eq!(update["reason"], "policyUnreadable");
    }
    host.assert_offline();
}

#[test]
fn a_corrupted_download_is_refused_and_not_tried_again_for_the_same_app() {
    let host = Host::new();
    host.fixture.server.fault(Some(Fault::TamperedAsset));
    assert_eq!(host.connect(NEW).unwrap()["state"], "started");
    let record = host.settled();
    Host::assert_outcome(&record, "failed", "verificationFailed");
    // Nothing was installed and nothing is left behind.
    assert_eq!(host.installed_version(), format!("lazysh-agent {THIS}"));
    assert_eq!(host.fixture.previous(), None);
    assert!(listing(&host.fixture.managed())
        .iter()
        .all(|name| !name.starts_with(".update-")));
    // The same app asking again is told what happened, without another request to the release host.
    let asked = host.fixture.server.requests().len();
    let again = host.connect(NEW).unwrap();
    Host::assert_outcome(&again, "failed", "verificationFailed");
    assert_eq!(host.fixture.server.requests().len(), asked);
    // A newer app is a new question.
    host.fixture.server.fault(None);
    host.fixture
        .server
        .publish(vec![release_of("99.1.0", &companion("99.1.0"))]);
    assert_eq!(host.connect("99.1.0").unwrap()["state"], "started");
    assert_eq!(host.settled_for("99.1.0")["state"], "done");
    assert_eq!(host.installed_version(), "lazysh-agent 99.1.0");
}

#[test]
fn an_update_that_does_not_come_up_is_rolled_back() {
    let scratch = tempfile::tempdir().unwrap();
    let flaky = stub::build(scratch.path(), NEW, true);
    let host = Host::with(&[release_of(NEW, &flaky)]);
    assert_eq!(host.connect(NEW).unwrap()["state"], "started");
    let record = host.settled();
    Host::assert_outcome(&record, "failed", "rolledBack");
    assert_eq!(
        fs::read(host.fixture.managed().join(NAME)).unwrap(),
        host.old
    );
    assert_eq!(host.installed_version(), format!("lazysh-agent {THIS}"));
}

#[test]
fn an_unreachable_release_host_is_a_quiet_skip_with_backoff() {
    let host = Host::new();
    host.fixture.server.fault(Some(Fault::Status(503, None)));
    host.connect(NEW);
    let record = host.settled();
    Host::assert_outcome(&record, "skipped", "networkUnavailable");
    assert!(record["notBefore"].is_string());
    assert_eq!(host.connect(NEW).unwrap()["state"], "skipped");
}

#[test]
fn an_agent_turn_in_progress_holds_the_update_until_it_ends() {
    let host = Host::new();
    host.ingest("working");
    host.connect(NEW);
    let record = host.settled();
    Host::assert_outcome(&record, "skipped", "activeTurn");
    host.assert_offline();
    assert_eq!(
        host.connect(NEW).unwrap()["reason"],
        "activeTurn",
        "not looked at again at once"
    );
    // The turn ends and the wait is over.
    host.ingest("done");
    fs::remove_file(host.state().join("app-update.json")).unwrap();
    assert_eq!(host.connect(NEW).unwrap()["state"], "started");
    assert_eq!(host.settled()["state"], "done");
}

#[test]
fn a_runner_that_died_is_replaced_but_not_on_every_request() {
    let host = Host::new();
    let died = |started: &str| json!({"schemaVersion":1,"from":THIS,"to":NEW,"state":"running","pid":2147483646,"startedAt":started});
    host.write_state(
        "app-update.json",
        &died(&chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    );
    let update = host.connect(NEW).unwrap();
    Host::assert_outcome(&update, "failed", "interrupted");
    host.assert_offline();
    host.write_state("app-update.json", &died("2000-01-01T00:00:00Z"));
    assert_eq!(host.connect(NEW).unwrap()["state"], "started");
    assert_eq!(host.settled()["state"], "done");
}

#[test]
fn a_release_the_user_rolled_back_from_is_not_installed_again() {
    let host = Host::new();
    host.write_state(
        "update-state.json",
        &json!({"schemaVersion":1,"lastOperation":{"action":"rollback","outcome":"rolledBack","from":NEW,"to":THIS}}),
    );
    assert_eq!(host.connect(NEW).unwrap()["reason"], "rolledBack");
    host.assert_offline();
}

#[test]
fn no_hook_and_no_policy_command_starts_an_update() {
    let host = Host::new();
    let event = json!({"schemaVersion":1,"sessionId":"s","agent":"A","project":"/p","state":"working","summary":"s"});
    let ingest = host.run_with(
        Some(NEW),
        &["ingest", "--agent", "generic"],
        event.to_string().as_bytes(),
    );
    assert!(ingest.status.success());
    let status = host.run(Some(NEW), &["auto-update", "status"]);
    assert!(status.status.success());
    thread::sleep(Duration::from_millis(500));
    host.assert_offline();
    assert_eq!(host.record(), None);
}

/// The same host, reached the way the app reaches it: `ssh` to a private OpenSSH server running as
/// this user. An exec channel only closes when every process holding it has exited, so a runner that
/// did not let go of it would keep each of these calls waiting until the update ended.
#[test]
fn a_newer_app_over_ssh_gets_its_reply_at_once_and_the_host_updates_once() {
    let Some(sshd) = openssh::Sshd::start() else {
        eprintln!("skipped: needs OpenSSH sshd, ssh and ssh-keygen");
        return;
    };
    let host = Host::new();
    let remote = {
        let mut words = vec!["env".to_owned(), "-i".to_owned()];
        words.extend(
            host.environment(Some(NEW))
                .iter()
                .map(|(k, v)| format!("{k}={v}")),
        );
        words.push(
            host.fixture
                .managed()
                .join(NAME)
                .to_str()
                .unwrap()
                .to_owned(),
        );
        words.extend(["snapshot", "--limit", "5"].map(str::to_owned));
        words.join(" ")
    };
    let begun = Instant::now();
    let replies: Vec<Output> = thread::scope(|scope| {
        let all: Vec<_> = (0..6).map(|_| scope.spawn(|| sshd.exec(&remote))).collect();
        all.into_iter().map(|reply| reply.join().unwrap()).collect()
    });
    assert!(begun.elapsed() < Duration::from_secs(20));
    for reply in &replies {
        assert!(reply.status.success(), "{reply:?}");
        let reply: Value = serde_json::from_slice(&reply.stdout).unwrap();
        assert_eq!(reply["update"]["to"], NEW);
    }
    assert_eq!(host.settled()["state"], "done");
    assert_eq!(host.installed_version(), format!("lazysh-agent {NEW}"));
    assert_eq!(host.fixture.server.companion_downloads(), 1);
}
