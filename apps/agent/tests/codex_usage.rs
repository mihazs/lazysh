use lazysh_agent::{transcript::TranscriptAgent, usage};
use serde_json::{json, Value};
use std::{fs, io::Write};

#[path = "support/jsonl.rs"]
mod jsonl;
use jsonl::write as records;
fn event(info: Value, rate: Value) -> Value {
    json!({"type":"event_msg","timestamp":"2020-01-01T00:00:00Z","payload":{"type":"token_count","info":info,"rate_limits":rate}})
}
fn info() -> Value {
    json!({"total_token_usage":{"input_tokens":9999,"total_tokens":9999},"last_token_usage":{"input_tokens":120,"cached_input_tokens":40,"output_tokens":12,"total_tokens":132},"model_context_window":1000})
}
fn rate(id: &str, percent: f64) -> Value {
    json!({"limit_id":id,"primary":{"used_percent":percent,"window_minutes":300,"resets_at":4102444800_i64},"secondary":{"used_percent":0.0,"window_minutes":10080,"resets_at":null},"credits":{"balance":"SECRET"},"plan_type":"SECRET"})
}
fn read(path: &std::path::Path, offset: u64) -> Value {
    serde_json::to_value(usage::read(path, TranscriptAgent::Codex, None, offset).unwrap()).unwrap()
}

#[test]
fn codex_records_actual_last_context_and_windows_without_cumulative_or_account_claims() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    records(
        &path,
        &[
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"SECRET-PROMPT"}]}}),
            event(info(), rate("codex", 12.5)),
        ],
    );
    let before = fs::read(&path).unwrap();
    let result = read(&path, 0);
    assert_eq!(result["schemaVersion"], 1);
    assert_eq!(result["samples"][0]["inputTokens"], 120);
    assert_eq!(result["recordedContext"]["usedTokens"], 132);
    assert_eq!(result["recordedContext"]["limitTokens"], 1000);
    assert_eq!(result["recordedContext"]["freshness"], "stale");
    assert_eq!(result["providerWindows"].as_array().unwrap().len(), 2);
    assert_eq!(result["providerWindows"][0]["usedPercent"], 12.5);
    assert_eq!(result["providerWindows"][0]["accountId"], Value::Null);
    assert_eq!(result["providerWindows"][1]["usedPercent"], 0.0);
    assert_eq!(result["providerWindows"][1]["resetsAt"], Value::Null);
    assert_eq!(result["context"]["remainingTokens"], Value::Null);
    assert_eq!(result["quota"]["remaining"], Value::Null);
    let output = result.to_string();
    for secret in ["SECRET", "9999"] {
        assert!(!output.contains(secret));
    }
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn latest_snapshot_replaces_each_limit_and_null_clears_unavailable_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    records(
        &path,
        &[
            event(info(), rate("first", 10.0)),
            event(info(), rate("other", 20.0)),
            event(
                Value::Null,
                json!({"limit_id":"first","primary":{"used_percent":30.0,"window_minutes":null,"resets_at":null},"secondary":null}),
            ),
        ],
    );
    let result = read(&path, 0);
    assert_eq!(result["recordedContext"], Value::Null);
    assert_eq!(result["providerWindows"].as_array().unwrap().len(), 3);
    assert_eq!(result["providerWindows"][2]["usedPercent"], 30.0);
    assert_eq!(result["providerWindows"][2]["windowMinutes"], Value::Null);
    assert_eq!(result["samples"].as_array().unwrap().len(), 2);
    records(
        &path,
        &[
            event(info(), rate("first", 10.0)),
            event(Value::Null, Value::Null),
        ],
    );
    let result = read(&path, 0);
    assert_eq!(result["recordedContext"], Value::Null);
    assert!(result["providerWindows"].as_array().unwrap().is_empty());
}

#[test]
fn codex_windows_are_bounded_and_cursors_resume_without_reading_a_partial_tail() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    let values = (0..101)
        .map(|id| event(info(), rate(&format!("limit-{id}"), 25.0)))
        .collect::<Vec<_>>();
    records(&path, &values);
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"type\":")
        .unwrap();
    let first = read(&path, 0);
    assert_eq!(first["samplesAvailable"], 100);
    assert_eq!(first["samples"].as_array().unwrap().len(), 20);
    assert_eq!(first["providerWindows"].as_array().unwrap().len(), 16);
    assert_eq!(first["hasMore"], true);
    let second = read(&path, first["nextOffset"].as_u64().unwrap());
    assert_eq!(second["samplesAvailable"], 1);
    assert_eq!(second["hasMore"], false);
    let tail = read(&path, second["nextOffset"].as_u64().unwrap());
    assert_eq!(tail["nextOffset"], second["nextOffset"]);
    assert_eq!(tail["hasMore"], false);
}

#[test]
fn invalid_limits_counters_and_unsafe_file_shapes_fail_without_plausible_defaults() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    for invalid in [json!(-1), json!(101), json!("25")] {
        let mut value = rate("codex", 10.0);
        value["primary"]["used_percent"] = invalid;
        records(&path, &[event(info(), value)]);
        assert!(usage::read(&path, TranscriptAgent::Codex, None, 0).is_err());
    }
    let mut bad = info();
    bad["last_token_usage"]["total_tokens"] = json!(u64::MAX);
    records(&path, &[event(bad, Value::Null)]);
    assert!(usage::read(&path, TranscriptAgent::Codex, None, 0).is_err());
    fs::write(&path, "x".repeat(256 * 1024 + 1)).unwrap();
    assert!(usage::read(&path, TranscriptAgent::Codex, None, 0).is_err());
    records(&path, &[event(info(), rate("codex", 20.0))]);
    assert!(usage::read(&path, TranscriptAgent::Codex, None, 1).is_err());
    #[cfg(unix)]
    {
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(usage::read(&link, TranscriptAgent::Codex, None, 0).is_err());
    }
}

#[test]
fn recording_times_and_passed_resets_do_not_make_old_or_future_snapshots_live() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    let mut recent = event(info(), rate("codex", 0.0));
    recent["timestamp"] = json!(chrono::Utc::now().to_rfc3339());
    recent["payload"]["rate_limits"]["primary"]["resets_at"] = json!(1);
    records(&path, &[recent]);
    let result = read(&path, 0);
    assert_eq!(result["recordedContext"]["freshness"], "fresh");
    assert_eq!(result["providerWindows"][0]["freshness"], "stale");
    let mut future = event(info(), rate("codex", 0.0));
    future["timestamp"] = json!("2999-01-01T00:00:00Z");
    records(&path, &[future]);
    let result = read(&path, 0);
    assert_eq!(result["recordedContext"]["freshness"], "unknown");
    assert_eq!(result["providerWindows"][0]["freshness"], "unknown");
    let mut undated = event(info(), rate("codex", 0.0));
    undated.as_object_mut().unwrap().remove("timestamp");
    records(&path, &[undated]);
    let result = read(&path, 0);
    assert_eq!(result["recordedContext"]["recordedAt"], Value::Null);
    assert_eq!(result["recordedContext"]["freshness"], "unknown");
    assert_eq!(result["providerWindows"][0]["recordedAt"], Value::Null);
}
