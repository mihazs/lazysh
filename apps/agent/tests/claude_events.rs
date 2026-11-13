//! Harness records the conversation view shows as compact event lines, over `fixtures/claude-events.jsonl`
//! (synthetic, in the record shapes Claude Code 2.1.3xx writes): goal set and reached, plan mode on and off,
//! the away recap and a failed hook. Hook successes, skill listings, repeated goal checks and a sub-agent's plan
//! mode reminder stay hidden.
use lazysh_agent::transcript::{conversation, read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::fs;

const LOG: &str = include_str!("fixtures/claude-events.jsonl");

#[test]
fn chosen_events_become_event_messages_in_place_and_the_rest_stays_hidden() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("c.jsonl");
    fs::write(&path, LOG).unwrap();
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    let shape: Vec<Value> = page
        .messages
        .iter()
        .map(|message| {
            if message["role"] == "event" {
                json!([
                    message["event"]["kind"],
                    message["event"]["text"],
                    message["event"]["detail"],
                    message["blocks"]
                ])
            } else {
                json!(message["role"])
            }
        })
        .collect();
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
