use crate::runtime::Error;
use ghostty_vt::{
    ActiveScreen, CellStyle, CellWide, Dirty, RenderCursor, RenderState, RgbColor, RowCells,
    RowIterator, Terminal,
};

/// One cell as a renderer needs it. Colors are resolved RGB; `None` means the default color.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    /// Full grapheme cluster (base plus combining/ZWJ parts); empty for a blank cell.
    pub text: String,
    pub wide: CellWide,
    pub fg: Option<RgbColor>,
    pub bg: Option<RgbColor>,
    pub style: CellStyle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub y: u16,
    pub cells: Vec<Cell>,
}

/// Incremental screen update. `dirty` holds only changed rows unless `full`, which carries every
/// row (first frame, resize, screen switch, or an explicit snapshot).
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub full: bool,
    pub cols: u16,
    pub rows: u16,
    pub cursor: RenderCursor,
    pub active_screen: ActiveScreen,
    pub dirty: Vec<Row>,
}

pub(crate) struct Renderer {
    state: RenderState,
    row_iter: RowIterator,
    row_cells: RowCells,
}

impl Renderer {
    pub(crate) fn new() -> Result<Self, Error> {
        Ok(Self {
            state: RenderState::new()?,
            row_iter: RowIterator::new()?,
            row_cells: RowCells::new()?,
        })
    }

    /// Collect changed rows and mark them clean. `None` when nothing changed and `force` is off.
    pub(crate) fn frame(
        &mut self,
        terminal: &Terminal,
        force: bool,
    ) -> Result<Option<Frame>, Error> {
        self.state.update(terminal)?;
        let dirty = self.state.dirty()?;
        if dirty == Dirty::Clean && !force {
            return Ok(None);
        }
        let full = force || dirty == Dirty::Full;
        let mut rows = Vec::new();
        {
            let mut iter = self.state.populate_row_iterator(&mut self.row_iter)?;
            let mut y = 0u16;
            while iter.next() {
                if full || iter.dirty()? {
                    let mut cells = iter.populate_cells(&mut self.row_cells)?;
                    let mut row = Vec::new();
                    while cells.next() {
                        let basic = cells.basic_data()?;
                        row.push(Cell {
                            text: cells.grapheme_text()?,
                            wide: basic.wide,
                            fg: cells.fg_color()?,
                            bg: cells.bg_color()?,
                            style: basic.style,
                        });
                    }
                    rows.push(Row { y, cells: row });
                }
                iter.clear_dirty()?;
                y += 1;
            }
        }
        self.state.set_dirty(Dirty::Clean)?;
        Ok(Some(Frame {
            full,
            cols: self.state.cols()?,
            rows: self.state.rows()?,
            cursor: self.state.cursor()?,
            active_screen: terminal.active_screen()?,
            dirty: rows,
        }))
    }
}
