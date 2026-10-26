use lazysh_agent::transcript::{discover, read_page, TranscriptAgent};
use serde_json::Value;
use std::{fs, path::Path, process::Command};
fn candidate(root: &Path, relative: &str) -> std::path::PathBuf {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        b"not transcript JSON; discovery must not parse contents\n",
    )
    .unwrap();
    path
}
fn list(root: &Path, limit: u8) -> Value {
    serde_json::to_value(discover(TranscriptAgent::GrokAcp, Some(root), limit).unwrap()).unwrap()
}
#[test]
fn discovery_selects_only_exact_depth_updates_without_reading_sidecars_or_binding_identity() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let expected = candidate(root, "%2Fproject/session-one/updates.jsonl");
    for relative in [
        "updates.jsonl",
        "cwd/updates.jsonl",
        "cwd/session/child/updates.jsonl",
        "cwd/session/events.jsonl",
        "cwd/session/chat_history.jsonl",
        "cwd/session/session.json",
        "cwd/session/UPDATES.jsonl",
    ] {
        candidate(root, relative);
    }
    // Neither this metadata nor transcript content is valid; listing must use only stat metadata.
    candidate(root, "%2Fproject/.cwd");
    let result = list(root, 50);
    assert_eq!(result["agent"], "grok-acp");
    assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
    let row = &result["sessions"][0];
    assert_eq!(row["path"], expected.to_str().unwrap());
    assert_eq!(row["name"], "session-one");
    assert!(row.get("sessionId").is_none());
    assert!(row["bytes"].as_u64().unwrap() > 0);
    assert!(!row["modifiedAt"].as_str().unwrap().is_empty());
    assert!(read_page(&expected, TranscriptAgent::GrokAcp, 0, 50).is_err());
}
#[test]
fn missing_roots_and_result_limits_remain_bounded_and_read_only() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("not-created");
    assert!(list(&missing, 50)["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!missing.exists());
    assert!(discover(TranscriptAgent::GrokAcp, Some(&missing), 0).is_err());
    assert!(discover(TranscriptAgent::GrokAcp, Some(&missing), 101).is_err());
    for index in 0..102 {
        candidate(
            directory.path(),
            &format!("cwd/session-{index}/updates.jsonl"),
        );
    }
    let result = list(directory.path(), 100);
    assert_eq!(result["sessions"].as_array().unwrap().len(), 100);
    assert_eq!(result["truncated"], true);
}
fn cli(directory: &Path, grok_home: Option<&str>) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    command
        .args(["discover", "--agent", "grok-acp", "--limit", "50"])
        .current_dir(directory)
        .env("HOME", directory)
        .env("USERPROFILE", directory)
        .env("LAZYSH_STATE_DIR", directory.join("lazysh-state"));
    if let Some(value) = grok_home {
        command.env("GROK_HOME", value);
    } else {
        command.env_remove("GROK_HOME");
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn default_cli_root_preserves_empty_relative_and_whitespace_override_contract() {
    for override_value in [
        None,
        Some(""),
        Some("relative-root"),
        Some(" literal root "),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let home = override_value
            .filter(|value| !value.is_empty())
            .unwrap_or(".grok");
        let expected = candidate(
            &directory.path().join(home).join("sessions"),
            "cwd/session/updates.jsonl",
        );
        let result = cli(directory.path(), override_value);
        let found = Path::new(result["sessions"][0]["path"].as_str().unwrap());
        assert_eq!(
            found.strip_prefix(directory.path()).unwrap_or(found),
            expected.strip_prefix(directory.path()).unwrap()
        );
        assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
        assert!(result["sessions"][0].get("sessionId").is_none());
    }
    let directory = tempfile::tempdir().unwrap();
    let explicit = tempfile::tempdir().unwrap();
    let expected = candidate(
        &explicit.path().join("sessions"),
        "cwd/absolute-session/updates.jsonl",
    );
    let absolute = cli(directory.path(), explicit.path().to_str());
    assert_eq!(absolute["sessions"][0]["path"], expected.to_str().unwrap());
    candidate(
        &directory.path().join(".grok/sessions"),
        "cwd/fallback/updates.jsonl",
    );
    assert!(cli(directory.path(), Some("missing-root"))["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!directory.path().join("missing-root").exists());
}
#[cfg(unix)]
#[test]
fn symlinked_roots_branches_leaf_and_nonregular_files_are_not_discovered() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    fs::create_dir(&root).unwrap();
    let real = candidate(
        &directory.path().join("outside"),
        "cwd/session/updates.jsonl",
    );
    symlink(
        real.parent().unwrap().parent().unwrap(),
        root.join("cwd-link"),
    )
    .unwrap();
    fs::create_dir(root.join("cwd")).unwrap();
    symlink(real.parent().unwrap(), root.join("cwd/session-link")).unwrap();
    fs::create_dir(root.join("cwd/session")).unwrap();
    symlink(&real, root.join("cwd/session/updates.jsonl")).unwrap();
    let fifo = root.join("cwd/fifo/updates.jsonl");
    fs::create_dir(fifo.parent().unwrap()).unwrap();
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(list(&root, 50)["sessions"].as_array().unwrap().is_empty());
    let link = directory.path().join("root-link");
    symlink(&root, &link).unwrap();
    assert!(discover(TranscriptAgent::GrokAcp, Some(&link), 50).is_err());
}
#[test]
fn the_existing_entry_budget_truncates_even_when_no_candidate_is_accepted() {
    let directory = tempfile::tempdir().unwrap();
    for index in 0..10_001 {
        fs::write(directory.path().join(format!("ignored-{index}")), []).unwrap();
    }
    let result = list(directory.path(), 50);
    assert_eq!(result["truncated"], true);
    assert!(result["sessions"].as_array().unwrap().is_empty());
}
