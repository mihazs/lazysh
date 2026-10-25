use crate::Error;
use std::{
    ffi::CString,
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path, PathBuf},
};
unsafe extern "C" {
    fn lazysh_parakeet_macos_check_fd(fd: libc::c_int, role: libc::c_int) -> libc::c_int;
}
fn check(file: &File, role: i32) -> Result<(), Error> {
    // SAFETY: the native helper only inspects this live, borrowed descriptor and returns a fixed status.
    if unsafe { lazysh_parakeet_macos_check_fd(file.as_raw_fd(), role) } == 0 {
        Ok(())
    } else {
        Err(Error::Storage)
    }
}
fn open_directory(parent: Option<&File>, name: &std::ffi::OsStr) -> Result<File, Error> {
    let name = CString::new(name.as_bytes()).map_err(|_| Error::Storage)?;
    // SAFETY: the terminated name and optional parent remain live; NOFOLLOW prevents a changed symlink.
    let fd = unsafe {
        libc::openat(
            parent.map_or(libc::AT_FDCWD, AsRawFd::as_raw_fd),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(Error::Storage);
    }
    // SAFETY: successful openat returns a new, exclusively owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}
pub(crate) fn trusted_parent(parent: &Path) -> Result<PathBuf, Error> {
    let canonical = parent.canonicalize().map_err(|_| Error::Storage)?;
    let mut current = open_directory(None, std::ffi::OsStr::new("/"))?;
    let components: Vec<_> = canonical.components().collect();
    if components.first() != Some(&Component::RootDir) {
        return Err(Error::Storage);
    }
    check(&current, if components.len() == 1 { 1 } else { 0 })?;
    for (index, component) in components.iter().enumerate().skip(1) {
        let Component::Normal(name) = component else {
            return Err(Error::Storage);
        };
        current = open_directory(Some(&current), name)?;
        check(&current, if index + 1 == components.len() { 1 } else { 0 })?;
    }
    Ok(canonical)
}
pub(crate) fn created_directory(path: &Path) -> Result<(), Error> {
    check(&open_directory(None, path.as_os_str())?, 1)
}
pub(crate) fn created_file(file: &File) -> Result<(), Error> {
    check(file, 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{
        ffi::OsStrExt,
        fs::{symlink, PermissionsExt},
    };
    #[test]
    fn private_macos_root_is_admitted_and_unsafe_modes_fail_before_archive_read() {
        let root = tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        assert_eq!(
            trusted_parent(root.path()).unwrap(),
            root.path().canonicalize().unwrap()
        );
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(trusted_parent(root.path()).is_err());
    }
    #[test]
    fn descriptor_open_rejects_changed_symlink_and_file_components() {
        let root = tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let parent = open_directory(None, root.path().as_os_str()).unwrap();
        std::fs::create_dir(root.path().join("real")).unwrap();
        symlink(root.path().join("real"), root.path().join("alias")).unwrap();
        assert!(open_directory(Some(&parent), std::ffi::OsStr::new("alias")).is_err());
        std::fs::write(root.path().join("file"), b"fixture").unwrap();
        assert!(open_directory(Some(&parent), std::ffi::OsStr::new("file")).is_err());
        let invalid = std::ffi::OsStr::from_bytes(b"bad\0name");
        assert!(open_directory(Some(&parent), invalid).is_err());
    }
}
