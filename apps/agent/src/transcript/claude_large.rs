//! A bounded index of Claude records. Message bodies are re-read only for the requested page.
use super::conversation::{
    active_chain, activity, claude_message, is_conversation_record, is_main, prepare_records,
    ClaudeContext,
};
use super::window::{self, Window};
use super::{
    message_size, Error, Result, SourceSnapshot, TranscriptAgent, TranscriptPage, MAX_PAGE,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
};

const MAX_RECORD: u64 = 4 * 1024 * 1024;
const MAX_RECORDS: usize = 100_000;
const MAX_INDEX: usize = 32 * 1024 * 1024;

#[cfg(test)]
thread_local! {
    static SCANNED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(super) fn take_scanned() -> usize {
    SCANNED.with(|count| count.replace(0))
}

struct RecordInfo {
    length: usize,
    hash: [u8; 32],
    message: Option<(String, usize)>,
}

fn metadata(record: &Value) -> Value {
    let mut result = record.clone();
    if let Some(object) = result.as_object_mut() {
        object.retain(|key, _| {
            matches!(
                key.as_str(),
                "type"
                    | "uuid"
                    | "parentUuid"
                    | "logicalParentUuid"
                    | "subtype"
                    | "isSidechain"
                    | "isMeta"
                    | "pendingBackgroundAgentCount"
                    | "teamName"
                    | "agentId"
                    | "sourceToolAssistantUUID"
                    | "timestamp"
                    | "cwd"
                    | "gitBranch"
                    | "message"
                    | "attachment"
            )
        });
    }
    if result["type"] == "attachment" && result["attachment"]["type"] != "goal_status" {
        result.as_object_mut().unwrap().remove("attachment");
    }
    if let Some(message) = result["message"].as_object_mut() {
        message.retain(|key, _| {
            matches!(
                key.as_str(),
                "id" | "role" | "model" | "usage" | "stop_reason" | "content"
            )
        });
        if let Some(content) = message.get_mut("content") {
            match content {
                Value::Array(parts) => {
                    for part in parts {
                        if let Some(object) = part.as_object_mut() {
                            object.retain(|key, value| {
                                matches!(key.as_str(), "type" | "id" | "tool_use_id" | "name")
                                    || (key == "text"
                                        && value.as_str().is_some_and(|text| {
                                            text.starts_with("[Request interrupted")
                                        }))
                            });
                        }
                    }
                }
                Value::String(text) if !text.starts_with("[Request interrupted") => text.clear(),
                _ => {}
            }
        }
    }
    result
}

fn read_record(file: &mut File, offset: u64, info: &RecordInfo) -> Result<Value> {
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0; info.length];
    file.read_exact(&mut bytes)
        .map_err(|_| Error::InvalidEvent)?;
    let hash: [u8; 32] = Sha256::digest(&bytes).into();
    if hash != info.hash {
        return Err(Error::InvalidEvent);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::InvalidEvent)
}

/// The prefix records that carry queue and session state, which are small and start with their type. Other lines are
/// skipped without being parsed. shortcut: this still reads the prefix once and drops state lines over 1 MiB; index it if reads get slow.
fn state_lines(file: &mut File, end: u64) -> Result<Vec<u8>> {
    const STATE: [&[u8]; 4] = [
        br#"{"type":"queue-operation""#,
        br#"{"type":"permission-mode""#,
        br#"{"type":"cost-state""#,
        br#"{"type":"worktree-state""#,
    ];
    const CHUNK: u64 = 1024 * 1024;
    file.seek(SeekFrom::Start(0))?;
    let mut reader = BufReader::new(file.take(end));
    let (mut state, mut chunk) = (Vec::new(), Vec::new());
    loop {
        chunk.clear();
        if (&mut reader).take(CHUNK).read_until(b'\n', &mut chunk)? == 0 {
            return Ok(state);
        }
        let mut whole = chunk.last() == Some(&b'\n');
        if STATE.iter().any(|prefix| chunk.starts_with(prefix)) && whole {
            state.extend_from_slice(&chunk);
        }
        while !whole {
            chunk.clear();
            whole = (&mut reader).take(CHUNK).read_until(b'\n', &mut chunk)? == 0
                || chunk.last() == Some(&b'\n');
        }
    }
}

/// Try the newest page from a bounded complete-line suffix before indexing older records.
fn tail(
    open: &impl Fn() -> Result<File>,
    limit: u8,
    images: bool,
    expected_session_id: Option<&str>,
    window: &Window,
) -> Result<Option<TranscriptPage>> {
    let mut file = open()?;
    let before = SourceSnapshot::capture(&file)?;
    before.same_file(&open()?)?;
    const INITIAL_SUFFIX: u64 = 1024 * 1024;
    if before.len() <= INITIAL_SUFFIX {
        return Ok(None);
    }
    let mut size = INITIAL_SUFFIX;
    loop {
        let start = before.len().saturating_sub(size);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; (before.len() - start) as usize];
        file.read_exact(&mut bytes)?;
        #[cfg(test)]
        SCANNED.with(|count| count.set(count.get() + bytes.len()));
        let body_start = if start == 0 {
            Some(0)
        } else {
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|position| position + 1)
        };
        if let Some(body_start) = body_start {
            let project = |bytes: Vec<u8>| {
                super::conversation::project_claude_bounded(
                    bytes,
                    limit,
                    images,
                    MAX_RECORD,
                    MAX_RECORDS,
                    expected_session_id,
                    window,
                )
            };
            if let Ok(mut page) = project(bytes[body_start..].to_vec()) {
                if page.truncated || start == 0 {
                    let mut selected = open()?;
                    before.same_file(&selected)?;
                    if selected.metadata()?.len() < before.len() {
                        return Err(Error::InvalidEvent);
                    }
                    selected.seek(SeekFrom::Start(start))?;
                    let mut check = vec![0; bytes.len()];
                    selected
                        .read_exact(&mut check)
                        .map_err(|_| Error::InvalidEvent)?;
                    if check != bytes {
                        return Err(Error::InvalidEvent);
                    }
                    if start > 0 {
                        // The prefix holds the queue and session state the suffix alone would lose.
                        let mut state = state_lines(&mut open()?, start + body_start as u64)?;
                        state.extend_from_slice(&bytes[body_start..]);
                        page = project(state)?;
                    }
                    page.next_offset = before.len();
                    return Ok(Some(page));
                }
            }
        }
        if start == 0 || size >= 8 * INITIAL_SUFFIX {
            return Ok(None);
        }
        size = size.saturating_mul(2).min(before.len());
    }
}

pub(super) fn read(
    open: impl Fn() -> Result<File>,
    limit: u8,
    images: bool,
    window: &Window,
    expected_session_id: Option<&str>,
) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    if matches!(window, Window::Tail | Window::Before(_)) {
        if let Some(page) = tail(&open, limit, images, expected_session_id, window)? {
            return Ok(page);
        }
    }
    let mut file = open()?;
    let before = SourceSnapshot::capture(&file)?;
    before.same_file(&open()?)?;
    let mut records = Vec::new();
    let mut info = HashMap::new();
    let mut context = ClaudeContext::default();
    let (mut offset, mut index_size) = (0u64, 0usize);
    let mut digest = Sha256::new();
    {
        let mut reader = BufReader::new((&mut file).take(before.len()));
        while offset < before.len() {
            let line = super::read_record_line_bounded(&mut reader, MAX_RECORD)?;
            let length = line.len();
            #[cfg(test)]
            SCANNED.with(|count| count.set(count.get() + length));
            digest.update(&line);
            if line.last() != Some(&b'\n') {
                break;
            }
            if !line.iter().all(u8::is_ascii_whitespace) {
                let record: Value =
                    serde_json::from_slice(&line).map_err(|_| Error::InvalidEvent)?;
                context.observe(&record, expected_session_id)?;
                if is_conversation_record(&record) {
                    let mut for_message = record.clone();
                    for_message["isSidechain"] = Value::Bool(false);
                    let message = claude_message(&for_message, images, offset);
                    let message = message
                        .map(|message| {
                            Ok::<_, Error>((
                                message["id"]
                                    .as_str()
                                    .ok_or(Error::InvalidEvent)?
                                    .to_owned(),
                                message_size(&message)?,
                            ))
                        })
                        .transpose()?;
                    let meta = metadata(&record);
                    index_size = index_size
                        .checked_add(
                            serde_json::to_vec(&meta)
                                .map_err(|_| Error::InvalidEvent)?
                                .len()
                                + 64,
                        )
                        .ok_or(Error::TooLarge)?;
                    if records.len() >= MAX_RECORDS || index_size > MAX_INDEX {
                        return Err(Error::TooLarge);
                    }
                    records.push((offset, meta));
                    info.insert(
                        offset,
                        RecordInfo {
                            length,
                            hash: Sha256::digest(&line).into(),
                            message,
                        },
                    );
                }
            }
            offset += length as u64;
        }
    }
    context.verify(expected_session_id)?;
    let (records, own_file) = prepare_records(records);
    let (chain, leaf) = active_chain(&records)?;
    let activity = leaf.and_then(|index| activity(&records, index));
    let mut failed = None;
    let work = super::work::tasks(chain.iter().map(|index| {
        let position = records[*index].0;
        match read_record(&mut file, position, &info[&position]) {
            Ok(record) => record,
            Err(error) => {
                failed = Some(error);
                Value::Null
            }
        }
    }));
    if let Some(error) = failed {
        return Err(error);
    }
    let (queued, session) = context.finish(&records, &chain);
    let branch_id = chain
        .last()
        .and_then(|index| super::string(&records[*index].1, "uuid"));
    let messages: Vec<_> = chain
        .into_iter()
        .filter_map(|index| {
            let (position, record) = &records[index];
            if matches!(record["type"].as_str(), Some("user" | "assistant")) && !is_main(record) {
                return None;
            }
            info[position]
                .message
                .as_ref()
                .map(|(id, size)| (*position, id, *size))
        })
        .collect();
    let (forward, at) = window::position(window, messages.len(), |id| {
        messages
            .iter()
            .position(|(_, candidate, _)| *candidate == id)
            .ok_or(Error::InvalidArgument)
    })?;
    let (mut lo, mut hi, mut bytes) = (at, at, 0);
    while hi - lo < usize::from(limit) {
        let Some(next) = (if forward {
            (hi < messages.len()).then_some(hi)
        } else {
            lo.checked_sub(1)
        }) else {
            break;
        };
        let size = messages[next].2;
        if bytes + size > MAX_PAGE {
            break;
        }
        bytes += size;
        if forward {
            hi += 1;
        } else {
            lo = next;
        }
    }
    if lo == hi && (if forward { hi < messages.len() } else { lo > 0 }) {
        return Err(Error::InvalidEvent);
    }
    let mut selected = Vec::new();
    for (position, id, _) in &messages[lo..hi] {
        let mut record = read_record(&mut file, *position, &info[position])?;
        if own_file {
            record["isSidechain"] = Value::Bool(false);
        }
        let message = claude_message(&record, images, *position).ok_or(Error::InvalidEvent)?;
        if message["id"].as_str() != Some(id) {
            return Err(Error::InvalidEvent);
        }
        selected.push(message);
    }
    let mut selected_file = open()?;
    before.same_file(&selected_file)?;
    let after = selected_file.metadata()?;
    if after.len() < before.len() {
        return Err(Error::InvalidEvent);
    }
    if after.len() != before.len() || after.modified()? != before.modified()? {
        let expected: [u8; 32] = digest.finalize().into();
        let mut check = Sha256::new();
        let mut buffer = [0u8; 8192];
        let mut remaining = before.len();
        while remaining > 0 {
            let count = buffer.len().min(remaining as usize);
            selected_file
                .read_exact(&mut buffer[..count])
                .map_err(|_| Error::InvalidEvent)?;
            check.update(&buffer[..count]);
            remaining -= count as u64;
        }
        if <[u8; 32]>::from(check.finalize()) != expected {
            return Err(Error::InvalidEvent);
        }
    }
    before.same_file(&open()?)?;
    Ok(TranscriptPage {
        schema_version: 1,
        view: "active_branch",
        agent: TranscriptAgent::Claude,
        messages: selected,
        next_offset: offset,
        has_more: false,
        branch_id,
        truncated: lo > 0,
        has_newer: hi < messages.len(),
        checkpoint: None,
        activity,
        queued,
        work: (!work.is_empty()).then_some(work),
        session,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn index_preserves_branches_parallel_tool_results_and_session_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("parallel.jsonl");
        let call = |id: &str, parent: &str, call_id: &str| json!({"type":"assistant","uuid":id,"parentUuid":parent,"message":{"id":"response1","model":"model","content":[{"type":"tool_use","id":call_id,"name":"Read","input":{}}]}});
        let result = |id: &str, parent: &str, call_id: &str| json!({"type":"user","uuid":id,"parentUuid":parent,"message":{"content":[{"type":"tool_result","tool_use_id":call_id,"content":"result"}]}});
        let rows = [
            json!({"type":"user","uuid":"root","message":{"content":"question"}}),
            json!({"type":"assistant","uuid":"old","parentUuid":"root","message":{"content":"abandoned"}}),
            call("a1", "root", "tool1"),
            call("a2", "a1", "tool2"),
            result("r2", "a2", "tool2"),
            result("r1", "a1", "tool1"),
            result("wrong", "root", "unrelated"),
            json!({"type":"assistant","uuid":"done","parentUuid":"r1","message":{"content":"summary"}}),
        ];
        fs::write(
            &path,
            rows.iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        for window in [
            Window::Tail,
            Window::Start,
            Window::Before("done".into()),
            Window::After("a1".into()),
        ] {
            let expected = super::super::conversation::conversation_window(
                &path,
                TranscriptAgent::Claude,
                2,
                false,
                &window,
            )
            .unwrap();
            let actual = read(
                || super::super::open_transcript(&path),
                2,
                false,
                &window,
                None,
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(expected).unwrap(),
                "{window:?}"
            );
        }
    }

    #[test]
    fn indexed_pages_match_the_existing_projection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.jsonl");
        fs::write(
            &path,
            include_str!("../../tests/fixtures/claude-events.jsonl"),
        )
        .unwrap();
        let full = super::super::conversation::conversation_window(
            &path,
            TranscriptAgent::Claude,
            100,
            false,
            &Window::Tail,
        )
        .unwrap();
        let first = full.messages.first().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let last = full.messages.last().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        for window in [
            Window::Tail,
            Window::Start,
            Window::After(first),
            Window::Before(last),
        ] {
            for limit in [1, 5, 100] {
                let expected = super::super::conversation::conversation_window(
                    &path,
                    TranscriptAgent::Claude,
                    limit,
                    false,
                    &window,
                )
                .unwrap();
                let actual = read(
                    || super::super::open_transcript(&path),
                    limit,
                    false,
                    &window,
                    None,
                )
                .unwrap();
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(expected).unwrap(),
                    "{window:?} limit {limit}"
                );
            }
        }
    }
}
