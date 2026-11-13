#[path = "support/recorded_conversations.rs"]
mod recorded_conversations;

use lazysh_agent::transcript::{conversation, discover, TranscriptAgent};
use serde_json::{json, Value};
use std::{fs, process::Command};

#[path = "support/jsonl.rs"]
mod jsonl;
use jsonl::write;
fn message(id: &str, parent: Option<&str>, role: &str, text: &str) -> Value {
    json!({"type":role,"uuid":id,"parentUuid":parent,"message":{"content":text}})
}
fn ids(page: &lazysh_agent::transcript::TranscriptPage) -> Vec<&str> {
    page.messages
        .iter()
        .map(|message| message["id"].as_str().unwrap())
        .collect()
}

#[test]
fn refreshed_branch_replaces_recorded_tool_error_without_inventing_live_state() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut records = vec![
        message("root", None, "user", "inspect"),
        json!({"type":"assistant","uuid":"call","parentUuid":"root","message":{"content":[{"type":"tool_use","id":"tool1","name":"Read","input":{}}]}}),
        json!({"type":"user","uuid":"failed","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"denied","is_error":true}]}}),
    ];
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
fn compaction_keeps_the_earlier_conversation_above_the_summary_and_recent_limit_is_explicit() {
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
    // The boundary restarts the parent chain; the conversation before it is still the session's history.
    assert_eq!(ids(&page), vec!["old", "summary", "reply"]);
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

#[test]
fn codex_file_changes_become_one_patch_call_with_its_outcome() {
    // Independently authored `FileChange` items in the recorded shape: a map of path to add, update or delete.
    let change = |id: &str, status: &str, changes: Value| {
        codex_event(
            "item_completed",
            json!({"turn_id":"one","item":{"type":"FileChange","id":id,"status":status,"stdout":"Done!","stderr":"","changes":changes}}),
        )
    };
    let mut records = vec![
        codex_meta("11111111-1111-4111-8111-111111111111", "paginated"),
        codex_turn("one"),
        change(
            "edit-1",
            "completed",
            json!({"src/a.rs":{"type":"update","unified_diff":"@@ -1,3 +1,3 @@\n fn a() {\n-    old();\n+    new();\n }\n","move_path":null},
                   "docs/b.md":{"type":"add","content":"# B\nhello\n"}}),
        ),
        change(
            "edit-2",
            "failed",
            json!({"old.txt":{"type":"delete","content":"gone\n"}}),
        ),
        change(
            "edit-3",
            "completed",
            json!({"big.txt":{"type":"add","content":"x".repeat(100_000)}}),
        ),
    ];
    for (ordinal, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(ordinal);
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("recorded.jsonl");
    write(&path, &records);
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    let blocks = |index: usize| page.messages[index]["blocks"].clone();
    let first = blocks(0);
    assert_eq!(first[0]["type"], "tool_use");
    assert_eq!(first[0]["name"], "apply_patch");
    assert_eq!(
        first[0]["text"],
        "*** Begin Patch\n*** Add File: docs/b.md\n+# B\n+hello\n*** Update File: src/a.rs\n@@ -1,3 +1,3 @@\n fn a() {\n-    old();\n+    new();\n }\n*** End Patch"
    );
    assert_eq!(
        (
            first[1]["type"].clone(),
            first[1]["id"].clone(),
            first[1]["isError"].clone(),
            first[1]["text"].clone()
        ),
        (
            json!("tool_result"),
            first[0]["id"].clone(),
            json!(false),
            json!("Done!")
        )
    );
    let second = blocks(1);
    assert!(second[0]["text"]
        .as_str()
        .unwrap()
        .contains("*** Delete File: old.txt\n-gone\n"));
    assert_eq!(second[1]["isError"], true);
    // A large new file is cut, and the patch still ends where a reader expects.
    let big = blocks(2)[0]["text"].as_str().unwrap().to_owned();
    assert!(big.len() < 33 * 1024 && big.ends_with("\n*** End Patch"));
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
fn codex_goal_and_compaction_records_become_event_lines_once() {
    let goal = |status: &str, used: u64| {
        codex_event(
            "thread_goal_updated",
            json!({"goal":{"objective":"Fix the build","status":status,"tokensUsed":used}}),
        )
    };
    let (_directory, path) = codex_file(&[
        codex_meta("11111111-1111-4111-8111-111111111111", "legacy"),
        codex_turn("one"),
        goal("active", 0),
        codex_event("user_message", json!({"message":"go"})),
        goal("active", 10),
        goal("paused", 11),
        codex_record("compacted", json!({"message":"PRIVATE"})),
        goal("complete", 12),
    ]);
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    let lines: Vec<Value> = page
        .messages
        .iter()
        .map(|message| {
            if message["role"] == "event" {
                json!([message["event"]["kind"], message["event"]["text"]])
            } else {
                json!(message["role"])
            }
        })
        .collect();
    assert_eq!(
        lines,
        vec![
            json!(["goal", "Fix the build"]),
            json!("user"),
            json!(["compacted", ""]),
            json!(["goalMet", "Fix the build"]),
        ]
    );
    assert!(!serde_json::to_string(&page.messages)
        .unwrap()
        .contains("PRIVATE"));
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
        // The opt-in is admitted for Codex conversations: same text, plus previews only where an image was attached.
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
            matches!(option, None | Some("--inline-images")),
            "{option:?}"
        );
        if output.status.success() {
            let page: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(page["view"], "active_branch");
            assert_eq!(page["agent"], "codex");
            assert_eq!(page["messages"][0]["blocks"][0]["text"], "recorded answer");
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

fn queue_operation(operation: &str, content: &str, at: &str) -> Value {
    json!({"type":"queue-operation","operation":operation,"timestamp":at,"sessionId":"s","content":content})
}
fn queued_text(page: &lazysh_agent::transcript::TranscriptPage) -> Vec<&str> {
    page.queued
        .iter()
        .map(|entry| entry["text"].as_str().unwrap())
        .collect()
}

#[test]
fn prompts_typed_while_the_agent_works_are_queued_until_they_are_taken() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut records = vec![
        message("root", None, "user", "first"),
        queue_operation("enqueue", "then run the tests", "2026-11-11T10:00:00Z"),
        queue_operation("enqueue", "and update the docs", "2026-11-11T10:00:05Z"),
        // Text the harness injects is not something a person typed.
        queue_operation(
            "enqueue",
            "<task-notification>done</task-notification>",
            "2026-11-11T10:00:06Z",
        ),
    ];
    write(&path, &records);
    let page = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
    assert_eq!(
        queued_text(&page),
        ["then run the tests", "and update the docs"]
    );
    assert_eq!(page.queued[0]["timestamp"], "2026-11-11T10:00:00Z");
    // The oldest is taken and shows up as the user's message in the same step.
    records.push(queue_operation(
        "dequeue",
        "then run the tests",
        "2026-11-11T10:00:10Z",
    ));
    records.push(message("taken", Some("root"), "user", "then run the tests"));
    write(&path, &records);
    let page = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
    assert_eq!(queued_text(&page), ["and update the docs"]);
    assert_eq!(ids(&page), ["root", "taken"]);
    // Removing an entry by its text, and emptying the queue.
    records.push(queue_operation("enqueue", "extra", "2026-11-11T10:00:11Z"));
    records.push(queue_operation("remove", "extra", "2026-11-11T10:00:12Z"));
    write(&path, &records);
    assert_eq!(
        queued_text(&conversation(&path, TranscriptAgent::Claude, 50).unwrap()),
        ["and update the docs"]
    );
    records.push(queue_operation("popAll", "", "2026-11-11T10:00:13Z"));
    write(&path, &records);
    let page = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
    assert!(page.queued.is_empty());
    // An empty queue is not serialised, so older clients see the page they always saw.
    assert!(serde_json::to_value(&page).unwrap().get("queued").is_none());
}

#[test]
fn a_long_queue_keeps_its_first_entries_and_bounds_each_text() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut records = vec![message("root", None, "user", "first")];
    for index in 0..30 {
        records.push(queue_operation(
            "enqueue",
            &format!("{index}{}", "世".repeat(3000)),
            "2026-11-11T10:00:00Z",
        ));
    }
    write(&path, &records);
    let page = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
    assert_eq!(page.queued.len(), 20);
    assert!(page.queued[0]["text"].as_str().unwrap().len() <= 4096);
    assert!(page.queued[0]["text"].as_str().unwrap().starts_with("0世"));
}

#[test]
fn history_command_lists_one_folder_and_honors_the_discovery_setting() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("projects");
    let state = directory.path().join("companion-state");
    fs::create_dir_all(root.join("-work-app")).unwrap();
    fs::create_dir_all(root.join("-work-other")).unwrap();
    write(
        &root.join("-work-app/11111111-1111-4111-8111-111111111111.jsonl"),
        &[
            json!({"type":"user","cwd":"/work/app","message":{"content":"SECRET prompt"}}),
            json!({"type":"ai-title","aiTitle":"Fix the build"}),
        ],
    );
    write(
        &root.join("-work-other/22222222-2222-4222-8222-222222222222.jsonl"),
        &[json!({"type":"user","cwd":"/work/other"})],
    );
    let run = |folder: &str| {
        Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .env("LAZYSH_STATE_DIR", &state)
            .args(["history", "--agent", "claude", "--folder", folder, "--root"])
            .arg(&root)
            .output()
            .unwrap()
    };
    let output = run("/work/app");
    assert!(output.status.success());
    let page: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(page["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(page["sessions"][0]["title"], "Fix the build");
    assert_eq!(
        page["sessions"][0]["sessionId"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("SECRET"));
    assert!(!run("relative/path").status.success());
    // Turning transcript discovery off turns the list off with it.
    let settings = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", &state)
        .args(["settings", "show"])
        .output()
        .unwrap();
    let revision = serde_json::from_slice::<Value>(&settings.stdout).unwrap()["revision"]
        .as_u64()
        .unwrap();
    let off = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", &state)
        .args([
            "settings",
            "update",
            "--expected-revision",
            &revision.to_string(),
            "--transcript-discovery-enabled",
            "false",
            "--recorded-usage-enabled",
            "true",
            "--device-tools-enabled",
            "true",
        ])
        .output()
        .unwrap();
    assert!(
        off.status.success(),
        "{}",
        String::from_utf8_lossy(&off.stderr)
    );
    assert!(!run("/work/app").status.success());
}
