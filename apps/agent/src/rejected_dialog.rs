//! Claude Code runs no hook when the person rejects a permission dialog, not even `PostToolUseFailure` or `Stop`
//! (#1795), so the row stays `needs_attention` until the next prompt. The conversation file records the rejection as
//! the interruption marker, so a snapshot settles a row that waits at a dialog the file shows was rejected. Esc on a
//! running turn sends no hook either (#1956) and leaves the row `working`; the same marker settles it.
use crate::{notification_policy::Admission, write_event, Event, Result, SessionState, Store};
use chrono::{DateTime, Utc};
use rusqlite::TransactionBehavior;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const AGENT: &str = "Claude Code";
/// The end of the conversation file that is read; a last record longer than this is not recognised.
const TAIL: u64 = 64 * 1024;
const MAX_PROJECTS: usize = 10_000;

/// Where Claude Code keeps its sessions and conversations: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub(crate) fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
}

/// `<projects>/<project>/<session id>.jsonl`, the file Claude Code appends the conversation to. The id names a file,
/// so it holds nothing but the characters of the identifiers Claude Code writes.
pub(crate) fn conversation(session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    fs::read_dir(claude_config_dir()?.join("projects"))
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
    let Some(bytes) = conversation(session_id).and_then(|path| read_tail(&path, TAIL)) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes);
    // An incomplete newer line makes the state unknown; never skip it to settle from an older marker.
    // A window starting mid-record is harmless when a complete newer relevant record is found first.
    for line in text.lines().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        if matches!(record["type"].as_str(), Some("user" | "assistant"))
            && record["isSidechain"] != true
        {
            return crate::transcript::interrupted(&record)
                && record["timestamp"]
                    .as_str()
                    .and_then(|time| DateTime::parse_from_rfc3339(time).ok())
                    .is_some_and(|time| time.timestamp_micros() as f64 / 1_000_000.0 >= since);
        }
    }
    false
}

/// The last `limit` bytes of a conversation file, or `None` when the file changed while it was read.
pub(crate) fn read_tail(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let file = crate::transcript::open_transcript(path).ok()?;
    let before = crate::transcript::SourceSnapshot::capture(&file).ok()?;
    stable_tail(path, file, before, limit)
}

// The final observation bounds the evidence; later writes may still change the conversation.
fn stable_tail(
    path: &Path,
    mut file: File,
    before: crate::transcript::SourceSnapshot,
    limit: u64,
) -> Option<Vec<u8>> {
    let length = before.len();
    let start = length.saturating_sub(limit);
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(start)).ok()?;
    (&mut file).take(limit).read_to_end(&mut bytes).ok()?;
    let selected = crate::transcript::open_transcript(path).ok()?;
    let after = crate::transcript::SourceSnapshot::capture(&selected).ok()?;
    before.same_file(&selected).ok()?;
    if before.len() != after.len()
        || before.modified().ok()? != after.modified().ok()?
        || bytes.len() as u64 != length - start
    {
        return None;
    }
    Some(bytes)
}

impl Store {
    /// Marks done every Claude Code row that waits at a dialog (an approval, a question or a plan) its conversation
    /// shows the person rejected, or that is `working` on a turn it shows the person interrupted (#1956), as Codex's
    /// `Interrupt` does. A `working` row counts from its last report. A row it cannot confirm is left as it is: with no
    /// conversation file (another `CLAUDE_CONFIG_DIR` than the companion's) the row stays until the next report.
    pub fn settle_rejected_dialogs(
        &mut self,
        now: DateTime<Utc>,
        admission: Admission,
    ) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let waits = transaction
            .prepare("SELECT session_id,project,pane_id,COALESCE(since,updated_at),server FROM sessions LEFT JOIN session_waiting USING (agent,session_id) LEFT JOIN session_pane_server USING (agent,session_id) WHERE agent=?1 AND (state='working' OR (state='needs_attention' AND kind IN ('approval','question','plan')))")?
            .query_map([AGENT], |row| {
                Ok((
                    Event {
                        session_id: row.get(0)?,
                        agent: AGENT.into(),
                        project: row.get(1)?,
                        state: SessionState::Done,
                        summary: "Turn interrupted".into(),
                        pane_id: row.get(2)?,
                        // Kept: writing None would delete the row's stored pane server binding.
                        pane_server: row.get(4)?,
                        waiting: None,
                        title: None,
                    },
                    row.get::<_, f64>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let now = now.timestamp_micros() as f64 / 1_000_000.0;
        for (event, since) in waits {
            if interrupted_since(&event.session_id, since) {
                write_event(&transaction, &event, now, admission)?;
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn changed_or_replaced_transcript_makes_tail_inconclusive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.jsonl");
        fs::write(&path, vec![b'x'; TAIL as usize + 1]).unwrap();
        let capture = || {
            let file = File::open(&path).unwrap();
            let before = crate::transcript::SourceSnapshot::capture(&file).unwrap();
            (file, before)
        };
        let (file, before) = capture();
        writeln!(
            fs::OpenOptions::new().append(true).open(&path).unwrap(),
            "new record"
        )
        .unwrap();
        assert!(stable_tail(&path, file, before, TAIL).is_none());

        let (file, before) = capture();
        let modified = before.modified().unwrap() + std::time::Duration::from_secs(5);
        fs::write(&path, vec![b'y'; before.len() as usize]).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(stable_tail(&path, file, before, TAIL).is_none());

        let (file, before) = capture();
        fs::rename(&path, dir.path().join("old.jsonl")).unwrap();
        fs::write(&path, vec![b'x'; before.len() as usize]).unwrap();
        assert!(stable_tail(&path, file, before, TAIL).is_none());

        let (file, before) = capture();
        assert_eq!(
            stable_tail(&path, file, before, TAIL).unwrap().len(),
            TAIL as usize
        );
    }
}
