//! Where admitted terminal output goes (#1315). Every transport (SSH, ET, Mosh through
//! `ssh::send_output`, and the local PTY directly) hands bytes to `ssh::deliver_output`, which applies
//! the access-lease, background-epoch and renderer-replacement checks and then calls one
//! [`OutputSink`]: the WebView `Channel` (the xterm path, unchanged) or, once a core is attached to
//! the session, [`Core::feed`] inside Rust. The credit a chunk consumed comes back through the
//! [`CreditReturn`] the core was built with, after it has processed the bytes, so the transport window
//! still bounds memory and no per-chunk IPC acknowledgement is needed.
//!
//! A renderer asks for a core with `terminal_core_open(events, ..)` before it starts the terminal with
//! the same `events` Channel; the transport finds the offer by the Channel's id (no connect command
//! changed) and attaches the core before the first byte is read. Replies and encoded input are not
//! routed back to the transport yet (#1316): the real core's writer refuses them.
#![cfg_attr(not(test), allow(dead_code))]

use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::SshEvent;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError};
use tauri::ipc::Channel;

/// Destination of terminal output after the access checks. `data` runs inside the access-gated send,
/// so it must not block; an `Err` means the consumer is gone and ends the transport's output.
pub(crate) trait OutputSink: Send + Sync {
    fn data(&self, bytes: &[u8]) -> Result<(), String>;
    fn closed(&self, message: String, lost: bool) -> Result<(), String>;
}

impl OutputSink for Channel<SshEvent> {
    fn data(&self, bytes: &[u8]) -> Result<(), String> {
        self.send(SshEvent::Data {
            data: bytes.to_vec(),
        })
        .map_err(|_| "Terminal output closed".into())
    }

    fn closed(&self, message: String, lost: bool) -> Result<(), String> {
        self.send(SshEvent::Closed { message, lost })
            .map_err(|_| "Terminal output closed".into())
    }
}

/// A terminal core as the transports and the bridge commands see it. Chunks arrive in order, at most
/// one transport chunk each and never beyond the transport's credit window; the core returns each
/// chunk's credit (through the [`CreditReturn`] it was built with) after parsing it.
pub(crate) trait Core: Send + Sync {
    fn feed(&self, chunk: Vec<u8>) -> Result<(), String>;
    /// Text of the visible rows, on request: React never receives cells.
    fn viewport_text(&self) -> Result<String, String>;
    /// The renderer's grid changed: the terminal's size, so the transport's output wraps as drawn.
    fn resize(&self, cols: u32, rows: u32) -> Result<(), String>;
    /// The control plane (#1321): the state and a bounded window of row text, with the events raised since
    /// the last answer. Reading rearms the doorbell. Never cells.
    fn snapshot(&self, window: usize) -> Result<CoreSnapshot, String>;
    /// Moves the viewport as a reader asked, then answers like [`Core::snapshot`].
    fn scroll(&self, action: CoreScroll, window: usize) -> Result<CoreSnapshot, String>;
    /// Calls `ring` (once until the next [`Core::snapshot`]) when output changes the screen. At most one
    /// watcher: a second call is ignored.
    fn watch(&self, ring: Box<dyn Fn() + Send + Sync>);
    /// An inactive session keeps parsing and wakes nobody; becoming active again rings once to catch up.
    fn set_active(&self, active: bool);
    /// Free the core now. Idempotent.
    fn close(&self);
}

/// The most rows of text one control-plane answer carries, whatever the renderer asks for.
const MAX_WINDOW: usize = 1024;
const DEFAULT_WINDOW: usize = 256;

/// What a core says about itself: sizes, positions and modes, no cells. The field names are the client's
/// `NativeCoreSnapshot` (`fixtures/control-plane.json` in the runtime crate pins them from both sides).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreSnapshot {
    pub state: CoreState,
    pub window: CoreRows,
    /// Raised since the last answer; omitted when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<CoreEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreState {
    pub columns: u16,
    pub rows: u16,
    pub cursor: CoreCursor,
    pub modes: CoreModes,
    pub viewport: CoreViewport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CoreCursor {
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreModes {
    pub bracketed_paste: bool,
    pub mouse_tracking: CoreMouse,
    pub alternate_screen: bool,
    pub application_cursor_keys: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CoreMouse {
    None,
    X10,
    Vt200,
    Drag,
    Any,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CoreViewport {
    pub top: usize,
    pub rows: usize,
    pub length: usize,
    pub following: bool,
}

/// The text of consecutive absolute rows from `first`, trimmed on the right.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CoreRows {
    pub first: usize,
    pub rows: Vec<String>,
}

/// The raw reports the program made; the client decodes them with the same code as the xterm backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum CoreEvent {
    Bell,
    /// An OSC 7 report as sent (`file://host/path`); the client decodes it as the xterm backend does.
    Cwd {
        report: String,
    },
    /// An OSC 52 write, already decoded: valid UTF-8 and at most [`MAX_CLIPBOARD`] bytes, as the xterm backend accepts.
    Clipboard {
        text: String,
    },
}

/// The largest clipboard write offered to the user (the bound of the xterm backend's `decodeClipboardRequest`).
const MAX_CLIPBOARD: usize = 64 * 1024;

/// What the program reported since the last answer, in the order bell, clipboard, directory: at most 8 bells, and only
/// the clipboard writes the user may be offered (valid UTF-8, within [`MAX_CLIPBOARD`]).
pub(crate) fn report(
    bells: u16,
    clipboard: Vec<Vec<u8>>,
    directories: Vec<Vec<u8>>,
) -> Vec<CoreEvent> {
    std::iter::repeat_n(CoreEvent::Bell, usize::from(bells.min(8)))
        .chain(
            clipboard
                .into_iter()
                .filter(|bytes| bytes.len() <= MAX_CLIPBOARD)
                .filter_map(|bytes| String::from_utf8(bytes).ok())
                .map(|text| CoreEvent::Clipboard { text }),
        )
        .chain(directories.into_iter().map(|bytes| CoreEvent::Cwd {
            report: String::from_utf8_lossy(&bytes).into_owned(),
        }))
        .collect()
}

/// A reader's scroll, in the client's `TerminalScrollAction` shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum CoreScroll {
    Lines { delta: isize },
    Pages { delta: isize },
    ToTop,
    ToBottom,
    ToRow { row: usize },
}

/// What the watching channel receives: the screen changed, pull a snapshot.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum CoreSignal {
    Changed,
}

/// Turns the VT worker's "output arrived" into one signal per read: a stream of output rings once, and the
/// next ring waits for the control plane to read, so signals follow the reader and not the output volume.
#[derive(Default)]
pub(crate) struct Doorbell {
    ring: OnceLock<Box<dyn Fn() + Send + Sync>>,
    rung: AtomicBool,
}

impl Doorbell {
    /// Output changed the screen (any thread).
    pub(crate) fn changed(&self) {
        if let Some(ring) = self.ring.get() {
            if !self.rung.swap(true, Ordering::AcqRel) {
                ring();
            }
        }
    }

    /// The control plane read the state: a later change rings again.
    pub(crate) fn read(&self) {
        self.rung.store(false, Ordering::Release);
    }

    pub(crate) fn connect(&self, ring: Box<dyn Fn() + Send + Sync>) {
        let _ = self.ring.set(ring);
    }

    /// Ring now, whatever was rung before: something changed while nobody was told.
    pub(crate) fn wake(&self) {
        self.read();
        self.changed();
    }
}

/// Returns `bytes` of consumed credit to the session's transport window. Safe to call from any
/// thread; a call for a session that is gone does nothing.
pub(crate) type CreditReturn = Arc<dyn Fn(usize) + Send + Sync>;

/// The credit return of a transport session: releases consumed bytes into its output window through
/// `release` (the transport's own acknowledgement), and does nothing once the session is gone.
pub(crate) fn credit_to<S: Send + Sync + 'static, E: 'static>(
    session: &Arc<S>,
    release: fn(&S, u32) -> Result<(), E>,
) -> CreditReturn {
    let session = Arc::downgrade(session);
    Arc::new(move |bytes| {
        if let Some(session) = session.upgrade() {
            let _ = release(&session, bytes as u32);
        }
    })
}

/// A core is built before the transport session exists, so its credit return is filled in when the
/// session is attached; nothing is fed before that.
#[derive(Default)]
pub(crate) struct CreditCell(OnceLock<CreditReturn>);

impl CreditCell {
    pub(crate) fn returner(self: &Arc<Self>) -> CreditReturn {
        let cell = self.clone();
        Arc::new(move |bytes| {
            if let Some(credit) = cell.0.get() {
                credit(bytes);
            }
        })
    }
}

/// The core a session's output is routed to, and the id it is registered under, set at most once.
#[derive(Default)]
pub(crate) struct CoreSlot(OnceLock<(String, Arc<dyn Core>)>);

impl CoreSlot {
    /// A renderer must not acknowledge output a core consumes: the core alone returns that credit.
    pub(crate) fn is_attached(&self) -> bool {
        self.0.get().is_some()
    }

    /// A resize the renderer sent to the transport, for the core to follow (a no-op without a core).
    pub(crate) fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        self.0
            .get()
            .map_or(Ok(()), |(_, core)| core.resize(cols, rows))
    }

    /// Free the core of a session whose id the renderer will never receive (the connect failed or was
    /// cancelled after the core was attached), so its screen and scrollback budget do not leak.
    pub(crate) fn discard(&self) {
        if let Some((id, _)) = self.0.get() {
            close(id);
        }
    }

    /// The sink for one delivery: output data goes to the core if attached, otherwise to the
    /// Channel; the closing notice always goes to the Channel, which stays the control path.
    pub(crate) fn route<'a>(&'a self, channel: &'a Channel<SshEvent>) -> Routed<'a> {
        Routed {
            channel,
            core: self.0.get().map(|(_, core)| core),
        }
    }
}

pub(crate) struct Routed<'a> {
    channel: &'a Channel<SshEvent>,
    core: Option<&'a Arc<dyn Core>>,
}

impl OutputSink for Routed<'_> {
    fn data(&self, bytes: &[u8]) -> Result<(), String> {
        match self.core {
            Some(core) => core.feed(bytes.to_vec()),
            None => self.channel.data(bytes),
        }
    }

    fn closed(&self, message: String, lost: bool) -> Result<(), String> {
        self.channel.closed(message, lost)
    }
}

/// A core built for a session that is about to be created. Dropped unattached (the connect failed),
/// it frees the core.
pub(crate) struct Prepared {
    core: Arc<dyn Core>,
    cell: Arc<CreditCell>,
    attached: bool,
}

impl Prepared {
    pub(crate) fn new(core: Arc<dyn Core>, cell: Arc<CreditCell>) -> Self {
        Self {
            core,
            cell,
            attached: false,
        }
    }

    /// Route the session's output to the core and register it under the session id. `credit` is the
    /// session's own window release.
    pub(crate) fn attach(mut self, id: &str, slot: &CoreSlot, credit: CreditReturn) {
        let _ = self.cell.0.set(credit);
        slot.0.set((id.to_owned(), self.core.clone())).ok();
        registry().live.insert(id.to_owned(), self.core.clone());
        self.attached = true;
    }
}

impl Drop for Prepared {
    fn drop(&mut self) {
        if !self.attached {
            self.core.close();
        }
    }
}

/// How the renderer asked for a core: built when the transport session for the same `Channel` starts.
pub(crate) type Factory = Box<dyn FnOnce() -> Result<Prepared, String> + Send>;

/// Offers waiting for their terminal to start. A renderer that offers and never connects cannot
/// grow this: the oldest offer is dropped past the cap.
const MAX_OFFERS: usize = 16;

#[derive(Default)]
struct Registry {
    /// Offers by the id of the `Channel` the renderer will pass to the connect command.
    offered: VecDeque<(u32, Factory)>,
    live: HashMap<String, Arc<dyn Core>>,
}

impl Registry {
    fn offer(&mut self, channel: u32, factory: Factory) {
        self.offered.retain(|(id, _)| *id != channel);
        if self.offered.len() >= MAX_OFFERS {
            self.offered.pop_front();
        }
        self.offered.push_back((channel, factory));
    }

    fn take_offer(&mut self, channel: u32) -> Option<Factory> {
        let at = self.offered.iter().position(|(id, _)| *id == channel)?;
        self.offered.remove(at).map(|(_, factory)| factory)
    }
}

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);
    REGISTRY.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn offer(channel: &Channel<SshEvent>, factory: Factory) {
    registry().offer(channel.id(), factory);
}

/// Called by every transport when it starts a terminal with `channel`: the core the renderer
/// offered for that channel, built now, or `None` when the renderer wants the Channel path.
pub(crate) fn prepare(channel: &Channel<SshEvent>) -> Result<Option<Prepared>, String> {
    let factory = registry().take_offer(channel.id());
    factory.map(|factory| factory()).transpose()
}

/// The registry is process-wide, so in tests any renderer replacement would close the cores of
/// tests running beside it. A test that needs its core to survive holds a read guard from this;
/// `close_all` waits for all of them.
#[cfg(test)]
pub(crate) fn tests_keeping_cores() -> &'static std::sync::RwLock<()> {
    static KEEPING: std::sync::RwLock<()> = std::sync::RwLock::new(());
    &KEEPING
}

pub(crate) fn live(id: &str) -> Result<Arc<dyn Core>, String> {
    registry()
        .live
        .get(id)
        .cloned()
        .ok_or_else(|| "No native terminal core for this session".into())
}

pub(crate) fn close(id: &str) {
    let core = registry().live.remove(id);
    if let Some(core) = core {
        core.close();
    }
}

/// A renderer replacement ends every renderer-owned session; the cores they fed go with them,
/// so a screen cannot outlive the lock that protected it. Unclaimed offers hold no core yet and are
/// left to the cap above.
pub(crate) fn close_all() {
    #[cfg(test)]
    let _exclusive = tests_keeping_cores().write();
    let live = std::mem::take(&mut registry().live);
    live.values().for_each(|core| core.close());
}

type AccessResult<T> = Result<Guarded<T>, GuardedError<String>>;

/// Like the terminal commands, the two that create or read a screen belong to the current renderer:
/// a replaced renderer's lease is refused.
#[tauri::command]
pub async fn terminal_core_open(
    lease: AccessLease,
    events: Channel<SshEvent>,
    cols: u32,
    rows: u32,
    scrollback_bytes: Option<u32>,
) -> AccessResult<()> {
    lease
        .run(async {
            crate::ssh::check_size(cols, rows).map_err(|error| error.message().to_owned())?;
            offer(&events, native::factory(cols, rows, scrollback_bytes)?);
            Ok(())
        })
        .await
}

#[tauri::command]
pub async fn terminal_core_text(lease: AccessLease, session_id: String) -> AccessResult<String> {
    lease
        .run(async { live(&session_id)?.viewport_text() })
        .await
}

/// The control plane of a session's core: its state and a bounded window of row text, never cells (#1321).
#[tauri::command]
pub async fn terminal_core_snapshot(
    lease: AccessLease,
    session_id: String,
    window: Option<usize>,
) -> AccessResult<CoreSnapshot> {
    lease
        .run(async { live(&session_id)?.snapshot(window_rows(window)) })
        .await
}

#[tauri::command]
pub async fn terminal_core_scroll(
    lease: AccessLease,
    session_id: String,
    action: CoreScroll,
    window: Option<usize>,
) -> AccessResult<CoreSnapshot> {
    lease
        .run(async { live(&session_id)?.scroll(action, window_rows(window)) })
        .await
}

/// Sends `changed` on `events` when output changes the screen, once per read of the state (see [`Doorbell`]).
#[tauri::command]
pub async fn terminal_core_watch(
    lease: AccessLease,
    session_id: String,
    events: Channel<CoreSignal>,
) -> AccessResult<()> {
    lease
        .run(async {
            live(&session_id)?.watch(Box::new(move || {
                let _ = events.send(CoreSignal::Changed);
            }));
            Ok(())
        })
        .await
}

/// Whether the session's view is looking at it: an inactive one keeps parsing and wakes nobody.
#[tauri::command]
pub async fn terminal_core_active(
    lease: AccessLease,
    session_id: String,
    active: bool,
) -> AccessResult<()> {
    lease
        .run(async {
            live(&session_id)?.set_active(active);
            Ok(())
        })
        .await
}

fn window_rows(requested: Option<usize>) -> usize {
    requested.unwrap_or(DEFAULT_WINDOW).clamp(1, MAX_WINDOW)
}

#[tauri::command]
pub fn terminal_core_close(session_id: String) -> Result<(), String> {
    close(&session_id);
    Ok(())
}

/// The real core, `lazysh-terminal-runtime` on libghostty-vt, which needs Zig 0.16.0 to build; without
/// the `native-terminal` feature no build needs Zig and the commands report that.
#[cfg(not(feature = "native-terminal"))]
mod native {
    pub(super) fn factory(_: u32, _: u32, _: Option<u32>) -> Result<super::Factory, String> {
        Err("The native terminal core is not built into this app".into())
    }
}

#[cfg(feature = "native-terminal")]
mod native {
    use super::*;
    use lazysh_terminal_runtime::{
        Config, ControlSnapshot, Events, Hooks, Hub, HubConfig, MouseTracking, Offer, Origin,
        PtyWriter, Refused, ScrollAction, Session, Size, TerminalRuntime,
    };

    static HUB: LazyLock<Hub> = LazyLock::new(|| Hub::new(HubConfig::default()));

    /// Replies and encoded input are not wired to the Rust write path yet (#1316): refuse, so a
    /// reply is dropped and counted rather than written without the access check.
    struct RefuseAll;

    impl PtyWriter for RefuseAll {
        fn write(&self, _: Origin, _: &[u8]) -> Result<(), Refused> {
            Err(Refused)
        }
    }

    /// Live sessions and reserved scrollback bytes in the process-wide hub, for the lifecycle test.
    #[cfg(test)]
    pub(super) fn hub_usage() -> (usize, usize) {
        (HUB.live(), HUB.scrollback_reserved())
    }

    struct Runtime {
        session: Session,
        doorbell: Arc<Doorbell>,
    }

    /// The runtime's answer on the wire. Everything the program reported since the last answer rides along.
    fn wire(answer: ControlSnapshot, events: Events) -> CoreSnapshot {
        let (state, window) = (answer.state, answer.window);
        let events = report(events.bell, events.clipboard_writes, events.pwd_changes);
        CoreSnapshot {
            state: CoreState {
                columns: state.columns,
                rows: state.rows,
                cursor: CoreCursor {
                    x: state.cursor.0,
                    y: state.cursor.1,
                },
                modes: CoreModes {
                    bracketed_paste: state.modes.bracketed_paste,
                    mouse_tracking: match state.modes.mouse_tracking {
                        MouseTracking::None => CoreMouse::None,
                        MouseTracking::X10 => CoreMouse::X10,
                        MouseTracking::Vt200 => CoreMouse::Vt200,
                        MouseTracking::Drag => CoreMouse::Drag,
                        MouseTracking::Any => CoreMouse::Any,
                    },
                    alternate_screen: state.modes.alternate_screen,
                    application_cursor_keys: state.modes.application_cursor_keys,
                },
                viewport: CoreViewport {
                    top: state.viewport.top,
                    rows: state.viewport.rows,
                    length: state.viewport.length,
                    following: state.viewport.following,
                },
            },
            window: CoreRows {
                first: window.first,
                rows: window.rows,
            },
            events,
        }
    }

    impl Runtime {
        /// Reads the control plane under one lock: the doorbell is rearmed first, so output that lands during
        /// the read rings again rather than being missed.
        fn answer(
            &self,
            ask: impl FnOnce(
                &mut TerminalRuntime,
            ) -> Result<ControlSnapshot, lazysh_terminal_runtime::Error>,
        ) -> Result<CoreSnapshot, String> {
            self.doorbell.read();
            self.session
                .with(|runtime| ask(runtime).map(|answer| wire(answer, runtime.take_events())))
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())
        }
    }

    impl Core for Runtime {
        fn feed(&self, chunk: Vec<u8>) -> Result<(), String> {
            match self.session.feed(chunk) {
                Ok(Offer::Accepted) => Ok(()),
                // A transport that honours its credit window never gets here.
                Ok(_) => Err("Terminal core queue is full".into()),
                Err(error) => Err(error.to_string()),
            }
        }

        fn viewport_text(&self) -> Result<String, String> {
            self.session
                .with(|runtime| runtime.viewport_text())
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())
        }

        fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
            let size = Size::new(cols as u16, rows as u16);
            self.session
                .with(|runtime| runtime.request_size(size))
                .map_err(|error| error.to_string())?
                .map(drop)
                .map_err(|error| error.to_string())
        }

        fn snapshot(&self, window: usize) -> Result<CoreSnapshot, String> {
            self.answer(|runtime| runtime.control_snapshot(window))
        }

        fn scroll(&self, action: CoreScroll, window: usize) -> Result<CoreSnapshot, String> {
            let action = match action {
                CoreScroll::Lines { delta } => ScrollAction::Lines(delta),
                CoreScroll::Pages { delta } => ScrollAction::Pages(delta),
                CoreScroll::ToTop => ScrollAction::Top,
                CoreScroll::ToBottom => ScrollAction::Bottom,
                CoreScroll::ToRow { row } => ScrollAction::Row(row),
            };
            self.answer(|runtime| runtime.control_scroll(action, window))
        }

        fn watch(&self, ring: Box<dyn Fn() + Send + Sync>) {
            self.doorbell.connect(ring);
            self.session.watch();
        }

        fn set_active(&self, active: bool) {
            if active {
                self.session.watch();
                self.doorbell.wake();
            } else {
                self.session.detach();
            }
        }

        fn close(&self) {
            self.session.close();
        }
    }

    pub(super) fn factory(
        cols: u32,
        rows: u32,
        scrollback_bytes: Option<u32>,
    ) -> Result<Factory, String> {
        let defaults = Config::default();
        let config = Config {
            size: Size::new(cols as u16, rows as u16),
            scrollback_bytes: scrollback_bytes
                .map_or(defaults.scrollback_bytes, |bytes| bytes as usize),
            // The transport windows are 256 KiB: a producer holding credit always fits.
            ingress_bytes: crate::ssh::OUTPUT_WINDOW as usize,
            ..defaults
        };
        Ok(Box::new(move || {
            let cell = Arc::new(CreditCell::default());
            let credit = cell.returner();
            let doorbell = Arc::new(Doorbell::default());
            let bell = doorbell.clone();
            let hooks = Hooks {
                writer: Arc::new(RefuseAll),
                credit: Box::new(move |bytes| credit(bytes)),
                changed: Some(Box::new(move || bell.changed())),
            };
            let session = HUB
                .create(uuid::Uuid::new_v4().to_string(), config, hooks)
                .map_err(|error| error.to_string())?;
            Ok(Prepared::new(Arc::new(Runtime { session, doorbell }), cell))
        }))
    }
}

/// Live sessions and reserved scrollback bytes of the real core's hub (lifecycle test only).
#[cfg(all(test, feature = "native-terminal"))]
pub(crate) fn hub_usage() -> (usize, usize) {
    native::hub_usage()
}

/// A core stand-in for the transport tests: it parses (stores) chunks on its own thread, then
/// returns their credit, exactly the contract the real core's session honours.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    use std::sync::{mpsc, Mutex};

    pub(crate) struct ChecksumCore {
        chunks: mpsc::Sender<Vec<u8>>,
        pub(crate) seen: Arc<Mutex<Vec<u8>>>,
        /// Bytes fed and not yet credited back, at their peak.
        pub(crate) peak_queued: Arc<AtomicUsize>,
        pub(crate) feeds: Arc<AtomicUsize>,
        pub(crate) sizes: Mutex<Vec<(u32, u32)>>,
        pub(crate) closed: std::sync::atomic::AtomicBool,
        queued: Arc<AtomicUsize>,
        pub(crate) doorbell: Arc<Doorbell>,
        active: Arc<std::sync::atomic::AtomicBool>,
    }

    impl ChecksumCore {
        /// A core plus the `Prepared` that attaches it, built the way a factory would.
        pub(crate) fn prepared() -> (Arc<Self>, Prepared) {
            let cell = Arc::new(CreditCell::default());
            let core = Self::new(cell.returner());
            (core.clone(), Prepared::new(core, cell))
        }

        pub(crate) fn new(credit: CreditReturn) -> Arc<Self> {
            let (chunks, received) = mpsc::channel::<Vec<u8>>();
            let core = Arc::new(Self {
                chunks,
                seen: Arc::default(),
                peak_queued: Arc::default(),
                feeds: Arc::default(),
                sizes: Mutex::default(),
                closed: Default::default(),
                queued: Arc::default(),
                doorbell: Arc::default(),
                active: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            });
            let (seen, queued) = (core.seen.clone(), core.queued.clone());
            let (doorbell, active) = (core.doorbell.clone(), core.active.clone());
            std::thread::spawn(move || {
                for chunk in received {
                    // Stands in for VT parsing: slower than the producer, so the window is exercised.
                    std::thread::sleep(std::time::Duration::from_micros(100));
                    seen.lock().unwrap().extend_from_slice(&chunk);
                    queued.fetch_sub(chunk.len(), SeqCst);
                    // The real core wakes a watcher only while attached; a view that is not looking is not told.
                    if active.load(SeqCst) {
                        doorbell.changed();
                    }
                    credit(chunk.len());
                }
            });
            core
        }
    }

    impl ChecksumCore {
        /// Waits for `expected.len()` parsed bytes, then checks the stream's checksum, that at most one
        /// transport window was ever queued unreturned, and that nothing crossed the Channel (`ipc`).
        pub(crate) async fn assert_received(&self, expected: &[u8], ipc: &AtomicUsize) {
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while self.seen.lock().unwrap().len() < expected.len() {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the core parsed the whole stream");
            assert_eq!(sha256(&self.seen.lock().unwrap()), sha256(expected));
            let (peak, window) = (self.peak_queued.load(SeqCst), crate::ssh::OUTPUT_WINDOW);
            assert!(
                peak <= window as usize,
                "{peak} bytes queued over the {window} window"
            );
            assert_eq!(ipc.load(SeqCst), 0, "no per-chunk IPC on the core path");
        }
    }

    impl Core for ChecksumCore {
        fn feed(&self, chunk: Vec<u8>) -> Result<(), String> {
            self.feeds.fetch_add(1, SeqCst);
            let queued = self.queued.fetch_add(chunk.len(), SeqCst) + chunk.len();
            self.peak_queued.fetch_max(queued, SeqCst);
            self.chunks.send(chunk).map_err(|_| "core gone".into())
        }

        fn viewport_text(&self) -> Result<String, String> {
            Ok(String::from_utf8_lossy(&self.seen.lock().unwrap()).into_owned())
        }

        fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
            self.sizes.lock().unwrap().push((cols, rows));
            Ok(())
        }

        /// The parsed bytes as text lines, in a 80x24 screen that never scrolls: enough to see the plumbing.
        fn snapshot(&self, window: usize) -> Result<CoreSnapshot, String> {
            self.doorbell.read();
            let text = String::from_utf8_lossy(&self.seen.lock().unwrap()).into_owned();
            let rows: Vec<String> = text.lines().take(window).map(str::to_owned).collect();
            Ok(CoreSnapshot {
                state: CoreState {
                    columns: 80,
                    rows: 24,
                    cursor: CoreCursor { x: 0, y: 0 },
                    modes: CoreModes {
                        bracketed_paste: false,
                        mouse_tracking: CoreMouse::None,
                        alternate_screen: false,
                        application_cursor_keys: false,
                    },
                    viewport: CoreViewport {
                        top: 0,
                        rows: 24,
                        length: rows.len().max(24),
                        following: true,
                    },
                },
                window: CoreRows { first: 0, rows },
                events: Vec::new(),
            })
        }

        fn scroll(&self, _: CoreScroll, window: usize) -> Result<CoreSnapshot, String> {
            self.snapshot(window)
        }

        fn watch(&self, ring: Box<dyn Fn() + Send + Sync>) {
            self.doorbell.connect(ring);
        }

        fn set_active(&self, active: bool) {
            self.active.store(active, SeqCst);
            if active {
                self.doorbell.wake();
            }
        }

        fn close(&self) {
            self.closed.store(true, SeqCst);
        }
    }

    impl OutputSink for ChecksumCore {
        fn data(&self, bytes: &[u8]) -> Result<(), String> {
            self.feed(bytes.to_vec())
        }

        fn closed(&self, _: String, _: bool) -> Result<(), String> {
            Ok(())
        }
    }

    /// Deterministic pseudo-random bytes (xorshift), so a checksum covers real entropy.
    pub(crate) fn workload(len: usize) -> Vec<u8> {
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect()
    }

    pub(crate) fn sha256(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::fake::ChecksumCore;
    use super::*;

    fn channel() -> Channel<SshEvent> {
        Channel::new(|_| Ok(()))
    }

    #[test]
    fn an_offer_is_taken_once_by_the_channel_it_was_made_for() {
        let (core, prepared) = ChecksumCore::prepared();
        let (mine, other) = (channel(), channel());
        offer(&mine, Box::new(move || Ok(prepared)));
        assert!(
            prepare(&other).unwrap().is_none(),
            "another channel gets no core"
        );
        let taken = prepare(&mine).unwrap().expect("the offer");
        assert!(prepare(&mine).unwrap().is_none(), "an offer is single use");
        drop(taken); // the connect failed before the session existed
        assert!(
            core.closed.load(std::sync::atomic::Ordering::SeqCst),
            "an unattached core is freed"
        );
    }

    #[test]
    fn a_locked_app_can_free_a_core_but_not_open_or_read_one() {
        use crate::app_lock::allowed_while_locked;
        assert!(allowed_while_locked("terminal_core_close"));
        for protected in [
            "terminal_core_open",
            "terminal_core_text",
            "terminal_core_snapshot",
            "terminal_core_scroll",
            "terminal_core_watch",
            "terminal_core_active",
        ] {
            assert!(!allowed_while_locked(protected), "{protected}");
        }
    }

    #[test]
    fn a_failed_build_surfaces_as_the_connect_error() {
        let channel = channel();
        offer(
            &channel,
            Box::new(|| Err("scrollback budget exhausted".into())),
        );
        assert_eq!(
            prepare(&channel).err().as_deref(),
            Some("scrollback budget exhausted")
        );
    }

    #[test]
    fn renderer_replacement_frees_attached_cores() {
        let (attached, prepared) = ChecksumCore::prepared();
        prepared.attach("rebind-attached", &CoreSlot::default(), Arc::new(|_| {}));
        close_all();
        assert!(attached.closed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(live("rebind-attached").is_err());
    }

    #[test]
    fn unclaimed_offers_are_bounded_and_the_oldest_is_dropped() {
        // A private registry: the global one is shared by every test running in parallel.
        let mut offers = Registry::default();
        let cores: Vec<_> = (0..=MAX_OFFERS as u32)
            .map(|channel| {
                let (core, prepared) = ChecksumCore::prepared();
                offers.offer(channel, Box::new(move || Ok(prepared)));
                core
            })
            .collect();
        assert!(
            offers.take_offer(0).is_none(),
            "the oldest offer was evicted"
        );
        assert!(
            cores[0].closed.load(std::sync::atomic::Ordering::SeqCst),
            "and its core freed"
        );
        assert!(offers.take_offer(MAX_OFFERS as u32).is_some());
    }

    #[cfg(not(feature = "native-terminal"))]
    fn lease() -> AccessLease {
        crate::app_lock::AccessState::disabled()
            .lease(None)
            .unwrap()
    }

    #[cfg(not(feature = "native-terminal"))]
    #[tokio::test]
    async fn without_the_feature_the_commands_say_the_core_is_not_built() {
        let error = terminal_core_open(lease(), channel(), 80, 24, None)
            .await
            .err()
            .unwrap()
            .into_inner()
            .unwrap();
        assert!(error.contains("not built"), "{error}");
        assert!(terminal_core_open(lease(), channel(), 0, 24, None)
            .await
            .is_err());
        assert!(terminal_core_text(lease(), "none".into()).await.is_err());
        terminal_core_close("none".into()).unwrap();
    }

    /// The renderer's lease and a fake core attached under `id`, for the tests of what belongs to the current renderer.
    fn leased_core(id: &str) -> (crate::app_lock::AccessState, AccessLease) {
        let access = crate::app_lock::AccessState::disabled();
        let renderer = access.lease(None).unwrap();
        let (_core, prepared) = ChecksumCore::prepared();
        prepared.attach(id, &CoreSlot::default(), Arc::new(|_| {}));
        (access, renderer)
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn a_replaced_renderer_cannot_read_a_core() {
        let _kept = tests_keeping_cores().read();
        let (access, renderer) = leased_core("lease-gated");
        let text = terminal_core_text(renderer.clone(), "lease-gated".into())
            .await
            .unwrap();
        assert!(text.into_inner().is_ok());
        access.replace_renderer().unwrap();
        assert!(terminal_core_text(renderer, "lease-gated".into())
            .await
            .is_err());
        close("lease-gated");
    }

    /// Rings counted; the stand-in for the channel a renderer watches.
    fn bell() -> (
        Arc<std::sync::atomic::AtomicUsize>,
        Box<dyn Fn() + Send + Sync>,
    ) {
        let rings = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = rings.clone();
        (
            rings,
            Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        )
    }

    #[test]
    fn a_doorbell_rings_once_per_read_however_much_output_arrives() {
        let (rings, ring) = bell();
        let doorbell = Doorbell::default();
        doorbell.changed(); // nobody watches yet: nothing to ring
        doorbell.connect(ring);
        for _ in 0..10_000 {
            doorbell.changed();
        }
        assert_eq!(rings.load(Ordering::SeqCst), 1);
        doorbell.read();
        doorbell.changed();
        doorbell.changed();
        assert_eq!(rings.load(Ordering::SeqCst), 2);
        // A wake-up rings even though the last ring was never answered.
        doorbell.wake();
        assert_eq!(rings.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_core_wakes_its_watcher_once_per_read_and_not_while_inactive() {
        let (core, prepared) = ChecksumCore::prepared();
        prepared.attach("doorbell", &CoreSlot::default(), Arc::new(|_| {}));
        let (rings, ring) = bell();
        core.watch(ring);
        let wait = |expected: usize| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while core.seen.lock().unwrap().len() < expected {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the core parsed {expected} bytes"
                );
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        };
        for _ in 0..50 {
            core.feed(b"line\n".to_vec()).unwrap();
        }
        wait(250);
        assert_eq!(rings.load(Ordering::SeqCst), 1, "50 chunks, one signal");
        assert_eq!(core.snapshot(8).unwrap().window.rows.len(), 8);
        core.feed(b"more\n".to_vec()).unwrap();
        wait(255);
        assert_eq!(rings.load(Ordering::SeqCst), 2, "a read rearms it");
        core.set_active(false);
        core.snapshot(8).unwrap();
        core.feed(b"hidden\n".to_vec()).unwrap();
        wait(262);
        assert_eq!(
            rings.load(Ordering::SeqCst),
            2,
            "an inactive session wakes nobody"
        );
        core.set_active(true);
        assert_eq!(
            rings.load(Ordering::SeqCst),
            3,
            "and rings once to catch up when it is looked at again"
        );
        close("doorbell");
    }

    #[test]
    fn the_commands_belong_to_the_current_renderer_and_a_session_that_exists() {
        let _kept = tests_keeping_cores().read();
        let (access, renderer) = leased_core("control-plane");
        let snapshot = |id: &str| {
            tauri::async_runtime::block_on(terminal_core_snapshot(
                renderer.clone(),
                id.into(),
                Some(4),
            ))
        };
        let scroll = || {
            tauri::async_runtime::block_on(terminal_core_scroll(
                renderer.clone(),
                "control-plane".into(),
                CoreScroll::ToTop,
                None,
            ))
        };
        let watch = || {
            let events = Channel::<CoreSignal>::new(|_| Ok(()));
            tauri::async_runtime::block_on(terminal_core_watch(
                renderer.clone(),
                "control-plane".into(),
                events,
            ))
        };
        let active = || {
            tauri::async_runtime::block_on(terminal_core_active(
                renderer.clone(),
                "control-plane".into(),
                false,
            ))
        };
        assert!(snapshot("control-plane").unwrap().into_inner().is_ok());
        assert!(scroll().unwrap().into_inner().is_ok());
        assert!(watch().unwrap().into_inner().is_ok());
        assert!(active().unwrap().into_inner().is_ok());
        let missing = snapshot("nobody").err().unwrap().into_inner().unwrap();
        assert_eq!(missing, "No native terminal core for this session");
        access.replace_renderer().unwrap();
        assert!(snapshot("control-plane").is_err());
        assert!(scroll().is_err());
        assert!(watch().is_err());
        assert!(active().is_err());
        close("control-plane");
    }

    #[test]
    fn reports_are_bounded_and_only_what_the_user_may_be_offered() {
        let big = vec![b'a'; MAX_CLIPBOARD + 1];
        let fits = vec![b'a'; MAX_CLIPBOARD];
        let events = report(
            20,
            vec![b"hello".to_vec(), vec![0xff, 0xfe], big, fits.clone()],
            vec![b"file:///tmp/work".to_vec()],
        );
        let bells = events
            .iter()
            .take_while(|event| **event == CoreEvent::Bell)
            .count();
        assert_eq!(bells, 8, "a flood of bells is capped");
        assert_eq!(
            events[bells..],
            [
                CoreEvent::Clipboard {
                    text: "hello".into()
                },
                CoreEvent::Clipboard {
                    text: String::from_utf8(fits).unwrap()
                },
                CoreEvent::Cwd {
                    report: "file:///tmp/work".into()
                },
            ],
            "invalid UTF-8 and oversized writes are dropped, the rest keep their order"
        );
        assert!(report(0, vec![], vec![]).is_empty());
    }

    #[test]
    fn a_window_is_always_bounded() {
        assert_eq!(window_rows(None), DEFAULT_WINDOW);
        assert_eq!(window_rows(Some(0)), 1);
        assert_eq!(window_rows(Some(40)), 40);
        assert_eq!(window_rows(Some(usize::MAX)), MAX_WINDOW);
    }

    fn control_plane_cases() -> Vec<serde_json::Value> {
        let json: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/terminal-runtime/fixtures/control-plane.json"
        ))
        .unwrap();
        json["cases"].as_array().unwrap().clone()
    }

    /// The client reads these answers and sends these scrolls: the fixture is what headless xterm.js gave for
    /// the same cases, so a field renamed on either side fails here before it fails on a device.
    #[test]
    fn the_wire_format_is_the_one_the_client_and_the_runtime_fixture_use() {
        for case in control_plane_cases() {
            for answer in case["snapshots"].as_array().unwrap() {
                let parsed: CoreSnapshot = serde_json::from_value(answer.clone()).unwrap();
                assert_eq!(
                    &serde_json::to_value(&parsed).unwrap(),
                    answer,
                    "{}",
                    case["id"]
                );
            }
            for step in case["steps"].as_array().unwrap() {
                serde_json::from_value::<CoreScroll>(step.clone())
                    .unwrap_or_else(|error| panic!("{step}: {error}"));
            }
        }
        let events = serde_json::to_value(CoreSnapshot {
            events: vec![
                CoreEvent::Bell,
                CoreEvent::Cwd {
                    report: "file:///a".into(),
                },
                CoreEvent::Clipboard { text: "hi".into() },
            ],
            ..serde_json::from_value(control_plane_cases()[0]["snapshots"][0].clone()).unwrap()
        })
        .unwrap();
        assert_eq!(
            events["events"],
            serde_json::json!([{"type": "bell"}, {"type": "cwd", "report": "file:///a"}, {"type": "clipboard", "text": "hi"}])
        );
        assert_eq!(
            serde_json::to_value(CoreSignal::Changed).unwrap(),
            serde_json::json!({"type": "changed"})
        );
    }

    #[cfg(not(feature = "native-terminal"))]
    #[test]
    fn no_control_plane_answer_carries_a_cell() {
        // A snapshot is state, text rows and raw reports; a field that held cells would show up in this list.
        let answer =
            serde_json::to_value(control_plane_cases().remove(0)["snapshots"][0].clone()).unwrap();
        let keys = |value: &serde_json::Value| {
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(keys(&answer), ["state", "window"].map(String::from).into());
        assert!(answer["window"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(serde_json::Value::is_string));
    }

    /// A real core (libghostty-vt) that has been fed `bytes` and has parsed them: its credit comes back only after the VT ran.
    #[cfg(feature = "native-terminal")]
    fn real_core_fed(
        cols: u32,
        rows: u32,
        bytes: &[u8],
        watcher: Option<Box<dyn Fn() + Send + Sync>>,
    ) -> (Arc<dyn Core>, Prepared) {
        use std::sync::atomic::AtomicUsize;
        let prepared = native::factory(cols, rows, Some(1 << 20)).unwrap()().unwrap();
        let core = prepared.core.clone();
        let processed = Arc::new(AtomicUsize::new(0));
        let counter = processed.clone();
        prepared
            .cell
            .0
            .set(Arc::new(move |credit| {
                counter.fetch_add(credit, Ordering::SeqCst);
            }))
            .ok();
        if let Some(ring) = watcher {
            core.watch(ring);
        }
        for chunk in bytes.chunks(16 * 1024) {
            core.feed(chunk.to_vec()).unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while processed.load(Ordering::SeqCst) < bytes.len() {
            assert!(
                std::time::Instant::now() < deadline,
                "the core parsed the stream"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        (core, prepared)
    }

    /// The real core (`--features native-terminal`, Zig) answers every fixture case as headless xterm.js did.
    #[cfg(feature = "native-terminal")]
    #[test]
    fn the_real_core_answers_the_fixture_as_xterm_js_did() {
        for case in control_plane_cases() {
            let number = |key: &str| case[key].as_u64().unwrap() as u32;
            let (core, _prepared) = real_core_fed(
                number("cols"),
                number("rows"),
                case["write"].as_str().unwrap().as_bytes(),
                None,
            );
            let window = number("window") as usize;
            let mut answers = vec![core.snapshot(window).unwrap()];
            for step in case["steps"].as_array().unwrap() {
                answers.push(
                    core.scroll(serde_json::from_value(step.clone()).unwrap(), window)
                        .unwrap(),
                );
            }
            let expected = case["snapshots"].as_array().unwrap();
            assert_eq!(answers.len(), expected.len());
            for (at, (answer, expected)) in answers.iter().zip(expected).enumerate() {
                assert_eq!(
                    &serde_json::to_value(answer).unwrap(),
                    expected,
                    "{}, answer {at}",
                    case["id"]
                );
            }
            core.close();
        }
    }

    /// What the program reported reaches the control plane once, as raw reports the client decodes.
    #[cfg(feature = "native-terminal")]
    #[test]
    fn the_real_core_reports_a_bell_a_clipboard_write_and_a_directory_once() {
        let (rings, ring) = bell();
        let output = b"\x07\x1b]52;c;aGVsbG8=\x07\x1b]7;file:///tmp/work\x07";
        let (core, _prepared) = real_core_fed(20, 3, output, Some(ring));
        assert_eq!(rings.load(Ordering::SeqCst), 1);
        let answer = core.snapshot(8).unwrap();
        assert_eq!(
            answer.events,
            vec![
                CoreEvent::Bell,
                CoreEvent::Clipboard {
                    text: "hello".into()
                },
                CoreEvent::Cwd {
                    report: "file:///tmp/work".into()
                },
            ]
        );
        assert!(core.snapshot(8).unwrap().events.is_empty(), "taken once");
        core.close();
    }
}
