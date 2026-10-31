//! Native lifecycle adapters observe status; they never answer approvals.
use crate::{field, Event, Result, SessionState};
use serde_json::{json, Value};

pub(crate) fn command_config(agent: &str, events: &[&str], timeout: u8) -> Value {
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

pub fn opencode_plugin() -> Value {
    json!({"schemaVersion":1,"filename":"lazysh.js","content":include_str!("../hooks/opencode.js")})
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
