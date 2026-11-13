//! The managed namespace (`<user data>/lazysh/companion`): staging, the atomic replace and the kept
//! previous copy. Linux and macOS; every name is relative to one retained, owner-only directory.
use super::{
    current,
    report::{Failure, Fault},
};
use crate::{
    installation::{self, Existing, Lock, Temporary, MAXIMUM, NAME},
    managed_directory::Directory,
    storage_filesystem, storage_namespace,
};
use std::{
    fs::{self},
    io::{Seek, SeekFrom, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
};

pub const PREVIOUS: &str = "lazysh-agent.previous";
const STAGED: &str = ".update-";
const KEPT: &str = ".previous-";

/// SHA-256 and length of a file.
pub type Identity = (String, u64);

pub struct Store {
    dir: Directory,
    _lock: Option<Lock>,
    _scratch: Option<tempfile::TempDir>,
}
/// A file on its way into the namespace. It is private and not executable until `seal` has
/// compared its bytes with the expected identity, and it disappears unless it is committed.
pub struct Staged<'a> {
    guard: Temporary<'a>,
    file: Option<fs::File>,
    identity: Option<Identity>,
}

impl Store {
    /// The managed namespace, locked against other installs and updates. `Ok(None)` when it does
    /// not exist and `create` is not set.
    pub fn open(create: bool) -> Result<Option<Self>, Fault> {
        let destination =
            installation::destination().map_err(|_| Failure::UnsafeInstallLocation)?;
        let parent = destination.parent().unwrap();
        storage_namespace::resolve(parent).map_err(|_| Failure::UnsafeInstallLocation)?;
        storage_filesystem::require_local(parent).map_err(|_| Failure::UnsafeInstallLocation)?;
        // An existing namespace must already be private and ours: it is never repaired here.
        let dir = if parent.try_exists()? {
            Directory::open(parent)?
        } else if create {
            installation::namespace(parent)?
        } else {
            return Ok(None);
        };
        let lock = installation::lock(&dir)?;
        dir.check()?;
        let store = Self {
            dir,
            _lock: Some(lock),
            _scratch: None,
        };
        store.sweep();
        Ok(Some(store))
    }
    /// A private throwaway directory, for a dry run on a host with no managed namespace yet.
    pub fn scratch() -> Result<Self, Fault> {
        let scratch = tempfile::tempdir()?;
        // The directory's mode follows the umask; the managed-directory rules want owner-only.
        fs::set_permissions(scratch.path(), fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            dir: Directory::open(scratch.path())?,
            _lock: None,
            _scratch: Some(scratch),
        })
    }
    /// Leftovers of a run that was killed: only ever called while holding the lock.
    fn sweep(&self) {
        let Ok(entries) = fs::read_dir(&self.dir.path) else {
            return;
        };
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with(STAGED) || name.starts_with(KEPT) {
                    let _ = self.dir.remove(name, false);
                }
            }
        }
    }
    pub fn installed_path(&self) -> PathBuf {
        self.dir.path.join(NAME)
    }
    pub fn path(&self, staged: &Staged) -> PathBuf {
        self.dir.path.join(&staged.guard.name)
    }
    pub fn exists(&self, name: &str) -> bool {
        self.dir.open_file(name, libc::O_RDONLY).is_ok()
    }
    /// The installed binary, if there is one.
    pub fn current(&self) -> Result<Option<Identity>, Fault> {
        Ok(match self.dir.existing()? {
            Existing::Missing => None,
            Existing::Present { sha256, bytes } => Some((sha256, bytes)),
        })
    }
    fn create(&self, prefix: &str) -> Result<Staged<'_>, Fault> {
        let name = format!("{prefix}{}", uuid::Uuid::new_v4());
        let file = self
            .dir
            .open_file(&name, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL)?;
        Ok(Staged {
            guard: Temporary::new(&self.dir, name),
            file: Some(file),
            identity: None,
        })
    }
    pub fn stage(&self) -> Result<Staged<'_>, Fault> {
        self.create(STAGED)
    }
    /// A private copy of `name` whose bytes match `sha256`, verified before and after the copy.
    fn copy(&self, name: &str, sha256: &str, prefix: &str) -> Result<Staged<'_>, Fault> {
        let mut source = self.dir.open_file(name, libc::O_RDONLY)?;
        let (digest, bytes) = installation::file_hash(&mut source, true)?;
        if digest != sha256 {
            return Err(Fault::detail(Failure::VerificationFailed, "digestMismatch"));
        }
        source.seek(SeekFrom::Start(0))?;
        let mut staged = self.create(prefix)?;
        std::io::copy(
            &mut std::io::Read::take(&mut source, MAXIMUM + 1),
            staged.file.as_mut().unwrap(),
        )?;
        staged.seal(&digest, bytes)?;
        Ok(staged)
    }
    /// The kept previous binary, as a staged copy that is safe to self-test and install.
    pub fn copy_previous(&self, sha256: &str) -> Result<Staged<'_>, Fault> {
        self.copy(PREVIOUS, sha256, STAGED)
    }
    /// Replace the installed binary with `staged` and prove the installed path answers `version`.
    /// The binary it replaces is kept as `lazysh-agent.previous`; its identity is returned when so.
    /// A failed proof restores that binary (`RolledBack`), or is `Uncertain` when it cannot.
    pub fn commit(
        &self,
        mut staged: Staged<'_>,
        version: &str,
        checking: impl FnOnce(),
    ) -> Result<Option<Identity>, Fault> {
        let expected = staged.identity.clone().ok_or(Failure::Internal)?;
        self.dir.check()?;
        let replaced = self.current()?;
        // What is replaced is copied first; the new file only goes live once that copy is safe.
        let mut kept = match &replaced {
            Some((sha256, _)) => Some(self.copy(NAME, sha256, KEPT)?),
            None => None,
        };
        self.dir.check()?;
        self.dir.rename(&staged.guard.name, NAME, false)?;
        staged.guard.committed = true;
        let _ = self.dir.file.sync_all();
        checking();
        let installed = self.current().ok().flatten();
        if installed.as_ref() != Some(&expected)
            || current::version_of(&self.installed_path()).as_deref() != Some(version)
        {
            let restored = match &kept {
                Some(old) => self.dir.rename(&old.guard.name, NAME, false).is_ok(),
                None => self.dir.remove(NAME, false).is_ok(),
            };
            if let Some(old) = kept.as_mut() {
                old.guard.committed = restored;
            }
            return Err(if restored {
                Failure::RolledBack
            } else {
                Failure::Uncertain
            }
            .into());
        }
        let retained = match kept.as_mut() {
            Some(old) if self.dir.rename(&old.guard.name, PREVIOUS, false).is_ok() => {
                old.guard.committed = true;
                replaced
            }
            _ => None,
        };
        let _ = self.dir.file.sync_all();
        Ok(retained)
    }
}

impl Staged<'_> {
    pub fn write(&mut self, chunk: &[u8]) -> Result<(), Fault> {
        Ok(self.file.as_mut().unwrap().write_all(chunk)?)
    }
    /// Compare what is on disk with the expected identity, then make it executable and close it.
    pub fn seal(&mut self, sha256: &str, bytes: u64) -> Result<(), Fault> {
        let file = self.file.as_mut().unwrap();
        file.sync_all()?;
        file.seek(SeekFrom::Start(0))?;
        let (digest, count) = installation::file_hash(file, true)?;
        if count != bytes {
            return Err(Fault::detail(Failure::VerificationFailed, "sizeMismatch"));
        }
        if digest != sha256 {
            return Err(Fault::detail(Failure::VerificationFailed, "digestMismatch"));
        }
        file.set_permissions(fs::Permissions::from_mode(0o700))?;
        // A binary cannot be executed while a descriptor open for writing remains.
        self.file = None;
        self.identity = Some((digest, count));
        Ok(())
    }
    pub fn identity(&self) -> Option<&Identity> {
        self.identity.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scratch_directory_is_a_usable_private_store() {
        let store = Store::scratch().unwrap();
        let staged = store.stage().unwrap();
        assert!(store.path(&staged).exists());
        assert!(store.current().unwrap().is_none());
    }
}
