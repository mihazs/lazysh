//! SQLite pathname admission only: never open/close a database or sidecar descriptor.
use crate::storage_namespace;
use std::{fs, io, path::Path};

/// The caller supplies a fixed kind for its known database paths, never a suffix guess.
#[derive(Clone, Copy, Debug)]
pub enum SidecarKind {
    Journal,
    Wal,
    Shm,
    BootstrapLock,
    Other,
}
impl SidecarKind {
    #[cfg(unix)]
    fn name(self) -> &'static str {
        match self {
            Self::Journal => "journal",
            Self::Wal => "wal",
            Self::Shm => "shm",
            Self::BootstrapLock => "bootstrap-lock",
            Self::Other => "other",
        }
    }
}

pub(crate) fn regular_state_metadata(
    path: &Path,
    message: &'static str,
) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if storage_namespace::is_link(&metadata) || !metadata.is_file() => {
            Err(io::Error::new(io::ErrorKind::InvalidInput, message))
        }
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
pub fn validate_database(path: &Path) -> io::Result<()> {
    let Some(metadata) = regular_state_metadata(path, "State must be a regular file")? else {
        return Ok(());
    };
    #[cfg(not(unix))]
    let _ = metadata;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "State must not have hard links",
            ));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn validate_sidecar(path: &Path, kind: SidecarKind) -> io::Result<()> {
    observe_sidecar(kind, || {
        regular_state_metadata(path, "Invalid state sidecar")
    })
}
pub(crate) fn observe_sidecar(
    kind: SidecarKind,
    mut observe: impl FnMut() -> io::Result<Option<fs::Metadata>>,
) -> io::Result<()> {
    #[cfg(unix)]
    {
        let kind = kind.name();
        let mut retries = 0;
        loop {
            let Some(metadata) = observe()? else {
                return Ok(());
            };
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                let links = metadata.nlink();
                let owned = metadata.uid() == unsafe { libc::geteuid() };
                let mode = metadata.permissions().mode() & 0o777;
                // SQLite may unlink its ephemeral sidecar during stat. Never accept
                // that removed inode: re-stat the path, validating any replacement.
                if links == 0
                    && owned
                    && mode == 0o600
                    && matches!(kind, "journal" | "wal" | "shm")
                    && retries < 2
                {
                    retries += 1;
                    continue;
                }
                if links != 1 || !owned || mode != 0o600 {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!("Unsafe state sidecar (kind={kind}, links={links}, owned={owned}, mode={mode:03o})"),
                    ));
                }
            }
            return Ok(());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = kind;
        observe().map(|_| ())
    }
}
