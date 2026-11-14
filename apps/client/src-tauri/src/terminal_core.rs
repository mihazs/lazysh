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
#![cfg_attr(not(test), allow(dead_code))]

use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::SshEvent;
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
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
    /// Encode one input event for the modes the program has set and queue the bytes on the transport
    /// under `lease`; the bytes sent (0 when the modes ask for nothing, such as a focus event the
    /// program did not enable). Refused while `lease` is no longer valid.
    fn input(&self, lease: &AccessLease, input: CoreInput) -> Result<usize, String>;
    /// Free the core now. Idempotent.
    fn close(&self);
}

/// Most text one paste may carry, the limit `write_stdin` puts on a paste.
const MAX_PASTE: usize = 64 * 1024;

/// One input event of the renderer for the core to encode, in the shape of the DOM event it came
/// from: `code` names the physical key and `key` what it produced.
// The fields are read by the real core, which is built only with the `native-terminal` feature.
#[derive(Debug, Deserialize)]
#[cfg_attr(not(feature = "native-terminal"), allow(dead_code))]
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
    /// Reported only while the program enabled focus events.
    Focus { focused: bool },
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[cfg_attr(not(feature = "native-terminal"), allow(dead_code))]
#[serde(default)]
pub(crate) struct Mods {
    pub(crate) shift: bool,
    pub(crate) ctrl: bool,
    pub(crate) alt: bool,
    pub(crate) meta: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(not(feature = "native-terminal"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub(crate) enum MouseAction {
    Press,
    Release,
    Motion,
}

/// X11 buttons 1 to 5.
#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(not(feature = "native-terminal"), allow(dead_code))]
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
            offer(
                &events,
                native::factory(cols, rows, scrollback_bytes, lease.clone())?,
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
            if matches!(&input, CoreInput::Paste { text } if text.len() > MAX_PASTE) {
                return Err("Paste at most 64 KiB at once".to_owned());
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

#[tauri::command]
pub fn terminal_core_close(session_id: String) -> Result<(), String> {
    close(&session_id);
    Ok(())
}

/// The real core, `lazysh-terminal-runtime` on libghostty-vt, which needs Zig 0.16.0 to build; without
/// the `native-terminal` feature no build needs Zig and the commands report that.
#[cfg(not(feature = "native-terminal"))]
mod native {
    pub(super) fn factory(
        _: u32,
        _: u32,
        _: Option<u32>,
        _: crate::app_lock::AccessLease,
    ) -> Result<super::Factory, String> {
        Err("The native terminal core is not built into this app".into())
    }
}

#[cfg(feature = "native-terminal")]
mod native {
    use super::*;
    use lazysh_terminal_runtime::{
        dom_mods, ffi, Config, DomKey, Hooks, Hub, HubConfig, KeyInput, MouseInput, Offer, Origin,
        PtyWriter, Refused, Session, Size,
    };

    static HUB: LazyLock<Hub> = LazyLock::new(|| Hub::new(HubConfig::default()));

    /// Replies and encoded input leave through the transport's input queue under the renderer's
    /// latest lease. A refusal (gated, queue full, session gone) drops a reply and fails an input
    /// command, which the hub counts; the origin changes nothing here, both are access-gated alike.
    struct Writer(Arc<Link>);

    impl PtyWriter for Writer {
        fn write(&self, _: Origin, bytes: &[u8]) -> Result<(), Refused> {
            self.0.write(bytes).map_err(|_| Refused)
        }
    }

    /// Live sessions and reserved scrollback bytes in the process-wide hub, for the lifecycle test.
    #[cfg(test)]
    pub(super) fn hub_usage() -> (usize, usize) {
        (HUB.live(), HUB.scrollback_reserved())
    }

    struct Runtime(Session, Arc<Link>);

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

        fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
            let size = Size::new(cols as u16, rows as u16);
            self.0
                .with(|runtime| runtime.request_size(size))
                .map_err(|error| error.to_string())?
                .map(drop)
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
                CoreInput::Paste { text } => self.0.send_paste(&text),
                CoreInput::Focus { focused } => self.0.send_focus(focused),
            }
            .map_err(|error| error.to_string())
        }

        fn close(&self) {
            self.0.close();
        }
    }

    pub(super) fn factory(
        cols: u32,
        rows: u32,
        scrollback_bytes: Option<u32>,
        lease: AccessLease,
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
            let (core, link) = create(config, &lease)?;
            Ok(Prepared::new(Arc::new(core), link))
        }))
    }

    /// A session in the hub whose replies and encoded input go through the returned [`Link`], under
    /// `lease` until a command brings a newer one.
    fn create(config: Config, lease: &AccessLease) -> Result<(Runtime, Arc<Link>), String> {
        let link = Arc::new(Link::default());
        link.use_lease(lease);
        let credit = link.returner();
        let hooks = Hooks {
            writer: Arc::new(Writer(link.clone())),
            credit: Box::new(move |bytes| credit(bytes)),
            changed: None,
        };
        let session = HUB
            .create(uuid::Uuid::new_v4().to_string(), config, hooks)
            .map_err(|error| error.to_string())?;
        Ok((Runtime(session, link.clone()), link))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::{Duration, Instant};

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
            let (core, link) = create(config, &access.lease(None).unwrap()).unwrap();
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
                let start = Instant::now();
                while !done() {
                    assert!(start.elapsed() < Duration::from_secs(10), "timed out");
                    std::thread::sleep(Duration::from_millis(5));
                }
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
        /// The input events the bridge handed to `Core::input`, in order.
        pub(crate) inputs: Mutex<Vec<CoreInput>>,
        pub(crate) closed: std::sync::atomic::AtomicBool,
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
                inputs: Mutex::default(),
                closed: Default::default(),
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

        fn input(&self, _: &AccessLease, input: CoreInput) -> Result<usize, String> {
            self.inputs.lock().unwrap().push(input);
            Ok(0)
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
            "terminal_core_input",
            "terminal_core_text",
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
            parse(r#"{"type":"focus","focused":false}"#).unwrap(),
            CoreInput::Focus { focused: false }
        ));
        assert!(parse(r#"{"type":"scroll"}"#).is_err());
        assert!(parse(r#"{"type":"mouse","action":"drag","x":0,"y":0}"#).is_err());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn only_the_current_renderer_can_send_input_and_a_paste_is_bounded() {
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
        assert_eq!(core.inputs.lock().unwrap().len(), 1, "only the first paste");
        access.replace_renderer().unwrap();
        assert!(
            terminal_core_input(renderer, "input-gated".into(), paste("ok".into()))
                .await
                .is_err()
        );
        assert_eq!(core.inputs.lock().unwrap().len(), 1);
        close("input-gated");
    }
}
