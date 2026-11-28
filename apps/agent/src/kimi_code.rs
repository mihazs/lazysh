//! Kimi Code 2.4 approval observations (#696, #1635).
//!
//! Pinned 2.4.1 hooks are fire-and-forget and unordered, and only `PermissionRequest` and
//! `PermissionResult` name the agent that raised them. Everything else (turn, tool, `Stop`)
//! cannot be attributed to the root agent, and `Stop` is not completion, so this dialect
//! reports one fact only: the root agent requested approval. It never reports working or done.
use crate::{
    apply_retention, field, storage_failure, write_event, Error, Event, Result, SessionState,
    StoragePhase, Store, Waiting, MAX_INPUT,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, TransactionBehavior};
use serde_json::Value;
use std::io::Read;

pub const AGENT: &str = "Kimi Code";
/// Events the printed fragment subscribes to. `SessionEnd` only retires approvals of a closing session.
pub const EVENTS: [&str; 3] = ["PermissionRequest", "PermissionResult", "SessionEnd"];
/// A resolved request is remembered this long so a late `PermissionRequest` cannot reopen it.
const TOMBSTONE_SECONDS: f64 = 3600.0;

// Additive: a companion that predates it never reads or writes this table.
pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS kimi_code_approvals (
    session_id TEXT NOT NULL, request_id TEXT NOT NULL, resolved INTEGER NOT NULL CHECK(resolved IN (0,1)),
    seen REAL NOT NULL, PRIMARY KEY (session_id,request_id)) WITHOUT ROWID;";

#[derive(Debug)]
pub enum Observation {
    Requested { event: Event, request: String },
    Resolved { session_id: String, request: String },
    SessionEnded { session_id: String },
}

pub fn read(input: impl Read, pane: Option<&str>) -> Result<Option<Observation>> {
    observe(&crate::read_bounded_json(input, MAX_INPUT)?, pane)
}

/// Only the root agent's approval events count: a missing, unknown or other agent changes nothing,
/// and a root event without its full identity is refused.
fn observe(payload: &Value, pane: Option<&str>) -> Result<Option<Observation>> {
    let kind = payload.get("hook_event_name").and_then(Value::as_str);
    match kind {
        Some("SessionEnd") => {
            return Ok(Some(Observation::SessionEnded {
                session_id: field(payload, "session_id", 256)?,
            }))
        }
        Some("PermissionRequest" | "PermissionResult") => {}
        _ => return Ok(None),
    }
    if payload.get("agent_id").and_then(Value::as_str) != Some("main") {
        return Ok(None);
    }
    let session_id = field(payload, "session_id", 256)?;
    let request = field(payload, "id", 256)?;
    field(payload, "tool_call_id", 256)?;
    payload
        .get("turn_id")
        .and_then(Value::as_u64)
        .ok_or(Error::InvalidEvent)?;
    if kind == Some("PermissionResult") {
        return Ok(Some(Observation::Resolved {
            session_id,
            request,
        }));
    }
    Ok(Some(Observation::Requested {
        event: Event {
            session_id,
            agent: AGENT.into(),
            project: field(payload, "cwd", 4096)?,
            state: SessionState::NeedsAttention,
            // Asked, not confirmed waiting: the request may already be answered or cancelled.
            summary: "Approval requested".into(),
            pane_id: pane.map(str::to_owned),
            pane_server: None,
            title: None,
            waiting: Some(Waiting::Approval),
        },
        request,
    }))
}

impl Store {
    /// Keep one needs-attention row per session while any root request is unanswered. A result that
    /// arrives first leaves a tombstone, so observers delivering out of order never reopen attention.
    pub fn record_kimi_code(
        &mut self,
        observation: &Observation,
        reported_at: DateTime<Utc>,
        admission: crate::notification_policy::Admission,
    ) -> Result<()> {
        let now = reported_at.timestamp_micros() as f64 / 1_000_000.0;
        let phase = StoragePhase::SessionWrite;
        let fail = |e: rusqlite::Error| storage_failure(phase, e.into());
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| storage_failure(StoragePhase::IngestBegin, e.into()))?;
        transaction
            .execute(
                "DELETE FROM kimi_code_approvals WHERE (resolved=1 AND seen<?1) OR (resolved=0 AND NOT EXISTS
                (SELECT 1 FROM sessions WHERE agent=?2 AND session_id=kimi_code_approvals.session_id))",
                params![now - TOMBSTONE_SECONDS, AGENT],
            )
            .map_err(fail)?;
        let session = match observation {
            Observation::Requested { event, request } => {
                let new = transaction
                    .execute(
                        "INSERT OR IGNORE INTO kimi_code_approvals VALUES (?1,?2,0,?3)",
                        params![event.session_id, request, now],
                    )
                    .map_err(fail)?;
                if new == 1 {
                    write_event(&transaction, event, now, admission)?;
                }
                None
            }
            Observation::Resolved {
                session_id,
                request,
            } => {
                transaction
                    .execute(
                        "INSERT INTO kimi_code_approvals VALUES (?1,?2,1,?3)
                        ON CONFLICT(session_id,request_id) DO UPDATE SET resolved=1,seen=excluded.seen",
                        params![session_id, request, now],
                    )
                    .map_err(fail)?;
                Some(session_id)
            }
            Observation::SessionEnded { session_id } => {
                transaction
                    .execute(
                        "UPDATE kimi_code_approvals SET resolved=1,seen=?2 WHERE session_id=?1",
                        params![session_id, now],
                    )
                    .map_err(fail)?;
                Some(session_id)
            }
        };
        if let Some(session_id) = session {
            // Nothing true remains to report once no request is open, so the row goes rather than guessing a state.
            for table in ["session_waiting", "sessions"] {
                transaction
                    .execute(
                        &format!(
                            "DELETE FROM {table} WHERE agent=?1 AND session_id=?2 AND NOT EXISTS
                        (SELECT 1 FROM kimi_code_approvals WHERE session_id=?2 AND resolved=0)"
                        ),
                        params![AGENT, session_id],
                    )
                    .map_err(fail)?;
            }
        }
        apply_retention(&transaction, now)?;
        transaction
            .commit()
            .map_err(|e| storage_failure(StoragePhase::Commit, e.into()))
    }
}
