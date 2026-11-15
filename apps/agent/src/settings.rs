use crate::{private_json, Error, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub schema_version: u8,
    pub revision: u64,
    pub transcript_discovery_enabled: bool,
    pub recorded_usage_enabled: bool,
    pub device_tools_enabled: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            transcript_discovery_enabled: true,
            recorded_usage_enabled: true,
            device_tools_enabled: true,
        }
    }
}

#[derive(Clone, Copy)]
pub enum Operation {
    TranscriptDiscovery,
    RecordedUsage,
    DeviceTools,
}
impl Settings {
    pub fn check(&self, operation: Operation) -> Result<()> {
        let (enabled, reason) = match operation {
            Operation::TranscriptDiscovery => (
                self.transcript_discovery_enabled,
                "TranscriptDiscoveryDisabled",
            ),
            Operation::RecordedUsage => (self.recorded_usage_enabled, "UsageInspectionDisabled"),
            Operation::DeviceTools => (self.device_tools_enabled, "DeviceToolsDisabled"),
        };
        if enabled {
            Ok(())
        } else {
            Err(Error::Settings(reason))
        }
    }
    fn validate(&self) -> Result<()> {
        if self.schema_version != 1 || self.revision > private_json::MAX_REVISION {
            return Err(Error::InvalidArgument);
        }
        Ok(())
    }
}

/// Absent settings return compatibility defaults without creating any file.
pub fn read(directory: &Path) -> Result<Settings> {
    let Some(bytes) = private_json::read(directory, "settings.json")? else {
        return Ok(Settings::default());
    };
    let settings: Settings = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidArgument)?;
    settings.validate()?;
    Ok(settings)
}

pub fn update(
    directory: &Path,
    expected_revision: u64,
    discovery: bool,
    usage: bool,
    devices: bool,
) -> Result<Settings> {
    private_json::update_revisioned(
        directory,
        "settings.json",
        "settings.lock",
        expected_revision,
        || Ok(read(directory)?.revision),
        |revision| Settings {
            schema_version: 1,
            revision,
            transcript_discovery_enabled: discovery,
            recorded_usage_enabled: usage,
            device_tools_enabled: devices,
        },
    )
}
