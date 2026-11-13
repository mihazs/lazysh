#![cfg(unix)]
//! The real `lazysh-agent update` process against a local fake HTTPS release server.
//! The binary under test is built with the `update-test-endpoint` seam; shipped builds ignore it.
use lazysh_companion_release::{
    fake::{Fault, Release, Server},
    sha, TARGETS,
};
use serde_json::Value;
use std::{fs, process::Command};

const THIS: &str = env!("CARGO_PKG_VERSION");
const BINARY: &[u8] = b"companion bytes";

struct Fixture {
    root: tempfile::TempDir,
    server: Server,
}
struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}
impl Run {
    fn lines(&self) -> Vec<Value> {
        self.stdout
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn result(&self) -> Value {
        let lines = self.lines();
        let last = lines.last().unwrap().clone();
        assert_eq!(last["event"], "result");
        assert_eq!(last["schemaVersion"], 1);
        assert_eq!(last["exitCode"], self.code);
        last
    }
}
fn release(version: &str) -> Release {
    TARGETS
        .iter()
        .fold(Release::new(version), |release, target| {
            release.binary(target, BINARY)
        })
}
impl Fixture {
    fn new(releases: &[Release]) -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
            server: Server::start(releases.to_vec()),
        }
    }
    fn state(&self) -> std::path::PathBuf {
        self.root.path().join("state")
    }
    fn managed(&self) -> std::path::PathBuf {
        let data = if cfg!(target_os = "macos") {
            self.root.path().join("Library/Application Support")
        } else {
            self.root.path().join("data")
        };
        data.join("lazysh/companion")
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
        command
            .env_clear()
            .args(["update"])
            .args(args)
            .env("HOME", self.root.path())
            .env("XDG_DATA_HOME", self.root.path().join("data"))
            .env("LAZYSH_STATE_DIR", self.state())
            .env("LAZYSH_UPDATE_TEST_ENDPOINT", &self.server.api)
            .env("LAZYSH_UPDATE_TEST_CA", self.root.path().join("ca.pem"));
        fs::write(self.root.path().join("ca.pem"), &self.server.ca_pem).unwrap();
        command
    }
    fn run(&self, args: &[&str]) -> Run {
        self.finish(self.command(args))
    }
    fn finish(&self, mut command: Command) -> Run {
        let output = command.output().unwrap();
        Run {
            code: output.status.code().unwrap(),
            stdout: String::from_utf8(output.stdout).unwrap(),
            stderr: String::from_utf8(output.stderr).unwrap(),
        }
    }
    fn managed_binary(&self, script: &str) {
        let path = self.managed().join("lazysh-agent");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    /// Nothing under the isolated home, state or managed namespace was created.
    fn assert_untouched(&self) {
        let entries = fs::read_dir(self.root.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(entries, ["ca.pem"], "update --check must not create state");
    }
}

#[test]
fn check_reports_an_available_release_with_exit_10_and_downloads_nothing() {
    let fixture = Fixture::new(&[release("1.0.0"), release("99.0.0")]);
    let run = fixture.run(&["--check", "--json"]);
    assert_eq!(run.code, 10, "{}{}", run.stdout, run.stderr);
    assert!(run.stderr.is_empty());
    let lines = run.lines();
    assert_eq!(lines[0]["event"], "stage");
    assert_eq!(lines[0]["stage"], "resolving");
    let result = run.result();
    assert_eq!(
        (result["action"].as_str(), result["outcome"].as_str()),
        (Some("check"), Some("available"))
    );
    assert!(result["error"].is_null());
    assert_eq!(result["current"]["version"], THIS);
    assert_eq!(result["current"]["managed"], false);
    assert_eq!(result["current"]["sha256"].as_str().unwrap().len(), 64);
    let latest = &result["latest"];
    assert_eq!(latest["version"], "99.0.0");
    assert_eq!(latest["channel"], "stable");
    assert_eq!(latest["tag"], "v99.0.0");
    assert_eq!(latest["sha256"], sha(BINARY));
    assert_eq!(latest["bytes"], BINARY.len());
    assert!(latest["asset"]
        .as_str()
        .unwrap()
        .starts_with("lazysh-99.0.0-"));
    assert_eq!(fixture.server.companion_downloads(), 0);
    // Only HTTPS_PROXY is honored; other proxy variables must not divert the request.
    let mut command = fixture.command(&["--check"]);
    command
        .env("ALL_PROXY", "http://127.0.0.1:1")
        .env("HTTP_PROXY", "http://127.0.0.1:1");
    assert_eq!(fixture.finish(command).code, 10);
    let requests = fixture.server.requests();
    assert!(!requests.is_empty());
    assert!(requests
        .iter()
        .all(|r| r.user_agent == format!("lazysh-agent/{THIS}")));
    fixture.assert_untouched();
}
#[test]
fn check_is_up_to_date_for_the_same_or_an_older_latest_release() {
    for latest in [THIS, "0.0.1"] {
        let fixture = Fixture::new(&[release(latest)]);
        let run = fixture.run(&["--check"]);
        assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
        assert!(run.stdout.contains("Already up to date."));
        assert_eq!(
            fixture.run(&["--check", "--json"]).result()["outcome"],
            "upToDate"
        );
        fixture.assert_untouched();
    }
}
#[test]
fn the_managed_copy_is_what_check_compares_not_the_running_binary() {
    let fixture = Fixture::new(&[release("99.0.0")]);
    fixture.managed_binary("#!/bin/sh\necho lazysh-agent 0.1.0\n");
    let result = fixture.run(&["--check", "--json"]).result();
    assert_eq!(result["current"]["managed"], true);
    assert_eq!(result["current"]["version"], "0.1.0");
    // A managed copy that cannot say its version is replaced by any release.
    fixture.managed_binary("#!/bin/sh\necho not a version\n");
    let run = fixture.run(&["--check", "--json"]);
    assert_eq!(run.code, 10);
    assert!(run.result()["current"]["version"].is_null());
    let fixture = Fixture::new(&[release("0.1.0")]);
    fixture.managed_binary("#!/bin/sh\necho lazysh-agent 0.1.0\n");
    assert_eq!(fixture.run(&["--check"]).code, 0);
}
#[test]
fn a_managed_copy_that_others_can_write_is_never_executed() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new(&[]);
    let marker = fixture.root.path().join("executed");
    fixture.managed_binary(&format!(
        "#!/bin/sh\ntouch {}\necho lazysh-agent 0.1.0\n",
        marker.display()
    ));
    let binary = fixture.managed().join("lazysh-agent");
    let mode = |path: &std::path::Path, mode| {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap()
    };
    // (executable mode, directory mode): group or world writable either way is refused.
    for (file, directory) in [
        (0o770, 0o700),
        (0o707, 0o700),
        (0o700, 0o770),
        (0o700, 0o707),
    ] {
        mode(&binary, file);
        mode(&fixture.managed(), directory);
        let result = fixture.run(&["--status", "--json"]).result();
        assert_eq!(result["current"]["managed"], true);
        assert!(
            result["current"]["version"].is_null(),
            "file {file:o} directory {directory:o}"
        );
        assert!(!marker.exists(), "an untrusted managed copy was executed");
    }
    mode(&binary, 0o700);
    mode(&fixture.managed(), 0o700);
    assert_eq!(
        fixture.run(&["--status", "--json"]).result()["current"]["version"],
        "0.1.0"
    );
    assert!(marker.exists());
}
#[test]
fn an_explicit_version_is_resolved_by_tag_and_never_a_downgrade() {
    let fixture = Fixture::new(&[release("1.0.0"), release("99.0.0"), release("100.0.0")]);
    let result = fixture
        .run(&["--check", "--json", "--version", "99.0.0"])
        .result();
    assert_eq!(result["latest"]["version"], "99.0.0");
    assert_eq!(result["outcome"], "available");
    let run = fixture.run(&["--check", "--json", "--version", "1.0.0"]);
    assert_eq!(run.code, 23);
    assert_eq!(run.result()["error"]["kind"], "downgradeRefused");
    let run = fixture.run(&["--check", "--json", "--version", "98.0.0"]);
    assert_eq!(run.code, 21, "{}", run.stdout);
    assert_eq!(run.result()["error"]["kind"], "releaseUnavailable");
}
#[test]
fn the_prerelease_channel_picks_the_highest_release_and_stable_ignores_it() {
    let mut rc = release("101.0.0");
    rc.prerelease = true;
    let mut draft = release("102.0.0");
    draft.draft = true;
    let fixture = Fixture::new(&[release("99.0.0"), rc, draft]);
    let stable = fixture.run(&["--check", "--json"]).result();
    assert_eq!(stable["latest"]["version"], "99.0.0");
    let pre = fixture
        .run(&["--check", "--json", "--channel", "prerelease"])
        .result();
    assert_eq!(pre["latest"]["version"], "101.0.0");
    assert_eq!(pre["latest"]["channel"], "prerelease");
    let tagged = fixture.run(&["--check", "--json", "--version", "101.0.0"]);
    assert_eq!(tagged.code, 21, "a prerelease needs the prerelease channel");
    let tagged = fixture.run(&[
        "--check",
        "--json",
        "--version",
        "101.0.0",
        "--channel",
        "prerelease",
    ]);
    assert_eq!(tagged.code, 10);
}

/// One row per refusal: the fault, the exit code, `error.kind` and `error.detail`.
#[test]
fn every_failure_class_has_its_exit_code_kind_and_detail() {
    let table: [(Fault, i32, &str, Option<&str>); 13] = [
        (
            Fault::ApiDigest,
            22,
            "verificationFailed",
            Some("digestMismatch"),
        ),
        (
            Fault::ApiSize,
            22,
            "verificationFailed",
            Some("sizeMismatch"),
        ),
        (
            Fault::ManifestDigest,
            22,
            "verificationFailed",
            Some("digestMismatch"),
        ),
        (
            Fault::ManifestBytes,
            22,
            "verificationFailed",
            Some("digestMismatch"),
        ),
        (
            Fault::MovedTag,
            22,
            "verificationFailed",
            Some("commitMismatch"),
        ),
        (
            Fault::LongManifest,
            22,
            "verificationFailed",
            Some("sizeMismatch"),
        ),
        (
            Fault::DropManifest(10),
            20,
            "networkUnavailable",
            Some("interrupted"),
        ),
        (Fault::NoPlatform, 21, "releaseUnavailable", None),
        (
            Fault::Status(503, None),
            20,
            "networkUnavailable",
            Some("http"),
        ),
        (
            Fault::Status(429, Some(30)),
            20,
            "networkUnavailable",
            Some("rateLimited"),
        ),
        (
            Fault::Status(403, Some(999_999)),
            20,
            "networkUnavailable",
            Some("rateLimited"),
        ),
        (Fault::Status(404, None), 21, "releaseUnavailable", None),
        (
            Fault::RedirectTo("https://example.invalid/asset".into()),
            22,
            "verificationFailed",
            Some("redirectRefused"),
        ),
    ];
    for (fault, code, kind, detail) in table {
        let fixture = Fixture::new(&[release("99.0.0")]);
        fixture.server.fault(Some(fault.clone()));
        let run = fixture.run(&["--check", "--json"]);
        assert_eq!(run.code, code, "{fault:?}: {}{}", run.stdout, run.stderr);
        let error = &run.result()["error"];
        assert_eq!(error["kind"], kind, "{fault:?}");
        assert_eq!(error["detail"].as_str(), detail, "{fault:?}");
        assert!(error["message"].as_str().unwrap().len() > 10);
        assert_eq!(run.result()["outcome"], "failed");
        fixture.assert_untouched();
    }
}
#[test]
fn rate_limits_report_a_bounded_retry_after() {
    let fixture = Fixture::new(&[release("99.0.0")]);
    for (given, reported) in [(30, 30), (999_999, 86_400)] {
        fixture.server.fault(Some(Fault::Status(429, Some(given))));
        let error = fixture.run(&["--check", "--json"]).result()["error"].clone();
        assert_eq!(error["retryAfterSeconds"], reported);
    }
}
#[test]
fn an_insecure_redirect_and_an_untrusted_certificate_are_refused_as_security_events() {
    let fixture = Fixture::new(&[release("99.0.0")]);
    fixture
        .server
        .fault(Some(Fault::RedirectTo("http://localhost:1/asset".into())));
    let result = fixture.run(&["--check", "--json"]).result();
    assert_eq!(result["error"]["detail"], "insecureUrl");
    // The server's certificate is not the one the client was told to trust.
    let other = Server::start(vec![]);
    let mut command = fixture.command(&["--check", "--json"]);
    fs::write(fixture.root.path().join("ca.pem"), &other.ca_pem).unwrap();
    command.env("LAZYSH_UPDATE_TEST_CA", fixture.root.path().join("ca.pem"));
    let run = fixture.finish(command);
    assert_eq!(run.code, 22, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.result()["error"]["detail"], "tls");
    assert_eq!(fixture.server.companion_downloads(), 0);
}
#[test]
fn unreachable_hosts_are_offline_errors_and_never_leak_urls_or_proxy_credentials() {
    let fixture = Fixture::new(&[release("99.0.0")]);
    let proxy = "http://proxyuser:proxysecret@127.0.0.1:1";
    for (name, endpoint, detail) in [
        (
            "closed port",
            "https://localhost:1/repos/mihazs/lazysh/",
            "connect",
        ),
        (
            "unresolvable name",
            "https://lazysh-no-such-host.invalid/repos/mihazs/lazysh/",
            "dns",
        ),
    ] {
        let mut command = fixture.command(&["--check", "--json"]);
        command.env("LAZYSH_UPDATE_TEST_ENDPOINT", endpoint);
        let run = fixture.finish(command);
        assert_eq!(run.code, 20, "{name}: {}{}", run.stdout, run.stderr);
        assert_eq!(run.result()["error"]["detail"], detail, "{name}");
    }
    let mut command = fixture.command(&["--check"]);
    command.env("HTTPS_PROXY", proxy);
    let run = fixture.finish(command);
    assert_eq!(run.code, 20);
    for text in [&run.stdout, &run.stderr] {
        for secret in [
            "proxysecret",
            "proxyuser",
            "127.0.0.1",
            "localhost",
            "https://",
            "http://",
        ] {
            assert!(!text.contains(secret), "{secret} leaked in {text}");
        }
    }
    assert_eq!(
        fixture.server.requests().len(),
        0,
        "the proxy path never reached the server"
    );
    fixture.assert_untouched();
}

#[test]
fn status_is_offline_creates_nothing_and_reads_the_recorded_history() {
    let fixture = Fixture::new(&[]);
    let mut command = fixture.command(&["--status", "--json"]);
    command.env(
        "LAZYSH_UPDATE_TEST_ENDPOINT",
        "https://localhost:1/repos/mihazs/lazysh/",
    );
    let run = fixture.finish(command);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.lines().len(), 1, "status has no progress events");
    let result = run.result();
    assert_eq!(result["action"], "status");
    assert_eq!(result["outcome"], "status");
    assert_eq!(result["current"]["version"], THIS);
    assert!(result["previous"].is_null());
    assert!(result["lastCheck"].is_null() && result["lastOperation"].is_null());
    assert_eq!(fixture.server.requests().len(), 0);
    fixture.assert_untouched();

    let previous = "c".repeat(64);
    fixture.managed_binary("#!/bin/sh\necho lazysh-agent 1.2.3\n");
    fs::write(fixture.managed().join("lazysh-agent.previous"), b"old").unwrap();
    fs::create_dir_all(fixture.state()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(fixture.state(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let state = serde_json::json!({"schemaVersion":1,"previous":{"version":"1.2.2","sha256":previous},
        "lastCheck":{"at":"2026-11-13T10:00:00Z","available":true},
        "lastOperation":{"action":"update","outcome":"updated","from":"1.2.2","to":"1.2.3"},
        "fromAFutureVersion":{"ignored":true}});
    let path = fixture.state().join("update-state.json");
    fs::write(&path, state.to_string()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let result = fixture.run(&["--status", "--json"]).result();
    assert_eq!(result["current"]["managed"], true);
    assert_eq!(result["current"]["version"], "1.2.3");
    assert_eq!(result["previous"]["version"], "1.2.2");
    assert_eq!(result["previous"]["sha256"], previous);
    assert_eq!(result["lastCheck"]["available"], true);
    assert_eq!(result["lastOperation"]["to"], "1.2.3");
    // A damaged state file reads as empty and never fails the capability probe.
    fs::write(&path, "{not json").unwrap();
    let damaged = fixture.run(&["--status", "--json"]);
    assert_eq!(damaged.code, 0);
    let result = damaged.result();
    assert!(result["previous"].is_null() && result["lastOperation"].is_null());
    // The previous copy is only reported while its file exists.
    fs::write(&path, state.to_string()).unwrap();
    fs::remove_file(fixture.managed().join("lazysh-agent.previous")).unwrap();
    assert!(fixture.run(&["--status", "--json"]).result()["previous"].is_null());
}

#[test]
fn usage_errors_exit_2_before_any_network_use() {
    let fixture = Fixture::new(&[release("99.0.0")]);
    for args in [
        &[][..],
        &["--check", "--status"],
        &["--status", "--version", "1.2.3"],
        &["--status", "--channel", "stable"],
        &["--check", "--version", "1.2"],
        &["--check", "--version", "01.2.3"],
        &["--check", "--channel", "nightly"],
    ] {
        let run = fixture.run(args);
        assert_eq!(run.code, 2, "{args:?}: {}{}", run.stdout, run.stderr);
        assert!(run.stdout.is_empty());
    }
    assert_eq!(fixture.server.requests().len(), 0);
    fixture.assert_untouched();
}
