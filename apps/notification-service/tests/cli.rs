#[cfg(unix)]
#[test]
fn keygen_is_private_no_overwrite_and_stdout_and_errors_never_contain_capabilities() {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().join("private capability");
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_lazysh-notifications"))
            .arg("keygen")
            .arg("--output")
            .arg(&path)
            .output()
            .unwrap()
    };
    let first = run();
    assert!(first.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&first.stdout).unwrap(),
        serde_json::json!({"created":true})
    );
    let key = std::fs::read(&path).unwrap();
    assert_eq!(key.len(), 64);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let second = run();
    assert!(!second.status.success());
    assert_eq!(std::fs::read(path).unwrap(), key);
    for output in [&first, &second] {
        for bytes in [&output.stdout, &output.stderr] {
            assert!(!bytes.windows(key.len()).any(|s| s == key));
        }
    }
}

#[cfg(unix)]
#[test]
fn relative_capability_filename_completes_in_private_working_directory() {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-notifications"))
        .current_dir(directory.path())
        .args(["keygen", "--output", "key"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read(directory.path().join("key")).unwrap().len(),
        64
    );
}

#[cfg(unix)]
#[test]
fn push_event_format_is_explicit_private_and_defaults_to_legacy() {
    use lazysh_notifications::push::{EventFormat, PushConfig};
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    for (index, format) in [
        None,
        Some("legacy"),
        Some("bound-v2"),
        Some("unknown-format"),
    ]
    .into_iter()
    .enumerate()
    {
        let path = directory.path().join(format!("push-{index}.json"));
        let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-notifications"));
        command
            .args(["push-config-generate", "--output"])
            .arg(&path)
            .args([
                "--push-origin",
                "https://push.example:8443",
                "--address",
                "127.0.0.1",
                "--contact",
                "mailto:operator@example.invalid",
            ]);
        if let Some(value) = format {
            command.args(["--event-format", value]);
        }
        let output = command.output().unwrap();
        if format == Some("unknown-format") {
            assert!(!output.status.success());
            assert!(!path.exists());
            continue;
        }
        assert!(output.status.success());
        let config = PushConfig::read(&path).unwrap();
        assert_eq!(
            config.event_format(),
            if format == Some("bound-v2") {
                EventFormat::BoundV2
            } else {
                EventFormat::Legacy
            }
        );
        let settings: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            settings.get("eventFormat").is_some(),
            format == Some("bound-v2")
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let public: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(public["created"], true);
        assert_eq!(public["publicVapidKey"], config.public_key());
        assert_eq!(public.as_object().unwrap().len(), 2);
        let private = settings["privateVapid"].as_str().unwrap().as_bytes();
        for bytes in [&output.stdout, &output.stderr] {
            assert!(!bytes.windows(private.len()).any(|chunk| chunk == private));
        }
    }
}
