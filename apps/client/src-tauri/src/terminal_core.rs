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
//! changed) and attaches the core before the first byte is read.
//!
//! The way back (#1316): terminal replies (DA, DSR, ...) and the input the core encodes (keys, mouse,
//! paste, focus) leave through the core's one writer into the same input queue the renderer's own
//! write commands use, so every transport's lease re-check, ordering and pacing apply unchanged. The
//! writer sends under the renderer's latest [`AccessLease`] (the one that opened the core, replaced by
//! each input command) and refuses once that lease is no longer valid, so nothing goes out while the
//! app is locked, backgrounded or its renderer was replaced; a refused reply is dropped, never held.
//!
//! The control plane (#1321): `terminal_core_snapshot`, `_scroll`, `_resize` and `_set_active` answer with the state
//! and the text of a bounded window of rows, never a cell, and the core's event stream (the screen changed, title,
//! bell, directory, clipboard) goes out on the same `Channel` that opened it, at most one `changed` per read of the
//! state however much output arrives. The text questions (#1320) are a command each: `terminal_core_selection_text`,
//! `_search`, `_word_at`, `_line_at`, `_buffer_range` and `_copy_screen` answer with text, a range or a hit, and
//! `terminal_core_select` hands the selection to the session, where a renderer host draws it. The logic is the runtime crate's (`control_*`, [`Doorbell`]), which the stdio
//! harness shares; this module gates it behind the renderer's access lease.
//!
//! The way out (#1342): `terminal_core_release(events)` hands a session's transport back to the WebView. From the
//! next chunk on, the output and the closing notice go to the new `events` Channel and the WebView acknowledges
//! them; the core parses what it was fed before that, answers with an ANSI snapshot of its visible screen, cursor
//! and modes (`terminal_core_ansi_snapshot` reads the same without releasing) and is freed. A chunk is never
//! split, so a reader that replays the snapshot and then the Channel's data has every byte once, in order.
//! Scrollback is not carried over.
#![cfg_attr(not(test), allow(dead_code))]

use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::SshEvent;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError};
use tauri::ipc::Channel;

/// What the control commands answer and take, as JSON: the runtime crate's `ControlSnapshot` and `ScrollAction`
/// serialized, which that crate pins to the fixture of what xterm.js answers. The commands pass it through, so the
/// wire format has one definition and a build without the `native-terminal` feature needs no copy of it.
pub(crate) type Json = serde_json::Value;

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
    /// Bytes that rebuild the visible screen, the cursor and the modes in a fresh terminal of the same size, and
    /// how many bytes the core was fed and has not parsed yet (the snapshot is missing those).
    fn ansi_snapshot(&self) -> Result<(String, usize), String>;
    /// The renderer's grid changed: the terminal's size, so the transport's output wraps as drawn.
    fn resize(&self, cols: u32, rows: u32) -> Result<(), String>;
    /// Encode one input event for the modes the program has set and queue the bytes on the transport
    /// under `lease`; the bytes sent (0 when the modes ask for nothing, such as a focus event the
    /// program did not enable). Refused while `lease` is no longer valid.
    fn input(&self, lease: &AccessLease, input: CoreInput) -> Result<usize, String>;
    /// The control plane: the state and a bounded window of row text, never cells. Reading rearms the doorbell
    /// and refreshes the lease the core's events leave under. `window` is the rows asked for, bounded by the core.
    fn control_snapshot(&self, lease: &AccessLease, window: Option<usize>) -> Result<Json, String>;
    /// Moves the viewport as a reader asked, then answers like [`Core::control_snapshot`].
    fn control_scroll(
        &self,
        lease: &AccessLease,
        action: Json,
        window: Option<usize>,
    ) -> Result<Json, String>;
    /// Sizes the core as [`Core::resize`] does, then answers with the state it has (a transport that owns the
    /// size keeps it).
    fn control_resize(
        &self,
        lease: &AccessLease,
        cols: u32,
        rows: u32,
        window: Option<usize>,
    ) -> Result<Json, String>;
    /// One question about the buffer's text (#1320): selected text, a search, the word or line at a place, the
    /// whole buffer's range or the screen's text. The answer is text, a range or a hit, never cells.
    fn control_query(&self, lease: &AccessLease, query: Json) -> Result<Json, String>;
    /// The cells the renderer highlights as selected, in absolute rows; `None` clears them.
    fn select(&self, lease: &AccessLease, range: Option<Json>) -> Result<(), String>;
    /// Whether a reader is looking. An inactive core keeps parsing and wakes nobody; becoming active rings once
    /// to catch up. A core starts active.
    fn set_active(&self, lease: &AccessLease, active: bool);
    /// The app's terminal theme changed: report these colours to the queries that arrive from now on.
    fn set_theme(&self, theme: &Json) -> Result<(), String>;
    /// The History lines setting changed (already within [`HISTORY_LINES`]): keep that many rows of history from now
    /// on, dropping the oldest at once when it is fewer than the core holds.
    fn set_scrollback(&self, lines: u32) -> Result<(), String>;
    /// The session a renderer host draws and the inbox its `changed` calls ring, made again for each call
    /// (a surface that is placed again draws the same session). `None` for a core with nothing to draw.
    #[cfg(all(feature = "native-terminal", native_terminal_core))]
    fn drawing(
        &self,
    ) -> Option<(
        lazysh_terminal_runtime::Session,
        crate::native_renderer::Inbox,
    )> {
        None
    }
    /// The session's transport ended: a Mosh display left inside a frame has failed, and the reader is told before the
    /// closing notice that follows. Nothing for a core that follows no frames.
    fn finished(&self) {}
    /// Free the core now. Idempotent.
    fn close(&self);
}

/// What a renderer opens a core with besides its size and history, as `terminal_core_open`'s `config`.
#[derive(Debug, Default, Deserialize)]
#[cfg_attr(not(feature = "native-terminal"), allow(dead_code))]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct CoreConfig {
    /// The app's terminal theme as the client's `TerminalTheme` (CSS hex colours). The core reports it to programs
    /// that ask for the default colours (`OSC 10`, `11`, `12` and `4`); absent, it reports its own default colours.
    pub(crate) theme: Option<Json>,
    /// The session's transport is Mosh: its frames decide the grid's size and the renderer's sizes are only intent.
    pub(crate) canonical_frames: bool,
}

/// Most text one paste (or one committed text) may carry, the limit `write_stdin` puts on a paste.
const MAX_PASTE: usize = 64 * 1024;

/// One input event of the renderer for the core to encode, in the shape of the DOM event it came
/// from: `code` names the physical key and `key` what it produced.
// The fields are read by the real core, which is built only with the `native-terminal` feature.
#[derive(Debug, Deserialize)]
#[cfg_attr(not(native_terminal_core), allow(dead_code))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum CoreInput {
    Key {
        code: String,
        key: String,
        #[serde(default)]
        mods: Mods,
        #[serde(default)]
        repeat: bool,
        #[serde(default)]
        release: bool,
        #[serde(default)]
        composing: bool,
    },
    Mouse {
        action: MouseAction,
        button: Option<MouseButton>,
        #[serde(default)]
        mods: Mods,
        /// Pointer position from the top-left in the core's pixels. The bridge's grid has 1 px cells
        /// (`resize` carries no pixel size yet), so this is a position in cells until the renderer
        /// reports its metrics (#1321).
        x: f32,
        y: f32,
    },
    /// Bracketed only when the program enabled it.
    Paste { text: String },
    /// What a soft keyboard or an IME committed (a word, DEL for an erase, CR for Enter): sent verbatim, as it
    /// names no key and no protocol may rewrite it. A pre-edit still being composed is not committed text.
    Text { text: String },
    /// Reported only while the program enabled focus events.
    Focus { focused: bool },
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[cfg_attr(not(native_terminal_core), allow(dead_code))]
#[serde(default)]
pub(crate) struct Mods {
    pub(crate) shift: bool,
    pub(crate) ctrl: bool,
    pub(crate) alt: bool,
    pub(crate) meta: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(not(native_terminal_core), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub(crate) enum MouseAction {
    Press,
    Release,
    Motion,
}

/// X11 buttons 1 to 5.
#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(not(native_terminal_core), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub(crate) enum MouseButton {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
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

/// Queues bytes on a transport session's input as one write under a lease: the queue its own write
/// commands use. An `Err` means the queue is full or the transport is gone.
pub(crate) type InputQueue = Arc<dyn Fn(Vec<u8>, &AccessLease) -> Result<(), String> + Send + Sync>;

/// The input queue of a transport session; a write for a session that is gone is refused.
pub(crate) fn input_to<S: Send + Sync + 'static>(
    session: &Arc<S>,
    queue: fn(&S, Vec<u8>, &AccessLease) -> Result<(), String>,
) -> InputQueue {
    let session = Arc::downgrade(session);
    Arc::new(move |bytes, lease| match session.upgrade() {
        Some(session) => queue(&session, bytes, lease),
        None => Err("Terminal session is gone".into()),
    })
}

/// Most bytes one write may carry: a 64 KiB paste (the limit of `write_stdin`) and its bracket markers.
const MAX_WRITE: usize = 64 * 1024 + 16;

/// What a core needs from the transport session it will be attached to. The core is built before that
/// session exists, so the credit return and the input queue are filled in by [`Prepared::attach`];
/// nothing is fed or written before that.
#[derive(Default)]
pub(crate) struct Link {
    credit: OnceLock<CreditReturn>,
    input: OnceLock<InputQueue>,
    /// The renderer's latest lease: the one that opened the core, then that of each input command.
    lease: Mutex<Option<AccessLease>>,
}

impl Link {
    pub(crate) fn returner(self: &Arc<Self>) -> CreditReturn {
        let link = self.clone();
        Arc::new(move |bytes| {
            if let Some(credit) = link.credit.get() {
                credit(bytes);
            }
        })
    }

    /// The lease later writes are made under (replies included, which no command carries a lease for).
    pub(crate) fn use_lease(&self, lease: &AccessLease) {
        *self.lease.lock().unwrap_or_else(PoisonError::into_inner) = Some(lease.clone());
    }

    /// Whether the renderer's latest lease is valid: the app is unlocked, in the foreground and has not replaced
    /// the renderer. What the core says about the screen (a title, a clipboard write) leaves only while it is.
    #[cfg_attr(not(native_terminal_core), allow(dead_code))]
    pub(crate) fn permits(&self) -> bool {
        self.lease
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|lease| lease.check().is_ok())
    }

    /// One write to the transport: refused before the session is attached, once the lease is no longer
    /// valid, when it is larger than [`MAX_WRITE`], and when the queue is full.
    pub(crate) fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let queue = self.input.get().ok_or("The core has no transport yet")?;
        let lease = self
            .lease
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or("The core has no access lease")?;
        if bytes.len() > MAX_WRITE {
            return Err("Terminal input is too large".into());
        }
        lease.check().map_err(|_| "Terminal input is gated")?;
        queue(bytes.to_vec(), &lease)
    }
}

/// A core and where its session's output goes once it was released: the Channel [`release`] was given. One
/// delivery holds the lock, so a chunk goes whole to the core or whole to that Channel.
#[derive(Clone)]
struct Attached {
    core: Arc<dyn Core>,
    handed: Arc<Mutex<Option<Channel<SshEvent>>>>,
}

impl Attached {
    fn handed(&self) -> std::sync::MutexGuard<'_, Option<Channel<SshEvent>>> {
        self.handed.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The core a session's output is routed to, and the id it is registered under, set at most once.
#[derive(Default)]
pub(crate) struct CoreSlot(OnceLock<(String, Attached)>);

impl CoreSlot {
    /// The core, while it still consumes the session's output.
    fn consuming(&self) -> Option<&Attached> {
        let (_, attached) = self.0.get()?;
        attached.handed().is_none().then_some(attached)
    }

    /// A renderer must not acknowledge output a core consumes: the core alone returns that credit. After a
    /// release the output is the WebView's again, and so is its acknowledgement.
    pub(crate) fn is_attached(&self) -> bool {
        self.consuming().is_some()
    }

    /// A resize the renderer sent to the transport, for the core to follow (a no-op without a core).
    pub(crate) fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        self.consuming()
            .map_or(Ok(()), |attached| attached.core.resize(cols, rows))
    }

    /// Free the core of a session whose id the renderer will never receive (the connect failed or was
    /// cancelled after the core was attached), so its screen and scrollback budget do not leak.
    pub(crate) fn discard(&self) {
        if let Some((id, _)) = self.0.get() {
            close(id);
        }
    }

    /// The sink for one delivery: output data goes to the core if attached, otherwise to the
    /// Channel; the closing notice always goes to the Channel, which stays the control path. After a
    /// release, both go to the Channel the session was released to.
    pub(crate) fn route<'a>(&'a self, channel: &'a Channel<SshEvent>) -> Routed<'a> {
        Routed {
            channel,
            attached: self.0.get().map(|(_, attached)| attached),
        }
    }
}

pub(crate) struct Routed<'a> {
    channel: &'a Channel<SshEvent>,
    attached: Option<&'a Attached>,
}

impl OutputSink for Routed<'_> {
    fn data(&self, bytes: &[u8]) -> Result<(), String> {
        let Some(attached) = self.attached else {
            return self.channel.data(bytes);
        };
        match &*attached.handed() {
            Some(channel) => channel.data(bytes),
            None => attached.core.feed(bytes.to_vec()),
        }
    }

    fn closed(&self, message: String, lost: bool) -> Result<(), String> {
        let handed = self.attached.and_then(|attached| attached.handed().clone());
        if let (None, Some(attached)) = (&handed, self.attached) {
            attached.core.finished();
        }
        handed
            .as_ref()
            .unwrap_or(self.channel)
            .closed(message, lost)
    }
}

/// A core built for a session that is about to be created. Dropped unattached (the connect failed),
/// it frees the core.
pub(crate) struct Prepared {
    core: Arc<dyn Core>,
    link: Arc<Link>,
    attached: bool,
}

impl Prepared {
    pub(crate) fn new(core: Arc<dyn Core>, link: Arc<Link>) -> Self {
        Self {
            core,
            link,
            attached: false,
        }
    }

    /// Route the session's output to the core and register it under the session id. `credit` is the
    /// session's own window release and `input` its input queue, where the core's replies and encoded
    /// input go.
    pub(crate) fn attach(
        mut self,
        id: &str,
        slot: &CoreSlot,
        credit: CreditReturn,
        input: InputQueue,
    ) {
        let _ = self.link.credit.set(credit);
        let _ = self.link.input.set(input);
        let attached = Attached {
            core: self.core.clone(),
            handed: Arc::default(),
        };
        slot.0.set((id.to_owned(), attached.clone())).ok();
        registry().live.insert(id.to_owned(), attached);
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
    live: HashMap<String, Attached>,
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

fn attached(id: &str) -> Result<Attached, String> {
    registry()
        .live
        .get(id)
        .cloned()
        .ok_or_else(|| "No native terminal core for this session".into())
}

pub(crate) fn live(id: &str) -> Result<Arc<dyn Core>, String> {
    attached(id).map(|attached| attached.core)
}

pub(crate) fn close(id: &str) {
    let attached = registry().live.remove(id);
    if let Some(attached) = attached {
        attached.core.close();
    }
}

/// How long [`release`] waits for the core to parse what it was fed: at most one transport window, parsed in
/// milliseconds, so this only ends a wait on a core that stopped.
const RELEASE_DRAIN: std::time::Duration = std::time::Duration::from_secs(5);

/// Hand the session's transport back to the WebView (#1342): its output goes to `events` from the next chunk on,
/// and the answer is the core's ANSI snapshot once it has parsed every chunk it was fed before that. The core is
/// freed either way. On an error the output already flows to `events`, with no screen to start from.
pub(crate) async fn release(id: &str, events: Channel<SshEvent>) -> Result<String, String> {
    let attached = attached(id)?;
    {
        let mut handed = attached.handed();
        if handed.is_some() {
            return Err("This session is already being released".into());
        }
        *handed = Some(events);
    }
    let started = std::time::Instant::now();
    let snapshot = loop {
        match attached.core.ansi_snapshot() {
            Ok((snapshot, 0)) => break Ok(snapshot),
            Ok(_) if started.elapsed() < RELEASE_DRAIN => {
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
            Ok(_) => break Err("The terminal core did not finish its output".to_owned()),
            Err(error) => break Err(error),
        }
    };
    close(id);
    snapshot
}

/// A renderer replacement ends every renderer-owned session; the cores they fed go with them,
/// so a screen cannot outlive the lock that protected it. Unclaimed offers hold no core yet and are
/// left to the cap above.
pub(crate) fn close_all() {
    #[cfg(test)]
    let _exclusive = tests_keeping_cores().write();
    let live = std::mem::take(&mut registry().live);
    live.values().for_each(|attached| attached.core.close());
}

/// What every native terminal command says in a build made with `LAZYSH_NATIVE_TERMINAL=off` (the kill switch, see `build.rs`).
pub(crate) const DISABLED_IN_BUILD: &str = "The native terminal is disabled in this build";

type AccessResult<T> = Result<Guarded<T>, GuardedError<String>>;

/// The History lines setting's range (`scrollback` in `preferences.ts`).
const HISTORY_LINES: std::ops::RangeInclusive<u32> = 100..=20_000;

fn history_lines(lines: Option<u32>) -> Result<(), String> {
    match lines {
        Some(lines) if !HISTORY_LINES.contains(&lines) => Err(format!(
            "scrollback lines must be {} to {}",
            HISTORY_LINES.start(),
            HISTORY_LINES.end()
        )),
        _ => Ok(()),
    }
}

/// Like the terminal commands, the two that create or read a screen belong to the current renderer:
/// a replaced renderer's lease is refused. `scrollback_lines` is the History lines setting; the core
/// requests a budget for that many rows of ordinary output (see `scrollback_bytes_for_lines`);
/// the hub may grant less. When absent, the core uses its default history budget. `config` is how the session differs
/// from the default core: the app's colours and the Mosh canonical-frame mode, both fixed before the first byte.
#[tauri::command]
pub async fn terminal_core_open(
    lease: AccessLease,
    events: Channel<SshEvent>,
    cols: u32,
    rows: u32,
    scrollback_lines: Option<u32>,
    config: Option<CoreConfig>,
) -> AccessResult<()> {
    lease
        .run(async {
            crate::ssh::check_size(cols, rows).map_err(|error| error.message().to_owned())?;
            history_lines(scrollback_lines)?;
            offer(
                &events,
                native::factory(
                    cols,
                    rows,
                    scrollback_lines,
                    config.unwrap_or_default(),
                    lease.clone(),
                    events.clone(),
                )?,
            );
            Ok(())
        })
        .await
}

/// A renderer's input event, encoded by the core and queued on the session's transport. Like the
/// write commands it belongs to the current renderer: a locked app or a replaced renderer is refused.
#[tauri::command]
pub async fn terminal_core_input(
    lease: AccessLease,
    session_id: String,
    input: CoreInput,
) -> AccessResult<usize> {
    lease
        .run(async {
            if matches!(&input, CoreInput::Paste { text } | CoreInput::Text { text } if text.len() > MAX_PASTE)
            {
                return Err("Send at most 64 KiB of text at once".to_owned());
            }
            live(&session_id)?.input(&lease, input)
        })
        .await
}

#[tauri::command]
pub async fn terminal_core_text(lease: AccessLease, session_id: String) -> AccessResult<String> {
    lease
        .run(async { live(&session_id)?.viewport_text() })
        .await
}

/// The visible screen, cursor and modes as bytes a fresh terminal of the same size replays (#1342); the scrollback
/// is not part of it. Like `terminal_core_text` it belongs to the current renderer.
#[tauri::command]
pub async fn terminal_core_ansi_snapshot(
    lease: AccessLease,
    session_id: String,
) -> AccessResult<String> {
    lease
        .run(async { Ok(live(&session_id)?.ansi_snapshot()?.0) })
        .await
}

/// Hands the session's transport back to the WebView: see [`release`]. The renderer replays the answer into its
/// terminal first, then the data of `events`, which it acknowledges like any Channel terminal's.
#[tauri::command]
pub async fn terminal_core_release(
    lease: AccessLease,
    session_id: String,
    events: Channel<SshEvent>,
) -> AccessResult<String> {
    lease.run(release(&session_id, events)).await
}

/// The control plane (#1321) belongs to the current renderer like `terminal_core_text`: a locked app or a replaced
/// renderer is refused. `window` is how many rows of text the answer may carry; the core bounds it.
#[tauri::command]
pub async fn terminal_core_snapshot(
    lease: AccessLease,
    session_id: String,
    window: Option<usize>,
) -> AccessResult<Json> {
    lease
        .run(async { live(&session_id)?.control_snapshot(&lease, window) })
        .await
}

#[tauri::command]
pub async fn terminal_core_scroll(
    lease: AccessLease,
    session_id: String,
    action: Json,
    window: Option<usize>,
) -> AccessResult<Json> {
    lease
        .run(async { live(&session_id)?.control_scroll(&lease, action, window) })
        .await
}

/// For a core the renderer sizes itself. A core behind a transport follows the transport's own resize, which the
/// renderer already sends; this command is how a snapshot of the result is asked for, and what a core-only build uses.
#[tauri::command]
pub async fn terminal_core_resize(
    lease: AccessLease,
    session_id: String,
    cols: u32,
    rows: u32,
    window: Option<usize>,
) -> AccessResult<Json> {
    lease
        .run(async {
            crate::ssh::check_size(cols, rows).map_err(|error| error.message().to_owned())?;
            live(&session_id)?.control_resize(&lease, cols, rows, window)
        })
        .await
}

/// One question about the buffer's text, for the current renderer like the rest of the control plane.
async fn query(lease: AccessLease, session_id: String, query: Json) -> AccessResult<Json> {
    lease
        .run(async { live(&session_id)?.control_query(&lease, query) })
        .await
}

/// The text of a range of cells (absolute rows, both ends inclusive) as a copy takes it.
#[tauri::command]
pub async fn terminal_core_selection_text(
    lease: AccessLease,
    session_id: String,
    range: Json,
) -> AccessResult<Json> {
    query(
        lease,
        session_id,
        serde_json::json!({"kind": "selectionText", "range": range}),
    )
    .await
}

/// The next row whose text contains `query`, ignoring case and wrapping around; `from` is the previous hit's row.
#[tauri::command]
pub async fn terminal_core_search(
    lease: AccessLease,
    session_id: String,
    query: String,
    direction: Json,
    from: Option<usize>,
) -> AccessResult<Json> {
    let search =
        serde_json::json!({"kind": "search", "query": query, "direction": direction, "from": from});
    self::query(lease, session_id, search).await
}

#[tauri::command]
pub async fn terminal_core_word_at(
    lease: AccessLease,
    session_id: String,
    cell: Json,
) -> AccessResult<Json> {
    let word = serde_json::json!({"kind": "wordAt", "cell": cell});
    query(lease, session_id, word).await
}

/// The link a tap on `cell` opens: an OSC 8 hyperlink, a URL or a host path (`{kind: "url", uri}` or `{kind: "path", ...}`), `null`
/// where there is none.
#[tauri::command]
pub async fn terminal_core_link_at(
    lease: AccessLease,
    session_id: String,
    cell: Json,
) -> AccessResult<Json> {
    let link = serde_json::json!({"kind": "linkAt", "cell": cell});
    query(lease, session_id, link).await
}

/// The whole soft-wrapped line that holds `row`.
#[tauri::command]
pub async fn terminal_core_line_at(
    lease: AccessLease,
    session_id: String,
    row: usize,
) -> AccessResult<Json> {
    let line = serde_json::json!({"kind": "lineAt", "row": row});
    query(lease, session_id, line).await
}

/// Select all: the range of everything held, `null` for an empty buffer.
#[tauri::command]
pub async fn terminal_core_buffer_range(
    lease: AccessLease,
    session_id: String,
) -> AccessResult<Json> {
    query(
        lease,
        session_id,
        serde_json::json!({"kind": "bufferRange"}),
    )
    .await
}

#[tauri::command]
pub async fn terminal_core_copy_screen(
    lease: AccessLease,
    session_id: String,
) -> AccessResult<Json> {
    query(lease, session_id, serde_json::json!({"kind": "copyScreen"})).await
}

/// The selection overlay: the cells the renderer host highlights, or none. The selection itself is the reader's.
#[tauri::command]
pub async fn terminal_core_select(
    lease: AccessLease,
    session_id: String,
    range: Option<Json>,
) -> AccessResult<()> {
    lease
        .run(async { live(&session_id)?.select(&lease, range) })
        .await
}

#[tauri::command]
pub async fn terminal_core_set_active(
    lease: AccessLease,
    session_id: String,
    active: bool,
) -> AccessResult<()> {
    lease
        .run(async {
            live(&session_id)?.set_active(&lease, active);
            Ok(())
        })
        .await
}

/// The app's terminal theme changed (the client's `TerminalTheme`): the core reports its colours from now on.
#[tauri::command]
pub async fn terminal_core_theme(
    lease: AccessLease,
    session_id: String,
    theme: Json,
) -> AccessResult<()> {
    lease
        .run(async { live(&session_id)?.set_theme(&theme) })
        .await
}

/// The History lines setting changed while the session is open: the core keeps that many rows of history from now on.
#[tauri::command]
pub async fn terminal_core_scrollback(
    lease: AccessLease,
    session_id: String,
    lines: u32,
) -> AccessResult<()> {
    lease
        .run(async {
            history_lines(Some(lines))?;
            live(&session_id)?.set_scrollback(lines)
        })
        .await
}

#[tauri::command]
pub fn terminal_core_close(session_id: String) -> Result<(), String> {
    close(&session_id);
    Ok(())
}

/// What `terminal_core_available` answers: whether this build can run a native terminal and, when it cannot, why. The
/// client's registry records the reason as it is, so it says what is missing.
#[derive(Debug, Serialize)]
pub struct CoreAvailability {
    available: bool,
    reason: &'static str,
}

const NOT_BUILT: &str = "The native terminal core is not built into this app";

fn availability(core: bool, host: bool) -> CoreAvailability {
    let reason = match (core, host) {
        (false, _) => NOT_BUILT,
        (true, false) => "The native terminal surface exists on Android and Linux only",
        (true, true) => "The native terminal core and its surface host are present",
    };
    CoreAvailability {
        available: core && host,
        reason,
    }
}

/// The client registry's probe for the native backend: the core is compiled in (`native-terminal`) and the platform has
/// a host to draw it on: Android (#1327) and Linux (#1331) so far; each other platform's host adds its target here. The
/// GPU and surface probe is #1336. Allowed while locked: it reads this build, nothing of the user's.
#[tauri::command]
pub fn terminal_core_available() -> CoreAvailability {
    availability(
        cfg!(native_terminal_core),
        cfg!(any(
            target_os = "android",
            target_os = "linux",
            any(target_os = "macos", target_os = "ios")
        )),
    )
}

/// What `native_terminal_probe` answers: whether a native terminal can run on this device and, when it cannot, why,
/// with what the answer cost. The client's registry shows the reason as it is. `adapter` is what the renderer would run
/// on and `seen` every adapter its backends listed, drawn on or not: a device that is refused for having only a CPU
/// rasterizer shows it there, which is the evidence a release asks of a device.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProbe {
    available: bool,
    reason: String,
    elapsed_ms: u64,
    adapter: Option<ProbeAdapter>,
    seen: Vec<ProbeAdapter>,
}

/// A GPU adapter as the probe reports it: the name the driver gives, the backend, the kind (`DiscreteGpu`, `Cpu`, ...)
/// and the driver's own description.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeAdapter {
    name: String,
    backend: String,
    device_type: String,
    driver: String,
}

/// What asking the GPU answered: the adapter the renderer would run on, or why it cannot draw, and every adapter seen.
struct Gpu {
    chosen: Result<ProbeAdapter, String>,
    seen: Vec<ProbeAdapter>,
}

impl Gpu {
    fn refused(why: impl Into<String>) -> Self {
        Self {
            chosen: Err(why.into()),
            seen: Vec::new(),
        }
    }
}

/// What a probe may cost before the app answers that native cannot be offered. A GPU driver that takes longer to
/// list its adapters and create a device would also delay the first frame of every session.
const PROBE_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// The build and host check first (free), then the device: `gpu` names the adapter the renderer would run on, or says
/// why it cannot draw (no place for a surface, no GPU). It is not called for a build that could not run a native
/// terminal anyway.
fn probe(build: CoreAvailability, gpu: impl FnOnce() -> Gpu) -> NativeProbe {
    let started = std::time::Instant::now();
    let (available, reason, adapter, seen) = match build.available.then(gpu) {
        None => (false, build.reason.into(), None, Vec::new()),
        Some(Gpu {
            chosen: Ok(adapter),
            seen,
        }) => {
            let software = if adapter.device_type == "Cpu" {
                ", a software rasterizer the debug switch allowed"
            } else {
                ""
            };
            let reason = format!(
                "The native terminal can draw on {} ({}{software})",
                adapter.name, adapter.backend
            );
            (true, reason, Some(adapter), seen)
        }
        Some(Gpu {
            chosen: Err(why),
            seen,
        }) => (
            false,
            format!("The native terminal cannot draw on this device: {why}"),
            None,
            seen,
        ),
    };
    NativeProbe {
        available,
        reason,
        elapsed_ms: started.elapsed().as_millis() as u64,
        adapter,
        seen,
    }
}

/// Runs `work` off the async runtime and answers within `budget`: a probe that is still running then is a refusal.
/// The work is not cancelled (a driver call cannot be), so its answer still reaches whoever caches it.
async fn within(
    budget: std::time::Duration,
    work: impl FnOnce() -> NativeProbe + Send + 'static,
) -> NativeProbe {
    let refused = |reason: String| NativeProbe {
        available: false,
        reason,
        elapsed_ms: budget.as_millis() as u64,
        adapter: None,
        seen: Vec::new(),
    };
    match tokio::time::timeout(budget, tauri::async_runtime::spawn_blocking(work)).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(error)) => refused(format!("The native terminal probe failed: {error}")),
        Err(_) => refused(format!(
            "The native terminal probe took longer than {} ms",
            budget.as_millis()
        )),
    }
}

/// The platform's surface check: on Linux a native surface composes below the page on Wayland only, so the GDK
/// display type of the window decides (X11 and Xwayland keep xterm.js, #1331).
fn surface() -> Result<(), String> {
    #[cfg(all(target_os = "linux", native_terminal_core))]
    crate::native_terminal_surface::linux::display()?;
    #[cfg(all(any(target_os = "macos", target_os = "ios"), native_terminal_core))]
    crate::native_terminal_surface::apple::display()?;
    Ok(())
}

/// The registry's second question, after `terminal_core_available` (#1336): can the renderer draw on this device?
/// It asks for an adapter under the app's policy (`native_renderer::policy`: the shipping one, which refuses CPU
/// rasterizers, except in a debug build on Android that asked for software) and creates its device. Each
/// platform's surface check joins here with its host. The answer is kept for the life of the process, per policy, so
/// the cost is paid once; a probe over its budget answers "no" for now and the kept answer serves the next start of the
/// registry. Allowed while locked: it reads the device, nothing of the user's.
#[tauri::command]
pub async fn native_terminal_probe() -> NativeProbe {
    // One answer per policy: a shipping build has only the first, the debug switch the second.
    static ANSWERS: [std::sync::OnceLock<NativeProbe>; 2] =
        [std::sync::OnceLock::new(), std::sync::OnceLock::new()];
    let software = native::software();
    within(PROBE_BUDGET, move || {
        ANSWERS[usize::from(software)]
            .get_or_init(|| {
                probe(terminal_core_available(), || match surface() {
                    Ok(()) => native::gpu(),
                    Err(why) => Gpu::refused(why),
                })
            })
            .clone()
    })
    .await
}

/// The real core, `lazysh-terminal-runtime` on libghostty-vt, which needs Zig 0.16.0 to build; without
/// the `native-terminal` feature no build needs Zig and the commands report that. A build made with
/// `LAZYSH_NATIVE_TERMINAL=off` (the kill switch, see `build.rs`) leaves the core out even with the
/// feature, and says so.
#[cfg(not(native_terminal_core))]
mod native {
    pub(super) const UNAVAILABLE: &str = if cfg!(native_terminal_disabled) {
        super::DISABLED_IN_BUILD
    } else {
        super::NOT_BUILT
    };

    pub(super) fn factory(
        _: u32,
        _: u32,
        _: Option<u32>,
        _: super::CoreConfig,
        _: crate::app_lock::AccessLease,
        _: tauri::ipc::Channel<crate::ssh::SshEvent>,
    ) -> Result<super::Factory, String> {
        Err(UNAVAILABLE.into())
    }

    pub(super) fn gpu() -> super::Gpu {
        super::Gpu::refused(UNAVAILABLE)
    }

    pub(super) fn software() -> bool {
        false
    }
}

#[cfg(native_terminal_core)]
pub(crate) use native::{css_color, theme_of};

#[cfg(native_terminal_core)]
mod native {
    use super::*;
    use lazysh_terminal_runtime::{
        control_window, dom_mods, ffi, scrollback_bytes_for_lines, CellRange, Config, ControlEvent,
        ControlQuery, ControlSnapshot, DisplayFailure, DomKey, Doorbell, Error as RuntimeError,
        Hooks, Hub, HubConfig, KeyInput, MouseInput, Offer, Origin, PtyWriter, Refused, RgbColor,
        ScrollAction, Session, Size, TerminalRuntime, Theme,
    };

    static HUB: LazyLock<Hub> = LazyLock::new(|| Hub::new(HubConfig::default()));

    /// Whether the app's policy accepts a CPU rasterizer: only a debug build on Android that asked for one.
    pub(super) fn software() -> bool {
        crate::native_renderer::policy().allow_software
    }

    /// The adapter the app's policy picks, or the renderer's reason for having none, and every adapter listed.
    pub(super) fn gpu() -> Gpu {
        gpu_under(&crate::native_renderer::policy())
    }

    fn gpu_under(policy: &lazysh_terminal_renderer_wgpu::Policy) -> Gpu {
        let (chosen, seen) = lazysh_terminal_renderer_wgpu::probe_seen(policy);
        let adapter = |info: &lazysh_terminal_renderer_wgpu::AdapterInfo| ProbeAdapter {
            name: info.name.clone(),
            backend: format!("{:?}", info.backend),
            device_type: format!("{:?}", info.device_type),
            driver: info.driver.trim().to_owned(),
        };
        Gpu {
            chosen: chosen
                .map(|info| adapter(&info))
                .map_err(|error| error.to_string()),
            seen: seen.iter().map(adapter).collect(),
        }
    }

    /// Replies and encoded input leave through the transport's input queue under the renderer's
    /// latest lease. A refusal (gated, queue full, session gone) drops a reply and fails an input
    /// command, which the hub counts; the origin changes nothing here, both are access-gated alike.
    struct Writer(Arc<Link>);

    impl PtyWriter for Writer {
        fn write(&self, _: Origin, bytes: &[u8]) -> Result<(), Refused> {
            self.0.write(bytes).map_err(|_| Refused)
        }
    }

    /// The names of the sixteen ANSI colours in a `TerminalTheme`, in palette order.
    const ANSI_NAMES: [&str; 16] = [
        "black",
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
        "white",
        "brightBlack",
        "brightRed",
        "brightGreen",
        "brightYellow",
        "brightBlue",
        "brightMagenta",
        "brightCyan",
        "brightWhite",
    ];

    /// xterm.js's own sixteen ANSI colours: what the xterm.js engine draws, and so what a program probing the
    /// palette must see, for a colour the theme leaves out (the bundled themes name only some of them).
    const XTERM_ANSI: [&str; 16] = [
        "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
        "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
    ];

    /// `#rgb`, `#rrggbb` or `#rrggbbaa` (the forms a lazysh theme holds; the alpha, which only a selection uses, is dropped).
    pub(crate) fn css_color(text: &str) -> Option<RgbColor> {
        let digits = text.strip_prefix('#')?;
        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let value = |digits: &str| u8::from_str_radix(digits, 16).ok();
        let [r, g, b] = match digits.len() {
            3 => [0, 1, 2].map(|at| value(&digits[at..=at]).map(|nibble| nibble * 17)),
            6 | 8 => [0, 2, 4].map(|at| value(&digits[at..at + 2])),
            _ => return None,
        };
        Some(RgbColor {
            r: r?,
            g: g?,
            b: b?,
        })
    }

    /// The colours a `TerminalTheme` gives a core to report: the default foreground, background and cursor, the
    /// sixteen ANSI colours and `extendedAnsi` (palette entries 16 and up). What it does not name is what xterm.js
    /// draws, so the core and the xterm.js engine answer a probe alike. Selection colours are the renderer's.
    pub(crate) fn theme_of(json: &Json) -> Result<Theme, String> {
        let object = json
            .as_object()
            .ok_or("The terminal theme must be an object")?;
        let color = |key: &str| match object.get(key) {
            None | Some(Json::Null) => Ok(None),
            Some(value) => value
                .as_str()
                .and_then(css_color)
                .map(Some)
                .ok_or_else(|| format!("The terminal theme's {key} is not a hex colour")),
        };
        let constant = |text| css_color(text).expect("a colour written in this file");
        let mut theme = Theme {
            cursor: constant("#ffffff"),
            ..Theme::default()
        };
        for (entry, ansi) in theme.palette.iter_mut().zip(XTERM_ANSI) {
            *entry = constant(ansi);
        }
        theme.foreground = color("foreground")?.unwrap_or(theme.foreground);
        theme.background = color("background")?.unwrap_or(theme.background);
        theme.cursor = color("cursor")?.unwrap_or(theme.cursor);
        for (entry, name) in theme.palette.iter_mut().zip(ANSI_NAMES) {
            *entry = color(name)?.unwrap_or(*entry);
        }
        if let Some(extended) = object.get("extendedAnsi").filter(|value| !value.is_null()) {
            let extended = extended
                .as_array()
                .filter(|colors| colors.len() <= 240)
                .ok_or("The terminal theme's extendedAnsi must be at most 240 colours")?;
            for (entry, value) in theme.palette[16..].iter_mut().zip(extended) {
                *entry = value
                    .as_str()
                    .and_then(css_color)
                    .ok_or("The terminal theme's extendedAnsi holds a colour that is not hex")?;
            }
        }
        Ok(theme)
    }

    /// Live sessions and reserved scrollback bytes in the process-wide hub, for the lifecycle test.
    #[cfg(test)]
    pub(super) fn hub_usage() -> (usize, usize) {
        (HUB.live(), HUB.scrollback_reserved())
    }

    /// A core's session, the link to its transport and the doorbell that tells its reader what changed.
    struct Runtime(Session, Arc<Link>, Arc<Doorbell>, Ringer);

    /// The wake of the renderer host that draws the session now, which the session's `changed` hook rings.
    type Ringer = Arc<Mutex<Option<crate::native_renderer::Wake>>>;

    impl From<ControlEvent> for SshEvent {
        fn from(event: ControlEvent) -> Self {
            match event {
                ControlEvent::Changed => Self::Changed,
                ControlEvent::Title { title } => Self::Title { title },
                ControlEvent::Bell => Self::Bell,
                ControlEvent::Cwd { path } => Self::Cwd { path },
                ControlEvent::Clipboard { text } => Self::Clipboard { text },
                ControlEvent::Failure { reason } => Self::Failure {
                    reason: match reason {
                        DisplayFailure::InvalidFrame => "invalid-frame",
                        DisplayFailure::PartialFrame => "partial-frame",
                    },
                },
            }
        }
    }

    impl Runtime {
        /// One control-plane read, for the reader that holds `lease`: the lease later events leave under, the
        /// doorbell rearmed first (so output that lands during the read rings again rather than being missed),
        /// then the answer under the session lock.
        fn answer(
            &self,
            lease: &AccessLease,
            window: Option<usize>,
            ask: impl FnOnce(&mut TerminalRuntime, usize) -> Result<ControlSnapshot, RuntimeError>,
        ) -> Result<Json, String> {
            self.1.use_lease(lease);
            self.2.read();
            let answer = self
                .0
                .with(|runtime| ask(runtime, control_window(window)))
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
            serde_json::to_value(answer).map_err(|error| error.to_string())
        }
    }

    impl Core for Runtime {
        fn feed(&self, chunk: Vec<u8>) -> Result<(), String> {
            match self.0.feed(chunk) {
                Ok(Offer::Accepted) => Ok(()),
                // A transport that honours its credit window never gets here.
                Ok(_) => Err("Terminal core queue is full".into()),
                Err(error) => Err(error.to_string()),
            }
        }

        fn viewport_text(&self) -> Result<String, String> {
            self.0
                .with(|runtime| runtime.viewport_text())
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())
        }

        fn ansi_snapshot(&self) -> Result<(String, usize), String> {
            // Under the session lock no worker is mid-parse: nothing queued means everything fed is on the screen.
            self.0
                .with(|runtime| {
                    Ok::<_, RuntimeError>((runtime.ansi_snapshot()?, runtime.ingress().queued()))
                })
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())
        }

        fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
            let size = Size::new(cols as u16, rows as u16);
            self.0
                .with(|runtime| runtime.request_size(size))
                .map_err(|error| error.to_string())?
                .map(drop)
                .map_err(|error| error.to_string())
        }

        fn control_snapshot(
            &self,
            lease: &AccessLease,
            window: Option<usize>,
        ) -> Result<Json, String> {
            self.answer(lease, window, |runtime, rows| {
                runtime.control_snapshot(rows)
            })
        }

        fn control_scroll(
            &self,
            lease: &AccessLease,
            action: Json,
            window: Option<usize>,
        ) -> Result<Json, String> {
            let action: ScrollAction = serde_json::from_value(action)
                .map_err(|error| format!("Not a scroll action: {error}"))?;
            let answer = self.answer(lease, window, |runtime, rows| {
                runtime.control_scroll(action, rows)
            });
            // The program printed nothing, so no screen change rang the renderer: it must be told the viewport moved.
            ring(&self.3);
            answer
        }

        fn control_resize(
            &self,
            lease: &AccessLease,
            cols: u32,
            rows: u32,
            window: Option<usize>,
        ) -> Result<Json, String> {
            let answer = self.answer(lease, window, |runtime, window| {
                runtime.control_resize(cols as u16, rows as u16, window)
            });
            ring(&self.3);
            answer
        }

        fn control_query(&self, lease: &AccessLease, query: Json) -> Result<Json, String> {
            let query: ControlQuery = serde_json::from_value(query)
                .map_err(|error| format!("Not a terminal query: {error}"))?;
            self.1.use_lease(lease);
            let answer = self
                .0
                .with(|runtime| runtime.control_query(query))
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
            serde_json::to_value(answer).map_err(|error| error.to_string())
        }

        fn select(&self, lease: &AccessLease, range: Option<Json>) -> Result<(), String> {
            let range: Option<CellRange> = range
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| format!("Not a range of cells: {error}"))?;
            self.1.use_lease(lease);
            self.0.set_selection(range);
            Ok(())
        }

        fn set_active(&self, lease: &AccessLease, active: bool) {
            self.1.use_lease(lease);
            self.0.set_active(active);
            if active {
                self.2.wake();
            }
        }

        fn set_theme(&self, theme: &Json) -> Result<(), String> {
            let theme = theme_of(theme)?;
            self.0
                .with(|runtime| runtime.set_theme(&theme))
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())
        }

        fn set_scrollback(&self, lines: u32) -> Result<(), String> {
            // The budget counts rows at the width the grid has now, as it did when the core opened.
            let cols = self
                .0
                .with(|runtime| runtime.size().cols)
                .map_err(|error| error.to_string())?;
            self.0
                .set_scrollback_bytes(scrollback_bytes_for_lines(lines as usize, cols))
                .map(|_| ())
                .map_err(|error| error.to_string())
        }

        fn input(&self, lease: &AccessLease, input: CoreInput) -> Result<usize, String> {
            self.1.use_lease(lease);
            match input {
                CoreInput::Key {
                    code,
                    key,
                    mods,
                    repeat,
                    release,
                    composing,
                } => self.0.send_key(&KeyInput::from_dom(DomKey {
                    code: &code,
                    key: &key,
                    mods: dom_mods(mods.shift, mods.ctrl, mods.alt, mods.meta),
                    repeat,
                    release,
                    composing,
                })),
                CoreInput::Mouse {
                    action,
                    button,
                    mods,
                    x,
                    y,
                } => self.0.send_mouse(MouseInput {
                    action: match action {
                        MouseAction::Press => ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_PRESS,
                        MouseAction::Release => {
                            ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_RELEASE
                        }
                        MouseAction::Motion => ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_MOTION,
                    },
                    button: button.map(|button| match button {
                        MouseButton::Left => ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_LEFT,
                        MouseButton::Middle => ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_MIDDLE,
                        MouseButton::Right => ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_RIGHT,
                        MouseButton::WheelUp => ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_FOUR,
                        MouseButton::WheelDown => ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_FIVE,
                    }),
                    mods: dom_mods(mods.shift, mods.ctrl, mods.alt, mods.meta),
                    x,
                    y,
                }),
                CoreInput::Text { text } => self.0.send_key(&KeyInput {
                    key: ffi::GhosttyKey_GHOSTTY_KEY_UNIDENTIFIED,
                    mods: 0,
                    text: Some(text),
                    composing: false,
                    repeat: false,
                    release: false,
                }),
                CoreInput::Paste { text } => self.0.send_paste(&text),
                CoreInput::Focus { focused } => self.0.send_focus(focused),
            }
            .map_err(|error| error.to_string())
        }

        fn drawing(&self) -> Option<(Session, crate::native_renderer::Inbox)> {
            let (wake, inbox) = crate::native_renderer::wake();
            *self.3.lock().unwrap_or_else(PoisonError::into_inner) = Some(wake);
            Some((self.0.clone(), inbox))
        }

        fn finished(&self) {
            // Everything fed is parsed first: a frame the transport finished is not a partial one. Nothing is
            // queued in the usual case, and then the reader hears of a failure before the closing notice.
            if finish_display(&self.0, &self.2) {
                return;
            }
            let (session, bell) = (self.0.clone(), self.2.clone());
            std::thread::spawn(move || {
                let until = std::time::Instant::now() + FINISH_PATIENCE;
                while !finish_display(&session, &bell) && std::time::Instant::now() < until {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            });
        }

        fn close(&self) {
            self.0.close();
        }
    }

    /// How long a transport that has ended waits for the core to parse what it was fed before the Mosh display is closed.
    const FINISH_PATIENCE: std::time::Duration = std::time::Duration::from_secs(5);

    /// Closes the Mosh display once nothing is queued, and tells the reader what failed. False while chunks wait; true
    /// when done or when the session is already gone.
    fn finish_display(session: &Session, bell: &Doorbell) -> bool {
        match session
            .with(|runtime| (runtime.ingress().queued() == 0).then(|| runtime.finish_canonical()))
        {
            Ok(Some(_)) => {
                bell.read();
                true
            }
            Ok(None) => false,
            Err(_) => true,
        }
    }

    pub(super) fn factory(
        cols: u32,
        rows: u32,
        scrollback_lines: Option<u32>,
        open: CoreConfig,
        lease: AccessLease,
        events: Channel<SshEvent>,
    ) -> Result<Factory, String> {
        let defaults = Config::default();
        let theme = open.theme.as_ref().map(theme_of).transpose()?;
        let config = Config {
            size: Size::new(cols as u16, rows as u16),
            scrollback_bytes: scrollback_lines.map_or(defaults.scrollback_bytes, |lines| {
                scrollback_bytes_for_lines(lines as usize, cols as u16)
            }),
            // The transport windows are 256 KiB: a producer holding credit always fits.
            ingress_bytes: crate::ssh::OUTPUT_WINDOW as usize,
            canonical_frames: open.canonical_frames,
            theme: theme.unwrap_or(defaults.theme),
        };
        Ok(Box::new(move || {
            let (core, link) = create(config, &lease, move |event| {
                let _ = events.send(event.into());
            })?;
            Ok(Prepared::new(Arc::new(core), link))
        }))
    }

    /// Rings the renderer host that draws the core, if one does: the screen it holds may have changed.
    fn ring(ringer: &Ringer) {
        if let Some(wake) = ringer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            wake.ring();
        }
    }

    /// A session in the hub whose replies and encoded input go through the returned [`Link`], under
    /// `lease` until a command brings a newer one. The session starts active: it was opened to be looked at.
    /// Its event stream goes to `events`, only while that lease is valid: a locked app is told nothing.
    fn create(
        config: Config,
        lease: &AccessLease,
        events: impl Fn(ControlEvent) + Send + Sync + 'static,
    ) -> Result<(Runtime, Arc<Link>), String> {
        let link = Arc::new(Link::default());
        link.use_lease(lease);
        let credit = link.returner();
        let permitted = link.clone();
        let doorbell = Arc::new(Doorbell::new(events, move || permitted.permits()));
        let (ringer, bell) = (Ringer::default(), doorbell.hook());
        let drawn = ringer.clone();
        let hooks = Hooks {
            writer: Arc::new(Writer(link.clone())),
            credit: Box::new(move |bytes| credit(bytes)),
            changed: Some(Box::new(move || {
                bell();
                ring(&drawn);
            })),
        };
        let session = HUB
            .create(uuid::Uuid::new_v4().to_string(), config, hooks)
            .map_err(|error| error.to_string())?;
        doorbell.bind(session.clone());
        session.set_active(true);
        Ok((Runtime(session, link.clone(), doorbell, ringer), link))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::{Duration, Instant};

        /// The cost on this machine's own drivers, with CPU rasterizers allowed so that a runner without a GPU
        /// still creates a device, the expensive half. The shipping policy refuses that adapter.
        #[test]
        fn the_real_gpu_probe_answers_within_the_budget_and_never_offers_a_software_rasterizer() {
            let policy = lazysh_terminal_renderer_wgpu::Policy::for_platform();
            let started = Instant::now();
            let lenient = gpu_under(&policy.clone().with_software());
            let cost = started.elapsed();
            println!(
                "native terminal GPU probe: {:?} of {:?} in {cost:?}",
                lenient.chosen, lenient.seen
            );
            assert!(cost < PROBE_BUDGET, "{cost:?}");
            let strict = gpu();
            // This host has no Android debug switch: the shipping policy, whatever the machine offers.
            assert!(!software());
            assert_eq!(strict.seen, lenient.seen);
            match &strict.chosen {
                Ok(adapter) => assert_eq!(lenient.chosen.as_ref(), Ok(adapter)),
                Err(why) => assert!(
                    why.contains("no hardware GPU") == lenient.chosen.is_ok(),
                    "{why}"
                ),
            }
        }

        fn wait_until(done: impl Fn() -> bool) {
            let start = Instant::now();
            while !done() {
                assert!(start.elapsed() < Duration::from_secs(10), "timed out");
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        /// A real core and what it wrote to the transport so far.
        struct Fixture {
            core: Runtime,
            link: Arc<Link>,
            sent: Arc<Mutex<Vec<Vec<u8>>>>,
            access: crate::app_lock::AccessState,
        }

        fn fixture() -> Fixture {
            let access = crate::app_lock::AccessState::disabled();
            let config = Config {
                // 120 columns: a column above 95 makes an X10 report leave ASCII.
                size: Size::new(120, 30),
                scrollback_bytes: 64 * 1024,
                ..Config::default()
            };
            let (core, link) = create(config, &access.lease(None).unwrap(), |_| {}).unwrap();
            let sent = Arc::new(Mutex::new(Vec::new()));
            let queue_sent = sent.clone();
            let _ = link.credit.set(Arc::new(|_| {}));
            let _ = link.input.set(Arc::new(move |bytes, _| {
                queue_sent.lock().unwrap().push(bytes);
                Ok(())
            }));
            Fixture {
                core,
                link,
                sent,
                access,
            }
        }

        impl Fixture {
            /// Feed the program's output and wait until the VT has processed it.
            fn program_prints(&self, output: &[u8]) {
                let before = self.core.0.stats().unwrap().processed;
                assert!(matches!(
                    self.core.0.feed(output.to_vec()),
                    Ok(Offer::Accepted)
                ));
                self.wait(|| {
                    self.core.0.stats().unwrap().processed >= before + output.len() as u64
                });
            }

            fn wait(&self, done: impl Fn() -> bool) {
                wait_until(done);
            }

            /// The bytes one input event put on the transport (none when the modes ask for nothing).
            fn encode(&self, input: CoreInput) -> Vec<u8> {
                let sent = self.sent.lock().unwrap().len();
                let lease = self.access.lease(None).unwrap();
                let count = self.core.input(&lease, input).unwrap();
                let queue = self.sent.lock().unwrap();
                assert_eq!(queue.len(), sent + usize::from(count > 0));
                queue.get(sent).cloned().unwrap_or_default()
            }
        }

        fn key(code: &str, key: &str, mods: Mods) -> CoreInput {
            CoreInput::Key {
                code: code.into(),
                key: key.into(),
                mods,
                repeat: false,
                release: false,
                composing: false,
            }
        }

        fn mouse(action: MouseAction, button: MouseButton) -> CoreInput {
            // Cells are 1 px for the bridge's grid, so the pointer is in cell coordinates: the middle of
            // column 111 and row 2.
            CoreInput::Mouse {
                action,
                button: Some(button),
                mods: Mods::default(),
                x: 110.5,
                y: 1.5,
            }
        }

        #[test]
        fn replies_go_to_the_transport_under_the_lease_and_are_dropped_once_it_is_gone() {
            let fixture = fixture();
            fixture.program_prints(b"\x1b[c");
            fixture.wait(|| !fixture.sent.lock().unwrap().is_empty());
            {
                let sent = fixture.sent.lock().unwrap();
                assert!(
                    sent[0].starts_with(b"\x1b[?") && sent[0].ends_with(b"c"),
                    "{sent:?}"
                );
            }
            // A reply for a renderer that has been replaced must not reach the shell, now or later.
            fixture.access.replace_renderer().unwrap();
            fixture.program_prints(b"\x1b[c\x1b[5n");
            fixture.wait(|| fixture.core.0.stats().unwrap().replies_dropped > 0);
            // The counters are bytes: what was written is exactly the first reply.
            let written = fixture.sent.lock().unwrap()[0].len() as u64;
            assert_eq!(fixture.core.0.stats().unwrap().replies_written, written);
            assert_eq!(
                fixture.sent.lock().unwrap().len(),
                1,
                "nothing after the lease went"
            );
            fixture.core.close();
        }

        #[test]
        fn paste_is_bracketed_only_after_the_program_enabled_it() {
            let fixture = fixture();
            let paste = |text: &str| CoreInput::Paste { text: text.into() };
            assert_eq!(fixture.encode(paste("a\nb")), b"a\rb");
            fixture.program_prints(b"\x1b[?2004h");
            assert_eq!(
                fixture.encode(paste("a\nb\x1b[201~c")),
                b"\x1b[200~a\rbc\x1b[201~"
            );
            fixture.program_prints(b"\x1b[?2004l");
            assert_eq!(fixture.encode(paste("c")), b"c");
            fixture.core.close();
        }

        #[test]
        fn committed_text_is_sent_verbatim_whatever_the_program_asked_for() {
            let fixture = fixture();
            let text = |text: &str| CoreInput::Text { text: text.into() };
            assert_eq!(fixture.encode(text("ação")), "ação".as_bytes());
            // An erase unit (DEL) and an Enter (CR) are bytes of the text, not keys the protocols may rename.
            assert_eq!(fixture.encode(text("\x7f")), b"\x7f");
            // Every Kitty flag and bracketed paste on: the encoder turned a committed CR into CSI 13u (#1043).
            fixture.program_prints(b"\x1b[>31u\x1b[?2004h");
            assert_eq!(fixture.encode(text("\r")), b"\r");
            assert_eq!(fixture.encode(text("a\x1b[201~")), b"a\x1b[201~");
            assert!(fixture.encode(text("")).is_empty());
            fixture.core.close();
        }

        #[test]
        fn keys_follow_the_cursor_key_mode_and_shift_enter_stays_distinct() {
            let fixture = fixture();
            let up = || key("ArrowUp", "ArrowUp", Mods::default());
            assert_eq!(fixture.encode(up()), b"\x1b[A");
            fixture.program_prints(b"\x1b[?1h");
            assert_eq!(fixture.encode(up()), b"\x1bOA");
            let ctrl = Mods {
                ctrl: true,
                ..Mods::default()
            };
            assert_eq!(fixture.encode(key("KeyC", "c", ctrl)), b"\x03");
            let shift = Mods {
                shift: true,
                ..Mods::default()
            };
            assert_eq!(fixture.encode(key("Enter", "Enter", shift)), b"\x1b[13;2u");
            assert_eq!(
                fixture.encode(key("Enter", "Enter", Mods::default())),
                b"\r"
            );
            fixture.core.close();
        }

        #[test]
        fn mouse_and_focus_reports_leave_only_when_enabled_and_may_not_be_text() {
            let fixture = fixture();
            let press = || mouse(MouseAction::Press, MouseButton::Left);
            assert!(fixture.encode(press()).is_empty(), "no tracking, no report");
            assert!(fixture
                .encode(CoreInput::Focus { focused: true })
                .is_empty());
            fixture.program_prints(b"\x1b[?1000h\x1b[?1004h");
            // X10 encoding: ESC [ M, then button, column and row, each plus 32: column 111 is 0x8f.
            let report = fixture.encode(press());
            assert_eq!(report, [0x1b, b'[', b'M', 0x20, 0x8f, 0x22]);
            assert!(std::str::from_utf8(&report).is_err(), "not valid UTF-8");
            assert_eq!(
                fixture.encode(mouse(MouseAction::Press, MouseButton::WheelUp)),
                [0x1b, b'[', b'M', 0x60, 0x8f, 0x22]
            );
            assert_eq!(
                fixture.encode(CoreInput::Focus { focused: true }),
                b"\x1b[I"
            );
            assert_eq!(
                fixture.encode(CoreInput::Focus { focused: false }),
                b"\x1b[O"
            );
            fixture.program_prints(b"\x1b[?1006h");
            assert_eq!(fixture.encode(press()), b"\x1b[<0;111;2M");
            fixture.core.close();
        }

        /// The handed-over session's terminal: small, so its lines scroll.
        fn handed() -> Config {
            Config {
                size: Size::new(40, 6),
                ..Config::default()
            }
        }

        /// A terminal of the handed-over session's size that parsed `parts` in order.
        fn replayed(parts: &[&[u8]]) -> TerminalRuntime {
            let mut runtime = TerminalRuntime::new(handed()).unwrap();
            for chunk in parts.iter().flat_map(|part| part.chunks(16 * 1024)) {
                assert_eq!(runtime.offer(chunk.to_vec()), Offer::Accepted);
                runtime.pump(usize::MAX);
            }
            runtime
        }

        #[tokio::test(flavor = "multi_thread")]
        #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
        async fn a_released_real_core_hands_over_its_screen_cursor_and_modes_and_no_byte_is_lost() {
            let _kept = tests_keeping_cores().read();
            let lease = crate::app_lock::AccessState::disabled().lease(None);
            let (core, link) = create(handed(), &lease.unwrap(), |_| {}).unwrap();
            let prepared = Prepared::new(Arc::new(core), link);
            // A program on the alternate screen with bracketed paste, drag tracking in the SGR encoding,
            // application cursor keys and a hidden cursor, printing while the user switches engine.
            let prelude = b"shell\r\n\x1b[?1049h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1h\x1b[?25l";
            let mut released = fake::release_mid_stream("handed-real", prepared, prelude).await;
            let (after, _) = fake::received(&mut released.second_events);
            assert!(!after.is_empty(), "lines arrived after the release");
            assert!(fake::received(&mut released.first_events).0.is_empty());
            // The new Channel carries exactly what the core did not consume: its credit says where it stopped.
            let start = Instant::now();
            let consumed = released.delivered.len() - after.len();
            while released.credited.load(std::sync::atomic::Ordering::SeqCst) < consumed {
                assert!(start.elapsed() < Duration::from_secs(10), "credit missing");
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(
                released.credited.load(std::sync::atomic::Ordering::SeqCst),
                consumed
            );
            assert!(consumed > prelude.len(), "lines were parsed by the core");
            assert_eq!(after, released.delivered[consumed..]);
            // A fresh terminal that replays the snapshot and then the Channel shows what one that saw the whole
            // stream shows, with the same cursor and modes.
            let mut whole = replayed(&[&released.delivered]);
            let mut resumed = replayed(&[released.snapshot.as_bytes(), &after]);
            assert_eq!(
                resumed.viewport_text().unwrap(),
                whole.viewport_text().unwrap()
            );
            let (state, expected) = (
                resumed.control_snapshot(6).unwrap().state,
                whole.control_snapshot(6).unwrap().state,
            );
            assert_eq!(
                (state.cursor, state.modes),
                (expected.cursor, expected.modes)
            );
            assert!(state.modes.alternate_screen && state.modes.bracketed_paste);
            assert_eq!(
                resumed.ansi_snapshot().unwrap(),
                whole.ansi_snapshot().unwrap()
            );
            // The snapshot alone is the screen at the release: the last line the core parsed, and none after it.
            let mut at_release = replayed(&[released.snapshot.as_bytes()]);
            let mut before = replayed(&[&released.delivered[..consumed]]);
            assert_eq!(
                at_release.viewport_text().unwrap(),
                before.viewport_text().unwrap()
            );
            assert_eq!(
                at_release.ansi_snapshot().unwrap(),
                before.ansi_snapshot().unwrap()
            );
            assert!(live("handed-real").is_err(), "the released core is freed");
        }

        /// A real core whose event stream is recorded, opened under `lease`.
        fn watched_core(lease: &AccessLease) -> (Runtime, Arc<Mutex<Vec<ControlEvent>>>) {
            let sent = Arc::new(Mutex::new(Vec::new()));
            let log = sent.clone();
            let config = Config {
                size: Size::new(40, 5),
                scrollback_bytes: 64 * 1024,
                ..Config::default()
            };
            let (core, link) =
                create(config, lease, move |event| log.lock().unwrap().push(event)).unwrap();
            let _ = link.credit.set(Arc::new(|_| {}));
            (core, sent)
        }

        fn parsed(core: &Runtime, output: &[u8]) {
            let before = core.0.stats().unwrap().processed;
            assert!(matches!(core.0.feed(output.to_vec()), Ok(Offer::Accepted)));
            wait_until(|| core.0.stats().unwrap().processed >= before + output.len() as u64);
        }

        #[test]
        fn a_locked_app_is_told_nothing_and_the_next_reader_brings_the_core_back_to_life() {
            let access = crate::ssh::test_support::unlocked_access();
            let lease = crate::ssh::test_support::ready_lease(&access);
            let (core, sent) = watched_core(&lease);
            parsed(&core, b"\x07one\r\n");
            let start = Instant::now();
            while sent.lock().unwrap().len() < 2 {
                assert!(start.elapsed() < Duration::from_secs(10), "no events");
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(
                *sent.lock().unwrap(),
                [ControlEvent::Bell, ControlEvent::Changed]
            );
            // Reading rearms the doorbell; then the app locks and the program keeps talking.
            core.control_snapshot(&lease, None).unwrap();
            sent.lock().unwrap().clear();
            access.lock().unwrap();
            parsed(&core, b"\x07\x1b]0;secret title\x07two\r\n");
            parsed(&core, b"three\r\n");
            assert_eq!(
                *sent.lock().unwrap(),
                [],
                "nothing about the screen leaves while locked"
            );
            assert!(
                core.control_snapshot(&lease, None).is_ok(),
                "the core still parses"
            );
            // Unlocked, a reader with the new lease is answered and what was held comes out.
            access.authorize(access.generation().unwrap()).unwrap();
            access.ready(access.generation().unwrap()).unwrap();
            let fresh = access
                .lease(access.status().unwrap().nonce.as_deref())
                .unwrap();
            core.set_active(&fresh, true);
            assert_eq!(
                *sent.lock().unwrap(),
                [
                    ControlEvent::Title {
                        title: "secret title".into()
                    },
                    ControlEvent::Bell,
                    ControlEvent::Changed,
                ]
            );
            core.close();
        }

        #[test]
        fn a_reader_that_scrolls_or_resizes_rings_the_renderer_that_draws_the_core() {
            let lease = crate::app_lock::AccessState::disabled()
                .lease(None)
                .unwrap();
            let (core, _) = watched_core(&lease);
            let (_, inbox) = core.drawing().unwrap();
            let rows: String = (0..30).map(|row| format!("row {row}\r\n")).collect();
            parsed(&core, rows.as_bytes());
            // What the program printed rang it; reading the screen changes nothing and rings nothing.
            assert!(inbox.rang(Duration::from_secs(5)), "the output rang");
            core.control_snapshot(&lease, None).unwrap();
            assert!(!inbox.rang(Duration::from_millis(100)), "a read rang");
            // Nothing was printed, but the viewport moved, or the grid changed, and the pixels must follow.
            core.control_scroll(&lease, serde_json::json!({"kind": "toTop"}), None)
                .unwrap();
            assert!(
                inbox.rang(Duration::from_secs(5)),
                "the scroll did not ring"
            );
            core.control_resize(&lease, 20, 7, None).unwrap();
            assert!(
                inbox.rang(Duration::from_secs(5)),
                "the resize did not ring"
            );
        }

        #[test]
        fn a_core_answers_a_reader_from_the_real_screen_and_never_with_a_cell() {
            let lease = crate::app_lock::AccessState::disabled()
                .lease(None)
                .unwrap();
            let (core, _) = watched_core(&lease);
            let rows: String = (0..30).map(|row| format!("row {row}\r\n")).collect();
            parsed(&core, rows.as_bytes());
            let live = core.control_snapshot(&lease, Some(8)).unwrap();
            fake::assert_no_cells(&live);
            assert_eq!(live["state"]["columns"], 40);
            assert_eq!(live["state"]["viewport"]["following"], true);
            assert_eq!(live["window"]["rows"].as_array().unwrap().len(), 8);
            assert_eq!(live["window"]["rows"][6], "row 29");
            let top = core
                .control_scroll(&lease, serde_json::json!({"kind": "toTop"}), Some(8))
                .unwrap();
            fake::assert_no_cells(&top);
            assert_eq!(top["state"]["viewport"]["top"], 0);
            assert_eq!(top["window"]["rows"][0], "row 0");
            let bad = core.control_scroll(&lease, serde_json::json!({"kind": "sideways"}), None);
            assert!(bad.unwrap_err().starts_with("Not a scroll action"));
            let resized = core.control_resize(&lease, 20, 7, Some(8)).unwrap();
            fake::assert_no_cells(&resized);
            assert_eq!(
                (
                    resized["state"]["columns"].as_u64(),
                    resized["state"]["rows"].as_u64()
                ),
                (Some(20), Some(7))
            );
            // Questions about the text are answered from the same screen, in the adapter's shapes.
            let ask = |query: Json| core.control_query(&lease, query);
            let word =
                ask(serde_json::json!({"kind": "wordAt", "cell": {"x": 4, "y": 3}})).unwrap();
            assert_eq!(
                word,
                serde_json::json!({"start": {"x": 4, "y": 3}, "end": {"x": 4, "y": 3}})
            );
            let text = ask(
                serde_json::json!({"kind": "selectionText", "range": {"start": {"x": 4, "y": 3}, "end": {"x": 2, "y": 4}}}),
            );
            assert_eq!(text.unwrap(), "3\nrow");
            let hit = ask(
                serde_json::json!({"kind": "search", "query": "ROW 29", "direction": "forward"}),
            );
            assert_eq!(
                hit.unwrap(),
                serde_json::json!({"row": 29, "column": 0, "length": 6})
            );
            let bad = ask(serde_json::json!({"kind": "cells"}));
            assert!(bad.unwrap_err().starts_with("Not a terminal query"));
            let selected = serde_json::json!({"start": {"x": 0, "y": 0}, "end": {"x": 3, "y": 0}});
            core.select(&lease, Some(selected)).unwrap();
            assert!(
                core.0.selection_overlay().unwrap().is_some(),
                "held for the renderer host"
            );
            core.select(&lease, None).unwrap();
            assert_eq!(core.0.selection_overlay().unwrap(), None);
            let bad = core.select(&lease, Some(serde_json::json!({"start": 1})));
            assert!(bad.unwrap_err().starts_with("Not a range of cells"));
            // Whatever the reader asks, the answer is bounded.
            let wide = core.control_snapshot(&lease, Some(usize::MAX)).unwrap();
            assert!(wide["window"]["rows"].as_array().unwrap().len() <= 1024);
            core.close();
            assert!(
                core.control_snapshot(&lease, None).is_err(),
                "a closed core answers nothing"
            );
        }

        /// A core opened the way the renderer opens one, `terminal_core_open` and then the transport starting on the
        /// same channel, with the bytes it wrote to that transport.
        struct Opened {
            id: &'static str,
            lease: AccessLease,
            core: Arc<dyn Core>,
            written: Arc<Mutex<Vec<u8>>>,
            /// Where the session's output goes, as the transport finds it.
            slot: CoreSlot,
            channel: Channel<SshEvent>,
        }

        async fn opened(id: &'static str, config: Option<CoreConfig>) -> Opened {
            opened_on(Channel::new(|_| Ok(())), id, config).await
        }

        async fn opened_on(
            channel: Channel<SshEvent>,
            id: &'static str,
            config: Option<CoreConfig>,
        ) -> Opened {
            let lease = crate::app_lock::AccessState::disabled()
                .lease(None)
                .unwrap();
            terminal_core_open(lease.clone(), channel.clone(), 80, 24, None, config)
                .await
                .unwrap()
                .into_inner()
                .unwrap();
            let prepared = prepare(&channel).unwrap().expect("the offer");
            let core = prepared.core.clone();
            let written = Arc::new(Mutex::new(Vec::new()));
            let transport = written.clone();
            let slot = CoreSlot::default();
            prepared.attach(
                id,
                &slot,
                Arc::new(|_| {}),
                Arc::new(move |bytes, _| {
                    transport.lock().unwrap().extend(bytes);
                    Ok(())
                }),
            );
            Opened {
                id,
                lease,
                core,
                written,
                slot,
                channel,
            }
        }

        impl Opened {
            /// What the core wrote to the transport in answer to `output`: everything before the reply to a
            /// device-status report sent behind it, which marks the end of what the core parsed.
            fn answers_to(&self, output: &[u8]) -> String {
                const DONE: &[u8] = b"\x1b[0n";
                self.written.lock().unwrap().clear();
                self.core.feed([output, b"\x1b[5n"].concat()).unwrap();
                wait_until(|| self.written.lock().unwrap().ends_with(DONE));
                let written = std::mem::take(&mut *self.written.lock().unwrap());
                String::from_utf8(written[..written.len() - DONE.len()].to_vec()).unwrap()
            }

            /// The core's grid after asking for `resize` (or as it is), through the commands.
            async fn size(&self, resize: Option<(u32, u32)>) -> (u64, u64) {
                let answer = match resize {
                    Some((cols, rows)) => {
                        terminal_core_resize(self.lease.clone(), self.id.into(), cols, rows, None)
                            .await
                    }
                    None => terminal_core_snapshot(self.lease.clone(), self.id.into(), None).await,
                };
                let state = answer.unwrap().into_inner().unwrap()["state"].clone();
                (
                    state["columns"].as_u64().unwrap(),
                    state["rows"].as_u64().unwrap(),
                )
            }

            async fn retheme(&self, theme: Json) -> Result<(), String> {
                match terminal_core_theme(self.lease.clone(), self.id.into(), theme).await {
                    Ok(done) => {
                        done.into_inner().unwrap();
                        Ok(())
                    }
                    Err(error) => Err(error.into_inner().unwrap()),
                }
            }
        }

        fn app_theme(background: &str) -> CoreConfig {
            CoreConfig {
                theme: Some(serde_json::json!({
                    "foreground": "#d9e0d6", "background": background, "cursor": "#c4eb89",
                    "red": "#f48781", "extendedAnsi": ["#010203"],
                    "selectionBackground": "#40543a80", "cursorAccent": "#000000"
                })),
                ..CoreConfig::default()
            }
        }

        const COLOUR_QUERIES: &[u8] =
            b"\x1b]11;?\x07\x1b]10;?\x1b\\\x1b]12;?\x07\x1b]4;1;?\x07\x1b]4;2;?\x07\x1b]4;16;?\x07";

        #[tokio::test]
        #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
        async fn colour_queries_get_the_apps_theme_and_a_theme_change_changes_the_next_answer() {
            let _kept = tests_keeping_cores().read();
            let themed = opened("theme-open", Some(app_theme("#101311"))).await;
            let plain = opened("theme-default", None).await;
            // Background, foreground and cursor, then ANSI red and extendedAnsi 0 from the theme, and ANSI green
            // (which the theme leaves out) as xterm.js draws it.
            assert_eq!(
                themed.answers_to(COLOUR_QUERIES),
                "\x1b]11;rgb:1010/1313/1111\x07\x1b]10;rgb:d9d9/e0e0/d6d6\x1b\\\x1b]12;rgb:c4c4/ebeb/8989\x07\
                 \x1b]4;1;rgb:f4f4/8787/8181\x07\x1b]4;2;rgb:4e4e/9a9a/0606\x07\x1b]4;16;rgb:0101/0202/0303\x07"
            );
            assert_eq!(
                plain.answers_to(b"\x1b]11;?\x07"),
                "\x1b]11;rgb:0000/0000/0000\x07",
                "a core opened without a theme reports its own colours"
            );

            themed
                .retheme(serde_json::json!({"background": "#abc", "foreground": "#000", "cursor": "#102030", "red": "#112233", "extendedAnsi": ["#040506"]}))
                .await
                .unwrap();
            assert_eq!(
                themed.answers_to(COLOUR_QUERIES),
                "\x1b]11;rgb:aaaa/bbbb/cccc\x07\x1b]10;rgb:0000/0000/0000\x1b\\\x1b]12;rgb:1010/2020/3030\x07\
                 \x1b]4;1;rgb:1111/2222/3333\x07\x1b]4;2;rgb:4e4e/9a9a/0606\x07\x1b]4;16;rgb:0404/0505/0606\x07"
            );
            assert_eq!(
                plain.answers_to(b"\x1b]11;?\x07"),
                "\x1b]11;rgb:0000/0000/0000\x07",
                "another session's colours did not move"
            );
            close("theme-open");
            close("theme-default");
        }

        #[tokio::test]
        #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
        async fn a_theme_that_is_not_a_set_of_hex_colours_opens_no_core_and_changes_nothing() {
            let _kept = tests_keeping_cores().read();
            let themed = opened("theme-refused", Some(app_theme("#101311"))).await;
            let too_many = vec!["#000000"; 241];
            for theme in [
                serde_json::json!("dark"),
                serde_json::json!({"background": "red"}),
                serde_json::json!({"foreground": 7}),
                serde_json::json!({"cursor": "#12345"}),
                serde_json::json!({"black": "#gg0000"}),
                serde_json::json!({"cursor": "#ééé"}),
                serde_json::json!({"extendedAnsi": too_many}),
                serde_json::json!({"extendedAnsi": ["#000000", "nope"]}),
                serde_json::json!({"extendedAnsi": "#000000"}),
            ] {
                assert!(
                    themed.retheme(theme.clone()).await.is_err(),
                    "{theme} changed the theme"
                );
                let channel = Channel::new(|_| Ok(()));
                let lease = themed.lease.clone();
                let config = CoreConfig {
                    theme: Some(theme.clone()),
                    ..CoreConfig::default()
                };
                let refused =
                    terminal_core_open(lease, channel.clone(), 80, 24, None, Some(config))
                        .await
                        .err()
                        .unwrap()
                        .into_inner()
                        .unwrap();
                assert!(refused.contains("terminal theme"), "{theme}: {refused}");
                assert!(
                    prepare(&channel).unwrap().is_none(),
                    "{theme} left an offer behind"
                );
            }
            assert_eq!(
                themed.answers_to(b"\x1b]11;?\x07"),
                "\x1b]11;rgb:1010/1313/1111\x07",
                "the theme in force is the one before the refusals"
            );
            close("theme-refused");
        }

        #[tokio::test]
        #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
        async fn a_mosh_session_follows_the_sizes_of_its_frames_and_a_plain_one_does_not() {
            let _kept = tests_keeping_cores().read();
            let mosh = opened(
                "mosh-canonical",
                Some(CoreConfig {
                    canonical_frames: true,
                    ..CoreConfig::default()
                }),
            )
            .await;
            let plain = opened("mosh-plain", None).await;
            let frame = |id: u32, cols: u32, rows: u32| {
                format!(
                    "\x1b]7777;lazysh-mosh;1;begin;{id};{cols};{rows}\x1b\\hello\x1b]7777;lazysh-mosh;1;end;{id}\x1b\\"
                )
            };
            for core in [&mosh, &plain] {
                assert_eq!(core.answers_to(frame(1, 50, 12).as_bytes()), "");
            }
            assert_eq!(mosh.size(None).await, (50, 12), "the frame sized the grid");
            assert_eq!(
                plain.size(None).await,
                (80, 24),
                "a core not told it is Mosh ignores frames"
            );
            // The renderer's size is an intent to the transport, which alone decides what the grid is.
            assert_eq!(mosh.size(Some((100, 30))).await, (50, 12));
            assert_eq!(plain.size(Some((100, 30))).await, (100, 30));
            assert_eq!(mosh.answers_to(frame(2, 60, 20).as_bytes()), "");
            assert_eq!(mosh.size(None).await, (60, 20));
            close("mosh-canonical");
            close("mosh-plain");
        }

        /// A Channel and the kinds of event it was sent that matter to a Mosh display (`failure:<reason>` and `closed`), in order.
        struct Told(
            Channel<SshEvent>,
            Mutex<tokio::sync::mpsc::UnboundedReceiver<Json>>,
            Mutex<Vec<String>>,
        );

        impl Told {
            fn new() -> Self {
                let (channel, received) = crate::ssh::test_support::json_events();
                Self(channel, Mutex::new(received), Mutex::default())
            }

            fn kinds(&self) -> Vec<String> {
                let (mut received, mut seen) = (self.1.lock().unwrap(), self.2.lock().unwrap());
                while let Ok(event) = received.try_recv() {
                    let kind = event["type"].as_str().unwrap();
                    match event["reason"].as_str() {
                        Some(reason) if kind == "failure" => seen.push(format!("failure:{reason}")),
                        _ if kind == "closed" => seen.push(kind.into()),
                        _ => {}
                    }
                }
                seen.clone()
            }
        }

        #[tokio::test]
        #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
        async fn a_mosh_display_the_core_cannot_follow_is_told_to_the_renderer_before_the_closing_notice(
        ) {
            let _kept = tests_keeping_cores().read();
            let mosh = || CoreConfig {
                canonical_frames: true,
                ..CoreConfig::default()
            };
            let end = |opened: &Opened| {
                opened
                    .slot
                    .route(&opened.channel)
                    .closed("gone".into(), false)
                    .unwrap()
            };
            // A frame the core refuses fails the display, once, as the client's `failure` event.
            let refused = Told::new();
            let refusing = opened_on(refused.0.clone(), "mosh-refused", Some(mosh())).await;
            refusing.answers_to(b"\x1b]7777;lazysh-mosh;1;end;9\x1b\\");
            wait_until(|| refused.kinds() == ["failure:invalid-frame"]);
            refusing.answers_to(b"\x1b]7777;lazysh-mosh;1;end;9\x1b\\");
            assert_eq!(refused.kinds(), ["failure:invalid-frame"]);
            // A transport that ends inside a frame fails it too, ahead of the notice that it ended.
            let cut = Told::new();
            let cutting = opened_on(cut.0.clone(), "mosh-cut", Some(mosh())).await;
            cutting.answers_to(b"\x1b]7777;lazysh-mosh;1;begin;1;30;6\x1b\\half");
            end(&cutting);
            wait_until(|| cut.kinds().len() == 2);
            assert_eq!(cut.kinds(), ["failure:partial-frame", "closed"]);
            // A frame the transport finished is not a partial one, and a session that is not Mosh never fails a display.
            let (whole, plain) = (Told::new(), Told::new());
            let finished = opened_on(whole.0.clone(), "mosh-whole", Some(mosh())).await;
            finished.answers_to(
                b"\x1b]7777;lazysh-mosh;1;begin;1;30;6\x1b\\ok\x1b]7777;lazysh-mosh;1;end;1\x1b\\",
            );
            let ordinary = opened_on(plain.0.clone(), "mosh-plain-failure", None).await;
            ordinary.answers_to(b"\x1b]7777;lazysh-mosh;1;end;9\x1b\\");
            end(&finished);
            end(&ordinary);
            wait_until(|| whole.kinds() == ["closed"] && plain.kinds() == ["closed"]);
            assert_eq!(finished.size(None).await, (30, 6));
            for id in [
                "mosh-refused",
                "mosh-cut",
                "mosh-whole",
                "mosh-plain-failure",
            ] {
                close(id);
            }
        }

        #[test]
        fn input_is_refused_and_counted_when_the_renderer_was_replaced() {
            let fixture = fixture();
            let paste = CoreInput::Paste { text: "x".into() };
            let stale = fixture.access.lease(None).unwrap();
            fixture.access.replace_renderer().unwrap();
            let error = fixture.core.input(&stale, paste).unwrap_err();
            assert!(error.contains("access policy"), "{error}");
            assert!(fixture.sent.lock().unwrap().is_empty());
            assert_eq!(fixture.core.0.stats().unwrap().input_refused, 1);
            assert!(fixture.link.write(b"x").is_err());
            fixture.core.close();
        }
    }
}

/// Live sessions and reserved scrollback bytes of the real core's hub (lifecycle test only).
#[cfg(all(test, native_terminal_core))]
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
        /// The themes the bridge handed to `Core::set_theme`, in order.
        pub(crate) themes: Mutex<Vec<Json>>,
        /// The History lines the bridge handed to `Core::set_scrollback`, in order.
        pub(crate) history: Mutex<Vec<u32>>,
        /// The input events the bridge handed to `Core::input`, in order.
        pub(crate) inputs: Mutex<Vec<CoreInput>>,
        /// The questions about the buffer's text and the selections the commands handed over, in order.
        pub(crate) asked: Mutex<Vec<Json>>,
        pub(crate) closed: std::sync::atomic::AtomicBool,
        /// What the last `set_active` said; a core starts active.
        pub(crate) active: std::sync::atomic::AtomicBool,
        queued: Arc<AtomicUsize>,
    }

    impl ChecksumCore {
        /// A core plus the `Prepared` that attaches it, built the way a factory would.
        pub(crate) fn prepared() -> (Arc<Self>, Prepared) {
            let (core, prepared, _) = Self::linked();
            (core, prepared)
        }

        /// [`Self::prepared`] and the [`Link`] the core's writer uses, to write as the core would.
        pub(crate) fn linked() -> (Arc<Self>, Prepared, Arc<Link>) {
            let link = Arc::new(Link::default());
            let core = Self::new(link.returner());
            (core.clone(), Prepared::new(core, link.clone()), link)
        }

        pub(crate) fn new(credit: CreditReturn) -> Arc<Self> {
            let (chunks, received) = mpsc::channel::<Vec<u8>>();
            let core = Arc::new(Self {
                chunks,
                seen: Arc::default(),
                peak_queued: Arc::default(),
                feeds: Arc::default(),
                sizes: Mutex::default(),
                themes: Mutex::default(),
                history: Mutex::default(),
                inputs: Mutex::default(),
                asked: Mutex::default(),
                closed: Default::default(),
                active: std::sync::atomic::AtomicBool::new(true),
                queued: Arc::default(),
            });
            let (seen, queued) = (core.seen.clone(), core.queued.clone());
            std::thread::spawn(move || {
                for chunk in received {
                    // Stands in for VT parsing: slower than the producer, so the window is exercised.
                    std::thread::sleep(std::time::Duration::from_micros(100));
                    seen.lock().unwrap().extend_from_slice(&chunk);
                    queued.fetch_sub(chunk.len(), SeqCst);
                    credit(chunk.len());
                }
            });
            core
        }
    }

    impl ChecksumCore {
        /// Waits for `expected.len()` parsed bytes, then checks the stream's checksum and that at most
        /// one transport window was ever queued unreturned.
        pub(crate) async fn assert_stream(&self, expected: &[u8]) {
            // A stall (no byte parsed for 10 s) fails; a slow stand-in on a big workload does not.
            let (mut len, mut progressed) = (0, std::time::Instant::now());
            loop {
                let now = self.seen.lock().unwrap().len();
                if now >= expected.len() {
                    break;
                }
                if now != len {
                    (len, progressed) = (now, std::time::Instant::now());
                }
                assert!(
                    progressed.elapsed() < std::time::Duration::from_secs(10),
                    "the core parsed {now} of {} bytes, then stalled",
                    expected.len()
                );
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            assert_eq!(sha256(&self.seen.lock().unwrap()), sha256(expected));
            let (peak, window) = (self.peak_queued.load(SeqCst), crate::ssh::OUTPUT_WINDOW);
            assert!(
                peak <= window as usize,
                "{peak} bytes queued over the {window} window"
            );
        }

        /// [`Self::assert_stream`], and nothing crossed the Channel (`ipc`).
        pub(crate) async fn assert_received(&self, expected: &[u8], ipc: &AtomicUsize) {
            self.assert_stream(expected).await;
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

        fn input(&self, _: &AccessLease, input: CoreInput) -> Result<usize, String> {
            self.inputs.lock().unwrap().push(input);
            Ok(0)
        }

        /// The parsed bytes as one row of text: enough to see what the commands do with a lease.
        /// The stand-in's screen is every byte it parsed.
        fn ansi_snapshot(&self) -> Result<(String, usize), String> {
            let seen = self.seen.lock().unwrap();
            Ok((
                String::from_utf8_lossy(&seen).into_owned(),
                self.queued.load(SeqCst),
            ))
        }

        fn control_snapshot(&self, _: &AccessLease, window: Option<usize>) -> Result<Json, String> {
            let text = String::from_utf8_lossy(&self.seen.lock().unwrap()).into_owned();
            Ok(serde_json::json!({"window": {"first": 0, "rows": [text]}, "asked": window}))
        }

        fn control_scroll(
            &self,
            lease: &AccessLease,
            _: Json,
            window: Option<usize>,
        ) -> Result<Json, String> {
            self.control_snapshot(lease, window)
        }

        fn control_resize(
            &self,
            lease: &AccessLease,
            cols: u32,
            rows: u32,
            window: Option<usize>,
        ) -> Result<Json, String> {
            self.resize(cols, rows)?;
            self.control_snapshot(lease, window)
        }

        /// Answers with the question, so a test sees what a command asked.
        fn control_query(&self, _: &AccessLease, query: Json) -> Result<Json, String> {
            self.asked.lock().unwrap().push(query.clone());
            Ok(query)
        }

        fn select(&self, _: &AccessLease, range: Option<Json>) -> Result<(), String> {
            self.asked.lock().unwrap().push(range.into());
            Ok(())
        }

        fn set_active(&self, _: &AccessLease, active: bool) {
            self.active.store(active, SeqCst);
        }

        fn set_theme(&self, theme: &Json) -> Result<(), String> {
            self.themes.lock().unwrap().push(theme.clone());
            Ok(())
        }

        fn set_scrollback(&self, lines: u32) -> Result<(), String> {
            self.history.lock().unwrap().push(lines);
            Ok(())
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

    /// What a control answer may hold: the state and the text of rows, and nothing a cell grid could ride in.
    #[cfg(native_terminal_core)]
    pub(crate) fn assert_no_cells(answer: &Json) {
        let keys = |value: &Json| -> Vec<String> {
            let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        };
        assert_eq!(keys(answer), ["state", "window"]);
        let state = &answer["state"];
        assert_eq!(
            keys(state),
            ["columns", "cursor", "modes", "rows", "viewport"]
        );
        assert_eq!(keys(&state["cursor"]), ["x", "y"]);
        assert_eq!(
            keys(&state["modes"]),
            [
                "alternateScreen",
                "applicationCursorKeys",
                "bracketedPaste",
                "mouseTracking"
            ]
        );
        assert_eq!(
            keys(&state["viewport"]),
            ["following", "length", "rows", "top"]
        );
        assert_eq!(keys(&answer["window"]), ["first", "rows"]);
        let rows = answer["window"]["rows"].as_array().unwrap();
        assert!(rows.iter().all(Json::is_string), "a row is its text");
        assert!(rows.len() <= 1024, "a window is bounded");
    }

    /// A session released while its transport keeps delivering: the Channels it had and was released to, what
    /// the transport delivered, what the core returned as credit, and what `terminal_core_release` answered.
    pub(crate) struct Released {
        pub(crate) delivered: Vec<u8>,
        pub(crate) snapshot: String,
        pub(crate) credited: Arc<AtomicUsize>,
        pub(crate) slot: Arc<CoreSlot>,
        pub(crate) first: Channel<SshEvent>,
        pub(crate) first_events: tokio::sync::mpsc::UnboundedReceiver<Json>,
        pub(crate) second_events: tokio::sync::mpsc::UnboundedReceiver<Json>,
    }

    /// Attaches `prepared` as session `id`, has a transport thread deliver `prelude` and then one numbered line
    /// per chunk without pause, releases the session while lines are in flight and stops the transport some
    /// lines later.
    pub(crate) async fn release_mid_stream(
        id: &str,
        prepared: Prepared,
        prelude: &[u8],
    ) -> Released {
        use crate::ssh::test_support::json_events;
        let (slot, credited) = (Arc::new(CoreSlot::default()), Arc::new(AtomicUsize::new(0)));
        let counted = credited.clone();
        let credit = move |bytes| {
            counted.fetch_add(bytes, SeqCst);
        };
        prepared.attach(id, &slot, Arc::new(credit), Arc::new(|_, _| Ok(())));
        let (first, first_events) = json_events();
        let (second, second_events) = json_events();
        let (lines, stop) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let transport = {
            let (slot, first, lines, stop) =
                (slot.clone(), first.clone(), lines.clone(), stop.clone());
            let mut delivered = prelude.to_vec();
            std::thread::spawn(move || {
                slot.route(&first).data(&delivered).unwrap();
                while stop.load(SeqCst) == 0 {
                    let line = format!("line {}\r\n", lines.fetch_add(1, SeqCst));
                    slot.route(&first).data(line.as_bytes()).unwrap();
                    delivered.extend_from_slice(line.as_bytes());
                    std::thread::sleep(std::time::Duration::from_micros(50));
                }
                delivered
            })
        };
        let reached = |count: usize| {
            let lines = lines.clone();
            async move {
                while lines.load(SeqCst) < count {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
            }
        };
        reached(60).await;
        assert!(
            slot.is_attached(),
            "the core acknowledges until the release"
        );
        let lease = crate::app_lock::AccessState::disabled()
            .lease(None)
            .unwrap();
        let snapshot = terminal_core_release(lease, id.to_owned(), second)
            .await
            .unwrap()
            .into_inner()
            .unwrap();
        reached(lines.load(SeqCst) + 60).await;
        stop.store(1, SeqCst);
        Released {
            delivered: transport.join().unwrap(),
            snapshot,
            credited,
            slot,
            first,
            first_events,
            second_events,
        }
    }

    /// The `data` bytes a Channel received so far, in order, and its other messages.
    pub(crate) fn received(
        events: &mut tokio::sync::mpsc::UnboundedReceiver<Json>,
    ) -> (Vec<u8>, Vec<Json>) {
        let (mut bytes, mut others) = (Vec::new(), Vec::new());
        while let Ok(event) = events.try_recv() {
            match event["data"].as_array() {
                Some(data) => bytes.extend(data.iter().map(|byte| byte.as_u64().unwrap() as u8)),
                None => others.push(event),
            }
        }
        (bytes, others)
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
            "terminal_core_input",
            "terminal_core_text",
            "terminal_core_ansi_snapshot",
            "terminal_core_release",
            "terminal_core_snapshot",
            "terminal_core_scroll",
            "terminal_core_resize",
            "terminal_core_set_active",
            "terminal_core_theme",
            "terminal_core_scrollback",
            "terminal_core_selection_text",
            "terminal_core_search",
            "terminal_core_word_at",
            "terminal_core_link_at",
            "terminal_core_line_at",
            "terminal_core_buffer_range",
            "terminal_core_copy_screen",
            "terminal_core_select",
        ] {
            assert!(!allowed_while_locked(protected), "{protected}");
        }
    }

    #[test]
    fn a_locked_app_can_not_ask_the_control_plane_a_question() {
        let access = crate::ssh::test_support::unlocked_access();
        let lease = crate::ssh::test_support::ready_lease(&access);
        let (_core, prepared) = ChecksumCore::prepared();
        let _kept = tests_keeping_cores().read();
        prepared.attach(
            "locked-control",
            &CoreSlot::default(),
            Arc::new(|_| {}),
            Arc::new(|_, _| Ok(())),
        );
        let ask = |lease: AccessLease| async move {
            let id = || "locked-control".to_owned();
            let scroll = serde_json::json!({"kind": "toBottom"});
            [
                terminal_core_snapshot(lease.clone(), id(), None)
                    .await
                    .is_ok(),
                terminal_core_scroll(lease.clone(), id(), scroll, None)
                    .await
                    .is_ok(),
                terminal_core_resize(lease.clone(), id(), 80, 24, None)
                    .await
                    .is_ok(),
                terminal_core_set_active(lease.clone(), id(), true)
                    .await
                    .is_ok(),
                terminal_core_theme(lease, id(), serde_json::json!({}))
                    .await
                    .is_ok(),
            ]
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert_eq!(runtime.block_on(ask(lease.clone())), [true; 5]);
        access.lock().unwrap();
        assert_eq!(
            runtime.block_on(ask(lease)),
            [false; 5],
            "every control command is refused to a lease the lock revoked"
        );
        close("locked-control");
    }

    /// A stand-in core attached as session `id`, with the access state and the lease of the renderer that may ask it.
    fn gated(id: &str) -> (crate::app_lock::AccessState, AccessLease, Arc<ChecksumCore>) {
        let access = crate::app_lock::AccessState::disabled();
        let renderer = access.lease(None).unwrap();
        let (core, prepared) = ChecksumCore::prepared();
        prepared.attach(
            id,
            &CoreSlot::default(),
            Arc::new(|_| {}),
            Arc::new(|_, _| Ok(())),
        );
        (access, renderer, core)
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn the_control_commands_need_a_session_a_valid_size_and_the_current_renderer() {
        let _kept = tests_keeping_cores().read();
        let (access, renderer, core) = gated("control-gated");
        let message = |result: AccessResult<Json>| result.err().unwrap().into_inner().unwrap();
        let scroll = || serde_json::json!({"kind": "toTop"});
        assert!(
            terminal_core_snapshot(renderer.clone(), "control-gated".into(), Some(4))
                .await
                .unwrap()
                .into_inner()
                .is_ok()
        );
        for result in [
            terminal_core_snapshot(renderer.clone(), "nobody".into(), None).await,
            terminal_core_scroll(renderer.clone(), "nobody".into(), scroll(), None).await,
            terminal_core_resize(renderer.clone(), "nobody".into(), 80, 24, None).await,
        ] {
            assert_eq!(message(result), "No native terminal core for this session");
        }
        assert!(
            terminal_core_set_active(renderer.clone(), "nobody".into(), true)
                .await
                .err()
                .is_some()
        );
        for (cols, rows) in [(0, 24), (80, 0), (1001, 24), (80, 1001)] {
            let refused =
                terminal_core_resize(renderer.clone(), "control-gated".into(), cols, rows, None)
                    .await;
            assert!(
                message(refused).contains("between 1 and 1000"),
                "{cols}x{rows}"
            );
        }
        assert!(
            core.sizes.lock().unwrap().is_empty(),
            "a refused size reaches no core"
        );
        terminal_core_resize(renderer.clone(), "control-gated".into(), 90, 30, None)
            .await
            .unwrap();
        assert_eq!(*core.sizes.lock().unwrap(), [(90, 30)]);
        terminal_core_set_active(renderer.clone(), "control-gated".into(), false)
            .await
            .unwrap();
        assert!(!core.active.load(std::sync::atomic::Ordering::SeqCst));
        let theme = serde_json::json!({"background": "#101311"});
        terminal_core_theme(renderer.clone(), "control-gated".into(), theme.clone())
            .await
            .unwrap();
        assert_eq!(*core.themes.lock().unwrap(), std::slice::from_ref(&theme));
        assert!(
            terminal_core_theme(renderer.clone(), "nobody".into(), theme.clone())
                .await
                .is_err(),
            "no session, no theme"
        );
        terminal_core_scrollback(renderer.clone(), "control-gated".into(), 2_000)
            .await
            .unwrap();
        assert_eq!(*core.history.lock().unwrap(), [2_000]);
        for (session, lines) in [
            ("control-gated", 99),
            ("control-gated", 20_001),
            ("nobody", 2_000),
        ] {
            assert!(
                terminal_core_scrollback(renderer.clone(), session.into(), lines)
                    .await
                    .is_err(),
                "{session} {lines}: outside the setting's range or no session"
            );
        }
        assert_eq!(core.history.lock().unwrap().len(), 1);
        access.replace_renderer().unwrap();
        assert!(
            terminal_core_scrollback(renderer.clone(), "control-gated".into(), 3_000)
                .await
                .is_err(),
            "a replaced renderer is refused"
        );
        assert!(
            terminal_core_theme(renderer.clone(), "control-gated".into(), theme)
                .await
                .is_err(),
            "a replaced renderer is refused"
        );
        assert_eq!(core.themes.lock().unwrap().len(), 1);
        assert_eq!(
            core.history.lock().unwrap().len(),
            1,
            "a replaced renderer changes no history"
        );
        for result in [
            terminal_core_snapshot(renderer.clone(), "control-gated".into(), None).await,
            terminal_core_scroll(renderer.clone(), "control-gated".into(), scroll(), None).await,
            terminal_core_resize(renderer.clone(), "control-gated".into(), 80, 24, None).await,
        ] {
            assert!(
                result.err().unwrap().into_inner().is_err(),
                "a replaced renderer is refused"
            );
        }
        close("control-gated");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn the_text_commands_ask_the_core_one_question_each_for_the_current_renderer_only() {
        use serde_json::json;
        let _kept = tests_keeping_cores().read();
        let (access, renderer, core) = gated("text-gated");
        let id = || "text-gated".to_owned();
        let range = json!({"start": {"x": 1, "y": 2}, "end": {"x": 3, "y": 4}});
        let lease = renderer.clone();
        let ask = |id: String| async {
            let range = json!({"start": {"x": 1, "y": 2}, "end": {"x": 3, "y": 4}});
            let lease = || lease.clone();
            [
                terminal_core_selection_text(lease(), id.clone(), range).await,
                terminal_core_search(
                    lease(),
                    id.clone(),
                    "needle".into(),
                    json!("backward"),
                    Some(7),
                )
                .await,
                terminal_core_word_at(lease(), id.clone(), json!({"x": 5, "y": 6})).await,
                terminal_core_link_at(lease(), id.clone(), json!({"x": 7, "y": 8})).await,
                terminal_core_line_at(lease(), id.clone(), 9).await,
                terminal_core_buffer_range(lease(), id.clone()).await,
                terminal_core_copy_screen(lease(), id).await,
            ]
        };
        for answer in ask(id()).await {
            assert!(answer.unwrap().into_inner().is_ok());
        }
        terminal_core_select(renderer.clone(), id(), Some(range.clone()))
            .await
            .unwrap();
        terminal_core_select(renderer.clone(), id(), None)
            .await
            .unwrap();
        assert_eq!(
            *core.asked.lock().unwrap(),
            [
                json!({"kind": "selectionText", "range": range}),
                json!({"kind": "search", "query": "needle", "direction": "backward", "from": 7}),
                json!({"kind": "wordAt", "cell": {"x": 5, "y": 6}}),
                json!({"kind": "linkAt", "cell": {"x": 7, "y": 8}}),
                json!({"kind": "lineAt", "row": 9}),
                json!({"kind": "bufferRange"}),
                json!({"kind": "copyScreen"}),
                range,
                Json::Null,
            ]
        );
        for answer in ask("nobody".into()).await {
            assert_eq!(
                answer.err().unwrap().into_inner().unwrap(),
                "No native terminal core for this session"
            );
        }
        access.replace_renderer().unwrap();
        for answer in ask(id()).await {
            assert!(
                answer.err().unwrap().into_inner().is_err(),
                "a replaced renderer is refused"
            );
        }
        assert!(terminal_core_select(renderer, id(), None).await.is_err());
        assert_eq!(
            core.asked.lock().unwrap().len(),
            9,
            "a refusal asks nothing"
        );
        close("text-gated");
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
        prepared.attach(
            "rebind-attached",
            &CoreSlot::default(),
            Arc::new(|_| {}),
            Arc::new(|_, _| Ok(())),
        );
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

    fn lease() -> AccessLease {
        crate::app_lock::AccessState::disabled()
            .lease(None)
            .unwrap()
    }

    /// The error `terminal_core_open` returns for an 80x24 session with these History lines.
    async fn open_error(lines: Option<u32>) -> String {
        terminal_core_open(lease(), channel(), 80, 24, lines, None)
            .await
            .err()
            .unwrap()
            .into_inner()
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn a_release_hands_the_transport_to_the_new_channel_with_every_byte_once_and_in_order() {
        let _kept = tests_keeping_cores().read();
        let (core, prepared) = ChecksumCore::prepared();
        let mut released = fake::release_mid_stream("handed-back", prepared, b"").await;
        // The stand-in's snapshot is every byte it parsed: with the new Channel's data, the whole stream.
        let (after, _) = fake::received(&mut released.second_events);
        assert!(!released.snapshot.is_empty() && !after.is_empty());
        assert_eq!(
            fake::sha256(&[released.snapshot.as_bytes(), &after].concat()),
            fake::sha256(&released.delivered)
        );
        assert_eq!(
            fake::received(&mut released.first_events),
            (vec![], vec![]),
            "nothing reaches the Channel the session started with"
        );
        // The core returned the credit of what it consumed and is freed; the rest is the WebView's to acknowledge.
        assert_eq!(
            released.credited.load(std::sync::atomic::Ordering::SeqCst),
            released.snapshot.len()
        );
        assert!(core.closed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!released.slot.is_attached());
        // A resize no longer reaches the freed core, and the closing notice follows the output.
        released.slot.resize(100, 30).unwrap();
        assert!(core.sizes.lock().unwrap().is_empty());
        let routed = released.slot.route(&released.first);
        routed.closed("Session ended".into(), false).unwrap();
        let (_, notices) = fake::received(&mut released.second_events);
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert_eq!(notices[0]["message"], "Session ended");
        assert_eq!(
            fake::received(&mut released.first_events).1,
            [] as [Json; 0]
        );
        // Released once: there is no core left to snapshot or release.
        for result in [
            terminal_core_release(lease(), "handed-back".into(), channel()).await,
            terminal_core_ansi_snapshot(lease(), "handed-back".into()).await,
        ] {
            assert_eq!(
                result.err().unwrap().into_inner().unwrap(),
                "No native terminal core for this session"
            );
        }
    }

    #[tokio::test]
    async fn open_refuses_history_lines_outside_the_setting_range() {
        for lines in [0, 99, 20_001, u32::MAX] {
            let error = open_error(Some(lines)).await;
            assert_eq!(error, "scrollback lines must be 100 to 20000", "{lines}");
        }
    }

    #[test]
    fn the_core_is_available_only_with_both_the_core_and_a_surface_host() {
        let answers = [(false, false), (false, true), (true, false), (true, true)]
            .map(|(core, host)| availability(core, host));
        assert_eq!(
            answers.each_ref().map(|answer| answer.available),
            [false, false, false, true]
        );
        // A missing core is reported before a missing host, and each reason names what is missing.
        assert!(
            answers[0].reason.contains("not built"),
            "{}",
            answers[0].reason
        );
        assert_eq!(answers[0].reason, answers[1].reason);
        assert!(
            answers[2].reason.contains("Android"),
            "{}",
            answers[2].reason
        );
    }

    #[test]
    fn this_build_answers_with_what_it_has_compiled_in() {
        let answer = serde_json::to_value(terminal_core_available()).unwrap();
        assert_eq!(
            answer["available"],
            cfg!(all(
                native_terminal_core,
                any(
                    target_os = "android",
                    target_os = "linux",
                    any(target_os = "macos", target_os = "ios")
                )
            ))
        );
        assert!(!answer["reason"].as_str().unwrap().is_empty());
        assert!(crate::app_lock::allowed_while_locked(
            "terminal_core_available"
        ));
    }

    fn adapter(name: &str, device_type: &str) -> ProbeAdapter {
        ProbeAdapter {
            name: name.into(),
            backend: "Vulkan".into(),
            device_type: device_type.into(),
            driver: String::new(),
        }
    }

    #[test]
    fn the_probe_asks_the_gpu_only_of_a_build_that_could_run_native_and_carries_its_reason() {
        let asked = std::cell::Cell::new(0);
        let ask = |chosen: Result<ProbeAdapter, &str>, seen: Vec<ProbeAdapter>| {
            asked.set(asked.get() + 1);
            Gpu {
                chosen: chosen.map_err(String::from),
                seen,
            }
        };
        let missing = probe(availability(false, true), || {
            ask(Ok(adapter("unused", "DiscreteGpu")), Vec::new())
        });
        assert_eq!((missing.available, asked.get()), (false, 0));
        assert_eq!(missing.reason, NOT_BUILT);
        let cpu = adapter("llvmpipe", "Cpu");
        let software = probe(availability(true, true), || {
            ask(
                Err("renderer unsupported: no hardware GPU, only a software rasterizer"),
                vec![cpu.clone()],
            )
        });
        assert!(!software.available);
        assert!(
            software.reason.contains("no hardware GPU"),
            "{}",
            software.reason
        );
        // What the device offered is reported even when nothing could be chosen.
        assert_eq!((software.adapter, software.seen), (None, vec![cpu.clone()]));
        let radeon = adapter("Radeon", "DiscreteGpu");
        let drawn = probe(availability(true, true), || {
            ask(Ok(radeon.clone()), vec![radeon.clone(), cpu.clone()])
        });
        assert!(drawn.available);
        assert!(drawn.reason.contains("Radeon (Vulkan)"), "{}", drawn.reason);
        assert!(!drawn.reason.contains("software"), "{}", drawn.reason);
        assert_eq!(drawn.adapter, Some(radeon.clone()));
        assert_eq!(drawn.seen, vec![radeon, cpu.clone()]);
        // A rasterizer is chosen only under the debug switch, and the reason says so.
        let allowed = probe(availability(true, true), || ask(Ok(cpu.clone()), vec![cpu]));
        assert!(allowed.available);
        assert!(
            allowed.reason.contains("software rasterizer"),
            "{}",
            allowed.reason
        );
        assert_eq!(asked.get(), 3);
    }

    #[tokio::test]
    async fn a_probe_over_its_budget_is_a_refusal_that_says_so_and_one_within_it_is_passed_on() {
        let answer = NativeProbe {
            available: true,
            reason: "drawn".into(),
            elapsed_ms: 3,
            adapter: Some(adapter("Radeon", "DiscreteGpu")),
            seen: Vec::new(),
        };
        let kept = answer.clone();
        assert_eq!(within(PROBE_BUDGET, move || kept).await, answer);
        let budget = std::time::Duration::from_millis(20);
        let late = within(budget, move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            answer
        })
        .await;
        assert!(!late.available);
        assert!(late.reason.contains("longer than 20 ms"), "{}", late.reason);
    }

    #[tokio::test]
    async fn this_build_answers_the_probe_once_within_the_budget_and_repeats_the_same_answer() {
        let started = std::time::Instant::now();
        let first = native_terminal_probe().await;
        assert!(started.elapsed() < PROBE_BUDGET, "{:?}", started.elapsed());
        // Only an Android build with the core can draw here: a Linux one needs a Wayland window, which no test
        // process has, and every other build has no host. Each is refused with a reason.
        if !cfg!(all(native_terminal_core, target_os = "android")) {
            assert!(!first.available);
        }
        assert!(!first.reason.is_empty());
        assert!(first.elapsed_ms < PROBE_BUDGET.as_millis() as u64);
        assert_eq!(native_terminal_probe().await, first);
        let answer = serde_json::to_value(&first).unwrap();
        assert!(answer["elapsedMs"].is_u64(), "{answer}");
        assert!(answer["seen"].is_array(), "{answer}");
        assert!(crate::app_lock::allowed_while_locked(
            "native_terminal_probe"
        ));
    }

    /// What a build without the real core says: it is not built, or (the kill switch, even with the feature) disabled.
    #[cfg(not(native_terminal_core))]
    #[tokio::test]
    async fn without_the_real_core_the_commands_say_why() {
        let why = if cfg!(native_terminal_disabled) {
            "The native terminal is disabled in this build"
        } else {
            "The native terminal core is not built into this app"
        };
        assert_eq!(open_error(None).await, why);
        // The ends of the History lines range reach the core; only values outside it are refused.
        for lines in [100, 20_000] {
            assert_eq!(open_error(Some(lines)).await, why, "{lines}");
        }
        assert!(terminal_core_open(lease(), channel(), 0, 24, None, None)
            .await
            .is_err());
        assert!(terminal_core_text(lease(), "none".into()).await.is_err());
        terminal_core_close("none".into()).unwrap();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn a_replaced_renderer_cannot_read_a_core() {
        let _kept = tests_keeping_cores().read();
        let access = crate::app_lock::AccessState::disabled();
        let renderer = access.lease(None).unwrap();
        let (_core, prepared) = ChecksumCore::prepared();
        prepared.attach(
            "lease-gated",
            &CoreSlot::default(),
            Arc::new(|_| {}),
            Arc::new(|_, _| Ok(())),
        );
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

    fn lease_of(access: &crate::app_lock::AccessState) -> AccessLease {
        access.lease(None).unwrap()
    }

    #[test]
    fn the_writer_sends_exact_bytes_under_the_latest_lease_and_refuses_when_it_cannot() {
        let (_core, prepared, link) = ChecksumCore::linked();
        assert!(link.write(b"x").is_err(), "no transport attached yet");
        let (sent, full) = (
            Arc::new(Mutex::new(Vec::<Vec<u8>>::new())),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let (queue_sent, queue_full) = (sent.clone(), full.clone());
        prepared.attach(
            "writer-gating",
            &CoreSlot::default(),
            Arc::new(|_| {}),
            Arc::new(move |bytes, _| {
                if queue_full.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("Terminal input queue is full".into());
                }
                queue_sent.lock().unwrap().push(bytes);
                Ok(())
            }),
        );
        assert!(link.write(b"x").is_err(), "no lease yet");
        let (replaced, current) = (
            crate::app_lock::AccessState::disabled(),
            crate::app_lock::AccessState::disabled(),
        );
        link.use_lease(&lease_of(&replaced));

        // An X10 mouse report is not text: bytes above 0x7f and a NUL must arrive untouched.
        let report = [0x1b, b'[', b'M', 0x20, 0xe8, 0x00, 0xff];
        link.write(&report).unwrap();
        assert_eq!(*sent.lock().unwrap(), [report.to_vec()]);

        assert!(link.write(&vec![0; MAX_WRITE + 1]).is_err());
        link.write(&vec![0; MAX_WRITE]).unwrap();
        assert_eq!(sent.lock().unwrap().len(), 2, "only the bounded write left");

        full.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(link.write(b"x"), Err("Terminal input queue is full".into()));
        full.store(false, std::sync::atomic::Ordering::SeqCst);

        replaced.replace_renderer().unwrap();
        assert!(link.write(b"reply").is_err(), "a replaced renderer's lease");
        assert_eq!(
            sent.lock().unwrap().len(),
            2,
            "nothing went out while gated"
        );
        link.use_lease(&lease_of(&current));
        link.write(b"reply").unwrap();
        assert_eq!(sent.lock().unwrap().last().unwrap(), b"reply");
    }

    #[test]
    fn input_events_arrive_in_the_shape_of_the_dom_event() {
        let parse = |json: &str| serde_json::from_str::<CoreInput>(json);
        let key = parse(
            r#"{"type":"key","code":"KeyA","key":"a","mods":{"ctrl":true,"shift":true},"repeat":true}"#,
        )
        .unwrap();
        assert!(matches!(
            key,
            CoreInput::Key { ref code, ref key, mods: Mods { ctrl: true, shift: true, alt: false, meta: false }, repeat: true, release: false, composing: false }
                if code == "KeyA" && key == "a"
        ));
        let mouse =
            parse(r#"{"type":"mouse","action":"press","button":"wheelUp","x":55.5,"y":30}"#)
                .unwrap();
        assert!(matches!(
            mouse,
            CoreInput::Mouse { action: MouseAction::Press, button: Some(MouseButton::WheelUp), x, y, .. }
                if x == 55.5 && y == 30.0
        ));
        assert!(matches!(
            parse(r#"{"type":"mouse","action":"motion","button":null,"x":0,"y":0}"#).unwrap(),
            CoreInput::Mouse {
                action: MouseAction::Motion,
                button: None,
                ..
            }
        ));
        assert!(matches!(
            parse(r#"{"type":"paste","text":"a\nb"}"#).unwrap(),
            CoreInput::Paste { text } if text == "a\nb"
        ));
        assert!(matches!(
            parse(r#"{"type":"text","text":"a\u007f\r"}"#).unwrap(),
            CoreInput::Text { text } if text == "a\x7f\r"
        ));
        assert!(parse(r#"{"type":"text"}"#).is_err());
        assert!(matches!(
            parse(r#"{"type":"focus","focused":false}"#).unwrap(),
            CoreInput::Focus { focused: false }
        ));
        assert!(parse(r#"{"type":"scroll"}"#).is_err());
        assert!(parse(r#"{"type":"mouse","action":"drag","x":0,"y":0}"#).is_err());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn only_the_current_renderer_can_send_input_and_pastes_and_texts_are_bounded() {
        let _kept = tests_keeping_cores().read();
        let access = crate::app_lock::AccessState::disabled();
        let renderer = lease_of(&access);
        let (core, prepared) = ChecksumCore::prepared();
        prepared.attach(
            "input-gated",
            &CoreSlot::default(),
            Arc::new(|_| {}),
            Arc::new(|_, _| Ok(())),
        );
        let paste = |text: String| CoreInput::Paste { text };
        let sent = terminal_core_input(renderer.clone(), "input-gated".into(), paste("ok".into()))
            .await
            .unwrap();
        assert_eq!(sent.into_inner().unwrap(), 0);
        assert!(terminal_core_input(
            renderer.clone(),
            "input-gated".into(),
            paste("x".repeat(MAX_PASTE + 1))
        )
        .await
        .is_err());
        assert!(
            terminal_core_input(renderer.clone(), "missing".into(), paste("ok".into()))
                .await
                .is_err()
        );
        let text = |text: String| CoreInput::Text { text };
        terminal_core_input(renderer.clone(), "input-gated".into(), text("ok".into()))
            .await
            .unwrap();
        assert!(terminal_core_input(
            renderer.clone(),
            "input-gated".into(),
            text("x".repeat(MAX_PASTE + 1))
        )
        .await
        .is_err());
        assert_eq!(
            core.inputs.lock().unwrap().len(),
            2,
            "only the first paste and the first text"
        );
        access.replace_renderer().unwrap();
        for input in [paste("ok".into()), text("ok".into())] {
            assert!(
                terminal_core_input(renderer.clone(), "input-gated".into(), input)
                    .await
                    .is_err()
            );
        }
        assert_eq!(core.inputs.lock().unwrap().len(), 2);
        close("input-gated");
    }
}
