//! The probe's pixel arithmetic, free of any windowing so it is tested off Windows too.
use std::{fs::File, io::BufWriter, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    /// A rectangle the page measured in CSS pixels, in device pixels.
    pub fn from_css(css: [f64; 4], dpr: f64) -> Self {
        let device = |v: f64| (v * dpr).round() as i32;
        Self {
            x: device(css[0]),
            y: device(css[1]),
            w: device(css[2]),
            h: device(css[3]),
        }
    }

    pub fn area(self) -> usize {
        self.w.max(0) as usize * self.h.max(0) as usize
    }

    pub fn overlap(self, other: Self) -> Self {
        let (x, y) = (self.x.max(other.x), self.y.max(other.y));
        Self {
            x,
            y,
            w: (self.x + self.w).min(other.x + other.w) - x,
            h: (self.y + self.h).min(other.y + other.h) - y,
        }
    }
}

pub const RED: [u8; 3] = [255, 0, 0];
/// Per channel; the readbacks of a composited window are exact when nothing blends, and this only absorbs rounding.
const TOLERANCE: i32 = 2;

/// A readback of the window's client area, top-down BGRA as GDI delivers it.
pub struct Frame {
    pub w: usize,
    pub h: usize,
    pub bgra: Vec<u8>,
}

impl Frame {
    pub fn rgb(&self, x: i32, y: i32) -> Option<[u8; 3]> {
        let inside = (0..self.w as i32).contains(&x) && (0..self.h as i32).contains(&y);
        inside.then(|| {
            let i = (y as usize * self.w + x as usize) * 4;
            [self.bgra[i + 2], self.bgra[i + 1], self.bgra[i]]
        })
    }

    /// How many pixels are the colour, and the box around them.
    pub fn find(&self, rgb: [u8; 3]) -> (usize, Option<Rect>) {
        let near =
            |p: &[u8]| (0..3).all(|c| (i32::from(p[2 - c]) - i32::from(rgb[c])).abs() <= TOLERANCE);
        let (mut n, mut lo, mut hi) = (0, (i32::MAX, i32::MAX), (-1, -1));
        for (i, _) in self
            .bgra
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, p)| near(p))
        {
            let (x, y) = ((i % self.w) as i32, (i / self.w) as i32);
            (n, lo, hi) = (
                n + 1,
                (lo.0.min(x), lo.1.min(y)),
                (hi.0.max(x), hi.1.max(y)),
            );
        }
        (
            n,
            (n > 0).then(|| Rect {
                x: lo.0,
                y: lo.1,
                w: hi.0 - lo.0 + 1,
                h: hi.1 - lo.1 + 1,
            }),
        )
    }

    pub fn save_png(&self, path: &Path) -> Result<(), String> {
        let mut encoder = png::Encoder::new(
            BufWriter::new(File::create(path).map_err(|e| e.to_string())?),
            self.w as u32,
            self.h as u32,
        );
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let rgba: Vec<u8> = self
            .bgra
            .chunks_exact(4)
            .flat_map(|p| [p[2], p[1], p[0], 255])
            .collect();
        encoder
            .write_header()
            .and_then(|mut w| w.write_image_data(&rgba))
            .map_err(|e| e.to_string())
    }
}

/// What one readback shows against what the page and the host asked for.
#[derive(Debug)]
pub struct Judgement {
    /// Pixels of the surface's colour: found, and expected when the surface sits at the anchor with the overlay over it.
    pub child: usize,
    pub child_expected: usize,
    pub child_box: Option<Rect>,
    pub anchor: Rect,
    /// Pixels of the page's red overlay: found, and its area, which they equal while nothing covers it.
    pub overlay: usize,
    pub overlay_area: usize,
    /// The pixel at the anchor's centre: what a user sees where the surface should be.
    pub centre: Option<[u8; 3]>,
}

impl Judgement {
    /// The surface shows exactly at the anchor, or, when none is expected, none of its colour shows.
    pub fn placed(&self) -> bool {
        self.child == self.child_expected
            && self.child_box == (self.child_expected > 0).then_some(self.anchor)
    }

    /// The page's overlay is drawn in full, over the surface.
    pub fn overlay_on_top(&self) -> bool {
        self.overlay == self.overlay_area
    }
}

/// `colour` is the surface's colour; `shown` says whether a surface should be on screen at the anchor.
pub fn judge(
    frame: &Frame,
    anchor: Rect,
    overlay: Rect,
    colour: [u8; 3],
    shown: bool,
) -> Judgement {
    let (child, child_box) = frame.find(colour);
    Judgement {
        child,
        child_expected: if shown {
            anchor.area() - anchor.overlap(overlay).area()
        } else {
            0
        },
        child_box,
        anchor,
        overlay: frame.find(RED).0,
        overlay_area: overlay.area(),
        centre: frame.rgb(anchor.x + anchor.w / 2, anchor.y + anchor.h / 2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GREEN: [u8; 3] = [0, 200, 0];
    const ANCHOR: Rect = Rect {
        x: 60,
        y: 40,
        w: 240,
        h: 160,
    };
    const OVERLAY: Rect = Rect {
        x: 200,
        y: 120,
        w: 140,
        h: 100,
    };

    /// A 400x260 window: `paint` lists rectangles in order, later ones over earlier ones, on a black background.
    fn frame(paint: &[(Rect, [u8; 3])]) -> Frame {
        let mut bgra = vec![0u8; 400 * 260 * 4];
        for (r, rgb) in paint {
            for y in r.y..r.y + r.h {
                for x in r.x..r.x + r.w {
                    bgra[(y as usize * 400 + x as usize) * 4..][..3]
                        .copy_from_slice(&[rgb[2], rgb[1], rgb[0]]);
                }
            }
        }
        Frame {
            w: 400,
            h: 260,
            bgra,
        }
    }

    #[test]
    fn judges_where_the_surface_and_the_overlay_show() {
        let shown = judge(
            &frame(&[(ANCHOR, GREEN), (OVERLAY, RED)]),
            ANCHOR,
            OVERLAY,
            GREEN,
            true,
        );
        assert!(shown.placed() && shown.overlay_on_top(), "{shown:?}");
        assert_eq!(shown.centre, Some(GREEN));

        // The web view paints over the surface: the page is intact and none of the surface reaches the screen.
        let hidden = judge(&frame(&[(OVERLAY, RED)]), ANCHOR, OVERLAY, GREEN, true);
        assert!(
            !hidden.placed() && hidden.overlay_on_top() && hidden.child == 0,
            "{hidden:?}"
        );
        assert_eq!(hidden.centre, Some([0, 0, 0]));

        // The surface is on top without a cut-out: it covers the part of the overlay inside the anchor.
        let covering = judge(
            &frame(&[(OVERLAY, RED), (ANCHOR, GREEN)]),
            ANCHOR,
            OVERLAY,
            GREEN,
            true,
        );
        assert!(
            !covering.placed() && !covering.overlay_on_top(),
            "{covering:?}"
        );

        // A destroyed surface leaves nothing; a surface left behind is seen.
        assert!(judge(&frame(&[(OVERLAY, RED)]), ANCHOR, OVERLAY, GREEN, false).placed());
        assert!(!judge(
            &frame(&[(ANCHOR, GREEN), (OVERLAY, RED)]),
            ANCHOR,
            OVERLAY,
            GREEN,
            false
        )
        .placed());
    }

    #[test]
    fn scales_css_rectangles_to_device_pixels() {
        assert_eq!(
            Rect::from_css([60.0, 40.0, 240.0, 160.0], 1.5),
            Rect {
                x: 90,
                y: 60,
                w: 360,
                h: 240
            }
        );
        assert_eq!(ANCHOR.overlap(OVERLAY).area(), 100 * 80);
        assert_eq!(
            ANCHOR
                .overlap(Rect {
                    x: 500,
                    y: 0,
                    w: 10,
                    h: 10
                })
                .area(),
            0
        );
    }
}
