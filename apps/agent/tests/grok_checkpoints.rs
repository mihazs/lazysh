use lazysh_agent::transcript::{read_checkpointed_grok, read_page, TranscriptAgent};
#[cfg(unix)]
use lazysh_common::record_checkpoint::{RecordCheckpoint, MAX_SNAPSHOT};
use serde_json::{json, Value};
#[cfg(unix)]
use std::io::Write;
use std::{fs, path::PathBuf, process::Command};

fn record(text: &str) -> Vec<u8> {
    let row = json!({"timestamp":1,"method":"session/update","params":{"sessionId":"recording","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}});
    format!("{row}\n").into_bytes()
}
fn fixture(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("updates.jsonl");
    fs::write(&path, bytes).unwrap();
    (dir, path)
}
fn cli(path: &std::path::Path, arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .args(["transcript", "--agent", "grok-acp", "--path"])
        .arg(path)
        .args(arguments)
        .output()
        .unwrap()
}

#[cfg(unix)]
#[test]
fn append_and_partial_utf8_wait_for_newline_without_changing_existing_records() {
    let original = record("first");
    let (_dir, path) = fixture(&original);
    let first = read_checkpointed_grok(&path, 0, 50, None).unwrap();
    assert!(!first.has_more);
    let appended = record("é after rewind");
    let split = appended.iter().position(|b| *b == 0xc3).unwrap() + 1;
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&appended[..split])
        .unwrap();
    let tail =
        read_checkpointed_grok(&path, first.next_offset, 50, first.checkpoint.as_deref()).unwrap();
    assert!(tail.messages.is_empty());
    assert_eq!(tail.next_offset, first.next_offset);
    assert!(!tail.has_more);
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&appended[split..appended.len() - 1])
        .unwrap();
    let complete_json =
        read_checkpointed_grok(&path, tail.next_offset, 50, tail.checkpoint.as_deref()).unwrap();
    assert!(
        complete_json.messages.is_empty(),
        "valid JSON also waits for newline"
    );
    assert_eq!(complete_json.next_offset, first.next_offset);
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    let finished = read_checkpointed_grok(
        &path,
        complete_json.next_offset,
        50,
        complete_json.checkpoint.as_deref(),
    )
    .unwrap();
    assert_eq!(finished.messages[0]["blocks"][0]["text"], "é after rewind");
    assert_eq!(
        finished.next_offset,
        (original.len() + appended.len()) as u64
    );
    let all = read_checkpointed_grok(&path, 0, 1, None).unwrap();
    assert_eq!(all.messages, first.messages);
    assert!(all.has_more);
}

#[cfg(unix)]
#[test]
fn observed_rewrites_truncation_and_identical_content_replacement_invalidate_receipts() {
    for mutation in ["truncate", "rewrite", "replace", "alias"] {
        let bytes = record("initial");
        let (dir, path) = fixture(&bytes);
        let first = read_checkpointed_grok(&path, 0, 50, None).unwrap();
        let selected = match mutation {
            "truncate" => {
                fs::write(&path, b"").unwrap();
                path.clone()
            }
            "rewrite" => {
                fs::write(&path, record("changed")).unwrap();
                path.clone()
            }
            "replace" => {
                fs::rename(&path, dir.path().join("original")).unwrap();
                fs::write(&path, &bytes).unwrap();
                path.clone()
            }
            _ => {
                let alias = dir.path().join("alias");
                fs::hard_link(&path, &alias).unwrap();
                alias
            }
        };
        let error = read_checkpointed_grok(
            &selected,
            first.next_offset,
            50,
            first.checkpoint.as_deref(),
        )
        .unwrap_err();
        assert_eq!(error.class(), "TranscriptChanged", "{mutation}");
    }
}

#[cfg(unix)]
#[test]
fn exact_cursor_boundaries_and_full_observed_unread_prefix_are_required() {
    let mut bytes = record("one");
    bytes.extend(record("two"));
    let (_dir, path) = fixture(&bytes);
    let page = read_checkpointed_grok(&path, 0, 1, None).unwrap();
    assert!(read_checkpointed_grok(&path, 1, 1, None).is_err());
    assert!(
        read_checkpointed_grok(&path, page.next_offset + 1, 1, page.checkpoint.as_deref()).is_err()
    );
    let mut receipt = RecordCheckpoint::parse(page.checkpoint.as_ref().unwrap()).unwrap();
    receipt.next_offset = 1;
    assert!(read_checkpointed_grok(&path, 1, 1, Some(&receipt.to_string())).is_err());
    let last = bytes.len() - 3;
    bytes[last] = b'X';
    fs::write(&path, bytes).unwrap();
    assert_eq!(
        read_checkpointed_grok(&path, page.next_offset, 1, page.checkpoint.as_deref())
            .unwrap_err()
            .class(),
        "TranscriptChanged"
    );
}

#[cfg(unix)]
#[test]
fn limits_and_recovered_torn_tails_fail_without_fallback() {
    let (_dir, path) = fixture(b"{\"torn\":");
    let tail = read_checkpointed_grok(&path, 0, 50, None).unwrap();
    assert_eq!(tail.next_offset, 0);
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert_eq!(
        read_checkpointed_grok(&path, 0, 50, tail.checkpoint.as_deref())
            .unwrap_err()
            .class(),
        "InvalidEvent"
    );
    fs::write(&path, vec![b' '; 256 * 1024 + 1]).unwrap();
    assert_eq!(
        read_checkpointed_grok(&path, 0, 50, None)
            .unwrap_err()
            .class(),
        "InvalidEvent"
    );
    fs::write(&path, record("legacy still readable")).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_SNAPSHOT + 1)
        .unwrap();
    assert_eq!(
        read_checkpointed_grok(&path, 0, 1, None)
            .unwrap_err()
            .class(),
        "InvalidArgument"
    );
    assert_eq!(
        read_page(&path, TranscriptAgent::GrokAcp, 0, 1)
            .unwrap()
            .messages
            .len(),
        1
    );
}

#[cfg(unix)]
#[test]
fn checkpointed_records_keep_scan_and_output_budgets_without_reconstructing_rewinds() {
    let chunk = record(&"x".repeat(180 * 1024));
    let (_dir, path) = fixture(&chunk.repeat(4));
    let bounded = read_checkpointed_grok(&path, 0, 100, None).unwrap();
    assert_eq!(bounded.messages.len(), 2);
    assert_eq!(bounded.next_offset, (chunk.len() * 2) as u64);
    assert!(bounded.has_more);
    let mut whitespace = vec![b' '; 64 * 1024 - 1];
    whitespace.push(b'\n');
    fs::write(&path, whitespace.repeat(65)).unwrap();
    let scanned = read_checkpointed_grok(&path, 0, 100, None).unwrap();
    assert_eq!(scanned.next_offset, 4 * 1024 * 1024);
    assert!(scanned.has_more);
    assert!(scanned.messages.is_empty());
    let mut history = record("original branch");
    history.extend_from_slice(b"{\"timestamp\":2,\"method\":\"_x.ai/session/update\",\"params\":{\"sessionId\":\"recording\",\"update\":{\"sessionUpdate\":\"rewind_marker\",\"target_prompt_index\":0}}}\n");
    history.extend(record("new branch"));
    fs::write(&path, &history).unwrap();
    let raw = read_checkpointed_grok(&path, 0, 100, None).unwrap();
    assert_eq!(raw.messages.len(), 2);
    assert_eq!(raw.messages[0]["blocks"][0]["text"], "original branch");
    assert_eq!(raw.next_offset, history.len() as u64);
    assert!(raw.branch_id.is_none());
}

#[test]
fn cli_opt_in_is_explicit_and_incompatible_combinations_fail() {
    let (_dir, path) = fixture(&record("CLI"));
    let legacy = cli(&path, &[]);
    assert!(legacy.status.success());
    assert!(serde_json::from_slice::<Value>(&legacy.stdout)
        .unwrap()
        .get("checkpoint")
        .is_none());
    for arguments in [
        vec!["--checkpointed", "--view", "conversation"],
        vec!["--checkpointed", "--session-id", "recording"],
        vec!["--checkpointed", "--offset", "1"],
        vec!["--checkpointed", "--checkpoint", "g1:invalid"],
        vec!["--checkpoint", "g1:invalid"],
    ] {
        let result = cli(&path, &arguments);
        assert!(!result.status.success(), "{arguments:?}");
        assert!(result.stdout.is_empty());
    }
    let wrong_agent = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .args([
            "transcript",
            "--agent",
            "claude",
            "--checkpointed",
            "--path",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert!(!wrong_agent.status.success());
    let result = cli(&path, &["--checkpointed"]);
    #[cfg(unix)]
    {
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let page: Value = serde_json::from_slice(&result.stdout).unwrap();
        let token = page["checkpoint"].as_str().unwrap();
        let offset = page["nextOffset"].to_string();
        assert!(cli(
            &path,
            &["--checkpointed", "--checkpoint", token, "--offset", &offset]
        )
        .status
        .success());
        fs::write(&path, b"").unwrap();
        let changed = cli(
            &path,
            &["--checkpointed", "--checkpoint", token, "--offset", &offset],
        );
        assert!(!changed.status.success());
        assert!(String::from_utf8_lossy(&changed.stderr).contains("TranscriptChanged"));
    }
    #[cfg(not(unix))]
    {
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("TranscriptIdentityUnsupported"));
    }
}
