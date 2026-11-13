//! Terminal Renderer API (#1322): what any renderer consumes, independent of a graphics library.
//!
//! A renderer is fed by the core ([`crate::TerminalRuntime`]): [`Frame`]s (full or dirty rows)
//! through [`TerminalRenderer::apply`], plus the host-owned [`Overlay`] (cursor blink phase,
//! selection) and [`Appearance`] (cell metrics, fonts, theme). Drawing and presentation are
//! separate calls so output bursts coalesce: any number of `apply` calls, then at most one
//! `draw` and `present` per display refresh, and none while nothing changed.
//!
//! [`Screen`] is the shared half of that contract: it mirrors the cells, applies full and
//! incremental frames, and reports which rows need redrawing, so every implementation (CPU
//! reference, GPU, platform canvas) resolves "what changed" the same way.

use crate::frame::{Cell, Frame};
use crate::size::MAX_CELLS;
use ghostty_vt::{CellWide, CursorVisualStyle, RenderCursor, RgbColor};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    /// Zero or absurd metrics, surface or grid dimensions.
    InvalidSize,
    /// A frame whose rows or cells do not describe the grid it claims. State is unchanged.
    InvalidFrame(&'static str),
    /// The renderer holds no usable copy of the screen (first frame, after a size change, after
    /// device loss): the host answers with [`crate::TerminalRuntime::snapshot`].
    NeedsFullFrame,
    /// The GPU device or surface is gone. Call `resume`, then send a snapshot.
    DeviceLost,
    /// `destroy` was called; nothing but `destroy` and `stats` work any more.
    Destroyed,
    /// This device has no usable graphics backend for the renderer (no adapter the platform policy
    /// allows, or none that could create a device). Not a loss: `resume` does not help, the host
    /// keeps its fallback renderer.
    Unsupported(&'static str),
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSize => write!(f, "invalid renderer size"),
            Self::InvalidFrame(why) => write!(f, "invalid frame: {why}"),
            Self::NeedsFullFrame => write!(f, "renderer needs a full frame"),
            Self::DeviceLost => write!(f, "render device lost"),
            Self::Destroyed => write!(f, "renderer destroyed"),
            Self::Unsupported(why) => write!(f, "renderer unsupported: {why}"),
        }
    }
}

impl std::error::Error for RenderError {}

/// Cell geometry in device pixels (already multiplied by the display scale factor, so a scale
/// change is a new `Appearance`). Offsets count down from the top of the cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellMetrics {
    pub cell_width: u32,
    pub cell_height: u32,
    pub underline_y: u32,
    pub strikethrough_y: u32,
    /// Underline, strikethrough, overline, bar cursor and hollow-cursor outline thickness.
    pub line_thickness: u32,
}

impl Default for CellMetrics {
    fn default() -> Self {
        Self {
            cell_width: 8,
            cell_height: 16,
            underline_y: 12,
            strikethrough_y: 8,
            line_thickness: 1,
        }
    }
}

impl CellMetrics {
    /// The metrics for a display scale of `numerator / denominator` times these (rounded to whole
    /// pixels, never below one). A host that learns of a new scale factor (a window moved to
    /// another display, a changed system setting) passes the scaled metrics as a new
    /// [`Appearance`], which repaints every row; no frame is needed.
    pub fn scaled(self, numerator: u32, denominator: u32) -> Result<Self, RenderError> {
        if numerator == 0 || denominator == 0 || numerator > 64 * denominator {
            return Err(RenderError::InvalidSize);
        }
        let by = |v: u32| {
            ((u64::from(v) * u64::from(numerator) + u64::from(denominator) / 2)
                / u64::from(denominator))
            .max(1) as u32
        };
        let (cell_height, line_thickness) = (by(self.cell_height), by(self.line_thickness));
        // Decoration offsets keep their place in the cell when it shrinks: never past its bottom.
        let fit = |offset: u32, thickness_rows: u32| {
            by(offset).min(cell_height.saturating_sub(thickness_rows * line_thickness))
        };
        Self {
            cell_width: by(self.cell_width),
            cell_height,
            underline_y: fit(self.underline_y, 3),
            strikethrough_y: fit(self.strikethrough_y, 1),
            line_thickness,
        }
        .validate()
    }

    pub fn validate(self) -> Result<Self, RenderError> {
        let ok = (1..=256).contains(&self.cell_width)
            && (1..=256).contains(&self.cell_height)
            && self.line_thickness >= 1
            && u64::from(self.underline_y) + 3 * u64::from(self.line_thickness)
                <= u64::from(self.cell_height)
            && u64::from(self.strikethrough_y) + u64::from(self.line_thickness)
                <= u64::from(self.cell_height);
        ok.then_some(self).ok_or(RenderError::InvalidSize)
    }
}

/// Colors the host owns. `foreground` and `background` paint cells whose own color is the
/// default (`None`); the core resolves every other color to RGB before a frame is built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Theme {
    pub foreground: RgbColor,
    pub background: RgbColor,
    pub cursor: RgbColor,
    pub selection_background: RgbColor,
    /// `None` keeps each cell's own text color inside the selection.
    pub selection_foreground: Option<RgbColor>,
    /// Resolves palette-indexed underline colors, which a frame leaves unresolved.
    pub palette: [RgbColor; 256],
}

impl Default for Theme {
    fn default() -> Self {
        let rgb = |r, g, b| RgbColor { r, g, b };
        // Foreground, background and palette are what libghostty-vt resolves cells against by default.
        Self {
            foreground: rgb(0xff, 0xff, 0xff),
            background: rgb(0, 0, 0),
            cursor: rgb(0xff, 0xd7, 0x00),
            selection_background: rgb(0x30, 0x50, 0x90),
            selection_foreground: None,
            palette: ghostty_vt::default_palette(),
        }
    }
}

/// Everything that is not screen content. Changing it repaints every row.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Appearance {
    pub metrics: CellMetrics,
    /// Preferred family first, then the fallback list (CJK, emoji). Renderers without fonts ignore it.
    pub font_families: Vec<String>,
    pub theme: Theme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionKind {
    /// Reading order from `anchor` to `head`, whole rows in between.
    Linear,
    /// The rectangle spanned by `anchor` and `head`.
    Block,
}

/// A selection in viewport cells, `(column, row)`, both ends inclusive and in any order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Selection {
    pub kind: SelectionKind,
    pub anchor: (u16, u16),
    pub head: (u16, u16),
}

impl Selection {
    fn ends(&self) -> ((u16, u16), (u16, u16)) {
        let (a, h) = (self.anchor, self.head);
        match self.kind {
            SelectionKind::Linear if (a.1, a.0) <= (h.1, h.0) => (a, h),
            SelectionKind::Linear => (h, a),
            SelectionKind::Block => ((a.0.min(h.0), a.1.min(h.1)), (a.0.max(h.0), a.1.max(h.1))),
        }
    }

    pub fn rows(&self) -> std::ops::RangeInclusive<u16> {
        self.anchor.1.min(self.head.1)..=self.anchor.1.max(self.head.1)
    }

    pub fn contains(&self, col: u16, row: u16) -> bool {
        let (start, end) = self.ends();
        match self.kind {
            SelectionKind::Block => {
                (start.0..=end.0).contains(&col) && (start.1..=end.1).contains(&row)
            }
            SelectionKind::Linear => {
                (row, col) >= (start.1, start.0) && (row, col) <= (end.1, end.0)
            }
        }
    }
}

/// State the host owns and changes without the core: cursor blink phase and the selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Overlay {
    /// The blink phase from the host's single coalesced timer. Ignored while the cursor does not blink.
    pub cursor_phase_on: bool,
    pub selection: Option<Selection>,
}

impl Default for Overlay {
    fn default() -> Self {
        Self {
            cursor_phase_on: true,
            selection: None,
        }
    }
}

/// Cumulative counters, for the benchmarks ([`crate::TerminalRenderer::stats`]); callers take deltas.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RenderStats {
    pub frames_drawn: u64,
    pub frames_presented: u64,
    pub rows_drawn: u64,
    pub cells_drawn: u64,
    /// Bytes handed to the presentation target (GPU upload or surface copy).
    pub bytes_uploaded: u64,
    pub draw_time: Duration,
    pub present_time: Duration,
}

/// The [`TerminalRenderer`] methods that only forward to the [`RendererCore`] held in field `$core`
/// (`apply`, `set_overlay`, `needs_draw`, `wants_blink_timer`, `suspend`, `stats`), for the `impl` block of a renderer that embeds one.
/// A second implementation (the wgpu prototype of #1323) showed they are identical for every
/// renderer; the rest (`create`, `resize`, `draw`, `present`, `resume`, `destroy`) is where
/// implementations differ.
#[macro_export]
macro_rules! forward_to_core {
    ($core:ident) => {
        fn apply(&mut self, frame: &$crate::Frame) -> Result<(), $crate::RenderError> {
            self.$core.apply(frame)
        }

        fn set_overlay(&mut self, overlay: $crate::Overlay) -> Result<(), $crate::RenderError> {
            self.$core.set_overlay(overlay)
        }

        fn needs_draw(&self) -> bool {
            self.$core.needs_draw()
        }

        fn wants_blink_timer(&self) -> bool {
            self.$core.wants_blink_timer()
        }

        fn suspend(&mut self) {
            self.$core.suspend();
        }

        fn stats(&self) -> $crate::RenderStats {
            self.$core.stats
        }
    };
}

/// A renderer for one session and one surface. Implementations: the CPU
/// [`crate::ReferenceRenderer`] (golden images), then whatever the shootout (#1323) selects.
///
/// Contract:
/// * `apply` never draws. An incremental frame is only valid after a full one for the same grid
///   size; otherwise it fails with [`RenderError::NeedsFullFrame`] and changes nothing.
/// * `draw` repaints exactly the rows that changed since the last `draw` and returns how many.
///   Zero means the screen is unchanged and `present` has nothing to show.
/// * `needs_draw` is true exactly when `draw` would paint at least one row, so an idle screen needs no frames.
/// * `wants_blink_timer` is true only while a visible blinking cursor is on screen; see [`crate::BlinkClock`].
/// * `present` shows what was drawn on the surface; without a preceding `draw` it does nothing.
/// * `suspend`, `resume` and `destroy` are idempotent. While suspended `draw` and `present` do
///   nothing and return `Ok(0)`/`Ok(())`; `resume` repaints everything on the next `draw`.
/// * [`RenderError::DeviceLost`] puts the renderer in the suspended state with its screen copy
///   dropped: `resume`, then `apply(snapshot)`.
pub trait TerminalRenderer: Sized {
    /// The opaque presentation target (window handle, `ANativeWindow`, `CAMetalLayer`, an image).
    type Surface;

    fn create(surface: Self::Surface, appearance: Appearance) -> Result<Self, RenderError>;
    fn set_appearance(&mut self, appearance: Appearance) -> Result<(), RenderError>;
    /// The surface size in device pixels; the grid is drawn from its top-left corner.
    fn resize(&mut self, width: u32, height: u32) -> Result<(), RenderError>;
    fn apply(&mut self, frame: &Frame) -> Result<(), RenderError>;
    fn set_overlay(&mut self, overlay: Overlay) -> Result<(), RenderError>;
    fn draw(&mut self) -> Result<u32, RenderError>;
    /// Whether `draw` would paint something now: the host asks for a display frame only when this
    /// is true and runs no frame loop while it is false (nothing changed, suspended, lost).
    fn needs_draw(&self) -> bool;
    /// Whether the host's blink timer has anything to do for this renderer: it is active, shows a
    /// visible blinking cursor and so redraws one row per phase change. False for a steady or
    /// hidden cursor, a suspended, lost or destroyed renderer: the host then arms no timer.
    fn wants_blink_timer(&self) -> bool;
    fn present(&mut self) -> Result<(), RenderError>;
    fn suspend(&mut self);
    fn resume(&mut self) -> Result<(), RenderError>;
    fn destroy(&mut self);
    fn stats(&self) -> RenderStats;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Active,
    Suspended,
    Destroyed,
}

/// What `resume` found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resume {
    /// Nothing to do: the renderer was active.
    Already,
    /// It was suspended; the next `draw` repaints everything.
    Resumed,
    /// The device was lost: the screen copy is gone, the renderer must rebuild its device and
    /// resources before the host sends a snapshot.
    DeviceRecovered,
}

/// The rows one `draw` has to paint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrawPlan {
    /// Ascending grid rows whose content changed.
    pub rows: Vec<u16>,
    /// Everything is stale (first draw, resize, new appearance, resume): clear the whole surface.
    pub repaint_all: bool,
    /// When `begin_draw` ran, for the draw time that `finish_draw` counts.
    pub started: Instant,
}

/// The contract of [`TerminalRenderer`] that does not depend on how pixels are made: lifecycle
/// phases, device loss, the screen copy, what to redraw and the counters. A renderer embeds one,
/// forwards the lifecycle calls to it and adds its own surface, resources and rasterization, so
/// every implementation answers the same way (tested for the CPU reference and the shootout
/// candidates alike).
#[derive(Debug)]
pub struct RendererCore {
    pub appearance: Appearance,
    pub screen: Screen,
    pub stats: RenderStats,
    repaint_all: bool,
    phase: Phase,
    lost: Arc<AtomicBool>,
}

impl RendererCore {
    pub fn new(appearance: Appearance) -> Result<Self, RenderError> {
        appearance.metrics.validate()?;
        Ok(Self {
            appearance,
            screen: Screen::new(),
            stats: RenderStats::default(),
            repaint_all: true,
            phase: Phase::Active,
            lost: Arc::new(AtomicBool::new(false)),
        })
    }

    /// The flag a GPU device-lost callback sets (from any thread) to report a loss the renderer
    /// did not cause.
    pub fn lost_flag(&self) -> Arc<AtomicBool> {
        self.lost.clone()
    }

    /// Whether calls other than `resume`, `destroy` and `stats` may proceed.
    pub fn live(&self) -> Result<(), RenderError> {
        match (self.phase, self.lost.load(Ordering::SeqCst)) {
            (Phase::Destroyed, _) => Err(RenderError::Destroyed),
            (_, true) => Err(RenderError::DeviceLost),
            _ => Ok(()),
        }
    }

    /// Every row is stale: after a resize, a new appearance or a resume.
    pub fn repaint(&mut self) {
        self.repaint_all = true;
        self.screen.invalidate();
    }

    pub fn set_appearance(&mut self, appearance: Appearance) -> Result<(), RenderError> {
        self.live()?;
        appearance.metrics.validate()?;
        self.appearance = appearance;
        self.repaint();
        Ok(())
    }

    pub fn apply(&mut self, frame: &Frame) -> Result<(), RenderError> {
        self.live()?;
        self.screen.apply(frame)
    }

    pub fn set_overlay(&mut self, overlay: Overlay) -> Result<(), RenderError> {
        self.live()?;
        self.screen.set_overlay(overlay);
        Ok(())
    }

    /// Whether `begin_draw` would return rows: active, holding a screen, and something stale.
    pub fn needs_draw(&self) -> bool {
        self.phase == Phase::Active
            && !self.lost.load(Ordering::SeqCst)
            && self.screen.has_content()
            && (self.repaint_all || self.screen.has_dirty())
    }

    /// Whether a visible blinking cursor is on screen on a live renderer.
    pub fn wants_blink_timer(&self) -> bool {
        self.phase == Phase::Active
            && !self.lost.load(Ordering::SeqCst)
            && self.screen.cursor_blinks()
    }

    /// The start of `draw`: `None` while suspended, before the first frame and when nothing
    /// changed; otherwise the rows to paint (the stale marks are consumed).
    pub fn begin_draw(&mut self) -> Result<Option<DrawPlan>, RenderError> {
        let started = Instant::now();
        if self.phase == Phase::Suspended && !self.lost.load(Ordering::SeqCst) {
            return Ok(None);
        }
        self.live()?;
        if !self.screen.has_content() {
            return Ok(None);
        }
        let rows = self.screen.take_dirty();
        if rows.is_empty() && !self.repaint_all {
            return Ok(None);
        }
        let repaint_all = std::mem::take(&mut self.repaint_all);
        Ok(Some(DrawPlan {
            rows,
            repaint_all,
            started,
        }))
    }

    /// The end of `draw`: counts the frame.
    pub fn finish_draw(&mut self, plan: &DrawPlan) -> u32 {
        let rows = plan.rows.len() as u64;
        self.stats.frames_drawn += 1;
        self.stats.rows_drawn += rows;
        self.stats.cells_drawn += rows * u64::from(self.screen.cols());
        self.stats.draw_time += plan.started.elapsed();
        plan.rows.len() as u32
    }

    /// The start of `present`: whether there is a renderer to present with (false while
    /// suspended).
    pub fn begin_present(&self) -> Result<bool, RenderError> {
        if self.phase == Phase::Suspended && !self.lost.load(Ordering::SeqCst) {
            return Ok(false);
        }
        self.live()?;
        Ok(true)
    }

    /// The end of `present`: counts the frame and what it moved to the surface.
    pub fn finish_present(&mut self, bytes: u64, started: Instant) {
        self.stats.frames_presented += 1;
        self.stats.bytes_uploaded += bytes;
        self.stats.present_time += started.elapsed();
    }

    /// The device is gone: suspended, screen copy dropped, `DeviceLost` until `resume`.
    pub fn lose_device(&mut self) {
        self.lost.store(true, Ordering::SeqCst);
        self.phase = Phase::Suspended;
        self.screen.forget();
    }

    pub fn suspend(&mut self) {
        if self.phase == Phase::Active {
            self.phase = Phase::Suspended;
        }
    }

    pub fn resume(&mut self) -> Result<Resume, RenderError> {
        if self.phase == Phase::Destroyed {
            return Err(RenderError::Destroyed);
        }
        let lost = self.lost.swap(false, Ordering::SeqCst);
        let suspended = self.phase == Phase::Suspended;
        self.phase = Phase::Active;
        if lost {
            self.screen.forget();
        }
        if lost || suspended {
            self.repaint();
        }
        Ok(match (lost, suspended) {
            (true, _) => Resume::DeviceRecovered,
            (false, true) => Resume::Resumed,
            _ => Resume::Already,
        })
    }

    pub fn destroy(&mut self) {
        self.phase = Phase::Destroyed;
        self.screen.forget();
    }
}

/// The renderer-side copy of the screen. Implementations own one and ask it what to redraw.
#[derive(Debug, Default)]
pub struct Screen {
    cols: u16,
    rows: u16,
    cells: Vec<Cell>,
    cursor: Option<RenderCursor>,
    overlay: Overlay,
    dirty: Vec<bool>,
}

impl Screen {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has_content(&self) -> bool {
        self.cols > 0
    }

    /// Whether any row is marked for redrawing.
    pub fn has_dirty(&self) -> bool {
        self.dirty.iter().any(|&stale| stale)
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// The cells of row `y`; empty outside the grid or before the first frame.
    pub fn row(&self, y: u16) -> &[Cell] {
        let start = usize::from(y) * usize::from(self.cols);
        self.cells
            .get(start..start + usize::from(self.cols))
            .unwrap_or(&[])
    }

    /// Take over a frame. Incremental frames replace only their rows and mark those dirty whose
    /// cells differ (an application that rewrites the same text costs no redraw), plus the rows
    /// the cursor left and entered.
    pub fn apply(&mut self, frame: &Frame) -> Result<(), RenderError> {
        let (cols, rows) = (frame.cols, frame.rows);
        if cols == 0 || rows == 0 || u32::from(cols) * u32::from(rows) > MAX_CELLS {
            return Err(RenderError::InvalidSize);
        }
        let same_grid = self.has_content() && (self.cols, self.rows) == (cols, rows);
        if !frame.full && !same_grid {
            return Err(RenderError::NeedsFullFrame);
        }
        if frame
            .dirty
            .iter()
            .any(|row| row.y >= rows || row.cells.len() != usize::from(cols))
        {
            return Err(RenderError::InvalidFrame(
                "row outside the grid or with a wrong cell count",
            ));
        }
        let distinct: std::collections::BTreeSet<_> = frame.dirty.iter().map(|row| row.y).collect();
        if distinct.len() != frame.dirty.len() || frame.full && distinct.len() != usize::from(rows)
        {
            return Err(RenderError::InvalidFrame(
                "a row appears twice, or a full frame misses one",
            ));
        }
        if frame.full && !same_grid {
            self.cols = cols;
            self.rows = rows;
            self.cells = vec![blank(); usize::from(cols) * usize::from(rows)];
            self.dirty = vec![true; usize::from(rows)];
        }
        for row in &frame.dirty {
            let start = usize::from(row.y) * usize::from(cols);
            let held = &mut self.cells[start..start + usize::from(cols)];
            if *held != row.cells[..] {
                held.clone_from_slice(&row.cells);
                self.dirty[usize::from(row.y)] = true;
            }
        }
        if self.cursor != Some(frame.cursor) {
            self.mark_cursor_row();
            self.cursor = Some(frame.cursor);
            self.mark_cursor_row();
        }
        Ok(())
    }

    /// A different overlay redraws the cursor row when the blink phase changed and each row where
    /// the selected cells differ, so extending a selection by one cell redraws one row.
    pub fn set_overlay(&mut self, overlay: Overlay) {
        if self.overlay == overlay {
            return;
        }
        let old = std::mem::replace(&mut self.overlay, overlay);
        if old.cursor_phase_on != overlay.cursor_phase_on && self.cursor.is_some_and(|c| c.blinking)
        {
            self.mark_cursor_row();
        }
        let rows = [old.selection, overlay.selection]
            .into_iter()
            .flatten()
            .flat_map(|s| s.rows().take_while(|&y| y < self.rows));
        for y in rows.collect::<std::collections::BTreeSet<_>>() {
            let covers = |s: Option<Selection>, x| s.is_some_and(|s| s.contains(x, y));
            if (0..self.cols).any(|x| covers(old.selection, x) != covers(overlay.selection, x)) {
                self.mark_row(y);
            }
        }
    }

    pub fn invalidate(&mut self) {
        self.dirty.fill(true);
    }

    /// Device loss: the copy is dropped, so the next incremental frame is refused.
    pub fn forget(&mut self) {
        *self = Self {
            overlay: self.overlay,
            ..Self::default()
        };
    }

    /// Rows to redraw, ascending; clears the marks.
    pub fn take_dirty(&mut self) -> Vec<u16> {
        let rows = (0..self.rows)
            .filter(|&y| self.dirty[usize::from(y)])
            .collect();
        self.dirty.fill(false);
        rows
    }

    /// Whether the cursor is visible on the grid and blinking, so its phase changes the picture.
    pub fn cursor_blinks(&self) -> bool {
        self.cursor.is_some_and(|c| {
            c.visible
                && c.blinking
                && c.viewport
                    .is_some_and(|at| at.x < self.cols && at.y < self.rows)
        })
    }

    /// The cursor as it should be painted now: `(column, row, style)`, `cells` wide. A cursor on
    /// the tail of a wide character is painted on the whole character.
    pub fn visible_cursor(&self) -> Option<(u16, u16, CursorVisualStyle)> {
        let cursor = self
            .cursor
            .filter(|c| c.visible && (!c.blinking || self.overlay.cursor_phase_on))?;
        let at = cursor
            .viewport
            .filter(|at| at.x < self.cols && at.y < self.rows)?;
        Some((
            at.x - u16::from(at.wide_tail && at.x > 0),
            at.y,
            cursor.visual_style,
        ))
    }

    /// Whether the cell is inside the selection; the two halves of a wide character count together.
    pub fn is_selected(&self, col: u16, row: u16) -> bool {
        let Some(selection) = self.overlay.selection else {
            return false;
        };
        let Some(cell) = self.row(row).get(usize::from(col)) else {
            return false;
        };
        let (a, b) = match cell.wide {
            CellWide::Wide => (col, col + 1),
            CellWide::SpacerTail if col > 0 => (col - 1, col),
            _ => (col, col),
        };
        selection.contains(a, row) || selection.contains(b, row)
    }

    fn mark_row(&mut self, y: u16) {
        if let Some(mark) = self.dirty.get_mut(usize::from(y)) {
            *mark = true;
        }
    }

    fn mark_cursor_row(&mut self) {
        if let Some(at) = self.cursor.and_then(|c| c.viewport) {
            self.mark_row(at.y);
        }
    }
}

fn blank() -> Cell {
    Cell {
        text: String::new(),
        wide: CellWide::Narrow,
        fg: None,
        bg: None,
        style: Default::default(),
    }
}
