use lazysh_agent::transcript::{read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::fs;

fn export(messages: Vec<Value>) -> Value {
    json!({"id":"T-fixture","v":17,"messages":messages,"systemPrompt":"SECRET","~debug":{"secret":"SECRET"}})
}

#[test]
fn amp_full_export_preserves_raw_message_identity_tools_thinking_and_recorded_usage() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("amp.json");
    fs::write(&path, export(vec![
        json!({"messageId":0,"role":"user","content":[{"type":"text","text":"Fix tests"}]}),
        json!({"messageId":1,"role":"info","content":[{"type":"text","text":"SECRET"}]}),
        json!({"messageId":"a","role":"assistant","content":[{"type":"thinking","thinking":"Inspect tests","signature":"SECRET"},{"type":"tool_use","id":"c","name":"Bash","input":{"cmd":"cargo test"}},{"type":"image","source":{"url":"https://invalid.example/never-fetch.png"}}],"usage":{"inputTokens":23,"outputTokens":7,"cacheReadInputTokens":11,"cacheCreationInputTokens":0,"totalInputTokens":999,"maxInputTokens":999}}),
        json!({"messageId":2,"role":"user","content":[{"type":"tool_result","toolUseID":"c","run":{"status":"done","result":{"output":"passed","exitCode":0}}}]}),
        json!({"messageId":3,"role":"assistant","parentToolUseId":"delegate","content":[{"type":"text","text":"SECRET"}]}),
        json!({"messageId":4,"role":"user","content":[{"type":"tool_result","toolUseID":"c","run":{"status":"in-progress","progress":"SECRET"}},{"type":"tool_result","toolUseID":"c","run":{"status":"error","error":{"message":"SECRET"}}}]}),
    ]).to_string()).unwrap();
    let response = read_page(&path, TranscriptAgent::AmpJson, 0, 50).unwrap();
    assert_eq!(response.messages.len(), 3);
    assert_eq!(response.messages[0]["id"], "number-0");
    assert_eq!(response.messages[1]["id"], "string-a");
    assert_eq!(response.messages[1]["blocks"][0]["type"], "thinking");
    assert_eq!(response.messages[1]["blocks"][1]["id"], "c");
    assert_eq!(response.messages[1]["usage"]["cacheWriteTokens"], 0);
    assert_eq!(response.messages[2]["blocks"][0]["id"], "c");
    assert_eq!(
        serde_json::from_str::<Value>(response.messages[2]["blocks"][0]["text"].as_str().unwrap())
            .unwrap()["output"],
        "passed"
    );
    assert!(!response.has_more);
    let encoded = serde_json::to_string(&response).unwrap();
    for hidden in ["SECRET", "999", "invalid.example"] {
        assert!(!encoded.contains(hidden));
    }
}

#[test]
fn amp_exports_page_with_unique_typed_ids_and_preserve_cursor_after_output_budget() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("amp.json");
    fs::write(&path, export(vec![
        json!({"messageId":0,"role":"user","content":[{"type":"text","text":"a".repeat(220_000)}]}),
        json!({"messageId":"0","role":"assistant","content":[{"type":"text","text":"b".repeat(220_000)}]}),
        json!({"messageId":1,"role":"assistant","content":[{"type":"text","text":"c".repeat(220_000)}]}),
    ]).to_string()).unwrap();
    let first = read_page(&path, TranscriptAgent::AmpJson, 0, 50).unwrap();
    assert_eq!(first.next_offset, 2);
    assert_eq!(first.messages.len(), 2);
    assert_ne!(first.messages[0]["id"], first.messages[1]["id"]);
    assert!(first.has_more);
    let next = read_page(&path, TranscriptAgent::AmpJson, first.next_offset, 1).unwrap();
    assert_eq!(next.messages[0]["id"], "number-1");
    assert!(!next.has_more);
    assert!(read_page(&path, TranscriptAgent::AmpJson, 4, 1).is_err());
}

#[test]
fn unsupported_export_shapes_duplicate_ids_and_bounds_fail_explicitly() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("amp.json");
    for value in [
        json!({"messages":[]}),
        json!({"id":"T-fixture","v":"not-a-revision","messages":[]}),
        export(vec![
            json!({"messageId":0,"role":"user","content":[]}),
            json!({"messageId":0,"role":"user","content":[]}),
        ]),
        export(vec![json!({"messageId":0,"role":"system","content":[]})]),
        export(vec![
            json!({"messageId":0,"role":"assistant","content":[{"type":"text","text":"x".repeat(262_145)}]}),
        ]),
        export(
            (0..10_001)
                .map(|id| json!({"messageId":id,"role":"info","content":[]}))
                .collect(),
        ),
    ] {
        fs::write(&path, value.to_string()).unwrap();
        assert!(read_page(&path, TranscriptAgent::AmpJson, 0, 50).is_err());
    }
    fs::write(&path, "{\"id\":").unwrap();
    assert!(read_page(&path, TranscriptAgent::AmpJson, 0, 50).is_err());
    let file = fs::File::create(&path).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    assert!(read_page(&path, TranscriptAgent::AmpJson, 0, 50).is_err());
}

#[test]
fn amp_export_cli_is_explicit_file_only_with_no_default_native_cache_discovery() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("amp.json");
    fs::write(&path, export(vec![]).to_string()).unwrap();
    let response = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .args(["transcript", "--agent", "amp-json", "--path"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(response.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&response.stdout).unwrap()["agent"],
        "amp-json"
    );
    let discovery = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .args(["discover", "--agent", "amp-json"])
        .env("HOME", directory.path())
        .output()
        .unwrap();
    assert!(!discovery.status.success());
}
