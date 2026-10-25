use std::{
    fs::{DirBuilder, Metadata, OpenOptions},
    io,
    path::Path,
};

/// Creates directories with owner-only permissions; callers still validate existing paths.
pub fn private_directory(path: &Path) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

pub fn owner_only(metadata: &Metadata, directory: bool) -> bool {
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || (!directory && metadata.nlink() != 1)
        {
            return false;
        }
    }
    true
}

pub fn read_options(writable: bool) -> OpenOptions {
    #[cfg(unix)]
    let flags = libc::O_NONBLOCK;
    #[cfg(not(unix))]
    let flags = 0;
    read_options_with_flags(writable, flags)
}

pub fn read_options_with_flags(writable: bool, extra_unix_flags: i32) -> OpenOptions {
    #[cfg(not(unix))]
    let _ = extra_unix_flags;
    let mut options = OpenOptions::new();
    options.read(true).write(writable);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | extra_unix_flags);
    }
    options
}

pub fn private_create_new() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn rejects_public_permissions_links_and_nonregular_paths() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("private");
        private_directory(&directory).unwrap();
        assert!(owner_only(
            &std::fs::symlink_metadata(&directory).unwrap(),
            true
        ));
        let path = directory.join("secret");
        let file = private_create_new().open(&path).unwrap();
        assert!(owner_only(&file.metadata().unwrap(), false));
        let link = directory.join("symlink");
        symlink(&path, &link).unwrap();
        assert!(read_options(false).open(&link).is_err());
        std::fs::hard_link(&path, directory.join("hardlink")).unwrap();
        assert!(!owner_only(&file.metadata().unwrap(), false));
        std::fs::remove_file(directory.join("hardlink")).unwrap();
        file.set_permissions(std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert!(!owner_only(&file.metadata().unwrap(), false));
        assert!(!owner_only(&std::fs::metadata(&directory).unwrap(), false));
        assert!(private_create_new().open(&path).is_err());
    }
}
