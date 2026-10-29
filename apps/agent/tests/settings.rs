use lazysh_agent::settings;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
#[path = "support/binary.rs"]
mod binary;

fn run(directory: &Path, args: &[&str]) -> Output {
    Command::new(binary::path())
        .args(args)
        .env("LAZYSH_STATE_DIR", directory)
        .env("PATH", directory.join("no-sdk"))
        .output()
        .unwrap()
}
#[test]
fn absent_settings_read_returns_defaults_without_creating_state() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("missing");
    assert_eq!(
        settings::read(&state).unwrap(),
        settings::Settings::default()
    );
    let output = run(&state, &["settings", "show"]);
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["revision"], 0);
    assert_eq!(value["recordedUsageEnabled"], true);
    assert!(!state.exists());
}
#[test]
fn atomic_updates_persist_exact_values_and_reject_stale_revisions() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let first = settings::update(&state, 0, false, true, false).unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(settings::read(&state).unwrap(), first);
    assert!(settings::update(&state, 0, true, false, true).is_err());
    assert_eq!(settings::read(&state).unwrap(), first);
    let second = settings::update(&state, 1, true, false, true).unwrap();
    assert_eq!(second.revision, 2);
    assert_eq!(settings::read(&state).unwrap(), second);
    assert_eq!(fs::read_dir(&state).unwrap().count(), 2);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for name in ["settings.json", "settings.lock"] {
            assert_eq!(
                fs::metadata(state.join(name)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn cli_updates_apply_all_explicit_flags_and_new_processes_observe_them() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let output = run(
        &state,
        &[
            "settings",
            "update",
            "--expected-revision",
            "0",
            "--transcript-discovery-enabled",
            "false",
            "--recorded-usage-enabled",
            "false",
            "--device-tools-enabled",
            "true",
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let settings: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(settings["revision"], 1);
    assert_eq!(settings["recordedUsageEnabled"], false);
    assert_eq!(settings["deviceToolsEnabled"], true);
    assert_eq!(
        serde_json::from_slice::<Value>(&run(&state, &["settings", "show"]).stdout).unwrap(),
        settings
    );
}
#[test]
fn simultaneous_clients_have_one_winner_without_lost_updates() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    settings::update(&state, 0, true, true, true).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let jobs = (0..2)
        .map(|_| {
            let state = state.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                settings::update(&state, 1, false, false, false)
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        jobs.into_iter()
            .map(|job| job.join().unwrap().is_ok())
            .filter(|ok| *ok)
            .count(),
        1
    );
    assert_eq!(settings::read(&state).unwrap().revision, 2);
}
#[test]
fn disabled_operations_fail_before_transcript_or_device_access_but_settings_remain_readable() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    settings::update(&state, 0, false, false, false).unwrap();
    let before = fs::read(state.join("settings.json")).unwrap();
    for (args, kind) in [
        (
            vec!["discover", "--agent", "claude", "--root", "/does-not-exist"],
            "TranscriptDiscoveryDisabled",
        ),
        (
            vec!["usage", "--agent", "codex", "--path", "/does-not-exist"],
            "UsageInspectionDisabled",
        ),
        (
            vec!["devices", "list", "--platform", "android"],
            "DeviceToolsDisabled",
        ),
        (
            vec![
                "devices",
                "screenshot",
                "--platform",
                "ios",
                "--id",
                "not-opened",
            ],
            "DeviceToolsDisabled",
        ),
        (
            vec!["devices", "android", "--id", "emulator-5554", "stream"],
            "DeviceToolsDisabled",
        ),
        (
            vec![
                "devices",
                "ios",
                "--id",
                "not-opened",
                "--socket",
                "/not-opened",
                "stream",
            ],
            "DeviceToolsDisabled",
        ),
    ] {
        let output = run(&state, &args);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(kind));
    }
    assert!(run(&state, &["settings", "show"]).status.success());
    assert_eq!(fs::read(state.join("settings.json")).unwrap(), before);
    let export = directory.path().join("export.jsonl");
    fs::write(
        &export,
        "{\"type\":\"user\",\"uuid\":\"u\",\"message\":{\"content\":\"Explicit selection\"}}\n",
    )
    .unwrap();
    assert!(run(
        &state,
        &[
            "transcript",
            "--agent",
            "claude",
            "--path",
            export.to_str().unwrap()
        ]
    )
    .status
    .success());
}
#[test]
fn configuration_is_strict_bounded_and_updates_require_all_typed_values() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    settings::update(&state, 0, true, true, true).unwrap();
    for value in [
        json!({"schemaVersion":2,"revision":0,"transcriptDiscoveryEnabled":true,"recordedUsageEnabled":true,"deviceToolsEnabled":true}),
        json!({"schemaVersion":1,"revision":0,"transcriptDiscoveryEnabled":"true","recordedUsageEnabled":true,"deviceToolsEnabled":true}),
        json!({"schemaVersion":1,"revision":0,"transcriptDiscoveryEnabled":true,"recordedUsageEnabled":true,"deviceToolsEnabled":true,"extra":1}),
    ] {
        fs::write(state.join("settings.json"), value.to_string()).unwrap();
        assert!(settings::read(&state).is_err());
    }
    fs::write(state.join("settings.json"), vec![b' '; 4097]).unwrap();
    assert!(settings::read(&state).is_err());
    assert!(!run(
        &state,
        &[
            "settings",
            "update",
            "--expected-revision",
            "0",
            "--recorded-usage-enabled",
            "false"
        ]
    )
    .status
    .success());
}
#[cfg(unix)]
#[test]
fn links_public_files_and_special_files_are_refused_without_changing_targets() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    settings::update(&state, 0, true, true, true).unwrap();
    let path = state.join("settings.json");
    let bytes = fs::read(&path).unwrap();
    let target = directory.path().join("target");
    fs::write(&target, &bytes).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    fs::remove_file(&path).unwrap();
    symlink(&target, &path).unwrap();
    assert!(settings::read(&state).is_err());
    assert!(settings::update(&state, 1, false, false, false).is_err());
    assert_eq!(fs::read(&target).unwrap(), bytes);
    fs::remove_file(&path).unwrap();
    fs::hard_link(&target, &path).unwrap();
    assert!(settings::read(&state).is_err());
    fs::remove_file(&path).unwrap();
    fs::write(&path, &bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(settings::read(&state).is_err());
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o644
    );
    fs::remove_file(&path).unwrap();
    let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(settings::read(&state).is_err());
    let link = directory.path().join("linked-state");
    symlink(&state, &link).unwrap();
    assert!(settings::read(&link).is_err());
    let mutable = directory.path().join("mutable");
    fs::create_dir(&mutable).unwrap();
    fs::set_permissions(&mutable, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(settings::read(&mutable.join("missing")).is_err());
    assert!(settings::update(&mutable.join("new"), 0, true, true, true).is_err());
}
