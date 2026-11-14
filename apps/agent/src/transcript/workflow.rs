//! The progress tree of a Claude Code dynamic workflow (a `Workflow` tool call).
//!
//! Claude Code records it next to the session, outside the main conversation:
//! `<session>/workflows/wf_*.json` (`workflowName`, `status`, `phases[{title}]`, `workflowProgress` with one
//! `workflow_agent` per agent, token and tool counts) and `<session>/subagents/workflows/wf_*/journal.jsonl`
//! (`launched`, `started{agentId,label,phase}`, `result{agentId}`, `failed{agentId}`). The journal is live while a
//! workflow runs; the file is the summary. The format is Claude Code's own: unknown fields are ignored and nothing
//! is shown for a shape that does not match. An agent that started and never ended is `running` only while the
//! workflow itself is not recorded as finished, and `unknown` after.
use serde_json::{json, Value};
use std::{collections::HashMap, io::Read, path::Path};

const MAX_FILE: u64 = 4 * 1024 * 1024;
const MAX_JOURNAL: u64 = 2 * 1024 * 1024;
const MAX_AGENTS: usize = 200;
const MAX_PHASES: usize = 50;

fn read(path: &Path, limit: u64) -> Option<String> {
    let mut text = String::new();
    super::open_transcript(path)
        .ok()?
        .take(limit)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}
fn short(value: &Value, limit: usize) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(limit).collect())
}

#[derive(Default)]
struct Agent {
    label: String,
    phase: Option<String>,
    state: &'static str,
    tokens: Option<u64>,
    tool_calls: Option<u64>,
    duration_ms: Option<u64>,
    last: Option<String>,
}

/// The agent record for `id`, registered in launch order; `None` past the agent cap.
fn slot<'a>(
    order: &mut Vec<String>,
    agents: &'a mut HashMap<String, Agent>,
    id: &str,
) -> Option<&'a mut Agent> {
    if !agents.contains_key(id) {
        if order.len() >= MAX_AGENTS {
            return None;
        }
        order.push(id.to_owned());
    }
    Some(agents.entry(id.to_owned()).or_default())
}

/// `{name, status, phases[{title,state}], agents[…], totals}` for one run, or `None` when neither file is usable.
pub(super) fn tree(session: &Path, run: &str) -> Option<(Value, Option<&'static str>)> {
    if !super::work::valid_id(run) || !run.starts_with("wf_") {
        return None;
    }
    let file: Option<Value> = read(
        &session.join("workflows").join(format!("{run}.json")),
        MAX_FILE,
    )
    .and_then(|text| serde_json::from_str(&text).ok());
    let journal = read(
        &session
            .join("subagents/workflows")
            .join(run)
            .join("journal.jsonl"),
        MAX_JOURNAL,
    );
    if file.is_none() && journal.is_none() {
        return None;
    }
    let mut order: Vec<String> = Vec::new();
    let mut agents: HashMap<String, Agent> = HashMap::new();
    for line in journal.iter().flat_map(|text| text.lines()) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(id) = record["agentId"]
            .as_str()
            .filter(|id| super::work::valid_id(id))
        else {
            continue;
        };
        let state = match record["type"].as_str() {
            Some("started") => "running",
            Some("result") => "done",
            Some("failed") => "failed",
            _ => continue,
        };
        let Some(agent) = slot(&mut order, &mut agents, id) else {
            continue;
        };
        agent.state = state;
        if state == "running" {
            agent.label = short(&record["label"], 120).unwrap_or_default();
            agent.phase = short(&record["phase"], 120);
        }
    }
    let progress = file.as_ref().map(|file| &file["workflowProgress"]);
    for entry in progress.and_then(Value::as_array).into_iter().flatten() {
        if entry["type"] != "workflow_agent" {
            continue;
        }
        let Some(id) = entry["agentId"]
            .as_str()
            .filter(|id| super::work::valid_id(id))
        else {
            continue;
        };
        let Some(agent) = slot(&mut order, &mut agents, id) else {
            continue;
        };
        agent.state = match entry["state"].as_str() {
            Some("done") => "done",
            Some("error") => "failed",
            Some("progress" | "start") => "running",
            _ => agent.state,
        };
        if let Some(label) = short(&entry["label"], 120) {
            agent.label = label;
        }
        agent.phase = short(&entry["phaseTitle"], 120).or(agent.phase.take());
        agent.tokens = entry["tokens"].as_u64();
        agent.tool_calls = entry["toolCalls"].as_u64();
        agent.duration_ms = entry["durationMs"].as_u64();
        agent.last = short(&entry["lastToolSummary"], 200)
            .or_else(|| short(&entry["resultPreview"], 200))
            .map(|text| text.lines().next().unwrap_or_default().to_owned());
    }
    let finished = match file.as_ref().and_then(|file| file["status"].as_str()) {
        Some("completed") => Some("done"),
        Some("killed") => Some("stopped"),
        Some("failed" | "error") => Some("failed"),
        _ => None,
    };
    // A workflow recorded as finished leaves no agent running: an agent without an end is not confirmed.
    for agent in agents.values_mut() {
        if agent.state == "running" && finished.is_some() {
            agent.state = "unknown";
        }
    }
    let rows: Vec<Value> = order
        .iter()
        .map(|id| {
            let agent = &agents[id];
            let mut row = json!({"agentId":id,"label":agent.label,"state":agent.state});
            let own = session
                .join("subagents/workflows")
                .join(run)
                .join(format!("agent-{id}.jsonl"));
            if super::open_transcript(&own).is_ok() {
                row["childPath"] = json!(own.to_string_lossy());
            }
            for (key, value) in [
                ("phase", agent.phase.as_ref().map(|p| json!(p))),
                ("tokens", agent.tokens.map(|n| json!(n))),
                ("toolCalls", agent.tool_calls.map(|n| json!(n))),
                ("durationMs", agent.duration_ms.map(|n| json!(n))),
                ("last", agent.last.as_ref().map(|l| json!(l))),
            ] {
                if let Some(value) = value {
                    row[key] = value;
                }
            }
            row
        })
        .collect();
    let mut titles: Vec<String> = Vec::new();
    for title in file
        .iter()
        .flat_map(|file| file["phases"].as_array().into_iter().flatten())
        .filter_map(|phase| short(&phase["title"], 120))
        .chain(order.iter().filter_map(|id| agents[id].phase.clone()))
    {
        if !titles.contains(&title) && titles.len() < MAX_PHASES {
            titles.push(title);
        }
    }
    let phases: Vec<Value> = titles
        .iter()
        .map(|title| {
            let states: Vec<&str> = order
                .iter()
                .filter(|id| agents[*id].phase.as_ref() == Some(title))
                .map(|id| agents[id].state)
                .collect();
            let state = if states.contains(&"running") {
                "running"
            } else if states.contains(&"failed") {
                "failed"
            } else if states.contains(&"unknown") {
                "unknown"
            } else if states.is_empty() {
                "pending"
            } else {
                "done"
            };
            json!({"title":title,"state":state})
        })
        .collect();
    let total = |key: &str| {
        file.as_ref()
            .and_then(|file| file[key].as_u64())
            .unwrap_or_else(|| {
                agents
                    .values()
                    .map(|a| {
                        if key == "totalTokens" {
                            a.tokens
                        } else {
                            a.tool_calls
                        }
                        .unwrap_or(0)
                    })
                    .sum()
            })
    };
    let mut tree = json!({
        "phases": phases, "agents": rows,
        "totals": {"agents": order.len(), "tokens": total("totalTokens"), "toolCalls": total("totalToolCalls")},
    });
    if let Some(name) = file
        .as_ref()
        .and_then(|file| short(&file["workflowName"], 120))
    {
        tree["name"] = json!(name);
    }
    Some((tree, finished))
}
