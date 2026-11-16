//! Real Windows ACLs for the tests, set with the system's own `icacls`.
// Not every test that includes this file sets an ACL itself.
#[allow(unused_imports)]
pub use lazysh_common::test_support::windows_acl::{icacls, private_to_current_user};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// A stand-in user profile in `folder`, private to the current user, with the `AppData\Local` that the shell
/// resolves the local application data folder to once `USERPROFILE` names `folder`. Returns that folder.
pub fn profile(folder: &Path) -> PathBuf {
    private_to_current_user(folder);
    let local = folder.join("AppData").join("Local");
    fs::create_dir_all(&local).unwrap();
    local
}
