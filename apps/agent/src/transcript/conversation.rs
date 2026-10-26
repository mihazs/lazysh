use super::{
    normalize, open_transcript, string, Error, Result, TranscriptAgent, TranscriptPage, MAX_PAGE,
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufReader, Cursor, Read},
    path::Path,
};

pub fn conversation(path: &Path, agent: TranscriptAgent, limit: u8) -> Result<TranscriptPage> {
    conversation_options(path, agent, limit, false)
}

pub fn claude_conversation_images(path: &Path, limit: u8) -> Result<TranscriptPage> {
    conversation_options(path, TranscriptAgent::Claude, limit, true)
}

fn conversation_options(
    path: &Path,
    agent: TranscriptAgent,
    limit: u8,
    inline_images: bool,
) -> Result<TranscriptPage> {
    if matches!(agent, TranscriptAgent::GrokAcp) {
        return super::grok_conversation::conversation(path, limit);
    }
    if !(1..=100).contains(&limit) || !matches!(agent, TranscriptAgent::Claude) {
        return Err(Error::InvalidArgument);
    }
    let bytes = capture(path)?;
    let size = bytes.len() as u64;
    let mut reader = Cursor::new(&bytes);
    let mut records = Vec::new();
    let mut offset = 0;
    while offset < size {
        let line = super::read_record_line(&mut reader)?;
        let bytes = line.len();
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
    drop(bytes);
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
        let message = if inline_images {
            super::normalize_images(record, agent, *position)
        } else {
            normalize(record, agent, *position)
        };
        if let Some(message) = message {
            let size = super::message_size(&message)?;
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

// Observe one initial prefix, allowing append-only growth without pausing Follow.
// Changed metadata requires one exact prefix comparison, never a capture retry.
fn capture(path: &Path) -> Result<Vec<u8>> {
    let mut file = open_transcript(path)?;
    let before = super::SourceSnapshot::capture(&file)?;
    drop(selected_source(path, &file, &before)?);
    #[cfg(test)]
    let source = super::mutation_observer::ObservedRead(&mut file);
    #[cfg(not(test))]
    let source = &mut file;
    let bytes = super::snapshot::read_bytes(&mut BufReader::new(source), before.len())?;
    if bytes.len() as u64 != before.len() {
        return Err(Error::InvalidEvent);
    }
    let mut selected = selected_source(path, &file, &before)?;
    let after = file.metadata()?;
    let selected_metadata = selected.metadata()?;
    if after.len() != before.len()
        || selected_metadata.len() != before.len()
        || after.modified()? != before.modified()?
        || selected_metadata.modified()? != before.modified()?
    {
        let mut chunk = [0; 8192];
        for expected in bytes.chunks(chunk.len()) {
            selected
                .read_exact(&mut chunk[..expected.len()])
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::UnexpectedEof {
                        Error::InvalidEvent
                    } else {
                        error.into()
                    }
                })?;
            #[cfg(test)]
            snapshot_audit::verify_observer();
            if chunk[..expected.len()] != *expected {
                return Err(Error::InvalidEvent);
            }
        }
        selected_source(path, &selected, &before)?;
        selected_source(path, &file, &before)?;
    }
    Ok(bytes)
}

fn selected_source(path: &Path, file: &File, before: &super::SourceSnapshot) -> Result<File> {
    let selected = open_transcript(path)?;
    for source in [file, &selected] {
        before.same_file(source)?;
        let after = source.metadata()?;
        if after.len() < before.len() {
            return Err(Error::InvalidEvent);
        }
    }
    Ok(selected)
}

fn candidate_results<'a>(
    record: &'a Value,
    index: usize,
    seen: &HashSet<usize>,
) -> Option<Vec<&'a str>> {
    if seen.contains(&index) || record["type"] != "user" || !is_main(record) {
        return None;
    }
    let calls = block_ids(record, "tool_result", "tool_use_id");
    if calls.is_empty() {
        None
    } else {
        Some(calls)
    }
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
        let Some(calls) = candidate_results(record, index, seen) else {
            continue;
        };
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
            let Some(calls) = candidate_results(record, index, seen) else {
                continue;
            };
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

#[cfg(test)]
mod snapshot_audit {
    use super::*;
    use serde_json::json;
    use std::{
        cell::RefCell,
        fs::{self, File, OpenOptions},
        io::Write,
    };

    thread_local! {
        static VERIFY: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
    }
    pub(super) fn verify_observer() {
        VERIFY.with(|slot| {
            if let Some(mutate) = slot.borrow_mut().take() {
                mutate();
            }
        });
    }
    fn row(id: &str, parent: Option<&str>, text: &str) -> String {
        format!(
            "{}\n",
            json!({"type":"assistant","uuid":id,"parentUuid":parent,"message":{"content":text}})
        )
    }
    fn source(fill: char) -> String {
        row("root", None, "owned root")
            + &row("answer", Some("root"), &fill.to_string().repeat(18000))
    }
    fn mutation(case: &'static str) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owned.jsonl");
        fs::write(&path, source('Q')).unwrap();
        let selected = path.clone();
        let detached = directory.path().join("detached.jsonl");
        let original_at = fs::metadata(&path).unwrap().modified().unwrap();
        let verify_path = path.clone();
        if case.ends_with("_verifying") {
            let verify_detached = directory.path().join("verify-detached.jsonl");
            VERIFY.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || match case {
                    "rename_verifying" => {
                        fs::rename(&verify_path, verify_detached).unwrap();
                        fs::write(&verify_path, source('Q')).unwrap();
                    }
                    "truncate_verifying" => fs::write(&verify_path, "").unwrap(),
                    "rewrite_verifying" => fs::write(&verify_path, source('Z')).unwrap(),
                    _ => OpenOptions::new()
                        .append(true)
                        .open(verify_path)
                        .unwrap()
                        .write_all(row("later", Some("new"), "later append").as_bytes())
                        .unwrap(),
                }))
            });
        }
        super::super::mutation_observer::set(move || {
            match case {
                "truncate" => fs::write(&selected, "").unwrap(),
                "rename" => {
                    fs::rename(&selected, detached).unwrap();
                    fs::write(&selected, source('Z')).unwrap();
                }
                "rename_same_mtime" => {
                    fs::rename(&selected, detached).unwrap();
                    fs::write(&selected, source('Z')).unwrap();
                    File::options()
                        .write(true)
                        .open(&selected)
                        .unwrap()
                        .set_modified(original_at)
                        .unwrap();
                }
                "rewrite" | "rewrite_append" => {
                    OpenOptions::new()
                        .write(true)
                        .open(&selected)
                        .unwrap()
                        .write_all(source('Z').as_bytes())
                        .unwrap();
                    if case == "rewrite_append" {
                        OpenOptions::new()
                            .append(true)
                            .open(&selected)
                            .unwrap()
                            .write_all(
                                row("new", Some("answer"), "new appended message").as_bytes(),
                            )
                            .unwrap();
                    }
                }
                "truncate_regrow" => {
                    fs::write(
                        &selected,
                        source('Z') + &row("new", Some("answer"), "new appended message"),
                    )
                    .unwrap();
                }
                case if case == "append" || case.ends_with("_verifying") => OpenOptions::new()
                    .append(true)
                    .open(&selected)
                    .unwrap()
                    .write_all(row("new", Some("answer"), "new appended message").as_bytes())
                    .unwrap(),
                _ => unreachable!(),
            }
            if case != "rename_same_mtime" {
                File::options()
                    .write(true)
                    .open(&selected)
                    .unwrap()
                    .set_modified(original_at + std::time::Duration::from_secs(2))
                    .unwrap();
            }
        });
        let result = conversation(&path, TranscriptAgent::Claude, 50);
        super::super::mutation_observer::clear();
        VERIFY.with(|slot| {
            assert!(
                slot.borrow_mut().take().is_none(),
                "verification mutation must actually run"
            );
        });
        if let Ok(page) = &result {
            let text = page
                .messages
                .iter()
                .flat_map(|message| message["blocks"].as_array().unwrap())
                .filter_map(|block| block["text"].as_str())
                .collect::<String>();
            eprintln!(
                "Claude mutation={case} accepted rows={} branch={:?} mixed_old_new={}",
                page.messages.len(),
                page.branch_id,
                text.contains('Q') && text.contains('Z')
            );
        }
        if matches!(case, "append" | "append_verifying") {
            let captured = result.unwrap();
            assert_eq!(captured.branch_id.as_deref(), Some("answer"));
            let next = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
            assert_eq!(
                next.branch_id.as_deref(),
                Some(if case == "append_verifying" {
                    "later"
                } else {
                    "new"
                })
            );
        } else {
            assert!(
                result.is_err(),
                "mutated Claude conversation accepted: {case}"
            );
        }
    }
    #[test]
    fn truncate_must_not_publish_shorter_branch() {
        mutation("truncate");
    }
    #[test]
    fn rename_must_not_publish_detached_branch() {
        mutation("rename");
    }
    #[test]
    fn rewrite_must_not_publish_mixed_text() {
        mutation("rewrite");
    }
    #[test]
    fn ordinary_append_keeps_captured_prefix_useful_for_follow() {
        mutation("append");
    }
    #[test]
    fn growth_does_not_hide_rewritten_or_truncated_prefix() {
        for case in ["rewrite_append", "truncate_regrow"] {
            mutation(case);
        }
    }
    #[test]
    #[cfg(any(unix, windows))]
    fn same_size_same_mtime_rename_is_rejected_by_original_identity() {
        mutation("rename_same_mtime");
    }
    #[test]
    fn append_during_comparison_is_accepted_without_recapture() {
        mutation("append_verifying");
    }
    #[test]
    fn comparison_cannot_admit_a_later_replacement_truncation_or_rewrite() {
        for case in [
            "rename_verifying",
            "truncate_verifying",
            "rewrite_verifying",
        ] {
            mutation(case);
        }
    }
    #[test]
    fn incomplete_tail_waits_for_newline_and_split_utf8_before_next_follow_read() {
        for split_utf8 in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("partial.jsonl");
            let first = row("root", None, "owned root");
            let second = row("answer", Some("root"), "owned é answer");
            let split = if split_utf8 {
                second
                    .as_bytes()
                    .iter()
                    .position(|byte| *byte == 0xc3)
                    .unwrap()
                    + 1
            } else {
                second.len() - 1
            };
            let mut bytes = first.as_bytes().to_vec();
            bytes.extend_from_slice(&second.as_bytes()[..split]);
            fs::write(&path, &bytes).unwrap();
            let partial = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
            assert_eq!(partial.branch_id.as_deref(), Some("root"));
            assert_eq!(partial.next_offset, first.len() as u64);
            assert!(!partial.has_more);
            assert_eq!(fs::read(&path).unwrap(), bytes);
            OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(&second.as_bytes()[split..])
                .unwrap();
            let completed = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
            assert_eq!(completed.branch_id.as_deref(), Some("answer"));
            assert_eq!(completed.next_offset, (first.len() + second.len()) as u64);
            assert_eq!(completed.messages[1]["blocks"][0]["text"], "owned é answer");
        }
    }
}
