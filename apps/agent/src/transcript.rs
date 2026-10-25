use crate::{Error, Result};
use clap::ValueEnum;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};
mod amp_json;
mod antigravity;
mod atif;
mod conversation;
mod cursor;
mod database;
mod discovery;
mod droid;
mod event_adapters;
mod grok_acp;
mod jcode;
mod snapshot;
pub use conversation::conversation;
pub use database::read_database_page;
pub use discovery::discover;

const MAX_LINE: u64 = 256 * 1024;
const MAX_SCAN: u64 = 4 * 1024 * 1024;
const MAX_PAGE: usize = 512 * 1024;

#[derive(Clone, Copy, Debug, ValueEnum, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptAgent {
    Claude,
    Codex,
    Pi,
    Omp,
    Hermes,
    Opencode,
    Copilot,
    #[value(name = "qoder-ide")]
    #[serde(rename = "qoder-ide")]
    QoderIde,
    Kimi,
    Jcode,
    Droid,
    Cursor,
    Omo,
    #[value(name = "devin-atif")]
    #[serde(rename = "devin-atif")]
    DevinAtif,
    #[value(name = "amp-json")]
    #[serde(rename = "amp-json")]
    AmpJson,
    #[value(name = "grok-acp")]
    #[serde(rename = "grok-acp")]
    GrokAcp,
    #[value(name = "antigravity-jsonl")]
    #[serde(rename = "antigravity-jsonl")]
    AntigravityJsonl,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum TranscriptView {
    Records,
    Conversation,
}
impl std::fmt::Display for TranscriptView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Records => "records",
            Self::Conversation => "conversation",
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub schema_version: u8,
    pub view: &'static str,
    pub agent: TranscriptAgent,
    pub messages: Vec<Value>,
    pub next_offset: u64,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
}

/// Read record boundaries from an explicitly selected file; never follow image/tool paths.
pub fn read_page(
    path: &Path,
    agent: TranscriptAgent,
    offset: u64,
    limit: u8,
) -> Result<TranscriptPage> {
    read_page_with_checkpoint(path, agent, offset, limit, None)
}

pub fn read_page_with_checkpoint(
    path: &Path,
    agent: TranscriptAgent,
    offset: u64,
    limit: u8,
    checkpoint: Option<&str>,
) -> Result<TranscriptPage> {
    if matches!(agent, TranscriptAgent::AntigravityJsonl) {
        return antigravity::read_page(path, offset, limit, checkpoint);
    }
    if checkpoint.is_some() {
        return Err(Error::InvalidArgument);
    }
    if matches!(agent, TranscriptAgent::DevinAtif) {
        return atif::read_page(path, offset, limit);
    }
    if matches!(agent, TranscriptAgent::AmpJson) {
        return amp_json::read_page(path, offset, limit);
    }
    if matches!(agent, TranscriptAgent::Jcode) {
        return jcode::read_page(path, offset, limit);
    }
    if !(1..=100).contains(&limit)
        || matches!(agent, TranscriptAgent::Hermes | TranscriptAgent::Opencode)
    {
        return Err(Error::InvalidArgument);
    }
    let mut file = open_transcript(path)?;
    let metadata = file.metadata()?;
    if offset > metadata.len() {
        return Err(Error::InvalidArgument);
    }
    if offset > 0 {
        file.seek(SeekFrom::Start(offset - 1))?;
        let mut previous = [0];
        file.read_exact(&mut previous)?;
        if previous != *b"\n" {
            return Err(Error::InvalidArgument);
        }
    }
    let mut reader = BufReader::new(file.take(metadata.len() - offset));
    let mut next_offset = offset;
    let mut messages = Vec::new();
    let mut output_bytes = 0;
    let mut pending_tail = false;
    while next_offset < metadata.len()
        && next_offset - offset < MAX_SCAN
        && messages.len() < usize::from(limit)
    {
        let mut line = Vec::new();
        let bytes = reader
            .by_ref()
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut line)?;
        if bytes as u64 > MAX_LINE {
            return Err(Error::InvalidEvent);
        }
        if line.last() != Some(&b'\n') {
            pending_tail = true;
            break;
        }
        if next_offset - offset + bytes as u64 > MAX_SCAN {
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            next_offset += bytes as u64;
            continue;
        }
        let record: Value = serde_json::from_slice(&line).map_err(|_| Error::InvalidEvent)?;
        if !record.is_object() {
            return Err(Error::InvalidEvent);
        }
        if matches!(agent, TranscriptAgent::GrokAcp) {
            grok_acp::validate_bounds(&record)?;
        }
        if let Some(message) = normalize(&record, agent, next_offset) {
            validate_message(&message)?;
            let size = serde_json::to_vec(&message)
                .map_err(|_| Error::InvalidEvent)?
                .len();
            if size > MAX_PAGE {
                return Err(Error::InvalidEvent);
            }
            if output_bytes + size > MAX_PAGE {
                break;
            }
            output_bytes += size;
            messages.push(message);
        }
        next_offset += bytes as u64;
    }
    Ok(TranscriptPage {
        schema_version: 1,
        view: "record_stream",
        agent,
        messages,
        next_offset,
        has_more: !pending_tail && next_offset < metadata.len(),
        branch_id: None,
        truncated: false,
        checkpoint: None,
    })
}

fn validate_message(message: &Value) -> Result<()> {
    if message["blocks"]
        .as_array()
        .is_some_and(|blocks| blocks.len() > 1000)
    {
        return Err(Error::InvalidEvent);
    }
    Ok(())
}

pub(crate) fn open_transcript(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(not(unix))]
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(Error::InvalidArgument);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(Error::InvalidArgument);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(Error::InvalidArgument);
        }
    }
    Ok(file)
}

fn string(value: &Value, field: &str) -> Option<String> {
    value.get(field)?.as_str().map(str::to_owned)
}
fn block(kind: &str, text: String, id: Option<String>, name: Option<String>) -> Value {
    let mut value = json!({"type":kind,"text":text});
    if let Some(id) = id {
        value["id"] = json!(id);
    }
    if let Some(name) = name {
        value["name"] = json!(name);
    }
    value
}
fn content(value: &Value) -> Vec<Value> {
    if let Some(text) = value.as_str() {
        return vec![block("text", text.into(), None, None)];
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| {
            let kind = part.get("type")?.as_str()?;
            Some(match kind {
                "text" | "input_text" | "output_text" => {
                    block("text", string(part, "text")?, None, None)
                }
                "thinking" => block("thinking", string(part, "thinking")?, None, None),
                "image" | "input_image" | "image_url" | "file" => block(
                    "image",
                    "Attachment: view in the host agent terminal".into(),
                    None,
                    None,
                ),
                "tool_use" | "toolCall" => block(
                    "tool_use",
                    serde_json::to_string(part.get("input").or_else(|| part.get("arguments"))?)
                        .ok()?,
                    string(part, "id"),
                    string(part, "name"),
                ),
                "tool_result" => block(
                    "tool_result",
                    content(part.get("content")?)
                        .iter()
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    string(part, "tool_use_id"),
                    None,
                ),
                _ => return None,
            })
        })
        .collect()
}
fn normalize(record: &Value, agent: TranscriptAgent, offset: u64) -> Option<Value> {
    match agent {
        TranscriptAgent::Copilot => return event_adapters::copilot(record, offset),
        TranscriptAgent::Kimi => return event_adapters::kimi(record, offset),
        TranscriptAgent::Droid => return droid::normalize(record, offset),
        TranscriptAgent::Cursor => return cursor::normalize(record, offset),
        TranscriptAgent::GrokAcp => return grok_acp::normalize(record, offset),
        _ => {}
    }
    let (role, blocks, id, usage) = match agent {
        TranscriptAgent::Pi | TranscriptAgent::Omp | TranscriptAgent::Omo => {
            if record["type"] != "message" {
                return None;
            }
            let message = record.get("message")?;
            let role = message["role"].as_str()?;
            if !matches!(role, "user" | "assistant" | "toolResult") {
                return None;
            }
            let mut blocks = content(message.get("content")?);
            if role == "toolResult" {
                blocks = vec![block(
                    "tool_result",
                    blocks
                        .iter()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    string(message, "toolCallId"),
                    string(message, "toolName"),
                )];
            }
            let mut usage = serde_json::Map::new();
            for (source, target) in [
                ("input", "inputTokens"),
                ("output", "outputTokens"),
                ("cacheRead", "cacheReadTokens"),
                ("cacheWrite", "cacheWriteTokens"),
            ] {
                if let Some(count) = message["usage"][source].as_u64() {
                    usage.insert(target.into(), json!(count));
                }
            }
            (
                if role == "toolResult" { "tool" } else { role },
                blocks,
                string(record, "id"),
                usage,
            )
        }
        TranscriptAgent::Hermes | TranscriptAgent::Opencode => return None,
        TranscriptAgent::Claude | TranscriptAgent::QoderIde => {
            if record["isSidechain"] == true
                || record["isMeta"] == true
                || record.get("teamName").is_some_and(|v| !v.is_null())
            {
                return None;
            }
            let role = record["type"].as_str()?;
            if role != "user" && role != "assistant" {
                return None;
            }
            let message = record.get("message")?;
            let blocks = content(message.get("content")?);
            let mut usage = serde_json::Map::new();
            for (source, target) in [
                ("input_tokens", "inputTokens"),
                ("output_tokens", "outputTokens"),
                ("cache_read_input_tokens", "cacheReadTokens"),
                ("cache_creation_input_tokens", "cacheWriteTokens"),
            ] {
                if let Some(count) = message["usage"][source].as_u64() {
                    usage.insert(target.into(), json!(count));
                }
            }
            (role, blocks, string(record, "uuid"), usage)
        }
        TranscriptAgent::Codex => {
            if record["type"] != "response_item" {
                return None;
            }
            let payload = record.get("payload")?;
            let (role, blocks) = match payload["type"].as_str()? {
                "message" => {
                    let role = payload["role"].as_str()?;
                    if role != "user" && role != "assistant" {
                        return None;
                    }
                    (role, content(payload.get("content")?))
                }
                "function_call" | "custom_tool_call" => (
                    "assistant",
                    vec![block(
                        "tool_use",
                        string(payload, "arguments").or_else(|| string(payload, "input"))?,
                        string(payload, "call_id"),
                        string(payload, "name"),
                    )],
                ),
                "function_call_output" | "custom_tool_call_output" => (
                    "tool",
                    vec![block(
                        "tool_result",
                        content(payload.get("output")?)
                            .iter()
                            .filter_map(|p| p["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                        string(payload, "call_id"),
                        string(payload, "name"),
                    )],
                ),
                "reasoning" => (
                    "assistant",
                    payload["summary"]
                        .as_array()?
                        .iter()
                        .filter_map(|summary| string(summary, "text"))
                        .map(|text| block("thinking", text, None, None))
                        .collect(),
                ),
                _ => return None,
            };
            (role, blocks, string(payload, "id"), serde_json::Map::new())
        }
        TranscriptAgent::Copilot
        | TranscriptAgent::Kimi
        | TranscriptAgent::Droid
        | TranscriptAgent::Cursor => return None,
        TranscriptAgent::Jcode => return None,
        TranscriptAgent::DevinAtif => return None,
        TranscriptAgent::AmpJson => return None,
        TranscriptAgent::GrokAcp | TranscriptAgent::AntigravityJsonl => return None,
    };
    if blocks.is_empty() {
        return None;
    }
    let mut message =
        json!({"id":id.unwrap_or_else(||format!("record-{offset}")),"role":role,"blocks":blocks});
    if let Some(timestamp) = string(record, "timestamp") {
        message["timestamp"] = json!(timestamp);
    }
    if let Some(parent) = string(record, "parentUuid").or_else(|| string(record, "parentId")) {
        message["parentId"] = json!(parent);
    }
    if !usage.is_empty() {
        message["usage"] = json!(usage);
    }
    Some(message)
}
