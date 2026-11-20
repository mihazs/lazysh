//! Windows model storage is trusted from owner SIDs and DACLs read from the objects themselves, not from a name
//! that could be re-pointed. Directories inherit their DACL from the private parent, so each created object is
//! read back before any model byte reaches it.
use crate::Error;
use lazysh_common::windows_acl::{admit_chain, admit_path, Need};
use std::{
    fs::File,
    path::{Path, PathBuf},
};

/// The canonical private parent: every directory above it cannot be replaced by another account, and nobody but
/// the current user, the administrators and the system can reach the parent itself.
pub(crate) fn trusted_parent(parent: &Path) -> Result<PathBuf, Error> {
    let canonical = dunce::canonicalize(parent).map_err(|_| Error::Storage)?;
    admit_chain(&canonical, Need::Private).map_err(|_| Error::Storage)?;
    Ok(canonical)
}
pub(crate) fn created_directory(path: &Path) -> Result<(), Error> {
    admit_path(path, Need::Private).map_err(|_| Error::Storage)
}
pub(crate) fn created_file(_: &File, path: &Path) -> Result<(), Error> {
    admit_path(path, Need::Private).map_err(|_| Error::Storage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lazysh_common::test_support::{expose, private_tempdir};

    #[test]
    fn a_private_directory_is_admitted_under_its_canonical_name() {
        let root = private_tempdir();
        assert_eq!(
            trusted_parent(root.path()).unwrap(),
            dunce::canonicalize(root.path()).unwrap()
        );
        let directory = root.path().join("child");
        std::fs::create_dir(&directory).unwrap();
        created_directory(&directory).unwrap();
        let file = File::create(directory.join("model")).unwrap();
        created_file(&file, &directory.join("model")).unwrap();
    }

    #[test]
    fn a_directory_other_accounts_can_modify_is_refused_before_anything_is_created() {
        let root = private_tempdir();
        let child = root.path().join("child");
        std::fs::create_dir(&child).unwrap();
        expose(&child);
        assert!(matches!(trusted_parent(&child), Err(Error::Storage)));
        assert!(matches!(created_directory(&child), Err(Error::Storage)));
        // Anything below the exposed ancestor is no better, however private it is.
        let private = child.join("private");
        std::fs::create_dir(&private).unwrap();
        lazysh_common::windows_acl::fixtures::restrict(&private);
        assert!(matches!(trusted_parent(&private), Err(Error::Storage)));
    }

    #[test]
    fn a_file_and_a_missing_path_are_never_a_parent() {
        let root = private_tempdir();
        let file = root.path().join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(trusted_parent(&file).is_err());
        assert!(trusted_parent(&root.path().join("absent")).is_err());
    }
}
