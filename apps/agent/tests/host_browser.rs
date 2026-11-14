//! The hidden developer launcher for the host browser prototype (docs/host-browser.md, "Prototype").
#![cfg(unix)]
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};
#[path = "support/binary.rs"]
mod binary;

fn agent(state: &Path) -> Command {
    let mut command = Command::new(binary::path());
    command.env("LAZYSH_STATE_DIR", state);
    command
}

/// Change the host browser switch, as the app does through the settings command.
fn switch(state: &Path, revision: &str, enabled: &str) {
    let output = agent(state)
        .args(["settings", "host-browser", "update"])
        .args([
            "--expected-revision",
            revision,
            "--host-browser-enabled",
            enabled,
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

fn enable(state: &Path) {
    switch(state, "0", "true");
}

fn launcher(state: &Path, extra: &[&str], dev_flag: bool) -> Command {
    let mut command = agent(state);
    command
        .arg("host-browser")
        .args(extra)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if dev_flag {
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
printf 'session-cookie' > "$profile/Cookies"
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

/// A temporary companion state directory and a fake browser beside it; the switch is off until `enabled`.
struct Fixture {
    directory: tempfile::TempDir,
    state: PathBuf,
    fake: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        Self {
            state: directory.path().join("state"),
            fake: fake_browser(directory.path()),
            directory,
        }
    }
    fn enabled() -> Self {
        let fixture = Self::new();
        enable(&fixture.state);
        fixture
    }
    /// The launcher over the fake browser with the developer flag on.
    fn launch(&self, extra: &[&str]) -> Command {
        let binary = ["--binary", self.fake.to_str().unwrap()];
        let mut command = launcher(&self.state, &[&binary[..], extra].concat(), true);
        command.env("FAKE_BROWSER_DIR", self.directory.path());
        command
    }
    fn spawn(&self, extra: &[&str]) -> Child {
        self.launch(extra).spawn().unwrap()
    }
    /// What the fake browser recorded; absent when no browser was ever started.
    fn recorded(&self, name: &str) -> Option<String> {
        fs::read_to_string(self.directory.path().join(name)).ok()
    }
    fn helper(&self) -> u32 {
        self.recorded("helper").unwrap().trim().parse().unwrap()
    }
    fn markers(&self) -> usize {
        fs::read_dir(self.state.join("host-browser"))
            .unwrap()
            .count()
    }
}

fn first_line(child: &mut Child) -> Value {
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    if line.is_empty() {
        // The launcher gave up: show why, instead of a bare parse error.
        let mut diagnostics = String::new();
        let _ = child
            .stderr
            .as_mut()
            .unwrap()
            .read_to_string(&mut diagnostics);
        panic!("launcher printed nothing; stderr: {diagnostics}");
    }
    serde_json::from_str(&line).unwrap_or_else(|_| panic!("not JSON: {line:?}"))
}

fn profile_of(report: &Value) -> PathBuf {
    PathBuf::from(report["profile"].as_str().unwrap())
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

fn stop(mut child: Child) {
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}

fn failure(output: &Output) -> String {
    assert!(!output.status.success(), "{output:?}");
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn clear_data(state: &Path) -> Output {
    agent(state)
        .args(["host-browser", "--clear-data"])
        .output()
        .unwrap()
}

fn cleared(output: &Output) -> bool {
    serde_json::from_slice::<Value>(&output.stdout).unwrap()["cleared"] == true
}

/// Everything a launcher run left in the state directory, as text, so a leak shows as a missing needle.
fn state_text(state: &Path) -> String {
    fn walk(path: &Path, text: &mut String) {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            text.push_str(&entry.file_name().to_string_lossy());
            if entry.path().is_dir() {
                walk(&entry.path(), text);
            } else if let Ok(bytes) = fs::read(entry.path()) {
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
    }
    let mut text = String::new();
    walk(state, &mut text);
    text
}

#[test]
fn a_switch_that_is_off_or_unreadable_fails_before_anything_starts() {
    let fixture = Fixture::new();
    let root = fixture.directory.path();
    let explicit = root.join("explicit");
    let malformed = root.join("malformed");
    for state in [&explicit, &malformed] {
        fs::create_dir(state).unwrap();
        fs::set_permissions(state, fs::Permissions::from_mode(0o700)).unwrap();
    }
    switch(&explicit, "0", "false");
    let file = malformed.join("host-browser.json");
    fs::write(&file, r#"{"hostBrowserEnabled":true,"x":1}"#).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    // The developer flag is on in every case: the switch alone must refuse.
    for (state, reason) in [
        (&fixture.state, "HostBrowserDisabled"),
        (&explicit, "HostBrowserDisabled"),
        (&malformed, "InvalidArgument"),
    ] {
        let binary = ["--binary", fixture.fake.to_str().unwrap()];
        let mut command = launcher(state, &binary, true);
        let output = command.env("FAKE_BROWSER_DIR", root).output().unwrap();
        assert!(failure(&output).contains(reason), "{output:?}");
        assert!(fixture.recorded("args").is_none(), "a browser was started");
        assert!(!state.join("host-browser").exists(), "a profile was made");
    }
    assert!(!fixture.state.exists(), "the gate created state");
}

#[test]
fn refuses_to_start_without_the_developer_flag() {
    let fixture = Fixture::enabled();
    let binary = ["--binary", fixture.fake.to_str().unwrap()];
    let output = launcher(&fixture.state, &binary, false)
        .env("FAKE_BROWSER_DIR", fixture.directory.path())
        .output()
        .unwrap();
    assert!(failure(&output).contains("HostBrowserDevFlagOff"));
    assert!(fixture.recorded("args").is_none(), "a browser was started");
}

#[test]
fn rejects_other_first_pages_and_option_lookalikes_before_starting_anything() {
    let fixture = Fixture::enabled();
    for url in [
        "file:///etc/passwd",
        "chrome://settings",
        "javascript:alert(1)",
        "--no-sandbox",
    ] {
        failure(&fixture.launch(&["--url", url]).output().unwrap());
    }
    assert!(fixture.recorded("args").is_none(), "a browser was started");
}

#[test]
fn rejects_wildcard_and_list_origins_before_starting_anything() {
    let fixture = Fixture::enabled();
    for origin in [
        "*",
        "http://*",
        "http://a.example,http://b.example",
        "http://a.example/x",
    ] {
        let output = fixture
            .launch(&["--allow-origin", origin])
            .output()
            .unwrap();
        assert!(failure(&output).contains("BrowserOriginInvalid"));
    }
    assert!(fixture.recorded("args").is_none(), "a browser was started");
}

#[test]
fn reports_the_endpoint_and_removes_browser_helpers_and_profile_when_input_closes() {
    let fixture = Fixture::enabled();
    let mut child = fixture.spawn(&[
        "--allow-origin",
        "http://127.0.0.1:1420",
        "--url",
        "http://127.0.0.1:3000/start",
        "--no-sandbox",
    ]);
    let report = first_line(&mut child);
    assert_eq!(report["schemaVersion"], 1);
    assert_eq!(report["port"], 4242);
    assert_eq!(report["path"], "/devtools/browser/fake-id");
    let profile = profile_of(&report);
    let browser = report["pid"].as_u64().unwrap() as u32;
    let helper = fixture.helper();
    assert!(
        profile.starts_with(fixture.state.join("host-browser")),
        "{profile:?}"
    );
    assert_eq!(
        fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
        0o700,
        "the profile must be private"
    );
    let args = fixture.recorded("args").unwrap();
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

    stop(child);
    wait_gone(browser);
    wait_gone(helper);
    assert!(!profile.exists(), "the profile outlived the launcher");
    assert_eq!(fixture.markers(), 0, "a marker outlived the launcher");
}

/// An SSH drop ends the channel: the host delivers SIGHUP or SIGTERM as well as closing standard input.
#[test]
fn signals_stop_the_browser_and_remove_the_profile() {
    for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
        let fixture = Fixture::enabled();
        let mut child = fixture.spawn(&[]);
        let report = first_line(&mut child);
        // SAFETY: the pid is the launcher this test spawned.
        unsafe { libc::kill(child.id() as i32, signal) };
        assert!(child.wait().unwrap().success(), "signal {signal}");
        wait_gone(report["pid"].as_u64().unwrap() as u32);
        assert!(
            !profile_of(&report).exists(),
            "signal {signal} left the profile"
        );
    }
}

/// A launcher killed outright cannot clean up. The browser must still die (Linux) and the next start removes
/// the profile it left, matched by the dead launcher's pid.
#[test]
fn a_crashed_launcher_leaves_a_profile_that_the_next_start_removes() {
    let fixture = Fixture::enabled();
    let mut crashed = fixture.spawn(&[]);
    let report = first_line(&mut crashed);
    let orphan = profile_of(&report);
    let helper = fixture.helper();
    // SAFETY: the pid is the launcher this test spawned.
    unsafe { libc::kill(crashed.id() as i32, libc::SIGKILL) };
    let _ = crashed.wait();
    assert!(orphan.exists(), "a SIGKILL cannot have cleaned up");
    #[cfg(target_os = "linux")]
    wait_gone(report["pid"].as_u64().unwrap() as u32);
    // The fake's helper does not watch its parent as a real browser's do; stop it so the test leaves nothing.
    unsafe { libc::kill(helper as i32, libc::SIGKILL) };

    let mut next = fixture.spawn(&[]);
    let fresh = profile_of(&first_line(&mut next));
    assert!(
        !orphan.exists(),
        "the crashed launcher's profile survived the next start"
    );
    assert!(fresh.exists());
    stop(next);
    assert_eq!(fixture.markers(), 0);
}

#[test]
fn keep_profile_survives_the_session_until_browser_data_is_cleared() {
    let fixture = Fixture::enabled();
    let mut first = fixture.spawn(&["--keep-profile"]);
    let profile = profile_of(&first_line(&mut first));
    // One kept profile cannot be shared by two running browsers, and clearing must not pull it from under one.
    let second = fixture.launch(&["--keep-profile"]).output().unwrap();
    assert!(failure(&second).contains("BrowserProfileInUse"));
    assert!(failure(&clear_data(&fixture.state)).contains("BrowserProfileInUse"));
    assert!(
        profile.join("Cookies").exists(),
        "clearing touched a profile in use"
    );
    stop(first);

    assert_eq!(
        fs::read_to_string(profile.join("Cookies")).unwrap(),
        "session-cookie"
    );
    assert_eq!(
        fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let mut again = fixture.spawn(&["--keep-profile"]);
    assert_eq!(profile_of(&first_line(&mut again)), profile);
    stop(again);

    // Clearing works with the switch off: a user who turned the feature off can still remove what it kept.
    switch(&fixture.state, "1", "false");
    assert!(cleared(&clear_data(&fixture.state)));
    assert!(!profile.exists(), "Clear browser data left the profile");
    assert!(!cleared(&clear_data(&fixture.state)));
}

#[test]
fn clearing_browser_data_creates_no_state() {
    let fixture = Fixture::new();
    assert!(!cleared(&clear_data(&fixture.state)));
    assert!(!fixture.state.exists());
}

/// No page address reaches the launcher's output or the companion's state: the browser holds it, nothing else.
#[test]
fn the_page_address_is_never_written_by_the_launcher() {
    let fixture = Fixture::enabled();
    let secret = "http://internal.example.test/reset?token=s3cr3t-token";
    let mut child = fixture.spawn(&["--keep-profile", "--url", secret]);
    let report = first_line(&mut child);
    assert!(!report.to_string().contains("s3cr3t"));
    drop(child.stdin.take());
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(child.wait().unwrap().success());
    assert!(!stderr.contains("s3cr3t"), "{stderr}");
    let kept = state_text(&fixture.state);
    assert!(
        !kept.contains("s3cr3t") && !kept.contains("internal.example"),
        "{kept}"
    );
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
    let fixture = Fixture::enabled();
    let mut child = launcher(
        &fixture.state,
        &["--binary", binary.to_str().unwrap(), "--no-sandbox"],
        true,
    )
    .spawn()
    .unwrap();
    let report = first_line(&mut child);
    let port = report["port"].as_u64().unwrap() as u16;
    let profile = profile_of(&report);
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

    stop(child);
    wait_gone(browser);
    assert!(!profile.exists(), "the profile outlived the launcher");
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_err(),
        "the debug port stayed open"
    );
}
