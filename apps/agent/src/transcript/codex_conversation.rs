//! Recorded UI history, qualified against Codex 0.166.0. Not model context.
use super::window::{select, Window};
use super::{
    codex_lineage, interaction, message_size, Error, Result, TranscriptAgent, TranscriptPage,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

#[derive(Default)]
struct Turn {
    id: String,
    explicit: bool,
    messages: Vec<Value>,
    items: HashMap<String, usize>,
    compacted: bool,
}
#[derive(Default)]
struct Projection {
    turns: Vec<Turn>,
    current: Option<Turn>,
}
impl Projection {
    fn finish(&mut self) {
        if let Some(turn) = self.current.take() {
            if turn.explicit || turn.compacted || !turn.messages.is_empty() {
                self.turns.push(turn);
            }
        }
    }
    fn turn(&mut self, id: Option<&str>) -> &mut Turn {
        if let Some(id) = id {
            if self.current.as_ref().is_some_and(|turn| turn.id == id) {
                return self.current.as_mut().unwrap();
            }
            if let Some(index) = self.turns.iter().position(|turn| turn.id == id) {
                return &mut self.turns[index];
            }
            if self.current.is_some() {
                self.finish();
            }
        }
        self.current.get_or_insert_with(|| Turn {
            id: id.unwrap_or("").to_owned(),
            ..Turn::default()
        })
    }
    fn put(&mut self, turn: Option<&str>, mut message: Value) -> Result<()> {
        message_size(&message)?;
        if message["blocks"].as_array().is_some_and(|blocks| {
            blocks.iter().any(|block| {
                ["text", "name", "id"].iter().any(|field| {
                    block[*field]
                        .as_str()
                        .is_some_and(|text| text.len() > 262_144)
                })
            })
        }) {
            return Err(Error::InvalidEvent);
        }
        let id = message["id"]
            .as_str()
            .ok_or(Error::InvalidEvent)?
            .to_owned();
        let turn = self.turn(turn);
        if !turn.id.is_empty() {
            let scoped = format!("{}:{}{}", turn.id.len(), turn.id, id);
            if scoped.len() > 4096 {
                return Err(Error::InvalidEvent);
            }
            message["id"] = json!(scoped);
        }
        if let Some(index) = turn.items.get(&id) {
            turn.messages[*index] = message;
        } else {
            turn.items.insert(id, turn.messages.len());
            turn.messages.push(message);
        }
        Ok(())
    }
}
fn text(kind: &str, value: &str) -> Value {
    json!({"type":kind,"text":value})
}
/// The embedded `data:` URL of a user-attached image part; a path or a link is never followed.
fn embedded_image(part: &Value) -> Option<Option<&Value>> {
    matches!(
        part["type"].as_str(),
        Some("image" | "Image" | "input_image" | "inputImage")
    )
    .then(|| part.get("image_url").or_else(|| part.get("url")))
}
/// A placeholder for the attachment, with the bounded preview only when the bytes are an admissible PNG or JPEG.
fn image_block(url: Option<&Value>) -> Value {
    let mut block = json!({"type":"image","text":"Attachment: view in the host agent terminal"});
    if let Some(preview) = url
        .and_then(Value::as_str)
        .and_then(super::inline_image::admit_data_url)
    {
        block["imagePreview"] = preview;
    }
    block
}
fn message(id: &str, role: &str, blocks: Vec<Value>, timestamp: &Value) -> Option<Value> {
    if blocks.is_empty() {
        return None;
    }
    let mut value = json!({"id":id,"role":role,"blocks":blocks});
    if let Some(timestamp) = timestamp.as_str() {
        value["timestamp"] = json!(timestamp);
    }
    Some(value)
}
fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or(Error::InvalidEvent)
}
fn output_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| {
            matches!(
                part["type"].as_str(),
                Some("input_text" | "output_text" | "text" | "inputText")
            )
            .then(|| part["text"].as_str())
            .flatten()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn canonical(item: &Value, timestamp: &Value, images: bool) -> Result<Option<Value>> {
    let kind = required(item, "type")?;
    let id = required(item, "id")?;
    let (role, blocks) = match kind {
        "UserMessage" | "AgentMessage" => {
            let parts = item["content"].as_array().ok_or(Error::InvalidEvent)?;
            let blocks = parts
                .iter()
                .filter_map(|part| {
                    if images && kind == "UserMessage" {
                        if let Some(url) = embedded_image(part) {
                            return Some(image_block(url));
                        }
                    }
                    matches!(part["type"].as_str(), Some("text" | "Text"))
                        .then(|| part["text"].as_str())
                        .flatten()
                        .map(|s| text("text", s))
                })
                .collect();
            (
                if kind == "UserMessage" {
                    "user"
                } else {
                    "assistant"
                },
                blocks,
            )
        }
        "Reasoning" => (
            "assistant",
            item["summary_text"]
                .as_array()
                .ok_or(Error::InvalidEvent)?
                .iter()
                .filter_map(Value::as_str)
                .map(|s| text("thinking", s))
                .collect(),
        ),
        "Plan" => ("assistant", {
            let value = item["text"].as_str().ok_or(Error::InvalidEvent)?;
            if value.is_empty() {
                Vec::new()
            } else {
                vec![json!({"type":"text","text":value,"card":{"kind":"proposed_plan"}})]
            }
        }),
        "CommandExecution" => {
            let command = item["command"]
                .as_array()
                .ok_or(Error::InvalidEvent)?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            let mut blocks =
                vec![json!({"type":"tool_use","id":id,"name":"command","text":command})];
            if let Some(output) = item["aggregated_output"].as_str() {
                let failed = matches!(item["status"].as_str(), Some("failed" | "declined"))
                    || item["exit_code"].as_i64().is_some_and(|n| n != 0);
                blocks.push(json!({"type":"tool_result","id":id,"text":output,"isError":failed}));
            }
            ("assistant", blocks)
        }
        "FunctionCallOutput" => {
            let name = required(item, "name")?;
            if !item["output"].is_string() && !item["output"].is_array() {
                return Err(Error::InvalidEvent);
            }
            let output = output_text(&item["output"]);
            (
                "tool",
                vec![json!({"type":"tool_result","id":id,"name":name,"text":output})],
            )
        }
        "DynamicToolCall" | "McpToolCall" => {
            let tool = required(item, "tool")?;
            let mut blocks = vec![
                json!({"type":"tool_use","id":id,"name":tool,"text":item["arguments"].to_string()}),
            ];
            let parts = if kind == "DynamicToolCall" {
                &item["content_items"]
            } else {
                &item["result"]["content"]
            };
            let mut output = output_text(parts);
            let error = item["error"]
                .as_str()
                .or_else(|| item["error"]["message"].as_str());
            if let Some(error) = error {
                if !output.is_empty() {
                    output.push('\n');
                }
                output.push_str(error);
            }
            if !parts.is_null() || error.is_some() {
                blocks.push(json!({"type":"tool_result","id":id,"text":output,"isError":error.is_some() || item["success"] == false || item["result"]["isError"] == true}));
            }
            ("assistant", blocks)
        }
        // Other recorded provider surfaces do not gain approval/stop authority.
        _ => return Ok(None),
    };
    Ok(message(id, role, blocks, timestamp))
}
fn legacy(event: &Value, key: &str, timestamp: &Value, images: bool) -> Result<Option<Value>> {
    let kind = required(event, "type")?;
    let (role, blocks, id) = match kind {
        "user_message" | "agent_message" => (
            if kind == "user_message" {
                "user"
            } else {
                "assistant"
            },
            event["message"]
                .as_str()
                .map(|s| {
                    let mut blocks = vec![text("text", s)];
                    if images && kind == "user_message" {
                        // A local file is never read: it only says an image was attached.
                        let attached = |key: &str| event[key].as_array().into_iter().flatten();
                        blocks.extend(attached("images").map(|url| image_block(Some(url))));
                        blocks.extend(attached("local_images").map(|_| image_block(None)));
                    }
                    blocks
                })
                .ok_or(Error::InvalidEvent)?,
            key.to_owned(),
        ),
        "agent_reasoning" => (
            "assistant",
            event["text"]
                .as_str()
                .map(|s| vec![text("thinking", s)])
                .ok_or(Error::InvalidEvent)?,
            key.to_owned(),
        ),
        "exec_command_begin" | "exec_command_end" => {
            let id = required(event, "call_id")?;
            let command = event["command"]
                .as_array()
                .map(|args| {
                    args.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let mut blocks =
                vec![json!({"type":"tool_use","id":id,"name":"command","text":command})];
            if kind == "exec_command_end" {
                let output = event["aggregated_output"].as_str().unwrap_or("");
                blocks.push(json!({"type":"tool_result","id":id,"text":output,"isError":event["exit_code"].as_i64().is_some_and(|n|n != 0)}));
            }
            ("assistant", blocks, format!("command:{id}"))
        }
        "dynamic_tool_call_response" => {
            let mut item = event.clone();
            item["type"] = json!("DynamicToolCall");
            item["id"] = json!(required(event, "call_id")?);
            return canonical(&item, timestamp, images);
        }
        "mcp_tool_call_end" => {
            let item = json!({"type":"McpToolCall","id":required(event,"call_id")?,"tool":event["invocation"]["tool"],"arguments":event["invocation"]["arguments"],"result":event["result"]["Ok"],"error":event["result"]["Err"]});
            return canonical(&item, timestamp, images);
        }
        "item_completed" => return canonical(&event["item"], timestamp, images),
        _ => return Ok(None),
    };
    Ok(message(&id, role, blocks, timestamp))
}

/// Track recorded `request_user_input` calls that have no output yet.
fn pending_question(payload: &Value, asked: &mut HashSet<String>) {
    let Some(call) = payload["call_id"].as_str() else {
        return;
    };
    match payload["type"].as_str() {
        Some("function_call")
            if payload["name"]
                .as_str()
                .is_some_and(|name| interaction::awaits_answer(TranscriptAgent::Codex, name)) =>
        {
            asked.insert(call.to_owned());
        }
        Some("function_call_output") => {
            asked.remove(call);
        }
        _ => {}
    }
}

pub(super) fn conversation(
    path: &Path,
    limit: u8,
    images: bool,
    window: &Window,
) -> Result<TranscriptPage> {
    project(codex_lineage::read(path)?, limit, images, window)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn anchored(
    root: &crate::managed_directory::Directory,
    path: &Path,
    limit: u8,
    expected: &super::SourceSnapshot,
    window: &Window,
) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    project(
        codex_lineage::read_anchored(root, path, expected)?,
        limit,
        false,
        window,
    )
}

fn project(
    history: codex_lineage::History,
    limit: u8,
    images: bool,
    window: &Window,
) -> Result<TranscriptPage> {
    let mut projection = Projection::default();
    let mut activity = None;
    let mut asked = HashSet::new();
    let mut agents = super::work::CodexAgents::default();
    for record in &history.records {
        let value = &record.value;
        if value["type"] == "response_item" {
            // Turn state only: model-context items never become messages here.
            pending_question(&value["payload"], &mut asked);
            if value["payload"]["type"] == "agent_message" {
                agents.message(&value["payload"], value["timestamp"].as_str());
            }
        }
        if value["type"] == "compacted" {
            projection.turn(None).compacted = true;
            continue;
        }
        if value["type"] != "event_msg" {
            continue;
        }
        let event = &value["payload"];
        if event["type"] == "item_completed" && event["item"]["type"] == "SubAgentActivity" {
            agents.observe(&event["item"], value["timestamp"].as_str());
        }
        match required(event, "type")? {
            "task_started" | "turn_started" => {
                activity = Some("working");
                projection.finish();
                projection.current = Some(Turn {
                    id: required(event, "turn_id")?.to_owned(),
                    explicit: true,
                    ..Turn::default()
                });
                continue;
            }
            "turn_aborted" => {
                activity = Some("stopped");
                asked.clear();
                continue;
            }
            "task_complete" | "turn_complete" => {
                activity = Some("idle");
                asked.clear();
                if event["turn_id"]
                    .as_str()
                    .is_some_and(|id| projection.turns.iter().any(|turn| turn.id == id))
                {
                    continue;
                }
                projection.finish();
                continue;
            }
            "thread_rolled_back" => {
                let count = event["num_turns"].as_u64().ok_or(Error::InvalidEvent)?;
                projection.finish();
                projection.turns.truncate(
                    projection
                        .turns
                        .len()
                        .saturating_sub(usize::try_from(count).unwrap_or(usize::MAX)),
                );
                continue;
            }
            "user_message"
                if history.mode == "legacy"
                    && projection.current.as_ref().is_some_and(|turn| {
                        !turn.explicit && !(turn.compacted && turn.messages.is_empty())
                    }) =>
            {
                projection.finish()
            }
            _ => {}
        }
        let projected = if history.mode == "paginated" {
            if !matches!(
                event["type"].as_str(),
                Some("item_started" | "item_completed")
            ) {
                continue;
            }
            required(event, "turn_id")?;
            if required(event, "thread_id")? != record.thread {
                return Err(Error::InvalidEvent);
            }
            canonical(&event["item"], &value["timestamp"], images)?
        } else {
            // Legacy compatibility events own display text; response_item is
            // model context and can contain reinjection/private compaction data.
            if event["type"] == "item_completed"
                && matches!(
                    event["item"]["type"].as_str(),
                    Some("UserMessage" | "AgentMessage" | "Reasoning")
                )
            {
                continue;
            }
            legacy(event, &record.key, &value["timestamp"], images)?
        };
        if let Some(message) = projected {
            let turn = event["turn_id"].as_str().filter(|id| !id.is_empty());
            projection.put(turn, message)?;
        }
    }
    projection.finish();
    let all = projection
        .turns
        .into_iter()
        .flat_map(|turn| turn.messages)
        .collect::<Vec<_>>();
    let selected = select(all, window, limit)?;
    history.verify()?;
    Ok(TranscriptPage {
        schema_version: 1,
        view: "active_branch",
        agent: TranscriptAgent::Codex,
        messages: selected.messages,
        next_offset: history.offset,
        has_more: false,
        branch_id: Some(history.thread),
        truncated: selected.has_older,
        has_newer: selected.has_newer,
        checkpoint: None,
        activity: match activity {
            Some("working") if !asked.is_empty() => Some("waiting"),
            other => other,
        },
        queued: Vec::new(),
        work: agents.into_work(),
    })
}
