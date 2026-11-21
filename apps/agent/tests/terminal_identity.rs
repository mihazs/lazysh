#[path = "support/process.rs"]
mod process;
use serde_json::{json, Value};
use std::process::Command;

const TERMINAL: &str = "0123456789abcdef0123456789abcdef";

/// Runs the real `lazysh-agent ingest` as a hook of an agent whose terminal exports `environment`, and returns the
/// pane identity the stored report carries.
fn reported_pane(environment: &[(&str, &str)]) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let mut hook = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    hook.args(["ingest", "--agent", "claude"])
        .env("LAZYSH_STATE_DIR", directory.path())
        .envs(environment.iter().copied());
    // Whatever multiplexer or launched terminal runs the test must not leak into the cases.
    for name in [
        "TMUX_PANE",
        "ZELLIJ_SESSION_NAME",
        "ZELLIJ_PANE_ID",
        "LAZYSH_TERMINAL",
    ] {
        if !environment.iter().any(|(set, _)| *set == name) {
            hook.env_remove(name);
        }
    }
    let payload = json!({"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"/work"});
    let report = process::run(&mut hook, &serde_json::to_vec(&payload).unwrap());
    assert!(report.status.success(), "{report:?}");
    let mut snapshot = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    snapshot
        .args(["snapshot", "--limit", "10"])
        .env("LAZYSH_STATE_DIR", directory.path());
    let output = process::run(&mut snapshot, b"");
    assert!(output.status.success(), "{output:?}");
    let state: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(state["sessions"].as_array().unwrap().len(), 1);
    state["sessions"][0]["paneId"].clone()
}

#[test]
fn a_hook_in_a_launched_terminal_reports_its_identifier_and_one_elsewhere_reports_none() {
    assert_eq!(
        reported_pane(&[("LAZYSH_TERMINAL", TERMINAL)]),
        format!("lazysh:{TERMINAL}")
    );
    assert_eq!(reported_pane(&[]), Value::Null);
}

#[test]
fn a_malformed_identifier_is_dropped_without_failing_the_hook() {
    for terminal in [
        "",
        "not-an-identifier",
        &TERMINAL.to_uppercase(),
        &TERMINAL[1..],
        &format!("{TERMINAL}0"),
        &format!("{}\n", &TERMINAL[1..]),
    ] {
        assert_eq!(
            reported_pane(&[("LAZYSH_TERMINAL", terminal)]),
            Value::Null,
            "{terminal:?}"
        );
    }
}

#[test]
fn a_multiplexer_pane_still_names_itself_inside_a_launched_terminal() {
    assert_eq!(
        reported_pane(&[("LAZYSH_TERMINAL", TERMINAL), ("TMUX_PANE", "%7")]),
        "%7"
    );
    assert_eq!(
        reported_pane(&[
            ("LAZYSH_TERMINAL", TERMINAL),
            ("ZELLIJ_SESSION_NAME", "work"),
            ("ZELLIJ_PANE_ID", "3"),
        ]),
        "zellij:work:3"
    );
}
