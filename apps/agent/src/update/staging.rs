//! What both managed-namespace stores share: a file that is written, then compared with the expected
//! identity before it may run, and the one commit routine around each store's own swap.
use super::{
    current,
    report::{Failure, Fault},
};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

/// SHA-256 and length of a file.
pub type Identity = (String, u64);
pub const MAXIMUM: u64 = 64 * 1024 * 1024;

/// A file being filled: private and not runnable until `seal` compared its bytes with the identity.
pub struct Staging {
    file: Option<File>,
    identity: Option<Identity>,
}
impl Staging {
    pub fn new(file: File) -> Self {
        Self {
            file: Some(file),
            identity: None,
        }
    }
    pub fn write(&mut self, chunk: &[u8]) -> Result<(), Fault> {
        Ok(self.file.as_mut().unwrap().write_all(chunk)?)
    }
    /// Compare what is on disk with the expected identity, then make it executable and close it.
    pub fn seal(
        &mut self,
        sha256: &str,
        bytes: u64,
        hash: fn(&mut File) -> Result<Identity, Fault>,
    ) -> Result<(), Fault> {
        let file = self.file.as_mut().unwrap();
        file.sync_all()?;
        file.seek(SeekFrom::Start(0))?;
        let (digest, count) = hash(file)?;
        if count != bytes {
            return Err(Fault::detail(Failure::VerificationFailed, "sizeMismatch"));
        }
        if digest != sha256 {
            return Err(Fault::detail(Failure::VerificationFailed, "digestMismatch"));
        }
        // Windows has no such bit; a Unix build of the path-based store (under test) needs it.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o700))?;
        }
        // A binary cannot be started while a descriptor open for writing remains.
        self.file = None;
        self.identity = Some((digest, count));
        Ok(())
    }
    /// Fill the file with a copy of `source`, which must hash to `sha256` before and after.
    pub fn copy_of(
        &mut self,
        source: &mut File,
        sha256: &str,
        hash: fn(&mut File) -> Result<Identity, Fault>,
    ) -> Result<(), Fault> {
        let (digest, bytes) = hash(source)?;
        if digest != sha256 {
            return Err(Fault::detail(Failure::VerificationFailed, "digestMismatch"));
        }
        source.seek(SeekFrom::Start(0))?;
        std::io::copy(
            &mut Read::take(&mut *source, MAXIMUM + 1),
            self.file.as_mut().unwrap(),
        )?;
        self.seal(&digest, bytes, hash)
    }
    pub fn identity(&self) -> Option<&Identity> {
        self.identity.as_ref()
    }
}
/// A store's staged file.
pub trait Staged {
    fn staging(&self) -> &Staging;
}

/// How one store puts a verified file under the installed name. Names, not handles: the kept copy
/// is whatever the store made of the binary it replaced.
pub trait Swap<S: Staged> {
    fn current(&self) -> Result<Option<Identity>, Fault>;
    fn installed_path(&self) -> PathBuf;
    /// Make `staged` the installed binary and keep `replaced` (if any); returns the kept copy's name.
    fn place(&self, staged: &mut S, replaced: Option<&Identity>) -> Result<Option<String>, Fault>;
    /// Undo `place`: true when the replaced binary is back, or there was none and the new one is gone.
    fn restore(&self, kept: Option<&str>) -> bool;
    /// Make the kept copy the previous one: true when it is kept.
    fn retain(&self, kept: Option<&str>) -> bool;
}

/// Replace the installed binary with `staged` and prove the installed path answers `version`.
/// Returns the identity of what was replaced when it was kept as the previous copy. A failed proof
/// restores it (`RolledBack`), or is `Uncertain` when it cannot.
pub fn commit<S: Staged, W: Swap<S>>(
    store: &W,
    mut staged: S,
    version: &str,
    checking: impl FnOnce(),
) -> Result<Option<Identity>, Fault> {
    let expected = staged
        .staging()
        .identity()
        .cloned()
        .ok_or(Failure::Internal)?;
    let replaced = store.current()?;
    let kept = store.place(&mut staged, replaced.as_ref())?;
    checking();
    if store.current().ok().flatten().as_ref() != Some(&expected)
        || current::version_of(&store.installed_path()).as_deref() != Some(version)
    {
        let restored = store.restore(kept.as_deref());
        return Err(if restored {
            Failure::RolledBack
        } else {
            Failure::Uncertain
        }
        .into());
    }
    Ok(store.retain(kept.as_deref()).then_some(replaced).flatten())
}
