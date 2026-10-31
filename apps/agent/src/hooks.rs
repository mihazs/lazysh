//! Native lifecycle adapters observe status; they never answer approvals.
use crate::{field, Event, Result, SessionState};
use serde_json::{json, Value};

pub(crate) fn command_config(agent: &str, events: &[&str], timeout: u16) -> Value {
    let mut hooks = serde_json::Map::new();
    for kind in events {
        hooks.insert((*kind).into(), json!([{"hooks":[{"type":"command","command":format!("lazysh-agent ingest --agent {agent}"),"timeout":timeout}]}]));
    }
    json!({"hooks":hooks})
}

pub fn codex_config() -> Value {
    // SessionEnd and Interrupt have a three-second maximum in Codex.
    command_config(
        "codex",
        &[
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PermissionRequest",
            "Stop",
            "SessionEnd",
            "Interrupt",
        ],
        3,
    )
}

pub fn gemini_config() -> Value {
    command_config(
        "gemini",
        &[
            "BeforeAgent",
            "BeforeTool",
            "AfterTool",
            "Notification",
            "AfterAgent",
            "SessionEnd",
        ],
        5000,
    )
}

pub fn droid_config() -> Value {
    let mut config = command_config(
        "droid",
        &[
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "Notification",
            "Stop",
            "SessionEnd",
        ],
        5,
    );
    config["hooks"].take()
}

pub fn kimi_config() -> Value {
    let events = [
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "Notification",
        "SessionEnd",
    ];
    let content = events.iter().map(|event| format!("[[hooks]]\nevent = \"{event}\"\ncommand = \"lazysh-agent ingest --agent kimi\"\ntimeout = 5\n")).collect::<Vec<_>>().join("\n");
    json!({"schemaVersion":1,"format":"toml","filename":"config.toml","content":content})
}

pub fn copilot_config() -> Value {
    let mut hooks = serde_json::Map::new();
    // Avoid preToolUse's fail-closed observer errors and pre-approval permissionRequest.
    for event in [
        "UserPromptSubmit",
        "PostToolUse",
        "PostToolUseFailure",
        "Stop",
        "SessionEnd",
        "notification",
    ] {
        hooks.insert(event.into(), json!([{"type":"command","exec":"lazysh-agent","args":["ingest","--agent","copilot"],"timeoutSec":5}]));
    }
    json!({"version":1,"hooks":hooks})
}

pub fn opencode_plugin() -> Value {
    json!({"schemaVersion":1,"filename":"lazysh.js","content":include_str!("../hooks/opencode.js")})
}

pub fn cursor_config() -> Value {
    let mut hooks = serde_json::Map::new();
    for event in [
        "beforeSubmitPrompt",
        "postToolUse",
        "postToolUseFailure",
        "afterAgentThought",
        "stop",
        "sessionEnd",
    ] {
        hooks.insert(
            event.into(),
            json!([{"command":"lazysh-agent ingest --agent cursor","timeout":5}]),
        );
    }
    json!({"version":1,"hooks":hooks})
}

pub fn amp_plugin() -> Value {
    json!({"schemaVersion":1,"filename":"lazysh.js","content":include_str!("../hooks/amp.js")})
}

pub(crate) fn cursor_event(payload: &Value, pane: Option<&str>) -> Result<Option<Event>> {
    let kind = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let (state, summary) = match kind {
        "beforeSubmitPrompt" => (SessionState::Working, "Working on your prompt"),
        "postToolUse" | "postToolUseFailure" | "afterAgentThought" => {
            (SessionState::Working, "Working")
        }
        "stop" => match payload.get("status").and_then(Value::as_str) {
            Some("completed") => (SessionState::Done, "Turn finished"),
            Some("aborted") => (SessionState::Done, "Turn interrupted"),
            Some("error") => (SessionState::NeedsAttention, "Turn failed"),
            _ => return Ok(None),
        },
        "sessionEnd" => (SessionState::Done, "Session ended"),
        _ => return Ok(None),
    };
    let project = match payload.get("cwd") {
        Some(Value::String(_)) => field(payload, "cwd", 4096)?,
        None | Some(Value::Null) => {
            let roots = payload
                .get("workspace_roots")
                .and_then(Value::as_array)
                .ok_or(crate::Error::InvalidEvent)?;
            for root in roots {
                crate::text(root.as_str().ok_or(crate::Error::InvalidEvent)?, 4096)?;
            }
            match roots.len() {
                0 => "Cursor (no workspace)".into(),
                1 => roots[0].as_str().unwrap().into(),
                count => format!("Cursor ({count} workspace roots)"),
            }
        }
        _ => return Err(crate::Error::InvalidEvent),
    };
    Ok(Some(Event {
        session_id: field(payload, "conversation_id", 256)?,
        agent: "Cursor CLI".into(),
        project,
        state,
        summary: summary.into(),
        pane_id: pane.map(str::to_owned),
    }))
}

pub(crate) fn amp_event(payload: &Value, pane: Option<&str>) -> Result<Option<Event>> {
    if payload.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(crate::Error::InvalidEvent);
    }
    let (state, summary) = match payload.get("state").and_then(Value::as_str) {
        Some("running") => (SessionState::Working, "Working"),
        Some("awaiting-approval") => (SessionState::NeedsAttention, "Permission requested"),
        Some("idle") => (SessionState::Done, "Turn finished"),
        Some("error") => (SessionState::NeedsAttention, "Turn failed"),
        _ => return Ok(None),
    };
    Ok(Some(Event {
        session_id: field(payload, "threadId", 256)?,
        agent: "Amp".into(),
        project: field(payload, "directory", 4096)?,
        state,
        summary: summary.into(),
        pane_id: pane.map(str::to_owned),
    }))
}

// Additive health-only table; never insert an ambiguous Aider notification into sessions.
pub(crate) const AIDER_HEALTH_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS aider_hook_health (
    id INTEGER PRIMARY KEY CHECK(id=1), callbacks INTEGER NOT NULL CHECK(callbacks BETWEEN 1 AND 9007199254740991),
    updated_at INTEGER NOT NULL);";

pub fn aider_config() -> Value {
    json!({"schemaVersion":1,"agent":"Aider","arguments":["--notifications","--notifications-command","lazysh-agent aider-notification"],"callbackCommand":"lazysh-agent aider-notification","sessionAttribution":"unavailable","lifecycleStates":[],"observedCallback":"input_boundary"})
}

impl crate::Store {
    pub fn record_aider_notification(&mut self, now: chrono::DateTime<chrono::Utc>) -> Result<()> {
        self.connection.execute("INSERT INTO aider_hook_health VALUES(1,1,?1) ON CONFLICT(id) DO UPDATE SET callbacks=MIN(callbacks+1,9007199254740991),updated_at=excluded.updated_at", [now.timestamp_millis()])?;
        Ok(())
    }
    pub fn aider_hook_status(&mut self) -> Result<Value> {
        use rusqlite::OptionalExtension;
        let observation: Option<(i64, i64)> = self
            .connection
            .query_row(
                "SELECT callbacks,updated_at FROM aider_hook_health WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (count, updated) = match observation {
            Some((count, stamp)) => (
                count,
                Some(
                    chrono::DateTime::from_timestamp_millis(stamp)
                        .ok_or(crate::Error::InvalidEvent)?
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ),
            ),
            None => (0, None),
        };
        Ok(
            json!({"schemaVersion":1,"agent":"Aider","observedCallback":"input_boundary","sessionAttribution":"unavailable","lifecycleStates":[],"callbackCount":count,"lastObservedAt":updated}),
        )
    }
}

pub(crate) fn opencode_event(payload: &Value, pane: Option<&str>) -> Result<Option<Event>> {
    let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
    let (state, summary) = match kind {
        "session.status" => match payload
            .pointer("/properties/status/type")
            .and_then(Value::as_str)
        {
            Some("busy") => (SessionState::Working, "Working"),
            Some("retry") => (SessionState::Working, "Retrying"),
            Some("idle") => (SessionState::Done, "Turn finished"),
            _ => return Ok(None),
        },
        "permission.asked" => (SessionState::NeedsAttention, "Permission requested"),
        "question.asked" => (SessionState::NeedsAttention, "Answer requested"),
        "session.deleted" => (SessionState::Done, "Session ended"),
        "session.error" if payload.pointer("/properties/sessionID").is_some() => {
            (SessionState::NeedsAttention, "Session error")
        }
        _ => return Ok(None),
    };
    Ok(Some(Event {
        session_id: field(&payload["properties"], "sessionID", 256)?,
        agent: "OpenCode".into(),
        project: field(payload, "directory", 4096)?,
        state,
        summary: summary.into(),
        pane_id: pane.map(str::to_owned),
    }))
}
