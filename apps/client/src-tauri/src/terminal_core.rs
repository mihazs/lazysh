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
    /// Free the core now. Idempotent.
    fn close(&self);
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
        Config, Hooks, Hub, HubConfig, Offer, Origin, PtyWriter, Refused, Session, Size,
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

    struct Runtime(Session);

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

        fn close(&self) {
            self.0.close();
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
        };
        Ok(Box::new(move || {
            let cell = Arc::new(CreditCell::default());
            let credit = cell.returner();
            let hooks = Hooks {
                writer: Arc::new(RefuseAll),
                credit: Box::new(move |bytes| credit(bytes)),
                changed: None,
            };
            let session = HUB
                .create(uuid::Uuid::new_v4().to_string(), config, hooks)
                .map_err(|error| error.to_string())?;
            Ok(Prepared::new(Arc::new(Runtime(session)), cell))
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
        for protected in ["terminal_core_open", "terminal_core_text"] {
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

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn a_replaced_renderer_cannot_read_a_core() {
        let _kept = tests_keeping_cores().read();
        let access = crate::app_lock::AccessState::disabled();
        let renderer = access.lease(None).unwrap();
        let (_core, prepared) = ChecksumCore::prepared();
        prepared.attach("lease-gated", &CoreSlot::default(), Arc::new(|_| {}));
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
}
