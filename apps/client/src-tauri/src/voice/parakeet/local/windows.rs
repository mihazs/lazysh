//! The Windows private cache: the owner SID and DACL read back from each directory and file. Objects inherit their
//! DACL from the private cache directory, so a created object that turns out to be reachable by another account is
//! refused before any model byte reaches it.
use super::*;
use lazysh_common::windows_acl::{admit_chain, admit_path, Need};
use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt};

/// Open the link itself, never what it points to; `private` then refuses the link.
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
}

/// The canonical directory that holds the cache, when no other account can replace it or any directory above it.
pub(super) fn trusted_parent(root: &Path) -> Result<PathBuf> {
    let parent = dunce::canonicalize(root.parent().ok_or(CACHE_ERROR)?).map_err(|_| CACHE_ERROR)?;
    admit_chain(&parent, Need::NoForeignReplace).map_err(|_| CACHE_ERROR)?;
    Ok(parent)
}
pub(super) fn create_private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)
}
/// New files inherit the private cache directory's DACL; `create_partial` reads it back.
pub(super) fn owner_only(_: &mut OpenOptions) {}
pub(super) fn no_follow(options: &mut OpenOptions) {
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}
/// Hard links are not counted here: a link elsewhere does not widen the DACL of the file it names.
pub(super) fn private(path: &Path, metadata: &fs::Metadata, directory: bool) -> Result<()> {
    if (if directory {
        !metadata.is_dir()
    } else {
        !metadata.is_file()
    }) || admit_path(path, Need::Private).is_err()
    {
        return Err(CACHE_ERROR.into());
    }
    Ok(())
}
/// A rename that fails when the destination exists, written through before it returns.
pub(super) fn publish(source: &Path, destination: &Path) -> Result<()> {
    let wide =
        |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (source, destination) = (wide(source), wide(destination));
    // SAFETY: Both names are NUL-terminated and live through the call. Without MOVEFILE_REPLACE_EXISTING the
    // system refuses an existing destination, so a crash leaves either the partial file or the published one.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err("Cannot install Parakeet model; destination may already exist".into());
    }
    Ok(())
}
/// A directory cannot be opened as a file here, and the write-through rename already reached the disk.
pub(super) fn sync_directory(_: &Path) -> std::io::Result<()> {
    Ok(())
}
