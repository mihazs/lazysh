#[path = "support/recorded_conversations.rs"]
mod recorded_conversations;

use lazysh_agent::transcript::{
    claude_conversation_v2, codex_conversation_v2, codex_conversation_v3, conversation, discover,
    TranscriptAgent,
};
use serde_json::{json, Value};
use std::{fs, process::Command};

#[test]
fn transcript_capabilities_are_machine_readable_without_a_source() {
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .arg("transcript-capabilities")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({
            "schemaVersion":1,"conversationSchemas":[1,2,3],"herdrConversationSchemas":[1,2,3]
        })
    );
}

#[path = "support/jsonl.rs"]
mod jsonl;
use jsonl::write;
fn message(id: &str, parent: Option<&str>, role: &str, text: &str) -> Value {
    json!({"type":role,"uuid":id,"parentUuid":parent,"message":{"content":text}})
}
fn claude_call(name: &str, input: Value) -> Value {
    json!({"type":"assistant","uuid":"call","parentUuid":"root","message":{"content":[{"type":"tool_use","id":"tool1","name":name,"input":input}]}})
}
fn add_unrelated_result(record: &mut Value) {
    record["message"]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"tool_result","tool_use_id":"other","content":"unrelated"}));
}
fn assert_unmatched_call_is_partial(path: &std::path::Path, records: &[Value]) {
    write(path, records);
    let page = claude_conversation_v2(path, 50).unwrap();
    assert_eq!(page.messages[1]["partial"], true);
    assert_eq!(page.messages[1]["parts"][0]["type"], "text");
}
fn assert_claude_partial(path: &std::path::Path, records: &[Value]) {
    write(path, records);
    assert_eq!(
        claude_conversation_v2(path, 50).unwrap().messages[1]["partial"],
        true
    );
}
fn claude_failed_result(path: &std::path::Path, records: &mut [Value]) -> Value {
    records[2]["message"]["content"][0]["is_error"] = json!(true);
    write(path, records);
    let page = claude_conversation_v2(path, 50).unwrap();
    assert_eq!(page.messages[1]["parts"][0]["status"], "error");
    page.messages[1]["parts"][0].clone()
}
fn claude_fixture(name: &str, input: Value) -> (tempfile::TempDir, std::path::PathBuf, Vec<Value>) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let records = vec![
        message("root", None, "user", "inspect"),
        claude_call(name, input),
    ];
    (directory, path, records)
}
fn ids(page: &lazysh_agent::transcript::TranscriptPage) -> Vec<&str> {
    page.messages
        .iter()
        .map(|message| message["id"].as_str().unwrap())
        .collect()
}

#[test]
fn schema_two_pairs_late_claude_result_without_inventing_running_or_denied() {
    let (_directory, path, mut records) = claude_fixture("future_tool", json!({"path":"example"}));
    write(&path, &records);
    let pending = claude_conversation_v2(&path, 50).unwrap();
    let call = pending.messages.last().unwrap();
    assert_eq!(call["partial"], true);
    assert_eq!(call["parts"][0]["type"], "text");
    let original_rev = call["rev"].as_u64().unwrap();
    records.push(json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"denied","is_error":true}]}}));
    write(&path, &records);
    let page = claude_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages.len(), 2);
    let call = &page.messages[1];
    assert!(call["rev"].as_u64().unwrap() > original_rev);
    assert_eq!(call["parts"][0]["status"], "error");
    assert_eq!(call["parts"][0]["call"]["kind"], "other");
    assert_eq!(call["parts"][0]["result"], "denied");
    assert_eq!(
        claude_conversation_v2(&path, 1).unwrap().messages[0]["parts"][0]["text"],
        "denied"
    );
    assert_eq!(
        conversation(&path, TranscriptAgent::Claude, 50)
            .unwrap()
            .schema_version,
        1
    );
    records.push(json!({"type":"user","uuid":"duplicate","parentUuid":"result","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"ambiguous"}]}}));
    write(&path, &records);
    assert!(claude_conversation_v2(&path, 50).is_err());
}

#[test]
fn schema_two_keeps_large_claude_result_and_call_within_page() {
    let (_directory, path, mut records) = claude_fixture("future_tool", json!({"x":1}));
    records.push(json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"x".repeat(262_000)}]}}));
    write(&path, &records);
    let page = claude_conversation_v2(&path, 50).unwrap();
    let call = page
        .messages
        .iter()
        .find(|entry| entry["id"] == "call")
        .unwrap();
    let result = call["parts"][0]["result"].as_str().unwrap();
    assert_eq!(result.len(), 262_000);
    let last = claude_conversation_v2(&path, 1).unwrap();
    assert_eq!(last.messages[0]["role"], "note");
    assert_eq!(
        last.messages[0]["parts"][0]["text"].as_str().unwrap().len(),
        262_000
    );
    records[2]["message"]["content"][0]["content"] = json!("x".repeat(261_950));
    records[2]["message"]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"text","text":"Keep this user text"}));
    write(&path, &records);
    let mixed = claude_conversation_v2(&path, 50).unwrap();
    assert!(mixed.messages.iter().any(|entry| entry["id"] == "call"));
    assert!(mixed.messages.iter().any(|entry| entry["parts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|part| part["text"] == "Keep this user text")));
}

#[test]
fn schema_two_page_limit_counts_only_visible_paired_entries() {
    let (_directory, path, mut records) = claude_fixture("Bash", json!({"command":"true"}));
    records.push(json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"done"}]}}));
    write(&path, &records);
    let one = claude_conversation_v2(&path, 1).unwrap();
    assert_eq!(ids(&one), vec!["result"]);
    assert_eq!(one.messages[0]["parts"][0]["text"], "done");
    let two = claude_conversation_v2(&path, 2).unwrap();
    assert_eq!(ids(&two), vec!["root", "call"]);
    assert!(!two.truncated);
    assert_eq!(two.next_offset, one.next_offset);
    records.insert(2, json!({"type":"assistant","uuid":"second","parentUuid":"call","message":{"content":[{"type":"tool_use","id":"other","name":"Read","input":{"file_path":"file"}}]}}));
    records[3]["parentUuid"] = json!("second");
    records[3]["message"]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"tool_result","tool_use_id":"other","content":"source"}));
    write(&path, &records);
    let three = claude_conversation_v2(&path, 3).unwrap();
    assert_eq!(ids(&three), vec!["root", "call", "second"]);
    assert!(!three.truncated);
    let output = serde_json::to_string(&three).unwrap();
    assert_eq!(output.matches("done").count(), 1);
    assert_eq!(output.matches("\"result\":\"source\"").count(), 1);
}

#[test]
fn schema_two_retains_prose_next_to_an_unmatched_call() {
    let (_directory, path, mut records) = claude_fixture("Bash", json!({"command":"sleep 10"}));
    records[1]["message"]["content"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!({"type":"text","text":"Here is the answer"}));
    write(&path, &records);
    let page = claude_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[1]["partial"], true);
    assert_eq!(page.messages[1]["parts"][0]["text"], "Here is the answer");
    assert!(page.messages[1]["parts"][1]["text"]
        .as_str()
        .unwrap()
        .contains("sleep 10"));
}

#[test]
fn schema_two_maps_recorded_claude_inputs_and_default_success() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    write(
        &path,
        &[
            message("root", None, "user", "inspect"),
            json!({"type":"assistant","uuid":"call","parentUuid":"root","message":{"content":[{"type":"tool_use","id":"bash","name":"Bash","input":{"command":"printf hello"}},{"type":"tool_use","id":"read","name":"Read","input":{"file_path":"example.rs"}}]}}),
            json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"bash","content":"hello"},{"type":"tool_result","tool_use_id":"read","content":"source"}]}}),
        ],
    );
    let page = claude_conversation_v2(&path, 50).unwrap();
    let parts = &page.messages[1]["parts"];
    assert_eq!(parts[0]["status"], "ok");
    assert_eq!(
        parts[0]["call"],
        json!({"kind":"execute","command":"printf hello"})
    );
    assert_eq!(parts[1]["call"], json!({"kind":"read","path":"example.rs"}));
}

#[test]
fn schema_two_suppresses_only_results_whose_calls_fit_the_window() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mixed.jsonl");
    write(
        &path,
        &[
            message("root", None, "user", "inspect"),
            json!({"type":"assistant","uuid":"one","parentUuid":"root","message":{"content":[{"type":"tool_use","id":"first","name":"Bash","input":{"command":"first"}}]}}),
            json!({"type":"assistant","uuid":"two","parentUuid":"one","message":{"content":[{"type":"tool_use","id":"second","name":"Read","input":{"file_path":"file"}}]}}),
            json!({"type":"user","uuid":"result","parentUuid":"two","message":{"content":[{"type":"tool_result","tool_use_id":"first","content":"first result"},{"type":"text","text":"user text"},{"type":"tool_result","tool_use_id":"second","content":"second result"}]}}),
        ],
    );
    for (limit, first_count, second_count) in [(1, 1, 1), (2, 1, 1), (3, 1, 1)] {
        let page = claude_conversation_v2(&path, limit).unwrap();
        let output = serde_json::to_string(&page).unwrap();
        assert_eq!(
            output.matches("first result").count(),
            first_count,
            "limit {limit}"
        );
        assert_eq!(
            output.matches("second result").count(),
            second_count,
            "limit {limit}"
        );
        assert!(output.contains("user text"));
        assert!(!output.contains("_toolCallId") && !output.contains("_toolResultId"));
        let parts = page.messages.last().unwrap()["parts"].as_array().unwrap();
        assert_eq!(
            parts
                .iter()
                .filter(|part| part["text"] == "first result")
                .count(),
            usize::from(limit < 3)
        );
        assert_eq!(
            parts
                .iter()
                .filter(|part| part["text"] == "second result")
                .count(),
            usize::from(limit == 1)
        );
    }
}

#[test]
fn schema_two_claude_agent_uses_only_unambiguous_recorded_task_state() {
    let (_directory, path, mut records) = claude_fixture(
        "Agent",
        json!({"subagent_type":"reviewer","prompt":"inspect"}),
    );
    assert_unmatched_call_is_partial(&path, &records);
    let mut result = json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"started"}]},"toolUseResult":{"agentId":"agent-fixture","status":"async_launched","isAsync":true,"private":"SECRET"}});
    for (metadata, expected) in [
        (
            json!({"agentId":"agent-fixture","status":"async_launched","isAsync":true,"private":"SECRET"}),
            None,
        ),
        (
            json!({"agentId":"agent-fixture","agentType":"reviewer","status":"completed"}),
            Some(false),
        ),
        (
            json!({"agentId":"agent-fixture","status":"completed"}),
            Some(false),
        ),
        (
            json!({"agentId":"agent-fixture","agentType":null,"status":"completed"}),
            None,
        ),
        (
            json!({"agentId":"agent-fixture","agentType":"reviewer","status":"completed","isAsync":null}),
            None,
        ),
        (
            json!({"agentId":"agent-fixture","agentType":"other","status":"completed"}),
            None,
        ),
        (
            json!({"agentId":"agent-fixture","status":"async_launched"}),
            None,
        ),
        (json!({"agentId":"agent-fixture","status":"future"}), None),
    ] {
        result["toolUseResult"] = metadata;
        let mut session = records.clone();
        session.push(result.clone());
        write(&path, &session);
        let page = claude_conversation_v2(&path, 50).unwrap();
        let call = &page.messages[1];
        if let Some(ongoing) = expected {
            assert_eq!(
                call["parts"][0]["call"],
                json!({"kind":"task","agent":"reviewer","agentId":"agent-fixture","ongoing":ongoing})
            );
        } else {
            assert_eq!(call["partial"], true);
            assert!(call["parts"][0].get("call").is_none());
        }
        assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
    }
    result["toolUseResult"] =
        json!({"agentId":"agent-fixture","agentType":"reviewer","status":"completed"});
    add_unrelated_result(&mut result);
    records.push(result);
    write(&path, &records);
    let page = claude_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[1]["partial"], true);
    assert!(page.messages[1]["parts"][0].get("call").is_none());
    records[2]["message"]["content"]
        .as_array_mut()
        .unwrap()
        .pop();
    records[1]["message"]["content"][0]["input"]["subagent_type"] = Value::Null;
    assert_claude_partial(&path, &records);
    records[1]["message"]["content"][0]["input"]
        .as_object_mut()
        .unwrap()
        .remove("subagent_type");
    write(&path, &records);
    assert_eq!(
        claude_conversation_v2(&path, 50).unwrap().messages[1]["parts"][0]["call"]["agent"],
        "reviewer"
    );
    records[1]["message"]["content"][0]["input"]["subagent_type"] = json!("reviewer");
    records[1]["message"]["content"][0]["name"] = json!("Task");
    write(&path, &records);
    let alias = claude_conversation_v2(&path, 50).unwrap();
    assert_eq!(alias.messages[1]["parts"][0]["call"]["kind"], "task");
    let failed = claude_failed_result(&path, &mut records);
    assert!(failed.get("call").is_none());
}

#[test]
fn schema_two_claude_edits_use_verified_result_hunks_and_create_content() {
    let hunk = json!({"oldStart":1,"oldLines":2,"newStart":1,"newLines":3,"lines":[" context","-before","+after","+++literal"],"private":"SECRET"});
    for (name, input, metadata, expected) in [
        (
            "Edit",
            json!({"file_path":"example.rs","old_string":"before","new_string":"after"}),
            json!({"filePath":"example.rs","structuredPatch":[hunk.clone()]}),
            json!({"added":2,"removed":1,"created":false}),
        ),
        (
            "Write",
            json!({"file_path":"example.rs","content":"old"}),
            json!({"filePath":"example.rs","type":"update","structuredPatch":[hunk]}),
            json!({"added":2,"removed":1,"created":false}),
        ),
        (
            "Write",
            json!({"file_path":"example.rs","content":"requested"}),
            json!({"filePath":"example.rs","type":"create","structuredPatch":[],"content":"recorded\ncontent","originalFile":null}),
            json!({"added":2,"removed":0,"created":true}),
        ),
    ] {
        let (_directory, path, mut records) = claude_fixture(name, input);
        records.push(json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"done"}]},"toolUseResult":metadata}));
        write(&path, &records);
        let page = claude_conversation_v2(&path, 50).unwrap();
        let edit = &page.messages[1]["parts"][0]["call"];
        assert_eq!(edit["kind"], "edit");
        assert_eq!(edit["path"], "example.rs");
        for field in ["added", "removed", "created"] {
            assert_eq!(edit[field], expected[field]);
        }
        if expected["created"] == true {
            assert_eq!(edit["hunks"][0], "+recorded\n+content");
        }
        assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
    }
}

#[test]
fn schema_two_claude_edits_keep_unproven_or_ambiguous_results_partial() {
    let (_directory, path, mut records) = claude_fixture(
        "Edit",
        json!({"file_path":"example.rs","old_string":"a","new_string":"b"}),
    );
    write(&path, &records);
    assert_eq!(
        claude_conversation_v2(&path, 50).unwrap().messages[1]["parts"][0]["type"],
        "text"
    );
    let valid = json!({"filePath":"example.rs","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-a","+b"]}]});
    let mut result = json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"done"}]},"toolUseResult":valid});
    for field in ["filePath", "structuredPatch"] {
        let mut broken = result.clone();
        broken["toolUseResult"][field] = if field == "filePath" {
            json!("other.rs")
        } else {
            json!([{"oldStart":1,"oldLines":2,"newStart":1,"newLines":1,"lines":["-a","+b"]}])
        };
        let mut session = records.clone();
        session.push(broken);
        write(&path, &session);
        let page = claude_conversation_v2(&path, 50).unwrap();
        assert_eq!(page.messages[1]["partial"], true);
        assert!(page.messages[1]["parts"][0].get("call").is_none());
    }
    add_unrelated_result(&mut result);
    records.push(result);
    write(&path, &records);
    assert_eq!(
        claude_conversation_v2(&path, 50).unwrap().messages[1]["partial"],
        true
    );
    records[2]["message"]["content"]
        .as_array_mut()
        .unwrap()
        .pop();
    records[2]["message"]["content"][0]["is_error"] = json!(true);
    write(&path, &records);
    let page = claude_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[1]["parts"][0]["status"], "error");
    assert!(page.messages[1]["parts"][0].get("call").is_none());
    records[2]["toolUseResult"]["structuredPatch"][0]["lines"][0] = json!("-".repeat(300_000));
    write(&path, &records);
    assert!(claude_conversation_v2(&path, 50).is_err());
}

#[test]
fn schema_two_claude_invalid_tool_names_preserve_the_recorded_receipt() {
    for name in [String::new(), "x".repeat(4097)] {
        let (_directory, path, mut records) =
            claude_fixture(&name, json!({"query":"public input"}));
        records.push(json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"public result"}]}}));
        write(&path, &records);
        let page = claude_conversation_v2(&path, 50).unwrap();
        let message = &page.messages[1];
        assert_eq!(message["partial"], true);
        let receipt = &message["parts"][0];
        assert_eq!(receipt["name"], "tool");
        assert_eq!(receipt["status"], "ok");
        assert!(receipt.get("call").is_none());
        assert!(receipt["input"].as_str().unwrap().contains("public input"));
        assert!(receipt["input"].as_str().unwrap().contains(&name));
        assert_eq!(receipt["result"], "public result");
        assert_eq!(page.messages.len(), 2);
    }
}

#[test]
fn schema_two_invalid_names_do_not_expand_the_part_count() {
    let (_directory, path, mut records) = claude_fixture("", json!({}));
    let calls: Vec<_> = (0..1000)
        .map(|i| json!({"type":"tool_use","id":format!("t{i}"),"name":"","input":{}}))
        .collect();
    let results: Vec<_> = (0..1000)
        .map(|i| json!({"type":"tool_result","tool_use_id":format!("t{i}"),"content":"done"}))
        .collect();
    records[1]["message"]["content"] = json!(calls);
    records.push(
        json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":results}}),
    );
    write(&path, &records);
    let page = claude_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[1]["partial"], true);
    assert_eq!(page.messages[1]["parts"].as_array().unwrap().len(), 1000);
    assert_eq!(page.messages.len(), 2);
}

#[test]
fn schema_two_claude_targets_respect_client_field_bounds() {
    for (name, field, kind, target) in [
        ("Read", "file_path", "read", "path"),
        ("Grep", "pattern", "search", "query"),
        ("Glob", "pattern", "search", "query"),
        ("WebFetch", "url", "fetch", "url"),
        ("WebSearch", "query", "search", "query"),
    ] {
        let (_directory, path, mut records) =
            claude_fixture(name, json!({field: "x".repeat(16384)}));
        records.push(json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"done"}]}}));
        for (value, fits) in [
            ("x".repeat(16384), true),
            ("é".repeat(16384), true),
            ("😀".repeat(8192), true),
            (format!("{}x", "😀".repeat(8192)), false),
            ("x".repeat(16385), false),
        ] {
            records[1]["message"]["content"][0]["input"][field] = json!(value);
            write(&path, &records);
            let page = claude_conversation_v2(&path, 50).unwrap();
            let receipt = &page.messages[1]["parts"][0];
            if fits {
                assert_eq!(receipt["call"]["kind"], kind);
                assert_eq!(receipt["call"][target], value);
            } else {
                assert_eq!(page.messages[1]["partial"], true);
                assert!(receipt.get("call").is_none());
                assert!(receipt["input"].as_str().unwrap().contains(&value));
                assert_eq!(receipt["result"], "done");
            }
        }
    }
}

#[test]
fn schema_two_claude_web_search_keeps_query_without_inventing_hits() {
    let (_directory, path, mut records) = claude_fixture(
        "WebSearch",
        json!({"query":"synthetic search","mode":"standard"}),
    );
    assert_unmatched_call_is_partial(&path, &records);
    records.push(json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"recorded result"}]}}));
    for (mode, error) in [
        (Some("standard"), false),
        (Some("extended"), true),
        (None, false),
    ] {
        let input = records[1]["message"]["content"][0]["input"]
            .as_object_mut()
            .unwrap();
        if let Some(mode) = mode {
            input.insert("mode".into(), json!(mode));
        } else {
            input.remove("mode");
        }
        records[2]["message"]["content"][0]["is_error"] = json!(error);
        write(&path, &records);
        let page = claude_conversation_v2(&path, 50).unwrap();
        assert_eq!(
            page.messages[1]["parts"][0]["status"],
            if error { "error" } else { "ok" }
        );
        assert_eq!(
            page.messages[1]["parts"][0]["call"],
            json!({"kind":"search","query":"synthetic search"})
        );
    }
    for invalid in [
        json!({"query":"  "}),
        json!({"query":null}),
        json!({"query":"x","mode":"future"}),
        json!({"query":"x","mode":null}),
        json!({"query":"x".repeat(16*1024+1)}),
    ] {
        records[1]["message"]["content"][0]["input"] = invalid;
        write(&path, &records);
        let page = claude_conversation_v2(&path, 50).unwrap();
        assert_eq!(page.messages[1]["partial"], true);
        assert!(page.messages[1]["parts"][0].get("call").is_none());
    }
}

#[test]
fn schema_two_claude_bash_background_requires_recorded_unambiguous_launch() {
    let (_directory, path, mut records) =
        claude_fixture("Bash", json!({"command":"synthetic command"}));
    let mut result = json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"launched","is_error":false}]},"toolUseResult":{"backgroundTaskId":"private-task-id","interrupted":false}});
    records.push(result.clone());
    write(&path, &records);
    let page = claude_conversation_v2(&path, 50).unwrap();
    assert_eq!(
        page.messages[1]["parts"][0]["call"],
        json!({"kind":"execute","command":"synthetic command","background":true})
    );
    assert!(!serde_json::to_string(&page)
        .unwrap()
        .contains("private-task-id"));
    for invalid in [
        json!({"backgroundTaskId":"","interrupted":false}),
        json!({"backgroundTaskId":{},"interrupted":false}),
        json!({"backgroundTaskId":"job","interrupted":true}),
        json!({"backgroundTaskId":"job"}),
    ] {
        records[2]["toolUseResult"] = invalid;
        write(&path, &records);
        let page = claude_conversation_v2(&path, 50).unwrap();
        assert_eq!(page.messages[1]["partial"], true);
        assert!(page.messages[1]["parts"][0]["call"]
            .get("background")
            .is_none());
    }
    records[2] = result.clone();
    add_unrelated_result(&mut records[2]);
    write(&path, &records);
    assert_eq!(
        claude_conversation_v2(&path, 50).unwrap().messages[1]["partial"],
        true
    );
    records[2] = result.clone();
    let failed = claude_failed_result(&path, &mut records);
    assert!(failed["call"].get("background").is_none());
    result.as_object_mut().unwrap().remove("toolUseResult");
    records[2] = result;
    records[1]["message"]["content"][0]["input"]["run_in_background"] = json!(true);
    assert_claude_partial(&path, &records);
    records[1]["message"]["content"][0]["input"]["run_in_background"] = json!("yes");
    write(&path, &records);
    let malformed = claude_conversation_v2(&path, 50).unwrap();
    assert_eq!(malformed.messages[1]["partial"], true);
    assert!(malformed.messages[1]["parts"][0].get("call").is_none());
}

#[test]
fn schema_two_claude_edits_reject_overlapping_hunks_and_contradictory_creation() {
    let hunk = json!({"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-a","+b"]});
    for (name, metadata) in [
        (
            "Edit",
            json!({"filePath":"example.rs","structuredPatch":[hunk.clone(),hunk]}),
        ),
        (
            "Write",
            json!({"filePath":"example.rs","type":"create","structuredPatch":[],"content":"b","originalFile":"PRIVATE-ORIGINAL"}),
        ),
        (
            "Write",
            json!({"filePath":"example.rs","type":"create","structuredPatch":[],"content":"b"}),
        ),
    ] {
        let (_directory, path, mut records) =
            claude_fixture(name, json!({"file_path":"example.rs"}));
        records.push(json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"done"}]},"toolUseResult":metadata}));
        write(&path, &records);
        let page = claude_conversation_v2(&path, 50).unwrap();
        assert_eq!(page.messages[1]["partial"], true);
        assert!(page.messages[1]["parts"][0].get("call").is_none());
        assert!(!serde_json::to_string(&page)
            .unwrap()
            .contains("PRIVATE-ORIGINAL"));
        assert_eq!(
            conversation(&path, TranscriptAgent::Claude, 50)
                .unwrap()
                .schema_version,
            1
        );
    }
    let (_directory, path, mut records) = claude_fixture("Edit", json!({"file_path":"example.rs"}));
    records.push(json!({"type":"user","uuid":"result","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"done"}]},"toolUseResult":{"filePath":"example.rs","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-a","+b"]},{"oldStart":1,"oldLines":0,"newStart":2,"newLines":1,"lines":["+c"]}]}}));
    write(&path, &records);
    let page = claude_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[1]["parts"][0]["call"]["added"], 2);
}

#[test]
fn refreshed_branch_replaces_recorded_tool_error_without_inventing_live_state() {
    let (_directory, path, mut records) = claude_fixture("Read", json!({}));
    records.push(json!({"type":"user","uuid":"failed","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"denied","is_error":true}]}}));
    write(&path, &records);
    let failed = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
    assert_eq!(
        failed.messages.last().unwrap()["blocks"][0]["isError"],
        true
    );
    records.push(json!({"type":"user","uuid":"replacement","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"read","is_error":false}]}}));
    write(&path, &records);
    let refreshed = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
    assert_eq!(refreshed.branch_id.as_deref(), Some("replacement"));
    assert!(!ids(&refreshed).contains(&"failed"));
    assert_eq!(
        refreshed.messages.last().unwrap()["blocks"][0]["isError"],
        false
    );
    assert_eq!(
        refreshed.messages.last().unwrap()["blocks"][0]["id"],
        "tool1"
    );
}

#[test]
fn latest_main_leaf_selects_one_branch_ignoring_progress_sidechains_and_old_forks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut side = message("side", Some("root"), "assistant", "other agent");
    side["isSidechain"] = json!(true);
    write(
        &path,
        &[
            message("root", None, "user", "question"),
            message("old", Some("root"), "assistant", "abandoned answer"),
            message("new", Some("root"), "assistant", "current answer"),
            json!({"type":"progress","uuid":"old-progress","parentUuid":"old"}),
            side,
        ],
    );
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(page.view, "active_branch");
    assert_eq!(ids(&page), vec!["root", "new"]);
    assert_eq!(page.branch_id.as_deref(), Some("new"));
    assert!(!page.has_more && !page.truncated);
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args([
            "transcript",
            "--agent",
            "claude",
            "--view",
            "conversation",
            "--path",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert!(output.status.success());
    let cli: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(cli["branchId"], "new");
    assert_eq!(cli["view"], "active_branch");
}

#[test]
fn compaction_replaces_earlier_chain_and_recent_limit_is_explicit() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut summary = message(
        "summary",
        Some("boundary"),
        "user",
        "summary of prior context",
    );
    summary["isCompactSummary"] = json!(true);
    write(
        &path,
        &[
            message("old", None, "user", "original context"),
            json!({"type":"system","uuid":"boundary","parentUuid":null,"logicalParentUuid":"old","subtype":"compact_boundary"}),
            summary,
            message("reply", Some("summary"), "assistant", "current answer"),
        ],
    );
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(ids(&page), vec!["summary", "reply"]);
    let latest = conversation(&path, TranscriptAgent::Claude, 1).unwrap();
    assert_eq!(ids(&latest), vec!["reply"]);
    assert!(latest.truncated);
}

#[test]
fn parallel_tool_calls_and_results_are_recovered_without_answering_a_different_response() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("parallel.jsonl");
    let call = |id: &str, parent: &str, call_id: &str| json!({"type":"assistant","uuid":id,"parentUuid":parent,"message":{"id":"response1","content":[{"type":"tool_use","id":call_id,"name":"Read","input":{}}]}});
    let result = |id: &str, parent: &str, call_id: &str| json!({"type":"user","uuid":id,"parentUuid":parent,"message":{"content":[{"type":"tool_result","tool_use_id":call_id,"content":"result"}]}});
    write(
        &path,
        &[
            message("root", None, "user", "read both files"),
            call("a1", "root", "tool1"),
            call("a2", "a1", "tool2"),
            result("r2", "a2", "tool2"),
            result("r1", "a1", "tool1"),
            result("wrong", "root", "unrelated-call"),
            message("done", Some("r1"), "assistant", "summary"),
        ],
    );
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(ids(&page), vec!["root", "a1", "a2", "r2", "r1", "done"]);
}

#[test]
fn cycles_oversize_files_and_wrong_provider_input_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    write(
        &path,
        &[
            message("a", Some("b"), "user", "a"),
            message("b", Some("a"), "assistant", "b"),
        ],
    );
    assert!(conversation(&path, TranscriptAgent::Claude, 100).is_err());
    assert!(conversation(&path, TranscriptAgent::Codex, 100).is_err());
    fs::File::create(&path)
        .unwrap()
        .set_len(16 * 1024 * 1024 + 1)
        .unwrap();
    assert!(conversation(&path, TranscriptAgent::Claude, 100).is_err());
}

#[test]
fn duplicate_uuids_use_the_latest_record_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("duplicate.jsonl");
    let mut old = message("assistant", Some("root"), "assistant", "stale");
    old["message"]["id"] = json!("response1");
    let mut new = old.clone();
    new["message"]["content"] = json!("current");
    write(
        &path,
        &[message("root", None, "user", "question"), old, new],
    );
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(ids(&page), vec!["root", "assistant"]);
    assert_eq!(page.messages[1]["blocks"][0]["text"], "current");
}

#[test]
fn discovery_only_lists_bounded_metadata_from_expected_depths() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("projects");
    fs::create_dir_all(root.join("project/subagents")).unwrap();
    fs::write(
        root.join("project/session.jsonl"),
        b"not JSON; discovery must not parse this",
    )
    .unwrap();
    fs::write(root.join("project/subagents/hidden.jsonl"), b"private").unwrap();
    fs::write(root.join("project/settings.json"), b"private").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args(["discover", "--agent", "claude", "--root"])
        .arg(&root)
        .output()
        .unwrap();
    assert!(output.status.success());
    let page: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(page["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(page["sessions"][0]["name"], "session.jsonl");
    assert_eq!(page["sessions"][0]["bytes"], 39);
    assert!(page["sessions"][0]["modifiedAt"].is_string());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("not JSON"));
    let empty = serde_json::to_value(
        discover(
            TranscriptAgent::Claude,
            Some(&directory.path().join("absent")),
            50,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(empty["sessions"].as_array().unwrap().is_empty());
    let codex = directory.path().join("sessions");
    fs::create_dir_all(codex.join("2026/10/24")).unwrap();
    fs::write(codex.join("2026/10/24/rollout.jsonl"), b"{}").unwrap();
    let codex =
        serde_json::to_value(discover(TranscriptAgent::Codex, Some(&codex), 50).unwrap()).unwrap();
    assert_eq!(codex["sessions"].as_array().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn discovery_ignores_symbolic_links_and_caps_results() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("projects");
    fs::create_dir_all(root.join("project")).unwrap();
    let outside = directory.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.jsonl"), b"secret").unwrap();
    symlink(&outside, root.join("linked-project")).unwrap();
    symlink(
        outside.join("secret.jsonl"),
        root.join("project/linked.jsonl"),
    )
    .unwrap();
    for i in 0..5 {
        fs::write(root.join(format!("project/{i}.jsonl")), b"{}").unwrap();
    }
    let page =
        serde_json::to_value(discover(TranscriptAgent::Claude, Some(&root), 2).unwrap()).unwrap();
    assert_eq!(page["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(page["truncated"], true);
    assert!(!page.to_string().contains("secret"));
    assert!(discover(
        TranscriptAgent::Claude,
        Some(&root.join("linked-project")),
        50
    )
    .is_err());
}

fn codex_file(records: &[Value]) -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("recorded.jsonl");
    write(&path, records);
    (directory, path)
}
// Independently authored records matching the official 0.166.0 persistence envelope.
fn codex_record(kind: &str, payload: Value) -> Value {
    json!({"timestamp":"2026-01-02T03:04:05Z","type":kind,"payload":payload})
}
fn codex_meta(id: &str, mode: &str) -> Value {
    codex_record("session_meta", json!({"id":id,"history_mode":mode}))
}
fn codex_event(kind: &str, mut payload: Value) -> Value {
    payload["type"] = json!(kind);
    if matches!(kind, "item_started" | "item_completed") && payload.get("thread_id").is_none() {
        payload["thread_id"] = json!("11111111-1111-4111-8111-111111111111");
    }
    codex_record("event_msg", payload)
}
fn codex_turn(id: &str) -> Value {
    codex_event("task_started", json!({"turn_id":id}))
}
fn codex_item(turn: &str, kind: &str, id: &str, text: &str) -> Value {
    let item = match kind {
        "UserMessage" => json!({"type":kind,"id":id,"content":[{"type":"text","text":text}]}),
        _ => json!({"type":kind,"id":id,"content":[{"type":"Text","text":text}]}),
    };
    codex_event(
        "item_completed",
        json!({"thread_id":"11111111-1111-4111-8111-111111111111","turn_id":turn,"item":item,"completed_at_ms":1}),
    )
}
fn codex_text(page: &lazysh_agent::transcript::TranscriptPage) -> String {
    page.messages
        .iter()
        .flat_map(|m| m["blocks"].as_array().unwrap())
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("|")
}
#[test]
fn codex_legacy_rollbacks_remove_turns_without_replaying_model_context_or_private_reasoning() {
    let (_directory, path) = codex_file(&[
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        codex_event("user_message", json!({"message":"question"})),
        codex_event("agent_message", json!({"message":"answer"})),
        codex_record(
            "response_item",
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"duplicate-model-context"}]}),
        ),
        codex_record(
            "compacted",
            json!({"message":"PRIVATE SUMMARY","replacement_history":[{"type":"message","role":"user","content":[{"type":"input_text","text":"PRIVATE CONTEXT"}]}]}),
        ),
        codex_turn("removed"),
        codex_event("user_message", json!({"message":"abandoned"})),
        codex_event("thread_rolled_back", json!({"num_turns":1})),
        codex_turn("replacement"),
        codex_event("user_message", json!({"message":"replacement"})),
        codex_event("agent_reasoning", json!({"text":"public summary"})),
        codex_event(
            "agent_reasoning_raw_content",
            json!({"text":"PRIVATE REASONING"}),
        ),
        codex_event(
            "turn_aborted",
            json!({"turn_id":"replacement","reason":"interrupted"}),
        ),
    ]);
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    assert_eq!(page.view, "active_branch");
    assert!(!page.has_more);
    assert_eq!(
        codex_text(&page),
        "question|answer|replacement|public summary"
    );
    assert!(!serde_json::to_string(&page).unwrap().contains("PRIVATE"));
}
#[test]
fn codex_paginated_upserts_canonical_items_and_ignores_compatibility_copies() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("recorded.jsonl");
    let mut records = vec![
        codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
        codex_turn("one"),
        codex_item("one", "UserMessage", "user-1", "question"),
        codex_event("user_message", json!({"message":"duplicate user"})),
        codex_item("one", "AgentMessage", "assistant-1", "initial"),
        codex_item("one", "AgentMessage", "assistant-1", "corrected"),
        codex_event("agent_message", json!({"message":"duplicate answer"})),
    ];
    for (ordinal, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(ordinal);
    }
    write(&path, &records);
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    assert_eq!(codex_text(&page), "question|corrected");
    assert_eq!(ids(&page), ["3:oneuser-1", "3:oneassistant-1"]);
}

fn paginated(mut records: Vec<Value>, start: u64) -> Vec<Value> {
    for (offset, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(start + offset as u64);
    }
    records
}
fn codex_fork(directory: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf, Vec<Value>) {
    let root = directory.join("sessions/2026/01/02");
    fs::create_dir_all(&root).unwrap();
    let parent =
        root.join("rollout-2026-01-02T03-04-05-11111111-1111-4111-8111-111111111111.jsonl");
    let child = root.join("rollout-2026-01-02T03-04-06-22222222-2222-4222-8222-222222222222.jsonl");
    let prefix = paginated(
        vec![
            codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
            codex_turn("parent"),
            codex_item("parent", "UserMessage", "parent-user", "inherited"),
            codex_item("parent", "AgentMessage", "parent-answer", "retained answer"),
        ],
        0,
    );
    write(&parent, &prefix);
    let cutoff = fs::metadata(&parent).unwrap().len();
    let mut all = prefix;
    all.extend(paginated(
        vec![
            codex_turn("abandoned"),
            codex_item(
                "abandoned",
                "UserMessage",
                "abandoned-user",
                "abandoned suffix",
            ),
        ],
        4,
    ));
    write(&parent, &all);
    let mut meta = codex_meta("33333333-3333-4333-8333-333333333333", "paginated");
    meta["payload"]["history_base"] = json!({"thread_id":"11111111-1111-4111-8111-111111111111","end_ordinal_exclusive":4,"end_byte_offset":cutoff});
    let mut child_item = codex_item("child", "UserMessage", "child-user", "fork question");
    child_item["payload"]["thread_id"] = json!("33333333-3333-4333-8333-333333333333");
    let records = paginated(vec![meta, codex_turn("child"), child_item], 4);
    write(&child, &records);
    (parent, child, records)
}
#[test]
fn codex_fork_and_revert_project_only_the_exact_inherited_prefix_and_stable_thread() {
    let dir = tempfile::tempdir().unwrap();
    let (_, child, _) = codex_fork(dir.path());
    let page = conversation(&child, TranscriptAgent::Codex, 100).unwrap();
    assert_eq!(codex_text(&page), "inherited|retained answer|fork question");
    assert_eq!(
        page.branch_id.as_deref(),
        Some("33333333-3333-4333-8333-333333333333")
    );
    assert_eq!(page.next_offset, fs::metadata(&child).unwrap().len());
}
#[test]
fn codex_subagent_context_is_not_child_conversation_and_attached_projection_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (_, child, mut records) = codex_fork(dir.path());
    records[0]["payload"]["subagent_history_start_ordinal"] = json!(5);
    write(&child, &records);
    assert_eq!(
        codex_text(&conversation(&child, TranscriptAgent::Codex, 100).unwrap()),
        "fork question"
    );
    records[0]["payload"]["attached_thread"] = json!(true);
    write(&child, &records);
    assert!(conversation(&child, TranscriptAgent::Codex, 100).is_err());
}
#[test]
fn codex_lineage_rejects_missing_ambiguous_cutoff_unknown_mode_and_ordinal_gaps() {
    for case in [
        "missing",
        "ambiguous",
        "byte-cutoff",
        "ordinal-cutoff",
        "unknown-mode",
        "ordinal-gap",
        "missing-ordinal",
        "wrong-thread",
        "missing-turn",
        "invalid-tool-body",
        "missing-tool-name",
        "missing-plan-text",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (parent, child, mut records) = codex_fork(dir.path());
        match case {
            "missing" => fs::remove_file(&parent).unwrap(),
            "ambiguous" => {
                fs::copy(
                    &parent,
                    parent
                        .with_file_name("rollout-other-11111111-1111-4111-8111-111111111111.jsonl"),
                )
                .unwrap();
            }
            "byte-cutoff" => {
                records[0]["payload"]["history_base"]["end_byte_offset"] = json!(1);
            }
            "ordinal-cutoff" => {
                records[0]["payload"]["history_base"]["end_ordinal_exclusive"] = json!(3);
            }
            "unknown-mode" => {
                records[0]["payload"]["history_mode"] = json!("future");
            }
            "invalid-tool-body" | "missing-tool-name" => {
                records[2]["payload"]["item"]["type"] = json!("FunctionCallOutput");
                records[2]["payload"]["item"]["output"] = if case == "invalid-tool-body" {
                    json!({"unknown":"unsupported"})
                } else {
                    json!("done")
                };
                if case == "invalid-tool-body" {
                    records[2]["payload"]["item"]["name"] = json!("inspect");
                }
            }
            "missing-plan-text" => {
                records[2]["payload"]["item"]["type"] = json!("Plan");
            }
            "wrong-thread" => {
                records[2]["payload"]["thread_id"] = json!("99999999-9999-4999-8999-999999999999");
            }
            "missing-turn" => {
                records[2]["payload"]
                    .as_object_mut()
                    .unwrap()
                    .remove("turn_id");
            }
            "ordinal-gap" => {
                records[1]["ordinal"] = json!(999);
            }
            _ => {
                records[1].as_object_mut().unwrap().remove("ordinal");
            }
        }
        write(&child, &records);
        assert!(
            conversation(&child, TranscriptAgent::Codex, 100).is_err(),
            "accepted {case}"
        );
    }
}
#[test]
fn codex_rollback_counts_empty_and_compaction_only_turns_and_recent_limit_is_explicit() {
    let (_directory, path) = codex_file(&[
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        codex_event("user_message", json!({"message":"keep"})),
        codex_turn("empty"),
        codex_turn("compaction"),
        codex_record("compacted", json!({"message":"PRIVATE"})),
        codex_event("thread_rolled_back", json!({"num_turns":2})),
        codex_turn("last"),
        codex_event("user_message", json!({"message":"last"})),
    ]);
    let page = conversation(&path, TranscriptAgent::Codex, 1).unwrap();
    assert_eq!(codex_text(&page), "last");
    assert!(page.truncated);
    assert!(!page.has_more);
    assert_eq!(
        codex_text(&conversation(&path, TranscriptAgent::Codex, 100).unwrap()),
        "keep|last"
    );
}
#[test]
fn codex_complete_lines_are_followable_without_admitting_a_partial_tail() {
    use std::io::Write;
    let (_directory, path) = codex_file(&[
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        codex_event("user_message", json!({"message":"complete"})),
    ]);
    let complete = fs::metadata(&path).unwrap().len();
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    let tail =
        serde_json::to_vec(&codex_event("agent_message", json!({"message":"answer é"}))).unwrap();
    file.write_all(&tail).unwrap();
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    assert_eq!(codex_text(&page), "complete");
    assert_eq!(page.next_offset, complete);
    file.write_all(b"\n").unwrap();
    assert_eq!(
        codex_text(&conversation(&path, TranscriptAgent::Codex, 100).unwrap()),
        "complete|answer é"
    );
}

#[test]
fn codex_cli_uses_the_same_recorded_projection_and_rejects_other_reader_options() {
    let (directory, path) = codex_file(&[
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        codex_event("agent_message", json!({"message":"recorded answer"})),
    ]);
    for option in [
        None,
        Some("--schema-version=2"),
        Some("--inline-images"),
        Some("--checkpoint=invalid"),
        Some("--offset=1"),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
        command
            .env("LAZYSH_STATE_DIR", directory.path().join("state"))
            .args([
                "transcript",
                "--agent",
                "codex",
                "--view",
                "conversation",
                "--path",
            ])
            .arg(&path);
        if let Some(option) = option {
            command.arg(option);
        }
        let output = command.output().unwrap();
        assert_eq!(
            output.status.success(),
            option.is_none() || option == Some("--schema-version=2"),
            "{option:?}"
        );
        if option.is_none() {
            let page: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(page["view"], "active_branch");
            assert_eq!(page["agent"], "codex");
            assert_eq!(page["messages"][0]["blocks"][0]["text"], "recorded answer");
        } else if option == Some("--schema-version=2") {
            let page: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(page["schemaVersion"], 2);
            assert_eq!(page["messages"][0]["parts"][0]["text"], "recorded answer");
        }
    }
}
#[test]
fn codex_recorded_commands_and_public_summaries_do_not_publish_raw_reasoning_or_media_urls() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("recorded.jsonl");
    let records = paginated(
        vec![
            codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
            codex_turn("one"),
            codex_event(
                "item_completed",
                json!({"turn_id":"one","item":{"type":"CommandExecution","id":"call-1","command":["false"],"status":"failed","aggregated_output":"original output","exit_code":1}}),
            ),
            codex_event(
                "item_completed",
                json!({"turn_id":"one","item":{"type":"Reasoning","id":"summary","summary_text":["public summary"],"raw_content":["PRIVATE REASONING"]}}),
            ),
            codex_event(
                "item_completed",
                json!({"turn_id":"one","item":{"type":"FunctionCallOutput","id":"call-2","name":"inspect","output":[{"type":"input_text","text":"public result"},{"type":"input_image","image_url":"https://example.invalid/PRIVATE"},{"type":"thinking","thinking":"PRIVATE UNSUPPORTED BLOCK"}]}}),
            ),
            codex_event(
                "item_completed",
                json!({"turn_id":"one","item":{"type":"DynamicToolCall","id":"call-3","tool":"fixture","arguments":{},"content_items":[{"type":"inputText","text":"dynamic result"},{"type":"inputImage","imageUrl":"PRIVATE MEDIA"}],"success":true}}),
            ),
        ],
        0,
    );
    write(&path, &records);
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    assert_eq!(page.messages[0]["blocks"][1]["isError"], true);
    let serialized = serde_json::to_string(&page).unwrap();
    assert!(
        serialized.contains("public summary")
            && serialized.contains("public result")
            && serialized.contains("dynamic result")
    );
    assert!(!serialized.contains("PRIVATE") && !serialized.contains("https://"));
    let page = codex_conversation_v2(&path, 100).unwrap();
    let dynamic = &page.messages[3]["parts"][0];
    assert_eq!(dynamic["status"], "ok");
    assert_eq!(dynamic["call"]["kind"], "other");
    assert_eq!(dynamic["result"], "dynamic result");
    assert!(!serde_json::to_string(&page).unwrap().contains("PRIVATE"));
}

fn assert_partial_mcp(page: &lazysh_agent::transcript::TranscriptPage) {
    assert_eq!(page.messages[0]["partial"], true);
    assert_eq!(page.messages[0]["parts"][0]["type"], "text");
}

#[test]
fn schema_two_codex_completed_mcp_accepts_omitted_is_error_only_with_valid_result() {
    let mut item = json!({"type":"McpToolCall","id":"mcp","tool":"example","arguments":{"query":"synthetic"},"status":"completed","result":{"content":[{"type":"text","text":"public result"}],"private":"SECRET"}});
    for (change, expected) in [
        ("valid", true),
        ("null_error", false),
        ("failed_status", false),
        ("missing_content", false),
        ("unknown_success", false),
        ("unknown_content", false),
        ("malformed_text", false),
    ] {
        let mut current = item.clone();
        match change {
            "null_error" => current["result"]["isError"] = Value::Null,
            "failed_status" => current["status"] = json!("failed"),
            "missing_content" => {
                current["result"].as_object_mut().unwrap().remove("content");
            }
            "unknown_success" => current["success"] = json!("unknown"),
            "unknown_content" => {
                current["result"]["content"] = json!([{"type":"image","data":"SECRET"}])
            }
            "malformed_text" => current["result"]["content"] = json!([{"type":"text","text":null}]),
            _ => (),
        }
        let records = paginated(
            vec![
                codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
                codex_turn("one"),
                codex_event("item_completed", json!({"turn_id":"one","item":current})),
            ],
            0,
        );
        let (_directory, path) = codex_file(&records);
        let page = codex_conversation_v2(&path, 50).unwrap();
        let part = &page.messages[0]["parts"][0];
        if expected {
            assert_eq!(part["status"], "ok");
            assert_eq!(part["call"]["kind"], "other");
            assert_eq!(part["result"], "public result");
        } else {
            assert_partial_mcp(&page);
        }
        assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
    }
    item["result"]["isError"] = json!(true);
    let (_directory, path) = codex_file(&paginated(
        vec![
            codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
            codex_turn("one"),
            codex_event("item_completed", json!({"turn_id":"one","item":item})),
        ],
        0,
    ));
    assert_eq!(
        codex_conversation_v2(&path, 50).unwrap().messages[0]["parts"][0]["status"],
        "error"
    );
}

#[test]
fn schema_two_codex_legacy_mcp_projects_explicit_completed_results() {
    for (result, expected) in [
        (
            json!({"Ok":{"content":[{"type":"text","text":"visible"}],"private":"SECRET"}}),
            Some("ok"),
        ),
        (
            json!({"Ok":{"content":[{"type":"text","text":"visible"}],"isError":true}}),
            Some("error"),
        ),
        (json!({"Err":{"message":"failed"}}), Some("error")),
        (
            json!({"Ok":{"content":[{"type":"text","text":"visible"}],"isError":null}}),
            None,
        ),
        (
            json!({"Ok":{"content":[{"type":"text","text":"visible"}],"isError":false},"Err":{"message":"conflict"}}),
            None,
        ),
    ] {
        let records = vec![
            codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
            codex_turn("one"),
            codex_event(
                "mcp_tool_call_end",
                json!({"turn_id":"one","call_id":"mcp","invocation":{"tool":"example","arguments":{}},"result":result}),
            ),
        ];
        let (_directory, path) = codex_file(&records);
        let schema_one = conversation(&path, TranscriptAgent::Codex, 50).unwrap();
        assert_eq!(schema_one.schema_version, 1);
        let page = codex_conversation_v2(&path, 50).unwrap();
        let part = &page.messages[0]["parts"][0];
        if let Some(status) = expected {
            assert_eq!(part["status"], status);
            assert_eq!(part["call"]["kind"], "other");
            if status == "ok" {
                assert_eq!(part["result"], "visible");
            }
        } else {
            assert_partial_mcp(&page);
        }
        assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
    }
}

#[test]
fn schema_two_codex_command_keeps_exit_code_and_later_revision() {
    let mut records = vec![
        codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
        codex_turn("one"),
        codex_event(
            "item_started",
            json!({"turn_id":"one","item":{"type":"CommandExecution","id":"call","command":["false"],"status":"in_progress"}}),
        ),
    ];
    let (_directory, path) = codex_file(&paginated(records.clone(), 0));
    let first = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(first.messages[0]["parts"][0]["status"], "running");
    records.push(codex_event("item_completed", json!({"turn_id":"one","item":{"type":"CommandExecution","id":"call","command":["false"],"status":"failed","exit_code":1,"aggregated_output":"failure"}})));
    write(&path, &paginated(records, 0));
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert!(page.messages[0]["rev"].as_u64().unwrap() > first.messages[0]["rev"].as_u64().unwrap());
    assert_eq!(page.messages[0]["parts"][0]["status"], "error");
    assert_eq!(page.messages[0]["parts"][0]["call"]["exitCode"], 1);
    assert_eq!(page.messages[0]["parts"][0]["result"], "failure");
}

#[test]
fn schema_two_codex_malformed_command_exit_code_stays_partial() {
    for exit in [json!("0"), json!(false), json!(2147483648_i64)] {
        let (_directory, path) = codex_file(&paginated(
            vec![
                codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
                codex_turn("one"),
                codex_event(
                    "item_completed",
                    json!({"turn_id":"one","item":{
                        "type":"CommandExecution","id":"call","command":["printf","hello"],
                        "status":"completed","exit_code":exit,"aggregated_output":"recorded output"
                    }}),
                ),
            ],
            0,
        ));
        let page = codex_conversation_v2(&path, 50).unwrap();
        assert_eq!(page.messages[0]["partial"], true);
        assert!(page.messages[0]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|part| part["type"] != "tool"));
        assert!(serde_json::to_string(&page.messages[0])
            .unwrap()
            .contains("recorded output"));
    }
}

#[test]
fn schema_two_codex_distinguishes_explicit_decline_from_unknown_status() {
    let (_directory, path) = codex_file(&paginated(
        vec![
            codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
            codex_turn("one"),
            codex_event(
                "item_completed",
                json!({"turn_id":"one","item":{"type":"CommandExecution","id":"declined","command":["true"],"status":"declined"}}),
            ),
            codex_event(
                "item_completed",
                json!({"turn_id":"one","item":{"type":"CommandExecution","id":"unknown","command":["true"]}}),
            ),
        ],
        0,
    ));
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[0]["parts"][0]["status"], "denied");
    assert_eq!(page.messages[1]["partial"], true);
    assert_eq!(page.messages[1]["parts"][0]["type"], "text");
}

fn legacy_command_fixture(exit: i64, output: &str) -> Vec<Value> {
    vec![
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        codex_event(
            "exec_command_begin",
            json!({"turn_id":"one","call_id":"call","command":["printf","hello"]}),
        ),
        codex_event(
            "exec_command_end",
            json!({"turn_id":"one","call_id":"call","exit_code":exit,"aggregated_output":output}),
        ),
    ]
}

#[test]
fn schema_two_codex_legacy_end_keeps_command_from_start() {
    let (_directory, path) = codex_file(&legacy_command_fixture(0, "hello"));
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(
        page.messages[0]["parts"][0]["call"]["command"],
        r#"["printf","hello"]"#
    );
    assert_eq!(page.messages[0]["parts"][0]["status"], "ok");
}

fn completed_command_fixture(argv: Value) -> (tempfile::TempDir, std::path::PathBuf) {
    codex_file(&paginated(
        vec![
            codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
            codex_turn("one"),
            codex_event(
                "item_completed",
                json!({"turn_id":"one","item":{"type":"CommandExecution","id":"run","command":argv,"status":"completed","exit_code":0}}),
            ),
        ],
        0,
    ))
}

#[test]
fn schema_two_codex_commands_preserve_recorded_argument_boundaries() {
    let argv = json!(["sh", "-lc", "printf '%s' 'a b'"]);
    let (_directory, path) = completed_command_fixture(argv.clone());
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(
        page.messages[0]["parts"][0]["call"]["command"],
        argv.to_string()
    );
    let old = conversation(&path, TranscriptAgent::Codex, 50).unwrap();
    assert_eq!(
        old.messages[0]["blocks"][0]["text"],
        "sh -lc printf '%s' 'a b'"
    );
    let mut legacy = legacy_command_fixture(0, "done");
    legacy[2]["payload"]["command"] = argv.clone();
    write(&path, &paginated(legacy.clone(), 0));
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(
        page.messages[0]["parts"][0]["call"]["command"],
        argv.to_string()
    );
    legacy[2]["payload"]["command"] = json!(["sh", 42]);
    write(&path, &paginated(legacy, 0));
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[0]["partial"], true);
    assert!(serde_json::to_string(&page.messages[0])
        .unwrap()
        .contains("sh"));
}

#[test]
fn schema_two_codex_malformed_commands_exclude_unrelated_object_fields() {
    let secret = "synthetic-secret";
    let (_directory, path) =
        completed_command_fixture(json!(["echo", {"env":{"API_TOKEN":secret}}]));
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[0]["partial"], true);
    let text = serde_json::to_string(&page).unwrap();
    assert!(text.contains("echo"));
    assert!(!text.contains(secret));
    assert!(!text.contains("API_TOKEN"));
    let mut legacy = legacy_command_fixture(0, "done");
    legacy[2]["payload"]["command"] = json!({"env":{"API_TOKEN":secret}});
    write(&path, &paginated(legacy, 0));
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[0]["partial"], true);
    let text = serde_json::to_string(&page).unwrap();
    assert!(!text.contains(secret));
    assert!(!text.contains("API_TOKEN"));
    assert!(text.contains("done"));
}

#[test]
fn schema_two_codex_legacy_out_of_range_exit_preserves_partial_output() {
    for (exit, valid) in [
        (2147483648_i64, false),
        (-2147483649_i64, false),
        (i32::MAX as i64, true),
        (i32::MIN as i64, true),
    ] {
        let (_directory, path) = codex_file(&legacy_command_fixture(exit, "recorded output"));
        let page = codex_conversation_v2(&path, 50).unwrap();
        let entry = &page.messages[0];
        if valid {
            assert_eq!(entry["parts"][0]["call"]["exitCode"], exit);
            assert_eq!(entry["parts"][0]["status"], "error");
            continue;
        }
        assert_eq!(entry["partial"], true);
        assert!(entry["parts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|part| part["type"] == "text"));
        let text = serde_json::to_string(entry).unwrap();
        assert!(
            text.contains("printf") && text.contains("hello") && text.contains("recorded output")
        );
    }
}

#[test]
fn schema_two_codex_legacy_start_rejects_invalid_exit_values() {
    for invalid in [
        json!(2147483648_i64),
        json!(-2147483649_i64),
        json!("0"),
        json!(false),
    ] {
        let mut records = legacy_command_fixture(0, "unused");
        records.pop();
        records[2]["payload"]["exit_code"] = invalid;
        let (_directory, path) = codex_file(&records);
        let page = codex_conversation_v2(&path, 50).unwrap();
        let entry = &page.messages[0];
        assert_eq!(entry["partial"], true);
        assert_eq!(entry["parts"][0]["type"], "text");
        assert!(entry["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains(r#"["printf","hello"]"#));
    }
    let mut records = legacy_command_fixture(0, "unused");
    records.pop();
    let (_directory, path) = codex_file(&records);
    assert_eq!(
        codex_conversation_v2(&path, 50).unwrap().messages[0]["parts"][0]["status"],
        "running"
    );
}

#[test]
fn schema_two_codex_file_changes_count_actual_hunks_and_preserve_rename() {
    // Synthetic values use recorded Codex FileChange field shapes, never transcript content.
    let diff = "@@ -1,2 +1,2 @@\n context\n-before\n+after\n@@ -5 +5,2 @@\n same\n+++literal\n\\ No newline at end of file\n";
    let records = paginated(
        vec![
            codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
            codex_turn("one"),
            codex_event(
                "item_completed",
                json!({"turn_id":"one","item":{"type":"FileChange","id":"patch","status":"completed","changes":{"a.rs":{"type":"update","unified_diff":diff,"move_path":"moved.rs"},"b.rs":{"type":"add","content":"first\nsecond"}},"private":"SECRET"}}),
            ),
        ],
        0,
    );
    let (_directory, path) = codex_file(&records);
    let page = codex_conversation_v2(&path, 50).unwrap();
    let parts = &page.messages[0]["parts"];
    assert_eq!(parts[0]["call"]["added"], 2);
    assert_eq!(parts[0]["call"]["removed"], 1);
    assert_eq!(parts[0]["call"]["movePath"], "moved.rs");
    assert_eq!(parts[1]["call"]["added"], 2);
    assert_eq!(parts[1]["call"]["created"], true);
    assert_eq!(parts[1]["call"]["hunks"][0], "+first\n+second");
    assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
    assert!(conversation(&path, TranscriptAgent::Codex, 50)
        .unwrap()
        .messages
        .is_empty());
}

#[test]
fn schema_two_codex_rejects_unproven_edits_and_oversized_records() {
    let make = |status: &str, diff: String| {
        paginated(
            vec![
                codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
                codex_turn("one"),
                codex_event(
                    "item_completed",
                    json!({"turn_id":"one","item":{"type":"FileChange","id":"patch","status":status,"changes":{"a.rs":{"type":"update","unified_diff":diff,"private":"SECRET"}}}}),
                ),
            ],
            0,
        )
    };
    for (status, diff) in [
        ("completed", "@@ -1 +1 @@\n+new\n"),
        ("declined", "@@ -1 +1 @@\n-old\n+new\n"),
    ] {
        let (_directory, path) = codex_file(&make(status, diff.into()));
        let page = codex_conversation_v2(&path, 50).unwrap();
        assert_eq!(page.messages[0]["partial"], true);
        assert_eq!(page.messages[0]["parts"][0]["type"], "text");
        assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
    }
    let (_directory, path) = codex_file(&make("completed", "+".repeat(300_000)));
    assert!(codex_conversation_v2(&path, 50).is_err());
    let unknown = paginated(
        vec![
            codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
            codex_turn("one"),
            codex_event(
                "item_started",
                json!({"turn_id":"one","item":{"type":"FileChange","id":"patch","status":"completed","changes":[]}}),
            ),
        ],
        0,
    );
    let (_directory, path) = codex_file(&unknown);
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[0]["partial"], true);
    assert_eq!(page.messages[0]["parts"][0]["type"], "text");
    let mut malformed = make("completed", String::new());
    malformed[2]["payload"]["item"]["changes"]["a.rs"] =
        json!({"type":{"private":"SECRET"},"content":{"private":"SECRET"}});
    let (_directory, path) = codex_file(&malformed);
    let page = codex_conversation_v2(&path, 50).unwrap();
    assert_eq!(page.messages[0]["partial"], true);
    assert!(!serde_json::to_string(&page).unwrap().contains("SECRET"));
}
#[test]
fn codex_reference_never_follows_symlinks_or_unbounded_export_scope() {
    let dir = tempfile::tempdir().unwrap();
    let (parent, child, records) = codex_fork(dir.path());
    let outside = dir.path().join("export.jsonl");
    write(&outside, &records);
    assert!(conversation(&outside, TranscriptAgent::Codex, 100).is_err());
    let traversal = child.parent().unwrap().join("../../../../export.jsonl");
    assert!(
        conversation(&traversal, TranscriptAgent::Codex, 100).is_err(),
        "a lexical sessions ancestor must not expand an outside export's scope"
    );
    #[cfg(unix)]
    {
        let moved = parent.with_extension("retained");
        fs::rename(&parent, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &parent).unwrap();
        assert!(conversation(&child, TranscriptAgent::Codex, 100).is_err());
        assert!(conversation(&parent, TranscriptAgent::Codex, 100).is_err());
    }
}

#[test]
fn codex_late_tool_completion_stays_in_its_original_turn_when_a_newer_turn_is_rolled_back() {
    let (_directory, path) = codex_file(&[
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("first"),
        codex_event("user_message", json!({"message":"keep question"})),
        codex_turn("second"),
        codex_event("user_message", json!({"message":"discarded question"})),
        codex_event(
            "exec_command_end",
            json!({"turn_id":"first","call_id":"command-1","command":["printf","done"],"aggregated_output":"command preserved","exit_code":0}),
        ),
        codex_event(
            "mcp_tool_call_end",
            json!({"turn_id":"first","call_id":"mcp-1","invocation":{"tool":"inspect","arguments":{}},"result":{"Ok":{"content":[{"type":"text","text":"mcp preserved"},{"type":"image","data":"PRIVATE MEDIA"}]}}}),
        ),
        codex_event(
            "dynamic_tool_call_response",
            json!({"turn_id":"second","call_id":"dynamic-1","tool":"inspect","arguments":{},"content_items":[{"type":"inputText","text":"discarded result"}],"success":true}),
        ),
        codex_event("thread_rolled_back", json!({"num_turns":1})),
    ]);
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    let text = codex_text(&page);
    assert!(
        text.contains("keep question")
            && text.contains("command preserved")
            && text.contains("mcp preserved")
    );
    assert!(!text.contains("discarded") && !text.contains("PRIVATE"));
}

#[test]
fn codex_prefix_chains_have_a_bounded_source_budget() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("sessions/2026/01/02");
    fs::create_dir_all(&root).unwrap();
    let mut previous: Option<(String, u64, u64)> = None;
    for index in 1..=17 {
        let physical = format!("{index:08x}-1111-4111-8111-111111111111");
        let path = root.join(format!("rollout-2026-01-02T03-04-05-{physical}.jsonl"));
        let mut meta = codex_meta("11111111-1111-4111-8111-111111111111", "paginated");
        let start = if let Some((id, end, bytes)) = &previous {
            meta["payload"]["history_base"] =
                json!({"thread_id":id,"end_ordinal_exclusive":end,"end_byte_offset":bytes});
            *end
        } else {
            0
        };
        let turn = format!("turn-{index}");
        let records = paginated(
            vec![
                meta,
                codex_turn(&turn),
                codex_item(
                    &turn,
                    "UserMessage",
                    &format!("user-{index}"),
                    "recorded question",
                ),
            ],
            start,
        );
        write(&path, &records);
        if index == 16 {
            assert_eq!(
                conversation(&path, TranscriptAgent::Codex, 100)
                    .unwrap()
                    .messages
                    .len(),
                16
            );
        }
        if index == 17 {
            assert!(conversation(&path, TranscriptAgent::Codex, 100).is_err());
        }
        previous = Some((physical, start + 3, fs::metadata(&path).unwrap().len()));
    }
}

#[test]
fn codex_item_ids_are_scoped_to_their_turn_for_client_row_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("recorded.jsonl");
    write(
        &path,
        &paginated(
            vec![
                codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
                codex_turn("one"),
                codex_item("one", "UserMessage", "reused", "first question"),
                codex_event("task_complete", json!({"turn_id":"one"})),
                codex_turn("two"),
                codex_item("two", "UserMessage", "reused", "second question"),
            ],
            0,
        ),
    );
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    assert_eq!(codex_text(&page), "first question|second question");
    assert_eq!(
        ids(&page)
            .into_iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        2
    );
}

#[test]
fn shared_synthetic_android_codex_conversation_matches_original_messages() {
    let specification = recorded_conversations::specification();
    let expected = recorded_conversations::messages(&specification, "codex");
    let mut records = vec![
        codex_meta(
            specification["codexThreadId"].as_str().unwrap(),
            "paginated",
        ),
        codex_turn("owned"),
    ];
    for message in &expected {
        records.push(codex_item(
            "owned",
            if message["role"] == "user" {
                "UserMessage"
            } else {
                "AgentMessage"
            },
            message["id"].as_str().unwrap(),
            message["text"].as_str().unwrap(),
        ));
    }
    let (_directory, path) = codex_file(&paginated(records, 0));
    let page = conversation(&path, TranscriptAgent::Codex, 50).unwrap();
    assert_eq!(
        page.branch_id.as_deref(),
        specification["codexThreadId"].as_str()
    );
    recorded_conversations::assert_messages(&page.messages, &expected);
}

#[test]
fn schema_three_retains_bounded_historical_subagent_events_without_displacing_messages() {
    let mut records = vec![
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        codex_event("user_message", json!({"message":"question"})),
    ];
    for (index, kind) in ["started", "completed", "completed", "future", "interrupted"]
        .iter()
        .enumerate()
    {
        records.push(codex_event("item_completed", json!({"turn_id":"one", "item":{"type":"SubAgentActivity","id":format!("item-{index}"),"agent_thread_id":"PRIVATE-ID","agent_path":"PRIVATE-PATH","kind":kind}})));
    }
    let (_directory, path) = codex_file(&records);
    let old = codex_conversation_v2(&path, 1).unwrap();
    let page = codex_conversation_v3(&path, 1).unwrap();
    assert_eq!(old.messages, page.messages);
    let value = serde_json::to_value(page).unwrap();
    assert_eq!(
        value["historicalActivity"],
        json!({"version":1,"events":["started","completed","completed","interrupted"],"truncated":false})
    );
    assert!(!value.to_string().contains("PRIVATE"));
    assert!(serde_json::to_value(old)
        .unwrap()
        .get("historicalActivity")
        .is_none());
    for index in 0..55 {
        records.push(codex_event("item_completed",json!({"turn_id":"one","item":{"type":"SubAgentActivity","id":format!("extra-{index}"),"kind":"completed"}})));
    }
    write(&path, &records);
    let bounded = serde_json::to_value(codex_conversation_v3(&path, 1).unwrap()).unwrap();
    assert_eq!(
        bounded["historicalActivity"]["events"]
            .as_array()
            .unwrap()
            .len(),
        50
    );
    assert_eq!(bounded["historicalActivity"]["truncated"], true);
}

#[test]
fn schema_three_discards_events_from_rolled_back_turns() {
    let event = |turn: &str, kind: &str| {
        codex_event(
            "item_completed",
            json!({"turn_id":turn,"item":{"type":"SubAgentActivity","id":kind,"kind":kind}}),
        )
    };
    let records = vec![
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        event("one", "started"),
        codex_turn("two"),
        event("two", "completed"),
        codex_event("thread_rolled_back", json!({"num_turns":1})),
    ];
    let (_directory, path) = codex_file(&records);
    let page = serde_json::to_value(codex_conversation_v3(&path, 50).unwrap()).unwrap();
    assert_eq!(page["historicalActivity"]["events"], json!(["started"]));
}

#[test]
fn schema_three_keeps_late_events_in_source_order_before_limiting() {
    let event = |turn: &str, kind: &str| {
        codex_event(
            "item_completed",
            json!({"turn_id":turn,"item":{"type":"SubAgentActivity","kind":kind}}),
        )
    };
    let mut records = vec![
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        event("one", "started"),
        codex_turn("two"),
    ];
    records.extend((0..50).map(|_| event("two", "interacted")));
    records.push(event("one", "completed"));
    let (_directory, path) = codex_file(&records);
    let page = serde_json::to_value(codex_conversation_v3(&path, 50).unwrap()).unwrap();
    let events = page["historicalActivity"]["events"].as_array().unwrap();
    assert_eq!(events.len(), 50);
    assert_eq!(events.last().unwrap(), "completed");
    assert_eq!(events[0], "interacted");
    assert_eq!(page["historicalActivity"]["truncated"], true);
}

#[test]
fn schema_three_ignores_late_activity_from_rolled_back_turns() {
    let event = |turn: &str, kind: &str| {
        codex_event(
            "item_completed",
            json!({"turn_id":turn,"item":{"type":"SubAgentActivity","kind":kind,"agent_thread_id":"PRIVATE"}}),
        )
    };
    let records = vec![
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        event("one", "started"),
        codex_turn("two"),
        event("two", "started"),
        codex_event("thread_rolled_back", json!({"num_turns":1})),
        event("two", "completed"),
        codex_turn("three"),
        event("one", "interacted"),
        event("three", "started"),
    ];
    let (_directory, path) = codex_file(&records);
    let page = serde_json::to_value(codex_conversation_v3(&path, 50).unwrap()).unwrap();
    assert_eq!(
        page["historicalActivity"]["events"],
        json!(["started", "interacted", "started"])
    );
    assert!(!page.to_string().contains("PRIVATE"));
}
