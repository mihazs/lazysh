use super::{block, content, snapshot, string, Error, Result, TranscriptAgent, TranscriptPage};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};

pub(super) fn read_page(path: &Path, offset: u64, limit: u8) -> Result<TranscriptPage> {
    let export = snapshot::read_export(path, limit)?;
    if !export["id"]
        .as_str()
        .is_some_and(|id| id.starts_with("T-") && id.len() <= 256)
        || !export["v"].is_u64()
    {
        return Err(Error::InvalidEvent);
    }
    let messages = export["messages"].as_array().ok_or(Error::InvalidEvent)?;
    if messages.len() > 10_000 {
        return Err(Error::InvalidArgument);
    }
    let mut seen = HashSet::new();
    for message in messages {
        if !seen.insert(identity(message)?) {
            return Err(Error::InvalidEvent);
        }
    }
    snapshot::page(messages, offset, limit, TranscriptAgent::AmpJson, normalize)
}

fn identity(message: &Value) -> Result<String> {
    match &message["messageId"] {
        Value::Number(value) if value.is_u64() => Ok(format!("number-{value}")),
        Value::String(value) if !value.is_empty() && value.len() <= 256 => {
            Ok(format!("string-{value}"))
        }
        _ => Err(Error::InvalidEvent),
    }
}

fn normalize(message: &Value) -> Result<Option<Value>> {
    let role = match message["role"].as_str() {
        Some("user") => "user",
        Some("assistant") => "assistant",
        Some("info") => return Ok(None),
        _ => return Err(Error::InvalidEvent),
    };
    if message
        .get("parentToolUseId")
        .is_some_and(|value| !value.is_null())
    {
        return Ok(None);
    }
    let parts = message["content"].as_array().ok_or(Error::InvalidEvent)?;
    if parts.len() > 1000 {
        return Err(Error::InvalidEvent);
    }
    let mut blocks = Vec::new();
    for part in parts {
        match part["type"].as_str() {
            Some("text" | "thinking" | "tool_use" | "image") => {
                blocks.extend(content(&json!([part])))
            }
            Some("tool_result") => {
                let run = &part["run"];
                if run["status"] == "done" {
                    if let Some(result) = run.get("result") {
                        let text = match result {
                            Value::String(text) => text.clone(),
                            value => {
                                serde_json::to_string(value).map_err(|_| Error::InvalidEvent)?
                            }
                        };
                        blocks.push(block("tool_result", text, string(part, "toolUseID"), None));
                    }
                }
            }
            _ => {}
        }
    }
    if blocks.is_empty() {
        return Ok(None);
    }
    let mut output = json!({"id":identity(message)?,"role":role,"blocks":blocks});
    if role == "assistant" {
        super::copy_usage(
            &mut output,
            &message["usage"],
            &[
                ("inputTokens", "inputTokens"),
                ("outputTokens", "outputTokens"),
                ("cacheReadInputTokens", "cacheReadTokens"),
                ("cacheCreationInputTokens", "cacheWriteTokens"),
            ],
        );
    }
    Ok(Some(output))
}
