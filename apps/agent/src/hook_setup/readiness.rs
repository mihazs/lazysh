//! Additive readiness facts beside a hook status. Configuration is not reporting evidence, so each
//! fact stays its own state, and one that cannot be probed read-only stays `notChecked`.
//! Provider reload, project trust and remote delivery have no such probe: the companion never reads
//! provider trust records or processes, and a local event does not prove a remote push.
use super::record::Agent;
use chrono::{DateTime, SecondsFormat};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, io, path::Path, time::Duration};

/// The `agent` name each adapter stores with its events.
fn event_agent(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "Claude Code",
        Agent::Codex => "Codex",
        Agent::Droid => "Droid",
        Agent::Gemini => "Gemini CLI",
        Agent::Cursor => "Cursor CLI",
        Agent::Opencode => "OpenCode",
        Agent::Cline => "Cline CLI",
        Agent::Copilot => "GitHub Copilot CLI",
        Agent::Amp => "Amp",
    }
}

enum Probe {
    /// The store could not be read without a side effect, so nothing is claimed.
    Unavailable,
    /// There is no store, or it holds no report from this agent.
    Silent,
    Heard {
        at: String,
        pane: bool,
    },
}

fn is_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
}

/// The newest report of one agent, from the companion's own store and never from a profile.
/// It never creates or initializes the store: an absent store is opened by nobody.
fn probe(agent: &str) -> Probe {
    let Ok(directory) = crate::state_directory() else {
        return Probe::Unavailable;
    };
    let Ok(directory) = crate::storage_namespace::resolve(&directory) else {
        return Probe::Unavailable;
    };
    if crate::storage_filesystem::require_local(&directory).is_err() {
        return Probe::Unavailable;
    }
    let database = directory.join("events.sqlite3");
    match fs::symlink_metadata(&database) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Probe::Silent,
        Ok(metadata) if metadata.is_file() => {}
        _ => return Probe::Unavailable,
    }
    // Even a read-only connection creates a missing WAL index, so only a store that has one is read.
    if !is_file(&directory.join("events.sqlite3-wal"))
        || !is_file(&directory.join("events.sqlite3-shm"))
    {
        return Probe::Unavailable;
    }
    let newest = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .and_then(|connection| {
        connection.busy_timeout(Duration::from_millis(500))?;
        connection
            .query_row(
                "SELECT updated_at,pane_id IS NOT NULL FROM sessions WHERE agent=?1 ORDER BY updated_at DESC,rowid DESC LIMIT 1",
                [agent],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()
    });
    match newest {
        Ok(None) => Probe::Silent,
        Ok(Some((seconds, pane))) => {
            match DateTime::from_timestamp_micros((seconds * 1_000_000.0).round() as i64) {
                Some(time) => Probe::Heard {
                    at: time.to_rfc3339_opts(SecondsFormat::Micros, true),
                    pane,
                },
                None => Probe::Unavailable,
            }
        }
        Err(_) => Probe::Unavailable,
    }
}

/// `localEvent` and `paneBinding` describe the agent, not the selected profile: the store records no
/// profile. A past report says when the agent last spoke, never that it is running now.
pub(super) fn report(agent: Agent) -> Value {
    let (event, pane, at) = match probe(event_agent(agent)) {
        Probe::Unavailable => ("notChecked", "notChecked", None),
        Probe::Silent => ("none", "notChecked", None),
        Probe::Heard { at, pane } => ("received", if pane { "bound" } else { "unbound" }, Some(at)),
    };
    let mut readiness = json!({"schemaVersion":1,"providerReload":"notChecked","projectTrust":"notChecked","localEvent":event,"paneBinding":pane,"remoteDelivery":"notChecked"});
    if let Some(at) = at {
        readiness["lastEventAt"] = Value::String(at);
    }
    readiness
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The name this module looks for is the name each real adapter stores.
    #[test]
    fn looks_for_the_agent_name_every_adapter_stores() {
        let claude_like = |kind: &str| json!({"hook_event_name":kind,"session_id":"s","cwd":"/p"});
        for (agent, native, payload) in [
            (
                Agent::Claude,
                crate::Agent::Claude,
                claude_like("UserPromptSubmit"),
            ),
            (
                Agent::Codex,
                crate::Agent::Codex,
                claude_like("UserPromptSubmit"),
            ),
            (
                Agent::Droid,
                crate::Agent::Droid,
                claude_like("UserPromptSubmit"),
            ),
            (
                Agent::Gemini,
                crate::Agent::Gemini,
                claude_like("BeforeAgent"),
            ),
            (
                Agent::Copilot,
                crate::Agent::Copilot,
                claude_like("UserPromptSubmit"),
            ),
            (
                Agent::Cursor,
                crate::Agent::Cursor,
                json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"s","cwd":"/p"}),
            ),
            (
                Agent::Opencode,
                crate::Agent::Opencode,
                json!({"type":"session.status","directory":"/p","properties":{"sessionID":"s","status":{"type":"busy"}}}),
            ),
            (
                Agent::Amp,
                crate::Agent::Amp,
                json!({"schemaVersion":1,"state":"running","threadId":"s","directory":"/p"}),
            ),
            (
                Agent::Cline,
                crate::Agent::Cline,
                json!({"schemaVersion":1,"status":"start","agentId":"a","conversationId":"c","runId":"r","directory":"/p"}),
            ),
        ] {
            let event = crate::normalize(&payload, native, None).unwrap().unwrap();
            assert_eq!(event.agent, event_agent(agent));
        }
    }
}
