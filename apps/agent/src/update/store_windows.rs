//! The managed namespace on hosts without descriptor-relative file operations (Windows). Names are
//! paths inside one directory that the user owns by virtue of living under their own profile.
//!
//! A running `lazysh-agent.exe` can be renamed but not overwritten, so the replace is rename then
//! place: the installed file becomes `lazysh-agent.exe.previous` and the verified file takes its
//! name. Between the two renames the installed name does not exist; a failure of either puts the
//! previous file back. The same code runs on Unix under test, where the semantics are a superset.
use super::{
    current,
    report::{Failure, Fault},
    staging::{Identity, Staged as StagedFile, Staging, Swap},
};
use crate::{storage_filesystem, storage_namespace};
use std::{
    fs::{self, File, OpenOptions},
    path::PathBuf,
    thread,
    time::Duration,
};

pub const PREVIOUS: &str = if cfg!(windows) {
    "lazysh-agent.exe.previous"
} else {
    "lazysh-agent.previous"
};
// A file that can be started on Windows must end in `.exe`.
const SUFFIX: &str = if cfg!(windows) { ".exe" } else { "" };
const STAGED: &str = ".update-";

pub struct Store {
    dir: PathBuf,
    _lock: Option<File>,
    _scratch: Option<tempfile::TempDir>,
}
/// A file on its way into the namespace; it is removed unless it is committed.
pub struct Staged<'a> {
    path: PathBuf,
    pub staging: Staging,
    committed: bool,
    // Ties the staged file to the locked store it was made in, as on Unix.
    _store: std::marker::PhantomData<&'a Store>,
}
impl StagedFile for Staged<'_> {
    fn staging(&self) -> &Staging {
        &self.staging
    }
}
impl Drop for Staged<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}
/// The hash of an open file, read from the start.
pub fn hash(file: &mut File) -> Result<Identity, Fault> {
    current::hash_file(file.try_clone()?)
}

/// Antivirus and indexers hold new files for a moment; a few short retries cover that.
fn retried<T>(mut operation: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    for _ in 0..4 {
        match operation() {
            Ok(value) => return Ok(value),
            Err(_) => thread::sleep(Duration::from_millis(200)),
        }
    }
    operation()
}
fn unsafe_location(_: impl std::fmt::Debug) -> Fault {
    Failure::UnsafeInstallLocation.into()
}

impl Store {
    /// The managed namespace, locked against other updates. `Ok(None)` when it does not exist and
    /// `create` is not set.
    pub fn open(create: bool) -> Result<Option<Self>, Fault> {
        let dir = current::managed_directory()?;
        storage_namespace::resolve(&dir).map_err(unsafe_location)?;
        storage_filesystem::require_local(&dir).map_err(unsafe_location)?;
        if !dir.try_exists()? {
            if !create {
                return Ok(None);
            }
            storage_namespace::create(&dir).map_err(unsafe_location)?;
        }
        Self::in_directory(dir, true).map(Some)
    }
    fn in_directory(dir: PathBuf, locked: bool) -> Result<Self, Fault> {
        let metadata = fs::symlink_metadata(&dir)?;
        if !metadata.is_dir() || storage_namespace::is_link(&metadata) {
            return Err(Failure::UnsafeInstallLocation.into());
        }
        let lock = if locked {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(dir.join("installation.lock"))?;
            file.try_lock().map_err(|_| Failure::Busy)?;
            Some(file)
        } else {
            None
        };
        let store = Self {
            dir,
            _lock: lock,
            _scratch: None,
        };
        store.sweep();
        Ok(store)
    }
    /// A private throwaway directory, for a dry run on a host with no managed namespace yet.
    pub fn scratch() -> Result<Self, Fault> {
        let scratch = tempfile::tempdir()?;
        let mut store = Self::in_directory(scratch.path().to_owned(), false)?;
        store._scratch = Some(scratch);
        Ok(store)
    }
    /// Leftovers of a run that was killed: only ever called while holding the lock.
    fn sweep(&self) {
        for entry in fs::read_dir(&self.dir).into_iter().flatten().flatten() {
            if entry.file_name().to_string_lossy().starts_with(STAGED) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    pub fn installed_path(&self) -> PathBuf {
        self.dir.join(current::NAME)
    }
    pub fn path(&self, staged: &Staged) -> PathBuf {
        staged.path.clone()
    }
    pub fn exists(&self, name: &str) -> bool {
        self.dir.join(name).is_file()
    }
    /// The installed binary, if there is one. A link or a directory under its name is refused.
    pub fn current(&self) -> Result<Option<Identity>, Fault> {
        let path = self.installed_path();
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
            Ok(metadata) if metadata.is_file() && !storage_namespace::is_link(&metadata) => {
                current::hash(&path).map(Some)
            }
            Ok(_) => Err(Failure::UnsafeInstallLocation.into()),
        }
    }
    pub fn stage(&self) -> Result<Staged<'_>, Fault> {
        let path = self
            .dir
            .join(format!("{STAGED}{}{SUFFIX}", uuid::Uuid::new_v4()));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Staged {
            path,
            staging: Staging::new(file),
            committed: false,
            _store: std::marker::PhantomData,
        })
    }
    /// The kept previous binary, as a staged copy that is safe to self-test and install.
    pub fn copy_previous(&self, sha256: &str) -> Result<Staged<'_>, Fault> {
        let mut source = File::open(self.dir.join(PREVIOUS))?;
        let mut staged = self.stage()?;
        staged.staging.copy_of(&mut source, sha256, hash)?;
        Ok(staged)
    }
}

/// Rename then place: a running image can be renamed, not overwritten. The replaced binary becomes
/// the previous copy by that first rename, and the verified file then takes the installed name.
impl<'a> Swap<Staged<'a>> for Store {
    fn current(&self) -> Result<Option<Identity>, Fault> {
        Store::current(self)
    }
    fn installed_path(&self) -> PathBuf {
        self.dir.join(current::NAME)
    }
    fn place(
        &self,
        staged: &mut Staged<'a>,
        replaced: Option<&Identity>,
    ) -> Result<Option<String>, Fault> {
        let (installed, previous) = (self.installed_path(), self.dir.join(PREVIOUS));
        if replaced.is_some() {
            // The old kept copy goes first; one that is still in use stops the update before it
            // has changed anything.
            if previous.try_exists()? {
                retried(|| fs::remove_file(&previous)).map_err(unsafe_location)?;
            }
            retried(|| fs::rename(&installed, &previous)).map_err(unsafe_location)?;
        }
        if retried(|| fs::rename(&staged.path, &installed)).is_err() {
            let put_back = replaced.is_none() || self.restore(Some(PREVIOUS));
            return Err(if put_back {
                Failure::RolledBack
            } else {
                Failure::Uncertain
            }
            .into());
        }
        staged.committed = true;
        Ok(replaced.map(|_| PREVIOUS.to_owned()))
    }
    fn restore(&self, kept: Option<&str>) -> bool {
        let installed = self.installed_path();
        let removed = !installed.exists() || retried(|| fs::remove_file(&installed)).is_ok();
        removed
            && kept
                .is_none_or(|name| retried(|| fs::rename(self.dir.join(name), &installed)).is_ok())
    }
    fn retain(&self, _: Option<&str>) -> bool {
        true
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::update::{report::Failure, staging::commit};
    use std::os::unix::fs::PermissionsExt;

    fn companion(version: &str) -> Vec<u8> {
        format!("#!/bin/sh\necho lazysh-agent {version}\n").into_bytes()
    }
    fn sha(bytes: &[u8]) -> String {
        lazysh_companion_release::sha(bytes)
    }
    /// A locked store over a private directory that already holds an installed companion `1.0.0`.
    fn host(installed: bool) -> (tempfile::TempDir, Store) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("companion");
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        if installed {
            let path = dir.join(current::NAME);
            fs::write(&path, companion("1.0.0")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let store = Store::in_directory(dir, true).unwrap();
        (root, store)
    }
    fn staged<'a>(store: &'a Store, version: &str) -> Staged<'a> {
        let bytes = companion(version);
        let mut staged = store.stage().unwrap();
        staged.staging.write(&bytes).unwrap();
        staged
            .staging
            .seal(&sha(&bytes), bytes.len() as u64, hash)
            .unwrap();
        staged
    }
    /// The installed and the previous binary's bytes.
    fn holds(store: &Store) -> (Vec<u8>, Vec<u8>) {
        (
            fs::read(store.installed_path()).unwrap(),
            fs::read(store.dir.join(PREVIOUS)).unwrap(),
        )
    }
    fn names(store: &Store) -> Vec<String> {
        let mut names = fs::read_dir(&store.dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        names.sort();
        names
    }
    fn failure(error: Fault) -> Failure {
        error.failure
    }

    #[test]
    fn the_replaced_binary_becomes_the_previous_one_and_the_new_one_takes_its_name() {
        let (_root, store) = host(true);
        let kept = commit(&store, staged(&store, "2.0.0"), "2.0.0", || {}).unwrap();
        assert_eq!(
            kept,
            Some((sha(&companion("1.0.0")), companion("1.0.0").len() as u64))
        );
        assert_eq!(holds(&store), (companion("2.0.0"), companion("1.0.0")));
        assert_eq!(
            names(&store),
            ["installation.lock", current::NAME, PREVIOUS]
        );
        // The next update replaces the kept copy: the old one is deleted first, then the installed one kept.
        commit(&store, staged(&store, "3.0.0"), "3.0.0", || {}).unwrap();
        assert_eq!(holds(&store), (companion("3.0.0"), companion("2.0.0")));
        // Rollback is a copy of the kept file, installed the same way.
        let (digest, _) = current::hash(&store.dir.join(PREVIOUS)).unwrap();
        let back = store.copy_previous(&digest).unwrap();
        commit(&store, back, "2.0.0", || {}).unwrap();
        assert_eq!(holds(&store), (companion("2.0.0"), companion("3.0.0")));
    }

    #[test]
    fn a_failed_check_puts_the_previous_binary_back_and_leaves_nothing_behind() {
        let (_root, store) = host(true);
        let error = commit(&store, staged(&store, "2.0.0"), "9.9.9", || {}).unwrap_err();
        assert_eq!(failure(error), Failure::RolledBack);
        assert_eq!(
            fs::read(store.installed_path()).unwrap(),
            companion("1.0.0")
        );
        assert_eq!(names(&store), ["installation.lock", current::NAME]);

        // With nothing to put back, the failed binary is removed rather than left installed.
        let (_root, store) = host(false);
        let error = commit(&store, staged(&store, "2.0.0"), "9.9.9", || {}).unwrap_err();
        assert_eq!(failure(error), Failure::RolledBack);
        assert_eq!(names(&store), ["installation.lock"]);
    }

    #[test]
    fn a_kept_copy_that_cannot_be_deleted_stops_the_update_before_it_changes_anything() {
        let (_root, store) = host(true);
        // A directory under the kept name cannot be removed as a file, like a copy still in use.
        fs::create_dir(store.dir.join(PREVIOUS)).unwrap();
        let error = commit(&store, staged(&store, "2.0.0"), "2.0.0", || {}).unwrap_err();
        assert_eq!(failure(error), Failure::UnsafeInstallLocation);
        assert_eq!(
            fs::read(store.installed_path()).unwrap(),
            companion("1.0.0")
        );
    }

    #[test]
    fn only_one_update_holds_the_directory_and_leftovers_are_swept_under_the_lock() {
        let (_root, store) = host(true);
        fs::write(store.dir.join(".update-killed.exe"), b"x").unwrap();
        assert_eq!(
            failure(Store::in_directory(store.dir.clone(), true).err().unwrap()),
            Failure::Busy
        );
        let lock = store._lock.as_ref().unwrap();
        lock.unlock().unwrap();
        // Once free, the next holder removes what a killed run left.
        let next = Store::in_directory(store.dir.clone(), true).unwrap();
        assert!(!names(&next).iter().any(|name| name.starts_with(".update-")));
    }

    #[test]
    fn a_link_or_a_directory_under_the_installed_name_is_refused() {
        let (_root, store) = host(false);
        fs::create_dir(store.installed_path()).unwrap();
        assert_eq!(
            failure(store.current().unwrap_err()),
            Failure::UnsafeInstallLocation
        );
        fs::remove_dir(store.installed_path()).unwrap();
        std::os::unix::fs::symlink("elsewhere", store.installed_path()).unwrap();
        assert_eq!(
            failure(store.current().unwrap_err()),
            Failure::UnsafeInstallLocation
        );
    }

    #[test]
    fn staging_refuses_bytes_that_differ_from_the_expected_identity() {
        let (_root, store) = host(false);
        let mut file = store.stage().unwrap();
        file.staging.write(b"abc").unwrap();
        let error = file.staging.seal(&sha(b"abd"), 3, hash).unwrap_err();
        assert_eq!(error.detail, Some("digestMismatch"));
        let error = file.staging.seal(&sha(b"abc"), 4, hash).unwrap_err();
        assert_eq!(error.detail, Some("sizeMismatch"));
        let path = store.path(&file);
        drop(file);
        assert!(!path.exists(), "an unsealed file never survives its owner");
        // A copy of the previous binary is only made from the digest that was recorded for it.
        fs::write(store.dir.join(PREVIOUS), b"kept").unwrap();
        let error = store.copy_previous(&sha(b"other")).err().unwrap();
        assert_eq!(error.detail, Some("digestMismatch"));
    }
}
