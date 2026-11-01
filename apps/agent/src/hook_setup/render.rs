use super::{json::Entry, record::Agent};
use std::path::Path;

// Persisted v1 records must survive later additions to the public config printers.
pub(super) fn v1_entry(agent: Agent, binary: &Path, event: &str) -> Result<Entry, &'static str> {
    let common = matches!(
        event,
        "UserPromptSubmit"
            | "PreToolUse"
            | "PostToolUse"
            | "PermissionRequest"
            | "Stop"
            | "SessionEnd"
    );
    let (valid, timeout) = match agent {
        Agent::Claude => (
            common || matches!(event, "PostToolUseFailure" | "Notification"),
            5,
        ),
        Agent::Codex => (common || event == "Interrupt", 3),
        Agent::Droid => (
            matches!(
                event,
                "UserPromptSubmit"
                    | "PreToolUse"
                    | "PostToolUse"
                    | "Notification"
                    | "Stop"
                    | "SessionEnd"
            ),
            5,
        ),
        Agent::Gemini => (
            matches!(
                event,
                "BeforeAgent"
                    | "BeforeTool"
                    | "AfterTool"
                    | "Notification"
                    | "AfterAgent"
                    | "SessionEnd"
            ),
            5000,
        ),
        Agent::Cursor => (
            matches!(
                event,
                "beforeSubmitPrompt"
                    | "postToolUse"
                    | "postToolUseFailure"
                    | "afterAgentThought"
                    | "stop"
                    | "sessionEnd"
            ),
            5,
        ),
        Agent::Opencode | Agent::Cline | Agent::Copilot => (false, 0),
    };
    if !valid {
        return Err("HooksInvalidTemplate");
    }
    let command = binary.to_str().ok_or("HooksInvalidBinary")?;
    let command = format!(
        "'{}' ingest --agent {}",
        command.replace('\'', "'\\''"),
        agent.name()
    );
    let group = if agent == Agent::Cursor {
        serde_json::json!({"command":command,"timeout":timeout})
    } else {
        serde_json::json!({"hooks":[{"type":"command","command":command,"timeout":timeout}]})
    };
    Ok(Entry {
        event: event.into(),
        group,
    })
}

pub(super) fn entries(agent: Agent, binary: &Path) -> Result<Vec<Entry>, &'static str> {
    let config = match agent {
        Agent::Claude => crate::claude_config(),
        Agent::Codex => crate::hooks::codex_config(),
        Agent::Droid => crate::hooks::droid_config(),
        Agent::Gemini => crate::hooks::gemini_config(),
        Agent::Cursor => crate::hooks::cursor_config(),
        Agent::Opencode | Agent::Cline | Agent::Copilot => return Ok(Vec::new()),
    };
    if agent == Agent::Cursor && config["version"] != 1 {
        return Err("HooksInvalidTemplate");
    }
    let events = if agent == Agent::Droid {
        &config
    } else {
        &config["hooks"]
    };
    let events = events.as_object().ok_or("HooksInvalidTemplate")?;
    events
        .iter()
        .map(|(event, groups)| {
            let groups = groups
                .as_array()
                .filter(|groups| groups.len() == 1)
                .ok_or("HooksInvalidTemplate")?;
            let entry = v1_entry(agent, binary, event)?;
            let mut current = groups[0].clone();
            let pointer = if agent == Agent::Cursor {
                "/command"
            } else {
                "/hooks/0/command"
            };
            *current.pointer_mut(pointer).ok_or("HooksInvalidTemplate")? = entry
                .group
                .pointer(pointer)
                .ok_or("HooksInvalidTemplate")?
                .clone();
            if current != entry.group {
                return Err("HooksInvalidTemplate");
            }
            Ok(entry)
        })
        .collect()
}
pub(super) fn owned_file(agent: Agent, binary: &Path) -> Result<String, &'static str> {
    let path = binary.to_str().ok_or("HooksInvalidBinary")?;
    if agent == Agent::Copilot {
        let mut config = crate::hooks::copilot_config();
        let expected = [
            "UserPromptSubmit",
            "PostToolUse",
            "PostToolUseFailure",
            "Stop",
            "SessionEnd",
            "notification",
        ];
        if config["version"] != 1 || config.as_object().is_none_or(|v| v.len() != 2) {
            return Err("HooksInvalidTemplate");
        }
        let events = config["hooks"]
            .as_object_mut()
            .ok_or("HooksInvalidTemplate")?;
        if events.len() != expected.len() {
            return Err("HooksInvalidTemplate");
        }
        for event in expected {
            let commands = events
                .get_mut(event)
                .and_then(serde_json::Value::as_array_mut)
                .ok_or("HooksInvalidTemplate")?;
            if commands.len() != 1
                || commands[0]
                    != serde_json::json!({"type":"command","exec":"lazysh-agent","args":["ingest","--agent","copilot"],"timeoutSec":5})
            {
                return Err("HooksInvalidTemplate");
            }
            commands[0]["exec"] = path.into();
        }
        return serde_json::to_string_pretty(&config)
            .map(|text| text + "\n")
            .map_err(|_| "HooksInvalidTemplate");
    }
    let path = serde_json::to_string(path).map_err(|_| "HooksInvalidBinary")?;
    let (asset, command, replacement) = match agent {
        Agent::Opencode => (
            crate::hooks::opencode_plugin(),
            "['lazysh-agent', 'ingest', '--agent', 'opencode']",
            format!("[{path}, 'ingest', '--agent', 'opencode']"),
        ),
        Agent::Cline => (
            crate::hooks::cline_plugin(),
            "childProcess.execFile('lazysh-agent',",
            format!("childProcess.execFile({path},"),
        ),
        _ => return Err("HooksInvalidTemplate"),
    };
    let body = asset["content"].as_str().ok_or("HooksInvalidTemplate")?;
    if body.matches(command).count() != 1 {
        return Err("HooksInvalidTemplate");
    }
    Ok(body.replace(command, &replacement))
}

/// Provider envelope handling stays separate from ownership of individual groups.
pub(super) fn configuration(
    agent: Agent,
    input: &str,
    previous: &[Entry],
    next: &[Entry],
) -> Result<String, super::json::Fault> {
    let input = if agent == Agent::Cursor && (!previous.is_empty() || !next.is_empty()) {
        super::json::cursor_document(input, !next.is_empty())?
    } else {
        input.into()
    };
    if agent == Agent::Droid {
        super::json::rewrite_standalone(&input, previous, next)
    } else {
        super::json::rewrite(&input, previous, next)
    }
}
