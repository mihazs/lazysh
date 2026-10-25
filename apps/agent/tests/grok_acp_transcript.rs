use lazysh_agent::transcript::{conversation, discover, read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::{fs, io::Write, process::Command};

const FIXTURE: &str = include_str!("fixtures/grok-acp/records.jsonl");
fn update(tag: &str, fields: Value) -> Value {
    let mut update = fields;
    update["sessionUpdate"] = json!(tag);
    json!({"timestamp":1,"method":"session/update","params":{"sessionId":"test","update":update}})
}
#[path = "support/jsonl.rs"]
mod jsonl;
use jsonl::write;
#[test]
fn recorded_tool_status_only_updates_remain_distinct_and_link_to_the_tool() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    let statuses = ["pending", "in_progress", "completed", "failed"];
    write(
        &path,
        &statuses.map(|status| {
            update(
                "tool_call_update",
                json!({"toolCallId":"call-one","status":status}),
            )
        }),
    );
    let page = read_page(&path, TranscriptAgent::GrokAcp, 0, 100).unwrap();
    assert_eq!(page.messages.len(), 4);
    for (message, status) in page.messages.iter().zip(statuses) {
        assert_eq!(message["role"], "tool");
        assert_eq!(message["blocks"][0]["id"], "call-one");
        assert_eq!(message["blocks"][0]["name"], "Tool status");
        assert_eq!(message["blocks"][0]["status"], status);
        assert_eq!(
            message["blocks"][0]["text"],
            format!("Recorded tool status: {status}")
        );
    }
    assert_ne!(page.messages[0]["id"], page.messages[1]["id"]);
    let first = read_page(&path, TranscriptAgent::GrokAcp, 0, 2).unwrap();
    let second = read_page(&path, TranscriptAgent::GrokAcp, first.next_offset, 2).unwrap();
    assert!(first.has_more);
    assert!(!second.has_more);
    assert_eq!(first.messages, page.messages[..2]);
    assert_eq!(second.messages, page.messages[2..]);
}
#[test]
fn explicit_status_preserves_outputs_and_unknown_or_missing_status_stays_unassigned() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    write(
        &path,
        &[
            update(
                "tool_call",
                json!({"toolCallId":"call","title":"Inspect source","rawInput":{"path":"not-read"},"status":"in_progress"}),
            ),
            update(
                "tool_call_update",
                json!({"toolCallId":"call","rawOutput":"Original failure output","status":"failed"}),
            ),
            update(
                "tool_call_update",
                json!({"toolCallId":"other","rawOutput":"Unknown status output","status":"future_status"}),
            ),
            update(
                "tool_call_update",
                json!({"toolCallId":"other","rawOutput":"No status output"}),
            ),
            update(
                "tool_call_update",
                json!({"toolCallId":"other","status":"future_status"}),
            ),
            update("tool_call_update", json!({"toolCallId":"other"})),
            update(
                "tool_call_update",
                json!({"toolCallId":"other","status":null}),
            ),
            update(
                "tool_call",
                json!({"toolCallId":"missing","title":"No recorded status"}),
            ),
        ],
    );
    let page = read_page(&path, TranscriptAgent::GrokAcp, 0, 100).unwrap();
    assert_eq!(page.messages.len(), 5);
    assert_eq!(page.messages[0]["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(
        page.messages[0]["blocks"][0]["text"],
        r#"{"path":"not-read"}"#
    );
    assert_eq!(page.messages[0]["blocks"][0]["status"], "in_progress");
    assert_eq!(
        page.messages[1]["blocks"][0]["text"],
        "Original failure output"
    );
    assert_eq!(page.messages[1]["blocks"][0]["status"], "failed");
    for index in [2, 3] {
        assert!(page.messages[index]["blocks"][0].get("status").is_none());
    }
    assert_eq!(
        page.messages[2]["blocks"][0]["text"],
        "Unknown status output"
    );
    assert_eq!(page.messages[3]["blocks"][0]["text"], "No status output");
    assert!(page.messages[4]["blocks"][0].get("status").is_none());
    assert_eq!(page.next_offset, fs::metadata(&path).unwrap().len());
}
#[test]
fn recorded_status_preserves_maximum_block_counts_and_tool_attachment_linkage() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    let part = json!({"type":"content","content":{"type":"image","data":"not-decoded","mimeType":"image/png"}});
    write(
        &path,
        &[update(
            "tool_call_update",
            json!({"toolCallId":"call","status":"completed","content":vec![part.clone();1000]}),
        )],
    );
    let page = read_page(&path, TranscriptAgent::GrokAcp, 0, 1).unwrap();
    let blocks = page.messages[0]["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 1000);
    for block in blocks {
        assert_eq!(block["type"], "image");
        assert_eq!(block["id"], "call");
        assert_eq!(block["status"], "completed");
        assert!(!block["text"].as_str().unwrap().contains("not-decoded"));
    }
    write(
        &path,
        &[update(
            "tool_call",
            json!({"toolCallId":"call","title":"Inspect","status":"pending","content":vec![part.clone();999]}),
        )],
    );
    let page = read_page(&path, TranscriptAgent::GrokAcp, 0, 1).unwrap();
    assert_eq!(page.messages[0]["blocks"].as_array().unwrap().len(), 1000);
    write(
        &path,
        &[update(
            "tool_call_update",
            json!({"toolCallId":"call","status":"completed","content":vec![part;1001]}),
        )],
    );
    assert!(read_page(&path, TranscriptAgent::GrokAcp, 0, 1).is_err());
}
#[test]
fn pinned_records_keep_chunk_identity_roles_tools_plans_and_provider_time() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    fs::write(&path, FIXTURE).unwrap();
    let page = read_page(&path, TranscriptAgent::GrokAcp, 0, 100).unwrap();
    assert_eq!(page.view, "record_stream");
    assert_eq!(page.messages.len(), 8);
    assert_eq!(page.messages[0]["role"], "user");
    assert_eq!(page.messages[0]["timestamp"], "1970-01-01T00:00:01Z");
    assert_eq!(page.messages[1]["blocks"][0]["type"], "thinking");
    assert_ne!(page.messages[2]["id"], page.messages[3]["id"]);
    assert_eq!(page.messages[2]["blocks"][0]["text"], "First chunk ");
    assert_eq!(page.messages[4]["blocks"][0]["id"], "call-one");
    assert_eq!(page.messages[4]["blocks"][0]["name"], "Inspect source");
    assert_eq!(page.messages[4]["blocks"][1]["type"], "tool_result");
    assert_eq!(page.messages[5]["role"], "tool");
    assert!(page.messages[5]["blocks"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Old:\nbefore\nNew:\nafter"));
    assert!(page.messages[6]["blocks"][0]["text"]
        .as_str()
        .unwrap()
        .contains("[completed] Review source"));
    assert_eq!(
        page.messages[7]["blocks"][0]["text"],
        "Plan:\nA recorded plan"
    );
    assert!(!serde_json::to_string(&page)
        .unwrap()
        .contains("DO_NOT_DUPLICATE"));
    assert_eq!(page.next_offset, FIXTURE.len() as u64);
    assert!(!page.has_more);
    assert_eq!(serde_json::to_value(&page).unwrap()["agent"], "grok-acp");
    assert_eq!(fs::read_to_string(path).unwrap(), FIXTURE);
}
#[test]
fn exact_envelopes_skip_unknown_metadata_without_inventing_messages_or_time() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    let mut wrong = update(
        "agent_message_chunk",
        json!({"content":{"type":"text","text":"wrong rail"}}),
    );
    wrong["method"] = json!("_x.ai/session/update");
    let mut timestamp = update(
        "user_message_chunk",
        json!({"content":{"type":"text","text":"bad time"}}),
    );
    timestamp["timestamp"] = json!(u64::MAX);
    write(
        &path,
        &[
            json!({"params":{"update":{"sessionUpdate":"user_message_chunk"}}}),
            wrong,
            timestamp,
            update(
                "tool_call_update",
                json!({"toolCallId":"call","status":"completed"}),
            ),
            update("future_extension", json!({"text":"ignored"})),
            update(
                "agent_message_chunk",
                json!({"content":{"type":"text","text":"kept"}}),
            ),
        ],
    );
    let page = read_page(&path, TranscriptAgent::GrokAcp, 0, 100).unwrap();
    assert_eq!(page.messages.len(), 2);
    assert_eq!(page.messages[0]["blocks"][0]["status"], "completed");
    assert_eq!(page.messages[1]["blocks"][0]["text"], "kept");
    assert_eq!(page.next_offset, fs::metadata(&path).unwrap().len());
}
#[test]
fn attachment_paths_are_not_followed_and_tool_output_requires_real_content() {
    let directory = tempfile::tempdir().unwrap();
    let secret = directory.path().join("secret");
    fs::write(&secret, "PRIVATE_NOT_READ").unwrap();
    let path = directory.path().join("updates.jsonl");
    write(
        &path,
        &[
            update(
                "user_message_chunk",
                json!({"content":{"type":"resource_link","uri":secret}}),
            ),
            update(
                "tool_call_update",
                json!({"toolCallId":"call","rawOutput":"Actual output"}),
            ),
        ],
    );
    let page = read_page(&path, TranscriptAgent::GrokAcp, 0, 100).unwrap();
    assert_eq!(page.messages[0]["blocks"][0]["type"], "image");
    assert_eq!(page.messages[1]["blocks"][0]["text"], "Actual output");
    assert!(!serde_json::to_string(&page)
        .unwrap()
        .contains("PRIVATE_NOT_READ"));
}
#[test]
fn cursor_paging_torn_tails_and_ignored_rows_preserve_existing_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    fs::write(&path, FIXTURE).unwrap();
    let first = read_page(&path, TranscriptAgent::GrokAcp, 0, 2).unwrap();
    assert!(first.has_more);
    let rest = read_page(&path, TranscriptAgent::GrokAcp, first.next_offset, 100).unwrap();
    assert_eq!(rest.messages.len(), 6);
    assert!(read_page(&path, TranscriptAgent::GrokAcp, 1, 100).is_err());
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"timestamp\":")
        .unwrap();
    let tail = read_page(&path, TranscriptAgent::GrokAcp, rest.next_offset, 100).unwrap();
    assert!(tail.messages.is_empty());
    assert_eq!(tail.next_offset, rest.next_offset);
    assert!(!tail.has_more);
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"not-json}\n")
        .unwrap();
    assert!(read_page(&path, TranscriptAgent::GrokAcp, rest.next_offset, 100).is_err());
}
#[test]
fn oversized_rows_fail_and_unknown_rows_advance_within_scan_budget() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    write(
        &path,
        &[update(
            "user_message_chunk",
            json!({"content":{"type":"text","text":"x".repeat(256*1024)}}),
        )],
    );
    assert!(read_page(&path, TranscriptAgent::GrokAcp, 0, 100).is_err());
    let ignored = "{\"method\":\"unknown\"}\n";
    fs::write(&path, ignored.repeat((4 * 1024 * 1024) / ignored.len() + 2)).unwrap();
    let page = read_page(&path, TranscriptAgent::GrokAcp, 0, 100).unwrap();
    assert!(page.messages.is_empty());
    assert!(page.has_more);
    assert!(page.next_offset > 0 && page.next_offset <= 4 * 1024 * 1024);
}
#[test]
fn explicit_records_reject_discovery_and_conversation_cli_views() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    fs::write(&path, FIXTURE).unwrap();
    assert!(discover(TranscriptAgent::GrokAcp, None, 50).is_err());
    assert!(discover(TranscriptAgent::GrokAcp, Some(directory.path()), 50).is_err());
    assert!(conversation(&path, TranscriptAgent::GrokAcp, 50).is_err());
    let run = |extra: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .args(["transcript", "--agent", "grok-acp", "--path"])
            .arg(&path)
            .args(extra)
            .env("LAZYSH_STATE_DIR", directory.path())
            .output()
            .unwrap()
    };
    let records = run(&[]);
    assert!(records.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&records.stdout).unwrap()["agent"],
        "grok-acp"
    );
    assert!(!run(&["--view", "conversation"]).status.success());
}
#[cfg(unix)]
#[test]
fn explicit_file_rejects_leaf_symlinks_and_nonregular_files() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    fs::write(&path, FIXTURE).unwrap();
    let link = directory.path().join("alias.jsonl");
    symlink(path, &link).unwrap();
    assert!(read_page(&link, TranscriptAgent::GrokAcp, 0, 100).is_err());
    assert!(read_page(directory.path(), TranscriptAgent::GrokAcp, 0, 100).is_err());
}

#[test]
fn amplified_tool_records_fail_instead_of_returning_a_stuck_cursor() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    let terminals = |count| vec![json!({"type":"terminal","terminalId":"x"}); count];
    // Bound input independently from output amplification, including UTF-8 IDs.
    for (tag, fields) in [
        (
            "tool_call",
            json!({"toolCallId":"i".repeat(1024),"title":"tool","content":terminals(600)}),
        ),
        (
            "tool_call_update",
            json!({"toolCallId":"é".repeat(129),"content":terminals(1)}),
        ),
        (
            "tool_call_update",
            json!({"toolCallId":"small","content":terminals(1001)}),
        ),
        (
            "tool_call",
            json!({"toolCallId":"i".repeat(256),"title":"tool","rawInput":"x".repeat(200_000),"content":terminals(999)}),
        ),
    ] {
        write(&path, &[update(tag, fields)]);
        assert!(fs::metadata(&path).unwrap().len() < 256 * 1024);
        assert!(read_page(&path, TranscriptAgent::GrokAcp, 0, 100).is_err());
    }
}

#[test]
fn full_pages_stop_before_the_next_record_without_losing_progress() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    let row = update(
        "agent_message_chunk",
        json!({"content":{"type":"text","text":"x".repeat(180_000)}}),
    );
    write(&path, &[row.clone(), row.clone(), row]);
    let first = read_page(&path, TranscriptAgent::GrokAcp, 0, 100).unwrap();
    assert_eq!(first.messages.len(), 2);
    assert!(first.has_more && first.next_offset > 0);
    let rest = read_page(&path, TranscriptAgent::GrokAcp, first.next_offset, 100).unwrap();
    assert_eq!(rest.messages.len(), 1);
    assert!(!rest.has_more);
}
