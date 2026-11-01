//! Explicit native diagnostics; no production behavior or durability changes.
#[path = "../tests/support/thread_join.rs"]
mod thread_join;
use super::*;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Barrier, Mutex,
};

#[derive(Debug)]
struct Phase {
    name: &'static str,
    wall: Duration,
    busy: Duration,
}
#[derive(Debug)]
struct Worker {
    phases: Vec<Phase>,
    total: Duration,
    result: Result<()>,
}

fn probe(commit_hold: Duration) {
    eprintln!(
        "sqlite_storage_diagnostic writers=16 busy_budget=3s injected_commit_hold={commit_hold:?}"
    );
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let barrier = Barrier::new(16);
    let event = Event {
        session_id: "diagnostic".into(),
        agent: "Test".into(),
        project: "/fixture".into(),
        state: SessionState::Working,
        summary: "Synthetic fixture".into(),
        pane_id: None,
    };
    let workers = std::thread::scope(|scope| {
        let workers = (0..16)
            .map(|_| {
                scope.spawn(|| {
                    let mut store = match Store::open(dir.path()) {
                        Ok(store) => store,
                        Err(error) => {
                            barrier.wait();
                            return Worker {
                                phases: Vec::new(),
                                total: Duration::ZERO,
                                result: Err(error),
                            };
                        }
                    };
                    let phases = Arc::new(Mutex::new(Vec::new()));
                    let recorded = phases.clone();
                    let busy_nanos = Arc::new(AtomicU64::new(0));
                    let measured = busy_nanos.clone();
                    store
                        .connection
                        .busy_handler(Some(move |attempt| {
                            let started = Instant::now();
                            let result = wait_for_storage(attempt);
                            measured
                                .fetch_add(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
                            result
                        }))
                        .unwrap();
                    let mut previous_busy = 0;
                    store
                        .connection
                        .trace_v2(
                            TraceEventCodes::SQLITE_TRACE_PROFILE,
                            Some(move |event: TraceEvent<'_>| {
                                if let TraceEvent::Profile(statement, wall) = event {
                                    let sql = statement.sql();
                                    let name = if sql.starts_with("BEGIN") {
                                        "begin"
                                    } else if sql.starts_with("INSERT") {
                                        "insert"
                                    } else if sql.starts_with("DELETE") {
                                        "retention"
                                    } else if sql.starts_with("COMMIT") {
                                        "commit"
                                    } else {
                                        "other"
                                    };
                                    let current_busy = busy_nanos.load(Ordering::Relaxed);
                                    recorded.lock().unwrap().push(Phase {
                                        name,
                                        wall,
                                        busy: Duration::from_nanos(current_busy - previous_busy),
                                    });
                                    previous_busy = current_busy;
                                }
                            }),
                        )
                        .unwrap();
                    if !commit_hold.is_zero() {
                        // Model a known amount of time holding the write transaction. This
                        // does NOT identify filesystem sync latency in an unobserved CI run.
                        store
                            .connection
                            .commit_hook(Some(move || {
                                std::thread::sleep(commit_hold);
                                false
                            }))
                            .unwrap();
                    }
                    barrier.wait();
                    let started = Instant::now();
                    let result = store.ingest(&event, Utc::now());
                    let total = started.elapsed();
                    drop(store);
                    let phases = Arc::try_unwrap(phases).unwrap().into_inner().unwrap();
                    Worker {
                        phases,
                        total,
                        result,
                    }
                })
            })
            .collect::<Vec<_>>();
        thread_join::join_workers(workers)
    });
    let mut successes = 0;
    for (index, worker) in workers.iter().enumerate() {
        let busy = worker
            .phases
            .iter()
            .map(|phase| phase.busy)
            .sum::<Duration>();
        eprintln!(
            "worker={index} total={:?} callback_wait={busy:?} success={}",
            worker.total,
            worker.result.is_ok()
        );
        for phase in &worker.phases {
            eprintln!(
                "worker={index} phase={} wall={:?} callback_wait={:?} other_wall={:?}",
                phase.name,
                phase.wall,
                phase.busy,
                phase.wall.saturating_sub(phase.busy)
            );
        }
        match &worker.result {
            Ok(()) => successes += 1,
            Err(Error::Storage(rusqlite::Error::SqliteFailure(code, _))) => {
                assert_eq!(code.extended_code, 5);
                assert!(busy >= Duration::from_secs(2));
            }
            Err(error) => panic!("Unexpected diagnostic failure class={}", error.class()),
        }
        assert!(worker.total < Duration::from_secs(7));
    }
    let stored = Store::open(dir.path())
        .unwrap()
        .snapshot(50, Utc::now())
        .unwrap()
        .sessions
        .first()
        .map_or(0, |session| session.event_count);
    eprintln!("synthetic_commit_hold={commit_hold:?} committed={successes} stored={stored}");
    assert_eq!(stored, successes);
}

#[test]
#[ignore = "explicit storage phase diagnostic; emits only numeric timings and fixed phase names"]
fn profile_storage_commit_phases() {
    probe(Duration::ZERO);
}

#[test]
#[ignore = "controlled latency diagnostic; intentionally exhausts some unchanged wait budgets"]
fn profile_storage_with_known_commit_hold() {
    probe(Duration::from_millis(250));
}

#[test]
fn schema_initialization_commits_once_and_warm_open_does_not_commit() {
    let directory = tempfile::tempdir().unwrap();
    let mut connection = Connection::open(directory.path().join("events.sqlite3")).unwrap();
    connection
        .pragma_update(None, "synchronous", "FULL")
        .unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    let commits = Arc::new(AtomicU64::new(0));
    let observed = commits.clone();
    connection
        .commit_hook(Some(move || {
            observed.fetch_add(1, Ordering::Relaxed);
            false
        }))
        .unwrap();
    let durations = Arc::new(Mutex::new(Vec::new()));
    let measured = durations.clone();
    connection
        .trace_v2(
            TraceEventCodes::SQLITE_TRACE_PROFILE,
            Some(move |event: TraceEvent<'_>| {
                if let TraceEvent::Profile(_, elapsed) = event {
                    measured.lock().unwrap().push(elapsed.as_micros());
                }
            }),
        )
        .unwrap();
    let started = Instant::now();
    initialize_schema(&mut connection).unwrap();
    eprintln!(
        "schema_bootstrap commits={} wall_us={} statement_us={:?}",
        commits.load(Ordering::Relaxed),
        started.elapsed().as_micros(),
        durations.lock().unwrap()
    );
    assert_eq!(
        commits.load(Ordering::Relaxed),
        1,
        "Schema DDL must share one commit"
    );
    commits.store(0, Ordering::Relaxed);
    initialize_schema(&mut connection).unwrap();
    assert_eq!(
        commits.load(Ordering::Relaxed),
        0,
        "Warm schema must not acquire a write transaction"
    );
}

#[test]
fn last_schema_failure_rolls_back_new_tables_and_preserves_existing_data() {
    let directory = tempfile::tempdir().unwrap();
    let mut connection = Connection::open(directory.path().join("events.sqlite3")).unwrap();
    // The final relay index cannot be created on this incompatible preexisting table.
    connection.execute_batch("CREATE TABLE relay_outbox(id TEXT PRIMARY KEY); INSERT INTO relay_outbox VALUES ('owned');").unwrap();
    assert!(initialize_schema(&mut connection).is_err());
    let created: i64 = connection.query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('sessions','claude_reported_history','aider_hook_health','relay_policy')", [], |row| row.get(0)).unwrap();
    assert_eq!(
        created, 0,
        "A later DDL failure must not publish partial bootstrap tables"
    );
    let preserved: i64 = connection
        .query_row(
            "SELECT count(*) FROM relay_outbox WHERE id='owned'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(preserved, 1);
    assert!(connection.is_autocommit());
}
