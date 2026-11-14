#[path = "support/process.rs"]
mod process;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
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

/// `transcript --agent AGENT --reference REFERENCE` with `extra` arguments.
fn read_reference_with(state: &Path, agent: &str, reference: &str, extra: &[&str]) -> Output {
    let mut args = vec!["transcript", "--agent", agent, "--reference", reference];
    args.extend(extra);
    run(state, &args, &Value::Null)
}

fn read_reference(state: &Path, agent: &str, reference: &str) -> Output {
    read_reference_with(state, agent, reference, &["--view", "conversation"])
}

fn reference_for(state: &Path, id: &str) -> Value {
    let output = run(
        state,
        &["reported-history", "--reference", "--session-id", id],
        &Value::Null,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn report(state: &Path, agent: &str, id: &str, path: &Path) {
    let payload = json!({"hook_event_name":"UserPromptSubmit","session_id":id,"cwd":"/owned","transcript_path":path});
    let output = run(
        state,
        &["ingest", "--agent", agent, "--reported-history"],
        &payload,
    );
    assert!(output.status.success());
}

/// A Claude report of `session.jsonl` holding `content`: the state directory, the transcript and the reference issued for it.
fn reported_claude(directory: &Path, content: &str) -> (PathBuf, PathBuf, String) {
    let state = directory.join("state");
    let path = directory.join("session.jsonl");
    std::fs::write(&path, content).unwrap();
    report(&state, "claude", "owned", &path);
    let token = reference_for(&state, "owned")["reference"]
        .as_str()
        .unwrap()
        .to_owned();
    (state, path, token)
}

#[test]
fn a_reference_reads_the_current_host_report_without_ever_returning_its_path() {
    let directory = tempfile::tempdir().unwrap();
    let record =
        json!({"type":"user","uuid":"first","parentUuid":null,"message":{"content":"hello"}});
    let (state, _, token) = reported_claude(directory.path(), &format!("{record}\n"));
    let reply = reference_for(&state, "owned");
    assert_eq!(
        (&reply["status"], &reply["paneId"], &reply["sessionId"]),
        (&json!("available"), &json!("%7"), &json!("owned"))
    );
    assert!(!reply.to_string().contains("session.jsonl"));
    assert_eq!(reply["reference"], json!(token));
    let page = read_reference(&state, "claude", &token);
    assert!(
        page.status.success(),
        "{}",
        String::from_utf8_lossy(&page.stderr)
    );
    assert!(String::from_utf8_lossy(&page.stdout).contains("hello"));
    // A reference is a reading handle, not a way to choose another file or reading mode.
    for extra in [&["--path", "/etc/passwd"][..], &["--session-id", "x"], &[]] {
        let output = read_reference_with(&state, "claude", &token, extra);
        assert!(!output.status.success() && output.stdout.is_empty());
    }
}

#[test]
fn a_stale_altered_or_foreign_reference_is_refused_without_reading_a_file() {
    let directory = tempfile::tempdir().unwrap();
    let content =
        "{\"type\":\"user\",\"uuid\":\"a\",\"message\":{\"content\":\"private words\"}}\n";
    let (state, path, token) = reported_claude(directory.path(), content);
    let refused = |state: &Path, agent: &str, token: &str| {
        let output = read_reference(state, agent, token);
        assert!(!output.status.success(), "{token} was read for {agent}");
        assert!(output.stdout.is_empty());
    };
    // Altered: a reference the companion never issued, and its near misses.
    refused(&state, "claude", &uuid::Uuid::new_v4().to_string());
    refused(&state, "claude", &token.to_uppercase());
    refused(&state, "claude", &format!("{token} "));
    refused(&state, "claude", "../session.jsonl");
    // Foreign: another agent, another host's state, or an agent without reported history.
    refused(&state, "codex", &token);
    refused(&state, "opencode", &token);
    refused(&directory.path().join("other-state"), "claude", &token);
    // The path is gone: the read still fails, with no page.
    let moved = directory.path().join("moved.jsonl");
    std::fs::rename(&path, &moved).unwrap();
    refused(&state, "claude", &token);
    std::fs::rename(&moved, &path).unwrap();
    assert!(read_reference(&state, "claude", &token).status.success());
    // Turning transcript discovery off retires every reference, as it does reported history itself.
    lazysh_agent::settings::update(&state, 0, false, true, true).unwrap();
    refused(&state, "claude", &token);
    lazysh_agent::settings::update(&state, 1, true, true, true).unwrap();
    assert!(read_reference(&state, "claude", &token).status.success());
    // Stale: the report now names another file, or has become ambiguous.
    let elsewhere = directory.path().join("elsewhere.jsonl");
    std::fs::copy(&path, &elsewhere).unwrap();
    report(&state, "claude", "owned", &elsewhere);
    refused(&state, "claude", &token);
    let other = reference_for(&state, "owned");
    assert_eq!(other["status"], "ambiguous");
    assert!(other.get("reference").is_none());
}

#[test]
fn a_codex_reference_reads_the_conversation_its_hook_reported() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let path = directory.path().join("rollout.jsonl");
    let thread = "11111111-1111-4111-8111-111111111111";
    let records = [
        json!({"timestamp":"2026-01-02T03:04:05Z","type":"session_meta","payload":{"id":thread,"history_mode":"legacy"}}),
        json!({"timestamp":"2026-01-02T03:04:05Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}),
        json!({"timestamp":"2026-01-02T03:04:05Z","type":"event_msg","payload":{"type":"user_message","message":"hello from codex"}}),
    ];
    std::fs::write(
        &path,
        records.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    report(&state, "codex", thread, &path);
    let token = reference_for(&state, thread)["reference"]
        .as_str()
        .unwrap()
        .to_owned();
    let page = read_reference(&state, "codex", &token);
    assert!(
        page.status.success(),
        "{}",
        String::from_utf8_lossy(&page.stderr)
    );
    assert!(String::from_utf8_lossy(&page.stdout).contains("hello from codex"));
    assert!(!read_reference(&state, "claude", &token).status.success());
}
