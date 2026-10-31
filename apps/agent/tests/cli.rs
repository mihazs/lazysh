#[path = "support/binary.rs"]
mod binary;
#[cfg(unix)]
#[path = "support/permissions.rs"]
mod permissions;
#[path = "support/process.rs"]
mod process;
#[path = "support/thread_join.rs"]
mod thread_join;
use lazysh_agent::{Agent, SessionState, Store};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
#[path = "support/storage_trace.rs"]
mod storage_trace;

fn run(directory: &Path, args: &[&str], payload: &[u8]) -> Output {
    run_traced(directory, args, payload, None)
}
fn run_traced(
    directory: &Path,
    args: &[&str],
    payload: &[u8],
    trace: Option<(&storage_trace::StorageTrace, usize)>,
) -> Output {
    let program = binary::path();
    let mut command = trace.map_or_else(
        || Command::new(&program),
        |(trace, worker)| trace.command(worker, &program),
    );
    // The full native test process may opt into phase records; ordinary CLI
    // children retain their normal stderr contract. Explicit traces opt in above.
    if trace.is_none() {
        command.env_remove("LAZYSH_STORAGE_DIAGNOSTICS");
    }
    process::run(
        command
            .args(args)
            .env("LAZYSH_STATE_DIR", directory)
            .env("TMUX_PANE", "%7")
            .current_dir(directory),
        payload,
    )
}
fn event(session: &str, state: &str) -> Value {
    json!({"schemaVersion":1,"sessionId":session,"agent":"Test Agent","project":"/work/app","state":state,"summary":"A turn","paneId":"%1"})
}
fn ingest(directory: &Path, kind: &str, payload: &Value) -> Output {
    run(
        directory,
        &["ingest", "--agent", kind],
        &serde_json::to_vec(payload).unwrap(),
    )
}
fn snapshot(directory: &Path, limit: &str) -> Value {
    let output = run(directory, &["snapshot", "--limit", limit], b"");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn distinct_sessions_and_agents_keep_their_latest_state() {
    let dir = tempfile::tempdir().unwrap();
    for (session, state) in [("a", "working"), ("b", "done"), ("a", "needs_attention")] {
        assert!(ingest(dir.path(), "generic", &event(session, state))
            .status
            .success());
    }
    let mut other = event("a", "done");
    other["agent"] = json!("Other Agent");
    assert!(ingest(dir.path(), "generic", &other).status.success());
    let output = snapshot(dir.path(), "10");
    assert_eq!(output["schemaVersion"], 1);
    let sessions = output["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 3);
    let first = sessions
        .iter()
        .find(|s| s["sessionId"] == "a" && s["agent"] == "Test Agent")
        .unwrap();
    assert_eq!(first["state"], "needs_attention");
    assert_eq!(first["eventCount"], 2);
    assert_eq!(first["paneId"], "%1");
    assert!(chrono::DateTime::parse_from_rfc3339(first["updatedAt"].as_str().unwrap()).is_ok());
    assert_eq!(
        sessions.iter().find(|s| s["sessionId"] == "b").unwrap()["eventCount"],
        1
    );
}

#[test]
fn claude_discards_prompts_tool_arguments_and_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let output = ingest(
        dir.path(),
        "claude",
        &json!({"hook_event_name":"PreToolUse","session_id":"s1","cwd":"/work","tool_name":"Bash","tool_input":{"command":"SECRET-TOKEN"},"prompt":"PRIVATE-PROMPT"}),
    );
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    let state = snapshot(dir.path(), "50");
    assert_eq!(state["sessions"][0]["paneId"], "%7");
    assert_eq!(state["sessions"][0]["summary"], "Bash");
    for entry in fs::read_dir(dir.path()).unwrap() {
        let bytes = fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes
            .windows(b"SECRET-TOKEN".len())
            .any(|w| w == b"SECRET-TOKEN"));
        assert!(!bytes
            .windows(b"PRIVATE-PROMPT".len())
            .any(|w| w == b"PRIVATE-PROMPT"));
    }
}

#[test]
fn invalid_events_fail_without_files_or_secret_echo() {
    let dir = tempfile::tempdir().unwrap();
    let mut bad_version = event("a", "done");
    bad_version["schemaVersion"] = json!(true);
    let mut float_version = event("a", "done");
    float_version["schemaVersion"] = json!(1.0);
    for payload in [
        json!([]),
        json!({"password":"SECRET"}),
        event("a", "approved"),
        event("a\ncmd", "done"),
        bad_version,
        float_version,
        event(&"界".repeat(257), "done"),
    ] {
        let output = ingest(dir.path(), "generic", &payload);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("SECRET"));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
    let malformed = run(
        dir.path(),
        &["ingest", "--agent", "generic"],
        b"{SECRET malformed",
    );
    assert_eq!(malformed.status.code(), Some(1));
    assert!(!String::from_utf8_lossy(&malformed.stderr).contains("SECRET"));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn notifications_distinguish_attention_from_information() {
    let dir = tempfile::tempdir().unwrap();
    for kind in ["auth_success", "unrecognized"] {
        assert!(ingest(dir.path(),"claude",&json!({"hook_event_name":"Notification","notification_type":kind,"session_id":"a","cwd":"/work"})).status.success());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
    assert!(ingest(dir.path(),"claude",&json!({"hook_event_name":"Notification","notification_type":"permission_prompt","session_id":"a","cwd":"/work"})).status.success());
    assert_eq!(
        snapshot(dir.path(), "50")["sessions"][0]["state"],
        "needs_attention"
    );
}

#[test]
fn snapshot_caps_rows_and_uses_private_local_storage() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    for i in 0..120 {
        let normalized =
            lazysh_agent::normalize(&event(&i.to_string(), "done"), Agent::Generic, None)
                .unwrap()
                .unwrap();
        store.ingest(&normalized, chrono::Utc::now()).unwrap();
    }
    drop(store);
    assert_eq!(
        snapshot(dir.path(), "100")["sessions"]
            .as_array()
            .unwrap()
            .len(),
        100
    );
    assert_eq!(
        snapshot(dir.path(), "2")["sessions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    #[cfg(unix)]
    permissions::assert_state_modes(dir.path(), 0o700, 0o600);
}

#[test]
fn snapshot_expires_old_rows_even_without_new_events() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let normalized = lazysh_agent::normalize(&event("old", "done"), Agent::Generic, None)
        .unwrap()
        .unwrap();
    store
        .ingest(&normalized, chrono::Utc::now() - chrono::TimeDelta::days(8))
        .unwrap();
    drop(store);
    assert!(snapshot(dir.path(), "100")["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn codex_hooks_preserve_main_turn_while_subagents_finish() {
    let dir = tempfile::tempdir().unwrap();
    for (kind, state) in [
        ("UserPromptSubmit", "working"),
        ("PermissionRequest", "needs_attention"),
        ("PostToolUse", "working"),
        ("Interrupt", "done"),
        ("Stop", "done"),
        ("SessionEnd", "done"),
    ] {
        let payload = json!({"hook_event_name":kind,"session_id":"parent","cwd":"/work","prompt":"PRIVATE-PROMPT","tool_input":{"token":"SECRET-TOKEN"}});
        let output = ingest(dir.path(), "codex", &payload);
        assert!(output.status.success());
        assert!(output.stdout.is_empty() && output.stderr.is_empty());
        let before = snapshot(dir.path(), "1");
        assert_eq!(before["sessions"][0]["state"], state);
        assert_eq!(before["sessions"][0]["agent"], "Codex");
        for ignored in [
            "SessionStart",
            "SubagentStart",
            "SubagentStop",
            "Notification",
            "PostToolUseFailure",
            "Unknown",
        ] {
            let output = ingest(
                dir.path(),
                "codex",
                &json!({"hook_event_name":ignored,"session_id":"parent","agent_id":"child","cwd":"/work"}),
            );
            assert!(output.status.success());
            assert_eq!(snapshot(dir.path(), "1"), before);
        }
    }
}

#[test]
fn opencode_native_events_keep_exact_sessions_and_bounded_metadata() {
    let dir = tempfile::tempdir().unwrap();
    for (kind, status, state) in [
        ("session.status", "busy", "working"),
        ("session.status", "retry", "working"),
        ("permission.asked", "", "needs_attention"),
        ("question.asked", "", "needs_attention"),
        ("session.error", "", "needs_attention"),
        ("session.status", "idle", "done"),
        ("session.deleted", "", "done"),
    ] {
        let output = ingest(
            dir.path(),
            "opencode",
            &json!({"type":kind,"directory":"/work","properties":{"sessionID":"ses_owned","status":{"type":status},"metadata":{"secret":"SECRET-TOKEN"},"error":{"message":"PRIVATE-PROMPT"}}}),
        );
        assert!(output.status.success());
        assert!(output.stdout.is_empty() && output.stderr.is_empty());
        let snapshot = snapshot(dir.path(), "1");
        assert_eq!(snapshot["sessions"][0]["sessionId"], "ses_owned");
        assert_eq!(snapshot["sessions"][0]["state"], state);
        assert_eq!(snapshot["sessions"][0]["agent"], "OpenCode");
        assert_eq!(snapshot["sessions"][0]["paneId"], "%7");
        assert!(!snapshot.to_string().contains("SECRET-TOKEN"));
        assert!(!snapshot.to_string().contains("PRIVATE-PROMPT"));
    }
    let before = snapshot(dir.path(), "1");
    for payload in [
        json!({"type":"session.error","properties":{}}),
        json!({"type":"permission.replied"}),
        json!({"type":"session.idle"}),
        json!({"type":"session.status","properties":{"status":{"type":"future"}}}),
    ] {
        assert!(ingest(dir.path(), "opencode", &payload).status.success());
        assert_eq!(snapshot(dir.path(), "1"), before);
    }
    for bad in [
        json!(""),
        json!("bad\nsession"),
        json!("s".repeat(257)),
        json!(12),
    ] {
        assert!(!ingest(
            dir.path(),
            "opencode",
            &json!({"type":"permission.asked","directory":"/work","properties":{"sessionID":bad}})
        )
        .status
        .success());
        assert_eq!(snapshot(dir.path(), "1"), before);
    }
}

#[test]
fn native_hook_assets_are_print_only_and_never_change_profiles_or_trust() {
    let dir = tempfile::tempdir().unwrap();
    for command in ["codex-config", "opencode-plugin"] {
        let output = run(dir.path(), &[command], b"");
        assert!(output.status.success());
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        if command == "codex-config" {
            let hooks = value["hooks"].as_object().unwrap();
            assert_eq!(hooks.len(), 7);
            for (kind, value) in hooks {
                assert!(!kind.starts_with("Subagent") && kind != "SessionStart");
                assert_eq!(
                    value[0]["hooks"][0]["command"],
                    "lazysh-agent ingest --agent codex"
                );
                assert_eq!(value[0]["hooks"][0]["timeout"], 3);
            }
        } else {
            assert_eq!(value["filename"], "lazysh.js");
            assert_eq!(value["content"], include_str!("../hooks/opencode.js"));
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

#[test]
fn unscoped_kimi_terminal_hooks_do_not_finish_or_fault_the_parent() {
    let dir = tempfile::tempdir().unwrap();
    let mut observed = Vec::new();
    // Kimi 1.52.0 shares parent session/engine with child souls and omits role from these events.
    for terminal in [
        json!({"hook_event_name":"Stop","session_id":"owned-parent","cwd":"/owned/project","stop_hook_active":false}),
        json!({"hook_event_name":"StopFailure","session_id":"owned-parent","cwd":"/owned/project","error_type":"OwnedChildError","error_message":"PRIVATE-PROMPT"}),
    ] {
        for payload in [
            json!({"hook_event_name":"UserPromptSubmit","session_id":"owned-parent","cwd":"/owned/project","prompt":"parent prompt"}),
            json!({"hook_event_name":"PreToolUse","session_id":"owned-parent","cwd":"/owned/project","tool_name":"Agent"}),
            json!({"hook_event_name":"UserPromptSubmit","session_id":"owned-parent","cwd":"/owned/project","prompt":"child prompt"}),
        ] {
            assert!(ingest(dir.path(), "kimi", &payload).status.success());
        }
        let before = snapshot(dir.path(), "1");
        let output = ingest(dir.path(), "kimi", &terminal);
        assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
        let after = snapshot(dir.path(), "1");
        observed.push((
            after["sessions"][0]["state"].as_str().unwrap().to_owned(),
            before == after,
        ));
    }
    assert_eq!(
        observed,
        vec![("working".into(), true), ("working".into(), true)]
    );
}

#[test]
fn additional_native_agents_report_only_their_actual_lifecycle_contracts() {
    for (agent, name, events, unsupported, attention_type) in [
        (
            "gemini",
            "Gemini CLI",
            vec![
                ("BeforeAgent", "working"),
                ("BeforeTool", "working"),
                ("AfterTool", "working"),
                ("Notification", "needs_attention"),
                ("AfterAgent", "done"),
                ("SessionEnd", "done"),
            ],
            vec![
                "UserPromptSubmit",
                "PreToolUse",
                "PostToolUse",
                "Stop",
                "PermissionRequest",
                "StopFailure",
            ],
            "ToolPermission",
        ),
        (
            "droid",
            "Droid",
            vec![
                ("UserPromptSubmit", "working"),
                ("PreToolUse", "working"),
                ("PostToolUse", "working"),
                ("Notification", "needs_attention"),
                ("Stop", "done"),
                ("SessionEnd", "done"),
            ],
            vec![
                "BeforeAgent",
                "BeforeTool",
                "AfterTool",
                "AfterAgent",
                "PermissionRequest",
                "PostToolUseFailure",
                "StopFailure",
            ],
            "permission_prompt",
        ),
        (
            "kimi",
            "Kimi CLI",
            vec![
                ("UserPromptSubmit", "working"),
                ("PreToolUse", "working"),
                ("PostToolUse", "working"),
                ("PostToolUseFailure", "working"),
                ("Notification", "needs_attention"),
                ("SessionEnd", "done"),
            ],
            vec![
                "BeforeAgent",
                "BeforeTool",
                "AfterTool",
                "AfterAgent",
                "PermissionRequest",
                "Stop",
                "StopFailure",
            ],
            "permission_prompt",
        ),
        (
            "copilot",
            "GitHub Copilot CLI",
            vec![
                ("UserPromptSubmit", "working"),
                ("PostToolUse", "working"),
                ("PostToolUseFailure", "working"),
                ("Notification", "needs_attention"),
                ("Stop", "done"),
                ("SessionEnd", "done"),
            ],
            vec![
                "BeforeAgent",
                "BeforeTool",
                "AfterTool",
                "AfterAgent",
                "PreToolUse",
                "PermissionRequest",
                "StopFailure",
            ],
            "permission_prompt",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        for (index, (kind, state)) in events.iter().enumerate() {
            let mut payload = json!({"hook_event_name":kind,"session_id":"owned-main","cwd":"/owned/project","notification_type":attention_type,"prompt":"PRIVATE-PROMPT","prompt_response":"PRIVATE-PROMPT","body":"PRIVATE-PROMPT","tool_input":{"token":"SECRET-TOKEN"},"error_message":"SECRET-TOKEN"});
            if agent == "copilot" && *kind == "Notification" {
                payload.as_object_mut().unwrap().remove("session_id");
                payload["sessionId"] = json!("owned-main");
            }
            let output = ingest(dir.path(), agent, &payload);
            assert!(output.status.success(), "{agent}/{kind}");
            assert!(output.stdout.is_empty() && output.stderr.is_empty());
            let row = &snapshot(dir.path(), "1")["sessions"][0];
            assert_eq!(row["sessionId"], "owned-main");
            assert_eq!(row["agent"], name);
            assert_eq!(row["project"], "/owned/project");
            assert_eq!(row["paneId"], "%7");
            assert_eq!(row["state"], *state);
            assert_eq!(row["eventCount"], index + 1);
            let before = snapshot(dir.path(), "1");
            for ignored in unsupported.iter().copied().chain([
                "SessionStart",
                "SubagentStart",
                "SubagentStop",
                "PreCompact",
                "Unknown",
            ]) {
                let output = ingest(
                    dir.path(),
                    agent,
                    &json!({"hook_event_name":ignored,"session_id":"owned-main","agent_id":"owned-child","cwd":"/owned/project","response":"PRIVATE-PROMPT"}),
                );
                assert!(output.status.success());
                assert_eq!(snapshot(dir.path(), "1"), before);
            }
            let output = ingest(
                dir.path(),
                agent,
                &json!({"hook_event_name":"Notification","session_id":"owned-main","cwd":"/owned/project","notification_type":"auth_success","message":"PRIVATE-PROMPT"}),
            );
            assert!(output.status.success());
            assert_eq!(snapshot(dir.path(), "1"), before);
        }
        if agent == "copilot" {
            let before = snapshot(dir.path(), "1");
            for kind in ["Stop", "SessionEnd"] {
                assert!(ingest(dir.path(), agent, &json!({"hook_event_name":kind,"session_id":"owned-main","agent_id":"owned-child","parent_agent_id":"owned-parent","cwd":"/owned/project"})).status.success());
                assert_eq!(snapshot(dir.path(), "1"), before);
            }
            for kind in [
                "agent_completed",
                "agent_idle",
                "shell_completed",
                "shell_detached_completed",
            ] {
                assert!(ingest(dir.path(), agent, &json!({"hook_event_name":"Notification","sessionId":"owned-main","cwd":"/owned/project","notification_type":kind})).status.success());
                assert_eq!(snapshot(dir.path(), "1"), before);
            }
            assert!(!ingest(dir.path(), agent, &json!({"hook_event_name":"Notification","session_id":"wrong-snake-field","cwd":"/owned/project","notification_type":"permission_prompt"})).status.success());
            assert_eq!(snapshot(dir.path(), "1"), before);
            assert!(ingest(dir.path(), agent, &json!({"hook_event_name":"Notification","sessionId":"owned-main","session_id":"ignored-wrong-field","cwd":"/owned/project","notification_type":"elicitation_dialog"})).status.success());
            let row = &snapshot(dir.path(), "1")["sessions"][0];
            assert_eq!(row["sessionId"], "owned-main");
            assert_eq!(row["state"], "needs_attention");
        }
        for entry in fs::read_dir(dir.path()).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            for secret in [b"SECRET-TOKEN".as_slice(), b"PRIVATE-PROMPT"] {
                assert!(!bytes.windows(secret.len()).any(|window| window == secret));
            }
        }
        let before = snapshot(dir.path(), "1");
        let kind = events[0].0;
        for invalid in [
            json!(""),
            json!(12),
            json!("id\ncontrol"),
            json!("s".repeat(257)),
        ] {
            let output = ingest(
                dir.path(),
                agent,
                &json!({"hook_event_name":kind,"session_id":invalid,"cwd":"/owned/project"}),
            );
            assert!(!output.status.success());
            assert_eq!(snapshot(dir.path(), "1"), before);
        }
    }
}

#[test]
fn config_is_print_only_and_contains_supported_hooks() {
    let dir = tempfile::tempdir().unwrap();
    let output = run(dir.path(), &["claude-config"], b"");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let config: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(config["hooks"]["Stop"][0]["hooks"][0]["type"], "command");
    assert_eq!(
        config["hooks"]["Stop"][0]["hooks"][0]["command"],
        "lazysh-agent ingest --agent claude"
    );
    assert_eq!(config["hooks"].as_object().unwrap().len(), 8);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn concurrent_hooks_preserve_every_event() {
    let trace = storage_trace::StorageTrace::from_env();
    let dir = tempfile::tempdir().unwrap();
    let outputs = std::thread::scope(|scope| {
        let workers = (0..16)
            .map(|worker| {
                let trace = trace.as_ref();
                let directory = dir.path();
                scope.spawn(move || {
                    run_traced(
                        directory,
                        &["ingest", "--agent", "generic"],
                        &serde_json::to_vec(&event("same", "working")).unwrap(),
                        trace.map(|trace| (trace, worker)),
                    )
                })
            })
            .collect::<Vec<_>>();
        thread_join::join_workers(workers)
    });
    // Retain evidence from this exact failing case before its unchanged gates.
    if let Some(trace) = trace {
        trace
            .export(&outputs)
            .expect("export owned storage trace excerpts");
    }
    for output in outputs {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let output = snapshot(dir.path(), "50");
    let sessions = output["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["eventCount"], 16);
}

#[test]
fn opening_another_store_preserves_an_existing_sqlite_writer_lock() {
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let writer = rusqlite::Connection::open(dir.path().join("events.sqlite3")).unwrap();
    // A RESERVED writer permits schema reads from another connection, but no
    // other process may start a write until this transaction ends.
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    drop(Store::open(dir.path()).unwrap());
    let output = ingest(dir.path(), "generic", &event("blocked", "working"));
    writer.execute_batch("ROLLBACK").unwrap();
    assert!(
        !output.status.success(),
        "opening another Store released a live SQLite writer's OS lock"
    );
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "lazysh-agent: StorageError: operation failed (sqlite_code=5)\n"
    );
    assert!(snapshot(dir.path(), "50")["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn simultaneous_initialization_and_ingest_preserve_every_event() {
    for round in 0..4 {
        let dir = tempfile::tempdir().unwrap();
        let barrier = std::sync::Barrier::new(16);
        let normalized = lazysh_agent::normalize(&event("same", "working"), Agent::Generic, None)
            .unwrap()
            .unwrap();
        // Reference the round's spawn epoch without adding a barrier participant.
        let epoch = std::time::Instant::now();
        let workers = std::thread::scope(|scope| {
            let workers = ContendedWorker::spawn(scope, &barrier, dir.path(), &normalized, epoch);
            thread_join::join_workers(workers)
        });
        if workers.iter().any(|worker| worker.result.is_err()) {
            storage_trace::initialization_workers(round, &workers);
        }
        for worker in &workers {
            worker.result.as_ref().expect(if worker.stage == "open" {
                "concurrent Store::open"
            } else {
                "concurrent ingest"
            });
        }
        let mut store = Store::open(dir.path()).unwrap();
        let count = store
            .snapshot(50, chrono::Utc::now())
            .unwrap()
            .sessions
            .first()
            .map_or(0, |session| session.event_count);
        if count != 16 {
            storage_trace::initialization_workers(round, &workers);
        }
        assert_eq!(count, 16);
    }
}

#[derive(Debug)]
struct ContendedWorker {
    started_after: std::time::Duration,
    open_elapsed: std::time::Duration,
    total_elapsed: std::time::Duration,
    stage: &'static str,
    result: lazysh_agent::Result<()>,
}

impl ContendedWorker {
    fn spawn<'scope>(
        scope: &'scope std::thread::Scope<'scope, '_>,
        barrier: &'scope std::sync::Barrier,
        directory: &'scope Path,
        normalized: &'scope lazysh_agent::Event,
        epoch: std::time::Instant,
    ) -> Vec<std::thread::ScopedJoinHandle<'scope, Self>> {
        (0..16)
            .map(|_| {
                scope.spawn(move || {
                    barrier.wait();
                    Self::ingest(directory, normalized, epoch)
                })
            })
            .collect()
    }
    fn ingest(
        directory: &Path,
        normalized: &lazysh_agent::Event,
        epoch: std::time::Instant,
    ) -> Self {
        let started = std::time::Instant::now();
        let started_after = started.duration_since(epoch);
        let opened = Store::open(directory);
        let open_elapsed = started.elapsed();
        let (stage, result) = match opened {
            Ok(mut store) => match store.ingest(normalized, chrono::Utc::now()) {
                Ok(()) => ("complete", Ok(())),
                Err(error) => ("ingest", Err(error)),
            },
            Err(error) => ("open", Err(error)),
        };
        ContendedWorker {
            started_after,
            open_elapsed,
            total_elapsed: started.elapsed(),
            stage,
            result,
        }
    }
}

fn exclusive_store() -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let blocker = rusqlite::Connection::open(dir.path().join("events.sqlite3")).unwrap();
    blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();
    (dir, blocker)
}
fn contended_ingests(
    hold: std::time::Duration,
) -> (Vec<ContendedWorker>, std::time::Duration, u64) {
    let (dir, blocker) = exclusive_store();
    let barrier = std::sync::Barrier::new(17);
    let normalized = lazysh_agent::normalize(&event("same", "working"), Agent::Generic, None)
        .unwrap()
        .unwrap();
    let epoch = std::time::Instant::now();
    let (workers, actual_hold) = std::thread::scope(|scope| {
        let workers = ContendedWorker::spawn(scope, &barrier, dir.path(), &normalized, epoch);
        barrier.wait();
        let hold_started = std::time::Instant::now();
        std::thread::sleep(hold);
        blocker.execute_batch("ROLLBACK").unwrap();
        let actual_hold = hold_started.elapsed();
        (thread_join::join_workers(workers), actual_hold)
    });
    let stored = Store::open(dir.path())
        .unwrap()
        .snapshot(50, chrono::Utc::now())
        .unwrap()
        .sessions
        .first()
        .map_or(0, |session| session.event_count);
    (workers, actual_hold, stored)
}

#[test]
fn concurrent_ingest_recovers_after_a_transient_database_lock() {
    // Leave ample budget for all writers, scheduling and durable filesystem I/O.
    let (workers, actual_hold, stored) = contended_ingests(std::time::Duration::from_millis(250));
    assert!(
        workers.iter().all(|worker| worker.result.is_ok()),
        "actual_hold={actual_hold:?}, workers={workers:#?}"
    );
    assert_eq!(
        stored, 16,
        "actual_hold={actual_hold:?}, workers={workers:#?}"
    );
}

#[test]
fn near_deadline_contention_counts_every_success_and_fails_explicitly() {
    // This stress case deliberately leaves little wait budget. Recovery of all
    // workers is not promised; successful commits must still never be lost.
    let (workers, actual_hold, stored) = contended_ingests(std::time::Duration::from_millis(2700));
    eprintln!("actual_hold={actual_hold:?}, workers={workers:#?}");
    let mut successes = 0;
    for worker in &workers {
        assert!(
            worker.started_after < std::time::Duration::from_secs(7),
            "{worker:?}"
        );
        assert!(worker.open_elapsed <= worker.total_elapsed, "{worker:?}");
        assert!(
            worker.total_elapsed < std::time::Duration::from_secs(7),
            "{worker:?}"
        );
        match &worker.result {
            Ok(()) => {
                assert_eq!(worker.stage, "complete");
                successes += 1;
            }
            Err(lazysh_agent::Error::Storage(rusqlite::Error::SqliteFailure(code, _))) => {
                assert_eq!(code.extended_code, 5, "{worker:?}");
                // Catch immediate non-retryable upgrades separately from budget exhaustion.
                let failed_stage_elapsed = match worker.stage {
                    "open" => worker.open_elapsed,
                    "ingest" => worker.total_elapsed.saturating_sub(worker.open_elapsed),
                    _ => panic!("unexpected failed stage: {worker:?}"),
                };
                assert!(
                    failed_stage_elapsed >= std::time::Duration::from_secs(2),
                    "early busy failure: {worker:?}"
                );
            }
            Err(error) => panic!("unexpected contention failure: {error:?}, worker={worker:?}"),
        }
    }
    assert_eq!(
        stored, successes,
        "actual_hold={actual_hold:?}, workers={workers:#?}"
    );
}

#[test]
fn sustained_storage_contention_is_bounded_and_reports_only_the_sqlite_code() {
    let (dir, blocker) = exclusive_store();
    let started = std::time::Instant::now();
    let output = ingest(
        dir.path(),
        "generic",
        &event("private-session-marker", "working"),
    );
    assert!(!output.status.success());
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "lazysh-agent: StorageError: operation failed (sqlite_code=5)\n"
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    assert!(snapshot(dir.path(), "50")["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn oversized_stdin_fails_before_opening_storage() {
    let dir = tempfile::tempdir().unwrap();
    let mut payload = event("a", "working");
    payload["unused"] = json!("x".repeat(256 * 1024));
    let output = ingest(dir.path(), "generic", &payload);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn invalid_snapshot_limits_fail_before_creating_storage() {
    let dir = tempfile::tempdir().unwrap();
    for limit in ["0", "101", "-1", "true"] {
        let output = run(dir.path(), &["snapshot", "--limit", limit], b"");
        assert!(!output.status.success());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

#[test]
fn lifecycle_events_update_status_without_executing_actions() {
    let dir = tempfile::tempdir().unwrap();
    for (kind, state) in [
        ("UserPromptSubmit", SessionState::Working),
        ("PermissionRequest", SessionState::NeedsAttention),
        ("Stop", SessionState::Done),
        ("SessionEnd", SessionState::Done),
    ] {
        let output = ingest(
            dir.path(),
            "claude",
            &json!({"hook_event_name":kind,"session_id":"a","cwd":"/work"}),
        );
        assert!(output.status.success());
        let summary: lazysh_agent::Snapshot =
            serde_json::from_value(snapshot(dir.path(), "1")).unwrap();
        assert_eq!(summary.sessions[0].event.state, state);
    }
    assert_eq!(
        fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| !matches!(
                e.file_name().to_str(),
                Some(
                    "events.sqlite3"
                        | "events.sqlite3-init-lock"
                        | "events.sqlite3-wal"
                        | "events.sqlite3-shm"
                )
            ))
            .count(),
        0
    );
}

#[cfg(unix)]
#[test]
fn refuses_state_symlinks_and_database_links_without_changing_the_target() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    fs::create_dir(&target).unwrap();
    let link = dir.path().join("linked");
    symlink(&target, &link).unwrap();
    assert!(Store::open(&link).is_err());
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    let storage = dir.path().join("state");
    fs::create_dir(&storage).unwrap();
    let victim = dir.path().join("victim");
    fs::write(&victim, b"untouched").unwrap();
    let db = storage.join("events.sqlite3");
    symlink(&victim, &db).unwrap();
    assert!(Store::open(&storage).is_err());
    assert_eq!(fs::read(&victim).unwrap(), b"untouched");
    fs::remove_file(&db).unwrap();
    fs::hard_link(&victim, &db).unwrap();
    assert!(Store::open(&storage).is_err());
    assert_eq!(fs::read(&victim).unwrap(), b"untouched");
}

#[test]
fn hook_previews_label_their_dialect_and_platform_binding_without_creating_state() {
    let directory = tempfile::tempdir().unwrap();
    for (agent, dialect) in [
        ("claude", "posix-shell"),
        ("codex", "posix-shell"),
        ("opencode", "bun-javascript"),
    ] {
        let output = run(
            directory.path(),
            &["hooks", "preview", "--agent", agent],
            b"",
        );
        assert!(output.status.success());
        let preview: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(preview["agent"], agent);
        assert_eq!(preview["dialect"], dialect);
        assert_eq!(preview["reporting"], "notChecked");
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            assert_eq!(preview["binaryBinding"], "currentExecutable");
            assert!(Path::new(preview["binary"].as_str().unwrap()).is_absolute());
        } else {
            assert_eq!(preview["binaryBinding"], "unboundTemplate");
            assert_eq!(preview["managedSetupSupported"], false);
            assert!(preview.get("binary").is_none());
        }
    }
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
}
