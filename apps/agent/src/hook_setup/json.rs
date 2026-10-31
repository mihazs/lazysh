//! Validated edits retain foreign JSON values verbatim; owned groups and separators may change.
use serde::{de::Visitor, Deserialize, Deserializer};
use serde_json::{value::RawValue, Value};
use std::{collections::BTreeSet, fmt, ops::Range};

pub(super) const MAXIMUM: usize = 256 * 1024;
#[derive(Debug, PartialEq)]
pub(super) enum Fault {
    Invalid,
    Stale,
    Conflict,
}
type Result<T> = std::result::Result<T, Fault>;

struct Object<'a>(Vec<(String, &'a RawValue)>);
impl<'de> Deserialize<'de> for Object<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Object<'de>;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an object with unique keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut fields: Vec<(String, &'de RawValue)> = Vec::new();
                let mut seen = BTreeSet::new();
                while let Some((key, value)) = map.next_entry::<String, &'de RawValue>()? {
                    if !seen.insert(key.clone()) {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                    fields.push((key, value));
                }
                Ok(Object(fields))
            }
        }
        deserializer.deserialize_map(Fields)
    }
}
fn decode<'a, T: Deserialize<'a>>(input: &'a str) -> Result<T> {
    serde_json::from_str(input).map_err(|_| Fault::Invalid)
}
fn validate(value: &RawValue, depth: u8) -> Result<()> {
    if depth >= 64 {
        return Err(Fault::Invalid);
    }
    match value.get().as_bytes()[0] {
        b'{' => {
            for (_, value) in decode::<Object<'_>>(value.get())?.0 {
                validate(value, depth + 1)?;
            }
        }
        b'[' => {
            for value in decode::<Vec<&RawValue>>(value.get())? {
                validate(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn span(input: &str, value: &RawValue) -> Result<Range<usize>> {
    let start = (value.get().as_ptr() as usize)
        .checked_sub(input.as_ptr() as usize)
        .ok_or(Fault::Invalid)?;
    let end = start.checked_add(value.get().len()).ok_or(Fault::Invalid)?;
    (end <= input.len())
        .then_some(start..end)
        .ok_or(Fault::Invalid)
}
fn encoded(value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(|_| Fault::Invalid)
}
pub(super) fn document(input: &str) -> Result<&RawValue> {
    if input.is_empty() || input.len() > MAXIMUM {
        return Err(Fault::Invalid);
    }
    let root: &RawValue = decode(input)?;
    validate(root, 0)?;
    Ok(root)
}
fn append_member(
    input: &str,
    object: &RawValue,
    members: Vec<(String, Value)>,
) -> Result<(Range<usize>, String)> {
    let fields = decode::<Object<'_>>(object.get())?;
    let point = match fields.0.last() {
        Some((_, value)) => span(input, value)?.end,
        None => span(input, object)?.end - 1,
    };
    let mut text = String::new();
    for (index, (key, value)) in members.into_iter().enumerate() {
        if !fields.0.is_empty() || index > 0 {
            text.push(',');
        }
        text.push_str(&encoded(&Value::String(key))?);
        text.push(':');
        text.push_str(&encoded(&value)?);
    }
    Ok((point..point, text))
}

/// One independently owned matcher group per event; never a whole provider file.
#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Entry {
    pub event: String,
    pub group: Value,
}
fn entry<'a>(entries: &'a [Entry], event: &str) -> Option<&'a Value> {
    entries
        .iter()
        .find(|entry| entry.event == event)
        .map(|entry| &entry.group)
}
pub(super) fn rewrite(input: &str, previous: &[Entry], desired: &[Entry]) -> Result<String> {
    rewrite_map(input, previous, desired, false)
}
pub(super) fn rewrite_standalone(
    input: &str,
    previous: &[Entry],
    desired: &[Entry],
) -> Result<String> {
    rewrite_map(input, previous, desired, true)
}
fn event_map(root: &RawValue, standalone: bool) -> Result<Option<&RawValue>> {
    let fields: Object<'_> = decode(root.get())?;
    if standalone {
        // A settings envelope must never be mistaken for a standalone event map.
        for (_, value) in &fields.0 {
            let _: Vec<&RawValue> = decode(value.get())?;
        }
        Ok(Some(root))
    } else {
        Ok(fields
            .0
            .into_iter()
            .find(|(key, _)| key == "hooks")
            .map(|(_, value)| value))
    }
}
fn rewrite_map(
    input: &str,
    previous: &[Entry],
    desired: &[Entry],
    standalone: bool,
) -> Result<String> {
    let root = document(input)?;
    for entries in [previous, desired] {
        let mut seen = BTreeSet::new();
        if entries
            .iter()
            .any(|entry| !seen.insert(&entry.event) || !entry.group.is_object())
        {
            return Err(Fault::Invalid);
        }
    }
    let hooks = event_map(root, standalone)?;
    let Some(hooks) = hooks else {
        if !previous.is_empty() {
            return Err(Fault::Stale);
        }
        if desired.is_empty() {
            return Ok(input.into());
        }
        let value: serde_json::Map<String, Value> = desired
            .iter()
            .map(|entry| (entry.event.clone(), Value::Array(vec![entry.group.clone()])))
            .collect();
        let (range, text) =
            append_member(input, root, vec![("hooks".into(), Value::Object(value))])?;
        let mut output = input.to_owned();
        output.replace_range(range, &text);
        document(&output)?;
        return Ok(output);
    };
    let events: Object<'_> = decode(hooks.get())?;
    let names: BTreeSet<_> = previous
        .iter()
        .chain(desired)
        .map(|entry| entry.event.as_str())
        .collect();
    let mut changes = Vec::new();
    let mut new_events = Vec::new();
    for name in names {
        let old = entry(previous, name);
        let new = entry(desired, name);
        let array = events
            .0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| *value);
        let Some(array) = array else {
            if old.is_some() {
                return Err(Fault::Stale);
            }
            if let Some(new) = new {
                new_events.push((name.to_owned(), Value::Array(vec![new.clone()])));
            }
            continue;
        };
        let groups: Vec<&RawValue> = decode(array.get())?;
        let values: Vec<Value> = groups
            .iter()
            .map(|group| decode(group.get()))
            .collect::<Result<_>>()?;
        let owned: Vec<usize> = values
            .iter()
            .enumerate()
            .filter_map(|(index, group)| old.filter(|old| *old == group).map(|_| index))
            .collect();
        if old.is_some() && owned.len() != 1 {
            return Err(Fault::Stale);
        }
        let index = owned.first().copied();
        if new.is_some_and(|new| {
            values
                .iter()
                .enumerate()
                .any(|(position, value)| Some(position) != index && value == new)
        }) {
            return Err(Fault::Conflict);
        }
        match (index, new) {
            (Some(index), Some(new)) if Some(new) != old => {
                changes.push((span(input, groups[index])?, encoded(new)?));
            }
            (Some(index), None) => {
                let current = span(input, groups[index])?;
                let range = if index + 1 < groups.len() {
                    current.start..span(input, groups[index + 1])?.start
                } else if index > 0 {
                    span(input, groups[index - 1])?.end..current.end
                } else {
                    current
                };
                changes.push((range, String::new()));
            }
            (None, Some(new)) => {
                let (point, separator) = match groups.last() {
                    Some(last) => (span(input, last)?.end, ","),
                    None => (span(input, array)?.end - 1, ""),
                };
                changes.push((point..point, format!("{separator}{}", encoded(new)?)));
            }
            _ => {}
        }
    }
    if !new_events.is_empty() {
        changes.push(append_member(input, hooks, new_events)?);
    }
    changes.sort_by_key(|change| std::cmp::Reverse(change.0.start));
    let mut output = input.to_owned();
    for (range, text) in changes {
        output.replace_range(range, &text);
    }
    document(&output)?;
    Ok(output)
}

pub(super) fn counts(input: &str, entries: &[Entry], standalone: bool) -> Result<Vec<usize>> {
    let root = document(input)?;
    let Some(hooks) = event_map(root, standalone)? else {
        return Ok(vec![0; entries.len()]);
    };
    let hooks: Object<'_> = decode(hooks.get())?;
    entries
        .iter()
        .map(|entry| {
            let Some((_, groups)) = hooks.0.iter().find(|(key, _)| key == &entry.event) else {
                return Ok(0);
            };
            let groups: Vec<&RawValue> = decode(groups.get())?;
            let mut count = 0;
            for group in groups {
                count += usize::from(decode::<Value>(group.get())? == entry.group);
            }
            Ok(count)
        })
        .collect()
}

/// Cursor requires its existing integer version 1, or explicit initialization on install.
/// Preserve the field on uninstall; it is shared provider schema, not an owned hook.
pub(super) fn cursor_document(input: &str, insert_missing: bool) -> Result<String> {
    let root = document(input)?;
    let fields: Object<'_> = decode(root.get())?;
    if let Some((_, version)) = fields.0.iter().find(|(key, _)| key == "version") {
        return if decode::<Value>(version.get())?.as_u64() == Some(1) {
            Ok(input.into())
        } else {
            Err(Fault::Invalid)
        };
    }
    if !insert_missing {
        return Err(Fault::Invalid);
    }
    let (range, text) = append_member(input, root, vec![("version".into(), Value::from(1))])?;
    let mut output = input.to_owned();
    output.replace_range(range, &text);
    document(&output)?;
    Ok(output)
}
