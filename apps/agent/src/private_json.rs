//! Small owner-only JSON state files: bounded reads that never create state, and atomic locked writes.
use crate::{Error, Result};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub(crate) const MAX_CONFIG: u64 = 4096;

/// Held while one state file is read, changed and replaced.
pub(crate) struct Lock(File);
impl Drop for Lock {
    fn drop(&mut self) {
        // Release explicitly: a concurrent process spawn can briefly inherit
        // the file description until close-on-exec, delaying close-only unlock.
        let _ = self.0.unlock();
    }
}

fn private(metadata: &fs::Metadata, directory: bool) -> Result<()> {
    if lazysh_common::fs::owner_only(metadata, directory) {
        Ok(())
    } else {
        Err(Error::InvalidArgument)
    }
}

pub(crate) fn directory_exists(directory: &Path) -> Result<bool> {
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

/// The bytes of `name`, or `None` when the directory or file is absent. Never creates state.
pub(crate) fn read(directory: &Path, name: &str) -> Result<Option<Vec<u8>>> {
    if !directory_exists(directory)? {
        return Ok(None);
    }
    let file = match open(&directory.join(name), false) {
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
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
    Ok(Some(bytes))
}

/// Create the directory when needed and take the exclusive lock file `name`; `None` when busy.
pub(crate) fn lock(directory: &Path, name: &str) -> Result<Option<Lock>> {
    if !directory_exists(directory)? {
        lazysh_common::fs::private_directory(directory)?;
    }
    directory_exists(directory)?;
    let path = directory.join(name);
    let lock = match options(true).create_new(true).open(&path) {
        Ok(file) => {
            private(&file.metadata()?, false)?;
            file
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => open(&path, true)?,
        Err(error) => return Err(error.into()),
    };
    Ok(lock.try_lock().is_ok().then_some(Lock(lock)))
}

/// Replace `name` atomically and durably. Hold the matching [`Lock`].
pub(crate) fn write(directory: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(directory.join(name))
        .map_err(|error| Error::Io(error.error))?;
    #[cfg(unix)]
    File::open(directory)?.sync_all()?;
    Ok(())
}
