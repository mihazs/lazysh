use super::{
    open_transcript, validate_message, Error, Result, TranscriptAgent, TranscriptPage, MAX_PAGE,
};
use serde_json::Value;
use std::{io::Read, path::Path};

pub(super) fn read(path: &Path) -> Result<Value> {
    let file = open_transcript(path)?;
    let before = file.metadata()?;
    if before.len() > 16 * 1024 * 1024 {
        return Err(Error::InvalidArgument);
    }
    let value =
        serde_json::from_reader(file.take(before.len())).map_err(|_| Error::InvalidEvent)?;
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
    Ok(value)
}

pub(super) fn page(
    values: &[Value],
    offset: u64,
    limit: u8,
    agent: TranscriptAgent,
    normalize: fn(&Value) -> Result<Option<Value>>,
) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) || values.len() > 10_000 || offset > values.len() as u64 {
        return Err(Error::InvalidArgument);
    }
    let mut messages = Vec::new();
    let mut next_offset = offset;
    let mut output_bytes = 0;
    for value in values.iter().skip(offset as usize) {
        if let Some(message) = normalize(value)? {
            validate_message(&message)?;
            if message["blocks"].as_array().is_some_and(|parts| {
                parts.iter().any(|part| {
                    part["text"]
                        .as_str()
                        .is_some_and(|text| text.len() > 262_144)
                })
            }) {
                return Err(Error::InvalidEvent);
            }
            let size = serde_json::to_vec(&message)
                .map_err(|_| Error::InvalidEvent)?
                .len();
            if size > MAX_PAGE {
                return Err(Error::InvalidEvent);
            }
            if messages.len() == usize::from(limit) || output_bytes + size > MAX_PAGE {
                break;
            }
            output_bytes += size;
            messages.push(message);
        }
        next_offset += 1;
    }
    Ok(TranscriptPage {
        schema_version: 1,
        view: "record_stream",
        agent,
        messages,
        next_offset,
        has_more: next_offset < values.len() as u64,
        branch_id: None,
        truncated: false,
        checkpoint: None,
    })
}
