//! Sub-agents, background shells and monitors of a Claude Code conversation.
//!
//! Recorded evidence only: a task starts at its `tool_use` (an `Agent`/`Task` call, a `Bash` call with
//! `run_in_background`, a `Monitor`), gets its task id from the launch result, and ends at a result, a
//! `<task-notification>` naming its task or tool-use id, or a `TaskStop` call. A launch with no recorded end
//! stays `running`; the reader decides from the start time when that is too old to believe.
use super::TranscriptPage;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const MAX_TASKS: usize = 100;
const MAX_EVENTS: usize = 50;
const MAX_TEXT: usize = 2000;

struct Task {
    id: String,
    kind: &'static str,
    title: String,
    subtitle: Option<String>,
    command: Option<String>,
    state: &'static str,
    task_id: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
    last: Option<String>,
    summary: Option<String>,
    events: Vec<String>,
    timeout_ms: Option<u64>,
    /// From the notice's `<usage>`: a sub-agent's tokens and run time.
    tokens: Option<u64>,
    duration_ms: Option<u64>,
}

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}
fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| clip(text, MAX_TEXT))
}
/// `name: '…'` of a workflow script's `export const meta`, read from its first 2 KB only.
fn workflow_name(script: &Value) -> String {
    let head: String = script
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(2048)
        .collect();
    head.split("name:")
        .nth(1)
        .and_then(|rest| {
            let rest = rest.trim_start();
            let quote = rest
                .chars()
                .next()
                .filter(|c| matches!(c, '\'' | '"' | '`'))?;
            let name = rest[1..].split(quote).next()?;
            Some(clip(name, 120))
        })
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Workflow".to_owned())
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| clip(line, 200))
}
fn tag(text: &str, name: &str) -> Option<String> {
    let (open, close) = (format!("<{name}>"), format!("</{name}>"));
    let start = text.find(&open)? + open.len();
    let end = start + text[start..].find(&close)?;
    Some(text[start..end].trim().to_owned())
}
/// The identifier after `marker`.
fn token_after(text: &str, marker: &str) -> Option<String> {
    let rest = text[text.find(marker)? + marker.len()..].trim_start();
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        .collect();
    (!token.is_empty()).then_some(token)
}
fn result_text(block: &Value) -> String {
    match &block["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn start(block: &Value, at: Option<&str>) -> Option<Task> {
    let input = &block["input"];
    let describe = |fallback: &str| {
        text(&input["description"])
            .or_else(|| input["command"].as_str().and_then(first_line))
            .unwrap_or_else(|| fallback.to_owned())
    };
    let (kind, title, subtitle) = match block["name"].as_str()? {
        name @ ("Agent" | "Task") => (
            "agent",
            text(&input["description"])
                .or_else(|| text(&input["subagent_type"]))
                .unwrap_or_else(|| name.to_owned()),
            text(&input["subagent_type"]),
        ),
        "Bash" if input["run_in_background"] == true => ("shell", describe("Bash"), None),
        "Monitor" => ("monitor", describe("Monitor"), None),
        "Workflow" => ("workflow", workflow_name(&input["script"]), None),
        _ => return None,
    };
    Some(Task {
        id: block["id"].as_str()?.to_owned(),
        kind,
        title,
        subtitle,
        command: if kind == "agent" {
            None
        } else {
            text(&input["command"])
        },
        state: "running",
        task_id: None,
        started_at: at.map(str::to_owned),
        ended_at: None,
        last: None,
        summary: None,
        events: Vec::new(),
        timeout_ms: input["timeout_ms"].as_u64(),
        tokens: None,
        duration_ms: None,
    })
}

fn finish(task: &mut Task, state: &'static str, at: Option<&str>) {
    task.state = state;
    task.ended_at = at.map(str::to_owned);
}

fn tags(text: &str, name: &str) -> Vec<String> {
    let (open, close) = (format!("<{name}>"), format!("</{name}>"));
    text.split(&open)
        .skip(1)
        .filter_map(|rest| Some(rest[..rest.find(&close)?].trim().to_owned()))
        .collect()
}

/// A notice names its task by tool-use id or by task id; the one Claude Code writes when a session ends names
/// every task it never saw end, one `<task-id>` each.
fn notice(tasks: &mut [Task], index: &HashMap<String, usize>, body: &str, at: Option<&str>) {
    let mut named: Vec<usize> = tag(body, "tool-use-id")
        .and_then(|id| index.get(&id).copied())
        .into_iter()
        .collect();
    if named.is_empty() {
        for id in tags(body, "task-id") {
            named.extend(
                tasks
                    .iter()
                    .position(|task| task.task_id.as_deref() == Some(id.as_str())),
            );
        }
    }
    for position in named {
        settle(&mut tasks[position], body, at);
    }
}

fn settle(task: &mut Task, body: &str, at: Option<&str>) {
    if let Some(event) = tag(body, "event") {
        task.last = event.lines().last().and_then(first_line);
        task.events.push(clip(&event, MAX_TEXT));
        if task.events.len() > MAX_EVENTS {
            task.events.remove(0);
        }
    }
    let state = match tag(body, "status").as_deref() {
        Some("completed") => "done",
        Some("failed") => "failed",
        Some("killed" | "stopped" | "cancelled") => "stopped",
        Some(_) => "unknown",
        None => return,
    };
    finish(task, state, at);
    let usage = |name| tag(body, name).and_then(|value| value.parse().ok());
    (task.tokens, task.duration_ms) = (usage("subagent_tokens"), usage("duration_ms"));
    task.summary = tag(body, "summary").map(|summary| clip(&summary, MAX_TEXT));
    if let Some(last) = tag(body, "result").as_deref().and_then(first_line) {
        task.last = Some(last);
    }
}

/// Tasks in launch order, the newest `MAX_TASKS`.
pub(super) fn tasks<'a>(records: impl IntoIterator<Item = &'a Value>) -> Vec<Value> {
    let mut tasks: Vec<Task> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut stops: HashMap<String, String> = HashMap::new();
    for record in records {
        let at = record["timestamp"].as_str();
        let content = &record["message"]["content"];
        if let Some(body) = content.as_str() {
            if body.starts_with("<task-notification>") {
                notice(&mut tasks, &index, body, at);
            }
            continue;
        }
        for block in content.as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("tool_use") => {
                    if let (Some("TaskStop"), Some(id), Some(target)) = (
                        block["name"].as_str(),
                        block["id"].as_str(),
                        block["input"]["task_id"].as_str(),
                    ) {
                        stops.insert(id.to_owned(), target.to_owned());
                    } else if let Some(task) = start(block, at) {
                        index.insert(task.id.clone(), tasks.len());
                        tasks.push(task);
                    }
                }
                Some("tool_result") => {
                    if let Some(id) = block["tool_use_id"].as_str() {
                        result(&mut tasks, &index, &stops, id, block, at);
                    }
                }
                Some("text") => {
                    if let Some(body) = block["text"]
                        .as_str()
                        .filter(|body| body.starts_with("<task-notification>"))
                    {
                        notice(&mut tasks, &index, body, at);
                    }
                }
                _ => {}
            }
        }
    }
    let skip = tasks.len().saturating_sub(MAX_TASKS);
    tasks.into_iter().skip(skip).map(render).collect()
}

fn result(
    tasks: &mut [Task],
    index: &HashMap<String, usize>,
    stops: &HashMap<String, String>,
    id: &str,
    block: &Value,
    at: Option<&str>,
) {
    let body = result_text(block);
    let failed = block["is_error"] == true;
    if let Some(target) = stops.get(id).filter(|_| !failed) {
        if let Some(task) = tasks
            .iter_mut()
            .find(|task| task.task_id.as_deref() == Some(target.as_str()))
        {
            finish(task, "stopped", at);
        }
    }
    let Some(&position) = index.get(id) else {
        return;
    };
    let task = &mut tasks[position];
    // A workflow only ever launches here; it ends with its notice.
    let launched = task.kind == "workflow"
        || [
            "Async agent launched",
            "running in background",
            "Monitor started",
        ]
        .iter()
        .any(|marker| body.contains(marker));
    task.task_id = token_after(&body, "agentId:")
        .or_else(|| token_after(&body, "background with ID:"))
        .or_else(|| token_after(&body, "(task "))
        .or(task.task_id.take());
    if failed {
        finish(task, "failed", at);
        task.last = first_line(&body);
    } else if !launched {
        finish(task, "done", at);
        task.last = first_line(&body);
    }
}

fn render(task: Task) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(task.id));
    out.insert("kind".into(), json!(task.kind));
    out.insert("title".into(), json!(task.title));
    out.insert("state".into(), json!(task.state));
    out.insert("events".into(), json!(task.events));
    for (key, value) in [
        ("subtitle", task.subtitle),
        ("command", task.command),
        ("taskId", task.task_id),
        ("startedAt", task.started_at),
        ("endedAt", task.ended_at),
        ("last", task.last),
        ("summary", task.summary),
    ] {
        if let Some(value) = value {
            out.insert(key.into(), json!(value));
        }
    }
    for (key, value) in [
        ("timeoutMs", task.timeout_ms),
        ("tokens", task.tokens),
        ("durationMs", task.duration_ms),
    ] {
        if let Some(value) = value {
            out.insert(key.into(), json!(value));
        }
    }
    Value::Object(out)
}

const MAX_CHILDREN: usize = 200;
const MAX_META: u64 = 16 * 1024;
const TAIL: u64 = 64 * 1024;

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// The last assistant text of a sub-agent's own file, read from its tail only.
fn last_line(path: &Path) -> Option<String> {
    let mut file = super::open_transcript(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(TAIL)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(TAIL).read_to_end(&mut bytes).ok()?;
    String::from_utf8_lossy(&bytes)
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|record| record["type"] == "assistant")
        .find_map(|record| {
            record["message"]["content"]
                .as_array()?
                .iter()
                .filter(|part| part["type"] == "text")
                .find_map(|part| part["text"].as_str().and_then(first_line))
        })
}

/// Ties each sub-agent call to its own conversation: Claude Code writes
/// `<session>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json` (`toolUseId`, `finished`).
/// The meta file is the evidence that a sub-agent ended, so a call without a recorded result but with
/// `finished: true` is done. Anything unreadable, oversized or not an owned plain file is skipped.
pub(super) fn attach_children(page: &mut TranscriptPage, transcript: &Path) {
    let Some(work) = page.work.as_mut().filter(|work| !work.is_empty()) else {
        return;
    };
    let directory = transcript.with_extension("").join("subagents");
    let Ok(entries) = fs::read_dir(&directory) else {
        return;
    };
    for entry in entries.flatten().take(MAX_CHILDREN * 2) {
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_prefix("agent-"))
            .and_then(|name| name.strip_suffix(".meta.json"))
            .filter(|id| valid_id(id))
        else {
            continue;
        };
        let Ok(file) = super::open_transcript(&entry.path()) else {
            continue;
        };
        let mut text = String::new();
        if file.take(MAX_META).read_to_string(&mut text).is_err() {
            continue;
        }
        let Ok(meta) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(item) = meta["toolUseId"]
            .as_str()
            .and_then(|call| work.iter_mut().find(|item| item["id"] == call))
        else {
            continue;
        };
        let child = directory.join(format!("agent-{id}.jsonl"));
        if super::open_transcript(&child).is_err() {
            continue;
        }
        item["childPath"] = json!(child.to_string_lossy());
        item["taskId"] = json!(id);
        if let Some(last) = last_line(&child) {
            item["last"] = json!(last);
        }
        if meta["finished"] == true && item["state"] == "running" {
            item["state"] = json!("done");
        }
    }
}
