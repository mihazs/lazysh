//! Synthetic native stores only; no developer state or external services.
#[path = "support/binary.rs"]
mod binary;
#[path = "../src/storage_schema.rs"]
mod storage_schema;
use chrono::Utc;
use lazysh_agent::{Event, SessionState, Store};
use rusqlite::Connection;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

fn event() -> Event {
    Event {
        session_id: "recovery".into(),
        agent: "Fixture".into(),
        project: "/fixture".into(),
        state: SessionState::Working,
        summary: "Synthetic".into(),
        pane_id: None,
    }
}

#[cfg(unix)]
#[test]
fn short_lived_writers_keep_private_sidecar_inodes_and_recover_commits() {
    use std::os::unix::fs::MetadataExt;
    let directory = tempfile::tempdir().unwrap();
    let paths =
        ["-wal", "-shm"].map(|suffix| directory.path().join(format!("events.sqlite3{suffix}")));
    let inspect = || {
        paths
            .iter()
            .map(|path| {
                let metadata =
                    fs::symlink_metadata(path).expect("successful Store close removed a sidecar");
                assert!(lazysh_common::fs::owner_only(&metadata, false));
                assert_eq!(metadata.mode() & 0o777, 0o600);
                (metadata.dev(), metadata.ino())
            })
            .collect::<Vec<_>>()
    };
    let mut first = Store::open(directory.path()).unwrap();
    first.ingest(&event(), Utc::now()).unwrap();
    let original = inspect();
    drop(first);
    assert_eq!(inspect(), original);
    for _ in 0..16 {
        let mut writer = Store::open(directory.path()).unwrap();
        writer.ingest(&event(), Utc::now()).unwrap();
        drop(writer);
        assert_eq!(inspect(), original);
    }
    // A fresh process must recover the acknowledged rows from retained WAL.
    let output = Command::new(binary::path())
        .env("LAZYSH_STATE_DIR", directory.path())
        .args(["snapshot", "--limit", "50"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let snapshot: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(snapshot["sessions"][0]["eventCount"], 17);
    assert_eq!(inspect(), original);

    // Disabling automatic close checkpoints must not disable explicit checkpoints.
    let checkpoint = Connection::open(directory.path().join("events.sqlite3")).unwrap();
    assert!(checkpoint
        .set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true
        )
        .unwrap());
    let result: (i32, i32, i32) = checkpoint
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(result, (0, 0, 0));
    assert_eq!(fs::metadata(&paths[0]).unwrap().len(), 0);
    drop(checkpoint);
    let mut reopened = Store::open(directory.path()).unwrap();
    assert_eq!(
        reopened.snapshot(50, Utc::now()).unwrap().sessions[0].event_count,
        17
    );
}

#[test]
fn normal_automatic_checkpoints_recycle_retained_wal_after_many_commits() {
    let directory = tempfile::tempdir().unwrap();
    let mut writer = Store::open(directory.path()).unwrap();
    let wal = directory.path().join("events.sqlite3-wal");
    let mut previous = 0;
    let mut maximum = 0;
    let mut recycled = false;
    // Cross the unchanged 1000-page automatic checkpoint threshold. Only
    // metadata is inspected: no sidecar descriptor may disturb SQLite locks.
    for _ in 0..1100 {
        writer.ingest(&event(), Utc::now()).unwrap();
        let bytes = fs::metadata(&wal).unwrap().len();
        recycled |= bytes < previous;
        maximum = maximum.max(bytes);
        previous = bytes;
    }
    eprintln!("WAL recycling: max_bytes={maximum}, final_bytes={previous}");
    assert!(
        maximum > 1024 * 1024,
        "fixture never reached the journal-size limit"
    );
    assert!(
        recycled,
        "normal commit checkpoints failed to recycle retained WAL"
    );
    assert_eq!(
        writer.snapshot(50, Utc::now()).unwrap().sessions[0].event_count,
        1100
    );
}

#[test]
fn parent_traversal_after_missing_prefix_is_rejected_before_creation() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("state");
    fs::create_dir(&target).unwrap();
    let db = target.join("events.sqlite3");
    fs::write(&db, b"untouched existing state").unwrap();
    let route = dir.path().join("not-created/../state");
    assert!(matches!(
        Store::open(&route),
        Err(lazysh_agent::Error::InvalidArgument)
    ));
    assert!(!dir.path().join("not-created").exists());
    assert_eq!(fs::read(db).unwrap(), b"untouched existing state");
    assert_eq!(fs::read_dir(target).unwrap().count(), 1);
}

#[test]
fn migration_preserves_existing_rows_and_verifies_full_wal_on_every_open() {
    let dir = tempfile::tempdir().unwrap();
    // A real rollback-mode database with the previous Store schema and data.
    let db = dir.path().join("events.sqlite3");
    let connection = Connection::open(&db).unwrap();
    connection
        .execute_batch("PRAGMA journal_mode=DELETE;")
        .unwrap();
    connection
        .execute_batch(storage_schema::V1_SESSIONS)
        .unwrap();
    connection.execute("INSERT INTO sessions VALUES ('Fixture','recovery','/fixture','working','Synthetic',NULL,?1,7)", [Utc::now().timestamp()]).unwrap();
    drop(connection);
    let mut store = Store::open(dir.path()).unwrap();
    assert_eq!(
        store.snapshot(50, Utc::now()).unwrap().sessions[0].event_count,
        7
    );
    store.ingest(&event(), Utc::now()).unwrap();
    drop(store);
    let mut store = Store::open(dir.path()).unwrap();
    assert_eq!(
        store.snapshot(50, Utc::now()).unwrap().sessions[0].event_count,
        8
    );
    let connection = Connection::open(db).unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    // Synchronous is per connection, so the production connection is checked
    // separately by its native unit test rather than inferred from this handle.
}

#[test]
fn legacy_read_only_transaction_blocks_migration_explicitly_without_losing_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite3");
    let old = Connection::open(&path).unwrap();
    old.execute_batch(
        "PRAGMA journal_mode=DELETE; CREATE TABLE marker (value); INSERT INTO marker VALUES (42);",
    )
    .unwrap();
    drop(old);
    let reader =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM marker;")
        .unwrap();
    let result = Store::open(dir.path());
    assert!(
        matches!(result, Err(lazysh_agent::Error::Storage(rusqlite::Error::SqliteFailure(code, _))) if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
    );
    assert_eq!(
        reader
            .query_row("SELECT value FROM marker", [], |row| row.get::<_, i32>(0))
            .unwrap(),
        42
    );
    reader.execute_batch("ROLLBACK").unwrap();
    drop(reader);
    // A new explicit open after the blocking reader is released, not an
    // internal retry or silent rollback-journal fallback.
    drop(Store::open(dir.path()).unwrap());
    let check = Connection::open(path).unwrap();
    assert_eq!(
        check
            .query_row("SELECT value FROM marker", [], |row| row.get::<_, i32>(0))
            .unwrap(),
        42
    );
    assert_eq!(
        check
            .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn killed_writer_recovers_committed_wal_and_discards_uncommitted_tail() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "crash_writer_child", "--nocapture"])
            .env("LAZYSH_WAL_CRASH_FIXTURE", dir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line.unwrap() == "WAL_FIXTURE_READY" {
                send.send(()).unwrap();
                return;
            }
        }
    });
    let ready = receive.recv_timeout(Duration::from_secs(5));
    if ready.is_err() {
        let _ = child.0.kill();
    }
    reader.join().unwrap();
    ready.expect("owned crash writer did not reach committed+uncommitted state");
    assert!(
        fs::metadata(dir.path().join("events.sqlite3-wal"))
            .unwrap()
            .len()
            > 32
    );
    child.0.kill().unwrap();
    assert!(!child.0.wait().unwrap().success());
    let mut recovered = Store::open(dir.path()).unwrap();
    let snapshot = recovered.snapshot(50, Utc::now()).unwrap();
    assert_eq!(snapshot.sessions.len(), 1);
    assert_eq!(snapshot.sessions[0].event_count, 1);
    let db = Connection::open(dir.path().join("events.sqlite3")).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='spill'",
            [],
            |r| r.get::<_, i32>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
#[ignore = "owned subprocess fixture selected only by the crash/recovery test"]
fn crash_writer_child() {
    let Some(directory) = std::env::var_os("LAZYSH_WAL_CRASH_FIXTURE") else {
        return;
    };
    let mut store = Store::open(std::path::Path::new(&directory)).unwrap();
    store.ingest(&event(), Utc::now()).unwrap();
    let wal = std::path::Path::new(&directory).join("events.sqlite3-wal");
    let committed_bytes = fs::metadata(&wal).unwrap().len();
    let pending =
        Connection::open(std::path::Path::new(&directory).join("events.sqlite3")).unwrap();
    pending
        .execute_batch(
            "PRAGMA cache_size=1; PRAGMA cache_spill=1;
            BEGIN IMMEDIATE; UPDATE sessions SET event_count=1000;
            CREATE TABLE spill (data BLOB); INSERT INTO spill VALUES (zeroblob(131072));",
        )
        .unwrap();
    assert!(
        fs::metadata(wal).unwrap().len() > committed_bytes,
        "fixture must spill uncommitted WAL frames before termination"
    );
    println!("WAL_FIXTURE_READY");
    std::io::stdout().flush().unwrap();
    // Parent kills this owned process while both SQLite connections remain live.
    let _ = std::io::stdin().read_exact(&mut [0]);
    panic!("parent must terminate the live writer");
}

#[cfg(unix)]
#[test]
fn live_sidecars_are_private_and_unsafe_sidecars_leave_targets_untouched() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store.ingest(&event(), Utc::now()).unwrap();
    for name in [
        "events.sqlite3",
        "events.sqlite3-wal",
        "events.sqlite3-shm",
        "events.sqlite3-init-lock",
    ] {
        assert_eq!(
            fs::metadata(dir.path().join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    drop(store);
    for suffix in ["-journal", "-wal", "-shm", "-init-lock"] {
        let state = tempfile::tempdir().unwrap();
        let victim = state.path().join("victim");
        fs::write(&victim, b"untouched").unwrap();
        fs::set_permissions(&victim, fs::Permissions::from_mode(0o640)).unwrap();
        let sidecar = state.path().join(format!("events.sqlite3{suffix}"));
        symlink(&victim, &sidecar).unwrap();
        assert!(Store::open(state.path()).is_err());
        fs::remove_file(&sidecar).unwrap();
        fs::hard_link(&victim, &sidecar).unwrap();
        assert!(Store::open(state.path()).is_err());
        fs::remove_file(&sidecar).unwrap();
        fs::write(&sidecar, []).unwrap();
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(Store::open(state.path()).is_err());
        assert_eq!(fs::read(&victim).unwrap(), b"untouched");
        assert_eq!(
            fs::metadata(victim).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}

#[cfg(unix)]
#[test]
fn writable_ancestor_is_rejected_before_any_state_chmod_or_database_open() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let unsafe_parent = dir.path().join("shared");
    let leaf = unsafe_parent.join("state");
    fs::create_dir_all(&leaf).unwrap();
    fs::set_permissions(&unsafe_parent, fs::Permissions::from_mode(0o777)).unwrap();
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o750)).unwrap();
    assert!(Store::open(&leaf).is_err());
    assert_eq!(
        fs::metadata(&leaf).unwrap().permissions().mode() & 0o777,
        0o750
    );
    assert_eq!(fs::read_dir(leaf).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn chained_custom_link_route_is_rejected_without_mutating_its_target() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let safe = dir.path().join("safe");
    let shared = dir.path().join("shared");
    let owned = dir.path().join("owned");
    for path in [&safe, &shared, &owned] {
        fs::create_dir(path).unwrap();
    }
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
    fs::set_permissions(&owned, fs::Permissions::from_mode(0o750)).unwrap();
    let db = owned.join("events.sqlite3");
    fs::write(&db, b"untouched owned state").unwrap();
    fs::set_permissions(&db, fs::Permissions::from_mode(0o640)).unwrap();
    symlink(&owned, shared.join("hop")).unwrap();
    symlink(shared.join("hop"), safe.join("link")).unwrap();
    assert!(Store::open(&safe.join("link")).is_err());
    assert!(Store::open(&safe.join("link/missing-child/state")).is_err());
    assert!(!owned.join("missing-child").exists());
    assert_eq!(fs::read(&db).unwrap(), b"untouched owned state");
    assert_eq!(
        fs::metadata(&db).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert_eq!(
        fs::metadata(&owned).unwrap().permissions().mode() & 0o777,
        0o750
    );
    assert_eq!(fs::read_dir(owned).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn windows_junction_route_is_rejected_before_target_mutation() {
    use std::os::windows::{fs::MetadataExt, process::CommandExt};
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let junction = dir.path().join("junction");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("marker"), b"untouched owned target").unwrap();
    // mklink is a native Windows built-in, invoked only for this owned Cargo
    // fixture. Quote each path and reject cmd expansion/metacharacters; no
    // generated shell script or untrusted argument is executed.
    let target_text = target.to_str().expect("fixture path must be Unicode");
    let junction_text = junction.to_str().expect("fixture path must be Unicode");
    for text in [target_text, junction_text] {
        assert!(
            !text.chars().any(|c| "\"\r\n%!&|<>^".contains(c)),
            "unsafe native fixture command path"
        );
    }
    let output = Command::new("cmd.exe")
        .args(["/d", "/v:off", "/s", "/c"])
        .raw_arg(format!("mklink /J \"{junction_text}\" \"{target_text}\""))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native junction creation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_ne!(
        fs::symlink_metadata(&junction).unwrap().file_attributes() & 0x400,
        0
    );
    assert!(Store::open(&junction.join("missing-state")).is_err());
    assert!(!target.join("missing-state").exists());
    assert_eq!(
        fs::read(target.join("marker")).unwrap(),
        b"untouched owned target"
    );
    assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    // Remove only the owned junction, never recursively remove its target.
    fs::remove_dir(junction).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn verified_darwin_system_temp_aliases_remain_supported() {
    for root in ["/tmp", "/var/tmp"] {
        let directory = tempfile::tempdir_in(root).unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        store.ingest(&event(), Utc::now()).unwrap();
        assert_eq!(
            store.snapshot(50, Utc::now()).unwrap().sessions[0].event_count,
            1
        );
    }
}

#[test]
fn native_bootstrap_and_sqlite_share_one_wait_deadline() {
    use std::time::Instant;
    let dir = tempfile::tempdir().unwrap();
    let blocker = Connection::open(dir.path().join("events.sqlite3")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            dir.path().join("events.sqlite3"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    blocker
        .execute_batch("BEGIN EXCLUSIVE; CREATE TABLE fixture (value);")
        .unwrap();
    let lock_path = dir.path().join("events.sqlite3-init-lock");
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let bootstrap = options.open(lock_path).unwrap();
    bootstrap.lock().unwrap();
    let directory = dir.path().to_owned();
    let (started_send, started_receive) = mpsc::channel();
    let (send, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let started = Instant::now();
        started_send.send(()).unwrap();
        let result = Store::open(&directory);
        send.send((started.elapsed(), result)).unwrap();
    });
    started_receive.recv().unwrap();
    // Consume the first part of the SAME budget at the native lock, then
    // release it while the SQLite exclusive lock is deliberately still held.
    assert!(matches!(
        receive.recv_timeout(Duration::from_secs(1)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(bootstrap);
    let result = receive.recv_timeout(Duration::from_millis(2600));
    blocker.execute_batch("ROLLBACK").unwrap();
    worker.join().unwrap();
    let (elapsed, result) = result.expect("bootstrap added a second SQLite wait budget");
    assert!(
        elapsed >= Duration::from_millis(2800) && elapsed < Duration::from_millis(3600),
        "elapsed={elapsed:?}"
    );
    assert!(
        matches!(result, Err(lazysh_agent::Error::Storage(rusqlite::Error::SqliteFailure(code, _))) if code.code == rusqlite::ErrorCode::DatabaseBusy)
    );
    // Both timeout and SQLite error paths must release the native bootstrap lock.
    drop(Store::open(dir.path()).unwrap());
}
