use super::{block, content, snapshot, string, Error, Result, TranscriptAgent, TranscriptPage};
use serde_json::{json, Value};
use std::path::Path;

/// Reads an existing Devin export; never starts an agent or resolves references.
pub(super) fn read_page(path: &Path, offset: u64, limit: u8) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    let export = snapshot::read(path)?;
    if export["schema_version"] != "ATIF-v1.7" {
        return Err(Error::InvalidEvent);
    }
    let steps = export["steps"].as_array().ok_or(Error::InvalidEvent)?;
    if steps.len() > 10_000 {
        return Err(Error::InvalidArgument);
    }
    for (index, step) in steps.iter().enumerate() {
        if step["step_id"].as_u64() != Some(index as u64 + 1)
            || !matches!(step["source"].as_str(), Some("system" | "user" | "agent"))
        {
            return Err(Error::InvalidEvent);
        }
    }
    snapshot::page(steps, offset, limit, TranscriptAgent::DevinAtif, normalize)
}

fn normalize(step: &Value) -> Result<Option<Value>> {
    let role = match step["source"].as_str() {
        Some("agent") => "assistant",
        Some("user") => "user",
        _ => return Ok(None),
    };
    let message = step.get("message").ok_or(Error::InvalidEvent)?;
    if !message.is_string() && !message.is_array() {
        return Err(Error::InvalidEvent);
    }
    let mut blocks = atif_content(message)?;
    if role == "assistant" {
        if let Some(reasoning) = string(step, "reasoning_content").filter(|text| !text.is_empty()) {
            blocks.push(block("thinking", reasoning, None, None));
        }
        if let Some(calls) = step.get("tool_calls").filter(|value| !value.is_null()) {
            let calls = calls.as_array().ok_or(Error::InvalidEvent)?;
            if calls.len() > 1000 {
                return Err(Error::InvalidEvent);
            }
            for call in calls {
                let arguments = call
                    .get("arguments")
                    .filter(|value| value.is_object())
                    .ok_or(Error::InvalidEvent)?;
                blocks.push(block(
                    "tool_use",
                    serde_json::to_string(arguments).map_err(|_| Error::InvalidEvent)?,
                    Some(string(call, "tool_call_id").ok_or(Error::InvalidEvent)?),
                    Some(string(call, "function_name").ok_or(Error::InvalidEvent)?),
                ));
            }
        }
        if let Some(observation) = step.get("observation").filter(|value| !value.is_null()) {
            let results = observation["results"]
                .as_array()
                .ok_or(Error::InvalidEvent)?;
            if results.len() > 1000 {
                return Err(Error::InvalidEvent);
            }
            for result in results {
                // Do not follow subagent_trajectory_ref or any image path.
                if let Some(value) = result.get("content").filter(|value| !value.is_null()) {
                    if !value.is_string() && !value.is_array() {
                        return Err(Error::InvalidEvent);
                    }
                    let text = atif_content(value)?
                        .iter()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    blocks.push(block(
                        "tool_result",
                        text,
                        string(result, "source_call_id"),
                        None,
                    ));
                }
            }
        }
    }
    if blocks.is_empty() {
        return Ok(None);
    }
    if blocks.iter().any(|part| {
        part["text"]
            .as_str()
            .is_some_and(|text| text.len() > 262_144)
    }) {
        return Err(Error::InvalidEvent);
    }
    let mut output = json!({"id":format!("step-{}",step["step_id"]),"role":role,"blocks":blocks});
    if let Some(timestamp) = string(step, "timestamp") {
        output["timestamp"] = json!(timestamp);
    }
    if role == "assistant" {
        let mut usage = serde_json::Map::new();
        for (source, target) in [
            ("prompt_tokens", "inputTokens"),
            ("completion_tokens", "outputTokens"),
            ("cached_tokens", "cacheReadTokens"),
        ] {
            if let Some(count) = step["metrics"][source].as_u64() {
                usage.insert(target.into(), json!(count));
            }
        }
        if !usage.is_empty() {
            output["usage"] = json!(usage);
        }
    }
    Ok(Some(output))
}

fn atif_content(value: &Value) -> Result<Vec<Value>> {
    if let Some(parts) = value.as_array() {
        if parts.len() > 1000
            || parts.iter().any(|part| match part["type"].as_str() {
                Some("text") => !part["text"].is_string(),
                Some("image") => !part["source"].is_object(),
                _ => true,
            })
        {
            return Err(Error::InvalidEvent);
        }
    }
    Ok(content(value))
}
