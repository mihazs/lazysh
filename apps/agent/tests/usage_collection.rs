use serde_json::Value;
#[cfg(unix)]
use std::path::PathBuf;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
#[path = "support/binary.rs"]
mod binary;

fn run(state: &Path, args: &[&str]) -> Output {
    Command::new(binary::path())
        .args(args)
        .env("LAZYSH_STATE_DIR", state)
        .output()
        .unwrap()
}
fn json(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn set_quota(state: &Path, revision: &str, enabled: &str) -> Output {
    run(
        state,
        &[
            "usage-collection",
            "update",
            "--expected-revision",
            revision,
            "--account-quota-enabled",
            enabled,
        ],
    )
}

#[test]
fn absent_policy_reads_as_defaults_and_creates_no_state() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("missing");
    let policy = json(&run(&state, &["usage-collection", "show"]));
    assert_eq!(policy["revision"], 0);
    assert_eq!(policy["accountQuotaEnabled"], true);
    assert_eq!(policy["collectorEnabled"], false);
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
    assert_eq!(first["collectorEnabled"], false);
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

/// A private profile that lets the external `ai-usagebar` run, and a fake one that records that it did.
#[cfg(unix)]
struct Host {
    _directory: tempfile::TempDir,
    state: PathBuf,
    command: Command,
    started: PathBuf,
}
#[cfg(unix)]
fn host() -> Host {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let config = if cfg!(target_os = "macos") {
        root.join("Library/Application Support/lazysh")
    } else {
        root.join("config/lazysh")
    };
    let tools = root.join("tools");
    fs::create_dir_all(&config).unwrap();
    fs::create_dir(&tools).unwrap();
    let profile = config.join("account-usage.toml");
    fs::write(
        &profile,
        "[context]\nenabled=false\n[notifications]\nenabled=false\n[anthropic]\nenabled=false\n[openai]\nenabled=false\n[openrouter]\nenabled=false\n[zai]\nenabled=false\n",
    )
    .unwrap();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o600)).unwrap();
    let started = root.join("started");
    let report = r#"{"schema_version":1,"entries":[{"id":"owned","name":"Owned","status":"ready","stale":false,"sections":[{"type":"text","label":"Balance","value":"$12.30"}]}]}"#;
    let executable = tools.join("ai-usagebar");
    fs::write(
        &executable,
        format!("#!/bin/sh\necho started > \"$OWNED_STARTED\"\nprintf '%s' '{report}'\n"),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let state = root.join("state");
    let mut command = Command::new(binary::path());
    command
        .arg("account-usage")
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("PATH", &tools)
        .env("LAZYSH_STATE_DIR", &state)
        .env("OWNED_STARTED", &started);
    Host {
        _directory: directory,
        state,
        command,
        started,
    }
}

#[cfg(unix)]
#[test]
fn account_quota_reads_stay_allowed_by_default_and_a_forbidden_one_starts_nothing() {
    let mut allowed = host();
    let response = json(&allowed.command.output().unwrap());
    assert_eq!(response["state"], "ready");
    assert!(
        allowed.started.exists(),
        "the default policy allows the read"
    );

    let mut forbidden = host();
    json(&set_quota(&forbidden.state, "0", "false"));
    let response = json(&forbidden.command.output().unwrap());
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
    assert_eq!(json(&forbidden.command.output().unwrap())["state"], "ready");
    assert!(forbidden.started.exists());
}

#[cfg(unix)]
#[test]
fn an_unreadable_policy_fails_the_quota_read_closed() {
    let mut host = host();
    json(&set_quota(&host.state, "0", "true"));
    fs::write(host.state.join("usage-collection.json"), "not json").unwrap();
    let output = host.command.output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!host.started.exists());
}
