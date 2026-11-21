//! Pixel arithmetic of the macOS surface probe (#1333). Platform-neutral, so its tests run on any host: the probe itself is
//! macOS only, and what it measures is a capture of its own window, never what it believes it drew.

/// An axis-aligned rectangle in device pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

impl Rect {
    pub fn new(x: i64, y: i64, w: i64, h: i64) -> Self {
        Self { x, y, w, h }
    }

    /// The rectangle a CSS-pixel box covers in a capture whose page origin is `origin` and whose scale is `scale` device pixels per CSS pixel.
    pub fn from_css(css: [f64; 4], origin: (i64, i64), scale: f64) -> Self {
        let edge = |v: f64| (v * scale).round() as i64;
        Self::new(
            origin.0 + edge(css[0]),
            origin.1 + edge(css[1]),
            edge(css[2]),
            edge(css[3]),
        )
    }

    /// The largest difference, in pixels, between any of the four edges of two rectangles.
    pub fn error(&self, other: &Rect) -> i64 {
        [
            self.x - other.x,
            self.y - other.y,
            (self.x + self.w) - (other.x + other.w),
            (self.y + self.h) - (other.y + other.h),
        ]
        .into_iter()
        .map(i64::abs)
        .max()
        .unwrap_or(0)
    }

    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let (x0, y0) = (self.x.max(other.x), self.y.max(other.y));
        let x1 = (self.x + self.w).min(other.x + other.w);
        let y1 = (self.y + self.h).min(other.y + other.h);
        (x1 > x0 && y1 > y0).then(|| Rect::new(x0, y0, x1 - x0, y1 - y0))
    }

    pub fn center(&self) -> (i64, i64) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }
}

/// A captured window: RGBA, 8 bits per channel, rows packed. Alpha is premultiplied as the window server hands it out, which equals
/// the straight value wherever alpha is 255 and keeps every transparent pixel at exactly zero.
#[derive(Clone, Debug)]
pub struct Raster {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

/// How the four bytes of a captured pixel are laid out in memory.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Layout {
    Bgra,
    Argb,
    Rgba,
}

impl Raster {
    pub fn new(width: usize, height: usize, fill: [u8; 4]) -> Self {
        Self {
            width,
            height,
            rgba: fill.repeat(width * height),
        }
    }

    /// Converts a capture with `stride` bytes per row. `None` when the buffer is too small for its stated size.
    pub fn from_capture(
        width: usize,
        height: usize,
        stride: usize,
        layout: Layout,
        data: &[u8],
    ) -> Option<Self> {
        if stride < width * 4 || data.len() < stride * height {
            return None;
        }
        let mut rgba = Vec::with_capacity(width * height * 4);
        for row in data.chunks(stride).take(height) {
            for p in row[..width * 4].chunks_exact(4) {
                rgba.extend_from_slice(&match layout {
                    Layout::Bgra => [p[2], p[1], p[0], p[3]],
                    Layout::Argb => [p[1], p[2], p[3], p[0]],
                    Layout::Rgba => [p[0], p[1], p[2], p[3]],
                });
            }
        }
        Some(Self {
            width,
            height,
            rgba,
        })
    }

    /// The pixel at (x, y), or `None` outside the raster.
    pub fn get(&self, x: i64, y: i64) -> Option<[u8; 4]> {
        if x < 0 || y < 0 || x as usize >= self.width || y as usize >= self.height {
            return None;
        }
        let i = (y as usize * self.width + x as usize) * 4;
        Some([
            self.rgba[i],
            self.rgba[i + 1],
            self.rgba[i + 2],
            self.rgba[i + 3],
        ])
    }

    /// The pixel at (x, y); outside the raster it reads as transparent, so a rectangle that sticks out never panics.
    pub fn px(&self, x: i64, y: i64) -> [u8; 4] {
        self.get(x, y).unwrap_or([0; 4])
    }

    pub fn set(&mut self, x: usize, y: usize, rgba: [u8; 4]) {
        let i = (y * self.width + x) * 4;
        self.rgba[i..i + 4].copy_from_slice(&rgba);
    }

    pub fn fill(&mut self, rect: Rect, rgba: [u8; 4]) {
        for y in rect.y.max(0)..(rect.y + rect.h).min(self.height as i64) {
            for x in rect.x.max(0)..(rect.x + rect.w).min(self.width as i64) {
                self.set(x as usize, y as usize, rgba);
            }
        }
    }

    /// The bounding box of the pixels `wanted` accepts, and how many there are.
    pub fn find_where(&self, wanted: impl Fn([u8; 4]) -> bool) -> Option<(Rect, usize)> {
        let mut found = Region::default();
        for y in 0..self.height {
            for x in 0..self.width {
                if wanted(self.px(x as i64, y as i64)) {
                    found.add(x, y);
                }
            }
        }
        found.finish()
    }

    /// The bounding box and size of the largest 4-connected region of pixels `wanted` accepts: a large box is not confused with
    /// a stray pixel of the same colour elsewhere in the window (the title bar's close button is red too).
    pub fn largest_region(&self, wanted: impl Fn([u8; 4]) -> bool) -> Option<(Rect, usize)> {
        let (w, h) = (self.width, self.height);
        let mut seen = vec![false; w * h];
        let mut best: Option<(Rect, usize)> = None;
        for start in 0..w * h {
            if seen[start] || !wanted(self.px((start % w) as i64, (start / w) as i64)) {
                continue;
            }
            let mut region = Region::default();
            let mut stack = vec![start];
            seen[start] = true;
            while let Some(i) = stack.pop() {
                let (x, y) = (i % w, i / w);
                region.add(x, y);
                let neighbours = [
                    (x > 0).then(|| i - 1),
                    (x + 1 < w).then(|| i + 1),
                    (y > 0).then(|| i - w),
                    (y + 1 < h).then(|| i + w),
                ];
                for n in neighbours.into_iter().flatten() {
                    if !seen[n] && wanted(self.px((n % w) as i64, (n / w) as i64)) {
                        seen[n] = true;
                        stack.push(n);
                    }
                }
            }
            let found = region.finish();
            if found.is_some_and(|(_, n)| best.is_none_or(|(_, m)| n > m)) {
                best = found;
            }
        }
        best
    }

    /// The bounding box of the opaque pixels within `tolerance` of `color` (per channel), and how many there are.
    pub fn find_color(&self, color: [u8; 3], tolerance: u8) -> Option<(Rect, usize)> {
        self.find_where(|px| is_color(px, color, tolerance))
    }

    /// Whether every pixel of `rect` is accepted by `wanted`.
    pub fn all_where(&self, rect: Rect, wanted: impl Fn([u8; 4]) -> bool) -> bool {
        (rect.y..rect.y + rect.h).all(|y| (rect.x..rect.x + rect.w).all(|x| wanted(self.px(x, y))))
    }
}

/// A bounding box under construction.
struct Region {
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    n: usize,
}

impl Default for Region {
    fn default() -> Self {
        Self {
            x0: usize::MAX,
            y0: usize::MAX,
            x1: 0,
            y1: 0,
            n: 0,
        }
    }
}

impl Region {
    fn add(&mut self, x: usize, y: usize) {
        (self.x0, self.y0) = (self.x0.min(x), self.y0.min(y));
        (self.x1, self.y1) = (self.x1.max(x), self.y1.max(y));
        self.n += 1;
    }

    fn finish(&self) -> Option<(Rect, usize)> {
        (self.n > 0).then(|| {
            let (x, y) = (self.x0 as i64, self.y0 as i64);
            (
                Rect::new(x, y, self.x1 as i64 - x + 1, self.y1 as i64 - y + 1),
                self.n,
            )
        })
    }
}

/// An opaque pixel within `tolerance` of `color` in every channel.
pub fn is_color(px: [u8; 4], color: [u8; 3], tolerance: u8) -> bool {
    px[3] == 255
        && (0..3).all(|i| {
            (i16::from(px[i]) - i16::from(color[i])).unsigned_abs() <= u16::from(tolerance)
        })
}

/// The DOM box's red (#f00) as the window server may show it: colour matching to the display can move it toward orange, and
/// the title bar's close button (about 255, 95, 87) must not count.
pub fn is_red(px: [u8; 4]) -> bool {
    px[3] == 255 && px[0] >= 200 && px[1] <= 70 && px[2] <= 70
}

/// The page origin in the capture: where the DOM overlay's red box starts, less where the page puts it. This measures what the
/// page shows, so the window's title bar and any inset the window system adds need no assumption.
pub fn page_origin(raster: &Raster, overlay_css: [f64; 4], scale: f64) -> Option<(i64, i64)> {
    let (found, _) = raster.largest_region(is_red)?;
    let at = Rect::from_css(overlay_css, (0, 0), scale);
    // The title bar's close button is red too: only a region of the box's size is the box.
    let is_the_box = (found.w - at.w).abs() <= 2 && (found.h - at.h).abs() <= 2;
    is_the_box.then_some((found.x - at.x, found.y - at.y))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OVERLAY: [f64; 4] = [200.0, 120.0, 140.0, 100.0];
    const ANCHOR: [f64; 4] = [60.0, 40.0, 240.0, 160.0];
    const BLUE: [u8; 3] = [51, 102, 255];

    /// A window the way the probe sees it: a transparent page at `origin`, a surface of `color` at the anchor and the red DOM box on
    /// top of it (`box_on_top`) or hidden by it.
    fn window(scale: f64, origin: (i64, i64), color: [u8; 3], box_on_top: bool) -> Raster {
        let mut r = Raster::new((640.0 * scale) as usize, (400.0 * scale) as usize, [0; 4]);
        let paint = |r: &mut Raster, css: [f64; 4], c: [u8; 3]| {
            r.fill(Rect::from_css(css, origin, scale), [c[0], c[1], c[2], 255])
        };
        let (first, second) = if box_on_top {
            (ANCHOR, OVERLAY)
        } else {
            (OVERLAY, ANCHOR)
        };
        paint(&mut r, first, if box_on_top { color } else { [255, 0, 0] });
        paint(&mut r, second, if box_on_top { [255, 0, 0] } else { color });
        r
    }

    #[test]
    fn a_surface_below_a_dom_box_is_found_exactly_at_one_and_two_x() {
        for scale in [1.0, 2.0] {
            let origin = (0, (28.0 * scale) as i64);
            let r = window(scale, origin, BLUE, true);
            assert_eq!(page_origin(&r, OVERLAY, scale), Some(origin));
            let (found, n) = r.find_color(BLUE, 6).unwrap();
            let want = Rect::from_css(ANCHOR, origin, scale);
            assert_eq!(found.error(&want), 0, "scale {scale}");
            // The red box covers its overlap with the anchor, so fewer pixels than the whole anchor are blue.
            assert!(n < (want.w * want.h) as usize);
            let overlap = want
                .intersect(&Rect::from_css(OVERLAY, origin, scale))
                .unwrap();
            assert!(r.all_where(overlap, is_red));
        }
    }

    #[test]
    fn a_surface_above_the_dom_box_covers_it_and_the_check_can_tell() {
        let r = window(1.0, (0, 28), BLUE, false);
        let overlap = Rect::from_css(ANCHOR, (0, 28), 1.0)
            .intersect(&Rect::from_css(OVERLAY, (0, 28), 1.0))
            .unwrap();
        let (cx, cy) = overlap.center();
        assert!(is_color(r.px(cx, cy), BLUE, 6));
        assert!(!is_red(r.px(cx, cy)));
    }

    #[test]
    fn a_misplaced_surface_is_reported_with_its_pixel_error() {
        let want = Rect::from_css(ANCHOR, (0, 28), 2.0);
        let mut r = Raster::new(1280, 800, [0; 4]);
        r.fill(
            Rect::new(want.x + 3, want.y - 5, want.w, want.h),
            [51, 102, 255, 255],
        );
        let (found, _) = r.find_color(BLUE, 6).unwrap();
        assert_eq!(found.error(&want), 5);
    }

    #[test]
    fn the_largest_region_wins_over_a_stray_pixel_of_the_same_colour() {
        let mut r = Raster::new(40, 30, [0; 4]);
        r.fill(Rect::new(10, 8, 12, 9), [255, 0, 0, 255]);
        r.set(1, 1, [255, 0, 0, 255]); // a close button
        let (all, _) = r.find_where(is_red).unwrap();
        assert_eq!(
            all,
            Rect::new(1, 1, 21, 16),
            "the plain bounding box includes the stray pixel"
        );
        let (blob, n) = r.largest_region(is_red).unwrap();
        assert_eq!((blob, n), (Rect::new(10, 8, 12, 9), 108));
        // An L shape is one region: a box with a corner hidden behind a surface keeps its bounding box.
        let mut l = Raster::new(20, 20, [0; 4]);
        l.fill(Rect::new(2, 2, 10, 3), [255, 0, 0, 255]);
        l.fill(Rect::new(2, 2, 3, 10), [255, 0, 0, 255]);
        assert_eq!(l.largest_region(is_red).unwrap().0, Rect::new(2, 2, 10, 10));
    }

    #[test]
    fn a_red_button_is_not_the_dom_box() {
        let mut r = Raster::new(640, 432, [0; 4]);
        r.fill(Rect::new(14, 9, 12, 12), [255, 0, 0, 255]);
        assert_eq!(
            page_origin(&r, OVERLAY, 1.0),
            None,
            "only a close button is on screen"
        );
        r.fill(Rect::from_css(OVERLAY, (0, 32), 1.0), [255, 0, 0, 255]);
        assert_eq!(page_origin(&r, OVERLAY, 1.0), Some((0, 32)));
    }

    #[test]
    fn transparent_and_missing_pixels_are_never_a_color() {
        let r = Raster::new(4, 4, [0; 4]);
        assert!(r.find_color([0, 0, 0], 255).is_none());
        assert_eq!(r.px(-1, 0), [0; 4]);
        assert_eq!(r.px(4, 4), [0; 4]);
        assert_eq!(r.get(4, 4), None);
        assert_eq!(r.get(3, 3), Some([0; 4]));
    }

    #[test]
    fn captures_are_converted_from_every_byte_layout_and_stride() {
        // 2x1 pixels, stride 12 (4 bytes of padding per row): red then green, opaque.
        let bgra = [0, 0, 255, 255, 0, 255, 0, 255, 9, 9, 9, 9];
        let r = Raster::from_capture(2, 1, 12, Layout::Bgra, &bgra).unwrap();
        assert_eq!(
            (r.px(0, 0), r.px(1, 0)),
            ([255, 0, 0, 255], [0, 255, 0, 255])
        );
        let argb = [255, 255, 0, 0, 255, 0, 255, 0, 9, 9, 9, 9];
        assert_eq!(
            Raster::from_capture(2, 1, 12, Layout::Argb, &argb)
                .unwrap()
                .rgba,
            r.rgba
        );
        assert!(Raster::from_capture(2, 2, 12, Layout::Bgra, &bgra).is_none());
        assert!(Raster::from_capture(2, 1, 4, Layout::Bgra, &bgra).is_none());
    }
}
