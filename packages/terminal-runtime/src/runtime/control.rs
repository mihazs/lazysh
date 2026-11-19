//! The control plane of one runtime (#1321): sizes, positions, modes and the TEXT of a window of rows, what the
//! native adapter's synchronous readers need and nothing a renderer draws from. No cells, styles or pixels leave
//! here. The types are the wire format of the app's `terminal_core_*` commands and of the stdio harness, and
//! `fixtures/control-plane.json` pins them to what xterm.js answers for the same bytes.
use super::{Error, TerminalRuntime, Viewport, MAX_READ_ROWS};
use crate::size::Size;
use ghostty_vt::ActiveScreen;
use serde::{Deserialize, Serialize};

/// Rows of text an answer carries when the reader does not say.
pub const CONTROL_WINDOW_DEFAULT: usize = 256;
/// The most rows of text one answer carries, whatever the reader asks for.
pub const CONTROL_WINDOW_MAX: usize = 1024;
/// The most bells one answer reports; a program that rings in a loop is one flood, not a thousand events.
const MAX_BELLS: usize = 8;
/// The largest clipboard write offered to the user, the bound the xterm backend's `decodeClipboardRequest` has.
const MAX_CLIPBOARD: usize = 64 * 1024;

/// DEC private mouse tracking modes: X10 (9), normal (1000), button-event (1002), any-event (1003).
const MOUSE_MODES: [(u16, MouseTracking); 4] = [
    (1003, MouseTracking::Any),
    (1002, MouseTracking::Drag),
    (1000, MouseTracking::Vt200),
    (9, MouseTracking::X10),
];

/// The rows of text per answer for a reader's request: [`CONTROL_WINDOW_DEFAULT`] when absent, never more than
/// [`CONTROL_WINDOW_MAX`] and never less than one.
pub fn control_window(requested: Option<usize>) -> usize {
    requested
        .unwrap_or(CONTROL_WINDOW_DEFAULT)
        .clamp(1, CONTROL_WINDOW_MAX)
}

/// The most demanding mouse reporting the program asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseTracking {
    None,
    X10,
    Vt200,
    Drag,
    Any,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlModes {
    pub bracketed_paste: bool,
    pub mouse_tracking: MouseTracking,
    pub alternate_screen: bool,
    pub application_cursor_keys: bool,
}

/// The cursor in the live screen: row 0 is its first row, wherever the reader has scrolled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlCursor {
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlState {
    pub columns: u16,
    pub rows: u16,
    pub cursor: ControlCursor,
    pub modes: ControlModes,
    pub viewport: Viewport,
}

/// The text of `rows.len()` absolute rows from `first`, trimmed on the right.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowWindow {
    pub first: usize,
    pub rows: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlSnapshot {
    pub state: ControlState,
    pub window: RowWindow,
}

/// What a reader can ask of the viewport, in the adapter's `TerminalScrollAction` shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScrollAction {
    Lines {
        delta: isize,
    },
    /// A page is one row short of the screen, as xterm.js scrolls it.
    Pages {
        delta: isize,
    },
    ToTop,
    ToBottom,
    ToRow {
        row: usize,
    },
}

/// What the program reported, in the adapter's event shapes (`NativeCoreEvent`). `Changed` is the doorbell
/// ([`crate::Doorbell`]); the rest are decoded and bounded here, so a consumer never parses a raw escape sequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ControlEvent {
    Changed,
    Title {
        title: String,
    },
    Bell,
    /// The directory an OSC 7 report (`file://host/path`) names, percent-decoded.
    Cwd {
        path: String,
    },
    /// An OSC 52 write the user may be offered: valid UTF-8, at most 64 KiB.
    Clipboard {
        text: String,
    },
}

impl TerminalRuntime {
    /// The control state and the text of up to `window` rows chosen so the viewport is inside them: the last
    /// rows of the buffer while the reader follows, the rows from the viewport's top when they scrolled back.
    pub fn control_snapshot(&mut self, window: usize) -> Result<ControlSnapshot, Error> {
        let viewport = self.viewport()?;
        let count = window.clamp(viewport.rows.max(1), MAX_READ_ROWS);
        let first = viewport.top.min(viewport.length.saturating_sub(count));
        let rows = self.read_rows(first, count.min(viewport.length - first), None)?;
        let modes = self.modes()?;
        let (x, y) = self.live_cursor(viewport)?;
        Ok(ControlSnapshot {
            state: ControlState {
                columns: self.size.cols,
                rows: self.size.rows,
                cursor: ControlCursor { x, y },
                modes: ControlModes {
                    bracketed_paste: modes.bracketed_paste,
                    mouse_tracking: self.mouse_tracking()?,
                    alternate_screen: self.terminal.active_screen()? == ActiveScreen::Alternate,
                    application_cursor_keys: modes.application_cursor_keys,
                },
                viewport,
            },
            window: RowWindow { first, rows },
        })
    }

    /// Moves the viewport as the reader asked, then answers like [`control_snapshot`](Self::control_snapshot).
    pub fn control_scroll(
        &mut self,
        action: ScrollAction,
        window: usize,
    ) -> Result<ControlSnapshot, Error> {
        let Viewport {
            top, rows, length, ..
        } = self.viewport()?;
        let last = length.saturating_sub(rows);
        let to = |row: usize| row.min(last) as isize - top as isize;
        let within = |delta: isize| delta.clamp(-(top as isize), last as isize - top as isize);
        match action {
            ScrollAction::Lines { delta } => self.scroll_viewport(within(delta)),
            ScrollAction::Pages { delta } => {
                let step = rows.saturating_sub(1).max(1) as isize;
                self.scroll_viewport(within(delta.saturating_mul(step)));
            }
            ScrollAction::ToTop => self.scroll_viewport(to(0)),
            ScrollAction::ToBottom => drop(self.scroll_to_bottom()),
            ScrollAction::ToRow { row } => self.scroll_viewport(to(row)),
        }
        self.control_snapshot(window)
    }

    /// Asks for a size as [`request_size`](Self::request_size) does (a transport that owns the size keeps it), then
    /// answers with the state the core has, which tells the reader what the request became.
    pub fn control_resize(
        &mut self,
        cols: u16,
        rows: u16,
        window: usize,
    ) -> Result<ControlSnapshot, Error> {
        self.request_size(Size::new(cols, rows))?;
        self.control_snapshot(window)
    }

    /// What the program reported since the last call, decoded and bounded, in a fixed order across kinds (title,
    /// bells, directory, clipboard) and the order they happened within one: the VT queues them apart. The queues
    /// hold at most 8 of each kind, so what a reader never takes is bounded, and a flood of bells is capped. Takes
    /// only these; the size and display events stay for [`take_events`](Self::take_events).
    pub fn take_control_events(&mut self) -> Vec<ControlEvent> {
        let events = &mut self.events;
        let title = events
            .title
            .take()
            .map(|title| ControlEvent::Title { title });
        let bells = std::iter::repeat_n(
            ControlEvent::Bell,
            usize::from(std::mem::take(&mut events.bell)).min(MAX_BELLS),
        );
        let directories = std::mem::take(&mut events.pwd_changes)
            .into_iter()
            .filter_map(|report| cwd_path(&report))
            .map(|path| ControlEvent::Cwd { path });
        let writes = std::mem::take(&mut events.clipboard_writes)
            .into_iter()
            .filter(|bytes| bytes.len() <= MAX_CLIPBOARD)
            .filter_map(|bytes| String::from_utf8(bytes).ok())
            .map(|text| ControlEvent::Clipboard { text });
        title
            .into_iter()
            .chain(bells)
            .chain(directories)
            .chain(writes)
            .collect()
    }

    fn mouse_tracking(&self) -> Result<MouseTracking, Error> {
        for (mode, level) in MOUSE_MODES {
            if self.terminal.mode_get(mode)? {
                return Ok(level);
            }
        }
        Ok(MouseTracking::None)
    }

    /// The cursor's cell in the live screen. The renderer state only knows the cell inside the viewport, so a
    /// reader who scrolled back is moved to the bottom for the read and put back where they were.
    fn live_cursor(&mut self, viewport: Viewport) -> Result<(u16, u16), Error> {
        if viewport.following {
            return self.renderer.cursor_cell(&self.terminal);
        }
        self.terminal.scroll_viewport_bottom();
        let bottom = self.viewport()?.top;
        let cursor = self.renderer.cursor_cell(&self.terminal);
        self.terminal
            .scroll_viewport_delta(viewport.top as isize - bottom as isize);
        cursor
    }
}

/// The directory an OSC 7 report names (`file://host/path`), percent-decoded as the xterm backend's `cwdFromOsc7`
/// does: any other scheme, a malformed escape or bytes that are not UTF-8 name no directory.
fn cwd_path(report: &[u8]) -> Option<String> {
    let rest = report.strip_prefix(b"file://")?;
    let path = rest
        .iter()
        .position(|&b| b == b'/')
        .map_or(&b"/"[..], |at| &rest[at..]);
    let path = &path[..path
        .iter()
        .position(|&b| b == b'?' || b == b'#')
        .unwrap_or(path.len())];
    let mut bytes = Vec::with_capacity(path.len());
    let mut rest = path.iter();
    while let Some(&b) = rest.next() {
        if b != b'%' {
            bytes.push(b);
            continue;
        }
        let hex = |digit: Option<&u8>| (*digit? as char).to_digit(16);
        bytes.push((hex(rest.next())? * 16 + hex(rest.next())?) as u8);
    }
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_report_names_its_decoded_path_or_nothing() {
        let path = |report: &str| cwd_path(report.as_bytes());
        assert_eq!(path("file:///tmp/work").as_deref(), Some("/tmp/work"));
        assert_eq!(path("file://host/tmp/a%20b").as_deref(), Some("/tmp/a b"));
        assert_eq!(path("file://host/%E6%97%A5?x=1#y").as_deref(), Some("/日"));
        assert_eq!(path("file://host").as_deref(), Some("/"));
        for refused in [
            "nonsense",
            "http://host/no",
            "file:///%zz",
            "file:///%e6",
            "file:///%4",
        ] {
            assert_eq!(path(refused), None, "{refused}");
        }
    }
}
