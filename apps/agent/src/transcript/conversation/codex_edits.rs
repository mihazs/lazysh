use super::{Error, Result, Value};
use serde_json::json;

pub(super) fn counts(diff: &str) -> Option<(usize, usize)> {
    fn range(value: &str, prefix: char) -> Option<usize> {
        let value = value.strip_prefix(prefix)?;
        let (start, length) = value.split_once(',').unwrap_or((value, "1"));
        start.parse::<usize>().ok()?;
        length.parse().ok()
    }
    let (mut added, mut removed, mut hunk) = (0, 0, None::<(usize, usize)>);
    for line in diff.lines() {
        if let Some(header) = line.strip_prefix("@@ ") {
            if hunk.is_some_and(|remaining| remaining != (0, 0)) {
                return None;
            }
            let mut fields = header.split_whitespace();
            let old = range(fields.next()?, '-')?;
            let new = range(fields.next()?, '+')?;
            if fields.next()? != "@@" {
                return None;
            }
            hunk = Some((old, new));
        } else if line.starts_with('+') {
            let remaining = hunk.as_mut()?;
            remaining.1 = remaining.1.checked_sub(1)?;
            added += 1;
        } else if line.starts_with('-') {
            let remaining = hunk.as_mut()?;
            remaining.0 = remaining.0.checked_sub(1)?;
            removed += 1;
        } else if line.starts_with(' ') {
            let remaining = hunk.as_mut()?;
            remaining.0 = remaining.0.checked_sub(1)?;
            remaining.1 = remaining.1.checked_sub(1)?;
        } else if line != "\\ No newline at end of file" || hunk.is_none() {
            return None;
        }
    }
    (hunk == Some((0, 0))).then_some((added, removed))
}

pub(super) fn added_hunk(content: &str) -> String {
    content
        .split_inclusive('\n')
        .map(|line| format!("+{line}"))
        .collect()
}

pub(in crate::transcript) fn project(
    item: &Value,
    position: u64,
    completed: bool,
) -> Result<Value> {
    let id = item["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 4096)
        .ok_or(Error::InvalidEvent)?;
    let changes = item["changes"]
        .as_object()
        .filter(|changes| !changes.is_empty() && changes.len() <= 1000);
    let Some(changes) = changes else {
        return Ok(
            json!({"id":id,"role":"assistant","rev":position,"source":"transcript","partial":true,"parts":[{"type":"text","text":"File change details unavailable"}]}),
        );
    };
    let status = match (completed, item["status"].as_str()) {
        (true, Some("completed")) => Some("ok"),
        _ => None,
    };
    let mut parts = Vec::new();
    let mut partial = false;
    for (path, change) in changes {
        if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
            return Err(Error::InvalidEvent);
        }
        let edit = match change["type"].as_str() {
            Some("update") => change["unified_diff"].as_str().and_then(|diff| counts(diff).and_then(|(added,removed)| {
                let mut edit = json!({"kind":"edit","path":path,"added":added,"removed":removed,"hunks":[diff],"created":false});
                if !change["move_path"].is_null() {
                    let target = change["move_path"].as_str().filter(|target| !target.is_empty() && target.len() <= 4096 && !target.chars().any(char::is_control))?;
                    edit["movePath"] = json!(target);
                }
                Some(edit)
            })),
            Some("add") => change["content"].as_str().map(|content| {
                let hunk = added_hunk(content);
                json!({"kind":"edit","path":path,"added":content.lines().count(),"removed":0,"hunks":[hunk],"created":true})
            }),
            _ => None,
        };
        if let (Some(status), Some(edit)) = (status, edit) {
            parts.push(json!({"type":"tool","name":"fileChange","summary":path,"status":status,"call":edit}));
        } else {
            partial = true;
            let safe = json!({"type":change["type"].as_str(),"unified_diff":change["unified_diff"].as_str(),"content":change["content"].as_str(),"move_path":change["move_path"].as_str()});
            parts.push(json!({"type":"text","text":format!("File change {path}: {safe}")}));
        }
    }
    let mut message =
        json!({"id":id,"role":"assistant","rev":position,"source":"transcript","parts":parts});
    if partial {
        message["partial"] = json!(true);
    }
    Ok(message)
}
