use crate::Error;
use std::path::{Path, PathBuf};

/// Model loading is disabled where POSIX mode checks do not establish the ACL boundary.
/// Apple extended ACL and Windows ACL validation need separate native acceptance work.
#[cfg(any(not(unix), target_vendor = "apple"))]
pub(crate) fn trusted_parent(_: &Path) -> Result<PathBuf, Error> {
    Err(Error::Storage)
}

#[cfg(all(unix, not(target_vendor = "apple")))]
pub(crate) fn trusted_parent(parent: &Path) -> Result<PathBuf, Error> {
    let canonical = std::fs::canonicalize(parent).map_err(|_| Error::Storage)?;
    // SAFETY: geteuid has no pointer arguments and only reads the current process identity.
    let owner = unsafe { libc::geteuid() };
    validate_canonical(&canonical, owner, cfg!(target_os = "android"))?;
    Ok(canonical)
}

#[cfg(all(unix, not(target_vendor = "apple")))]
fn trusted_owner(owner: u32, current: u32, android: bool) -> bool {
    owner == 0 || owner == current || (android && owner == 1000)
}

#[cfg(all(unix, not(target_vendor = "apple")))]
fn untrusted_write(mode: u32, group: u32, android: bool) -> bool {
    // Android's root/system groups are platform identities, unlike arbitrary application UIDs/groups.
    let trusted_group = android && matches!(group, 0 | 1000);
    mode & 0o002 != 0 || (mode & 0o020 != 0 && !trusted_group)
}

#[cfg(all(unix, not(target_vendor = "apple")))]
fn validate_canonical(parent: &Path, current: u32, android: bool) -> Result<(), Error> {
    use std::os::unix::fs::MetadataExt;
    if !parent.is_absolute() {
        return Err(Error::Storage);
    }
    let mut path = PathBuf::new();
    // Walk root to leaf: a safe ancestor cannot be renamed by an untrusted identity. In a sticky
    // shared directory, the next child's trusted ownership (checked next) prevents replacement.
    for part in parent.components() {
        path.push(part);
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| Error::Storage)?;
        if !metadata.file_type().is_dir() || !trusted_owner(metadata.uid(), current, android) {
            return Err(Error::Storage);
        }
        let leaf = path == parent;
        if untrusted_write(metadata.mode(), metadata.gid(), android)
            && (leaf || metadata.mode() & 0o1000 == 0)
        {
            return Err(Error::Storage);
        }
        if leaf && (metadata.uid() != current || metadata.mode() & 0o077 != 0) {
            return Err(Error::Storage);
        }
    }
    Ok(())
}

#[cfg(all(test, unix, not(target_vendor = "apple")))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn private_storage_under_sticky_temp_and_normal_owned_ancestors_is_allowed() {
        let root = tempfile::tempdir_in("/tmp").unwrap();
        let private = root.path().join("private");
        std::fs::create_dir(&private).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            trusted_parent(&private).unwrap(),
            private.canonicalize().unwrap()
        );
        // A shared sticky directory is an allowed ancestor, never the private model parent itself.
        assert!(trusted_parent(Path::new("/tmp")).is_err());
    }

    #[test]
    fn writable_ancestor_and_nonprivate_leaf_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("private");
        std::fs::create_dir(&private).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        for mode in [0o777, 0o770] {
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(mode)).unwrap();
            assert!(trusted_parent(&private).is_err());
        }
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o750)).unwrap();
        assert!(trusted_parent(&private).is_err());
    }

    #[test]
    fn canonical_name_survives_alias_retarget_but_changed_canonical_components_fail() {
        let root = tempfile::tempdir().unwrap();
        let private = || {
            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir_in(root.path())
                .unwrap()
        };
        let first = private();
        let second = private();
        let alias = root.path().join("alias");
        symlink(first.path(), &alias).unwrap();
        let canonical = trusted_parent(&alias).unwrap();
        std::fs::remove_file(&alias).unwrap();
        symlink(second.path(), &alias).unwrap();
        let model = tempfile::tempdir_in(&canonical).unwrap();
        assert!(model.path().starts_with(first.path()));
        let former = root.path().join("former");
        std::fs::rename(first.path(), &former).unwrap();
        symlink(second.path(), &canonical).unwrap();
        let uid = unsafe { libc::geteuid() };
        assert!(validate_canonical(&canonical, uid, false).is_err());
        std::fs::remove_file(&canonical).unwrap();
        std::fs::write(&canonical, b"not a directory").unwrap();
        assert!(validate_canonical(&canonical, uid, false).is_err());
    }

    #[test]
    fn only_android_platform_identities_extend_the_owner_and_group_allowlist() {
        let app = 10123;
        assert!(trusted_owner(1000, app, true));
        assert!(!trusted_owner(1000, app, false));
        assert!(!trusted_owner(10124, app, true));
        assert!(!untrusted_write(0o771, 1000, true));
        assert!(!untrusted_write(0o771, 0, true));
        assert!(untrusted_write(0o771, 1000, false));
        assert!(untrusted_write(0o771, 10124, true));
        assert!(untrusted_write(0o777, 1000, true));
    }
}
