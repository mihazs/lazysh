//! Pinned CLI step-record snapshots, without conversation or branch reconstruction.
use super::{
    block, open_transcript, validate_message, TranscriptAgent, TranscriptPage, MAX_LINE, MAX_PAGE,
    MAX_SCAN,
};
use crate::{Error, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Deserialize)]
struct ToolCall {
    name: String,
    args: Option<Map<String, Value>>,
}
#[derive(Deserialize)]
struct Media {
    mime_type: Option<String>,
    uri: String,
}
#[derive(Deserialize)]
struct Record {
    step_index: Option<u32>,
    source: String,
    #[serde(rename = "type")]
    kind: String,
    status: String,
    created_at: Option<String>,
    content: Option<String>,
    thinking: Option<String>,
    exit_code: Option<i32>,
    error: Option<String>,
    error_code: Option<u32>,
    input_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    output_tokens: Option<u64>,
    tool_calls: Option<Vec<ToolCall>>,
    media: Option<Vec<Media>>,
    truncated_fields: Option<Vec<String>>,
}
fn normalize(bytes: &[u8], offset: u64) -> Result<Value> {
    let record: Record = serde_json::from_slice(bytes).map_err(|_| Error::InvalidEvent)?;
    let calls = record.tool_calls.unwrap_or_default();
    let media = record.media.unwrap_or_default();
    let flags = record.truncated_fields.unwrap_or_default();
    if [&record.source, &record.kind, &record.status]
        .iter()
        .any(|s| s.len() > 256)
        || record.created_at.as_ref().is_some_and(|s| s.len() > 4096)
        || flags.len() > 64
        || flags.iter().any(|s| s.len() > 256)
        || calls.len() + media.len() + 3 > 1000
        || calls.iter().any(|call| call.name.len() > 256)
    {
        return Err(Error::InvalidEvent);
    }
    let mut blocks = Vec::new();
    if let Some(text) = record.content {
        blocks.push(block("text", text, None, None));
    }
    if let Some(text) = record.thinking {
        blocks.push(block("thinking", text, None, None));
    }
    if let Some(text) = record.error {
        blocks.push(block("text", format!("Recorded error: {text}"), None, None));
    }
    for call in calls {
        blocks.push(block(
            "tool_use",
            call.args
                .map(|args| Value::Object(args).to_string())
                .unwrap_or_default(),
            None,
            Some(call.name),
        ));
    }
    for item in media {
        // URI is validated as recorded text, never opened or passed to an image renderer.
        let _ = item.uri;
        blocks.push(block(
            "image",
            format!(
                "Attachment{}: view in the host agent terminal",
                item.mime_type
                    .map(|mime| format!(" ({mime})"))
                    .unwrap_or_default()
            ),
            None,
            None,
        ));
    }
    let mut metadata = json!({"source":record.source,"type":record.kind,"status":record.status,"truncatedFields":flags});
    if let Some(index) = record.step_index {
        metadata["stepIndex"] = json!(index);
    }
    if let Some(code) = record.exit_code {
        metadata["exitCode"] = json!(code);
    }
    if let Some(code) = record.error_code {
        metadata["errorCode"] = json!(code);
    }
    let mut message = json!({"id":format!("antigravity-record-{offset}"),"role":"record","record":metadata,"blocks":blocks});
    if let Some(timestamp) = record.created_at {
        message["timestamp"] = json!(timestamp);
    }
    let usage: Map<String, Value> = [
        ("inputTokens", record.input_tokens),
        ("cacheReadTokens", record.cache_read_tokens),
        ("outputTokens", record.output_tokens),
    ]
    .into_iter()
    .filter_map(|(name, value)| value.map(|count| (name.into(), json!(count.to_string()))))
    .collect();
    if !usage.is_empty() {
        message["usage"] = Value::Object(usage);
    }
    validate_message(&message)?;
    Ok(message)
}

pub(super) fn read_page(
    path: &Path,
    offset: u64,
    limit: u8,
    checkpoint: Option<&str>,
) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) || (offset > 0 && checkpoint.is_none()) {
        return Err(Error::InvalidArgument);
    }
    let mut file = open_transcript(path)?;
    let before = super::SourceSnapshot::capture(&file)?;
    let bytes = super::snapshot::read_bytes(&mut file, before.len())?;
    let selected = open_transcript(path)?;
    before.same_file(&selected)?;
    let after = selected.metadata()?;
    if before.len() != bytes.len() as u64
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(Error::InvalidEvent);
    }
    if let Some(checkpoint) = checkpoint {
        if checkpoint.len() > 96 {
            return Err(Error::InvalidArgument);
        }
        let parts: Vec<_> = checkpoint.split(':').collect();
        if parts.len() != 3
            || parts[0] != "v1"
            || parts[2].len() != 64
            || !parts[2]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(Error::InvalidArgument);
        }
        let length = parts[1]
            .parse::<usize>()
            .map_err(|_| Error::InvalidArgument)?;
        if length > bytes.len()
            || offset > length as u64
            || format!("{:x}", Sha256::digest(&bytes[..length])) != parts[2]
        {
            return Err(Error::Device("TranscriptChanged"));
        }
    }
    if offset > bytes.len() as u64 || (offset > 0 && bytes[offset as usize - 1] != b'\n') {
        return Err(Error::InvalidArgument);
    }
    let mut next_offset = offset;
    let mut messages = Vec::new();
    let mut output_bytes = 0;
    let mut pending_tail = false;
    for line in bytes[offset as usize..].split_inclusive(|byte| *byte == b'\n') {
        if messages.len() == usize::from(limit) || next_offset - offset >= MAX_SCAN {
            break;
        }
        if line.len() > MAX_LINE as usize {
            return Err(Error::InvalidEvent);
        }
        if !line.ends_with(b"\n") {
            pending_tail = true;
            break;
        }
        if next_offset - offset + line.len() as u64 > MAX_SCAN
            || messages.len() == usize::from(limit)
        {
            break;
        }
        if !line.iter().all(u8::is_ascii_whitespace) {
            let message = normalize(line, next_offset)?;
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
        next_offset += line.len() as u64;
    }
    Ok(TranscriptPage {
        schema_version: 1,
        view: "record_stream",
        agent: TranscriptAgent::AntigravityJsonl,
        messages,
        next_offset,
        has_more: !pending_tail && next_offset < bytes.len() as u64,
        branch_id: None,
        truncated: false,
        checkpoint: Some(format!("v1:{}:{:x}", bytes.len(), Sha256::digest(&bytes))),
    })
}
