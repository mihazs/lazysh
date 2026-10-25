use std::process::Command;

#[test]
fn keygen_produces_a_256_bit_token_and_rejects_public_bind_before_storage_changes() {
    let binary = env!("CARGO_BIN_EXE_lazysh-share");
    let first = Command::new(binary).arg("keygen").output().unwrap();
    let second = Command::new(binary).arg("keygen").output().unwrap();
    assert!(first.status.success());
    let token = String::from_utf8(first.stdout).unwrap();
    assert_eq!(token.trim().len(), 64);
    assert!(token.trim().bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(token.as_bytes(), second.stdout);
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("not-created");
    let rejected = Command::new(binary)
        .args(["serve", "--listen", "0.0.0.0:7347", "--token-file"])
        .arg(directory.path().join("missing-token"))
        .arg("--data-dir")
        .arg(&data)
        .args(["--public-origin", "https://shares.example"])
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert!(!data.exists());
    assert!(String::from_utf8(rejected.stderr)
        .unwrap()
        .contains("loopback"));
}
