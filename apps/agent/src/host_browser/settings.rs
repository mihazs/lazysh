//! The host browser switch, off by default (docs/host-browser.md, "Opt-in and launch model").
//!
//! It lives in its own strict file next to `settings.json`, not in it: that file refuses unknown fields, so a
//! field added there would make every released companion and client that shares the state directory fail on the
//! other three switches. An absent file means off and is never created by a read.
use crate::{private_json, Error, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

const FILE: &str = "host-browser.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostBrowserSettings {
    pub schema_version: u8,
    pub revision: u64,
    pub host_browser_enabled: bool,
}
impl Default for HostBrowserSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            host_browser_enabled: false,
        }
    }
}

/// Absent settings are the default (off) and create nothing. Malformed or unsupported settings are an error.
pub fn read(directory: &Path) -> Result<HostBrowserSettings> {
    let Some(bytes) = private_json::read(directory, FILE)? else {
        return Ok(HostBrowserSettings::default());
    };
    let settings: HostBrowserSettings =
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidArgument)?;
    if settings.schema_version != 1 || settings.revision > private_json::MAX_REVISION {
        return Err(Error::InvalidArgument);
    }
    Ok(settings)
}

pub fn update(
    directory: &Path,
    expected_revision: u64,
    enabled: bool,
) -> Result<HostBrowserSettings> {
    private_json::update_revisioned(
        directory,
        FILE,
        "host-browser.lock",
        expected_revision,
        || Ok(read(directory)?.revision),
        |revision| HostBrowserSettings {
            schema_version: 1,
            revision,
            host_browser_enabled: enabled,
        },
    )
}

/// Fails closed: off, absent, malformed and unreadable settings all refuse, before anything is started.
pub fn require_enabled(directory: &Path) -> Result<()> {
    if read(directory)?.host_browser_enabled {
        Ok(())
    } else {
        Err(Error::Settings("HostBrowserDisabled"))
    }
}
