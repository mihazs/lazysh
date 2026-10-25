use lazysh_agent::transcript::{read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::{fs, io::Write};

#[test]
fn omo_native_senpi_v3_preserves_records_tools_and_billing_counters() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut file = fs::File::create(&path).unwrap();
    for value in [
        json!({"type":"session","version":3,"id":"session","cwd":"/fixture"}),
        json!({"type":"custom","customType":"senpi.todo-state","data":{"secret":"HIDDEN"}}),
        json!({"type":"message","id":"system","message":{"role":"system","content":"HIDDEN"}}),
        json!({"type":"message","id":"u","parentId":null,"timestamp":"2026-10-24T20:00:00Z","inputSource":"interactive","message":{"role":"user","content":[{"type":"text","text":"Fix tests"}]}}),
        json!({"type":"message","id":"a","parentId":"u","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Inspect tests","thinkingSignature":"HIDDEN"},{"type":"toolCall","id":"c","name":"bash","arguments":{"command":"cargo test"}}],"usage":{"input":13,"output":7,"cacheRead":11,"cacheWrite":0,"contextUsage":{"input":999,"output":3},"totalTokens":31}}}),
        json!({"type":"message","id":"r","parentId":"a","message":{"role":"toolResult","toolCallId":"c","toolName":"bash","content":[{"type":"text","text":"passed"}],"isError":false}}),
    ] {
        serde_json::to_writer(&mut file, &value).unwrap();
        writeln!(file).unwrap();
    }
    let result = read_page(&path, TranscriptAgent::Omo, 0, 50).unwrap();
    assert_eq!(result.messages.len(), 3);
    assert_eq!(result.messages[1]["parentId"], "u");
    assert_eq!(result.messages[1]["usage"]["inputTokens"], 13);
    assert_eq!(result.messages[1]["usage"]["cacheWriteTokens"], 0);
    assert_eq!(result.messages[1]["blocks"][1]["id"], "c");
    assert_eq!(result.messages[2]["role"], "tool");
    assert_eq!(result.messages[2]["blocks"][0]["text"], "passed");
    let output = serde_json::to_string(&result).unwrap();
    assert!(!output.contains("HIDDEN"));
    assert!(!output.contains("999"));
}

#[test]
fn omo_cli_discovery_honors_documented_agent_directory_precedence_with_fixture_homes() {
    let directory = tempfile::tempdir().unwrap();
    let omo = directory.path().join("omo");
    let senpi = directory.path().join("senpi");
    let pi = directory.path().join("pi");
    for root in [&omo, &senpi, &pi] {
        fs::create_dir_all(root.join("sessions/workspace")).unwrap();
        fs::write(
            root.join("sessions/workspace/fixture.jsonl"),
            "PRIVATE NOT READ DURING DISCOVERY",
        )
        .unwrap();
    }
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args(["discover", "--agent", "omo"])
        .env("OMO_CODING_AGENT_DIR", format!(" {} ", omo.display()))
        .env("SENPI_CODING_AGENT_DIR", &senpi)
        .env("PI_CODING_AGENT_DIR", &pi)
        .output()
        .unwrap();
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["agent"], "omo");
    assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["sessions"][0]["path"],
        omo.join("sessions/workspace/fixture.jsonl")
            .to_str()
            .unwrap()
    );
}
