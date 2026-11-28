//! The host browser relay, `lazysh-agent host-browser serve` (docs/host-browser.md, "Relay wire format"), driven
//! through its real standard input and output over a fake browser on the DevTools pipe and, where the host has
//! one, a real Chrome or Chromium.
#![cfg(unix)]
use lazysh_agent::host_browser::{allow, wire};
use lazysh_common::test_support::GREEN_PAGE;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
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
    agent, assert_kept, assert_nothing_started, chrome, clear_data, cleared, enable,
    refusing_states, state_text, wait_gone,
};

#[path = "host_browser_relay/navigation.rs"]
mod navigation;

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
    /// The message, when it is a JSON one of `kind`.
    fn json(self, kind: &str) -> Option<Value> {
        match self {
            Self::Json(value) if value["type"] == kind => Some(value),
            _ => None,
        }
    }
    fn kind(&self) -> &str {
        match self {
            Self::Json(value) => value["type"].as_str().unwrap_or("?"),
            Self::Frame { .. } => "frame",
        }
    }
    /// The kind, with the whole message for a JSON one that is not routine page information (a `closed` has its reason).
    fn describe(&self) -> String {
        match self {
            Self::Json(value) if self.kind() != "page" => value.to_string(),
            _ => self.kind().to_string(),
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
        self.try_send_bytes(bytes).unwrap();
    }
    fn try_send_bytes(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let input = self.input.as_mut().unwrap();
        input.write_all(bytes)?;
        input.flush()
    }
    fn frame(value: &Value) -> Vec<u8> {
        let body = value.to_string();
        let mut bytes = (body.len() as u32 + 1).to_be_bytes().to_vec();
        bytes.push(wire::JSON);
        bytes.extend_from_slice(body.as_bytes());
        bytes
    }
    fn send(&mut self, value: Value) {
        self.send_bytes(&Self::frame(&value));
    }
    fn open(&mut self, url: &str) {
        self.open_as("chrome", url);
    }
    fn open_message(browser: &str, url: &str) -> Value {
        json!({"type": "open", "browser": browser, "viewport": {"width": 412, "height": 915}, "url": url})
    }
    fn open_as(&mut self, browser: &str, url: &str) {
        self.send(Self::open_message(browser, url));
    }
    /// An open the relay refuses: it reports why and exits without reading its input, so the write may meet a closed pipe.
    fn open_refused(&mut self, browser: &str, url: &str) {
        match self.try_send_bytes(&Self::frame(&Self::open_message(browser, url))) {
            Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {}
            result => result.unwrap(),
        }
    }
    fn control(&mut self, on: bool) {
        self.send(json!({"type": "control", "on": on}));
    }
    /// A touch at a point: the move, press and release that the client sends for it.
    fn tap(&mut self, x: u32, y: u32) {
        for (kind, button, clicks) in [
            ("move", "none", 0),
            ("press", "left", 1),
            ("release", "left", 1),
        ] {
            self.send(pointer(kind, button, clicks, x, y));
        }
    }
    /// Wait for the page's title to be `expected`; the fixture page reports its state in its title.
    fn title(&self, expected: &str) {
        let mut seen = Vec::new();
        let deadline = Instant::now() + WAIT * 2;
        while let Some(message) = self.within(deadline.saturating_duration_since(Instant::now())) {
            if let Some(page) = message.json("page") {
                if page["title"] == expected {
                    return;
                }
                seen.push(page["title"].clone());
            }
        }
        panic!("the page's title was never {expected:?}; it was {seen:?}");
    }
    /// The next refusal the relay reports: its reason and its count.
    fn refused(&self) -> (String, u64) {
        let refusal = self.next_json("refused");
        (
            refusal["reason"].as_str().unwrap().to_string(),
            refusal["count"].as_u64().unwrap(),
        )
    }

    fn within(&self, wait: Duration) -> Option<Message> {
        self.output.recv_timeout(wait).ok()
    }
    /// The next message of `kind`, skipping the others; what was skipped is shown when it never comes.
    fn next(&self, kind: &str) -> Message {
        self.next_during(kind, WAIT)
    }
    fn next_during(&self, kind: &str, wait: Duration) -> Message {
        let mut skipped = Vec::new();
        let deadline = Instant::now() + wait;
        while let Some(message) = self.within(deadline.saturating_duration_since(Instant::now())) {
            if message.kind() == kind {
                return message;
            }
            skipped.push(message.describe());
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
    /// Whether no frame and no control other than page and quality information arrives within `wait`.
    fn quiet(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        while let Some(message) = self.within(deadline.saturating_duration_since(Instant::now())) {
            if !["page", "quality"].contains(&message.kind()) {
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
        Self::with_fake(FAKE)
    }
    /// A fixture whose stand-in browser is the script `fake`.
    fn with_fake(fake: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fake-browser");
        fs::write(&path, fake).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            state: directory.path().join("state"),
            fake: path,
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
        self.serve_with(mode, product, &[])
    }
    fn serve_with(&self, mode: &str, product: &str, options: &[&str]) -> Relay {
        let (mode, product) = (Path::new(mode), Path::new(product));
        let envs = [
            ("FAKE_BROWSER_DIR", self.directory.path()),
            ("FAKE_MODE", mode),
            ("FAKE_PRODUCT", product),
        ];
        let binary = ["--binary", self.fake.to_str().unwrap()];
        Relay::start(&self.state, &envs, &[&binary[..], options].concat())
    }
    /// Wait for the fake browser to have received a `Page.startScreencast` with this JPEG quality and frame
    /// divisor as its latest, and return its parameters. The browser is another process: a message the relay sent
    /// is recorded a moment after the relay's own message about it reached the client.
    fn screencast_with(&self, quality: u64, every_nth: u64) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let screencasts = self.screencasts();
            match screencasts.last() {
                Some(last) if last["quality"] == quality && last["everyNthFrame"] == every_nth => {
                    return last.clone();
                }
                _ => assert!(
                    Instant::now() < deadline,
                    "no screencast with quality {quality} every {every_nth}: {screencasts:?}"
                ),
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    /// The parameters of every `Page.startScreencast` the fake browser received, in order.
    fn screencasts(&self) -> Vec<Value> {
        self.commands()
            .into_iter()
            .filter(|command| command["method"] == "Page.startScreencast")
            .map(|command| command["params"].clone())
            .collect()
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
    /// Every complete command in the fake browser's append-only log.
    fn commands(&self) -> Vec<Value> {
        fs::read(self.directory.path().join("commands"))
            .unwrap_or_default()
            .split_inclusive(|&byte| byte == b'\n')
            .take_while(|line| line.ends_with(b"\n"))
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }
    fn methods(&self) -> Vec<String> {
        self.commands()
            .iter()
            .map(|c| c["method"].as_str().unwrap().to_string())
            .collect()
    }
    /// The fixture's relay with a page open and its first frame in, and Control on when asked: the one a test
    /// drives. A relay that its test does not stop ends when the test drops it, because its input closes.
    fn started(control: bool) -> (Self, Relay) {
        let fixture = Self::enabled();
        let mut relay = fixture.serve("", "Chrome/120.0.0.0");
        relay.open("about:blank");
        relay.next("frame");
        if control {
            relay.control(true);
        }
        (fixture, relay)
    }
    /// The input calls the browser received, once at least `count` have arrived (the fake records them as it
    /// reads them). The relay writes in order, so a valid message sent last marks the end of what came before it.
    fn input_calls(&self, count: usize) -> Vec<Value> {
        let deadline = Instant::now() + WAIT;
        loop {
            let calls: Vec<_> = self
                .commands()
                .into_iter()
                .filter(|c| {
                    let method = c["method"].as_str().unwrap();
                    method.starts_with("Input.") || method == "Emulation.setPageScaleFactor"
                })
                .collect();
            if calls.len() >= count || Instant::now() > deadline {
                return calls;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
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
fn the_command_log_can_be_read_during_an_append() {
    let fixture = Fixture::new();
    let path = fixture.directory.path().join("commands");
    let first = json!({"method": "Page.enable"});
    let second = json!({"method": "Page.startScreencast"});
    let mut log = fs::File::create(path).unwrap();
    write!(log, "{first}\n{{\"method\":\"Page.start").unwrap();

    assert_eq!(fixture.commands(), vec![first.clone()]);

    writeln!(log, "Screencast\"}}").unwrap();
    assert_eq!(fixture.commands(), vec![first, second]);
}

#[test]
fn a_switch_that_is_off_or_unreadable_starts_nothing() {
    let fixture = Fixture::new();
    let root = fixture.directory.path();
    for (state, reason) in refusing_states(root, &fixture.state) {
        for browser in ["chrome", "firefox"] {
            let envs = [("FAKE_BROWSER_DIR", root)];
            let mut relay =
                Relay::start(&state, &envs, &["--binary", fixture.fake.to_str().unwrap()]);
            relay.open_refused(browser, "about:blank");
            assert_eq!(closed(&relay)["reason"], reason, "{browser}");
            assert!(!relay.exit().success());
            assert_nothing_started(root, &state);
        }
    }
    assert!(!fixture.state.exists(), "the gate created state");
}

/// Two frames `first` and `second` are out; a third waits for the device to acknowledge the first.
fn frames_wait_for_acknowledgements(relay: &mut Relay, first: u32, second: u32) {
    assert!(second > first);
    assert!(relay.quiet(QUIET), "a third frame went out unacknowledged");
    relay.send(json!({"type": "ack", "sequence": first, "decodeMs": 3}));
    let (third, _) = relay.next_frame();
    assert!(third > second, "{third} after {second}");
}

/// Everything the stand-in browser received was on the allow-list `allowed`, so the phone reached nothing else.
fn assert_every_command_is_allowed(
    fixture: &Fixture,
    allowed: impl Fn(&str, &Value) -> Result<(), allow::Refusal>,
) {
    let commands = fixture.commands();
    assert!(!commands.is_empty());
    for command in &commands {
        let method = command["method"].as_str().unwrap();
        assert_eq!(
            allowed(method, &command["params"]),
            Ok(()),
            "{method} is not on the allow-list"
        );
    }
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
    assert_eq!(state["capabilities"]["control"], true);

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
    frames_wait_for_acknowledgements(&mut relay, first, second);

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

/// Each of these names a protocol method, a script or a control the closed message set does not have: counted
/// and told to the client at 1, 2 and 4, never forwarded.
fn refuse_what_the_closed_set_lacks(relay: &mut Relay) {
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
}

#[test]
fn the_browser_only_ever_receives_allow_listed_commands() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve("", "Chrome/120.0.0.0");
    relay.open("about:blank");
    relay.next("frame");
    refuse_what_the_closed_set_lacks(&mut relay);
    relay.stop();

    assert_every_command_is_allowed(&fixture, allow::command);
    let commands = fixture.commands();
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

fn pointer(kind: &str, button: &str, clicks: u8, x: u32, y: u32) -> Value {
    json!({"type": "pointer", "kind": kind, "x": x, "y": y, "button": button, "clickCount": clicks})
}

/// One of each input message, all inside the viewport and valid.
fn one_of_each_input() -> [Value; 5] {
    [
        pointer("move", "none", 0, 10, 20),
        json!({"type": "wheel", "x": 10, "y": 20, "deltaX": 0, "deltaY": 120}),
        json!({"type": "pinch", "scale": 2}),
        json!({"type": "key", "key": "Enter", "modifiers": 0}),
        json!({"type": "text", "text": "ação"}),
    ]
}

/// The messages of a tap on the viewport's button, a wheel, a pinch, typed text and two keys, and a right press.
/// `pinch` is left out for an adapter that has no page pinch.
fn session_input(pinch: bool) -> Vec<Value> {
    let at = |kind, button, clicks| pointer(kind, button, clicks, 200, 300);
    let mut messages = vec![
        at("move", "none", 0),
        at("press", "left", 1),
        at("release", "left", 1),
        json!({"type": "wheel", "x": 200, "y": 300, "deltaX": 0, "deltaY": 120.5}),
        json!({"type": "text", "text": "ação 日本 😀"}),
        json!({"type": "key", "key": "Enter", "modifiers": 0}),
        json!({"type": "key", "key": "a", "modifiers": 2}),
        at("press", "right", 1),
    ];
    if pinch {
        messages.insert(4, json!({"type": "pinch", "scale": 2.5}));
    }
    messages
}

/// Turning Control off stops forwarding at once and on again resumes it. `forwarded(n)` waits for `n` calls at the
/// browser and says how many arrived.
fn assert_control_gates_input(relay: &mut Relay, forwarded: impl Fn(usize) -> usize) {
    let [pointer, wheel, ..] = one_of_each_input();
    relay.send(pointer);
    assert_eq!(forwarded(1), 1);
    relay.control(false);
    relay.send(wheel.clone());
    assert_eq!(relay.refused(), ("ControlOff".to_string(), 1));
    assert_eq!(
        forwarded(0),
        1,
        "input was forwarded after Control went off"
    );
    relay.control(true);
    relay.send(wheel);
    assert_eq!(forwarded(2), 2);
}

/// A real browser on `INPUT_PAGE` takes a tap, typed text and a scroll only while Control is on, and a tap that
/// came while it was off did not click. `after_tap` runs once the first tap has shown.
fn drive_input_page(relay: &mut Relay, after_tap: impl FnOnce(&mut Relay)) {
    relay.title("clicks=0;scroll=0;text=[]");

    // On the button, with Control off: refused. A click that got through would show as a second one below.
    relay.tap(200, 100);
    assert_eq!(relay.refused(), ("ControlOff".to_string(), 1));

    relay.control(true);
    relay.tap(200, 100);
    relay.title("clicks=1;scroll=0;text=[]");
    after_tap(relay);
    // Into the input, where the phone's keyboard puts accents, CJK and emoji as text, and a key deletes the emoji.
    relay.tap(200, 270);
    relay.send(json!({"type": "text", "text": "ação 日本 😀"}));
    relay.title("clicks=1;scroll=0;text=[ação 日本 😀]");
    relay.send(json!({"type": "key", "key": "Backspace", "modifiers": 0}));
    relay.title("clicks=1;scroll=0;text=[ação 日本 ]");
    // A drag of the page: the wheel, at a point of the spacer.
    relay.send(json!({"type": "wheel", "x": 200, "y": 600, "deltaX": 0, "deltaY": 400}));
    relay.title("clicks=1;scroll=1;text=[ação 日本 ]");
}

#[test]
fn with_control_off_which_is_how_a_session_starts_every_input_is_refused_and_counted() {
    let (fixture, mut relay) = Fixture::started(false);
    let inputs = one_of_each_input();
    for message in inputs.iter().chain(inputs.iter()).take(8) {
        relay.send(message.clone());
    }
    // A reply at 1, 2, 4 and 8: the last one means the relay has seen every message.
    for count in [1, 2, 4, 8] {
        assert_eq!(relay.refused(), ("ControlOff".to_string(), count));
    }
    assert!(
        fixture.input_calls(0).is_empty(),
        "input reached the browser"
    );
    relay.stop();
}

#[test]
fn with_control_on_each_message_becomes_exactly_its_calls_in_order() {
    let (fixture, mut relay) = Fixture::started(true);
    for message in session_input(true) {
        relay.send(message);
    }
    let key = |kind: &str, name: &str, code: &str, virtual_key: u32, modifiers: u32| json!({"type": kind, "key": name, "code": code, "windowsVirtualKeyCode": virtual_key, "modifiers": modifiers});
    let mut enter = key("keyDown", "Enter", "Enter", 13, 0);
    enter["text"] = "\r".into();
    let mouse = |kind: &str, button: &str, buttons: u32, clicks: u32| json!({"type": kind, "x": 200.0, "y": 300.0, "button": button, "buttons": buttons, "clickCount": clicks});
    let expected = [
        (
            "Input.dispatchMouseEvent",
            mouse("mouseMoved", "none", 0, 0),
        ),
        (
            "Input.dispatchMouseEvent",
            mouse("mousePressed", "left", 1, 1),
        ),
        (
            "Input.dispatchMouseEvent",
            mouse("mouseReleased", "left", 0, 1),
        ),
        (
            "Input.dispatchMouseEvent",
            json!({"type": "mouseWheel", "x": 200.0, "y": 300.0, "deltaX": 0.0, "deltaY": 120.5}),
        ),
        (
            "Emulation.setPageScaleFactor",
            json!({"pageScaleFactor": 2.5}),
        ),
        ("Input.insertText", json!({"text": "ação 日本 😀"})),
        ("Input.dispatchKeyEvent", enter),
        (
            "Input.dispatchKeyEvent",
            key("keyUp", "Enter", "Enter", 13, 0),
        ),
        (
            "Input.dispatchKeyEvent",
            key("rawKeyDown", "a", "KeyA", 65, 2),
        ),
        ("Input.dispatchKeyEvent", key("keyUp", "a", "KeyA", 65, 2)),
        (
            "Input.dispatchMouseEvent",
            mouse("mousePressed", "right", 2, 1),
        ),
    ];
    let calls = fixture.input_calls(expected.len());
    let received: Vec<_> = calls
        .iter()
        .map(|c| (c["method"].as_str().unwrap(), c["params"].clone()))
        .collect();
    assert_eq!(received, expected);
    assert!(
        calls.iter().all(|c| c["sessionId"] == "S1"),
        "an input call left the page's session"
    );
    relay.stop();
}

#[test]
fn turning_control_off_stops_forwarding_at_once_and_on_again_resumes_it() {
    let (fixture, mut relay) = Fixture::started(true);
    assert_control_gates_input(&mut relay, |count| fixture.input_calls(count).len());
    assert_eq!(fixture.input_calls(2)[1]["params"]["type"], "mouseWheel");
    relay.stop();
}

#[test]
fn input_outside_its_bounds_a_clipboard_chord_or_an_unknown_field_is_refused() {
    let (fixture, mut relay) = Fixture::started(true);
    let out_of_range = [
        json!({"type": "pointer", "kind": "move", "x": 413, "y": 10, "button": "none", "clickCount": 0}),
        json!({"type": "wheel", "x": 10, "y": 10, "deltaX": 0, "deltaY": 10001}),
        json!({"type": "pinch", "scale": 5.5}),
        json!({"type": "text", "text": "a".repeat(5000)}),
        json!({"type": "key", "key": "Insert", "modifiers": 0}),
    ];
    let clipboard = [
        json!({"type": "key", "key": "v", "modifiers": 2}),
        json!({"type": "key", "key": "C", "modifiers": 4}),
        json!({"type": "key", "key": "Delete", "modifiers": 8}),
    ];
    let unknown = [
        json!({"type": "pointer", "kind": "move", "x": 1, "y": 1, "button": "none", "clickCount": 0, "method": "Input.dispatchDragEvent"}),
        json!({"type": "key", "key": "v", "modifiers": 2, "commands": ["paste"]}),
        json!({"type": "dragEvent", "x": 1, "y": 1}),
    ];
    for message in out_of_range.iter().chain(&clipboard).chain(&unknown) {
        relay.send(message.clone());
    }
    // The last message that is valid ends what came before it.
    relay.send(json!({"type": "key", "key": "a", "modifiers": 2}));
    let mut counts = std::collections::BTreeMap::new();
    // A reply at 1, 2 and 4 of the first kind, 1 and 2 of the other two.
    for _ in 0..7 {
        let (reason, count) = relay.refused();
        counts.insert(reason, count);
    }
    // The third of a kind has no reply of its own, so the last one seen is the second.
    assert_eq!(
        counts,
        [
            ("InputOutOfRange".to_string(), 4),
            ("OperationRefused".to_string(), 2),
            ("PermissionRefused".to_string(), 2),
        ]
        .into()
    );
    let calls = fixture.input_calls(2);
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0]["params"]["code"], "KeyA");
    relay.stop();
}

#[test]
fn a_flood_of_input_is_rate_limited_and_the_browser_gets_a_bounded_share() {
    let (fixture, mut relay) = Fixture::started(true);
    let flood = json!({"type": "pointer", "kind": "move", "x": 10, "y": 10, "button": "none", "clickCount": 0}).to_string();
    let bytes: Vec<u8> = (0..2000)
        .flat_map(|_| {
            let mut message = (flood.len() as u32 + 1).to_be_bytes().to_vec();
            message.push(wire::JSON);
            message.extend_from_slice(flood.as_bytes());
            message
        })
        .collect();
    relay.send_bytes(&bytes);
    // Refusals are reported at powers of two: 1024 means more than half of the 2000 were refused.
    let mut last = (String::new(), 0);
    while last.1 < 1024 {
        last = relay.refused();
        assert_eq!(last.0, "InputRateLimited");
    }
    // Whatever the rate, the browser cannot have received more than were not refused.
    let received = fixture.input_calls(200).len();
    assert!((200..=976).contains(&received), "{received} calls");
    relay.stop();
}

#[test]
fn whatever_a_client_sends_the_browser_only_gets_allow_listed_input_methods() {
    let (fixture, mut relay) = Fixture::started(true);
    let mut hostile = Vec::new();
    for method in [
        "Input.dispatchDragEvent",
        "Input.dispatchTouchEvent",
        "Runtime.evaluate",
        "Browser.close",
    ] {
        for kind in ["move", "press", "release", "drag"] {
            hostile.push(json!({"type": "pointer", "kind": kind, "x": 5, "y": 5, "button": "left", "clickCount": 1, "method": method, "params": {}}));
        }
        hostile.push(json!({"type": "key", "key": "v", "modifiers": 2, "method": method, "commands": ["paste", "copy"]}));
        hostile.push(json!({"type": "cdp", "method": method}));
    }
    for key in ["v", "c", "x", "Insert", "F12", "Delete"] {
        for modifiers in [0, 2, 4, 6, 8, 10, 15, 16] {
            hostile.push(json!({"type": "key", "key": key, "modifiers": modifiers}));
        }
    }
    for message in &hostile {
        relay.send(message.clone());
    }
    relay.send(json!({"type": "text", "text": "last"}));
    // The sentinel is sent after every hostile input. Wait until the browser has seen it before
    // checking the whole preceding sequence; a nonempty prefix is not a completion signal.
    let deadline = Instant::now() + WAIT;
    let calls = loop {
        let calls = fixture.input_calls(1);
        if calls.iter().any(|call| {
            call["method"] == "Input.insertText" && call["params"] == json!({"text": "last"})
        }) {
            break calls;
        }
        assert!(
            Instant::now() < deadline,
            "final input sentinel did not reach browser"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(!calls.is_empty());
    let allowed = [
        "Input.dispatchMouseEvent",
        "Input.dispatchKeyEvent",
        "Input.insertText",
        "Emulation.setPageScaleFactor",
    ];
    for call in fixture.commands() {
        let method = call["method"].as_str().unwrap();
        assert_eq!(allow::command(method, &call["params"]), Ok(()), "{method}");
        if method.starts_with("Input.") {
            assert!(allowed.contains(&method), "{method}");
            assert!(call["params"].get("commands").is_none(), "{call}");
        }
    }
    // The only key events are the valid ones: Delete and the plain keys, never a clipboard chord.
    for call in calls
        .iter()
        .filter(|c| c["method"] == "Input.dispatchKeyEvent")
    {
        let (key, modifiers) = (
            call["params"]["key"].as_str().unwrap(),
            call["params"]["modifiers"].as_u64().unwrap(),
        );
        assert!(
            !(matches!(key.to_lowercase().as_str(), "c" | "x" | "v") && modifiers & 6 != 0),
            "{call}"
        );
        assert!(!(key == "Delete" && modifiers & 8 != 0), "{call}");
    }
    assert_eq!(calls.last().unwrap()["params"], json!({"text": "last"}));
    relay.stop();
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

/// **Keep profile** through the relay: the one kept profile is held by one session, survives its stop with what the
/// browser wrote, and goes only with **Clear browser data**, which refuses while a session uses it.
#[test]
fn a_kept_profile_survives_a_stop_and_is_gone_after_clear_browser_data() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve_with("", "Chrome/120.0.0.0", &["--keep-profile"]);
    relay.open("about:blank");
    relay.next("frame");
    let profile = fixture.profiles().remove(0);
    assert_eq!(profile.file_name().unwrap(), "kept");

    // One kept profile is never shared by two browsers, and clearing never pulls it from under one.
    let mut second = fixture.serve_with("", "Chrome/120.0.0.0", &["--keep-profile"]);
    second.open("about:blank");
    assert_eq!(closed(&second)["reason"], "BrowserProfileInUse");
    assert!(!second.exit().success());
    let refused = clear_data(&fixture.state);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("BrowserProfileInUse"));
    assert!(profile.join("Cookies").exists());

    relay.close_input();
    assert_eq!(closed(&relay)["reason"], "ClientClosed");
    assert!(relay.exit().success());
    wait_gone(fixture.pid("browser"));
    wait_gone(fixture.pid("helper"));
    assert_kept(&profile);
    assert_eq!(
        fs::read_dir(profile.parent().unwrap()).unwrap().count(),
        1,
        "only the kept profile may outlive the session, with no marker"
    );

    // Without the option the session is ephemeral again and leaves the kept profile as it was.
    let mut ephemeral = fixture.serve("", "Chrome/120.0.0.0");
    ephemeral.open("about:blank");
    ephemeral.next("frame");
    assert_eq!(fixture.profiles().len(), 2);
    ephemeral.stop();
    assert_eq!(fixture.profiles(), std::slice::from_ref(&profile));

    assert!(cleared(&clear_data(&fixture.state)));
    assert!(!profile.exists(), "Clear browser data left the profile");
    assert!(!cleared(&clear_data(&fixture.state)));
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
            json!({"type": "open", "browser": "safari", "viewport": {"width": 412, "height": 915}}),
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

/// The client's side of a shaped link, for `wait`: each frame takes its size at `mbps` to arrive behind the ones
/// before it and is acknowledged one `round_trip` after that, as a device that decodes at once would. Returns
/// the relay's other messages with when each came, since the call.
fn over_link(
    relay: &mut Relay,
    mbps: f64,
    round_trip: Duration,
    wait: Duration,
) -> Vec<(Duration, Value)> {
    let start = Instant::now();
    let (mut free, mut due, mut controls) = (start, VecDeque::new(), Vec::new());
    while start.elapsed() < wait {
        let next = due.front().map_or(wait, |(at, _): &(Instant, u32)| {
            at.saturating_duration_since(Instant::now())
        });
        match relay.within(next.min(wait.saturating_sub(start.elapsed()))) {
            Some(Message::Frame { sequence, jpeg, .. }) => {
                free = free.max(Instant::now())
                    + Duration::from_secs_f64(jpeg.len() as f64 * 8.0 / (mbps * 1e6));
                due.push_back((free + round_trip, sequence));
            }
            Some(Message::Json(message)) => controls.push((start.elapsed(), message)),
            None => {}
        }
        while due.front().is_some_and(|(at, _)| *at <= Instant::now()) {
            let (_, sequence) = due.pop_front().unwrap();
            relay.send(json!({"type": "ack", "sequence": sequence, "decodeMs": 2}));
        }
    }
    controls
}

fn rungs(controls: &[(Duration, Value)]) -> Vec<(Duration, String)> {
    controls
        .iter()
        .filter(|(_, message)| message["type"] == "quality")
        .map(|(at, message)| (*at, message["rung"].as_str().unwrap().to_string()))
        .collect()
}

/// Run `relay` over a shaped link for `wait` and assert the rung it settles on, within five seconds, and, with
/// `first_step`, that the first step down came within a second and a half.
fn assert_settles_on(
    relay: &mut Relay,
    (mbps, round_trip): (f64, Duration),
    wait: Duration,
    (rung, first_step): (&str, bool),
) {
    let controls = over_link(relay, mbps, round_trip, wait);
    let rungs = rungs(&controls);
    let (settled, last) = rungs.last().unwrap();
    assert_eq!(last, rung, "{rungs:?}");
    assert!(*settled <= Duration::from_secs(5), "{rungs:?}");
    if first_step {
        // A problem is answered within a second.
        assert!(rungs[1].0 <= Duration::from_millis(1500), "{rungs:?}");
    }
}

/// A page that changes 60 times a second, seen over a link: the rung the stream settles on, and how soon.
fn settles_on(mbps: f64, round_trip_ms: u64, rung: &str, first_step: bool) {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve("animate", "Chrome/120.0.0.0");
    relay.open("about:blank");
    relay.next("state");
    assert_settles_on(
        &mut relay,
        (mbps, Duration::from_millis(round_trip_ms)),
        Duration::from_secs(6),
        (rung, first_step),
    );
    relay.stop();
}

#[test]
fn a_fast_link_keeps_the_highest_rung() {
    settles_on(50.0, 10, "high", false);
}

#[test]
fn a_mobile_link_that_carries_the_frames_keeps_the_highest_rung() {
    settles_on(20.0, 40, "high", false);
}

#[test]
fn a_slow_link_steps_down_within_a_second_and_settles_within_five() {
    settles_on(1.5, 150, "minimal", true);
}

#[test]
fn data_saver_holds_a_rung_whatever_the_link_does_until_the_client_says_auto() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve("animate", "Chrome/120.0.0.0");
    relay.open("about:blank");
    // The first start is the top rung, and the client is told so.
    let quality = relay.next_json("quality");
    assert_eq!(
        (quality["rung"].as_str(), quality["pinned"].as_bool()),
        (Some("high"), Some(false))
    );
    relay.send(json!({"type": "quality", "rung": "balanced"}));
    let quality = relay.next_json("quality");
    assert_eq!(
        (quality["rung"].as_str(), quality["pinned"].as_bool()),
        (Some("balanced"), Some(true))
    );
    // Nothing is acknowledged, which would step an adaptive ladder down within a second or two.
    let silent = Instant::now() + Duration::from_millis(2500);
    while let Some(message) = relay.within(silent.saturating_duration_since(Instant::now())) {
        assert_ne!(message.kind(), "quality", "{message:?}");
    }
    // Held at Balanced, which is the browser's latest start: no step down came in between.
    fixture.screencast_with(50, 2);
    assert!(fixture
        .methods()
        .contains(&"Page.stopScreencast".to_string()));

    // Data saver is the lowest rung: 75 percent of 412 by 915, at q35, every sixth frame.
    relay.send(json!({"type": "quality", "rung": "minimal"}));
    assert_eq!(relay.next_json("quality")["rung"], "minimal");
    let minimal = fixture.screencast_with(35, 6);
    assert_eq!(
        (&minimal["maxWidth"], &minimal["maxHeight"]),
        (&json!(309), &json!(686))
    );

    relay.send(json!({"type": "quality", "rung": "auto"}));
    let quality = relay.next_json("quality");
    assert_eq!(
        (quality["rung"].as_str(), quality["pinned"].as_bool()),
        (Some("high"), Some(false))
    );
    fixture.screencast_with(60, 1);

    // A rung that does not exist is refused like any other message outside the closed set.
    relay.send(json!({"type": "quality", "rung": "ultra"}));
    assert_eq!(relay.next_json("refused")["reason"], "OperationRefused");
    relay.stop();
}

#[test]
fn input_gives_the_page_every_frame_for_two_seconds_and_then_the_ladder_again() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve("animate", "Chrome/120.0.0.0");
    relay.open("about:blank");
    relay.send(json!({"type": "control", "on": true}));
    // Nothing is acknowledged, so the ladder steps down to the lowest rung, every sixth frame.
    let wait = Instant::now() + WAIT;
    while fixture
        .screencasts()
        .last()
        .is_none_or(|last| last["everyNthFrame"] != 6)
    {
        assert!(Instant::now() < wait, "{:?}", fixture.screencasts());
        std::thread::sleep(Duration::from_millis(50));
    }
    let before = fixture.screencasts().len();
    let touched = Instant::now();
    relay.send(pointer("move", "none", 0, 10, 20));
    let mut boosted = None;
    while Instant::now() < touched + WAIT {
        let screencasts = fixture.screencasts();
        if screencasts.len() > before + 1 {
            boosted = Some((
                screencasts[before].clone(),
                screencasts[before + 1].clone(),
                touched.elapsed(),
            ));
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let (boost, back, elapsed) = boosted.expect("the stream never returned to the ladder");
    // Every frame, at the rung's own quality and size; then the rung's own rate again after two seconds.
    assert_eq!(boost["everyNthFrame"], 1);
    assert_eq!(
        (boost["quality"].as_u64(), boost["maxWidth"].as_u64()),
        (Some(35), Some(309))
    );
    assert_eq!(back["everyNthFrame"], 6);
    assert!(elapsed >= Duration::from_millis(1900), "{elapsed:?}");
    relay.stop();
}

#[test]
fn a_view_hidden_for_the_idle_time_releases_the_browser_and_a_shown_one_never_does() {
    let fixture = Fixture::enabled();
    let mut relay = fixture.serve_with("", "Chrome/120.0.0.0", &["--idle-release", "2"]);
    relay.open("about:blank");
    // Shown for longer than the idle time, and acknowledging: nothing ends the session.
    let controls = over_link(
        &mut relay,
        1000.0,
        Duration::ZERO,
        Duration::from_millis(2500),
    );
    assert!(
        controls
            .iter()
            .all(|(_, message)| message["type"] != "closed"),
        "{controls:?}"
    );
    relay.send(json!({"type": "pause"}));
    let hidden = Instant::now();
    assert_eq!(relay.next_json("closed")["reason"], "IdleReleased");
    let elapsed = hidden.elapsed();
    assert!(
        elapsed >= Duration::from_millis(1900) && elapsed < Duration::from_secs(5),
        "{elapsed:?}"
    );
    assert!(relay.exit().success());
    fixture.nothing_is_left();
}

#[test]
fn an_idle_time_outside_one_second_to_a_day_is_refused_before_anything_starts() {
    let fixture = Fixture::enabled();
    for value in ["0", "86401", "soon"] {
        let output = agent(&fixture.state)
            .args(["host-browser", "serve", "--idle-release", value])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{value}");
    }
    fixture.nothing_was_started();
}

/// A page that keeps its state in its title, which the relay reports as text: clicks on the button, whether it
/// scrolled, and the text in the input, in brackets (a title loses trailing spaces). The button, the input and a tall spacer fill the width, one below the other.
const INPUT_PAGE: &str = "<!doctype html><title>clicks=0;scroll=0;text=[]</title>
<style>body{margin:0}button{display:block;width:412px;height:200px;border:0;background:#00c800}
input{display:block;box-sizing:border-box;width:412px;height:100px;margin-top:20px;font-size:32px}div{height:4000px}</style>
<button></button><input autocomplete=off><div></div>
<script>
let clicks = 0;
const input = document.querySelector('input');
const report = () => { document.title = `clicks=${clicks};scroll=${scrollY > 0 ? 1 : 0};text=[${input.value}]`; };
const button = document.querySelector('button');
button.onclick = () => { clicks++; button.style.background = '#0000c8'; report(); };
input.oninput = report;
onscroll = report;
</script>";

/// A server on loopback for a real browser: `respond` gets the request line and returns the whole response.
fn fixture_server(
    respond: impl Fn(&str) -> String + Send + 'static,
) -> (u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        // The browser asks for the page and a favicon; stop when the test drops its relay and connections stop.
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            };
            let mut request = [0u8; 2048];
            let read = std::io::Read::read(&mut stream, &mut request).unwrap_or(0);
            let request = String::from_utf8_lossy(&request[..read]);
            let _ =
                stream.write_all(respond(request.lines().next().unwrap_or_default()).as_bytes());
        }
    });
    (port, server)
}

/// An HTTP response that closes the connection after `body`.
fn http_response(headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// A page on loopback, served to a real browser.
fn fixture_page(body: &'static str) -> (u16, std::thread::JoinHandle<()>) {
    fixture_server(move |_| http_response("Content-Type: text/html\r\n", body))
}

/// What a loopback server sends for one path: its media type, extra header lines (each ended by a line break)
/// and its body.
struct Reply {
    content_type: &'static str,
    headers: &'static str,
    body: String,
}

/// A loopback server that serves a real browser: `answer` gets the path of each request and says what to send.
fn serve_pages(
    answer: impl Fn(&str) -> Reply + Send + 'static,
) -> (u16, std::thread::JoinHandle<()>) {
    fixture_server(move |line| {
        let reply = answer(line.split_whitespace().nth(1).unwrap_or("/"));
        http_response(
            &format!("Content-Type: {}\r\n{}", reply.content_type, reply.headers),
            &reply.body,
        )
    })
}

/// A relay over the host's real Chrome or Chromium, opened on a loopback page: the fixture, the relay and the
/// page's port. `None` on a host that has no browser.
fn real_relay(page: &'static str) -> Option<(Fixture, Relay, u16)> {
    let Some(binary) = chrome() else {
        eprintln!("skipped: no Chrome or Chromium on PATH");
        return None;
    };
    let (port, _server) = lazysh_common::test_support::loopback_page(page, 60);
    let fixture = Fixture::enabled();
    let mut relay = Relay::start(
        &fixture.state,
        &[],
        &["--binary", binary.to_str().unwrap(), "--no-sandbox"],
    );
    relay.open(&format!("http://127.0.0.1:{port}/"));
    Some((fixture, relay, port))
}

/// Read until the fixture's color has reached the client as pixels, and its own title and address as text. Early
/// frames can show the blank page, and a blank canvas never satisfies either.
fn wait_for_fixture(relay: &mut Relay, port: u16) {
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
}

/// After the relay stopped: no process still runs with `profile` on its command line, and the profile is gone.
fn assert_real_browser_is_gone(profile: &Path) {
    let pattern = profile.to_str().unwrap();
    let running = || {
        Command::new("pgrep")
            .args(["-f", pattern])
            .output()
            .unwrap()
            .status
            .success()
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && running() {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!running(), "the browser survived the relay");
    assert!(!profile.exists(), "the profile outlived the relay");
}

/// The real browser: its pixels, not a fake's, reach the client, and nothing is left behind.
#[test]
fn a_real_browser_streams_the_fixture_page_and_leaves_nothing_behind() {
    let Some((fixture, mut relay, port)) = real_relay(GREEN_PAGE) else {
        return;
    };
    let state = relay.next_json("state");
    assert_eq!(state["state"], "running");
    let version = state["browser"].as_str().unwrap();
    assert!(version.contains("Chrom"), "{version}");
    let profile = fixture.profiles().remove(0);
    wait_for_fixture(&mut relay, port);
    relay.stop();
    assert_real_browser_is_gone(&profile);
}

/// A real browser writes the kept profile and a prompt stop keeps what the page wrote (#2045): the data survives
/// reopening and is removed by Clear browser data.
#[test]
fn real_browser_kept_profile_persists_until_cleared() {
    let Some(binary) = chrome() else {
        eprintln!("skipped: no Chrome or Chromium on PATH");
        return;
    };
    let page = "<!doctype html><script>const previous = localStorage.getItem('owned'); localStorage.setItem('owned', 'yes'); document.title = previous || 'fresh';</script>";
    let (port, _server) = lazysh_common::test_support::loopback_page(page, 60);
    let fixture = Fixture::enabled();
    let url = format!("http://127.0.0.1:{port}/");
    let run = |expected: &str| {
        let mut relay = Relay::start(
            &fixture.state,
            &[],
            &[
                "--binary",
                binary.to_str().unwrap(),
                "--no-sandbox",
                "--keep-profile",
            ],
        );
        relay.open(&url);
        relay.title(expected);
        relay.stop();
    };
    run("fresh");
    run("yes");
    assert!(cleared(&clear_data(&fixture.state)));
    run("fresh");
    assert!(cleared(&clear_data(&fixture.state)));
}

/// The real browser honors a restart with other parameters: after Data saver its frames are 75 percent of the
/// width. A screencast sends a frame when the page changes, so the page is scrolled until one arrives.
#[test]
fn a_real_browser_sends_the_smaller_frames_the_lowest_rung_asks_for() {
    let Some((_fixture, mut relay, _port)) = real_relay(INPUT_PAGE) else {
        return;
    };
    relay.next_json("state");
    relay.control(true);
    relay.send(json!({"type": "quality", "rung": "minimal"}));
    let deadline = Instant::now() + WAIT * 2;
    let mut widths = Vec::new();
    while widths.last() != Some(&309) {
        assert!(
            Instant::now() < deadline,
            "frame widths after Data saver: {widths:?}"
        );
        relay.send(json!({"type": "wheel", "x": 10, "y": 20, "deltaX": 0, "deltaY": 120}));
        if let Some(Message::Frame { sequence, jpeg, .. }) =
            relay.within(Duration::from_millis(500))
        {
            relay.send(json!({"type": "ack", "sequence": sequence}));
            widths.push(image::load_from_memory(&jpeg).unwrap().width());
        }
    }
    relay.stop();
}

/// The real browser takes the client's input through the relay: the page changes only because a tap, a scroll and
/// typed text arrived, and a tap that came while Control was off did not.
#[test]
fn a_real_browser_takes_a_tap_typed_text_and_a_scroll_only_while_control_is_on() {
    let Some((_fixture, mut relay, _)) = real_relay(INPUT_PAGE) else {
        return;
    };
    drive_input_page(&mut relay, |_| {});
    relay.stop();
}

#[path = "host_browser_relay/firefox.rs"]
mod firefox;
