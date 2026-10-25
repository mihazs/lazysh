//! Explicit modern Grok disk records; no chunk assembly or timeline replay.
use super::{block, string};
use crate::{Error, Result};
use serde_json::{json, Value};

// Bound amplification before tool identifiers are cloned into output blocks.
const MAX_TOOL_ID_BYTES: usize = 256;
pub(super) fn validate_bounds(record: &Value) -> Result<()> {
    if record["method"] != "session/update" {
        return Ok(());
    }
    let update = &record["params"]["update"];
    let max_outputs = match update["sessionUpdate"].as_str() {
        Some("tool_call") => 999, // one additional tool-use block
        Some("tool_call_update") => 1000,
        _ => return Ok(()),
    };
    if update["toolCallId"]
        .as_str()
        .is_some_and(|id| id.len() > MAX_TOOL_ID_BYTES)
        || update["content"]
            .as_array()
            .is_some_and(|parts| parts.len() > max_outputs)
    {
        return Err(Error::InvalidEvent);
    }
    Ok(())
}

pub(super) fn normalize(record: &Value, offset: u64) -> Option<Value> {
    let method = record["method"].as_str()?;
    if !matches!(method, "session/update" | "_x.ai/session/update") {
        return None;
    }
    let params = record.get("params")?;
    if params["sessionId"].as_str()?.is_empty() {
        return None;
    }
    let seconds = i64::try_from(record["timestamp"].as_u64()?).ok()?;
    let timestamp = chrono::DateTime::from_timestamp(seconds, 0)?
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let update = params.get("update")?;
    let tag = update["sessionUpdate"].as_str()?;
    let (role, blocks) = if method == "session/update" {
        match tag {
            "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" => {
                let kind = if tag == "agent_thought_chunk" {
                    "thinking"
                } else {
                    "text"
                };
                let part = content(update.get("content")?, kind)?;
                (
                    if tag == "user_message_chunk" {
                        "user"
                    } else {
                        "assistant"
                    },
                    vec![part],
                )
            }
            "tool_call" => {
                let id = string(update, "toolCallId").filter(|id| !id.is_empty())?;
                let title = string(update, "title")?;
                let arguments = update
                    .get("rawInput")
                    .filter(|value| !value.is_null())
                    .map(Value::to_string)
                    .unwrap_or_default();
                let mut blocks = vec![block("tool_use", arguments, Some(id.clone()), Some(title))];
                blocks.extend(tool_output(update, &id));
                ("assistant", blocks)
            }
            "tool_call_update" => {
                let id = string(update, "toolCallId").filter(|id| !id.is_empty())?;
                ("tool", tool_output(update, &id))
            }
            "plan" => ("assistant", vec![block("text", plan(update)?, None, None)]),
            _ => return None,
        }
    } else {
        match tag {
            "plan_kept" => (
                "assistant",
                vec![block(
                    "text",
                    format!("Plan:\n{}", update["content"].as_str()?),
                    None,
                    None,
                )],
            ),
            // Turn outcomes and rewinds are control records, not new assistant messages.
            _ => return None,
        }
    };
    if blocks.is_empty() {
        return None;
    }
    // messageId is shared by streamed chunks; it is not a physical-record key.
    Some(
        json!({"id":format!("grok-record-{offset}"),"role":role,"blocks":blocks,"timestamp":timestamp}),
    )
}

fn content(value: &Value, kind: &str) -> Option<Value> {
    Some(match value["type"].as_str()? {
        "text" => block(kind, string(value, "text")?, None, None),
        "image" | "audio" | "resource" | "resource_link" => block(
            "image",
            "Attachment: view in the host agent terminal".into(),
            None,
            None,
        ),
        _ => return None,
    })
}

fn tool_output(update: &Value, id: &str) -> Vec<Value> {
    let parts: Vec<Value> = update["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| match part["type"].as_str()? {
            "content" => content(part.get("content")?, "tool_result").map(|mut value| {
                value["id"] = json!(id);
                value
            }),
            "diff" => Some(block(
                "tool_result",
                format!(
                    "Path: {}\nOld:\n{}\nNew:\n{}",
                    part["path"].as_str()?,
                    match part.get("oldText") {
                        None | Some(Value::Null) => "",
                        Some(value) => value.as_str()?,
                    },
                    part["newText"].as_str()?
                ),
                Some(id.into()),
                None,
            )),
            "terminal" => Some(block(
                "tool_result",
                "Terminal output: view in the host agent terminal".into(),
                Some(id.into()),
                None,
            )),
            _ => None,
        })
        .collect();
    if !parts.is_empty() {
        return parts;
    }
    update
        .get("rawOutput")
        .filter(|value| !value.is_null())
        .map(|value| {
            vec![block(
                "tool_result",
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string()),
                Some(id.into()),
                None,
            )]
        })
        .unwrap_or_default()
}

fn plan(update: &Value) -> Option<String> {
    let entries = update["entries"].as_array()?;
    let mut lines = vec!["Plan:".to_owned()];
    for entry in entries {
        let status = entry["status"].as_str()?;
        let priority = entry["priority"].as_str()?;
        if !matches!(status, "pending" | "in_progress" | "completed")
            || !matches!(priority, "high" | "medium" | "low")
        {
            return None;
        }
        lines.push(format!(
            "- [{status}] {} (priority: {priority})",
            entry["content"].as_str()?
        ));
    }
    Some(lines.join("\n"))
}
