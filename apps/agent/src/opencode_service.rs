//! Answers an OpenCode permission request or question form, and stops a turn, through the loopback background
//! service the OpenCode 2.x TUI already uses (`opencode service`). The service's own credentials are read here, on the
//! host, from OpenCode's private state file; they are never printed and never leave this process. Nothing is typed into
//! a terminal and hook events stay observational.
//!
//! Every answer is bound to one listed request: its id, the exact text the person saw (a hash that also covers a short
//! expiry), the OpenCode session and, when given, the pane that still shows that session. The request is read again
//! immediately before the reply, and a request that is gone, changed, expired or whose pane changed is refused with
//! nothing sent. The refusals print `{"accepted":false,"reason":...}` and exit successfully so a client can say why.
use crate::{Error, Result, Store};
use base64::Engine;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use clap::{Subcommand, ValueEnum};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    time::Duration as Wait,
};

const EXPIRY: Duration = Duration::seconds(120);
const MAX_BODY: u64 = 1 << 20;
const MAX_ANSWER: usize = 8 * 1024;
const MAX_MESSAGE: usize = 500;
const MAX_REQUESTS: usize = 20;
const MAX_FIELDS: usize = 20;
const MAX_OPTIONS: usize = 50;
const MAX_TEXT: usize = 4096;
const MAX_ITEMS: usize = 32;

#[derive(Clone, Copy, ValueEnum)]
pub enum Decision {
    Once,
    Always,
    Reject,
}
impl Decision {
    fn value(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Reject => "reject",
        }
    }
}

#[derive(Subcommand)]
pub enum Command {
    /// Print the permission requests and question forms the OpenCode service holds for one session.
    List {
        #[arg(long)]
        session_id: String,
    },
    /// Answer one listed request, once.
    Reply {
        #[arg(long)]
        session_id: String,
        #[arg(long)]
        id: String,
        #[arg(long)]
        expected_hash: String,
        /// The listing's `expiresAt`, exactly as printed; it is part of the hash.
        #[arg(long)]
        expires_at: String,
        /// Refuse unless the host's hook reports show only this OpenCode session in this pane.
        #[arg(long)]
        pane_id: Option<String>,
        /// Answer a permission request: once, always (keeps the listed rules) or reject.
        #[arg(long, value_enum)]
        decision: Option<Decision>,
        /// With `--decision reject`: the reason the agent reads.
        #[arg(long)]
        message: Option<String>,
        /// Answer a question form: a JSON object of field key to value.
        #[arg(long)]
        answer: Option<String>,
    },
    /// Stop the turn the session is running, once.
    Abort {
        #[arg(long)]
        session_id: String,
        #[arg(long)]
        pane_id: Option<String>,
    },
}

pub fn run(command: Command) -> Result<Value> {
    let now = Utc::now();
    match command {
        Command::List { session_id } => list(&session_id, now),
        Command::Reply {
            session_id,
            id,
            expected_hash,
            expires_at,
            pane_id,
            decision,
            message,
            answer,
        } => {
            let body = match (decision, answer) {
                (Some(decision), None)
                    if message.is_none() || matches!(decision, Decision::Reject) =>
                {
                    Body::Permission(decision, message)
                }
                (None, Some(answer)) if message.is_none() => Body::Form(answer),
                _ => return Err(Error::InvalidArgument),
            };
            reply(
                &crate::state_directory()?,
                &Resolve {
                    session_id: &session_id,
                    id: &id,
                    expected_hash: &expected_hash,
                    expires_at: &expires_at,
                    pane_id: pane_id.as_deref(),
                    body,
                },
                now,
            )
        }
        Command::Abort {
            session_id,
            pane_id,
        } => abort(
            &crate::state_directory()?,
            &session_id,
            pane_id.as_deref(),
            now,
        ),
    }
}

pub enum Body {
    Permission(Decision, Option<String>),
    Form(String),
}
pub struct Resolve<'a> {
    pub session_id: &'a str,
    pub id: &'a str,
    pub expected_hash: &'a str,
    pub expires_at: &'a str,
    pub pane_id: Option<&'a str>,
    pub body: Body,
}

/// A refusal: nothing was sent to the service.
type Refusal = &'static str;

fn refused(reason: Refusal) -> Value {
    json!({"schemaVersion": 1, "accepted": false, "reason": reason})
}
fn accepted() -> Value {
    json!({"schemaVersion": 1, "accepted": true})
}

struct Service {
    address: SocketAddr,
    authorization: String,
    id: String,
    version: String,
}

fn registry_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| dirs::home_dir().map(|home| home.join(".local/state")))?;
    Some(base.join("opencode/service.json"))
}

fn alive(pid: u64) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks that the process exists.
        unsafe {
            libc::kill(pid, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }
    #[cfg(not(unix))]
    {
        pid > 0
    }
}

/// Only a loopback address is ever contacted, named by IP literal: no name lookup, no redirect.
fn loopback(url: &str) -> Option<SocketAddr> {
    let (host, port) = url
        .strip_prefix("http://")?
        .trim_end_matches('/')
        .rsplit_once(':')?;
    let ip = match host {
        "127.0.0.1" | "localhost" => Ipv4Addr::LOCALHOST.into(),
        "[::1]" => Ipv6Addr::LOCALHOST.into(),
        _ => return None,
    };
    Some(SocketAddr::new(
        ip,
        port.parse().ok().filter(|port| *port != 0)?,
    ))
}

fn discover() -> std::result::Result<Service, Refusal> {
    let path = registry_path().ok_or("no-service")?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| "no-service")?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err("unsafe-registry");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("unsafe-registry");
        }
    }
    let registry: Value = serde_json::from_slice(&fs::read(&path).map_err(|_| "no-service")?)
        .map_err(|_| "unsafe-registry")?;
    let text = |key| {
        registry[key]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 512)
    };
    let (Some(id), Some(version), Some(url), Some(password), Some(pid)) = (
        text("id"),
        text("version"),
        text("url"),
        text("password"),
        registry["pid"].as_u64(),
    ) else {
        return Err("unsafe-registry");
    };
    let address = loopback(url).ok_or("unsafe-address")?;
    if !alive(pid) {
        return Err("stopped");
    }
    let service = Service {
        address,
        authorization: format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"))
        ),
        id: id.into(),
        version: version.into(),
    };
    // Only the 2.x service shape is spoken here; its session list answers with this object.
    if version.split('.').next() != Some("2") {
        return Err("unsupported");
    }
    match service.call("GET", "/api/session/active", None)? {
        (200, body) if body["data"].is_object() => Ok(service),
        (401 | 403, _) => Err("unauthorized"),
        _ => Err("unsupported"),
    }
}

impl Service {
    /// One HTTP/1.0 exchange (no chunked bodies), bounded in time and size.
    fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> std::result::Result<(u16, Value), Refusal> {
        let payload = body.map(Value::to_string);
        let mut request = format!(
            "{method} {path} HTTP/1.0\r\nHost: {}\r\nAuthorization: {}\r\nAccept: application/json\r\nConnection: close\r\n",
            self.address, self.authorization
        );
        if method == "POST" {
            request += &format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                payload.as_ref().map_or(0, String::len)
            );
        }
        request += "\r\n";
        request += payload.as_deref().unwrap_or("");
        let mut stream = TcpStream::connect_timeout(&self.address, Wait::from_secs(2))
            .map_err(|_| "unreachable")?;
        stream
            .set_read_timeout(Some(Wait::from_secs(5)))
            .map_err(|_| "unreachable")?;
        stream
            .set_write_timeout(Some(Wait::from_secs(5)))
            .map_err(|_| "unreachable")?;
        stream
            .write_all(request.as_bytes())
            .map_err(|_| "unreachable")?;
        let mut response = Vec::new();
        stream
            .take(MAX_BODY + 1)
            .read_to_end(&mut response)
            .map_err(|_| "unreachable")?;
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .ok_or("unsupported")?;
        let head = String::from_utf8_lossy(&response[..split]).to_ascii_lowercase();
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .ok_or("unsupported")?;
        let body = &response[split + 4..];
        if body.len() as u64 > MAX_BODY || head.contains("transfer-encoding: chunked") {
            return Err("unsupported");
        }
        Ok((
            status,
            if body.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(body).map_err(|_| "unsupported")?
            },
        ))
    }
    fn running(&self, session: &str) -> std::result::Result<bool, Refusal> {
        match self.call("GET", "/api/session/active", None)? {
            (200, body) => Ok(body["data"].get(session).is_some()),
            _ => Err("unsupported"),
        }
    }
}

fn id_like(value: &str, prefix: &str) -> bool {
    value.len() <= 128
        && value.strip_prefix(prefix).is_some_and(|rest| {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
}
fn text(value: &Value, max: usize) -> Option<String> {
    value
        .as_str()
        .filter(|text| text.chars().count() <= max)
        .map(str::to_owned)
}
/// The strings of a list when it fits the bounds; otherwise a cut-down copy and `false`, which makes the request unanswerable here.
fn strings(value: &Value, items: usize, max: usize) -> (Vec<String>, bool) {
    let list = value.as_array().map_or(&[][..], Vec::as_slice);
    let kept: Vec<String> = list
        .iter()
        .take(items)
        .filter_map(|item| item.as_str())
        .map(|item| item.chars().take(max).collect())
        .collect();
    let complete = kept.len() == list.len()
        && list
            .iter()
            .zip(&kept)
            .all(|(item, kept)| item.as_str() == Some(kept));
    (kept, complete)
}

/// A request as listed: its id, what the person sees, and whether it can be answered from here.
struct Item {
    kind: &'static str,
    id: String,
    content: Value,
    supported: bool,
}

fn permission(item: &Value, session: &str) -> Option<Item> {
    let id = text(&item["id"], 128).filter(|id| id_like(id, "per_"))?;
    if item["sessionID"].as_str() != Some(session) {
        return None;
    }
    let (resources, whole) = strings(&item["resources"], MAX_ITEMS, MAX_TEXT);
    let (save, saved) = strings(&item["save"], MAX_ITEMS, MAX_TEXT);
    let action = text(&item["action"], 256);
    let mut content = Map::new();
    content.insert("action".into(), action.clone().unwrap_or_default().into());
    content.insert("resources".into(), resources.into());
    content.insert("save".into(), save.into());
    if let Some(message) = item["message"].as_str() {
        content.insert(
            "message".into(),
            message.chars().take(MAX_TEXT).collect::<String>().into(),
        );
    }
    Some(Item {
        kind: "permission",
        id,
        content: content.into(),
        supported: whole && saved && action.is_some(),
    })
}

fn field(item: &Value) -> Option<(Value, bool)> {
    let kind = item["type"].as_str()?;
    let key = text(&item["key"], 128).filter(|key| !key.is_empty())?;
    let mut field = Map::new();
    field.insert("key".into(), key.into());
    field.insert("type".into(), kind.into());
    let mut whole = ["string", "multiselect", "boolean", "number", "integer"].contains(&kind)
        && item
            .get("hidden")
            .is_none_or(|hidden| hidden == &Value::Bool(false))
        && item.get("when").is_none();
    for name in ["title", "description"] {
        if let Some(value) = item[name].as_str() {
            whole &= value.chars().count() <= MAX_TEXT;
            field.insert(
                name.into(),
                value.chars().take(MAX_TEXT).collect::<String>().into(),
            );
        }
    }
    for name in ["required", "custom"] {
        if let Some(value) = item[name].as_bool() {
            field.insert(name.into(), value.into());
        }
    }
    if let Some(options) = item["options"].as_array() {
        whole &= options.len() <= MAX_OPTIONS;
        let options: Vec<Value> = options
            .iter()
            .take(MAX_OPTIONS)
            .filter_map(|option| {
                let value = text(&option["value"], 512)?;
                let label = text(&option["label"], 512)?;
                let description = text(&option["description"], 512);
                Some(json!({"value": value, "label": label, "description": description}))
            })
            .collect();
        field.insert("options".into(), options.into());
    }
    Some((field.into(), whole))
}

fn form(item: &Value, session: &str) -> Option<Item> {
    let id = text(&item["id"], 128).filter(|id| id_like(id, "frm_"))?;
    if item["sessionID"].as_str() != Some(session) {
        return None;
    }
    let raw = item["fields"]
        .as_array()
        .filter(|fields| !fields.is_empty())?;
    let fields: Vec<(Value, bool)> = raw.iter().take(MAX_FIELDS).filter_map(field).collect();
    let supported = fields.len() == raw.len() && fields.iter().all(|(_, whole)| *whole);
    let content = json!({"title": text(&item["title"], MAX_TEXT), "fields": fields.into_iter().map(|(field, _)| field).collect::<Vec<_>>()});
    Some(Item {
        kind: "form",
        id,
        content,
        supported,
    })
}

fn digest(service: &Service, session: &str, item: &Item, expires: &str) -> String {
    let identity = json!([
        1,
        service.id,
        session,
        item.kind,
        item.id,
        item.content,
        item.supported,
        expires
    ]);
    format!("{:x}", Sha256::digest(identity.to_string()))
}

fn listed(
    service: &Service,
    session: &str,
    kind: &str,
) -> std::result::Result<Vec<Value>, Refusal> {
    match service.call("GET", &format!("/api/session/{session}/{kind}"), None)? {
        (200, body) => Ok(body["data"].as_array().cloned().unwrap_or_default()),
        (404, _) => Ok(Vec::new()),
        _ => Err("unsupported"),
    }
}

fn valid_session(session: &str) -> Result<()> {
    id_like(session, "ses")
        .then_some(())
        .ok_or(Error::InvalidArgument)
}
fn valid_pane(pane: &str) -> Result<()> {
    (pane.len() <= 32
        && pane
            .strip_prefix('%')
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())))
    .then_some(())
    .ok_or(Error::InvalidArgument)
}

pub fn list(session: &str, now: DateTime<Utc>) -> Result<Value> {
    valid_session(session)?;
    let unavailable = |reason| json!({"schemaVersion": 1, "service": {"available": false, "reason": reason}, "running": false, "requests": []});
    let service = match discover() {
        Ok(service) => service,
        Err(reason) => return Ok(unavailable(reason)),
    };
    let expires = (now + EXPIRY).to_rfc3339_opts(SecondsFormat::Secs, true);
    let read = || -> std::result::Result<(bool, Vec<Item>), Refusal> {
        let mut items: Vec<Item> = listed(&service, session, "permission")?
            .iter()
            .filter_map(|item| permission(item, session))
            .collect();
        items.extend(
            listed(&service, session, "form")?
                .iter()
                .filter_map(|item| form(item, session)),
        );
        Ok((service.running(session)?, items))
    };
    let Ok((running, items)) = read() else {
        return Ok(unavailable("unreachable"));
    };
    let requests: Vec<Value> = items
        .iter()
        .take(MAX_REQUESTS)
        .map(|item| {
            let mut entry = item.content.as_object().cloned().unwrap_or_default();
            entry.extend([
                ("kind".into(), item.kind.into()),
                ("id".into(), item.id.clone().into()),
                ("supported".into(), item.supported.into()),
                (
                    "expectedHash".into(),
                    digest(&service, session, item, &expires).into(),
                ),
                ("expiresAt".into(), expires.clone().into()),
            ]);
            Value::Object(entry)
        })
        .collect();
    Ok(
        json!({"schemaVersion": 1, "service": {"available": true, "shape": "v2", "version": service.version}, "sessionId": session, "running": running, "requests": requests}),
    )
}

/// Serialises every answer of this host, so a second resolver reads the request again only after the first finished.
fn exclusive(state: &Path) -> Result<fs::File> {
    fs::create_dir_all(state)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("opencode-service.lock"))?;
    lock.lock()?;
    Ok(lock)
}

/// Exactly one hook-reported OpenCode session names this pane, and it is this one.
fn pane_shows(state: &Path, pane: &str, session: &str, now: DateTime<Utc>) -> Result<bool> {
    valid_pane(pane)?;
    let snapshot = Store::open(state)?.snapshot(100, now)?;
    let mut rows = snapshot
        .sessions
        .iter()
        .filter(|row| row.event.pane_id.as_deref() == Some(pane));
    Ok(
        matches!((rows.next(), rows.next()), (Some(row), None) if row.event.agent == "OpenCode" && row.event.session_id == session),
    )
}

fn answer_for(content: &Value, raw: &str) -> Option<Value> {
    let answer: Map<String, Value> = serde_json::from_str(raw)
        .ok()
        .filter(|_| raw.len() <= MAX_ANSWER)?;
    let fields = content["fields"].as_array()?;
    let known = |key: &str| fields.iter().find(|field| field["key"] == key);
    let fits = |value: &Value, kind: &str| match kind {
        "string" => value
            .as_str()
            .is_some_and(|text| text.chars().count() <= MAX_TEXT),
        "multiselect" => value.as_array().is_some_and(|list| {
            list.len() <= MAX_OPTIONS
                && list.iter().all(|item| {
                    item.as_str()
                        .is_some_and(|text| text.chars().count() <= 512)
                })
        }),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        _ => value.is_i64() || value.is_u64(),
    };
    let typed = answer.iter().all(|(key, value)| {
        known(key).is_some_and(|field| fits(value, field["type"].as_str().unwrap_or_default()))
    });
    let complete = fields.iter().all(|field| {
        field["required"] != true || answer.contains_key(field["key"].as_str().unwrap_or_default())
    });
    (typed && complete).then(|| answer.into())
}

pub fn reply(state: &Path, resolve: &Resolve, now: DateTime<Utc>) -> Result<Value> {
    valid_session(resolve.session_id)?;
    let (kind, prefix) = match resolve.body {
        Body::Permission(..) => ("permission", "per_"),
        Body::Form(_) => ("form", "frm_"),
    };
    if !id_like(resolve.id, prefix)
        || resolve.expected_hash.len() != 64
        || !resolve.expected_hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(Error::InvalidArgument);
    }
    if let Body::Permission(_, Some(message)) = &resolve.body {
        if message.trim().is_empty()
            || message.chars().count() > MAX_MESSAGE
            || message.chars().any(char::is_control)
        {
            return Err(Error::InvalidArgument);
        }
    }
    let expires =
        DateTime::parse_from_rfc3339(resolve.expires_at).map_err(|_| Error::InvalidArgument)?;
    if now >= expires {
        return Ok(refused("expired"));
    }
    let _lock = exclusive(state)?;
    let service = match discover() {
        Ok(service) => service,
        Err(_) => return Ok(refused("unavailable")),
    };
    if let Some(pane) = resolve.pane_id {
        if !pane_shows(state, pane, resolve.session_id, now)? {
            return Ok(refused("pane"));
        }
    }
    let session = resolve.session_id;
    let path = format!("/api/session/{session}/{kind}/{}", resolve.id);
    let fresh = match service.call("GET", &path, None) {
        Ok((200, body)) => body["data"].clone(),
        Ok((404, _)) => return Ok(refused("gone")),
        Ok(_) | Err(_) => return Ok(refused("unavailable")),
    };
    // A form that is no longer pending was answered or dismissed since it was listed.
    if kind == "form" && fresh["state"]["status"] != "pending" {
        return Ok(refused("gone"));
    }
    let Some(item) = (if kind == "form" {
        form(&fresh, session)
    } else {
        permission(&fresh, session)
    })
    .filter(|item| item.id == resolve.id) else {
        return Ok(refused("changed"));
    };
    if digest(&service, session, &item, resolve.expires_at)
        != resolve.expected_hash.to_ascii_lowercase()
    {
        return Ok(refused("changed"));
    }
    if !item.supported {
        return Ok(refused("unsupported"));
    }
    let payload = match &resolve.body {
        // A rule is kept only when the person could read exactly which rules.
        Body::Permission(Decision::Always, _)
            if item.content["save"].as_array().is_none_or(Vec::is_empty) =>
        {
            return Ok(refused("unsupported"))
        }
        Body::Permission(decision, message) => {
            let mut payload = json!({"decision": decision.value()});
            if let Some(message) = message {
                payload["message"] = message.as_str().into();
            }
            payload
        }
        Body::Form(raw) => match answer_for(&item.content, raw) {
            Some(answer) => json!({"answer": answer}),
            None => return Ok(refused("invalid")),
        },
    };
    Ok(
        match service.call("POST", &format!("{path}/reply"), Some(&payload)) {
            Ok((204, _)) => accepted(),
            Ok((404 | 409, _)) => refused("gone"),
            Ok((400, _)) => refused("invalid"),
            Ok(_) => refused("refused"),
            Err(_) => refused("unavailable"),
        },
    )
}

pub fn abort(state: &Path, session: &str, pane: Option<&str>, now: DateTime<Utc>) -> Result<Value> {
    valid_session(session)?;
    let _lock = exclusive(state)?;
    let Ok(service) = discover() else {
        return Ok(refused("unavailable"));
    };
    if let Some(pane) = pane {
        if !pane_shows(state, pane, session, now)? {
            return Ok(refused("pane"));
        }
    }
    match service.running(session) {
        Ok(true) => {}
        Ok(false) => return Ok(refused("idle")),
        Err(_) => return Ok(refused("unavailable")),
    }
    Ok(
        match service.call("POST", &format!("/api/session/{session}/interrupt"), None) {
            Ok((200, body)) if body["interrupted"] == true => accepted(),
            Ok((200, _)) => refused("idle"),
            Ok(_) => refused("refused"),
            Err(_) => refused("unavailable"),
        },
    )
}
