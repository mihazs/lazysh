use super::{
    normalize, open_transcript, string, validate_message, Error, Result, TranscriptAgent,
    TranscriptPage, MAX_LINE, MAX_PAGE,
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read},
    path::Path,
};

pub fn conversation(path: &Path, agent: TranscriptAgent, limit: u8) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) || !matches!(agent, TranscriptAgent::Claude) {
        return Err(Error::InvalidArgument);
    }
    let file = open_transcript(path)?;
    let size = file.metadata()?.len();
    if size > 16 * 1024 * 1024 {
        return Err(Error::InvalidArgument);
    }
    let mut reader = BufReader::new(file.take(size));
    let mut records = Vec::new();
    let mut offset = 0;
    while offset < size {
        let mut line = Vec::new();
        let bytes = reader
            .by_ref()
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut line)?;
        if bytes as u64 > MAX_LINE {
            return Err(Error::InvalidEvent);
        }
        if line.last() != Some(&b'\n') {
            break;
        }
        if !line.iter().all(u8::is_ascii_whitespace) {
            let record: Value = serde_json::from_slice(&line).map_err(|_| Error::InvalidEvent)?;
            if !record.is_object() {
                return Err(Error::InvalidEvent);
            }
            if matches!(
                record["type"].as_str(),
                Some("user" | "assistant" | "progress" | "system" | "attachment")
            ) && record["uuid"].is_string()
            {
                records.push((offset, record));
                if records.len() > 10_000 {
                    return Err(Error::InvalidArgument);
                }
            }
        }
        offset += bytes as u64;
    }
    let latest: HashMap<String, usize> = records
        .iter()
        .enumerate()
        .filter_map(|(index, (_, record))| string(record, "uuid").map(|id| (id, index)))
        .collect();
    let records: Vec<_> = records
        .into_iter()
        .enumerate()
        .filter(|(index, (_, record))| {
            record["uuid"].as_str().and_then(|id| latest.get(id)) == Some(index)
        })
        .map(|(_, record)| record)
        .collect();
    let chain = active_chain(&records)?;
    let branch_id = chain
        .last()
        .and_then(|index| string(&records[*index].1, "uuid"));
    let mut messages = Vec::new();
    let mut output_bytes = 0;
    let mut truncated = false;
    for index in chain.into_iter().rev() {
        let (position, record) = &records[index];
        if let Some(message) = normalize(record, agent, *position) {
            validate_message(&message)?;
            let size = serde_json::to_vec(&message)
                .map_err(|_| Error::InvalidEvent)?
                .len();
            if messages.len() == usize::from(limit) || output_bytes + size > MAX_PAGE {
                truncated = true;
                break;
            }
            output_bytes += size;
            messages.push(message);
        }
    }
    messages.reverse();
    Ok(TranscriptPage {
        schema_version: 1,
        view: "active_branch",
        agent,
        messages,
        next_offset: offset,
        has_more: false,
        branch_id,
        truncated,
        checkpoint: None,
    })
}

fn active_chain(records: &[(u64, Value)]) -> Result<Vec<usize>> {
    let mut by_id = HashMap::new();
    let mut parents = HashSet::new();
    for (index, (_, record)) in records.iter().enumerate() {
        if let Some(id) = record["uuid"].as_str() {
            by_id.insert(id, index);
        }
        if let Some(parent) = record["parentUuid"].as_str() {
            parents.insert(parent);
        }
    }
    let mut leaves = HashSet::new();
    for (_, record) in records {
        let Some(id) = record["uuid"].as_str() else {
            continue;
        };
        if parents.contains(id) {
            continue;
        }
        let mut current = by_id.get(id).copied();
        let mut visited = HashSet::new();
        while let Some(index) = current {
            if !visited.insert(index) {
                return Err(Error::InvalidEvent);
            }
            let record = &records[index].1;
            if matches!(record["type"].as_str(), Some("user" | "assistant")) {
                if is_main(record) {
                    leaves.insert(index);
                }
                break;
            }
            current = record["parentUuid"]
                .as_str()
                .and_then(|parent| by_id.get(parent).copied());
        }
    }
    let Some(leaf) = leaves.into_iter().max() else {
        if !records.is_empty() && parents.len() >= by_id.len() {
            return Err(Error::InvalidEvent);
        }
        return Ok(Vec::new());
    };
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(leaf);
    while let Some(index) = current {
        if !seen.insert(index) {
            return Err(Error::InvalidEvent);
        }
        chain.push(index);
        current = records[index].1["parentUuid"]
            .as_str()
            .and_then(|parent| by_id.get(parent).copied());
    }
    chain.reverse();
    recover_parallel(records, &chain, &mut seen)
}

fn is_main(record: &Value) -> bool {
    record["isSidechain"] != true
        && record["isMeta"] != true
        && record.get("teamName").is_none_or(|v| v.is_null())
}
fn response_id(record: &Value) -> Option<&str> {
    (record["type"] == "assistant")
        .then(|| record["message"]["id"].as_str())
        .flatten()
}
fn block_ids<'a>(record: &'a Value, kind: &str, field: &str) -> Vec<&'a str> {
    record["message"]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == kind)
        .filter_map(|block| block[field].as_str())
        .collect()
}
fn same_writer(left: &Value, right: &Value) -> bool {
    (left["isSidechain"] == true) == (right["isSidechain"] == true)
        && left["agentId"] == right["agentId"]
}

fn recover_parallel(
    records: &[(u64, Value)],
    chain: &[usize],
    seen: &mut HashSet<usize>,
) -> Result<Vec<usize>> {
    let mut anchors = HashMap::new();
    for index in chain {
        if let Some(id) = response_id(&records[*index].1) {
            anchors.insert(id, *index);
        }
    }
    let mut groups: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut call_owners: HashMap<&str, Option<usize>> = HashMap::new();
    for (index, (_, record)) in records.iter().enumerate() {
        if let Some(id) = response_id(record) {
            groups.entry(id).or_default().push(index);
            for call in block_ids(record, "tool_use", "id") {
                match call_owners.get(call) {
                    None => {
                        call_owners.insert(call, Some(index));
                    }
                    Some(Some(previous)) if response_id(&records[*previous].1) == Some(id) => {
                        call_owners.insert(call, Some(index));
                    }
                    _ => {
                        call_owners.insert(call, None);
                    }
                }
            }
        }
    }
    let by_uuid: HashMap<&str, usize> = records
        .iter()
        .enumerate()
        .filter_map(|(index, (_, record))| record["uuid"].as_str().map(|id| (id, index)))
        .collect();
    let mut candidates: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, (_, record)) in records.iter().enumerate() {
        if seen.contains(&index) || record["type"] != "user" || !is_main(record) {
            continue;
        }
        let calls = block_ids(record, "tool_result", "tool_use_id");
        if calls.is_empty() {
            continue;
        }
        let mut possible = HashSet::new();
        for key in ["parentUuid", "sourceToolAssistantUUID"] {
            if let Some(owner) = record[key].as_str().and_then(|id| by_uuid.get(id)) {
                if key == "parentUuid" || same_writer(record, &records[*owner].1) {
                    if let Some(id) = response_id(&records[*owner].1) {
                        possible.insert(id);
                    }
                }
            }
        }
        for call in calls {
            if let Some(owner) = call_owners.get(call).and_then(|owner| *owner) {
                if same_writer(record, &records[owner].1) {
                    if let Some(id) = response_id(&records[owner].1) {
                        possible.insert(id);
                    }
                }
            }
        }
        for id in possible {
            candidates.entry(id).or_default().push(index);
        }
    }
    let mut answered: HashSet<&str> = chain
        .iter()
        .flat_map(|index| block_ids(&records[*index].1, "tool_result", "tool_use_id"))
        .collect();
    let mut inserts: HashMap<usize, Vec<usize>> = HashMap::new();
    for (id, anchor) in anchors {
        let members = &groups[id];
        let member_ids: HashSet<&str> = members
            .iter()
            .filter_map(|index| records[*index].1["uuid"].as_str())
            .collect();
        let mut siblings = members
            .iter()
            .copied()
            .filter(|index| {
                !seen.contains(index) && same_writer(&records[*index].1, &records[anchor].1)
            })
            .collect::<Vec<_>>();
        let mut results = Vec::new();
        for index in candidates.remove(id).unwrap_or_default() {
            let record = &records[index].1;
            if seen.contains(&index) || record["type"] != "user" || !is_main(record) {
                continue;
            }
            let calls = block_ids(record, "tool_result", "tool_use_id");
            if calls.is_empty() {
                continue;
            }
            let parent_is_member = record["parentUuid"]
                .as_str()
                .is_some_and(|parent| member_ids.contains(parent));
            let matches_call = calls.iter().any(|call| {
                !answered.contains(call)
                    && call_owners
                        .get(call)
                        .and_then(|owner| *owner)
                        .is_some_and(|owner| {
                            response_id(&records[owner].1) == Some(id)
                                && same_writer(record, &records[owner].1)
                        })
            });
            if parent_is_member || matches_call {
                answered.extend(calls);
                results.push(index);
            }
        }
        let key = |index: &usize| records[*index].1["timestamp"].as_str().unwrap_or("");
        siblings.sort_by_key(key);
        results.sort_by_key(key);
        siblings.extend(results);
        for index in &siblings {
            seen.insert(*index);
        }
        inserts.insert(anchor, siblings);
    }
    let mut result = Vec::new();
    for index in chain {
        result.push(*index);
        result.extend(inserts.remove(index).unwrap_or_default());
    }
    Ok(result)
}
