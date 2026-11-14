//! The host browser relay, `lazysh-agent host-browser serve` (docs/host-browser.md, "Relay wire format"), driven
//! through its real standard input and output over a fake browser on the DevTools pipe and, where the host has
//! one, a real Chrome or Chromium.
#![cfg(unix)]
use lazysh_agent::host_browser::{allow, wire};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
#[path = "support/binary.rs"]
mod binary;
#[path = "support/host_browser.rs"]
mod support;
use support::{
    agent, assert_nothing_started, chrome, enable, refusing_states, state_text, wait_gone,
};

const FAKE: &str = include_str!("support/fake_chrome_pipe.py");
const WAIT: Duration = Duration::from_secs(20);
const QUIET: Duration = Duration::from_millis(500);

/// A message from the relay, decoded the way a client does.
#[derive(Debug)]
enum Message {
    Json(Value),
    Frame {
        sequence: u32,
        width: u16,
        height: u16,
        scroll_y: f32,
        jpeg: Vec<u8>,
    },
}
impl Message {
    fn kind(&self) -> &str {
        match self {
            Self::Json(value) => value["type"].as_str().unwrap_or("?"),
            Self::Frame { .. } => "frame",
        }
    }
}

/// One relay process and its two ends of the channel.
struct Relay {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Message>,
}
impl Relay {
    fn start(state: &Path, envs: &[(&str, &Path)], options: &[&str]) -> Self {
        let mut child = agent(state)
            .envs(envs.iter().copied())
            .args(["host-browser", "serve"])
            .args(options)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (sender, output) = mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(Some((tag, body))) = wire::read(&mut stdout, wire::MAX_JPEG + 64) {
                let message = if tag == wire::JSON {
                    Message::Json(serde_json::from_slice(&body).unwrap())
                } else {
                    assert_eq!(tag, wire::FRAME);
                    Message::Frame {
                        sequence: u32::from_be_bytes(body[0..4].try_into().unwrap()),
                        width: u16::from_be_bytes(body[4..6].try_into().unwrap()),
                        height: u16::from_be_bytes(body[6..8].try_into().unwrap()),
                        scroll_y: f32::from_be_bytes(body[8..12].try_into().unwrap()),
                        jpeg: body[20..].to_vec(),
                    }
                };
                if sender.send(message).is_err() {
                    return;
                }
            }
        });
        Self {
            input: child.stdin.take(),
            child,
            output,
        }
    }

    fn send_bytes(&mut self, bytes: &[u8]) {
        let input = self.input.as_mut().unwrap();
        input.write_all(bytes).unwrap();
        input.flush().unwrap();
    }
    fn send(&mut self, value: Value) {
        let body = value.to_string();
        let mut bytes = (body.len() as u32 + 1).to_be_bytes().to_vec();
        bytes.push(wire::JSON);
        bytes.extend_from_slice(body.as_bytes());
        self.send_bytes(&bytes);
    }
    fn open(&mut self, url: &str) {
        self.send(json!({"type": "open", "viewport": {"width": 412, "height": 915}, "url": url}));
    }

    fn within(&self, wait: Duration) -> Option<Message> {
        self.output.recv_timeout(wait).ok()
    }
    /// The next message of `kind`, skipping the others; what was skipped is shown when it never comes.
    fn next(&self, kind: &str) -> Message {
        let mut skipped = Vec::new();
        let deadline = Instant::now() + WAIT;
        while let Some(message) = self.within(deadline.saturating_duration_since(Instant::now())) {
            if message.kind() == kind {
                return message;
            }
            skipped.push(message.kind().to_string());
        }
        panic!("no {kind} message; saw {skipped:?}");
    }
    fn next_json(&self, kind: &str) -> Value {
        match self.next(kind) {
            Message::Json(value) => value,
            Message::Frame { .. } => unreachable!(),
        }
    }
    fn next_frame(&self) -> (u32, Vec<u8>) {
        match self.next("frame") {
            Message::Frame { sequence, jpeg, .. } => (sequence, jpeg),
            Message::Json(_) => unreachable!(),
        }
    }
    /// Whether anything but page information arrives within `wait`.
    fn quiet(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        while let Some(message) = self.within(deadline.saturating_duration_since(Instant::now())) {
            if message.kind() != "page" {
                return false;
            }
        }
        true
    }

    fn close_input(&mut self) {
        drop(self.input.take());
    }
    fn exit(&mut self) -> std::process::ExitStatus {
        self.child.wait().unwrap()
    }
    fn stop(mut self) {
        self.close_input();
        assert!(self.exit().success());
    }
    fn signal(&self, signal: i32) {
        // SAFETY: the pid is the relay this test spawned.
        unsafe { libc::kill(self.child.id() as i32, signal) };
    }
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
        let fake = directory.path().join("fake-browser");
        fs::write(&fake, FAKE).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            state: directory.path().join("state"),
            fake,
            directory,
        }
    }
    fn enabled() -> Self {
        let fixture = Self::new();
        enable(&fixture.state);
        fixture
    }
    /// A relay over the fake browser, which reads its mode and reported product from its environment.
    fn serve(&self, mode: &str, product: &str) -> Relay {
        let (mode, product) = (Path::new(mode), Path::new(product));
        let envs = [
            ("FAKE_BROWSER_DIR", self.directory.path()),
            ("FAKE_MODE", mode),
            ("FAKE_PRODUCT", product),
        ];
        Relay::start(
            &self.state,
            &envs,
            &["--binary", self.fake.to_str().unwrap()],
        )
    }
    fn recorded(&self, name: &str) -> Option<String> {
        fs::read_to_string(self.directory.path().join(name)).ok()
    }
    fn pid(&self, name: &str) -> u32 {
        self.recorded(name).unwrap().trim().parse().unwrap()
    }
    /// The profile directories the relay created and has not removed.
    fn profiles(&self) -> Vec<PathBuf> {
        fs::read_dir(self.state.join("host-browser"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect()
    }
    /// Every command the fake browser received.
    fn commands(&self) -> Vec<Value> {
        self.recorded("commands")
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn methods(&self) -> Vec<String> {
        self.commands()
            .iter()
            .map(|c| c["method"].as_str().unwrap().to_string())
            .collect()
    }
    fn nothing_was_started(&self) {
        assert!(self.recorded("args").is_none(), "a browser was started");
        assert!(self.profiles().is_empty(), "a profile was created");
    }
    /// The browser, its helper, the profile and the profile's marker are all gone.
    fn nothing_is_left(&self) {
        wait_gone(self.pid("browser"));
        wait_gone(self.pid("helper"));
        assert!(self.profiles().is_empty(), "the profile outlived the relay");
        let markers = fs::read_dir(self.state.join("host-browser")).map_or(0, Iterator::count);
        assert_eq!(markers, 0, "a marker outlived the relay");
    }
}

fn closed(relay: &Relay) -> Value {
    relay.next_json("closed")
}

#[test]
fn a_switch_that_is_off_or_unreadable_starts_nothing() {
    let fixture = Fixture::new();
    let root = fixture.directory.path();
    for (state, reason) in refusing_states(root, &fixture.state) {
        let envs = [("FAKE_BROWSER_DIR", root)];
        let mut relay = Relay::start(&state, &envs, &["--binary", fixture.fake.to_str().unwrap()]);
        relay.open("about:blank");
        assert_eq!(closed(&relay)["reason"], reason);
        assert!(!relay.exit().success());
        assert_nothing_started(root, &state);
    }
    assert!(!fixture.state.exists(), "the gate created state");
}

#[test]
fn frames_flow_two_at_a_time_until_the_device_acknowledges() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve("", "Chrome/120.0.6099.109");
    relay.open("http://127.0.0.1:3000/start");
    let state = relay.next_json("state");
    assert_eq!(state["state"], "running");
    assert_eq!(state["browser"], "Chrome/120.0.6099.109");
    assert_eq!(
        state["viewport"],
        json!({"width": 412, "height": 915, "scale": 1.0})
    );
    assert_eq!(state["capabilities"]["control"], false);

    let page = relay.next_json("page");
    assert_eq!(page["title"], "Fixture page");
    assert_eq!(page["url"], "http://127.0.0.1:3000/secret-path");

    let first = match relay.next("frame") {
        Message::Frame {
            sequence,
            width,
            height,
            scroll_y,
            jpeg,
        } => {
            assert_eq!((width, height, scroll_y), (412, 915, 7.5));
            assert!(jpeg.starts_with(b"\xff\xd8fake-jpeg\xff\xd9"), "{jpeg:?}");
            sequence
        }
        Message::Json(_) => unreachable!(),
    };
    let (second, _) = relay.next_frame();
    assert!(second > first);
    assert!(relay.quiet(QUIET), "a third frame went out unacknowledged");
    relay.send(json!({"type": "ack", "sequence": first, "decodeMs": 3}));
    let (third, _) = relay.next_frame();
    assert!(third > second, "{third} after {second}");

    // The browser was started as specified: a pipe, no socket, no origin widening, the page as an argument.
    let args = fixture.recorded("args").unwrap();
    let args: Vec<_> = args.lines().collect();
    for expected in [
        "--remote-debugging-pipe",
        "--headless=new",
        "--no-first-run",
        "http://127.0.0.1:3000/start",
    ] {
        assert!(args.contains(&expected), "missing {expected}: {args:?}");
    }
    assert!(
        !args
            .iter()
            .any(|arg| arg.starts_with("--remote-debugging-port")
                || arg.starts_with("--remote-allow-origins")),
        "{args:?}"
    );
    relay.stop();
    // No page text and no frame reached the app's own storage.
    let stored = state_text(&fixture.state);
    for needle in ["Fixture page", "secret-path", "fake-jpeg"] {
        assert!(!stored.contains(needle), "{needle} was stored");
    }
}

#[test]
fn a_hidden_view_pauses_the_stream_at_the_browser_and_resuming_restarts_it() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve("", "Chrome/120.0.0.0");
    relay.open("about:blank");
    relay.next("frame");
    relay.send(json!({"type": "pause"}));
    assert_eq!(relay.next_json("state")["state"], "paused");
    assert!(relay.quiet(QUIET), "frames arrived while paused");
    assert!(fixture
        .methods()
        .contains(&"Page.stopScreencast".to_string()));

    relay.send(json!({"type": "resume"}));
    assert_eq!(relay.next_json("state")["state"], "running");
    relay.next("frame");
    let starts = fixture
        .methods()
        .iter()
        .filter(|m| *m == "Page.startScreencast")
        .count();
    assert_eq!(starts, 2);
    relay.stop();
}

#[test]
fn the_browser_only_ever_receives_allow_listed_commands() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve("", "Chrome/120.0.0.0");
    relay.open("about:blank");
    relay.next("frame");
    // Each of these names a protocol method, a script or a control the closed message set does not have.
    for refused in [
        json!({"type": "cdp", "method": "Network.getCookies"}),
        json!({"type": "evaluate", "expression": "document.cookie"}),
        json!({"type": "pointer", "kind": "tap", "x": 1, "y": 1}),
        json!({"type": "open", "viewport": {"width": 412, "height": 915}}),
        json!({"type": "ack", "sequence": 1, "method": "Runtime.evaluate"}),
    ] {
        relay.send(refused);
    }
    let counts: Vec<_> = (0..3)
        .map(|_| relay.next_json("refused")["count"].as_u64().unwrap())
        .collect();
    assert_eq!(counts, [1, 2, 4]);
    relay.stop();

    let commands = fixture.commands();
    assert!(!commands.is_empty());
    for command in &commands {
        let method = command["method"].as_str().unwrap();
        assert_eq!(
            allow::command(method, &command["params"]),
            Ok(()),
            "{method} is not on the allow-list"
        );
    }
    let text = fixture.recorded("commands").unwrap();
    assert!(
        !text.contains("Network.")
            && !text.contains("Runtime.")
            && !text.contains("document.cookie"),
        "{text}"
    );
    let denied = commands
        .iter()
        .find(|c| c["method"] == "Browser.setDownloadBehavior")
        .unwrap();
    assert_eq!(denied["params"]["behavior"], "deny");
}

#[test]
fn closing_the_view_ends_the_browser_its_helpers_and_the_profile() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve("", "Chrome/120.0.0.0");
    relay.open("about:blank");
    relay.next("frame");
    let profile = fixture.profiles().remove(0);
    assert_eq!(
        fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
        0o700,
        "the profile must be private"
    );
    relay.close_input();
    assert_eq!(closed(&relay)["reason"], "ClientClosed");
    assert!(relay.exit().success());
    fixture.nothing_is_left();
    assert!(!profile.exists());
}

/// An SSH drop ends the channel: the host delivers SIGHUP or SIGTERM as well as closing standard input.
#[test]
fn signals_end_the_browser_and_remove_the_profile() {
    for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
        let fixture = Fixture::enabled();
        let mut relay = fixture.serve("", "Chrome/120.0.0.0");
        relay.open("about:blank");
        relay.next("frame");
        relay.signal(signal);
        assert!(relay.exit().success(), "signal {signal}");
        fixture.nothing_is_left();
    }
}

/// A relay killed outright cannot clean up. The browser must still die (Linux) and the next start removes the
/// profile it left, matched by the dead relay's pid.
#[test]
fn a_killed_relay_leaves_a_profile_that_the_next_start_removes() {
    let fixture = Fixture::enabled();
    let mut crashed = fixture.serve("", "Chrome/120.0.0.0");
    crashed.open("about:blank");
    crashed.next("frame");
    let orphan = fixture.profiles().remove(0);
    crashed.signal(libc::SIGKILL);
    let _ = crashed.exit();
    assert!(orphan.exists(), "a SIGKILL cannot have cleaned up");
    #[cfg(target_os = "linux")]
    wait_gone(fixture.pid("browser"));
    // The fake's helper does not watch its parent as a real browser's do; stop it so the test leaves nothing.
    // SAFETY: the pid is the helper the fake browser recorded.
    unsafe { libc::kill(fixture.pid("helper") as i32, libc::SIGKILL) };

    let mut next = fixture.serve("", "Chrome/120.0.0.0");
    next.open("about:blank");
    next.next("frame");
    assert!(
        !orphan.exists(),
        "the killed relay's profile survived the next start"
    );
    assert_eq!(fixture.profiles().len(), 1);
    next.stop();
    assert!(fixture.profiles().is_empty());
}

#[test]
fn an_unsupported_browser_version_is_named_and_stopped() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve("", "Chrome/110.0.5481.77");
    relay.open("about:blank");
    let closing = closed(&relay);
    assert_eq!(closing["reason"], "BrowserVersionUnsupported");
    assert_eq!(closing["detail"], "Chrome/110.0.5481.77");
    assert!(!relay.exit().success());
    fixture.nothing_is_left();
}

#[test]
fn a_browser_that_exits_or_a_page_that_closes_ends_the_session() {
    for (mode, reason, success) in [
        ("exit", "BrowserExited", false),
        ("close", "PageClosed", true),
    ] {
        let fixture = Fixture::enabled();
        let mut relay = fixture.serve(mode, "Chrome/120.0.0.0");
        relay.open("about:blank");
        assert_eq!(closed(&relay)["reason"], reason);
        assert_eq!(relay.exit().success(), success, "{mode}");
        fixture.nothing_is_left();
    }
}

#[test]
fn a_bad_first_message_starts_nothing() {
    for (first, reason) in [
        (
            json!({"type": "open", "viewport": {"width": 412, "height": 915}, "url": "file:///etc/passwd"}),
            "AddressRefused",
        ),
        (
            json!({"type": "open", "viewport": {"width": 412, "height": 915}, "url": "javascript:alert(1)"}),
            "AddressRefused",
        ),
        (
            json!({"type": "open", "viewport": {"width": 50, "height": 915}}),
            "ViewportInvalid",
        ),
        (
            json!({"type": "open", "browser": "firefox", "viewport": {"width": 412, "height": 915}}),
            "BrowserUnsupported",
        ),
        (json!({"type": "pause"}), "OpenExpected"),
        (
            json!({"type": "evaluate", "expression": "1"}),
            "OpenExpected",
        ),
    ] {
        let fixture = Fixture::enabled();
        let mut relay = fixture.serve("", "Chrome/120.0.0.0");
        relay.send(first.clone());
        assert_eq!(closed(&relay)["reason"], reason, "{first}");
        assert!(!relay.exit().success());
        fixture.nothing_was_started();
    }
}

#[test]
fn broken_framing_closes_the_session_and_the_browser() {
    for garbage in [
        vec![0xff, 0xff, 0xff, 0xff, 1],
        vec![0, 0, 0, 0],
        vec![0, 0, 0, 2, wire::FRAME, 0],
    ] {
        let fixture = Fixture::enabled();
        let mut relay = fixture.serve("", "Chrome/120.0.0.0");
        relay.open("about:blank");
        relay.next("frame");
        relay.send_bytes(&garbage);
        assert_eq!(closed(&relay)["reason"], "ProtocolViolation", "{garbage:?}");
        assert!(!relay.exit().success());
        fixture.nothing_is_left();
    }
}

/// A page on loopback that is one solid color, served to a real browser.
fn fixture_page() -> (u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let body =
            "<!doctype html><title>Green</title><body style=\"margin:0;background:#00c800\">";
        // The browser asks for the page and a favicon; stop when the test drops its relay and connections stop.
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            };
            let mut request = [0u8; 2048];
            let _ = std::io::Read::read(&mut stream, &mut request);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (port, server)
}

/// The real browser: its pixels, not a fake's, reach the client, and nothing is left behind.
#[test]
fn a_real_browser_streams_the_fixture_page_and_leaves_nothing_behind() {
    let Some(binary) = chrome() else {
        eprintln!("skipped: no Chrome or Chromium on PATH");
        return;
    };
    let (port, _server) = fixture_page();
    let fixture = Fixture::enabled();
    let mut relay = Relay::start(
        &fixture.state,
        &[],
        &["--binary", binary.to_str().unwrap(), "--no-sandbox"],
    );
    relay.open(&format!("http://127.0.0.1:{port}/"));
    let state = relay.next_json("state");
    assert_eq!(state["state"], "running");
    let version = state["browser"].as_str().unwrap();
    assert!(version.contains("Chrom"), "{version}");
    let profile = fixture.profiles().remove(0);
    // Early frames can show the blank page, so read until the fixture's color has arrived, and until the page's
    // own title and address have, as text. A blank canvas never satisfies either.
    let deadline = Instant::now() + WAIT * 2;
    let (mut center, mut page) = (None, None);
    while center.is_none() || page.is_none() {
        assert!(
            Instant::now() < deadline,
            "the fixture page never reached the client: {center:?} {page:?}"
        );
        match relay.within(Duration::from_secs(1)) {
            Some(Message::Frame { sequence, jpeg, .. }) => {
                relay.send(json!({"type": "ack", "sequence": sequence}));
                let image = image::load_from_memory(&jpeg).unwrap().to_rgb8();
                let pixel = image.get_pixel(image.width() / 2, image.height() / 2).0;
                if pixel[1] > 150 && pixel[0] < 60 && pixel[2] < 60 {
                    center = Some(pixel);
                }
            }
            Some(Message::Json(message))
                if message["type"] == "page" && message["title"] == "Green" =>
            {
                page = Some(message);
            }
            _ => {}
        }
    }
    assert!((center.unwrap()[1] as i32 - 200).abs() < 40, "{center:?}");
    assert_eq!(page.unwrap()["url"], format!("http://127.0.0.1:{port}/"));

    relay.stop();
    let pattern = profile.to_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline
        && Command::new("pgrep")
            .args(["-f", pattern])
            .output()
            .unwrap()
            .status
            .success()
    {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !Command::new("pgrep")
            .args(["-f", pattern])
            .output()
            .unwrap()
            .status
            .success(),
        "the browser survived the relay"
    );
    assert!(!profile.exists(), "the profile outlived the relay");
}
