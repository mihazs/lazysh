use chrono::{DateTime, SecondsFormat, Utc};
pub mod approvals;
pub mod devices;
pub mod settings;
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
        let remaining = Duration::from_secs(3).saturating_sub(start.elapsed());
        if remaining.is_zero() {
            return false;
        }
        // SQLite's default timeout backs off to 100 ms. Concurrent short hook
        // writes can then wake in lockstep, leaving it idle between waves.
        // Poll briefly under the same wall-clock budget, without weakening syncs.
        std::thread::sleep(remaining.min(Duration::from_millis(5)));
        true
    })
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
            Self::Device(kind) => kind,
            Self::Settings(kind) => kind,
            Self::Io(_) => "IoError",
            Self::Storage(_) => "StorageError",
        }
    }
}
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error)
    }
}
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
pub fn read_event(mut input: impl Read, agent: Agent, pane: Option<&str>) -> Result<Option<Event>> {
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(MAX_INPUT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_INPUT {
        return Err(Error::InvalidEvent);
    }
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidEvent)?;
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

pub struct Store {
    connection: Connection,
}

fn validate_state_file(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() {
        return Err(Error::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "State must be a regular file",
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "State must not have hard links",
            )));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        match fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(Error::Io(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Invalid state directory",
                )))
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut directories = fs::DirBuilder::new();
        directories.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directories.mode(0o700);
        }
        directories.create(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }
        let path = directory.join("events.sqlite3");
        // Never open/close the database outside SQLite: on POSIX, closing any
        // descriptor for this inode releases this process's SQLite locks.
        // The private directory protects newly created files until chmod, and
        // SQLite itself refuses leaf symlinks with SQLITE_OPEN_NOFOLLOW.
        validate_state_file(&path)?;
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        validate_state_file(&path)?;
        connection.busy_handler(Some(wait_for_storage))?;
        connection.execute_batch(
            "PRAGMA journal_size_limit=1048576;
            CREATE TABLE IF NOT EXISTS sessions (
                agent TEXT NOT NULL, session_id TEXT NOT NULL, project TEXT NOT NULL,
                state TEXT NOT NULL, summary TEXT NOT NULL, pane_id TEXT,
                updated_at REAL NOT NULL, event_count INTEGER NOT NULL,
                PRIMARY KEY (agent,session_id));",
        )?;
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

#[cfg(test)]
mod tests {
    use super::*;
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
