use lazysh_agent::transcript::{discover, read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::{fs, io::Write};

fn write(path: &std::path::Path, records: &[Value]) {
    let mut file = fs::File::create(path).unwrap();
    for record in records {
        serde_json::to_writer(&mut file, record).unwrap();
        writeln!(file).unwrap();
    }
}

#[test]
fn persisted_droid_blocks_preserve_identity_without_hidden_or_unverified_data() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    write(
        &path,
        &[
            json!({"type":"session_start","systemPrompt":"SECRET"}),
            json!({"type":"message","id":"u","message":{"role":"user","content":"Fix it"}}),
            json!({"type":"message","id":"hidden","message":{"role":"user","content":"SECRET","visibility":"llm_only"}}),
            json!({"type":"message","message":{"role":"user","content":"SECRET","hiddenFromUserViews":true}}),
            json!({"type":"message","message":{"role":"assistant","content":"SECRET","isUserVisible":false}}),
            json!({"type":"message","id":"a","parentId":"u","timestamp":"2026-10-24T20:00:00Z","tokens":{"input":999},"message":{"role":"assistant","openaiEncryptedContent":"SECRET","content":[{"type":"thinking","thinking":"Inspect tests","signature":"SECRET"},{"type":"tool_use","id":"c","name":"Execute","input":{"command":"cargo test"}}]}}),
            json!({"type":"message","id":"r","parentId":"a","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c","content":[{"type":"text","text":"passed"}]}]}}),
            json!({"type":"message","message":{"role":"system","content":"SECRET"}}),
        ],
    );
    let page = read_page(&path, TranscriptAgent::Droid, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 3);
    assert_eq!(page.messages[1]["id"], "a");
    assert_eq!(page.messages[1]["parentId"], "u");
    assert_eq!(page.messages[1]["timestamp"], "2026-10-24T20:00:00Z");
    assert_eq!(page.messages[1]["blocks"][0]["type"], "thinking");
    assert_eq!(page.messages[1]["blocks"][1]["id"], "c");
    assert_eq!(page.messages[2]["blocks"][0]["text"], "passed");
    assert!(page.messages[1].get("usage").is_none());
    assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
    assert_eq!(serde_json::to_value(page).unwrap()["agent"], "droid");
}

#[test]
fn droid_pages_resume_and_partial_tail_is_retryable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    write(
        &path,
        &[
            json!({"type":"message","id":"1","message":{"role":"user","content":"one"}}),
            json!({"type":"message","id":"2","message":{"role":"assistant","content":"two"}}),
        ],
    );
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"type\":")
        .unwrap();
    let first = read_page(&path, TranscriptAgent::Droid, 0, 1).unwrap();
    assert!(first.has_more);
    let second = read_page(&path, TranscriptAgent::Droid, first.next_offset, 50).unwrap();
    assert_eq!(second.messages[0]["id"], "2");
    assert!(!second.has_more);
    let tail = read_page(&path, TranscriptAgent::Droid, second.next_offset, 50).unwrap();
    assert_eq!(tail.next_offset, second.next_offset);
    assert!(tail.messages.is_empty());
}

#[test]
fn droid_discovery_only_lists_uuid_sessions_at_bounded_depth() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("-workspace");
    fs::create_dir(&project).unwrap();
    let id = "a1111111-1111-4111-8111-111111111111.jsonl";
    fs::write(project.join(id), "PRIVATE NOT READ DURING DISCOVERY").unwrap();
    fs::write(project.join("progress.jsonl"), "PRIVATE").unwrap();
    fs::create_dir(project.join("nested")).unwrap();
    fs::write(project.join("nested").join(id), "PRIVATE").unwrap();
    let result =
        serde_json::to_value(discover(TranscriptAgent::Droid, Some(directory.path()), 50).unwrap())
            .unwrap();
    assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(result["sessions"][0]["name"], id);
}
