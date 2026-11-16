//! Claude Code runs no hook when the person rejects a permission dialog, not even `PostToolUseFailure` or `Stop`
//! (#1795), so the row stays `needs_attention` until the next prompt. The conversation file records the rejection as
//! the interruption marker, so a snapshot settles a row that waits at a dialog the file shows was rejected.
use crate::{write_event, Event, Result, SessionState, Store};
use chrono::{DateTime, Utc};
use rusqlite::TransactionBehavior;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
};

const AGENT: &str = "Claude Code";
/// The end of the conversation file that is read; a last record longer than this is not recognised.
const TAIL: u64 = 64 * 1024;
const MAX_PROJECTS: usize = 10_000;

/// `<projects>/<project>/<session id>.jsonl`, the file Claude Code appends the conversation to. The id names a file,
/// so it holds nothing but the characters of the identifiers Claude Code writes.
fn conversation(session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    let root = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))?;
    fs::read_dir(root.join("projects"))
        .ok()?
        .take(MAX_PROJECTS)
        .flatten()
        .filter(|project| project.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|project| project.path().join(format!("{session_id}.jsonl")))
        .find(|path| fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file()))
}

/// Whether the last record of the conversation is an interruption written at or after `since` (seconds since the
/// epoch): nothing was said after the person rejected the dialog, and no newer dialog opened.
fn interrupted_since(session_id: &str, since: f64) -> bool {
    let Some(mut file) = conversation(session_id).and_then(|path| File::open(path).ok()) else {
        return false;
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return false;
    };
    let start = length.saturating_sub(TAIL);
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err()
        || file.take(TAIL).read_to_end(&mut bytes).is_err()
    {
        return false;
    }
    let text = String::from_utf8_lossy(&bytes);
    // The first line of a window that starts mid-record is not valid JSON, so it is never taken for a record.
    // Other records (queue operations, snapshots, a sub-agent's own messages) say nothing about the dialog.
    let last = text
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|record| {
            matches!(record["type"].as_str(), Some("user" | "assistant"))
                && record["isSidechain"] != true
        });
    last.is_some_and(|record| {
        crate::transcript::interrupted(&record)
            && record["timestamp"]
                .as_str()
                .and_then(|time| DateTime::parse_from_rfc3339(time).ok())
                .is_some_and(|time| time.timestamp_micros() as f64 / 1_000_000.0 >= since)
    })
}

impl Store {
    /// Marks done every Claude Code row that waits at a dialog (an approval, a question or a plan) its conversation
    /// shows the person rejected, as Codex's `Interrupt` does. A row it cannot confirm is left as it is: with no
    /// conversation file (another `CLAUDE_CONFIG_DIR` than the companion's) the row stays until the next report.
    pub fn settle_rejected_dialogs(&mut self, now: DateTime<Utc>) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let waits = transaction
            .prepare("SELECT session_id,project,pane_id,since FROM sessions JOIN session_waiting USING (agent,session_id) WHERE agent=?1 AND state='needs_attention' AND kind IN ('approval','question','plan')")?
            .query_map([AGENT], |row| {
                Ok((
                    Event {
                        session_id: row.get(0)?,
                        agent: AGENT.into(),
                        project: row.get(1)?,
                        state: SessionState::Done,
                        summary: "Turn interrupted".into(),
                        pane_id: row.get(2)?,
                        waiting: None,
                    },
                    row.get::<_, f64>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let now = now.timestamp_micros() as f64 / 1_000_000.0;
        for (event, since) in waits {
            if interrupted_since(&event.session_id, since) {
                write_event(&transaction, &event, now)?;
            }
        }
        transaction.commit()?;
        Ok(())
    }
}
