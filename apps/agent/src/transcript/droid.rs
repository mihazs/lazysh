use super::{content, string};
use serde_json::{json, Value};

/// Factory Droid 0.249.0 persisted message envelope, independently normalized.
/// Outer token metadata has no verified per-message accounting contract.
pub(super) fn normalize(record: &Value, offset: u64) -> Option<Value> {
    if record["type"] != "message" {
        return None;
    }
    let message = record.get("message")?;
    if message["hiddenFromUserViews"] == true
        || message["isUserVisible"] == false
        || message["visibility"] == "llm_only"
    {
        return None;
    }
    let role = message["role"].as_str()?;
    if !matches!(role, "user" | "assistant") {
        return None;
    }
    let blocks = content(message.get("content")?);
    if blocks.is_empty() {
        return None;
    }
    let mut result = json!({
        "id": string(record, "id").unwrap_or_else(|| format!("record-{offset}")),
        "role": role,
        "blocks": blocks,
    });
    for key in ["timestamp", "parentId"] {
        if let Some(value) = string(record, key) {
            result[key] = json!(value);
        }
    }
    Some(result)
}

pub(super) fn session_filename(path: &std::path::Path) -> bool {
    let Some(id) = path.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}
