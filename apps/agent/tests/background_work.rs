//! A turn that ended is not a finished session (#2956): the snapshot reads Claude Code's own session registry and the
//! `turn_duration` record of the conversation and keeps a row the hooks left `done` at `working` while a background shell,
//! monitor, sub-agent or workflow runs. The registry and record shapes are those of Claude Code 2.1.326, with no text.
// Windows never believes a registry file (no process start time to compare), so there is nothing to observe there.
#![cfg(unix)]
#[path = "support/claude_host.rs"]
mod claude_host;
#[path = "support/json_output.rs"]
mod json_output;
#[path = "support/process.rs"]
mod process;
use chrono::{Duration, Utc};
use claude_host::{at, carry_on, queue_operation, sidechain_text, Host, SESSION};
use lazysh_agent::background::holds_done;
use serde_json::{json, Value};
use std::fs;

/// The start time Claude Code records for the process: field 22 of `/proc/<pid>/stat` on Linux.
fn proc_start(pid: u32) -> String {
    fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            Some(
                stat.rsplit_once(") ")?
                    .1
                    .split_whitespace()
                    .nth(19)?
                    .to_owned(),
            )
        })
        .unwrap_or_else(|| "0".into())
}
/// A process that has ended: its registry file outlives it when the agent is killed.
fn dead_pid() -> u32 {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

impl Host {
    /// One `<config>/sessions/<pid>.json` as Claude Code writes it.
    fn register(&self, pid: u32, session: &str, status: &str, status_at: Duration) {
        let directory = self.config.path().join("sessions");
        fs::create_dir_all(&directory).unwrap();
        let millis = (Utc::now() + status_at).timestamp_millis();
        let record = json!({"pid":pid,"sessionId":session,"cwd":"/work","startedAt":millis - 60_000,
            "procStart":proc_start(pid),"version":"2.1.326","kind":"interactive","entrypoint":"cli",
            "status":status,"updatedAt":millis,"statusUpdatedAt":millis});
        fs::write(directory.join(format!("{pid}.json")), record.to_string()).unwrap();
    }
    /// The `turn_duration` record Claude Code writes after a turn's `Stop` hooks; a count of zero is absent.
    fn turn_ended(&self, agents: u64, workflows: u64, age: Duration) {
        let mut record = json!({"type":"system","subtype":"turn_duration","durationMs":4072,"messageCount":12,
            "isSidechain":false,"isMeta":false,"userType":"external","entrypoint":"cli","version":"2.1.326",
            "timestamp":at(-age)});
        for (key, count) in [
            ("pendingBackgroundAgentCount", agents),
            ("pendingWorkflowCount", workflows),
        ] {
            if count > 0 {
                record[key] = json!(count);
            }
        }
        self.append(&[record]);
    }
    /// A turn that ended with `agents` background sub-agents running, in an idle session whose process lives.
    fn idle_with_agents(agents: u64, age: Duration) -> Self {
        let host = Self::new();
        host.finished_turn();
        host.register(std::process::id(), SESSION, "idle", Duration::seconds(-30));
        host.turn_ended(agents, 0, age);
        host
    }
    fn finished_turn(&self) -> Value {
        self.hook("Stop", None);
        let row = self.row();
        assert_eq!(
            (row["state"].as_str(), row["summary"].as_str()),
            (Some("done"), Some("Turn finished"))
        );
        row
    }
}

mod live_process {
    use super::*;

    #[test]
    fn a_background_shell_or_monitor_keeps_the_row_working_until_it_ends() {
        let host = Host::new();
        let stored = host.finished_turn();
        host.register(std::process::id(), SESSION, "shell", Duration::seconds(-30));
        host.turn_ended(0, 0, Duration::seconds(30));
        let row = host.row();
        assert_eq!(row["state"], "working");
        assert_eq!(row["summary"], "Working in the background");
        assert_eq!(row["background"], json!({"shells": 1}));
        // The overlay is read, not stored: no report was written for it.
        assert_eq!(row["eventCount"], stored["eventCount"]);

        // The shell ended: the registry says idle again and the row is what the hooks said.
        host.register(std::process::id(), SESSION, "idle", Duration::seconds(-1));
        let row = host.row();
        assert_eq!(
            (row["state"].as_str(), row["summary"].as_str()),
            (Some("done"), Some("Turn finished"))
        );
        assert!(row.get("background").is_none());
    }

    #[test]
    fn sub_agents_and_workflows_the_turn_left_running_are_counted_and_end_with_the_next_turn() {
        let host = Host::new();
        host.finished_turn();
        host.register(std::process::id(), SESSION, "idle", Duration::seconds(-30));
        host.turn_ended(2, 1, Duration::seconds(30));
        let row = host.row();
        assert_eq!(row["state"], "working");
        assert_eq!(row["background"], json!({"agents": 2, "workflows": 1}));

        // The agents finished, the agent woke and ended a new turn: the count is gone.
        host.turn_ended(0, 0, Duration::zero());
        assert_eq!(host.row()["state"], "done");
    }

    #[test]
    fn shells_and_agents_add_up() {
        let host = Host::new();
        host.finished_turn();
        host.register(std::process::id(), SESSION, "shell", Duration::seconds(-30));
        host.turn_ended(3, 0, Duration::seconds(30));
        assert_eq!(host.row()["background"], json!({"agents": 3, "shells": 1}));
    }

    #[test]
    fn a_count_that_a_later_turn_may_have_changed_or_that_is_too_old_is_not_believed() {
        let host = Host::idle_with_agents(2, Duration::hours(25));
        assert_eq!(host.row()["state"], "done", "older than a day");

        let host = Host::idle_with_agents(2, Duration::seconds(30));
        host.append(&[carry_on(Duration::zero())]);
        assert_eq!(
            host.row()["state"],
            "done",
            "a turn runs again: the count says nothing"
        );

        // A sub-agent's own records and other record kinds after the count change nothing.
        let host = Host::idle_with_agents(2, Duration::seconds(30));
        host.append(&[
            sidechain_text(Duration::zero()),
            json!({"type":"system","subtype":"away_summary","isSidechain":false,"timestamp":at(Duration::zero())}),
            queue_operation(Duration::zero()),
        ]);
        assert_eq!(host.row()["background"], json!({"agents": 2}));
    }

    #[test]
    fn a_turn_a_finished_task_resumed_reads_working_before_any_hook_reports_it() {
        let host = Host::new();
        host.finished_turn();
        // The agent started a turn after the last report: its hooks come only at the first tool call or `Stop`.
        host.register(std::process::id(), SESSION, "busy", Duration::seconds(5));
        let row = host.row();
        assert_eq!(
            (row["state"].as_str(), row["summary"].as_str()),
            (Some("working"), Some("Turn resumed"))
        );
        assert!(row.get("background").is_none());

        // Busy since before the last report is the turn that report ended.
        host.register(std::process::id(), SESSION, "busy", Duration::seconds(-30));
        assert_eq!(host.row()["state"], "done");
        host.register(std::process::id(), SESSION, "waiting", Duration::seconds(5));
        assert_eq!(host.row()["state"], "done");
    }

    #[test]
    fn only_the_hook_state_of_a_finished_claude_code_turn_is_overlaid() {
        let host = Host::new();
        host.register(std::process::id(), SESSION, "shell", Duration::seconds(-30));
        host.turn_ended(2, 0, Duration::seconds(30));
        host.hook("SessionEnd", None);
        let row = host.row();
        assert_eq!(
            (row["state"].as_str(), row["summary"].as_str()),
            (Some("done"), Some("Session ended"))
        );

        host.hook("PermissionRequest", Some("Write"));
        assert_eq!(host.row()["state"], "needs_attention");
        host.hook("UserPromptSubmit", None);
        let row = host.row();
        assert_eq!(
            (row["state"].as_str(), row["summary"].as_str()),
            (Some("working"), Some("Working on your prompt"))
        );
        assert!(row.get("background").is_none());

        let output = process::run(
            &mut host.command(&["ingest", "--agent", "codex"]),
            json!({"hook_event_name":"Stop","session_id":SESSION,"cwd":"/work"})
                .to_string()
                .as_bytes(),
        );
        assert!(output.status.success());
        let rows = host.sessions();
        let codex = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["agent"] == "Codex")
            .unwrap();
        assert_eq!(codex["state"], "done");
    }

    #[test]
    fn the_done_push_of_a_session_is_held_exactly_while_it_still_works() {
        let host = Host::new();
        host.finished_turn();
        let reported = Utc::now() - Duration::seconds(1);
        let held = || holds_done(host.config.path(), SESSION, reported, Utc::now());
        assert!(!held(), "nothing is known");

        host.register(std::process::id(), SESSION, "shell", Duration::seconds(-30));
        host.turn_ended(0, 0, Duration::seconds(30));
        assert!(held(), "a shell or monitor runs");
        host.register(std::process::id(), SESSION, "idle", Duration::seconds(-1));
        assert!(!held(), "it ended");

        host.turn_ended(2, 0, Duration::zero());
        assert!(held(), "sub-agents run");
        host.turn_ended(0, 0, Duration::zero());
        assert!(!held(), "a later turn ended without them");

        host.register(std::process::id(), SESSION, "busy", Duration::seconds(5));
        assert!(held(), "a turn started after the report");
        host.register(std::process::id(), SESSION, "busy", Duration::seconds(-30));
        assert!(!held(), "the turn the report ended");
    }

    #[test]
    fn a_torn_or_foreign_registry_file_proves_nothing() {
        let host = Host::new();
        host.finished_turn();
        let directory = host.config.path().join("sessions");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{}.json", std::process::id())),
            "{\"pid\":1,\"sessionId\":\"9d5c",
        )
        .unwrap();
        fs::write(directory.join("notes.json"), "{}").unwrap();
        host.register(
            std::process::id() + 1,
            "another-session",
            "shell",
            Duration::seconds(-30),
        );
        assert_eq!(host.row()["state"], "done");
    }
}

#[test]
fn a_process_that_is_gone_leaves_no_background_work_behind() {
    let host = Host::new();
    host.finished_turn();
    host.register(dead_pid(), SESSION, "shell", Duration::seconds(-30));
    host.turn_ended(2, 1, Duration::seconds(30));
    let row = host.row();
    assert_eq!(row["state"], "done");
    assert!(row.get("background").is_none());
}

#[test]
fn without_a_registry_only_a_recent_count_is_believed() {
    let host = Host::new();
    host.finished_turn();
    host.turn_ended(2, 0, Duration::minutes(5));
    assert_eq!(host.row()["background"], json!({"agents": 2}));

    let host = Host::new();
    host.finished_turn();
    host.turn_ended(2, 0, Duration::minutes(16));
    assert_eq!(
        host.row()["state"],
        "done",
        "nothing proves the agent still lives"
    );
}

#[test]
fn a_row_without_a_registry_entry_or_a_conversation_keeps_the_hook_state() {
    let host = Host::new();
    host.finished_turn();
    assert_eq!(host.row()["state"], "done");
    host.register(
        std::process::id() + 1,
        "another-session",
        "shell",
        Duration::seconds(-30),
    );
    assert_eq!(host.row()["state"], "done");
}
