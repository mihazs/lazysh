//! The Firefox adapter of the host browser relay (docs/host-browser.md, "Adapters and capabilities").
//!
//! Firefox has no pipe mode and no push screencast, so the relay starts it with a private profile and a random
//! loopback port, finds the port in the profile, speaks WebDriver BiDi over [`bidi`], and polls
//! `browsingContext.captureScreenshot`, pipelined, skipping repeats. Firefox allows one BiDi session at a time, and
//! a session that was never ended blocks every later client until Firefox exits (measured), so the relay always
//! ends its session, and a browser that already holds one is replaced by a new one the relay owns.
//!
//! Everything the relay sends goes through [`allow::bidi`]. The client sees the same wire format as for Chrome.
//! Navigation, history and tabs are `browsingContext` commands on a context id the relay itself listed from
//! `getTree` or `create`; one that it never listed is refused here, before Firefox is asked.
use super::{
    allow, bidi, die_with_launcher, find_in, input,
    outbox::Outbox,
    own_process_group, profile,
    relay::{
        announce_page, await_reply, bounded, major, running_state, tally, Event, Handler, Running,
        Serve, CLIENT_CLOSED,
    },
    tabs::{self, Tab, MAX_TABS},
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
/// Between screenshot requests while the page changes (at most 20 a second), and once it has stopped changing.
// shortcut: fixed pacing. The adaptive quality ladder (#1259) replaces both and adds the boost after input.
const BUSY_INTERVAL: Duration = Duration::from_millis(50);
const IDLE_INTERVAL: Duration = Duration::from_millis(250);
const IDLE_AFTER: u32 = 8;
const QUALITY: f64 = 0.6;
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
    let tabs: Vec<Tab> = top_level(&tree)
        .into_iter()
        .map(|(tab, _)| tab)
        .take(MAX_TABS)
        .collect();
    launched.context = tabs
        .first()
        .ok_or(Error::Browser("BrowserNoPage"))?
        .id
        .clone();
    let viewport = open.viewport;
    launched.link.call(
        "browsingContext.setViewport",
        sized(&launched.context, viewport),
    )?;
    // `stop` is false: Firefox 160 has no command to stop a load (`browsingContext.stop` is unknown, measured).
    outbox.control(running_state(
        &launched.product,
        viewport,
        json!({
            "view": true,
            "control": true,
            "pinch": false,
            "composition": false,
            "navigation": true,
            "tabs": true,
            "stop": false,
            // Why, so that the viewer can say it and hide the control: Firefox did not scale the page when two
            // touch pointers spread (headless probe), and BiDi has neither `insertText` nor composition.
            "unavailable": {"pinch": "NoPagePinch", "composition": "NoTextInsertion"},
        }),
    ));
    Stream::new(&mut launched, outbox, viewport, tabs).run()
}

/// The top-level browsing contexts of a `getTree` result, each with the context that opened it, if any.
fn top_level(result: &Value) -> Vec<(Tab, Option<String>)> {
    result["contexts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|context| context["parent"].is_null())
        .filter_map(|context| {
            let opener = context["originalOpener"].as_str().map(str::to_string);
            Some((Tab::context(context)?, opener))
        })
        .collect()
}

/// A page is sized like the phone, one context at a time.
fn sized(context: &str, viewport: Viewport) -> Value {
    json!({
        "context": context,
        "viewport": {"width": viewport.width, "height": viewport.height},
        "devicePixelRatio": viewport.scale,
    })
}

enum Pending {
    /// A screenshot of this context: dropped when another one is shown by the time it arrives.
    Capture(String),
    /// The tree, as of this change count of the tab list; an older answer is ignored.
    Tree(u32),
    /// The title of this context.
    Title(String),
    /// A command whose failure is not the browser failing: a page that closed meanwhile, or a history that ends.
    Action,
    /// An `input.performActions`; when it fails, what it left held is released.
    Input,
    Release,
}

struct Stream<'l, 'a> {
    launched: &'l mut Launched<'a>,
    outbox: &'l Arc<Outbox>,
    viewport: Viewport,
    paused: bool,
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
    /// The top-level contexts the relay listed, in the order it learned them. A command only ever names one of
    /// these; the shown one is `launched.context`.
    tabs: Vec<Tab>,
    /// How often the relay changed `tabs` itself, so that a tree asked for before a change cannot undo it.
    epoch: u32,
    /// The last `tabs` message sent.
    sent: Value,
}
impl<'l, 'a> Stream<'l, 'a> {
    fn new(
        launched: &'l mut Launched<'a>,
        outbox: &'l Arc<Outbox>,
        viewport: Viewport,
        tabs: Vec<Tab>,
    ) -> Self {
        let now = Instant::now();
        Self {
            launched,
            outbox,
            viewport,
            paused: false,
            sequence: 0,
            refused: BTreeMap::new(),
            control: false,
            limit: input::Limit::new(now),
            pending: Vec::new(),
            last: Vec::new(),
            same: 0,
            next_capture: now,
            // The first read is due at once: it gives the titles and any page that opened meanwhile.
            polled: now.checked_sub(PAGE_POLL).unwrap_or(now),
            errors: 0,
            page: Default::default(),
            tabs,
            epoch: 0,
            sent: Value::Null,
        }
    }

    // shortcut: no watchdog on a Firefox that stops answering; its requests wait until the channel closes, which
    // ends it, and the page and capture polls add two entries a second meanwhile. Upgrade with the quality ladder.
    fn request(&mut self, method: &str, params: Value, kind: Pending) -> Result<()> {
        let id = self.launched.link.bidi.send(method, params)?;
        self.pending.push((id, kind));
        Ok(())
    }

    fn capturing(&self) -> usize {
        self.pending
            .iter()
            .filter(|(_, kind)| matches!(kind, Pending::Capture(_)))
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
        self.publish();
        self.send_tabs(false);
        loop {
            let now = Instant::now();
            if self.capture_due().is_some_and(|due| due <= now) {
                let context = self.launched.context.clone();
                let interval = if self.same >= IDLE_AFTER {
                    IDLE_INTERVAL
                } else {
                    BUSY_INTERVAL
                };
                self.next_capture = now + interval;
                self.request(
                    "browsingContext.captureScreenshot",
                    json!({
                        "context": context,
                        "origin": "viewport",
                        "format": {"type": "image/jpeg", "quality": QUALITY},
                    }),
                    Pending::Capture(context),
                )?;
            }
            if self.poll_due().is_some_and(|due| due <= now) {
                self.polled = now;
                let kind = Pending::Tree(self.epoch);
                self.request("browsingContext.getTree", json!({}), kind)?;
            }
            let event = match self.launched.link.backlog.pop_front() {
                Some(event) => event,
                None => {
                    let wake = [self.capture_due(), self.poll_due()]
                        .into_iter()
                        .flatten()
                        .min()
                        .map_or(PAGE_POLL, |due| due.saturating_duration_since(now));
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

    /// `getTree` has no title, so each page's is one read of `document.title` in the relay's own realm.
    fn read_title(&mut self, context: &str) -> Result<()> {
        self.request(
            "script.evaluate",
            json!({
                "expression": allow::TITLE_EXPRESSION,
                "awaitPromise": false,
                "target": {"context": context, "sandbox": SANDBOX},
            }),
            Pending::Title(context.to_string()),
        )
    }

    /// No request goes out while hidden, and the first one after showing it again sends a frame, changed or not.
    fn pause(&mut self, paused: bool) {
        if paused == self.paused {
            return;
        }
        self.paused = paused;
        self.outbox.pause(paused);
        self.last.clear();
        self.same = 0;
        self.next_capture = Instant::now();
        self.polled = Instant::now();
        self.outbox
            .control(json!({"type": "state", "state": if paused { "paused" } else { "running" }}));
    }

    /// One input message: refused while Control is off, outside the bounds or in a flood, else its call.
    // shortcut: turning Control off while a button is held leaves it held until the next click, as in Chrome;
    // upgrade when the viewer can start a drag and switch Control off in the same gesture.
    fn input(&mut self, message: &Client) -> Result<()> {
        if !self.control {
            return self.refuse(input::CONTROL_OFF);
        }
        match input::bidi_commands(message, self.viewport) {
            Err(reason) => self.refuse(reason)?,
            Ok(_) if !self.limit.take(Instant::now()) => self.refuse(input::RATE_LIMITED)?,
            Ok(calls) => {
                for (method, mut params) in calls {
                    params["context"] = self.launched.context.clone().into();
                    self.request(method, params, Pending::Input)?;
                }
                // The page is about to change: look at it soon, not after the idle interval.
                self.same = 0;
                self.next_capture = self.next_capture.min(Instant::now() + BUSY_INTERVAL);
            }
        }
        Ok(())
    }

    /// Counted and told to the client at the first and every doubling, and the message is dropped.
    fn refuse(&mut self, reason: &'static str) -> Result<()> {
        if let Some(count) = tally(&mut self.refused, reason) {
            self.outbox
                .control(json!({"type": "refused", "reason": reason, "count": count}));
        }
        Ok(())
    }

    fn listed(&self, id: &str) -> bool {
        self.tabs.iter().any(|tab| tab.id == id)
    }

    /// A command on a context the relay listed. What the allow-list refuses (an address that is not `http`,
    /// `https` or `about:blank`) and a context it never listed are counted and dropped, so that neither reaches
    /// Firefox and neither is a failure of the relay.
    fn act(&mut self, method: &str, params: Value) -> Result<()> {
        let listed = params["context"].as_str().is_some_and(|id| self.listed(id));
        match allow::bidi(method, &params) {
            Ok(()) if listed => self.request(method, params, Pending::Action),
            Ok(()) => self.refuse(allow::Refusal::Unlisted.reason()),
            Err(refusal) => self.refuse(refusal.reason()),
        }
    }

    /// Show another listed page: it is raised and sized like the phone, and its frames replace the old one's.
    fn show(&mut self, id: &str) -> Result<()> {
        self.act("browsingContext.activate", json!({"context": id}))?;
        self.act("browsingContext.setViewport", sized(id, self.viewport))?;
        self.launched.context = id.to_string();
        self.last.clear();
        self.same = 0;
        self.next_capture = Instant::now();
        self.page = Default::default();
        self.publish();
        self.send_tabs(false);
        Ok(())
    }

    /// A page is gone. The shown one hands the view to the last page of the list; the session ends with
    /// `PageClosed` only when the browser has none left.
    fn gone(&mut self, id: &str) -> Result<Option<&'static str>> {
        self.tabs.retain(|tab| tab.id != id);
        self.epoch += 1;
        if id != self.launched.context {
            self.send_tabs(false);
            return Ok(None);
        }
        match self.tabs.last().map(|tab| tab.id.clone()) {
            Some(next) => self.show(&next).map(|()| None),
            None => Ok(Some("PageClosed")),
        }
    }

    /// The tree of every top-level page: pages that closed, pages that opened and the addresses. A page that the
    /// shown one opened takes the view, like in a browser, and a page beyond [`MAX_TABS`] is closed again, so that
    /// a page that opens windows in a loop cannot grow the list.
    fn refresh(&mut self, result: &Value) -> Result<Option<&'static str>> {
        let shown = self.launched.context.clone();
        let (mut tabs, mut popup) = (Vec::<Tab>::new(), None);
        for (mut tab, opener) in top_level(result) {
            let title = self.tabs.iter().find(|known| known.id == tab.id);
            if let Some(known) = title {
                tab.title.clone_from(&known.title);
            } else if tabs.len() >= MAX_TABS {
                let params = json!({"context": tab.id});
                self.request("browsingContext.close", params, Pending::Action)?;
                continue;
            } else if popup.is_none() && opener.as_deref() == Some(shown.as_str()) {
                popup = Some(tab.id.clone());
            }
            tabs.push(tab);
        }
        self.tabs = tabs;
        if !self.listed(&shown) {
            return self.gone(&shown);
        }
        if let Some(id) = popup {
            self.show(&id)?;
        }
        for id in self
            .tabs
            .iter()
            .map(|tab| tab.id.clone())
            .collect::<Vec<_>>()
        {
            self.read_title(&id)?;
        }
        self.publish();
        self.send_tabs(false);
        Ok(None)
    }

    /// A new blank page, listed at once; the caller shows it.
    fn create_tab(&mut self) -> Result<String> {
        let created = self.launched.link.call(
            "browsingContext.create",
            json!({"type": "tab", "background": true}),
        )?;
        let tab = Tab::context(&json!({"context": created["context"], "url": "about:blank"}))
            .ok_or(Error::Browser("BrowserProtocolError"))?;
        let id = tab.id.clone();
        self.tabs.push(tab);
        self.epoch += 1;
        Ok(id)
    }

    fn new_tab(&mut self) -> Result<()> {
        if self.tabs.len() >= MAX_TABS {
            return self.refuse(allow::Refusal::Unlisted.reason());
        }
        let id = self.create_tab()?;
        self.show(&id)
    }

    fn close_tab(&mut self, id: &str) -> Result<()> {
        if !self.listed(id) {
            return self.refuse(allow::Refusal::Unlisted.reason());
        }
        // A browser keeps a page: the last one is replaced by a blank one first, never left without any.
        if self.tabs.len() == 1 {
            self.create_tab()?;
        }
        self.act("browsingContext.close", json!({"context": id}))?;
        self.gone(id).map(|_| ())
    }

    fn activate(&mut self, id: &str) -> Result<()> {
        if id == self.launched.context {
            Ok(())
        } else if self.listed(id) {
            self.show(id)
        } else {
            self.refuse(allow::Refusal::Unlisted.reason())
        }
    }

    /// Send the tab list and what the controls show, when it is not what the client has.
    // shortcut: BiDi has no history list, so back and forward are always offered and an end of history is a no-op
    // (`no such history entry`, ignored); `loading` is always false because navigations do not wait. Upgrade if
    // Firefox adds a history query or the viewer needs the loading state.
    fn send_tabs(&mut self, force: bool) {
        let view = tabs::view(&self.tabs, &self.launched.context, true, true, false);
        if force || view != self.sent {
            self.outbox.tabs(&view);
            self.sent = view;
        }
    }

    /// `Some(reason)` ends the session: no page is left.
    fn reply(&mut self, message: &Value) -> Result<Option<&'static str>> {
        let Some(position) = message["id"]
            .as_u64()
            .and_then(|id| self.pending.iter().position(|(pending, _)| *pending == id))
        else {
            return Ok(None);
        };
        let (_, kind) = self.pending.remove(position);
        if message["type"] == "error" {
            return self.failed(kind, message);
        }
        self.errors = 0;
        let result = &message["result"];
        match kind {
            Pending::Capture(context) if context == self.launched.context => {
                self.frame(result["data"].as_str().unwrap_or_default());
            }
            Pending::Tree(epoch) if epoch == self.epoch => return self.refresh(result),
            Pending::Title(id) if result["result"]["type"] == "string" => {
                let title = result["result"]["value"].as_str().unwrap_or_default();
                if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) {
                    tab.title = bounded(title, tabs::MAX_TITLE);
                }
                self.publish();
                self.send_tabs(false);
            }
            _ => {}
        }
        Ok(None)
    }

    /// A page that is gone is dropped from the list; a title that could not be read is only a title, and a
    /// command on a page or history that ended is only that; anything else a few times in a row is the browser
    /// failing.
    fn failed(&mut self, kind: Pending, message: &Value) -> Result<Option<&'static str>> {
        match kind {
            Pending::Title(_) | Pending::Action | Pending::Release => return Ok(None),
            Pending::Capture(context) if message["error"] == "no such frame" => {
                return self.gone(&context);
            }
            // A sequence that Firefox rejected may have pressed a key or a button already: let go of everything,
            // and do not count it as the browser failing.
            Pending::Input => {
                let context = self.launched.context.clone();
                self.request(
                    "input.releaseActions",
                    json!({"context": context}),
                    Pending::Release,
                )?;
                return Ok(None);
            }
            _ => {}
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

    /// The shown page's title and address, as last read.
    fn publish(&mut self) {
        if let Some(tab) = self.tabs.iter().find(|tab| tab.id == self.launched.context) {
            announce_page(self.outbox, &mut self.page, &tab.title, &tab.url);
        }
    }
}
impl Handler for Stream<'_, '_> {
    fn client(&mut self, body: &[u8]) -> Result<()> {
        let message = serde_json::from_slice::<Client>(body).ok();
        let shown = self.launched.context.clone();
        match message {
            Some(Client::Ack { .. }) => {
                self.outbox.ack();
            }
            Some(Client::Pause {}) => self.pause(true),
            Some(Client::Resume {}) => self.pause(false),
            // Navigation is not input: Control does not gate it. A navigation does not wait for the page to load.
            Some(Client::Navigate { url }) => self.act(
                "browsingContext.navigate",
                json!({"context": shown, "url": url, "wait": "none"}),
            )?,
            Some(Client::Back {}) => self.act(
                "browsingContext.traverseHistory",
                json!({"context": shown, "delta": -1}),
            )?,
            Some(Client::Forward {}) => self.act(
                "browsingContext.traverseHistory",
                json!({"context": shown, "delta": 1}),
            )?,
            Some(Client::Reload {}) => self.act(
                "browsingContext.reload",
                json!({"context": shown, "wait": "none"}),
            )?,
            Some(Client::Tabs {}) => self.send_tabs(true),
            Some(Client::ActivateTab { id }) => self.activate(&id)?,
            Some(Client::NewTab {}) => self.new_tab()?,
            Some(Client::CloseTab { id }) => self.close_tab(&id)?,
            Some(Client::Control { on }) => self.control = on,
            Some(
                message @ (Client::Pointer { .. }
                | Client::Wheel { .. }
                | Client::Pinch { .. }
                | Client::Text { .. }
                | Client::Key { .. }),
            ) => self.input(&message)?,
            // A second open, any message outside the closed set, `stop` (Firefox has no command for it) and a
            // dialog answer (a later slice): counted, never forwarded.
            Some(_) | None => self.refuse(allow::Refusal::Unlisted.reason())?,
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
