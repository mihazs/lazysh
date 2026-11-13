//! The wgpu prototype against the CPU reference renderer (#1322 is the oracle, #1323 the shootout):
//! the same `Frame` stream, the same appearance, and the images must be identical pixel for pixel.
//! Needs a GPU adapter (Vulkan or GL); without one `create` fails and so does every test, because a
//! skipped correctness check would look like a pass.

use lazysh_terminal_renderer_wgpu::{Target, WgpuRenderer};
use lazysh_terminal_runtime::{
    Appearance, Config, CursorVisualStyle, Frame, Image, Offer, Overlay, ReferenceRenderer,
    RenderError, Selection, SelectionKind, Size, TerminalRenderer, TerminalRuntime, Theme,
};

const W: u32 = 8;
const H: u32 = 16;

fn runtime(cols: u16, rows: u16, bytes: &[u8]) -> TerminalRuntime {
    let mut rt = TerminalRuntime::new(Config {
        size: Size::new(cols, rows),
        ..Config::default()
    })
    .unwrap();
    send(&mut rt, bytes);
    rt
}

fn send(rt: &mut TerminalRuntime, bytes: &[u8]) {
    assert_eq!(rt.offer(bytes.to_vec()), Offer::Accepted);
    rt.pump(usize::MAX);
}

struct Pair {
    gpu: WgpuRenderer,
    cpu: ReferenceRenderer,
}

impl Pair {
    fn new(cols: u16, rows: u16) -> Self {
        let (width, height) = (u32::from(cols) * W, u32::from(rows) * H);
        let blank = Image::new(width, height, Theme::default().background).unwrap();
        Self {
            gpu: WgpuRenderer::create(Target { width, height }, Appearance::default())
                .expect("a GPU adapter is required"),
            cpu: ReferenceRenderer::create(blank, Appearance::default()).unwrap(),
        }
    }

    /// Show a frame on both and return the rows each one drew.
    fn show(&mut self, frame: &Frame) -> (u32, u32) {
        let rows = (self.gpu.apply(frame), self.cpu.apply(frame));
        assert_eq!(rows.0, rows.1, "both renderers judge the frame alike");
        let drawn = (self.gpu.draw().unwrap(), self.cpu.draw().unwrap());
        self.gpu.present().unwrap();
        self.cpu.present().unwrap();
        drawn
    }

    fn overlay(&mut self, overlay: Overlay) {
        self.gpu.set_overlay(overlay).unwrap();
        self.cpu.set_overlay(overlay).unwrap();
        assert_eq!(self.gpu.draw().unwrap(), self.cpu.draw().unwrap());
        self.gpu.present().unwrap();
        self.cpu.present().unwrap();
    }

    fn assert_same(&mut self, what: &str) {
        let (gpu, cpu) = (self.gpu.read_image(), self.cpu.surface());
        let bg = Theme::default().background;
        assert!(
            cpu.rgb.chunks(3).any(|p| p != [bg.r, bg.g, bg.b]),
            "{what}: the oracle image is blank, so equality would prove nothing"
        );
        let at = gpu.rgb.iter().zip(&cpu.rgb).position(|(a, b)| a != b);
        assert!(
            at.is_none(),
            "{what}: first difference at pixel ({}, {})",
            at.unwrap() / 3 % gpu.width as usize,
            at.unwrap() / 3 / gpu.width as usize
        );
        assert_eq!((gpu.width, gpu.height), (cpu.width, cpu.height));
    }
}

#[test]
fn every_content_class_matches_the_reference() {
    let text = "\x1b[1mbold\x1b[22m \x1b[2mfaint\x1b[22m \x1b[7minverse\x1b[27m \x1b[8mhidden\x1b[28m\r\n\
        \x1b[4mone\x1b[24m \x1b[4:2mtwo\x1b[24m \x1b[4:3mwave\x1b[24m \x1b[4:4mdots\x1b[24m \x1b[4:5mdash\x1b[24m \x1b[4;58;5;196mtint\x1b[0m\r\n\
        \x1b[9mstrike\x1b[29m \x1b[53mover\x1b[55m \x1b[31;42mred on green\x1b[0m \x1b[38;2;250;120;10mrgb\x1b[0m\r\n\
        日本語 한국어 A日B e\u{301}a\u{308}\u{323} 😀 👨\u{200d}👩\u{200d}👧 🇧🇷 👍🏽 ❤\u{fe0f}\r\n\
        123456789012345678語";
    let mut rt = runtime(40, 6, text.as_bytes());
    let mut pair = Pair::new(40, 6);
    pair.show(&rt.snapshot().unwrap());
    pair.assert_same("content classes");
}

#[test]
fn cursor_shapes_and_selections_match_the_reference() {
    let mut rt = runtime(12, 3, "ab日c\r\nline two\r\nthird".as_bytes());
    let mut pair = Pair::new(12, 3);
    for (setup, hollow) in [
        ("\x1b[2 q", false),
        ("\x1b[4 q", false),
        ("\x1b[6 q", false),
        ("\x1b[2 q", true),
    ] {
        send(&mut rt, format!("{setup}\x1b[1;4H").as_bytes());
        let mut frame = rt.snapshot().unwrap();
        if hollow {
            frame.cursor.visual_style = CursorVisualStyle::BlockHollow;
        }
        pair.show(&frame);
        pair.assert_same("cursor");
    }
    send(&mut rt, b"\x1b[?25l");
    pair.show(&rt.snapshot().unwrap());
    for (kind, anchor, head) in [
        (SelectionKind::Linear, (3, 0), (4, 2)),
        (SelectionKind::Block, (1, 0), (4, 2)),
        (SelectionKind::Linear, (3, 0), (3, 0)),
    ] {
        pair.overlay(Overlay {
            selection: Some(Selection { kind, anchor, head }),
            ..Overlay::default()
        });
        pair.assert_same("selection");
    }
}

#[test]
fn incremental_frames_match_the_reference_and_draw_the_same_rows() {
    let mut rt = runtime(30, 8, b"");
    let mut pair = Pair::new(30, 8);
    pair.show(&rt.snapshot().unwrap());
    for n in 0..40 {
        send(
            &mut rt,
            format!("\x1b[3{}mline {n} 日本 \x1b[0mend\r\n", n % 8).as_bytes(),
        );
        if let Some(frame) = rt.take_frame().unwrap() {
            let (gpu, cpu) = pair.show(&frame);
            assert_eq!(gpu, cpu, "rows drawn at step {n}");
        }
        pair.assert_same(&format!("step {n}"));
    }
    let (gpu, cpu) = (pair.gpu.stats(), pair.cpu.stats());
    assert_eq!(
        (gpu.frames_drawn, gpu.rows_drawn),
        (cpu.frames_drawn, cpu.rows_drawn)
    );
    assert!(gpu.bytes_uploaded > 0);
    // Idle: nothing changed since the last frame, so nothing is drawn, submitted or uploaded.
    assert_eq!(pair.gpu.draw().unwrap(), 0);
    pair.gpu.present().unwrap();
    assert_eq!(pair.gpu.stats(), gpu);
}

#[test]
fn a_lost_device_recovers_from_a_snapshot() {
    let mut rt = runtime(20, 4, "before the loss 日本\r\nsecond".as_bytes());
    let mut pair = Pair::new(20, 4);
    pair.show(&rt.snapshot().unwrap());
    pair.gpu.lose_device();
    assert_eq!(pair.gpu.draw(), Err(RenderError::DeviceLost));
    assert_eq!(
        pair.gpu.apply(&rt.snapshot().unwrap()),
        Err(RenderError::DeviceLost)
    );
    pair.gpu.resume().unwrap();
    send(&mut rt, b"\r\nafter the resume");
    let frame = rt.take_frame().unwrap().unwrap();
    if !frame.full {
        assert_eq!(pair.gpu.apply(&frame), Err(RenderError::NeedsFullFrame));
    }
    pair.gpu.apply(&rt.snapshot().unwrap()).unwrap();
    pair.gpu.draw().unwrap();
    pair.gpu.present().unwrap();
    pair.cpu.apply(&frame).unwrap();
    pair.cpu.draw().unwrap();
    pair.cpu.present().unwrap();
    pair.assert_same("after recovery");
}
