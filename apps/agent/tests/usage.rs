use chrono::{TimeZone, Utc};
use lazysh_agent::transcript::{TranscriptAgent, TranscriptPage};
use lazysh_agent::usage;
use serde_json::{json, Value};

fn page(messages: Vec<Value>) -> TranscriptPage {
    TranscriptPage {
        schema_version: 1,
        view: "record_stream",
        agent: TranscriptAgent::Claude,
        messages,
        next_offset: 500,
        has_more: false,
        branch_id: None,
        truncated: false,
        checkpoint: None,
    }
}
fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 24, 20, 0, 0).unwrap()
}

#[test]
fn recorded_counters_are_not_added_or_converted_to_context_and_quota() {
    let page = page(vec![
        json!({"id":"chunk1","timestamp":"2026-10-24T19:59:00Z","usage":{"inputTokens":120,"outputTokens":12,"cacheReadTokens":40}}),
        json!({"id":"chunk2","timestamp":"2026-10-24T19:59:01Z","usage":{"inputTokens":120,"outputTokens":12,"cacheReadTokens":40}}),
    ]);
    let snapshot = serde_json::to_value(usage::from_page(page, now()).unwrap()).unwrap();
    assert_eq!(snapshot["samples"][0]["inputTokens"], 120);
    assert_eq!(snapshot["samples"][1]["inputTokens"], 120);
    assert!(snapshot.get("totalTokens").is_none());
    assert_eq!(
        snapshot["context"],
        json!({"usedTokens":null,"limitTokens":null,"remainingTokens":null})
    );
    assert_eq!(snapshot["quota"], json!({"remaining":null,"resetsAt":null}));
    assert_eq!(snapshot["scope"], "transcript_window");
}

#[test]
fn missing_counts_remain_unknown_and_old_future_or_undated_reports_are_explicit() {
    let mut sample = page(vec![
        json!({"id":"fresh","timestamp":"2026-10-24T19:59:00Z","usage":{"outputTokens":0}}),
        json!({"id":"old","timestamp":"2026-10-24T18:00:00Z","usage":{"outputTokens":6}}),
        json!({"id":"future","timestamp":"2026-10-24T22:00:00Z","usage":{"outputTokens":8}}),
        json!({"id":"undated","usage":{"outputTokens":9}}),
        json!({"id":"subsecond-future","timestamp":"2026-10-24T20:00:00.100Z","usage":{"outputTokens":1}}),
    ]);
    sample.has_more = true;
    let snapshot = serde_json::to_value(usage::from_page(sample, now()).unwrap()).unwrap();
    let samples = snapshot["samples"].as_array().unwrap();
    assert_eq!(samples[0]["outputTokens"], 0);
    assert_eq!(samples[0]["inputTokens"], Value::Null);
    assert_eq!(
        samples
            .iter()
            .map(|row| row["freshness"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["fresh", "stale", "unknown", "unknown", "unknown"]
    );
    assert_eq!(samples[3]["recordedAt"], Value::Null);
    assert_eq!(snapshot["hasMore"], true);
    assert_eq!(snapshot["nextOffset"], 500);
}

#[test]
fn bounded_sample_history_deduplicates_record_identity_and_keeps_latest_twenty() {
    let mut samples = (0..25)
        .map(|index| json!({"id":format!("s{index}"),"usage":{"inputTokens":index}}))
        .collect::<Vec<_>>();
    samples.push(json!({"id":"s24","usage":{"inputTokens":99}}));
    let snapshot = serde_json::to_value(usage::from_page(page(samples), now()).unwrap()).unwrap();
    assert_eq!(snapshot["samplesAvailable"], 25);
    assert_eq!(snapshot["samples"].as_array().unwrap().len(), 20);
    assert_eq!(snapshot["samples"][19]["inputTokens"], 99);
}

#[test]
fn invalid_counters_cannot_become_plausible_values() {
    for number in [json!(-1), json!(1.5), json!("10"), json!(u64::MAX)] {
        assert!(usage::from_page(
            page(vec![json!({"id":"bad","usage":{"inputTokens":number}})]),
            now()
        )
        .is_err());
    }
}

#[test]
fn reading_usage_returns_only_selected_transcript_metrics_without_retaining_prompts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    std::fs::write(&path,format!("{}\n",json!({"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"PRIVATE-PROMPT"}],"usage":{"input_tokens":22,"output_tokens":3}}}))).unwrap();
    let before = std::fs::read(&path).unwrap();
    let snapshot =
        serde_json::to_string(&usage::read(&path, TranscriptAgent::Claude, None, 0).unwrap())
            .unwrap();
    assert!(snapshot.contains("inputTokens\":22"));
    assert!(!snapshot.contains("PRIVATE-PROMPT"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .args(["usage", "--agent", "claude", "--path"])
        .arg(&path)
        .env("LAZYSH_STATE_DIR", dir.path().join("unused-state"))
        .output()
        .unwrap();
    assert!(output.status.success());
    let output: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output["schemaVersion"], 1);
    assert_eq!(output["samples"][0]["inputTokens"], 22);
    assert!(!dir.path().join("unused-state").exists());
}
