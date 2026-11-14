//! Transport-independent session service ([#1315], [#1316], [#1319]): one [`Hub`] owns a small,
//! fixed pool of VT worker threads and every session's [`TerminalRuntime`]. SSH, Mosh, ET and the
//! local PTY all feed bytes through the same [`Session::feed`]; none of them knows about the VT.
//!
//! * Transport side: `feed` queues a chunk (bounded by the runtime's ingress, which equals the
//!   transport credit window) and returns at once. After a worker has run the bytes through the
//!   VT it calls [`Hooks::credit`] with that byte count: credits are acknowledged only after VT
//!   processing, so the window bounds memory and a slow VT slows the producer instead of dropping.
//! * Output side: terminal replies (DA, DSR, ...) and encoded user input leave through one
//!   [`PtyWriter`], tagged with their [`Origin`]. The host's writer owns the access policy and may
//!   refuse; a refused reply is dropped and counted, never delayed (a stale answer typed into a
//!   shell after unlock would be worse than none).
//! * Lifecycle: a registry keyed by session id with a global scrollback budget; a view attaches
//!   and detaches without touching the transport or the screen.
//!
//! No thread per session: the pool size is fixed at construction and sessions are assigned to the
//! least-loaded worker. A worker serves one bounded slice per turn and requeues a session that
//! still has bytes, so a flood on one session cannot starve the others on its worker. A session
//! with an attached view is the one the user is looking at: it queues ahead of detached ones, and
//! after [`PRIORITY_BURST`] such turns in a row a detached session gets one, so background
//! sessions keep parsing (bounded by their credit window) without ever delaying the visible one by
//! more than the turn in progress.
//!
//! A detached session that has received nothing for [`HubConfig::compress_after`] has its
//! scrollback compacted by its worker, one bounded step at a time and only while no session on that
//! worker has bytes to parse: the memory of a background session falls to a fraction of its budget
//! and comes back, page by page, if the user scrolls into it.
//!
//! [#1315]: https://github.com/mihazs/lazysh/issues/1315
//! [#1316]: https://github.com/mihazs/lazysh/issues/1316
//! [#1319]: https://github.com/mihazs/lazysh/issues/1319

use crate::frame::Frame;
use crate::ingress::{IngressHandle, Offer};
use crate::input::{KeyInput, MouseInput};
use crate::runtime::{Config, Error, TerminalRuntime};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::*};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Smallest scrollback grant; below this a session is refused instead of silently crippled.
const MIN_SCROLLBACK_BYTES: usize = 64 * 1024;

/// Turns an attached session may take in a row while a detached one waits on the same worker.
const PRIORITY_BURST: u32 = 4;

/// Who produced bytes headed to the peer, preserved so the host can apply its access policy
/// (xterm today tags replies `terminal-nonuser`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    User,
    Reply,
}

/// The host's access policy said no (locked, background, lease gone, queue full).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refused;

/// Where bytes for the peer go. Runs on a shared VT worker (replies) or the caller's thread
/// (user input), so it must not block: enqueue or refuse.
pub trait PtyWriter: Send + Sync {
    fn write(&self, origin: Origin, bytes: &[u8]) -> Result<(), Refused>;
}

pub struct Hooks {
    pub writer: Arc<dyn PtyWriter>,
    /// Bytes the VT just finished processing: hand them back to the transport's credit window.
    /// Runs on a VT worker; must not block.
    pub credit: Box<dyn Fn(usize) + Send + Sync>,
    /// The screen may have changed and a view is attached. Coalescing is the receiver's job; must
    /// not block. Never called while detached, so a backgrounded session wakes nothing.
    pub changed: Option<Box<dyn Fn() + Send + Sync>>,
}

#[derive(Debug, Clone, Copy)]
pub struct HubConfig {
    /// VT worker threads; clamped to at least one. Sessions never get a thread of their own.
    pub workers: usize,
    /// Scrollback bytes reserved across all live sessions.
    pub scrollback_budget: usize,
    /// Most scrollback bytes one session may reserve, so a single request cannot take the whole
    /// budget from the others (a request above it is clamped, like one above what is left).
    pub session_scrollback_max: usize,
    /// Bytes one session has parsed per worker turn (whole chunks, so at least one chunk). 16 KiB is
    /// one transport chunk: the slice is also the longest a key press can wait for the session lock
    /// (see the session benchmark).
    pub pump_slice: usize,
    /// How long a detached session must have received nothing before its scrollback is compacted
    /// (`None` never compacts). Compaction is a bounded step on an idle worker, never on a session
    /// that is attached or has bytes waiting.
    pub compress_after: Option<Duration>,
}

impl Default for HubConfig {
    fn default() -> Self {
        // Placeholders, not measurements: sizes follow the benchmarks (#1339, #1338).
        Self {
            workers: 2,
            scrollback_budget: 256 * 1024 * 1024,
            session_scrollback_max: 64 * 1024 * 1024,
            pump_slice: 16 * 1024,
            compress_after: Some(Duration::from_secs(2)),
        }
    }
}

#[derive(Debug)]
pub enum HubError {
    Core(Error),
    Duplicate(String),
    /// Not even the minimum scrollback fits in what the budget has left.
    Budget {
        requested: usize,
        available: usize,
    },
}

impl fmt::Display for HubError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Core(err) => err.fmt(f),
            Self::Duplicate(id) => write!(f, "session {id} already exists"),
            Self::Budget {
                requested,
                available,
            } => write!(
                f,
                "scrollback budget exhausted: {requested} bytes requested, {available} left"
            ),
        }
    }
}

impl std::error::Error for HubError {}

#[derive(Debug)]
pub enum SessionError {
    Core(Error),
    /// The session was closed (or its core failed and was discarded).
    Closed,
    /// The writer refused user input.
    Refused,
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Core(err) => err.fmt(f),
            Self::Closed => f.write_str("terminal session is closed"),
            Self::Refused => f.write_str("terminal input refused by the access policy"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<Error> for SessionError {
    fn from(err: Error) -> Self {
        Self::Core(err)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    /// Bytes the VT has parsed.
    pub processed: u64,
    /// Bytes accepted but not yet parsed (never above the ingress capacity).
    pub queued: usize,
    pub replies_written: u64,
    /// Reply bytes the writer refused (input gated) or the reply cap dropped.
    pub replies_dropped: u64,
    pub input_refused: u64,
    /// Scrollback compaction steps run on this session while it was detached and idle.
    pub compactions: u64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A session whose scrollback may be compacted once `due` has passed, if it saw no bytes since
/// `generation`.
struct Idle {
    due: Instant,
    generation: u64,
    cell: Arc<Cell>,
}

/// A worker's run queue: sessions with an attached view first, the rest behind them.
#[derive(Default)]
struct Queue {
    attached: VecDeque<Arc<Cell>>,
    detached: VecDeque<Arc<Cell>>,
    /// Attached turns taken since a detached one last ran.
    streak: u32,
    /// At most one entry per session.
    idle: Vec<Idle>,
}

impl Queue {
    fn push(&mut self, cell: Arc<Cell>) {
        if cell.attached.load(Acquire) {
            self.attached.push_back(cell);
        } else {
            self.detached.push_back(cell);
        }
    }

    fn pop(&mut self) -> Option<Arc<Cell>> {
        if self.streak < PRIORITY_BURST {
            if let Some(cell) = self.attached.pop_front() {
                self.streak += 1;
                return Some(cell);
            }
        }
        self.streak = 0;
        self.detached
            .pop_front()
            .or_else(|| self.attached.pop_front())
    }

    fn arm(&mut self, idle: Idle) {
        self.idle
            .retain(|other| !Arc::ptr_eq(&other.cell, &idle.cell));
        self.idle.push(idle);
    }

    fn take_due(&mut self, now: Instant) -> Option<Idle> {
        let index = self.idle.iter().position(|idle| idle.due <= now)?;
        Some(self.idle.swap_remove(index))
    }

    fn next_due(&self) -> Option<Instant> {
        self.idle.iter().map(|idle| idle.due).min()
    }
}

struct Worker {
    queue: Mutex<Queue>,
    wake: Condvar,
    sessions: AtomicUsize,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<Cell>>,
    reserved: usize,
}

struct HubShared {
    config: HubConfig,
    registry: Mutex<Registry>,
    workers: Vec<Worker>,
    shutdown: AtomicBool,
}

struct Cell {
    id: String,
    worker: usize,
    /// `None` once closed or failed: the VT state is freed at that moment, not at some later drop.
    runtime: Mutex<Option<TerminalRuntime>>,
    /// The producer side of the runtime's byte queue: feeding never waits for a worker's slice.
    ingress: IngressHandle,
    /// In a worker queue or being processed. Set by the producer, cleared by the worker under the
    /// runtime lock when nothing is queued, then re-checked, so a wakeup can never be lost.
    scheduled: AtomicBool,
    attached: AtomicBool,
    released: AtomicBool,
    hooks: Hooks,
    reserved: usize,
    shared: Weak<HubShared>,
    replies_written: AtomicU64,
    replies_dropped: AtomicU64,
    input_refused: AtomicU64,
    /// Typing or pasting returns a scrolled-back viewport to the live screen (xterm's `scrollOnUserInput`).
    scroll_on_user_input: AtomicBool,
    /// Turns that parsed bytes so far: a compaction armed for an older count is stale.
    generation: AtomicU64,
    compactions: AtomicU64,
}

impl Cell {
    fn schedule(self: &Arc<Self>) {
        if !self.scheduled.swap(true, AcqRel) {
            self.enqueue();
        }
    }

    fn enqueue(self: &Arc<Self>) {
        if let Some(shared) = self.shared.upgrade() {
            let worker = &shared.workers[self.worker];
            lock(&worker.queue).push(Arc::clone(self));
            worker.wake.notify_one();
        }
    }

    /// One bounded unit of work for the worker that owns this session.
    fn turn(self: &Arc<Self>, slice: usize) {
        let mut guard = lock(&self.runtime);
        let Some(runtime) = guard.as_mut() else {
            self.scheduled.store(false, Release);
            return;
        };
        let bytes = runtime.pump(slice);
        let (replies, dropped) = runtime.take_replies();
        let more = self.ingress.queued() > 0;
        if bytes > 0 {
            self.generation.fetch_add(1, AcqRel);
        }
        if !more {
            self.scheduled.store(false, Release);
        }
        drop(guard);
        if bytes > 0 {
            (self.hooks.credit)(bytes);
            if self.attached.load(Acquire) {
                if let Some(changed) = &self.hooks.changed {
                    changed();
                }
            }
        }
        self.replies_dropped.fetch_add(dropped, Relaxed);
        if !replies.is_empty() {
            match self.hooks.writer.write(Origin::Reply, &replies) {
                Ok(()) => self
                    .replies_written
                    .fetch_add(replies.len() as u64, Relaxed),
                Err(Refused) => self
                    .replies_dropped
                    .fetch_add(replies.len() as u64, Relaxed),
            };
        }
        if more {
            self.enqueue();
        } else if self.ingress.queued() > 0 {
            // A producer that offered after the check above saw `scheduled` still set and queued
            // nothing; its offer is ordered after the clear by the ingress lock, so look again.
            self.schedule();
        } else {
            self.compact_when_idle();
        }
    }

    /// Arm a compaction `compress_after` from now for a session nobody is looking at.
    fn compact_when_idle(self: &Arc<Self>) {
        let after = self
            .shared
            .upgrade()
            .and_then(|shared| shared.config.compress_after);
        if let Some(after) = after {
            if !self.attached.load(Acquire) {
                self.arm_compaction(Instant::now() + after);
            }
        }
    }

    fn arm_compaction(self: &Arc<Self>, due: Instant) {
        if self.released.load(Acquire) {
            return;
        }
        if let Some(shared) = self.shared.upgrade() {
            let worker = &shared.workers[self.worker];
            lock(&worker.queue).arm(Idle {
                due,
                generation: self.generation.load(Acquire),
                cell: Arc::clone(self),
            });
            worker.wake.notify_one();
        }
    }

    /// A closed session has nothing to compact: do not keep its cell alive until the timer.
    fn disarm_compaction(&self) {
        if let Some(shared) = self.shared.upgrade() {
            lock(&shared.workers[self.worker].queue)
                .idle
                .retain(|idle| !std::ptr::eq(Arc::as_ptr(&idle.cell), self));
        }
    }

    /// One bounded compaction step if nothing happened to the session since it was armed; re-armed
    /// at once while the VT reports more work, so other sessions' turns always run in between.
    fn compact(self: &Arc<Self>, generation: u64) {
        if self.attached.load(Acquire)
            || self.scheduled.load(Acquire)
            || self.generation.load(Acquire) != generation
        {
            return; // whoever attaches, feeds or detaches arms it again
        }
        let more = lock(&self.runtime)
            .as_mut()
            .is_some_and(|runtime| runtime.compress_scrollback().unwrap_or(false));
        self.compactions.fetch_add(1, Relaxed);
        if more {
            self.arm_compaction(Instant::now());
        }
    }

    /// Close or fail the session: leave the registry, free the VT state now and give the credit
    /// of everything still queued back to the transport so its producer cannot stay blocked.
    fn discard(&self) {
        self.disarm_compaction();
        self.release();
        drop(lock(&self.runtime).take());
        let queued = self.ingress.clear();
        if queued > 0 {
            (self.hooks.credit)(queued);
        }
    }

    /// Leave the registry and give the budget back, exactly once.
    fn release(&self) {
        if self.released.swap(true, AcqRel) {
            return;
        }
        if let Some(shared) = self.shared.upgrade() {
            let mut registry = lock(&shared.registry);
            if registry
                .sessions
                .get(&self.id)
                .is_some_and(|cell| std::ptr::eq(Arc::as_ptr(cell), self))
            {
                registry.sessions.remove(&self.id);
            }
            registry.reserved -= self.reserved;
            shared.workers[self.worker].sessions.fetch_sub(1, Relaxed);
        }
    }
}

pub struct Hub {
    shared: Arc<HubShared>,
    threads: Vec<JoinHandle<()>>,
}

impl Hub {
    pub fn new(config: HubConfig) -> Self {
        let workers = config.workers.max(1);
        let shared = Arc::new(HubShared {
            config: HubConfig { workers, ..config },
            registry: Mutex::default(),
            workers: (0..workers)
                .map(|_| Worker {
                    queue: Mutex::default(),
                    wake: Condvar::new(),
                    sessions: AtomicUsize::new(0),
                })
                .collect(),
            shutdown: AtomicBool::new(false),
        });
        let threads = (0..workers)
            .map(|index| {
                let shared = Arc::clone(&shared);
                std::thread::Builder::new()
                    .name(format!("lazysh-vt-{index}"))
                    .spawn(move || run(&shared, index))
                    .expect("spawn VT worker")
            })
            .collect();
        Self { shared, threads }
    }

    /// Register a session. Its scrollback is the request clamped to what the global budget has
    /// left ([`Session::scrollback_granted`]); the call fails only when not even the minimum fits.
    pub fn create(
        &self,
        id: impl Into<String>,
        mut config: Config,
        hooks: Hooks,
    ) -> Result<Session, HubError> {
        let id = id.into();
        let mut registry = lock(&self.shared.registry);
        if registry.sessions.contains_key(&id) {
            return Err(HubError::Duplicate(id));
        }
        let available = self
            .shared
            .config
            .scrollback_budget
            .saturating_sub(registry.reserved);
        let requested = config
            .scrollback_bytes
            .min(self.shared.config.session_scrollback_max);
        let granted = requested.min(available);
        if granted < requested.min(MIN_SCROLLBACK_BYTES) {
            return Err(HubError::Budget {
                requested,
                available,
            });
        }
        config.scrollback_bytes = granted;
        let runtime = TerminalRuntime::new(config).map_err(HubError::Core)?;
        let ingress = runtime.ingress().clone();
        let worker = (0..self.shared.workers.len())
            .min_by_key(|&index| self.shared.workers[index].sessions.load(Relaxed))
            .expect("at least one worker");
        self.shared.workers[worker].sessions.fetch_add(1, Relaxed);
        registry.reserved += granted;
        let cell = Arc::new(Cell {
            id: id.clone(),
            worker,
            runtime: Mutex::new(Some(runtime)),
            ingress,
            scheduled: AtomicBool::new(false),
            attached: AtomicBool::new(false),
            released: AtomicBool::new(false),
            hooks,
            reserved: granted,
            shared: Arc::downgrade(&self.shared),
            replies_written: AtomicU64::new(0),
            replies_dropped: AtomicU64::new(0),
            input_refused: AtomicU64::new(0),
            scroll_on_user_input: AtomicBool::new(true),
            generation: AtomicU64::new(0),
            compactions: AtomicU64::new(0),
        });
        registry.sessions.insert(id, Arc::clone(&cell));
        Ok(Session { cell })
    }

    pub fn get(&self, id: &str) -> Option<Session> {
        lock(&self.shared.registry)
            .sessions
            .get(id)
            .map(|cell| Session {
                cell: Arc::clone(cell),
            })
    }

    pub fn live(&self) -> usize {
        lock(&self.shared.registry).sessions.len()
    }

    /// Scrollback bytes currently granted to live sessions.
    pub fn scrollback_reserved(&self) -> usize {
        lock(&self.shared.registry).reserved
    }

    pub fn workers(&self) -> usize {
        self.shared.workers.len()
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        let sessions: Vec<_> = lock(&self.shared.registry)
            .sessions
            .values()
            .cloned()
            .collect();
        for cell in sessions {
            Session { cell }.close();
        }
        self.shared.shutdown.store(true, Release);
        for worker in &self.shared.workers {
            // Taking the queue lock orders the flag before a worker's re-check, so no wakeup is lost.
            drop(lock(&worker.queue));
            worker.wake.notify_all();
        }
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

enum Job {
    Turn(Arc<Cell>),
    Compact(Idle),
}

fn run(shared: &HubShared, index: usize) {
    let worker = &shared.workers[index];
    loop {
        let job = {
            let mut queue = lock(&worker.queue);
            loop {
                if let Some(cell) = queue.pop() {
                    break Job::Turn(cell);
                }
                if shared.shutdown.load(Acquire) {
                    return;
                }
                let now = Instant::now();
                if let Some(idle) = queue.take_due(now) {
                    break Job::Compact(idle);
                }
                queue = match queue.next_due() {
                    Some(due) => {
                        let wait = worker.wake.wait_timeout(queue, due - now);
                        wait.unwrap_or_else(PoisonError::into_inner).0
                    }
                    None => worker
                        .wake
                        .wait(queue)
                        .unwrap_or_else(PoisonError::into_inner),
                };
            }
        };
        // A panic in the VT binding or a host hook costs that session, never the worker's others.
        // Only with panic=unwind: the app's release profile sets panic=abort, where any panic ends
        // the process, so this protects tests and unwinding builds, not shipped binaries.
        let (cell, outcome) = match job {
            Job::Turn(cell) => {
                let slice = shared.config.pump_slice;
                let outcome = catch_unwind(AssertUnwindSafe(|| cell.turn(slice)));
                (cell, outcome)
            }
            Job::Compact(Idle {
                cell, generation, ..
            }) => {
                let outcome = catch_unwind(AssertUnwindSafe(|| cell.compact(generation)));
                (cell, outcome)
            }
        };
        if outcome.is_err() {
            cell.discard();
        }
    }
}

/// A handle to one session. Cheap to clone; the hub's registry owns the session until
/// [`Session::close`], so dropping handles never ends it.
#[derive(Clone)]
pub struct Session {
    cell: Arc<Cell>,
}

impl Session {
    pub fn id(&self) -> &str {
        &self.cell.id
    }

    pub fn scrollback_granted(&self) -> usize {
        self.cell.reserved
    }

    /// Run `f` on the VT state (size, modes, events, text, scrolling, selection...). It holds the
    /// session lock, which a worker needs for its next slice, so keep it short.
    pub fn with<R>(&self, f: impl FnOnce(&mut TerminalRuntime) -> R) -> Result<R, SessionError> {
        lock(&self.cell.runtime)
            .as_mut()
            .map(f)
            .ok_or(SessionError::Closed)
    }

    /// Transport entry point. Queues the chunk for the VT worker and returns without parsing; a
    /// chunk over budget comes back intact (`Offer::Full`), so a transport that honours its credit
    /// window never sees it.
    pub fn feed(&self, chunk: Vec<u8>) -> Result<Offer, SessionError> {
        if self.cell.released.load(Acquire) {
            return Err(SessionError::Closed);
        }
        let offer = self.cell.ingress.offer(chunk);
        if offer == Offer::Accepted {
            if self.cell.released.load(Acquire) {
                // Closed while this chunk was being queued: nobody will parse it.
                self.cell.discard();
                return Err(SessionError::Closed);
            }
            self.cell.schedule();
        }
        Ok(offer)
    }

    pub fn stats(&self) -> Result<Stats, SessionError> {
        let (processed, queued) =
            self.with(|runtime| (runtime.processed_bytes(), runtime.ingress().queued()))?;
        Ok(Stats {
            processed,
            queued,
            replies_written: self.cell.replies_written.load(Relaxed),
            replies_dropped: self.cell.replies_dropped.load(Relaxed),
            input_refused: self.cell.input_refused.load(Relaxed),
            compactions: self.cell.compactions.load(Relaxed),
        })
    }

    /// A view appeared (or was recreated): the full screen to draw first, then
    /// [`Hooks::changed`] fires as output arrives. The session and transport are untouched. While
    /// attached, the session is served ahead of detached ones on its worker.
    pub fn attach(&self) -> Result<Frame, SessionError> {
        let frame = self.with(|runtime| runtime.snapshot())??;
        self.cell.attached.store(true, Release);
        Ok(frame)
    }

    pub fn detach(&self) {
        self.cell.attached.store(false, Release);
        self.cell.compact_when_idle();
    }

    pub fn take_frame(&self) -> Result<Option<Frame>, SessionError> {
        Ok(self.with(|runtime| runtime.take_frame())??)
    }

    /// Whether typing or pasting returns a viewport scrolled into history to the live screen
    /// (default true, like xterm.js's `scrollOnUserInput`). Mouse and focus reports never do.
    pub fn set_scroll_on_user_input(&self, enabled: bool) {
        self.cell.scroll_on_user_input.store(enabled, Relaxed);
    }

    pub fn send_key(&self, input: &KeyInput) -> Result<usize, SessionError> {
        self.send_typed(|runtime| runtime.encode_key(input))
    }

    pub fn send_mouse(&self, input: MouseInput) -> Result<usize, SessionError> {
        self.send(|runtime| runtime.encode_mouse(input))
    }

    /// Bracketed only when the program enabled it; pasted text can never close its own bracket.
    pub fn send_paste(&self, text: &str) -> Result<usize, SessionError> {
        self.send_typed(|runtime| runtime.encode_paste(text))
    }

    /// Focus in/out report, sent only while the program enabled focus events (mode 1004).
    pub fn send_focus(&self, focused: bool) -> Result<usize, SessionError> {
        self.send(|runtime| runtime.encode_focus(focused))
    }

    /// Input the user typed: once the writer accepted it, the viewport follows the live screen again, so
    /// a reply to the very key that was pressed is never left out of view (#1043). A refusal (input
    /// gated) leaves the viewport where the reader put it. A moved viewport wakes an attached view.
    fn send_typed(
        &self,
        encode: impl FnOnce(&mut TerminalRuntime) -> Result<Vec<u8>, Error>,
    ) -> Result<usize, SessionError> {
        let sent = self.send(encode)?;
        if sent > 0 && self.cell.scroll_on_user_input.load(Relaxed) {
            // A close racing this call already freed the state; the bytes are out, nothing to scroll.
            let moved = self
                .with(TerminalRuntime::scroll_to_bottom)
                .unwrap_or(false);
            if moved && self.cell.attached.load(Acquire) {
                if let Some(changed) = &self.cell.hooks.changed {
                    changed();
                }
            }
        }
        Ok(sent)
    }

    /// Encode under the session lock, write outside it. Nothing to send is `Ok(0)`.
    fn send(
        &self,
        encode: impl FnOnce(&mut TerminalRuntime) -> Result<Vec<u8>, Error>,
    ) -> Result<usize, SessionError> {
        let bytes = self.with(encode)??;
        if bytes.is_empty() {
            return Ok(0);
        }
        self.cell
            .hooks
            .writer
            .write(Origin::User, &bytes)
            .map_err(|Refused| {
                self.cell.input_refused.fetch_add(1, Relaxed);
                SessionError::Refused
            })?;
        Ok(bytes.len())
    }

    /// Dispose: leave the registry, return the scrollback budget and free the VT state now.
    /// Idempotent; later calls on any handle report [`SessionError::Closed`].
    pub fn close(&self) {
        self.cell.discard();
    }
}
