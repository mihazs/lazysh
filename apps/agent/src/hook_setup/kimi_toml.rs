//! Kimi Code `config.toml` lane: lazysh owns one deterministic `[[hooks]]` suffix at EOF and nothing else.
//! Every earlier byte, including comments, secrets, BOM and line endings, is carried over verbatim.
use super::json::Entry;
use super::json::{Fault, MAXIMUM};
use serde_json::Value;
use toml_edit::{DocumentMut, Item};

/// The four fields Kimi accepts are `event`, `matcher`, `command` and `timeout`; lazysh writes three.
#[derive(Debug, PartialEq)]
struct Hook {
    event: Option<String>,
    command: Option<String>,
    timeout: Option<i64>,
    fields: usize,
}
fn owned(entry: &Entry) -> Result<Hook, Fault> {
    let group = entry.group.as_object().filter(|group| group.len() == 3);
    let group = group.ok_or(Fault::Invalid)?;
    let text = |name: &str| group.get(name).and_then(Value::as_str).map(str::to_owned);
    let timeout = group.get("timeout").and_then(Value::as_i64);
    if text("event").as_deref() != Some(&entry.event)
        || !timeout.is_some_and(|t| (1..=600).contains(&t))
    {
        return Err(Fault::Invalid);
    }
    Ok(Hook {
        event: text("event"),
        command: Some(text("command").ok_or(Fault::Invalid)?),
        timeout,
        fields: 3,
    })
}
/// The owned text depends only on the entries, so it can be found again at EOF without the prefix.
pub(super) fn suffix(entries: &[Entry]) -> Result<String, Fault> {
    let quote = |text: &str| serde_json::to_string(text).map_err(|_| Fault::Invalid);
    let mut text = String::new();
    for entry in entries {
        let hook = owned(entry)?;
        text += &format!(
            "\n[[hooks]]\nevent = {}\ncommand = {}\ntimeout = {}\n",
            quote(hook.event.as_deref().unwrap_or_default())?,
            quote(hook.command.as_deref().unwrap_or_default())?,
            hook.timeout.unwrap_or_default()
        );
    }
    Ok(text)
}
fn hooks(text: &str) -> Result<Vec<Hook>, Fault> {
    // A leading BOM is the reader's concern in TOML, and the bytes stay untouched either way.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let document = text.parse::<DocumentMut>().map_err(|_| Fault::Invalid)?;
    match document.get("hooks") {
        None => Ok(vec![]),
        Some(Item::ArrayOfTables(tables)) => Ok(tables
            .iter()
            .map(|table| Hook {
                event: table.get("event").and_then(Item::as_str).map(str::to_owned),
                command: table
                    .get("command")
                    .and_then(Item::as_str)
                    .map(str::to_owned),
                timeout: table.get("timeout").and_then(Item::as_integer),
                fields: table.len(),
            })
            .collect()),
        // An inline `hooks = [...]` or a `[hooks]` table cannot take a `[[hooks]]` suffix.
        Some(_) => Err(Fault::Conflict),
    }
}
/// Replace exactly the owned EOF suffix; anything else at the end of the file is a conflict, never a rewrite.
pub(super) fn rewrite(input: &str, previous: &[Entry], next: &[Entry]) -> Result<String, Fault> {
    let prefix = input
        .strip_suffix(suffix(previous)?.as_str())
        .ok_or(Fault::Conflict)?;
    let foreign = hooks(prefix)?;
    let output = format!("{prefix}{}", suffix(next)?);
    if output.len() > MAXIMUM {
        return Err(Fault::Invalid);
    }
    let desired = next.iter().map(owned).collect::<Result<Vec<_>, _>>()?;
    let parsed = hooks(&output)?;
    // The result must be the foreign hooks followed by exactly ours, and no foreign twin of an owned hook.
    let twin = desired.iter().any(|ours| {
        foreign
            .iter()
            .any(|theirs| theirs.event == ours.event && theirs.command == ours.command)
    });
    if twin
        || parsed.len() != foreign.len() + desired.len()
        || parsed[foreign.len()..] != desired[..]
    {
        return Err(Fault::Conflict);
    }
    Ok(output)
}
