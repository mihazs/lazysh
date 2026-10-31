//! Owned HTTP fixture: no user sign-in or credential store is read.
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    time::{Duration, Instant},
};
#[path = "support/binary.rs"]
mod binary;
fn owned_command(directory: &std::path::Path, tools: &std::path::Path) -> Command {
    let mut command = Command::new(binary::path());
    command
        .arg("account-usage")
        .env_clear()
        .env("HOME", directory)
        .env("USERPROFILE", directory)
        .env("XDG_CONFIG_HOME", directory.join("config"))
        .env("XDG_CACHE_HOME", directory.join("cache"))
        .env("PATH", tools);
    command
}
#[test]
#[cfg(unix)]
fn missing_external_cli_uses_builtin_collectors_without_exposing_authentication() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("config/lazysh");
    fs::create_dir_all(&config).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let stop = Instant::now() + Duration::from_secs(10);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = [0; 8192];
                    let count = stream.read(&mut request).unwrap();
                    let request = String::from_utf8_lossy(&request[..count]);
                    assert!(request
                        .to_ascii_lowercase()
                        .contains("authorization: bearer fixture-secret-never-wire"));
                    let body = r#"{"used":42,"limit":100,"balance":12.3,"reset":"2026-11-01T00:00:00Z","private":"not-for-the-phone"}"#;
                    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < stop,
                        "fixture did not receive builtin request"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("{error}"),
            }
        }
    });
    let path = config.join("account-usage.toml");
    fs::write(
        &path,
        format!(
            r#"[anthropic]
enabled=false
[openai]
enabled=false
[zai]
enabled=false
[openrouter]
enabled=false
[[custom]]
id="owned-fixture"
name="Owned quota fixture"
short_name="own"
enabled=true
url="http://{address}/quota"
allow_http=true
api_key="fixture-secret-never-wire"
[[custom.metrics]]
label="Requests"
used="/used"
limit="/limit"
resets_at="/reset"
window_secs=86400
[[custom.texts]]
label="Balance"
value="/balance"
currency="USD"
"#
        ),
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let output = owned_command(directory.path(), &directory.path().join("no-external-cli"))
        .output()
        .unwrap();
    assert!(output.status.success(), "bounded companion query failed");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["source"], "builtin");
    assert_eq!(report["state"], "ready");
    let entry = &report["report"]["entries"][0];
    assert_eq!(entry["rows"][0]["percent"], 42.0);
    assert_eq!(entry["rows"][1]["label"], "Balance");
    let serialized = String::from_utf8(output.stdout).unwrap();
    assert!(!serialized.contains("fixture-secret-never-wire"));
    assert!(!serialized.contains("not-for-the-phone"));
    assert!(output.stderr.is_empty());
    server.join().unwrap();
}

#[cfg(unix)]
#[test]
fn only_a_private_context_free_notification_free_profile_can_start_external_cli() {
    use std::os::unix::fs::PermissionsExt;
    for (profile, settings, inline, permissions, external) in [
        (
            "context",
            "[context]\nenabled=true\n[notifications]\nenabled=false\n",
            false,
            0o600,
            false,
        ),
        (
            "notifications",
            "[notifications]\nenabled=true\n",
            false,
            0o600,
            false,
        ),
        (
            "insecure",
            "[notifications]\nenabled=false\n",
            true,
            0o644,
            false,
        ),
        (
            "safe",
            "[context]\nenabled=false\n[notifications]\nenabled=false\n",
            false,
            0o600,
            true,
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config/lazysh");
        let tools = directory.path().join("tools");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir(&tools).unwrap();
        let path = config.join("account-usage.toml");
        let text=format!("[anthropic]\nenabled=false\n[openai]\nenabled=false\n[openrouter]\nenabled=false\n[zai]\nenabled=false\n{}{settings}",if inline {"api_key=\"owned-inline-fixture\"\n"}else{""});
        fs::write(&path, &text).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(permissions)).unwrap();
        let executable = tools.join("ai-usagebar");
        fs::write(&executable,"#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$OWNED_USAGE_ARGV\"\nprintf '%s' '{\"schema_version\":1,\"entries\":[]}'\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let marker = directory.path().join("argv");
        let output = owned_command(directory.path(), &tools)
            .env("OWNED_USAGE_ARGV", &marker)
            .output()
            .unwrap();
        assert!(output.status.success(), "{profile}");
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            response["source"],
            if external { "external_cli" } else { "builtin" },
            "{profile}"
        );
        assert_eq!(marker.exists(), external, "{profile}");
        if external {
            assert_eq!(
                fs::read_to_string(&marker)
                    .unwrap()
                    .lines()
                    .collect::<Vec<_>>(),
                vec!["--config", path.to_str().unwrap(), "usage", "--json"]
            );
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            permissions
        );
    }
}
