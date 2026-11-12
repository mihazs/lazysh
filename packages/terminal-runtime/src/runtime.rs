use crate::frame::{Frame, Renderer};
use crate::ingress::{Ingress, Offer};
use crate::input::{self, Encoders, KeyInput, MouseInput};
use crate::size::{Size, SizeAuthority, SizeOutcome};
use ghostty_vt::{ActiveScreen, Terminal};
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

/// Terminal-generated replies (DSR, DA, ...) waiting for the transport. A peer can spam queries,
/// so the queue is capped; overflow is counted, not silent.
const MAX_REPLY_BYTES: usize = 64 * 1024;
/// Pending OSC 52 writes and directory changes the host has not taken yet. The binding bounds one
/// payload (192 KiB) but not how many queue up, so an ignored session cannot grow without limit.
const MAX_PENDING_EVENTS: usize = 8;
const DEFAULT_SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;
/// Matches the current transport credit window (OUTPUT_WINDOW/WINDOW in the Rust workers).
const DEFAULT_INGRESS_BYTES: usize = 256 * 1024;

#[derive(Debug)]
pub enum Error {
    Vt(ghostty_vt::Error),
    InvalidSize(Size),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Vt(err) => write!(f, "libghostty-vt: {err}"),
            Self::InvalidSize(size) => {
                write!(f, "invalid terminal size {}x{}", size.cols, size.rows)
            }
        }
    }
}

impl std::error::Error for Error {}

impl From<ghostty_vt::Error> for Error {
    fn from(err: ghostty_vt::Error) -> Self {
        Self::Vt(err)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Config {
    pub size: Size,
    /// libghostty-vt budgets scrollback in bytes, not lines (lazysh's setting is lines).
    pub scrollback_bytes: usize,
    pub ingress_bytes: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            size: Size::new(80, 24),
            scrollback_bytes: DEFAULT_SCROLLBACK_BYTES,
            ingress_bytes: DEFAULT_INGRESS_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Modes {
    pub bracketed_paste: bool,
    pub mouse_tracking: bool,
    pub alternate_screen: bool,
    pub application_cursor_keys: bool,
    pub focus_events: bool,
}

/// Side effects the VT raised while processing, for the host to act on (consent stays in the UI).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Events {
    pub bell: u16,
    /// Raw OSC 52 payloads (each bounded by the binding); at most 8 wait, the newer ones are dropped.
    pub clipboard_writes: Vec<Vec<u8>>,
    /// OSC 7 directory changes, oldest first; at most 8 wait, the oldest are dropped.
    pub pwd_changes: Vec<Vec<u8>>,
    /// Clipboard writes and directory changes refused because the host had not taken earlier ones.
    pub dropped: u64,
}

#[derive(Default)]
struct Replies {
    bytes: Vec<u8>,
    dropped: u64,
}

pub struct TerminalRuntime {
    terminal: Terminal,
    renderer: Renderer,
    encoders: Encoders,
    ingress: Ingress,
    replies: Arc<Mutex<Replies>>,
    events: Events,
    size: Size,
    authority: SizeAuthority,
    intent: Option<Size>,
    processed: u64,
}

impl TerminalRuntime {
    pub fn new(config: Config) -> Result<Self, Error> {
        let size = config.size.validate()?;
        let mut terminal = Terminal::new(size.cols, size.rows, config.scrollback_bytes)?;
        terminal.resize(
            size.cols,
            size.rows,
            size.cell_width_px,
            size.cell_height_px,
        )?;
        let replies = Arc::new(Mutex::new(Replies::default()));
        let sink = Arc::clone(&replies);
        terminal.set_write_pty_callback(move |bytes| {
            let mut replies = sink.lock().unwrap_or_else(PoisonError::into_inner);
            if replies.bytes.len() + bytes.len() > MAX_REPLY_BYTES {
                replies.dropped += bytes.len() as u64;
            } else {
                replies.bytes.extend_from_slice(bytes);
            }
        })?;
        Ok(Self {
            terminal,
            renderer: Renderer::new()?,
            encoders: Encoders::new()?,
            ingress: Ingress::new(config.ingress_bytes),
            replies,
            events: Events::default(),
            size,
            authority: SizeAuthority::Local,
            intent: None,
            processed: 0,
        })
    }

    /// Queue transport bytes. Rejected chunks come back untouched; nothing is dropped or reordered.
    pub fn offer(&mut self, chunk: Vec<u8>) -> Offer {
        self.ingress.offer(chunk)
    }

    pub fn ingress(&self) -> &Ingress {
        &self.ingress
    }

    /// Run queued chunks through the VT: whole chunks in order until `budget` bytes were taken
    /// (a zero budget takes nothing). Returns the bytes processed: the credit to hand back to the
    /// transport (ack after processing).
    pub fn pump(&mut self, budget: usize) -> usize {
        let mut bytes = 0;
        for chunk in self.ingress.take(budget) {
            self.terminal.write(&chunk);
            self.collect_events();
            bytes += chunk.len();
        }
        self.processed += bytes as u64;
        bytes
    }

    /// Move what the VT queued into the bounded host-facing queue; runs after every chunk, so the
    /// binding's own queues never hold more than one chunk's worth.
    fn collect_events(&mut self) {
        let events = &mut self.events;
        events.bell = events.bell.saturating_add(self.terminal.take_bell_count());
        for payload in self.terminal.take_clipboard_writes() {
            if events.clipboard_writes.len() < MAX_PENDING_EVENTS {
                events.clipboard_writes.push(payload);
            } else {
                events.dropped += 1;
            }
        }
        for dir in self.terminal.take_pwd_changes() {
            if events.pwd_changes.len() >= MAX_PENDING_EVENTS {
                events.pwd_changes.remove(0);
                events.dropped += 1;
            }
            events.pwd_changes.push(dir);
        }
    }

    pub fn processed_bytes(&self) -> u64 {
        self.processed
    }

    /// The UI asks for a size (viewport change). Applied only when the runtime owns the size.
    pub fn request_size(&mut self, size: Size) -> Result<SizeOutcome, Error> {
        let size = size.validate()?;
        self.intent = Some(size);
        match self.authority {
            SizeAuthority::Local => self.apply(size).map(|()| SizeOutcome::Applied),
            SizeAuthority::Transport => Ok(SizeOutcome::Deferred(size)),
        }
    }

    /// The transport states the real grid size (Mosh framebuffer). Always applied; from now on UI
    /// requests are deferred until [`Self::release_transport_authority`].
    pub fn apply_transport_size(&mut self, size: Size) -> Result<(), Error> {
        let size = size.validate()?;
        self.apply(size)?;
        self.authority = SizeAuthority::Transport;
        Ok(())
    }

    /// Back to a local size owner (for example reconnecting over plain SSH): the last UI request
    /// is applied.
    pub fn release_transport_authority(&mut self) -> Result<(), Error> {
        self.authority = SizeAuthority::Local;
        match self.intent {
            Some(size) if size != self.size => self.apply(size),
            _ => Ok(()),
        }
    }

    fn apply(&mut self, size: Size) -> Result<(), Error> {
        self.terminal.resize(
            size.cols,
            size.rows,
            size.cell_width_px,
            size.cell_height_px,
        )?;
        self.size = size;
        Ok(())
    }

    pub fn size(&self) -> Size {
        self.size
    }

    pub fn authority(&self) -> SizeAuthority {
        self.authority
    }

    /// Latest UI-requested size, whether or not it was applied.
    pub fn size_intent(&self) -> Option<Size> {
        self.intent
    }

    /// Changed rows since the last call; `None` when the screen is unchanged (renderer stays idle).
    pub fn take_frame(&mut self) -> Result<Option<Frame>, Error> {
        self.renderer.frame(&self.terminal, false)
    }

    /// Every row, for a new or recreated renderer surface. Also resets dirty tracking.
    pub fn snapshot(&mut self) -> Result<Frame, Error> {
        Ok(self
            .renderer
            .frame(&self.terminal, true)?
            .expect("forced frame is always produced"))
    }

    /// Bytes the terminal wants written back to the peer, in order, and the count dropped to the cap.
    pub fn take_replies(&mut self) -> (Vec<u8>, u64) {
        let mut replies = self.replies.lock().unwrap_or_else(PoisonError::into_inner);
        (
            std::mem::take(&mut replies.bytes),
            std::mem::take(&mut replies.dropped),
        )
    }

    pub fn take_events(&mut self) -> Events {
        std::mem::take(&mut self.events)
    }

    pub fn modes(&self) -> Result<Modes, Error> {
        Ok(Modes {
            bracketed_paste: self.terminal.mode_get(ghostty_vt::MODE_BRACKETED_PASTE)?,
            mouse_tracking: self.terminal.mouse_tracking_enabled()?,
            alternate_screen: self.terminal.active_screen()? == ActiveScreen::Alternate,
            application_cursor_keys: self
                .terminal
                .mode_get(ghostty_vt::MODE_APPLICATION_CURSOR_KEYS)?,
            focus_events: self.terminal.mode_get(ghostty_vt::MODE_FOCUS_EVENT)?,
        })
    }

    pub fn encode_key(&mut self, input: &KeyInput) -> Result<Vec<u8>, Error> {
        self.encoders.key(&self.terminal, input)
    }

    pub fn encode_mouse(&mut self, input: MouseInput) -> Result<Vec<u8>, Error> {
        let Size {
            cols,
            rows,
            cell_width_px,
            cell_height_px,
        } = self.size;
        let surface = (
            u32::from(cols) * cell_width_px,
            u32::from(rows) * cell_height_px,
        );
        self.encoders.mouse(
            &self.terminal,
            surface,
            (cell_width_px, cell_height_px),
            input,
        )
    }

    pub fn encode_paste(&self, text: &str) -> Result<Vec<u8>, Error> {
        Ok(input::paste(text, self.modes()?.bracketed_paste))
    }

    /// Plain text of the visible rows, for screen inspection (Herdr navigation, search, checks).
    pub fn viewport_text(&self) -> Result<String, Error> {
        let end = (self.size.cols - 1, u32::from(self.size.rows) - 1);
        Ok(self.terminal.read_text_viewport((0, 0), end, false)?)
    }

    /// Plain text of scrollback plus screen.
    pub fn screen_text(&self) -> Result<String, Error> {
        let last = self.terminal.total_rows()?.saturating_sub(1) as u32;
        Ok(self
            .terminal
            .read_text_screen((0, 0), (self.size.cols - 1, last), false)?)
    }

    pub fn scrollback_rows(&self) -> Result<usize, Error> {
        Ok(self.terminal.scrollback_rows()?)
    }

    pub fn scroll_viewport(&mut self, delta: isize) {
        self.terminal.scroll_viewport_delta(delta);
    }

    pub fn scroll_to_bottom(&mut self) {
        self.terminal.scroll_viewport_bottom();
    }
}
