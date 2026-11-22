//! Host switches kept in their own `host-features.json`, because an older companion that shares the
//! state directory reads `settings.json` with `deny_unknown_fields` and would refuse a new field there.
use crate::{private_json, Error, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostFeatures {
    pub schema_version: u8,
    pub revision: u64,
    pub simulator_streaming_enabled: bool,
    pub port_scan_enabled: bool,
}
impl Default for HostFeatures {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            simulator_streaming_enabled: true,
            port_scan_enabled: true,
        }
    }
}
impl HostFeatures {
    /// Only the live Android and iOS streams ask; port scanning is enforced by the app, which scans over SSH.
    pub fn check_simulator_streaming(&self) -> Result<()> {
        if self.simulator_streaming_enabled {
            Ok(())
        } else {
            Err(Error::Settings("SimulatorStreamingDisabled"))
        }
    }
}

/// An absent file reports both switches enabled and creates nothing.
pub fn read(directory: &Path) -> Result<HostFeatures> {
    private_json::read_or_default(
        directory,
        "host-features.json",
        |features: &HostFeatures| {
            features.schema_version == 1 && features.revision <= private_json::MAX_REVISION
        },
    )
}

pub fn update(
    directory: &Path,
    expected_revision: u64,
    simulator_streaming_enabled: bool,
    port_scan_enabled: bool,
) -> Result<HostFeatures> {
    private_json::update_revisioned(
        directory,
        "host-features.json",
        "host-features.lock",
        expected_revision,
        || Ok(read(directory)?.revision),
        |revision| HostFeatures {
            schema_version: 1,
            revision,
            simulator_streaming_enabled,
            port_scan_enabled,
        },
    )
}
