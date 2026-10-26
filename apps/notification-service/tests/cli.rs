#[cfg(unix)]
#[test]
fn keygen_is_private_no_overwrite_and_stdout_and_errors_never_contain_capabilities() {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().join("private capability");
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_lazysh-notifications"))
            .arg("keygen")
            .arg("--output")
            .arg(&path)
            .output()
            .unwrap()
    };
    let first = run();
    assert!(first.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&first.stdout).unwrap(),
        serde_json::json!({"created":true})
    );
    let key = std::fs::read(&path).unwrap();
    assert_eq!(key.len(), 64);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let second = run();
    assert!(!second.status.success());
    assert_eq!(std::fs::read(path).unwrap(), key);
    for output in [&first, &second] {
        for bytes in [&output.stdout, &output.stderr] {
            assert!(!bytes.windows(key.len()).any(|s| s == key));
        }
    }
}

#[cfg(unix)]
#[test]
fn relative_capability_filename_completes_in_private_working_directory() {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-notifications"))
        .current_dir(directory.path())
        .args(["keygen", "--output", "key"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read(directory.path().join("key")).unwrap().len(),
        64
    );
}
