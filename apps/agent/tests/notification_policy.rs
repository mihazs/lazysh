//! The notification policy through the real `lazysh-agent` binary. The relay is switched on by writing its
//! policy row into the state database the binary opened (a live relay needs a server); everything else, the
//! hook input, the process tree, `PATH` and the exit codes, is the real thing.
#[path = "support/process.rs"]
mod process;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const PARENT_SESSION: &str = "LAZYSH_PARENT_SESSION_ID";

struct Host {
    _root: tempfile::TempDir,
    state: PathBuf,
}
fn command_of(program: impl AsRef<std::ffi::OsStr>, state: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .env("LAZYSH_STATE_DIR", state)
        .env_remove(PARENT_SESSION)
        .env_remove("TMUX_PANE");
    command
}
fn command(state: &Path) -> Command {
    command_of(env!("CARGO_BIN_EXE_lazysh-agent"), state)
}
fn run(state: &Path, args: &[&str], input: &[u8]) -> Output {
    process::run(command(state).args(args), input)
}
fn show(state: &Path) -> Value {
    let output = run(state, &["settings", "notifications", "show"], b"");
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}
fn set(state: &Path, revision: u64, nested: bool, unlocked: bool) -> Output {
    run(
        state,
        &[
            "settings",
            "notifications",
            "update",
            "--expected-revision",
            &revision.to_string(),
            "--nested-agent-suppression-enabled",
            &nested.to_string(),
            "--suppress-while-desktop-unlocked",
            &unlocked.to_string(),
        ],
        b"",
    )
}
/// A state directory with the relay enabled, as `relay configure --enable` leaves it.
fn host_with_relay() -> Host {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    assert!(run(&state, &["snapshot"], b"").status.success());
    let (account, source) = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let binding = json!({"schemaVersion":1,"origin":"https://relay.invalid","accountId":account,"sourceId":source,"capabilityHash":"a".repeat(64),"caHash":null});
    let configuration = json!({"schemaVersion":1,"capabilityFile":state.join("missing-capability"),"caFile":null,"binding":binding.to_string(),"accountId":account,"sourceId":source,"remoteGeneration":7});
    rusqlite::Connection::open(state.join("events.sqlite3"))
        .unwrap()
        .execute(
            "INSERT INTO relay_policy VALUES(1,1,1,?1,0)",
            [configuration.to_string()],
        )
        .unwrap();
    Host { _root: root, state }
}
fn queued(state: &Path) -> i64 {
    rusqlite::Connection::open(state.join("events.sqlite3"))
        .unwrap()
        .query_row("SELECT count(*) FROM relay_outbox", [], |row| row.get(0))
        .unwrap()
}
fn sessions(state: &Path) -> Vec<Value> {
    let output = run(state, &["snapshot"], b"");
    serde_json::from_slice::<Value>(&output.stdout).unwrap()["sessions"]
        .as_array()
        .unwrap()
        .clone()
}
fn prompt(session: &str) -> Vec<u8> {
    serde_json::to_vec(
        &json!({"hook_event_name":"UserPromptSubmit","session_id":session,"cwd":"/work"}),
    )
    .unwrap()
}
/// Ingest one Codex prompt with `edit` applied to the command; how many relay events it queued.
fn queued_by(host: &Host, session: &str, edit: impl FnOnce(&mut Command)) -> i64 {
    let before = queued(&host.state);
    let mut ingest = command(&host.state);
    ingest.args(["ingest", "--agent", "codex"]);
    edit(&mut ingest);
    let output = process::run(&mut ingest, &prompt(session));
    assert!(output.status.success(), "{output:?}");
    assert!(sessions(&host.state)
        .iter()
        .any(|stored| stored["sessionId"] == session));
    queued(&host.state) - before
}

#[test]
fn both_switches_default_off_and_change_only_with_the_current_revision() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let defaults = show(&state);
    assert_eq!(defaults["revision"], 0);
    assert_eq!(defaults["nestedAgentSuppressionEnabled"], false);
    assert_eq!(defaults["suppressWhileDesktopUnlocked"], false);
    assert!(!state.exists(), "show creates nothing");

    let first = set(&state, 0, true, false);
    assert!(first.status.success());
    let changed = show(&state);
    assert_eq!(changed["revision"], 1);
    assert_eq!(changed["nestedAgentSuppressionEnabled"], true);
    assert_eq!(changed["suppressWhileDesktopUnlocked"], false);

    let stale = set(&state, 0, false, true);
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("NotificationPolicyConflict"));
    assert_eq!(show(&state), changed);
    assert_eq!(set(&state, 1, false, true).status.code(), Some(0));
    assert_eq!(show(&state)["revision"], 2);

    // An older companion sharing the directory keeps reading settings.json, which this never touches.
    let settings = run(&state, &["settings", "show"], b"");
    let settings: Value = serde_json::from_slice(&settings.stdout).unwrap();
    assert_eq!(settings.as_object().unwrap().len(), 5);
    assert!(!state.join("settings.json").exists());
}

#[test]
fn a_damaged_policy_file_is_reported_by_show_but_never_stops_a_hook() {
    let host = host_with_relay();
    assert!(set(&host.state, 0, true, true).status.success());
    fs::write(host.state.join("notification-policy.json"), "{not json").unwrap();
    assert!(
        !run(&host.state, &["settings", "notifications", "show"], b"")
            .status
            .success()
    );
    // The policy reads as absent, so the hook is stored and notifies as it did before the switch existed.
    assert_eq!(queued_by(&host, "damaged", |_| {}), 1);
}

#[test]
fn a_nested_ingest_is_stored_but_queues_no_relay_event_only_while_the_switch_is_on() {
    let host = host_with_relay();
    let declared = |ingest: &mut Command| {
        ingest.env(PARENT_SESSION, "outer-session");
    };
    assert_eq!(queued_by(&host, "off", declared), 1);
    assert!(set(&host.state, 0, true, false).status.success());
    assert_eq!(queued_by(&host, "on", declared), 0);
    assert!(set(&host.state, 1, false, false).status.success());
    assert_eq!(queued_by(&host, "off-again", declared), 1);
}

#[cfg(unix)]
fn script(directory: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

/// lazysh-agent <- codex <- claude, as scripts named like the agents: the process table names a script by
/// its file name, the way it names the real programs.
#[cfg(unix)]
#[test]
fn an_agent_whose_ancestor_is_another_agent_is_nested() {
    let host = host_with_relay();
    let bin = host._root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let companion = env!("CARGO_BIN_EXE_lazysh-agent");
    let inner = script(&bin, "codex", &format!("'{companion}' \"$@\""));
    let outer = script(&bin, "claude", &format!("'{}' \"$@\"", inner.display()));
    let ingest = |session: &str| {
        let output = process::run(
            command_of(&outer, &host.state).args(["ingest", "--agent", "codex"]),
            &prompt(session),
        );
        assert!(output.status.success(), "{output:?}");
        assert!(sessions(&host.state)
            .iter()
            .any(|stored| stored["sessionId"] == session));
    };
    assert!(set(&host.state, 0, true, false).status.success());
    ingest("tree");
    assert_eq!(queued(&host.state), 0, "a nested agent queues nothing");
    // The same chain notifies with the switch off, which also shows the hook really ran.
    assert!(set(&host.state, 1, false, false).status.success());
    ingest("tree-off");
    assert_eq!(queued(&host.state), 1);
}

/// A `loginctl` that reports the user's display session as local, active and Wayland, with this lock hint.
#[cfg(target_os = "linux")]
fn logind(directory: &Path, locked_hint: &str) -> PathBuf {
    let bin = directory.join(format!("logind-{locked_hint}"));
    fs::create_dir(&bin).unwrap();
    script(
        &bin,
        "loginctl",
        &format!(
            "case \"$1\" in show-user) echo Display=3;; \
             show-session) printf 'Type=wayland\\nRemote=no\\nActive=yes\\nLockedHint={locked_hint}\\n';; esac"
        ),
    );
    bin
}

#[cfg(target_os = "linux")]
#[test]
fn an_unlocked_desktop_suppresses_only_with_the_switch_on_and_any_other_state_notifies() {
    let host = host_with_relay();
    let on = |path: &Path| {
        let path = path.to_owned();
        move |ingest: &mut Command| {
            ingest.env("PATH", &path);
        }
    };
    let bins = host._root.path();
    let (unlocked, locked) = (logind(bins, "no"), logind(bins, "yes"));
    let nothing = bins.join("no-logind");
    fs::create_dir(&nothing).unwrap();

    assert_eq!(queued_by(&host, "switch-off", on(&unlocked)), 1);
    assert!(set(&host.state, 0, false, true).status.success());
    assert_eq!(queued_by(&host, "unlocked", on(&unlocked)), 0);
    assert_eq!(queued_by(&host, "locked", on(&locked)), 1);
    assert_eq!(queued_by(&host, "unknown", on(&nothing)), 1, "no loginctl");
}

#[test]
fn a_nested_agents_permission_request_takes_no_approval_and_leaves_the_decision_to_the_agent() {
    let host = host_with_relay();
    let request = |timeout: &str, session: &str| {
        let payload = json!({"hook_event_name":"PermissionRequest","session_id":session,"cwd":"/work","tool_name":"Bash","tool_input":{"command":"ls"}});
        process::run(
            command(&host.state)
                .env(PARENT_SESSION, "outer-session")
                .args([
                    "approval-request",
                    "--agent",
                    "claude",
                    "--timeout-seconds",
                    timeout,
                ]),
            &serde_json::to_vec(&payload).unwrap(),
        )
    };
    // Off: the request is taken, waits its second and answers as it always did.
    let waited = request("1", "taken");
    assert!(waited.status.success());
    let answer: Value = serde_json::from_slice(&waited.stdout).unwrap();
    assert_eq!(answer["hookSpecificOutput"]["decision"]["behavior"], "deny");
    assert_eq!(queued(&host.state), 1);

    assert!(set(&host.state, 0, true, false).status.success());
    let nested = request("600", "nested");
    assert!(nested.status.success(), "{nested:?}");
    assert!(nested.stdout.is_empty(), "no decision is returned");
    let waiting = run(&host.state, &["approval-list"], b"");
    let waiting: Value = serde_json::from_slice(&waiting.stdout).unwrap();
    assert!(waiting["requests"].as_array().unwrap().is_empty());
    // The session is recorded as waiting, but no second notification was queued.
    assert!(sessions(&host.state)
        .iter()
        .any(|stored| stored["sessionId"] == "nested" && stored["state"] == "needs_attention"));
    assert_eq!(queued(&host.state), 1);
}
