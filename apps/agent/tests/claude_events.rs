//! Harness records the conversation view shows as compact event lines, over `fixtures/claude-events.jsonl`
//! (synthetic, in the record shapes Claude Code 2.1.3xx writes): goal set and reached, plan mode on and off,
//! the away recap and a failed hook. Hook successes, skill listings, repeated goal checks and a sub-agent's plan
//! mode reminder stay hidden.
use lazysh_agent::transcript::{conversation, read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::fs;

const LOG: &str = include_str!("fixtures/claude-events.jsonl");

/// Each message as its role, or, for an event, what `describe` makes of it.
fn shape(path: &std::path::Path, describe: impl Fn(&Value) -> Value) -> Vec<Value> {
    let page = conversation(path, TranscriptAgent::Claude, 100).unwrap();
    page.messages
        .iter()
        .map(|message| {
            if message["role"] == "event" {
                describe(message)
            } else {
                json!(message["role"])
            }
        })
        .collect()
}

#[test]
fn chosen_events_become_event_messages_in_place_and_the_rest_stays_hidden() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("c.jsonl");
    fs::write(&path, LOG).unwrap();
    let shape = shape(&path, |message| {
        json!([
            message["event"]["kind"],
            message["event"]["text"],
            message["event"]["detail"],
            message["blocks"]
        ])
    });
    assert_eq!(
        shape,
        vec![
            json!("user"),
            json!(["goal", "Merge every ready PR", null, []]),
            json!(["planMode", "", null, []]),
            json!("assistant"),
            json!(["planModeExit", "", null, []]),
            json!([
                "hookFailed",
                "PostToolUse:Read",
                "Failed with non-blocking status code: boom",
                []
            ]),
            json!([
                "recap",
                "Merged two PRs; waiting on CI for the third.",
                null,
                []
            ]),
            json!(["goalMet", "Merge every ready PR", "All PRs are merged.", []]),
            json!("assistant"),
        ]
    );
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(page.messages[1]["timestamp"], "2026-11-11T10:01:00Z");
    assert_eq!(page.messages[1]["id"], "r1");
}

#[test]
fn the_records_view_keeps_its_message_shapes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("c.jsonl");
    fs::write(&path, LOG).unwrap();
    let page = read_page(&path, TranscriptAgent::Claude, 0, 100).unwrap();
    assert!(page
        .messages
        .iter()
        .all(|message| message["role"] != "event"));
}

/// Synthetic records in the shape Claude Code writes: a plug-in status line of a record type lazysh does not map,
/// a `system` record of an unmapped subtype, known housekeeping, and and a record without an id, which cannot sit on the branch.
const UNMAPPED: &str = r#"{"uuid":"u0","parentUuid":null,"type":"user","message":{"role":"user","content":"hi"}}
{"uuid":"u1","parentUuid":"u0","type":"plugin-status","timestamp":"2026-11-11T10:01:00Z","text":"build: 3 jobs running"}
{"uuid":"u2","parentUuid":"u1","type":"system","subtype":"plugin_notice","content":"Plug-in x updated"}
{"uuid":"u3","parentUuid":"u2","type":"system","subtype":"turn_duration","durationMs":5}
{"type":"file-history-snapshot","messageId":"u3","text":"hidden bookkeeping"}
{"uuid":"u6","parentUuid":"u3","type":"assistant","message":{"role":"assistant","id":"m","content":[{"type":"text","text":"ok"}]}}
"#;

#[test]
fn a_record_lazysh_does_not_map_is_a_labelled_card_with_the_agents_own_text() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("c.jsonl");
    fs::write(&path, UNMAPPED).unwrap();
    let shape = shape(&path, |message| {
        json!([
            message["event"]["kind"],
            message["event"]["text"],
            message["event"]["detail"]
        ])
    });
    assert_eq!(
        shape,
        vec![
            json!("user"),
            json!(["unmapped", "plugin-status", "build: 3 jobs running"]),
            json!(["unmapped", "system/plugin_notice", "Plug-in x updated"]),
            json!("assistant"),
        ]
    );
}
