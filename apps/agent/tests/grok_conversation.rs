use lazysh_agent::transcript::{conversation, read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::{fs::OpenOptions, io::Write};
#[path = "support/jsonl.rs"]
mod jsonl;

fn event(tag: &str, fields: Value) -> Value {
    let mut update = fields;
    update["sessionUpdate"] = json!(tag);
    let method = if matches!(
        tag,
        "rewind_marker" | "compaction_checkpoint" | "turn_completed" | "future_timeline"
    ) {
        "_x.ai/session/update"
    } else {
        "session/update"
    };
    json!({"timestamp":1,"method":method,"params":{"sessionId":"owned-fixture","update":update}})
}
fn prompt(index: u64, text: &str) -> Value {
    event(
        "user_message_chunk",
        json!({"content":{"type":"text","text":text},"_meta":{"promptIndex":index}}),
    )
}
fn chunk(text: &str) -> Value {
    event(
        "agent_message_chunk",
        json!({"content":{"type":"text","text":text}}),
    )
}
fn run(events: &[Value]) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    jsonl::write(&path, events);
    serde_json::to_value(conversation(&path, TranscriptAgent::GrokAcp, 100).unwrap()).unwrap()
}
#[test]
fn streamed_chunks_and_tool_replacements_form_one_recorded_timeline() {
    let result = run(&[
        prompt(0, "Inspect "),
        prompt(0, "source"),
        chunk("Hel"),
        chunk("lo"),
        event(
            "tool_call",
            json!({"toolCallId":"t","title":"Read","rawInput":{"path":"never-open"},"status":"pending"}),
        ),
        event(
            "tool_call_update",
            json!({"toolCallId":"t","status":"in_progress","rawOutput":"obsolete"}),
        ),
        event(
            "tool_call_update",
            json!({"toolCallId":"t","title":"Read complete","content":[{"type":"content","content":{"type":"text","text":"final"}}],"status":"completed"}),
        ),
        chunk("Done"),
    ]);
    let messages = result["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0]["blocks"][0]["text"], "Inspect source");
    assert_eq!(messages[1]["blocks"][0]["text"], "Hello");
    assert_eq!(messages[2]["blocks"][0]["name"], "Read complete");
    assert_eq!(messages[2]["blocks"][0]["text"], r#"{"path":"never-open"}"#);
    assert_eq!(messages[2]["blocks"][1]["text"], "final");
    assert_eq!(messages[2]["blocks"][1]["status"], "completed");
    assert_eq!(result["view"], "active_branch");
    assert_eq!(result["truncated"], false);
}
#[test]
fn rewind_removes_abandoned_tool_updates_and_compaction_never_fetches_paths() {
    let result = run(&[
        prompt(0, "first"),
        event(
            "tool_call",
            json!({"toolCallId":"t","title":"Read","status":"pending"}),
        ),
        event(
            "compaction_checkpoint",
            json!({"checkpoint_file":"/forbidden","schema_version":1,"prompt_index_at_compaction":1}),
        ),
        prompt(1, "abandoned"),
        event(
            "tool_call_update",
            json!({"toolCallId":"t","status":"failed"}),
        ),
        event("rewind_marker", json!({"target_prompt_index":1})),
        prompt(1, "replacement"),
        chunk("new branch"),
    ]);
    let encoded = result.to_string();
    assert!(!encoded.contains("abandoned"));
    assert!(!encoded.contains("forbidden"));
    assert!(!encoded.contains("failed"));
    assert!(encoded.contains("pending"));
    assert!(encoded.contains("replacement"));
    assert!(result["branchId"]
        .as_str()
        .unwrap()
        .starts_with("grok-rewind-"));
    let empty = run(&[
        prompt(0, "discard"),
        event("rewind_marker", json!({"target_prompt_index":0})),
    ]);
    assert_eq!(empty["messages"], json!([]));
}
#[test]
fn explicit_empty_output_clears_unknown_status_is_not_a_stale_known_status() {
    let result = run(&[
        event(
            "tool_call",
            json!({"toolCallId":"t","title":"Read","status":"pending","content":[{"type":"content","content":{"type":"text","text":"old"}}]}),
        ),
        event(
            "tool_call_update",
            json!({"toolCallId":"t","content":[],"status":"future"}),
        ),
    ]);
    assert_eq!(result["messages"][0]["blocks"].as_array().unwrap().len(), 1);
    assert!(result["messages"][0]["blocks"][0].get("status").is_none());
}
#[test]
fn unsupported_or_ambiguous_history_fails_without_removing_records_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    for events in [
        vec![chunk("before"), event("future_timeline", json!({}))],
        vec![
            event(
                "user_message_chunk",
                json!({"content":{"type":"text","text":"legacy"}}),
            ),
            event("rewind_marker", json!({"target_prompt_index":0})),
        ],
        vec![
            prompt(0, "first"),
            event("rewind_marker", json!({"target_prompt_index":9})),
        ],
        vec![event(
            "tool_call_update",
            json!({"toolCallId":"missing","status":"completed"}),
        )],
        vec![prompt(2, "missing prefix")],
        vec![
            event("tool_call", json!({"toolCallId":"t","title":"one"})),
            event("tool_call", json!({"toolCallId":"t","title":"two"})),
        ],
    ] {
        jsonl::write(&path, &events);
        assert!(conversation(&path, TranscriptAgent::GrokAcp, 100).is_err());
        assert!(read_page(&path, TranscriptAgent::GrokAcp, 0, 100).is_ok());
    }
}
#[test]
fn partial_tail_latest_limit_and_mixed_session_are_bounded() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    jsonl::write(
        &path,
        &[prompt(0, "one"), chunk("answer"), prompt(1, "two")],
    );
    let size = std::fs::metadata(&path).unwrap().len();
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{partial")
        .unwrap();
    let page = conversation(&path, TranscriptAgent::GrokAcp, 1).unwrap();
    assert!(page.truncated);
    assert!(!page.has_more);
    assert_eq!(page.next_offset, size);
    assert_eq!(page.messages[0]["blocks"][0]["text"], "two");
    let mut other = chunk("foreign");
    other["params"]["sessionId"] = json!("other");
    jsonl::write(&path, &[prompt(0, "one"), other]);
    assert!(conversation(&path, TranscriptAgent::GrokAcp, 100).is_err());
}

#[test]
fn message_ids_media_hidden_prompts_and_repeated_rewinds_preserve_boundaries() {
    let mut first = chunk("first");
    first["params"]["update"]["messageId"] = json!("00000000-0000-4000-8000-000000000001");
    let mut second = first.clone();
    second["params"]["update"]["content"]["text"] = json!(" second");
    let mut hidden = prompt(0, "private model notification");
    hidden["params"]["update"]["_meta"]["hideFromScrollback"] = json!(true);
    let result = run(&[
        hidden,
        first,
        second,
        event(
            "agent_message_chunk",
            json!({"content":{"type":"image","data":"not-retained","uri":"file:///not-read"}}),
        ),
        prompt(1, "old"),
        event("rewind_marker", json!({"target_prompt_index":1})),
        prompt(1, "old again"),
        event("rewind_marker", json!({"target_prompt_index":1})),
        prompt(1, "kept"),
    ]);
    let encoded = result.to_string();
    for absent in [
        "private model notification",
        "not-retained",
        "not-read",
        "old",
    ] {
        assert!(!encoded.contains(absent));
    }
    assert_eq!(result["messages"][0]["blocks"][0]["text"], "first second");
    assert_eq!(result["messages"][1]["blocks"][0]["type"], "image");
    assert!(encoded.contains("kept"));
}

#[test]
fn reconstruction_enforces_file_record_block_and_assembled_text_limits() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    for events in [
        vec![chunk(&"x".repeat(150000)), chunk(&"y".repeat(150000))],
        vec![event("agent_message_chunk", json!({"content":{"type":"image"}})); 1001],
        vec![event("turn_completed", json!({})); 10001],
        vec![chunk(&"z".repeat(262144))],
    ] {
        jsonl::write(&path, &events);
        assert!(conversation(&path, TranscriptAgent::GrokAcp, 100).is_err());
    }
    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
        .unwrap()
        .set_len(16 * 1024 * 1024 + 1)
        .unwrap();
    assert!(conversation(&path, TranscriptAgent::GrokAcp, 100).is_err());
}

#[test]
fn output_budget_keeps_a_truthful_latest_suffix_and_cli_exposes_only_the_requested_view() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    let mut events = Vec::new();
    for index in 0..8 {
        events.push(prompt(index, "prompt"));
        events.push(chunk(&"x".repeat(100000)));
    }
    jsonl::write(&path, &events);
    let page = conversation(&path, TranscriptAgent::GrokAcp, 100).unwrap();
    assert!(page.truncated);
    assert!(serde_json::to_vec(&page.messages).unwrap().len() < 512 * 1024);
    assert!(page.messages.len() < 16);
    assert_eq!(
        page.messages.last().unwrap()["blocks"][0]["text"]
            .as_str()
            .unwrap()
            .len(),
        100000
    );
    for (extra, expected) in [
        (&[][..], "record_stream"),
        (&["--view", "conversation"][..], "active_branch"),
    ] {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .args(["transcript", "--agent", "grok-acp", "--path"])
            .arg(&path)
            .args(extra)
            .env("LAZYSH_STATE_DIR", directory.path().join("state"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["view"], expected);
    }
}
