// The fake SDK tools are Unix shell scripts, so the Windows build does not use them.
#![cfg_attr(not(unix), allow(dead_code))]
use lazysh_agent::{host_features, settings};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
#[path = "support/binary.rs"]
mod binary;

/// What an older companion reads out of `settings.json`: every field, and nothing it does not know.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct OlderSettings {
    schema_version: u8,
    revision: u64,
    transcript_discovery_enabled: bool,
    recorded_usage_enabled: bool,
    device_tools_enabled: bool,
}

/// Fake Android, iOS and ffmpeg tools that log every invocation, so a refusal can be shown to dispatch nothing.
struct Sdk {
    log: PathBuf,
    path: PathBuf,
    android_home: PathBuf,
}
impl Sdk {
    #[cfg(unix)]
    fn new(root: &Path) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let (bin, platform_tools) = (root.join("bin"), root.join("sdk/platform-tools"));
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&platform_tools).unwrap();
        let png = root.join("screen.png");
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbaImage::new(1, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        fs::write(&png, bytes.into_inner()).unwrap();
        let log = root.join("sdk.log");
        let script = format!(
            "#!/bin/sh\necho \"$0 $@\" >> '{}'\ncase \"$*\" in *screencap*) exec /bin/cat '{}';; esac\n",
            log.display(),
            png.display()
        );
        for tool in [
            bin.join("idb"),
            bin.join("ffmpeg"),
            platform_tools.join("adb"),
        ] {
            fs::write(&tool, &script).unwrap();
            fs::set_permissions(&tool, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            log,
            path: bin,
            android_home: root.join("sdk"),
        }
    }
    fn calls(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }
}

fn run(state: &Path, sdk: Option<&Sdk>, args: &[&str]) -> Output {
    let mut command = Command::new(binary::path());
    command
        .args(args)
        .env("LAZYSH_STATE_DIR", state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match sdk {
        Some(sdk) => command
            .env("PATH", &sdk.path)
            .env("ANDROID_HOME", &sdk.android_home),
        None => command.env("PATH", state.join("no-sdk")),
    };
    let mut child = command.spawn().unwrap();
    // A stream treats the end of its input as a cancellation, so the input stays open until it exits.
    let _input = child.stdin.take();
    child.wait_with_output().unwrap()
}
fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}
fn features_update(state: &Path, revision: &str, streaming: &str, scan: &str) -> Output {
    run(
        state,
        None,
        &[
            "settings",
            "features",
            "update",
            "--expected-revision",
            revision,
            "--simulator-streaming-enabled",
            streaming,
            "--port-scan-enabled",
            scan,
        ],
    )
}

#[test]
fn absent_features_report_both_enabled_and_create_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("missing");
    let output = run(&state, None, &["settings", "features", "show"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"schemaVersion":1,"revision":0,"simulatorStreamingEnabled":true,"portScanEnabled":true})
    );
    assert!(!state.exists());
    assert_eq!(
        host_features::read(&state).unwrap(),
        host_features::HostFeatures::default()
    );
    assert!(!state.exists());
}

#[test]
fn update_bumps_the_revision_once_and_refuses_a_stale_one() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let first = features_update(&state, "0", "false", "true");
    assert!(first.status.success(), "{}", stderr(&first));
    let first: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(
        first,
        json!({"schemaVersion":1,"revision":1,"simulatorStreamingEnabled":false,"portScanEnabled":true})
    );
    let stale = features_update(&state, "0", "true", "false");
    assert!(!stale.status.success());
    assert!(stderr(&stale).contains("SettingsConflict"));
    let shown = run(&state, None, &["settings", "features", "show"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&shown.stdout).unwrap(),
        first
    );
    let second = features_update(&state, "1", "true", "false");
    assert_eq!(
        serde_json::from_slice::<Value>(&second.stdout).unwrap()["revision"],
        2
    );
    // Both flags are required: a missing one must not silently keep or reset the other.
    assert!(!run(
        &state,
        None,
        &[
            "settings",
            "features",
            "update",
            "--expected-revision",
            "2",
            "--port-scan-enabled",
            "true"
        ]
    )
    .status
    .success());
    assert_eq!(host_features::read(&state).unwrap().revision, 2);
}

#[test]
fn an_older_companion_keeps_reading_settings_after_the_feature_file_exists() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    settings::update(&state, 0, true, false, true).unwrap();
    let before = fs::read(state.join("settings.json")).unwrap();
    assert!(features_update(&state, "0", "false", "false")
        .status
        .success());
    assert!(state.join("host-features.json").is_file());
    assert_eq!(fs::read(state.join("settings.json")).unwrap(), before);
    let older: OlderSettings = serde_json::from_slice(&before).unwrap();
    assert_eq!((older.revision, older.recorded_usage_enabled), (1, false));
    // A new settings write keeps the five fields an older companion accepts.
    let updated = run(
        &state,
        None,
        &[
            "settings",
            "update",
            "--expected-revision",
            "1",
            "--transcript-discovery-enabled",
            "true",
            "--recorded-usage-enabled",
            "true",
            "--device-tools-enabled",
            "true",
        ],
    );
    assert!(updated.status.success(), "{}", stderr(&updated));
    let written = fs::read(state.join("settings.json")).unwrap();
    assert_eq!(
        serde_json::from_slice::<OlderSettings>(&written)
            .unwrap()
            .revision,
        2
    );
    assert_eq!(
        host_features::read(&state).unwrap().revision,
        1,
        "settings writes must not touch the feature file"
    );
}

#[test]
fn a_feature_file_that_is_not_strict_is_refused_and_fails_streams_closed() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    host_features::update(&state, 0, true, true).unwrap();
    for value in [
        json!({"schemaVersion":2,"revision":0,"simulatorStreamingEnabled":true,"portScanEnabled":true}),
        json!({"schemaVersion":1,"revision":0,"simulatorStreamingEnabled":"true","portScanEnabled":true}),
        json!({"schemaVersion":1,"revision":0,"simulatorStreamingEnabled":true,"portScanEnabled":true,"extra":1}),
    ] {
        fs::write(state.join("host-features.json"), value.to_string()).unwrap();
        assert!(host_features::read(&state).is_err());
        let output = run(
            &state,
            None,
            &["devices", "android", "--id", "emulator-5554", "stream"],
        );
        assert!(!output.status.success());
        assert!(stderr(&output).contains("InvalidArgument"));
    }
    fs::write(state.join("host-features.json"), vec![b' '; 4097]).unwrap();
    assert!(host_features::read(&state).is_err());
    assert!(host_features::update(&state, 0, true, true).is_err());
}

#[cfg(unix)]
#[test]
fn disabled_streaming_refuses_both_streams_before_any_sdk_process_and_leaves_other_device_operations(
) {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let sdk = Sdk::new(directory.path());
    assert!(features_update(&state, "0", "false", "true")
        .status
        .success());
    for args in [
        vec!["devices", "android", "--id", "emulator-5554", "stream"],
        vec![
            "devices",
            "ios",
            "--id",
            "01234567-89ab-cdef-0123-456789abcdef",
            "--socket",
            "/not-opened",
            "stream",
        ],
    ] {
        let output = run(&state, Some(&sdk), &args);
        assert!(!output.status.success());
        assert!(stderr(&output).contains("SimulatorStreamingDisabled"));
    }
    assert_eq!(
        sdk.calls(),
        "",
        "a refused stream must start no SDK process"
    );

    let screenshot = run(
        &state,
        Some(&sdk),
        &[
            "devices",
            "screenshot",
            "--platform",
            "android",
            "--id",
            "emulator-5554",
        ],
    );
    assert!(screenshot.status.success(), "{}", stderr(&screenshot));
    let frame: Value = serde_json::from_slice(&screenshot.stdout).unwrap();
    assert_eq!(
        (frame["width"].clone(), frame["height"].clone()),
        (json!(1), json!(1))
    );
    assert!(sdk.calls().contains("exec-out screencap -p"));
    assert!(run(
        &state,
        Some(&sdk),
        &["devices", "list", "--platform", "android"]
    )
    .status
    .success());

    // Streaming is a second condition, not a replacement: device tools off still wins.
    host_features::update(&state, 1, true, true).unwrap();
    settings::update(&state, 0, true, true, false).unwrap();
    let output = run(
        &state,
        Some(&sdk),
        &["devices", "android", "--id", "emulator-5554", "stream"],
    );
    assert!(stderr(&output).contains("DeviceToolsDisabled"));
}

#[cfg(unix)]
#[test]
fn enabled_streaming_reaches_the_sdk() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let sdk = Sdk::new(directory.path());
    host_features::update(&state, 0, true, false).unwrap();
    let output = run(
        &state,
        Some(&sdk),
        &["devices", "android", "--id", "emulator-5554", "stream"],
    );
    assert!(sdk.calls().contains("features"), "the SDK must be reached");
    assert!(!stderr(&output).contains("SimulatorStreamingDisabled"));
}
