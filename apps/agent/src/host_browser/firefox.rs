//! The Firefox adapter of the host browser relay (docs/host-browser.md, "Adapters and capabilities").
//!
//! Firefox has no pipe mode and no push screencast, so the relay starts it with a private profile and a random
//! loopback port, finds the port in the profile, speaks WebDriver BiDi over [`bidi`], and polls
//! `browsingContext.captureScreenshot`, pipelined, skipping repeats. Firefox allows one BiDi session at a time, and
//! a session that was never ended blocks every later client until Firefox exits (measured), so the relay always
//! ends its session, and a browser that already holds one is replaced by a new one the relay owns.
//!
//! Everything the relay sends goes through [`allow::bidi`]. The client sees the same wire format as for Chrome.
use super::{
    allow, bidi, die_with_launcher, find_in, input,
    ladder::{Ladder, Rung, Screencast},
    outbox::Outbox,
    own_process_group, profile,
    relay::{
        announce_page, await_reply, bounded, major, refuse, report_quality, running_state, Event,
        Handler, Running, Serve, CLIENT_CLOSED, TICK,
    },
    wire::{self, Client, Viewport},
    FIREFOX_CANDIDATES,
};
use crate::{Error, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// The oldest Firefox this adapter was exercised on. An older one is named and refused, never guessed at.
const MIN_VERSION: u32 = 159;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const PORT_FILE: &str = "WebDriverBiDiServer.json";
/// Screenshot requests in flight at once: enough that the round trip does not pace the browser.
const PIPELINE: usize = 2;
/// Between screenshot requests at most (20 a second): what a static page costs the host is measured in
/// `docs/reference/host-browser-feasibility.md`, and 60 a second on an animated page took 73 percent of a core.
const BASE_INTERVAL: Duration = Duration::from_millis(50);
/// The ladder's frame divisor is against a page that changes 60 times a second, as for Chrome.
const FRAME: Duration = Duration::from_micros(16_667);
/// Between screenshot requests once the page has stopped changing (never shorter than the rung's own interval).
const IDLE_INTERVAL: Duration = Duration::from_millis(250);
const IDLE_AFTER: u32 = 8;
const PAGE_POLL: Duration = Duration::from_secs(1);
const END_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_ERRORS: u32 = 5;
/// The realm the title is read in: a page's own script cannot see it or replace what it reads.
const SANDBOX: &str = "lazysh";
/// Firefox's answer to `session.new` while another session exists.
const BUSY: &str = "session not created";

/// What `open` asked for, already validated by the relay.
pub(super) struct Open<'a> {
    pub options: &'a Serve<'a>,
    pub headed: bool,
    pub viewport: Viewport,
    pub url: &'a str,
}

/// The preferences a managed Firefox starts with, as `user.js` in its private profile: nothing is reported or
/// updated, no permission is granted, and a download is neither asked for nor kept. A headless Firefox cannot show
/// the save dialog, so nothing is written (checked on a real Firefox); a dialog on a headed host would offer the
/// profile, which is removed with the session.
fn preferences(profile: &std::path::Path) -> String {
    let downloads = serde_json::to_string(&profile.join("downloads")).unwrap_or_default();
    let mut text = format!(
        "user_pref(\"browser.download.useDownloadDir\", false);\n\
         user_pref(\"browser.download.folderList\", 2);\n\
         user_pref(\"browser.download.dir\", {downloads});\n"
    );
    for name in [
        "permissions.default.camera",
        "permissions.default.microphone",
        "permissions.default.geo",
        "permissions.default.desktop-notification",
        "permissions.default.xr",
    ] {
        text.push_str(&format!("user_pref(\"{name}\", 2);\n"));
    }
    for name in [
        "app.update.auto",
        "app.normandy.enabled",
        "browser.shell.checkDefaultBrowser",
        "datareporting.policy.dataSubmissionEnabled",
        "datareporting.healthreport.uploadEnabled",
        "toolkit.telemetry.enabled",
        "network.captive-portal-service.enabled",
        "extensions.update.enabled",
    ] {
        text.push_str(&format!("user_pref(\"{name}\", false);\n"));
    }
    text
}

/// The BiDi port Firefox wrote into its profile once it listened: loopback only, or it is not used.
fn read_port(profile: &std::path::Path) -> Result<Option<u16>> {
    let Ok(text) = fs::read_to_string(profile.join(PORT_FILE)) else {
        return Ok(None);
    };
    let Ok(endpoint) = serde_json::from_str::<Value>(&text) else {
        // Written in place: the file can be read half done.
        return Ok(None);
    };
    match (endpoint["ws_host"].as_str(), endpoint["ws_port"].as_u64()) {
        (Some("127.0.0.1"), Some(port @ 1..=65535)) => Ok(Some(port as u16)),
        _ => Err(Error::Browser("BrowserEndpointInvalid")),
    }
}

/// Firefox's BiDi connection and its calls. Every command passes the allow-list before it is written.
struct Bidi {
    writer: bidi::Writer,
    next: u64,
}
impl Bidi {
    fn send(&mut self, method: &str, params: Value) -> Result<u64> {
        allow::bidi(method, &params).map_err(|refusal| Error::Browser(refusal.reason()))?;
        self.next += 1;
        let message = json!({"id": self.next, "method": method, "params": params});
        self.writer.send(&message.to_string())?;
        Ok(self.next)
    }
}

struct Link<'a> {
    bidi: Bidi,
    inbox: &'a mpsc::Receiver<Event>,
    /// Everything that arrived while a call waited, handled in order once the stream runs.
    backlog: &'a mut VecDeque<Event>,
}
impl Link<'_> {
    /// The whole reply, `type` and all, so that a caller can tell one kind of error from another.
    fn reply(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.bidi.send(method, params)?;
        await_reply(self.inbox, self.backlog, id)
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let mut reply = self.reply(method, params)?;
        if reply["type"] == "error" {
            Err(Error::Browser("BrowserProtocolError"))
        } else {
            Ok(reply["result"].take())
        }
    }
}

/// A started Firefox with its one BiDi session. Dropping it ends the session, then the browser, then the profile.
struct Launched<'a> {
    link: Link<'a>,
    /// Whether the reader thread may still report; cleared before the browser ends, so that a browser the
    /// relay replaced cannot look like the new one exiting.
    _live: Live,
    // In this order: the browser ends before its profile is removed.
    _browser: Running,
    _profile: profile::Profile,
    product: String,
    context: String,
}
impl Drop for Launched<'_> {
    /// End the session, whatever ended the relay, and wait a moment for Firefox to say so.
    fn drop(&mut self) {
        if let Ok(id) = self.link.bidi.send("session.end", json!({})) {
            let deadline = Instant::now() + END_TIMEOUT;
            while let Ok(event) = self
                .link
                .inbox
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                match event {
                    Event::Browser(message) if message["id"] == id => break,
                    Event::BrowserGone => break,
                    _ => {}
                }
            }
        }
        self.link.bidi.writer.close();
    }
}

struct Live(Arc<AtomicBool>);
impl Drop for Live {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn spawn_reader(mut reader: bidi::Reader, events: mpsc::Sender<Event>, live: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let end = loop {
            match reader.read() {
                Ok(Some(text)) => {
                    // Not JSON is not a message: dropped, as a CDP line that does not parse is.
                    let Ok(message) = serde_json::from_str(&text) else {
                        continue;
                    };
                    if !live.load(Ordering::SeqCst) || events.send(Event::Browser(message)).is_err()
                    {
                        return;
                    }
                }
                Ok(None) | Err(_) => break Event::BrowserGone,
            }
        };
        if live.load(Ordering::SeqCst) {
            let _ = events.send(end);
        }
    });
}

/// Wait for Firefox to write its port, while the client may still leave or break the framing.
fn wait_for_port(
    profile: &std::path::Path,
    browser: &mut Running,
    inbox: &mpsc::Receiver<Event>,
    backlog: &mut VecDeque<Event>,
) -> Result<u16> {
    let started = Instant::now();
    loop {
        if let Some(port) = read_port(profile)? {
            return Ok(port);
        }
        match inbox.recv_timeout(Duration::from_millis(25)) {
            Ok(Event::Stop | Event::ClientGone) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Error::Browser(CLIENT_CLOSED));
            }
            Ok(Event::Violation) => return Err(Error::Browser("ProtocolViolation")),
            Ok(event @ Event::Client(_)) => backlog.push_back(event),
            Ok(Event::Browser(_) | Event::BrowserGone) | Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if browser.0.try_wait()?.is_some() {
            return Err(Error::Browser("BrowserExited"));
        }
        if started.elapsed() > START_TIMEOUT {
            return Err(Error::Browser("BrowserStartTimeout"));
        }
    }
}

/// Start Firefox, connect, and create the session. `BrowserSessionBusy` means the browser already held one.
fn launch<'a>(
    open: &Open,
    binary: &std::path::Path,
    events: &mpsc::Sender<Event>,
    inbox: &'a mpsc::Receiver<Event>,
    backlog: &'a mut VecDeque<Event>,
    detail: &mut Option<String>,
) -> Result<Launched<'a>> {
    // Declared in the order they are released in reverse: the reporting thread is silenced, then the browser
    // ends, then its profile is removed.
    let profile = profile::create(open.options.state, false)?;
    fs::write(profile.path().join("user.js"), preferences(profile.path()))?;
    let mut command = Command::new(binary);
    if !open.headed {
        command.arg("--headless");
    }
    command
        .args(["--no-remote", "--profile"])
        .arg(profile.path())
        .args(["--remote-debugging-port", "0"])
        .arg(open.url)
        // Never on: it lets a page's script reach the browser itself (docs/host-browser.md, "Managed browser").
        .env_remove("MOZ_REMOTE_ALLOW_SYSTEM_ACCESS")
        // A crash report names the pages that were open, and goes to the host's own profile directory.
        .env("MOZ_CRASHREPORTER_DISABLE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // The browser's own messages can name pages, so they are not kept.
        .stderr(Stdio::null());
    if open.options.no_sandbox {
        command.env("MOZ_DISABLE_CONTENT_SANDBOX", "1");
    }
    own_process_group(&mut command);
    die_with_launcher(&mut command);
    let mut browser = Running(command.spawn()?);
    let port = wait_for_port(profile.path(), &mut browser, inbox, backlog)?;
    let (reader, writer) = bidi::connect(port, "/session")
        .map_err(|_| Error::Browser("BrowserEndpointUnreachable"))?;
    let live = Arc::new(AtomicBool::new(true));
    let guard = Live(live.clone());
    spawn_reader(reader, events.clone(), live);

    let mut link = Link {
        bidi: Bidi { writer, next: 0 },
        inbox,
        backlog,
    };
    let reply = link.reply(
        "session.new",
        json!({"capabilities": {"alwaysMatch": {
            "acceptInsecureCerts": false,
            // A dialog is dismissed until the client can answer it: a page must not hang on one.
            "unhandledPromptBehavior": {"default": "dismiss"},
        }}}),
    )?;
    if reply["type"] == "error" {
        return Err(Error::Browser(if reply["error"] == BUSY {
            "BrowserSessionBusy"
        } else {
            "BrowserProtocolError"
        }));
    }
    let capabilities = &reply["result"]["capabilities"];
    let product = format!(
        "Firefox/{}",
        bounded(
            capabilities["browserVersion"].as_str().unwrap_or_default(),
            32
        )
    );
    let launched = Launched {
        link,
        _live: guard,
        _browser: browser,
        _profile: profile,
        product,
        context: String::new(),
    };
    // The session exists: `launched` ends it on every error below.
    if capabilities["browserName"] != "firefox"
        || major(&launched.product).is_none_or(|major| major < MIN_VERSION)
    {
        *detail = Some(bounded(&launched.product, 64));
        return Err(Error::Browser("BrowserVersionUnsupported"));
    }
    Ok(launched)
}

/// Serve one client over a managed Firefox until it leaves or the browser does; the value is the reason.
pub(super) fn session(
    open: &Open,
    outbox: &Arc<Outbox>,
    detail: &mut Option<String>,
    events: &mpsc::Sender<Event>,
    inbox: &mpsc::Receiver<Event>,
) -> Result<&'static str> {
    let binary = find_in(open.options.binary, &FIREFOX_CANDIDATES)?;
    let mut backlog = VecDeque::new();
    // A browser that already holds a session cannot serve this one, and cannot be told to let go: replace it with
    // one the relay starts. Once only, so that a browser that always holds one ends the session with a reason.
    let mut replaced = false;
    let mut launched = loop {
        let error = match launch(open, &binary, events, inbox, &mut backlog, detail) {
            Ok(launched) => break launched,
            Err(error) => error,
        };
        if replaced || error.class() != "BrowserSessionBusy" {
            return Err(error);
        }
        replaced = true;
        // What the browser that was just replaced said is no longer true.
        backlog.extend(inbox.try_iter());
        backlog.retain(|event| !matches!(event, Event::Browser(_) | Event::BrowserGone));
    };
    let tree = launched.link.call("browsingContext.getTree", json!({}))?;
    launched.context = tree["contexts"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|context| context["parent"].is_null())
        .and_then(|context| context["context"].as_str())
        .ok_or(Error::Browser("BrowserNoPage"))?
        .to_string();
    let viewport = open.viewport;
    launched.link.call(
        "browsingContext.setViewport",
        json!({
            "context": launched.context,
            "viewport": {"width": viewport.width, "height": viewport.height},
            "devicePixelRatio": viewport.scale,
        }),
    )?;
    outbox.control(running_state(
        &launched.product,
        viewport,
        json!({
            "view": true,
            "control": true,
            "pinch": false,
            "composition": false,
            "navigation": false,
            "tabs": false,
            // Why, so that the viewer can say it and hide the control: Firefox did not scale the page when two
            // touch pointers spread (headless probe), and BiDi has neither `insertText` nor composition.
            "unavailable": {"pinch": "NoPagePinch", "composition": "NoTextInsertion"},
        }),
    ));
    Stream::new(&mut launched, outbox, viewport).run()
}

enum Pending {
    Capture,
    Tree,
    Title,
    /// An `input.performActions`; when it fails, what it left held is released.
    Input,
    Release,
    /// The device pixel ratio that gives a rung its frame size; the reply carries nothing.
    Viewport,
}

struct Stream<'l, 'a> {
    launched: &'l mut Launched<'a>,
    outbox: &'l Arc<Outbox>,
    viewport: Viewport,
    paused: bool,
    /// What the rung asks of the browser now, and what the client was last told about the rung.
    ladder: Ladder,
    screencast: Screencast,
    quality: Option<(Rung, bool)>,
    sequence: u32,
    /// Refused client messages, by reason and count: never their content.
    refused: BTreeMap<&'static str, u64>,
    /// Control is off when a session starts, and only the client turns it on.
    control: bool,
    limit: input::Limit,
    pending: Vec<(u64, Pending)>,
    /// The last frame sent, and how many captures in a row matched it.
    last: Vec<u8>,
    same: u32,
    next_capture: Instant,
    polled: Instant,
    errors: u32,
    page: (String, String),
    /// The page's title and address as last read, before they are cut for the client.
    read: (String, String),
}
impl<'l, 'a> Stream<'l, 'a> {
    fn new(launched: &'l mut Launched<'a>, outbox: &'l Arc<Outbox>, viewport: Viewport) -> Self {
        let now = Instant::now();
        let mut ladder = Ladder::new(now);
        Self {
            launched,
            outbox,
            viewport,
            paused: false,
            screencast: ladder.apply(now),
            ladder,
            quality: None,
            sequence: 0,
            refused: BTreeMap::new(),
            control: false,
            limit: input::Limit::new(now),
            pending: Vec::new(),
            last: Vec::new(),
            same: 0,
            next_capture: now,
            polled: now,
            errors: 0,
            page: Default::default(),
            read: Default::default(),
        }
    }

    // shortcut: no watchdog on a Firefox that stops answering; its requests wait until the channel closes, which
    // ends it, and the page and capture polls add two entries a second meanwhile. Upgrade when it is seen.
    fn request(&mut self, method: &str, params: Value, kind: Pending) -> Result<()> {
        let id = self.launched.link.bidi.send(method, params)?;
        self.pending.push((id, kind));
        Ok(())
    }

    fn capturing(&self) -> usize {
        self.pending
            .iter()
            .filter(|(_, kind)| matches!(kind, Pending::Capture))
            .count()
    }

    fn capture_due(&self) -> Option<Instant> {
        (!self.paused && self.capturing() < PIPELINE).then_some(self.next_capture)
    }

    fn poll_due(&self) -> Option<Instant> {
        (!self.paused).then_some(self.polled + PAGE_POLL)
    }

    /// Handle events until the session ends; the value is the reason it ended.
    fn run(&mut self) -> Result<&'static str> {
        loop {
            let now = Instant::now();
            if !self.paused {
                if let Some(screencast) = self.ladder.tick(now) {
                    self.fit(screencast)?;
                }
            }
            report_quality(&self.ladder, &mut self.quality, self.outbox);
            if self.capture_due().is_some_and(|due| due <= now) {
                let context = self.launched.context.clone();
                let interval = (FRAME * self.screencast.every_nth).max(BASE_INTERVAL);
                self.next_capture = now
                    + if self.same >= IDLE_AFTER {
                        interval.max(IDLE_INTERVAL)
                    } else {
                        interval
                    };
                self.request(
                    "browsingContext.captureScreenshot",
                    json!({
                        "context": context,
                        "origin": "viewport",
                        "format": {
                            "type": "image/jpeg",
                            "quality": f64::from(self.screencast.quality) / 100.0,
                        },
                    }),
                    Pending::Capture,
                )?;
            }
            if self.poll_due().is_some_and(|due| due <= now) {
                self.polled = now;
                self.poll_page()?;
            }
            let event = match self.launched.link.backlog.pop_front() {
                Some(event) => event,
                None => {
                    let wake = [self.capture_due(), self.poll_due()]
                        .into_iter()
                        .flatten()
                        .min()
                        .map_or(PAGE_POLL, |due| due.saturating_duration_since(now))
                        .min(TICK);
                    match self.launched.link.inbox.recv_timeout(wake) {
                        Ok(event) => event,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(CLIENT_CLOSED),
                    }
                }
            };
            if let Some(reason) = self.handle(event)? {
                return Ok(reason);
            }
        }
    }

    /// Take the rung's parameters. Quality and pace apply to the next capture; the frame size is the device pixel
    /// ratio, because BiDi's capture has a clip but no scale (a clip would cut the page the pointer maps onto).
    fn fit(&mut self, screencast: Screencast) -> Result<()> {
        let resized = screencast.percent != self.screencast.percent;
        self.screencast = screencast;
        if resized {
            let viewport = self.viewport;
            self.request(
                "browsingContext.setViewport",
                json!({
                    "context": self.launched.context,
                    "viewport": {"width": viewport.width, "height": viewport.height},
                    "devicePixelRatio": viewport.scale * screencast.percent as f32 / 100.0,
                }),
                Pending::Viewport,
            )?;
        }
        Ok(())
    }

    /// `getTree` has no title, so it is one read of `document.title` in the relay's own realm.
    fn poll_page(&mut self) -> Result<()> {
        let context = self.launched.context.clone();
        self.request("browsingContext.getTree", json!({}), Pending::Tree)?;
        self.request(
            "script.evaluate",
            json!({
                "expression": allow::TITLE_EXPRESSION,
                "awaitPromise": false,
                "target": {"context": context, "sandbox": SANDBOX},
            }),
            Pending::Title,
        )
    }

    /// No request goes out while hidden, and the first one after showing it again sends a frame, changed or not.
    fn pause(&mut self, paused: bool) -> Result<()> {
        if paused == self.paused {
            return Ok(());
        }
        self.paused = paused;
        self.outbox.pause(paused);
        self.last.clear();
        self.same = 0;
        self.next_capture = Instant::now();
        self.polled = Instant::now();
        self.outbox
            .control(json!({"type": "state", "state": if paused { "paused" } else { "running" }}));
        if paused {
            return Ok(());
        }
        // A shown view starts from what the ladder wants now, as a restarted screencast does.
        let screencast = self.ladder.apply(Instant::now());
        self.fit(screencast)
    }

    /// One input message: refused while Control is off, outside the bounds or in a flood, else its call.
    // shortcut: turning Control off while a button is held leaves it held until the next click, as in Chrome;
    // upgrade when the viewer can start a drag and switch Control off in the same gesture.
    fn input(&mut self, message: &Client) -> Result<()> {
        if !self.control {
            self.refuse(input::CONTROL_OFF);
            return Ok(());
        }
        match input::bidi_commands(message, self.viewport) {
            Err(reason) => self.refuse(reason),
            Ok(_) if !self.limit.take(Instant::now()) => self.refuse(input::RATE_LIMITED),
            Ok(calls) => {
                for (method, mut params) in calls {
                    params["context"] = self.launched.context.clone().into();
                    self.request(method, params, Pending::Input)?;
                }
                // The page is about to change: look at it soon, not after the idle interval.
                self.same = 0;
                let busy = (FRAME * self.screencast.every_nth).max(BASE_INTERVAL);
                self.next_capture = self.next_capture.min(Instant::now() + busy);
            }
        }
        Ok(())
    }

    fn refuse(&mut self, reason: &'static str) {
        refuse(self.outbox, &mut self.refused, reason);
    }

    /// `Some(reason)` ends the session: the page is gone.
    fn reply(&mut self, message: &Value) -> Result<Option<&'static str>> {
        let Some(position) = message["id"]
            .as_u64()
            .and_then(|id| self.pending.iter().position(|(pending, _)| *pending == id))
        else {
            return Ok(None);
        };
        let (_, kind) = self.pending.remove(position);
        if message["type"] == "error" {
            return self.failed(&kind, message);
        }
        self.errors = 0;
        let result = &message["result"];
        match kind {
            Pending::Capture => self.frame(result["data"].as_str().unwrap_or_default()),
            Pending::Viewport => {}
            Pending::Tree => {
                let context = self.launched.context.as_str();
                let Some(page) = result["contexts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|page| page["context"] == context)
                else {
                    return Ok(Some("PageClosed"));
                };
                self.read.1 = page["url"].as_str().unwrap_or_default().to_string();
                self.publish();
            }
            Pending::Input | Pending::Release => {}
            Pending::Title => {
                if result["result"]["type"] == "string" {
                    self.read.0 = result["result"]["value"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    self.publish();
                }
            }
        }
        Ok(None)
    }

    /// A page that is gone ends the session; a title that could not be read is only a title; anything else
    /// a few times in a row is the browser failing.
    fn failed(&mut self, kind: &Pending, message: &Value) -> Result<Option<&'static str>> {
        if matches!(kind, Pending::Title | Pending::Release) {
            return Ok(None);
        }
        if message["error"] == "no such frame" {
            return Ok(Some("PageClosed"));
        }
        // A sequence that Firefox rejected may have pressed a key or a button already: let go of everything, and do
        // not count it as the browser failing.
        if matches!(kind, Pending::Input) {
            let context = self.launched.context.clone();
            self.request(
                "input.releaseActions",
                json!({"context": context}),
                Pending::Release,
            )?;
            return Ok(None);
        }
        self.errors += 1;
        if self.errors >= MAX_ERRORS {
            return Err(Error::Browser("BrowserProtocolError"));
        }
        Ok(None)
    }

    fn frame(&mut self, data: &str) {
        // Base64 is a third larger than the bytes it carries.
        if self.paused || data.len() > wire::MAX_JPEG / 3 * 4 + 4 {
            return;
        }
        let Ok(jpeg) = base64::engine::general_purpose::STANDARD.decode(data) else {
            return;
        };
        if jpeg.len() > wire::MAX_JPEG {
            return;
        }
        if jpeg == self.last {
            self.same = self.same.saturating_add(1);
            return;
        }
        self.same = 0;
        self.ladder.produced();
        self.last.clone_from(&jpeg);
        self.sequence = self.sequence.wrapping_add(1);
        self.outbox.frame(&wire::Frame {
            sequence: self.sequence,
            width: self.viewport.width as u16,
            height: self.viewport.height as u16,
            // The capture is the viewport, and a pointer is mapped into the viewport: no scroll offset applies.
            scroll_y: 0.0,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as u64),
            jpeg,
        });
    }

    fn publish(&mut self) {
        announce_page(self.outbox, &mut self.page, &self.read.0, &self.read.1);
    }
}
impl Handler for Stream<'_, '_> {
    fn client(&mut self, body: &[u8]) -> Result<()> {
        let message = serde_json::from_slice::<Client>(body).ok();
        match message {
            Some(Client::Ack { .. }) => {
                if self.outbox.ack() {
                    self.ladder.delivered();
                }
            }
            Some(Client::Quality { rung }) => self.ladder.choose(rung, Instant::now()),
            Some(Client::Pause {}) => self.pause(true)?,
            Some(Client::Resume {}) => self.pause(false)?,
            Some(Client::Control { on }) => self.control = on,
            // A second open, or any message outside the closed set: counted, never forwarded.
            Some(Client::Open { .. }) | None => self.refuse(allow::Refusal::Unlisted.reason()),
            // What is left is input; `input::bidi_commands` refuses a message that is not.
            Some(message) => self.input(&message)?,
        }
        Ok(())
    }

    fn browser(&mut self, message: &Value) -> Result<Option<&'static str>> {
        self.reply(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_is_taken_from_the_profile_only_when_it_is_loopback() {
        let profile = tempfile::tempdir().unwrap();
        let write = |text: &str| fs::write(profile.path().join(PORT_FILE), text).unwrap();
        assert_eq!(read_port(profile.path()).unwrap(), None, "no file yet");
        write("{\"ws_host\": \"127.0.0.1\"");
        assert_eq!(read_port(profile.path()).unwrap(), None, "half written");
        write(r#"{"ws_host": "127.0.0.1", "ws_port": 41337}"#);
        assert_eq!(read_port(profile.path()).unwrap(), Some(41337));
        for bad in [
            r#"{"ws_host": "10.0.0.5", "ws_port": 41337}"#,
            r#"{"ws_host": "::1", "ws_port": 41337}"#,
            r#"{"ws_host": "127.0.0.1", "ws_port": 0}"#,
            r#"{"ws_host": "127.0.0.1", "ws_port": 70000}"#,
            r#"{"ws_port": 41337}"#,
        ] {
            write(bad);
            assert!(read_port(profile.path()).is_err(), "{bad}");
        }
    }

    /// `user.js` is JavaScript, and a JSON string literal is one: every line must read back as the name and
    /// value it was written from, whatever characters the profile's path has.
    #[test]
    fn every_preference_reads_back_and_downloads_go_inside_the_profile() {
        let profile = std::path::Path::new("/tmp/a \"b\"\\c\n/d");
        let preferences: std::collections::HashMap<String, Value> = preferences(profile)
            .lines()
            .map(|line| {
                let line = line.strip_prefix("user_pref(").unwrap();
                let (name, value) = line.strip_suffix(");").unwrap().split_once(", ").unwrap();
                (
                    serde_json::from_str(name).unwrap(),
                    serde_json::from_str(value).unwrap(),
                )
            })
            .collect();
        assert_eq!(
            preferences["browser.download.dir"],
            json!(profile.join("downloads").to_str().unwrap())
        );
        assert_eq!(preferences["browser.download.useDownloadDir"], json!(false));
        assert_eq!(preferences["permissions.default.geo"], json!(2));
        assert_eq!(preferences["toolkit.telemetry.enabled"], json!(false));
    }
}
