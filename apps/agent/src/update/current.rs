//! The installed companion: the managed copy when there is one, else the running executable.
use super::{
    process,
    report::{Current, Failure, Fault},
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const NAME: &str = if cfg!(windows) {
    "lazysh-agent.exe"
} else {
    "lazysh-agent"
};

/// The release target of this build, or `None` for a platform no release is published for.
pub fn target() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-agent-x64",
        ("linux", "aarch64") => "linux-agent-arm64",
        ("macos", "x86_64") => "macos-agent-x64",
        ("macos", "aarch64") => "macos-agent-arm64",
        ("windows", "x86_64") => "windows-agent-x64",
        _ => return None,
    })
}
/// `<user data>/lazysh/companion`: where the app and `installation install` place the companion.
pub fn managed_directory() -> Result<PathBuf, Fault> {
    let root = dirs::data_local_dir().filter(|root| root.is_absolute());
    Ok(root
        .ok_or(Failure::UnsafeInstallLocation)?
        .join("lazysh/companion"))
}
// A release asset is far smaller; development builds with debug information are the reason for the room.
const MAX_HASHED: u64 = 1 << 30;

/// SHA-256 and length of a regular local file.
pub fn hash(path: &Path) -> Result<(String, u64), Fault> {
    let file = lazysh_common::fs::read_options(false).open(path)?;
    if !file.metadata()?.is_file() {
        return Err(Failure::Internal.into());
    }
    let mut digest = Sha256::new();
    let bytes = std::io::copy(&mut file.take(MAX_HASHED + 1), &mut digest)?;
    if bytes > MAX_HASHED {
        return Err(Failure::Internal.into());
    }
    Ok((format!("{:x}", digest.finalize()), bytes))
}
/// A file only its owner can change, in a directory only its owner can change: the only kind this
/// command executes.
#[cfg(unix)]
fn trusted(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let sealed = |metadata: &fs::Metadata| {
        // SAFETY: geteuid has no preconditions.
        metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o022 == 0
    };
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && sealed(&m))
        && path
            .parent()
            .is_some_and(|dir| fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir() && sealed(&m)))
}
// shortcut: Windows ACLs are not inspected here; the Windows replace slice hardens the managed namespace check.
#[cfg(not(unix))]
fn trusted(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}
/// The version a trusted `path` reports, asked with an empty environment and a time limit.
pub fn version_of(path: &Path) -> Option<String> {
    trusted(path)
        .then(|| process::version_text(path, &std::env::temp_dir()))
        .flatten()
}
fn same_file(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}
pub fn detect() -> Result<Current, Fault> {
    let running = std::env::current_exe()?;
    let managed = managed_directory()?.join(NAME);
    let is_managed = fs::symlink_metadata(&managed).is_ok_and(|metadata| metadata.is_file());
    let path = if is_managed { managed } else { running.clone() };
    let version = if same_file(&path, &running) {
        Some(env!("CARGO_PKG_VERSION").to_owned())
    } else {
        version_of(&path)
    };
    let (sha256, bytes) = hash(&path)?;
    Ok(Current {
        version,
        path: path.to_string_lossy().into_owned(),
        sha256,
        bytes,
        managed: is_managed,
    })
}
