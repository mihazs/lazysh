//! Display-only plan and question cards projected from recorded tool calls.
//!
//! Each agent's tool names and argument shapes come from recorded sessions and
//! official schemas listed in `tests/fixtures/interaction-cards/README.md`. A
//! shape that does not match exactly yields no card; the original tool card
//! remains. Cards never carry answers or authority to answer. An error card marks the
//! API-error message Claude Code writes as an assistant record.
use super::TranscriptAgent;
use serde_json::{json, Value};

const MAX_ITEMS: usize = 100;
const MAX_OPTIONS: usize = 20;
const MAX_TEXT: usize = 16 * 1024;
const PLAN_STATUSES: [&str; 3] = ["pending", "in_progress", "completed"];
const OPENCODE_STATUSES: [&str; 4] = ["pending", "in_progress", "completed", "cancelled"];

fn bounded(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty() && text.len() <= MAX_TEXT)
}

/// `None` when present but invalid; `Some(None)` when absent.
fn optional(value: &Value) -> Option<Option<&str>> {
    if value.is_null() {
        return Some(None);
    }
    value
        .as_str()
        .filter(|text| text.len() <= MAX_TEXT)
        .map(|text| Some(text).filter(|text| !text.trim().is_empty()))
}

fn list(value: &Value, limit: usize) -> Option<&Vec<Value>> {
    value
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= limit)
}

fn plan(items: &Value, text: &str, statuses: &[&str]) -> Option<Value> {
    let entries = list(items, MAX_ITEMS)?
        .iter()
        .map(|item| {
            let status = item["status"].as_str().filter(|s| statuses.contains(s))?;
            Some(json!({"text":bounded(&item[text])?,"status":status}))
        })
        .collect::<Option<Vec<_>>>()?;
    Some(json!({"kind":"plan","entries":entries}))
}

fn options(value: &Value) -> Option<Vec<Value>> {
    if value.is_null() {
        return Some(Vec::new());
    }
    list(value, MAX_OPTIONS)?
        .iter()
        .map(|option| {
            let mut card = json!({"label":bounded(&option["label"])?});
            if let Some(description) = optional(&option["description"])? {
                card["description"] = json!(description);
            }
            Some(card)
        })
        .collect()
}

fn questions(input: &Value, multiple: Option<&str>) -> Option<Value> {
    let questions = list(&input["questions"], MAX_OPTIONS)?
        .iter()
        .map(|item| {
            let selection = match multiple.map(|field| &item[field]) {
                None | Some(Value::Null) => false,
                Some(value) => value.as_bool()?,
            };
            let mut card = json!({
                "question":bounded(&item["question"])?,
                "options":options(&item["options"])?,
                "multiple":selection,
            });
            if let Some(header) = optional(&item["header"])? {
                card["header"] = json!(header);
            }
            Some(card)
        })
        .collect::<Option<Vec<_>>>()?;
    Some(json!({"kind":"question","questions":questions}))
}

/// A Grok ACP `plan` update, which replaces the whole plan: `entries[{content,status}]`.
pub(super) fn grok_plan(update: &Value) -> Option<Value> {
    plan(&update["entries"], "content", &PLAN_STATUSES)
}

/// Recognized tools that stop the turn until the user answers in the terminal.
pub(super) fn awaits_answer(agent: TranscriptAgent, name: &str) -> bool {
    matches!(
        (agent, name),
        (TranscriptAgent::Claude, "AskUserQuestion" | "ExitPlanMode")
            | (TranscriptAgent::Codex, "request_user_input")
            | (TranscriptAgent::Opencode, "question")
    )
}

pub(super) fn card(agent: TranscriptAgent, name: &str, input: &Value) -> Option<Value> {
    match (agent, name) {
        (TranscriptAgent::Claude, "TodoWrite") => plan(&input["todos"], "content", &PLAN_STATUSES),
        (TranscriptAgent::Opencode, "todowrite") => {
            plan(&input["todos"], "content", &OPENCODE_STATUSES)
        }
        (TranscriptAgent::Codex, "update_plan") => {
            let mut card = plan(&input["plan"], "step", &PLAN_STATUSES)?;
            if let Some(explanation) = optional(&input["explanation"])? {
                card["explanation"] = json!(explanation);
            }
            Some(card)
        }
        (TranscriptAgent::Claude, "ExitPlanMode") => {
            Some(json!({"kind":"proposed_plan","text":bounded(&input["plan"])?}))
        }
        (TranscriptAgent::Claude, "AskUserQuestion") => questions(input, Some("multiSelect")),
        (TranscriptAgent::Opencode, "question") => questions(input, Some("multiple")),
        (TranscriptAgent::Codex, "request_user_input") => questions(input, None),
        _ => None,
    }
}

/// Attach cards to normalized tool calls whose text is the recorded JSON input.
pub(super) fn annotate(agent: TranscriptAgent, blocks: &mut [Value]) {
    for block in blocks
        .iter_mut()
        .filter(|block| block["type"] == "tool_use")
    {
        let Some(name) = block["name"].as_str() else {
            continue;
        };
        let Some(input) = block["text"]
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
        else {
            continue;
        };
        if let Some(card) = card(agent, name, &input) {
            block["card"] = card;
        }
    }
}

/// Causes of a recorded Claude Code API-error message (`isApiErrorMessage` with an `error` string). Only these have a
/// synthetic fixture (`tests/fixtures/interaction-cards/README.md`); any other cause stays an ordinary assistant message.
const API_ERRORS: [&str; 4] = ["rate_limit", "server_error", "invalid_request", "unknown"];

/// Turns the text of a recorded API-error message into an error card; the text itself says what to do next
/// (for a usage limit it carries the reset time).
pub(super) fn error_card(agent: TranscriptAgent, record: &Value, blocks: &mut [Value]) {
    if !matches!(agent, TranscriptAgent::Claude) || record["isApiErrorMessage"] != true {
        return;
    }
    let Some(cause) = record["error"]
        .as_str()
        .filter(|cause| API_ERRORS.contains(cause))
    else {
        return;
    };
    if let Some(block) = blocks.iter_mut().find(|block| block["type"] == "text") {
        block["card"] = json!({"kind":"error","cause":cause});
    }
}
