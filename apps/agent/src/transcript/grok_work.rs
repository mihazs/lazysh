//! Sub-agents, background commands and monitors of a Grok Build session, from its recorded `_x.ai/session/update` records.
//!
//! Recorded evidence only, as for the other agents. A sub-agent starts at `subagent_spawned` and ends at the
//! `subagent_finished` naming it; a background command or monitor starts at `task_backgrounded` and ends at the
//! `task_completed` whose snapshot names its task. The field names are the ones the official writer serializes
//! (`tests/fixtures/grok-acp/README.md`). A record whose fields are not the recorded shape, an end naming no launch and a
//! snapshot of a task still running change nothing, and a launch with no recorded end stays `running`.
use super::opencode_work::{clip, string};
use serde_json::{json, Map, Value};
use std::collections::{hash_map::Entry, HashMap};

const MAX_TASKS: usize = 100;

type Fields = Map<String, Value>;

/// A task launch (its row) or the end of an earlier launch, each under its `agent:` or `task:` key.
pub(super) enum Record {
    Launch(String, Fields),
    End(String, Fields),
}

/// The first, or the last, line of `text` that holds anything.
fn line(text: &str, last: bool) -> Option<String> {
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    (if last {
        lines.next_back()
    } else {
        lines.next()
    })
    .map(clip)
}
fn set(fields: &mut Fields, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        fields.insert(key.into(), value.into());
    }
}

fn launch(class: &str, id: &str, kind: &str, title: String, at: &str) -> (String, Fields) {
    let mut row = Fields::new();
    for (key, value) in [
        ("id", json!(id)),
        ("kind", json!(kind)),
        ("title", json!(title)),
        ("state", json!("running")),
        ("events", json!([])),
        ("startedAt", json!(at)),
    ] {
        row.insert(key.into(), value);
    }
    (format!("{class}:{id}"), row)
}

fn end(class: &str, id: &str, state: &str, at: &str) -> (String, Fields) {
    let mut fields = Fields::new();
    fields.insert("state".into(), json!(state));
    fields.insert("endedAt".into(), json!(at));
    (format!("{class}:{id}"), fields)
}

/// The work record the `_x.ai/session/update` `tag` carries at the time `at`, if it is one of the four recorded shapes.
pub(super) fn record(tag: &str, update: &Value, at: &str) -> Option<Record> {
    match tag {
        "subagent_spawned" => {
            let (id, kind) = (
                string(&update["subagent_id"])?,
                string(&update["subagent_type"]),
            );
            let title = string(&update["description"]).or_else(|| kind.clone())?;
            let (key, mut row) = launch("agent", &id, "agent", title, at);
            set(&mut row, "subtitle", kind);
            set(&mut row, "taskId", string(&update["child_session_id"]));
            Some(Record::Launch(key, row))
        }
        "subagent_finished" => {
            let state = match update["status"].as_str()? {
                "completed" => "done",
                "failed" => "failed",
                "cancelled" => "stopped",
                _ => return None,
            };
            let (key, mut fields) = end("agent", &string(&update["subagent_id"])?, state, at);
            let said = string(&update["error"])
                .or_else(|| update["output"].as_str().and_then(|text| line(text, false)));
            set(&mut fields, "last", said);
            for (name, value) in [("tokens", "tokens_used"), ("durationMs", "duration_ms")] {
                set(
                    &mut fields,
                    name,
                    update[value].as_u64().filter(|count| *count > 0),
                );
            }
            Some(Record::End(key, fields))
        }
        "task_backgrounded" => {
            let id = string(&update["task_id"])?;
            let (command, monitor) = (
                string(&update["command"]),
                string(&update["monitor_description"]),
            );
            let title = monitor
                .clone()
                .or_else(|| string(&update["description"]))
                .or_else(|| command.as_deref().and_then(|text| line(text, false)))?;
            let (key, mut row) = launch(
                "task",
                &id,
                if monitor.is_some() {
                    "monitor"
                } else {
                    "shell"
                },
                title,
                at,
            );
            set(&mut row, "command", command);
            set(&mut row, "taskId", Some(id));
            Some(Record::Launch(key, row))
        }
        "task_completed" => {
            let snapshot = &update["task_snapshot"];
            // `completed` false is a snapshot of a task still running, not its end.
            if snapshot["completed"] != true {
                return None;
            }
            let state = if snapshot["explicitly_killed"] == true {
                "stopped"
            } else if snapshot["signal"] == "session_restart" {
                // Written for a task the session lost: neither a failure nor a recorded end.
                "unknown"
            } else if snapshot["signal"].is_null()
                && snapshot["exit_code"].as_i64().unwrap_or(0) == 0
            {
                "done"
            } else {
                "failed"
            };
            let (key, mut fields) = end("task", &string(&snapshot["task_id"])?, state, at);
            set(
                &mut fields,
                "last",
                snapshot["output"]
                    .as_str()
                    .and_then(|text| line(text, true)),
            );
            Some(Record::End(key, fields))
        }
        _ => None,
    }
}

/// The rows of `records` in launch order, the newest `MAX_TASKS`.
pub(super) fn tasks(records: impl IntoIterator<Item = Record>) -> Option<Vec<Value>> {
    let mut rows: Vec<Fields> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for record in records {
        match record {
            Record::Launch(key, row) => {
                if let Entry::Vacant(slot) = index.entry(key) {
                    slot.insert(rows.len());
                    rows.push(row);
                }
            }
            Record::End(key, fields) => {
                if let Some(&position) = index.get(&key) {
                    rows[position].extend(fields);
                }
            }
        }
    }
    let skip = rows.len().saturating_sub(MAX_TASKS);
    let rows: Vec<Value> = rows.into_iter().skip(skip).map(Value::Object).collect();
    (!rows.is_empty()).then_some(rows)
}
