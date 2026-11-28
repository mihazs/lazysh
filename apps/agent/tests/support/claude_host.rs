//! A private companion state directory and Claude Code configuration directory driven through the real binary.
//! The including test declares `json_output` and `process` beside it.
use super::{json_output, process};
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, process::Command};

pub const SESSION: &str = "9d5c2c9e-6a38-4a4d-b1c8-3f8f5a1b2c3d";

pub struct Host {
    pub state: tempfile::TempDir,
    pub config: tempfile::TempDir,
}
impl Host {
    pub fn new() -> Self {
        let config = tempfile::tempdir().unwrap();
        fs::create_dir_all(config.path().join("projects/-work")).unwrap();
        Self {
            state: tempfile::tempdir().unwrap(),
            config,
        }
    }
    pub fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
        command
            .args(args)
            .env("LAZYSH_STATE_DIR", self.state.path())
            .env("CLAUDE_CONFIG_DIR", self.config.path());
        command
    }
    pub fn ingest(&self, payload: &Value) {
        let output = process::run(
            &mut self.command(&["ingest", "--agent", "claude"]),
            payload.to_string().as_bytes(),
        );
        assert!(output.status.success(), "{output:?}");
    }
    pub fn hook(&self, name: &str, tool: Option<&str>) {
        let mut payload = json!({"hook_event_name":name,"session_id":SESSION,"cwd":"/work"});
        if let Some(tool) = tool {
            payload["tool_name"] = json!(tool);
        }
        self.ingest(&payload);
    }
    pub fn sessions(&self) -> Value {
        json_output::decode(process::run(&mut self.command(&["snapshot"]), b""))["sessions"].clone()
    }
    pub fn row(&self) -> Value {
        self.sessions()[0].clone()
    }
    pub fn conversation(&self) -> std::path::PathBuf {
        self.config
            .path()
            .join(format!("projects/-work/{SESSION}.jsonl"))
    }
    pub fn append(&self, records: &[Value]) {
        append(&self.conversation(), records);
    }
}
pub fn append(path: &Path, records: &[Value]) {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    for record in records {
        writeln!(file, "{record}").unwrap();
    }
}
pub fn at(offset: Duration) -> String {
    (Utc::now() + offset).to_rfc3339_opts(SecondsFormat::Millis, true)
}
/// A record a sub-agent writes to the conversation file of its parent: not the main thread's.
pub fn sidechain_text(offset: Duration) -> Value {
    json!({"type":"assistant","isSidechain":true,"timestamp":at(offset),
        "message":{"role":"assistant","content":[{"type":"text","text":"working"}]}})
}
pub fn queue_operation(offset: Duration) -> Value {
    json!({"type":"queue-operation","operation":"enqueue","timestamp":at(offset)})
}
/// A main-thread message of the person: the conversation went on.
pub fn carry_on(offset: Duration) -> Value {
    json!({"type":"user","isSidechain":false,"timestamp":at(offset),
        "message":{"role":"user","content":"carry on"}})
}
