use crate::{
    transcript::{self, TranscriptAgent, TranscriptPage},
    Error, Result,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    schema_version: u8,
    agent: TranscriptAgent,
    scope: &'static str,
    observed_at: String,
    next_offset: u64,
    has_more: bool,
    samples_available: usize,
    samples: Vec<UsageSample>,
    context: Value,
    quota: Value,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSample {
    id: String,
    recorded_at: Option<String>,
    freshness: &'static str,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
}

/// Return recorded counters from one bounded transcript window; never add request counters.
pub fn read(
    path: &Path,
    agent: TranscriptAgent,
    session_id: Option<&str>,
    offset: u64,
) -> Result<UsageSnapshot> {
    let page = match agent {
        TranscriptAgent::Hermes | TranscriptAgent::Opencode => transcript::read_database_page(
            path,
            agent,
            session_id.ok_or(Error::InvalidArgument)?,
            offset,
            100,
        )?,
        _ => transcript::read_page(path, agent, offset, 100)?,
    };
    from_page(page, Utc::now())
}
pub fn from_page(page: TranscriptPage, observed_at: DateTime<Utc>) -> Result<UsageSnapshot> {
    if page.next_offset > MAX_SAFE_INTEGER || page.messages.len() > 100 {
        return Err(Error::InvalidEvent);
    }
    let mut samples = Vec::new();
    for message in page.messages {
        let Some(usage) = message.get("usage") else {
            continue;
        };
        if !usage.is_object() {
            return Err(Error::InvalidEvent);
        }
        let count = |field: &str| -> Result<Option<u64>> {
            usage
                .get(field)
                .map(|number| {
                    number
                        .as_u64()
                        .filter(|value| *value <= MAX_SAFE_INTEGER)
                        .ok_or(Error::InvalidEvent)
                })
                .transpose()
        };
        let input_tokens = count("inputTokens")?;
        let output_tokens = count("outputTokens")?;
        let cache_read_tokens = count("cacheReadTokens")?;
        let cache_write_tokens = count("cacheWriteTokens")?;
        if [
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
        ]
        .iter()
        .all(Option::is_none)
        {
            continue;
        }
        let id = message["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 4096)
            .ok_or(Error::InvalidEvent)?
            .to_owned();
        let recorded_at = message["timestamp"]
            .as_str()
            .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok());
        let freshness = recorded_at
            .map(|recorded| {
                let age = observed_at.signed_duration_since(recorded);
                if age < chrono::TimeDelta::zero() {
                    "unknown"
                } else if age > chrono::TimeDelta::minutes(15) {
                    "stale"
                } else {
                    "fresh"
                }
            })
            .unwrap_or("unknown");
        samples.push(UsageSample {
            id,
            recorded_at: recorded_at.map(|time| time.to_rfc3339()),
            freshness,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
        });
    }
    let last_by_id: HashMap<&str, usize> = samples
        .iter()
        .enumerate()
        .map(|(index, sample)| (sample.id.as_str(), index))
        .collect();
    let keep: Vec<bool> = samples
        .iter()
        .enumerate()
        .map(|(index, sample)| last_by_id.get(sample.id.as_str()) == Some(&index))
        .collect();
    samples = samples
        .into_iter()
        .zip(keep)
        .filter_map(|(sample, keep)| keep.then_some(sample))
        .collect();
    let samples_available = samples.len();
    if samples.len() > 20 {
        samples.drain(..samples.len() - 20);
    }
    Ok(UsageSnapshot {
        schema_version: 1,
        agent: page.agent,
        scope: "transcript_window",
        observed_at: observed_at.to_rfc3339(),
        next_offset: page.next_offset,
        has_more: page.has_more,
        samples_available,
        samples,
        context: json!({"usedTokens":null,"limitTokens":null,"remainingTokens":null}),
        quota: json!({"remaining":null,"resetsAt":null}),
    })
}
