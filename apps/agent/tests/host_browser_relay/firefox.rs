//! The Firefox adapter of the host browser relay, driven the way the Chrome one is: through the real relay process
//! and its standard input and output, over a stand-in Firefox that speaks WebDriver BiDi (exact commands, leaked
//! sessions, versions) and over a real Firefox where the host has one.
use super::*;
use lazysh_agent::host_browser::bidi;
use std::{
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
    assert_eq!(state["capabilities"]["control"], false);
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

/// This adapter reports `control: false`: a client that turns Control on anyway, and every valid input message,
/// is refused and counted, and nothing but the view's own commands reaches the browser.
#[test]
fn control_and_input_are_refused_while_the_adapter_cannot_take_them() {
    let fixture = fixture();
    let mut relay = serve(&fixture, "", "160.0");
    relay.next("frame");
    relay.control(true);
    for message in one_of_each_input() {
        relay.send(message);
    }
    // Six messages: a reply at count 1, 2 and 4.
    for count in [1, 2, 4] {
        assert_eq!(relay.refused(), ("OperationRefused".to_string(), count));
    }
    relay.stop();
    assert!(
        !fixture
            .methods()
            .iter()
            .any(|method| method.starts_with("input.")),
        "input reached the browser: {:?}",
        fixture.methods()
    );
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
    fn start(binary: &Path) -> Self {
        Self::start_with(binary, GREEN_PAGE)
    }
    fn start_with(binary: &Path, page: &'static str) -> Self {
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
    let mut shown = OnFixturePage::start(&binary);
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

/// Firefox allows one session. While the relay holds it a second client is refused, however it connects, and the
/// relay's view is not disturbed. The `Host` and `Origin` rules the relay's own connection depends on are checked
/// here too, on the Firefox the host has: a version that changed them would fail here, not in the field.
#[test]
fn a_real_firefox_refuses_a_second_client_while_the_relay_holds_the_session() {
    let Some(binary) = firefox() else {
        return;
    };
    let mut shown = OnFixturePage::start(&binary);
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
    let mut shown = OnFixturePage::start_with(&binary, NOISE_PAGE);
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
    let mut shown = OnFixturePage::start_with(binary, MOVING_PAGE);
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
