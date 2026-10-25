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
fn devin_atif_cli_reads_explicit_export_and_missing_default_exports_are_empty() {
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
        .env("XDG_DATA_HOME", directory.path().join("missing-data"))
        .output()
        .unwrap();
    assert!(discover.status.success());
    assert!(
        serde_json::from_slice::<Value>(&discover.stdout).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(!directory.path().join(".local").exists());
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

fn discover_exports(
    home: &std::path::Path,
    data_home: Option<&std::path::Path>,
    limit: &str,
) -> std::process::Output {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    command
        .env("HOME", home)
        .env("LAZYSH_STATE_DIR", home.join("companion-state"))
        .env_remove("XDG_DATA_HOME")
        .args(["discover", "--agent", "devin-atif", "--limit", limit]);
    if let Some(data_home) = data_home {
        command.env("XDG_DATA_HOME", data_home);
    }
    command.output().unwrap()
}

#[test]
fn devin_discovery_honors_xdg_precedence_and_selected_export_uses_existing_reader() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let data = dir.path().join("data");
    let fallback = home.join(".local/share/devin/cli/transcripts");
    let selected = data.join("devin/cli/transcripts");
    fs::create_dir_all(&fallback).unwrap();
    fs::create_dir_all(&selected).unwrap();
    fs::write(
        fallback.join("fallback-session.json"),
        b"not read during discovery",
    )
    .unwrap();
    let path = selected.join("opaque-session-id.json");
    let contents = export(vec![
        json!({"step_id":1,"source":"user","message":"Fixture question"}),
        json!({"step_id":2,"source":"agent","message":"Fixture answer"}),
    ])
    .to_string();
    fs::write(&path, &contents).unwrap();
    let output = discover_exports(&home, Some(&data), "50");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let found: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(found["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(found["sessions"][0]["path"], path.to_str().unwrap());
    assert_eq!(found["sessions"][0]["name"], "opaque-session-id.json");
    let page = read_page(
        std::path::Path::new(found["sessions"][0]["path"].as_str().unwrap()),
        TranscriptAgent::DevinAtif,
        0,
        50,
    )
    .unwrap();
    assert_eq!(page.messages.len(), 2);
    assert_eq!(page.messages[1]["blocks"][0]["text"], "Fixture answer");
    assert_eq!(fs::read_to_string(&path).unwrap(), contents);
    #[cfg(unix)]
    for invalid_xdg in [
        None,
        Some(std::path::Path::new("")),
        Some(std::path::Path::new("relative-data")),
    ] {
        let output = discover_exports(&home, invalid_xdg, "50");
        assert!(output.status.success());
        let found: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            found["sessions"][0]["path"],
            fallback.join("fallback-session.json").to_str().unwrap()
        );
    }
    let missing_data = dir.path().join("missing-data");
    let output = discover_exports(&home, Some(&missing_data), "50");
    assert!(output.status.success());
    assert!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(!missing_data.exists());
    assert!(!home.join("companion-state").exists());
}

#[test]
fn devin_discovery_is_flat_bounded_metadata_and_does_not_validate_or_read_contents() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("devin/cli/transcripts");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("candidate-one.json"), b"not ATIF").unwrap();
    fs::write(root.join("candidate-two.json"), b"also not ATIF").unwrap();
    fs::write(root.join("debug.txt"), b"private").unwrap();
    fs::write(root.join("nested/other.json"), b"private").unwrap();
    let output = discover_exports(dir.path(), Some(dir.path()), "1");
    assert!(output.status.success());
    let found: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(found["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(found["truncated"], true);
    let selected = std::path::Path::new(found["sessions"][0]["path"].as_str().unwrap());
    assert_eq!(selected.parent(), Some(root.as_path()));
    assert!(read_page(selected, TranscriptAgent::DevinAtif, 0, 50).is_err());
    assert_eq!(
        fs::read(root.join("candidate-one.json")).unwrap(),
        b"not ATIF"
    );
}

#[cfg(unix)]
#[test]
fn devin_default_discovery_refuses_symlink_root_and_skips_linked_candidates() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("devin/cli/transcripts");
    fs::create_dir_all(&root).unwrap();
    let outside = dir.path().join("private-export.json");
    fs::write(&outside, b"private fixture").unwrap();
    symlink(&outside, root.join("session.json")).unwrap();
    let output = discover_exports(dir.path(), Some(dir.path()), "50");
    assert!(output.status.success());
    assert!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    fs::remove_dir_all(&root).unwrap();
    symlink(dir.path(), &root).unwrap();
    let output = discover_exports(dir.path(), Some(dir.path()), "50");
    assert!(!output.status.success());
    assert_eq!(fs::read(outside).unwrap(), b"private fixture");
}
