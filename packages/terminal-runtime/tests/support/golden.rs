//! The golden-image cases of the Renderer API (#1322), shared by every renderer that is checked
//! against `tests/golden/*.png`: the CPU reference renderer here and the wgpu renderer (#1324).
//! Included with `#[path]` by the test crates that need it, not through `support`, because the
//! comparison uses `CARGO_TARGET_TMPDIR`, which examples do not have.

use lazysh_terminal_runtime::{
    Appearance, CellMetrics, CursorVisualStyle, Image, Overlay, Selection, SelectionKind,
    TerminalRenderer, TerminalRuntime,
};

/// One golden image: what the core receives, what the host adds on top, and the PNG it must equal.
pub struct Golden {
    pub name: &'static str,
    pub cols: u16,
    pub rows: u16,
    pub bytes: Vec<u8>,
    pub overlay: Overlay,
    /// The cursor shape is forced to the hollow block, which the core never reports by itself.
    pub hollow: bool,
    /// Display scale: the default cell metrics times this (2 is a 16x32 pixel cell).
    pub scale: u32,
}

impl Golden {
    pub fn appearance(&self) -> Appearance {
        Appearance {
            metrics: CellMetrics::default().scaled(self.scale, 1).unwrap(),
            ..Appearance::default()
        }
    }

    /// Show this case on `renderer`: the screen of `core` (which has received the case's bytes),
    /// the forced cursor shape and the overlay, drawn and presented.
    pub fn show<R: TerminalRenderer>(&self, renderer: &mut R, core: &mut TerminalRuntime) {
        let mut frame = core.snapshot().unwrap();
        if self.hollow {
            frame.cursor.visual_style = CursorVisualStyle::BlockHollow;
        }
        renderer.apply(&frame).unwrap();
        renderer.set_overlay(self.overlay).unwrap();
        renderer.draw().unwrap();
        renderer.present().unwrap();
    }

    /// The surface size in device pixels.
    pub fn size(&self) -> (u32, u32) {
        let m = self.appearance().metrics;
        (
            u32::from(self.cols) * m.cell_width,
            u32::from(self.rows) * m.cell_height,
        )
    }
}

pub fn select(kind: SelectionKind, anchor: (u16, u16), head: (u16, u16)) -> Overlay {
    Overlay {
        selection: Some(Selection { kind, anchor, head }),
        ..Overlay::default()
    }
}

/// Content classes first, then the cursor shapes and selections over one three-line text.
pub fn goldens() -> Vec<Golden> {
    let attributes = b"\x1b[1mbold\x1b[0m \x1b[2mfaint\x1b[0m \x1b[7minverse\x1b[0m \x1b[8mhidden\x1b[0m\r\n\
        \x1b[4msingle\x1b[0m \x1b[4:2mdouble\x1b[0m \x1b[4:3mcurly\x1b[0m \x1b[4:4mdotted\x1b[0m \x1b[4:5mdashed\x1b[0m\r\n\
        \x1b[9mstrike\x1b[0m \x1b[53moverline\x1b[0m \x1b[4;58;2;255;0;0mred line\x1b[0m";
    let colors = "\x1b[30mA\x1b[31mB\x1b[32mC\x1b[33mD\x1b[34mE\x1b[35mF\x1b[36mG\x1b[37mH\x1b[0m \x1b[90mI\x1b[91mJ\x1b[92mK\x1b[93mL\x1b[94mM\x1b[95mN\x1b[96mO\x1b[97mP\x1b[0m\r\n\
        \x1b[41m \x1b[42m \x1b[43m \x1b[44m \x1b[45m \x1b[46m \x1b[47m \x1b[100m \x1b[101m \x1b[102m \x1b[103m \x1b[104m \x1b[0m\r\n\
        \x1b[38;5;196mred256\x1b[0m \x1b[48;5;21m\x1b[38;5;226myellow on blue\x1b[0m\r\n\
        \x1b[38;2;255;128;0mtruecolor\x1b[0m \x1b[48;2;0;128;64m  \x1b[48;2;128;0;128m  \x1b[0m";
    let content: [(&str, u16, u16, &[u8]); 6] = [
        (
            "ascii",
            24,
            3,
            b"Hello, lazysh!\r\n0123456789 ~!@#$%\r\nThe quick brown fox",
        ),
        ("ansi_colors", 24, 4, colors.as_bytes()),
        ("attributes", 36, 3, attributes),
        (
            "wide",
            16,
            3,
            "日本語 한국어 AB\r\nA日B本C語\r\n123456789012345語X".as_bytes(),
        ),
        (
            "combining",
            16,
            2,
            "e\u{301} a\u{308}\u{323} n\u{303}x\r\nplain eee".as_bytes(),
        ),
        (
            "emoji",
            16,
            3,
            "😀 👨\u{200d}👩\u{200d}👧 🇧🇷 👍🏽\r\nA😀B\u{2764}\u{fe0f}C".as_bytes(),
        ),
    ];
    let text = "ab日c\r\nline two\r\nthird line";
    let over = |name, setup: &str, overlay, hollow| Golden {
        name,
        cols: 10,
        rows: 3,
        bytes: format!("{text}{setup}").into_bytes(),
        overlay,
        hollow,
        scale: 1,
    };
    let (none, hidden) = (Overlay::default(), "\x1b[?25l");
    let linear = |anchor, head| select(SelectionKind::Linear, anchor, head);
    let mut all: Vec<Golden> = content
        .into_iter()
        .map(|(name, cols, rows, bytes)| Golden {
            name,
            cols,
            rows,
            bytes: bytes.to_vec(),
            overlay: none,
            hollow: false,
            scale: 1,
        })
        .collect();
    all.extend([
        over("cursor_block", "\x1b[2 q\x1b[2;3H", none, false),
        over("cursor_bar", "\x1b[6 q\x1b[2;3H", none, false),
        over("cursor_underline", "\x1b[4 q\x1b[2;3H", none, false),
        over("cursor_on_wide_head", "\x1b[2 q\x1b[1;3H", none, false),
        over("selection_linear", hidden, linear((3, 0), (4, 2)), false),
        over(
            "selection_block",
            hidden,
            select(SelectionKind::Block, (1, 0), (4, 2)),
            false,
        ),
        over("selection_over_wide", hidden, linear((3, 0), (3, 0)), false),
        over(
            "cursor_hollow_on_wide_tail",
            "\x1b[2 q\x1b[1;4H",
            none,
            true,
        ),
    ]);
    // The same layout at other display scales: the cell metrics change, nothing else does.
    let mixed = "Hi 日本 e\u{301} \u{1F600}\r\n\x1b[1mbold\x1b[0m \x1b[4mline\x1b[0m \x1b[9mgone\x1b[0m\r\n\x1b[7minv\x1b[0m\x1b[2 q\x1b[3;2H";
    let scaled = |name, scale, overlay| Golden {
        name,
        cols: 16,
        rows: 3,
        bytes: mixed.as_bytes().to_vec(),
        overlay,
        hollow: false,
        scale,
    };
    all.extend([
        scaled("scale2_mixed", 2, none),
        scaled("scale3_mixed_selection", 3, linear((1, 0), (6, 1))),
    ]);
    all
}

/// Compare `image` with `<dir>/<name>.png` pixel for pixel. With `update` the golden is rewritten
/// instead; a difference writes `<name>.actual.png` into the target directory and panics.
pub fn assert_golden(dir: &str, name: &str, image: &Image, update: bool) {
    assert_golden_within(dir, name, image, update, 0);
}

/// [`assert_golden`] that accepts a difference of up to `tolerance` per color channel: for images
/// whose glyphs a rasterizer draws and a GPU blends, where the last bit is the driver's.
pub fn assert_golden_within(dir: &str, name: &str, image: &Image, update: bool, tolerance: u8) {
    let path = format!("{dir}/{name}.png");
    let encode = |path: &str, image: &Image| {
        let mut encoder = png::Encoder::new(
            std::fs::File::create(path).unwrap(),
            image.width,
            image.height,
        );
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&image.rgb)
            .unwrap();
    };
    if update {
        return encode(&path, image);
    }
    let decoded = std::fs::File::open(&path).map(|file| {
        let mut reader = png::Decoder::new(file).read_info().unwrap();
        let mut rgb = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut rgb).unwrap();
        (info.width, info.height, rgb)
    });
    if decoded.as_ref().is_ok_and(|(w, h, rgb)| {
        (*w, *h) == (image.width, image.height)
            && rgb
                .iter()
                .zip(&image.rgb)
                .all(|(a, b)| a.abs_diff(*b) <= tolerance)
    }) {
        return;
    }
    let actual = format!("{}/{name}.actual.png", env!("CARGO_TARGET_TMPDIR"));
    encode(&actual, image);
    panic!(
        "golden {name} differs ({}); actual image: {actual}",
        if decoded.is_ok() { "pixels" } else { "missing" }
    );
}
