//! Sub-agents, background commands and monitors read from a synthetic Claude Code conversation. The record
//! shapes follow the ones Claude Code 2.1.3xx writes (Agent, Bash `run_in_background`, Monitor, TaskStop and
//! `<task-notification>` user records); the file is built here, never copied from a real session.
use lazysh_agent::transcript::{conversation, TranscriptAgent};
use serde_json::{json, Value};
use std::fs;

struct Log(Vec<Value>);
impl Log {
    fn push(&mut self, kind: &str, minute: u32, content: Value) {
        let n = self.0.len();
        self.0.push(json!({
            "uuid":format!("r{n}"),"parentUuid":(n > 0).then(|| format!("r{}", n - 1)),"type":kind,
            "isSidechain":false,"timestamp":format!("2026-11-11T10:{minute:02}:00Z"),
            "message":{"role":kind,"content":content,"id":format!("m{n}")},
        }));
    }
    fn call(&mut self, minute: u32, id: &str, name: &str, input: Value) {
        self.push(
            "assistant",
            minute,
            json!([{"type":"tool_use","id":id,"name":name,"input":input}]),
        );
    }
    fn result(&mut self, minute: u32, id: &str, text: &str, error: bool) {
        self.push("user", minute, json!([{"type":"tool_result","tool_use_id":id,"content":[{"type":"text","text":text}],"is_error":error}]));
    }
    fn notice(&mut self, minute: u32, body: &str) {
        self.push(
            "user",
            minute,
            json!(format!("<task-notification>\n{body}\n</task-notification>")),
        );
    }
    fn turn_end(&mut self, minute: u32, pending: u64) {
        let n = self.0.len();
        self.0.push(json!({"uuid":format!("r{n}"),"parentUuid":format!("r{}", n - 1),"type":"system","subtype":"turn_duration",
            "isSidechain":false,"timestamp":format!("2026-11-11T10:{minute:02}:00Z"),"durationMs":1000,"pendingBackgroundAgentCount":pending}));
    }
    fn page(&self) -> Value {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("c.jsonl");
        fs::write(
            &path,
            self.0.iter().map(|r| format!("{r}\n")).collect::<String>(),
        )
        .unwrap();
        serde_json::to_value(conversation(&path, TranscriptAgent::Claude, 100).unwrap()).unwrap()
    }
    fn activity(&self) -> Value {
        self.page()["activity"].clone()
    }
    fn work(&self) -> Vec<Value> {
        self.page()["work"].as_array().cloned().unwrap_or_default()
    }
}
fn row<'a>(work: &'a [Value], id: &str) -> &'a Value {
    work.iter().find(|task| task["id"] == id).unwrap()
}

#[test]
fn a_sub_agent_runs_until_its_result_and_a_background_one_until_its_notice() {
    let mut log = Log(Vec::new());
    log.push("user", 0, json!("Audit it"));
    log.call(
        1,
        "a1",
        "Agent",
        json!({"description":"Review the diff","subagent_type":"general-purpose"}),
    );
    log.call(
        1,
        "a2",
        "Task",
        json!({"description":"Plan the work","run_in_background":true}),
    );
    log.call(1, "a3", "Agent", json!({"description":"Broken"}));
    let work = log.work();
    assert_eq!(work.len(), 3);
    assert!(work
        .iter()
        .all(|task| task["state"] == "running" && task["kind"] == "agent"));
    assert_eq!(row(&work, "a1")["subtitle"], "general-purpose");

    log.result(3, "a1", "No blockers found.\nSecond line", false);
    log.result(2, "a2", "Async agent launched successfully.\nagentId: a28f3 (internal ID)\nThe agent is working in the background.", false);
    log.result(3, "a3", "Agent crashed", true);
    let work = log.work();
    assert_eq!(row(&work, "a1")["state"], "done");
    assert_eq!(row(&work, "a1")["last"], "No blockers found.");
    assert_eq!(row(&work, "a1")["endedAt"], "2026-11-11T10:03:00Z");
    assert_eq!(
        (
            row(&work, "a2")["state"].clone(),
            row(&work, "a2")["taskId"].clone()
        ),
        (json!("running"), json!("a28f3"))
    );
    assert_eq!(row(&work, "a3")["state"], "failed");

    log.notice(9, "<task-id>a28f3</task-id>\n<status>completed</status>\n<summary>Agent \"Plan the work\" completed</summary>\n<result>Plan is ready\nmore</result>");
    let done = log.work();
    assert_eq!(row(&done, "a2")["state"], "done");
    assert_eq!(row(&done, "a2")["last"], "Plan is ready");
    assert_eq!(
        row(&done, "a2")["summary"],
        "Agent \"Plan the work\" completed"
    );
}

#[test]
fn background_commands_and_monitors_keep_their_events_and_a_stop_ends_them() {
    let mut log = Log(Vec::new());
    log.push("user", 0, json!("Watch CI"));
    log.call(
        1,
        "b1",
        "Bash",
        json!({"command":"sleep 60; echo hi","description":"Wait for CI","run_in_background":true}),
    );
    log.result(
        1,
        "b1",
        "Command running in background with ID: bg1. Output is being written to: /tmp/bg1.output",
        false,
    );
    log.call(
        2,
        "m1",
        "Monitor",
        json!({"description":"PR checks","command":"gh pr checks 1","timeout_ms":600_000}),
    );
    log.result(
        2,
        "m1",
        "Monitor started (task mon1, expires in 10m unless the source ends first).",
        false,
    );
    log.call(2, "f1", "Bash", json!({"command":"ls"}));
    log.result(2, "f1", "a", false);
    log.notice(3, "<task-id>mon1</task-id>\n<summary>Monitor event: \"PR checks\"</summary>\n<event>lint: pass\ntests: pass</event>");
    let work = log.work();
    assert_eq!(work.len(), 2, "a foreground command is not background work");
    assert_eq!(
        (
            row(&work, "b1")["kind"].clone(),
            row(&work, "b1")["state"].clone(),
            row(&work, "b1")["command"].clone()
        ),
        (json!("shell"), json!("running"), json!("sleep 60; echo hi"))
    );
    assert_eq!(
        row(&work, "m1")["events"],
        json!(["lint: pass\ntests: pass"])
    );
    assert_eq!(row(&work, "m1")["last"], "tests: pass");
    assert_eq!(row(&work, "m1")["timeoutMs"], 600_000);

    log.notice(4, "<task-id>bg1</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>\n<summary>Background command \"Wait for CI\" completed (exit code 0)</summary>");
    log.call(5, "s1", "TaskStop", json!({"task_id":"mon1"}));
    log.result(
        5,
        "s1",
        "{\"message\":\"Successfully stopped task: mon1\"}",
        false,
    );
    let work = log.work();
    assert_eq!(row(&work, "b1")["state"], "done");
    assert_eq!(row(&work, "m1")["state"], "stopped");
    assert_eq!(row(&work, "m1")["endedAt"], "2026-11-11T10:05:00Z");
}

#[test]
fn a_failed_stop_a_failed_launch_and_an_unknown_notice_are_not_guessed() {
    let mut log = Log(Vec::new());
    log.push("user", 0, json!("Go"));
    log.call(
        1,
        "b1",
        "Bash",
        json!({"command":"make","run_in_background":true}),
    );
    log.result(1, "b1", "spawn failed", true);
    log.call(1, "m1", "Monitor", json!({"command":"tail -f log"}));
    log.result(1, "m1", "Monitor started (task mon1)", false);
    log.call(2, "s1", "TaskStop", json!({"task_id":"mon1"}));
    log.result(2, "s1", "No such task", true);
    let work = log.work();
    assert_eq!(row(&work, "b1")["state"], "failed");
    assert_eq!(row(&work, "b1")["title"], "make");
    assert_eq!(row(&work, "m1")["state"], "running");
    log.notice(3, "<task-id>mon1</task-id>\n<status>timed_out</status>");
    assert_eq!(row(&log.work(), "m1")["state"], "unknown");
    // A notice for a task the conversation never started changes nothing.
    log.notice(4, "<task-id>nope</task-id>\n<status>completed</status>");
    assert_eq!(log.work().len(), 2);
}

#[test]
fn a_conversation_without_background_work_reports_none() {
    let mut log = Log(Vec::new());
    log.push("user", 0, json!("Hi"));
    log.push("assistant", 1, json!([{"type":"text","text":"Hello"}]));
    assert!(log.work().is_empty());
}

#[test]
fn a_finished_turn_with_a_running_background_agent_is_still_working() {
    let mut log = Log(Vec::new());
    log.push("user", 0, json!("Go"));
    log.push(
        "assistant",
        1,
        json!([{"type":"text","text":"Started it."}]),
    );
    log.turn_end(2, 1);
    assert_eq!(log.activity(), "working");
    let mut idle = Log(log.0[..2].to_vec());
    idle.turn_end(2, 0);
    assert_eq!(idle.activity(), "idle");
}

fn side(n: usize, kind: &str, content: Value) -> Value {
    json!({"uuid":format!("c{n}"),"parentUuid":(n > 0).then(|| format!("c{}", n - 1)),"type":kind,"isSidechain":true,
        "agentId":"a1b2","timestamp":format!("2026-11-11T10:{:02}:00Z", n + 2),"message":{"role":kind,"content":content,"id":format!("cm{n}")}})
}

#[test]
fn a_sub_agent_with_its_own_files_gets_its_conversation_and_a_finished_state() {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().join("sess.jsonl");
    let mut log = Log(Vec::new());
    log.push("user", 0, json!("Audit it"));
    log.call(1, "a1", "Agent", json!({"description":"Review the diff"}));
    log.call(1, "a2", "Agent", json!({"description":"Still going"}));
    log.call(1, "a3", "Agent", json!({"description":"No files"}));
    fs::write(
        &parent,
        log.0.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    let folder = directory.path().join("sess/subagents");
    fs::create_dir_all(&folder).unwrap();
    let child: Vec<Value> = vec![
        side(0, "user", json!("Review the diff")),
        side(
            1,
            "assistant",
            json!([{"type":"text","text":"Reading files.\nNo blockers."}]),
        ),
    ];
    fs::write(
        folder.join("agent-a1b2.jsonl"),
        child.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    fs::write(
        folder.join("agent-a1b2.meta.json"),
        json!({"toolUseId":"a1","parentAgentId":null,"finished":true}).to_string(),
    )
    .unwrap();
    fs::write(folder.join("agent-c3d4.jsonl"), "{}\n").unwrap();
    fs::write(
        folder.join("agent-c3d4.meta.json"),
        json!({"toolUseId":"a2","finished":false}).to_string(),
    )
    .unwrap();
    // A meta file with an id that is not a plain identifier, and one that is not JSON, are ignored.
    fs::write(
        folder.join("agent-..%2Fx.meta.json"),
        json!({"toolUseId":"a3","finished":true}).to_string(),
    )
    .unwrap();
    fs::write(folder.join("agent-zzzz.meta.json"), "not json").unwrap();

    let work = serde_json::to_value(conversation(&parent, TranscriptAgent::Claude, 100).unwrap())
        .unwrap()["work"]
        .as_array()
        .unwrap()
        .clone();
    let first = row(&work, "a1");
    assert_eq!(
        (
            first["state"].clone(),
            first["taskId"].clone(),
            first["last"].clone()
        ),
        (json!("done"), json!("a1b2"), json!("Reading files."))
    );
    let path = first["childPath"].as_str().unwrap();
    assert_eq!(path, folder.join("agent-a1b2.jsonl").to_str().unwrap());
    assert_eq!(row(&work, "a2")["state"], "running");
    assert!(row(&work, "a2").get("childPath").is_some());
    assert!(row(&work, "a3").get("childPath").is_none());

    // The child file read on its own is a conversation, although every record is a sidechain record.
    let page = conversation(std::path::Path::new(path), TranscriptAgent::Claude, 100).unwrap();
    let roles: Vec<_> = page
        .messages
        .iter()
        .map(|m| m["role"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(roles, ["user", "assistant"]);
    assert_eq!(page.messages[0]["blocks"][0]["text"], "Review the diff");
}
