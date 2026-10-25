use lazysh_agent::transcript::{read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, process::Command};

fn write_records(path: &Path, records: &[Value]) {
    let mut file = fs::File::create(path).unwrap();
    for record in records {
        serde_json::to_writer(&mut file, record).unwrap();
        writeln!(file).unwrap();
    }
}
fn user(text: &str) -> Value {
    json!({"type":"user","uuid":"u1","timestamp":"2026-10-24T20:00:00Z","message":{"role":"user","content":text}})
}

#[test]
fn claude_recorded_tool_errors_preserve_explicit_booleans_and_optional_content() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("errors.jsonl");
    let mut records = Vec::new();
    for flag in [
        json!(true),
        json!(false),
        Value::Null,
        json!("false"),
        json!(0),
    ] {
        records.push(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":[{"type":"text","text":"original output"}],"is_error":flag}]}}));
    }
    records.push(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"empty","is_error":true}]}}));
    records.push(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"missing","content":"unchanged"}]}}));
    write_records(&path, &records);
    let page = read_page(&path, TranscriptAgent::Claude, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 7);
    for (index, expected) in [Some(true), Some(false), None, None, None]
        .into_iter()
        .enumerate()
    {
        let block = &page.messages[index]["blocks"][0];
        assert_eq!(block["isError"].as_bool(), expected);
        assert_eq!(block["text"], "original output");
        assert_eq!(block["id"], "tool1");
    }
    assert_eq!(page.messages[5]["blocks"][0]["isError"], true);
    assert_eq!(page.messages[5]["blocks"][0]["text"], "");
    assert!(page.messages[6]["blocks"][0].get("isError").is_none());
    let other = read_page(&path, TranscriptAgent::QoderIde, 0, 50).unwrap();
    assert!(other
        .messages
        .iter()
        .flat_map(|m| m["blocks"].as_array().unwrap())
        .all(|b| b.get("isError").is_none()));
}

#[test]
fn claude_pages_preserve_content_tools_usage_and_parent_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("transcript.jsonl");
    write_records(
        &path,
        &[
            json!({"type":"system","secret":"must not surface"}),
            user("你好 **world**\n```rust\nfn main() {}\n```"),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"content":[
            {"type":"thinking","thinking":"Check the failing test","signature":"SECRET"},
            {"type":"tool_use","id":"tool1","name":"Bash","input":{"command":"cargo test"}},
            {"type":"image","source":{"data":"DO-NOT-RETURN-BASE64"}}
        ],"usage":{"input_tokens":12,"output_tokens":7,"cache_read_input_tokens":5}}}),
            json!({"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":[{"type":"text","text":"all tests pass"}]}]}}),
        ],
    );
    let first = read_page(&path, TranscriptAgent::Claude, 0, 1).unwrap();
    assert_eq!(first.messages.len(), 1);
    assert_eq!(
        first.messages[0]["blocks"][0]["text"],
        "你好 **world**\n```rust\nfn main() {}\n```"
    );
    assert!(first.has_more);
    let next = read_page(&path, TranscriptAgent::Claude, first.next_offset, 50).unwrap();
    assert_eq!(next.messages.len(), 2);
    assert_eq!(next.messages[0]["parentId"], "u1");
    assert_eq!(next.messages[0]["usage"]["inputTokens"], 12);
    assert_eq!(next.messages[0]["usage"]["cacheReadTokens"], 5);
    assert_eq!(next.messages[0]["blocks"][1]["id"], "tool1");
    assert_eq!(next.messages[1]["blocks"][0]["text"], "all tests pass");
    assert!(!next.has_more);
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args(["transcript", "--agent", "claude", "--path"])
        .arg(&path)
        .args(["--limit", "1"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let cli: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(cli["schemaVersion"], 1);
    assert_eq!(cli["view"], "record_stream");
    assert_eq!(cli["agent"], "claude");
    assert_eq!(cli["messages"].as_array().unwrap().len(), 1);
    let serialized = serde_json::to_string(&next).unwrap();
    assert!(!serialized.contains("SECRET"));
    assert!(!serialized.contains("BASE64"));
}

#[test]
fn codex_handles_response_items_without_duplicate_event_messages_or_hidden_reasoning() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    let records = vec![
        json!({"type":"session_meta","payload":{"base_instructions":{"text":"SECRET"}}}),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"duplicate"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"SECRET"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix it"}]}}),
        json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Review tests"}],"encrypted_content":"SECRET","content":[{"type":"reasoning_text","text":"PRIVATE"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"c1","arguments":"{\"cmd\":\"cargo test\"}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":[{"type":"input_text","text":"passed"},{"type":"input_image","image_url":"https://example.invalid/private"}]}}),
        json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c2","input":"patch text"}}),
        json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c2","output":"Done"}}),
    ];
    write_records(&path, &records);
    let page = read_page(&path, TranscriptAgent::Codex, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 6);
    assert_eq!(page.messages[1]["blocks"][0]["type"], "thinking");
    assert_eq!(page.messages[2]["blocks"][0]["id"], "c1");
    assert_eq!(page.messages[3]["role"], "tool");
    assert!(page.messages[3]["blocks"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("passed"));
    assert_eq!(page.messages[4]["blocks"][0]["text"], "patch text");
    let output = serde_json::to_string(&page).unwrap();
    for excluded in ["SECRET", "PRIVATE", "duplicate", "https://"] {
        assert!(!output.contains(excluded));
    }
}

#[test]
fn pi_records_preserve_messages_tools_usage_and_tree_parent_without_running_agent() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.jsonl");
    write_records(
        &path,
        &[
            json!({"type":"session","version":3,"id":"session1","cwd":"/work"}),
            json!({"type":"message","id":"user1","parentId":null,"message":{"role":"user","content":"Fix the test"}}),
            json!({"type":"message","id":"assistant1","parentId":"user1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Inspect it","thinkingSignature":"SECRET"},{"type":"toolCall","id":"tool1","name":"bash","arguments":{"command":"cargo test"}}],"usage":{"input":10,"output":20,"cacheRead":5,"cacheWrite":3}}}),
            json!({"type":"message","id":"result1","parentId":"assistant1","message":{"role":"toolResult","toolCallId":"tool1","toolName":"bash","content":[{"type":"text","text":"passed"}],"isError":false}}),
        ],
    );
    let page = read_page(&path, TranscriptAgent::Pi, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 3);
    assert_eq!(page.messages[1]["parentId"], "user1");
    assert_eq!(page.messages[1]["usage"]["cacheWriteTokens"], 3);
    assert_eq!(page.messages[1]["blocks"][1]["type"], "tool_use");
    assert_eq!(
        page.messages[1]["blocks"][1]["text"],
        "{\"command\":\"cargo test\"}"
    );
    assert_eq!(page.messages[2]["role"], "tool");
    assert_eq!(page.messages[2]["blocks"][0]["id"], "tool1");
    assert_eq!(page.messages[2]["blocks"][0]["text"], "passed");
    assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
    let omp = read_page(&path, TranscriptAgent::Omp, 0, 50).unwrap();
    assert_eq!(omp.messages, page.messages);
    assert_eq!(serde_json::to_value(omp).unwrap()["agent"], "omp");
}

#[test]
fn partial_tail_retries_from_its_start_and_invalid_offsets_fail() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("live.jsonl");
    write_records(&path, &[user("first")]);
    let first_len = fs::metadata(&path).unwrap().len();
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(b"{\"type\":\"user\"").unwrap();
    let page = read_page(&path, TranscriptAgent::Claude, 0, 50).unwrap();
    assert_eq!(page.next_offset, first_len);
    assert!(!page.has_more);
    file.write_all(b",\"message\":{\"content\":\"second\"}}\n")
        .unwrap();
    let next = read_page(&path, TranscriptAgent::Claude, page.next_offset, 50).unwrap();
    assert_eq!(next.messages[0]["blocks"][0]["text"], "second");
    assert!(!next.has_more);
    for offset in [1, u64::MAX] {
        assert!(read_page(&path, TranscriptAgent::Claude, offset, 1).is_err());
    }
    assert!(read_page(&path, TranscriptAgent::Claude, 0, 0).is_err());
}

#[test]
fn sidechain_team_and_meta_records_are_not_confused_with_main_records() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("branches.jsonl");
    let mut side = user("side");
    side["isSidechain"] = json!(true);
    let mut team = user("team");
    team["teamName"] = json!("workers");
    let mut meta = user("meta");
    meta["isMeta"] = json!(true);
    write_records(&path, &[side, team, meta, user("main")]);
    let page = read_page(&path, TranscriptAgent::Claude, 0, 50).unwrap();
    assert_eq!(page.view, "record_stream");
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0]["blocks"][0]["text"], "main");
}

#[test]
fn oversized_lines_malformed_json_and_directories_fail_without_state_or_payload_echo() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("bad.jsonl");
    for bytes in [
        vec![b'x'; 256 * 1024 + 1],
        b"{SECRET-invalid}\n".to_vec(),
        b"[]\n".to_vec(),
    ] {
        fs::write(&path, bytes).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .args(["transcript", "--agent", "claude", "--path"])
            .arg(&path)
            .env("LAZYSH_STATE_DIR", directory.path().join("state"))
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("SECRET"));
        assert!(!directory.path().join("state").exists());
    }
    assert!(read_page(directory.path(), TranscriptAgent::Claude, 0, 50).is_err());
}

#[test]
fn output_and_skipped_record_scans_are_bounded_and_continue() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("large.jsonl");
    write_records(&path, &vec![user(&"x".repeat(200_000)); 10]);
    let page = read_page(&path, TranscriptAgent::Claude, 0, 100).unwrap();
    assert_eq!(page.messages.len(), 2);
    assert!(serde_json::to_vec(&page).unwrap().len() < 513 * 1024);
    assert!(page.has_more);
    let second = read_page(&path, TranscriptAgent::Claude, page.next_offset, 100).unwrap();
    assert!(second.next_offset > page.next_offset);
    write_records(
        &path,
        &vec![json!({"type":"unknown","padding":"x".repeat(100_000)}); 50],
    );
    let skipped = read_page(&path, TranscriptAgent::Claude, 0, 100).unwrap();
    assert!(skipped.messages.is_empty());
    assert!(skipped.next_offset > 0 && skipped.next_offset <= 4 * 1024 * 1024);
    assert!(skipped.has_more);
    let last = read_page(&path, TranscriptAgent::Claude, skipped.next_offset, 100).unwrap();
    assert!(!last.has_more);
    write_records(
        &path,
        &[
            json!({"type":"assistant","message":{"content":vec![json!({"type":"text","text":"x"});1001]}}),
        ],
    );
    assert!(read_page(&path, TranscriptAgent::Claude, 0, 50).is_err());
}

#[cfg(unix)]
#[test]
fn symlinks_and_fifos_cannot_be_read_as_transcripts() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("real.jsonl");
    write_records(&path, &[user("private")]);
    let link = directory.path().join("link.jsonl");
    symlink(&path, &link).unwrap();
    assert!(read_page(&link, TranscriptAgent::Claude, 0, 50).is_err());
    let fifo = directory.path().join("fifo");
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(read_page(&fifo, TranscriptAgent::Claude, 0, 50).is_err());
}
