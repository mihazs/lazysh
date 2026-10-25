use super::{block, content, string};
use serde_json::{json, Value};

pub(super) fn copilot(record: &Value, offset: u64) -> Option<Value> {
    if record["ephemeral"] == true {
        return None;
    }
    let data = record.get("data")?;
    if data["parentToolCallId"]
        .as_str()
        .is_some_and(|id| !id.is_empty())
    {
        return None;
    }
    let (role, blocks) = match record["type"].as_str()? {
        "user.message" => {
            if data["source"]
                .as_str()
                .is_some_and(|source| source.starts_with("skill-") || source.starts_with("agent-"))
            {
                return None;
            }
            let mut blocks = vec![block("text", string(data, "content")?, None, None)];
            if data["attachments"]
                .as_array()
                .is_some_and(|attachments| !attachments.is_empty())
            {
                blocks.push(block(
                    "image",
                    "Attachments: view in the host agent terminal".into(),
                    None,
                    None,
                ));
            }
            ("user", blocks)
        }
        "assistant.message" => (
            "assistant",
            vec![block("text", string(data, "content")?, None, None)],
        ),
        "assistant.reasoning" => (
            "assistant",
            vec![block("thinking", string(data, "content")?, None, None)],
        ),
        "tool.execution_start" => (
            "assistant",
            vec![block(
                "tool_use",
                data.get("arguments")
                    .map(Value::to_string)
                    .unwrap_or_default(),
                string(data, "toolCallId"),
                string(data, "toolName"),
            )],
        ),
        "tool.execution_complete" => {
            let text = string(&data["result"], "detailedContent")
                .or_else(|| string(&data["result"], "content"))
                .or_else(|| string(&data["error"], "message"))?;
            (
                "tool",
                vec![block("tool_result", text, string(data, "toolCallId"), None)],
            )
        }
        _ => return None,
    };
    let mut message = json!({"id":string(record,"id").unwrap_or_else(||format!("record-{offset}")),"role":role,"blocks":blocks});
    if let Some(timestamp) = string(record, "timestamp") {
        message["timestamp"] = json!(timestamp);
    }
    if let Some(parent) = string(record, "parentId") {
        message["parentId"] = json!(parent);
    }
    if record["type"] == "assistant.message" {
        if let Some(tokens) = data["outputTokens"].as_u64() {
            message["usage"] = json!({"outputTokens":tokens});
        }
    }
    Some(message)
}

pub(super) fn kimi(record: &Value, offset: u64) -> Option<Value> {
    let role = record["role"].as_str()?;
    if !matches!(role, "user" | "assistant" | "tool") || record["partial"] == true {
        return None;
    }
    let raw = record.get("content")?;
    let mut blocks = Vec::new();
    if let Some(parts) = raw.as_array() {
        for part in parts {
            if part["type"] == "think" {
                if let Some(text) = string(part, "think") {
                    blocks.push(block("thinking", text, None, None));
                }
            } else {
                blocks.extend(content(&json!([part])));
            }
        }
    } else {
        blocks = content(raw);
    }
    if role == "tool" {
        blocks = vec![block(
            "tool_result",
            blocks
                .iter()
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            string(record, "tool_call_id"),
            string(record, "name"),
        )];
    }
    for call in record["tool_calls"].as_array().into_iter().flatten() {
        blocks.push(block(
            "tool_use",
            string(&call["function"], "arguments").unwrap_or_default(),
            string(call, "id"),
            string(&call["function"], "name"),
        ));
    }
    if blocks.is_empty() {
        return None;
    }
    Some(json!({"id":format!("record-{offset}"),"role":role,"blocks":blocks}))
}
