//! The host browser relay: `lazysh-agent host-browser serve` (docs/host-browser.md, "Relay protocol").
//!
//! One SSH exec channel carries the [`wire`] format. The relay starts a Chrome-family browser with a private
//! profile and `--remote-debugging-pipe`, so no socket exists on the host, speaks the DevTools Protocol to it
//! over the pipe, and sends the client only frames, the page's title and address, and its own state. The client
//! never sends a protocol command: every command goes through [`allow::command`] before it is written, and a
//! client message that is not in the closed [`wire::Client`] set is refused and counted.
//!
//! The browser, its helpers and its profile end with the channel: standard input closing, SIGINT, SIGTERM or
//! SIGHUP, or the browser exiting. Nothing about a page is logged or written to disk.
use super::{
    allow, browser_command, find_binary,
    outbox::Outbox,
    profile, settings, terminate,
    wire::{self, Client, Viewport},
};
use crate::{Error, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
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
const MAX_TITLE: usize = 512;
const MAX_URL: usize = 2048;
const QUALITY: u8 = 60;
const TITLE_POLL: Duration = Duration::from_secs(1);

pub struct Serve<'a> {
    /// The companion state directory: where the setting and the profiles live.
    pub state: &'a Path,
    pub binary: Option<&'a Path>,
    /// Pass --no-sandbox, for containers and CI runners that cannot create a sandbox.
    pub no_sandbox: bool,
}

enum Event {
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

const CLIENT_CLOSED: &str = "ClientClosed";

/// Ends the browser (its whole process group) when it goes out of scope, on every path.
struct Running(Child);
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
    if browser != "chrome" {
        return Err(Error::Browser("BrowserUnsupported"));
    }
    if !viewport.valid() {
        return Err(Error::Browser("ViewportInvalid"));
    }
    allow::address(url).map_err(|refusal| Error::Browser(refusal.reason()))?;
    let binary = find_binary(options.binary)?;

    // Declared before the browser, so it is removed after the browser has ended.
    let profile = profile::create(options.state, false)?;
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
        sequence: 0,
        refused: 0,
        page: (String::new(), String::new()),
        polled: Instant::now(),
    };
    relay.start_screencast()?;
    outbox.control(json!({
        "type": "state",
        "state": "running",
        "browser": product,
        "viewport": {"width": viewport.width, "height": viewport.height, "scale": viewport.scale},
        "capabilities": {"view": true, "control": false, "navigation": false, "tabs": false},
    }));
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
#[cfg(unix)]
fn spawn_piped(command: &mut Command) -> Result<Piped> {
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
// shortcut: no pipe transport off Unix, so no browser there; Windows hosts are not supported, and the viewer
// says so. Upgrade only if a Windows host is ever required.
#[cfg(not(unix))]
fn spawn_piped(_: &mut Command) -> Result<(Child, Box<dyn Write + Send>, Box<dyn Read + Send>)> {
    Err(Error::Browser("HostBrowserUnsupported"))
}

/// "HeadlessChrome/120.0.6099.109" and "Chrome/120.0.6099.109" are version 120.
fn major(product: &str) -> Option<u32> {
    product.split_once('/')?.1.split('.').next()?.parse().ok()
}

fn bounded(text: &str, max: usize) -> String {
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
        self.to_browser.write_all(&bytes)?;
        self.to_browser.flush()?;
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
        let deadline = Instant::now() + CALL_TIMEOUT;
        loop {
            let wait = deadline.saturating_duration_since(Instant::now());
            match self.inbox.recv_timeout(wait) {
                Ok(Event::Browser(mut message)) if message["id"] == id => {
                    return if message.get("error").is_some() {
                        Err(Error::Browser("BrowserProtocolError"))
                    } else {
                        Ok(message["result"].take())
                    };
                }
                Ok(Event::Stop | Event::ClientGone) => return Err(Error::Browser(CLIENT_CLOSED)),
                Ok(Event::BrowserGone) => return Err(Error::Browser("BrowserExited")),
                Ok(Event::Violation) => return Err(Error::Browser("ProtocolViolation")),
                Ok(other) => self.backlog.push_back(other),
                Err(_) => return Err(Error::Browser("BrowserStartTimeout")),
            }
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
    sequence: u32,
    /// Client messages outside the closed set, by count: never their content.
    refused: u64,
    page: (String, String),
    /// When the page's title was last asked for.
    polled: Instant,
}
impl Relay {
    fn start_screencast(&mut self) -> Result<()> {
        let width = (self.viewport.width as f32 * self.viewport.scale).round() as u32;
        let height = (self.viewport.height as f32 * self.viewport.scale).round() as u32;
        self.link.cdp.send(
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": QUALITY,
                "maxWidth": width,
                "maxHeight": height,
                "everyNthFrame": 1,
            }),
            Some(&self.session),
        )?;
        Ok(())
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
            let event = match self.link.backlog.pop_front() {
                Some(event) => event,
                None => match self
                    .link
                    .inbox
                    .recv_timeout((self.polled + TITLE_POLL).saturating_duration_since(now))
                {
                    Ok(event) => event,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(CLIENT_CLOSED),
                },
            };
            match event {
                Event::Stop | Event::ClientGone => return Ok(CLIENT_CLOSED),
                Event::Violation => return Err(Error::Browser("ProtocolViolation")),
                Event::BrowserGone => return Err(Error::Browser("BrowserExited")),
                Event::Client(body) => self.client(&body)?,
                Event::Browser(message) => {
                    if let Some(reason) = self.browser(&message)? {
                        return Ok(reason);
                    }
                }
            }
        }
    }

    fn client(&mut self, body: &[u8]) -> Result<()> {
        match serde_json::from_slice::<Client>(body) {
            Ok(Client::Ack { .. }) => self.outbox.ack(),
            Ok(Client::Pause {}) if !self.paused => {
                self.paused = true;
                self.outbox.pause(true);
                self.link
                    .cdp
                    .send("Page.stopScreencast", json!({}), Some(&self.session))?;
                self.outbox
                    .control(json!({"type": "state", "state": "paused"}));
            }
            Ok(Client::Resume {}) if self.paused => {
                self.paused = false;
                self.outbox.pause(false);
                self.start_screencast()?;
                self.outbox
                    .control(json!({"type": "state", "state": "running"}));
            }
            Ok(Client::Pause {} | Client::Resume {}) => {}
            // A second open, or any message outside the closed set: counted, never forwarded.
            Ok(Client::Open { .. }) | Err(_) => self.refuse(),
        }
        Ok(())
    }

    /// Tell the client about the first refusal and every doubling after it, so a flood stays small.
    fn refuse(&mut self) {
        self.refused += 1;
        if self.refused.is_power_of_two() {
            self.outbox.control(json!({
                "type": "refused",
                "reason": allow::Refusal::Unlisted.reason(),
                "count": self.refused,
            }));
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
        // Base64 is a third larger than the bytes it carries.
        if self.paused || data.len() > wire::MAX_JPEG / 3 * 4 + 4 {
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
        let page = (
            bounded(info["title"].as_str().unwrap_or_default(), MAX_TITLE),
            bounded(info["url"].as_str().unwrap_or_default(), MAX_URL),
        );
        if page != self.page {
            self.outbox.page(&page.0, &page.1);
            self.page = page;
        }
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

    #[test]
    fn page_text_is_cut_on_a_character_boundary() {
        assert_eq!(bounded("héllo", 2), "hé");
        assert_eq!(bounded("ab", 10), "ab");
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
