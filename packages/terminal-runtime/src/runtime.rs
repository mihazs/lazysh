use crate::colors::ColorQueries;
use crate::cursor::CursorChoice;
use crate::frame::{CursorDefault, Frame, Renderer};
use crate::ingress::{IngressHandle, Offer};
use crate::input::{self, Encoders, KeyInput, MouseInput};
use crate::mosh::{self, Action, Display, DisplayFailure};
use crate::render::Theme;
use crate::size::{Size, SizeAuthority, SizeOutcome};
use crate::titles::Titles;
use ghostty_vt::{ActiveScreen, CellWide, Terminal, TerminalCompressionResult};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::ops::Range;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

mod control;
pub use control::{
    control_window, ControlAnswer, ControlCursor, ControlEvent, ControlModes, ControlQuery,
    ControlSnapshot, ControlState, MouseTracking, RowWindow, ScrollAction, CONTROL_WINDOW_DEFAULT,
    CONTROL_WINDOW_MAX,
};

/// Terminal-generated replies (DSR, DA, ...) waiting for the transport. A peer can spam queries,
/// so the queue is capped; overflow is counted, not silent.
const MAX_REPLY_BYTES: usize = 64 * 1024;
/// Pending OSC 52 writes and directory changes the host has not taken yet. The binding bounds one
/// payload (192 KiB) but not how many queue up, so an ignored session cannot grow without limit.
const MAX_PENDING_EVENTS: usize = 8;
/// How a new grid size is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Resize {
    /// libghostty-vt's own: reflowing and bottom-anchored.
    Plain,
    /// Mosh's: top-anchored, no reflow, nothing pushed into scrollback. Only at a sequence boundary.
    Canonical,
}

/// DEC private modes 6 (origin) and 7 (wraparound); libghostty-vt reflows only while 7 is set.
const MODE_ORIGIN: u16 = 6;
const MODE_WRAPAROUND: u16 = 7;
/// What JavaScript's `String.prototype.trimEnd` strips (the xterm backend's `readRows` uses it):
/// Rust's `White_Space` plus U+FEFF, minus U+0085.
pub(crate) fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// How the right edge of a row's text is trimmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trim {
    /// Every trailing Unicode space, as JavaScript's `trimEnd` (the adapter's `readRows`).
    Spaces,
    /// Only cells nothing was written to; written spaces stay (xterm's `translateToString(true)`,
    /// which selection and search read).
    EmptyCells,
}

/// Most rows one [`TerminalRuntime::read_rows`] call returns, so a text query over the bridge stays bounded.
pub const MAX_READ_ROWS: usize = 4096;
const DEFAULT_SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;
/// A scrollback cell costs 8 bytes in libghostty-vt plus page overhead: 8.9 to 9.2 bytes per cell
/// measured at 20 to 279 columns, the same for plain, SGR-coloured and syntax-highlighted output
/// (`examples/scrollback_budget.rs`). 10 leaves margin; see [`scrollback_bytes_for_lines`].
const SCROLLBACK_BYTES_PER_CELL: usize = 10;
/// libghostty-vt frees whole pages (about half a MiB each), so a budget of a few pages keeps up to
/// a page and a half fewer rows than its byte size suggests; two pages of slack make up for it.
const SCROLLBACK_PAGE_SLACK_BYTES: usize = 1024 * 1024;
/// Narrower terminals are budgeted as this wide, so a phone that opens in portrait still keeps its
/// history after the grid widens.
const SCROLLBACK_REFERENCE_COLS: usize = 80;
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

/// The scrollback byte budget that keeps at least `lines` rows of ordinary output (plain text,
/// SGR colours, syntax highlighting) for a terminal `cols` wide: lazysh's History lines setting counts
/// lines, libghostty-vt budgets bytes, and the rows one byte budget holds depend on the width.
///
/// The width is the one at open and is not revisited: output written after a later widening takes
/// more bytes per row and keeps fewer rows, and content that defeats cell sharing (a different
/// truecolor foreground and background on every cell: 5.5 times the plain cost at 80 columns) or
/// leans on graphemes and hyperlinks keeps fewer rows too. The hub clamps the request to its
/// per-session cap and remaining global budget, so either can reduce the granted history.
pub fn scrollback_bytes_for_lines(lines: usize, cols: u16) -> usize {
    lines
        .saturating_mul(usize::from(cols).max(SCROLLBACK_REFERENCE_COLS))
        .saturating_mul(SCROLLBACK_BYTES_PER_CELL)
        .saturating_add(SCROLLBACK_PAGE_SLACK_BYTES)
}

#[derive(Debug, Clone, Copy)]
pub struct Config {
    pub size: Size,
    /// libghostty-vt budgets scrollback in bytes, not lines (lazysh's setting is lines).
    pub scrollback_bytes: usize,
    pub ingress_bytes: usize,
    /// The transport is Mosh: its OSC 7777 envelopes carry the authoritative grid size (see
    /// [`crate::mosh`]) and UI sizes are only intent from the first byte, as with the xterm
    /// backend's `enableCanonicalResize`.
    pub canonical_frames: bool,
    /// The colours the terminal reports to programs that ask: the default foreground, background and
    /// cursor (`OSC 10`, `11`, `12`) and the 256-colour palette (`OSC 4`). Pass the theme the
    /// renderer draws with, so a program that probes it to pick a light or dark scheme sees what is
    /// on screen. The theme the session opens with; [`TerminalRuntime::set_theme`] changes it later.
    pub theme: Theme,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            size: Size::new(80, 24),
            scrollback_bytes: DEFAULT_SCROLLBACK_BYTES,
            ingress_bytes: DEFAULT_INGRESS_BYTES,
            canonical_frames: false,
            theme: Theme::default(),
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
    /// The latest `OSC 0` or `OSC 2` title; an earlier one nobody took is replaced.
    pub title: Option<String>,
    /// Clipboard writes and directory changes refused because the host had not taken earlier ones.
    pub dropped: u64,
    /// The latest grid size the runtime applied since the last take (local or transport).
    pub geometry: Option<Geometry>,
    /// Set once, when the Mosh display fails; the session cannot recover (see [`DisplayFailure`]).
    pub display_failure: Option<DisplayFailure>,
}

/// A grid size change and who decided it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub size: Size,
    pub authority: SizeAuthority,
}

/// Where the visible rows sit in the buffer, in absolute rows (the adapter's `TerminalViewport`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Viewport {
    /// The first visible absolute row.
    pub top: usize,
    pub rows: usize,
    /// Rows held: scrollback plus the screen.
    pub length: usize,
    /// The view shows live output (it is not scrolled into history).
    pub following: bool,
}

#[derive(Default)]
struct Replies {
    bytes: Vec<u8>,
    dropped: u64,
}

impl Replies {
    fn push(&mut self, bytes: &[u8]) {
        if self.bytes.len() + bytes.len() > MAX_REPLY_BYTES {
            self.dropped += bytes.len() as u64;
        } else {
            self.bytes.extend_from_slice(bytes);
        }
    }

    /// Bytes queued or dropped so far: it moves whenever the VT answers something.
    fn seen(&self) -> u64 {
        self.bytes.len() as u64 + self.dropped
    }
}

pub struct TerminalRuntime {
    terminal: Terminal,
    renderer: Renderer,
    encoders: Encoders,
    ingress: IngressHandle,
    replies: Arc<Mutex<Replies>>,
    colors: ColorQueries,
    cursor: CursorChoice,
    titles: Titles,
    events: Events,
    size: Size,
    authority: SizeAuthority,
    intent: Option<Size>,
    display: Option<Display>,
    /// The Mosh display failure was handed to a control reader ([`TerminalRuntime::take_control_events`]).
    failure_told: bool,
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
            sink.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(bytes);
        })?;
        terminal.set_default_palette(&config.theme.palette)?;
        Ok(Self {
            terminal,
            renderer: Renderer::new()?,
            encoders: Encoders::new()?,
            ingress: IngressHandle::new(config.ingress_bytes),
            replies,
            colors: ColorQueries::new(&config.theme),
            cursor: CursorChoice::new(),
            titles: Titles::default(),
            events: Events::default(),
            size,
            authority: if config.canonical_frames {
                SizeAuthority::Transport
            } else {
                SizeAuthority::Local
            },
            intent: None,
            display: config.canonical_frames.then(Display::new),
            failure_told: false,
            processed: 0,
        })
    }

    /// Report `theme`'s colours to the queries that arrive from now on, for a user who changed the app's theme while the
    /// session runs (see [`Config::theme`]). A reply already queued keeps the colour it was made with. A palette colour a
    /// program set itself (`OSC 4`) stays; the others follow the new palette.
    pub fn set_theme(&mut self, theme: &Theme) -> Result<(), Error> {
        self.terminal.set_default_palette(&theme.palette)?;
        self.colors.set(theme);
        Ok(())
    }

    /// The cursor the frames show for a program that never chose one (`DECSCUSR` 1 to 6) or gave it back (0), as a
    /// host's preferences name it; `None`, the start, leaves what the VT draws. A program's own choice is kept, which
    /// the VT alone cannot tell from the default (the `cursor` module reads the bytes for it). Take a [`TerminalRuntime::snapshot`] for it to
    /// reach a renderer that already holds the screen.
    pub fn set_cursor_default(&mut self, default: Option<CursorDefault>) {
        self.renderer.set_cursor_default(default);
    }

    /// Queue transport bytes. Rejected chunks come back untouched; nothing is dropped or reordered.
    pub fn offer(&mut self, chunk: Vec<u8>) -> Offer {
        self.ingress.offer(chunk)
    }

    /// The producer side of the byte queue, cloneable so a transport can offer without borrowing
    /// the runtime while a worker parses.
    pub fn ingress(&self) -> &IngressHandle {
        &self.ingress
    }

    /// Run queued chunks through the VT: whole chunks in order until `budget` bytes were taken
    /// (a zero budget takes nothing). Returns the bytes processed: the credit to hand back to the
    /// transport (ack after processing).
    pub fn pump(&mut self, budget: usize) -> usize {
        let mut bytes = 0;
        for chunk in self.ingress.take(budget) {
            self.write_chunk(&chunk);
            self.collect_events();
            bytes += chunk.len();
        }
        self.processed += bytes as u64;
        bytes
    }

    fn replies(&self) -> MutexGuard<'_, Replies> {
        self.replies.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Feed one chunk to the VT. A default colour query (see [`crate::colors`]) is answered from
    /// the theme right after the byte the VT dispatches it on, behind the replies to the bytes
    /// before it, unless the VT answered it itself.
    fn write_chunk(&mut self, chunk: &[u8]) {
        if let Some(title) = self.titles.scan(chunk) {
            self.events.title = Some(title);
        }
        self.cursor.scan(chunk);
        self.renderer.set_cursor_chosen(self.cursor.chosen());
        let mut at = 0;
        while let Some((end, reply)) = self.colors.find(chunk, at) {
            self.write_segment(&chunk[at..end - 1]);
            let before = self.replies().seen();
            self.write_segment(&chunk[end - 1..end]);
            if self.replies().seen() == before {
                self.replies().push(reply.as_bytes());
            }
            at = end;
        }
        self.write_segment(&chunk[at..]);
    }

    /// Feed bytes to the VT. On a Mosh session they are cut after each envelope so its geometry
    /// is applied between the bytes before it and the bytes after it.
    fn write_segment(&mut self, chunk: &[u8]) {
        let mut at = 0;
        while let Some((end, signal)) = self
            .display
            .as_mut()
            .filter(|display| display.scanning())
            .and_then(|display| display.find(chunk, at))
        {
            self.terminal.write(&chunk[at..end]);
            at = end;
            let action = self
                .display
                .as_mut()
                .and_then(|display| display.handle(signal));
            self.run(action);
        }
        self.terminal.write(&chunk[at..]);
    }

    fn run(&mut self, action: Option<Action>) {
        match action {
            Some(Action::Resize { cols, rows }) => {
                let size = Size {
                    cols,
                    rows,
                    ..self.size
                };
                // Out of memory is the only way this fails; a display that cannot follow the
                // transport is as good as a corrupt one.
                if self
                    .apply(size, SizeAuthority::Transport, Resize::Canonical)
                    .is_err()
                {
                    self.fail_display(DisplayFailure::InvalidFrame);
                }
            }
            Some(Action::Failed(failure)) => self.events.display_failure = Some(failure),
            None => {}
        }
    }

    fn fail_display(&mut self, failure: DisplayFailure) {
        if let Some(display) = self.display.as_mut() {
            display.fail(failure);
        }
        self.events.display_failure = Some(failure);
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

    /// The UI asks for a size (viewport change). Applied only when the runtime owns the size; when
    /// the transport owns it (Mosh) this is intent only: the caller forwards it to the transport
    /// and the answer arrives as a frame envelope or through [`Self::apply_transport_size`].
    pub fn request_size(&mut self, size: Size) -> Result<SizeOutcome, Error> {
        if self.authority == SizeAuthority::Transport && self.display_failure().is_some() {
            return Ok(SizeOutcome::Dropped);
        }
        let size = size.validate()?;
        if self.display.is_some() && !mosh::valid_size(size.cols, size.rows) {
            return Err(Error::InvalidSize(size));
        }
        self.intent = Some(size);
        match self.authority {
            SizeAuthority::Local => self
                .apply(size, SizeAuthority::Local, Resize::Plain)
                .map(|()| SizeOutcome::Applied),
            SizeAuthority::Transport => Ok(SizeOutcome::Deferred(size)),
        }
    }

    /// The transport states the real grid size. Always applied, as a plain libghostty-vt resize
    /// (reflowing, bottom-anchored); from now on UI requests are deferred until
    /// [`Self::release_transport_authority`]. Mosh frames do not come through here: the envelope
    /// path resizes top-anchored and without reflow ([`Config::canonical_frames`]), which needs to
    /// run at a sequence boundary that only the byte stream knows.
    pub fn apply_transport_size(&mut self, size: Size) -> Result<(), Error> {
        let size = size.validate()?;
        self.apply(size, SizeAuthority::Transport, Resize::Plain)?;
        self.authority = SizeAuthority::Transport;
        Ok(())
    }

    /// Back to a local size owner (for example reconnecting over plain SSH): the last UI request
    /// is applied.
    pub fn release_transport_authority(&mut self) -> Result<(), Error> {
        self.authority = SizeAuthority::Local;
        match self.intent {
            Some(size) if size != self.size => {
                self.apply(size, SizeAuthority::Local, Resize::Plain)
            }
            _ => Ok(()),
        }
    }

    /// The Mosh transport ended: stop reading envelopes and hand the size back to the UI without
    /// applying its pending intent (the final canonical geometry stays until the UI asks again).
    /// A frame left open fails the display as [`DisplayFailure::PartialFrame`]. Idempotent.
    pub fn finish_canonical(&mut self) -> Option<DisplayFailure> {
        let action = self.display.as_mut().and_then(Display::finish);
        self.run(action);
        if self.display.is_some() {
            self.authority = SizeAuthority::Local;
            self.intent = None;
        }
        self.display_failure()
    }

    /// Why the Mosh display stopped following the transport, if it did.
    pub fn display_failure(&self) -> Option<DisplayFailure> {
        self.display.as_ref().and_then(Display::failure)
    }

    fn apply(&mut self, size: Size, authority: SizeAuthority, how: Resize) -> Result<(), Error> {
        let old = self.size;
        // Every Mosh update repeats the grid size; an unchanged grid is a plain call that only
        // refreshes the pixel size, and moves nothing.
        if how == Resize::Plain || (size.cols, size.rows) == (old.cols, old.rows) {
            self.terminal.resize(
                size.cols,
                size.rows,
                size.cell_width_px,
                size.cell_height_px,
            )?;
        } else {
            self.resize_canonical(size)?;
        }
        self.size = size;
        if size != old {
            self.events.geometry = Some(Geometry { size, authority });
        }
        Ok(())
    }

    /// libghostty-vt keeps the bottom of the grid when it shrinks (the rows above become history),
    /// pulls history down when it grows, and reflows wrapped lines while wraparound is on. Mosh
    /// repaints from the top, so each of those would duplicate or rewrite rows the server never
    /// changed. So: erase the rows that no longer fit (Ghostty trims blank trailing rows without
    /// making history), park the cursor on the first cell so there is no reason to move rows,
    /// resize with wraparound off (no reflow), then put the cursor back, clamped. The erase and the
    /// moves are ordinary VT input at a sequence boundary; origin mode is cleared around them
    /// because CUP is margin-relative under it. The saved-cursor slot is not touched.
    fn resize_canonical(&mut self, size: Size) -> Result<(), Error> {
        let (wrap, origin) = (
            self.terminal.mode_get(MODE_WRAPAROUND)?,
            self.terminal.mode_get(MODE_ORIGIN)?,
        );
        let scrolled = self.terminal.scrollbar()?;
        self.terminal.scroll_viewport_bottom();
        let (x, y) = self.renderer.cursor_cell(&self.terminal)?;
        self.terminal.mode_set(MODE_ORIGIN, false)?;
        if size.rows < self.size.rows {
            self.terminal
                .write(format!("\x1b[{};1H\x1b[J", size.rows + 1).as_bytes());
        }
        self.terminal.write(b"\x1b[H");
        self.terminal.mode_set(MODE_WRAPAROUND, false)?;
        let resized = self.terminal.resize(
            size.cols,
            size.rows,
            size.cell_width_px,
            size.cell_height_px,
        );
        self.terminal.mode_set(MODE_WRAPAROUND, wrap)?;
        let (x, y) = (x.min(size.cols - 1), y.min(size.rows - 1));
        self.terminal
            .write(format!("\x1b[{};{}H", y + 1, x + 1).as_bytes());
        self.terminal.mode_set(MODE_ORIGIN, origin)?;
        if scrolled.offset + scrolled.len < scrolled.total {
            self.terminal.scroll_viewport_row(scrolled.offset);
        }
        Ok(resized?)
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
        let mut replies = self.replies();
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

    /// Focus in/out report; empty unless the program enabled focus events (mode 1004).
    pub fn encode_focus(&self, focused: bool) -> Result<Vec<u8>, Error> {
        if !self.terminal.mode_get(ghostty_vt::MODE_FOCUS_EVENT)? {
            return Ok(Vec::new());
        }
        Ok(ghostty_vt::encode_focus(if focused {
            ghostty_vt::FocusEvent::Gained
        } else {
            ghostty_vt::FocusEvent::Lost
        })?)
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

    /// The text of one absolute row over the columns of `span`, as xterm's `translateToString`
    /// builds it: a blank cell reads as a space, a wide character's spacer as nothing (a span that
    /// opens on a wide character's second cell reads it as a blank, and a wrapped wide character's
    /// head as a blank), a grapheme cluster whole. A row past the end or past `u32` is empty.
    pub(crate) fn row_text(
        &self,
        row: usize,
        span: &Range<u16>,
        trim: Trim,
    ) -> Result<String, Error> {
        let mut text = String::new();
        let Ok(row) = u32::try_from(row) else {
            return Ok(text);
        };
        let (mut column, mut content, mut written) = (0u16, 0, 0u16);
        self.terminal
            .for_each_screen_row_cell(row, |wide, graphemes| {
                // The row's own length, as xterm trims it: one past its last cell with content.
                if !graphemes.is_empty() || wide == CellWide::SpacerTail {
                    written = column + 1;
                }
                if span.contains(&column) {
                    let spacer = wide == CellWide::SpacerTail && column != span.start
                        || wide == CellWide::SpacerHead;
                    if graphemes.is_empty() && !spacer {
                        text.push(' ');
                    }
                    text.extend(graphemes.iter().filter_map(|&code| char::from_u32(code)));
                    // xterm counts a wide character's second cell in the row's length, so a span that
                    // opens on it keeps its blank even when nothing follows.
                    if !graphemes.is_empty()
                        || (wide == CellWide::SpacerTail && column == span.start)
                    {
                        content = text.len();
                    }
                }
                column += 1;
            })?;
        match trim {
            Trim::Spaces => text.truncate(text.trim_end_matches(js_space).len()),
            // xterm cuts a span at the end of the row's content, not at the span's own last
            // content: the empty cells of a gap (a tab, a cursor move) stay while text follows them.
            Trim::EmptyCells if written < span.end => text.truncate(content),
            Trim::EmptyCells => {}
        }
        Ok(text)
    }

    /// Text of absolute rows (scrollback first, as `screen_text`), trimmed on the right, optionally
    /// of a column span `[start, end)`: the adapter's `readRows`, text only, never cells. A blank
    /// cell reads as a space, a wide character's spacer as nothing, a grapheme cluster whole. Rows
    /// past the end read as empty; at most [`MAX_READ_ROWS`] are returned. Same results as the xterm
    /// backend (`translateToString(true, start, end)` then `trimEnd`), pinned by
    /// `fixtures/read-rows.json`.
    pub fn read_rows(
        &self,
        first: usize,
        count: usize,
        columns: Option<Range<u16>>,
    ) -> Result<Vec<String>, Error> {
        let span = columns.unwrap_or(0..u16::MAX);
        (first..first.saturating_add(count.min(MAX_READ_ROWS)))
            .map(|row| self.row_text(row, &span, Trim::Spaces))
            .collect()
    }

    pub fn viewport(&self) -> Result<Viewport, Error> {
        let bar = self.terminal.scrollbar()?;
        Ok(Viewport {
            top: bar.offset,
            rows: bar.len,
            length: bar.total,
            following: bar.offset + bar.len >= bar.total,
        })
    }

    /// One bounded step of libghostty-vt's idle scrollback compression; `true` while more work
    /// remains. Meant for a session nobody is looking at once its input has stopped.
    pub fn compress_scrollback(&mut self) -> Result<bool, Error> {
        Ok(self.terminal.compress_incremental()? == TerminalCompressionResult::Pending)
    }

    /// The VT state, for the text queries of sibling modules.
    pub(crate) fn vt(&self) -> &Terminal {
        &self.terminal
    }

    pub fn scrollback_rows(&self) -> Result<usize, Error> {
        Ok(self.terminal.scrollback_rows()?)
    }

    pub fn scroll_viewport(&mut self, delta: isize) {
        self.terminal.scroll_viewport_delta(delta);
    }

    /// Whether the viewport moved (it was already on the live screen otherwise).
    pub fn scroll_to_bottom(&mut self) -> bool {
        let offset = |terminal: &Terminal| terminal.scrollbar().map(|bar| bar.offset).ok();
        let before = offset(&self.terminal);
        self.terminal.scroll_viewport_bottom();
        before != offset(&self.terminal)
    }
}
