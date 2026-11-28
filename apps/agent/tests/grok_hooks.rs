//! What the companion does with the hook input Grok Build sends: camelCase keys with snake_case aliases and Claude's
//! PascalCase event name, the shape of `HookEventEnvelope::to_hook_json` in the pinned official source (see
//! `tests/fixtures/grok-acp/README.md`). No real Grok Build ran: the payloads are synthetic.
#[path = "support/pane.rs"]
mod pane;
use pane::run;
use serde_json::{json, Value};
use std::{path::Path, process::Output};

fn json_of(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

/// A Grok hook input: both spellings of the common keys, and `extra` merged over them.
fn hook(event: &str, session: &str, extra: Value) -> Value {
    let snake: String = event
        .chars()
        .enumerate()
        .flat_map(|(index, letter)| {
            let lower = letter.to_ascii_lowercase();
            if letter.is_ascii_uppercase() && index > 0 {
                vec!['_', lower]
            } else {
                vec![lower]
            }
        })
        .collect();
    let mut payload = json!({
        "hookEventName": snake, "hook_event_name": event,
        "sessionId": session, "session_id": session,
        "cwd": "/work/project", "workspaceRoot": "/work/project",
        "permissionMode": "default", "timestamp": "2026-11-15T12:00:00Z"
    });
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    payload
}

fn ingest(directory: &Path, agent: &str, payload: &Value) {
    let output = run(
        directory,
        &["ingest", "--agent", agent, "--reported-history"],
        payload,
    );
    assert!(
        output.status.success() && output.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn session(directory: &Path, id: &str) -> Option<Value> {
    let snapshot = json_of(run(directory, &["snapshot"], &Value::Null));
    snapshot["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["sessionId"] == id)
        .cloned()
}

fn reported(directory: &Path, id: &str) -> Value {
    json_of(run(
        directory,
        &["reported-history", &format!("--session-id={id}")],
        &Value::Null,
    ))
}

#[test]
fn a_turn_is_reported_with_its_pane_and_its_session_file() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory
        .path()
        .join("sessions/work-project/s1/updates.jsonl");
    let with_file = |event: &str, extra: Value| {
        let mut payload = hook(event, "grok-1", extra);
        payload["transcriptPath"] = json!(file);
        payload["transcript_path"] = json!(file);
        payload
    };
    ingest(
        directory.path(),
        "grok",
        &with_file("UserPromptSubmit", json!({"response": "never stored"})),
    );
    let row = session(directory.path(), "grok-1").unwrap();
    assert_eq!(
        (
            &row["agent"],
            &row["project"],
            &row["state"],
            &row["paneId"]
        ),
        (
            &json!("Grok Build"),
            &json!("/work/project"),
            &json!("working"),
            &json!("%7")
        )
    );
    let source = reported(directory.path(), "grok-1");
    assert_eq!(
        (&source["status"], &source["path"], &source["paneId"]),
        (&json!("available"), &json!(file), &json!("%7"))
    );
    ingest(
        directory.path(),
        "grok",
        &with_file(
            "PostToolUse",
            json!({"toolName":"run_terminal_command","tool_name":"run_terminal_command","toolInput":{"command":"ls"},"toolResult":"never stored"}),
        ),
    );
    assert_eq!(
        session(directory.path(), "grok-1").unwrap()["summary"],
        "run_terminal_command"
    );
    ingest(
        directory.path(),
        "grok",
        &with_file(
            "Stop",
            json!({"reason": "end_turn", "stopHookActive": false}),
        ),
    );
    let row = session(directory.path(), "grok-1").unwrap();
    assert_eq!(
        (&row["state"], &row["summary"]),
        (&json!("done"), &json!("Turn finished"))
    );
    // The same file again leaves the association usable; nothing of the prompt or the output is kept.
    assert_eq!(reported(directory.path(), "grok-1")["status"], "available");
    let kept = json_of(run(directory.path(), &["snapshot"], &Value::Null)).to_string();
    assert!(!kept.contains("never stored") && !kept.contains("updates.jsonl"));
}

#[test]
fn a_session_file_that_does_not_exist_yet_is_not_a_conflict() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("sessions/p/s2/updates.jsonl");
    // Grok leaves `transcriptPath` out while the file is missing: the first prompt of a new session.
    ingest(
        directory.path(),
        "grok",
        &hook("UserPromptSubmit", "grok-2", json!({})),
    );
    assert_eq!(reported(directory.path(), "grok-2")["status"], "missing");
    assert_eq!(
        session(directory.path(), "grok-2").unwrap()["state"],
        "working"
    );
    ingest(
        directory.path(),
        "grok",
        &hook("Stop", "grok-2", json!({"transcript_path": file})),
    );
    assert_eq!(reported(directory.path(), "grok-2")["path"], json!(file));
    // Two different files for one session id stay unusable, as for every other agent.
    ingest(
        directory.path(),
        "grok",
        &hook(
            "Stop",
            "grok-2",
            json!({"transcript_path": directory.path().join("other.jsonl")}),
        ),
    );
    assert_eq!(reported(directory.path(), "grok-2")["status"], "ambiguous");
}

#[test]
fn a_sub_agent_never_becomes_a_session_or_a_source() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("child.jsonl");
    for event in ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] {
        ingest(
            directory.path(),
            "grok",
            &hook(
                event,
                "grok-child",
                json!({"subagentType": "explore", "transcript_path": file, "tool_name": "grep"}),
            ),
        );
    }
    assert!(session(directory.path(), "grok-child").is_none());
    assert_eq!(
        reported(directory.path(), "grok-child")["status"],
        "missing"
    );
}

#[test]
fn only_a_permission_prompt_makes_the_agent_wait_and_a_turn_end_clears_it() {
    let directory = tempfile::tempdir().unwrap();
    let id = "grok-3";
    let state = |directory: &Path| {
        let row = session(directory, id).unwrap();
        (
            row["state"].clone(),
            row["summary"].clone(),
            row["waiting"].clone(),
        )
    };
    ingest(
        directory.path(),
        "grok",
        &hook("UserPromptSubmit", id, json!({})),
    );
    let note = |kind: &str| {
        hook(
            "Notification",
            id,
            json!({"notificationType": kind, "message": "x"}),
        )
    };
    ingest(directory.path(), "grok", &note("idle_prompt"));
    assert_eq!(state(directory.path()).0, "working");
    ingest(directory.path(), "grok", &note("permission_prompt"));
    assert_eq!(
        state(directory.path()),
        (
            json!("needs_attention"),
            json!("Permission requested"),
            json!("approval")
        )
    );
    ingest(
        directory.path(),
        "grok",
        &hook("PostToolUse", id, json!({"tool_name": "edit"})),
    );
    assert_eq!(state(directory.path()).0, "working");
    ingest(
        directory.path(),
        "grok",
        &hook("StopCancelled", id, json!({"reason": "user_interrupt"})),
    );
    assert_eq!(
        state(directory.path()),
        (json!("done"), json!("Turn interrupted"), Value::Null)
    );
    ingest(
        directory.path(),
        "grok",
        &hook("StopFailure", id, json!({"error": "rate_limit"})),
    );
    assert_eq!(
        state(directory.path()),
        (json!("needs_attention"), json!("Turn failed"), Value::Null)
    );
    ingest(
        directory.path(),
        "grok",
        &hook("SessionEnd", id, json!({"reason": "exit"})),
    );
    assert_eq!(state(directory.path()).0, "done");
}

#[test]
fn grok_reading_a_claude_hook_file_is_reported_as_grok_not_as_claude_code() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("updates.jsonl");
    // The Claude Code fragment is installed in `~/.claude/settings.json`; Grok Build runs it too.
    ingest(
        directory.path(),
        "claude",
        &hook(
            "UserPromptSubmit",
            "grok-4",
            json!({"transcript_path": file}),
        ),
    );
    let row = session(directory.path(), "grok-4").unwrap();
    assert_eq!(row["agent"], "Grok Build");
    assert_eq!(reported(directory.path(), "grok-4")["path"], json!(file));
    // A Claude Code payload keeps its own agent: it has no camelCase `hookEventName`.
    ingest(
        directory.path(),
        "claude",
        &json!({"hook_event_name":"UserPromptSubmit","session_id":"claude-1","cwd":"/work","transcript_path":file}),
    );
    assert_eq!(
        session(directory.path(), "claude-1").unwrap()["agent"],
        "Claude Code"
    );
}

#[test]
fn the_printed_fragment_is_opt_in_and_never_blocks_a_tool() {
    let directory = tempfile::tempdir().unwrap();
    let plain = json_of(run(directory.path(), &["grok-config"], &Value::Null));
    assert_eq!(plain, lazysh_agent::hooks::grok_config());
    let opted = json_of(run(
        directory.path(),
        &["grok-config", "--reported-history"],
        &Value::Null,
    ));
    let events: Vec<_> = opted["hooks"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    // PreToolUse is the one Grok event that can deny a tool call; no fragment installs it.
    assert!(events.contains(&"SessionStart".to_owned()));
    assert!(!events.contains(&"PreToolUse".to_owned()));
    assert!(!plain["hooks"]
        .as_object()
        .unwrap()
        .contains_key("SessionStart"));
    for (event, rows) in opted["hooks"].as_object().unwrap() {
        assert_eq!(
            rows[0]["hooks"][0]["command"], "lazysh-agent ingest --agent grok --reported-history",
            "{event}"
        );
    }
    // Hook input that is not an event of this agent fails visibly instead of being guessed.
    let bad = run(
        directory.path(),
        &["ingest", "--agent", "grok"],
        &json!({"hook_event_name":"Stop","cwd":"/work"}),
    );
    assert!(!bad.status.success());
}

/// The Agent view's whole read for a pane, through the real executable: the hook report names the pane and the session
/// file, the file reads as the conversation, and the hook state is the state of the same session.
#[test]
fn a_reported_grok_session_reads_back_as_its_turn_its_tool_card_and_its_state() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("updates.jsonl");
    let record = |tag: &str, update: Value| {
        let mut update = update;
        update["sessionUpdate"] = json!(tag);
        json!({"timestamp":1,"method":"session/update","params":{"sessionId":"grok-5","update":update}})
    };
    let text = |text: &str| json!({"content":{"type":"text","text":text}});
    let mut prompt = text("Run the tests");
    prompt["_meta"] = json!({"promptIndex": 0});
    let records = [
        record("user_message_chunk", prompt),
        record("agent_message_chunk", text("Running them.")),
        record(
            "tool_call",
            json!({"toolCallId":"t1","title":"npm test","rawInput":{"command":"npm test"},"status":"in_progress"}),
        ),
        record(
            "tool_call_update",
            json!({"toolCallId":"t1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"12 passed"}}]}),
        ),
        record(
            "plan",
            json!({"entries":[{"content":"Run the tests","status":"completed","priority":"high"},{"content":"Report","status":"in_progress","priority":"medium"}]}),
        ),
    ];
    let lines: Vec<String> = records.iter().map(Value::to_string).collect();
    std::fs::write(&file, lines.join("\n") + "\n").unwrap();
    ingest(
        directory.path(),
        "grok",
        &hook(
            "UserPromptSubmit",
            "grok-5",
            json!({"transcript_path": file}),
        ),
    );

    let source = reported(directory.path(), "grok-5");
    assert_eq!(source["paneId"], "%7");
    let page = json_of(run(
        directory.path(),
        &[
            "transcript",
            "--agent",
            "grok-acp",
            "--view",
            "conversation",
            "--path",
            source["path"].as_str().unwrap(),
        ],
        &Value::Null,
    ));
    let messages = page["messages"].as_array().unwrap();
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["blocks"][0]["text"], "Run the tests");
    assert_eq!(messages[1]["blocks"][0]["text"], "Running them.");
    let tool = messages[2]["blocks"].as_array().unwrap();
    assert_eq!(
        (&tool[0]["type"], &tool[0]["name"], &tool[0]["status"]),
        (&json!("tool_use"), &json!("npm test"), &json!("completed"))
    );
    assert_eq!(tool[1]["text"], "12 passed");
    let card = &messages[3]["blocks"][0]["card"];
    assert_eq!(card["kind"], "plan");
    assert_eq!(
        card["entries"][1],
        json!({"text":"Report","status":"in_progress"})
    );
    let state = session(directory.path(), "grok-5").unwrap();
    assert_eq!(
        (&state["paneId"], &state["state"]),
        (&json!("%7"), &json!("working"))
    );
}
