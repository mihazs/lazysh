use crate::{Error, Result, Store, MAX_INPUT};
use chrono::{SecondsFormat, Utc};
use clap::ValueEnum;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_TOOL_INPUT: usize = 16 * 1024;
const MAX_PENDING: i64 = 32;

#[derive(Clone, Copy, ValueEnum)]
pub enum ApprovalAgent {
    Claude,
}
#[derive(Clone, Copy, ValueEnum)]
pub enum Decision {
    Allow,
    Deny,
}
impl Decision {
    fn value(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub expected_hash: String,
    pub agent: &'static str,
    pub session_id: String,
    pub project: String,
    pub pane_id: Option<String>,
    pub tool_name: String,
    pub tool_input: Value,
    pub created_at: String,
    pub expires_at: String,
}

struct ApprovalStore {
    store: Store,
    directory: PathBuf,
}
impl ApprovalStore {
    fn open(directory: &Path) -> Result<Self> {
        let directory = directory.join("approvals");
        let store = Store::open(&directory)?;
        store
            .connection
            .set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH, 64 * 1024)?;
        store.connection.execute_batch(
            "PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS approvals (
                id TEXT PRIMARY KEY, hash TEXT NOT NULL, session_id TEXT NOT NULL,
                project TEXT NOT NULL, pane_id TEXT, tool_name TEXT NOT NULL,
                tool_input TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
                decision TEXT CHECK(decision IN ('allow','deny')));",
        )?;
        Ok(Self { store, directory })
    }
    fn lease_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.lease"))
    }
    fn clean(&mut self) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let ids: Vec<(String, i64)> = self
            .store
            .connection
            .prepare("SELECT id,expires FROM approvals LIMIT 64")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        for (id, expires) in ids {
            if !valid_id(&id) {
                return Err(Error::InvalidEvent);
            }
            if expires <= now || !waiting(&self.lease_path(&id))? {
                self.store
                    .connection
                    .execute("DELETE FROM approvals WHERE id=?1", [&id])?;
                let _ = fs::remove_file(self.lease_path(&id));
            }
        }
        Ok(())
    }
}

fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
}
fn request_hash(request: &Request) -> Result<String> {
    let mut immutable = request.clone();
    immutable.expected_hash.clear();
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&immutable).map_err(|_| Error::InvalidEvent)?)
    ))
}
fn lease_options(create: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options
}
fn waiting(path: &Path) -> Result<bool> {
    let file = match lease_options(false).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !file.metadata()?.is_file() {
        return Err(Error::InvalidEvent);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata()?.nlink() != 1 {
            return Err(Error::InvalidEvent);
        }
    }
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}
fn string(payload: &Value, key: &str, max: usize) -> Result<String> {
    let value = payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Error::InvalidEvent)?;
    crate::text(value, max)?;
    Ok(value.into())
}
fn hook_request(mut input: impl Read, pane: Option<&str>, timeout: u16) -> Result<Request> {
    if !(1..=600).contains(&timeout) {
        return Err(Error::InvalidArgument);
    }
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(MAX_INPUT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_INPUT {
        return Err(Error::InvalidEvent);
    }
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidEvent)?;
    if payload.get("hook_event_name").and_then(Value::as_str) != Some("PermissionRequest") {
        return Err(Error::InvalidEvent);
    }
    let session_id = string(&payload, "session_id", 256)?;
    let project = string(&payload, "cwd", 4096)?;
    let tool_name = string(&payload, "tool_name", 256)?;
    let tool_input = payload
        .get("tool_input")
        .filter(|value| value.is_object())
        .ok_or(Error::InvalidEvent)?
        .clone();
    if serde_json::to_vec(&tool_input)
        .map_err(|_| Error::InvalidEvent)?
        .len()
        > MAX_TOOL_INPUT
    {
        return Err(Error::InvalidEvent);
    }
    let pane_id = pane.map(str::to_owned);
    if pane_id.as_ref().is_some_and(|pane| {
        !pane.starts_with('%')
            || pane.len() < 2
            || pane.len() > 32
            || !pane[1..].bytes().all(|c| c.is_ascii_digit())
    }) {
        return Err(Error::InvalidEvent);
    }
    let now = Utc::now();
    let mut request = Request {
        id: uuid::Uuid::new_v4().to_string(),
        expected_hash: String::new(),
        agent: "claude",
        session_id,
        project,
        pane_id,
        tool_name,
        tool_input,
        created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: (now + chrono::Duration::seconds(i64::from(timeout)))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    request.expected_hash = request_hash(&request)?;
    Ok(request)
}

struct Pending {
    store: ApprovalStore,
    id: String,
    lease: Option<File>,
}
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = self
            .store
            .store
            .connection
            .execute("DELETE FROM approvals WHERE id=?1", [&self.id]);
        self.lease.take();
        let _ = fs::remove_file(self.store.lease_path(&self.id));
    }
}

pub fn request(
    directory: &Path,
    input: impl Read,
    _agent: ApprovalAgent,
    pane: Option<&str>,
    timeout: u16,
) -> Result<Value> {
    let request = hook_request(input, pane, timeout)?;
    let mut store = ApprovalStore::open(directory)?;
    store.clean()?;
    let lease = lease_options(true).open(store.lease_path(&request.id))?;
    let mut pending = Pending {
        store,
        id: request.id.clone(),
        lease: Some(lease),
    };
    pending
        .lease
        .as_ref()
        .ok_or(Error::InvalidEvent)?
        .try_lock()
        .map_err(|_| Error::InvalidEvent)?;
    let transaction = pending
        .store
        .store
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let count: i64 =
        transaction.query_row("SELECT COUNT(*) FROM approvals", [], |row| row.get(0))?;
    if count >= MAX_PENDING {
        return Err(Error::InvalidEvent);
    }
    let created = chrono::DateTime::parse_from_rfc3339(&request.created_at)
        .map_err(|_| Error::InvalidEvent)?
        .timestamp_millis();
    let expires = chrono::DateTime::parse_from_rfc3339(&request.expires_at)
        .map_err(|_| Error::InvalidEvent)?
        .timestamp_millis();
    transaction.execute(
        "INSERT INTO approvals VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL)",
        params![
            request.id,
            request.expected_hash,
            request.session_id,
            request.project,
            request.pane_id,
            request.tool_name,
            serde_json::to_string(&request.tool_input).map_err(|_| Error::InvalidEvent)?,
            created,
            expires
        ],
    )?;
    transaction.commit()?;
    let payload = json!({"session_id":request.session_id,"cwd":request.project,"hook_event_name":"PermissionRequest","tool_name":request.tool_name});
    if let Some(event) =
        crate::normalize(&payload, crate::Agent::Claude, request.pane_id.as_deref())?
    {
        Store::open(directory)?.ingest(&event, Utc::now())?;
    }
    let deadline = Instant::now() + Duration::from_secs(u64::from(timeout));
    let decision = loop {
        if Instant::now() >= deadline {
            break "deny";
        }
        let decision: Option<Option<String>> = pending
            .store
            .store
            .connection
            .query_row(
                "SELECT decision FROM approvals WHERE id=?1 AND hash=?2 AND expires>?3",
                params![
                    request.id,
                    request.expected_hash,
                    Utc::now().timestamp_millis()
                ],
                |row| row.get(0),
            )
            .optional()?;
        match decision {
            Some(Some(decision)) => break if decision == "allow" { "allow" } else { "deny" },
            None => break "deny",
            _ => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    let decision = if decision == "deny" {
        json!({"behavior":"deny","message":"Permission denied or expired in lazysh."})
    } else {
        json!({"behavior":"allow"})
    };
    Ok(json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":decision}}))
}

pub fn list(directory: &Path, limit: u8) -> Result<Value> {
    if !(1..=20).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    let mut store = ApprovalStore::open(directory)?;
    store.clean()?;
    let mut statement = store.store.connection.prepare("SELECT id,hash,session_id,project,pane_id,tool_name,tool_input,created,expires FROM approvals WHERE decision IS NULL AND expires>?1 ORDER BY created,id LIMIT ?2")?;
    let rows = statement.query_map(params![Utc::now().timestamp_millis(), limit], |row| {
        let created: i64 = row.get(7)?;
        let expires: i64 = row.get(8)?;
        let tool_input: String = row.get(6)?;
        let request = Request {
            id: row.get(0)?,
            expected_hash: row.get(1)?,
            agent: "claude",
            session_id: row.get(2)?,
            project: row.get(3)?,
            pane_id: row.get(4)?,
            tool_name: row.get(5)?,
            tool_input: serde_json::from_str(&tool_input)
                .map_err(|_| rusqlite::Error::InvalidQuery)?,
            created_at: chrono::DateTime::from_timestamp_millis(created)
                .ok_or(rusqlite::Error::InvalidQuery)?
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: chrono::DateTime::from_timestamp_millis(expires)
                .ok_or(rusqlite::Error::InvalidQuery)?
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        if request_hash(&request).map_err(|_| rusqlite::Error::InvalidQuery)?
            != request.expected_hash
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        Ok(request)
    })?;
    let requests: Vec<Request> = rows.collect::<std::result::Result<_, _>>()?;
    Ok(json!({"schemaVersion":1,"requests":requests}))
}

pub fn resolve(
    directory: &Path,
    id: &str,
    hash: &str,
    session_id: &str,
    pane_id: Option<&str>,
    decision: Decision,
) -> Result<Value> {
    if !valid_id(id) || hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::InvalidArgument);
    }
    crate::text(session_id, 256)?;
    let mut store = ApprovalStore::open(directory)?;
    store.clean()?;
    if !waiting(&store.lease_path(id))? {
        return Err(Error::InvalidEvent);
    }
    let changed = store.store.connection.execute("UPDATE approvals SET decision=?1 WHERE id=?2 AND hash=?3 AND session_id=?4 AND pane_id IS ?5 AND decision IS NULL AND expires>?6", params![decision.value(), id, hash, session_id, pane_id, Utc::now().timestamp_millis()])?;
    if changed != 1 {
        return Err(Error::InvalidEvent);
    }
    Ok(json!({"schemaVersion":1,"accepted":true}))
}

pub fn config() -> Value {
    json!({"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"lazysh-agent approval-request --agent claude --timeout-seconds 300","timeout":310}]}]}})
}
