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
    for _ in 0..4 {
        let dir = tempfile::tempdir().unwrap();
        let barrier = std::sync::Barrier::new(16);
        let normalized = lazysh_agent::normalize(&event("same", "working"), Agent::Generic, None)
            .unwrap()
            .unwrap();
        std::thread::scope(|scope| {
            let workers = (0..16)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        let mut store = Store::open(dir.path()).expect("concurrent Store::open");
                        store
                            .ingest(&normalized, chrono::Utc::now())
                            .expect("concurrent ingest");
                    })
                })
                .collect::<Vec<_>>();
            for worker in workers {
                worker.join().unwrap();
            }
        });
        let mut store = Store::open(dir.path()).unwrap();
        assert_eq!(
            store.snapshot(50, chrono::Utc::now()).unwrap().sessions[0].event_count,
            16
        );
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
        let workers = (0..16)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    let started = std::time::Instant::now();
                    let started_after = started.duration_since(epoch);
                    let opened = Store::open(dir.path());
                    let open_elapsed = started.elapsed();
                    let (stage, result) = match opened {
                        Ok(mut store) => match store.ingest(&normalized, chrono::Utc::now()) {
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
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let hold_started = std::time::Instant::now();
        std::thread::sleep(hold);
        blocker.execute_batch("ROLLBACK").unwrap();
        let actual_hold = hold_started.elapsed();
        (
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>(),
            actual_hold,
        )
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
