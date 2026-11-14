//! The managed browser's profile: a private directory that one launcher owns and removes when it ends.
//!
//! It sits in `<state>/host-browser/`, claimed by a marker file `<name>.pid` that holds the launcher's pid. A
//! launcher that was killed leaves both behind, and the next start removes every profile whose marker names a
//! process that is gone. The profile holds the browser's cookies and sessions, so it is mode 0700, and it is
//! kept past a session only when the user asked for **Keep profile** (until **Clear browser data**).
use crate::{private_json, Error, Result};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

const ROOT: &str = "host-browser";
const KEPT: &str = "kept";

pub struct Profile {
    dir: PathBuf,
    marker: PathBuf,
    keep: bool,
}
impl Profile {
    pub fn path(&self) -> &Path {
        &self.dir
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.dir);
        }
        let _ = fs::remove_file(&self.marker);
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // Pid 0 and values above i32::MAX would address a process group or nothing at all.
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists; EPERM means it exists under another user.
    let exists = unsafe { libc::kill(pid as i32, 0) } == 0;
    exists || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
// shortcut: Windows never sweeps (every owner counts as alive), the launcher is Unix-first; the relay owns this.
#[cfg(not(unix))]
fn alive(_: u32) -> bool {
    true
}

/// The owner's pid, or `None` when the marker is unreadable: such a marker is stale (it is written atomically).
fn owner(marker: &Path) -> Option<u32> {
    fs::read_to_string(marker).ok()?.trim().parse().ok()
}

/// Take `marker` for this process, or fail when a running launcher already holds it.
fn claim(root: &Path, marker: &Path) -> Result<()> {
    for _ in 0..2 {
        let mut file = tempfile::NamedTempFile::new_in(root)?;
        writeln!(file, "{}", std::process::id())?;
        match file.persist_noclobber(marker) {
            Ok(_) => return Ok(()),
            Err(error) if error.error.kind() == ErrorKind::AlreadyExists => {
                if owner(marker).is_some_and(alive) {
                    return Err(Error::Browser("BrowserProfileInUse"));
                }
                let _ = fs::remove_file(marker);
            }
            Err(error) => return Err(error.error.into()),
        }
    }
    Err(Error::Browser("BrowserProfileInUse"))
}

/// Remove the profiles of launchers that no longer run. A stale kept profile loses only its marker.
fn sweep(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for marker in entries.flatten().map(|entry| entry.path()) {
        if marker
            .extension()
            .is_some_and(|extension| extension == "pid")
            && !owner(&marker).is_some_and(alive)
        {
            if marker.file_stem().is_some_and(|name| name != KEPT) {
                let _ = fs::remove_dir_all(marker.with_extension(""));
            }
            let _ = fs::remove_file(&marker);
        }
    }
}

fn claimed(root: &Path, name: &str, keep: bool) -> Result<Profile> {
    let marker = root.join(format!("{name}.pid"));
    claim(root, &marker)?;
    // Built first so that it releases the claim on every failure below.
    let profile = Profile {
        dir: root.join(name),
        marker,
        keep,
    };
    lazysh_common::fs::private_directory(&profile.dir)?;
    private_json::directory_exists(&profile.dir)?;
    Ok(profile)
}

fn root(state: &Path) -> Result<PathBuf> {
    if !private_json::directory_exists(state)? {
        lazysh_common::fs::private_directory(state)?;
    }
    let root = state.join(ROOT);
    lazysh_common::fs::private_directory(&root)?;
    private_json::directory_exists(&root)?;
    Ok(root)
}

/// A private profile for one launcher: a new one removed when it drops, or with `keep` the single kept one.
pub fn create(state: &Path, keep: bool) -> Result<Profile> {
    let root = root(state)?;
    sweep(&root);
    if keep {
        claimed(&root, KEPT, true)
    } else {
        claimed(
            &root,
            &format!("profile-{}", uuid::Uuid::new_v4().simple()),
            false,
        )
    }
}

/// **Clear browser data**: remove the kept profile. `Ok(false)` when there was none; refused while a launcher
/// uses it. Reads and removals only: it never creates the state directory.
pub fn clear(state: &Path) -> Result<bool> {
    let root = state.join(ROOT);
    if !private_json::directory_exists(&root)? {
        return Ok(false);
    }
    sweep(&root);
    let existed = root.join(KEPT).exists();
    drop(claimed(&root, KEPT, false)?);
    Ok(existed)
}
