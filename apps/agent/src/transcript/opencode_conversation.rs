//! Read the selected OpenCode projection, never the model-context replay log.
use super::{
    block, database, interaction, open_transcript, Error, Result, SourceSnapshot, TranscriptAgent,
    TranscriptPage, MAX_PAGE,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

const MAX_ROWS: usize = 10_000;
const MAX_INPUT: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Schema {
    V1,
    V2,
}

pub(super) fn table(db: &Connection, name: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )?)
}

pub(super) fn schema(db: &Connection, session: &str) -> Result<Schema> {
    // V2 migration retains the legacy session table. A projected V2 session wins.
    for (name, kind) in [("session_v2", Schema::V2), ("session", Schema::V1)] {
        if table(db, name)?
            && db.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {name} WHERE id=?1)"),
                [session],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Ok(kind);
        }
    }
    Err(Error::InvalidEvent)
}

fn decoded(raw: &str, bytes: &mut usize) -> Result<Value> {
    *bytes = bytes.checked_add(raw.len()).ok_or(Error::InvalidEvent)?;
    if *bytes > MAX_INPUT {
        return Err(Error::InvalidEvent);
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| Error::InvalidEvent)?;
    if !value.is_object() {
        return Err(Error::InvalidEvent);
    }
    Ok(value)
}

struct Row {
    id: String,
    role: String,
    data: Value,
    time: i64,
}

pub fn conversation(path: &Path, session: &str, limit: u8) -> Result<TranscriptPage> {
    if session.is_empty()
        || session.len() > 256
        || session.chars().any(char::is_control)
        || !(1..=100).contains(&limit)
    {
        return Err(Error::InvalidArgument);
    }
    let original = open_transcript(path)?;
    let identity = SourceSnapshot::capture(&original)?;
    let db = database::open_database(path)?;
    identity.same_file(&open_transcript(path)?)?;
    let kind = schema(&db, session)?;
    let name = if kind == Schema::V2 {
        "session_v2"
    } else {
        "session"
    };
    let raw: Option<String> = db.query_row(
        &format!("SELECT revert FROM {name} WHERE id=?1"),
        [session],
        |r| r.get(0),
    )?;
    let boundary = raw
        .map(|raw| -> Result<String> {
            let value: Value = serde_json::from_str(&raw).map_err(|_| Error::InvalidEvent)?;
            value["messageID"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .map(str::to_owned)
                .ok_or(Error::InvalidEvent)
        })
        .transpose()?;
    let mut queued = HashSet::new();
    if kind == Schema::V2 {
        let mut query = db.prepare("SELECT id FROM session_inbox WHERE session_id=?1 AND type='user' AND delivery='queue' LIMIT 10001")?;
        for id in query.query_map([session], |r| r.get::<_, String>(0))? {
            let id = id?;
            if id.len() > 256 || queued.len() == MAX_ROWS {
                return Err(Error::InvalidEvent);
            }
            queued.insert(id);
        }
    }
    let sql = if kind == Schema::V2 {
        "SELECT id,type,data,time_created FROM session_message WHERE session_id=?1 ORDER BY seq LIMIT 10001"
    } else {
        "SELECT id,json_extract(data,'$.role'),data,time_created FROM message WHERE session_id=?1 ORDER BY time_created,id LIMIT 10001"
    };
    let mut query = db.prepare(sql)?;
    let mut cursor = query.query([session])?;
    let mut rows = Vec::new();
    let mut bytes = 0;
    while let Some(row) = cursor.next()? {
        if rows.len() == MAX_ROWS {
            return Err(Error::InvalidEvent);
        }
        let id: String = row.get(0)?;
        if id.is_empty() || id.len() > 256 {
            return Err(Error::InvalidEvent);
        }
        rows.push(Row {
            id,
            role: row.get(1)?,
            data: decoded(&row.get::<_, String>(2)?, &mut bytes)?,
            time: row.get(3)?,
        });
    }
    if boundary
        .as_ref()
        .is_some_and(|id| !rows.iter().any(|r| &r.id == id))
    {
        return Err(Error::InvalidEvent);
    }
    let sql = if kind == Schema::V2 {
        "SELECT message_id,data FROM session_part WHERE session_id=?1 ORDER BY message_id,ordinal LIMIT 10001"
    } else {
        "SELECT message_id,data FROM part WHERE session_id=?1 ORDER BY message_id,id LIMIT 10001"
    };
    let mut query = db.prepare(sql)?;
    let mut cursor = query.query([session])?;
    let mut parts: HashMap<String, Vec<Value>> = HashMap::new();
    let ids: HashSet<_> = rows.iter().map(|r| r.id.as_str()).collect();
    let mut count = 0;
    while let Some(row) = cursor.next()? {
        count += 1;
        if count > MAX_ROWS {
            return Err(Error::InvalidEvent);
        }
        let id: String = row.get(0)?;
        if !ids.contains(id.as_str()) {
            return Err(Error::InvalidEvent);
        }
        parts
            .entry(id)
            .or_default()
            .push(decoded(&row.get::<_, String>(1)?, &mut bytes)?);
    }
    if kind == Schema::V1 {
        if let Some(boundary) = &boundary {
            let index = rows
                .iter()
                .position(|r| &r.id == boundary)
                .ok_or(Error::InvalidEvent)?;
            rows.truncate(index);
        }
    }
    let mut messages = Vec::new();
    let mut output = 0;
    let mut truncated = false;
    for row in rows.iter().rev() {
        // V2 TUI applies lexical IDs before grouping; V1 was cut by ordered index.
        if queued.contains(&row.id)
            || (kind == Schema::V2 && boundary.as_ref().is_some_and(|id| &row.id >= id))
        {
            continue;
        }
        let overlay = parts.get(&row.id);
        if let Some(message) = normalize(
            kind,
            &row.id,
            &row.role,
            &row.data,
            overlay.map(Vec::as_slice),
            row.time,
        )? {
            let size = super::message_size(&message)?;
            if messages.len() == usize::from(limit) || output + size > MAX_PAGE {
                truncated = true;
                break;
            }
            output += size;
            messages.push(message);
        }
    }
    messages.reverse();
    let activity = if kind == Schema::V1 {
        activity(&rows, &parts)
    } else {
        None
    };
    verify_source(path, &identity, &db)?;
    Ok(TranscriptPage {
        schema_version: 1,
        view: "active_branch",
        agent: TranscriptAgent::Opencode,
        messages,
        next_offset: 0,
        has_more: false,
        branch_id: Some(session.into()),
        truncated,
        checkpoint: None,
        activity,
        queued: Vec::new(),
    })
}

/// V1 turn state from the latest retained row, as OpenCode records it:
/// assistant `time.completed`, `finish` and `MessageAbortedError`, plus a
/// pending or running `question` tool part.
fn activity(rows: &[Row], parts: &HashMap<String, Vec<Value>>) -> Option<&'static str> {
    let last = rows.last()?;
    match last.role.as_str() {
        "user" => return Some("working"),
        "assistant" => {}
        _ => return None,
    }
    let waiting = parts.get(&last.id).into_iter().flatten().any(|part| {
        part["type"] == "tool"
            && part["tool"]
                .as_str()
                .is_some_and(|name| interaction::awaits_answer(TranscriptAgent::Opencode, name))
            && matches!(
                part["state"]["status"].as_str(),
                Some("pending" | "running")
            )
    });
    let data = &last.data;
    if waiting {
        Some("waiting")
    } else if data["error"]["name"] == "MessageAbortedError" {
        Some("stopped")
    } else if !data["error"].is_null() {
        None
    } else if data["time"]["completed"].is_null() {
        Some("working")
    } else {
        match data["finish"].as_str() {
            Some("stop") => Some("idle"),
            Some("tool-calls") => Some("working"),
            _ => None,
        }
    }
}

fn verify_source(path: &Path, identity: &SourceSnapshot, db: &Connection) -> Result<()> {
    #[cfg(not(unix))]
    let _ = db;
    identity.same_file(&open_transcript(path)?)?;
    // SQLite checks the actual opened VFS file as well as our retained pathname object.
    #[cfg(unix)]
    {
        let mut moved: std::ffi::c_int = 0;
        let rc = unsafe {
            rusqlite::ffi::sqlite3_file_control(
                db.handle(),
                c"main".as_ptr(),
                rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
                (&mut moved as *mut std::ffi::c_int).cast(),
            )
        };
        if rc != rusqlite::ffi::SQLITE_OK || moved != 0 {
            return Err(Error::InvalidEvent);
        }
    }
    Ok(())
}

fn text(value: &Value, field: &str) -> Result<String> {
    value[field]
        .as_str()
        .map(str::to_owned)
        .ok_or(Error::InvalidEvent)
}

fn attachment(value: &Value) -> Result<Value> {
    let mime = value["mime"].as_str().ok_or(Error::InvalidEvent)?;
    let name = value["name"]
        .as_str()
        .or_else(|| value["filename"].as_str())
        .unwrap_or("Attachment");
    Ok(block(
        "image",
        format!("{name} ({mime}) — view in the host agent terminal"),
        None,
        None,
    ))
}

pub(super) fn normalize(
    kind: Schema,
    id: &str,
    role: &str,
    data: &Value,
    parts: Option<&[Value]>,
    time: i64,
) -> Result<Option<Value>> {
    let mut blocks = Vec::new();
    if kind == Schema::V2 && role == "user" {
        blocks.push(block("text", text(data, "text")?, None, None));
        if let Some(files) = data.get("files") {
            for file in files.as_array().ok_or(Error::InvalidEvent)? {
                blocks.push(attachment(file)?);
            }
        }
    } else if matches!(role, "user" | "assistant") {
        let inline;
        let content: &[Value] = if let Some(parts) = parts {
            parts
        } else if kind == Schema::V1 {
            &[]
        } else {
            inline = data["content"].as_array().ok_or(Error::InvalidEvent)?;
            inline
        };
        for part in content {
            match part["type"].as_str().ok_or(Error::InvalidEvent)? {
                "text" | "reasoning" => {
                    if kind == Schema::V1
                        && role == "user"
                        && part["synthetic"].as_bool() == Some(true)
                    {
                        continue;
                    }
                    blocks.push(block(
                        if part["type"] == "reasoning" {
                            "thinking"
                        } else {
                            "text"
                        },
                        text(part, "text")?,
                        None,
                        None,
                    ));
                }
                "file" => blocks.push(attachment(part)?),
                "tool" => tool(part, &mut blocks)?,
                // V1 structural timeline markers contain no conversation text.
                "step-start" | "step-finish" | "snapshot" | "patch" | "compaction" | "retry"
                | "agent" | "subtask" => {}
                _ => return Err(Error::InvalidEvent),
            }
        }
    } else {
        match role {
            "synthetic" | "system" => {
                if let Some(description) = data["description"].as_str() {
                    blocks.push(block("text", description.into(), None, None));
                }
            }
            "shell" => {
                blocks.push(block(
                    "tool_use",
                    text(data, "command")?,
                    None,
                    Some("shell".into()),
                ));
                if let Some(output) = data.pointer("/output/output").and_then(Value::as_str) {
                    blocks.push(block(
                        "tool_result",
                        output.into(),
                        None,
                        Some("shell".into()),
                    ));
                }
            }
            "skill" => blocks.push(block(
                "text",
                format!("Skill: {}", text(data, "name")?),
                None,
                None,
            )),
            "compaction" | "idle" | "agent-switched" | "model-switched" | "location-switched" => {}
            _ => return Err(Error::InvalidEvent),
        }
    }
    if role == "assistant" && data.get("error").is_some_and(|error| !error.is_null()) {
        blocks.push(block(
            "text",
            "Agent response failed; inspect the host agent terminal".into(),
            None,
            None,
        ));
    }
    if blocks.is_empty() {
        return Ok(None);
    }
    let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(time)
        .ok_or(Error::InvalidEvent)?
        .to_rfc3339();
    let mut message = json!({"id":id,"role":if role=="user" {"user"}else{"assistant"},"blocks":blocks,"timestamp":timestamp});
    database::opencode_usage(&mut message, data);
    Ok(Some(message))
}

fn tool(part: &Value, blocks: &mut Vec<Value>) -> Result<()> {
    let id = part["callID"]
        .as_str()
        .or_else(|| part["id"].as_str())
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .ok_or(Error::InvalidEvent)?
        .to_owned();
    let id = Some(id);
    let name = part["name"]
        .as_str()
        .or_else(|| part["tool"].as_str())
        .map(str::to_owned);
    let state = &part["state"];
    let status = state["status"].as_str().ok_or(Error::InvalidEvent)?;
    if !matches!(
        status,
        "pending" | "streaming" | "running" | "completed" | "error"
    ) {
        return Err(Error::InvalidEvent);
    }
    let first = blocks.len();
    let input = state.get("input").ok_or(Error::InvalidEvent)?;
    if !input.is_object() && !(status == "streaming" && input.is_string()) {
        return Err(Error::InvalidEvent);
    }
    blocks.push(block(
        "tool_use",
        input
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| input.to_string()),
        id.clone(),
        name.clone(),
    ));
    if let Some(card) = name
        .as_deref()
        .and_then(|name| interaction::card(TranscriptAgent::Opencode, name, input))
    {
        blocks[first]["card"] = card;
    }
    if status == "completed" || status == "error" {
        if let Some(content) = state.get("content") {
            for item in content.as_array().ok_or(Error::InvalidEvent)? {
                match item["type"].as_str() {
                    Some("text") => blocks.push(block(
                        "tool_result",
                        text(item, "text")?,
                        id.clone(),
                        name.clone(),
                    )),
                    Some("file") => blocks.push(attachment(item)?),
                    _ => return Err(Error::InvalidEvent),
                }
            }
        } else if let Some(output) = state["output"].as_str() {
            blocks.push(block(
                "tool_result",
                output.into(),
                id.clone(),
                name.clone(),
            ));
        }
        if status == "error" {
            let results = &mut blocks[first..];
            let mut found = false;
            for result in results
                .iter_mut()
                .filter(|result| result["type"] == "tool_result")
            {
                result["isError"] = json!(true);
                found = true;
            }
            if !found {
                let mut failure = block(
                    "tool_result",
                    state["error"]
                        .as_str()
                        .unwrap_or("Tool failed; inspect the host agent terminal")
                        .into(),
                    id.clone(),
                    name,
                );
                failure["isError"] = json!(true);
                blocks.push(failure);
            }
        }
    }
    if let Some(files) = state.get("attachments") {
        for file in files.as_array().ok_or(Error::InvalidEvent)? {
            blocks.push(attachment(file)?);
        }
    }
    for item in &mut blocks[first..] {
        item["id"] = json!(id);
        item["status"] = json!(match status {
            "pending" | "streaming" => "pending",
            "running" => "in_progress",
            "completed" => "completed",
            _ => "failed",
        });
    }
    Ok(())
}

// V1 has no seq column. Its additive Records cursor is the SQLite rowid, not a
// provider message ID; established V2 seq and Hermes cursors remain untouched.
pub(super) fn records(
    db: &Connection,
    session: &str,
    offset: u64,
    limit: u8,
) -> Result<TranscriptPage> {
    let mut query = db.prepare("SELECT rowid,id,data,time_created FROM message WHERE session_id=?1 AND rowid>=?2 ORDER BY rowid LIMIT 201")?;
    let mut cursor = query.query(rusqlite::params![session, offset as i64])?;
    let mut messages = Vec::new();
    let mut bytes = 0;
    let mut output = 0;
    let mut next = offset;
    let mut has_more = false;
    let mut examined = 0;
    while let Some(row) = cursor.next()? {
        if examined == 200 {
            has_more = true;
            break;
        }
        let position: i64 = row.get(0)?;
        let id: String = row.get(1)?;
        let data = decoded(&row.get::<_, String>(2)?, &mut bytes)?;
        let mut parts = Vec::new();
        let mut query = db.prepare(
            "SELECT data FROM part WHERE session_id=?1 AND message_id=?2 ORDER BY id LIMIT 1001",
        )?;
        for raw in query.query_map(rusqlite::params![session, id], |r| r.get::<_, String>(0))? {
            if parts.len() == 1000 {
                return Err(Error::InvalidEvent);
            }
            parts.push(decoded(&raw?, &mut bytes)?);
        }
        if let Some(message) = normalize(
            Schema::V1,
            &id,
            &text(&data, "role")?,
            &data,
            Some(&parts),
            row.get(3)?,
        )? {
            let size = super::message_size(&message)?;
            if size > MAX_PAGE {
                return Err(Error::InvalidEvent);
            }
            if messages.len() == usize::from(limit) || output + size > MAX_PAGE {
                has_more = true;
                break;
            }
            messages.push(message);
            output += size;
        }
        next = u64::try_from(position)
            .ok()
            .and_then(|n| n.checked_add(1))
            .ok_or(Error::InvalidEvent)?;
        examined += 1;
    }
    Ok(TranscriptPage {
        schema_version: 1,
        view: "record_stream",
        agent: TranscriptAgent::Opencode,
        messages,
        next_offset: next,
        has_more,
        branch_id: None,
        truncated: false,
        checkpoint: None,
        activity: None,
        queued: Vec::new(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn restoring_the_retained_path_cannot_publish_a_different_sqlite_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap().join("opencode.db");
        let original = Connection::open(&path).unwrap();
        original
            .execute_batch("CREATE TABLE original(id TEXT)")
            .unwrap();
        drop(original);
        let retained = open_transcript(&path).unwrap();
        let identity = SourceSnapshot::capture(&retained).unwrap();
        let old = directory.path().join("original.db");
        std::fs::rename(&path, &old).unwrap();
        let replacement = Connection::open(&path).unwrap();
        replacement
            .execute_batch("CREATE TABLE replacement(id TEXT)")
            .unwrap();
        std::fs::rename(&path, directory.path().join("replacement.db")).unwrap();
        std::fs::rename(&old, &path).unwrap();
        // The pathname-only check sees A again while SQLite still holds B.
        identity
            .same_file(&open_transcript(&path).unwrap())
            .unwrap();
        assert!(verify_source(&path, &identity, &replacement).is_err());
        let unchanged = database::open_database(&path).unwrap();
        assert!(verify_source(&path, &identity, &unchanged).is_ok());
    }
}
