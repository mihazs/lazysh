use super::discovery::{DiscoveredSession, Discovery};
use super::{
    block, content, open_transcript, string, validate_message, Error, Result, TranscriptAgent,
    TranscriptPage, MAX_LINE, MAX_PAGE,
};
use rusqlite::{limits::Limit, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

fn open_database(path: &Path) -> Result<Connection> {
    let _file = open_transcript(path)?;
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_secs(2))?;
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, (MAX_LINE * 2) as i32)?;
    connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 65536)?;
    connection.set_limit(Limit::SQLITE_LIMIT_COLUMN, 128)?;
    let started = Instant::now();
    let mut callbacks = 0;
    connection.progress_handler(
        10000,
        Some(move || {
            callbacks += 1;
            callbacks > 1000 || started.elapsed() > Duration::from_secs(2)
        }),
    )?;
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN;")?;
    Ok(connection)
}
fn timestamp(seconds: f64) -> Result<String> {
    if !seconds.is_finite() {
        return Err(Error::InvalidEvent);
    }
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis((seconds * 1000.0) as i64)
        .map(|time| time.to_rfc3339())
        .ok_or(Error::InvalidEvent)
}

pub fn read_database_page(
    path: &Path,
    agent: TranscriptAgent,
    session_id: &str,
    offset: u64,
    limit: u8,
) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit)
        || session_id.is_empty()
        || session_id.len() > 256
        || offset > i64::MAX as u64
    {
        return Err(Error::InvalidArgument);
    }
    let connection = open_database(path)?;
    let sql=match agent {
        TranscriptAgent::Hermes=>"SELECT id,role,content,tool_call_id,tool_calls,tool_name,timestamp FROM messages WHERE session_id=?1 AND id>=?2 AND active=1 AND compacted=0 ORDER BY id LIMIT 201",
        TranscriptAgent::Opencode=>"SELECT seq,id,type,data,time_created FROM session_message WHERE session_id=?1 AND seq>=?2 ORDER BY seq LIMIT 201",
        _=>return Err(Error::InvalidArgument),
    };
    let mut statement = connection.prepare(sql)?;
    let mut rows = statement.query(rusqlite::params![session_id, offset as i64])?;
    let mut messages = Vec::new();
    let mut next_offset = offset;
    let mut output_bytes = 0;
    let mut has_more = false;
    let mut examined = 0;
    while let Some(row) = rows.next()? {
        if examined == 200 {
            has_more = true;
            break;
        }
        let cursor: u64 = row
            .get::<_, i64>(0)?
            .try_into()
            .map_err(|_| Error::InvalidEvent)?;
        let message = match agent {
            TranscriptAgent::Hermes => hermes_message(row)?,
            TranscriptAgent::Opencode => opencode_message(row)?,
            _ => return Err(Error::InvalidArgument),
        };
        if let Some(message) = message {
            validate_message(&message)?;
            let size = serde_json::to_vec(&message)
                .map_err(|_| Error::InvalidEvent)?
                .len();
            if size > MAX_PAGE {
                return Err(Error::InvalidEvent);
            }
            if messages.len() == usize::from(limit) || output_bytes + size > MAX_PAGE {
                has_more = true;
                break;
            }
            output_bytes += size;
            messages.push(message);
        }
        next_offset = cursor.checked_add(1).ok_or(Error::InvalidEvent)?;
        examined += 1;
    }
    Ok(TranscriptPage {
        schema_version: 1,
        view: "record_stream",
        agent,
        messages,
        next_offset,
        has_more,
        branch_id: None,
        truncated: false,
        checkpoint: None,
    })
}

fn hermes_message(row: &rusqlite::Row<'_>) -> Result<Option<Value>> {
    let role: String = row.get(1)?;
    if !matches!(role.as_str(), "user" | "assistant" | "tool") {
        return Ok(None);
    }
    let raw: Option<String> = row.get(2)?;
    let decoded = raw
        .as_deref()
        .and_then(|text| text.strip_prefix("\0json:"))
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|_| Error::InvalidEvent)?;
    let mut blocks =
        content(&decoded.unwrap_or_else(|| raw.map(Value::String).unwrap_or(Value::Null)));
    if role == "tool" {
        blocks = vec![block(
            "tool_result",
            blocks
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            row.get(3)?,
            row.get(5)?,
        )];
    }
    if let Some(raw) = row.get::<_, Option<String>>(4)? {
        let calls: Value = serde_json::from_str(&raw).map_err(|_| Error::InvalidEvent)?;
        for call in calls.as_array().ok_or(Error::InvalidEvent)? {
            blocks.push(block(
                "tool_use",
                string(&call["function"], "arguments").unwrap_or_default(),
                string(call, "id"),
                string(&call["function"], "name"),
            ));
        }
    }
    if blocks.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        json!({"id":format!("hermes-{}",row.get::<_,i64>(0)?),"role":role,"blocks":blocks,"timestamp":timestamp(row.get(6)?)?}),
    ))
}
fn opencode_message(row: &rusqlite::Row<'_>) -> Result<Option<Value>> {
    let role: String = row.get(2)?;
    if !matches!(role.as_str(), "user" | "assistant") {
        return Ok(None);
    }
    let raw: String = row.get(3)?;
    let data: Value = serde_json::from_str(&raw).map_err(|_| Error::InvalidEvent)?;
    let mut blocks = Vec::new();
    if role == "user" {
        if let Some(text) = string(&data, "text") {
            blocks.push(block("text", text, None, None));
        }
        if data["files"]
            .as_array()
            .is_some_and(|files| !files.is_empty())
        {
            blocks.push(block(
                "image",
                "Attachments: view in the host agent terminal".into(),
                None,
                None,
            ));
        }
    } else {
        for item in data["content"].as_array().into_iter().flatten() {
            match item["type"].as_str() {
                Some("text") => {
                    if let Some(text) = string(item, "text") {
                        blocks.push(block("text", text, None, None));
                    }
                }
                Some("reasoning") => {
                    if let Some(text) = string(item, "text") {
                        blocks.push(block("thinking", text, None, None));
                    }
                }
                Some("tool") => {
                    if let Some(input) = item["state"].get("input") {
                        let text = input
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| input.to_string());
                        blocks.push(block(
                            "tool_use",
                            text,
                            string(item, "id"),
                            string(item, "name"),
                        ));
                    }
                    if let Some(output) = item["state"].get("content") {
                        let text = content(output)
                            .iter()
                            .filter_map(|part| part["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        blocks.push(block(
                            "tool_result",
                            text,
                            string(item, "id"),
                            string(item, "name"),
                        ));
                    }
                }
                _ => {}
            }
        }
    }
    if blocks.is_empty() {
        return Ok(None);
    }
    let mut message = json!({"id":row.get::<_,String>(1)?,"role":role,"blocks":blocks,"timestamp":timestamp(row.get::<_,i64>(4)? as f64/1000.0)?});
    let mut usage = serde_json::Map::new();
    for (pointer, key) in [
        ("/tokens/input", "inputTokens"),
        ("/tokens/output", "outputTokens"),
        ("/tokens/cache/read", "cacheReadTokens"),
        ("/tokens/cache/write", "cacheWriteTokens"),
    ] {
        if let Some(count) = data.pointer(pointer).and_then(Value::as_u64) {
            usage.insert(key.into(), json!(count));
        }
    }
    if !usage.is_empty() {
        message["usage"] = json!(usage);
    }
    Ok(Some(message))
}

pub(super) fn discover_database(
    agent: TranscriptAgent,
    root: Option<&Path>,
    limit: u8,
) -> Result<Discovery> {
    let filename = match agent {
        TranscriptAgent::Hermes => "state.db",
        TranscriptAgent::Opencode => "opencode.db",
        _ => return Err(Error::InvalidArgument),
    };
    let path = match root {
        Some(root) => {
            if root.is_dir() {
                root.join(filename)
            } else {
                root.to_path_buf()
            }
        }
        None => match agent {
            TranscriptAgent::Hermes => {
                let home = std::env::var_os("HERMES_HOME")
                    .map(PathBuf::from)
                    .or_else(|| {
                        #[cfg(windows)]
                        {
                            dirs::data_local_dir().map(|home| home.join("hermes"))
                        }
                        #[cfg(not(windows))]
                        {
                            dirs::home_dir().map(|home| home.join(".hermes"))
                        }
                    })
                    .ok_or(Error::InvalidArgument)?;
                home.join(filename)
            }
            TranscriptAgent::Opencode => std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".local/share")))
                .ok_or(Error::InvalidArgument)?
                .join("opencode")
                .join(filename),
            _ => return Err(Error::InvalidArgument),
        },
    };
    let mut discovery = Discovery {
        schema_version: 1,
        agent,
        sessions: Vec::new(),
        truncated: false,
    };
    if !path.try_exists()? {
        return Ok(discovery);
    }
    let path_text = path
        .to_str()
        .filter(|text| text.len() <= 4096)
        .ok_or(Error::InvalidArgument)?;
    let connection = open_database(&path)?;
    let sql=match agent {
        TranscriptAgent::Hermes=>"SELECT id,substr(COALESCE(title,id),1,512),COALESCE(last_activity_at,started_at) FROM sessions WHERE hidden=0 ORDER BY COALESCE(last_activity_at,started_at) DESC LIMIT ?1",
        TranscriptAgent::Opencode=>"SELECT id,substr(COALESCE(title,id),1,512),time_updated/1000.0 FROM session_v2 ORDER BY time_updated DESC LIMIT ?1",
        _=>return Err(Error::InvalidArgument),
    };
    let mut statement = connection.prepare(sql)?;
    let mut rows = statement.query([u16::from(limit) + 1])?;
    let metadata = std::fs::metadata(&path)?;
    while let Some(row) = rows.next()? {
        if discovery.sessions.len() == usize::from(limit) {
            discovery.truncated = true;
            break;
        }
        let id: String = row.get(0)?;
        if id.is_empty() || id.len() > 256 {
            return Err(Error::InvalidEvent);
        }
        discovery.sessions.push(DiscoveredSession {
            path: path_text.into(),
            name: row.get(1)?,
            modified_at: timestamp(row.get(2)?)?,
            bytes: metadata.len(),
            modified: SystemTime::UNIX_EPOCH,
            session_id: Some(id),
        });
    }
    Ok(discovery)
}
