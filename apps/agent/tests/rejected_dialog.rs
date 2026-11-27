//! A permission dialog the person rejects in Claude Code sends no hook (#1795); the snapshot settles the row from the
//! conversation file. The records have the shapes Claude Code 2.1.3xx writes for a rejected tool call: the assistant
//! `tool_use`, a `tool_result` with `is_error` and `toolUseResult: "User rejected tool use"`, then the interruption marker.
#[path = "support/json_output.rs"]
mod json_output;
#[path = "support/process.rs"]
mod process;
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, process::Command};

const SESSION: &str = "9d5c2c9e-6a38-4a4d-b1c8-3f8f5a1b2c3d";

struct Host {
    state: tempfile::TempDir,
    config: tempfile::TempDir,
}
impl Host {
    fn new() -> Self {
        let config = tempfile::tempdir().unwrap();
        fs::create_dir_all(config.path().join("projects/-work")).unwrap();
        Self {
            state: tempfile::tempdir().unwrap(),
            config,
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
        command
            .args(args)
            .env("LAZYSH_STATE_DIR", self.state.path())
            .env("CLAUDE_CONFIG_DIR", self.config.path());
        command
    }
    fn ingest(&self, payload: &Value) {
        let output = process::run(
            &mut self.command(&["ingest", "--agent", "claude"]),
            payload.to_string().as_bytes(),
        );
        assert!(output.status.success(), "{output:?}");
    }
    fn hook(&self, name: &str, tool: Option<&str>) {
        let mut payload = json!({"hook_event_name":name,"session_id":SESSION,"cwd":"/work"});
        if let Some(tool) = tool {
            payload["tool_name"] = json!(tool);
        }
        self.ingest(&payload);
    }
    fn sessions(&self) -> Value {
        json_output::decode(process::run(&mut self.command(&["snapshot"]), b""))["sessions"].clone()
    }
    fn row(&self) -> Value {
        self.sessions()[0].clone()
    }
    fn conversation(&self) -> std::path::PathBuf {
        self.config
            .path()
            .join(format!("projects/-work/{SESSION}.jsonl"))
    }
    fn append(&self, records: &[Value]) {
        append(&self.conversation(), records);
    }
}
fn append(path: &Path, records: &[Value]) {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    for record in records {
        writeln!(file, "{record}").unwrap();
    }
}
fn at(offset: Duration) -> String {
    (Utc::now() + offset).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn asks(tool: &str, offset: Duration) -> Value {
    json!({"type":"assistant","isSidechain":false,"timestamp":at(offset),"sessionId":SESSION,
        "message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"toolu_1","name":tool,"input":{}}]}})
}
fn rejection() -> [Value; 2] {
    [
        json!({"type":"user","isSidechain":false,"timestamp":at(Duration::zero()),"sessionId":SESSION,
            "toolUseResult":"User rejected tool use",
            "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":true,
                "content":"The user doesn't want to proceed with this tool use. The tool use was rejected."}]}}),
        json!({"type":"user","isSidechain":false,"timestamp":at(Duration::zero()),"sessionId":SESSION,
            "message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}),
    ]
}

#[test]
fn a_rejected_dialog_stops_the_row_waiting_and_the_next_prompt_moves_it_on() {
    for (tool, wait) in [
        ("Write", "approval"),
        ("AskUserQuestion", "question"),
        ("ExitPlanMode", "plan"),
    ] {
        let host = Host::new();
        host.hook("PermissionRequest", Some(tool));
        host.append(&[asks(tool, Duration::seconds(-1))]);
        let waiting = host.row();
        assert_eq!(
            (waiting["state"].as_str(), waiting["waiting"].as_str()),
            (Some("needs_attention"), Some(wait))
        );

        // The dialog is still open: nothing was said after the request, however often the snapshot is read.
        assert_eq!(host.row()["state"], "needs_attention", "{tool}");

        host.append(&rejection());
        let settled = host.row();
        assert_eq!(settled["state"], "done", "{tool}");
        assert_eq!(settled["summary"], "Turn interrupted");
        assert!(settled.get("waiting").is_none() && settled.get("waitingSince").is_none());
        assert_eq!(settled["paneId"], waiting["paneId"]);
        assert_eq!(
            host.row()["eventCount"],
            settled["eventCount"],
            "settled once"
        );

        host.hook("UserPromptSubmit", None);
        assert_eq!(host.row()["state"], "working");
    }
}

#[test]
fn only_a_rejection_after_the_wait_began_and_with_nothing_said_since_settles_it() {
    let host = Host::new();
    // An earlier turn's rejection, then a new dialog the conversation file has not recorded yet.
    let mut earlier = rejection();
    for record in &mut earlier {
        record["timestamp"] = json!(at(Duration::seconds(-60)));
    }
    host.append(&earlier);
    host.hook("PermissionRequest", Some("Write"));
    assert_eq!(host.row()["state"], "needs_attention");

    // The model asked again after the rejection that came before the request.
    host.append(&[asks("Write", Duration::zero())]);
    assert_eq!(host.row()["state"], "needs_attention");

    // A message after the rejection means the conversation went on, so no dialog is rejected.
    host.append(&rejection());
    host.append(&[
        json!({"type":"user","isSidechain":false,"timestamp":at(Duration::zero()),
        "message":{"role":"user","content":"carry on"}}),
    ]);
    assert_eq!(host.row()["state"], "needs_attention");
}

#[test]
fn a_sub_agents_own_records_and_other_record_types_do_not_hide_the_rejection() {
    let host = Host::new();
    host.hook("PermissionRequest", Some("Bash"));
    host.append(&[asks("Bash", Duration::seconds(-1))]);
    host.append(&rejection());
    host.append(&[
        json!({"type":"assistant","isSidechain":true,"timestamp":at(Duration::zero()),
            "message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}),
        json!({"type":"queue-operation","operation":"enqueue","timestamp":at(Duration::zero())}),
        json!({"type":"system","subtype":"turn_duration","timestamp":at(Duration::zero())}),
    ]);
    assert_eq!(host.row()["state"], "done");
}

#[test]
fn reads_the_end_of_a_long_conversation_file() {
    let host = Host::new();
    host.hook("PermissionRequest", Some("Write"));
    let filler = "x".repeat(8 * 1024);
    let long: Vec<Value> = (0..40)
        .map(|index| json!({"type":"assistant","isSidechain":false,"timestamp":at(Duration::seconds(-1)),
            "message":{"role":"assistant","content":[{"type":"text","text":format!("{index} {filler}")}]}}))
        .collect();
    host.append(&long);
    host.append(&[asks("Write", Duration::seconds(-1))]);
    assert!(fs::metadata(host.conversation()).unwrap().len() > 256 * 1024);
    assert_eq!(host.row()["state"], "needs_attention");
    host.append(&rejection());
    assert_eq!(host.row()["state"], "done");
}

#[test]
fn a_row_without_a_conversation_file_keeps_waiting() {
    let host = Host::new();
    host.hook("PermissionRequest", Some("Write"));
    // The companion cannot tell, so the row stays as the hooks left it.
    assert_eq!(host.row()["state"], "needs_attention");
}

#[test]
fn a_session_id_never_leaves_the_projects_directory() {
    let host = Host::new();
    let payload = json!({"hook_event_name":"PermissionRequest","session_id":"../../escape","cwd":"/work","tool_name":"Write"});
    host.ingest(&payload);
    // `projects/-work/../../escape.jsonl` is this file, with a rejection newer than the request.
    append(&host.config.path().join("escape.jsonl"), &rejection());
    assert_eq!(host.row()["state"], "needs_attention");
}

#[test]
fn incomplete_trailing_record_cannot_settle_an_earlier_rejection() {
    let host = Host::new();
    host.hook("PermissionRequest", Some("Write"));
    host.append(&rejection());
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(host.conversation())
        .unwrap();
    write!(file, "{{\"type\":\"user\",\"message\":").unwrap();
    file.flush().unwrap();
    assert_eq!(host.row()["state"], "needs_attention");
    writeln!(file, "{{\"role\":\"user\",\"content\":\"carry on\"}}}}").unwrap();
    file.flush().unwrap();
    assert_eq!(host.row()["state"], "needs_attention");
    host.append(&rejection());
    assert_eq!(host.row()["state"], "done");
}

fn interruption(offset: Duration, sidechain: bool) -> Value {
    json!({"type":"user","isSidechain":sidechain,"timestamp":at(offset),"sessionId":SESSION,
        "message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}})
}

// Esc on a running turn sends no hook either (#1956).
#[test]
fn an_interrupted_turn_stops_the_row_working_and_the_next_prompt_moves_it_on() {
    let host = Host::new();
    host.hook("UserPromptSubmit", None);
    host.append(&[asks("Bash", Duration::zero())]);
    assert_eq!(host.row()["state"], "working");

    host.append(&[interruption(Duration::zero(), false)]);
    let settled = host.row();
    assert_eq!(settled["state"], "done");
    assert_eq!(settled["summary"], "Turn interrupted");
    assert_eq!(
        host.row()["eventCount"],
        settled["eventCount"],
        "settled once"
    );

    host.hook("UserPromptSubmit", None);
    assert_eq!(host.row()["state"], "working");
}

#[test]
fn a_working_row_is_settled_only_by_a_main_thread_marker_newer_than_its_last_report() {
    let host = Host::new();
    host.append(&[interruption(Duration::seconds(-60), false)]);
    host.hook("UserPromptSubmit", None);
    // The marker is older than the last report: an earlier turn's interruption.
    assert_eq!(host.row()["state"], "working");

    // A sub-agent's interruption is not the main turn's.
    host.append(&[interruption(Duration::zero(), true)]);
    assert_eq!(host.row()["state"], "working");

    // The conversation went on after the marker: a turn is running.
    host.append(&[
        interruption(Duration::zero(), false),
        asks("Bash", Duration::zero()),
    ]);
    assert_eq!(host.row()["state"], "working");
}
