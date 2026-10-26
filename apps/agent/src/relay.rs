//! Explicit opt-in relay admission. Ordinary ingestion never constructs a network client.
mod run;
mod store;
use crate::{Error, Result, Store};
use lazysh_notification_client::{client::PublisherBinding, Kind};
pub use run::{run, RelayCommand};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub(crate) use store::{admit_transition, initialize};
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_CONFIG: usize = 16384;
const PENDING_LIMIT: i64 = 1000;
const TERMINAL_LIMIT: i64 = 100;
const RETRY_LIMIT: i64 = 3;
const TTL_SECONDS: i64 = 86400;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    schema_version: u8,
    capability_file: PathBuf,
    ca_file: Option<PathBuf>,
    binding: String,
    account_id: String,
    source_id: String,
    remote_generation: i64,
}
impl Configuration {
    fn validate(&self) -> Result<()> {
        if self.schema_version != 1 || self.remote_generation < 0 || self.binding.len() > 2048 {
            return Err(invalid());
        }
        let binding: PublisherBinding =
            serde_json::from_str(&self.binding).map_err(|_| invalid())?;
        if binding.account_id.to_string() != self.account_id
            || binding.source_id.to_string() != self.source_id
        {
            return Err(invalid());
        }
        for path in std::iter::once(&self.capability_file).chain(self.ca_file.iter()) {
            if !path.is_absolute()
                || path.as_os_str().len() > 4096
                || path
                    .to_str()
                    .is_none_or(|s| s.chars().any(char::is_control))
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
    fn encode(&self) -> Result<String> {
        self.validate()?;
        let text = serde_json::to_string(self).map_err(|_| invalid())?;
        if text.len() > MAX_CONFIG {
            return Err(invalid());
        }
        Ok(text)
    }
    fn decode(text: &str) -> Result<Self> {
        if text.len() > MAX_CONFIG {
            return Err(invalid());
        }
        let config: Self = serde_json::from_str(text).map_err(|_| invalid())?;
        config.validate()?;
        Ok(config)
    }
}
fn invalid() -> Error {
    Error::Relay("RelayInvalidConfiguration")
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub schema_version: u8,
    pub supported: bool,
    pub revision: u64,
    pub configured: bool,
    pub enabled: bool,
    pub account_id: Option<String>,
    pub source_id: Option<String>,
    pub remote_generation: Option<i64>,
    pub pending: u64,
    pub retained_recorded: u64,
    pub retained_blocked: u64,
    pub retained_unknown: u64,
    pub capacity_failures: u64,
}
struct Policy {
    revision: i64,
    enabled: bool,
    config: Option<String>,
    capacity_failures: i64,
}
struct Job {
    id: String,
    revision: i64,
    config: Configuration,
    kind: Kind,
    attempts: i64,
}
impl Store {
    pub fn relay_status(&self) -> Result<RelayStatus> {
        store::status(&self.connection)
    }
    pub fn relay_disable(&mut self, expected_revision: u64) -> Result<RelayStatus> {
        store::change(&mut self.connection, expected_revision, None, false)
    }
}

#[cfg(test)]
mod tests;
