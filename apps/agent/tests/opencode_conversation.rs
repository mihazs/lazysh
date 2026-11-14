#[path = "support/recorded_conversations.rs"]
mod recorded_conversations;

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
        let path = dir.path().canonicalize().unwrap().join("opencode.db");
        let db = Connection::open(&path).unwrap();
        let specification = recorded_conversations::specification();
        db.execute_batch(
            specification["opencodeSchemas"][if v2 { "v2" } else { "v1" }]
                .as_str()
                .unwrap(),
        )
        .unwrap();
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
        let error = if v2 {
            json!({"type":"api","message":"failure","response":{"body":"private"}})
        } else {
            json!({"name":"APIError","data":{"responseHeaders":{"authorization":"private"}}})
        };
        f.message(
            "msg_a",
            1,
            "assistant",
            json!({"content":[],
                "error":error,
                "tokens":{"input":15,"output":3,"cache":{"read":9,"write":2}}
            }),
        );
        let page = f.page(50);
        let failure = &page["messages"][0]["blocks"][0];
        assert_eq!(failure["type"], "text");
        assert!(failure["text"]
            .as_str()
            .unwrap()
            .starts_with("Agent response failed"));
        assert!(failure.get("isError").is_none());
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

#[test]
fn shared_synthetic_android_conversation_matches_both_database_formats() {
    let specification = recorded_conversations::specification();
    for v2 in [false, true] {
        let fixture = Fixture::new(v2);
        let kind = if v2 { "v2" } else { "v1" };
        let expected = recorded_conversations::messages(&specification, kind);
        for (index, message) in expected.iter().enumerate() {
            let id = message["id"].as_str().unwrap();
            fixture.message(
                id,
                index as i64,
                message["role"].as_str().unwrap(),
                json!({"text":message["text"]}),
            );
            fixture.part(
                id,
                index as i64,
                json!({"type":"text","text":message["text"]}),
            );
        }
        let session = specification["opencodeSessions"][kind].as_str().unwrap();
        fixture
            .db
            .execute(
                &format!(
                    "UPDATE {} SET id=?1",
                    if v2 { "session_v2" } else { "session" }
                ),
                [session],
            )
            .unwrap();
        for table in if v2 {
            ["session_message", "session_part"]
        } else {
            ["message", "part"]
        } {
            fixture
                .db
                .execute(&format!("UPDATE {table} SET session_id=?1"), [session])
                .unwrap();
        }
        let page = serde_json::to_value(opencode_conversation(&fixture.path, session, 50).unwrap())
            .unwrap();
        assert_eq!(page["branchId"], session);
        recorded_conversations::assert_messages(page["messages"].as_array().unwrap(), &expected);
    }
}

#[test]
fn task_calls_become_sub_agents_in_the_work_list_and_a_plain_session_has_none() {
    let f = Fixture::new(false);
    f.message("msg_a", 1, "user", json!({"time":{"created":1}}));
    f.message(
        "msg_b",
        2,
        "assistant",
        json!({"time":{"created":2,"completed":3},"finish":"stop"}),
    );
    f.part("msg_b", 0, json!({"type":"tool","tool":"read","callID":"r1","state":{"status":"completed","input":{"filePath":"a.rs"},"output":"x"}}));
    assert!(f.page(50)["work"].is_null());
    f.part("msg_b", 1, json!({"type":"tool","tool":"task","callID":"c1","state":{"status":"completed","input":{"description":"Map config","subagent_type":"explore"},"output":"done","metadata":{"sessionId":"ses_child"},"time":{"start":1_785_941_702_000_i64,"end":1_785_941_762_000_i64}}}));
    f.part("msg_b", 2, json!({"type":"tool","tool":"task","callID":"c2","state":{"status":"completed","input":{"description":"Research","run_in_background":true},"output":"Background task launched.","metadata":{"backgroundTaskId":"bg_1"},"time":{"start":1_785_941_703_000_i64}}}));
    f.part("msg_b", 3, json!({"type":"tool","tool":"background_output","callID":"o1","state":{"status":"completed","input":{"task_id":"bg_1"},"output":"Task ID: bg_1\nStatus: completed\n"}}));
    let page = f.page(50);
    let work = page["work"].as_array().unwrap();
    let rows: Vec<_> = work
        .iter()
        .map(|t| {
            (
                t["title"].as_str().unwrap(),
                t["subtitle"].as_str(),
                t["state"].as_str().unwrap(),
                t["taskId"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("Map config", Some("explore"), "done", "ses_child"),
            ("Research", None, "done", "bg_1")
        ]
    );
    assert_eq!(work[0]["startedAt"], "2026-08-05T14:55:02Z");
    // The tool calls stay in the conversation next to the work list.
    assert!(page["messages"].to_string().contains("Map config"));
}

#[test]
fn a_compaction_is_one_event_line_and_a_step_or_patch_marker_stays_silent() {
    // V1 records a compaction as a user message holding one `compaction` part; V2 as a message of the `compaction` role.
    for v2 in [false, true] {
        let f = Fixture::new(v2);
        f.message(
            "msg_a",
            1,
            "user",
            json!({"time":{"created":1}, "text":"Build it"}),
        );
        if v2 {
            f.message("msg_b", 2, "compaction", json!({"time":{"created":2_000}}));
        } else {
            f.message("msg_b", 2, "user", json!({"time":{"created":2_000}}));
            f.part(
                "msg_b",
                0,
                json!({"type":"compaction","auto":true,"overflow":false}),
            );
            // Markers of a step and of the files it changed show nothing: the tool cards already say what ran.
            f.message(
                "msg_c",
                3,
                "assistant",
                json!({"time":{"created":3,"completed":4},"finish":"stop"}),
            );
            f.part("msg_c", 1, json!({"type":"step-start"}));
            f.part(
                "msg_c",
                2,
                json!({"type":"patch","hash":"abc","files":["/work/a.rs"]}),
            );
            f.part("msg_c", 3, json!({"type":"step-finish","reason":"stop"}));
        }
        let page = f.page(50);
        let events: Vec<_> = page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "event")
            .map(|message| {
                (
                    message["id"].as_str().unwrap(),
                    message["event"]["kind"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(events, [("msg_b", "compacted")], "v2 {v2}");
        assert!(!page.to_string().contains("/work/a.rs"), "v2 {v2}");
    }
}

#[test]
fn a_v2_database_without_a_part_table_reads_its_inline_parts_and_lists_their_sub_agents() {
    // OpenCode 2.2 has no `session_part`: the parts of a message stay in its `content`, and reminders are user text.
    let f = Fixture::new(true);
    f.db.execute_batch("DROP TABLE session_part").unwrap();
    f.message("msg_a", 1, "user", json!({"text":"question"}));
    f.message("msg_b", 2, "assistant", json!({"content":[
        {"type":"text","text":"working"},
        {"type":"tool","id":"call_1","name":"task","state":{"status":"completed","input":{"description":"Research","subagent_type":"librarian","run_in_background":true},"output":"Background task launched.","metadata":{"backgroundTaskId":"bg_9"},"time":{"start":1_785_941_702_000_i64}}}]}));
    let running = f.page(50);
    assert!(texts(&running).contains(&"working"));
    assert_eq!(running["work"][0]["state"], "running");
    f.message("msg_c", 3, "user", json!({"text":"<system-reminder>\n[BACKGROUND TASK COMPLETED]\n\n**Completed:**\n- `bg_9`: Research\n</system-reminder>"}));
    assert_eq!(f.page(50)["work"][0]["state"], "done");
}

#[test]
fn the_footer_facts_come_from_the_assistant_messages_and_stay_absent_when_unrecorded() {
    for v2 in [true, false] {
        let f = Fixture::new(v2);
        f.message(
            "msg_a",
            1,
            "user",
            json!({"text":"hi","time":{"created":1}}),
        );
        // V2 names the model under `model.id`, V1 as `modelID`; both record the agent, cost and token counts.
        let named = |model: &str, cost: f64, tokens: Value| {
            let mut data = json!({"agent":"plan","cost":cost,"tokens":tokens});
            if v2 {
                data["model"] = json!({"id":model,"providerID":"opencode"});
                data["content"] = json!([]);
            } else {
                data["modelID"] = json!(model);
                data["path"] = json!({"cwd":"/work/app/","root":"/work"});
            }
            data
        };
        f.message(
            "msg_b",
            2,
            "assistant",
            named(
                "big-pickle",
                0.25,
                json!({"input":100,"output":10,"reasoning":5,"cache":{"read":50,"write":3}}),
            ),
        );
        f.message(
            "msg_c",
            3,
            "assistant",
            named(
                "big-pickle",
                0.5,
                json!({"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}),
            ),
        );
        if v2 {
            f.db.execute_batch("ALTER TABLE session_v2 ADD COLUMN directory TEXT; UPDATE session_v2 SET directory='/work/app'").unwrap();
        }
        // The newest reply is still streaming and has no tokens yet: the context in use is the reply before it.
        assert_eq!(
            f.page(50)["session"],
            json!({"model":"big-pickle","mode":"plan","usage":{"usedTokens":168},"cost":{"usd":0.75},"folder":"app"}),
            "v2={v2}"
        );
    }
    // A conversation that records none of it has no `session`, not a zeroed one.
    let f = Fixture::new(true);
    f.message("msg_a", 1, "user", json!({"text":"hi"}));
    f.message("msg_b", 2, "assistant", json!({"content":[]}));
    assert!(f.page(50).get("session").is_none());
}
