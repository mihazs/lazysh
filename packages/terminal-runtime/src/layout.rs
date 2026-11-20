//! What to paint for one screen row, decided once for every renderer (#1322).
//!
//! [`row_draws`] turns the cells of a [`Screen`] row, the cursor, the selection and the
//! [`Appearance`] into an ordered list of [`Draw`]s: solid rectangles and grapheme-cluster glyphs
//! in device pixels. Later draws cover earlier ones. The CPU [`crate::ReferenceRenderer`] rasterizes
//! the list, a GPU renderer turns it into instances and an atlas, a platform canvas into drawing
//! calls; what they disagree on is then rasterization, not placement, colors or decorations, and
//! the golden images catch exactly that.
//!
//! The glyph itself is a renderer's business. [`glyph_pixels`] is the reference one: a 5x7 dot
//! pattern derived from the cluster's text (like the web platform tests' Ahem font), so a wrong
//! cluster, cell or width changes the image without any font being involved.

use crate::frame::Cell;
use crate::render::{Appearance, CellMetrics, Screen, Theme};
use ghostty_vt::{CellColor, CellWide, CursorVisualStyle, RgbColor};

const DOTS_HIGH: u32 = 7;
const DOTS_WIDE: u32 = 5;

/// A filled rectangle in device pixels, relative to the top-left of the grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub color: RgbColor,
}

/// A grapheme cluster in the text color `color`, drawn into `cells` (1 or 2) cells at `(x, y)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Glyph<'a> {
    pub x: u32,
    pub y: u32,
    pub cells: u32,
    pub text: &'a str,
    pub color: RgbColor,
    pub bold: bool,
    pub italic: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Draw<'a> {
    Rect(Rect),
    Glyph(Glyph<'a>),
}

/// The draws for row `y`, left to right, one cell (or wide pair) after the other; none for a row
/// outside the grid. Does not clear the row: a renderer fills it with the theme background first.
pub fn row_draws<'a>(screen: &'a Screen, y: u16, appearance: &Appearance) -> Vec<Draw<'a>> {
    if y >= screen.rows() {
        return Vec::new();
    }
    let m = appearance.metrics;
    let cursor = screen.visible_cursor().filter(|c| c.1 == y);
    let mut draws = Vec::new();
    let mut x = 0;
    while x < screen.cols() {
        let cell = &screen.row(y)[usize::from(x)];
        let cells = if cell.wide == CellWide::Wide { 2 } else { 1 };
        if cell.wide != CellWide::SpacerTail {
            let origin = (u32::from(x) * m.cell_width, u32::from(y) * m.cell_height);
            let cursor = cursor.filter(|c| c.0 == x).map(|c| c.2);
            let selected = screen.is_selected(x, y);
            paint(
                &mut draws, appearance, cell, origin, cells, selected, cursor,
            );
        }
        x += cells as u16;
    }
    draws
}

fn paint<'a>(
    out: &mut Vec<Draw<'a>>,
    appearance: &Appearance,
    cell: &'a Cell,
    (x, y): (u32, u32),
    cells: u32,
    selected: bool,
    cursor: Option<CursorVisualStyle>,
) {
    let (theme, m) = (&appearance.theme, appearance.metrics);
    let (fg, bg) = colors(
        theme,
        cell,
        selected,
        cursor == Some(CursorVisualStyle::Block),
    );
    let (w, h, t) = (cells * m.cell_width, m.cell_height, m.line_thickness);
    let rect = |x, y, w, h, color| Draw::Rect(Rect { x, y, w, h, color });
    out.push(rect(x, y, w, h, bg));
    if !cell.style.invisible && !cell.text.trim().is_empty() {
        out.push(Draw::Glyph(Glyph {
            x,
            y,
            cells,
            text: &cell.text,
            color: fg,
            bold: cell.style.bold,
            italic: cell.style.italic,
        }));
    }
    if cell.style.underlined {
        let line = match cell.style.underline_color {
            Some(CellColor::Rgb(rgb)) => rgb,
            Some(CellColor::Palette(index)) => theme.palette[usize::from(index)],
            None => fg,
        };
        underline(
            out,
            cell.style.underline,
            (x, y + m.underline_y),
            (w, t),
            line,
        );
    }
    if cell.style.strikethrough {
        out.push(rect(x, y + m.strikethrough_y, w, t, fg));
    }
    if cell.style.overline {
        out.push(rect(x, y, w, t, fg));
    }
    let c = theme.cursor;
    match cursor {
        Some(CursorVisualStyle::Bar) => out.push(rect(x, y, t, h, c)),
        Some(CursorVisualStyle::Underline) => out.push(rect(x, y + h - t, w, t, c)),
        Some(CursorVisualStyle::BlockHollow) => out.extend([
            rect(x, y, w, t, c),
            rect(x, y + h - t, w, t, c),
            rect(x, y, t, h, c),
            rect(x + w - t, y, t, h, c),
        ]),
        Some(CursorVisualStyle::Block) | None => {}
    }
}

/// SGR 4:n underline as rectangles, adjacent columns merged: single, double, curly (alternating
/// column pairs one thickness apart), dotted and dashed.
fn underline(
    out: &mut Vec<Draw<'_>>,
    kind: u8,
    (x, y): (u32, u32),
    (w, t): (u32, u32),
    color: RgbColor,
) {
    let mut rect = |x, y, w| {
        out.push(Draw::Rect(Rect {
            x,
            y,
            w,
            h: t,
            color,
        }))
    };
    match kind {
        3 => (0..w.div_ceil(2)).for_each(|i| rect(x + 2 * i, y + i % 2 * t, 2.min(w - 2 * i))),
        4 => (0..w.div_ceil(t))
            .filter(|i| i % 2 == 0)
            .for_each(|i| rect(x + i * t, y, t.min(w - i * t))),
        5 => {
            (0..w.div_ceil(4 * t)).for_each(|i| rect(x + 4 * t * i, y, (3 * t).min(w - 4 * t * i)))
        }
        2 => {
            rect(x, y, w);
            rect(x, y + 2 * t, w);
        }
        _ => rect(x, y, w),
    }
}

/// Text and background of a cell after inverse, faint, selection and a block cursor, in that order.
fn colors(theme: &Theme, cell: &Cell, selected: bool, block_cursor: bool) -> (RgbColor, RgbColor) {
    let (mut fg, mut bg) = (
        cell.fg.unwrap_or(theme.foreground),
        cell.bg.unwrap_or(theme.background),
    );
    if cell.style.inverse {
        (fg, bg) = (bg, fg);
    }
    if cell.style.faint {
        fg = RgbColor {
            r: mid(fg.r, bg.r),
            g: mid(fg.g, bg.g),
            b: mid(fg.b, bg.b),
        };
    }
    if selected {
        (fg, bg) = (
            theme.selection_foreground.unwrap_or(fg),
            theme.selection_background,
        );
    }
    if block_cursor {
        (fg, bg) = (theme.background, theme.cursor);
    }
    (fg, bg)
}

fn mid(a: u8, b: u8) -> u8 {
    ((u16::from(a) + u16::from(b)) / 2) as u8
}

/// The reference glyph: every pixel `(x, y, width)` of the cell run (relative to its top-left, in
/// pixels) that the dot pattern of `text` colors, an eighth of a cell of margin on each side. Bold
/// double-strikes: the pixel is one wider (`width` 2) unless it would leave the run.
pub fn glyph_pixels(
    m: CellMetrics,
    cells: u32,
    text: &str,
    bold: bool,
) -> impl Iterator<Item = (u32, u32, u32)> {
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3)
    });
    let w = cells * m.cell_width;
    let (mx, my) = (m.cell_width / 8, m.cell_height / 8);
    let (bw, bh) = ((w - 2 * mx).max(1), (m.cell_height - 2 * my).max(1));
    let dots_wide = DOTS_WIDE * cells;
    (0..bh).flat_map(move |py| {
        (0..bw).filter_map(move |px| {
            let (dx, dy) = (px * dots_wide / bw, py * DOTS_HIGH / bh);
            dot(hash, dy * dots_wide + dx).then_some((
                mx + px,
                my + py,
                1 + u32::from(bold && mx + px + 1 < w),
            ))
        })
    })
}

/// One pseudo-random bit per (cluster, dot) from the splitmix64 finalizer.
fn dot(hash: u64, index: u32) -> bool {
    let mut z = hash ^ u64::from(index).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    (z ^ (z >> 31)) & 1 == 1
}
