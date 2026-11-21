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
    let current = unsafe { (libc::geteuid(), libc::getegid()) };
    for ancestor in parent.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| CACHE_ERROR)?;
        if !metadata.is_dir()
            || !trusted_ancestor(
                (metadata.uid(), metadata.gid(), metadata.mode()),
                current,
                cfg!(target_os = "android"),
            )
        {
            return Err(CACHE_ERROR.into());
        }
    }
    Ok(parent)
}
/// `(owner, group, mode)` of a directory above the cache. Root and this app own safe ancestors, writable only by
/// trusted identities. Android's `system` account owns `/data`, and an app's data directories are typically
/// group-writable (mode 0771) by the app's own group, which no other app shares.
pub(super) fn trusted_ancestor(
    (owner, group, mode): (u32, u32, u32),
    (uid, gid): (u32, u32),
    android: bool,
) -> bool {
    let trusted_owner = owner == 0 || owner == uid || (android && owner == 1000);
    let trusted_group = android && (matches!(group, 0 | 1000) || group == gid);
    let writable = mode & 0o002 != 0 || (mode & 0o020 != 0 && !trusted_group);
    trusted_owner && (!writable || (owner == 0 && mode & 0o1000 != 0))
}
/// Bytes an unprivileged process may still write on the filesystem that holds `directory`.
#[allow(clippy::unnecessary_cast)] // statvfs field widths differ between libc targets
pub(super) fn free_space(directory: &Path) -> Result<u64> {
    let path = CString::new(directory.as_os_str().as_bytes()).map_err(|_| CACHE_ERROR)?;
    // SAFETY: `path` is NUL-terminated and outlives the call; a zeroed statvfs is a valid out-parameter.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return Err(CACHE_ERROR.into());
    }
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
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
#[cfg(not(target_os = "android"))]
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
        return Err(PUBLISH_FAILED.into());
    }
    Ok(())
}
// bionic only exports renameat2 from API 30 and the app supports API 24. The cache lock and the single active slot
// leave no other writer between this check and the atomic same-directory rename.
#[cfg(target_os = "android")]
pub(super) fn publish(source: &Path, destination: &Path) -> Result<()> {
    if fs::symlink_metadata(destination).is_ok() {
        return Err(PUBLISH_FAILED.into());
    }
    fs::rename(source, destination).map_err(|_| PUBLISH_FAILED.into())
}
pub(super) fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}
