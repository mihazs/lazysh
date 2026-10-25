use lazysh_agent::transcript::{discover, read_page, TranscriptAgent};
use serde_json::json;
use std::fs;

#[path = "support/jsonl.rs"]
mod jsonl;
use jsonl::write as records;

#[test]
fn copilot_persisted_events_skip_deltas_hidden_context_and_subagents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.jsonl");
    records(
        &path,
        &[
            json!({"type":"session.start","data":{"systemPrompt":"SECRET"}}),
            json!({"id":"u","type":"user.message","data":{"content":"Fix it","transformedContent":"SECRET"}}),
            json!({"id":"delta","ephemeral":true,"type":"assistant.message","data":{"content":"DUPLICATE"}}),
            json!({"type":"user.message","data":{"source":"skill-tests","content":"HIDDEN-SKILL"}}),
            json!({"type":"assistant.message","data":{"parentToolCallId":"task1","content":"OTHER-AGENT"}}),
            json!({"id":"think","type":"assistant.reasoning","data":{"content":"Inspect the failing test"}}),
            json!({"id":"call","type":"tool.execution_start","data":{"toolCallId":"c1","toolName":"bash","arguments":{"command":"cargo test"}}}),
            json!({"id":"result","type":"tool.execution_complete","data":{"toolCallId":"c1","success":true,"result":{"content":"short","detailedContent":"all tests pass"}}}),
            json!({"id":"done","parentId":"result","timestamp":"2026-10-24T20:00:00Z","type":"assistant.message","data":{"content":"Fixed","outputTokens":12,"encryptedContent":"SECRET","toolRequests":[{"toolCallId":"c1"}]}}),
        ],
    );
    let page = read_page(&path, TranscriptAgent::Copilot, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 5);
    assert_eq!(page.messages[1]["blocks"][0]["type"], "thinking");
    assert_eq!(page.messages[2]["blocks"][0]["id"], "c1");
    assert_eq!(page.messages[3]["blocks"][0]["text"], "all tests pass");
    assert_eq!(page.messages[4]["usage"]["outputTokens"], 12);
    assert!(page.messages[4]["usage"].get("inputTokens").is_none());
    assert_eq!(page.messages[4]["parentId"], "result");
    let output = serde_json::to_string(&page).unwrap();
    for secret in ["SECRET", "DUPLICATE", "HIDDEN-SKILL", "OTHER-AGENT"] {
        assert!(!output.contains(secret));
    }
}

#[test]
fn qoder_ide_documented_message_and_tool_shapes_preserve_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoder.jsonl");
    records(
        &path,
        &[
            json!({"type":"session_meta","sessionId":"q1","data":{"meta_type":"session_info","content":{"mode":"agent"}}}),
            json!({"type":"user","uuid":"u1","message":{"role":"user","content":"Read test.py"}}),
            json!({"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"call1","name":"read_file","input":{"file_path":"test.py"}}]}}),
            json!({"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"call1","content":"file text","is_error":false}]}}),
        ],
    );
    let page = read_page(&path, TranscriptAgent::QoderIde, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 3);
    assert_eq!(page.messages[1]["id"], "a1");
    assert_eq!(page.messages[1]["blocks"][0]["name"], "read_file");
    assert_eq!(page.messages[2]["blocks"][0]["text"], "file text");
    assert_eq!(serde_json::to_value(page).unwrap()["agent"], "qoder-ide");
}

#[test]
fn kimi_cli_context_filters_metadata_and_normalizes_plaintext_thinking_and_tools() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.jsonl");
    records(
        &path,
        &[
            json!({"role":"_system_prompt","content":"SECRET"}),
            json!({"role":"_usage","token_count":1000}),
            json!({"role":"_checkpoint","id":0}),
            json!({"role":"user","content":"Fix test"}),
            json!({"role":"assistant","content":[{"type":"think","think":"Inspect","encrypted":"SECRET"},{"type":"text","text":"Running test"}],"tool_calls":[{"type":"function","id":"call1","function":{"name":"Shell","arguments":"{\"command\":\"cargo test\"}"}}]}),
            json!({"role":"tool","tool_call_id":"call1","content":"passed"}),
            json!({"role":"assistant","partial":true,"content":"UNFINISHED"}),
        ],
    );
    let page = read_page(&path, TranscriptAgent::Kimi, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 3);
    assert_eq!(page.messages[1]["blocks"][0]["type"], "thinking");
    assert_eq!(page.messages[1]["blocks"][2]["id"], "call1");
    assert_eq!(page.messages[2]["blocks"][0]["text"], "passed");
    let output = serde_json::to_string(&page).unwrap();
    assert!(!output.contains("SECRET") && !output.contains("UNFINISHED"));
    assert!(page
        .messages
        .iter()
        .all(|message| message.get("usage").is_none()));
}

#[test]
fn discovery_only_includes_expected_agent_transcript_files() {
    let dir = tempfile::tempdir().unwrap();
    for (agent, relative, other) in [
        (
            TranscriptAgent::Copilot,
            "session1/events.jsonl",
            "session1/debug.jsonl",
        ),
        (
            TranscriptAgent::Kimi,
            "work/session1/context.jsonl",
            "work/session1/wire.jsonl",
        ),
        (
            TranscriptAgent::QoderIde,
            "project/transcript/session1.jsonl",
            "project/debug.jsonl",
        ),
    ] {
        let root = dir.path().join(format!("{agent:?}"));
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"do not parse").unwrap();
        let other = root.join(other);
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(other, b"private debug").unwrap();
        let found = serde_json::to_value(discover(agent, Some(&root), 50).unwrap()).unwrap();
        assert_eq!(found["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(found["sessions"][0]["path"], path.to_str().unwrap());
    }
}

#[test]
fn jcode_snapshot_and_journal_replay_deduplicate_stale_checkpoint_entries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session1.json");
    let user = json!({"id":"u1","role":"user","content":[{"type":"text","text":"Fix it"}]});
    let call = json!({"id":"a1","role":"assistant","content":[{"type":"anthropic_thinking","thinking":"Read tests","signature":"SECRET"},{"type":"tool_use","id":"c1","name":"bash","input":{"command":"cargo test"}}],"token_usage":{"input_tokens":12,"output_tokens":5,"cache_read_input_tokens":3}});
    fs::write(
        &path,
        json!({"id":"session1","messages":[user.clone(),call.clone()],"system_prompt":"SECRET"})
            .to_string(),
    )
    .unwrap();
    let result = json!({"id":"u2","role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"passed"}]});
    records(
        &dir.path().join("session1.journal.jsonl"),
        &[
            json!({"meta":{"system_prompt":"SECRET"},"append_messages":[user,call]}),
            json!({"meta":{},"append_messages":[result]}),
        ],
    );
    let snapshot_bytes = fs::read(&path).unwrap();
    let first = read_page(&path, TranscriptAgent::Jcode, 0, 2).unwrap();
    assert_eq!(first.messages.len(), 2);
    assert_eq!(first.messages[1]["usage"]["inputTokens"], 12);
    assert_eq!(first.messages[1]["blocks"][0]["type"], "thinking");
    assert!(first.has_more);
    let second = read_page(&path, TranscriptAgent::Jcode, first.next_offset, 50).unwrap();
    assert_eq!(second.messages.len(), 1);
    assert_eq!(second.messages[0]["blocks"][0]["text"], "passed");
    assert!(!second.has_more);
    assert!(!serde_json::to_string(&first).unwrap().contains("SECRET"));
    assert_eq!(fs::read(&path).unwrap(), snapshot_bytes);
    let found =
        serde_json::to_value(discover(TranscriptAgent::Jcode, Some(dir.path()), 50).unwrap())
            .unwrap();
    assert_eq!(found["sessions"].as_array().unwrap().len(), 1);
}

#[test]
fn jcode_rejects_malformed_or_oversized_snapshots_and_retries_partial_journal_tail() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.json");
    fs::write(
        &path,
        json!({"messages":[{"id":"u","role":"user","content":[{"type":"text","text":"hello"}]}]})
            .to_string(),
    )
    .unwrap();
    fs::write(dir.path().join("session.journal.jsonl"), b"{\"meta\":").unwrap();
    let page = read_page(&path, TranscriptAgent::Jcode, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 1);
    assert!(!page.has_more);
    fs::write(
        dir.path().join("session.journal.jsonl"),
        b"{\"meta\":{}}\nINVALID\n",
    )
    .unwrap();
    assert!(read_page(&path, TranscriptAgent::Jcode, 0, 50).is_err());
    fs::File::create(&path)
        .unwrap()
        .set_len(16 * 1024 * 1024 + 1)
        .unwrap();
    assert!(read_page(&path, TranscriptAgent::Jcode, 0, 50).is_err());
}
