use chrono::{DateTime, SecondsFormat, Utc};
pub mod approvals;
pub mod devices;
pub mod settings;
mod storage_filesystem;
mod storage_namespace;
pub mod transcript;
pub mod usage;
use clap::ValueEnum;
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

thread_local! {
    static STORAGE_WAIT_STARTED: Cell<Option<Instant>> = const { Cell::new(None) };
}

fn wait_for_storage(attempt: i32) -> bool {
    STORAGE_WAIT_STARTED.with(|started| {
        let now = Instant::now();
        let start = if attempt == 0 {
            now
        } else {
            started.get().unwrap_or(now)
        };
        started.set(Some(start));
        wait_for_storage_until(start + Duration::from_secs(3))
    })
}

fn wait_for_storage_until(deadline: Instant) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    // SQLite's default timeout backs off to 100 ms. Concurrent short hook
    // writes can then wake in lockstep, leaving it idle between waves.
    // Poll briefly under the same wall-clock budget, without weakening syncs.
    std::thread::sleep(remaining.min(Duration::from_millis(5)));
    true
}

pub const MAX_INPUT: usize = 256 * 1024;
const RETENTION_SECONDS: f64 = 7.0 * 86400.0;
const HOOK_EVENTS: [&str; 8] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
    "Notification",
];

#[derive(Debug)]
pub enum Error {
    InvalidEvent,
    InvalidArgument,
    UnsupportedStateFilesystem,
    Device(&'static str),
    Settings(&'static str),
    Io(io::Error),
    Storage(rusqlite::Error),
}
impl Error {
    pub fn class(&self) -> &'static str {
        match self {
            Self::InvalidEvent => "InvalidEvent",
            Self::InvalidArgument => "InvalidArgument",
            Self::UnsupportedStateFilesystem => "UnsupportedStateFilesystem",
            Self::Device(kind) => kind,
            Self::Settings(kind) => kind,
            Self::Io(_) => "IoError",
            Self::Storage(_) => "StorageError",
        }
    }
}
lazysh_common::impl_from_error!(Error, Io, io::Error);
lazysh_common::impl_from_error!(Error, Storage, rusqlite::Error);
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, ValueEnum)]
pub enum Agent {
    Claude,
    Generic,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Working,
    NeedsAttention,
    Done,
}
impl SessionState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::NeedsAttention => "needs_attention",
            Self::Done => "done",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub session_id: String,
    pub agent: String,
    pub project: String,
    pub state: SessionState,
    pub summary: String,
    pub pane_id: Option<String>,
}
impl Event {
    fn validate(&self) -> Result<()> {
        text(&self.session_id, 256)?;
        text(&self.agent, 80)?;
        text(&self.project, 4096)?;
        text(&self.summary, 512)?;
        if let Some(pane) = &self.pane_id {
            text(pane, 256)?;
        }
        Ok(())
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[serde(flatten)]
    pub event: Event,
    pub updated_at: String,
    pub event_count: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u8,
    pub sessions: Vec<SessionSummary>,
}

fn text(value: &str, maximum: usize) -> Result<()> {
    if value.trim().is_empty()
        || value.chars().count() > maximum
        || value.chars().any(|c| c < '\u{20}')
    {
        return Err(Error::InvalidEvent);
    }
    Ok(())
}
fn field(payload: &Value, name: &str, maximum: usize) -> Result<String> {
    let value = payload
        .get(name)
        .and_then(Value::as_str)
        .ok_or(Error::InvalidEvent)?;
    text(value, maximum)?;
    Ok(value.to_owned())
}
pub(crate) fn read_bounded_json(mut input: impl Read, maximum: usize) -> Result<Value> {
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(Error::InvalidEvent);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::InvalidEvent)
}
pub fn read_event(input: impl Read, agent: Agent, pane: Option<&str>) -> Result<Option<Event>> {
    let payload = read_bounded_json(input, MAX_INPUT)?;
    normalize(&payload, agent, pane)
}
pub fn normalize(payload: &Value, agent: Agent, pane: Option<&str>) -> Result<Option<Event>> {
    if !payload.is_object() {
        return Err(Error::InvalidEvent);
    }
    let event = match agent {
        Agent::Generic => {
            if payload.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
                return Err(Error::InvalidEvent);
            }
            serde_json::from_value::<Event>(payload.clone()).map_err(|_| Error::InvalidEvent)?
        }
        Agent::Claude => {
            let kind = payload
                .get("hook_event_name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let (state, default_summary) = match kind {
                "UserPromptSubmit" => (SessionState::Working, "Working on your prompt"),
                "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => {
                    (SessionState::Working, kind)
                }
                "PermissionRequest" => (SessionState::NeedsAttention, "Permission requested"),
                "Stop" => (SessionState::Done, "Turn finished"),
                "SessionEnd" => (SessionState::Done, "Session ended"),
                "Notification"
                    if matches!(
                        payload.get("notification_type").and_then(Value::as_str),
                        Some("permission_prompt" | "idle_prompt" | "elicitation_dialog")
                    ) =>
                {
                    (SessionState::NeedsAttention, "Agent needs attention")
                }
                _ => return Ok(None),
            };
            let summary = match payload.get("tool_name") {
                None | Some(Value::Null) => default_summary,
                Some(Value::String(value)) if value.is_empty() => default_summary,
                Some(Value::String(value)) => value,
                _ => return Err(Error::InvalidEvent),
            };
            Event {
                session_id: field(payload, "session_id", 256)?,
                agent: "Claude Code".into(),
                project: field(payload, "cwd", 4096)?,
                state,
                summary: summary.into(),
                pane_id: pane.map(str::to_owned),
            }
        }
    };
    event.validate()?;
    Ok(Some(event))
}

pub fn state_directory() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("LAZYSH_STATE_DIR") {
        return Ok(path.into());
    }
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .map(|path| path.join("lazysh"))
        .ok_or_else(|| {
            Error::Io(io::Error::new(
                io::ErrorKind::NotFound,
                "No user state directory",
            ))
        })
}

mod storage_schema;

pub struct Store {
    connection: Connection,
}

fn regular_state_metadata(path: &Path, message: &'static str) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if storage_namespace::is_link(&metadata) || !metadata.is_file() => {
            Err(io::Error::new(io::ErrorKind::InvalidInput, message))
        }
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
fn validate_state_file(path: &Path) -> Result<()> {
    let Some(metadata) = regular_state_metadata(path, "State must be a regular file")? else {
        return Ok(());
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "State must not have hard links",
            )));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn validate_sidecar(path: &Path) -> Result<()> {
    validate_sidecar_with(path, || {
        regular_state_metadata(path, "Invalid state sidecar")
    })
}
fn validate_sidecar_with(
    path: &Path,
    mut observe: impl FnMut() -> io::Result<Option<fs::Metadata>>,
) -> Result<()> {
    #[cfg(unix)]
    {
        let kind = match path.file_name().and_then(|name| name.to_str()) {
            Some("events.sqlite3-journal") => "journal",
            Some("events.sqlite3-wal") => "wal",
            Some("events.sqlite3-shm") => "shm",
            Some("events.sqlite3-init-lock") => "bootstrap-lock",
            _ => "other",
        };
        let mut retries = 0;
        loop {
            let Some(metadata) = observe()? else {
                return Ok(());
            };
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                let links = metadata.nlink();
                let owned = metadata.uid() == unsafe { libc::geteuid() };
                let mode = metadata.permissions().mode() & 0o777;
                // SQLite may unlink its ephemeral sidecar during stat. Never accept
                // that removed inode: re-stat the path, validating any replacement.
                if links == 0
                    && owned
                    && mode == 0o600
                    && matches!(kind, "journal" | "wal" | "shm")
                    && retries < 2
                {
                    retries += 1;
                    continue;
                }
                if links != 1 || !owned || mode != 0o600 {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!("Unsafe state sidecar (kind={kind}, links={links}, owned={owned}, mode={mode:03o})"),
                    ).into());
                }
            }
            return Ok(());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        observe().map(|_| ()).map_err(Error::from)
    }
}

fn lock_store_bootstrap(directory: &Path, deadline: Instant) -> Result<fs::File> {
    let path = directory.join("events.sqlite3-init-lock");
    validate_sidecar(&path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let lock = options.open(&path)?;
    validate_sidecar(&path)?;
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(lock),
            Err(fs::TryLockError::WouldBlock) if wait_for_storage_until(deadline) => {}
            Err(fs::TryLockError::WouldBlock) => {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                    None,
                )
                .into())
            }
            Err(fs::TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        Self::open_with_admission(directory, storage_filesystem::require_local)
    }
    // Private native-test seam: rejection must precede every state mutation.
    fn open_with_admission(directory: &Path, admit: fn(&Path) -> io::Result<()>) -> Result<Self> {
        Self::open_with_storage_checks(directory, admit, validate_sidecar)
    }
    fn open_with_storage_checks(
        directory: &Path,
        admit: fn(&Path) -> io::Result<()>,
        mut check_sidecar: impl FnMut(&Path) -> Result<()>,
    ) -> Result<Self> {
        fn path_error(error: io::Error) -> Error {
            if error.kind() == io::ErrorKind::Unsupported {
                Error::UnsupportedStateFilesystem
            } else if error.kind() == io::ErrorKind::InvalidInput {
                Error::InvalidArgument
            } else {
                Error::Io(error)
            }
        }
        let directory = storage_namespace::resolve(directory).map_err(path_error)?;
        admit(&directory).map_err(path_error)?;
        storage_namespace::create(&directory)?;
        let path = directory.join("events.sqlite3");
        // Never open/close the database outside SQLite: on POSIX, closing any
        // descriptor for this inode releases this process's SQLite locks.
        // The private directory protects newly created files until chmod, and
        // SQLite itself refuses leaf symlinks with SQLITE_OPEN_NOFOLLOW.
        validate_state_file(&path)?;
        // One deadline covers native bootstrap coordination, sidecar admission
        // and SQLite's schema/mode waits rather than adding another wait budget.
        let bootstrap_deadline = Instant::now() + Duration::from_secs(3);
        let _bootstrap = lock_store_bootstrap(&directory, bootstrap_deadline)?;
        // Inspect ephemeral paths inside the same lock as initialization: another
        // initializer must not unlink its rollback journal during these checks.
        // SQLite owns sidecar descriptors; never open/close them here because
        // POSIX locks belong to the process/inode.
        for suffix in ["-journal", "-wal", "-shm"] {
            check_sidecar(&directory.join(format!("events.sqlite3{suffix}")))?;
        }
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        validate_state_file(&path)?;
        connection.busy_handler(Some(move |_| wait_for_storage_until(bootstrap_deadline)))?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        let mode: String = connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
        if mode != "wal" {
            return Err(io::Error::other("WAL unavailable for companion state").into());
        }
        connection.execute_batch("PRAGMA journal_size_limit=1048576;")?;
        connection.execute_batch(storage_schema::V1_SESSIONS)?;
        connection.busy_handler(Some(wait_for_storage))?;
        Ok(Self { connection })
    }
    pub fn ingest(&mut self, event: &Event, now: DateTime<Utc>) -> Result<()> {
        event.validate()?;
        let now = now.timestamp_micros() as f64 / 1_000_000.0;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("INSERT INTO sessions VALUES (?1,?2,?3,?4,?5,?6,?7,1)
            ON CONFLICT(agent,session_id) DO UPDATE SET project=excluded.project,state=excluded.state,
            summary=excluded.summary,pane_id=excluded.pane_id,updated_at=excluded.updated_at,event_count=sessions.event_count+1",
            params![event.agent,event.session_id,event.project,event.state.as_str(),event.summary,event.pane_id,now])?;
        transaction.execute(
            "DELETE FROM sessions WHERE updated_at < ?1",
            [now - RETENTION_SECONDS],
        )?;
        transaction.execute("DELETE FROM sessions WHERE rowid NOT IN (SELECT rowid FROM sessions ORDER BY updated_at DESC,rowid DESC LIMIT 100)",[])?;
        transaction.commit()?;
        Ok(())
    }
    pub fn snapshot(&mut self, limit: u8, now: DateTime<Utc>) -> Result<Snapshot> {
        if !(1..=100).contains(&limit) {
            return Err(Error::InvalidArgument);
        }
        self.connection.execute(
            "DELETE FROM sessions WHERE updated_at < ?1",
            [now.timestamp_micros() as f64 / 1_000_000.0 - RETENTION_SECONDS],
        )?;
        let mut statement=self.connection.prepare("SELECT session_id,agent,project,state,summary,pane_id,updated_at,event_count FROM sessions ORDER BY updated_at DESC,rowid DESC LIMIT ?1")?;
        let mut rows = statement.query([limit])?;
        let mut sessions = Vec::new();
        while let Some(row) = rows.next()? {
            let state: String = row.get(3)?;
            let state = match state.as_str() {
                "working" => SessionState::Working,
                "needs_attention" => SessionState::NeedsAttention,
                "done" => SessionState::Done,
                _ => return Err(Error::InvalidEvent),
            };
            let updated_at: f64 = row.get(6)?;
            let updated_at =
                DateTime::from_timestamp_micros((updated_at * 1_000_000.0).round() as i64)
                    .ok_or(Error::InvalidEvent)?
                    .to_rfc3339_opts(SecondsFormat::Micros, true);
            sessions.push(SessionSummary {
                event: Event {
                    session_id: row.get(0)?,
                    agent: row.get(1)?,
                    project: row.get(2)?,
                    state,
                    summary: row.get(4)?,
                    pane_id: row.get(5)?,
                },
                updated_at,
                event_count: u64::try_from(row.get::<_, i64>(7)?)
                    .map_err(|_| Error::InvalidEvent)?,
            });
        }
        Ok(Snapshot {
            schema_version: 1,
            sessions,
        })
    }
}
pub fn claude_config() -> Value {
    let mut hooks = serde_json::Map::new();
    for kind in HOOK_EVENTS {
        hooks.insert(kind.into(),json!([{"hooks":[{"type":"command","command":"lazysh-agent ingest --agent claude","timeout":5}]}]));
    }
    json!({"hooks":hooks})
}

#[cfg(all(test, unix))]
#[path = "../tests/support/permissions.rs"]
mod test_permissions;
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn sidecar_diagnostics_use_fixed_kinds_and_security_metadata_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        for (name, kind) in [
            ("events.sqlite3-journal", "journal"),
            ("events.sqlite3-wal", "wal"),
            ("events.sqlite3-shm", "shm"),
            ("events.sqlite3-init-lock", "bootstrap-lock"),
            ("do-not-report-this-private-name", "other"),
        ] {
            let path = dir.path().join(name);
            fs::write(&path, b"do not report file contents").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            let Error::Io(error) = validate_sidecar(&path).unwrap_err() else {
                panic!("unsafe permissions must remain an I/O validation error");
            };
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert_eq!(
                error.to_string(),
                format!("Unsafe state sidecar (kind={kind}, links=1, owned=true, mode=644)")
            );
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            validate_sidecar(&path).unwrap();
        }
    }
    #[cfg(unix)]
    fn unlinked_sidecar(mode: u32) -> (tempfile::TempDir, std::path::PathBuf, fs::Metadata) {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.sqlite3-shm");
        // Only a synthetic ordinary file: no SQLite connection or sidecar descriptor.
        let file = fs::File::create(&path).unwrap();
        file.set_permissions(fs::Permissions::from_mode(mode))
            .unwrap();
        fs::remove_file(&path).unwrap();
        let removed = file.metadata().unwrap();
        assert_eq!(removed.nlink(), 0);
        (dir, path, removed)
    }
    #[cfg(unix)]
    #[test]
    fn unlinked_sidecar_metadata_rechecks_absence_or_a_private_replacement() {
        use std::os::unix::fs::PermissionsExt;
        for replace in [false, true] {
            let (_dir, path, removed) = unlinked_sidecar(0o600);
            if replace {
                fs::write(&path, b"synthetic replacement").unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            }
            let mut observations = 0;
            validate_sidecar_with(&path, || {
                observations += 1;
                if observations == 1 {
                    Ok(Some(removed.clone()))
                } else {
                    regular_state_metadata(&path, "Invalid state sidecar")
                }
            })
            .unwrap();
            assert_eq!(observations, 2);
        }
    }
    #[cfg(unix)]
    #[test]
    fn ephemeral_sidecar_admission_holds_the_native_bootstrap_lock() {
        let (directory, _path, removed) = unlinked_sidecar(0o600);
        // Create only the real private bootstrap lock, not a SQLite sidecar FD.
        drop(
            lock_store_bootstrap(directory.path(), Instant::now() + Duration::from_secs(3))
                .unwrap(),
        );
        let lock_path = directory.path().join("events.sqlite3-init-lock");
        let mut protected_checks = 0;
        let mut unprotected_observations = 0;
        let store = Store::open_with_storage_checks(
            directory.path(),
            storage_filesystem::require_local,
            |sidecar| {
                let independent = fs::File::open(&lock_path)?;
                match independent.try_lock() {
                    Ok(()) => {
                        // Model an initializer unlinking its journal during each
                        // unprotected stat, using actual owned 0600 zero-link metadata.
                        validate_sidecar_with(sidecar, || {
                            unprotected_observations += 1;
                            Ok(Some(removed.clone()))
                        })
                    }
                    Err(fs::TryLockError::WouldBlock) => {
                        protected_checks += 1;
                        validate_sidecar(sidecar)
                    }
                    Err(fs::TryLockError::Error(error)) => Err(error.into()),
                }
            },
        )
        .unwrap_or_else(|error| panic!("ephemeral admission raced bootstrap: {error:?}"));
        assert_eq!(protected_checks, 3);
        assert_eq!(unprotected_observations, 0);
        // Admission and successful open must release the native lock again.
        fs::File::open(lock_path).unwrap().try_lock().unwrap();
        drop(store);
    }
    #[cfg(unix)]
    #[test]
    fn sidecar_revalidation_rejects_unsafe_replacements_and_stops_after_three_observations() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for replacement in ["hardlink", "symlink", "mode", "directory"] {
            let (dir, path, removed) = unlinked_sidecar(0o600);
            let target = dir.path().join("target");
            fs::write(&target, b"synthetic target").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
            match replacement {
                "hardlink" => fs::hard_link(&target, &path).unwrap(),
                "symlink" => symlink(&target, &path).unwrap(),
                "mode" => {
                    fs::rename(&target, &path).unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
                }
                "directory" => fs::create_dir(&path).unwrap(),
                _ => unreachable!(),
            }
            let mut observations = 0;
            assert!(
                validate_sidecar_with(&path, || {
                    observations += 1;
                    if observations == 1 {
                        Ok(Some(removed.clone()))
                    } else {
                        regular_state_metadata(&path, "Invalid state sidecar")
                    }
                })
                .is_err(),
                "{replacement}"
            );
            assert_eq!(observations, 2, "{replacement}");
        }
        let (_public_dir, public_path, public_removed) = unlinked_sidecar(0o644);
        let mut observations = 0;
        assert!(validate_sidecar_with(&public_path, || {
            observations += 1;
            Ok(Some(public_removed.clone()))
        })
        .is_err());
        assert_eq!(
            observations, 1,
            "unsafe removed metadata must not be retried"
        );
        let (_dir, path, removed) = unlinked_sidecar(0o600);
        for (name, expected) in [
            ("events.sqlite3-shm", 3),
            ("events.sqlite3-wal", 3),
            ("events.sqlite3-journal", 3),
            ("events.sqlite3-init-lock", 1),
            ("other", 1),
        ] {
            let mut observations = 0;
            let error = validate_sidecar_with(&path.with_file_name(name), || {
                observations += 1;
                Ok(Some(removed.clone()))
            })
            .unwrap_err();
            assert_eq!(observations, expected, "{name}");
            assert!(
                matches!(error, Error::Io(ref e) if e.kind() == io::ErrorKind::PermissionDenied)
            );
        }
    }
    #[cfg(windows)]
    #[test]
    fn drive_relative_state_fails_before_admission_or_creation() {
        fn must_not_admit(_: &Path) -> io::Result<()> {
            panic!("drive-relative path reached filesystem admission");
        }
        // The seam ensures a regression cannot create anything in a drive's
        // unrelated per-drive cwd: admission would panic before all mutation.
        for path in ["C:junction/missing-state", "D:junction/missing-state", "C:"] {
            assert!(matches!(
                Store::open_with_admission(Path::new(path), must_not_admit),
                Err(Error::InvalidArgument)
            ));
        }
    }
    #[cfg(unix)]
    #[test]
    fn a_missing_component_replaced_after_admission_is_not_followed_or_mutated() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        fn replace_component(directory: &Path) -> io::Result<()> {
            let root = directory.parent().unwrap().parent().unwrap();
            symlink(root.join("victim"), root.join("missing"))
        }
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim");
        fs::create_dir(&victim).unwrap();
        fs::set_permissions(&victim, fs::Permissions::from_mode(0o750)).unwrap();
        let db = victim.join("events.sqlite3");
        fs::write(&db, b"untouched victim").unwrap();
        assert!(
            Store::open_with_admission(&dir.path().join("missing/state"), replace_component)
                .is_err()
        );
        assert!(!victim.join("state").exists());
        assert_eq!(
            fs::metadata(&victim).unwrap().permissions().mode() & 0o777,
            0o750
        );
        assert_eq!(fs::read(db).unwrap(), b"untouched victim");
        assert_eq!(fs::read_dir(victim).unwrap().count(), 1);
    }
    #[test]
    fn filesystem_rejection_precedes_creation_chmod_bootstrap_and_sqlite() {
        fn reject(_: &Path) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "fixture unsupported filesystem",
            ))
        }
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("not-created/state");
        assert!(matches!(
            Store::open_with_admission(&missing, reject),
            Err(Error::UnsupportedStateFilesystem)
        ));
        assert!(!dir.path().join("not-created").exists());
        let db = dir.path().join("events.sqlite3");
        fs::write(&db, b"untouched synthetic legacy bytes").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o750)).unwrap();
            fs::set_permissions(&db, fs::Permissions::from_mode(0o640)).unwrap();
        }
        assert!(Store::open_with_admission(dir.path(), reject).is_err());
        assert_eq!(fs::read(&db).unwrap(), b"untouched synthetic legacy bytes");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        crate::test_permissions::assert_state_modes(dir.path(), 0o750, 0o640);
    }
    #[test]
    fn every_store_connection_has_full_synchronization_in_wal_mode() {
        let dir = tempfile::tempdir().unwrap();
        let first = Store::open(dir.path()).unwrap();
        let second = Store::open(dir.path()).unwrap();
        for store in [first, second] {
            assert_eq!(
                store
                    .connection
                    .query_row("PRAGMA synchronous", [], |r| r.get::<_, i32>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                store
                    .connection
                    .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "wal"
            );
        }
    }
    #[test]
    fn retention_runs_on_ingest_and_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let now = Utc::now();
        for i in 0..120 {
            store
                .ingest(
                    &Event {
                        session_id: i.to_string(),
                        agent: "Test".into(),
                        project: "/work".into(),
                        state: SessionState::Done,
                        summary: "Done".into(),
                        pane_id: None,
                    },
                    now + chrono::TimeDelta::microseconds(i),
                )
                .unwrap();
        }
        let snapshot = store.snapshot(100, now).unwrap();
        assert_eq!(snapshot.sessions.len(), 100);
        assert_eq!(snapshot.sessions[0].event.session_id, "119");
        assert_eq!(store.snapshot(2, now).unwrap().sessions.len(), 2);
        assert!(store
            .snapshot(100, now + chrono::TimeDelta::days(8))
            .unwrap()
            .sessions
            .is_empty());
    }
    #[test]
    fn bounds_and_schema_reject_invalid_inputs() {
        for schema in [json!(true), json!(1.0), json!("1"), json!(2)] {
            assert!(normalize(&json!({"schemaVersion":schema,"sessionId":"s","agent":"Test","project":"/work","state":"done","summary":"Done"}),Agent::Generic,None).is_err());
        }
        assert!(read_event(
            io::repeat(b'x').take(MAX_INPUT as u64 + 1),
            Agent::Generic,
            None
        )
        .is_err());
    }
}

#[cfg(test)]
mod storage_diagnostics;
