//! Clean-room recorded display reduction, not reconstruction of model context.
use super::{
    grok_acp, open_transcript, read_record_line, Error, Result, TranscriptAgent, TranscriptPage,
    MAX_PAGE,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufReader, Read},
    path::Path,
};

const MAX_RECONSTRUCTION: usize = 16 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;

enum Action {
    Chunk(Value, Option<String>),
    Tool(String, Value, bool, u64, String),
    Barrier,
}

pub(super) fn conversation(path: &Path, limit: u8) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    let file = open_transcript(path)?;
    let size = file.metadata()?.len();
    if size > MAX_RECONSTRUCTION as u64 {
        return Err(Error::InvalidArgument);
    }
    let mut reader = BufReader::new(file.take(size));
    let mut actions = Vec::new();
    let mut boundaries = Vec::new();
    let mut session = None;
    let mut ambiguous = false;
    let mut offset = 0;
    let mut charged = 0;
    let mut count = 0;
    let mut branch_id = None;
    while offset < size {
        let line = read_record_line(&mut reader)?;
        if line.last() != Some(&b'\n') {
            break;
        }
        let position = offset;
        offset += line.len() as u64;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        count += 1;
        if count > MAX_RECORDS {
            return Err(Error::InvalidArgument);
        }
        let record: Value = serde_json::from_slice(&line).map_err(|_| Error::InvalidEvent)?;
        let method = record["method"].as_str().ok_or(Error::InvalidEvent)?;
        if !matches!(method, "session/update" | "_x.ai/session/update") {
            return Err(Error::InvalidEvent);
        }
        let id = record["params"]["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 4096)
            .ok_or(Error::InvalidEvent)?;
        if session.as_deref().is_some_and(|previous| previous != id) {
            return Err(Error::InvalidEvent);
        }
        session = Some(id.to_owned());
        let timestamp = grok_acp::recorded_timestamp(&record).ok_or(Error::InvalidEvent)?;
        grok_acp::validate_bounds(&record)?;
        let update = &record["params"]["update"];
        let tag = update["sessionUpdate"]
            .as_str()
            .ok_or(Error::InvalidEvent)?;
        let action = if method == "session/update" {
            match tag {
                "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" => {
                    let mut key = None;
                    if tag == "user_message_chunk" {
                        if let Some(index) = update["_meta"]["promptIndex"].as_u64() {
                            if boundaries.last().map(|(last, _)| *last) != Some(index) {
                                if index != boundaries.len() as u64 {
                                    return Err(Error::InvalidEvent);
                                }
                                boundaries.push((index, actions.len()));
                            }
                            key = Some(format!("prompt:{index}"));
                        } else if update["_meta"]["hostTurn"] != true
                            && update["_meta"]["interjection"] != true
                        {
                            ambiguous = true;
                        }
                    }
                    if let Some(id) = update.get("messageId").filter(|id| !id.is_null()) {
                        let id = id.as_str().ok_or(Error::InvalidEvent)?;
                        uuid::Uuid::parse_str(id).map_err(|_| Error::InvalidEvent)?;
                        key = Some(format!("message:{id}"));
                    }
                    let message =
                        grok_acp::normalize(&record, position).ok_or(Error::InvalidEvent)?;
                    if tag == "user_message_chunk" && update["_meta"]["hideFromScrollback"] == true
                    {
                        Action::Barrier
                    } else {
                        charged += normalized_size(&message)?;
                        Action::Chunk(message, key)
                    }
                }
                "tool_call" | "tool_call_update" => {
                    let id = update["toolCallId"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or(Error::InvalidEvent)?;
                    let patch = tool_patch(update)?;
                    charged += serde_json::to_vec(&patch)
                        .map_err(|_| Error::InvalidEvent)?
                        .len()
                        + id.len();
                    Action::Tool(id.into(), patch, tag == "tool_call", position, timestamp)
                }
                "plan" => display_action(
                    &record,
                    position,
                    Some(format!("record:{position}")),
                    &mut charged,
                )?,
                // Explicit non-conversation ACP snapshots do not change the timeline.
                "available_commands_update"
                | "current_mode_update"
                | "config_option_update"
                | "session_info_update"
                | "usage_update" => Action::Barrier,
                _ => return Err(Error::InvalidEvent),
            }
        } else {
            match tag {
                "rewind_marker" => {
                    let target = update["target_prompt_index"]
                        .as_u64()
                        .ok_or(Error::InvalidEvent)?;
                    if ambiguous {
                        return Err(Error::InvalidEvent);
                    }
                    let cut = boundaries
                        .iter()
                        .find(|(index, _)| *index == target)
                        .map(|(_, cut)| *cut)
                        .ok_or(Error::InvalidEvent)?;
                    actions.truncate(cut);
                    boundaries.retain(|(index, _)| *index < target);
                    branch_id = Some(format!("grok-rewind-{position}"));
                    Action::Barrier
                }
                "plan_kept" => display_action(
                    &record,
                    position,
                    Some(format!("record:{position}")),
                    &mut charged,
                )?,
                // Recorded display keeps the original transcript across model compaction.
                // Checkpoint files/paths are deliberately never opened.
                "compaction_checkpoint"
                | "auto_compact_started"
                | "auto_compact_completed"
                | "auto_compact_failed"
                | "auto_compact_cancelled"
                | "turn_completed"
                | "response_started"
                | "response_completed"
                | "reasoning_completed"
                | "turn_usage"
                | "plan_cleared"
                | "plan_executing" => Action::Barrier,
                // No catch-all: a future timeline-changing event cannot silently pass.
                _ => return Err(Error::InvalidEvent),
            }
        };
        if charged > MAX_RECONSTRUCTION {
            return Err(Error::InvalidArgument);
        }
        actions.push(action);
    }
    let messages = reduce(actions)?;
    let total_messages = messages.len();
    let mut output_bytes = 0;
    let mut latest = Vec::new();
    for message in messages.into_iter().rev() {
        let bytes = normalized_size(&message)?;
        if bytes > MAX_PAGE {
            return Err(Error::InvalidEvent);
        }
        if latest.len() == usize::from(limit) || output_bytes + bytes > MAX_PAGE {
            break;
        }
        output_bytes += bytes;
        latest.push(message);
    }
    let truncated = latest.len() < total_messages;
    latest.reverse();
    Ok(TranscriptPage {
        schema_version: 1,
        view: "active_branch",
        agent: TranscriptAgent::GrokAcp,
        messages: latest,
        next_offset: offset,
        has_more: false,
        branch_id,
        truncated,
        checkpoint: None,
    })
}

fn tool_patch(update: &Value) -> Result<Value> {
    let mut patch = json!({});
    for field in ["title", "rawInput", "status"] {
        if let Some(value) = update.get(field).filter(|value| !value.is_null()) {
            patch[field] = match field {
                "title" => json!(value.as_str().ok_or(Error::InvalidEvent)?),
                "rawInput" => json!(value.to_string()),
                _ => match grok_acp::recorded_status(update) {
                    Some(status) => json!(status),
                    None => Value::Null,
                },
            };
        }
    }
    for field in ["content", "rawOutput"] {
        if let Some(value) = update.get(field).filter(|value| !value.is_null()) {
            if field == "content" && !value.is_array() {
                return Err(Error::InvalidEvent);
            }
            let mut selected = json!({});
            selected[field] = value.clone();
            patch[field] = json!(grok_acp::tool_output(
                &selected,
                update["toolCallId"].as_str().ok_or(Error::InvalidEvent)?,
                false
            ));
        }
    }
    Ok(patch)
}

fn reduce(actions: Vec<Action>) -> Result<Vec<Value>> {
    let mut messages: Vec<Value> = Vec::new();
    let mut tools: HashMap<String, (usize, Value)> = HashMap::new();
    let mut previous: Option<(String, String)> = None;
    let mut closed_keys = HashSet::new();
    for action in actions {
        match action {
            Action::Barrier => previous = None,
            Action::Chunk(message, key) => {
                let role = message["role"]
                    .as_str()
                    .ok_or(Error::InvalidEvent)?
                    .to_owned();
                let explicit_key = key.is_some();
                let key = key.unwrap_or_else(|| format!("unkeyed:{role}"));
                if previous.as_ref() == Some(&(role.clone(), key.clone())) {
                    let last = messages.last_mut().ok_or(Error::InvalidEvent)?;
                    for block in message["blocks"].as_array().ok_or(Error::InvalidEvent)? {
                        let blocks = last["blocks"].as_array_mut().ok_or(Error::InvalidEvent)?;
                        if matches!(block["type"].as_str(), Some("text" | "thinking"))
                            && blocks
                                .last()
                                .is_some_and(|last| last["type"] == block["type"])
                        {
                            let tail = blocks.last_mut().ok_or(Error::InvalidEvent)?;
                            let Value::String(text) = &mut tail["text"] else {
                                return Err(Error::InvalidEvent);
                            };
                            let addition = block["text"].as_str().ok_or(Error::InvalidEvent)?;
                            if text.len() + addition.len() > 262144 {
                                return Err(Error::InvalidEvent);
                            }
                            text.push_str(addition);
                        } else {
                            blocks.push(block.clone());
                        }
                    }
                    super::validate_message(last)?;
                } else {
                    if explicit_key && !closed_keys.insert(key.clone()) {
                        return Err(Error::InvalidEvent);
                    }
                    messages.push(message);
                }
                previous = Some((role, key));
            }
            Action::Tool(id, patch, initial, offset, timestamp) => {
                previous = None;
                if initial {
                    if tools.contains_key(&id) || !patch["title"].is_string() {
                        return Err(Error::InvalidEvent);
                    }
                    tools.insert(id.clone(), (messages.len(), json!({})));
                    messages.push(
                        json!({"id":format!("grok-tool-{offset}"),"role":"assistant","blocks":[],"timestamp":timestamp}),
                    );
                }
                let (_, state) = tools.get_mut(&id).ok_or(Error::InvalidEvent)?;
                for (key, value) in patch.as_object().ok_or(Error::InvalidEvent)? {
                    state[key] = value.clone();
                }
            }
        }
    }
    for (id, (index, state)) in tools {
        let mut call = super::block(
            "tool_use",
            state["rawInput"].as_str().unwrap_or_default().into(),
            Some(id.clone()),
            Some(state["title"].as_str().ok_or(Error::InvalidEvent)?.into()),
        );
        let mut output = state["content"]
            .as_array()
            .filter(|parts| !parts.is_empty())
            .or_else(|| state["rawOutput"].as_array())
            .cloned()
            .unwrap_or_default();
        if let Some(status) = state["status"].as_str() {
            call["status"] = json!(status);
            for block in &mut output {
                block["status"] = json!(status);
            }
        }
        let mut blocks = vec![call];
        blocks.extend(output);
        messages[index]["blocks"] = json!(blocks);
        validate_normalized(&messages[index])?;
    }
    Ok(messages)
}

fn display_action(
    record: &Value,
    position: u64,
    key: Option<String>,
    charged: &mut usize,
) -> Result<Action> {
    let message = grok_acp::normalize(record, position).ok_or(Error::InvalidEvent)?;
    *charged += normalized_size(&message)?;
    Ok(Action::Chunk(message, key))
}

fn validate_normalized(message: &Value) -> Result<()> {
    for block in message["blocks"].as_array().ok_or(Error::InvalidEvent)? {
        for field in ["text", "id", "name"] {
            if block[field]
                .as_str()
                .is_some_and(|text| text.len() > 262144)
            {
                return Err(Error::InvalidEvent);
            }
        }
    }
    super::validate_message(message)
}

fn normalized_size(message: &Value) -> Result<usize> {
    validate_normalized(message)?;
    super::message_size(message)
}
