//! The Unix private cache: owners and mode bits, read through the descriptors that were opened without following links.
use super::*;
use std::{
    ffi::CString,
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
};

/// The canonical directory that holds the cache, when it and every ancestor belong to this user or root and nobody
/// else can write them (a sticky root-owned directory excepted).
pub(super) fn trusted_parent(root: &Path) -> Result<PathBuf> {
    let parent = root
        .parent()
        .ok_or(CACHE_ERROR)?
        .canonicalize()
        .map_err(|_| CACHE_ERROR)?;
    let uid = unsafe { libc::geteuid() };
    for ancestor in parent.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| CACHE_ERROR)?;
        if !metadata.is_dir()
            || !matches!(metadata.uid(), 0) && metadata.uid() != uid
            || metadata.mode() & 0o022 != 0
                && !(metadata.uid() == 0 && metadata.mode() & 0o1000 != 0)
        {
            return Err(CACHE_ERROR.into());
        }
    }
    Ok(parent)
}
pub(super) fn create_private_directory(path: &Path) -> std::io::Result<()> {
    fs::DirBuilder::new().mode(0o700).create(path)
}
/// New files are readable and writable by their owner alone.
pub(super) fn owner_only(options: &mut OpenOptions) {
    options.mode(0o600);
}
/// Refuse a final symbolic link, and keep the descriptor from reaching child processes.
pub(super) fn no_follow(options: &mut OpenOptions) {
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
}
pub(super) fn private(_: &Path, metadata: &fs::Metadata, directory: bool) -> Result<()> {
    if metadata.file_type().is_symlink()
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || (!directory && metadata.nlink() != 1)
    {
        return Err(CACHE_ERROR.into());
    }
    Ok(())
}
pub(super) fn publish(source: &Path, destination: &Path) -> Result<()> {
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| CACHE_ERROR)?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| CACHE_ERROR)?;
    // SAFETY: Both private-cache names are terminated and live through the call.
    // Linux NOREPLACE atomically publishes one name without a hard-link crash window.
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err("Cannot install Parakeet model; destination may already exist".into());
    }
    Ok(())
}
pub(super) fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}
