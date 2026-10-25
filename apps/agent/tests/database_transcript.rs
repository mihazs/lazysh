use lazysh_agent::transcript::{discover, read_database_page, TranscriptAgent};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command};

fn hermes(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,last_activity_at REAL,started_at REAL,hidden INTEGER DEFAULT 0);
        CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,timestamp REAL,active INTEGER DEFAULT 1,compacted INTEGER DEFAULT 0);
        INSERT INTO sessions VALUES('s1','Hermes work',NULL,1792872000,0);
        INSERT INTO sessions VALUES('s2','Other work',NULL,1792872001,0);").unwrap();
    db
}
fn opencode(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch("CREATE TABLE session_v2(id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER);
        CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);
        CREATE UNIQUE INDEX seq ON session_message(session_id,seq);
        INSERT INTO session_v2 VALUES('ses_1','OpenCode work',1792872000000);").unwrap();
    db
}
fn hermes_row(db: &Connection, id: i64, session: &str, role: &str, content: &str) {
    db.execute(
        "INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(?1,?2,?3,?4,1792872000)",
        params![id, session, role, content],
    )
    .unwrap();
}

#[test]
fn hermes_pages_exact_session_active_rows_and_preserves_literal_json_text() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.db");
    let db = hermes(&path);
    hermes_row(&db, 1, "s1", "user", "[\"literal JSON text\"]");
    hermes_row(&db, 2, "s2", "user", "other session secret");
    hermes_row(&db, 3, "s1", "assistant", "answer");
    db.execute("UPDATE messages SET tool_calls=?1 WHERE id=3",[json!([{"id":"c1","type":"function","function":{"name":"terminal","arguments":"{\"command\":\"cargo test\"}"}}]).to_string()]).unwrap();
    hermes_row(&db, 4, "s1", "tool", "passed");
    db.execute(
        "UPDATE messages SET tool_call_id='c1',tool_name='terminal' WHERE id=4",
        [],
    )
    .unwrap();
    hermes_row(&db, 5, "s1", "user", "inactive secret");
    db.execute("UPDATE messages SET active=0 WHERE id=5", [])
        .unwrap();
    hermes_row(&db, 6, "s1", "assistant", "compacted secret");
    db.execute("UPDATE messages SET compacted=1 WHERE id=6", [])
        .unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    let first = read_database_page(&path, TranscriptAgent::Hermes, "s1", 0, 1).unwrap();
    assert_eq!(first.messages.len(), 1);
    assert_eq!(
        first.messages[0]["blocks"][0]["text"],
        "[\"literal JSON text\"]"
    );
    assert!(first.has_more);
    assert_eq!(first.next_offset, 2);
    let second =
        read_database_page(&path, TranscriptAgent::Hermes, "s1", first.next_offset, 50).unwrap();
    assert_eq!(second.messages.len(), 2);
    assert_eq!(second.messages[0]["blocks"][1]["id"], "c1");
    assert_eq!(second.messages[1]["blocks"][0]["type"], "tool_result");
    assert_eq!(second.messages[1]["blocks"][0]["text"], "passed");
    assert!(!second.has_more);
    assert!(!serde_json::to_string(&second).unwrap().contains("secret"));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(
        read_database_page(&path, TranscriptAgent::Hermes, "s1' OR 1=1 --", 0, 50)
            .unwrap()
            .messages
            .is_empty()
    );
}

#[test]
fn hermes_structured_content_marker_and_current_wal_rows_are_visible() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.db");
    let db = hermes(&path);
    db.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    let content = format!(
        "\0json:{}",
        json!([{"type":"text","text":"multimodal prompt"},{"type":"image_url","image_url":{"url":"https://example.invalid/private"}}])
    );
    hermes_row(&db, 1, "s1", "user", &content);
    let page = read_database_page(&path, TranscriptAgent::Hermes, "s1", 0, 50).unwrap();
    assert_eq!(page.messages[0]["blocks"][0]["text"], "multimodal prompt");
    assert!(!serde_json::to_string(&page).unwrap().contains("https://"));
}

#[test]
fn opencode_v2_normalizes_current_user_assistant_and_tool_projection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("opencode.db");
    let db = opencode(&path);
    let rows = [
        (
            "msg_0",
            "user",
            json!({"text":"Fix it","files":[],"time":{"created":1792872000000_i64}}),
        ),
        ("msg_1", "model-switched", json!({"model":{"id":"SECRET"}})),
        (
            "msg_2",
            "assistant",
            json!({"content":[{"type":"text","text":"Inspecting"},{"type":"reasoning","text":"Read tests"},{"type":"tool","id":"c1","name":"bash","native":{"hidden":"SECRET"},"state":{"status":"completed","input":{"command":"cargo test"},"content":[{"type":"text","text":"passed"}]}}],"tokens":{"input":10,"output":20,"cache":{"read":3,"write":4}}}),
        ),
    ];
    for (seq, (id, kind, data)) in rows.iter().enumerate() {
        db.execute(
            "INSERT INTO session_message VALUES(?1,'ses_1',?2,?3,1792872000000,?4)",
            params![id, kind, seq as i64, data.to_string()],
        )
        .unwrap();
    }
    drop(db);
    let page = read_database_page(&path, TranscriptAgent::Opencode, "ses_1", 0, 50).unwrap();
    assert_eq!(page.messages.len(), 2);
    assert_eq!(page.messages[1]["usage"]["inputTokens"], 10);
    assert_eq!(page.messages[1]["blocks"][1]["type"], "thinking");
    assert_eq!(page.messages[1]["blocks"][2]["id"], "c1");
    assert_eq!(page.messages[1]["blocks"][3]["type"], "tool_result");
    assert_eq!(page.messages[1]["blocks"][3]["text"], "passed");
    assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
    assert_eq!(page.next_offset, 3);
}

#[test]
fn database_discovery_returns_exact_ids_and_cli_requires_selected_session() {
    let directory = tempfile::tempdir().unwrap();
    let hermes_path = directory.path().join("state.db");
    let db = hermes(&hermes_path);
    hermes_row(&db, 1, "s1", "user", "hello");
    drop(db);
    let page =
        serde_json::to_value(discover(TranscriptAgent::Hermes, Some(directory.path()), 1).unwrap())
            .unwrap();
    assert_eq!(page["sessions"][0]["sessionId"], "s2");
    assert_eq!(page["truncated"], true);
    assert_eq!(page["sessions"][0]["path"], hermes_path.to_str().unwrap());
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args(["transcript", "--agent", "hermes", "--path"])
        .arg(&hermes_path)
        .args(["--session-id", "s1"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let output: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output["messages"][0]["blocks"][0]["text"], "hello");
    let missing = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args(["transcript", "--agent", "hermes", "--path"])
        .arg(&hermes_path)
        .output()
        .unwrap();
    assert!(!missing.status.success());
    let opencode_path = directory.path().join("opencode.db");
    drop(opencode(&opencode_path));
    let page = serde_json::to_value(
        discover(TranscriptAgent::Opencode, Some(&opencode_path), 50).unwrap(),
    )
    .unwrap();
    assert_eq!(page["sessions"][0]["sessionId"], "ses_1");
}

#[test]
fn database_payload_limits_and_unsupported_schemas_fail_without_modification() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.db");
    let db = hermes(&path);
    hermes_row(&db, 1, "s1", "user", &"x".repeat(600_000));
    drop(db);
    assert!(read_database_page(&path, TranscriptAgent::Hermes, "s1", 0, 50).is_err());
    let legacy = directory.path().join("old.db");
    let db = Connection::open(&legacy).unwrap();
    db.execute_batch(
        "CREATE TABLE message(id TEXT,data TEXT); CREATE TABLE part(id TEXT,data TEXT);",
    )
    .unwrap();
    drop(db);
    let before = fs::read(&legacy).unwrap();
    assert!(read_database_page(&legacy, TranscriptAgent::Opencode, "s1", 0, 50).is_err());
    assert_eq!(before, fs::read(&legacy).unwrap());
    assert!(read_database_page(&path, TranscriptAgent::Hermes, "", 0, 50).is_err());
    assert!(read_database_page(&path, TranscriptAgent::Hermes, "s1", u64::MAX, 50).is_err());
    assert!(!directory.path().join("events.sqlite3").exists());
}

#[test]
fn hostile_recursive_database_views_are_interrupted_by_query_budget() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("hostile.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE VIEW messages AS WITH RECURSIVE endless(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM endless) SELECT x AS id,'s1' AS session_id,'system' AS role,NULL AS content,NULL AS tool_call_id,NULL AS tool_calls,NULL AS tool_name,0 AS timestamp,1 AS active,0 AS compacted FROM endless;").unwrap();
    drop(db);
    let started = std::time::Instant::now();
    assert!(read_database_page(&path, TranscriptAgent::Hermes, "s1", 0, 50).is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}
