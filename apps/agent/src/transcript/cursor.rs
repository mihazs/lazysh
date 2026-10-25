use super::content;
use serde_json::{json, Value};

/// Cursor IDE 3.27.12 JSONL export: thinking is already combined with text;
/// tool results, timestamps and stable message IDs are not exported.
pub(super) fn normalize(record: &Value, offset: u64) -> Option<Value> {
    let role = record["role"].as_str()?;
    if !matches!(role, "user" | "assistant") || record.get("type").is_some() {
        return None;
    }
    let parts = record["message"]["content"].as_array()?;
    let supported = Value::Array(
        parts
            .iter()
            .filter(|part| matches!(part["type"].as_str(), Some("text" | "tool_use")))
            .cloned()
            .collect(),
    );
    let blocks = content(&supported);
    if blocks.is_empty() {
        return None;
    }
    Some(json!({"id":format!("record-{offset}"),"role":role,"blocks":blocks}))
}

pub(super) fn session_path(path: &std::path::Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    // Legacy flat files or current <conversation>/<conversation>.jsonl only.
    parent
        .file_name()
        .is_some_and(|name| name == "agent-transcripts")
        || (parent
            .parent()
            .and_then(std::path::Path::file_name)
            .is_some_and(|name| name == "agent-transcripts")
            && parent.file_name() == path.file_stem())
}
