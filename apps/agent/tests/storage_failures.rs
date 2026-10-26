//! Real CLI invocation diagnostics; owned synthetic stores only.
#[path = "support/process.rs"]
mod process;
#[path = "../src/storage_failure_record.rs"]
#[allow(dead_code)]
mod record;
use lazysh_agent::Store;
use std::{
    path::Path,
    process::{Command, Output},
};

fn invoke(directory: &Path, enabled: Option<&str>, payload: &[u8]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    command
        .args(["ingest", "--agent", "generic"])
        .env("LAZYSH_STATE_DIR", directory)
        .env_remove("LAZYSH_STORAGE_DIAGNOSTICS")
        .env_remove("TMUX_PANE")
        .current_dir(directory);
    if let Some(enabled) = enabled {
        command.env("LAZYSH_STORAGE_DIAGNOSTICS", enabled);
    }
    process::run(&mut command, payload)
}
const PAYLOAD: &[u8] = br#"{"schemaVersion":1,"sessionId":"private-session","agent":"private-agent","project":"private-project","state":"working","summary":"private-summary"}"#;
const LEGACY_ERROR: &str = "lazysh-agent: StorageError: operation failed (sqlite_code=5)\n";

fn assert_diagnostic_failure(output: Output, phase: record::Phase, code: i32) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    let (line, legacy) = stderr.split_once('\n').unwrap();
    let failure = record::Failure::parse(line).expect("one finite diagnostic record");
    assert_eq!(failure.phase, phase);
    assert_eq!(failure.result, record::ResultClass::StorageError);
    assert_eq!(failure.sqlite_code, Some(code));
    assert_eq!(
        legacy,
        format!("lazysh-agent: StorageError: operation failed (sqlite_code={code})\n")
    );
    assert!(!stderr.contains("private"));
}

#[test]
fn controlled_cli_writer_failure_identifies_its_actual_phase_without_changing_the_error() {
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let blocker = rusqlite::Connection::open(dir.path().join("events.sqlite3")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    for enabled in [None, Some("true"), Some("1")] {
        let start = std::time::Instant::now();
        let output = invoke(dir.path(), enabled, PAYLOAD);
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
        if enabled == Some("1") {
            assert_diagnostic_failure(output, record::Phase::IngestBegin, 5);
        } else {
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert_eq!(String::from_utf8(output.stderr).unwrap(), LEGACY_ERROR);
        }
    }
    blocker.execute_batch("ROLLBACK").unwrap();
    let output = invoke(dir.path(), Some("1"), PAYLOAD);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let rejected = invoke(dir.path(), Some("1"), br#"{"private":"not an event"}"#);
    assert!(!rejected.status.success());
    assert!(!String::from_utf8(rejected.stderr)
        .unwrap()
        .contains(record::PREFIX));
}

#[test]
fn bootstrap_lock_busy_is_distinct_from_sqlite_writer_busy() {
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.path().join("events.sqlite3-init-lock"))
        .unwrap();
    lock.lock().unwrap();
    let output = invoke(dir.path(), Some("1"), PAYLOAD);
    assert_diagnostic_failure(output, record::Phase::BootstrapLock, 5);
}

#[test]
fn native_statement_failure_records_the_exact_boundary_without_its_private_message() {
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let connection = rusqlite::Connection::open(dir.path().join("events.sqlite3")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_owned BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'private-SQL-payload'); END;").unwrap();
    let output = invoke(dir.path(), Some("1"), PAYLOAD);
    assert_diagnostic_failure(output, record::Phase::SessionWrite, 1811);
}
