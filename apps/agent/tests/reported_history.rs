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

#[test]
fn gemini_reports_its_session_file_on_the_prompt_event_only_when_opted_in() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory
        .path()
        .join("chats/session-2026-11-13T01-00-abcd1234.jsonl");
    let hook = |event: &str| json!({"hook_event_name":event,"session_id":"gem-1","cwd":"/owned","transcript_path":file,"timestamp":"2026-11-13T01:00:00Z"});
    let lookup = || {
        let output = run(
            directory.path(),
            &["reported-history", "--session-id=gem-1"],
            &Value::Null,
        );
        assert!(output.status.success());
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let ingest = |payload: &Value, flag: bool| {
        let mut args = vec!["ingest", "--agent", "gemini"];
        args.extend(flag.then_some("--reported-history"));
        let output = run(directory.path(), &args, payload);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    ingest(&hook("BeforeAgent"), false);
    assert_eq!(lookup()["status"], "missing");
    // Only the prompt event names the session file; a tool event leaves the record alone.
    ingest(&hook("BeforeTool"), true);
    assert_eq!(lookup()["status"], "missing");
    ingest(&hook("BeforeAgent"), true);
    let source = lookup();
    assert_eq!(
        (
            source["status"].as_str(),
            source["path"].as_str(),
            source["paneId"].as_str()
        ),
        (Some("available"), file.to_str(), Some("%7"))
    );
    let config = run(
        directory.path(),
        &["gemini-config", "--reported-history"],
        &Value::Null,
    );
    let config: Value = serde_json::from_slice(&config.stdout).unwrap();
    assert_eq!(
        config["hooks"]["BeforeAgent"][0]["hooks"][0]["command"],
        "lazysh-agent ingest --agent gemini --reported-history"
    );
    assert_eq!(
        run(directory.path(), &["gemini-config"], &Value::Null).stdout,
        format!("{}\n", lazysh_agent::hooks::gemini_config()).as_bytes()
    );
}
