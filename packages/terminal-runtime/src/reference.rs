//! CPU reference renderer (#1322): deterministic pixels from a [`Frame`] stream, for golden-image
//! tests that need no GPU, font or platform. Integer arithmetic only, so every host produces the
//! same bytes.
//!
//! It rasterizes the draws that [`crate::layout::row_draws`] decides for every renderer: cell
//! placement, wide and combining clusters, colors (default, inverse, faint, invisible), underline
//! styles, strikethrough, overline, cursor styles and the selection. It deliberately draws no
//! typography: each grapheme cluster becomes a 5x7 dot pattern derived from its text
//! ([`crate::layout::glyph_pixels`]), so a wrong cluster, cell or width changes the image without
//! any font being involved. Bold double-strikes the pattern; italic and blink are not drawn.

use crate::frame::Frame;
use crate::layout::{glyph_pixels, row_draws, Draw, Rect};
use crate::render::{
    Appearance, Overlay, RenderError, RenderStats, RendererCore, TerminalRenderer,
};
use ghostty_vt::RgbColor;
use std::collections::BTreeSet;
use std::time::Instant;

/// Bounds the pixel buffers (3 bytes per pixel, two of them).
const MAX_PIXELS: u64 = 1 << 25;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    /// Row-major RGB, 3 bytes per pixel.
    pub rgb: Vec<u8>,
}

impl Image {
    pub fn new(width: u32, height: u32, fill: RgbColor) -> Result<Self, RenderError> {
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
            return Err(RenderError::InvalidSize);
        }
        let rgb = [fill.r, fill.g, fill.b].repeat(width as usize * height as usize);
        Ok(Self { width, height, rgb })
    }

    pub fn pixel(&self, x: u32, y: u32) -> RgbColor {
        let at = (y as usize * self.width as usize + x as usize) * 3;
        RgbColor {
            r: self.rgb[at],
            g: self.rgb[at + 1],
            b: self.rgb[at + 2],
        }
    }

    fn fill_rect(&mut self, x: u32, y: u32, w: u32, h: u32, color: RgbColor) {
        for py in y..(y + h).min(self.height) {
            for px in x..(x + w).min(self.width) {
                let at = (py as usize * self.width as usize + px as usize) * 3;
                self.rgb[at..at + 3].copy_from_slice(&[color.r, color.g, color.b]);
            }
        }
    }

    /// Copy whole pixel rows `y..y + h` from an image of the same size; returns the bytes copied.
    fn copy_rows(&mut self, from: &Image, y: u32, h: u32) -> usize {
        let stride = self.width as usize * 3;
        // A grid taller than the surface (a resize that has not reached the grid yet) clips here.
        let range =
            (y.min(self.height) as usize * stride)..((y + h).min(self.height) as usize * stride);
        self.rgb[range.clone()].copy_from_slice(&from.rgb[range.clone()]);
        range.len()
    }
}

pub struct ReferenceRenderer {
    core: RendererCore,
    /// Where `draw` paints; `present` copies the drawn rows to `surface`.
    back: Image,
    surface: Image,
    /// Grid rows drawn since the last `present`, or everything after a full repaint.
    undelivered: BTreeSet<u16>,
    all_undelivered: bool,
}

impl ReferenceRenderer {
    /// What `present` has delivered so far.
    pub fn surface(&self) -> &Image {
        &self.surface
    }

    /// Simulate GPU device loss: the screen copy is gone and every call but `resume`, `destroy`
    /// and `stats` reports [`RenderError::DeviceLost`] until `resume`.
    pub fn lose_device(&mut self) {
        self.core.lose_device();
        self.undelivered.clear();
        self.all_undelivered = false;
    }
}

impl TerminalRenderer for ReferenceRenderer {
    type Surface = Image;

    fn create(surface: Image, appearance: Appearance) -> Result<Self, RenderError> {
        // `Image` has public fields: refuse what `Image::new` would never build.
        let pixels = u64::from(surface.width) * u64::from(surface.height);
        if pixels == 0 || pixels > MAX_PIXELS || surface.rgb.len() as u64 != pixels * 3 {
            return Err(RenderError::InvalidSize);
        }
        Ok(Self {
            core: RendererCore::new(appearance)?,
            back: surface.clone(),
            surface,
            undelivered: BTreeSet::new(),
            all_undelivered: false,
        })
    }

    fn set_appearance(&mut self, appearance: Appearance) -> Result<(), RenderError> {
        self.core.set_appearance(appearance)
    }

    fn resize(&mut self, width: u32, height: u32) -> Result<(), RenderError> {
        self.core.live()?;
        let bg = self.core.appearance.theme.background;
        self.back = Image::new(width, height, bg)?;
        self.surface = Image::new(width, height, bg)?;
        self.core.repaint();
        Ok(())
    }

    fn apply(&mut self, frame: &Frame) -> Result<(), RenderError> {
        self.core.apply(frame)
    }

    fn set_overlay(&mut self, overlay: Overlay) -> Result<(), RenderError> {
        self.core.set_overlay(overlay)
    }

    fn draw(&mut self) -> Result<u32, RenderError> {
        let started = Instant::now();
        let Some(plan) = self.core.begin_draw()? else {
            return Ok(0);
        };
        let (bg, cell_height) = (
            self.core.appearance.theme.background,
            self.core.appearance.metrics.cell_height,
        );
        if plan.repaint_all {
            self.back
                .fill_rect(0, 0, self.back.width, self.back.height, bg);
            self.all_undelivered = true;
        }
        for &y in &plan.rows {
            self.back.fill_rect(
                0,
                u32::from(y) * cell_height,
                self.back.width,
                cell_height,
                bg,
            );
            self.draw_row(y);
            self.undelivered.insert(y);
        }
        Ok(self.core.finish_draw(&plan, started))
    }

    fn present(&mut self) -> Result<(), RenderError> {
        if !self.core.begin_present()? {
            return Ok(());
        }
        if !self.all_undelivered && self.undelivered.is_empty() {
            return Ok(());
        }
        let started = Instant::now();
        let bytes = if std::mem::take(&mut self.all_undelivered) {
            self.surface.rgb.copy_from_slice(&self.back.rgb);
            self.surface.rgb.len()
        } else {
            let h = self.core.appearance.metrics.cell_height;
            let rows = std::mem::take(&mut self.undelivered);
            rows.iter()
                .map(|&y| self.surface.copy_rows(&self.back, u32::from(y) * h, h))
                .sum()
        };
        self.undelivered.clear();
        self.core.finish_present(bytes as u64, started);
        Ok(())
    }

    fn suspend(&mut self) {
        self.core.suspend();
    }

    fn resume(&mut self) -> Result<(), RenderError> {
        self.core.resume().map(drop)
    }

    fn destroy(&mut self) {
        self.core.destroy();
        for image in [&mut self.back, &mut self.surface] {
            *image = Image {
                width: 0,
                height: 0,
                rgb: Vec::new(),
            };
        }
    }

    fn stats(&self) -> RenderStats {
        self.core.stats
    }
}

impl ReferenceRenderer {
    /// Rasterize the shared layout of row `y` over the cleared row.
    fn draw_row(&mut self, y: u16) {
        let m = self.core.appearance.metrics;
        for draw in row_draws(&self.core.screen, y, &self.core.appearance) {
            match draw {
                Draw::Rect(Rect { x, y, w, h, color }) => self.back.fill_rect(x, y, w, h, color),
                Draw::Glyph(g) => {
                    for (px, py, w) in glyph_pixels(m, g.cells, g.text, g.bold) {
                        self.back.fill_rect(g.x + px, g.y + py, w, 1, g.color);
                    }
                }
            }
        }
    }
}
