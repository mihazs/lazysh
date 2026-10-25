use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

const MAX_CONFIG: u64 = 4096;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

struct UpdateLock(File);
impl Drop for UpdateLock {
    fn drop(&mut self) {
        // Release explicitly: a concurrent process spawn can briefly inherit
        // the file description until close-on-exec, delaying close-only unlock.
        let _ = self.0.unlock();
    }
}

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
        if self.schema_version != 1 || self.revision > MAX_REVISION {
            return Err(Error::InvalidArgument);
        }
        Ok(())
    }
}

fn private(metadata: &fs::Metadata, directory: bool) -> Result<()> {
    if lazysh_common::fs::owner_only(metadata, directory) {
        Ok(())
    } else {
        Err(Error::InvalidArgument)
    }
}

fn directory_exists(directory: &Path) -> Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let absolute = if directory.is_absolute() {
            directory.to_owned()
        } else {
            std::env::current_dir()?.join(directory)
        };
        for parent in absolute.ancestors().skip(1) {
            if parent.as_os_str().is_empty() {
                continue;
            }
            match fs::metadata(parent) {
                Ok(metadata) => {
                    let trusted_owner =
                        metadata.uid() == 0 || metadata.uid() == unsafe { libc::geteuid() };
                    let mutable = metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0;
                    if !metadata.is_dir() || !trusted_owner || mutable {
                        return Err(Error::InvalidArgument);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(Error::InvalidArgument);
            }
            private(&metadata, true)?;
            Ok(true)
        }
    }
}
fn options(write: bool) -> OpenOptions {
    lazysh_common::fs::read_options(write)
}

fn open(path: &Path, write: bool) -> Result<File> {
    // Unix O_NOFOLLOW closes the check/open race; other hosts also refuse known links.
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(Error::InvalidArgument);
    }
    let file = options(write).open(path)?;
    private(&file.metadata()?, false)?;
    Ok(file)
}

/// Absent settings return compatibility defaults without creating any file.
pub fn read(directory: &Path) -> Result<Settings> {
    if !directory_exists(directory)? {
        return Ok(Settings::default());
    }
    let path = directory.join("settings.json");
    let file = match open(&path, false) {
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Settings::default())
        }
        result => result?,
    };
    if file.metadata()?.len() > MAX_CONFIG {
        return Err(Error::InvalidArgument);
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err(Error::InvalidArgument);
    }
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
    if expected_revision >= MAX_REVISION {
        return Err(Error::InvalidArgument);
    }
    if !directory_exists(directory)? {
        lazysh_common::fs::private_directory(directory)?;
    }
    directory_exists(directory)?;
    let path = directory.join("settings.lock");
    let lock = match options(true).create_new(true).open(&path) {
        Ok(file) => {
            private(&file.metadata()?, false)?;
            file
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => open(&path, true)?,
        Err(error) => return Err(error.into()),
    };
    lock.try_lock()
        .map_err(|_| Error::Settings("SettingsBusy"))?;
    let _lock = UpdateLock(lock);
    let current = read(directory)?;
    if current.revision != expected_revision {
        return Err(Error::Settings("SettingsConflict"));
    }
    let settings = Settings {
        schema_version: 1,
        revision: current.revision + 1,
        transcript_discovery_enabled: discovery,
        recorded_usage_enabled: usage,
        device_tools_enabled: devices,
    };
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(temporary.as_file_mut(), &settings)
        .map_err(|_| Error::InvalidArgument)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(directory.join("settings.json"))
        .map_err(|error| Error::Io(error.error))?;
    #[cfg(unix)]
    File::open(directory)?.sync_all()?;
    Ok(settings)
}
