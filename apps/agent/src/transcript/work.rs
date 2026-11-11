//! Sub-agents, background shells and monitors of a Claude Code conversation.
//!
//! Recorded evidence only: a task starts at its `tool_use` (an `Agent`/`Task` call, a `Bash` call with
//! `run_in_background`, a `Monitor`), gets its task id from the launch result, and ends at a result, a
//! `<task-notification>` naming its task or tool-use id, or a `TaskStop` call. A launch with no recorded end
//! stays `running`; the reader decides from the start time when that is too old to believe.
use serde_json::{json, Map, Value};
use std::collections::HashMap;

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
    })
}

fn finish(task: &mut Task, state: &'static str, at: Option<&str>) {
    task.state = state;
    task.ended_at = at.map(str::to_owned);
}

fn notice(tasks: &mut [Task], index: &HashMap<String, usize>, body: &str, at: Option<&str>) {
    let by_use = tag(body, "tool-use-id").and_then(|id| index.get(&id).copied());
    let by_task = || {
        let id = tag(body, "task-id")?;
        tasks
            .iter()
            .position(|task| task.task_id.as_deref() == Some(id.as_str()))
    };
    let Some(position) = by_use.or_else(by_task) else {
        return;
    };
    let task = &mut tasks[position];
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
    let launched = [
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
    if let Some(timeout) = task.timeout_ms {
        out.insert("timeoutMs".into(), json!(timeout));
    }
    Value::Object(out)
}
