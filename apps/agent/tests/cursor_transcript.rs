use lazysh_agent::transcript::{discover, read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::{fs, io::Write};

#[test]
fn cursor_export_preserves_text_and_calls_without_fabricating_missing_fields() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("conversation.jsonl");
    let mut file = fs::File::create(&path).unwrap();
    for value in [
        json!({"type":"metadata","metadata":{"overview":"IGNORE"}}),
        json!({"role":"user","message":{"content":[{"type":"text","text":"Fix tests"}]}}),
        json!({"role":"assistant","message":{"content":[{"type":"text","text":"Running tests\n\nInspect tests first"},{"type":"tool_use","name":"run_terminal_cmd","input":{"command":"cargo test"}}]}}),
        json!({"role":"tool","message":{"content":[{"type":"text","text":"NOT EXPORTED"}]}}),
        json!({"type":"turn_ended","status":"success"}),
        json!({"role":"system","message":{"content":[{"type":"text","text":"SECRET"}]}}),
    ] {
        serde_json::to_writer(&mut file, &value).unwrap();
        writeln!(file).unwrap();
    }
    let first = read_page(&path, TranscriptAgent::Cursor, 0, 1).unwrap();
    assert_eq!(first.messages.len(), 1);
    assert!(first.has_more);
    let next = read_page(&path, TranscriptAgent::Cursor, first.next_offset, 50).unwrap();
    assert_eq!(next.messages.len(), 1);
    assert_eq!(next.messages[0]["blocks"][0]["type"], "text");
    assert_eq!(next.messages[0]["blocks"][1]["name"], "run_terminal_cmd");
    assert!(next.messages[0]["blocks"][1].get("id").is_none());
    for field in ["usage", "parentId", "timestamp"] {
        assert!(next.messages[0].get(field).is_none());
    }
    assert!(!next.has_more);
    assert_ne!(first.messages[0]["id"], next.messages[0]["id"]);
}

#[test]
fn cursor_discovery_accepts_flat_and_current_layout_but_excludes_other_files_and_subagents() {
    let directory = tempfile::tempdir().unwrap();
    let transcripts = directory.path().join("workspace/agent-transcripts");
    fs::create_dir_all(transcripts.join("main/subagents")).unwrap();
    for path in [
        transcripts.join("legacy.jsonl"),
        transcripts.join("main/main.jsonl"),
        transcripts.join("main/wrong.jsonl"),
        transcripts.join("main/subagents/child.jsonl"),
        directory.path().join("workspace/other.jsonl"),
    ] {
        fs::write(path, "PRIVATE NOT READ DURING DISCOVERY").unwrap();
    }
    let result: Value = serde_json::to_value(
        discover(TranscriptAgent::Cursor, Some(directory.path()), 50).unwrap(),
    )
    .unwrap();
    assert_eq!(result["sessions"].as_array().unwrap().len(), 2);
    assert!(result["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|session| {
            matches!(
                session["name"].as_str(),
                Some("legacy.jsonl" | "main.jsonl")
            )
        }));
}

#[test]
fn cursor_cli_uses_explicit_versioned_record_stream() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("chat.jsonl");
    fs::write(&path, "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Hello\"}]}}\n").unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .arg("transcript")
        .args(["--agent", "cursor", "--path"])
        .arg(path)
        .output()
        .unwrap();
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["agent"], "cursor");
    assert_eq!(value["view"], "record_stream");
}
