//! Glyph masks from real fonts: face choice with fallback, shaping, rasterization (#1325).
//!
//! Cell widths come from the core, never from the font: a cluster is drawn into the one or two
//! cells the layout gives it, whatever its glyphs' advances are. Per cluster:
//!
//! 1. **Face.** The first family of the stack that has every scalar of the cluster wins, with
//!    emoji presentation (a color face) preferred for emoji clusters and text presentation for the
//!    rest; with none covering it, the family covering the most leading scalars, else the
//!    primary's `.notdef` box, so a missing glyph is visible instead of a hole.
//! 2. **Shape.** `swash` shapes the cluster alone (so no ligature or contextual alternate can
//!    reach across cells) with its script set: base plus combining marks through GPOS, ZWJ and
//!    flag sequences through GSUB.
//! 3. **Fit.** One font size for every face, so rows share a baseline: the primary's advance of
//!    `0` is one cell. A cluster whose advance exceeds its cells is scaled down to fit and one that
//!    falls short is centered, so a fallback face (CJK, symbols) never moves the grid.
//! 4. **Rasterize** unhinted into a mask of the cell run: gray coverage for outlines, RGBA for
//!    color bitmaps and layers. Bold and italic come from the family's own faces; a style it lacks
//!    is synthesized (stronger stroke, slant).

use crate::fonts::{Family, FontLibrary};
use lazysh_terminal_runtime::layout::{glyph_pixels, Glyph};
use lazysh_terminal_runtime::{Appearance, CellMetrics};
use std::time::{Duration, Instant};
use swash::scale::image::{Content, Image};
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::shape::ShapeContext;
use swash::text::{Codepoint, Script};
use swash::zeno::{Angle, Format, Transform, Vector};

/// What a glyph's mask holds, which decides the atlas and the shader path it takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// One byte of coverage per texel, tinted with the cell's text color.
    Mask,
    /// RGBA, drawn as it is (emoji).
    Color,
}

/// Variation selectors 15 and 16: they ask for text or emoji presentation.
fn is_selector(c: char) -> bool {
    matches!(c, '\u{fe0e}' | '\u{fe0f}')
}

/// Scalars that join or select presentation and are never looked up in a font on their own.
fn is_invisible(c: char) -> bool {
    c == '\u{200d}' || is_selector(c)
}

/// Scalars whose default presentation is emoji (`Emoji_Presentation`) below the pictograph blocks.
const EMOJI_BMP: &[(u32, u32)] = &[
    (0x231a, 0x231b),
    (0x23e9, 0x23ec),
    (0x23f0, 0x23f0),
    (0x23f3, 0x23f3),
    (0x25fd, 0x25fe),
    (0x2614, 0x2615),
    (0x2648, 0x2653),
    (0x267f, 0x267f),
    (0x2693, 0x2693),
    (0x26a1, 0x26a1),
    (0x26aa, 0x26ab),
    (0x26bd, 0x26be),
    (0x26c4, 0x26c5),
    (0x26ce, 0x26ce),
    (0x26d4, 0x26d4),
    (0x26ea, 0x26ea),
    (0x26f2, 0x26f3),
    (0x26f5, 0x26f5),
    (0x26fa, 0x26fa),
    (0x26fd, 0x26fd),
    (0x2705, 0x2705),
    (0x270a, 0x270b),
    (0x2728, 0x2728),
    (0x274c, 0x274c),
    (0x274e, 0x274e),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2795, 0x2797),
    (0x27b0, 0x27b0),
    (0x27bf, 0x27bf),
    (0x2b1b, 0x2b1c),
    (0x2b50, 0x2b50),
    (0x2b55, 0x2b55),
];

/// Whether a cluster asks for emoji presentation: U+FE0F, a keycap or an emoji-presentation scalar
/// (the pictograph blocks, regional indicators and the list above), unless U+FE0E asks for text.
/// shortcut: the pictograph blocks hold a few text-default scalars (a thermometer, a hand); they
/// take the emoji face when one is registered. Upgrade with the Unicode emoji data if that shows.
fn wants_emoji(text: &str) -> bool {
    if text.contains('\u{fe0e}') {
        return false;
    }
    text.contains('\u{fe0f}')
        || text.chars().any(|c| {
            let c = u32::from(c);
            (0x1f300..=0x1faff).contains(&c)
                || (0x1f1e6..=0x1f1ff).contains(&c)
                || c == 0x20e3
                || EMOJI_BMP.iter().any(|&(a, b)| (a..=b).contains(&c))
        })
}

/// The glyph a face draws for `.notdef`: the primary's missing-glyph box.
const NOTDEF: u16 = 0;

struct Placed {
    id: u16,
    x: f32,
    y: f32,
}

/// Rasterizes clusters at one cell size with one font stack. Lives beside the device, not in it, so
/// a lost device does not cost the fonts.
pub(crate) struct Rasterizer {
    stack: Vec<Family>,
    /// The family that sets the metrics and draws what nothing covers: the first one with no
    /// range limit (a CJK font limited to CJK ranges cannot size the cell).
    primary: usize,
    /// Em size in pixels: the primary's advance of `0` is one cell.
    size: f32,
    /// Rows from the top of the cell to the baseline.
    baseline: f32,
    scale: ScaleContext,
    shape: ShapeContext,
    image: Image,
    placed: Vec<Placed>,
    /// Time spent choosing, shaping and rasterizing, cumulative.
    pub time: Duration,
}

impl Rasterizer {
    /// `None` when the library has no font to draw with.
    fn new(fonts: &FontLibrary, appearance: &Appearance) -> Option<Self> {
        let stack = fonts.stack(&appearance.font_families);
        let index = stack.iter().position(Family::is_unrestricted).unwrap_or(0);
        let primary = stack.get(index)?.pick(false, false).face.font();
        let upem = f32::from(primary.metrics(&[]).units_per_em);
        let gm = primary.glyph_metrics(&[]);
        let zero = primary.charmap().map('0');
        let advance = [zero, primary.charmap().map(' ')]
            .into_iter()
            .map(|g| gm.advance_width(g))
            .find(|a| *a > 0.0)
            .unwrap_or(0.6 * upem);
        let m = appearance.metrics;
        let size = m.cell_width as f32 * upem / advance;
        let v = primary.metrics(&[]).scale(size);
        let top = (m.cell_height as f32 - (v.ascent + v.descent)) / 2.0;
        Some(Self {
            stack,
            primary: index,
            size,
            baseline: (top + v.ascent).round().clamp(0.0, m.cell_height as f32),
            scale: ScaleContext::new(),
            shape: ShapeContext::new(),
            image: Image::new(),
            placed: Vec::new(),
            time: Duration::ZERO,
        })
    }

    /// The face for a cluster: the first family with every scalar, of the presentation it asks
    /// for if there is one.
    fn choose(&self, text: &str, bold: bool, italic: bool) -> (usize, bool) {
        let needed = || text.chars().filter(|c| !is_invisible(*c));
        let total = needed().count();
        let emoji = wants_emoji(text);
        let (mut any, mut partial) = (None, None);
        let mut best = 0;
        for (i, family) in self.stack.iter().enumerate() {
            let face = family.pick(bold, italic).face;
            let have = needed()
                .take_while(|c| family.allows(*c) && face.has(*c))
                .count();
            if have == total && total > 0 {
                if face.color == emoji {
                    return (i, face.color);
                }
                any.get_or_insert((i, face.color));
            } else if have > best {
                (best, partial) = (have, Some((i, face.color)));
            }
        }
        any.or(partial).unwrap_or((self.primary, false))
    }

    fn kind(&self, text: &str, bold: bool, italic: bool) -> Kind {
        if self.choose(text, bold, italic).1 {
            Kind::Color
        } else {
            Kind::Mask
        }
    }

    /// Draw `text` into `cells` cells of `m` and put the mask in `out`: `cells * width * height`
    /// bytes for [`Kind::Mask`], four times that for [`Kind::Color`].
    fn render(&mut self, m: CellMetrics, g: &Glyph<'_>, out: &mut Vec<u8>) -> Kind {
        let started = Instant::now();
        let (w, h) = ((g.cells * m.cell_width) as usize, m.cell_height as usize);
        let (family, color) = self.choose(g.text, g.bold, g.italic);
        let kind = if color { Kind::Color } else { Kind::Mask };
        let texel = if color { 4 } else { 1 };
        out.clear();
        out.resize(w * h * texel, 0);

        let Self {
            stack,
            size,
            baseline,
            scale,
            shape,
            image,
            placed,
            ..
        } = self;
        let pick = stack[family].pick(g.bold, g.italic);
        let font = pick.face.font();
        let script = g
            .text
            .chars()
            .map(|c| c.script())
            .find(|s| !matches!(s, Script::Common | Script::Inherited | Script::Unknown))
            .unwrap_or(Script::Latin);
        // A variation selector the face does not map would shape to a glyph of its own and break
        // the ligature around it (the keycap of `1 U+FE0F U+20E3`): it only chose the face.
        let text: std::borrow::Cow<str> =
            if g.text.chars().any(|c| is_selector(c) && !pick.face.has(c)) {
                g.text
                    .chars()
                    .filter(|c| !is_selector(*c) || pick.face.has(*c))
                    .collect()
            } else {
                g.text.into()
            };
        placed.clear();
        let mut pen = 0.0f32;
        let mut shaper = shape.builder(font).script(script).size(*size).build();
        shaper.add_str(&text);
        shaper.shape_with(|cluster| {
            for glyph in cluster.glyphs {
                placed.push(Placed {
                    id: glyph.id,
                    x: pen + glyph.x,
                    y: glyph.y,
                });
                pen += glyph.advance;
            }
        });
        if placed.is_empty() {
            placed.push(Placed {
                id: NOTDEF,
                x: 0.0,
                y: 0.0,
            });
        }

        // Fit the advance to the cells: shrink what is wider, center what is narrower.
        let cells_px = w as f32;
        let fit = if pen > cells_px + 0.5 {
            cells_px / pen
        } else {
            1.0
        };
        let left = if (cells_px - pen * fit).abs() < 0.5 {
            0.0
        } else {
            (cells_px - pen * fit) / 2.0
        };
        let size = *size * fit;
        let sources: &[Source] = if color {
            &[
                Source::ColorOutline(0),
                Source::ColorBitmap(StrikeWith::BestFit),
            ]
        } else {
            &[Source::Outline]
        };
        let mut scaler = scale.builder(font).size(size).hint(false).build();
        for glyph in placed.iter() {
            let x = left + glyph.x * fit;
            let (ix, fx) = (x.floor(), x - x.floor());
            let iy = (*baseline - glyph.y * fit).round();
            let mut render = Render::new(sources);
            render.format(Format::Alpha).offset(Vector::new(fx, 0.0));
            if pick.synthetic_bold {
                render.embolden(size / 40.0);
            }
            if pick.synthetic_italic {
                render.transform(Some(Transform::skew(
                    Angle::from_degrees(14.0),
                    Angle::from_degrees(0.0),
                )));
            }
            // `render_into` resizes the buffer but leaves what it held: a stale glyph would show.
            image.clear();
            if !render.render_into(&mut scaler, glyph.id, image) {
                continue;
            }
            let p = image.placement;
            let (ox, oy) = (ix as i64 + i64::from(p.left), iy as i64 - i64::from(p.top));
            blit(out, (w, h), (ox, oy), image, kind);
        }
        self.time += started.elapsed();
        kind
    }
}

/// Composite a rendered glyph into the cluster's mask, clipped to the cells.
fn blit(out: &mut [u8], (w, h): (usize, usize), (ox, oy): (i64, i64), image: &Image, kind: Kind) {
    let (iw, ih) = (
        image.placement.width as usize,
        image.placement.height as usize,
    );
    for sy in 0..ih {
        let dy = oy + sy as i64;
        if dy < 0 || dy >= h as i64 {
            continue;
        }
        for sx in 0..iw {
            let dx = ox + sx as i64;
            if dx < 0 || dx >= w as i64 {
                continue;
            }
            let at = dy as usize * w + dx as usize;
            match (kind, image.content) {
                (Kind::Mask, Content::Mask) => {
                    let (s, d) = (u32::from(image.data[sy * iw + sx]), u32::from(out[at]));
                    out[at] = (s + d - (s * d + 127) / 255) as u8;
                }
                (Kind::Color, Content::Color) => {
                    let s = &image.data[(sy * iw + sx) * 4..][..4];
                    over(&mut out[at * 4..][..4], s);
                }
                _ => {}
            }
        }
    }
}

/// `src` over `dst`, both straight (not premultiplied) RGBA.
fn over(dst: &mut [u8], src: &[u8]) {
    let (sa, da) = (u32::from(src[3]), u32::from(dst[3]));
    let out_a = sa * 255 + da * (255 - sa);
    if out_a == 0 {
        return;
    }
    for i in 0..3 {
        let c = u32::from(src[i]) * sa * 255 + u32::from(dst[i]) * da * (255 - sa);
        dst[i] = (c / out_a) as u8;
    }
    dst[3] = ((out_a + 127) / 255) as u8;
}

/// How a renderer gets glyph masks: the reference dot patterns of the layout, or real fonts.
pub(crate) enum Glyphs {
    Dots,
    Fonts(Box<Rasterizer>),
}

impl Glyphs {
    /// Real fonts when the library has any, else the dot patterns.
    pub fn new(fonts: Option<&FontLibrary>, appearance: &Appearance) -> Self {
        fonts
            .and_then(|f| Rasterizer::new(f, appearance))
            .map_or(Self::Dots, |r| Self::Fonts(Box::new(r)))
    }

    pub fn kind(&self, g: &Glyph<'_>) -> Kind {
        match self {
            Self::Dots => Kind::Mask,
            Self::Fonts(r) => r.kind(g.text, g.bold, g.italic),
        }
    }

    pub fn render(&mut self, m: CellMetrics, g: &Glyph<'_>, out: &mut Vec<u8>) -> Kind {
        match self {
            Self::Dots => {
                let w = (g.cells * m.cell_width) as usize;
                out.clear();
                out.resize(w * m.cell_height as usize, 0);
                for (px, py, run) in glyph_pixels(m, g.cells, g.text, g.bold) {
                    let from = py as usize * w + px as usize;
                    out[from..from + run as usize].fill(255);
                }
                Kind::Mask
            }
            Self::Fonts(r) => r.render(m, g, out),
        }
    }

    /// Time spent in fonts so far.
    pub fn time(&self) -> Duration {
        match self {
            Self::Dots => Duration::ZERO,
            Self::Fonts(r) => r.time,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emoji_presentation_is_asked_for_by_scalar_selector_or_sequence() {
        for yes in [
            "😀",
            "👨\u{200d}👩\u{200d}👧",
            "🇧🇷",
            "❤\u{fe0f}",
            "1\u{fe0f}\u{20e3}",
            "⚡",
        ] {
            assert!(wants_emoji(yes), "{yes:?}");
        }
        for no in ["a", "é", "漢", "❤", "❤\u{fe0e}", "★", "e\u{301}"] {
            assert!(!wants_emoji(no), "{no:?}");
        }
    }
}
