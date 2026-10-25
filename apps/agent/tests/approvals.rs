use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

fn command(directory: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    command
        .env("LAZYSH_STATE_DIR", directory)
        .env("TMUX_PANE", "%7");
    command
}
fn run(directory: &Path, args: &[&str], input: &[u8]) -> Output {
    let mut child = command(directory)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(input);
    child.wait_with_output().unwrap()
}
fn payload() -> Value {
    json!({"hook_event_name":"PermissionRequest","session_id":"session-one","cwd":"/work/project","tool_name":"Bash","tool_input":{"command":"echo PRIVATE_APPROVAL_TOOL_INPUT_MARKER"}})
}
struct Hook(Option<Child>);
impl Drop for Hook {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Hook {
    fn finish(mut self) -> Output {
        self.0.take().unwrap().wait_with_output().unwrap()
    }
}
fn start(directory: &Path, timeout: &str) -> Hook {
    let mut child = command(directory)
        .args([
            "approval-request",
            "--agent",
            "claude",
            "--timeout-seconds",
            timeout,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&payload()).unwrap())
        .unwrap();
    Hook(Some(child))
}
fn list(directory: &Path) -> Value {
    let output = run(directory, &["approval-list"], b"");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn pending(directory: &Path) -> Value {
    let started = Instant::now();
    loop {
        let snapshot = list(directory);
        if let Some(request) = snapshot["requests"].as_array().unwrap().first() {
            return request.clone();
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "hook did not publish a request"
        );
        thread::sleep(Duration::from_millis(20));
    }
}
fn resolve(directory: &Path, request: &Value, decision: &str) -> Output {
    run(
        directory,
        &[
            "approval-resolve",
            "--id",
            request["id"].as_str().unwrap(),
            "--expected-hash",
            request["expectedHash"].as_str().unwrap(),
            "--session-id",
            request["sessionId"].as_str().unwrap(),
            "--pane-id",
            request["paneId"].as_str().unwrap(),
            "--decision",
            decision,
        ],
        b"",
    )
}

#[test]
fn exact_request_resolves_once_and_does_not_copy_tool_input_to_event_summaries() {
    let dir = tempfile::tempdir().unwrap();
    let hook = start(dir.path(), "10");
    let request = pending(dir.path());
    assert_eq!(request["toolInput"], payload()["tool_input"]);
    assert_eq!(request["paneId"], "%7");
    assert_eq!(request["expectedHash"].as_str().unwrap().len(), 64);
    for (field, wrong) in [
        ("expectedHash", "0".repeat(64)),
        ("sessionId", "another-session".into()),
        ("paneId", "%8".into()),
    ] {
        let mut altered = request.clone();
        altered[field] = json!(wrong);
        let output = resolve(dir.path(), &altered, "allow");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("PRIVATE_APPROVAL_TOOL_INPUT_MARKER")
        );
    }
    let output = resolve(dir.path(), &request, "allow");
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"schemaVersion":1,"accepted":true})
    );
    let output = hook.finish();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}})
    );
    assert!(!resolve(dir.path(), &request, "allow").status.success());
    assert_eq!(list(dir.path())["requests"], json!([]));
    let event_database = fs::read(dir.path().join("events.sqlite3")).unwrap();
    assert!(!event_database
        .windows(34)
        .any(|window| window == b"PRIVATE_APPROVAL_TOOL_INPUT_MARKER"));
    let approval_database = fs::read(dir.path().join("approvals/events.sqlite3")).unwrap();
    assert!(!approval_database
        .windows(34)
        .any(|window| window == b"PRIVATE_APPROVAL_TOOL_INPUT_MARKER"));
}

#[test]
fn concurrent_remote_decisions_have_one_winner() {
    let dir = tempfile::tempdir().unwrap();
    let hook = start(dir.path(), "10");
    let request = pending(dir.path());
    let jobs: Vec<_> = (0..8)
        .map(|index| {
            let directory = dir.path().to_path_buf();
            let request = request.clone();
            thread::spawn(move || {
                let decision = if index % 2 == 0 { "allow" } else { "deny" };
                (decision, resolve(&directory, &request, decision))
            })
        })
        .collect();
    let winners: Vec<_> = jobs
        .into_iter()
        .map(|job| job.join().unwrap())
        .filter(|(_, output)| output.status.success())
        .collect();
    assert_eq!(winners.len(), 1);
    let output = hook.finish();
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["hookSpecificOutput"]["decision"]["behavior"],
        winners[0].0
    );
}

#[test]
fn cancelled_hooks_release_their_lease_and_tokens_never_target_a_new_hook() {
    let dir = tempfile::tempdir().unwrap();
    let mut hook = start(dir.path(), "10");
    let old = pending(dir.path());
    hook.0.as_mut().unwrap().kill().unwrap();
    hook.0.as_mut().unwrap().wait().unwrap();
    assert_eq!(list(dir.path())["requests"], json!([]));
    assert!(!resolve(dir.path(), &old, "allow").status.success());
    let hook = start(dir.path(), "10");
    let fresh = pending(dir.path());
    assert_ne!(old["id"], fresh["id"]);
    assert_ne!(old["expectedHash"], fresh["expectedHash"]);
    assert!(!resolve(dir.path(), &old, "allow").status.success());
    assert!(resolve(dir.path(), &fresh, "deny").status.success());
    let output = hook.finish();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["hookSpecificOutput"]["decision"]
            ["behavior"],
        "deny"
    );
}

#[test]
fn timeout_denies_and_invalid_payloads_do_not_create_state() {
    let dir = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let hook = start(dir.path(), "1");
    let request = pending(dir.path());
    let output = hook.finish();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["hookSpecificOutput"]["decision"]
            ["behavior"],
        "deny"
    );
    assert!(!resolve(dir.path(), &request, "allow").status.success());
    for invalid in [
        json!({"hook_event_name":"PreToolUse"}),
        json!({"hook_event_name":"PermissionRequest","session_id":"s","cwd":"/w","tool_name":"Bash","tool_input":{"command":"x".repeat(16385)}}),
    ] {
        let path = dir.path().join("invalid-state");
        let output = run(
            &path,
            &["approval-request", "--agent", "claude"],
            &serde_json::to_vec(&invalid).unwrap(),
        );
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!path.exists());
    }
}

#[test]
fn config_is_an_opt_in_fragment_with_no_settings_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unused");
    let output = run(&path, &["approval-config"], b"");
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(value["hooks"]["PermissionRequest"].is_array());
    assert!(value["hooks"]["PreToolUse"].is_null());
    assert!(!path.exists());
}

#[test]
fn listing_refuses_modified_tool_content_instead_of_showing_it_with_an_old_hash() {
    let dir = tempfile::tempdir().unwrap();
    let hook = start(dir.path(), "10");
    let request = pending(dir.path());
    let db = rusqlite::Connection::open(dir.path().join("approvals/events.sqlite3")).unwrap();
    db.execute(
        "UPDATE approvals SET tool_input=?1 WHERE id=?2",
        rusqlite::params![
            "{\"command\":\"something else\"}",
            request["id"].as_str().unwrap()
        ],
    )
    .unwrap();
    let output = run(dir.path(), &["approval-list"], b"");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    drop(hook);
    assert_eq!(list(dir.path())["requests"], json!([]));
}

#[cfg(unix)]
#[test]
fn lease_links_are_rejected_without_reading_or_removing_the_target() {
    let dir = tempfile::tempdir().unwrap();
    let hook = start(dir.path(), "10");
    let request = pending(dir.path());
    let lease = dir
        .path()
        .join("approvals")
        .join(format!("{}.lease", request["id"].as_str().unwrap()));
    let outside = dir.path().join("outside");
    fs::write(&outside, b"SECRET_FILE").unwrap();
    fs::remove_file(&lease).unwrap();
    std::os::unix::fs::symlink(&outside, &lease).unwrap();
    let output = resolve(dir.path(), &request, "allow");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read(&outside).unwrap(), b"SECRET_FILE");
    drop(hook);
}
