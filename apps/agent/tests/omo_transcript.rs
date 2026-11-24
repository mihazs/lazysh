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

#[test]
fn senpi_discovers_its_own_sessions_and_normalizes_records() {
    let directory = tempfile::tempdir().unwrap();
    let session_dir = directory.path().join("sessions/--project--");
    fs::create_dir_all(&session_dir).unwrap();
    let path = session_dir.join("2026-01-01_session.jsonl");
    fs::write(&path, concat!(
        "{\"type\":\"session\",\"version\":3,\"id\":\"session\",\"cwd\":\"/project\"}\n",
        "{\"type\":\"message\",\"id\":\"u\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n",
        "{\"type\":\"message\",\"id\":\"a\",\"parentId\":\"u\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ready\"}]}}\n",
        "{\"type\":\"message\",\"id\":\"r\",\"parentId\":\"a\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"c\",\"toolName\":\"bash\",\"content\":[{\"type\":\"text\",\"text\":\"failed\"}],\"isError\":true}}\n"
    )).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("state"))
        .env("SENPI_CODING_AGENT_DIR", directory.path())
        .args(["discover", "--agent", "senpi"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let found: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(found["agent"], "senpi");
    assert_eq!(found["sessions"][0]["path"], path.to_str().unwrap());
    let page = read_page(&path, TranscriptAgent::Senpi, 0, 50).unwrap();
    assert_eq!(page.messages.len(), 3);
    assert_eq!(page.messages[0]["blocks"][0]["text"], "hello");
    assert_eq!(page.messages[1]["blocks"][0]["text"], "ready");
    assert_eq!(page.messages[2]["blocks"][0]["isError"], true);
}

#[test]
fn senpi_discovery_uses_the_default_home_and_allows_an_explicit_root() {
    let home = tempfile::tempdir().unwrap();
    let sessions = home.path().join(".senpi/agent/sessions");
    fs::create_dir_all(sessions.join("--project--")).unwrap();
    let path = sessions.join("--project--/session.jsonl");
    fs::write(&path, "{}").unwrap();
    for root in [None, Some(sessions.as_path())] {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
        command
            .env("HOME", home.path())
            .env_remove("SENPI_CODING_AGENT_DIR")
            .env("LAZYSH_STATE_DIR", home.path().join("state"))
            .current_dir(home.path())
            .args(["discover", "--agent", "senpi"]);
        if let Some(root) = root {
            command.arg("--root").arg(root);
        }
        let output = command.output().unwrap();
        assert!(output.status.success());
        let found: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(found["sessions"][0]["path"], path.to_str().unwrap());
    }
}
