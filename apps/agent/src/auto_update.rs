//! `auto-update.json`: whether this companion updates itself. Absent means the default, `install`,
//! and creates nothing. A file this companion does not fully understand is refused, never guessed at.
use crate::{private_json, Error, Result};
use clap::{Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

mod app;
pub use app::{trigger, Update, ENV as APP_VERSION_ENV};

const NAME: &str = "auto-update.json";
const MAX_REVISION: u64 = 9_007_199_254_740_991;

/// `off` never touches the network, `notify` never changes the executable, and `install` also lets a
/// newer lazysh app that connects update this companion to the app's own version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Off,
    Notify,
    Install,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoUpdate {
    pub schema_version: u8,
    pub revision: u64,
    pub policy: Policy,
}
impl Default for AutoUpdate {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            policy: Policy::Install,
        }
    }
}

pub fn read(directory: &Path) -> Result<AutoUpdate> {
    let Some(bytes) = private_json::read(directory, NAME)? else {
        return Ok(AutoUpdate::default());
    };
    let found: AutoUpdate = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidArgument)?;
    if found.schema_version != 1 || found.revision > MAX_REVISION {
        return Err(Error::InvalidArgument);
    }
    Ok(found)
}

pub fn set(directory: &Path, expected_revision: u64, policy: Policy) -> Result<AutoUpdate> {
    if expected_revision >= MAX_REVISION {
        return Err(Error::InvalidArgument);
    }
    let _held = private_json::lock(directory, "auto-update.lock")?
        .ok_or(Error::Settings("SettingsBusy"))?;
    let current = read(directory)?;
    if current.revision != expected_revision {
        return Err(Error::Settings("SettingsConflict"));
    }
    let next = AutoUpdate {
        revision: current.revision + 1,
        policy,
        ..current
    };
    let bytes = serde_json::to_vec(&next).map_err(|_| Error::InvalidArgument)?;
    private_json::write(directory, NAME, &bytes)?;
    Ok(next)
}

#[derive(Subcommand)]
pub enum Command {
    /// Show the policy and the last update an app started; creates no state.
    Status,
    /// Change the policy. `install` is the default for a companion with no file.
    Set {
        #[arg(long)]
        expected_revision: u64,
        #[arg(long, value_enum)]
        policy: Policy,
    },
    /// What a newer app starts in the background; runs one update to the app's version.
    #[command(hide = true)]
    Run {
        #[arg(long)]
        app_version: String,
    },
}
pub fn execute(command: Command) -> Result<Value> {
    let directory = crate::state_directory()?;
    let settings = match command {
        Command::Run { app_version } => return app::run(&app_version),
        Command::Status => read(&directory)?,
        Command::Set {
            expected_revision,
            policy,
        } => set(&directory, expected_revision, policy)?,
    };
    let mut output = serde_json::to_value(settings).map_err(|_| Error::InvalidArgument)?;
    output["appUpdate"] = app::recorded(&directory);
    Ok(json!(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_with_no_file_installs_and_reading_creates_nothing() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        assert_eq!(read(&state).unwrap().policy, Policy::Install);
        assert!(!state.exists());
    }
    #[test]
    fn setting_needs_the_current_revision_and_bumps_it() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        assert_eq!(set(&state, 0, Policy::Off).unwrap().revision, 1);
        assert!(matches!(
            set(&state, 0, Policy::Notify),
            Err(Error::Settings("SettingsConflict"))
        ));
        assert_eq!(read(&state).unwrap().policy, Policy::Off);
    }
    #[test]
    fn a_file_from_a_newer_companion_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        set(&state, 0, Policy::Off).unwrap();
        let path = state.join(NAME);
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"revision":1,"policy":"off","channel":"stable"}"#,
        )
        .unwrap();
        assert!(read(&state).is_err());
    }
}
