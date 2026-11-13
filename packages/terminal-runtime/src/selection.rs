//! Selection, copy and search in absolute cell coordinates ([#1320]): the questions the xterm
//! backend answers with `select`/`getSelection`, `terminalWordAt`, `selectAll` and the find box,
//! answered from the core's state so React never needs a cell mirror. Every call takes its range as
//! an argument and answers with text or a range, never cells: the host owns the selection itself
//! (the Renderer API's `Overlay::selection` is host state "changed without the core"), so the core
//! keeps none and there is nothing to invalidate when output scrolls the rows under it.
//!
//! Rows are absolute (scrollback first, as [`TerminalRuntime::read_rows`]); a range's end is
//! inclusive, like the adapter's `TerminalRange`.
//!
//! [#1320]: https://github.com/mihazs/lazysh/issues/1320

use crate::runtime::{js_space, Error, TerminalRuntime, Trim, MAX_READ_ROWS};
use ghostty_vt::CellWide;

/// A buffer cell: `x` is a column, `y` an absolute row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellPos {
    pub x: u16,
    pub y: usize,
}

/// Both ends inclusive, `start` first in reading order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellRange {
    pub start: CellPos,
    pub end: CellPos,
}

/// What [`TerminalRuntime::search`] found: the row, the match's UTF-16 offset in that row's text
/// (JavaScript's `indexOf`, so the TypeScript side can use it as is) and the row text's UTF-16
/// length, which is what the find box selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchHit {
    pub row: usize,
    pub column: usize,
    pub length: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Forward,
    Backward,
}

/// Longest query searched (the find box allows 256 characters).
pub const MAX_QUERY_BYTES: usize = 1024;
/// Most rows a single logical line may span when selecting it, so one unbroken soft-wrapped line
/// cannot make a query walk the whole scrollback.
const MAX_LINE_ROWS: usize = 4096;

impl TerminalRuntime {
    /// The text of `range`, as xterm's `getSelection` builds it: the first row from its start
    /// column, the last to its end column, a newline between rows unless the next row continues a
    /// soft-wrapped line, rows trimmed of cells nothing was written to, wide characters and
    /// grapheme clusters whole, and non-breaking spaces as plain spaces. Rows past the end are empty
    /// lines (at most [`MAX_READ_ROWS`] of them); a range that ends before it starts is empty.
    pub fn selection_text(&self, range: CellRange) -> Result<String, Error> {
        let total = self.vt().total_rows()?;
        let cols = self.size().cols;
        let (start, end) = (range.start, range.end);
        if (end.y, end.x) < (start.y, start.x) {
            return Ok(String::new());
        }
        // Rows past the end read as empty lines, as in xterm, but a query stays bounded.
        let last = end.y.min(total.max(start.y) + MAX_READ_ROWS);
        let wraps = self
            .vt()
            .screen_text_rows_range(start.y, last.min(total.saturating_sub(1)) + 1)?;
        let mut lines: Vec<String> = Vec::new();
        for y in start.y..=last {
            let from = if y == start.y { start.x } else { 0 };
            let to = if y == last && last == end.y {
                end.x.saturating_add(1)
            } else {
                cols
            };
            let text = self.row_text(y, &(from..to), Trim::EmptyCells)?;
            match lines.last_mut() {
                Some(previous)
                    if wraps
                        .get(y - start.y)
                        .is_some_and(|row| row.wrap_continuation) =>
                {
                    previous.push_str(&text)
                }
                _ => lines.push(text),
            }
        }
        Ok(lines.join("\n").replace('\u{a0}', " "))
    }

    /// The visible rows in full: what "copy screen" selects.
    pub fn screen_range(&self) -> Result<CellRange, Error> {
        let view = self.viewport()?;
        Ok(CellRange {
            start: CellPos { x: 0, y: view.top },
            end: CellPos {
                x: self.size().cols - 1,
                y: view.top + view.rows - 1,
            },
        })
    }

    /// The text of the visible screen: the adapter's "copy screen".
    pub fn copy_screen(&self) -> Result<String, Error> {
        self.selection_text(self.screen_range()?)
    }

    /// Everything, scrollback and screen: select all. `None` for an empty buffer.
    pub fn buffer_range(&self) -> Result<Option<CellRange>, Error> {
        let total = self.vt().total_rows()?;
        Ok((total > 0).then(|| CellRange {
            start: CellPos { x: 0, y: 0 },
            end: CellPos {
                x: self.size().cols - 1,
                y: total - 1,
            },
        }))
    }

    /// The word under `cell`: the run of cells on its row that are not blank, or the cell itself
    /// when it is blank (`terminalWordAt`). A wide character's second cell belongs to its word; a
    /// word never continues onto a wrapped row. A cell off the screen is returned as it is.
    pub fn word_at(&self, cell: CellPos) -> Result<CellRange, Error> {
        let alone = CellRange {
            start: cell,
            end: cell,
        };
        let cols = usize::from(self.size().cols);
        let Ok(row) = u32::try_from(cell.y) else {
            return Ok(alone);
        };
        if cell.y >= self.vt().total_rows()? || usize::from(cell.x) >= cols {
            return Ok(alone);
        }
        let mut word = Vec::with_capacity(cols);
        self.vt().for_each_screen_row_cell(row, |wide, graphemes| {
            let letters = graphemes
                .iter()
                .filter_map(|&code| char::from_u32(code))
                .any(|c| !js_space(c));
            word.push(wide == CellWide::SpacerTail || letters);
        })?;
        let x = usize::from(cell.x);
        if !word[x] {
            return Ok(alone);
        }
        let start = word[..x].iter().rposition(|&w| !w).map_or(0, |gap| gap + 1);
        let end = word[x..]
            .iter()
            .position(|&w| !w)
            .map_or(cols, |gap| x + gap)
            - 1;
        Ok(CellRange {
            start: CellPos {
                x: start as u16,
                y: cell.y,
            },
            end: CellPos {
                x: end as u16,
                y: cell.y,
            },
        })
    }

    /// The whole logical line containing `row`: from the first row of its soft-wrapped chain, column
    /// 0, to the last row, last column. Chains longer than 4096 rows are cut at that many.
    pub fn line_at(&self, row: usize) -> Result<CellRange, Error> {
        let total = self.vt().total_rows()?;
        let row = row.min(total.saturating_sub(1));
        let (mut first, mut last) = (row, row);
        let window = self
            .vt()
            .screen_text_rows_range(row.saturating_sub(MAX_LINE_ROWS), row + MAX_LINE_ROWS + 1)?;
        let base = row.saturating_sub(MAX_LINE_ROWS);
        while first > base && window[first - base].wrap_continuation {
            first -= 1;
        }
        while last + 1 < base + window.len() && window[last - base].soft_wrapped {
            last += 1;
        }
        Ok(CellRange {
            start: CellPos { x: 0, y: first },
            end: CellPos {
                x: self.size().cols - 1,
                y: last,
            },
        })
    }

    /// The first row after (or before) `from` whose text contains `query`, ignoring case, wrapping
    /// around the buffer; `from` is the previous hit's row, `None` starts from one end. The text of
    /// a row is read as selection reads it. At most [`MAX_QUERY_BYTES`] of query are searched; an
    /// empty or longer query finds nothing.
    pub fn search(
        &self,
        query: &str,
        direction: Direction,
        from: Option<usize>,
    ) -> Result<Option<SearchHit>, Error> {
        let total = self.vt().total_rows()?;
        if query.is_empty() || query.len() > MAX_QUERY_BYTES || total == 0 {
            return Ok(None);
        }
        let needle = query.to_lowercase();
        let step = |from: usize, offset: usize| match direction {
            Direction::Forward => (from + offset) % total,
            Direction::Backward => (from + total * 2 - offset % (total * 2)) % total,
        };
        let start = match (from, direction) {
            (Some(row), _) => row,
            (None, Direction::Forward) => total - 1,
            (None, Direction::Backward) => total,
        };
        for offset in 1..=total {
            let row = step(start, offset);
            let text = self.row_text(row, &(0..u16::MAX), Trim::EmptyCells)?;
            if let Some(index) = text.to_lowercase().find(&needle) {
                let column = text.to_lowercase()[..index].encode_utf16().count();
                return Ok(Some(SearchHit {
                    row,
                    column,
                    length: text.encode_utf16().count(),
                }));
            }
        }
        Ok(None)
    }
}
