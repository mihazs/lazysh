//! The Firefox adapter of the host browser relay, driven the way the Chrome one is: through the real relay process
//! and its standard input and output, over a stand-in Firefox that speaks WebDriver BiDi (exact commands, leaked
//! sessions, versions) and over a real Firefox where the host has one.
use super::navigation::{named, params, Client, Site, GREEN, YELLOW};
use super::*;
use lazysh_agent::host_browser::bidi;
use std::{
    collections::BTreeMap,
    io::Read,
    net::TcpStream,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

const FAKE_FIREFOX: &str = include_str!("../support/fake_firefox_bidi.py");
const LEAKY_FIREFOX: &str = include_str!("../support/leaky_firefox.py");
/// The oldest Firefox the relay supports, as its major version (`firefox::MIN_VERSION`).
const MIN_FIREFOX: u32 = 159;

fn fixture() -> Fixture {
    let fixture = Fixture::with_fake(FAKE_FIREFOX);
    enable(&fixture.state);
    fixture
}

/// A relay over the stand-in Firefox, which reads its mode and version from its environment. The relay's own
/// environment grants system access to the browser, which the relay must take away.
fn serve(fixture: &Fixture, mode: &str, version: &str) -> Relay {
    let (mode, version) = (Path::new(mode), Path::new(version));
    let envs = [
        ("FAKE_BROWSER_DIR", fixture.directory.path()),
        ("FAKE_MODE", mode),
        ("FAKE_VERSION", version),
        ("MOZ_REMOTE_ALLOW_SYSTEM_ACCESS", Path::new("1")),
    ];
    let mut relay = Relay::start(
        &fixture.state,
        &envs,
        &["--binary", fixture.fake.to_str().unwrap()],
    );
    relay.open_as("firefox", "http://127.0.0.1:3000/start");
    relay
}

/// Every browser process the stand-in recorded, over all its launches.
fn pids(fixture: &Fixture) -> Vec<u32> {
    fixture
        .recorded("pids")
        .unwrap()
        .lines()
        .map(|line| line.parse().unwrap())
        .collect()
}

fn launches(fixture: &Fixture) -> usize {
    fixture.recorded("launches").unwrap().lines().count()
}

#[test]
fn frames_and_page_text_flow_two_at_a_time_until_the_device_acknowledges() {
    let fixture = fixture();
    let mut relay = serve(&fixture, "", "160.0");
    let state = relay.next_json("state");
    assert_eq!(state["state"], "running");
    assert_eq!(state["browser"], "Firefox/160.0");
    assert_eq!(
        state["viewport"],
        json!({"width": 412, "height": 915, "scale": 1.0})
    );
    // Control and the capabilities Firefox lacks, with why.
    assert_eq!(state["capabilities"]["control"], true);
    assert_eq!(
        (
            &state["capabilities"]["pinch"],
            &state["capabilities"]["composition"],
            &state["capabilities"]["unavailable"]
        ),
        (
            &json!(false),
            &json!(false),
            &json!({"pinch": "NoPagePinch", "composition": "NoTextInsertion"})
        )
    );
    // The title and the address are read by two commands, so the page may be announced twice; frames come beside it.
    let (mut page, mut frames) = (None, Vec::new());
    while page.is_none() || frames.len() < 2 {
        match relay.within(WAIT).expect("the stream stopped") {
            Message::Json(message)
                if message["type"] == "page" && message["title"] == "Fixture page" =>
            {
                page = Some(message);
            }
            Message::Frame {
                sequence,
                width,
                height,
                scroll_y,
                jpeg,
            } => {
                assert_eq!((width, height, scroll_y), (412, 915, 0.0));
                assert!(jpeg.starts_with(b"\xff\xd8fake-jpeg\xff\xd9"), "{jpeg:?}");
                frames.push(sequence);
            }
            Message::Json(_) => {}
        }
    }
    assert_eq!(page.unwrap()["url"], "http://127.0.0.1:3000/start");
    frames_wait_for_acknowledgements(&mut relay, frames[0], frames[1]);

    // The browser was started as specified: a private profile, its own instance, a random port, the page as an
    // argument, no widening of who may connect, and no system access even though the relay's own environment
    // offered it.
    let args = fixture.recorded("args").unwrap();
    let args: Vec<_> = args.lines().collect();
    let profile = fixture.profiles().remove(0);
    for expected in [
        "--headless",
        "--no-remote",
        profile.to_str().unwrap(),
        "http://127.0.0.1:3000/start",
    ] {
        assert!(args.contains(&expected), "missing {expected}: {args:?}");
    }
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--profile", profile.to_str().unwrap()])
            && args
                .windows(2)
                .any(|pair| pair == ["--remote-debugging-port", "0"]),
        "{args:?}"
    );
    assert!(
        !args.iter().any(|arg| arg.starts_with("--remote-allow")),
        "{args:?}"
    );
    assert!(
        !fixture
            .recorded("env")
            .unwrap()
            .contains("MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"),
        "the browser got system access"
    );
    relay.stop();
    // No page text and no frame reached the app's own storage.
    let stored = state_text(&fixture.state);
    for needle in ["Fixture page", "3000/start", "fake-jpeg"] {
        assert!(!stored.contains(needle), "{needle} was stored");
    }
}

#[test]
fn the_browser_only_ever_receives_allow_listed_commands() {
    let fixture = fixture();
    let mut relay = serve(&fixture, "", "160.0");
    relay.next("frame");
    refuse_what_the_closed_set_lacks(&mut relay);
    relay.stop();

    assert_every_command_is_allowed(&fixture, allow::bidi);
    let text = fixture.recorded("commands").unwrap();
    assert!(
        !text.contains("storage.") && !text.contains("network.") && !text.contains("cookie"),
        "{text}"
    );
}

/// A relay over the stand-in Firefox with its first frame in, and Control on when asked.
fn started(mode: &str, control: bool) -> (Fixture, Relay) {
    let fixture = fixture();
    let mut relay = serve(&fixture, mode, "160.0");
    relay.next("frame");
    if control {
        relay.control(true);
    }
    (fixture, relay)
}

/// The `input.*` commands the stand-in received, once at least `count` have arrived (it records them as it reads
/// them). The relay writes in order, so a command sent last marks the end of what came before it.
fn input_commands(fixture: &Fixture, count: usize) -> Vec<Value> {
    let deadline = Instant::now() + WAIT;
    loop {
        let calls: Vec<_> = fixture
            .commands()
            .into_iter()
            .filter(|command| command["method"].as_str().unwrap().starts_with("input."))
            .collect();
        if calls.len() >= count || Instant::now() > deadline {
            return calls;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn with_control_off_which_is_how_a_session_starts_every_input_is_refused_and_counted() {
    let (fixture, mut relay) = started("", false);
    for message in one_of_each_input() {
        relay.send(message);
    }
    // A reply at 1, 2 and 4 of five messages.
    for count in [1, 2, 4] {
        assert_eq!(relay.refused(), ("ControlOff".to_string(), count));
    }
    relay.stop();
    assert!(
        input_commands(&fixture, 0).is_empty(),
        "input reached the browser"
    );
}

#[test]
fn with_control_on_each_message_becomes_exactly_its_actions_in_order() {
    let (fixture, mut relay) = started("", true);
    for message in session_input(false) {
        relay.send(message);
    }
    let to = json!({"type": "pointerMove", "x": 200, "y": 300, "origin": "viewport"});
    let mouse = |actions: Vec<Value>| json!({"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": actions});
    let keys = |events: &[(&str, &str)]| json!({"type": "key", "id": "keyboard", "actions": events.iter().map(|(kind, value)| json!({"type": kind, "value": value})).collect::<Vec<_>>()});
    let typed: Vec<_> = "ação 日本 😀"
        .chars()
        .flat_map(|c| [("keyDown", c.to_string()), ("keyUp", c.to_string())])
        .collect();
    let typed: Vec<_> = typed.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let expected = [
        mouse(vec![to.clone()]),
        mouse(vec![
            to.clone(),
            json!({"type": "pointerDown", "button": 0}),
        ]),
        mouse(vec![to.clone(), json!({"type": "pointerUp", "button": 0})]),
        json!({"type": "wheel", "id": "wheel", "actions": [{"type": "scroll", "x": 200, "y": 300, "deltaX": 0, "deltaY": 121, "origin": "viewport"}]}),
        keys(&typed),
        keys(&[("keyDown", "\u{E006}"), ("keyUp", "\u{E006}")]),
        keys(&[
            ("keyDown", "\u{E009}"),
            ("keyDown", "a"),
            ("keyUp", "a"),
            ("keyUp", "\u{E009}"),
        ]),
        mouse(vec![to, json!({"type": "pointerDown", "button": 2})]),
    ];
    let calls = input_commands(&fixture, expected.len());
    let received: Vec<_> = calls
        .iter()
        .map(|call| (call["method"].as_str().unwrap(), call["params"].clone()))
        .collect();
    let wanted: Vec<_> = expected
        .iter()
        .map(|source| {
            (
                "input.performActions",
                json!({"context": "C1", "actions": [source]}),
            )
        })
        .collect();
    assert_eq!(received, wanted);
    relay.stop();
    assert_every_command_is_allowed(&fixture, allow::bidi);
}

#[test]
fn turning_control_off_stops_forwarding_at_once_and_on_again_resumes_it() {
    let (fixture, mut relay) = started("", true);
    assert_control_gates_input(&mut relay, |count| input_commands(&fixture, count).len());
    relay.stop();
}

/// What Chrome refuses, Firefox refuses with the same class; a pinch is the one message Firefox has no mapping for.
#[test]
fn input_outside_its_bounds_a_clipboard_chord_a_pinch_or_an_unknown_message_is_refused() {
    let (fixture, mut relay) = started("", true);
    for message in [
        json!({"type": "wheel", "x": 413, "y": 10, "deltaX": 0, "deltaY": 1}),
        // Text that names keys would hold Control down for the rest of the text.
        json!({"type": "text", "text": "\u{E009}v"}),
        json!({"type": "key", "key": "v", "modifiers": 2}),
        json!({"type": "pinch", "scale": 2}),
        json!({"type": "dragEvent", "x": 1, "y": 1}),
        json!({"type": "key", "key": "a", "modifiers": 2}),
    ] {
        relay.send(message);
    }
    let mut counts = BTreeMap::new();
    // A reply at 1 and 2 of the classes that were refused twice, and at 1 of the one refused once.
    for _ in 0..5 {
        let (reason, count) = relay.refused();
        counts.insert(reason, count);
    }
    assert_eq!(
        counts,
        [
            ("InputOutOfRange".to_string(), 2),
            ("OperationRefused".to_string(), 2),
            ("PermissionRefused".to_string(), 1),
        ]
        .into()
    );
    // The valid key that came last is the only one that got through.
    let calls = input_commands(&fixture, 1);
    assert_eq!(calls.len(), 1, "{calls:?}");
    relay.stop();
}

/// Firefox rejected a sequence: whatever it pressed before it did is let go of, and that is not the browser
/// failing, however often it happens.
#[test]
fn a_rejected_sequence_is_released_and_the_session_goes_on() {
    let (fixture, mut relay) = started("input-error", true);
    for _ in 0..6 {
        relay.send(pointer("press", "left", 1, 10, 10));
    }
    let calls = input_commands(&fixture, 12);
    let methods: Vec<_> = calls
        .iter()
        .map(|call| call["method"].as_str().unwrap())
        .collect();
    assert_eq!(
        methods
            .iter()
            .filter(|m| **m == "input.performActions")
            .count(),
        6
    );
    assert_eq!(
        methods
            .iter()
            .filter(|m| **m == "input.releaseActions")
            .count(),
        6
    );
    for call in calls
        .iter()
        .filter(|call| call["method"] == "input.releaseActions")
    {
        assert_eq!(call["params"], json!({"context": "C1"}));
    }
    // Six failures in a row would have ended a failing capture; the view is still there.
    relay.next("frame");
    relay.stop();
    assert_every_command_is_allowed(&fixture, allow::bidi);
}

#[test]
fn a_page_that_stopped_changing_is_not_sent_again_but_is_still_watched() {
    let fixture = fixture();
    let relay = serve(&fixture, "same", "160.0");
    relay.next("frame");
    assert!(
        relay.quiet(QUIET * 2),
        "an unchanged page produced another frame"
    );
    let captures = fixture
        .methods()
        .iter()
        .filter(|method| *method == "browsingContext.captureScreenshot")
        .count();
    assert!(
        captures >= 3,
        "the page was not watched: {captures} captures"
    );
    relay.stop();
}

#[test]
fn a_hidden_view_stops_the_captures_and_showing_it_again_sends_a_frame() {
    let fixture = fixture();
    let mut relay = serve(&fixture, "same", "160.0");
    relay.next("frame");
    relay.send(json!({"type": "pause"}));
    assert_eq!(relay.next_json("state")["state"], "paused");
    let captures = || {
        fixture
            .methods()
            .iter()
            .filter(|method| *method == "browsingContext.captureScreenshot")
            .count()
    };
    // A request already on its way may still be answered; after that the browser is left alone.
    std::thread::sleep(QUIET);
    let before = captures();
    std::thread::sleep(QUIET * 2);
    assert_eq!(
        captures(),
        before,
        "captures continued while the view was hidden"
    );

    relay.send(json!({"type": "resume"}));
    assert_eq!(relay.next_json("state")["state"], "running");
    // The page did not change, yet the shown view must not stay empty.
    relay.next("frame");
    relay.stop();
}

/// Whatever ends the session, the relay ends the BiDi session first: a session that is left open blocks every
/// later client until Firefox exits.
#[test]
fn the_session_is_always_ended_and_then_the_browser_and_the_profile() {
    for (mode, reason, success) in [
        ("", "ClientClosed", true),
        ("signal", "ClientClosed", true),
        ("close", "PageClosed", true),
    ] {
        let fixture = fixture();
        let mut relay = serve(&fixture, mode, "160.0");
        relay.next("frame");
        match mode {
            "" => relay.close_input(),
            "signal" => relay.signal(libc::SIGTERM),
            _ => {}
        }
        assert_eq!(closed(&relay)["reason"], reason, "{mode}");
        assert_eq!(relay.exit().success(), success, "{mode}");
        assert_eq!(
            fixture.methods().last().map(String::as_str),
            Some("session.end"),
            "{mode}: the session was left open"
        );
        fixture.nothing_is_left();
    }
}

#[test]
fn a_browser_that_exits_ends_the_session_with_its_reason() {
    let fixture = fixture();
    let mut relay = serve(&fixture, "exit", "160.0");
    assert_eq!(closed(&relay)["reason"], "BrowserExited");
    assert!(!relay.exit().success());
    fixture.nothing_is_left();
}

#[test]
fn an_unsupported_version_is_named_and_its_session_ended() {
    let fixture = fixture();
    let mut relay = serve(&fixture, "", "158.0");
    let closing = closed(&relay);
    assert_eq!(closing["reason"], "BrowserVersionUnsupported");
    assert_eq!(closing["detail"], "Firefox/158.0");
    assert!(!relay.exit().success());
    assert_eq!(
        fixture.methods().last().map(String::as_str),
        Some("session.end")
    );
    fixture.nothing_is_left();
}

/// A browser that already holds a session cannot serve the relay and cannot be told to let go, so the relay
/// replaces it with one of its own, and the replaced one and its profile are gone.
#[test]
fn a_leaked_session_is_recovered_by_restarting_the_browser() {
    let fixture = fixture();
    let relay = serve(&fixture, "leak-first", "160.0");
    assert_eq!(relay.next_json("state")["state"], "running");
    relay.next("frame");
    assert_eq!(launches(&fixture), 2);
    let pids = pids(&fixture);
    assert_eq!(pids.len(), 4, "{pids:?}");
    for replaced in &pids[..2] {
        wait_gone(*replaced);
    }
    assert_eq!(
        fixture.profiles().len(),
        1,
        "the replaced browser's profile is still there"
    );
    relay.stop();
    fixture.nothing_is_left();
    pids.iter().for_each(|pid| wait_gone(*pid));
}

#[test]
fn a_browser_that_always_holds_a_session_ends_the_relay_with_a_reason_after_one_replacement() {
    let fixture = fixture();
    let mut relay = serve(&fixture, "leak-always", "160.0");
    assert_eq!(closed(&relay)["reason"], "BrowserSessionBusy");
    assert!(!relay.exit().success());
    assert_eq!(launches(&fixture), 2);
    pids(&fixture).iter().for_each(|pid| wait_gone(*pid));
    assert!(fixture.profiles().is_empty());
}

/// The first supported Firefox on `PATH`. `None` on a host that has none, or only an older one; the CI job sets
/// `LAZYSH_REQUIRE_FIREFOX=1` so that there its absence fails the test instead of skipping it.
fn firefox() -> Option<PathBuf> {
    let found = ["firefox", "firefox-esr"].iter().find_map(|name| {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    });
    // "Mozilla Firefox 160.0"
    let major = found.as_ref().and_then(|path| {
        let output = Command::new(path).arg("--version").output().ok()?;
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .last()?
            .split('.')
            .next()?
            .parse::<u32>()
            .ok()
    });
    let supported = found.filter(|_| major.is_some_and(|major| major >= MIN_FIREFOX));
    assert!(
        supported.is_some() || std::env::var_os("LAZYSH_REQUIRE_FIREFOX").is_none(),
        "LAZYSH_REQUIRE_FIREFOX is set and no Firefox {MIN_FIREFOX} or newer is on PATH"
    );
    if supported.is_none() {
        eprintln!("skipped: no Firefox {MIN_FIREFOX} or newer on PATH");
    }
    supported
}

/// A relay over the real Firefox, with a home of its own so that nothing it does reaches the host user's.
fn real(fixture: &Fixture, binary: &Path, home: &Path, page: &str) -> Relay {
    let mut relay = Relay::start(
        &fixture.state,
        &[("HOME", home)],
        &["--binary", binary.to_str().unwrap(), "--no-sandbox"],
    );
    relay.open_as("firefox", page);
    relay
}

/// A relay over the real Firefox, showing the fixture page of a server that the test keeps alive.
struct OnFixturePage {
    fixture: Fixture,
    relay: Relay,
    port: u16,
    _server: std::thread::JoinHandle<()>,
    _home: tempfile::TempDir,
}
impl OnFixturePage {
    fn start(binary: &Path, page: &'static str) -> Self {
        let (port, server) = fixture_page(page);
        let (fixture, home) = (Fixture::enabled(), tempfile::tempdir().unwrap());
        let url = format!("http://127.0.0.1:{port}/");
        Self {
            relay: real(&fixture, binary, home.path(), &url),
            fixture,
            port,
            _server: server,
            _home: home,
        }
    }
}

/// The real browser: its pixels, not a fake's, reach the client, and nothing is left behind.
#[test]
fn a_real_firefox_streams_the_fixture_page_and_leaves_nothing_behind() {
    let Some(binary) = firefox() else {
        return;
    };
    let mut shown = OnFixturePage::start(&binary, GREEN_PAGE);
    // The relay allows Firefox 30 seconds to start, before the BiDi session is established.
    let state = shown
        .relay
        .next_during("state", WAIT * 2)
        .json("state")
        .unwrap();
    assert_eq!(state["state"], "running");
    assert!(
        state["browser"].as_str().unwrap().starts_with("Firefox/"),
        "{state}"
    );
    let profile = shown.fixture.profiles().remove(0);
    wait_for_fixture(&mut shown.relay, shown.port);
    shown.relay.stop();
    assert_real_browser_is_gone(&profile);
}

/// The color at a point of the viewport, in the next frame that has one, until `wanted` accepts it.
fn wait_for_pixel(relay: &mut Relay, (x, y): (u32, u32), wanted: impl Fn([u8; 3]) -> bool) {
    // The waits for the page's title read the frames that came meanwhile, and a page that stopped changing sends
    // none: hiding the view and showing it again is what sends the current one.
    relay.send(json!({"type": "pause"}));
    assert_eq!(relay.next_json("state")["state"], "paused");
    relay.send(json!({"type": "resume"}));
    assert_eq!(relay.next_json("state")["state"], "running");
    let (deadline, mut seen) = (Instant::now() + WAIT, Vec::new());
    while Instant::now() < deadline {
        if let Some(Message::Frame { sequence, jpeg, .. }) = relay.within(Duration::from_secs(1)) {
            relay.send(json!({"type": "ack", "sequence": sequence}));
            let image = image::load_from_memory(&jpeg).unwrap().to_rgb8();
            let pixel = image.get_pixel(x, y).0;
            if wanted(pixel) {
                return;
            }
            seen.push(pixel);
        }
    }
    panic!("no frame ever showed the wanted color at {x},{y}; the frames showed {seen:?}");
}

/// The real browser takes the client's input through the relay: the page changes only because a tap, typed text
/// and a scroll arrived, a tap that came while Control was off did not, and the BiDi session is ended afterwards.
#[test]
fn a_real_firefox_takes_a_tap_typed_text_and_a_scroll_only_while_control_is_on() {
    let Some(binary) = firefox() else {
        return;
    };
    let mut shown = OnFixturePage::start(&binary, INPUT_PAGE);
    // The page turned the button blue, and a frame shows it.
    drive_input_page(&mut shown.relay, |relay| {
        wait_for_pixel(relay, (200, 100), |[red, _, blue]| blue > 150 && red < 60)
    });

    let profile = shown.fixture.profiles().remove(0);
    shown.relay.stop();
    assert_real_browser_is_gone(&profile);
}

/// Firefox allows one session. While the relay holds it a second client is refused, however it connects, and the
/// relay's view is not disturbed. The `Host` and `Origin` rules the relay's own connection depends on are checked
/// here too, on the Firefox the host has: a version that changed them would fail here, not in the field.
#[test]
fn a_real_firefox_refuses_a_second_client_while_the_relay_holds_the_session() {
    let Some(binary) = firefox() else {
        return;
    };
    let mut shown = OnFixturePage::start(&binary, GREEN_PAGE);
    shown.relay.next_during("frame", WAIT * 2);
    let endpoint = fs::read_to_string(
        shown
            .fixture
            .profiles()
            .remove(0)
            .join("WebDriverBiDiServer.json"),
    )
    .unwrap();
    let endpoint: Value = serde_json::from_str(&endpoint).unwrap();
    let firefox_port = endpoint["ws_port"].as_u64().unwrap() as u16;

    let (mut reader, writer) = bidi::connect(firefox_port, "/session").unwrap();
    writer
        .send(r#"{"id":1,"method":"session.new","params":{"capabilities":{}}}"#)
        .unwrap();
    let reply: Value = serde_json::from_str(&reader.read().unwrap().unwrap()).unwrap();
    assert_eq!(reply["type"], "error", "{reply}");
    assert_eq!(reply["error"], "session not created", "{reply}");

    for (header, why) in [
        ("Host: 127.0.0.1\r\n".to_string(), "a Host without the port"),
        (
            format!(
                "Host: 127.0.0.1:{firefox_port}\r\nOrigin: http://127.0.0.1:{firefox_port}\r\n"
            ),
            "an Origin",
        ),
    ] {
        let mut socket = TcpStream::connect(("127.0.0.1", firefox_port)).unwrap();
        write!(
            socket,
            "GET /session HTTP/1.1\r\n{header}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        .unwrap();
        let mut head = [0u8; 12];
        socket.read_exact(&mut head).unwrap();
        assert_eq!(&head, b"HTTP/1.1 400", "{why} was accepted");
    }
    // The relay's session is untouched: it still answers, and showing the view again sends a frame.
    shown.relay.send(json!({"type": "pause"}));
    assert_eq!(shown.relay.next_json("state")["state"], "paused");
    shown.relay.send(json!({"type": "resume"}));
    assert_eq!(shown.relay.next_json("state")["state"], "running");
    shown.relay.next("frame");
    shown.relay.stop();
}

/// A page can start a download on its own. Firefox cannot be told to refuse one over BiDi, so the profile makes a
/// headless Firefox write nothing: the page's bytes are served to the browser and no file appears anywhere.
#[test]
fn a_real_firefox_writes_no_download_to_the_host() {
    let Some(binary) = firefox() else {
        return;
    };
    let served = Arc::new(AtomicUsize::new(0));
    let counted = served.clone();
    let (port, _server) = fixture_server(move |request| {
        counted.fetch_add(request.contains("/download") as usize, Ordering::SeqCst);
        http_response(
            "Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"x.bin\"\r\n",
            "secret-download",
        )
    });
    let (fixture, home) = (Fixture::enabled(), tempfile::tempdir().unwrap());
    let relay = real(
        &fixture,
        &binary,
        home.path(),
        &format!("http://127.0.0.1:{port}/download"),
    );
    relay.next_during("state", WAIT * 2).json("state").unwrap();
    let profile = fixture.profiles().remove(0);
    // Long enough for Firefox to fetch the file and, as it does by default (measured), save it.
    let deadline = Instant::now() + WAIT;
    while served.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        served.load(Ordering::SeqCst) > 0,
        "the browser never asked for the download"
    );
    std::thread::sleep(Duration::from_secs(3));
    let saved = |root: &Path| {
        let mut files = Vec::new();
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
                match entry.file_type() {
                    Ok(kind) if kind.is_dir() => directories.push(entry.path()),
                    _ if entry.file_name().to_string_lossy().starts_with("x.bin") => {
                        files.push(entry.path());
                    }
                    _ => {}
                }
            }
        }
        files
    };
    assert_eq!(
        saved(home.path()),
        Vec::<PathBuf>::new(),
        "a download reached the host's home"
    );
    assert_eq!(
        saved(&profile),
        Vec::<PathBuf>::new(),
        "a download was kept in the profile"
    );
    relay.stop();
}

/// What a client that dropped without ending its session leaves behind, on a real Firefox: a browser that refuses
/// every later session until it exits. The relay must replace it with one of its own and then stream.
#[test]
fn a_real_firefox_holding_a_leaked_session_is_replaced_and_then_streams() {
    let Some(binary) = firefox() else {
        return;
    };
    let (port, _server) = fixture_page(GREEN_PAGE);
    let fixture = Fixture::with_fake(LEAKY_FIREFOX);
    enable(&fixture.state);
    let home = tempfile::tempdir().unwrap();
    let envs = [
        ("FAKE_BROWSER_DIR", fixture.directory.path()),
        ("REAL_FIREFOX", binary.as_path()),
        ("HOME", home.path()),
    ];
    let mut relay = Relay::start(
        &fixture.state,
        &envs,
        &["--binary", fixture.fake.to_str().unwrap(), "--no-sandbox"],
    );
    relay.open_as("firefox", &format!("http://127.0.0.1:{port}/"));
    assert_eq!(
        relay.next_during("state", WAIT * 4).json("state").unwrap()["state"],
        "running"
    );
    wait_for_fixture(&mut relay, port);
    // The first Firefox did hold a session (or the relay would not have needed a second one), and is gone.
    assert_eq!(launches(&fixture), 2);
    wait_gone(fixture.pid("leaked-pid"));
    let profile = fixture.profiles().remove(0);
    relay.stop();
    assert_real_browser_is_gone(&profile);
}

const START: &str = "http://127.0.0.1:3000/start";
const MAGENTA: [u8; 3] = [200, 0, 200];

/// A client of the stand-in Firefox, once its first frame and tab list are in.
fn client(fixture: &Fixture, mode: &str) -> Client {
    let mut client = Client::new(serve(fixture, mode, "160.0"));
    client.until("the first page", |known| {
        known.frames > 0 && !known.tabs().is_empty()
    });
    client
}

/// Wait until the stand-in's newest screenshot is of `context`: that is the page that streams.
fn streams(fixture: &Fixture, context: &str) {
    let deadline = Instant::now() + WAIT;
    loop {
        let newest = fixture
            .commands()
            .into_iter()
            .rfind(|call| call["method"] == "browsingContext.captureScreenshot");
        if newest.is_some_and(|call| call["params"]["context"] == context) {
            return;
        }
        assert!(Instant::now() < deadline, "{context} never streamed");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn navigation_messages_become_exactly_their_commands_and_stop_is_refused() {
    let fixture = fixture();
    let mut client = client(&fixture, "");
    assert_eq!(
        client.known.state["capabilities"],
        json!({
            "view": true,
            "control": true,
            "pinch": false,
            "composition": false,
            "navigation": true,
            "tabs": true,
            "stop": false,
            "unavailable": {"pinch": "NoPagePinch", "composition": "NoTextInsertion"},
        })
    );
    client.until("its title", |known| known.at("Fixture page", START));
    let address = "https://example.com/a";
    // Navigation is not input: Control stays off through all of it.
    for (message, wanted, page) in [
        (
            json!({"type": "navigate", "url": address}),
            json!({"context": "C1", "url": address, "wait": "none"}),
            ("Title of example.com/a", address),
        ),
        (
            json!({"type": "back"}),
            json!({"context": "C1", "delta": -1}),
            ("Fixture page", START),
        ),
        (
            json!({"type": "forward"}),
            json!({"context": "C1", "delta": 1}),
            ("Title of example.com/a", address),
        ),
        (
            json!({"type": "reload"}),
            json!({"context": "C1", "wait": "none"}),
            ("Title of example.com/a", address),
        ),
    ] {
        let before = fixture.made().len();
        let method = format!(
            "browsingContext.{}",
            match message["type"].as_str().unwrap() {
                "navigate" => "navigate",
                "reload" => "reload",
                _ => "traverseHistory",
            }
        );
        client.send(message);
        let calls = fixture.made_after(before, 1);
        assert_eq!(named(&calls), [method.as_str()]);
        assert_eq!(params(&calls, &method), &wanted);
        client.until("the page followed", |known| known.at(page.0, page.1));
    }
    // Firefox has no command to stop a load: refused and counted, nothing sent.
    let before = fixture.made().len();
    client.send(json!({"type": "stop"}));
    client.until("the refusal", |known| known.refused("OperationRefused", 1));
    assert_eq!(fixture.made().len(), before);
    // The end of the history is Firefox's error, which the relay takes as nothing to do.
    client.send(json!({"type": "back"}));
    client.send(json!({"type": "back"}));
    client.settled();
    assert!(client.known.closed.is_none());
    assert_every_command_is_allowed(&fixture, allow::bidi);
    client.relay.stop();
}

#[test]
fn an_address_outside_the_allowed_set_or_a_tab_never_listed_never_reaches_firefox() {
    let fixture = fixture();
    let mut client = client(&fixture, "");
    let before = fixture.made().len();
    let long = format!("https://a.test/{}", "a".repeat(2100));
    for address in [
        "file:///etc/hostname",
        "javascript:alert(1)",
        "data:text/html,hi",
        "about:config",
        "view-source:https://a.test/",
        "https://a.test/ a space",
        "",
        long.as_str(),
    ] {
        client.send(json!({"type": "navigate", "url": address}));
    }
    // A tab Firefox was never listed, and messages that name a field or a method the closed set lacks.
    client.send(json!({"type": "activateTab", "id": "C9"}));
    client.send(json!({"type": "closeTab", "id": "C9"}));
    client.send(json!({"type": "navigate", "url": "https://a.test/", "context": "C9"}));
    client.send(json!({"type": "reload", "ignoreCache": true}));
    client.ends_with_a_valid_address();
    let calls = fixture.made().split_off(before);
    assert_eq!(named(&calls), ["browsingContext.navigate"]);
    let sent = fixture.recorded("commands").unwrap();
    for never in ["C9", "file:", "javascript:", "data:", "about:config"] {
        assert!(!sent.contains(never), "{never} reached Firefox");
    }
    assert_every_command_is_allowed(&fixture, allow::bidi);
    client.relay.stop();
}

#[test]
fn a_popup_is_a_tab_and_switching_opening_and_closing_tabs_change_what_streams() {
    let fixture = fixture();
    let mut client = client(&fixture, "");
    let before = fixture.made().len();
    client.send(json!({"type": "navigate", "url": "http://fake.test/popup"}));
    // The page Firefox lists with the shown one as its opener takes the view, like in a browser.
    client.until("the popup is shown", |known| {
        known.ids() == ["C1", "C2"]
            && known.tabs["activeId"] == "C2"
            && known.shown()["title"] == "Title of 127.0.0.1:3000/popped"
    });
    let calls = fixture.made_after(before, 3);
    assert_eq!(
        named(&calls),
        [
            "browsingContext.navigate",
            "browsingContext.activate",
            "browsingContext.setViewport"
        ]
    );
    assert_eq!(
        params(&calls, "browsingContext.setViewport"),
        &json!({"context": "C2", "viewport": {"width": 412, "height": 915}, "devicePixelRatio": 1.0})
    );
    streams(&fixture, "C2");

    let before = fixture.made().len();
    client.send(json!({"type": "activateTab", "id": "C1"}));
    client.until("the first tab", |known| known.tabs["activeId"] == "C1");
    let calls = fixture.made_after(before, 2);
    assert_eq!(
        named(&calls),
        ["browsingContext.activate", "browsingContext.setViewport"]
    );
    assert_eq!(
        params(&calls, "browsingContext.activate"),
        &json!({"context": "C1"})
    );
    streams(&fixture, "C1");
    // Showing the page that is shown is not a switch.
    let made = fixture.made().len();
    client.send(json!({"type": "activateTab", "id": "C1"}));
    client.settled();
    assert_eq!(fixture.made().len(), made);

    client.send(json!({"type": "newTab"}));
    client.until("the new tab", |known| {
        known.ids() == ["C1", "C2", "C3"] && known.tabs["activeId"] == "C3"
    });
    assert_eq!(
        params(&fixture.made(), "browsingContext.create"),
        &json!({"type": "tab", "background": true})
    );
    streams(&fixture, "C3");

    // Closing the shown tab shows the last one; closing one that is not shown leaves the view alone.
    client.send(json!({"type": "closeTab", "id": "C3"}));
    client.until("the last tab is back", |known| {
        known.ids() == ["C1", "C2"] && known.tabs["activeId"] == "C2"
    });
    streams(&fixture, "C2");
    client.send(json!({"type": "closeTab", "id": "C1"}));
    client.until("the first tab is gone", |known| {
        known.ids() == ["C2"] && known.tabs["activeId"] == "C2"
    });
    // A browser keeps a page: the last one is replaced by a blank one first, and the session goes on.
    client.send(json!({"type": "closeTab", "id": "C2"}));
    client.until("a blank page replaces it", |known| {
        known.ids() == ["C4"] && known.tabs["activeId"] == "C4"
    });
    streams(&fixture, "C4");
    let calls = fixture.made();
    let created = calls
        .iter()
        .rposition(|call| call["method"] == "browsingContext.create")
        .unwrap();
    let closed = calls
        .iter()
        .position(|call| {
            call["method"] == "browsingContext.close" && call["params"]["context"] == "C2"
        })
        .unwrap();
    assert!(created < closed, "the blank page was made after the close");
    assert!(client.known.closed.is_none());
    assert_every_command_is_allowed(&fixture, allow::bidi);
    client.relay.stop();
}

#[test]
fn a_page_that_opens_windows_without_end_is_held_to_sixteen_tabs() {
    let fixture = fixture();
    let mut client = client(&fixture, "");
    client.send(json!({"type": "navigate", "url": "http://fake.test/popups"}));
    client.until("the list is full", |known| known.tabs().len() == 16);
    // The rest are closed again, and the list stays at the limit while Firefox keeps listing them.
    let deadline = Instant::now() + WAIT;
    while fixture
        .made()
        .iter()
        .filter(|call| call["method"] == "browsingContext.close")
        .count()
        < 5
    {
        assert!(Instant::now() < deadline, "the extra pages were not closed");
        std::thread::sleep(Duration::from_millis(20));
    }
    client.settled();
    assert_eq!(client.known.tabs().len(), 16);
    assert!(client.known.closed.is_none());
    client.relay.stop();
}

/// The real Firefox: two pages, then history, a reload, a second tab, and an address it must never be sent.
#[test]
fn a_real_firefox_navigates_goes_back_and_forward_reloads_and_switches_tabs() {
    let Some(binary) = firefox() else {
        return;
    };
    let site = Site::start();
    let (fixture, home) = (Fixture::enabled(), tempfile::tempdir().unwrap());
    let mut client = Client::new(real(&fixture, &binary, home.path(), &site.url("/start")));
    let (start, next, count) = (site.url("/start"), site.url("/next"), site.url("/count"));
    client.until("the start page", |known| {
        known.at("Start", &start) && known.shows(YELLOW)
    });
    assert_eq!(client.known.state["capabilities"]["navigation"], true);
    assert_eq!(client.known.state["capabilities"]["tabs"], true);
    let profile = fixture.profiles().remove(0);

    client.send(json!({"type": "navigate", "url": next}));
    client.until("the next page", |known| {
        known.at("Next", &next) && known.shows(MAGENTA)
    });
    client.send(json!({"type": "back"}));
    client.until("back", |known| {
        known.at("Start", &start) && known.shows(YELLOW)
    });
    client.send(json!({"type": "forward"}));
    client.until("forward", |known| {
        known.at("Next", &next) && known.shows(MAGENTA)
    });
    client.reloads_the_counting_page(&site, &count);

    // An address that is not a web page is refused by the relay: Firefox would have opened it.
    client.send(json!({"type": "navigate", "url": "file:///etc/hostname"}));
    client.until("the refusal", |known| known.refused("AddressRefused", 1));
    client.settled();
    assert!(client.known.at("count=2", &count));

    // A second tab takes the view and streams its own pixels; the first is shown again on request.
    let first = client.known.tabs()[0]["id"].as_str().unwrap().to_string();
    client.send(json!({"type": "newTab"}));
    client.until("the second tab", |known| known.tabs().len() == 2);
    let second = client.known.tabs["activeId"].as_str().unwrap().to_string();
    assert_ne!(first, second);
    let popup = site.url("/popup");
    client.send(json!({"type": "navigate", "url": popup}));
    client.until("the popup page", |known| {
        known.at("Popup", &popup) && known.shows(GREEN)
    });
    client.send(json!({"type": "activateTab", "id": first}));
    client.until("the first tab again", |known| {
        known.tabs["activeId"] == first.as_str() && known.at("count=2", &count)
    });
    client.send(json!({"type": "closeTab", "id": second}));
    client.until("one tab", |known| known.ids() == [first.as_str()]);
    assert!(client.known.closed.is_none());
    assert_eq!(client.known.refusals, [("AddressRefused".to_string(), 1)]);
    client.relay.stop();
    assert_real_browser_is_gone(&profile);
}

/// The capture requests the stand-in Firefox received, in order.
fn captures(fixture: &Fixture) -> Vec<Value> {
    fixture
        .commands()
        .into_iter()
        .filter(|command| command["method"] == "browsingContext.captureScreenshot")
        .collect()
}

fn wait_for_rung(relay: &Relay, rung: &str, pinned: bool) {
    let quality = relay.next_json("quality");
    assert_eq!(
        (quality["rung"].as_str(), quality["pinned"].as_bool()),
        (Some(rung), Some(pinned))
    );
}

/// A pinned rung (Data saver) is what the browser is asked for: the JPEG quality of each capture, how often it is
/// captured, and the frame size (the device pixel ratio), and `auto` gives the top rung back.
#[test]
fn a_rung_sets_the_capture_quality_the_pace_and_the_frame_size() {
    let fixture = fixture();
    let mut relay = serve(&fixture, "", "160.0");
    wait_for_rung(&relay, "high", false);
    // Pinned: a device that acknowledges nothing would step an adaptive ladder down within a second.
    relay.send(json!({"type": "quality", "rung": "high"}));
    wait_for_rung(&relay, "high", true);
    let over = |seconds: u64| {
        let before = captures(&fixture).len();
        std::thread::sleep(Duration::from_secs(seconds));
        captures(&fixture).len() - before
    };
    assert!(over(1) > 0, "nothing was captured");
    let last =
        |fixture: &Fixture| captures(fixture).pop().unwrap()["params"]["format"]["quality"].clone();
    assert_eq!(last(&fixture), json!(0.6));

    relay.send(json!({"type": "quality", "rung": "minimal"}));
    wait_for_rung(&relay, "minimal", true);
    std::thread::sleep(QUIET);
    let at_minimal = over(2);
    assert_eq!(last(&fixture), json!(0.35));
    // Every sixth frame of 60 a second: one capture every 100 ms, against one every 50 ms at the top.
    assert!(at_minimal <= 24, "{at_minimal} captures in 2 s");
    let resized: Vec<_> = fixture
        .commands()
        .into_iter()
        .filter(|command| command["method"] == "browsingContext.setViewport")
        .map(|command| command["params"].clone())
        .collect();
    // The page is laid out at the same size, and only its pixel density goes down.
    assert_eq!(resized.last().unwrap()["devicePixelRatio"], json!(0.75));
    assert_eq!(
        resized.last().unwrap()["viewport"],
        json!({"width": 412, "height": 915})
    );

    relay.send(json!({"type": "quality", "rung": "auto"}));
    wait_for_rung(&relay, "high", false);
    std::thread::sleep(QUIET);
    assert_eq!(last(&fixture), json!(0.6));
    let ratio = fixture
        .commands()
        .into_iter()
        .rfind(|command| command["method"] == "browsingContext.setViewport")
        .unwrap()["params"]["devicePixelRatio"]
        .clone();
    assert_eq!(ratio, json!(1.0));
    relay.stop();
}

/// A device that acknowledges nothing is a link that cannot carry the frames: the ladder steps down within a
/// second and settles on the lowest rung within five.
#[test]
fn a_device_that_acknowledges_nothing_steps_the_rung_down_to_the_lowest() {
    let fixture = fixture();
    let mut relay = serve(&fixture, "", "160.0");
    relay.next("state");
    assert_settles_on(
        &mut relay,
        (1000.0, Duration::from_secs(3600)),
        Duration::from_secs(6),
        ("minimal", true),
    );
    relay.stop();
}

/// A page that changes every frame with noise a JPEG cannot shrink: its frames are big enough for a slow link to
/// matter.
const NOISE_PAGE: &str = "<!doctype html><title>Noise</title><style>body{margin:0}canvas{display:block}</style>
<canvas width=412 height=915></canvas>
<script>
const context = document.querySelector('canvas').getContext('2d');
const draw = () => {
  for (let i = 0; i < 400; i++) {
    context.fillStyle = `rgb(${Math.random() * 255 | 0},${Math.random() * 255 | 0},${Math.random() * 255 | 0})`;
    context.fillRect(Math.random() * 412, Math.random() * 915, 60, 60);
  }
  requestAnimationFrame(draw);
};
draw();
</script>";

/// A page that animates the way the feasibility measurements did (moving blocks, no heavy script), so that the
/// cost measured is the capture's and not the page's.
const MOVING_PAGE: &str = "<!doctype html><title>Moving</title>
<style>body{margin:0;overflow:hidden}div{position:absolute;width:80px;height:80px;animation:m 1.3s linear infinite alternate}
@keyframes m{from{transform:translate(0,0) rotate(0)}to{transform:translate(320px,820px) rotate(90deg)}}</style>
<script>
for (let i = 0; i < 20; i++) {
  document.write(`<div style=\"left:${i * 20}px;background:hsl(${i * 18},80%,50%);animation-delay:-${i * 60}ms\"></div>`);
}
</script>";

/// The real Firefox over shaped links, with the harness of the Chrome ladder: the rung it settles on, and how soon.
fn real_firefox_settles_on(mbps: f64, round_trip_ms: u64, rung: &str) {
    let Some(binary) = firefox() else {
        return;
    };
    let mut shown = OnFixturePage::start(&binary, NOISE_PAGE);
    shown.relay.next_during("state", WAIT * 2);
    assert_settles_on(
        &mut shown.relay,
        (mbps, Duration::from_millis(round_trip_ms)),
        Duration::from_secs(8),
        (rung, false),
    );
    shown.relay.stop();
}

#[test]
fn a_real_firefox_on_a_fast_link_keeps_the_highest_rung() {
    real_firefox_settles_on(50.0, 10, "high");
}

#[test]
fn a_real_firefox_on_a_slow_link_settles_on_the_lowest_rung_within_five_seconds() {
    real_firefox_settles_on(1.5, 150, "minimal");
}

/// The CPU the relay and every process under it used, in seconds (Linux: `/proc`).
#[cfg(target_os = "linux")]
fn cpu_seconds(root: u32) -> f64 {
    let processes: Vec<(u32, u32, u64)> = fs::read_dir("/proc")
        .unwrap()
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse::<u32>().ok()?;
            let text = fs::read_to_string(entry.path().join("stat")).ok()?;
            // The command name can hold spaces and brackets: the fields start after its last bracket.
            let fields: Vec<_> = text[text.rfind(')')? + 2..].split_whitespace().collect();
            let (user, system) = (
                fields[11].parse::<u64>().ok()?,
                fields[12].parse::<u64>().ok()?,
            );
            Some((pid, fields[1].parse().ok()?, user + system))
        })
        .collect();
    let (mut tree, mut ticks) = (vec![root], 0);
    while let Some(pid) = tree.pop() {
        for (child, parent, own) in &processes {
            if *child == pid {
                ticks += own;
            }
            if *parent == pid {
                tree.push(*child);
            }
        }
    }
    // SAFETY: sysconf only reads a constant.
    ticks as f64 / unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64
}

/// The host's cost of one rung on a page that moves every frame, as a share of one core (the relay and every
/// Firefox process together), in a Firefox of its own: one that served other rungs before costs more (measured), so
/// rungs are not compared inside one.
#[cfg(target_os = "linux")]
fn cpu_share(binary: &Path, rung: &str) -> f64 {
    let mut shown = OnFixturePage::start(binary, MOVING_PAGE);
    shown.relay.next_during("state", WAIT * 2);
    let fast = |relay: &mut Relay, seconds| {
        over_link(
            relay,
            50.0,
            Duration::from_millis(10),
            Duration::from_secs(seconds),
        )
    };
    shown.relay.send(json!({"type": "quality", "rung": rung}));
    // Firefox's first seconds on a page cost more than the stream does.
    fast(&mut shown.relay, 4);
    let pid = shown.relay.child.id();
    let before = cpu_seconds(pid);
    fast(&mut shown.relay, 5);
    let share = (cpu_seconds(pid) - before) / 5.0 * 100.0;
    shown.relay.stop();
    share
}

/// At the highest rung, 20 captures a second of a page that moves every frame leave the host under one core.
#[cfg(target_os = "linux")]
#[test]
fn a_real_firefox_stays_under_one_core_at_the_highest_rung() {
    let Some(binary) = firefox() else {
        return;
    };
    let share = cpu_share(&binary, "high");
    assert!(share < 100.0, "{share} percent of one core");
}

/// The table of `docs/reference/host-browser-feasibility.md`: `cargo test -p lazysh-agent --test
/// host_browser_relay -- --ignored --nocapture cpu_by_rung`. A measurement, not a check: it asserts nothing.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "a measurement for the feasibility document"]
fn cpu_by_rung() {
    let Some(binary) = firefox() else {
        return;
    };
    for rung in ["high", "balanced", "low", "minimal"] {
        eprintln!(
            "{rung}: {:.0} percent of one core",
            cpu_share(&binary, rung)
        );
    }
}
