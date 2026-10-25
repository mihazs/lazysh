use lazysh_agent::transcript::{read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::fs;

fn export(steps: Vec<Value>) -> Value {
    json!({"schema_version":"ATIF-v1.7","session_id":"fixture","agent":{"name":"devin","version":"3000.11.205"},"steps":steps,"final_metrics":{"total_prompt_tokens":999},"extra":{"secret":"SECRET"}})
}

#[test]
fn devin_atif_export_preserves_steps_and_actual_metrics_without_resolving_references() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("export.json");
    let value = export(vec![
        json!({"step_id":1,"source":"system","message":"SECRET"}),
        json!({"step_id":2,"source":"user","message":"Fix tests"}),
        json!({"step_id":3,"source":"agent","timestamp":"2026-10-24T20:00:00Z","message":[{"type":"text","text":"Run test"},{"type":"image","source":{"media_type":"image/png","path":"/not/a/real/file.png"}}],"reasoning_content":"Inspect tests","tool_calls":[{"tool_call_id":"c","function_name":"shell","arguments":{"command":"cargo test"}}],"observation":{"results":[{"source_call_id":"c","content":[{"type":"text","text":"passed"}],"subagent_trajectory_ref":[{"trajectory_path":"/not/a/real/subagent.json"}]}]},"metrics":{"prompt_tokens":23,"completion_tokens":7,"cached_tokens":11,"cost_usd":0.1,"extra":{"cache_creation_input_tokens":999}}}),
    ]);
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let page = read_page(&path, TranscriptAgent::DevinAtif, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 2);
    assert_eq!(page.next_offset, 3);
    assert!(!page.has_more);
    let response = &page.messages[1];
    assert_eq!(response["id"], "step-3");
    assert_eq!(response["role"], "assistant");
    assert_eq!(response["blocks"][1]["type"], "image");
    assert_eq!(response["blocks"][2]["type"], "thinking");
    assert_eq!(response["blocks"][3]["id"], "c");
    assert_eq!(response["blocks"][4]["text"], "passed");
    assert_eq!(response["usage"]["inputTokens"], 23);
    assert_eq!(response["usage"]["cacheReadTokens"], 11);
    assert!(response["usage"].get("cacheWriteTokens").is_none());
    let encoded = serde_json::to_string(&page).unwrap();
    for hidden in ["SECRET", "999", "/not/a/real", "cost_usd"] {
        assert!(!encoded.contains(hidden));
    }
}

#[test]
fn atif_snapshot_paging_preserves_step_cursor_across_hidden_steps() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("export.json");
    fs::write(
        &path,
        export(vec![
            json!({"step_id":1,"source":"user","message":"One"}),
            json!({"step_id":2,"source":"system","message":"HIDDEN"}),
            json!({"step_id":3,"source":"agent","message":"Two"}),
        ])
        .to_string(),
    )
    .unwrap();
    let first = read_page(&path, TranscriptAgent::DevinAtif, 0, 1).unwrap();
    assert_eq!(first.next_offset, 2);
    assert!(first.has_more);
    let second = read_page(&path, TranscriptAgent::DevinAtif, first.next_offset, 1).unwrap();
    assert_eq!(second.messages[0]["id"], "step-3");
    assert_eq!(second.next_offset, 3);
    assert!(!second.has_more);
    assert!(read_page(&path, TranscriptAgent::DevinAtif, 4, 1).is_err());
}

#[test]
fn unsupported_schema_duplicate_ids_malformed_and_oversized_exports_fail() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("export.json");
    for value in [
        json!({"schema_version":"ATIF-v1.8","steps":[]}),
        export(vec![
            json!({"step_id":1,"source":"user","message":"One"}),
            json!({"step_id":1,"source":"agent","message":"Two"}),
        ]),
        export(vec![
            json!({"step_id":1,"source":"agent","message":[{"type":"audio","source":{}}]}),
        ]),
        export(vec![
            json!({"step_id":1,"source":"agent","message":"x".repeat(262_145)}),
        ]),
        export(
            (1..=10_001)
                .map(|id| json!({"step_id":id,"source":"user","message":"hi"}))
                .collect(),
        ),
    ] {
        fs::write(&path, value.to_string()).unwrap();
        assert!(read_page(&path, TranscriptAgent::DevinAtif, 0, 50).is_err());
    }
    fs::write(&path, "{\"schema_version\":").unwrap();
    assert!(read_page(&path, TranscriptAgent::DevinAtif, 0, 50).is_err());
    let file = fs::File::create(&path).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    assert!(read_page(&path, TranscriptAgent::DevinAtif, 0, 50).is_err());
}

#[test]
fn devin_atif_cli_reads_explicit_export_and_does_not_assume_cache_discovery() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("export.json");
    fs::write(
        &path,
        export(vec![json!({"step_id":1,"source":"user","message":"Hello"})]).to_string(),
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args(["transcript", "--agent", "devin-atif", "--path"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(output.status.success());
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["agent"], "devin-atif");
    assert_eq!(response["schemaVersion"], 1);
    let discover = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args(["discover", "--agent", "devin-atif"])
        .env("HOME", directory.path())
        .output()
        .unwrap();
    assert!(!discover.status.success());
    let explicit = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args(["discover", "--agent", "devin-atif", "--root"])
        .arg(directory.path())
        .output()
        .unwrap();
    assert!(explicit.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&explicit.stdout).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn atif_output_budget_stops_before_next_step_without_losing_the_cursor() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("export.json");
    fs::write(
        &path,
        export(
            (1..=3)
                .map(|id| json!({"step_id":id,"source":"agent","message":"x".repeat(220_000)}))
                .collect(),
        )
        .to_string(),
    )
    .unwrap();
    let first = read_page(&path, TranscriptAgent::DevinAtif, 0, 50).unwrap();
    assert_eq!(first.messages.len(), 2);
    assert_eq!(first.next_offset, 2);
    assert!(first.has_more);
    assert!(serde_json::to_vec(&first).unwrap().len() < 512 * 1024);
    let second = read_page(&path, TranscriptAgent::DevinAtif, first.next_offset, 50).unwrap();
    assert_eq!(second.messages[0]["id"], "step-3");
    assert!(!second.has_more);
    fs::write(&path, export(vec![json!({"step_id":1,"source":"agent","message":(0..1001).map(|_|json!({"type":"text","text":"x"})).collect::<Vec<_>>()})]).to_string()).unwrap();
    assert!(read_page(&path, TranscriptAgent::DevinAtif, 0, 50).is_err());
}
