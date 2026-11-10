use super::{codex_edits, Value};
use serde_json::json;

pub(super) fn project(name: &str, input: &str, result: &Value) -> Option<Value> {
    let input: Value = serde_json::from_str(input).ok()?;
    let path = input["file_path"].as_str().filter(|path| {
        !path.is_empty() && path.len() <= 4096 && !path.chars().any(char::is_control)
    })?;
    if result["filePath"].as_str()? != path {
        return None;
    }
    let patch = result["structuredPatch"]
        .as_array()
        .filter(|patch| patch.len() <= 1000)?;
    if name == "Write" && result["type"] == "create" && patch.is_empty() {
        if result["originalFileIsNull"] != true {
            return None;
        }
        let content = result["content"].as_str()?;
        return Some(
            json!({"kind":"edit","path":path,"added":content.lines().count(),"removed":0,"hunks":[codex_edits::added_hunk(content)],"created":true}),
        );
    }
    if patch.is_empty()
        || !(name == "Edit" && result["type"].is_null()
            || name == "Write" && result["type"] == "update")
    {
        return None;
    }
    let mut hunks = Vec::new();
    let (mut added, mut removed) = (0, 0);
    let (mut old_end, mut new_end) = (0, 0);
    for hunk in patch {
        let (old_start, old_lines) = (hunk["oldStart"].as_u64()?, hunk["oldLines"].as_u64()?);
        let (new_start, new_lines) = (hunk["newStart"].as_u64()?, hunk["newLines"].as_u64()?);
        let old_begin = if old_lines == 0 {
            old_start
        } else {
            old_start.checked_sub(1)?
        };
        let new_begin = if new_lines == 0 {
            new_start
        } else {
            new_start.checked_sub(1)?
        };
        if old_begin < old_end || new_begin < new_end {
            return None;
        }
        old_end = old_begin.checked_add(old_lines)?;
        new_end = new_begin.checked_add(new_lines)?;
        let lines = hunk["lines"]
            .as_array()
            .filter(|lines| lines.len() <= 10000)?;
        let lines = lines
            .iter()
            .map(|line| line.as_str().filter(|line| !line.contains('\n')))
            .collect::<Option<Vec<_>>>()?;
        let diff = format!(
            "@@ -{},{} +{},{} @@\n{}",
            old_start,
            old_lines,
            new_start,
            new_lines,
            lines.join("\n")
        );
        let (a, r) = codex_edits::counts(&diff)?;
        added += a;
        removed += r;
        hunks.push(diff);
    }
    Some(
        json!({"kind":"edit","path":path,"added":added,"removed":removed,"hunks":hunks,"created":false}),
    )
}
