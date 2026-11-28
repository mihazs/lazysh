#![cfg(target_os = "linux")]
//! `auto-update enable|disable|status` on Linux: the real `lazysh-agent` as the managed companion of
//! an isolated home, with a stand-in `systemctl` ahead of the system's own on its `PATH` (a test must
//! never touch the real user manager). The unit files it writes are the real ones, and
//! `systemd-analyze verify` checks them. Other platforms' formats are checked where they are
//! rendered, in the crate's own tests. Built with the `update-test-endpoint` seam.
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
#[path = "support/update_host.rs"]
#[allow(dead_code)]
mod host;
use host::{fixture::NAME, Host};

/// A `systemctl` that keeps what a user manager would: a log of its calls and whether the timer is
/// enabled, and fails on request. `no-manager` makes it answer like a bare SSH login, `fail-enable`
/// like a manager that refuses.
fn systemctl(root: &Path) -> PathBuf {
    let tools = root.join("tools");
    fs::create_dir_all(&tools).unwrap();
    let state = root.join("manager");
    fs::create_dir_all(&state).unwrap();
    let script = format!(
        r#"#!/bin/sh
echo "$@" >> "{state}/log"
[ "$1" = "--user" ] || exit 64
shift
case "$1" in
  show) [ -e "{state}/no-manager" ] && exit 1; echo Version=999; exit 0 ;;
  daemon-reload) exit 0 ;;
  enable) [ -e "{state}/fail-enable" ] && exit 1; touch "{state}/enabled"; exit 0 ;;
  disable) rm -f "{state}/enabled"; exit 0 ;;
  is-enabled) if [ -e "{state}/enabled" ]; then echo enabled; exit 0; fi; echo disabled; exit 1 ;;
esac
exit 64
"#,
        state = state.display()
    );
    let path = tools.join("systemctl");
    fs::write(&path, script).unwrap();
    host::fixture::mode(&path, 0o755);
    tools
}

struct Linux {
    host: Host,
}
impl Linux {
    fn new() -> Self {
        let mut host = Host::due();
        host.tools = Some(systemctl(host.fixture.root.path()));
        Self { host }
    }
    fn manager(&self, name: &str) -> PathBuf {
        self.host.fixture.root.path().join("manager").join(name)
    }
    fn units(&self) -> PathBuf {
        self.host.fixture.root.path().join(".config/systemd/user")
    }
    fn service(&self) -> PathBuf {
        self.units().join("lazysh-agent-update.service")
    }
    fn timer_file(&self) -> PathBuf {
        self.units().join("lazysh-agent-update.timer")
    }
    /// The calls that asked the manager to change something, one per line (reading is free).
    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.manager("log"))
            .unwrap_or_default()
            .lines()
            .filter(|call| !call.contains(" show ") && !call.contains("is-enabled"))
            .map(str::to_owned)
            .collect()
    }
    fn auto_update(&self, args: &[&str]) -> (i32, Value) {
        let mut words = vec!["auto-update"];
        words.extend(args);
        let output = self.host.run(None, &words);
        let reply = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
        (output.status.code().unwrap(), reply)
    }
    fn timer(&self) -> Value {
        self.auto_update(&["status"]).1["timer"].clone()
    }
}

#[test]
fn enable_installs_units_that_systemd_accepts_and_turns_the_timer_on() {
    let host = Linux::new();
    let (code, reply) = host.auto_update(&["enable"]);
    assert_eq!(code, 0, "{reply}");
    assert_eq!(reply["schemaVersion"], 1);
    assert_eq!(
        reply["timer"],
        serde_json::json!({"kind":"systemd","supported":true,"installed":true,"enabled":true,"drift":false})
    );
    assert_eq!(
        host.calls()
            .iter()
            .map(String::as_str)
            .filter(|call| !call.contains("show") && !call.contains("is-enabled"))
            .collect::<Vec<_>>(),
        [
            "--user daemon-reload",
            "--user enable --now lazysh-agent-update.timer"
        ]
    );
    // The real files, checked by systemd itself: syntax, the schedule, and that the program it runs
    // is the managed companion, which is only found when the path in the unit is right.
    let verify = Command::new("systemd-analyze")
        .args(["--user", "verify"])
        .arg(host.service())
        .arg(host.timer_file())
        .output();
    match verify {
        Ok(output) => assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        ),
        Err(_) => eprintln!("skipped: systemd-analyze is not installed on this host"),
    }
    // Idempotent: again changes nothing and still works.
    let (code, again) = host.auto_update(&["enable"]);
    assert_eq!((code, again["timer"].clone()), (0, reply["timer"].clone()));
}

#[test]
fn the_timer_runs_what_the_settings_say_without_being_touched_by_them() {
    let host = Linux::new();
    assert_eq!(host.auto_update(&["enable"]).0, 0);
    let before = (
        fs::read(host.service()).unwrap(),
        fs::read(host.timer_file()).unwrap(),
    );
    let (_, status) = host.auto_update(&["status"]);
    let revision = status["revision"].to_string();
    let set = host.auto_update(&[
        "set",
        "--expected-revision",
        &revision,
        "--policy",
        "notify",
        "--interval-hours",
        "6",
    ]);
    assert_eq!(set.0, 0);
    assert_eq!(
        before,
        (
            fs::read(host.service()).unwrap(),
            fs::read(host.timer_file()).unwrap()
        )
    );
    assert_eq!(host.timer()["drift"], false);
}

#[test]
fn enable_refuses_while_updates_are_off_and_changes_nothing() {
    let host = Linux::new();
    assert_eq!(
        host.auto_update(&["set", "--expected-revision", "0", "--policy", "off"])
            .0,
        0
    );
    assert_eq!(host.auto_update(&["enable"]).0, 40);
    assert!(!host.units().exists());
    assert!(host.calls().iter().all(|call| !call.contains("enable")));
}

#[test]
fn a_host_with_no_user_manager_gets_a_clear_refusal_and_nothing_written() {
    let host = Linux::new();
    fs::write(host.manager("no-manager"), "").unwrap();
    assert_eq!(host.auto_update(&["enable"]).0, 41);
    assert!(!host.units().exists());
    let timer = host.timer();
    assert_eq!(
        (timer["supported"].clone(), timer["installed"].clone()),
        (false.into(), false.into())
    );
}

#[test]
fn a_manager_that_refuses_leaves_the_files_as_they_were() {
    let host = Linux::new();
    fs::write(host.manager("fail-enable"), "").unwrap();
    // Never installed before: nothing is left behind.
    assert_eq!(host.auto_update(&["enable"]).0, 42);
    assert!(!host.service().exists() && !host.timer_file().exists());
    // Installed by an earlier companion at another path: its files are put back, not lost.
    fs::remove_file(host.manager("fail-enable")).unwrap();
    assert_eq!(host.auto_update(&["enable"]).0, 0);
    let earlier = fs::read_to_string(host.service())
        .unwrap()
        .replace(host.host.fixture.managed().to_str().unwrap(), "/old/place");
    fs::write(host.service(), &earlier).unwrap();
    assert_eq!(host.timer()["drift"], true, "an edited unit is drift");
    fs::write(host.manager("fail-enable"), "").unwrap();
    assert_eq!(host.auto_update(&["enable"]).0, 42);
    assert_eq!(fs::read_to_string(host.service()).unwrap(), earlier);
}

#[test]
fn a_file_that_is_not_ours_is_never_replaced_or_removed() {
    let host = Linux::new();
    fs::create_dir_all(host.units()).unwrap();
    fs::write(host.timer_file(), "[Timer]\nOnCalendar=weekly\n").unwrap();
    assert_eq!(host.auto_update(&["enable"]).0, 42);
    assert_eq!(
        fs::read_to_string(host.timer_file()).unwrap(),
        "[Timer]\nOnCalendar=weekly\n"
    );
    assert!(!host.service().exists(), "nothing of ours was written");
    assert_eq!(host.auto_update(&["disable"]).0, 0);
    assert!(host.timer_file().exists());
    // A link is not ours either, even to a file that is.
    fs::remove_file(host.timer_file()).unwrap();
    assert_eq!(host.auto_update(&["enable"]).0, 0);
    let real = host.units().join("real.timer");
    fs::rename(host.timer_file(), &real).unwrap();
    std::os::unix::fs::symlink(&real, host.timer_file()).unwrap();
    assert_eq!(host.auto_update(&["enable"]).0, 42);
    assert_eq!(host.auto_update(&["disable"]).0, 0);
    assert!(host.timer_file().is_symlink());
}

#[test]
fn disable_removes_only_what_enable_wrote_and_is_idempotent() {
    let host = Linux::new();
    assert_eq!(host.auto_update(&["enable"]).0, 0);
    fs::write(host.units().join("mine.timer"), "[Timer]\n").unwrap();
    let (code, reply) = host.auto_update(&["disable"]);
    assert_eq!(code, 0, "{reply}");
    assert_eq!(reply["timer"]["installed"], false);
    assert_eq!(reply["timer"]["enabled"], false);
    assert_eq!(
        fs::read_dir(host.units()).unwrap().count(),
        1,
        "only the user's own file is left"
    );
    assert!(host
        .calls()
        .iter()
        .any(|call| call == "--user disable --now lazysh-agent-update.timer"));
    // Nothing there: nothing is asked of the manager.
    let calls = host.calls().len();
    assert_eq!(host.auto_update(&["disable"]).0, 0);
    assert_eq!(host.calls().len(), calls);
}

#[test]
fn status_reads_the_real_state_and_reports_what_changed_behind_its_back() {
    let host = Linux::new();
    let none = host.timer();
    assert_eq!(
        (
            none["installed"].clone(),
            none["enabled"].clone(),
            none["drift"].clone()
        ),
        (false.into(), false.into(), false.into())
    );
    assert_eq!(host.auto_update(&["enable"]).0, 0);
    assert_eq!(host.timer()["drift"], false);
    // Disabled by the user's own `systemctl disable`: the files are still ours but it will not run.
    fs::remove_file(host.manager("enabled")).unwrap();
    let off = host.timer();
    assert_eq!(
        (
            off["installed"].clone(),
            off["enabled"].clone(),
            off["drift"].clone()
        ),
        (true.into(), false.into(), true.into())
    );
    // And repaired by enabling again.
    assert_eq!(host.auto_update(&["enable"]).0, 0);
    assert_eq!(host.timer()["drift"], false);
}

#[test]
fn a_companion_that_is_not_the_managed_copy_cannot_be_scheduled() {
    let host = Linux::new();
    fs::remove_file(host.host.fixture.managed().join(NAME)).unwrap();
    // The unit would have nothing to run: this build stands in for the companion being run by hand.
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env_clear()
        .args(["auto-update", "enable"])
        .envs(host.host.environment(None))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(27));
    assert!(!host.units().exists());
}
