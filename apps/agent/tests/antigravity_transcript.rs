use lazysh_agent::transcript::{
    conversation, discover, read_page, read_page_with_checkpoint, TranscriptAgent,
};
use serde_json::{json, Value};
use std::{fs, io::Write, process::Command};
const AGENT: TranscriptAgent = TranscriptAgent::AntigravityJsonl;
const FIXTURE: &str = include_str!("fixtures/antigravity-jsonl/records.jsonl");
fn row() -> Value {
    json!({"step_index":0,"source":"fixture","type":"UNKNOWN","status":"RECORDED","content":"text"})
}
#[path = "support/jsonl.rs"]
mod jsonl;
use jsonl::write;
fn checkpoint_fixture() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    lazysh_agent::transcript::TranscriptPage,
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    write(&path, &[row(), row()]);
    let first = read_page(&path, AGENT, 0, 1).unwrap();
    (dir, path, first)
}
#[test]
fn pinned_shape_preserves_literal_record_labels_optional_zeros_reasoning_and_u64_precision() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    fs::write(&path, FIXTURE).unwrap();
    let page = read_page(&path, AGENT, 0, 100).unwrap();
    assert_eq!(page.messages.len(), 4);
    assert_eq!(page.view, "record_stream");
    let messages = &page.messages;
    assert!(messages.iter().all(|message| message["role"] == "record"));
    assert_eq!(messages[0]["record"]["stepIndex"], 0);
    assert_eq!(messages[0]["usage"]["inputTokens"], "0");
    assert_eq!(messages[0]["timestamp"], "2026-10-25T00:00:00Z");
    assert_eq!(messages[1]["blocks"][1]["type"], "thinking");
    assert_eq!(
        messages[1]["record"]["truncatedFields"],
        json!(["content", "thinking"])
    );
    assert_eq!(
        messages[1]["record"]["stepIndex"],
        messages[2]["record"]["stepIndex"]
    );
    assert_ne!(messages[1]["id"], messages[2]["id"]);
    assert_eq!(messages[2]["record"]["exitCode"], 0);
    assert_eq!(messages[2]["record"]["errorCode"], 0);
    assert_eq!(messages[2]["usage"]["inputTokens"], "18446744073709551615");
    assert_eq!(messages[2]["usage"]["outputTokens"], "9007199254740993");
    assert_eq!(messages[3]["record"]["type"], "FUTURE_STEP");
    assert!(messages[3]["record"].get("stepIndex").is_none());
    for message in messages {
        for block in message["blocks"].as_array().unwrap() {
            assert!(block.get("id").is_none());
        }
    }
    assert!(!serde_json::to_string(&page)
        .unwrap()
        .contains("file:///not-opened"));
    assert_eq!(page.next_offset, FIXTURE.len() as u64);
    assert!(!page.has_more);
    assert!(page.checkpoint.is_some());
    assert_eq!(fs::read_to_string(&path).unwrap(), FIXTURE);
}
#[test]
fn validates_exact_field_types_ranges_and_optional_absence_without_enum_role_guesses() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    for (field, value) in [
        ("step_index", json!(-1)),
        ("step_index", json!(4294967296_u64)),
        ("step_index", json!(1.5)),
        ("source", json!(3)),
        ("type", json!(null)),
        ("status", json!([])),
        ("created_at", json!(7)),
        ("content", json!({})),
        ("thinking", json!(false)),
        ("exit_code", json!(2147483648_u64)),
        ("error_code", json!(-1)),
        ("error", json!(1)),
        ("input_tokens", json!("0")),
        ("cache_read_tokens", json!(-1)),
        ("tool_calls", json!([{"name":"x","args":[]}])),
        ("media", json!([{"uri":4}])),
        ("truncated_fields", json!({"content":true})),
    ] {
        let mut record = row();
        record[field] = value;
        write(&path, &[record]);
        assert!(read_page(&path, AGENT, 0, 100).is_err(), "{field}");
    }
    let mut record = row();
    record.as_object_mut().unwrap().remove("source");
    write(&path, &[record]);
    assert!(read_page(&path, AGENT, 0, 100).is_err());
    write(
        &path,
        &[
            json!({"source":"","type":"UNRECOGNIZED","status":"", "content":null, "step_index":null}),
        ],
    );
    assert_eq!(
        read_page(&path, AGENT, 0, 100).unwrap().messages[0]["role"],
        "record"
    );
}
#[test]
fn checkpoint_pages_allow_append_and_completion_of_a_partial_final_record() {
    let (_dir, path, first) = checkpoint_fixture();
    assert!(first.has_more);
    let second = read_page_with_checkpoint(
        &path,
        AGENT,
        first.next_offset,
        1,
        first.checkpoint.as_deref(),
    )
    .unwrap();
    assert!(!second.has_more);
    let bytes = format!("{}\n", row());
    let split = bytes.len() / 2;
    let append = |bytes: &[u8]| {
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    };
    append(&bytes.as_bytes()[..split]);
    let tail = read_page_with_checkpoint(
        &path,
        AGENT,
        second.next_offset,
        50,
        second.checkpoint.as_deref(),
    )
    .unwrap();
    assert!(tail.messages.is_empty());
    assert_eq!(tail.next_offset, second.next_offset);
    assert!(!tail.has_more);
    append(&bytes.as_bytes()[split..]);
    let finished = read_page_with_checkpoint(
        &path,
        AGENT,
        tail.next_offset,
        50,
        tail.checkpoint.as_deref(),
    )
    .unwrap();
    assert_eq!(finished.messages.len(), 1);
    assert_eq!(finished.next_offset, fs::metadata(&path).unwrap().len());
}
#[test]
fn changed_snapshot_bytes_reject_truncation_in_place_rewrite_and_replacement_between_pages() {
    for mode in ["truncate", "rewrite", "replace"] {
        let (dir, path, first) = checkpoint_fixture();
        let original = fs::read_to_string(&path).unwrap();
        if mode == "truncate" {
            fs::write(&path, "").unwrap();
        } else if mode == "rewrite" {
            fs::write(&path, original.replace("text", "next")).unwrap();
        } else {
            let replacement = dir.path().join("replacement");
            fs::write(&replacement, original.replace("text", "next")).unwrap();
            #[cfg(windows)]
            fs::remove_file(&path).unwrap();
            fs::rename(replacement, &path).unwrap();
        }
        assert_eq!(
            read_page_with_checkpoint(
                &path,
                AGENT,
                first.next_offset,
                50,
                first.checkpoint.as_deref()
            )
            .unwrap_err()
            .class(),
            "TranscriptChanged"
        );
        assert!(read_page(&path, AGENT, 0, 50).is_ok());
    }
}
#[test]
fn records_remain_inert_and_media_are_not_opened() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    let secret = dir.path().join("secret");
    fs::write(&secret, "NOT_READ").unwrap();
    let mut record = row();
    record["media"] = json!([{"uri":secret}]);
    record["tool_calls"] = json!([{"name":"$(do-not-execute)","args":{"path":secret}}]);
    write(&path, &[record]);
    let page = read_page(&path, AGENT, 0, 100).unwrap();
    assert!(!serde_json::to_string(&page).unwrap().contains("NOT_READ"));
    assert_eq!(page.messages[0]["blocks"][1]["name"], "$(do-not-execute)");
}
#[test]
fn malformed_and_oversized_records_fail_without_stuck_cursor_or_unbounded_output() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    fs::write(&path, "not-json\n").unwrap();
    assert!(read_page(&path, AGENT, 0, 100).is_err());
    let mut large = row();
    large["content"] = json!("x".repeat(256 * 1024));
    write(&path, &[large]);
    assert!(read_page(&path, AGENT, 0, 100).is_err());
    let mut row = row();
    row["content"] = json!("x".repeat(180000));
    write(&path, &[row.clone(), row.clone(), row]);
    let first = read_page(&path, AGENT, 0, 100).unwrap();
    assert_eq!(first.messages.len(), 2);
    assert!(first.has_more);
    let rest = read_page_with_checkpoint(
        &path,
        AGENT,
        first.next_offset,
        100,
        first.checkpoint.as_deref(),
    )
    .unwrap();
    assert_eq!(rest.messages.len(), 1);
    fs::write(&path, " ".repeat(16 * 1024 * 1024 + 1)).unwrap();
    assert!(read_page(&path, AGENT, 0, 100).is_err());
}
#[test]
fn scan_budget_advances_over_blank_lines_and_requires_safe_boundaries_and_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    fs::write(&path, "\n".repeat(4 * 1024 * 1024 + 2)).unwrap();
    let first = read_page(&path, AGENT, 0, 100).unwrap();
    assert!(first.messages.is_empty());
    assert_eq!(first.next_offset, 4 * 1024 * 1024);
    assert!(first.has_more);
    assert!(read_page(&path, AGENT, first.next_offset, 50).is_err());
    assert!(read_page_with_checkpoint(
        &path,
        TranscriptAgent::Claude,
        0,
        50,
        first.checkpoint.as_deref()
    )
    .is_err());
    for token in [
        "v1:0:bad",
        "v2:0:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "invalid",
    ] {
        assert!(read_page_with_checkpoint(&path, AGENT, 0, 50, Some(token)).is_err());
    }
}
#[test]
fn cli_supports_explicit_snapshot_checkpoint_and_rejects_discovery_and_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    fs::write(&path, FIXTURE).unwrap();
    assert!(discover(AGENT, Some(dir.path()), 50).is_err());
    assert!(conversation(&path, AGENT, 50).is_err());
    let run = |extra: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .args(["transcript", "--agent", "antigravity-jsonl", "--path"])
            .arg(&path)
            .args(extra)
            .env("LAZYSH_STATE_DIR", dir.path())
            .output()
            .unwrap()
    };
    let first = run(&["--limit", "1"]);
    assert!(first.status.success());
    let page: Value = serde_json::from_slice(&first.stdout).unwrap();
    let offset = page["nextOffset"].to_string();
    let checkpoint = page["checkpoint"].as_str().unwrap();
    assert!(run(&["--offset", &offset, "--checkpoint", checkpoint])
        .status
        .success());
    assert!(!run(&["--offset", &offset]).status.success());
    assert!(!run(&["--view", "conversation"]).status.success());
}
#[cfg(unix)]
#[test]
fn reuses_owner_regular_file_and_no_follow_checks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    fs::write(&path, FIXTURE).unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(read_page(&link, AGENT, 0, 100).is_err());
    assert!(read_page(dir.path(), AGENT, 0, 100).is_err());
}
