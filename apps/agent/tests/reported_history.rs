#[path = "support/process.rs"]
mod process;
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Command, Output},
};

fn run(directory: &Path, args: &[&str], input: &Value) -> Output {
    process::run(
        Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .args(args)
            .env("LAZYSH_STATE_DIR", directory)
            .env("TMUX_PANE", "%7"),
        &serde_json::to_vec(input).unwrap(),
    )
}

#[test]
fn default_config_and_ingest_remain_unchanged_until_explicit_opt_in() {
    let directory = tempfile::tempdir().unwrap();
    let payload = json!({"hook_event_name":"UserPromptSubmit","session_id":"opaque' $(id)","cwd":"/owned","transcript_path":directory.path().join("history 世界.jsonl "),"prompt":"never leak"});
    let config = run(directory.path(), &["claude-config"], &Value::Null);
    assert!(config.status.success());
    assert_eq!(
        config.stdout,
        format!("{}\n", lazysh_agent::claude_config()).as_bytes()
    );
    let default = run(directory.path(), &["ingest", "--agent", "claude"], &payload);
    assert!(default.status.success() && default.stdout.is_empty());
    let lookup = |args: &[&str]| {
        let output = run(directory.path(), args, &Value::Null);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let args = ["reported-history", "--session-id=opaque' $(id)"];
    assert_eq!(
        lookup(&args),
        json!({"schemaVersion":1,"sessionId":"opaque' $(id)","status":"missing"})
    );
    let opted = run(
        directory.path(),
        &["ingest", "--agent", "claude", "--reported-history"],
        &payload,
    );
    assert!(opted.status.success() && opted.stdout.is_empty());
    assert_eq!(lookup(&args)["path"], payload["transcript_path"]);
    let snapshot = lookup(&["snapshot"]);
    assert_eq!(snapshot["sessions"][0]["eventCount"], 2);
    assert!(
        !snapshot.to_string().contains("transcript_path")
            && !snapshot.to_string().contains("never leak")
    );
    let config = lookup(&["claude-config", "--reported-history"]);
    assert_eq!(
        config["hooks"]["SessionStart"][0]["hooks"][0]["command"],
        "lazysh-agent ingest --agent claude --reported-history"
    );
}

#[test]
fn unsupported_opt_in_and_disabled_discovery_fail_without_fabricated_results() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let output = run(
        &state,
        &["ingest", "--agent", "generic", "--reported-history"],
        &json!({}),
    );
    assert!(!output.status.success() && output.stdout.is_empty());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("InvalidArgument"));
    assert!(!state.join("events.sqlite3").exists());
    lazysh_agent::settings::update(&state, 0, false, true, true).unwrap();
    let output = run(
        &state,
        &["reported-history", "--session-id=owned"],
        &Value::Null,
    );
    assert!(!output.status.success() && output.stdout.is_empty());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("TranscriptDiscoveryDisabled"));
}

#[test]
fn codex_opt_in_reports_its_transcript_with_the_pane_of_its_lifecycle_row() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout codex 世界.jsonl");
    let payload = json!({"hook_event_name":"UserPromptSubmit","session_id":"019a-codex","cwd":"/owned","transcript_path":path,"model":"gpt","prompt":"never leak"});
    let output = |args: &[&str], input: &Value| {
        let output = run(directory.path(), args, input);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    };
    let lookup = || {
        serde_json::from_slice::<Value>(&output(
            &["reported-history", "--session-id=019a-codex"],
            &Value::Null,
        ))
        .unwrap()
    };
    output(&["ingest", "--agent", "codex"], &payload);
    assert_eq!(lookup()["status"], "missing");
    output(
        &["ingest", "--agent", "codex", "--reported-history"],
        &payload,
    );
    let source = lookup();
    assert_eq!(
        (&source["status"], &source["path"], &source["paneId"]),
        (&json!("available"), &json!(path), &json!("%7"))
    );
    let snapshot: Value = serde_json::from_slice(&output(&["snapshot"], &Value::Null)).unwrap();
    let row = &snapshot["sessions"][0];
    assert_eq!(
        (&row["agent"], &row["sessionId"], &row["paneId"]),
        (&json!("Codex"), &json!("019a-codex"), &json!("%7"))
    );
    assert!(!snapshot.to_string().contains("never leak"));
    let config: Value = serde_json::from_slice(&output(
        &["codex-config", "--reported-history"],
        &Value::Null,
    ))
    .unwrap();
    let commands: Vec<_> = config["hooks"]
        .as_object()
        .unwrap()
        .values()
        .map(|rows| rows[0]["hooks"][0]["command"].clone())
        .collect();
    assert!(!commands.is_empty());
    assert!(commands
        .iter()
        .all(|command| command == "lazysh-agent ingest --agent codex --reported-history"));
    let plain: Value = serde_json::from_slice(&output(&["codex-config"], &Value::Null)).unwrap();
    assert_eq!(plain, lazysh_agent::hooks::codex_config());
}
