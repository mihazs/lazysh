//! Gemini CLI conversations, reduced for display from a session file (`chats/session-*.jsonl`).
//!
//! The file is an append-only log, replayed the way the CLI replays it: a message record whose id is known replaces that
//! message in place, `$patch` edits, removes or reorders messages and sets tool results, `$rewindTo` drops a message and
//! every one after it, and the metadata lines (`sessionId`, `$set`) show nothing. A legacy `.json` session (one object
//! holding `messages`) reads the same way. Only `user` and `gemini` messages are shown; `info`, `warning` and `error`
//! messages are not mapped.
//!
//! Work tracking is recorded evidence only: an `invoke_agent` call is a sub-agent, a `run_shell_command` call with
//! `is_background` is a background shell (it ends at no recorded event, so it stays `running`), and `write_todos` is the
//! plan card. A tool name not listed here is an ordinary tool block.
use super::session_info::Session;
use super::window::{select, Window};
use super::{
    block, conversation::capture, interaction, Error, Result, TranscriptAgent, TranscriptPage,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_RECORDS: usize = 100_000;
const MAX_TEXT: usize = 32 * 1024;
const MAX_RESULT: usize = 8 * 1024;
const MAX_TASKS: usize = 100;
const MAX_TITLE: usize = 200;

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// A part list as Gemini stores it: a string, one part or an array of parts. Only text parts are shown.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().map(text_of).collect::<Vec<_>>().join(""),
        Value::Object(part) => part
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        _ => String::new(),
    }
}

fn records(bytes: &[u8]) -> Result<Vec<Value>> {
    if let Some(messages) = serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|whole| whole["messages"].as_array().cloned())
    {
        return Ok(messages);
    }
    // The last line may still be written: only complete lines count.
    let complete = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |end| end + 1);
    let mut records = Vec::new();
    for line in bytes[..complete].split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if records.len() >= MAX_RECORDS {
            return Err(Error::InvalidArgument);
        }
        records.push(serde_json::from_slice(line).map_err(|_| Error::InvalidEvent)?);
    }
    Ok(records)
}

fn position(messages: &[Value], id: &str) -> Option<usize> {
    messages.iter().position(|message| message["id"] == id)
}

/// `content` and tool results of one message, as a `$patch` sets them.
fn edit(messages: &mut [Value], patch: &Value) {
    let Some(message) = patch["id"].as_str().and_then(|id| position(messages, id)) else {
        return;
    };
    if let Some(content) = patch.get("content") {
        messages[message]["content"] = content.clone();
    }
    for call in patch["toolCalls"].as_array().into_iter().flatten() {
        let Some(result) = call.get("result") else {
            continue;
        };
        let target = messages[message]["toolCalls"]
            .as_array_mut()
            .and_then(|calls| calls.iter_mut().find(|known| known["id"] == call["id"]));
        if let Some(target) = target {
            target["result"] = result.clone();
        }
    }
}

fn patch(messages: &mut Vec<Value>, patch: &Value) {
    edit(messages, patch);
    for update in patch["updates"].as_array().into_iter().flatten() {
        edit(messages, update);
    }
    for id in patch["removeIds"].as_array().into_iter().flatten() {
        messages.retain(|message| message["id"] != *id);
    }
    // Listed messages move after all the others, in the listed order.
    let mut moved = Vec::new();
    for id in patch["orderIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if let Some(index) = position(messages, id) {
            moved.push(messages.remove(index));
        }
    }
    messages.append(&mut moved);
}

fn replay(records: Vec<Value>) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    for record in records {
        if let Some(id) = record["$rewindTo"].as_str() {
            // An unknown id empties the conversation, as in the CLI.
            messages.truncate(position(&messages, id).unwrap_or(0));
        } else if record.get("$patch").is_some_and(Value::is_object) {
            patch(&mut messages, &record["$patch"]);
        } else if let Some(id) = record["id"].as_str() {
            match position(&messages, id) {
                Some(index) => messages[index] = record,
                None => messages.push(record),
            }
        }
    }
    messages
}

/// The text a finished tool call reports: the response's `output` or `error`, else the display text.
fn result_text(call: &Value) -> String {
    let responses = call["result"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| {
            let response = &part["functionResponse"]["response"];
            response["output"]
                .as_str()
                .or_else(|| response["error"].as_str())
        })
        .collect::<Vec<_>>()
        .join("\n");
    clip(
        if responses.is_empty() {
            call["resultDisplay"].as_str().unwrap_or("")
        } else {
            &responses
        },
        MAX_RESULT,
    )
}

fn finished(call: &Value) -> bool {
    matches!(
        call["status"].as_str(),
        Some("success" | "error" | "cancelled")
    )
}

/// The shown messages one recorded message becomes: the assistant turn, then the results of its tool calls.
fn display(message: &Value) -> Vec<Value> {
    let (id, kind) = (
        message["id"].as_str().unwrap_or_default(),
        message["type"].as_str(),
    );
    let mut shown = Vec::new();
    let mut push = |role: &str, id: String, blocks: Vec<Value>| {
        if blocks.is_empty() {
            return;
        }
        let mut shown_message = json!({"id": id, "role": role, "blocks": blocks});
        if let Some(timestamp) = message["timestamp"].as_str() {
            shown_message["timestamp"] = json!(timestamp);
        }
        shown.push(shown_message);
    };
    match kind {
        Some("user") => {
            // What the user typed, not the file contents `@path` expanded into the prompt.
            let shown_content = message
                .get("displayContent")
                .filter(|value| !value.is_null())
                .unwrap_or(&message["content"]);
            let text = clip(text_of(shown_content).trim(), MAX_TEXT);
            push(
                "user",
                id.to_owned(),
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![block("text", text, None, None)]
                },
            );
        }
        Some("gemini") => {
            let mut blocks: Vec<Value> = message["thoughts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|thought| {
                    let (subject, description) = (
                        thought["subject"].as_str().unwrap_or(""),
                        thought["description"].as_str().unwrap_or(""),
                    );
                    let line = [subject, description]
                        .iter()
                        .filter(|part| !part.is_empty())
                        .copied()
                        .collect::<Vec<_>>()
                        .join(": ");
                    (!line.is_empty()).then(|| block("thinking", clip(&line, MAX_TEXT), None, None))
                })
                .collect();
            let text = clip(text_of(&message["content"]).trim(), MAX_TEXT);
            if !text.is_empty() {
                blocks.push(block("text", text, None, None));
            }
            let calls = message["toolCalls"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            for call in calls
                .iter()
                .filter(|call| call["id"].is_string() && call["name"].is_string())
            {
                let input = serde_json::to_string(&call["args"]).unwrap_or_default();
                let mut tool = block(
                    "tool_use",
                    clip(&input, MAX_TEXT),
                    call["id"].as_str().map(str::to_owned),
                    call["name"].as_str().map(str::to_owned),
                );
                interaction::annotate(TranscriptAgent::Gemini, std::slice::from_mut(&mut tool));
                blocks.push(tool);
            }
            let results: Vec<Value> = calls
                .iter()
                .filter(|call| call["id"].is_string() && finished(call))
                .map(|call| {
                    let mut result = block(
                        "tool_result",
                        result_text(call),
                        call["id"].as_str().map(str::to_owned),
                        None,
                    );
                    // A cancelled call did not succeed either; its text is whatever Gemini recorded.
                    result["isError"] = json!(call["status"] != "success");
                    result
                })
                .collect();
            push("assistant", id.to_owned(), blocks);
            push("tool", format!("{id}:results"), results);
        }
        _ => {}
    }
    shown
}

/// Sub-agents and background shells, in the order the calls were recorded.
fn work(messages: &[Value]) -> Option<Vec<Value>> {
    let mut items = Vec::new();
    for call in messages
        .iter()
        .filter(|message| message["type"] == "gemini")
        .flat_map(|message| message["toolCalls"].as_array().into_iter().flatten())
    {
        let (Some(id), args) = (call["id"].as_str(), &call["args"]) else {
            continue;
        };
        let (kind, title, command) = match call["name"].as_str() {
            Some("invoke_agent") => (
                "agent",
                args["agent_name"].as_str().map(str::to_owned),
                None,
            ),
            Some("run_shell_command") if args["is_background"] == true => {
                let command = args["command"]
                    .as_str()
                    .map(|command| clip(command, MAX_TITLE));
                (
                    "shell",
                    args["description"]
                        .as_str()
                        .map(|text| clip(text, MAX_TITLE))
                        .or_else(|| command.clone()),
                    command,
                )
            }
            _ => continue,
        };
        let state = match (kind, call["status"].as_str()) {
            (
                "shell",
                Some("success" | "validating" | "scheduled" | "executing" | "awaiting_approval"),
            ) => "running",
            ("agent", Some("validating" | "scheduled" | "executing" | "awaiting_approval")) => {
                "running"
            }
            ("agent", Some("success")) => "done",
            (_, Some("error")) => "failed",
            (_, Some("cancelled")) => "stopped",
            _ => continue,
        };
        let mut item = json!({"id": id, "kind": kind, "title": title.unwrap_or_else(|| kind.to_owned()), "state": state, "events": []});
        if let Some(command) = command {
            item["command"] = json!(command);
        }
        if let Some(started) = call["timestamp"].as_str() {
            item["startedAt"] = json!(started);
        }
        items.push(item);
        if items.len() == MAX_TASKS {
            break;
        }
    }
    (!items.is_empty()).then_some(items)
}

/// Recorded turn state of the last message: a tool call waiting for approval or running, the user's prompt not yet answered
/// and tool results not yet answered are working; a cancelled call stops the turn; a final answer is idle.
fn activity(messages: &[Value]) -> Option<&'static str> {
    let last = messages.last()?;
    match last["type"].as_str()? {
        "user" => Some("working"),
        "gemini" => {
            let calls = last["toolCalls"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            let any = |statuses: &[&str]| {
                calls.iter().any(|call| {
                    call["status"]
                        .as_str()
                        .is_some_and(|status| statuses.contains(&status))
                })
            };
            if any(&["awaiting_approval"]) {
                Some("waiting")
            } else if any(&["validating", "scheduled", "executing"])
                || (!calls.is_empty() && calls.iter().all(finished) && !any(&["cancelled"]))
            {
                Some("working")
            } else if any(&["cancelled"]) {
                Some("stopped")
            } else {
                (!text_of(&last["content"]).trim().is_empty()).then_some("idle")
            }
        }
        _ => None,
    }
}

pub(super) fn conversation(path: &Path, limit: u8, window: &Window) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    let messages = replay(records(&capture(path)?)?);
    let selected = select(messages.iter().flat_map(display).collect(), window, limit)?;
    let mut session = Session::default();
    session.gemini(&messages);
    Ok(TranscriptPage {
        schema_version: 1,
        view: "active_branch",
        agent: TranscriptAgent::Gemini,
        messages: selected.messages,
        next_offset: 0,
        has_more: false,
        branch_id: None,
        truncated: selected.has_older,
        has_newer: selected.has_newer,
        checkpoint: None,
        activity: activity(&messages),
        queued: Vec::new(),
        work: work(&messages),
        session: session.into_value(),
    })
}

/// `$GEMINI_CLI_HOME` (the CLI's home directory, else the user's) holds `.gemini/tmp`, one folder per project.
pub(super) fn sessions_root() -> Result<PathBuf> {
    std::env::var_os("GEMINI_CLI_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .map(|home| home.join(".gemini/tmp"))
        .ok_or(Error::InvalidArgument)
}

/// A main session file: `chats/session-<time>-<id>.jsonl`.
pub(super) fn session_path(path: &Path) -> bool {
    path.parent()
        .and_then(Path::file_name)
        .is_some_and(|folder| folder == "chats")
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("session-"))
}
