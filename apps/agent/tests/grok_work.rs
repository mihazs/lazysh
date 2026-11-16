//! Grok Build work records (sub-agents, background jobs, edits) read from a session file.
//! The records follow the shapes the official writer serializes (`fixtures/grok-acp/README.md`); no Grok CLI ran.
use lazysh_agent::transcript::{conversation, TranscriptAgent};
use serde_json::{json, Value};
#[path = "support/jsonl.rs"]
mod jsonl;

const FIXTURE: &str = include_str!("fixtures/grok-acp/work.jsonl");

fn record(method: &str, update: Value) -> Value {
    json!({"timestamp":1001,"method":method,"params":{"sessionId":"synthetic-work","update":update}})
}
fn xai(tag: &str, mut update: Value) -> Value {
    update["sessionUpdate"] = json!(tag);
    record("_x.ai/session/update", update)
}
fn acp(tag: &str, mut update: Value) -> Value {
    update["sessionUpdate"] = json!(tag);
    record("session/update", update)
}
fn read(records: &[Value]) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    jsonl::write(&path, records);
    serde_json::to_value(conversation(&path, TranscriptAgent::GrokAcp, 100).unwrap()).unwrap()
}
fn fixture() -> Vec<Value> {
    FIXTURE
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn rows(page: &Value) -> Vec<(&str, &str, &str)> {
    page["work"].as_array().map_or(Vec::new(), |work| {
        work.iter()
            .map(|row| {
                (
                    row["id"].as_str().unwrap(),
                    row["kind"].as_str().unwrap(),
                    row["state"].as_str().unwrap(),
                )
            })
            .collect()
    })
}
fn tool_blocks(page: &Value) -> Vec<&Value> {
    let blocks = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["blocks"].as_array().unwrap());
    blocks
        .filter(|block| matches!(block["type"].as_str(), Some("tool_use" | "tool_result")))
        .collect()
}

#[test]
fn a_recorded_session_fills_the_work_panel_and_shows_the_edit_as_a_diff() {
    let page = read(&fixture());
    let work = page["work"].as_array().unwrap();
    assert_eq!(work.len(), 2);
    assert_eq!(
        work[0],
        json!({"id":"sub-1","kind":"agent","title":"Map the module layout","subtitle":"explore","taskId":"sub-1","state":"done",
            "events":[],"startedAt":"1970-01-01T00:16:41Z","endedAt":"1970-01-01T00:16:45Z","last":"The module has three layers.",
            "tokens":1500,"durationMs":4200})
    );
    assert_eq!(
        work[1],
        json!({"id":"bg-1","kind":"shell","title":"Start the dev server","command":"npm run dev","taskId":"bg-1","state":"done",
            "events":[],"startedAt":"1970-01-01T00:16:42Z","endedAt":"1970-01-01T00:16:46Z","last":"stopped"})
    );
    // The control records add no message: the prompt, the edit and the answer.
    assert_eq!(page["messages"].as_array().unwrap().len(), 3);
    let calls = tool_blocks(&page);
    assert_eq!(calls.len(), 1, "the diff is the card, not also an output");
    assert_eq!(calls[0]["name"], "edit");
    assert_eq!(calls[0]["status"], "completed");
    assert_eq!(
        serde_json::from_str::<Value>(calls[0]["text"].as_str().unwrap()).unwrap(),
        json!({"file_path":"/not-opened/project/src/lib.rs","old_string":"let total = a + b;","new_string":"let total = a + b + c;"})
    );
}

#[test]
fn every_end_is_read_from_its_record_and_a_launch_with_no_end_stays_running() {
    let finished = |status: &str, more: Value| {
        let mut update = json!({"subagent_id":"s","status":status});
        update
            .as_object_mut()
            .unwrap()
            .extend(more.as_object().unwrap().clone());
        update
    };
    let ended = |snapshot: Value| {
        let mut full = json!({"task_id":"t","completed":true});
        full.as_object_mut()
            .unwrap()
            .extend(snapshot.as_object().unwrap().clone());
        json!({"task_snapshot":full})
    };
    let agent = |end: Option<Value>| {
        let mut records = vec![xai(
            "subagent_spawned",
            json!({"subagent_id":"s","description":"d"}),
        )];
        records.extend(end.map(|update| xai("subagent_finished", update)));
        rows(&read(&records))
            .iter()
            .map(|row| row.2.to_owned())
            .collect::<Vec<_>>()
    };
    let job = |end: Option<Value>| {
        let mut records = vec![xai(
            "task_backgrounded",
            json!({"task_id":"t","command":"make"}),
        )];
        records.extend(end.map(|update| xai("task_completed", update)));
        rows(&read(&records))
            .iter()
            .map(|row| row.2.to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(agent(None), ["running"]);
    assert_eq!(agent(Some(finished("completed", json!({})))), ["done"]);
    assert_eq!(
        agent(Some(finished("failed", json!({"error":"out of budget"})))),
        ["failed"]
    );
    assert_eq!(agent(Some(finished("cancelled", json!({})))), ["stopped"]);
    assert_eq!(agent(Some(finished("paused", json!({})))), ["running"]);
    assert_eq!(job(None), ["running"]);
    assert_eq!(job(Some(ended(json!({"exit_code":0})))), ["done"]);
    assert_eq!(job(Some(ended(json!({})))), ["done"]);
    assert_eq!(job(Some(ended(json!({"exit_code":2})))), ["failed"]);
    assert_eq!(job(Some(ended(json!({"signal":"SIGTERM"})))), ["failed"]);
    assert_eq!(
        job(Some(ended(
            json!({"explicitly_killed":true,"signal":"SIGKILL"})
        ))),
        ["stopped"]
    );
    assert_eq!(
        job(Some(ended(json!({"signal":"session_restart"})))),
        ["unknown"]
    );
    assert_eq!(job(Some(ended(json!({"completed":false})))), ["running"]);
    let failed = read(&[
        xai(
            "subagent_spawned",
            json!({"subagent_id":"s","description":"d"}),
        ),
        xai(
            "subagent_finished",
            finished(
                "failed",
                json!({"error":"out of budget","output":"ignored"}),
            ),
        ),
    ]);
    assert_eq!(failed["work"][0]["last"], "out of budget");
}

#[test]
fn a_monitor_is_a_monitor_and_a_command_without_a_description_is_titled_by_its_command() {
    let page = read(&[
        xai(
            "task_backgrounded",
            json!({"task_id":"m","command":"tail -f log","monitor_description":"Watch the log"}),
        ),
        xai(
            "task_backgrounded",
            json!({"task_id":"c","command":"\n  cargo build --release\nsecond line"}),
        ),
    ]);
    assert_eq!(
        rows(&page),
        [("m", "monitor", "running"), ("c", "shell", "running")]
    );
    assert_eq!(page["work"][0]["title"], "Watch the log");
    assert_eq!(page["work"][1]["title"], "cargo build --release");
}

#[test]
fn an_unknown_end_and_a_record_of_another_shape_change_nothing_and_do_not_fail_the_conversation() {
    let page = read(&[
        acp(
            "agent_message_chunk",
            json!({"content":{"type":"text","text":"Hello"}}),
        ),
        xai(
            "subagent_finished",
            json!({"subagent_id":"never-seen","status":"completed"}),
        ),
        xai(
            "task_completed",
            json!({"task_snapshot":{"task_id":"never-seen","completed":true,"exit_code":0}}),
        ),
        xai(
            "subagent_spawned",
            json!({"subagent_id":7,"description":"wrong type"}),
        ),
        xai("task_backgrounded", json!({"command":"no id"})),
        xai("task_completed", json!({"task_snapshot":"not a snapshot"})),
        xai(
            "monitor_event",
            json!({"task_id":"m","description":"d","event_text":"line"}),
        ),
        xai("background_tasks", json!({"tasks":[],"truncated":false})),
    ]);
    assert!(page["work"].is_null());
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn a_rewind_drops_the_work_of_the_turns_it_abandons() {
    let prompt = |index: u64| {
        acp(
            "user_message_chunk",
            json!({"content":{"type":"text","text":"go"},"_meta":{"promptIndex":index}}),
        )
    };
    let page = read(&[
        prompt(0),
        xai(
            "subagent_spawned",
            json!({"subagent_id":"kept","description":"first turn"}),
        ),
        prompt(1),
        xai(
            "subagent_spawned",
            json!({"subagent_id":"abandoned","description":"second turn"}),
        ),
        xai(
            "rewind_marker",
            json!({"target_prompt_index":1,"created_at":"1970-01-01T00:00:09Z"}),
        ),
        xai(
            "subagent_finished",
            json!({"subagent_id":"kept","status":"completed"}),
        ),
    ]);
    assert_eq!(rows(&page), [("kept", "agent", "done")]);
}

#[test]
fn an_edit_is_the_diff_card_only_when_it_completed_as_exactly_one_diff() {
    let diff = |old: Value| json!({"type":"diff","path":"/p/a.rs","oldText":old,"newText":"new"});
    let text =
        json!({"type":"content","content":{"type":"text","text":"No match for the old string"}});
    let call = |kind: &str, status: &str, content: Value| {
        let page = read(&[
            acp(
                "tool_call",
                json!({"toolCallId":"e","title":"Edit `a.rs`","kind":kind,"rawInput":{"file_path":"a.rs"},"status":"pending"}),
            ),
            acp(
                "tool_call_update",
                json!({"toolCallId":"e","status":status,"content":content}),
            ),
        ]);
        let blocks = tool_blocks(&page);
        (
            blocks[0]["name"].as_str().unwrap().to_owned(),
            blocks.len(),
            blocks[0]["text"].as_str().unwrap().to_owned(),
        )
    };
    let (name, blocks, input) = call("edit", "completed", json!([diff(Value::Null)]));
    assert_eq!((name.as_str(), blocks), ("edit", 1));
    assert_eq!(
        serde_json::from_str::<Value>(&input).unwrap(),
        json!({"file_path":"/p/a.rs","old_string":"","new_string":"new"}),
        "a diff with no old text is a new file"
    );
    // Anything else keeps the recorded title and its own input, and a failed edit its recorded error as the output.
    let ordinary = (r#"{"file_path":"a.rs"}"#.to_owned(), "Edit `a.rs`");
    for (kind, status, content) in [
        ("edit", "failed", json!([text])),
        ("edit", "failed", json!([diff(json!("old"))])),
        ("edit", "in_progress", json!([diff(json!("old"))])),
        (
            "edit",
            "completed",
            json!([diff(json!("old")), diff(json!("old"))]),
        ),
        ("edit", "completed", json!([diff(json!(5))])),
        ("edit", "completed", json!([text])),
        ("delete", "completed", json!([diff(json!("old"))])),
        ("teleport", "completed", json!([diff(json!("old"))])),
    ] {
        let (name, _, input) = call(kind, status, content);
        assert_eq!((input, name.as_str()), ordinary, "{kind} {status}");
    }
    assert_eq!(
        call("edit", "failed", json!([text])).1,
        2,
        "a failed edit keeps its recorded error"
    );
}
