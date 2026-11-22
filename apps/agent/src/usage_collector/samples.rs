//! `usage-samples.json`: the collector's bounded record. Each sample is a projection of the quota report that
//! keeps percentages, resets and staleness and nothing else (no plan, balance, text, credential or path).
use crate::{private_json, Error, Result};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use lazysh_account_usage::{Response, Row};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FILE: &str = "usage-samples.json";
pub const MAX_BYTES: usize = 1024 * 1024;
pub const MAX_SAMPLES: usize = 1000;
pub const RETENTION_DAYS: i64 = 7;
const MAX_ENTRIES: usize = 32;
const MAX_ROWS: usize = 16;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Store {
    pub schema_version: u8,
    pub last_run: Option<LastRun>,
    pub samples: Vec<Sample>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            schema_version: 1,
            last_run: None,
            samples: Vec::new(),
        }
    }
}

/// The newest attempt, recorded even when it produced no sample (a forbidden or failed read).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastRun {
    pub at: String,
    /// `recorded`, `skipped` or `unavailable`.
    pub outcome: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sample {
    pub recorded_at: String,
    pub source: String,
    pub truncated: bool,
    pub entries: Vec<Entry>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub status: String,
    pub stale: bool,
    pub fetched_at: Option<String>,
    pub rows: Vec<Metric>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metric {
    pub label: String,
    pub percent: f64,
    /// `used` or `left`: what `percent` measures.
    pub reading: String,
    pub reset_at: Option<String>,
    pub window_seconds: Option<u64>,
}

pub fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

impl Sample {
    /// `None` unless the read produced a report: an unavailable read has nothing to record.
    pub fn from_response(response: &Response, at: DateTime<Utc>) -> Option<Self> {
        let (report, source) = (response.report.as_ref()?, response.source.clone()?);
        let mut truncated = report.entries.len() > MAX_ENTRIES;
        let entries = report
            .entries
            .iter()
            .take(MAX_ENTRIES)
            .map(|entry| {
                let metrics = entry.rows.iter().filter_map(|row| match row {
                    Row::Metric {
                        label,
                        percent,
                        reading,
                        reset_at,
                        window_seconds,
                        ..
                    } => Some(Metric {
                        label: label.clone(),
                        percent: *percent,
                        reading: reading.clone(),
                        reset_at: reset_at.clone(),
                        window_seconds: *window_seconds,
                    }),
                    Row::Text { .. } => None,
                });
                let rows: Vec<_> = metrics.collect();
                truncated |= rows.len() > MAX_ROWS;
                Entry {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    status: entry.status.clone(),
                    stale: entry.stale,
                    fetched_at: entry.fetched_at.clone(),
                    rows: rows.into_iter().take(MAX_ROWS).collect(),
                }
            })
            .collect();
        Some(Self {
            recorded_at: timestamp(at),
            source,
            truncated,
            entries,
        })
    }
}

impl Store {
    /// An absent file is an empty store and creates nothing; an unreadable one is an error, never repaired.
    pub fn read(directory: &Path) -> Result<Self> {
        let Some(bytes) = private_json::read_limited(directory, FILE, MAX_BYTES as u64)? else {
            return Ok(Self::default());
        };
        let store: Self = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidArgument)?;
        if store.schema_version != 1 {
            return Err(Error::InvalidArgument);
        }
        Ok(store)
    }

    /// Drop what is older than the retention, then the oldest samples until the count and the size fit.
    pub fn prune(&mut self, now: DateTime<Utc>) {
        let oldest = now - Duration::days(RETENTION_DAYS);
        self.samples.retain(|sample| {
            DateTime::parse_from_rfc3339(&sample.recorded_at).is_ok_and(|at| at >= oldest)
        });
        let excess = self.samples.len().saturating_sub(MAX_SAMPLES);
        self.samples.drain(..excess);
        let sizes: Vec<usize> = self
            .samples
            .iter()
            .map(|sample| serde_json::to_vec(sample).map_or(MAX_BYTES, |bytes| bytes.len() + 1))
            .collect();
        // Everything but the samples: the envelope and the last run, with room for the newline.
        let overhead = serde_json::to_vec(&Self {
            samples: Vec::new(),
            ..self.clone()
        })
        .map_or(MAX_BYTES, |bytes| bytes.len() + 1);
        let mut total = overhead + sizes.iter().sum::<usize>();
        let mut dropped = 0;
        while total > MAX_BYTES && dropped < sizes.len() {
            total -= sizes[dropped];
            dropped += 1;
        }
        self.samples.drain(..dropped);
    }

    pub fn write(&self, directory: &Path) -> Result<()> {
        private_json::write(
            directory,
            FILE,
            &serde_json::to_vec(self).map_err(|_| Error::InvalidArgument)?,
        )
    }
}
