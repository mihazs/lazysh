//! A turn that ended is not a session that finished: Claude Code keeps background shells, monitors, sub-agents and
//! workflows running after `Stop` (#2956). The hooks cannot say so (none fires when a shell or a monitor ends), so the
//! snapshot reads the agent's own records and overlays `working` on a row the hooks left `done`.
//!
//! Evidence, all written by Claude Code 2.1.326:
//! - the session registry `<config>/sessions/<pid>.json`: `status` is `busy`, `waiting`, `idle` or `shell`, and `shell`
//!   is idle with a background shell or monitor that has not finished. It counts only while its process lives
//!   (`procStart` against the live process), so a killed agent leaves nothing behind;
//! - the last `turn_duration` record of the conversation: `pendingBackgroundAgentCount` and `pendingWorkflowCount`, the
//!   agent's own count of sub-agents and workflows still running when the turn ended.
//!
//! The stored hook state is never rewritten: when the evidence is gone the row is what the hooks said.
use crate::{
    rejected_dialog::{claude_config_dir, conversation, read_tail},
    SessionState, Snapshot,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, io::Read, path::Path};

const AGENT: &str = "Claude Code";
/// What the conversation tail must hold to find the last `turn_duration`.
const TAIL: u64 = 256 * 1024;
const MAX_ENTRIES: usize = 512;
const MAX_ENTRY_BYTES: u64 = 16 * 1024;
/// A sub-agent or workflow count older than this is not believed.
const PENDING_BOUND: Duration = Duration::hours(24);
/// Without a registry nothing proves the agent still lives, so a count is believed for a short while only.
const UNPROVEN_BOUND: Duration = Duration::minutes(15);
/// Where no process start time can be compared, a registry status older than this is not believed.
#[cfg(all(unix, not(target_os = "linux")))]
const UNVERIFIED_BOUND: Duration = Duration::hours(12);

/// What a session still runs after its turn ended. A count is positive, zero is omitted, and `shells` (background shell
/// commands and monitors together) is a lower bound: the agent reports that some run, not how many.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Background {
    #[serde(default, skip_serializing_if = "is_zero")]
    pub agents: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub workflows: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub shells: u32,
}
fn is_zero(count: &u32) -> bool {
    *count == 0
}
impl Background {
    fn is_open(&self) -> bool {
        self.agents + self.workflows + self.shells > 0
    }
}

struct Entry {
    session_id: String,
    status: String,
    status_at: Option<DateTime<Utc>>,
}

/// The live registry entries, or `None` when the agent keeps no registry here (an older Claude Code, another config
/// directory): then nothing proves a process, and only a recent `turn_duration` is believed.
fn registry(root: &Path) -> Option<Vec<Entry>> {
    let entries = fs::read_dir(root.join("sessions")).ok()?;
    Some(
        entries
            .take(MAX_ENTRIES)
            .flatten()
            .filter_map(|entry| read_entry(&entry.path()))
            .collect(),
    )
}

fn read_entry(path: &Path) -> Option<Entry> {
    let pid: u32 = path
        .file_name()?
        .to_str()?
        .strip_suffix(".json")?
        .parse()
        .ok()?;
    let file = crate::transcript::open_transcript(path).ok()?;
    let mut text = String::new();
    file.take(MAX_ENTRY_BYTES).read_to_string(&mut text).ok()?;
    // The agent rewrites the file in place: a torn read is not an entry.
    let record: Value = serde_json::from_str(&text).ok()?;
    let status_at = record["statusUpdatedAt"]
        .as_i64()
        .and_then(DateTime::from_timestamp_millis);
    if !alive(pid, &record["procStart"], status_at) {
        return None;
    }
    Some(Entry {
        session_id: record["sessionId"].as_str()?.to_owned(),
        status: record["status"].as_str()?.to_owned(),
        status_at,
    })
}

/// Whether the process the file names still runs. On Linux `procStart` is field 22 of `/proc/<pid>/stat`, which tells a
/// recycled pid from the agent.
#[cfg(target_os = "linux")]
fn alive(pid: u32, start: &Value, _status_at: Option<DateTime<Utc>>) -> bool {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    let started = stat
        .rsplit_once(") ")
        .and_then(|(_, fields)| fields.split_whitespace().nth(19));
    started.is_some()
        && started
            == match start {
                Value::String(text) => Some(text.as_str()),
                _ => None,
            }
}
#[cfg(all(unix, not(target_os = "linux")))]
fn alive(pid: u32, _start: &Value, status_at: Option<DateTime<Utc>>) -> bool {
    // shortcut: no start time to compare off Linux, so the status must be recent; compare it when a platform's format is known.
    let running = i32::try_from(pid).is_ok_and(|pid| {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe {
            libc::kill(pid, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    });
    running && status_at.is_some_and(|at| Utc::now() - at < UNVERIFIED_BOUND)
}
#[cfg(not(unix))]
fn alive(_pid: u32, _start: &Value, _status_at: Option<DateTime<Utc>>) -> bool {
    false
}

/// The counts of the last `turn_duration` of a conversation, when it is its newest main-thread record: a later record
/// means a turn runs again and the count says nothing, and an unreadable newest line makes the state unknown.
fn pending(session_id: &str, now: DateTime<Utc>, bound: Duration) -> Option<Background> {
    let bytes = read_tail(&conversation(session_id)?, TAIL)?;
    for line in String::from_utf8_lossy(&bytes).lines().rev() {
        let record: Value = serde_json::from_str(line).ok()?;
        if record["isSidechain"] == true {
            continue;
        }
        match (record["type"].as_str(), record["subtype"].as_str()) {
            (Some("system"), Some("turn_duration")) => {
                let at = DateTime::parse_from_rfc3339(record["timestamp"].as_str()?).ok()?;
                let count =
                    |key: &str| u32::try_from(record[key].as_u64().unwrap_or(0)).unwrap_or(0);
                return (now - at.with_timezone(&Utc) < bound).then(|| Background {
                    agents: count("pendingBackgroundAgentCount"),
                    workflows: count("pendingWorkflowCount"),
                    shells: 0,
                });
            }
            (Some("user" | "assistant"), _) => return None,
            _ => {}
        }
    }
    None
}

/// Overlays `working` on every Claude Code row the hooks left `done` while its agent still has work in the background,
/// or has started a turn no hook reported yet (a finished task wakes the agent, and its hooks come only at the first
/// tool call or `Stop`). A row it cannot confirm keeps the state the hooks gave it.
pub fn annotate(snapshot: &mut Snapshot, now: DateTime<Utc>) {
    let Some(root) = claude_config_dir() else {
        return;
    };
    let registry = registry(&root);
    for row in &mut snapshot.sessions {
        let event = &mut row.event;
        // `Session ended` ended its tasks with it.
        if event.agent != AGENT
            || event.state != SessionState::Done
            || event.summary == "Session ended"
        {
            continue;
        }
        let reported =
            DateTime::parse_from_rfc3339(&row.updated_at).map(|at| at.with_timezone(&Utc));
        let (background, resumed) = match &registry {
            None => (pending(&event.session_id, now, UNPROVEN_BOUND), false),
            Some(entries) => {
                let Some(entry) = entries
                    .iter()
                    .filter(|entry| entry.session_id == event.session_id)
                    .max_by_key(|entry| entry.status_at)
                else {
                    continue;
                };
                match entry.status.as_str() {
                    "busy" => (
                        None,
                        matches!((entry.status_at, reported), (Some(at), Ok(reported)) if at > reported),
                    ),
                    status @ ("idle" | "shell") => {
                        let mut open =
                            pending(&event.session_id, now, PENDING_BOUND).unwrap_or_default();
                        open.shells = u32::from(status == "shell");
                        (Some(open), false)
                    }
                    _ => (None, false),
                }
            }
        };
        match background.filter(Background::is_open) {
            Some(background) => {
                event.state = SessionState::Working;
                event.summary = "Working in the background".into();
                row.background = Some(background);
            }
            None if resumed => {
                event.state = SessionState::Working;
                event.summary = "Turn resumed".into();
            }
            None => {}
        }
    }
}
