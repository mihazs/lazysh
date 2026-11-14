//! A session of 10k+ records reads from its first message to its last, page by page, for every
//! agent whose conversation the companion projects, across compactions.
#[path = "support/jsonl.rs"]
mod jsonl;
#[path = "support/recorded_conversations.rs"]
#[allow(dead_code)]
mod recorded_conversations;
use jsonl::write;
use lazysh_agent::transcript::{
    conversation_window, opencode_conversation_window, window::Window, TranscriptAgent,
    TranscriptPage,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{path::Path, process::Command};

const RECORDS: usize = 12_000;

fn texts(page: &TranscriptPage) -> Vec<String> {
    page.messages
        .iter()
        .flat_map(|m| m["blocks"].as_array().unwrap().iter())
        .filter_map(|b| b["text"].as_str().map(str::to_owned))
        .collect()
}
fn first_id(page: &TranscriptPage) -> String {
    page.messages[0]["id"].as_str().unwrap().to_owned()
}

/// Reads the whole session newest page first, the way the Agent view scrolls up, and returns it
/// oldest first. Every page must start where the previous one ended.
fn walk_back(read: impl Fn(&Window) -> TranscriptPage) -> Vec<String> {
    let mut page = read(&Window::Tail);
    assert!(!page.has_newer);
    let mut all = texts(&page);
    let mut pages = 1;
    while page.truncated {
        page = read(&Window::Before(first_id(&page)));
        assert!(page.has_newer);
        all.splice(0..0, texts(&page));
        pages += 1;
    }
    assert!(pages > RECORDS / 200, "{pages} pages");
    all
}

fn expected(count: usize) -> Vec<String> {
    (0..count).map(|n| format!("m{n}")).collect()
}

#[test]
fn claude_reads_back_across_compactions_to_the_first_message() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut records = Vec::new();
    for n in 0..RECORDS {
        let role = if n % 2 == 0 { "user" } else { "assistant" };
        let mut record = json!({"type":role,"uuid":format!("u{n}"),"parentUuid":(n > 0).then(|| format!("u{}", n - 1)),"message":{"content":format!("m{n}")}});
        // Compaction restarts the parent chain; the earlier conversation stays behind logicalParentUuid.
        if n > 0 && n % 4000 == 0 {
            records.push(json!({"type":"system","subtype":"compact_boundary","uuid":format!("b{n}"),"parentUuid":null,"logicalParentUuid":format!("u{}", n - 1)}));
            record["parentUuid"] = json!(format!("b{n}"));
        }
        records.push(record);
    }
    write(&path, &records);
    let read = |window: &Window| {
        conversation_window(&path, TranscriptAgent::Claude, 100, false, window).unwrap()
    };
    assert_eq!(walk_back(read), expected(RECORDS));
    let start = read(&Window::Start);
    assert_eq!((texts(&start)[0].as_str(), start.truncated), ("m0", false));
    let mut forward = texts(&start);
    let mut page = start;
    while page.has_newer {
        page = read(&Window::After(
            page.messages.last().unwrap()["id"].as_str().unwrap().into(),
        ));
        forward.extend(texts(&page));
    }
    assert_eq!(forward, expected(RECORDS));
}

#[test]
fn claude_session_with_a_removed_anchor_is_an_error_not_a_wrong_page() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    write(
        &path,
        &[json!({"type":"user","uuid":"a","parentUuid":null,"message":{"content":"hi"}})],
    );
    let gone = Window::Before("missing".into());
    assert!(conversation_window(&path, TranscriptAgent::Claude, 50, false, &gone).is_err());
}

#[test]
fn codex_reads_back_to_the_first_message() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    let record = |kind: &str, payload: Value| json!({"timestamp":"2026-01-02T03:04:05Z","type":kind,"payload":payload});
    let mut records = vec![record(
        "session_meta",
        json!({"id":"11111111-1111-4111-8111-111111111111","history_mode":"legacy"}),
    )];
    for n in 0..RECORDS {
        records.push(record(
            "event_msg",
            json!({"type":"task_started","turn_id":format!("t{n}")}),
        ));
        let kind = if n % 2 == 0 {
            "user_message"
        } else {
            "agent_message"
        };
        records.push(record(
            "event_msg",
            json!({"type":kind,"message":format!("m{n}")}),
        ));
        if n % 4000 == 3999 {
            records.push(record(
                "compacted",
                json!({"message":"summary","replacement_history":[]}),
            ));
        }
    }
    write(&path, &records);
    let read = |window: &Window| {
        conversation_window(&path, TranscriptAgent::Codex, 100, false, window).unwrap()
    };
    assert_eq!(walk_back(read), expected(RECORDS));
}

#[test]
fn opencode_reads_back_to_the_first_message() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap().join("opencode.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        recorded_conversations::specification()["opencodeSchemas"]["v1"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    db.execute_batch("BEGIN").unwrap();
    for n in 0..RECORDS {
        let role = if n % 2 == 0 { "user" } else { "assistant" };
        db.execute(
            "INSERT INTO message VALUES(?1,'selected',?2,?3)",
            params![
                format!("msg_{n:06}"),
                json!({"role":role}).to_string(),
                n as i64
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO part VALUES(?1,?2,'selected',?3)",
            params![
                format!("part_{n:06}"),
                format!("msg_{n:06}"),
                json!({"type":"text","text":format!("m{n}")}).to_string()
            ],
        )
        .unwrap();
    }
    db.execute_batch("COMMIT").unwrap();
    drop(db);
    let read =
        |window: &Window| opencode_conversation_window(&path, "selected", 100, window).unwrap();
    assert_eq!(walk_back(read), expected(RECORDS));
}

fn companion(path: &Path, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .args([
            "transcript",
            "--agent",
            "claude",
            "--view",
            "conversation",
            "--path",
        ])
        .arg(path)
        .args(["--limit", "3"])
        .args(extra)
        .output()
        .unwrap()
}

#[test]
fn the_companion_command_pages_older_and_rejects_a_window_outside_the_conversation_view() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let records: Vec<Value> = (0..8)
        .map(|n| json!({"type":"user","uuid":format!("u{n}"),"parentUuid":(n > 0).then(|| format!("u{}", n - 1)),"message":{"content":format!("m{n}")}}))
        .collect();
    write(&path, &records);
    let newest: Value = serde_json::from_slice(&companion(&path, &[]).stdout).unwrap();
    assert_eq!(
        (newest["truncated"].clone(), newest.get("hasNewer").cloned()),
        (json!(true), None)
    );
    let older: Value =
        serde_json::from_slice(&companion(&path, &["--before", "u5"]).stdout).unwrap();
    let ids: Vec<_> = older["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        (ids, older["hasNewer"].clone()),
        (vec!["u2", "u3", "u4"], json!(true))
    );
    let first: Value = serde_json::from_slice(&companion(&path, &["--from-start"]).stdout).unwrap();
    assert_eq!(first["messages"][0]["id"], "u0");
    let both = companion(&path, &["--before", "u5", "--after", "u1"]);
    assert!(!both.status.success());
    let records = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .args(["transcript", "--agent", "claude", "--from-start", "--path"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(!records.status.success());
}
