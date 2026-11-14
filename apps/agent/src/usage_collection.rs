//! Host policy for reading and recording usage ([ADR 0005](../../../docs/architecture/adr-0005-background-usage-collection.md)).
//! It lives in its own `usage-collection.json` because an older companion that shares the state directory reads
//! `settings.json` with `deny_unknown_fields` and would refuse a new key there.
use crate::{private_json, Error, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

const FILE: &str = "usage-collection.json";
const LOCK: &str = "usage-collection.lock";
const MAX_REVISION: u64 = 9_007_199_254_740_991;
pub const MIN_INTERVAL_MINUTES: u32 = 5;
pub const MAX_INTERVAL_MINUTES: u32 = 1440;
pub const DEFAULT_INTERVAL_MINUTES: u32 = 30;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub schema_version: u8,
    pub revision: u64,
    /// Whether `account-usage` may read provider quotas on this host.
    pub account_quota_enabled: bool,
    /// Whether the scheduled collector records samples. Set by `usage-collector enable|disable`.
    pub collector_enabled: bool,
    pub collector_interval_minutes: u32,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            account_quota_enabled: true,
            collector_enabled: false,
            collector_interval_minutes: DEFAULT_INTERVAL_MINUTES,
        }
    }
}
impl Policy {
    fn validate(&self) -> Result<()> {
        let interval = MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES;
        if self.schema_version != 1
            || self.revision > MAX_REVISION
            || !interval.contains(&self.collector_interval_minutes)
        {
            return Err(Error::InvalidArgument);
        }
        Ok(())
    }
}

/// Absent policy returns the defaults without creating any file. A malformed one is an error, so a
/// host that tried to forbid a read is never treated as allowing it.
pub fn read(directory: &Path) -> Result<Policy> {
    let Some(bytes) = private_json::read(directory, FILE)? else {
        return Ok(Policy::default());
    };
    let policy: Policy = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidArgument)?;
    policy.validate()?;
    Ok(policy)
}

/// Apply `change` when the stored revision is still `expected_revision`, under the policy lock.
pub fn update(
    directory: &Path,
    expected_revision: u64,
    change: impl FnOnce(&mut Policy),
) -> Result<Policy> {
    if expected_revision >= MAX_REVISION {
        return Err(Error::InvalidArgument);
    }
    let _lock = private_json::lock(directory, LOCK)?.ok_or(Error::Settings("SettingsBusy"))?;
    let mut policy = read(directory)?;
    if policy.revision != expected_revision {
        return Err(Error::Settings("SettingsConflict"));
    }
    change(&mut policy);
    policy.revision += 1;
    policy.validate()?;
    private_json::write(
        directory,
        FILE,
        &serde_json::to_vec(&policy).map_err(|_| Error::InvalidArgument)?,
    )?;
    Ok(policy)
}
