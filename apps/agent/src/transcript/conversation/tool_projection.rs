use super::{Error, HashMap, Result, Value};
use serde_json::json;

fn target_fits(value: &str) -> bool {
    value.encode_utf16().count() <= 16 * 1024
}

fn call(name: &str, input: &str) -> Option<Value> {
    let input: Value = serde_json::from_str(input).unwrap_or(Value::Null);
    match name {
        "Bash" => {
            if input
                .get("run_in_background")
                .is_some_and(|value| !value.is_boolean())
            {
                return None;
            }
            input["command"]
                .as_str()
                .map(|command| json!({"kind":"execute","command":command}))
        }
        "Read" => input["file_path"]
            .as_str()
            .filter(|path| target_fits(path))
            .map(|path| json!({"kind":"read","path":path})),
        "Grep" | "Glob" => input["pattern"]
            .as_str()
            .filter(|query| target_fits(query))
            .map(|query| json!({"kind":"search","query":query})),
        "WebSearch" => {
            if let Some(mode) = input.get("mode") {
                if !matches!(mode.as_str(), Some("standard" | "extended")) {
                    return None;
                }
            }
            input["query"]
                .as_str()
                .filter(|query| !query.trim().is_empty() && target_fits(query))
                .map(|query| json!({"kind":"search","query":query}))
        }
        "WebFetch" => input["url"]
            .as_str()
            .filter(|url| target_fits(url))
            .map(|url| json!({"kind":"fetch","url":url})),
        "TodoWrite" | "AskUserQuestion" => {
            if name == "AskUserQuestion"
                && input["questions"].as_array()?.iter().any(|question| {
                    !question["multiSelect"].is_boolean() || !question["options"].is_array()
                })
            {
                return None;
            }
            let card = super::super::interaction::card(
                super::super::TranscriptAgent::Claude,
                name,
                &input,
            )?;
            if name == "TodoWrite" {
                let items = card["entries"]
                    .as_array()?
                    .iter()
                    .map(|entry| {
                        let state = match entry["status"].as_str()? {
                            "completed" => "done",
                            "pending" => "pending",
                            "in_progress" => "in_progress",
                            _ => return None,
                        };
                        Some(json!({"text":entry["text"],"state":state}))
                    })
                    .collect::<Option<Vec<_>>>()?;
                Some(json!({"kind":"plan","items":items}))
            } else {
                let questions = card["questions"].as_array()?.iter().map(|question| {
                    let mut item = json!({"text":question["question"],"multiple":question["multiple"],"options":question["options"]});
                    if let Some(header) = question.get("header") { item["header"] = header.clone(); }
                    item
                }).collect::<Vec<_>>();
                Some(json!({"kind":"question","questions":questions}))
            }
        }
        "Edit" | "Write" | "Task" | "Agent" | "ExitPlanMode" => None,
        _ => Some(json!({"kind":"other"})),
    }
}

pub(super) struct ToolResult {
    position: u64,
    status: &'static str,
    text: String,
    task: Option<(String, Option<String>)>,
    edit: Option<Value>,
    background: bool,
    background_uncertain: bool,
}

fn task(input: &str, result: &ToolResult) -> Option<Value> {
    if result.status != "ok" {
        return None;
    }
    let (id, recorded_agent) = result.task.as_ref()?;
    let input: Value = serde_json::from_str(input).ok()?;
    let agent = match input.get("subagent_type") {
        None => recorded_agent.as_deref()?,
        Some(value) => value
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control))?,
    };
    if recorded_agent
        .as_deref()
        .is_some_and(|recorded| agent != recorded)
    {
        return None;
    }
    Some(json!({"kind":"task","agent":agent,"agentId":id,"ongoing":false}))
}

pub(super) fn results(
    records: &[(u64, Value)],
    chain: &[usize],
) -> Result<HashMap<String, ToolResult>> {
    let mut results = HashMap::new();
    let mut calls = std::collections::HashSet::new();
    for index in chain {
        let (position, record) = &records[*index];
        if record["type"] == "assistant"
            && record["isMeta"] != true
            && record["isSidechain"] != true
            && record.get("teamName").is_none_or(Value::is_null)
        {
            for part in record["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if part["type"] == "tool_use" {
                    if let Some(id) = part["id"].as_str() {
                        if !calls.insert(id) {
                            return Err(Error::InvalidEvent);
                        }
                    }
                }
            }
        }
        if record["type"] != "user"
            || record["isMeta"] == true
            || record["isSidechain"] == true
            || record.get("teamName").is_some_and(|value| !value.is_null())
        {
            continue;
        }
        let Some(content) = record["message"]["content"].as_array() else {
            continue;
        };
        let single_result = content
            .iter()
            .filter(|item| item["type"] == "tool_result")
            .count()
            == 1;
        for part in content {
            if part["type"] != "tool_result" {
                continue;
            }
            let Some(id) = part["tool_use_id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 4096)
            else {
                continue;
            };
            let status = match part.get("is_error") {
                None | Some(Value::Bool(false)) => "ok",
                Some(Value::Bool(true)) => "error",
                _ => continue,
            };
            let text = super::super::content(part.get("content").unwrap_or(&Value::Null))
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let metadata = &record["toolUseResult"];
            let background_id = metadata.get("backgroundTaskId");
            let background = single_result
                && part["is_error"] == false
                && metadata["interrupted"] == false
                && background_id.and_then(Value::as_str).is_some_and(|id| {
                    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
                });
            let background_uncertain = background_id.is_some() && !background;
            let edit = (single_result && metadata.is_object()).then(|| {
                json!({
                    "filePath":metadata["filePath"], "type":metadata["type"],
                    "structuredPatch":metadata["structuredPatch"], "content":metadata["content"],
                    "originalFileIsNull":metadata.get("originalFile").is_some_and(Value::is_null),
                })
            });
            let task = if single_result {
                if metadata["status"] == "completed" && metadata.get("isAsync").is_none() {
                    let id = metadata["agentId"].as_str().filter(|id| {
                        !id.is_empty() && id.len() <= 4096 && !id.chars().any(char::is_control)
                    });
                    let agent = match metadata.get("agentType") {
                        None => Some(None),
                        Some(value) => value
                            .as_str()
                            .filter(|agent| {
                                !agent.is_empty()
                                    && agent.len() <= 4096
                                    && !agent.chars().any(char::is_control)
                            })
                            .map(|agent| Some(agent.to_owned())),
                    };
                    id.zip(agent).map(|(id, agent)| (id.to_owned(), agent))
                } else {
                    None
                }
            } else {
                None
            };
            if results
                .insert(
                    id.to_owned(),
                    ToolResult {
                        position: *position,
                        status,
                        text,
                        task,
                        edit,
                        background,
                        background_uncertain,
                    },
                )
                .is_some()
            {
                return Err(Error::InvalidEvent);
            }
        }
    }
    Ok(results)
}

pub(super) fn project(
    message: &mut Value,
    position: u64,
    results: &HashMap<String, ToolResult>,
) -> Result<()> {
    let blocks = message["blocks"].as_array().ok_or(Error::InvalidEvent)?;
    let results_only =
        !blocks.is_empty() && blocks.iter().all(|block| block["type"] == "tool_result");
    let mut parts = Vec::new();
    let mut revision = position;
    let mut partial = false;
    for block in blocks {
        if block["type"] == "tool_use" {
            let name = block["name"].as_str().unwrap_or("tool");
            let input = block["text"].as_str().unwrap_or("");
            let result = block["id"]
                .as_str()
                .and_then(|id| results.get(id))
                .filter(|result| result.position > position);
            if let Some(result) = result {
                revision = revision.max(result.position);
                let valid_name = !name.is_empty() && name.encode_utf16().count() <= 4096;
                partial |= !valid_name;
                let display_name = if valid_name { name } else { "tool" };
                let summary = display_name.lines().next().unwrap_or("tool");
                let display_input = if valid_name {
                    input.to_owned()
                } else {
                    format!("Recorded tool name: {name}\nInput: {input}")
                };
                let mut part = json!({"type":"tool","name":display_name,"summary":summary,"status":result.status,"input":display_input,"result":result.text});
                if name == "ExitPlanMode" && block["card"]["kind"] == "proposed_plan" {
                    part["card"] = block["card"].clone();
                }
                part["_toolCallId"] = block["id"].clone();
                let typed = match name {
                    _ if !valid_name => None,
                    "Agent" | "Task" => task(input, result),
                    "Edit" | "Write" if result.status == "ok" => result
                        .edit
                        .as_ref()
                        .and_then(|edit| super::claude_edits::project(name, input, edit)),
                    _ => call(name, input),
                };
                if let Some(mut call) = typed {
                    if name == "Bash" {
                        if result.background {
                            call["background"] = json!(true);
                        }
                        let requested = serde_json::from_str::<Value>(input)
                            .is_ok_and(|input| input["run_in_background"] == true);
                        partial |= result.background_uncertain || (requested && !result.background);
                    }
                    part["call"] = call;
                } else {
                    partial = true;
                }
                parts.push(part);
            } else {
                partial = true;
                let mut part = json!({"type":"text","text":format!("{name}: {input}")});
                if (name == "ExitPlanMode" && block["card"]["kind"] == "proposed_plan")
                    || (name == "AskUserQuestion"
                        && block["card"]["kind"] == "question"
                        && call(name, input).is_some())
                {
                    part["card"] = block["card"].clone();
                }
                parts.push(part);
            }
        } else if block["type"] == "tool_result" {
            parts.push(json!({"type":"text","text":block["text"],"_toolResultId":block["id"]}));
        } else {
            parts.push(block.clone());
        }
    }
    message["parts"] = json!(parts);
    message
        .as_object_mut()
        .ok_or(Error::InvalidEvent)?
        .remove("blocks");
    message["rev"] = json!(revision);
    message["source"] = json!("transcript");
    if results_only {
        message["role"] = json!("note");
    }
    if partial {
        message["partial"] = json!(true);
    }
    Ok(())
}

pub(super) fn suppress_paired_results(messages: &mut Vec<Value>, strip_markers: bool) {
    let calls: std::collections::HashSet<String> = messages
        .iter()
        .flat_map(|message| message["parts"].as_array().into_iter().flatten())
        .filter_map(|part| part["_toolCallId"].as_str().map(str::to_owned))
        .collect();
    for message in messages.iter_mut() {
        if let Some(parts) = message["parts"].as_array_mut() {
            parts.retain(|part| {
                !part["_toolResultId"]
                    .as_str()
                    .is_some_and(|id| calls.contains(id))
            });
            if strip_markers {
                for part in parts {
                    if let Some(object) = part.as_object_mut() {
                        object.remove("_toolCallId");
                        object.remove("_toolResultId");
                    }
                }
            }
        }
    }
    messages.retain(|message| {
        message["parts"]
            .as_array()
            .is_none_or(|parts| !parts.is_empty())
    });
}

pub(in crate::transcript) fn codex(
    message: &mut Value,
    event: &Value,
    position: u64,
    command_proven: bool,
) -> Result<()> {
    // Older Codex streams record the completed MCP result directly on the event.
    let legacy_mcp = (event["type"] == "mcp_tool_call_end").then(|| {
        let result = &event["result"];
        json!({
            "type":"McpToolCall", "result":result["Ok"], "error":result["Err"],
            "status":if result.get("Ok").is_some_and(Value::is_object) && result.get("Err").is_none() {"completed"} else {"unknown"},
        })
    });
    let item = legacy_mcp.as_ref().unwrap_or(&event["item"]);
    let canonical = item["type"] == "CommandExecution";
    let generic = matches!(
        item["type"].as_str(),
        Some("DynamicToolCall" | "McpToolCall")
    ) && (legacy_mcp.is_none()
        || matches!(
            (event["result"].get("Ok"), event["result"].get("Err")),
            (Some(Value::Object(_)), None) | (None, Some(Value::Object(_) | Value::String(_)))
        ));
    let legacy = matches!(
        event["type"].as_str(),
        Some("exec_command_begin" | "exec_command_end")
    );
    let source = if canonical { item } else { event };
    let valid_exit_code = source.get("exit_code").is_none_or(|value| {
        value.is_null()
            || value
                .as_i64()
                .is_some_and(|code| i32::try_from(code).is_ok())
    });
    let status = if (canonical || legacy) && (!valid_exit_code || !command_proven) {
        None
    } else if canonical {
        match item["status"].as_str() {
            Some("declined") => Some("denied"),
            Some("failed") => Some("error"),
            Some("completed") => Some(
                if item["exit_code"].as_i64().is_some_and(|code| code != 0) {
                    "error"
                } else {
                    "ok"
                },
            ),
            Some("in_progress" | "inProgress") => Some("running"),
            _ => None,
        }
    } else if generic {
        if item["error"].is_string()
            || item["error"]["message"].is_string()
            || item["success"] == false
            || item["result"]["isError"] == true
        {
            Some("error")
        } else if item["success"] == true
            || item["result"]["isError"] == false
            || (item["type"] == "McpToolCall"
                && item["status"] == "completed"
                && item["result"]["content"].as_array().is_some_and(|content| {
                    content
                        .iter()
                        .all(|part| part["type"] == "text" && part["text"].is_string())
                })
                && item["result"].get("isError").is_none()
                && item.get("success").is_none()
                && item["error"].is_null())
        {
            Some("ok")
        } else {
            None
        }
    } else if legacy && event["type"] == "exec_command_begin" {
        Some("running")
    } else if legacy {
        event["exit_code"]
            .as_i64()
            .and_then(|code| i32::try_from(code).ok())
            .map(|code| if code == 0 { "ok" } else { "error" })
    } else {
        None
    };
    let blocks = message["blocks"].as_array().ok_or(Error::InvalidEvent)?;
    let mut parts = Vec::new();
    let mut partial = false;
    if let Some(status) = status.filter(|_| generic) {
        let name = blocks
            .first()
            .and_then(|block| block["name"].as_str())
            .unwrap_or("tool");
        let input = blocks
            .first()
            .and_then(|block| block["text"].as_str())
            .unwrap_or("");
        let result = blocks
            .iter()
            .find(|block| block["type"] == "tool_result")
            .and_then(|block| block["text"].as_str())
            .unwrap_or("");
        parts.push(json!({"type":"tool","name":name,"summary":name.lines().next().unwrap_or("tool"),"status":status,"call":{"kind":"other"},"input":input,"result":result}));
    } else if let Some(status) = status {
        let command = blocks
            .first()
            .and_then(|block| block["text"].as_str())
            .unwrap_or("");
        let mut call = json!({"kind":"execute","command":command});
        if let Some(exit_code) = source["exit_code"].as_i64() {
            call["exitCode"] = json!(exit_code);
        }
        parts.push(json!({"type":"tool","name":"command","summary":"command","status":status,"call":call,"input":command,"result":source["aggregated_output"].as_str().unwrap_or("")}));
    } else {
        for block in blocks {
            if matches!(block["type"].as_str(), Some("tool_use" | "tool_result")) {
                partial = true;
                parts.push(json!({"type":"text","text":format!("{}: {}",block["name"].as_str().unwrap_or("tool"),block["text"].as_str().unwrap_or(""))}));
            } else {
                parts.push(block.clone());
            }
        }
    }
    if message["role"] == "tool" {
        message["role"] = json!("note");
    }
    message["parts"] = json!(parts);
    message
        .as_object_mut()
        .ok_or(Error::InvalidEvent)?
        .remove("blocks");
    message["rev"] = json!(position);
    message["source"] = json!("transcript");
    if partial {
        message["partial"] = json!(true);
    }
    Ok(())
}
