//! The host browser relay: `lazysh-agent host-browser serve` (docs/host-browser.md, "Relay protocol").
//!
//! One SSH exec channel carries the [`wire`] format. The relay starts a Chrome-family browser with a private
//! profile and `--remote-debugging-pipe`, so no socket exists on the host, speaks the DevTools Protocol to it
//! over the pipe, and sends the client only frames, the page's title and address, and its own state. The client
//! never sends a protocol command: every command goes through [`allow::command`] before it is written, and a
//! client message that is not in the closed [`wire::Client`] set is refused and counted.
//!
//! Input reaches the browser only while the client has turned Control on (off at every start), as the few fixed
//! messages of [`input`], each bounded and rate limited.
//!
//! The browser, its helpers and its profile end with the channel: standard input closing, SIGINT, SIGTERM or
//! SIGHUP, or the browser exiting. Nothing about a page is logged or written to disk.
use super::{
    allow, browser_command, find_binary, firefox, input,
    ladder::{self, Ladder, Screencast},
    outbox::Outbox,
    profile, settings, terminate,
    wire::{self, Client, Viewport},
};
use crate::{Error, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{self, BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};

/// Chrome 111 added the origin check and the pipe behavior this relay relies on.
const MIN_VERSION: u32 = 111;
const OPEN_TIMEOUT: Duration = Duration::from_secs(30);
// A cold browser on a loaded CI runner needs well over the 1 s a developer machine takes.
const CALL_TIMEOUT: Duration = Duration::from_secs(90);
/// A screencast frame is base64 of a JPEG of at most [`wire::MAX_JPEG`], inside a JSON object.
const MAX_BROWSER_MESSAGE: u64 = 8 << 20;
pub(super) const MAX_TITLE: usize = 512;
pub(super) const MAX_URL: usize = 2048;
const TITLE_POLL: Duration = Duration::from_secs(1);
/// How often the quality ladder and the idle time are looked at when nothing else wakes the relay.
const TICK: Duration = Duration::from_millis(100);

pub struct Serve<'a> {
    /// The companion state directory: where the setting and the profiles live.
    pub state: &'a Path,
    pub binary: Option<&'a Path>,
    /// Pass --no-sandbox, for containers and CI runners that cannot create a sandbox.
    pub no_sandbox: bool,
    /// Use the single kept profile instead of a private one, and leave it for `host-browser --clear-data`.
    pub keep_profile: bool,
    /// How long a hidden view may keep the browser before the session ends with `IdleReleased`.
    pub idle_release: Duration,
}

pub(super) enum Event {
    Client(Vec<u8>),
    ClientGone,
    /// The client broke the framing: an unknown tag, an oversize or zero length.
    Violation,
    Browser(Value),
    BrowserGone,
    Stop,
}

/// Serve one client until it leaves or the browser does. Fails closed, before anything starts, while the host
/// browser switch is off.
pub fn serve(options: &Serve) -> Result<()> {
    let outbox = Arc::new(Outbox::default());
    let (written, done) = mpsc::channel();
    {
        let outbox = outbox.clone();
        thread::spawn(move || {
            let _ = outbox.drain(&mut io::stdout().lock());
            let _ = written.send(());
        });
    }
    let mut detail = None;
    let result = match session(options, &outbox, &mut detail) {
        Err(error) if error.class() == CLIENT_CLOSED => Ok(CLIENT_CLOSED),
        other => other,
    };
    outbox.close(
        result
            .as_ref()
            .map_or_else(|error| error.class(), |reason| reason),
        detail.as_deref(),
    );
    // A client that stopped reading must not hold the exit: the browser is already gone.
    let _ = done.recv_timeout(Duration::from_secs(2));
    result.map(|_| ())
}

pub(super) const CLIENT_CLOSED: &str = "ClientClosed";

/// Ends the browser (its whole process group) when it goes out of scope, on every path.
pub(super) struct Running(pub(super) Child);
impl Drop for Running {
    fn drop(&mut self) {
        terminate(&mut self.0);
    }
}

fn session(
    options: &Serve,
    outbox: &Arc<Outbox>,
    detail: &mut Option<String>,
) -> Result<&'static str> {
    // Before anything else: the switch is off by default and an off switch must start nothing.
    settings::require_enabled(options.state)?;
    let (events, inbox) = mpsc::channel::<Event>();
    spawn_client_reader(events.clone());
    let stop = events.clone();
    // Also covers SIGINT, SIGTERM and SIGHUP through ctrlc's termination feature.
    let _ = ctrlc::set_handler(move || {
        let _ = stop.send(Event::Stop);
    });

    let Client::Open {
        browser,
        headed,
        viewport,
        url,
    } = wait_for_open(&inbox)?
    else {
        return Err(Error::Browser("OpenExpected"));
    };
    let url = url.as_deref().unwrap_or("about:blank");
    if !matches!(browser.as_str(), "chrome" | "firefox") {
        return Err(Error::Browser("BrowserUnsupported"));
    }
    if !viewport.valid() {
        return Err(Error::Browser("ViewportInvalid"));
    }
    allow::address(url).map_err(|refusal| Error::Browser(refusal.reason()))?;
    if browser == "firefox" {
        let open = firefox::Open {
            options,
            headed,
            viewport,
            url,
        };
        return firefox::session(&open, outbox, detail, &events, &inbox);
    }
    let binary = find_binary(options.binary)?;

    // Declared before the browser, so it is released after the browser has ended: removed, unless it is the kept one.
    let profile = profile::create(options.state, options.keep_profile)?;
    let mut command = browser_command(&binary, profile.path(), headed, options.no_sandbox);
    command
        .arg("--remote-debugging-pipe")
        // The browser's own messages can name pages, so they are not kept; the reason names the operation.
        .stderr(Stdio::null())
        .arg(url);
    let Piped {
        child,
        to_browser,
        from_browser,
    } = spawn_piped(&mut command)?;
    let _browser = Running(child);
    spawn_browser_reader(from_browser, events);

    let mut link = Link {
        cdp: Cdp {
            to_browser,
            next: 0,
        },
        inbox,
        backlog: VecDeque::new(),
    };
    let product = link.call("Browser.getVersion", json!({}), None)?["product"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if major(&product).is_none_or(|major| major < MIN_VERSION) {
        *detail = Some(bounded(&product, 64));
        return Err(Error::Browser("BrowserVersionUnsupported"));
    }
    link.call("Target.setDiscoverTargets", json!({"discover": true}), None)?;
    let targets = link.call("Target.getTargets", json!({}), None)?;
    let page = targets["targetInfos"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|info| info["type"] == "page")
        .and_then(|info| info["targetId"].as_str());
    let target = match page {
        Some(id) => id.to_string(),
        None => link.call("Target.createTarget", json!({"url": "about:blank"}), None)?["targetId"]
            .as_str()
            .ok_or(Error::Browser("BrowserNoPage"))?
            .to_string(),
    };
    let attached = link.call(
        "Target.attachToTarget",
        json!({"targetId": target, "flatten": true}),
        None,
    )?;
    let page_session = attached["sessionId"]
        .as_str()
        .ok_or(Error::Browser("BrowserNoPage"))?
        .to_string();
    let on_page = Some(page_session.as_str());
    link.call("Page.enable", json!({}), on_page)?;
    // Denied before any page can start one; the allow-list refuses every other behavior.
    link.call(
        "Browser.setDownloadBehavior",
        json!({"behavior": "deny"}),
        None,
    )?;
    link.call(
        "Page.setInterceptFileChooserDialog",
        json!({"enabled": true}),
        on_page,
    )?;
    link.call(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": viewport.width,
            "height": viewport.height,
            "deviceScaleFactor": viewport.scale,
            "mobile": false,
        }),
        on_page,
    )?;

    let mut relay = Relay {
        link,
        outbox: outbox.clone(),
        session: page_session,
        target,
        viewport,
        paused: false,
        paused_since: None,
        idle_release: options.idle_release,
        ladder: Ladder::new(Instant::now()),
        quality: None,
        control: false,
        limit: input::Limit::new(Instant::now()),
        sequence: 0,
        refused: BTreeMap::new(),
        page: (String::new(), String::new()),
        polled: Instant::now(),
    };
    relay.start_screencast()?;
    outbox.control(running_state(
        &product,
        viewport,
        json!({"view": true, "control": true, "navigation": false, "tabs": false}),
    ));
    relay.report_quality();
    relay.run()
}

fn wait_for_open(inbox: &mpsc::Receiver<Event>) -> Result<Client> {
    match inbox.recv_timeout(OPEN_TIMEOUT) {
        Ok(Event::Client(body)) => serde_json::from_slice(&body)
            .map_err(|_| Error::Browser("OpenExpected"))
            .and_then(|client| match client {
                open @ Client::Open { .. } => Ok(open),
                _ => Err(Error::Browser("OpenExpected")),
            }),
        Ok(Event::Violation) => Err(Error::Browser("ProtocolViolation")),
        Ok(Event::Stop | Event::ClientGone) => Err(Error::Browser(CLIENT_CLOSED)),
        Ok(Event::Browser(_) | Event::BrowserGone) | Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(Error::Browser("OpenExpected"))
        }
        Err(mpsc::RecvTimeoutError::Timeout) => Err(Error::Browser("OpenTimeout")),
    }
}

fn spawn_client_reader(events: mpsc::Sender<Event>) {
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        let last = loop {
            match wire::read(&mut input, wire::MAX_CLIENT) {
                Ok(Some((wire::JSON, body))) => {
                    if events.send(Event::Client(body)).is_err() {
                        return;
                    }
                }
                Ok(Some(_)) => break Event::Violation,
                Err(error) if error.kind() == io::ErrorKind::InvalidData => break Event::Violation,
                Ok(None) | Err(_) => break Event::ClientGone,
            }
        };
        let _ = events.send(last);
    });
}

/// The browser writes one JSON message, then a NUL byte.
fn spawn_browser_reader(from_browser: Box<dyn Read + Send>, events: mpsc::Sender<Event>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(from_browser);
        loop {
            let mut buffer = Vec::new();
            let read = (&mut reader)
                .take(MAX_BROWSER_MESSAGE + 1)
                .read_until(0, &mut buffer);
            if read.is_err() || buffer.last() != Some(&0) {
                break;
            }
            buffer.pop();
            if let Ok(message) = serde_json::from_slice(&buffer) {
                if events.send(Event::Browser(message)).is_err() {
                    return;
                }
            }
        }
        let _ = events.send(Event::BrowserGone);
    });
}

/// A started browser and the relay's ends of its pipe.
struct Piped {
    child: Child,
    to_browser: Box<dyn Write + Send>,
    from_browser: Box<dyn Read + Send>,
}

/// Both pipe ends the browser inherits: it reads commands on fd 3 and writes replies and events on fd 4.
// shortcut: no pipe transport off Unix, so no browser there; Windows hosts are not supported, and the viewer
// says so. Upgrade only if a Windows host is ever required. One signature serves both builds, so the stub
// cannot drift from the real function (it did, and broke the Windows build).
fn spawn_piped(command: &mut Command) -> Result<Piped> {
    #[cfg(not(unix))]
    {
        let _ = command;
        Err(Error::Browser("HostBrowserUnsupported"))
    }
    #[cfg(unix)]
    spawn_piped_unix(command)
}

#[cfg(unix)]
fn spawn_piped_unix(command: &mut Command) -> Result<Piped> {
    use std::os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::process::CommandExt,
    };
    // A copy above fd 4, so that a pipe the system happened to number 3 or 4 is not closed by the exec.
    fn above_four(fd: OwnedFd) -> io::Result<OwnedFd> {
        // SAFETY: duplicates a descriptor this function owns; the result is owned straight away.
        let copy = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
        if copy < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(copy) })
    }
    let (commands_in, commands_out) = io::pipe()?;
    let (replies_in, replies_out) = io::pipe()?;
    let browser_reads = above_four(OwnedFd::from(commands_in))?;
    let browser_writes = above_four(OwnedFd::from(replies_out))?;
    let (reads, writes) = (browser_reads.as_raw_fd(), browser_writes.as_raw_fd());
    // SAFETY: dup2 and errno are async-signal-safe and the closure touches no memory of the parent.
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(reads, 3) < 0 || libc::dup2(writes, 4) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    // Closing the parent's copies lets the end of the browser's output reach the reader as end of file.
    drop((browser_reads, browser_writes));
    Ok(Piped {
        child,
        to_browser: Box::new(commands_out),
        from_browser: Box::new(replies_in),
    })
}

/// What the client is told once the page streams: the browser, the page size and what the adapter can do.
pub(super) fn running_state(browser: &str, viewport: Viewport, capabilities: Value) -> Value {
    json!({
        "type": "state",
        "state": "running",
        "browser": browser,
        "viewport": {"width": viewport.width, "height": viewport.height, "scale": viewport.scale},
        "capabilities": capabilities,
    })
}

/// What to tell the client about its `count`th refused message: the first and every doubling after it, so that a
/// flood stays small.
pub(super) fn refusal_notice(reason: &str, count: u64) -> Option<Value> {
    count
        .is_power_of_two()
        .then(|| json!({"type": "refused", "reason": reason, "count": count}))
}

/// "HeadlessChrome/120.0.6099.109", "Chrome/120.0.6099.109" and "Firefox/160.0" are versions 120 and 160.
pub(super) fn major(product: &str) -> Option<u32> {
    product.split_once('/')?.1.split('.').next()?.parse().ok()
}

pub(super) fn bounded(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

struct Cdp {
    to_browser: Box<dyn Write + Send>,
    next: u64,
}
impl Cdp {
    /// Every command passes the allow-list before it is written, whatever asked for it. A refusal here is a
    /// relay bug, never a client's request (the client cannot name a method).
    fn send(&mut self, method: &str, params: Value, session: Option<&str>) -> Result<u64> {
        allow::command(method, &params).map_err(|refusal| Error::Browser(refusal.reason()))?;
        self.next += 1;
        let mut message = json!({"id": self.next, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        let mut bytes = message.to_string().into_bytes();
        bytes.push(0);
        // shortcut: a browser that stays alive but stops reading its pipe blocks this write, and the relay
        // with it, until the browser dies; the channel closing still kills it at the host's side.
        self.to_browser
            .write_all(&bytes)
            .and_then(|()| self.to_browser.flush())
            // The read end is closed: the browser exited between its last message and this command.
            .map_err(|error| match error.kind() {
                io::ErrorKind::BrokenPipe => Error::Browser("BrowserExited"),
                _ => error.into(),
            })?;
        Ok(self.next)
    }
}

/// The browser's pipe and the relay's inbox, before the stream starts: calls wait for their reply.
struct Link {
    cdp: Cdp,
    inbox: mpsc::Receiver<Event>,
    /// Everything that arrived while a call waited, handled in order once the stream runs.
    backlog: VecDeque<Event>,
}
impl Link {
    fn call(&mut self, method: &str, params: Value, session: Option<&str>) -> Result<Value> {
        let id = self.cdp.send(method, params, session)?;
        let mut reply = await_reply(&self.inbox, &mut self.backlog, id)?;
        if reply.get("error").is_some() {
            Err(Error::Browser("BrowserProtocolError"))
        } else {
            Ok(reply["result"].take())
        }
    }
}

/// The browser's reply to call `id`, whatever it says. Everything else that arrives meanwhile is kept in
/// `backlog`, in order, for the loop that handles events; a client that leaves, a broken framing or a browser that
/// exits ends the wait.
pub(super) fn await_reply(
    inbox: &mpsc::Receiver<Event>,
    backlog: &mut VecDeque<Event>,
    id: u64,
) -> Result<Value> {
    let deadline = Instant::now() + CALL_TIMEOUT;
    loop {
        let wait = deadline.saturating_duration_since(Instant::now());
        match inbox.recv_timeout(wait) {
            Ok(Event::Browser(message)) if message["id"] == id => return Ok(message),
            Ok(Event::Stop | Event::ClientGone) => return Err(Error::Browser(CLIENT_CLOSED)),
            Ok(Event::BrowserGone) => return Err(Error::Browser("BrowserExited")),
            Ok(Event::Violation) => return Err(Error::Browser("ProtocolViolation")),
            Ok(other) => backlog.push_back(other),
            Err(_) => return Err(Error::Browser("BrowserStartTimeout")),
        }
    }
}

struct Relay {
    link: Link,
    outbox: Arc<Outbox>,
    session: String,
    target: String,
    viewport: Viewport,
    paused: bool,
    /// When the view was hidden, while it is.
    paused_since: Option<Instant>,
    idle_release: Duration,
    ladder: Ladder,
    /// The rung and whether it is pinned, as last told to the client.
    quality: Option<(ladder::Rung, bool)>,
    /// Whether input reaches the browser. Off when a session starts, and it must be off again whenever the relay
    /// starts the browser anew: a client turns it on, never the relay.
    control: bool,
    limit: input::Limit,
    sequence: u32,
    /// Client messages that were refused, by reason and count: never their content.
    refused: BTreeMap<&'static str, u64>,
    page: (String, String),
    /// When the page's title was last asked for.
    polled: Instant,
}
impl Relay {
    /// Start the screencast at what the ladder wants now.
    fn start_screencast(&mut self) -> Result<()> {
        let screencast = self.ladder.apply(Instant::now());
        self.send_screencast(screencast)
    }

    fn send_screencast(&mut self, screencast: Screencast) -> Result<()> {
        let size = |css: u32| {
            (css as f32 * self.viewport.scale * screencast.percent as f32 / 100.0).round() as u32
        };
        self.link.cdp.send(
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": screencast.quality,
                "maxWidth": size(self.viewport.width),
                "maxHeight": size(self.viewport.height),
                "everyNthFrame": screencast.every_nth,
            }),
            Some(&self.session),
        )?;
        Ok(())
    }

    /// Move a running screencast to other parameters; the browser takes them at a start.
    fn restart_screencast(&mut self, screencast: Screencast) -> Result<()> {
        self.link
            .cdp
            .send("Page.stopScreencast", json!({}), Some(&self.session))?;
        self.send_screencast(screencast)
    }

    /// Tell the client the rung it sees and whether it is pinned, when that changed.
    fn report_quality(&mut self) {
        let quality = self.ladder.rung();
        if self.quality != Some(quality) {
            self.quality = Some(quality);
            self.outbox
                .control(json!({"type": "quality", "rung": quality.0, "pinned": quality.1}));
        }
    }

    /// Handle events until the session ends; the value is the reason it ended.
    fn run(&mut self) -> Result<&'static str> {
        loop {
            // Chrome announces an address change but not a title that the page sets later, and a page that
            // animates keeps the inbox busy, so the poll is on the clock, not on a quiet inbox.
            let now = Instant::now();
            if now >= self.polled + TITLE_POLL {
                self.polled = now;
                if !self.paused {
                    self.link.cdp.send("Target.getTargets", json!({}), None)?;
                }
            }
            if let Some(since) = self.paused_since {
                if now >= since + self.idle_release {
                    return Ok("IdleReleased");
                }
            } else if let Some(screencast) = self.ladder.tick(now) {
                self.restart_screencast(screencast)?;
            }
            self.report_quality();
            let event = match self.link.backlog.pop_front() {
                Some(event) => event,
                None => match self.link.inbox.recv_timeout(TICK) {
                    Ok(event) => event,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(CLIENT_CLOSED),
                },
            };
            if let Some(reason) = self.handle(event)? {
                return Ok(reason);
            }
        }
    }

    fn client(&mut self, body: &[u8]) -> Result<()> {
        match serde_json::from_slice::<Client>(body) {
            Ok(Client::Ack { .. }) => {
                if self.outbox.ack() {
                    self.ladder.delivered();
                }
            }
            Ok(Client::Quality { rung }) => self.ladder.choose(rung, Instant::now()),
            Ok(Client::Pause {}) if !self.paused => {
                self.paused = true;
                self.paused_since = Some(Instant::now());
                self.outbox.pause(true);
                self.link
                    .cdp
                    .send("Page.stopScreencast", json!({}), Some(&self.session))?;
                self.outbox
                    .control(json!({"type": "state", "state": "paused"}));
            }
            Ok(Client::Resume {}) if self.paused => {
                self.paused = false;
                self.paused_since = None;
                self.outbox.pause(false);
                self.start_screencast()?;
                self.outbox
                    .control(json!({"type": "state", "state": "running"}));
            }
            Ok(Client::Pause {} | Client::Resume {}) => {}
            Ok(Client::Control { on }) => self.control = on,
            // A second open, or any message outside the closed set: counted, never forwarded.
            Ok(Client::Open { .. }) | Err(_) => self.refuse(allow::Refusal::Unlisted.reason()),
            // What is left is input; `input::commands` refuses a message that is not.
            Ok(message) => self.input(&message)?,
        }
        Ok(())
    }

    /// One input message: refused while Control is off, outside the bounds or in a flood, else its calls in order.
    // shortcut: turning Control off while a button is held leaves the page's button pressed until the next click;
    // upgrade when the viewer can start a drag and switch Control off in the same gesture.
    fn input(&mut self, message: &Client) -> Result<()> {
        if !self.control {
            self.refuse(input::CONTROL_OFF);
            return Ok(());
        }
        match input::commands(message, self.viewport) {
            Err(reason) => self.refuse(reason),
            Ok(_) if !self.limit.take(Instant::now()) => self.refuse(input::RATE_LIMITED),
            Ok(calls) => {
                self.ladder.input(Instant::now());
                for (method, params) in calls {
                    self.link.cdp.send(method, params, Some(&self.session))?;
                }
            }
        }
        Ok(())
    }

    /// Tell the client about the first refusal of a reason and every doubling after it, so a flood stays small.
    fn refuse(&mut self, reason: &'static str) {
        let count = self.refused.entry(reason).or_default();
        *count += 1;
        if let Some(notice) = refusal_notice(reason, *count) {
            self.outbox.control(notice);
        }
    }

    /// `Some(reason)` ends the session: the page is gone.
    fn browser(&mut self, message: &Value) -> Result<Option<&'static str>> {
        let params = &message["params"];
        match message["method"].as_str() {
            Some("Page.screencastFrame") if message["sessionId"] == self.session.as_str() => {
                self.frame(params)?;
            }
            Some("Target.targetInfoChanged" | "Target.targetCreated")
                if params["targetInfo"]["targetId"] == self.target.as_str() =>
            {
                self.page(&params["targetInfo"]);
            }
            Some("Target.targetDestroyed") if params["targetId"] == self.target.as_str() => {
                return Ok(Some("PageClosed"));
            }
            Some("Target.detachedFromTarget") if params["sessionId"] == self.session.as_str() => {
                return Ok(Some("PageClosed"));
            }
            Some("Target.targetCrashed") if params["targetId"] == self.target.as_str() => {
                return Err(Error::Browser("PageCrashed"));
            }
            // The reply to the title poll.
            _ => {
                let targets = message["result"]["targetInfos"].as_array();
                if let Some(info) = targets.and_then(|infos| {
                    infos
                        .iter()
                        .find(|info| info["targetId"] == self.target.as_str())
                }) {
                    self.page(info);
                }
            }
        }
        Ok(None)
    }

    fn frame(&mut self, params: &Value) -> Result<()> {
        // Acknowledged at once: the link's round trip must not throttle the browser; only the newest frame is kept.
        self.link.cdp.send(
            "Page.screencastFrameAck",
            json!({"sessionId": params["sessionId"]}),
            Some(&self.session),
        )?;
        let Some(data) = params["data"].as_str() else {
            return Ok(());
        };
        if self.paused {
            return Ok(());
        }
        self.ladder.produced();
        // Base64 is a third larger than the bytes it carries.
        if data.len() > wire::MAX_JPEG / 3 * 4 + 4 {
            return Ok(());
        }
        let Ok(jpeg) = base64::engine::general_purpose::STANDARD.decode(data) else {
            return Ok(());
        };
        if jpeg.len() > wire::MAX_JPEG {
            return Ok(());
        }
        let metadata = &params["metadata"];
        self.sequence = self.sequence.wrapping_add(1);
        self.outbox.frame(&wire::Frame {
            sequence: self.sequence,
            width: metadata["deviceWidth"].as_f64().unwrap_or(0.0) as u16,
            height: metadata["deviceHeight"].as_f64().unwrap_or(0.0) as u16,
            scroll_y: metadata["scrollOffsetY"].as_f64().unwrap_or(0.0) as f32,
            timestamp_ms: (metadata["timestamp"].as_f64().unwrap_or(0.0) * 1000.0) as u64,
            jpeg,
        });
        Ok(())
    }

    /// The title and address are untrusted text: bounded here, shown as text only by the client.
    fn page(&mut self, info: &Value) {
        let (title, url) = (
            info["title"].as_str().unwrap_or_default(),
            info["url"].as_str().unwrap_or_default(),
        );
        announce_page(&self.outbox, &mut self.page, title, url);
    }
}

/// Tell the client the page's title and address when they changed since `announced`, bounded: they are untrusted
/// text, shown as text only.
pub(super) fn announce_page(
    outbox: &Outbox,
    announced: &mut (String, String),
    title: &str,
    url: &str,
) {
    let page = (bounded(title, MAX_TITLE), bounded(url, MAX_URL));
    if page != *announced {
        outbox.page(&page.0, &page.1);
        *announced = page;
    }
}

/// What an adapter's loop does with the events that reach it; the meaning of the ones that end the session, and
/// of a client that leaves, is the same for every browser.
pub(super) trait Handler {
    fn client(&mut self, body: &[u8]) -> Result<()>;
    /// A message from the browser; `Some(reason)` ends the session.
    fn browser(&mut self, message: &Value) -> Result<Option<&'static str>>;

    fn handle(&mut self, event: Event) -> Result<Option<&'static str>> {
        match event {
            Event::Stop | Event::ClientGone => Ok(Some(CLIENT_CLOSED)),
            Event::Violation => Err(Error::Browser("ProtocolViolation")),
            Event::BrowserGone => Err(Error::Browser("BrowserExited")),
            Event::Client(body) => self.client(&body).map(|()| None),
            Event::Browser(message) => self.browser(&message),
        }
    }
}
impl Handler for Relay {
    fn client(&mut self, body: &[u8]) -> Result<()> {
        Relay::client(self, body)
    }
    fn browser(&mut self, message: &Value) -> Result<Option<&'static str>> {
        Relay::browser(self, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_browser_version_is_read_from_its_product_and_never_guessed() {
        for (product, major_version) in [
            ("Chrome/120.0.6099.109", Some(120)),
            ("HeadlessChrome/111.0.5563.64", Some(111)),
            ("Chromium/99", Some(99)),
            ("Chrome", None),
            ("Chrome/x.1", None),
            ("", None),
        ] {
            assert_eq!(major(product), major_version, "{product}");
        }
    }

    // The agent is built for Windows too, where the relay only answers that the host has no browser pipe.
    #[cfg(windows)]
    #[test]
    fn a_windows_host_has_no_browser_pipe_and_says_so() {
        assert!(matches!(
            spawn_piped(&mut Command::new("cmd.exe")),
            Err(Error::Browser("HostBrowserUnsupported"))
        ));
    }

    #[test]
    fn a_write_to_a_browser_that_has_gone_reports_the_browser_exiting() {
        let (reader, writer) = io::pipe().unwrap();
        drop(reader);
        let mut cdp = Cdp {
            to_browser: Box::new(writer),
            next: 0,
        };
        assert!(matches!(
            cdp.send("Page.reload", json!({}), Some("s")),
            Err(Error::Browser("BrowserExited"))
        ));
    }

    #[test]
    fn page_text_is_cut_on_a_character_boundary() {
        assert_eq!(bounded("héllo", 2), "hé");
        assert_eq!(bounded("ab", 10), "ab");
    }

    #[test]
    fn a_command_to_a_browser_that_has_exited_says_so() {
        // A pipe whose read end is gone, as the browser's is once it has exited.
        let (reader, writer) = io::pipe().unwrap();
        drop(reader);
        let mut cdp = Cdp {
            to_browser: Box::new(writer),
            next: 0,
        };
        let error = cdp.send("Page.reload", json!({}), Some("s")).unwrap_err();
        assert_eq!(error.class(), "BrowserExited");
    }

    #[test]
    fn the_relay_cannot_send_what_the_allow_list_refuses() {
        let mut cdp = Cdp {
            to_browser: Box::new(io::sink()),
            next: 0,
        };
        for (method, params) in [
            ("Network.getCookies", json!({})),
            ("Runtime.evaluate", json!({"expression": "document.cookie"})),
            ("Browser.setDownloadBehavior", json!({"behavior": "allow"})),
            ("Page.navigate", json!({"url": "file:///etc/passwd"})),
        ] {
            assert!(cdp.send(method, params, None).is_err(), "{method}");
        }
        assert_eq!(cdp.next, 0, "a refused command still took an id");
        assert!(cdp.send("Page.reload", json!({}), Some("s")).is_ok());
    }
}
