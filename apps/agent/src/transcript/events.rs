//! Compact event lines for harness records that change what the agent does or says.
//!
//! Chosen by recorded Claude Code shapes: a goal being set or reached, plan mode on and off, the away recap
//! and a failed hook. Everything else the harness writes (hook successes, skill and tool listings, environment
//! and instruction wrappers, repeated goal checks) stays hidden because it outnumbers the conversation.
use serde_json::{json, Value};

const MAX_TEXT: usize = 2000;

fn clip(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(MAX_TEXT).collect())
}

fn event(record: &Value) -> Option<Value> {
    let attachment = &record["attachment"];
    match (record["type"].as_str()?, record["subtype"].as_str()) {
        ("attachment", _) => match attachment["type"].as_str()? {
            // Each turn re-checks an unmet goal; only its setting (`sentinel`) and its reaching are events.
            "goal_status" if attachment["met"] == true => Some(
                json!({"kind":"goalMet","text":clip(&attachment["condition"]).unwrap_or_default(),"detail":clip(&attachment["reason"])}),
            ),
            "goal_status" if attachment["sentinel"] == true => {
                Some(json!({"kind":"goal","text":clip(&attachment["condition"])?}))
            }
            "plan_mode" if attachment["isSubAgent"] != true => {
                Some(json!({"kind":"planMode","text":""}))
            }
            "plan_mode_reentry" => Some(json!({"kind":"planMode","text":""})),
            "plan_mode_exit" => Some(json!({"kind":"planModeExit","text":""})),
            "hook_non_blocking_error" => Some(json!({
                "kind":"hookFailed","text":clip(&attachment["hookName"]).unwrap_or_default(),
                "detail":clip(&attachment["stderr"]).or_else(|| clip(&attachment["command"])),
            })),
            _ => None,
        },
        ("system", Some("away_summary")) => {
            Some(json!({"kind":"recap","text":clip(&record["content"])?}))
        }
        _ => None,
    }
}

/// An `event` message for a conversation view, or `None` for every other record.
pub(super) fn claude(record: &Value) -> Option<Value> {
    let mut event = event(record)?;
    if event["detail"].is_null() {
        event.as_object_mut()?.remove("detail");
    }
    Some(message(
        record["uuid"].as_str()?,
        event,
        &record["timestamp"],
    ))
}

fn message(id: &str, event: Value, timestamp: &Value) -> Value {
    let mut message = json!({"id":id,"role":"event","blocks":[],"event":event});
    if let Some(timestamp) = timestamp.as_str() {
        message["timestamp"] = json!(timestamp);
    }
    message
}

/// The conversation was summarized: a Codex `compacted` record or an OpenCode `compaction` part.
pub(super) fn compacted(id: &str, timestamp: &Value) -> Value {
    message(id, json!({"kind":"compacted","text":""}), timestamp)
}

/// Codex `thread_goal_updated`: a goal being set (`active`) or reached (`complete`); other statuses are not shown.
pub(super) fn codex_goal(id: &str, goal: &Value, timestamp: &Value) -> Option<Value> {
    let kind = match goal["status"].as_str()? {
        "active" => "goal",
        "complete" | "completed" => "goalMet",
        _ => return None,
    };
    Some(message(
        id,
        json!({"kind":kind,"text":clip(&goal["objective"])?}),
        timestamp,
    ))
}

/// A record read through a provider session id keeps only the fields an event line needs.
pub(super) fn trim(record: &mut Value) {
    const KEPT: [&str; 9] = [
        "type",
        "met",
        "sentinel",
        "condition",
        "reason",
        "isSubAgent",
        "hookName",
        "stderr",
        "command",
    ];
    if let Some(attachment) = record["attachment"].as_object_mut() {
        attachment.retain(|key, _| KEPT.contains(&key.as_str()));
    }
    if record["subtype"] != "away_summary" {
        if let Some(object) = record.as_object_mut() {
            object.remove("content");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{conversation::project_claude_bounded, window::Window, MAX_LINE};

    /// Read through a provider session id, non-message records are cut down first; event lines survive that cut
    /// and carry nothing beyond what they show.
    #[test]
    fn session_reads_keep_event_lines_and_drop_the_rest_of_the_record() {
        let log: String = include_str!("../../tests/fixtures/claude-events.jsonl")
            .lines()
            .map(|line| {
                let mut record: serde_json::Value = serde_json::from_str(line).unwrap();
                record["sessionId"] = "s1".into();
                record["attachment"]["stdout"] = "secret".into();
                format!("{record}\n")
            })
            .collect();
        let page = project_claude_bounded(
            log.into_bytes(),
            100,
            false,
            MAX_LINE,
            10_000,
            Some("s1"),
            &Window::Tail,
        )
        .unwrap();
        let kinds: Vec<_> = page
            .messages
            .iter()
            .filter(|message| message["role"] == "event")
            .map(|message| message["event"]["kind"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            kinds,
            [
                "goal",
                "planMode",
                "planModeExit",
                "hookFailed",
                "recap",
                "goalMet"
            ]
        );
        assert!(!serde_json::to_string(&page.messages)
            .unwrap()
            .contains("secret"));
    }
}
