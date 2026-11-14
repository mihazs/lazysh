//! What a needs-attention agent waits for, from real hook payloads through the stored snapshot.
#[path = "support/process.rs"]
mod process;
use serde_json::{json, Value};
use std::{path::Path, process::Command};

fn run(directory: &Path, args: &[&str], input: &Value) -> Value {
    let output = process::run(
        Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .args(args)
            .env("LAZYSH_STATE_DIR", directory),
        &serde_json::to_vec(input).unwrap(),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or(Value::Null)
}
fn hook(directory: &Path, payload: Value) {
    run(directory, &["ingest", "--agent", "claude"], &payload);
}
fn session(directory: &Path) -> Value {
    run(directory, &["snapshot"], &Value::Null)["sessions"][0].clone()
}
fn event(name: &str) -> Value {
    json!({"hook_event_name":name,"session_id":"s","cwd":"/work"})
}

#[test]
fn names_the_blocker_and_keeps_the_start_of_an_open_wait() {
    let directory = tempfile::tempdir().unwrap();
    for (tool, kind) in [
        ("Bash", "approval"),
        ("AskUserQuestion", "question"),
        ("ExitPlanMode", "plan"),
    ] {
        hook(
            directory.path(),
            json!({"hook_event_name":"PermissionRequest","session_id":"s","cwd":"/work","tool_name":tool}),
        );
        assert_eq!(session(directory.path())["waiting"], kind, "{tool}");
    }
    let first = session(directory.path())["waitingSince"].clone();
    assert!(first.is_string());
    // A generic notification repeats the wait without replacing its kind or restarting its clock.
    std::thread::sleep(std::time::Duration::from_millis(20));
    hook(
        directory.path(),
        json!({"hook_event_name":"Notification","notification_type":"idle_prompt","session_id":"s","cwd":"/work"}),
    );
    let kept = session(directory.path());
    assert_eq!(kept["waiting"], "plan");
    assert_eq!(kept["waitingSince"], first);
    // Answering moves the report on: nothing waits any more.
    hook(directory.path(), event("PostToolUse"));
    let moved = session(directory.path());
    assert_eq!(moved["state"], "working");
    assert!(moved.get("waiting").is_none() && moved.get("waitingSince").is_none());
}

#[test]
fn a_notification_alone_waits_for_an_unknown_blocker_and_elicitation_is_a_question() {
    let directory = tempfile::tempdir().unwrap();
    hook(
        directory.path(),
        json!({"hook_event_name":"Notification","notification_type":"idle_prompt","session_id":"s","cwd":"/work"}),
    );
    assert_eq!(session(directory.path())["waiting"], "unknown");
    hook(directory.path(), event("Stop"));
    hook(
        directory.path(),
        json!({"hook_event_name":"Notification","notification_type":"elicitation_dialog","session_id":"s","cwd":"/work"}),
    );
    assert_eq!(session(directory.path())["waiting"], "question");
}
