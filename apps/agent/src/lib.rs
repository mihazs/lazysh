use chrono::{DateTime, SecondsFormat, Utc};
pub mod account_usage;
pub mod approvals;
pub mod auto_update;
pub mod browser;
pub mod desktop_lock;
pub mod devices;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod directory_listing;
pub mod herdr;
pub mod herdr_events;
pub mod herdr_pane_input;
pub mod hook_setup;
pub mod hooks;
pub mod host_browser;
pub mod host_features;
pub mod installation;
pub mod kimi_code;
pub mod listeners;
pub mod live_agents;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod managed_directory;
#[cfg(windows)]
#[path = "managed_directory_windows.rs"]
mod managed_directory;
// The process table is read on Unix only; elsewhere only the declared parent session applies.
#[cfg_attr(not(unix), allow(dead_code))]
pub mod nested_agent;
pub mod notification_policy;
pub mod opencode_service;
mod pane_server;
pub use pane_server::pane_server;
mod private_json;
pub mod rejected_dialog;
pub mod relay;
pub mod reported_history;
pub mod review;
pub mod settings;
pub mod skills;
#[cfg(feature = "storage-observation")]
mod storage_observation;
#[cfg(feature = "storage-observation")]
#[doc(hidden)]
pub use storage_observation::take_bootstrap_observation;
mod storage_filesystem;
mod storage_namespace;
pub mod transcript;
pub mod update;
pub mod usage;
pub mod usage_collection;
pub mod usage_collector;
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
const ACTIVE_TURN_SECONDS: i64 = 10 * 60;
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
    /// A source that is over the size a reader takes in: a transcript past its byte or record bound.
    TooLarge,
    Installation(&'static str),
    UnsupportedStateFilesystem,
    Device(&'static str),
    Herdr(&'static str),
    Settings(&'static str),
    Relay(&'static str),
    Browser(&'static str),
    Listeners(&'static str),
    Review(&'static str),
    Io(io::Error),
    Storage(rusqlite::Error),
}
impl Error {
    pub fn class(&self) -> &'static str {
        match self {
            Self::InvalidEvent => "InvalidEvent",
            Self::InvalidArgument => "InvalidArgument",
            Self::TooLarge => "TooLarge",
            Self::Installation(kind) => kind,
            Self::UnsupportedStateFilesystem => "UnsupportedStateFilesystem",
            Self::Device(kind) | Self::Herdr(kind) => kind,
            Self::Settings(kind) => kind,
            Self::Relay(kind) => kind,
            Self::Browser(kind) | Self::Listeners(kind) | Self::Review(kind) => kind,
            Self::Io(_) => "IoError",
            Self::Storage(_) => "StorageError",
        }
    }
}
lazysh_common::impl_from_error!(Error, Io, io::Error);
lazysh_common::impl_from_error!(Error, Storage, rusqlite::Error);
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Agent {
    Claude,
    Codex,
    Opencode,
    Gemini,
    Grok,
    Droid,
    Kimi,
    /// Kimi Code 2.4 approval requests only; reads through `kimi_code::read`, not `normalize`.
    KimiCode,
    Copilot,
    Cursor,
    Amp,
    Cline,
    Generic,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
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
/// What a needs-attention agent waits for; absent when it needs the user for another reason (a failed turn).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Waiting {
    Approval,
    Question,
    Plan,
    Menu,
    /// A generic notification: it never replaces a more specific wait that is still open.
    Unknown,
}
impl Waiting {
    fn as_str(self) -> &'static str {
        match self {
            Self::Approval => "approval",
            Self::Question => "question",
            Self::Plan => "plan",
            Self::Menu => "menu",
            Self::Unknown => "unknown",
        }
    }
    fn parse(value: &str) -> Option<Self> {
        [
            Self::Approval,
            Self::Question,
            Self::Plan,
            Self::Menu,
            Self::Unknown,
        ]
        .into_iter()
        .find(|kind| kind.as_str() == value)
    }
    /// A permission hook names the tool; the tools that ask a question or for a plan decision are not approvals.
    fn for_tool(tool: Option<&str>) -> Self {
        match tool {
            Some("AskUserQuestion" | "request_user_input") => Self::Question,
            Some("ExitPlanMode") => Self::Plan,
            _ => Self::Approval,
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
    /// The tmux or rmux server `pane_id` belongs to (`tmux:work`): a pane id is unique only within one server.
    /// Absent from a companion that predates it, and for a pane no `-L` label names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<Waiting>,
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
        if self
            .pane_server
            .as_deref()
            .is_some_and(|server| !pane_server::valid(server))
        {
            return Err(Error::InvalidEvent);
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
    /// When the current wait began; kept while the same wait is reported again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_since: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u8,
    pub sessions: Vec<SessionSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_agents: Option<live_agents::LiveAgents>,
    /// Present only when an app newer than this companion asked: what happens to this companion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<auto_update::Update>,
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
    let agent = hooks::reporting_agent(agent, payload);
    let event = match agent {
        // Its approvals need the correlation ledger, which a stateless event cannot carry.
        Agent::KimiCode => return Err(Error::InvalidArgument),
        Agent::Generic => {
            if payload.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
                return Err(Error::InvalidEvent);
            }
            serde_json::from_value::<Event>(payload.clone()).map_err(|_| Error::InvalidEvent)?
        }
        Agent::Opencode | Agent::Cursor | Agent::Amp | Agent::Cline | Agent::Grok => {
            match match agent {
                Agent::Opencode => hooks::opencode_event(payload, pane),
                Agent::Cursor => hooks::cursor_event(payload, pane),
                Agent::Amp => hooks::amp_event(payload, pane),
                Agent::Cline => hooks::cline_event(payload, pane),
                Agent::Grok => hooks::grok_event(payload, pane),
                _ => unreachable!(),
            }? {
                Some(event) => event,
                None => return Ok(None),
            }
        }
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
                // A tagged completion can own a separate child report.
                let child = payload
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .filter(|id| text(id, 256).is_ok());
                let parent = payload
                    .get("parent_agent_id")
                    .and_then(Value::as_str)
                    .filter(|id| text(id, 256).is_ok());
                if child.is_none()
                    || payload.get("session_id").and_then(Value::as_str) != child
                    || parent.is_none()
                    || parent == child
                {
                    return Ok(None);
                }
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
            let tool = payload.get("tool_name").and_then(Value::as_str);
            let waiting = (state == SessionState::NeedsAttention).then(|| {
                match (
                    kind,
                    payload.get("notification_type").and_then(Value::as_str),
                ) {
                    ("PermissionRequest", _) => Waiting::for_tool(tool),
                    (_, Some("elicitation_dialog")) => Waiting::Question,
                    // Claude also sends its PermissionRequest hook; the notification adds nothing the hook did not say.
                    (_, Some("permission_prompt")) if matches!(agent, Agent::Claude) => {
                        Waiting::Unknown
                    }
                    (_, Some("permission_prompt" | "ToolPermission")) => Waiting::Approval,
                    _ => Waiting::Unknown,
                }
            });
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
                pane_server: None,
                waiting,
            }
        }
    };
    event.validate()?;
    Ok(Some(event))
}

/// A channel whose sender is dropped when this process's stdin closes: how a stream command learns that
/// the exec channel it serves went away.
pub(crate) fn stdin_closed() -> std::sync::mpsc::Receiver<()> {
    let (closed_tx, closed) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0; 64];
        let mut stdin = io::stdin();
        while matches!(stdin.read(&mut buffer), Ok(count) if count > 0) {}
        drop(closed_tx);
    });
    closed
}

/// The terminal pane a hook runs in: tmux's `TMUX_PANE`, else Zellij's session and terminal pane as `zellij:<session>:<pane>`,
/// else the random identifier lazysh exported when it launched the terminal (`LAZYSH_TERMINAL`) as `lazysh:<id>`.
/// tmux wins when both are exported, as before Zellij was recognised; a multiplexer started inside a launched terminal names its own panes.
pub fn pane_identity() -> Option<String> {
    let var = |name| std::env::var(name).ok();
    identity(
        var("TMUX_PANE"),
        var("ZELLIJ_SESSION_NAME").as_deref(),
        var("ZELLIJ_PANE_ID").as_deref(),
        var("LAZYSH_TERMINAL").as_deref(),
    )
}
/// The multiplexer pane an approval is bound to, or the exact Herdr pane.
pub fn approval_pane_identity() -> Option<String> {
    pane_identity()
        .filter(|pane| !pane.starts_with("lazysh:"))
        .or_else(herdr::pane_identity)
}
fn identity(
    tmux: Option<String>,
    session: Option<&str>,
    pane: Option<&str>,
    terminal: Option<&str>,
) -> Option<String> {
    tmux.or_else(|| {
        let (session, pane) = (session?, pane?);
        let valid = !session.is_empty()
            && session.len() <= 200
            && !session.chars().any(char::is_control)
            && (1..=10).contains(&pane.len())
            && pane.bytes().all(|c| c.is_ascii_digit());
        valid.then(|| format!("zellij:{session}:{pane}"))
    })
    .or_else(|| {
        let id = terminal?;
        let valid = id.len() == 32 && id.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
        valid.then(|| format!("lazysh:{id}"))
    })
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

/// How an opener holds the native bootstrap lock.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Bootstrap {
    /// Shared: adopt an initialized WAL store without writing to it.
    Adopt,
    /// Exclusive: create the database, switch it to WAL and apply the schema.
    Initialize,
}

fn open_store_bootstrap(directory: &Path) -> Result<fs::File> {
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
    Ok(lock)
}

/// Initializers exclude every opener; adopters exclude only initializers, so
/// warm opens never queue behind each other. A warm open can stall in the
/// filesystem while it holds the lock (on Windows, opening, stat-ing or reading
/// the WAL can wait for another connection's FlushFileBuffers); one exclusive
/// queue turned that stall into one durable commit per waiting opener.
fn lock_store_bootstrap(
    lock: &fs::File,
    deadline: Instant,
    mut mode: Bootstrap,
) -> Result<Bootstrap> {
    loop {
        let attempt = match mode {
            Bootstrap::Adopt => lock.try_lock_shared(),
            Bootstrap::Initialize => lock.try_lock(),
        };
        match attempt {
            Ok(()) => return Ok(mode),
            Err(fs::TryLockError::WouldBlock) => {
                // An exclusive holder is initializing: adopt its result once it
                // releases instead of queueing to initialize the store again.
                if mode == Bootstrap::Initialize {
                    match lock.try_lock_shared() {
                        Ok(()) => lock.unlock()?,
                        Err(fs::TryLockError::WouldBlock) => mode = Bootstrap::Adopt,
                        Err(fs::TryLockError::Error(error)) => return Err(error.into()),
                    }
                }
                if !wait_for_storage_until(deadline) {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                        None,
                    )
                    .into());
                }
            }
            Err(fs::TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

// Additive: a companion that predates it never reads or writes this table.
const WAITING_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS session_waiting (
    agent TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, since REAL NOT NULL,
    PRIMARY KEY (agent,session_id));";
const EVICTED_WORKING_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS evicted_working (
    id INTEGER PRIMARY KEY CHECK (id = 1), updated_at REAL NOT NULL);";

// Additive like `session_waiting`: a companion that predates it never reads or writes this table.
const PANE_SERVER_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS session_pane_server (
    agent TEXT NOT NULL, session_id TEXT NOT NULL, server TEXT NOT NULL,
    PRIMARY KEY (agent,session_id));";

fn apply_schema(
    transaction: &rusqlite::Transaction<'_>,
) -> std::result::Result<(), (StoragePhase, Error)> {
    for schema in [
        storage_schema::V1_SESSIONS,
        reported_history::SCHEMA,
        hooks::AIDER_HEALTH_SCHEMA,
        WAITING_SCHEMA,
        EVICTED_WORKING_SCHEMA,
        kimi_code::SCHEMA,
        PANE_SERVER_SCHEMA,
    ] {
        transaction
            .execute_batch(schema)
            .map_err(|e| (StoragePhase::SessionsSchema, e.into()))?;
    }
    relay::initialize(transaction).map_err(|e| (StoragePhase::RelaySchema, e))
}

fn initialize_schema(connection: &mut Connection) -> Result<()> {
    // Defer writer acquisition so an already initialized store can open beside a live writer.
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
        .map_err(|e| storage_failure(StoragePhase::SessionsSchema, e.into()))?;
    apply_schema(&transaction).map_err(|(phase, e)| storage_failure(phase, e))?;
    transaction
        .commit()
        .map_err(|e| storage_failure(StoragePhase::Commit, e.into()))
}

/// Adopt an initialized WAL store under the shared bootstrap lock. `query_only`
/// makes the probe unable to write, so `false` (rollback journal mode or a
/// missing schema object) sends the opener to exclusive initialization.
fn adopt_initialized(connection: &mut Connection) -> Result<bool> {
    let configuration =
        |e: rusqlite::Error| storage_failure(StoragePhase::SqliteConfiguration, e.into());
    connection
        .pragma_update(None, "query_only", true)
        .map_err(configuration)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
        .map_err(|e| storage_failure(StoragePhase::JournalMode, e.into()))?;
    // The first read makes SQLite adopt the file's persistent journal mode.
    let mode = transaction
        .query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
        .and_then(|()| {
            transaction.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
        })
        .map_err(|e| storage_failure(StoragePhase::JournalMode, e.into()))?;
    if mode != "wal" {
        return Ok(false);
    }
    match apply_schema(&transaction) {
        Ok(()) => {}
        Err((_, Error::Storage(rusqlite::Error::SqliteFailure(code, _))))
            if code.code == rusqlite::ErrorCode::ReadOnly =>
        {
            return Ok(false)
        }
        Err((phase, error)) => return Err(storage_failure(phase, error)),
    }
    transaction
        .commit()
        .map_err(|e| storage_failure(StoragePhase::Commit, e.into()))?;
    connection
        .pragma_update(None, "query_only", false)
        .map_err(configuration)?;
    Ok(true)
}

fn set_journal_size_limit(connection: &Connection) -> Result<()> {
    connection
        .execute_batch("PRAGMA journal_size_limit=1048576;")
        .map_err(|e| storage_failure(StoragePhase::JournalSize, e.into()))
}

fn state_file_present(path: &Path, nonempty: bool) -> bool {
    fs::symlink_metadata(path).map_or_else(
        |error| error.kind() != io::ErrorKind::NotFound,
        |metadata| !nonempty || metadata.len() > 0,
    )
}

/// Write one lifecycle report and admit its relay transition, inside the caller's transaction.
fn write_event(
    transaction: &rusqlite::Transaction<'_>,
    event: &Event,
    now: f64,
    admission: notification_policy::Admission,
) -> Result<()> {
    let prior: Option<String> = transaction
        .query_row(
            "SELECT state FROM sessions WHERE agent=?1 AND session_id=?2",
            params![event.agent, event.session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| storage_failure(StoragePhase::PriorState, e.into()))?;
    // An open wait keeps its specific kind and start when a generic notification repeats it.
    let open: Option<(String, f64)> = transaction
        .query_row(
            "SELECT kind,since FROM session_waiting WHERE agent=?1 AND session_id=?2",
            params![event.agent, event.session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| storage_failure(StoragePhase::PriorState, e.into()))?
        .filter(|_| prior.as_deref() == Some(SessionState::NeedsAttention.as_str()));
    let waiting = match (
        event.waiting,
        open.as_ref().and_then(|(kind, _)| Waiting::parse(kind)),
    ) {
        (Some(Waiting::Unknown), Some(kept)) => Some(kept),
        (waiting, _) => waiting,
    };
    let since = open
        .filter(|(kind, _)| Some(kind.as_str()) == waiting.map(Waiting::as_str))
        .map_or(now, |(_, since)| since);
    match waiting {
            Some(kind) if event.state == SessionState::NeedsAttention => transaction.execute(
                "INSERT INTO session_waiting VALUES (?1,?2,?3,?4)
                ON CONFLICT(agent,session_id) DO UPDATE SET kind=excluded.kind,since=excluded.since",
                params![event.agent, event.session_id, kind.as_str(), since],
            ),
            _ => transaction.execute(
                "DELETE FROM session_waiting WHERE agent=?1 AND session_id=?2",
                params![event.agent, event.session_id],
            ),
        }
        .map_err(|e| storage_failure(StoragePhase::SessionWrite, e.into()))?;
    match &event.pane_server {
        Some(server) => transaction.execute(
            "INSERT INTO session_pane_server VALUES (?1,?2,?3)
            ON CONFLICT(agent,session_id) DO UPDATE SET server=excluded.server",
            params![event.agent, event.session_id, server],
        ),
        None => transaction.execute(
            "DELETE FROM session_pane_server WHERE agent=?1 AND session_id=?2",
            params![event.agent, event.session_id],
        ),
    }
    .map_err(|e| storage_failure(StoragePhase::SessionWrite, e.into()))?;
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
        transaction,
        kind,
        prior.as_deref() != Some(event.state.as_str())
            && admission == notification_policy::Admission::Queue,
        now as i64,
    )
    .map_err(|e| storage_failure(StoragePhase::RelayAdmission, e))?;

    Ok(())
}

/// Drop sessions past retention or the count cap, then the waits and observations of dropped sessions.
fn apply_retention(transaction: &rusqlite::Transaction<'_>, now: f64) -> Result<()> {
    // Age pruning must not erase malformed timestamp evidence before the updater sees it.
    transaction.execute("INSERT INTO evicted_working SELECT 1,?1 WHERE EXISTS(SELECT 1 FROM sessions WHERE typeof(state) != 'text' OR state NOT IN ('working','done','needs_attention') OR typeof(updated_at) NOT IN ('real','integer') OR updated_at NOT BETWEEN -62135596800 AND 253402300799) ON CONFLICT(id) DO UPDATE SET updated_at=MAX(updated_at,excluded.updated_at)",[now]).map_err(|e| storage_failure(StoragePhase::RetentionCount, e.into()))?;
    transaction
        .execute(
            "DELETE FROM sessions WHERE updated_at < ?1",
            [now - RETENTION_SECONDS],
        )
        .map_err(|e| storage_failure(StoragePhase::RetentionAge, e.into()))?;
    // Remember an evicted recent working report until its active-turn window expires.
    transaction.execute("INSERT INTO evicted_working SELECT 1,MAX(CASE WHEN typeof(state) != 'text' OR state NOT IN ('working','done','needs_attention') OR typeof(updated_at) NOT IN ('real','integer') OR updated_at NOT BETWEEN -62135596800 AND 253402300799 THEN ?2 ELSE updated_at END) FROM sessions WHERE (typeof(state) != 'text' OR state NOT IN ('working','done','needs_attention') OR typeof(updated_at) NOT IN ('real','integer') OR updated_at NOT BETWEEN -62135596800 AND 253402300799 OR (state NOT IN ('done','needs_attention') AND updated_at > ?1)) AND rowid NOT IN (SELECT rowid FROM sessions ORDER BY updated_at DESC,rowid DESC LIMIT 100) HAVING COUNT(*) > 0 ON CONFLICT(id) DO UPDATE SET updated_at=MAX(updated_at,excluded.updated_at)",[now - ACTIVE_TURN_SECONDS as f64,now]).map_err(|e| storage_failure(StoragePhase::RetentionCount, e.into()))?;
    // Keep the board’s newest-100 ordering; the sentinel keeps evicted active evidence separately.
    transaction.execute("DELETE FROM sessions WHERE rowid NOT IN (SELECT rowid FROM sessions ORDER BY updated_at DESC,rowid DESC LIMIT 100)",[]).map_err(|e| storage_failure(StoragePhase::RetentionCount, e.into()))?;
    for table in ["session_waiting", "session_pane_server"] {
        transaction
            .execute(&format!("DELETE FROM {table} WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.agent={table}.agent AND sessions.session_id={table}.session_id)"), [])
            .map_err(|e| storage_failure(StoragePhase::RetentionCount, e.into()))?;
    }
    Ok(())
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
        #[cfg(feature = "storage-observation")]
        let mut observation = storage_observation::Observation::new();
        let bootstrap = open_store_bootstrap(&directory)
            .map_err(|e| storage_failure(StoragePhase::BootstrapLock, e))?;
        // An existing database is usually initialized: adopt it under the shared
        // lock and fall back to exclusive initialization only when it is not.
        let mut mode = if state_file_present(&path, true) {
            Bootstrap::Adopt
        } else {
            Bootstrap::Initialize
        };
        let mut connection = loop {
            mode = lock_store_bootstrap(&bootstrap, bootstrap_deadline, mode)
                .map_err(|e| storage_failure(StoragePhase::BootstrapLock, e))?;
            #[cfg(feature = "storage-observation")]
            observation.mark(0);
            // Inspect ephemeral paths inside the same lock as initialization: an
            // initializer must not unlink its rollback journal during these checks.
            // SQLite owns sidecar descriptors; never open/close them here because
            // POSIX locks belong to the process/inode.
            for suffix in ["-journal", "-wal", "-shm"] {
                check_sidecar(&directory.join(format!("events.sqlite3{suffix}")))
                    .map_err(|e| storage_failure(StoragePhase::BootstrapPreparation, e))?;
            }
            #[cfg(feature = "storage-observation")]
            observation.mark(1);
            // A rollback journal belongs to interrupted initialization; only an
            // exclusive holder may let SQLite replay it.
            if mode == Bootstrap::Adopt
                && state_file_present(&directory.join("events.sqlite3-journal"), false)
            {
                bootstrap
                    .unlock()
                    .map_err(|e| storage_failure(StoragePhase::BootstrapLock, e.into()))?;
                mode = Bootstrap::Initialize;
                continue;
            }
            let mut connection = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )
            .map_err(|e| storage_failure(StoragePhase::SqliteOpen, e.into()))?;
            #[cfg(feature = "storage-observation")]
            observation.mark(2);
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
            #[cfg(feature = "storage-observation")]
            observation.mark(3);
            if mode == Bootstrap::Adopt {
                if !adopt_initialized(&mut connection)? {
                    // Close through SQLite (it retains the WAL) before upgrading.
                    drop(connection);
                    bootstrap
                        .unlock()
                        .map_err(|e| storage_failure(StoragePhase::BootstrapLock, e.into()))?;
                    mode = Bootstrap::Initialize;
                    continue;
                }
                set_journal_size_limit(&connection)?;
                #[cfg(feature = "storage-observation")]
                observation.mark(4);
            } else {
                let journal: String = connection
                    .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
                    .map_err(|e| storage_failure(StoragePhase::JournalMode, e.into()))?;
                if journal != "wal" {
                    return Err(storage_failure(
                        StoragePhase::JournalMode,
                        io::Error::other("WAL unavailable for companion state").into(),
                    ));
                }
                set_journal_size_limit(&connection)?;
                #[cfg(feature = "storage-observation")]
                observation.mark(4);
                initialize_schema(&mut connection)?;
            }
            #[cfg(feature = "storage-observation")]
            observation.mark(5);
            break connection;
        };
        connection
            .busy_handler(Some(wait_for_storage))
            .map_err(|e| storage_failure(StoragePhase::SqliteConfiguration, e.into()))?;
        drop(bootstrap);
        Ok(Self { connection })
    }
    pub fn ingest(&mut self, event: &Event, now: DateTime<Utc>) -> Result<()> {
        self.ingest_with_reported_history(
            Some(event),
            None,
            now,
            notification_policy::Admission::Queue,
        )
    }
    /// `admission` only decides whether a state change may queue a relay notification; the event is recorded either way.
    pub fn ingest_with_reported_history(
        &mut self,
        event: Option<&Event>,
        source: Option<&reported_history::ReportedSource>,
        reported_at: DateTime<Utc>,
        admission: notification_policy::Admission,
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
            write_event(&transaction, event, now, admission)?;
        }
        if let Some(source) = source {
            reported_history::insert(&transaction, source, reported_at)?;
        }
        apply_retention(&transaction, now)?;
        transaction
            .commit()
            .map_err(|e| storage_failure(StoragePhase::Commit, e.into()))?;
        Ok(())
    }
    /// Check all retained sessions without the display snapshot's row limit.
    pub(crate) fn has_working_since(&self, cutoff: DateTime<Utc>) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE typeof(state) != 'text' OR state NOT IN ('working','done','needs_attention') OR typeof(updated_at) NOT IN ('real','integer') OR updated_at NOT BETWEEN -62135596800 AND 253402300799 OR (state NOT IN ('done','needs_attention') AND updated_at > ?1) UNION ALL SELECT 1 FROM evicted_working WHERE typeof(updated_at) NOT IN ('real','integer') OR updated_at NOT BETWEEN -62135596800 AND 253402300799 OR updated_at > ?1)",
            [cutoff.timestamp_micros() as f64 / 1_000_000.0],
            |row| row.get(0),
        )?)
    }
    pub fn snapshot(&mut self, limit: u8, now: DateTime<Utc>) -> Result<Snapshot> {
        if !(1..=100).contains(&limit) {
            return Err(Error::InvalidArgument);
        }
        self.connection.execute(
            "DELETE FROM sessions WHERE typeof(state) = 'text' AND state IN ('working','done','needs_attention') AND typeof(updated_at) IN ('real','integer') AND updated_at BETWEEN -62135596800 AND 253402300799 AND updated_at < ?1",
            [now.timestamp_micros() as f64 / 1_000_000.0 - RETENTION_SECONDS],
        )?;
        let mut statement=self.connection.prepare("SELECT session_id,agent,project,state,summary,pane_id,updated_at,event_count,kind,since,server FROM sessions LEFT JOIN session_waiting USING (agent,session_id) LEFT JOIN session_pane_server USING (agent,session_id) ORDER BY updated_at DESC,sessions.rowid DESC LIMIT ?1")?;
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
            let rfc3339 = |seconds: f64| {
                DateTime::from_timestamp_micros((seconds * 1_000_000.0).round() as i64)
                    .map(|time| time.to_rfc3339_opts(SecondsFormat::Micros, true))
                    .ok_or(Error::InvalidEvent)
            };
            let updated_at = rfc3339(row.get(6)?)?;
            // Only a report that still needs the user waits; a stale row from a later state is ignored.
            let waiting = row
                .get::<_, Option<String>>(8)?
                .and_then(|kind| Waiting::parse(&kind))
                .filter(|_| state == SessionState::NeedsAttention);
            let waiting_since = match (waiting, row.get::<_, Option<f64>>(9)?) {
                (Some(_), Some(since)) => Some(rfc3339(since)?),
                _ => None,
            };
            sessions.push(SessionSummary {
                event: Event {
                    session_id: row.get(0)?,
                    agent: row.get(1)?,
                    project: row.get(2)?,
                    state,
                    summary: row.get(4)?,
                    pane_id: row.get(5)?,
                    pane_server: row.get(10)?,
                    waiting,
                },
                updated_at,
                waiting_since,
                event_count: u64::try_from(row.get::<_, i64>(7)?)
                    .map_err(|_| Error::InvalidEvent)?,
            });
        }
        Ok(Snapshot {
            schema_version: 1,
            sessions,
            live_agents: None,
            update: None,
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
    const TERMINAL: &str = "0123456789abcdef0123456789abcdef";
    #[test]
    fn names_the_pane_of_tmux_else_zellij_else_a_launched_terminal_and_nothing_malformed() {
        let zellij = |session, pane| identity(None, Some(session), Some(pane), None);
        assert_eq!(
            identity(Some("%4".into()), Some("work"), Some("2"), Some(TERMINAL)),
            Some("%4".into())
        );
        assert_eq!(zellij("work", "2"), Some("zellij:work:2".into()));
        assert_eq!(
            zellij("my:odd name", "12"),
            Some("zellij:my:odd name:12".into())
        );
        for (session, pane) in [
            ("", "2"),
            ("work", ""),
            ("work", "terminal_2"),
            ("work", "-1"),
            ("bad\nname", "2"),
            ("work", "12345678901"),
        ] {
            assert_eq!(zellij(session, pane), None, "{session:?} {pane:?}");
        }
        assert_eq!(identity(None, Some("work"), None, None), None);
        assert_eq!(identity(None, None, None, None), None);
        // A multiplexer started inside a launched terminal inherits its variable and still names its own pane.
        assert_eq!(
            identity(None, Some("work"), Some("2"), Some(TERMINAL)),
            Some("zellij:work:2".into())
        );
        assert_eq!(
            identity(None, None, None, Some(TERMINAL)),
            Some(format!("lazysh:{TERMINAL}"))
        );
        for terminal in [
            "",
            "0123456789ABCDEF0123456789abcdef",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789abcdef0123456789abcde\n",
            "0123456789abcdef0123456789abcdeg",
        ] {
            assert_eq!(
                identity(None, None, None, Some(terminal)),
                None,
                "{terminal:?}"
            );
        }
    }
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
        drop(open_store_bootstrap(directory.path()).unwrap());
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
    fn fixture_event(session_id: &str) -> Event {
        normalize(
            &json!({
                "schemaVersion": 1, "sessionId": session_id, "agent": "Fixture",
                "project": "/synthetic", "state": "working", "summary": "Synthetic fixture"
            }),
            Agent::Generic,
            None,
        )
        .unwrap()
        .unwrap()
    }
    #[test]
    fn stalled_bootstrap_admission_does_not_queue_simultaneous_openers() {
        // Model Windows, where a stat or read of the WAL stalls behind another
        // connection's FlushFileBuffers: every opener stalls 300 ms while it
        // holds the bootstrap lock. Sixteen of them queued on one exclusive
        // lock need 4.8 s, past the shared 3 s wait budget.
        let directory = tempfile::tempdir().unwrap();
        let event = fixture_event("stalled-admission");
        let barrier = std::sync::Barrier::new(16);
        let results = std::thread::scope(|scope| {
            let workers = (0..16)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        let started = Instant::now();
                        Store::open_with_storage_checks(
                            directory.path(),
                            storage_filesystem::require_local,
                            |sidecar| {
                                std::thread::sleep(Duration::from_millis(100));
                                validate_sidecar(sidecar)
                            },
                        )
                        .map_err(|error| (started.elapsed(), error))
                    })
                })
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        // Only the opens race. Sixteen ingests at once would queue on SQLite's single
        // writer, each commit waiting for a disk sync: on a slow disk that exhausts
        // the 3 s budget however admission behaves.
        for result in results {
            let mut store = result.unwrap_or_else(|(elapsed, error)| {
                panic!("simultaneous open failed after {elapsed:?}: {error:?}")
            });
            store.ingest(&event, Utc::now()).unwrap();
        }
        let snapshot = Store::open(directory.path())
            .unwrap()
            .snapshot(50, Utc::now())
            .unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].event_count, 16);
    }
    #[test]
    fn adoption_completes_a_wal_store_that_lacks_current_schema_objects() {
        let directory = tempfile::tempdir().unwrap();
        drop(Store::open(directory.path()).unwrap());
        let legacy = Connection::open(directory.path().join("events.sqlite3")).unwrap();
        legacy
            .execute_batch(
                "DROP INDEX relay_due; DROP TABLE relay_outbox; DROP TABLE relay_policy;",
            )
            .unwrap();
        drop(legacy);
        let mut store = Store::open(directory.path()).unwrap();
        store
            .ingest(&fixture_event("completed-schema"), Utc::now())
            .unwrap();
        let relay_objects: i64 = store
            .connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name IN ('relay_policy','relay_outbox','relay_due')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(relay_objects, 3);
        let journal: String = store
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal, "wal");
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
    fn recent_working_query_checks_all_stored_rows_and_cutoff() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let now = Utc::now();
        let seconds = now.timestamp_micros() as f64 / 1_000_000.0;
        assert!(!store.has_working_since(now).unwrap());
        store.connection.execute(
            "INSERT INTO sessions VALUES ('Test','working','/work','working','Working',NULL,?1,1)",
            [seconds],
        ).unwrap();
        for i in 0..101 {
            store
                .connection
                .execute(
                    "INSERT INTO sessions VALUES ('Test',?1,'/work','done','Done',NULL,?2,1)",
                    params![format!("done-{i}"), seconds + 1.0],
                )
                .unwrap();
        }
        assert!(store
            .has_working_since(now - chrono::TimeDelta::seconds(1))
            .unwrap());
        assert!(!store.has_working_since(now).unwrap());
        store
            .connection
            .execute(
                "UPDATE sessions SET state='future' WHERE session_id='working'",
                [],
            )
            .unwrap();
        assert!(store
            .has_working_since(now - chrono::TimeDelta::seconds(1))
            .unwrap());
    }
    #[test]
    fn invalid_session_timestamps_defer_even_after_retention_evicts_them() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let now = Utc::now();
        for id in ["bad-time", "bad-state", "bad-finite", "bad-unknown"] {
            store.ingest(&fixture_event(id), now).unwrap();
        }
        store
            .connection
            .execute(
                "UPDATE sessions SET updated_at=?1 WHERE session_id='bad-time'",
                [f64::NEG_INFINITY],
            )
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE sessions SET state=x'ff', updated_at=1 WHERE session_id='bad-state'",
                [],
            )
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE sessions SET updated_at=-8900000000000 WHERE session_id='bad-finite'",
                [],
            )
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE sessions SET state='future', updated_at=1 WHERE session_id='bad-unknown'",
                [],
            )
            .unwrap();
        assert!(store
            .has_working_since(now - chrono::TimeDelta::minutes(10))
            .unwrap());
        let _ = store.snapshot(100, now);
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM sessions WHERE session_id IN ('bad-state','bad-finite','bad-unknown')",
                    [],
                    |row| row.get::<_, u32>(0)
                )
                .unwrap(),
            3
        );
        assert!(store
            .has_working_since(now - chrono::TimeDelta::minutes(10))
            .unwrap());
        let mut event = fixture_event("next");
        event.state = SessionState::Done;
        for i in 0..101 {
            event.session_id = format!("later-{i}");
            store
                .ingest(&event, now + chrono::TimeDelta::microseconds(i))
                .unwrap();
        }
        assert!(store
            .has_working_since(now - chrono::TimeDelta::minutes(10))
            .unwrap());
    }

    #[test]
    fn active_query_rejects_timestamps_outside_safe_calendar_range() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let now = Utc::now();
        let mut event = fixture_event("bound");
        event.state = SessionState::Done;
        store.ingest(&event, now).unwrap();
        for (time, invalid) in [
            (-62_135_596_800_i64, false),
            (-62_135_596_801, true),
            (253_402_300_799, false),
            (253_402_300_800, true),
        ] {
            store
                .connection
                .execute(
                    "UPDATE sessions SET updated_at=?1 WHERE session_id='bound'",
                    [time],
                )
                .unwrap();
            assert_eq!(
                store
                    .has_working_since(now - chrono::TimeDelta::minutes(10))
                    .unwrap(),
                invalid,
                "{time}"
            );
        }
    }

    #[test]
    fn retention_records_recent_working_sessions_evicted_by_newer_done_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let now = Utc::now();
        let mut event = fixture_event("working");
        store.ingest(&event, now).unwrap();
        event.state = SessionState::Done;
        for i in 0..101 {
            event.session_id = format!("done-{i}");
            store
                .ingest(&event, now + chrono::TimeDelta::seconds(1))
                .unwrap();
        }
        assert!(store
            .has_working_since(now - chrono::TimeDelta::seconds(1))
            .unwrap());
        assert_eq!(store.snapshot(100, now).unwrap().sessions.len(), 100);
        assert!(!store
            .has_working_since(now + chrono::TimeDelta::seconds(1))
            .unwrap());
        event.session_id = "later".into();
        store
            .ingest(&event, now + chrono::TimeDelta::minutes(11))
            .unwrap();
        assert!(!store
            .has_working_since(now + chrono::TimeDelta::seconds(1))
            .unwrap());
    }
    #[test]
    fn evicted_working_session_defers_until_its_report_expires() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let now = Utc::now();
        let mut event = fixture_event("initial");
        for i in 0..102 {
            event.session_id = format!("session-{i}");
            store
                .ingest(&event, now + chrono::TimeDelta::microseconds(i))
                .unwrap();
        }
        event.state = SessionState::NeedsAttention;
        event.waiting = Some(Waiting::Unknown);
        event.session_id = "new-attention".into();
        store
            .ingest(&event, now + chrono::TimeDelta::milliseconds(500))
            .unwrap();
        assert!(store
            .snapshot(100, now)
            .unwrap()
            .sessions
            .iter()
            .any(|session| session.event.session_id == "new-attention"));
        event.state = SessionState::Done;
        event.waiting = None;
        for i in 2..102 {
            event.session_id = format!("session-{i}");
            store
                .ingest(&event, now + chrono::TimeDelta::seconds(1))
                .unwrap();
        }
        assert_eq!(store.snapshot(100, now).unwrap().sessions.len(), 100);
        assert!(store
            .has_working_since(now - chrono::TimeDelta::seconds(1))
            .unwrap());
        assert!(!store
            .has_working_since(now + chrono::TimeDelta::seconds(1))
            .unwrap());
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
                        pane_server: None,
                        waiting: None,
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
