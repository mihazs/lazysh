//! The control plane of one runtime (#1321): sizes, positions, modes and the TEXT of a window of rows, what the
//! adapter's synchronous readers need and nothing a renderer draws from. No cells, styles or pixels leave here.
use super::{Error, TerminalRuntime, Viewport, MAX_READ_ROWS};
use ghostty_vt::ActiveScreen;

/// DEC private mouse tracking modes: X10 (9), normal (1000), button-event (1002), any-event (1003).
const MOUSE_MODES: [(u16, MouseTracking); 4] = [
    (1003, MouseTracking::Any),
    (1002, MouseTracking::Drag),
    (1000, MouseTracking::Vt200),
    (9, MouseTracking::X10),
];

/// The most demanding mouse reporting the program asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseTracking {
    None,
    X10,
    Vt200,
    Drag,
    Any,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlModes {
    pub bracketed_paste: bool,
    pub mouse_tracking: MouseTracking,
    pub alternate_screen: bool,
    pub application_cursor_keys: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlState {
    pub columns: u16,
    pub rows: u16,
    /// The cursor in the live screen: row 0 is its first row, wherever the reader has scrolled.
    pub cursor: (u16, u16),
    pub modes: ControlModes,
    pub viewport: Viewport,
}

/// The text of `rows.len()` absolute rows from `first`, trimmed on the right.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowWindow {
    pub first: usize,
    pub rows: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlSnapshot {
    pub state: ControlState,
    pub window: RowWindow,
}

/// What a reader can ask of the viewport, in the adapter's terms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollAction {
    Lines(isize),
    /// A page is one row short of the screen, as xterm.js scrolls it.
    Pages(isize),
    Top,
    Bottom,
    Row(usize),
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
        Ok(ControlSnapshot {
            state: ControlState {
                columns: self.size.cols,
                rows: self.size.rows,
                cursor: self.live_cursor(viewport)?,
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
        match action {
            ScrollAction::Lines(delta) => {
                self.scroll_viewport(delta.clamp(-(top as isize), last as isize - top as isize))
            }
            ScrollAction::Pages(delta) => {
                let step = rows.saturating_sub(1).max(1) as isize;
                self.scroll_viewport(
                    delta
                        .saturating_mul(step)
                        .clamp(-(top as isize), last as isize - top as isize),
                );
            }
            ScrollAction::Top => self.scroll_viewport(to(0)),
            ScrollAction::Bottom => drop(self.scroll_to_bottom()),
            ScrollAction::Row(row) => self.scroll_viewport(to(row)),
        }
        self.control_snapshot(window)
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
