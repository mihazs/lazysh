//! WAL requires local shared memory; reject unsupported mounts before mutation.
use std::{fs, io, path::Path};

pub(crate) fn require_local(directory: &Path) -> io::Result<()> {
    // A missing prefix followed by .. could ascend onto a different mount
    // only after create_dir_all creates the prefix. Never normalize across
    // symlinks or admit one ancestor and mutate another filesystem.
    if directory
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "State paths must not contain parent traversal",
        ));
    }
    // A missing state directory inherits its nearest existing ancestor's mount.
    // Store supplies its checked namespace. Never canonicalize it again and
    // accidentally admit a different target than the path Store subsequently uses.
    // current_dir itself fails for a removed working directory. Do not fall
    // back repeatedly to "." after ENOENT or loop at the filesystem root.
    let absolute = if directory.is_absolute() {
        directory.to_owned()
    } else {
        std::env::current_dir()?.join(directory)
    };
    let mut ancestor = absolute.as_path();
    let existing = loop {
        match fs::metadata(ancestor) {
            Ok(_) => break ancestor.to_owned(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                ancestor = parent_ancestor(ancestor).ok_or(error)?;
            }
            Err(error) => return Err(error),
        }
    };
    if is_local_mount(&existing)? {
        Ok(())
    } else {
        Err(io::Error::new(io::ErrorKind::Unsupported, "Companion WAL requires a supported local filesystem; network, FUSE and unknown filesystems are unsupported"))
    }
}

fn parent_ancestor(path: &Path) -> Option<&Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn is_local_mount(path: &Path) -> io::Result<bool> {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid state path"))?;
    let mut stats = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: NUL-terminated input and correctly sized output; initialized only
    // after statfs reports success. No state file is opened or changed.
    if unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let stats = unsafe { stats.assume_init() };
    #[cfg(target_os = "linux")]
    return Ok(linux_local_type(stats.f_type as u32 as u64));
    #[cfg(target_os = "macos")]
    return Ok(darwin_local_flags(stats.f_flags));
}

#[cfg(any(target_os = "linux", test))]
fn linux_local_type(kind: u64) -> bool {
    // Linux UAPI include/uapi/linux/magic.h. Intentionally fail closed on FUSE,
    // network/cluster filesystems and unreviewed types rather than migrate them.
    matches!(
        kind,
        0xef53 | 0x9123683e | 0x58465342 | 0x01021994 | 0x858458f6 | 0x794c7630 | 0xf2f52010
    )
}

#[cfg(any(target_os = "macos", test))]
fn darwin_local_flags(flags: u32) -> bool {
    flags & 0x00001000 != 0 // Darwin sys/mount.h MNT_LOCAL
}

#[cfg(any(windows, test))]
fn windows_local_drive(kind: u32) -> bool {
    matches!(kind, 2 | 3 | 6) // DRIVE_REMOVABLE, DRIVE_FIXED, DRIVE_RAMDISK
}

#[cfg(windows)]
fn is_local_mount(path: &Path) -> io::Result<bool> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetVolumePathNameW(path: *const u16, volume: *mut u16, length: u32) -> i32;
        fn GetDriveTypeW(root: *const u16) -> u32;
    }
    let path = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut volume = vec![0u16; 32768];
    // SAFETY: terminated UTF-16 input and writable, length-bounded output.
    if unsafe { GetVolumePathNameW(path.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(windows_local_drive(unsafe {
        GetDriveTypeW(volume.as_ptr())
    }))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn is_local_mount(_: &Path) -> io::Result<bool> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ancestor_walk_terminates_without_repeating_dot_or_root() {
        assert!(parent_ancestor(Path::new(".")).is_none());
        assert!(parent_ancestor(Path::new("/")).is_none());
        assert!(parent_ancestor(Path::new("")).is_none());
        assert_eq!(
            parent_ancestor(Path::new("missing/state")),
            Some(Path::new("missing"))
        );
    }
    #[test]
    fn filesystem_types_and_flags_fail_closed() {
        for kind in [
            0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x858458f6, 0x794c7630, 0xf2f52010,
        ] {
            assert!(linux_local_type(kind));
        }
        for kind in [
            0x6969,
            0xff534d42,
            0xfe534d42,
            0x65735546,
            0x00c36400,
            0x7461636f,
            0,
            u64::MAX,
        ] {
            assert!(!linux_local_type(kind));
        }
        assert!(darwin_local_flags(0x1000));
        assert!(!darwin_local_flags(0));
        assert!(!darwin_local_flags(0xffffefff));
        for kind in [2, 3, 6] {
            assert!(windows_local_drive(kind));
        }
        for kind in [0, 1, 4, 5, 7, u32::MAX] {
            assert!(!windows_local_drive(kind));
        }
    }
    #[test]
    fn actual_temporary_mount_and_nonexistent_state_child_are_admitted() {
        let dir = tempfile::tempdir().unwrap();
        require_local(dir.path()).unwrap();
        require_local(&dir.path().join("not-created/state")).unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn actual_proc_filesystem_is_rejected_without_touching_it() {
        assert_eq!(
            require_local(Path::new("/proc")).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
    }
}
