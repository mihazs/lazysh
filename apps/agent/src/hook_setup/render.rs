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
        Agent::Opencode => (false, 0),
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
    Ok(Entry {
        event: event.into(),
        group: serde_json::json!({"hooks":[{"type":"command","command":command,"timeout":timeout}]}),
    })
}

pub(super) fn entries(agent: Agent, binary: &Path) -> Result<Vec<Entry>, &'static str> {
    let config = match agent {
        Agent::Claude => crate::claude_config(),
        Agent::Codex => crate::hooks::codex_config(),
        Agent::Opencode => return Ok(Vec::new()),
    };
    let events = config["hooks"].as_object().ok_or("HooksInvalidTemplate")?;
    events
        .iter()
        .map(|(event, groups)| {
            let groups = groups
                .as_array()
                .filter(|groups| groups.len() == 1)
                .ok_or("HooksInvalidTemplate")?;
            let entry = v1_entry(agent, binary, event)?;
            let mut current = groups[0].clone();
            current["hooks"][0]["command"] = entry.group["hooks"][0]["command"].clone();
            if current != entry.group {
                return Err("HooksInvalidTemplate");
            }
            Ok(entry)
        })
        .collect()
}
pub(super) fn plugin(binary: &Path) -> Result<String, &'static str> {
    let body = crate::hooks::opencode_plugin();
    let body = body["content"].as_str().ok_or("HooksInvalidTemplate")?;
    const COMMAND: &str = "['lazysh-agent', 'ingest', '--agent', 'opencode']";
    if body.matches(COMMAND).count() != 1 {
        return Err("HooksInvalidTemplate");
    }
    let path = binary.to_str().ok_or("HooksInvalidBinary")?;
    let path = serde_json::to_string(path).map_err(|_| "HooksInvalidBinary")?;
    Ok(body.replace(
        COMMAND,
        &format!("[{path}, 'ingest', '--agent', 'opencode']"),
    ))
}
