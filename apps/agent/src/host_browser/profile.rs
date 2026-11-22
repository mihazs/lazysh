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
    time::{Duration, Instant},
};

const ROOT: &str = "host-browser";
const KEPT: &str = "kept";

pub struct Profile {
    dir: PathBuf,
    marker: Option<PathBuf>,
    keep: bool,
}
impl Profile {
    pub fn path(&self) -> &Path {
        &self.dir
    }
}
impl Profile {
    // Caller holds the stable coordination lock throughout cleanup.
    fn cleanup(&mut self) -> Result<()> {
        let Some(marker) = self.marker.take() else {
            return Ok(());
        };
        if owner(&marker) != Some(std::process::id()) {
            return Err(Error::Browser("BrowserProfileInUse"));
        }
        if !self.keep {
            fs::remove_dir_all(&self.dir)?;
        }
        fs::remove_file(marker)?;
        Ok(())
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        if self.marker.is_some() {
            if let Some(root) = self.dir.parent() {
                if let Ok(_lock) = coordinate(root) {
                    let _ = self.cleanup();
                }
            }
        }
    }
}

// A stable private file serializes stale checks and their mutations; never unlink it.
fn coordinate(root: &Path) -> Result<private_json::Lock> {
    let state = root.parent().ok_or(Error::InvalidArgument)?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(lock) = private_json::lock(state, "host-browser-profiles.lock")? {
            return Ok(lock);
        }
        if Instant::now() >= deadline {
            return Err(Error::Browser("BrowserProfileInUse"));
        }
        std::thread::sleep(Duration::from_millis(10));
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
    sweep_inner(root, || {});
}

// Caller holds the coordination lock; the hook lets the regression pause at the stale decision.
fn sweep_inner(root: &Path, mut before_remove: impl FnMut()) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for marker in entries.flatten().map(|entry| entry.path()) {
        if marker
            .extension()
            .is_some_and(|extension| extension == "pid")
            && !owner(&marker).is_some_and(alive)
        {
            before_remove();
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
    let dir = root.join(name);
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    let created = match builder.create(&dir) {
        Ok(()) => true,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => false,
        Err(error) => {
            let _ = fs::remove_file(&marker);
            return Err(error.into());
        }
    };
    let checked = private_json::directory_exists(&dir).and_then(|exists| {
        if exists {
            Ok(())
        } else {
            Err(Error::InvalidArgument)
        }
    });
    if let Err(error) = checked {
        // Only an empty directory created by this attempt may be removed.
        if created {
            let _ = fs::remove_dir(&dir);
        }
        let _ = fs::remove_file(&marker);
        return Err(error);
    }
    Ok(Profile {
        dir,
        marker: Some(marker),
        keep,
    })
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
    let _lock = coordinate(&root)?;
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
    let _lock = coordinate(&root)?;
    sweep(&root);
    let existed = root.join(KEPT).exists();
    let mut profile = claimed(&root, KEPT, false)?;
    profile.cleanup()?;
    Ok(existed)
}

#[cfg(test)]
mod race_tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn profile_coordination_does_not_block_browser_settings() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let root = root(&state).unwrap();
        let _profile_lock = coordinate(&root).unwrap();
        let settings = super::super::settings::update(&state, 0, true).unwrap();
        assert!(settings.host_browser_enabled);
    }

    #[test]
    fn cleanup_refuses_a_replaced_marker() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let profile = create(&state, false).unwrap();
        let dir = profile.dir.clone();
        let marker = profile.marker.clone().unwrap();
        fs::write(&marker, b"0\n").unwrap();
        drop(profile);
        assert!(
            dir.is_dir(),
            "a replaced claim cannot authorize profile removal"
        );
        assert!(
            marker.is_file(),
            "a replaced claim cannot authorize marker removal"
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_setup_preserves_existing_directory_and_releases_claim() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let root = root(&state).unwrap();
        let existing = temp.path().join("existing");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("data"), b"preserve").unwrap();
        symlink(&existing, root.join("kept")).unwrap();
        assert!(create(&state, true).is_err());
        assert_eq!(fs::read(existing.join("data")).unwrap(), b"preserve");
        assert!(root.join("kept").is_symlink());
        assert!(!root.join("kept.pid").exists());
    }

    // A separate test process can hold the same OS lock without contacting a browser.
    #[test]
    fn profile_lock_child() {
        let Some(root) = std::env::var_os("LAZYSH_TEST_PROFILE_LOCK_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let _lock = coordinate(&root).unwrap();
        fs::write(root.join("ready"), b"").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("release").exists() {
            assert!(
                Instant::now() < deadline,
                "parent did not release owned lock"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn profile_lock_coordinates_separate_processes() {
        use std::process::{Child, Command, Stdio};
        struct ChildGuard(Option<Child>);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                if let Some(child) = &mut self.0 {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let root = root(&state).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "host_browser::profile::race_tests::profile_lock_child",
            ])
            .env("LAZYSH_TEST_PROFILE_LOCK_ROOT", &root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut child = ChildGuard(Some(child));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.join("ready").exists() {
            assert!(Instant::now() < deadline, "owned lock holder did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(
            create(&state, true),
            Err(Error::Browser("BrowserProfileInUse"))
        ));
        assert!(!root.join("kept.pid").exists());
        fs::write(root.join("release"), b"").unwrap();
        assert!(child.0.as_mut().unwrap().wait().unwrap().success());
        child.0 = None;
        let profile = create(&state, true).unwrap();
        assert!(matches!(
            clear(&state),
            Err(Error::Browser("BrowserProfileInUse"))
        ));
        drop(profile);
        assert!(clear(&state).unwrap());
    }

    #[test]
    fn stale_sweep_cannot_remove_a_fresh_kept_claim() {
        let state = tempfile::tempdir().unwrap();
        let state_path = state.path().join("state");
        let root = root(&state_path).unwrap();
        fs::write(root.join("kept.pid"), b"0\n").unwrap();
        let (seen_tx, seen_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let (created_tx, created_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let sweep_root = &root;
            let sweep = scope.spawn(move || {
                let _lock = coordinate(sweep_root).unwrap();
                sweep_inner(sweep_root, || {
                    seen_tx.send(()).unwrap();
                    continue_rx.recv().unwrap();
                });
            });
            seen_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            let state_path = &state_path;
            scope.spawn(move || created_tx.send(create(state_path, true)).unwrap());
            let early = created_rx.recv_timeout(Duration::from_millis(100));
            continue_tx.send(()).unwrap();
            sweep.join().unwrap();
            assert!(early.is_err(), "create must wait for stale cleanup");
            let first = created_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            assert!(
                matches!(
                    create(state_path, true),
                    Err(Error::Browser("BrowserProfileInUse"))
                ),
                "a delayed stale sweep must not remove a live kept claim"
            );
            drop(first);
        });
    }
}
