use super::{ProviderWindow, RecordedContext, MAX_SAFE_INTEGER};
use crate::{
    transcript::{open_transcript, TranscriptAgent, TranscriptPage},
    Error, Result,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

pub(super) struct Window {
    pub page: TranscriptPage,
    pub context: Option<RecordedContext>,
    pub windows: Vec<ProviderWindow>,
}

fn counter(value: &Value) -> Result<Option<u64>> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_u64()
        .filter(|count| *count <= MAX_SAFE_INTEGER)
        .map(Some)
        .ok_or(Error::InvalidEvent)
}
fn time(value: &Value, observed: DateTime<Utc>) -> (Option<String>, &'static str) {
    let recorded = value
        .as_str()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok());
    let freshness = recorded
        .map(|recorded| {
            let age = observed.signed_duration_since(recorded);
            if age < chrono::TimeDelta::zero() {
                "unknown"
            } else if age > chrono::TimeDelta::minutes(15) {
                "stale"
            } else {
                "fresh"
            }
        })
        .unwrap_or("unknown");
    (recorded.map(|value| value.to_rfc3339()), freshness)
}
fn label(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .filter(|value| {
            !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
        })
        .map(|value| Some(value.to_owned()))
        .ok_or(Error::InvalidEvent)
}

pub(super) fn read(path: &Path, offset: u64, observed: DateTime<Utc>) -> Result<Window> {
    let mut file = open_transcript(path)?;
    let before = file.metadata()?;
    if offset > before.len() {
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
    let mut reader = BufReader::new(file.take(before.len() - offset));
    let mut cursor = offset;
    let mut pending_tail = false;
    let mut reports = 0;
    let mut messages = Vec::new();
    let mut context = None;
    let mut limits: VecDeque<(Option<String>, Vec<ProviderWindow>)> = VecDeque::new();
    while cursor < before.len() && cursor - offset < 4 * 1024 * 1024 && reports < 100 {
        let mut line = Vec::new();
        let size = reader
            .by_ref()
            .take(256 * 1024 + 1)
            .read_until(b'\n', &mut line)? as u64;
        if size > 256 * 1024 {
            return Err(Error::InvalidEvent);
        }
        if line.last() != Some(&b'\n') {
            pending_tail = true;
            break;
        }
        if cursor - offset + size > 4 * 1024 * 1024 {
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            cursor += size;
            continue;
        }
        let record: Value = serde_json::from_slice(&line).map_err(|_| Error::InvalidEvent)?;
        if !record.is_object() {
            return Err(Error::InvalidEvent);
        }
        if record["type"] == "event_msg" && record["payload"]["type"] == "token_count" {
            reports += 1;
            let event = &record["payload"];
            let (recorded_at, freshness) = time(&record["timestamp"], observed);
            let info = &event["info"];
            context = if info.is_null() {
                None
            } else {
                if !info.is_object() {
                    return Err(Error::InvalidEvent);
                }
                Some(RecordedContext {
                    source: "codex_token_count",
                    used_tokens: counter(&info["last_token_usage"]["total_tokens"])?,
                    limit_tokens: counter(&info["model_context_window"])?,
                    recorded_at: recorded_at.clone(),
                    freshness,
                })
            };
            let last = &info["last_token_usage"];
            if !last.is_null() {
                if !last.is_object() {
                    return Err(Error::InvalidEvent);
                }
                let mut usage = serde_json::Map::new();
                for (source, target) in [
                    ("input_tokens", "inputTokens"),
                    ("output_tokens", "outputTokens"),
                    ("cached_input_tokens", "cacheReadTokens"),
                    ("cache_write_input_tokens", "cacheWriteTokens"),
                ] {
                    if let Some(count) = counter(&last[source])? {
                        usage.insert(target.into(), json!(count));
                    }
                }
                if !usage.is_empty() {
                    let mut message = json!({"id":format!("record-{cursor}"),"usage":usage});
                    if let Some(recorded_at) = &recorded_at {
                        message["timestamp"] = json!(recorded_at);
                    }
                    messages.push(message);
                }
            }
            let rate = &event["rate_limits"];
            if rate.is_null() {
                limits.clear();
            } else {
                if !rate.is_object() {
                    return Err(Error::InvalidEvent);
                }
                let id = label(&rate["limit_id"])?;
                limits.retain(|(key, _)| key != &id);
                let mut windows = Vec::new();
                for kind in ["primary", "secondary"] {
                    let value = &rate[kind];
                    if value.is_null() {
                        continue;
                    }
                    let used = value["used_percent"]
                        .as_f64()
                        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
                        .ok_or(Error::InvalidEvent)?;
                    let duration = counter(&value["window_minutes"])?;
                    if duration == Some(0) {
                        return Err(Error::InvalidEvent);
                    }
                    let resets_at = if value["resets_at"].is_null() {
                        None
                    } else {
                        let seconds = value["resets_at"].as_i64().ok_or(Error::InvalidEvent)?;
                        Some(
                            DateTime::<Utc>::from_timestamp(seconds, 0)
                                .ok_or(Error::InvalidEvent)?
                                .to_rfc3339(),
                        )
                    };
                    let window_freshness = if freshness == "fresh"
                        && resets_at.as_ref().is_some_and(|reset| {
                            DateTime::parse_from_rfc3339(reset).is_ok_and(|reset| reset <= observed)
                        }) {
                        "stale"
                    } else {
                        freshness
                    };
                    windows.push(ProviderWindow {
                        provider: "codex",
                        account_id: None,
                        limit_id: id.clone(),
                        kind,
                        used_percent: used,
                        window_minutes: duration,
                        resets_at,
                        recorded_at: recorded_at.clone(),
                        freshness: window_freshness,
                    });
                }
                limits.push_back((id, windows));
                if limits.len() > 8 {
                    limits.pop_front();
                }
            }
        }
        cursor += size;
    }
    let after = open_transcript(path)?.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(Error::InvalidEvent);
        }
    }
    if after.len() < before.len()
        || (after.len() == before.len() && after.modified()? != before.modified()?)
    {
        return Err(Error::InvalidEvent);
    }
    Ok(Window {
        page: TranscriptPage {
            schema_version: 1,
            view: "record_stream",
            agent: TranscriptAgent::Codex,
            messages,
            next_offset: cursor,
            has_more: !pending_tail && cursor < before.len(),
            branch_id: None,
            truncated: false,
        },
        context,
        windows: limits
            .into_iter()
            .flat_map(|(_, windows)| windows)
            .collect(),
    })
}
