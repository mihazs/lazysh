//! What rasterizing a terminal glyph costs when the rasterizer reports the glyph's extent and the colour is applied
//! by the shader (#1323). xterm.js's WebGL addon instead draws every glyph-and-colour pair into a canvas, reads the
//! canvas back and scans its pixels for the extent; this crate is the other design, measured on the same sizes.
use fontdue::{Font, FontSettings};

/// A coverage mask: one byte per pixel, `width` by `height`, the tight extent of the glyph, placed at (`xmin`, `ymin`) from the pen.
pub struct Mask {
    pub coverage: Vec<u8>,
    pub width: usize,
    pub height: usize,
    pub xmin: i32,
    pub ymin: i32,
}

pub fn load(path: &str) -> Font {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("cannot read font {path}: {e}"));
    Font::from_bytes(bytes, FontSettings::default())
        .unwrap_or_else(|e| panic!("cannot parse font {path}: {e}"))
}

pub fn rasterize(font: &Font, ch: char, px: f32) -> Mask {
    let (m, coverage) = font.rasterize(ch, px);
    Mask {
        coverage,
        width: m.width,
        height: m.height,
        xmin: m.xmin,
        ymin: m.ymin,
    }
}

/// The extent found the way the xterm.js addon finds it: scan the alpha channel for the first and last non-empty row and column. `None` for an empty mask.
pub fn scanned_extent(mask: &Mask) -> Option<(usize, usize, usize, usize)> {
    let at = |x: usize, y: usize| mask.coverage[y * mask.width + x] != 0;
    let rows: Vec<usize> = (0..mask.height)
        .filter(|&y| (0..mask.width).any(|x| at(x, y)))
        .collect();
    let cols: Vec<usize> = (0..mask.width)
        .filter(|&x| (0..mask.height).any(|y| at(x, y)))
        .collect();
    Some((*cols.first()?, *rows.first()?, *cols.last()?, *rows.last()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    const FONT: &str = "/usr/share/fonts/liberation/LiberationMono-Regular.ttf";

    #[test]
    fn the_rasterizer_reports_the_tight_extent_so_no_scan_is_needed() {
        let font = load(FONT);
        for ch in ['A', 'g', '|', '.', '~', 'W'] {
            let mask = rasterize(&font, ch, 42.0);
            assert_eq!(
                scanned_extent(&mask),
                Some((0, 0, mask.width - 1, mask.height - 1)),
                "{ch:?}: the reported extent is not the scanned one"
            );
        }
    }

    #[test]
    fn a_space_has_no_ink_and_a_letter_has() {
        let font = load(FONT);
        assert_eq!(scanned_extent(&rasterize(&font, ' ', 42.0)), None);
        assert!(rasterize(&font, 'A', 42.0)
            .coverage
            .iter()
            .any(|&c| c > 200));
    }
}
