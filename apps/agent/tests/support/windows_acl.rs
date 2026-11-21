//! Real Windows ACLs for the tests, set with the system's own `icacls`.
use lazysh_common::windows_acl::current_user;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// Runs `icacls <path> <args>`, which must succeed.
pub fn icacls(path: &Path, args: &[&str]) {
    let run = Command::new("icacls")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "icacls {args:?} on {}: {}{}",
        path.display(),
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
}
/// Leaves `folder`, and what is created in it later, to the current user and the system alone. A user profile
/// grants no more, but a temporary folder inherits what its volume gives (a data volume's root grants every
/// authenticated user modify), and the managed namespace is refused when others can change it.
pub fn private_to_current_user(folder: &Path) {
    let user = format!("*{}:(OI)(CI)F", current_user().unwrap());
    icacls(
        folder,
        &[
            "/inheritance:r",
            "/grant:r",
            &user,
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
        ],
    );
}
/// A stand-in user profile in `folder`, private to the current user, with the `AppData\Local` that the shell
/// resolves the local application data folder to once `USERPROFILE` names `folder`. Returns that folder.
pub fn profile(folder: &Path) -> PathBuf {
    private_to_current_user(folder);
    let local = folder.join("AppData").join("Local");
    fs::create_dir_all(&local).unwrap();
    local
}
