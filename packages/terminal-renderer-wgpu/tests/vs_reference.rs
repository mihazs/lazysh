//! The wgpu renderer against the CPU reference renderer (#1322 is the oracle) and the golden PNGs
//! of the Renderer API: the same `Frame` stream, the same appearance, identical pixels.

mod common;

#[path = "../../terminal-runtime/tests/support/golden.rs"]
mod golden;

use common::*;
use lazysh_terminal_runtime::{
    CursorVisualStyle, Overlay, RenderError, Selection, SelectionKind, TerminalRenderer,
};

#[test]
fn every_content_class_matches_the_reference() {
    let text = "\x1b[1mbold\x1b[22m \x1b[2mfaint\x1b[22m \x1b[7minverse\x1b[27m \x1b[8mhidden\x1b[28m\r\n\
        \x1b[4mone\x1b[24m \x1b[4:2mtwo\x1b[24m \x1b[4:3mwave\x1b[24m \x1b[4:4mdots\x1b[24m \x1b[4:5mdash\x1b[24m \x1b[4;58;5;196mtint\x1b[0m\r\n\
        \x1b[9mstrike\x1b[29m \x1b[53mover\x1b[55m \x1b[31;42mred on green\x1b[0m \x1b[38;2;250;120;10mrgb\x1b[0m\r\n\
        日本語 한국어 A日B e\u{301}a\u{308}\u{323} 😀 👨\u{200d}👩\u{200d}👧 🇧🇷 👍🏽 ❤\u{fe0f}\r\n\
        \x1b[41m  \x1b[42m  \x1b[41m  \x1b[0m 123456789012345678語";
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
        support::feed(&mut rt, format!("{setup}\x1b[1;4H").as_bytes());
        let mut frame = rt.snapshot().unwrap();
        if hollow {
            frame.cursor.visual_style = CursorVisualStyle::BlockHollow;
        }
        pair.show(&frame);
        pair.assert_same("cursor");
    }
    support::feed(&mut rt, b"\x1b[?25l");
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
fn incremental_frames_match_the_reference_and_cost_one_pass_each() {
    let mut rt = runtime(30, 8, b"");
    let mut pair = Pair::new(30, 8);
    pair.show(&rt.snapshot().unwrap());
    for n in 0..40 {
        support::feed(
            &mut rt,
            format!("\x1b[3{}mline {n} 日本 \x1b[0mend\r\n", n % 8).as_bytes(),
        );
        if let Some(frame) = rt.take_frame().unwrap() {
            let before = pair.gpu.gpu_stats();
            let (gpu, cpu) = pair.show(&frame);
            assert_eq!(gpu, cpu, "rows drawn at step {n}");
            let after = pair.gpu.gpu_stats();
            assert_eq!(
                after.submissions - before.submissions,
                1,
                "step {n}: one submission"
            );
            assert_eq!(after.passes - before.passes, 1, "step {n}: one pass");
        }
        pair.assert_same(&format!("step {n}"));
    }
    let (gpu, cpu) = (pair.gpu.stats(), pair.cpu.stats());
    assert_eq!(
        (gpu.frames_drawn, gpu.rows_drawn),
        (cpu.frames_drawn, cpu.rows_drawn)
    );
    assert!(gpu.bytes_uploaded > 0);
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
    support::feed(&mut rt, b"\r\nafter the resume");
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
    assert_eq!(pair.gpu.gpu_stats().device_recoveries, 1);
}

#[test]
fn every_golden_image_of_the_renderer_api_is_reproduced() {
    let dir = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../terminal-runtime/tests/golden"
    );
    for g in golden::goldens() {
        let mut rt = runtime(g.cols, g.rows, &g.bytes);
        let mut r = gpu(g.cols, g.rows);
        let mut frame = rt.snapshot().unwrap();
        if g.hollow {
            frame.cursor.visual_style = CursorVisualStyle::BlockHollow;
        }
        r.apply(&frame).unwrap();
        r.set_overlay(g.overlay).unwrap();
        r.draw().unwrap();
        r.present().unwrap();
        golden::assert_golden(dir, g.name, &r.read_image().unwrap(), false);
    }
}

/// 24 narrow and 4 wide slots against a screen that shows hundreds of distinct clusters: the atlas
/// spills into several passes and evicts, and the picture is still the reference picture.
#[test]
fn an_atlas_smaller_than_the_screen_draws_the_same_pixels() {
    let text: String = (0x400u32..0x4a0)
        .filter_map(char::from_u32)
        .chain("日本語한국어漢字仮名交じり文".chars())
        .collect();
    let mut rt = runtime(40, 6, text.as_bytes());
    let small = target(40, 6).with_atlas_side(64);
    let mut pair = Pair::with(
        WgpuRenderer::create(small, Default::default()).unwrap(),
        40,
        6,
    );
    pair.show(&rt.snapshot().unwrap());
    pair.assert_same("a frame bigger than the atlas");
    let stats = pair.gpu.gpu_stats();
    assert!(stats.atlas_spills > 0 && stats.passes > 1, "{stats:?}");
    assert!(stats.atlas_evictions > 0, "{stats:?}");
    let (capacity, resident) = pair.gpu.atlas_slots();
    assert!(
        resident <= capacity && capacity == 28,
        "{capacity} slots, {resident} in use"
    );
}

use lazysh_terminal_renderer_wgpu::WgpuRenderer;
