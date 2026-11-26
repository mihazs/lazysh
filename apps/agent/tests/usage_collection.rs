#[cfg(unix)]
use quota_host::host;
use quota_host::{json, run, set_quota};
use std::fs;
#[path = "support/binary.rs"]
mod binary;
#[allow(dead_code)]
#[path = "support/quota_host.rs"]
mod quota_host;

#[test]
fn absent_policy_reads_as_defaults_and_creates_no_state() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("missing");
    let policy = json(&run(&state, &["usage-collection", "show"]));
    assert_eq!(policy["revision"], 0);
    assert_eq!(policy["accountQuotaEnabled"], true);
    assert_eq!(policy["collectorEnabled"], true);
    assert_eq!(policy["collectorIntervalMinutes"], 30);
    assert!(!state.exists());
}

#[test]
fn updates_persist_for_new_processes_and_a_stale_revision_changes_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let first = json(&set_quota(&state, "0", "false"));
    assert_eq!(first["revision"], 1);
    assert_eq!(first["accountQuotaEnabled"], false);
    assert_eq!(first["collectorEnabled"], true);
    assert_eq!(json(&run(&state, &["usage-collection", "show"])), first);
    let stale = set_quota(&state, "0", "true");
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("SettingsConflict"));
    assert_eq!(json(&run(&state, &["usage-collection", "show"])), first);
    let mut names: Vec<_> = fs::read_dir(&state)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["usage-collection.json", "usage-collection.lock"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in &names {
            let mode = fs::metadata(state.join(name)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{name}");
        }
    }
}

#[test]
fn a_malformed_or_unknown_policy_is_refused_and_never_repaired() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    json(&set_quota(&state, "0", "true"));
    let path = state.join("usage-collection.json");
    for text in [
        "not json",
        r#"{"schemaVersion":1,"revision":1,"accountQuotaEnabled":true,"collectorEnabled":false,"collectorIntervalMinutes":4}"#,
        r#"{"schemaVersion":1,"revision":1,"accountQuotaEnabled":true,"collectorEnabled":false,"collectorIntervalMinutes":30,"extra":1}"#,
    ] {
        fs::write(&path, text).unwrap();
        assert!(!run(&state, &["usage-collection", "show"]).status.success());
        assert!(!set_quota(&state, "1", "false").status.success());
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }
}

#[cfg(unix)]
#[test]
fn account_quota_reads_stay_allowed_by_default_and_a_forbidden_one_starts_nothing() {
    let allowed = host();
    let response = json(&allowed.command(&["account-usage"]).output().unwrap());
    assert_eq!(response["state"], "ready");
    assert!(
        allowed.started.exists(),
        "the default policy allows the read"
    );

    let forbidden = host();
    json(&set_quota(&forbidden.state, "0", "false"));
    let response = json(&forbidden.command(&["account-usage"]).output().unwrap());
    assert_eq!(
        response,
        serde_json::json!({"schemaVersion":1,"state":"disabled","source":null,"report":null})
    );
    assert!(
        !forbidden.started.exists(),
        "a forbidden read must not start the helper"
    );

    // Turning the switch back on applies to the next call, with no restart.
    json(&set_quota(&forbidden.state, "1", "true"));
    assert_eq!(
        json(&forbidden.command(&["account-usage"]).output().unwrap())["state"],
        "ready"
    );
    assert!(forbidden.started.exists());
}

#[cfg(unix)]
#[test]
fn an_unreadable_policy_fails_the_quota_read_closed() {
    let host = host();
    json(&set_quota(&host.state, "0", "true"));
    fs::write(host.state.join("usage-collection.json"), "not json").unwrap();
    let output = host.command(&["account-usage"]).output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!host.started.exists());
}
