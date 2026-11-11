//! The hidden developer launcher for the host browser prototype (docs/host-browser.md, "Prototype").
#![cfg(unix)]
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
#[path = "support/binary.rs"]
mod binary;

fn launcher(extra: &[&str], enable: bool) -> Command {
    let mut command = Command::new(binary::path());
    command
        .arg("host-browser")
        .args(extra)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if enable {
        command.env("LAZYSH_DEV_HOST_BROWSER", "1");
    } else {
        command.env_remove("LAZYSH_DEV_HOST_BROWSER");
    }
    command
}

/// A stand-in browser: records its arguments, reports a fixed port like Chromium does, and keeps a helper
/// process alive so the test can prove the whole process group is stopped.
fn fake_browser(directory: &Path) -> PathBuf {
    let path = directory.join("fake-browser");
    fs::write(
        &path,
        r#"#!/bin/sh
for arg in "$@"; do
  case "$arg" in --user-data-dir=*) profile=${arg#--user-data-dir=};; esac
done
printf '%s\n' "$@" > "$FAKE_BROWSER_DIR/args"
sleep 600 &
echo $! > "$FAKE_BROWSER_DIR/helper"
printf '4242\n/devtools/browser/fake-id\n' > "$profile/DevToolsActivePort"
wait
"#,
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn first_line(child: &mut Child) -> Value {
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    serde_json::from_str(&line).unwrap_or_else(|_| panic!("not JSON: {line:?}"))
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn wait_gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(pid), "process {pid} survived the launcher");
}

#[test]
fn refuses_to_start_without_the_developer_flag() {
    let directory = tempfile::tempdir().unwrap();
    let fake = fake_browser(directory.path());
    let output = launcher(&["--binary", fake.to_str().unwrap()], false)
        .env("FAKE_BROWSER_DIR", directory.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("HostBrowserDisabled"));
    assert!(
        !directory.path().join("args").exists(),
        "a browser was started"
    );
}

#[test]
fn rejects_other_first_pages_and_option_lookalikes_before_starting_anything() {
    let directory = tempfile::tempdir().unwrap();
    let fake = fake_browser(directory.path());
    for url in [
        "file:///etc/passwd",
        "chrome://settings",
        "javascript:alert(1)",
        "--no-sandbox",
    ] {
        let output = launcher(&["--binary", fake.to_str().unwrap(), "--url", url], true)
            .env("FAKE_BROWSER_DIR", directory.path())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{url}");
    }
    assert!(
        !directory.path().join("args").exists(),
        "a browser was started"
    );
}

#[test]
fn rejects_wildcard_and_list_origins_before_starting_anything() {
    let directory = tempfile::tempdir().unwrap();
    let fake = fake_browser(directory.path());
    for origin in [
        "*",
        "http://*",
        "http://a.example,http://b.example",
        "http://a.example/x",
    ] {
        let output = launcher(
            &["--binary", fake.to_str().unwrap(), "--allow-origin", origin],
            true,
        )
        .env("FAKE_BROWSER_DIR", directory.path())
        .output()
        .unwrap();
        assert!(!output.status.success(), "{origin}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("BrowserOriginInvalid"));
    }
    assert!(
        !directory.path().join("args").exists(),
        "a browser was started"
    );
}

#[test]
fn reports_the_endpoint_and_removes_browser_helpers_and_profile_when_input_closes() {
    let directory = tempfile::tempdir().unwrap();
    let fake = fake_browser(directory.path());
    let mut child = launcher(
        &[
            "--binary",
            fake.to_str().unwrap(),
            "--allow-origin",
            "http://127.0.0.1:1420",
            "--url",
            "http://127.0.0.1:3000/start",
            "--no-sandbox",
        ],
        true,
    )
    .env("FAKE_BROWSER_DIR", directory.path())
    .spawn()
    .unwrap();
    let report = first_line(&mut child);
    assert_eq!(report["schemaVersion"], 1);
    assert_eq!(report["port"], 4242);
    assert_eq!(report["path"], "/devtools/browser/fake-id");
    let profile = PathBuf::from(report["profile"].as_str().unwrap());
    let browser = report["pid"].as_u64().unwrap() as u32;
    let helper: u32 = fs::read_to_string(directory.path().join("helper"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
        0o700,
        "the profile must be private"
    );
    let args = fs::read_to_string(directory.path().join("args")).unwrap();
    for expected in [
        "--remote-debugging-port=0",
        "--headless=new",
        "--no-sandbox",
        "--remote-allow-origins=http://127.0.0.1:1420",
        "http://127.0.0.1:3000/start",
    ] {
        assert!(
            args.lines().any(|arg| arg == expected),
            "missing {expected}: {args}"
        );
    }
    assert!(args.contains(&format!("--user-data-dir={}", profile.display())));

    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    wait_gone(browser);
    wait_gone(helper);
    assert!(!profile.exists(), "the profile outlived the launcher");
}

/// The real browser: skipped, with a message, on a host that has none of the supported binaries.
#[test]
fn real_browser_serves_loopback_devtools_and_leaves_nothing_behind() {
    let Some(binary) = [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
    ]
    .iter()
    .find_map(|name| {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    }) else {
        eprintln!("skipped: no Chrome or Chromium on PATH");
        return;
    };
    let mut child = launcher(
        &["--binary", binary.to_str().unwrap(), "--no-sandbox"],
        true,
    )
    .spawn()
    .unwrap();
    let report = first_line(&mut child);
    let port = report["port"].as_u64().unwrap() as u16;
    let profile = PathBuf::from(report["profile"].as_str().unwrap());
    let browser = report["pid"].as_u64().unwrap() as u32;

    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stream,
        "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    // Chromium keeps the connection open, so read until the browser path arrives instead of until EOF.
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut response = String::new();
    let mut chunk = [0u8; 2048];
    while !response.contains(report["path"].as_str().unwrap()) {
        let read = stream.read(&mut chunk).expect("DevTools did not answer");
        assert!(read > 0, "closed early: {response}");
        response.push_str(&String::from_utf8_lossy(&chunk[..read]));
    }
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    wait_gone(browser);
    assert!(!profile.exists(), "the profile outlived the launcher");
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_err(),
        "the debug port stayed open"
    );
}
