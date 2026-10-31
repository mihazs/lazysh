use chrono::{DateTime, SecondsFormat, Utc};
pub mod account_usage;
pub mod approvals;
pub mod devices;
pub mod herdr;
pub mod hook_setup;
pub mod hooks;
pub mod installation;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod managed_directory;
pub mod relay;
pub mod reported_history;
pub mod settings;
pub mod skills;
mod storage_filesystem;
mod storage_namespace;
pub mod transcript;
pub mod usage;
use clap::ValueEnum;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
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
    Installation(&'static str),
    UnsupportedStateFilesystem,
    Device(&'static str),
    Herdr(&'static str),
    Settings(&'static str),
    Relay(&'static str),
    Io(io::Error),
    Storage(rusqlite::Error),
}
impl Error {
    pub fn class(&self) -> &'static str {
        match self {
            Self::InvalidEvent => "InvalidEvent",
            Self::InvalidArgument => "InvalidArgument",
            Self::Installation(kind) => kind,
            Self::UnsupportedStateFilesystem => "UnsupportedStateFilesystem",
            Self::Device(kind) | Self::Herdr(kind) => kind,
            Self::Settings(kind) => kind,
            Self::Relay(kind) => kind,
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
    Codex,
    Opencode,
    Gemini,
    Droid,
    Kimi,
    Copilot,
    Cursor,
    Amp,
    Cline,
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
        Agent::Opencode | Agent::Cursor | Agent::Amp | Agent::Cline => match match agent {
            Agent::Opencode => hooks::opencode_event(payload, pane),
            Agent::Cursor => hooks::cursor_event(payload, pane),
            Agent::Amp => hooks::amp_event(payload, pane),
            Agent::Cline => hooks::cline_event(payload, pane),
            _ => unreachable!(),
        }? {
            Some(event) => event,
            None => return Ok(None),
        },
        Agent::Claude
        | Agent::Codex
        | Agent::Gemini
        | Agent::Droid
        | Agent::Kimi
        | Agent::Copilot => {
            let kind = payload
                .get("hook_event_name")
                .and_then(Value::as_str)
                .unwrap_or("");
            if matches!(agent, Agent::Copilot)
                && matches!(kind, "Stop" | "SessionEnd")
                && payload
                    .get("agent_id")
                    .is_some_and(|value| !value.is_null())
            {
                return Ok(None);
            }
            let (state, default_summary) = match kind {
                "UserPromptSubmit" if !matches!(agent, Agent::Gemini) => {
                    (SessionState::Working, "Working on your prompt")
                }
                "BeforeAgent" if matches!(agent, Agent::Gemini) => {
                    (SessionState::Working, "Working on your prompt")
                }
                "BeforeTool" | "AfterTool" if matches!(agent, Agent::Gemini) => {
                    (SessionState::Working, kind)
                }
                "PreToolUse" if !matches!(agent, Agent::Gemini | Agent::Copilot) => {
                    (SessionState::Working, kind)
                }
                "PostToolUse" if !matches!(agent, Agent::Gemini) => (SessionState::Working, kind),
                "PostToolUseFailure"
                    if matches!(agent, Agent::Claude | Agent::Kimi | Agent::Copilot) =>
                {
                    (SessionState::Working, kind)
                }
                "PermissionRequest" if matches!(agent, Agent::Claude | Agent::Codex) => {
                    (SessionState::NeedsAttention, "Permission requested")
                }
                "Interrupt" if matches!(agent, Agent::Codex) => {
                    (SessionState::Done, "Turn interrupted")
                }
                "Stop" if !matches!(agent, Agent::Gemini | Agent::Kimi) => {
                    (SessionState::Done, "Turn finished")
                }
                "AfterAgent" if matches!(agent, Agent::Gemini) => {
                    (SessionState::Done, "Turn finished")
                }
                "SessionEnd" => (SessionState::Done, "Session ended"),
                "Notification"
                    if matches!(agent, Agent::Claude | Agent::Droid)
                        && matches!(
                            payload.get("notification_type").and_then(Value::as_str),
                            Some("permission_prompt" | "idle_prompt" | "elicitation_dialog")
                        ) =>
                {
                    (SessionState::NeedsAttention, "Agent needs attention")
                }
                "Notification"
                    if matches!(agent, Agent::Gemini)
                        && payload.get("notification_type").and_then(Value::as_str)
                            == Some("ToolPermission") =>
                {
                    (SessionState::NeedsAttention, "Permission requested")
                }
                "Notification"
                    if matches!(agent, Agent::Kimi)
                        && payload.get("notification_type").and_then(Value::as_str)
                            == Some("permission_prompt") =>
                {
                    (SessionState::NeedsAttention, "Permission requested")
                }
                "Notification"
                    if matches!(agent, Agent::Copilot)
                        && matches!(
                            payload.get("notification_type").and_then(Value::as_str),
                            Some("permission_prompt" | "elicitation_dialog")
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
                session_id: field(
                    payload,
                    if matches!(agent, Agent::Copilot) && kind == "Notification" {
                        "sessionId"
                    } else {
                        "session_id"
                    },
                    256,
                )?,
                agent: match agent {
                    Agent::Claude => "Claude Code",
                    Agent::Codex => "Codex",
                    Agent::Gemini => "Gemini CLI",
                    Agent::Droid => "Droid",
                    Agent::Kimi => "Kimi CLI",
                    Agent::Copilot => "GitHub Copilot CLI",
                    _ => unreachable!(),
                }
                .into(),
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

mod storage_failure_diagnostic;
mod storage_schema;
use storage_failure_diagnostic::{failure as storage_failure, Phase as StoragePhase};

pub struct Store {
    connection: Connection,
}

fn validate_state_file(path: &Path) -> Result<()> {
    lazysh_common::private_state::validate_database(path).map_err(Error::from)
}
fn sidecar_kind(path: &Path) -> lazysh_common::private_state::SidecarKind {
    use lazysh_common::private_state::SidecarKind;
    match path.file_name().and_then(|name| name.to_str()) {
        Some("events.sqlite3-journal") => SidecarKind::Journal,
        Some("events.sqlite3-wal") => SidecarKind::Wal,
        Some("events.sqlite3-shm") => SidecarKind::Shm,
        Some("events.sqlite3-init-lock") => SidecarKind::BootstrapLock,
        _ => SidecarKind::Other,
    }
}
fn validate_sidecar(path: &Path) -> Result<()> {
    lazysh_common::private_state::validate_sidecar(path, sidecar_kind(path)).map_err(Error::from)
}
#[cfg(test)]
fn regular_state_metadata(path: &Path, message: &'static str) -> io::Result<Option<fs::Metadata>> {
    lazysh_common::test_support::regular_state_metadata(path, message)
}
#[cfg(test)]
fn validate_sidecar_with(
    path: &Path,
    observe: impl FnMut() -> io::Result<Option<fs::Metadata>>,
) -> Result<()> {
    lazysh_common::test_support::observe_sidecar(sidecar_kind(path), observe).map_err(Error::from)
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
        let directory = storage_namespace::resolve(directory)
            .map_err(path_error)
            .map_err(|e| storage_failure(StoragePhase::BootstrapPreparation, e))?;
        admit(&directory)
            .map_err(path_error)
            .map_err(|e| storage_failure(StoragePhase::BootstrapPreparation, e))?;
        storage_namespace::create(&directory)
            .map_err(|e| storage_failure(StoragePhase::BootstrapPreparation, e.into()))?;
        let path = directory.join("events.sqlite3");
        // Never open/close the database outside SQLite: on POSIX, closing any
        // descriptor for this inode releases this process's SQLite locks.
        // The private directory protects newly created files until chmod, and
        // SQLite itself refuses leaf symlinks with SQLITE_OPEN_NOFOLLOW.
        validate_state_file(&path)
            .map_err(|e| storage_failure(StoragePhase::BootstrapPreparation, e))?;
        // One deadline covers native bootstrap coordination, sidecar admission
        // and SQLite's schema/mode waits rather than adding another wait budget.
        let bootstrap_deadline = Instant::now() + Duration::from_secs(3);
        let _bootstrap = lock_store_bootstrap(&directory, bootstrap_deadline)
            .map_err(|e| storage_failure(StoragePhase::BootstrapLock, e))?;
        // Inspect ephemeral paths inside the same lock as initialization: another
        // initializer must not unlink its rollback journal during these checks.
        // SQLite owns sidecar descriptors; never open/close them here because
        // POSIX locks belong to the process/inode.
        for suffix in ["-journal", "-wal", "-shm"] {
            check_sidecar(&directory.join(format!("events.sqlite3{suffix}")))
                .map_err(|e| storage_failure(StoragePhase::BootstrapPreparation, e))?;
        }
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|e| storage_failure(StoragePhase::SqliteOpen, e.into()))?;
        // Short-lived hooks must not checkpoint/unlink shared WAL state when
        // another Store is admitting its sidecars. FULL commit synchronization
        // and SQLite's normal automatic checkpoints remain unchanged.
        if !connection
            .set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
                true,
            )
            .map_err(|e| storage_failure(StoragePhase::SqliteConfiguration, e.into()))?
        {
            return Err(storage_failure(
                StoragePhase::SqliteConfiguration,
                io::Error::other("Cannot retain companion WAL on close").into(),
            ));
        }
        validate_state_file(&path)
            .map_err(|e| storage_failure(StoragePhase::BootstrapPreparation, e))?;
        connection
            .busy_handler(Some(move |_| wait_for_storage_until(bootstrap_deadline)))
            .map_err(|e| storage_failure(StoragePhase::SqliteConfiguration, e.into()))?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|e| storage_failure(StoragePhase::Synchronous, e.into()))?;
        let mode: String = connection
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .map_err(|e| storage_failure(StoragePhase::JournalMode, e.into()))?;
        if mode != "wal" {
            return Err(storage_failure(
                StoragePhase::JournalMode,
                io::Error::other("WAL unavailable for companion state").into(),
            ));
        }
        connection
            .execute_batch("PRAGMA journal_size_limit=1048576;")
            .map_err(|e| storage_failure(StoragePhase::JournalSize, e.into()))?;
        connection
            .execute_batch(storage_schema::V1_SESSIONS)
            .map_err(|e| storage_failure(StoragePhase::SessionsSchema, e.into()))?;
        connection
            .execute_batch(reported_history::SCHEMA)
            .map_err(|e| storage_failure(StoragePhase::SessionsSchema, e.into()))?;
        connection
            .execute_batch(hooks::AIDER_HEALTH_SCHEMA)
            .map_err(|e| storage_failure(StoragePhase::SessionsSchema, e.into()))?;
        relay::initialize(&connection)
            .map_err(|e| storage_failure(StoragePhase::RelaySchema, e))?;
        connection
            .busy_handler(Some(wait_for_storage))
            .map_err(|e| storage_failure(StoragePhase::SqliteConfiguration, e.into()))?;
        Ok(Self { connection })
    }
    pub fn ingest(&mut self, event: &Event, now: DateTime<Utc>) -> Result<()> {
        self.ingest_with_reported_history(Some(event), None, now)
    }
    pub fn ingest_with_reported_history(
        &mut self,
        event: Option<&Event>,
        source: Option<&reported_history::ReportedSource>,
        reported_at: DateTime<Utc>,
    ) -> Result<()> {
        if let Some(event) = event {
            event
                .validate()
                .map_err(|e| storage_failure(StoragePhase::IngestValidation, e))?;
        }
        if let Some(source) = source {
            source
                .validate()
                .map_err(|e| storage_failure(StoragePhase::IngestValidation, e))?;
        }
        let now = reported_at.timestamp_micros() as f64 / 1_000_000.0;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| storage_failure(StoragePhase::IngestBegin, e.into()))?;
        if let Some(event) = event {
            let prior: Option<String> = transaction
                .query_row(
                    "SELECT state FROM sessions WHERE agent=?1 AND session_id=?2",
                    params![event.agent, event.session_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| storage_failure(StoragePhase::PriorState, e.into()))?;
            transaction.execute("INSERT INTO sessions VALUES (?1,?2,?3,?4,?5,?6,?7,1)
            ON CONFLICT(agent,session_id) DO UPDATE SET project=excluded.project,state=excluded.state,
            summary=excluded.summary,pane_id=excluded.pane_id,updated_at=excluded.updated_at,event_count=sessions.event_count+1",
            params![event.agent,event.session_id,event.project,event.state.as_str(),event.summary,event.pane_id,now]).map_err(|e| storage_failure(StoragePhase::SessionWrite, e.into()))?;
            let kind = match event.state {
                SessionState::Working => lazysh_notification_client::Kind::Working,
                SessionState::NeedsAttention => lazysh_notification_client::Kind::NeedsAttention,
                SessionState::Done => lazysh_notification_client::Kind::Done,
            };
            relay::admit_transition(
                &transaction,
                kind,
                prior.as_deref() != Some(event.state.as_str()),
                now as i64,
            )
            .map_err(|e| storage_failure(StoragePhase::RelayAdmission, e))?;
        }
        if let Some(source) = source {
            reported_history::insert(&transaction, source, reported_at)?;
        }
        transaction
            .execute(
                "DELETE FROM sessions WHERE updated_at < ?1",
                [now - RETENTION_SECONDS],
            )
            .map_err(|e| storage_failure(StoragePhase::RetentionAge, e.into()))?;
        transaction.execute("DELETE FROM sessions WHERE rowid NOT IN (SELECT rowid FROM sessions ORDER BY updated_at DESC,rowid DESC LIMIT 100)",[]).map_err(|e| storage_failure(StoragePhase::RetentionCount, e.into()))?;
        transaction
            .commit()
            .map_err(|e| storage_failure(StoragePhase::Commit, e.into()))?;
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
    hooks::command_config("claude", &HOOK_EVENTS, 5)
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
    fn legacy_connection_cleanup_during_protected_admission_preserves_committed_event() {
        let directory = tempfile::tempdir().unwrap();
        let now = Utc::now();
        let event = normalize(
            &json!({
                "schemaVersion": 1, "sessionId": "close-during-admission", "agent": "Fixture",
                "project": "/synthetic", "state": "working", "summary": "Committed before cleanup"
            }),
            Agent::Generic,
            None,
        )
        .unwrap()
        .unwrap();
        let mut existing = Store::open(directory.path()).unwrap();
        // Keep exercising the actual cleanup boundary for legacy/external peers
        // that have not adopted Store's retained-WAL close policy.
        assert!(!existing
            .connection
            .set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
                false,
            )
            .unwrap());
        existing.ingest(&event, now).unwrap();
        let sidecars =
            ["-wal", "-shm"].map(|suffix| directory.path().join(format!("events.sqlite3{suffix}")));
        for path in &sidecars {
            assert!(fs::symlink_metadata(path).unwrap().is_file());
        }
        let mut established = Some(existing);
        let mut checked = 0;
        let mut reopened = Store::open_with_storage_checks(
            directory.path(),
            storage_filesystem::require_local,
            |path| {
                let probe = fs::File::open(directory.path().join("events.sqlite3-init-lock"))?;
                assert!(matches!(
                    probe.try_lock(),
                    Err(fs::TryLockError::WouldBlock)
                ));
                if let Some(last_connection) = established.take() {
                    // The new opener holds its native lock but has not opened
                    // SQLite. Real last-close cleanup must still be able to run.
                    drop(last_connection);
                    for removed in &sidecars {
                        assert_eq!(
                            fs::symlink_metadata(removed).unwrap_err().kind(),
                            io::ErrorKind::NotFound
                        );
                    }
                }
                // Check real path state, not injected metadata or an opened sidecar FD.
                validate_sidecar(path)?;
                checked += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(checked, 3);
        assert!(established.is_none());
        let snapshot = reopened.snapshot(50, now).unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].event_count, 1);
        assert_eq!(
            serde_json::to_value(&snapshot.sessions[0].event).unwrap(),
            serde_json::to_value(event).unwrap()
        );
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
            assert!(store
                .connection
                .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)
                .unwrap());
            let number = |name: &str| {
                store
                    .connection
                    .pragma_query_value(None, name, |row| row.get::<_, i64>(0))
                    .unwrap()
            };
            assert_eq!(number("wal_autocheckpoint"), 1000);
            assert_eq!(number("journal_size_limit"), 1024 * 1024);
            assert_eq!(number("synchronous"), 2);
            eprintln!(
                "Store WAL settings: page_size={}, auto_pages={}, journal_bytes={}",
                number("page_size"),
                number("wal_autocheckpoint"),
                number("journal_size_limit")
            );
            assert_eq!(
                store
                    .connection
                    .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
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
