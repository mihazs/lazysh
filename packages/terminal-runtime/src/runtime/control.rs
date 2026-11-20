//! The control plane of one runtime (#1321): sizes, positions, modes and the TEXT of a window of rows, what the
//! native adapter's synchronous readers need and nothing a renderer draws from. No cells, styles or pixels leave
//! here. The types are the wire format of the app's `terminal_core_*` commands and of the stdio harness, and
//! `fixtures/control-plane.json` pins them to what xterm.js answers for the same bytes.
use super::{Error, TerminalRuntime, Viewport, MAX_READ_ROWS};
use crate::clipboard::clipboard_consent_text;
use crate::selection::{CellPos, CellRange, Direction, SearchHit};
use crate::size::Size;
use ghostty_vt::ActiveScreen;
use serde::{Deserialize, Serialize};

/// Rows of text an answer carries when the reader does not say.
pub const CONTROL_WINDOW_DEFAULT: usize = 256;
/// The most rows of text one answer carries, whatever the reader asks for.
pub const CONTROL_WINDOW_MAX: usize = 1024;
/// The most bells one answer reports; a program that rings in a loop is one flood, not a thousand events.
const MAX_BELLS: usize = 8;

/// DEC private mouse tracking modes: X10 (9), normal (1000), button-event (1002), any-event (1003).
const MOUSE_MODES: [(u16, MouseTracking); 4] = [
    (1003, MouseTracking::Any),
    (1002, MouseTracking::Drag),
    (1000, MouseTracking::Vt200),
    (9, MouseTracking::X10),
];

/// DEC private modes an ANSI snapshot restores, each with its value in a fresh terminal: cursor keys, wraparound,
/// the mouse tracking levels and encodings, cursor visibility, focus reports and bracketed paste.
const SNAPSHOT_MODES: [(u16, bool); 12] = [
    (1, false),
    (7, true),
    (9, false),
    (25, true),
    (1000, false),
    (1002, false),
    (1003, false),
    (1004, false),
    (1005, false),
    (1006, false),
    (1016, false),
    (2004, false),
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

/// What a reader asks about the text of the buffer (#1320), in the adapter's shapes: absolute rows, both ends of a
/// range inclusive. The answers are text, a range or a search hit, never cells.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ControlQuery {
    SelectionText {
        range: CellRange,
    },
    /// `from` is the previous hit's row.
    Search {
        query: String,
        direction: Direction,
        from: Option<usize>,
    },
    WordAt {
        cell: CellPos,
    },
    LineAt {
        row: usize,
    },
    /// Select all: `null` for an empty buffer.
    BufferRange,
    CopyScreen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlAnswer {
    Text(String),
    Range(Option<CellRange>),
    Hit(Option<SearchHit>),
}

impl TerminalRuntime {
    /// One question about the buffer's text, answered from the core's state as [`crate::selection`] defines it.
    pub fn control_query(&self, query: ControlQuery) -> Result<ControlAnswer, Error> {
        Ok(match query {
            ControlQuery::SelectionText { range } => {
                ControlAnswer::Text(self.selection_text(range)?)
            }
            ControlQuery::Search {
                query,
                direction,
                from,
            } => ControlAnswer::Hit(self.search(&query, direction, from)?),
            ControlQuery::WordAt { cell } => ControlAnswer::Range(Some(self.word_at(cell)?)),
            ControlQuery::LineAt { row } => ControlAnswer::Range(Some(self.line_at(row)?)),
            ControlQuery::BufferRange => ControlAnswer::Range(self.buffer_range()?),
            ControlQuery::CopyScreen => ControlAnswer::Text(self.copy_screen()?),
        })
    }

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
            .filter_map(|bytes| clipboard_consent_text(&bytes))
            .map(|text| ControlEvent::Clipboard { text });
        title
            .into_iter()
            .chain(bells)
            .chain(directories)
            .chain(writes)
            .collect()
    }

    /// The live screen as bytes that rebuild it in a FRESH terminal of the same size (#1342): the alternate screen
    /// if the program is on it, the visible rows with their styles, the cursor, and each mode of
    /// [`SNAPSHOT_MODES`] that differs from a fresh terminal's. Scrollback, the screen the program is not on,
    /// margins, tab stops and the Kitty keyboard flags are not carried over. A scrolled reader stays where they are.
    pub fn ansi_snapshot(&mut self) -> Result<String, Error> {
        let (x, y) = self.live_cursor(self.viewport()?)?;
        let last = self.terminal.total_rows()?.saturating_sub(1);
        let first = last.saturating_sub(usize::from(self.size.rows) - 1);
        let mut out = String::new();
        if self.terminal.active_screen()? == ActiveScreen::Alternate {
            out.push_str("\x1b[?1049h");
        }
        out.push_str(&self.terminal.read_ansi_screen(
            (0, first as u32),
            (self.size.cols - 1, last as u32),
            false,
            false,
        )?);
        // The modes come after the cursor: wraparound off or a mouse mode must not change how the rows replay.
        out.push_str(&format!("\x1b[0m\x1b[{};{}H", y + 1, x + 1));
        for (mode, fresh) in SNAPSHOT_MODES {
            // A mode this VT does not know reads as its fresh value: nothing to restore.
            let set = self.terminal.mode_get(mode).unwrap_or(fresh);
            if set != fresh {
                out.push_str(&format!("\x1b[?{mode}{}", if set { 'h' } else { 'l' }));
            }
        }
        Ok(out)
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
