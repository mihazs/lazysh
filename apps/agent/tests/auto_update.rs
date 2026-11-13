#![cfg(target_os = "linux")]
//! The scheduled check: the real `lazysh-agent` is the old companion on a host with an isolated home,
//! the new releases are published on a local fake HTTPS release server, and `auto-update run` (what
//! the timer and the companion itself start) decides what to do from the settings and the clock.
//! Built with the `update-test-endpoint` seam. Linux only, like `app_update`.
use chrono::{Duration as Hours, SecondsFormat, Utc};
use lazysh_companion_release::fake::Fault;
use serde_json::{json, Value};
use std::{
    fs, thread,
    time::{Duration, Instant},
};
#[path = "support/update_host.rs"]
#[allow(dead_code)]
mod host;
use host::{
    companion,
    fixture::{listing, mode, THIS},
    release_of, Host, NEW,
};

fn stamp(offset: Hours) -> String {
    (Utc::now() + offset).to_rfc3339_opts(SecondsFormat::Secs, true)
}
/// `HH:MM-HH:MM` from `from` to `to` hours after now, on the host's clock (UTC under test).
fn window(from: i64, to: i64) -> String {
    let at = |hours| {
        (Utc::now() + Hours::hours(hours))
            .format("%H:%M")
            .to_string()
    };
    format!("{}-{}", at(from), at(to))
}
impl Host {
    /// `auto-update <args>` and the JSON it printed.
    fn auto_update(&self, args: &[&str]) -> (i32, Value) {
        let mut words = vec!["auto-update"];
        words.extend(args);
        let output = self.run(None, &words);
        let reply = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
        (output.status.code().unwrap(), reply)
    }
    /// The same through the executable `program`, which is not the managed copy on this host.
    fn auto_update_by(&self, program: &str, args: &[&str]) -> (i32, Value) {
        let output = std::process::Command::new(program)
            .env_clear()
            .arg("auto-update")
            .args(args)
            .envs(self.environment(None))
            .output()
            .unwrap();
        let reply = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
        (output.status.code().unwrap(), reply)
    }
    /// A scheduled check, run to the end.
    fn check(&self) -> Value {
        let (code, reply) = self.auto_update(&["run"]);
        assert_eq!(code, 0, "{reply}");
        assert_eq!(reply["schemaVersion"], 1);
        reply
    }
    /// `set` with the revision the host is at, so each call is one change.
    fn set(&self, args: &[&str]) -> (i32, Value) {
        let (_, status) = self.auto_update(&["status"]);
        let revision = status["revision"].to_string();
        let mut words = vec!["set", "--expected-revision", &revision];
        words.extend(args);
        self.auto_update(&words)
    }
    fn last_check(&self) -> Value {
        let recorded = fs::read(self.state().join("update-state.json")).unwrap();
        serde_json::from_slice::<Value>(&recorded).unwrap()["lastCheck"].clone()
    }
    /// The last check was this long ago (or, negative, that far ahead).
    fn checked(&self, ago: Hours) {
        self.write_state(
            "update-state.json",
            &json!({"schemaVersion":1,"lastCheck":{"at":stamp(-ago),"latest":null,"available":false,"error":null}}),
        );
    }
    /// The last check, this many hours ago, found `NEW` and no one has installed it.
    fn found(&self, hours_ago: i64) {
        self.write_state(
            "update-state.json",
            &json!({"schemaVersion":1,"lastCheck":{"at":stamp(-Hours::hours(hours_ago)),"latest":NEW,"available":true,"error":null}}),
        );
    }
    fn paths(&self) -> Vec<String> {
        let requests = self.fixture.server.requests();
        requests.into_iter().map(|logged| logged.path).collect()
    }
    fn waits_for(&self, what: &str, done: impl Fn(&Host) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(90);
        while !done(self) {
            assert!(Instant::now() < deadline, "never happened: {what}");
            thread::sleep(Duration::from_millis(50));
        }
    }
}

#[test]
fn a_due_check_under_notify_records_the_latest_release_and_installs_nothing() {
    let host = Host::due();
    assert_eq!(host.set(&["--policy", "notify"]).0, 0);
    let reply = host.check();
    assert_eq!(
        (reply["state"].as_str(), reply["latest"].as_str()),
        (Some("checked"), Some(NEW))
    );
    let check = host.last_check();
    assert_eq!(
        (check["latest"].as_str(), check["available"].as_bool()),
        (Some(NEW), Some(true))
    );
    assert_eq!(check["error"], Value::Null);
    assert!(check["at"].is_string());
    assert_eq!(host.installed_version(), format!("lazysh-agent {THIS}"));
    assert_eq!(host.fixture.server.companion_downloads(), 0);
    // Release, tag, and the small `release.json`: what the docs promise a check costs.
    assert_eq!(host.paths().len(), 4, "{:?}", host.paths());
    // The app reads it from `status`, which also says when the next check may use the network.
    let (_, status) = host.auto_update(&["status"]);
    assert_eq!(status["lastCheck"]["latest"], NEW);
    let next =
        chrono::DateTime::parse_from_rfc3339(status["nextCheckAt"].as_str().unwrap()).unwrap();
    let wait = next.with_timezone(&Utc) - Utc::now();
    assert!(
        wait > Hours::hours(23) && wait <= Hours::hours(24),
        "{wait}"
    );
    // And `update --status`, the one call the app already makes, carries the settings with it.
    let status = host.run(None, &["update", "--status", "--json"]);
    let result: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(result["autoUpdate"]["policy"], "notify");
    assert_eq!(result["lastCheck"]["latest"], NEW);
}

#[test]
fn a_due_check_under_install_installs_the_release_once_and_then_has_nothing_to_report() {
    let host = Host::due();
    let reply = host.check();
    assert_eq!(
        (reply["state"].as_str(), reply["latest"].as_str()),
        (Some("updated"), Some(NEW))
    );
    assert_eq!(host.installed_version(), format!("lazysh-agent {NEW}"));
    assert_eq!(host.fixture.previous().unwrap(), host.old, "rollback copy");
    assert_eq!(host.fixture.server.companion_downloads(), 1);
    // What the check found is no longer news once it is installed.
    assert_eq!(host.last_check()["available"], false);
    let asked = host.paths().len();
    // The installed companion is the release now; this build is a stand-in for the one that checks.
    let (code, again) = host.auto_update_by(env!("CARGO_BIN_EXE_lazysh-agent"), &["run"]);
    assert_eq!((code, again["reason"].as_str()), (0, Some("notDue")));
    assert_eq!(host.paths().len(), asked, "not due: nothing was asked");
    assert!(listing(&host.fixture.managed())
        .iter()
        .all(|name| !name.starts_with(".update-")));
}

#[test]
fn an_off_policy_uses_no_network_and_writes_no_state() {
    let host = Host::due();
    assert_eq!(host.set(&["--policy", "off"]).0, 0);
    assert_eq!(host.check()["reason"], "policyOff");
    host.assert_offline();
    assert!(!host.state().join("update-state.json").exists());
    let (_, status) = host.auto_update(&["status"]);
    assert_eq!(status["nextCheckAt"], Value::Null);
}

#[test]
fn a_check_waits_for_its_interval_and_a_shorter_interval_shortens_the_wait() {
    let host = Host::due();
    assert_eq!(host.set(&["--policy", "notify"]).0, 0);
    host.checked(Hours::hours(2));
    assert_eq!(host.check()["reason"], "notDue");
    host.assert_offline();
    assert_eq!(
        host.set(&["--policy", "notify", "--interval-hours", "1"]).0,
        0
    );
    assert_eq!(host.check()["state"], "checked");
    assert!(!host.paths().is_empty());
}

#[test]
fn a_release_older_than_the_installed_companion_is_never_an_update() {
    let host = Host::due_with(&[release_of("0.0.9", &companion("0.0.9"))]);
    let reply = host.check();
    assert_eq!(reply["state"], "checked");
    let check = host.last_check();
    assert_eq!(
        (check["latest"].as_str(), check["available"].as_bool()),
        (Some("0.0.9"), Some(false))
    );
    assert_eq!(host.fixture.server.companion_downloads(), 0);
    assert_eq!(host.installed_version(), format!("lazysh-agent {THIS}"));
}

#[test]
fn a_clock_that_was_set_back_does_not_postpone_the_check() {
    let host = Host::due();
    assert_eq!(host.set(&["--policy", "notify"]).0, 0);
    host.checked(Hours::hours(-48));
    assert_eq!(host.check()["state"], "checked");
}

#[test]
fn an_unreachable_release_host_is_recorded_not_failed_and_backs_off_longer_each_time() {
    let host = Host::due();
    host.fixture.server.fault(Some(Fault::Status(503, None)));
    let reply = host.check();
    assert_eq!(
        (reply["state"].as_str(), reply["reason"].as_str()),
        (Some("skipped"), Some("networkUnavailable"))
    );
    let check = host.last_check();
    assert_eq!(check["error"]["kind"], "networkUnavailable");
    assert_eq!(check["failures"], 1);
    let wait = |check: &Value| {
        chrono::DateTime::parse_from_rfc3339(check["notBefore"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc)
            - Utc::now()
    };
    assert!(wait(&check) > Hours::minutes(59) && wait(&check) <= Hours::hours(1));
    let asked = host.paths().len();
    assert_eq!(host.check()["reason"], "notDue");
    assert_eq!(host.paths().len(), asked);
    // The wait is over: it tries again, fails again and waits twice as long.
    host.write_state(
        "update-state.json",
        &json!({"schemaVersion":1,"lastCheck":{"at":stamp(-Hours::hours(2)),"latest":null,"available":false,
            "error":{"kind":"networkUnavailable"},"failures":1,"notBefore":stamp(-Hours::hours(1))}}),
    );
    host.check();
    let check = host.last_check();
    assert_eq!(check["failures"], 2);
    assert!(wait(&check) > Hours::minutes(119) && wait(&check) <= Hours::hours(2));
    // Back online: the next check works and the failure is forgotten.
    host.fixture.server.fault(None);
    host.write_state(
        "update-state.json",
        &json!({"schemaVersion":1,"lastCheck":{"at":stamp(-Hours::hours(3)),"latest":null,"available":false,
            "error":{"kind":"networkUnavailable"},"failures":2,"notBefore":stamp(-Hours::hours(1))}}),
    );
    assert_eq!(host.check()["state"], "updated");
    let check = host.last_check();
    assert_eq!(
        (check["error"].clone(), check["failures"].clone()),
        (Value::Null, Value::Null)
    );
}

#[test]
fn a_check_that_cannot_be_recorded_does_not_use_the_network() {
    let host = Host::due();
    // A directory where the lock file belongs: the state file cannot be taken, so it cannot be kept.
    fs::create_dir_all(host.state()).unwrap();
    mode(&host.state(), 0o700);
    fs::create_dir(host.state().join("update-state.lock")).unwrap();
    let (code, _) = host.auto_update(&["run"]);
    assert_ne!(code, 0);
    host.assert_offline();
    assert_eq!(host.installed_version(), format!("lazysh-agent {THIS}"));
}

#[test]
fn the_channel_decides_which_release_a_check_looks_at() {
    let mut prerelease = release_of("99.1.0", &companion("99.1.0"));
    prerelease.prerelease = true;
    let host = Host::due_with(&[release_of(NEW, &companion(NEW)), prerelease]);
    assert_eq!(host.set(&["--policy", "notify"]).0, 0);
    assert_eq!(host.check()["latest"], NEW);
    host.checked(Hours::hours(48));
    assert_eq!(
        host.set(&["--policy", "notify", "--channel", "prerelease"])
            .0,
        0
    );
    assert_eq!(host.check()["latest"], "99.1.0");
    assert_eq!(host.last_check()["latest"], "99.1.0");
    assert_eq!(host.fixture.server.companion_downloads(), 0);
}

#[test]
fn an_install_waits_for_its_window_and_a_check_does_not() {
    let host = Host::due();
    assert_eq!(
        host.set(&["--policy", "install", "--window", &window(2, 3)])
            .0,
        0
    );
    let reply = host.check();
    assert_eq!(
        (reply["state"].as_str(), reply["reason"].as_str()),
        (Some("skipped"), Some("outsideWindow"))
    );
    // It still looked, so the app can say an update is waiting.
    assert_eq!(host.last_check()["available"], true);
    assert_eq!(host.fixture.server.companion_downloads(), 0);
    assert_eq!(host.installed_version(), format!("lazysh-agent {THIS}"));
    // A newer app that connects is held by the same window.
    assert_eq!(host.connect(NEW).unwrap()["reason"], "outsideWindow");
    assert_eq!(host.fixture.server.companion_downloads(), 0);
    // The window opens. The earlier check was not long ago, but an update that waits is looked at again soon.
    assert_eq!(
        host.set(&["--policy", "install", "--window", &window(-1, 1)])
            .0,
        0
    );
    host.found(1);
    assert_eq!(host.check()["state"], "updated");
    assert_eq!(host.installed_version(), format!("lazysh-agent {NEW}"));
}

#[test]
fn an_agent_turn_in_progress_holds_a_scheduled_install() {
    let host = Host::due();
    host.ingest("working");
    let reply = host.check();
    assert_eq!(
        (reply["state"].as_str(), reply["reason"].as_str()),
        (Some("skipped"), Some("activeTurn"))
    );
    assert_eq!(host.fixture.server.companion_downloads(), 0);
    assert_eq!(host.last_check()["available"], true);
    host.ingest("done");
    // The turn is over; the deferral of two minutes is not worth waiting out here.
    fs::remove_file(host.state().join("app-update.json")).unwrap();
    host.found(1);
    assert_eq!(host.check()["state"], "updated");
}

#[test]
fn a_release_that_failed_to_install_is_not_tried_again_until_a_newer_one_exists() {
    let host = Host::due();
    host.fixture.server.fault(Some(Fault::TamperedAsset));
    let reply = host.check();
    assert_eq!(
        (reply["state"].as_str(), reply["reason"].as_str()),
        (Some("failed"), Some("verificationFailed"))
    );
    assert_eq!(host.installed_version(), format!("lazysh-agent {THIS}"));
    let downloads = host.fixture.server.companion_downloads();
    assert_eq!(downloads, 1);
    // Looked at again later, it is still the same release: no second download, same answer.
    host.found(2);
    let again = host.check();
    assert_eq!(again["reason"], "verificationFailed");
    assert_eq!(host.fixture.server.companion_downloads(), downloads);
    // A newer release is a new question.
    host.fixture.server.fault(None);
    host.fixture
        .server
        .publish(vec![release_of("99.1.0", &companion("99.1.0"))]);
    host.found(2);
    assert_eq!(host.check()["state"], "updated");
    assert_eq!(host.installed_version(), "lazysh-agent 99.1.0");
}

#[test]
fn a_release_the_user_rolled_back_from_is_not_installed_again_by_a_check() {
    let host = Host::due();
    host.write_state(
        "update-state.json",
        &json!({"schemaVersion":1,"lastOperation":{"action":"rollback","outcome":"rolledBack","from":NEW,"to":THIS}}),
    );
    let reply = host.check();
    assert_eq!(
        (reply["state"].as_str(), reply["reason"].as_str()),
        (Some("skipped"), Some("rolledBack"))
    );
    assert_eq!(host.fixture.server.companion_downloads(), 0);
    assert_eq!(host.last_check()["available"], true);
}

#[test]
fn settings_are_changed_one_revision_at_a_time_and_bad_ones_are_refused() {
    let host = Host::due();
    let (_, status) = host.auto_update(&["status"]);
    assert_eq!(
        [
            status["policy"].clone(),
            status["channel"].clone(),
            status["intervalHours"].clone(),
            status["window"].clone(),
            status["lastCheck"].clone(),
        ],
        [
            json!("install"),
            json!("stable"),
            json!(24),
            Value::Null,
            Value::Null
        ]
    );
    assert!(
        !host.state().exists(),
        "reading the defaults creates nothing"
    );
    let (code, set) = host.set(&[
        "--policy",
        "notify",
        "--channel",
        "prerelease",
        "--interval-hours",
        "6",
        "--window",
        "22:00-06:00",
    ]);
    assert_eq!(code, 0);
    assert_eq!(
        [
            set["policy"].clone(),
            set["channel"].clone(),
            set["intervalHours"].clone(),
            set["window"].clone()
        ],
        [
            json!("notify"),
            json!("prerelease"),
            json!(6),
            json!("22:00-06:00")
        ]
    );
    // What is not named stays; `none` removes the window.
    let (_, kept) = host.set(&["--policy", "install"]);
    assert_eq!(
        [
            kept["channel"].clone(),
            kept["intervalHours"].clone(),
            kept["window"].clone()
        ],
        [json!("prerelease"), json!(6), json!("22:00-06:00")]
    );
    let (_, cleared) = host.set(&["--policy", "install", "--window", "none"]);
    assert_eq!(cleared["window"], Value::Null);
    for bad in [
        ["--interval-hours", "0"],
        ["--interval-hours", "721"],
        ["--window", "25:00-06:00"],
        ["--window", "banana"],
        ["--channel", "nightly"],
    ] {
        let (code, _) = host.set(&["--policy", "install", bad[0], bad[1]]);
        assert_eq!(code, 2, "{bad:?}");
    }
    // Two sessions that read revision 3 cannot both write it.
    let stale = host.auto_update(&["set", "--expected-revision", "0", "--policy", "off"]);
    assert_ne!(stale.0, 0);
    assert_eq!(host.auto_update(&["status"]).1["policy"], "install");
}

#[test]
fn a_file_that_only_turns_updates_off_stays_readable_by_a_companion_without_the_new_fields() {
    let host = Host::due();
    assert_eq!(host.set(&["--policy", "off"]).0, 0);
    let written = fs::read_to_string(host.state().join("auto-update.json")).unwrap();
    assert_eq!(
        written.trim(),
        r#"{"schemaVersion":1,"revision":1,"policy":"off"}"#
    );
}

/// What starts a check besides the timer: the read the app already makes.
mod opportunistic {
    use super::*;

    fn snapshot(host: &Host) -> Value {
        let output = host.run(None, &["snapshot", "--limit", "5"]);
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[test]
    fn a_snapshot_starts_a_due_check_without_waiting_for_it() {
        let host = Host::due();
        let begun = Instant::now();
        let reply = snapshot(&host);
        // The reply is the snapshot, with nothing about an update: no app asked.
        assert_eq!(reply["schemaVersion"], 1);
        assert!(reply.get("update").is_none());
        assert!(begun.elapsed() < Duration::from_secs(5));
        host.waits_for("the detached check installs the release", |host| {
            host.installed_version() == format!("lazysh-agent {NEW}")
        });
        assert_eq!(host.fixture.server.companion_downloads(), 1);
    }

    #[test]
    fn however_many_snapshots_ask_one_check_runs() {
        let host = Host::due();
        assert_eq!(host.set(&["--policy", "notify"]).0, 0);
        thread::scope(|scope| {
            let all: Vec<_> = (0..8).map(|_| scope.spawn(|| snapshot(&host))).collect();
            all.into_iter()
                .for_each(|reply| drop(reply.join().unwrap()));
        });
        host.waits_for("the check is recorded", |host| {
            fs::read(host.state().join("update-state.json")).is_ok()
        });
        // Later snapshots find a check that was just made and start nothing.
        thread::sleep(Duration::from_millis(300));
        snapshot(&host);
        thread::sleep(Duration::from_millis(500));
        let latest = host
            .paths()
            .iter()
            .filter(|path| path.ends_with("/releases/latest"))
            .count();
        assert_eq!(latest, 1, "{:?}", host.paths());
    }

    #[test]
    fn nothing_is_started_when_off_not_due_or_not_the_managed_companion() {
        let host = Host::due();
        assert_eq!(host.set(&["--policy", "off"]).0, 0);
        snapshot(&host);
        let (_, status) = host.auto_update(&["status"]);
        assert_eq!(status["policy"], "off");
        assert_eq!(host.set(&["--policy", "notify"]).0, 0);
        host.checked(Hours::minutes(5));
        snapshot(&host);
        // A development build or a copy on PATH is not what updates itself.
        host.checked(Hours::hours(48));
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
        command
            .env_clear()
            .args(["snapshot", "--limit", "5"])
            .envs(host.environment(None));
        assert!(command.output().unwrap().status.success());
        thread::sleep(Duration::from_secs(1));
        host.assert_offline();
        assert_eq!(host.installed_version(), format!("lazysh-agent {THIS}"));
    }

    #[test]
    fn a_hook_never_starts_a_check() {
        let host = Host::due();
        host.ingest("working");
        host.ingest("done");
        thread::sleep(Duration::from_secs(1));
        host.assert_offline();
        assert!(!host.state().join("update-state.json").exists());
    }
}
