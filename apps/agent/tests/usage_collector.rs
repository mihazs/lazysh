//! The collector's tick with an injected clock, quota reader and a temporary state directory.
use chrono::{DateTime, Duration, TimeZone, Utc};
use lazysh_account_usage::{normalize, Response};
use lazysh_agent::{
    usage_collection,
    usage_collector::{run_once, Outcome},
};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
};

fn start() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 14, 12, 0, 0).unwrap()
}
fn metric(label: &str, percent: f64, reading: &str) -> Value {
    json!({"type":"metric","label":label,"value":"x","percent":percent,"headline":"percent","reading":reading,
        "reset_at":"2026-11-14T17:00:00Z","window_secs":18000})
}
fn entry(id: &str, sections: Vec<Value>) -> Value {
    json!({"id":id,"name":id,"status":"ready","stale":false,"fetched_at":"2026-11-14T11:59:00Z",
        "plan":"Max 20x","sections":sections})
}
fn report(entries: Vec<Value>) -> Response {
    let report = json!({"schema_version":1,"entries":entries});
    normalize(&serde_json::to_vec(&report).unwrap(), "builtin")
}
fn quota() -> Response {
    report(vec![entry(
        "anthropic",
        vec![
            metric("Session", 42.5, "used"),
            metric("Weekly", 80.0, "left"),
            json!({"type":"text","label":"Balance","value":"$12.30"}),
        ],
    )])
}
/// A temporary host with the collector on, and its state directory.
fn collector(interval: u32) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    enable(&state, interval);
    (directory, state)
}
fn enable(directory: &Path, interval: u32) {
    usage_collection::update(directory, None, |policy| {
        policy.collector_enabled = true;
        policy.collector_interval_minutes = interval;
    })
    .unwrap();
}
fn stored(directory: &Path) -> Value {
    serde_json::from_slice(&fs::read(directory.join("usage-samples.json")).unwrap()).unwrap()
}
/// A tick with a quota reader that counts its calls.
fn tick(directory: &Path, at: DateTime<Utc>, response: Response) -> (Outcome, u32) {
    let calls = Cell::new(0);
    let outcome = run_once(directory, at, || {
        calls.set(calls.get() + 1);
        Ok(response)
    })
    .unwrap();
    (outcome, calls.get())
}

#[test]
fn a_collector_that_is_off_reads_nothing_and_writes_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    usage_collection::update(&state, None, |policy| policy.collector_enabled = false).unwrap();
    assert_eq!(tick(&state, start(), quota()), (Outcome::Off, 0));
    assert!(!state.join("usage-samples.json").exists());
    // Disabled after having run: still nothing, and what was recorded stays untouched.
    enable(&state, 30);
    assert_eq!(tick(&state, start(), quota()), (Outcome::Recorded, 1));
    let before = fs::read(state.join("usage-samples.json")).unwrap();
    usage_collection::update(&state, None, |policy| policy.collector_enabled = false).unwrap();
    let later = start() + Duration::days(30);
    assert_eq!(tick(&state, later, quota()), (Outcome::Off, 0));
    assert_eq!(fs::read(state.join("usage-samples.json")).unwrap(), before);
}

#[test]
fn an_enabled_collector_records_one_timestamped_sample_per_interval() {
    let (_directory, state) = collector(30);
    assert_eq!(tick(&state, start(), quota()), (Outcome::Recorded, 1));
    // The timer ticks every five minutes; a tick inside the interval reads nothing.
    for minutes in [5, 10, 25] {
        let at = start() + Duration::minutes(minutes);
        assert_eq!(tick(&state, at, quota()), (Outcome::NotDue, 0));
    }
    // A run starts a moment after its tick, so a minute of slack keeps the interval from doubling.
    let second = start() + Duration::minutes(29);
    assert_eq!(tick(&state, second, quota()), (Outcome::Recorded, 1));
    let store = stored(&state);
    assert_eq!(store["lastRun"]["at"], "2026-11-14T12:29:00Z");
    assert_eq!(store["lastRun"]["outcome"], "recorded");
    let times: Vec<&str> = store["samples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|sample| sample["recordedAt"].as_str().unwrap())
        .collect();
    assert_eq!(times, ["2026-11-14T12:00:00Z", "2026-11-14T12:29:00Z"]);
}

#[test]
fn a_sample_keeps_percentages_and_resets_and_nothing_a_plan_or_balance_could_leak() {
    let (_directory, state) = collector(30);
    tick(&state, start(), quota());
    let sample = &stored(&state)["samples"][0];
    assert_eq!(sample["source"], "builtin");
    assert_eq!(sample["truncated"], false);
    let account = &sample["entries"][0];
    assert_eq!(account["id"], "anthropic");
    assert_eq!(account["fetchedAt"], "2026-11-14T11:59:00Z");
    assert_eq!(account["stale"], false);
    assert_eq!(
        account["rows"],
        json!([
            {"label":"Session","percent":42.5,"reading":"used","resetAt":"2026-11-14T17:00:00Z","windowSeconds":18000},
            {"label":"Weekly","percent":80.0,"reading":"left","resetAt":"2026-11-14T17:00:00Z","windowSeconds":18000},
        ])
    );
    let text = fs::read_to_string(state.join("usage-samples.json")).unwrap();
    for leaked in ["Max 20x", "Balance", "$12.30"] {
        assert!(!text.contains(leaked), "{leaked}");
    }
}

#[test]
fn a_report_larger_than_the_bounds_is_cut_and_says_so() {
    let (_directory, state) = collector(30);
    let rows: Vec<Value> = (0..20)
        .map(|n| metric(&format!("Window {n}"), 1.0, "used"))
        .collect();
    let entries: Vec<Value> = (0..40)
        .map(|n| entry(&format!("p{n}"), rows.clone()))
        .collect();
    tick(&state, start(), report(entries));
    let sample = &stored(&state)["samples"][0];
    assert_eq!(sample["truncated"], true);
    assert_eq!(sample["entries"].as_array().unwrap().len(), 32);
    assert_eq!(sample["entries"][0]["rows"].as_array().unwrap().len(), 16);
}

#[test]
fn a_host_that_forbids_the_quota_read_is_skipped_without_reading_or_a_sample() {
    let (_directory, state) = collector(30);
    usage_collection::update(&state, None, |policy| {
        policy.account_quota_enabled = false;
    })
    .unwrap();
    assert_eq!(tick(&state, start(), quota()), (Outcome::Skipped, 0));
    let store = stored(&state);
    assert_eq!(store["samples"], json!([]));
    assert_eq!(store["lastRun"]["outcome"], "skipped");
    assert_eq!(store["lastRun"]["reason"], "accountQuotaDisabled");
}

#[test]
fn an_offline_read_records_the_run_and_no_sample_so_the_gap_stays_unknown() {
    let (_directory, state) = collector(30);
    let timed_out = Response::unavailable("timeout");
    assert_eq!(tick(&state, start(), timed_out), (Outcome::Unavailable, 1));
    let store = stored(&state);
    assert_eq!(store["samples"], json!([]));
    assert_eq!(store["lastRun"]["outcome"], "unavailable");
    assert_eq!(store["lastRun"]["reason"], "timeout");
}

#[test]
fn a_suspended_host_records_one_sample_after_waking_not_a_burst() {
    let (_directory, state) = collector(30);
    tick(&state, start(), quota());
    let woke = start() + Duration::days(3);
    assert_eq!(tick(&state, woke, quota()), (Outcome::Recorded, 1));
    assert_eq!(
        tick(&state, woke + Duration::minutes(5), quota()),
        (Outcome::NotDue, 0)
    );
    assert_eq!(stored(&state)["samples"].as_array().unwrap().len(), 2);
}

#[test]
fn a_clock_that_moved_back_does_not_stop_the_collector() {
    let (_directory, state) = collector(30);
    tick(&state, start(), quota());
    let earlier = start() - Duration::hours(2);
    assert_eq!(tick(&state, earlier, quota()), (Outcome::Recorded, 1));
}

#[test]
fn a_policy_change_while_the_quota_is_read_wins_and_nothing_is_written() {
    let (_directory, state) = collector(30);
    let outcome = run_once(&state, start(), || {
        usage_collection::update(&state, None, |policy| {
            policy.collector_enabled = false;
        })
        .unwrap();
        Ok(quota())
    })
    .unwrap();
    assert_eq!(outcome, Outcome::Off);
    assert!(!&state.join("usage-samples.json").exists());
}

#[cfg(unix)]
fn preload(directory: &Path, samples: Vec<Value>) {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join("usage-samples.json");
    let store = json!({"schemaVersion":1,"lastRun":null,"samples":samples});
    fs::write(&path, serde_json::to_vec(&store).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
}
#[cfg(unix)]
fn empty_sample(at: DateTime<Utc>) -> Value {
    json!({"recordedAt":at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),"source":"builtin","truncated":false,"entries":[]})
}

#[cfg(unix)]
#[test]
fn retention_drops_what_is_older_than_seven_days() {
    let (_directory, state) = collector(30);
    let old = start() - Duration::days(8);
    let recent = start() - Duration::days(6);
    preload(&state, vec![empty_sample(old), empty_sample(recent)]);
    tick(&state, start(), quota());
    let times: Vec<String> = stored(&state)["samples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|sample| sample["recordedAt"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(times, ["2026-11-08T12:00:00Z", "2026-11-14T12:00:00Z"]);
}

#[cfg(unix)]
#[test]
fn the_sample_count_is_bounded_and_the_oldest_go_first() {
    let (_directory, state) = collector(30);
    let first = start() - Duration::days(5);
    let many = (0..1005)
        .map(|n| empty_sample(first + Duration::minutes(n * 5)))
        .collect();
    preload(&state, many);
    tick(&state, start(), quota());
    let samples = stored(&state)["samples"].clone();
    let samples = samples.as_array().unwrap();
    assert_eq!(samples.len(), 1000);
    assert_eq!(
        samples.last().unwrap()["recordedAt"],
        "2026-11-14T12:00:00Z"
    );
    // 1006 existed, the six oldest went.
    assert_eq!(
        samples[0]["recordedAt"],
        (first + Duration::minutes(6 * 5)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    );
}

#[cfg(unix)]
#[test]
fn the_file_size_is_bounded_and_the_oldest_go_first() {
    let (_directory, state) = collector(30);
    let rows: Vec<Value> = (0..16)
        .map(|n| json!({"label":format!("{n}{}", "w".repeat(150)),"percent":1.0,"reading":"used","resetAt":null,"windowSeconds":null}))
        .collect();
    let account =
        json!({"id":"a","name":"a","status":"ready","stale":false,"fetchedAt":null,"rows":rows});
    let size = |sample: &Value| serde_json::to_vec(sample).unwrap().len() + 1;
    // The envelope around the samples, then big samples until one more would cross the limit.
    let mut total = size(&json!({"schemaVersion":1,"lastRun":null,"samples":[]}));
    let mut samples = Vec::new();
    for n in 0.. {
        let mut sample = empty_sample(start() - Duration::hours(40 - n));
        sample["entries"] = json!(vec![account.clone(); 12]);
        if total + size(&sample) > 1_048_576 - 100 {
            break;
        }
        total += size(&sample);
        samples.push(sample);
    }
    // One padded sample brings the file to within 100 bytes of the limit, so any new sample overflows it.
    let mut pad = empty_sample(start() - Duration::hours(1));
    pad["entries"] =
        json!([{"id":"a","name":"","status":"ready","stale":false,"fetchedAt":null,"rows":[]}]);
    pad["entries"][0]["name"] = json!("x".repeat(1_048_576 - 100 - total - size(&pad)));
    samples.push(pad);
    let preloaded = samples.len();
    assert!(preloaded > 10);
    preload(&state, samples);
    tick(&state, start(), quota());
    let bytes = fs::read(state.join("usage-samples.json")).unwrap();
    assert!(bytes.len() <= 1_048_576, "{}", bytes.len());
    let store: Value = serde_json::from_slice(&bytes).unwrap();
    let kept = store["samples"].as_array().unwrap();
    assert!(kept.len() <= preloaded, "the new sample displaced old ones");
    assert_eq!(kept.last().unwrap()["recordedAt"], "2026-11-14T12:00:00Z");
    assert_ne!(
        kept[0]["recordedAt"],
        (start() - Duration::hours(40)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_sample_file_stops_the_run_and_is_never_repaired() {
    let (_directory, state) = collector(30);
    preload(&state, vec![]);
    let path = &state.join("usage-samples.json");
    fs::write(path, "not json").unwrap();
    let calls = Cell::new(0);
    let result = run_once(&state, start(), || {
        calls.set(1);
        Ok(quota())
    });
    assert!(result.is_err());
    assert_eq!(calls.get(), 0);
    assert_eq!(fs::read_to_string(path).unwrap(), "not json");
}
