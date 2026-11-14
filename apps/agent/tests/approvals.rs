#[path = "support/process.rs"]
mod process;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

/// A companion command that runs in no multiplexer pane, whatever the test process itself runs in.
fn command(directory: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    command.env("LAZYSH_STATE_DIR", directory);
    for name in [
        "TMUX_PANE",
        "ZELLIJ_SESSION_NAME",
        "ZELLIJ_PANE_ID",
        "HERDR_ENV",
        "HERDR_PANE_ID",
        "HERDR_SOCKET_PATH",
    ] {
        command.env_remove(name);
    }
    command
}
fn run(directory: &Path, args: &[&str], input: &[u8]) -> Output {
    process::run(command(directory).args(args), input)
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
    start_with(directory, timeout, &payload())
}
fn start_with(directory: &Path, timeout: &str, payload: &Value) -> Hook {
    start_in(directory, timeout, payload, &[("TMUX_PANE", "%7")])
}
/// A hook started with exactly the environment a multiplexer exports to the pane it runs in.
fn start_in(directory: &Path, timeout: &str, payload: &Value, pane: &[(&str, &str)]) -> Hook {
    let mut child = command(directory)
        .envs(pane.iter().copied())
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
        .write_all(&serde_json::to_vec(payload).unwrap())
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
    resolve_with(directory, request, decision, &[])
}
fn resolve_with(directory: &Path, request: &Value, decision: &str, extra: &[&str]) -> Output {
    let mut args = vec![
        "approval-resolve",
        "--id",
        request["id"].as_str().unwrap(),
        "--expected-hash",
        request["expectedHash"].as_str().unwrap(),
        "--session-id",
        request["sessionId"].as_str().unwrap(),
        "--decision",
        decision,
    ];
    // A request listed without a pane is answered without one; the companion refuses any pane for it.
    if let Some(pane) = request["paneId"].as_str() {
        args.extend(["--pane-id", pane]);
    }
    args.extend_from_slice(extra);
    run(directory, &args, b"")
}
fn decision(hook: Hook) -> Value {
    let output = hook.finish();
    assert!(output.status.success());
    serde_json::from_slice::<Value>(&output.stdout).unwrap()["hookSpecificOutput"]["decision"]
        .clone()
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
    let output = hook.finish();
    assert!(started.elapsed() >= Duration::from_millis(900));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["hookSpecificOutput"]["decision"]
            ["behavior"],
        "deny"
    );
    assert_eq!(list(dir.path())["requests"], json!([]));
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
fn expired_tokens_are_rejected_even_while_the_originating_lease_is_held() {
    use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
    use lazysh_agent::approvals::Request;
    use sha2::{Digest, Sha256};

    let dir = tempfile::tempdir().unwrap();
    assert_eq!(list(dir.path())["requests"], json!([]));
    let database = rusqlite::Connection::open(dir.path().join("approvals/events.sqlite3")).unwrap();
    // Hold native leases ourselves so scheduling cannot close a short-lived hook
    // before the resolver checks expiry. Both rows have valid identity hashes.
    for expired in [false, true] {
        let now = Utc::now();
        let created = now - ChronoDuration::seconds(2);
        let expires = now + ChronoDuration::seconds(if expired { -1 } else { 60 });
        let mut request = Request {
            id: uuid::Uuid::new_v4().to_string(),
            expected_hash: String::new(),
            agent: "claude",
            session_id: "session-one".into(),
            project: "/work/project".into(),
            pane_id: Some("%7".into()),
            tool_name: "Bash".into(),
            tool_input: payload()["tool_input"].clone(),
            options: vec![],
            created_at: created.to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: expires.to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        request.expected_hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&request).unwrap())
        );
        let lease = tempfile::NamedTempFile::new_in(dir.path().join("approvals"))
            .unwrap()
            .persist(dir.path().join(format!("approvals/{}.lease", request.id)))
            .unwrap();
        lease.try_lock().unwrap();
        database.execute(
            "INSERT INTO approvals(id,hash,session_id,project,pane_id,tool_name,tool_input,created,expires) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![request.id, request.expected_hash, request.session_id, request.project, request.pane_id, request.tool_name, request.tool_input.to_string(), created.timestamp_millis(), expires.timestamp_millis()],
        ).unwrap();
        let output = resolve(
            dir.path(),
            &serde_json::to_value(&request).unwrap(),
            "allow",
        );
        // Explicitly unlock even if a spawned process briefly inherited the fd.
        lease.unlock().unwrap();
        assert_eq!(output.status.success(), !expired);
        if expired {
            assert!(output.stdout.is_empty());
        } else {
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                json!({"schemaVersion":1,"accepted":true})
            );
        }
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

fn suggested() -> Value {
    let mut request = payload();
    request["permission_suggestions"] = json!([
        {"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"echo PRIVATE_APPROVAL_TOOL_INPUT_MARKER","extra":1}],"behavior":"allow","destination":"localSettings","extra":true},
        {"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"deny","destination":"localSettings"},
        {"type":"setMode","mode":"bypassPermissions","destination":"session"},
        {"type":"setMode","mode":"acceptEdits","destination":"session"},
        {"type":"replaceRules","rules":[{"toolName":"Bash"}],"behavior":"allow","destination":"userSettings"},
        {"type":"addDirectories","directories":["/work/shared"],"destination":"projectSettings"},
        {"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"allow","destination":"elsewhere"}
    ]);
    request
}

#[test]
fn suggested_permission_updates_are_listed_and_an_allow_returns_exactly_the_chosen_one() {
    let dir = tempfile::tempdir().unwrap();
    let hook = start_with(dir.path(), "10", &suggested());
    let request = pending(dir.path());
    // Only allow rules, a non-bypass mode and directories survive, rebuilt without unknown fields.
    assert_eq!(
        request["options"],
        json!([
            {"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"echo PRIVATE_APPROVAL_TOOL_INPUT_MARKER"}],"behavior":"allow","destination":"localSettings"},
            {"type":"setMode","mode":"acceptEdits","destination":"session"},
            {"type":"addDirectories","directories":["/work/shared"],"destination":"projectSettings"}
        ])
    );
    // The index must exist, belongs to an allow, and a message belongs to a deny; each refusal leaves it pending.
    for (decision, extra) in [
        ("allow", vec!["--option", "3"]),
        ("deny", vec!["--option", "0"]),
        ("allow", vec!["--message", "no"]),
        ("deny", vec!["--message", "bad\nline"]),
        ("deny", vec!["--message", &"x".repeat(501)]),
    ] {
        let output = resolve_with(dir.path(), &request, decision, &extra);
        assert!(!output.status.success(), "{decision} {extra:?}");
        assert!(output.stdout.is_empty());
    }
    assert_eq!(list(dir.path())["requests"].as_array().unwrap().len(), 1);
    let output = resolve_with(dir.path(), &request, "allow", &["--option", "1"]);
    assert!(output.status.success());
    assert_eq!(
        decision(hook),
        json!({"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]})
    );
}

#[test]
fn a_plain_allow_adds_no_rule_and_a_deny_message_reaches_the_agent() {
    let dir = tempfile::tempdir().unwrap();
    let hook = start_with(dir.path(), "10", &suggested());
    let request = pending(dir.path());
    assert!(resolve(dir.path(), &request, "allow").status.success());
    assert_eq!(decision(hook), json!({"behavior":"allow"}));
    let hook = start(dir.path(), "10");
    let request = pending(dir.path());
    assert_eq!(request["options"], json!([]));
    let output = resolve_with(
        dir.path(),
        &request,
        "deny",
        &["--message", "Use the staging database instead"],
    );
    assert!(output.status.success());
    assert_eq!(
        decision(hook),
        json!({"behavior":"deny","message":"Use the staging database instead"})
    );
}

#[test]
fn requests_stored_by_an_older_companion_still_resolve() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(list(dir.path())["requests"], json!([]));
    let database = rusqlite::Connection::open(dir.path().join("approvals/events.sqlite3")).unwrap();
    database
        .execute_batch(
            "ALTER TABLE approvals DROP COLUMN options; ALTER TABLE approvals DROP COLUMN option; ALTER TABLE approvals DROP COLUMN message;",
        )
        .unwrap();
    drop(database);
    let hook = start_with(dir.path(), "10", &suggested());
    let request = pending(dir.path());
    assert_eq!(request["options"].as_array().unwrap().len(), 3);
    assert!(
        resolve_with(dir.path(), &request, "allow", &["--option", "0"])
            .status
            .success()
    );
    assert_eq!(decision(hook)["updatedPermissions"][0]["type"], "addRules");
}

/// A `herdr` that lists exactly these sessions, as `herdr session list --json` does; returns the `PATH` that finds it.
#[cfg(unix)]
fn fake_herdr(directory: &Path, sessions: &Value) -> String {
    use std::os::unix::fs::PermissionsExt;
    let bin = directory.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let script = bin.join("herdr");
    fs::write(
        &script,
        format!("#!/bin/sh\n[ \"$*\" = 'session list --json' ] || exit 1\ncat <<'JSON'\n{sessions}\nJSON\n"),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    format!("{}:{}", bin.display(), std::env::var("PATH").unwrap())
}
#[cfg(unix)]
fn herdr_pane<'a>(path: &'a str, pane: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("HERDR_ENV", "1"),
        ("HERDR_PANE_ID", pane),
        ("HERDR_SOCKET_PATH", "/run/herdr/work.sock"),
        ("PATH", path),
    ]
}
#[cfg(unix)]
fn herdr_sessions() -> Value {
    json!({"sessions":[
        {"default":true,"name":"default","running":true,"socket_path":"/run/herdr/default.sock"},
        {"default":false,"name":"work","running":true,"socket_path":"/run/herdr/work.sock"}
    ]})
}

#[cfg(unix)]
#[test]
fn a_zellij_or_herdr_pane_is_bound_into_the_decision_and_no_other_pane_can_answer_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = fake_herdr(dir.path(), &herdr_sessions());
    let zellij = vec![("ZELLIJ_SESSION_NAME", "work"), ("ZELLIJ_PANE_ID", "3")];
    for (pane, identity, others) in [
        (
            zellij,
            "zellij:work:3",
            vec!["zellij:work:4", "zellij:other:3", "%3", "herdr:work:w3V:p1"],
        ),
        (
            herdr_pane(&path, "w3V:p1"),
            "herdr:work:w3V:p1",
            vec![
                "herdr:work:w3V:p2",
                "herdr:work:w4V:p1",
                "herdr:default:w3V:p1",
                "%1",
                "zellij:work:3",
                "herdr:work:w3V:p1:x",
            ],
        ),
    ] {
        let state = dir.path().join(identity.replace(':', "-"));
        let hook = start_in(&state, "10", &payload(), &pane);
        let request = pending(&state);
        assert_eq!(request["paneId"], identity);
        // A pane replaced by another pane (or session) of the same multiplexer, another multiplexer and no pane all fail closed.
        for other in others.iter().map(|other| json!(other)).chain([Value::Null]) {
            let mut altered = request.clone();
            altered["paneId"] = other;
            let output = resolve(&state, &altered, "allow");
            assert!(!output.status.success(), "{altered}");
            assert!(output.stdout.is_empty());
        }
        assert_eq!(list(&state)["requests"].as_array().unwrap().len(), 1);
        // The board row is named as its lifecycle hooks name it: by a Zellij pane, never by a Herdr one.
        let board: Value = serde_json::from_slice(&run(&state, &["snapshot"], b"").stdout).unwrap();
        assert_eq!(
            board["sessions"][0]["paneId"],
            if identity.starts_with("herdr:") {
                Value::Null
            } else {
                json!(identity)
            }
        );
        assert!(resolve(&state, &request, "allow").status.success());
        assert_eq!(decision(hook), json!({"behavior":"allow"}));
        assert!(!resolve(&state, &request, "allow").status.success());
    }
}

#[cfg(unix)]
#[test]
fn a_herdr_pane_that_cannot_be_named_exactly_is_listed_without_a_pane_that_no_pane_id_answers() {
    let dir = tempfile::tempdir().unwrap();
    let work = |running: bool, name: &str| json!({"default":false,"name":name,"running":running,"socket_path":"/run/herdr/work.sock"});
    let missing = dir.path().join("empty");
    fs::create_dir_all(&missing).unwrap();
    // Each case lists a different set of sessions (or none), then breaks the pane's own environment.
    for (index, (sessions, pane_id, env_value)) in [
        (json!({"sessions":[work(false, "work")]}), "w3V:p1", "1"),
        (json!({"sessions":[]}), "w3V:p1", "1"),
        (
            json!({"sessions":[work(true, "work"), work(true, "other")]}),
            "w3V:p1",
            "1",
        ),
        (json!({"sessions":[work(true, "bad:name")]}), "w3V:p1", "1"),
        (json!({"sessions":[work(true, "work")]}), "p1", "1"),
        (json!({"sessions":[work(true, "work")]}), "w3V:p1", "0"),
        (json!({"nope":true}), "w3V:p1", "1"),
    ]
    .into_iter()
    .enumerate()
    {
        let path = fake_herdr(&dir.path().join(index.to_string()), &sessions);
        let mut pane = herdr_pane(&path, pane_id);
        pane[0].1 = env_value;
        let state = dir.path().join(format!("state-{index}"));
        let hook = start_in(&state, "10", &payload(), &pane);
        let request = pending(&state);
        assert_eq!(request["paneId"], Value::Null, "case {index}");
        let mut invented = request.clone();
        invented["paneId"] = json!("herdr:work:w3V:p1");
        assert!(!resolve(&state, &invented, "allow").status.success());
        assert!(resolve(&state, &request, "deny").status.success());
        assert_eq!(decision(hook)["behavior"], "deny");
    }
    // No herdr binary at all fails closed the same way.
    let pane = herdr_pane(missing.to_str().unwrap(), "w3V:p1");
    let hook = start_in(&dir.path().join("state-none"), "10", &payload(), &pane);
    assert_eq!(
        pending(&dir.path().join("state-none"))["paneId"],
        Value::Null
    );
    drop(hook);
}

#[cfg(unix)]
#[test]
fn tmux_names_the_pane_before_zellij_and_herdr_and_a_malformed_tmux_pane_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = fake_herdr(dir.path(), &herdr_sessions());
    let mut pane = herdr_pane(&path, "w3V:p1");
    pane.extend([
        ("ZELLIJ_SESSION_NAME", "work"),
        ("ZELLIJ_PANE_ID", "3"),
        ("TMUX_PANE", "%9"),
    ]);
    let hook = start_in(dir.path(), "10", &payload(), &pane);
    assert_eq!(pending(dir.path())["paneId"], "%9");
    drop(hook);
    let refused = dir.path().join("refused");
    let output = start_in(&refused, "10", &payload(), &[("TMUX_PANE", "7;cmd")]).finish();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!refused.exists());
}
