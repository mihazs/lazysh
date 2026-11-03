use lazysh_agent::transcript::opencode_conversation;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, process::Command};

struct Fixture {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    db: Connection,
    v2: bool,
}
impl Fixture {
    fn new(v2: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(if v2 {
            "CREATE TABLE session_v2(id TEXT PRIMARY KEY,title TEXT,revert TEXT,time_updated INTEGER);
             CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_created INTEGER);
             CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,data TEXT);
             CREATE TABLE session_inbox(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,delivery TEXT);
             INSERT INTO session_v2 VALUES('selected','work',NULL,1000);"
        } else {
            "CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,revert TEXT,time_updated INTEGER);
             CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER);
             CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT);
             INSERT INTO session VALUES('selected','work',NULL,1000);"
        }).unwrap();
        Self {
            _dir: dir,
            path,
            db,
            v2,
        }
    }
    fn message(&self, id: &str, seq: i64, role: &str, data: Value) {
        if self.v2 {
            self.db
                .execute(
                    "INSERT INTO session_message VALUES(?1,'selected',?2,?3,?4,?3)",
                    params![id, role, seq, data.to_string()],
                )
                .unwrap();
        } else {
            let mut data = data;
            data["role"] = json!(role);
            self.db
                .execute(
                    "INSERT INTO message VALUES(?1,'selected',?2,?3)",
                    params![id, data.to_string(), seq],
                )
                .unwrap();
        }
    }
    fn part(&self, message: &str, ordinal: i64, data: Value) {
        if self.v2 {
            self.db
                .execute(
                    "INSERT INTO session_part VALUES(?1,'selected',?2,?3)",
                    params![message, ordinal, data.to_string()],
                )
                .unwrap();
        } else {
            self.db
                .execute(
                    "INSERT INTO part VALUES(?1,?2,'selected',?3)",
                    params![format!("part_{ordinal:04}"), message, data.to_string()],
                )
                .unwrap();
        }
    }
    fn page(&self, limit: u8) -> Value {
        serde_json::to_value(opencode_conversation(&self.path, "selected", limit).unwrap()).unwrap()
    }
    fn revert(&self, value: Option<Value>) {
        let table = if self.v2 { "session_v2" } else { "session" };
        self.db
            .execute(
                &format!("UPDATE {table} SET revert=?1"),
                [value.map(|v| v.to_string())],
            )
            .unwrap();
    }
}
fn texts(page: &Value) -> Vec<&str> {
    page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["blocks"].as_array().unwrap())
        .filter_map(|p| p["text"].as_str())
        .collect()
}

#[test]
fn v2_parts_replace_legacy_inline_and_export_only_public_fields() {
    let f = Fixture::new(true);
    f.message("msg_a",1,"user",json!({"text":"question","metadata":{"secret":"private"},"files":[{"name":"diagram.png","mime":"image/png","uri":"media:secret","data":"privatebase64"}]}));
    f.message(
        "msg_b",
        2,
        "assistant",
        json!({"content":[{"type":"text","text":"stale"}],"providerState":{"secret":"private"}}),
    );
    f.part(
        "msg_b",
        0,
        json!({"type":"reasoning","text":"thinking","state":{"secret":"private"}}),
    );
    f.part("msg_b",1,json!({"type":"tool","id":"call","name":"read","providerState":{"secret":"private"},"providerResultState":{"secret":"private"},"state":{"status":"running","input":{"file":"public.rs"},"metadata":{"secret":"private"}}}));
    let page = f.page(50);
    assert_eq!(page["view"], "active_branch");
    assert_eq!(page["branchId"], "selected");
    assert!(!page["hasMore"].as_bool().unwrap());
    assert!(texts(&page).contains(&"question"));
    assert!(texts(&page).contains(&"thinking"));
    let encoded = page.to_string();
    for private in [
        "stale",
        "private",
        "media:",
        "base64",
        "providerState",
        "metadata",
    ] {
        assert!(!encoded.contains(private), "{private}");
    }
    f.db.execute("UPDATE session_part SET data=?1 WHERE ordinal=1",[json!({"type":"tool","id":"call","name":"read","state":{"status":"completed","input":{"file":"public.rs"},"content":[{"type":"text","text":"current result"}]}}).to_string()]).unwrap();
    assert!(texts(&f.page(50)).contains(&"current result"));
}

#[test]
fn v2_queue_filter_revert_clear_and_selected_fork_are_current_projection() {
    let f = Fixture::new(true);
    for (id, n) in [("msg_a", 1), ("msg_b", 2), ("msg_c", 3)] {
        f.message(id, n, "user", json!({"text":id}));
    }
    f.db.execute(
        "INSERT INTO session_inbox VALUES('msg_b','selected','user','queue')",
        [],
    )
    .unwrap();
    f.revert(Some(json!({"messageID":"msg_c","partID":"partial"})));
    assert_eq!(texts(&f.page(50)), ["msg_a"]);
    f.revert(None);
    assert_eq!(texts(&f.page(50)), ["msg_a", "msg_c"]);
    f.db.execute("DELETE FROM session_inbox", []).unwrap();
    assert_eq!(texts(&f.page(50)), ["msg_a", "msg_b", "msg_c"]);
    f.db.execute_batch("INSERT INTO session_v2 VALUES('parent','parent',NULL,1000); INSERT INTO session_message VALUES('msg_parent','parent','user',0,'{\"text\":\"parent secret\"}',0)").unwrap();
    assert!(!f.page(50).to_string().contains("parent secret"));
    f.revert(Some(json!({"messageID":"missing"})));
    assert!(opencode_conversation(&f.path, "selected", 50).is_err());
}

#[test]
fn v1_staged_revert_and_committed_partial_prefix_match_visible_history() {
    let f = Fixture::new(false);
    f.message("msg_a", 1, "user", json!({}));
    f.part("msg_a", 0, json!({"type":"text","text":"first"}));
    f.message("msg_b", 2, "assistant", json!({}));
    f.part("msg_b", 1, json!({"type":"text","text":"prefix"}));
    f.part("msg_b", 2, json!({"type":"text","text":"tail"}));
    f.part(
        "msg_a",
        3,
        json!({"type":"text","text":"synthetic secret","synthetic":true}),
    );
    f.revert(Some(json!({"messageID":"msg_b","partID":"part_0002"})));
    assert_eq!(texts(&f.page(50)), ["first"]);
    f.revert(None);
    assert_eq!(texts(&f.page(50)), ["first", "prefix", "tail"]);
    f.db.execute("DELETE FROM part WHERE id>='part_0002'", [])
        .unwrap();
    assert_eq!(texts(&f.page(50)), ["first", "prefix"]);
}

#[test]
fn empty_bounds_malformed_unknown_and_session_isolation_fail_truthfully() {
    for v2 in [true, false] {
        let f = Fixture::new(v2);
        assert!(f.page(50)["messages"].as_array().unwrap().is_empty());
        assert!(opencode_conversation(&f.path, "missing", 50).is_err());
        assert!(opencode_conversation(&f.path, "selected", 0).is_err());
        f.message("msg_a", 1, "user", json!({"text":"a"}));
        if !v2 {
            f.part("msg_a", 0, json!({"type":"text","text":"a"}));
        }
        f.message(
            "msg_b",
            2,
            "assistant",
            json!({"content":[{"type":"text","text":"b"}]}),
        );
        if !v2 {
            f.part("msg_b", 1, json!({"type":"text","text":"b"}));
        }
        let page = f.page(1);
        assert_eq!(texts(&page), ["b"]);
        assert_eq!(page["truncated"], true);
        if v2 {
            f.part("msg_b", 0, json!({"type":"future","private":"secret"}));
        } else {
            f.part("msg_b", 2, json!({"type":"future"}));
        }
        assert!(opencode_conversation(&f.path, "selected", 50).is_err());
    }
}

#[test]
fn wal_snapshot_reads_committed_rows_without_mutating_database() {
    let f = Fixture::new(true);
    f.db.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    f.message("msg_a", 1, "user", json!({"text":"committed"}));
    let before = fs::read(&f.path).unwrap();
    let wal = fs::read(f.path.with_extension("db-wal")).unwrap();
    f.db.execute_batch("BEGIN; UPDATE session_message SET data='{\"text\":\"uncommitted\"}'")
        .unwrap();
    assert_eq!(texts(&f.page(50)), ["committed"]);
    assert_eq!(fs::read(&f.path).unwrap(), before);
    assert_eq!(fs::read(f.path.with_extension("db-wal")).unwrap(), wal);
    f.db.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn cli_requires_database_session_and_conversation_offset_zero() {
    let f = Fixture::new(true);
    f.message("msg_a", 1, "user", json!({"text":"visible"}));
    let run = |extra: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .args([
                "transcript",
                "--agent",
                "opencode",
                "--path",
                f.path.to_str().unwrap(),
                "--view",
                "conversation",
            ])
            .args(extra)
            .output()
            .unwrap()
    };
    let ok = run(&["--session-id", "selected"]);
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
    assert_eq!(
        texts(&serde_json::from_slice::<Value>(&ok.stdout).unwrap()),
        ["visible"]
    );
    for args in [
        vec![],
        vec!["--session-id", "selected", "--offset", "1"],
        vec!["--session-id", "selected", "--inline-images"],
        vec!["--session-id", "selected", "--checkpoint", "x"],
    ] {
        assert!(!run(&args).status.success());
    }
}

#[cfg(unix)]
#[test]
fn symlink_sources_are_rejected() {
    let f = Fixture::new(true);
    let alias = f._dir.path().join("link.db");
    std::os::unix::fs::symlink(&f.path, &alias).unwrap();
    assert!(opencode_conversation(&alias, "selected", 50).is_err());
}

#[test]
fn tool_failures_with_only_files_keep_error_on_a_result_and_private_error_opaque() {
    let f = Fixture::new(true);
    f.message("msg_a", 1, "assistant", json!({"content":[]}));
    f.part(
        "msg_a",
        0,
        json!({"type":"tool","id":"call","name":"read","state":{
            "status":"error","input":{},"error":{"secret":"private"},
            "content":[{"type":"file","mime":"image/png","name":"capture.png","uri":"private"}]
        }}),
    );
    let page = f.page(50);
    let blocks = page["messages"][0]["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[1]["type"], "image");
    assert!(blocks[1].get("isError").is_none());
    assert_eq!(blocks[2]["type"], "tool_result");
    assert_eq!(blocks[2]["isError"], true);
    assert!(!page.to_string().contains("private"));
}

#[test]
fn empty_failed_responses_remain_visible_and_recorded_usage_is_preserved() {
    for v2 in [false, true] {
        let f = Fixture::new(v2);
        f.message(
            "msg_a",
            1,
            "assistant",
            json!({"content":[],
                "error":{"name":"APIError","data":{"responseHeaders":{"authorization":"private"}}},
                "tokens":{"input":15,"output":3,"cache":{"read":9,"write":2}}
            }),
        );
        let page = f.page(50);
        assert_eq!(page["messages"][0]["blocks"][0]["isError"], true);
        assert_eq!(
            page["messages"][0]["usage"],
            json!({"inputTokens":15,"outputTokens":3,"cacheReadTokens":9,"cacheWriteTokens":2})
        );
        assert!(!page.to_string().contains("private"));
        assert!(!page.to_string().contains("authorization"));
    }
}

#[test]
fn malformed_tool_inputs_cannot_silently_hide_invocations() {
    for input in [Value::Null, json!([]), json!(42), json!("unfinished")] {
        let f = Fixture::new(true);
        let state = json!({"status":"running","input":input});
        let content = json!({"type":"tool","id":"call","name":"read","state":state});
        f.message("msg_a", 1, "assistant", json!({"content":[content]}));
        assert!(opencode_conversation(&f.path, "selected", 50).is_err());
        assert!(opencode_conversation(&f.path, "selected\n", 50).is_err());
    }
}
