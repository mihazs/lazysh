//! Sub-agents of an OpenCode conversation, read from its `task` tool parts.
//!
//! Recorded evidence only. A `task` call runs the sub-agent to its end: `pending` and `running` are running, `completed` is
//! done and `error` is failed. A background `task` (`run_in_background`, or a recorded `backgroundTaskId`) completes at its
//! launch; it then ends at a later `background_output` call for the same task that reports a final `Status:`, or at a
//! `[BACKGROUND TASK COMPLETED]` reminder that lists it under `**Completed:**`. Nothing else is guessed: a background
//! sub-agent with no recorded end stays `running`, as for Claude Code.
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const MAX_TASKS: usize = 100;
const MAX_TEXT: usize = 200;

fn clip(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}
fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(clip)
}
fn stamp(millis: &Value) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis.as_i64()?)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}
/// The tool's name: `tool` in a V1 part, `name` in a V2 one.
fn tool_name(part: &Value) -> Option<&str> {
    part["tool"].as_str().or_else(|| part["name"].as_str())
}
/// The final state a `background_output` result reports (`Status: completed`), if any.
fn reported(output: &str) -> Option<&'static str> {
    let status = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("Status:"))?
        .trim();
    match status {
        "completed" => Some("done"),
        "error" | "failed" => Some("failed"),
        "cancelled" | "interrupted" => Some("stopped"),
        _ => None,
    }
}

/// The task ids a `[BACKGROUND TASK COMPLETED]` reminder lists under `**Completed:**`, as ``- `bg_id`: title`` lines.
fn completed(text: &str) -> Vec<&str> {
    if !text.contains("[BACKGROUND TASK COMPLETED]") {
        return Vec::new();
    }
    let Some((_, listed)) = text.split_once("**Completed:**") else {
        return Vec::new();
    };
    listed
        .lines()
        .skip(1)
        .map_while(|line| line.trim().strip_prefix("- `"))
        .filter_map(|rest| rest.split_once('`').map(|(id, _)| id))
        .collect()
}

/// The sub-agents in `parts` (and the text of the messages around them), which must come in conversation order.
pub(super) fn tasks<'a>(parts: impl IntoIterator<Item = &'a Value>) -> Option<Vec<Value>> {
    let mut items: Vec<Map<String, Value>> = Vec::new();
    let mut background: HashMap<String, usize> = HashMap::new();
    for part in parts {
        if let Some(text) = part["text"].as_str() {
            for id in completed(text) {
                if let Some(&position) = background.get(id) {
                    items[position].insert("state".into(), json!("done"));
                }
            }
        }
        if part["type"] != "tool" {
            continue;
        }
        let state = &part["state"];
        match tool_name(part) {
            Some("task") => {
                let input = &state["input"];
                let id = part["callID"].as_str().or_else(|| part["id"].as_str());
                let (Some(id), Some(status)) =
                    (id.filter(|id| id.len() <= 256), state["status"].as_str())
                else {
                    continue;
                };
                let launched = state["metadata"]["backgroundTaskId"]
                    .as_str()
                    .filter(|id| id.len() <= 256);
                let title = string(&input["description"])
                    .or_else(|| string(&input["subagent_type"]))
                    .unwrap_or_else(|| "task".to_owned());
                let finished = match status {
                    "completed" if launched.is_some() || input["run_in_background"] == true => None,
                    "completed" => Some("done"),
                    "error" => Some("failed"),
                    "pending" | "running" => None,
                    _ => continue,
                };
                let mut item = Map::new();
                item.insert("id".into(), json!(id));
                item.insert("kind".into(), json!("agent"));
                item.insert("title".into(), json!(title));
                item.insert("state".into(), json!(finished.unwrap_or("running")));
                item.insert("events".into(), json!([]));
                for (key, value) in [
                    ("subtitle", string(&input["subagent_type"])),
                    (
                        "taskId",
                        launched
                            .map(str::to_owned)
                            .or_else(|| string(&state["metadata"]["sessionId"])),
                    ),
                    ("startedAt", stamp(&state["time"]["start"])),
                    (
                        "endedAt",
                        finished.and_then(|_| stamp(&state["time"]["end"])),
                    ),
                ] {
                    if let Some(value) = value {
                        item.insert(key.into(), json!(value));
                    }
                }
                if let Some(launched) = launched {
                    background.insert(launched.to_owned(), items.len());
                }
                items.push(item);
            }
            Some("background_output") => {
                let ended = state["output"].as_str().and_then(reported);
                if let (Some(ended), Some(&position)) = (
                    ended,
                    state["input"]["task_id"]
                        .as_str()
                        .and_then(|id| background.get(id)),
                ) {
                    items[position].insert("state".into(), json!(ended));
                    if let Some(at) = stamp(&state["time"]["end"]) {
                        items[position].insert("endedAt".into(), json!(at));
                    }
                }
            }
            _ => {}
        }
    }
    let skip = items.len().saturating_sub(MAX_TASKS);
    let work: Vec<Value> = items.into_iter().skip(skip).map(Value::Object).collect();
    (!work.is_empty()).then_some(work)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(call: &str, status: &str, input: Value, metadata: Value) -> Value {
        json!({"type":"tool","tool":"task","callID":call,"state":{"status":status,"input":input,"metadata":metadata,"time":{"start":1_785_941_702_000_i64,"end":1_785_941_762_000_i64}}})
    }

    #[test]
    fn a_foreground_task_ends_with_its_call_and_a_background_one_at_its_reported_status() {
        let parts = [
            task(
                "c1",
                "completed",
                json!({"description":"Map config","subagent_type":"explore"}),
                json!({"sessionId":"ses_a"}),
            ),
            task("c2", "error", json!({"description":"Broken"}), json!({})),
            task("c3", "running", json!({"description":"Now"}), json!({})),
            task(
                "c4",
                "completed",
                json!({"description":"Research","subagent_type":"librarian","run_in_background":true}),
                json!({"backgroundTaskId":"bg_1","sessionId":"ses_b"}),
            ),
            task(
                "c5",
                "completed",
                json!({"description":"Still going","run_in_background":true}),
                json!({"backgroundTaskId":"bg_2"}),
            ),
            json!({"type":"tool","tool":"background_output","callID":"o1","state":{"status":"completed","input":{"task_id":"bg_1"},"output":"# Full Session Output\n\nTask ID: bg_1\nStatus: completed\n","time":{"end":1_785_941_999_000_i64}}}),
            json!({"type":"tool","tool":"background_output","callID":"o2","state":{"status":"completed","input":{"task_id":"bg_2"},"output":"Status: running\n"}}),
        ];
        let work = tasks(&parts).unwrap();
        let rows: Vec<_> = work
            .iter()
            .map(|t| (t["title"].as_str().unwrap(), t["state"].as_str().unwrap()))
            .collect();
        assert_eq!(
            rows,
            [
                ("Map config", "done"),
                ("Broken", "failed"),
                ("Now", "running"),
                ("Research", "done"),
                ("Still going", "running")
            ]
        );
        assert_eq!(work[0]["subtitle"], "explore");
        assert_eq!(work[0]["taskId"], "ses_a");
        assert_eq!(work[0]["startedAt"], "2026-08-05T14:55:02Z");
        assert_eq!(work[3]["taskId"], "bg_1");
        assert_eq!(work[3]["endedAt"], "2026-08-05T14:59:59Z");
        // A background task has no end of its own: its launch is not one.
        assert!(work[4].get("endedAt").is_none());
    }

    #[test]
    fn a_completed_reminder_ends_the_background_tasks_it_lists_and_no_others() {
        let parts = [
            task(
                "c1",
                "completed",
                json!({"description":"One","run_in_background":true}),
                json!({"backgroundTaskId":"bg_1"}),
            ),
            task(
                "c2",
                "completed",
                json!({"description":"Two","run_in_background":true}),
                json!({"backgroundTaskId":"bg_2"}),
            ),
            json!({"text":"<system-reminder>\n[BACKGROUND TASK COMPLETED]\n\n**Completed:**\n- `bg_1`: One\n\nAll sibling tasks are not complete. Call background_output for `bg_2`.\n</system-reminder>"}),
            // The same words from the agent itself, without the reminder's marker, end nothing.
            json!({"type":"text","text":"**Completed:**\n- `bg_2`: Two"}),
        ];
        let states: Vec<_> = tasks(&parts)
            .unwrap()
            .iter()
            .map(|t| t["state"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(states, ["done", "running"]);
    }

    #[test]
    fn other_tools_and_a_conversation_without_tasks_report_no_work() {
        assert!(tasks(&[
            json!({"type":"tool","tool":"bash","callID":"b","state":{"status":"completed"}}),
            json!({"type":"text","text":"hi"})
        ])
        .is_none());
    }

    #[test]
    fn a_v2_part_names_its_tool_in_name() {
        let part = json!({"type":"tool","id":"t1","name":"task","state":{"status":"pending","input":{"description":"V2"}}});
        assert_eq!(tasks(&[part]).unwrap()[0]["state"], "running");
    }
}
