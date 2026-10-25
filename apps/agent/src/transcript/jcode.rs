use super::{
    block, content, open_transcript, string, validate_message, Error, Result, TranscriptAgent,
    TranscriptPage, MAX_LINE, MAX_PAGE,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{File, Metadata},
    io::{BufRead, BufReader, Read},
    path::Path,
};

fn unchanged(path: &Path, before: &Metadata) -> Result<()> {
    let after = open_transcript(path)?.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(Error::InvalidEvent);
        }
    }
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(Error::InvalidEvent);
    }
    Ok(())
}
fn append_messages(
    messages: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    values: &Value,
) -> Result<()> {
    for message in values.as_array().ok_or(Error::InvalidEvent)? {
        let id = string(message, "id")
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or(Error::InvalidEvent)?;
        if seen.insert(id) {
            messages.push(message.clone());
        }
        if messages.len() > 10_000 {
            return Err(Error::InvalidArgument);
        }
    }
    Ok(())
}

pub(super) fn read_page(path: &Path, offset: u64, limit: u8) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    let file = open_transcript(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > 16 * 1024 * 1024 {
        return Err(Error::InvalidArgument);
    }
    let snapshot: Value =
        serde_json::from_reader(file.take(metadata.len())).map_err(|_| Error::InvalidEvent)?;
    let mut messages = Vec::new();
    let mut seen = HashSet::new();
    append_messages(
        &mut messages,
        &mut seen,
        snapshot.get("messages").ok_or(Error::InvalidEvent)?,
    )?;
    let name = path.file_stem().ok_or(Error::InvalidArgument)?;
    let mut journal_name = name.to_os_string();
    journal_name.push(".journal.jsonl");
    let journal_path = path.with_file_name(journal_name);
    let journal = match open_transcript(&journal_path) {
        Ok(file) => Some(file),
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let journal_metadata = journal.as_ref().map(File::metadata).transpose()?;
    if let (Some(file), Some(metadata)) = (journal, journal_metadata.as_ref()) {
        if metadata.len() > 16 * 1024 * 1024 {
            return Err(Error::InvalidArgument);
        }
        let mut reader = BufReader::new(file.take(metadata.len()));
        let mut entries = 0;
        loop {
            let mut line = Vec::new();
            let count = reader
                .by_ref()
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut line)?;
            if count == 0 {
                break;
            }
            if count as u64 > MAX_LINE {
                return Err(Error::InvalidEvent);
            }
            if line.last() != Some(&b'\n') {
                break;
            }
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let entry: Value = serde_json::from_slice(&line).map_err(|_| Error::InvalidEvent)?;
            if !entry["meta"].is_object() {
                return Err(Error::InvalidEvent);
            }
            if let Some(added) = entry.get("append_messages") {
                append_messages(&mut messages, &mut seen, added)?;
            }
            entries += 1;
            if entries > 10_000 {
                return Err(Error::InvalidArgument);
            }
        }
    }
    unchanged(path, &metadata)?;
    if let Some(metadata) = journal_metadata {
        unchanged(&journal_path, &metadata)?;
    } else if journal_path.try_exists()? {
        return Err(Error::InvalidEvent);
    }
    if offset > messages.len() as u64 {
        return Err(Error::InvalidArgument);
    }
    let mut output = Vec::new();
    let mut output_bytes = 0;
    let mut next_offset = offset;
    for message in messages.iter().skip(offset as usize) {
        if let Some(message) = normalize(message) {
            validate_message(&message)?;
            let size = serde_json::to_vec(&message)
                .map_err(|_| Error::InvalidEvent)?
                .len();
            if size > MAX_PAGE {
                return Err(Error::InvalidEvent);
            }
            if output.len() == usize::from(limit) || output_bytes + size > MAX_PAGE {
                break;
            }
            output_bytes += size;
            output.push(message);
        }
        next_offset += 1;
    }
    Ok(TranscriptPage {
        schema_version: 1,
        view: "record_stream",
        agent: TranscriptAgent::Jcode,
        messages: output,
        next_offset,
        has_more: next_offset < messages.len() as u64,
        branch_id: None,
        truncated: false,
    })
}

fn normalize(message: &Value) -> Option<Value> {
    let role = message["role"].as_str()?;
    if !matches!(role, "user" | "assistant") || message["display_role"].is_string() {
        return None;
    }
    let mut blocks = Vec::new();
    for part in message["content"].as_array()? {
        match part["type"].as_str()? {
            "anthropic_thinking" => {
                blocks.push(block("thinking", string(part, "thinking")?, None, None))
            }
            "reasoning_trace" => blocks.push(block("thinking", string(part, "text")?, None, None)),
            _ => blocks.extend(content(&json!([part]))),
        }
    }
    if blocks.is_empty() {
        return None;
    }
    let mut output = json!({"id":string(message,"id")?,"role":role,"blocks":blocks});
    if let Some(timestamp) = string(message, "timestamp") {
        output["timestamp"] = json!(timestamp);
    }
    let mut usage = serde_json::Map::new();
    for (source, key) in [
        ("input_tokens", "inputTokens"),
        ("output_tokens", "outputTokens"),
        ("cache_read_input_tokens", "cacheReadTokens"),
        ("cache_creation_input_tokens", "cacheWriteTokens"),
    ] {
        if let Some(count) = message["token_usage"][source].as_u64() {
            usage.insert(key.into(), json!(count));
        }
    }
    if !usage.is_empty() {
        output["usage"] = json!(usage);
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn checkpoint_replacement_is_detected_even_with_the_same_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        std::fs::write(&path, b"old").unwrap();
        let before = std::fs::metadata(&path).unwrap();
        let replacement = dir.path().join("replacement.json");
        std::fs::write(&replacement, b"new").unwrap();
        #[cfg(windows)]
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(replacement, &path).unwrap();
        assert!(unchanged(&path, &before).is_err());
    }
}
