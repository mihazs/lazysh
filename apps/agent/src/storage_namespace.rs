//! One checked state namespace for filesystem admission and subsequent use.
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

pub(crate) fn resolve(directory: &Path) -> io::Result<PathBuf> {
    if directory.as_os_str().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Empty state path",
        ));
    }
    if directory
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "State paths must not contain parent traversal",
        ));
    }
    let absolute = if directory.is_absolute() {
        directory.to_owned()
    } else {
        std::env::current_dir()?.join(directory)
    };
    // On Windows, joining a drive-prefixed relative path (C:state) can replace
    // cwd's prefix without acquiring a root. Never let walk skip that namespace.
    if !absolute.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "State path must resolve to an absolute namespace",
        ));
    }
    #[cfg(target_os = "macos")]
    let absolute = darwin_system_alias(&absolute)?;
    // Custom symlinks/reparse points are deliberately unsupported. In particular
    // canonicalize cannot hide an attacker-writable intermediate link namespace.
    walk(&absolute, false)?;
    Ok(absolute)
}

pub(crate) fn create(directory: &Path) -> io::Result<()> {
    // Check each component again before creating the next one. If an absent
    // component was replaced by a link after admission, never follow it.
    walk(directory, true)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn walk(path: &Path, create: bool) -> io::Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part.as_os_str());
        if !current.has_root() {
            continue;
        } // Windows drive prefix precedes root.
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound && !create => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut builder = fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                match builder.create(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
                fs::symlink_metadata(&current)?
            }
            Err(error) => return Err(error),
        };
        check(&metadata, current == path)?;
    }
    Ok(())
}

fn check(metadata: &fs::Metadata, leaf: bool) -> io::Result<()> {
    if is_link(metadata) || !metadata.is_dir() {
        return Err(unsafe_namespace());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let owner = metadata.uid();
        let uid = unsafe { libc::geteuid() };
        let sticky_root = owner == 0 && metadata.mode() & 0o1000 != 0;
        if (leaf && owner != uid)
            || (!leaf && owner != uid && owner != 0)
            || (!leaf && metadata.mode() & 0o022 != 0 && !sticky_root)
        {
            return Err(unsafe_namespace());
        }
    }
    #[cfg(not(unix))]
    let _ = leaf;
    Ok(())
}

pub(crate) fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0; // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    false
}

fn unsafe_namespace() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Unsafe state namespace; custom symlink and reparse routes are unsupported",
    )
}

#[cfg(target_os = "macos")]
fn darwin_system_alias(path: &Path) -> io::Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    for (alias, destination) in [
        ("/var", "/private/var"),
        ("/tmp", "/private/tmp"),
        ("/etc", "/private/etc"),
    ] {
        let Ok(tail) = path.strip_prefix(alias) else {
            continue;
        };
        let metadata = fs::symlink_metadata(alias)?;
        if !metadata.file_type().is_symlink() {
            return Ok(path.to_owned());
        }
        let target = fs::read_link(alias)?;
        if metadata.uid() != 0
            || !(target == Path::new(destination)
                || Path::new("/").join(target) == Path::new(destination))
        {
            return Err(unsafe_namespace());
        }
        return Ok(Path::new(destination).join(tail));
    }
    Ok(path.to_owned())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn only_verified_standard_root_aliases_are_mapped() {
        for (alias, expected) in [
            ("/var/lazysh-no-create", "/private/var/lazysh-no-create"),
            ("/tmp/lazysh-no-create", "/private/tmp/lazysh-no-create"),
            ("/etc/lazysh-no-create", "/private/etc/lazysh-no-create"),
        ] {
            assert_eq!(
                darwin_system_alias(Path::new(alias)).unwrap(),
                Path::new(expected)
            );
        }
    }
}
