//! The managed namespace (`<user data>/lazysh/companion`): staging, the atomic replace and the kept
//! previous copy. Linux and macOS; every name is relative to one retained, owner-only directory.
use super::{
    report::{Failure, Fault},
    staging::{Identity, Staged as StagedFile, Staging, Swap},
};
use crate::{
    installation::{self, Existing, Lock, Temporary, NAME},
    managed_directory::Directory,
    storage_filesystem, storage_namespace,
};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

pub const PREVIOUS: &str = "lazysh-agent.previous";
const STAGED: &str = ".update-";
const KEPT: &str = ".previous-";

pub struct Store {
    dir: Directory,
    _lock: Option<Lock>,
    _scratch: Option<tempfile::TempDir>,
}
/// A file on its way into the namespace; it disappears unless it is committed.
pub struct Staged<'a> {
    guard: Temporary<'a>,
    pub staging: Staging,
}
impl StagedFile for Staged<'_> {
    fn staging(&self) -> &Staging {
        &self.staging
    }
}
/// The hash the store trusts: a private, single-link file that did not change while it was read.
pub fn hash(file: &mut fs::File) -> Result<Identity, Fault> {
    Ok(installation::file_hash(file, true)?)
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
            staging: Staging::new(file),
        })
    }
    pub fn stage(&self) -> Result<Staged<'_>, Fault> {
        self.create(STAGED)
    }
    /// A private copy of `name` whose bytes match `sha256`, verified before and after the copy.
    fn copy(&self, name: &str, sha256: &str, prefix: &str) -> Result<Staged<'_>, Fault> {
        let mut source = self.dir.open_file(name, libc::O_RDONLY)?;
        let mut staged = self.create(prefix)?;
        staged.staging.copy_of(&mut source, sha256, hash)?;
        Ok(staged)
    }
    /// The kept previous binary, as a staged copy that is safe to self-test and install.
    pub fn copy_previous(&self, sha256: &str) -> Result<Staged<'_>, Fault> {
        self.copy(PREVIOUS, sha256, STAGED)
    }
}

/// One same-directory rename over the installed name; what it replaces is copied first and put back
/// (or removed) when the proof fails.
impl<'a> Swap<Staged<'a>> for Store {
    fn current(&self) -> Result<Option<Identity>, Fault> {
        Store::current(self)
    }
    fn installed_path(&self) -> PathBuf {
        self.dir.path.join(NAME)
    }
    fn place(
        &self,
        staged: &mut Staged<'a>,
        replaced: Option<&Identity>,
    ) -> Result<Option<String>, Fault> {
        self.dir.check()?;
        let kept = match replaced {
            Some((sha256, _)) => {
                let mut copy = self.copy(NAME, sha256, KEPT)?;
                // Kept from here on by name: the swap decides whether it becomes the previous copy.
                copy.guard.committed = true;
                Some(copy.guard.name.clone())
            }
            None => None,
        };
        let renamed = self
            .dir
            .check()
            .map_err(Fault::from)
            .and_then(|()| Ok(self.dir.rename(&staged.guard.name, NAME, false)?));
        if let Err(error) = renamed {
            if let Some(name) = &kept {
                let _ = self.dir.remove(name, false);
            }
            return Err(error);
        }
        staged.guard.committed = true;
        let _ = self.dir.file.sync_all();
        Ok(kept)
    }
    fn restore(&self, kept: Option<&str>) -> bool {
        match kept {
            Some(name) => self.dir.rename(name, NAME, false),
            None => self.dir.remove(NAME, false),
        }
        .is_ok()
    }
    fn retain(&self, kept: Option<&str>) -> bool {
        let kept = kept.is_some_and(|name| {
            let renamed = self.dir.rename(name, PREVIOUS, false).is_ok();
            // The copy is still under its temporary name when the rename failed.
            if !renamed {
                let _ = self.dir.remove(name, false);
            }
            renamed
        });
        let _ = self.dir.file.sync_all();
        kept
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
