use super::window::{select, Window};
use super::{normalize, open_transcript, string, Error, Result, TranscriptAgent, TranscriptPage};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufReader, Cursor, Read},
    path::Path,
};

pub fn conversation(path: &Path, agent: TranscriptAgent, limit: u8) -> Result<TranscriptPage> {
    conversation_options(path, agent, limit, false, &Window::Tail)
}

pub fn claude_conversation_images(path: &Path, limit: u8) -> Result<TranscriptPage> {
    conversation_options(path, TranscriptAgent::Claude, limit, true, &Window::Tail)
}

/// The Codex conversation with bounded previews of the images the user attached.
pub fn codex_conversation_images(path: &Path, limit: u8) -> Result<TranscriptPage> {
    conversation_options(path, TranscriptAgent::Codex, limit, true, &Window::Tail)
}

/// One page of the active branch at any position of the session, for reading it from the first message.
pub fn conversation_window(
    path: &Path,
    agent: TranscriptAgent,
    limit: u8,
    inline_images: bool,
    window: &Window,
) -> Result<TranscriptPage> {
    conversation_options(path, agent, limit, inline_images, window)
}

pub fn conversation_window_large(
    path: &Path,
    agent: TranscriptAgent,
    limit: u8,
    inline_images: bool,
    window: &Window,
    allow_large: bool,
) -> Result<TranscriptPage> {
    if allow_large && matches!(agent, TranscriptAgent::Codex) {
        if !(1..=100).contains(&limit) {
            return Err(Error::InvalidArgument);
        }
        return super::codex_conversation::conversation_large(path, limit, inline_images, window);
    }
    conversation_window(path, agent, limit, inline_images, window)
}

fn conversation_options(
    path: &Path,
    agent: TranscriptAgent,
    limit: u8,
    inline_images: bool,
    window: &Window,
) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    if matches!(agent, TranscriptAgent::Codex) {
        return super::codex_conversation::conversation(path, limit, inline_images, window);
    }
    if matches!(agent, TranscriptAgent::GrokAcp) {
        return super::grok_conversation::conversation(path, limit, window);
    }
    if matches!(agent, TranscriptAgent::Gemini) {
        return super::gemini_conversation::conversation(path, limit, window);
    }
    if !matches!(agent, TranscriptAgent::Claude) {
        return Err(Error::InvalidArgument);
    }
    let size = open_transcript(path)?.metadata()?.len();
    let mut page = if size > lazysh_common::record_checkpoint::MAX_SNAPSHOT {
        super::claude_large::read(|| open_transcript(path), limit, inline_images, window, None)?
    } else {
        project_claude(capture(path)?, limit, inline_images, window)?
    };
    super::work::attach_children(&mut page, path);
    Ok(page)
}

pub(super) fn project_claude(
    bytes: Vec<u8>,
    limit: u8,
    inline_images: bool,
    window: &Window,
) -> Result<TranscriptPage> {
    project_claude_bounded(
        bytes,
        limit,
        inline_images,
        super::MAX_LINE,
        MAX_RECORDS,
        None,
        window,
    )
}

/// A 16 MiB snapshot holds at most this many records of any realistic size; the cap stops a file of
/// tiny records from costing more memory than the snapshot budget implies.
const MAX_RECORDS: usize = 100_000;

/// One Claude record as a page message. A block longer than the client accepts is cut and says so, never refused.
pub(super) fn claude_message(record: &Value, inline_images: bool, position: u64) -> Option<Value> {
    let mut message = super::events::claude(record).or_else(|| {
        if inline_images {
            super::normalize_images(record, TranscriptAgent::Claude, position)
        } else {
            normalize(record, TranscriptAgent::Claude, position)
        }
    })?;
    super::codex_conversation::fit(&mut message);
    Some(message)
}

pub(super) fn is_conversation_record(record: &Value) -> bool {
    matches!(
        record["type"].as_str(),
        Some("user" | "assistant" | "progress" | "system" | "attachment")
    ) && record["uuid"].is_string()
}

#[derive(Default)]
pub(super) struct ClaudeContext {
    queue: Queue,
    roster: super::session_roster::Roster,
    session_seen: bool,
    permission_mode: Option<Value>,
    cost_usd: Option<f64>,
    worktree: Option<String>,
}

impl ClaudeContext {
    pub(super) fn observe(&mut self, record: &Value, expected: Option<&str>) -> Result<()> {
        if !record.is_object() {
            return Err(Error::InvalidEvent);
        }
        if let (Some(expected), Some(value)) = (expected, record.get("sessionId")) {
            if value.as_str() != Some(expected) {
                return Err(Error::InvalidEvent);
            }
            self.session_seen = true;
        }
        match record["type"].as_str() {
            Some("queue-operation") => self.queue.apply(record),
            Some("attachment") => self.roster.apply(record),
            Some("permission-mode") => self.permission_mode = record.get("permissionMode").cloned(),
            Some("cost-state") => self.cost_usd = record["totalCostUSD"].as_f64(),
            Some("worktree-state") => {
                self.worktree = record["worktreeSession"]["worktreeName"]
                    .as_str()
                    .map(str::to_owned)
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn verify(&self, expected: Option<&str>) -> Result<()> {
        if expected.is_some() && !self.session_seen {
            return Err(Error::InvalidEvent);
        }
        Ok(())
    }

    pub(super) fn finish(
        self,
        records: &[(u64, Value)],
        chain: &[usize],
    ) -> (Vec<Value>, Option<Value>) {
        let session = super::session_info::Session::claude(
            &chain
                .iter()
                .rev()
                .map(|index| &records[*index].1)
                .filter(|record| record["isSidechain"] != true)
                .collect::<Vec<_>>(),
            self.permission_mode.as_ref(),
            self.cost_usd,
            self.worktree.map(Value::from).as_ref(),
        )
        .with_info(self.roster.into_value())
        .into_value();
        (self.queue.pending(), session)
    }
}

pub(super) fn prepare_records(mut records: Vec<(u64, Value)>) -> (Vec<(u64, Value)>, bool) {
    let own_file = {
        let mut messages = records
            .iter()
            .filter(|(_, record)| matches!(record["type"].as_str(), Some("user" | "assistant")))
            .peekable();
        messages.peek().is_some() && messages.all(|(_, record)| record["isSidechain"] == true)
    };
    if own_file {
        for (_, record) in &mut records {
            record["isSidechain"] = Value::Bool(false);
        }
    }
    let latest: HashMap<String, usize> = records
        .iter()
        .enumerate()
        .filter_map(|(index, (_, record))| string(record, "uuid").map(|id| (id, index)))
        .collect();
    let records = records
        .into_iter()
        .enumerate()
        .filter(|(index, (_, record))| {
            record["uuid"].as_str().and_then(|id| latest.get(id)) == Some(index)
        })
        .map(|(_, record)| record)
        .collect();
    (records, own_file)
}

pub(super) fn project_claude_bounded(
    bytes: Vec<u8>,
    limit: u8,
    inline_images: bool,
    line_limit: u64,
    record_limit: usize,
    expected_session_id: Option<&str>,
    window: &Window,
) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    let agent = TranscriptAgent::Claude;
    let size = bytes.len() as u64;
    let mut reader = Cursor::new(&bytes);
    let mut records = Vec::new();
    let mut context = ClaudeContext::default();
    let mut offset = 0;
    while offset < size {
        let line = super::read_record_line_bounded(&mut reader, line_limit)?;
        let bytes = line.len();
        if line.last() != Some(&b'\n') {
            break;
        }
        if !line.iter().all(u8::is_ascii_whitespace) {
            let mut record: Value =
                serde_json::from_slice(&line).map_err(|_| Error::InvalidEvent)?;
            context.observe(&record, expected_session_id)?;
            if is_conversation_record(&record) {
                if expected_session_id.is_some()
                    && !matches!(record["type"].as_str(), Some("user" | "assistant"))
                {
                    record
                        .as_object_mut()
                        .ok_or(Error::InvalidEvent)?
                        .retain(|key, _| {
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
                                    | "attachment"
                                    | "content"
                            )
                        });
                    super::events::trim(&mut record);
                }
                records.push((offset, record));
                if records.len() > record_limit {
                    return Err(Error::InvalidArgument);
                }
            }
        }
        offset += bytes as u64;
    }
    context.verify(expected_session_id)?;
    drop(bytes);
    let (records, _) = prepare_records(records);
    let (chain, leaf) = active_chain(&records)?;
    let activity = leaf.and_then(|leaf| activity(&records, leaf));
    let work = super::work::tasks(chain.iter().map(|index| &records[*index].1));
    let (queued, session) = context.finish(&records, &chain);
    let branch_id = chain
        .last()
        .and_then(|index| string(&records[*index].1, "uuid"));
    let all = chain
        .into_iter()
        .filter_map(|index| {
            let (position, record) = &records[index];
            claude_message(record, inline_images, *position)
        })
        .collect();
    let selected = select(all, window, limit)?;
    Ok(TranscriptPage {
        schema_version: 1,
        view: "active_branch",
        agent,
        messages: selected.messages,
        next_offset: offset,
        has_more: false,
        branch_id,
        truncated: selected.has_older,
        has_newer: selected.has_newer,
        checkpoint: None,
        activity,
        queued,
        work: (!work.is_empty()).then_some(work),
        session,
    })
}

// Observe one initial prefix, allowing append-only growth without pausing Follow.
// Changed metadata requires one exact prefix comparison, never a capture retry.
pub(super) fn capture(path: &Path) -> Result<Vec<u8>> {
    capture_with(|| open_transcript(path))
}

pub(super) fn capture_with(open: impl Fn() -> Result<File>) -> Result<Vec<u8>> {
    capture_with_limit(open, lazysh_common::record_checkpoint::MAX_SNAPSHOT)
}

pub(super) fn capture_with_limit(open: impl Fn() -> Result<File>, maximum: u64) -> Result<Vec<u8>> {
    let mut file = open()?;
    let before = super::SourceSnapshot::capture(&file)?;
    drop(selected_with(&open, &file, &before)?);
    #[cfg(test)]
    let source = super::mutation_observer::ObservedRead(&mut file);
    #[cfg(not(test))]
    let source = &mut file;
    let bytes =
        super::snapshot::read_bytes_bounded(&mut BufReader::new(source), before.len(), maximum)?;
    if bytes.len() as u64 != before.len() {
        return Err(Error::InvalidEvent);
    }
    let mut selected = selected_with(&open, &file, &before)?;
    let after = file.metadata()?;
    let selected_metadata = selected.metadata()?;
    if after.len() != before.len()
        || selected_metadata.len() != before.len()
        || after.modified()? != before.modified()?
        || selected_metadata.modified()? != before.modified()?
    {
        compare_prefix(&mut selected, &bytes)?;
        selected_with(&open, &selected, &before)?;
        selected_with(&open, &file, &before)?;
    }
    Ok(bytes)
}

fn compare_prefix(selected: &mut File, bytes: &[u8]) -> Result<()> {
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
    Ok(())
}

pub(super) fn verify_captured_with(
    open: &impl Fn() -> Result<File>,
    before: &super::SourceSnapshot,
    bytes: &[u8],
) -> Result<()> {
    let source = open()?;
    let mut selected = selected_with(open, &source, before)?;
    compare_prefix(&mut selected, bytes)?;
    selected_with(open, &selected, before)?;
    selected_with(open, &source, before)?;
    Ok(())
}

fn selected_with(
    open: &impl Fn() -> Result<File>,
    file: &File,
    before: &super::SourceSnapshot,
) -> Result<File> {
    let selected = open()?;
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
/// The prompts typed while Claude Code works, replayed from its `queue-operation` records: `enqueue`
/// appends, `dequeue` takes the oldest, `remove` drops the entry with that text and `popAll` empties
/// the queue. Text the harness injects (`<task-notification>`, `<agent-message>`, ...) starts with
/// `<` and is not something a person typed, so it is not shown.
#[derive(Default)]
pub(super) struct Queue(Vec<(String, Option<String>)>);
const MAX_QUEUED: usize = 20;
const MAX_QUEUED_TEXT: usize = 4096;
impl Queue {
    pub(super) fn apply(&mut self, record: &Value) {
        let content = record["content"].as_str().unwrap_or_default();
        match record["operation"].as_str() {
            Some("enqueue") => self
                .0
                .push((content.to_owned(), string(record, "timestamp"))),
            Some("dequeue") if !self.0.is_empty() => {
                self.0.remove(0);
            }
            Some("remove") => {
                if let Some(index) = self.0.iter().position(|(text, _)| text == content) {
                    self.0.remove(index);
                }
            }
            Some("popAll") => self.0.clear(),
            _ => {}
        }
    }
    pub(super) fn pending(self) -> Vec<Value> {
        self.0
            .into_iter()
            .filter(|(text, _)| !text.trim().is_empty() && !text.trim_start().starts_with('<'))
            .take(MAX_QUEUED)
            .map(|(text, timestamp)| {
                let mut end = text.len().min(MAX_QUEUED_TEXT);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                let mut value = json!({"text":&text[..end]});
                if let Some(timestamp) = timestamp {
                    value["timestamp"] = json!(timestamp);
                }
                value
            })
            .collect()
    }
}

/// Whether a user record is the marker Claude Code writes when the person interrupts a turn, which includes
/// rejecting a permission dialog (`[Request interrupted by user for tool use]`).
pub(crate) fn interrupted(record: &Value) -> bool {
    let content = &record["message"]["content"];
    record["type"] == "user"
        && content
            .as_str()
            .into_iter()
            .chain(
                content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str()),
            )
            .any(|text| text.starts_with("[Request interrupted"))
}

/// Turn state at the selected leaf. Claude Code records `system/turn_duration`
/// after a turn ends; an unanswered question or plan approval waits for the
/// user; an assistant `tool_use` stop or a user record means a turn is running.
pub(super) fn activity(records: &[(u64, Value)], leaf: usize) -> Option<&'static str> {
    let mut children: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, (_, record)) in records.iter().enumerate() {
        if let Some(parent) = record["parentUuid"].as_str() {
            children.entry(parent).or_default().push(index);
        }
    }
    let mut pending = vec![leaf];
    let mut seen = HashSet::new();
    while let Some(index) = pending.pop() {
        let record = &records[index].1;
        if !seen.insert(index)
            || (index != leaf && matches!(record["type"].as_str(), Some("user" | "assistant")))
        {
            continue;
        }
        if record["type"] == "system"
            && record["subtype"] == "turn_duration"
            && record["isSidechain"] != true
        {
            // The turn ended, but a sub-agent it started is still recorded as running.
            return Some(
                if record["pendingBackgroundAgentCount"].as_u64() > Some(0) {
                    "working"
                } else {
                    "idle"
                },
            );
        }
        if let Some(id) = record["uuid"].as_str() {
            pending.extend(children.get(id).into_iter().flatten());
        }
    }
    let record = &records[leaf].1;
    let content = &record["message"]["content"];
    if record["type"] == "user" {
        // An interruption marker is not a recorded running turn.
        return (!interrupted(record)).then_some("working");
    }
    let asks = content.as_array().into_iter().flatten().any(|part| {
        part["type"] == "tool_use"
            && part["name"].as_str().is_some_and(|name| {
                super::interaction::awaits_answer(TranscriptAgent::Claude, name)
            })
    });
    if asks {
        Some("waiting")
    } else if record["message"]["stop_reason"] == "tool_use" {
        Some("working")
    } else {
        None
    }
}

pub(super) fn active_chain(records: &[(u64, Value)]) -> Result<(Vec<usize>, Option<usize>)> {
    let mut by_id = HashMap::new();
    let mut parents = HashSet::new();
    for (index, (_, record)) in records.iter().enumerate() {
        if let Some(id) = record["uuid"].as_str() {
            by_id.insert(id, index);
        }
        if let Some(parent) = parent(record) {
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
            current = parent(record).and_then(|parent| by_id.get(parent).copied());
        }
    }
    let Some(leaf) = leaves.into_iter().max() else {
        if !records.is_empty() && parents.len() >= by_id.len() {
            return Err(Error::InvalidEvent);
        }
        return Ok((Vec::new(), None));
    };
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(leaf);
    while let Some(index) = current {
        if !seen.insert(index) {
            return Err(Error::InvalidEvent);
        }
        chain.push(index);
        current = parent(&records[index].1).and_then(|parent| by_id.get(parent).copied());
    }
    chain.reverse();
    Ok((recover_parallel(records, &chain, &mut seen)?, Some(leaf)))
}

/// The record before this one in the session. A compaction restarts the chain with `parentUuid`
/// null and keeps the earlier conversation behind `logicalParentUuid`, so reading across it shows
/// the whole session from its first message.
fn parent(record: &Value) -> Option<&str> {
    record["parentUuid"].as_str().or_else(|| {
        (record["subtype"] == "compact_boundary")
            .then(|| record["logicalParentUuid"].as_str())
            .flatten()
    })
}

pub(super) fn is_main(record: &Value) -> bool {
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
    /// `count` chained assistant rows `{prefix}0..`, the first under `root`.
    fn chain(file: &mut File, prefix: &str, root: Option<&str>, count: usize, text: &str) {
        for number in 0..count {
            let id = format!("{prefix}{number}");
            let parent = if number > 0 {
                Some(format!("{prefix}{}", number - 1))
            } else {
                root.map(str::to_owned)
            };
            file.write_all(row(&id, parent.as_deref(), text).as_bytes())
                .unwrap();
        }
    }
    #[test]
    fn claude_pages_across_a_conversation_larger_than_the_snapshot_budget() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("long.jsonl");
        let mut file = File::create(&path).unwrap();
        chain(&mut file, "message-", None, 80, &"x".repeat(224 * 1024));
        assert!(file.metadata().unwrap().len() > lazysh_common::record_checkpoint::MAX_SNAPSHOT);
        super::super::claude_large::take_scanned();
        let tail =
            conversation_window(&path, TranscriptAgent::Claude, 1, false, &Window::Tail).unwrap();
        let scanned = super::super::claude_large::take_scanned();
        assert!(
            scanned < 2 * 1024 * 1024,
            "opening one recent message scanned {scanned} bytes"
        );
        assert_eq!(tail.messages[0]["id"], "message-79");
        assert!(tail.truncated);
        let before = Window::Before("message-79".into());
        let previous =
            conversation_window(&path, TranscriptAgent::Claude, 1, false, &before).unwrap();
        assert_eq!(previous.messages[0]["id"], "message-78");
        assert!(previous.has_newer);
    }

    #[test]
    fn a_large_earlier_tool_result_does_not_block_the_latest_page() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large-tool-result.jsonl");
        let mut file = File::create(&path).unwrap();
        let long_text = "x".repeat(5 * 1024 * 1024);
        let result = json!({
            "type": "user",
            "uuid": "tool",
            "message": {"content": [{"type":"tool_result","tool_use_id":"call","content":long_text}]}
        });
        writeln!(file, "{result}").unwrap();
        chain(&mut file, "m", Some("tool"), 55, &"x".repeat(224 * 1024));
        let tail =
            conversation_window(&path, TranscriptAgent::Claude, 1, false, &Window::Tail).unwrap();
        assert_eq!(tail.messages[0]["id"], "m54");
        assert!(tail.truncated);
    }

    #[test]
    fn older_pages_read_only_the_needed_suffix() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("old-page.jsonl");
        let mut file = File::create(&path).unwrap();
        chain(&mut file, "message-", None, 80, &"x".repeat(224 * 1024));
        super::super::claude_large::take_scanned();
        let page = conversation_window(
            &path,
            TranscriptAgent::Claude,
            1,
            false,
            &Window::Before("message-79".into()),
        )
        .unwrap();
        assert_eq!(page.messages[0]["id"], "message-78");
        let scanned = super::super::claude_large::take_scanned();
        assert!(
            scanned < 2 * 1024 * 1024,
            "one previous page scanned {scanned} bytes"
        );
        super::super::claude_large::take_scanned();
        let farther = conversation_window(
            &path,
            TranscriptAgent::Claude,
            1,
            false,
            &Window::Before("message-70".into()),
        )
        .unwrap();
        assert_eq!(farther.messages[0]["id"], "message-69");
        let farther_scanned = super::super::claude_large::take_scanned();
        assert!(
            farther_scanned < 8 * 1024 * 1024,
            "a farther page scanned {farther_scanned} bytes"
        );
    }

    #[test]
    fn one_oversized_message_is_cut_with_a_note_and_earlier_pages_stay_reachable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large-message.jsonl");
        let mut file = File::create(&path).unwrap();
        chain(&mut file, "message-", None, 80, &"x".repeat(224 * 1024));
        let body = "🌎hello".repeat(120_000);
        file.write_all(row("large", Some("message-79"), &body).as_bytes())
            .unwrap();

        let tail =
            conversation_window(&path, TranscriptAgent::Claude, 1, false, &Window::Tail).unwrap();
        let text = tail.messages[0]["blocks"][0]["text"].as_str().unwrap();
        assert_eq!(tail.messages[0]["id"], "large");
        assert!(text.len() <= 262_144 && text.starts_with("🌎hello"));
        assert!(text.contains("more bytes not shown]"));
        let earlier = conversation_window(
            &path,
            TranscriptAgent::Claude,
            1,
            false,
            &Window::Before("large".into()),
        )
        .unwrap();
        assert_eq!(earlier.messages[0]["id"], "message-79");
    }

    #[test]
    fn tail_preserves_a_queued_message_from_before_the_recent_suffix() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("queue.jsonl");
        let mut file = File::create(&path).unwrap();
        // Claude Code writes `type` first, which is how the tail read finds state records without parsing every line.
        writeln!(
            file,
            r#"{{"type":"queue-operation","operation":"enqueue","content":"waiting"}}"#
        )
        .unwrap();
        chain(&mut file, "m", None, 80, &"x".repeat(224 * 1024));
        let page =
            conversation_window(&path, TranscriptAgent::Claude, 1, false, &Window::Tail).unwrap();
        assert_eq!(page.queued[0]["text"], "waiting");
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
