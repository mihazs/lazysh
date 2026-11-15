//! Renderer API conformance (#1322): the CPU reference renderer fed by the real libghostty-vt
//! core. Goldens pin the pixels for each content class; the other cases pin the contract a GPU
//! or platform renderer must keep (what is redrawn, lifecycle, recovery) and check pixels
//! against the frame, not against a golden, so a wrong golden cannot hide a bug.
//! `UPDATE_GOLDEN=1 cargo test --test renderer` rewrites the goldens; review them as images.

#[path = "support/golden.rs"]
mod golden;
use golden::select;
mod support;

use lazysh_terminal_runtime::layout::row_draws;
use lazysh_terminal_runtime::{
    Appearance, CursorVisualStyle, Frame, Image, Overlay, ReferenceRenderer, RenderError,
    RendererCore, Resume, RgbColor, Screen, SelectionKind, TerminalRenderer, TerminalRuntime,
    Theme,
};
use support::*;

const W: u32 = 8;
const H: u32 = 16;

fn renderer(cols: u16, rows: u16) -> ReferenceRenderer {
    let blank = Image::new(
        u32::from(cols) * W,
        u32::from(rows) * H,
        Theme::default().background,
    )
    .unwrap();
    ReferenceRenderer::create(blank, Appearance::default()).unwrap()
}

fn show(r: &mut ReferenceRenderer, frame: &Frame) -> u32 {
    r.apply(frame).unwrap();
    let rows = r.draw().unwrap();
    r.present().unwrap();
    rows
}

/// A runtime that received `bytes`, and a renderer showing its snapshot.
fn start(cols: u16, rows: u16, bytes: &[u8]) -> (TerminalRuntime, ReferenceRenderer) {
    let mut rt = runtime(cols, rows);
    feed(&mut rt, bytes);
    let mut r = renderer(cols, rows);
    show(&mut r, &rt.snapshot().unwrap());
    (rt, r)
}

/// One host tick: the frame the core has, if any, drawn and presented. Returns the rows drawn.
fn tick(rt: &mut TerminalRuntime, r: &mut ReferenceRenderer) -> u32 {
    rt.take_frame().unwrap().map_or(0, |frame| show(r, &frame))
}

fn px(r: &ReferenceRenderer, col: u32, row: u32, dx: u32, dy: u32) -> RgbColor {
    r.surface().pixel(col * W + dx, row * H + dy)
}

fn count(r: &ReferenceRenderer, cols: std::ops::Range<u32>, row: u32, color: RgbColor) -> usize {
    let cells = (cols.start * W)..(cols.end * W);
    cells
        .flat_map(|x| (0..H).map(move |y| (x, y)))
        .filter(|&(x, y)| r.surface().pixel(x, row * H + y) == color)
        .count()
}

fn assert_golden(name: &str, image: &Image) {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden");
    golden::assert_golden(
        dir,
        name,
        image,
        std::env::var_os("UPDATE_GOLDEN").is_some(),
    );
}

#[test]
fn goldens_for_each_content_class_cursor_shape_and_selection() {
    for g in golden::goldens() {
        let (mut rt, mut r) = start(g.cols, g.rows, &g.bytes);
        r.set_overlay(g.overlay).unwrap();
        if g.hollow {
            let mut frame = rt.snapshot().unwrap();
            frame.cursor.visual_style = CursorVisualStyle::BlockHollow;
            show(&mut r, &frame);
        }
        r.draw().unwrap();
        r.present().unwrap();
        assert_golden(g.name, r.surface());
    }
}

#[test]
fn pixels_follow_the_frame_not_a_golden() {
    let (mut rt, r) = start(
        12,
        3,
        b"\x1b[41m \x1b[0m\x1b[7m \x1b[0m\x1b[4m \x1b[0m\x1b[8mX\x1b[0m\x1b[2;1H\x1b[32mgreen",
    );
    let frame = rt.snapshot().unwrap();
    let theme = Theme::default();
    assert_eq!(
        px(&r, 0, 0, 4, 8),
        frame.dirty[0].cells[0].bg.unwrap(),
        "background color of a cell"
    );
    assert_eq!(
        px(&r, 1, 0, 4, 8),
        theme.foreground,
        "inverse swaps the default colors"
    );
    assert_eq!(
        px(&r, 2, 0, 3, 12),
        theme.foreground,
        "underline at its row"
    );
    assert_eq!(px(&r, 2, 0, 3, 3), theme.background, "and only there");
    assert_eq!(
        count(&r, 3..4, 0, theme.foreground),
        0,
        "invisible text paints nothing"
    );
    let green = frame.dirty[1].cells[0].fg.unwrap();
    assert!(
        count(&r, 0..5, 1, green) > 0,
        "text takes its resolved foreground"
    );
}

#[test]
fn a_cluster_draws_the_same_everywhere_and_differs_from_other_clusters() {
    let (_, r) = start(8, 1, "aab e\u{301}".as_bytes());
    let cell =
        |col: u32| -> Vec<RgbColor> { (0..W * H).map(|i| px(&r, col, 0, i % W, i / W)).collect() };
    assert_eq!(cell(0), cell(1), "the same cluster in two cells");
    assert_ne!(cell(0), cell(2), "another letter");
    assert_ne!(cell(4), cell(5), "a base letter with and without its mark");
}

#[test]
fn wide_clusters_span_two_cells_and_combining_marks_stay_in_one() {
    let (_, r) = start(8, 2, "日\r\ne\u{301}\u{302}".as_bytes());
    let fg = Theme::default().foreground;
    assert!(
        count(&r, 0..1, 0, fg) > 0 && count(&r, 1..2, 0, fg) > 0,
        "both halves carry the glyph"
    );
    assert_eq!(count(&r, 2..8, 0, fg), 0, "nothing past the wide cell");
    assert!(count(&r, 0..1, 1, fg) > 0);
    assert_eq!(count(&r, 1..8, 1, fg), 0, "marks do not take a cell");
}

#[test]
fn cursor_shapes_and_the_selection_use_the_theme() {
    let theme = Theme::default();
    let (mut rt, mut r) = start(6, 2, b"ab\x1b[2 q\x1b[1;1H");
    assert_eq!(
        px(&r, 0, 0, 0, 0),
        theme.cursor,
        "block cursor fills its cell"
    );
    assert_eq!(px(&r, 1, 0, 0, 0), theme.background);
    for (style, corner, center) in [
        (
            CursorVisualStyle::BlockHollow,
            theme.cursor,
            theme.background,
        ),
        (CursorVisualStyle::Bar, theme.cursor, theme.background),
        (
            CursorVisualStyle::Underline,
            theme.background,
            theme.background,
        ),
    ] {
        let mut frame = rt.snapshot().unwrap();
        frame.cursor.visual_style = style;
        show(&mut r, &frame);
        assert_eq!(px(&r, 0, 0, 0, 0), corner, "{style:?} corner");
        assert_eq!(px(&r, 0, 0, 5, 8), center, "{style:?} center");
    }
    let frame = rt.snapshot().unwrap();
    r.apply(&frame).unwrap();
    r.set_overlay(select(SelectionKind::Linear, (4, 1), (5, 1)))
        .unwrap();
    r.draw().unwrap();
    r.present().unwrap();
    assert_eq!(px(&r, 4, 1, 1, 1), theme.selection_background);
    assert_eq!(px(&r, 3, 1, 1, 1), theme.background);
}

#[test]
fn incremental_updates_equal_a_full_repaint() {
    let steps: [&[u8]; 9] = [
        b"$ ls\r\nfile1 file2",
        b"\x1b[2D\x1b[4 q",
        b"\x1b[?25l\x1b[?25h\x1b[6 q",
        b"\x1b[31mred\x1b[0m text\x1b[2;1H\x1b[K",
        b"\x1b[3;3H\x1b[7mXY\x1b[0m\x1b[1;1H",
        "日本語\r\n".as_bytes(),
        b"\r\n\r\n\r\n\r\nscrolled",
        b"\x1b[?1049h\x1b[2J\x1b[Halt screen\x1b[2 q\x1b[3;1H",
        b"\x1b[?1049l\x1b[4;1Hback\x1b[?25l",
    ];
    let mut rt = runtime(14, 5);
    let mut r = renderer(14, 5);
    for step in steps {
        feed(&mut rt, step);
        tick(&mut rt, &mut r);
        let mut fresh = renderer(14, 5);
        show(&mut fresh, &rt.snapshot().unwrap());
        assert_eq!(
            r.surface(),
            fresh.surface(),
            "after {:?}",
            String::from_utf8_lossy(step)
        );
    }
}

#[test]
fn drawing_and_presenting_are_timed_only_when_something_is_drawn() {
    let (mut rt, mut r) = start(20, 10, b"hello");
    let drawn = r.stats();
    assert!(
        drawn.draw_time > std::time::Duration::ZERO
            && drawn.present_time > std::time::Duration::ZERO,
        "the first frame took time to draw and to present"
    );
    assert_eq!(tick(&mut rt, &mut r), 0);
    assert_eq!(r.stats(), drawn, "an idle frame adds no time");
    feed(&mut rt, b"\x1b[5;1Hmore");
    tick(&mut rt, &mut r);
    let after = r.stats();
    assert!(after.draw_time > drawn.draw_time && after.present_time > drawn.present_time);
}

#[test]
fn only_what_changed_is_drawn_and_uploaded() {
    let (mut rt, mut r) = start(20, 10, b"hello");
    let row_bytes = (20 * W * H * 3) as u64;
    assert_eq!(tick(&mut rt, &mut r), 0, "an idle screen draws nothing");
    let before = r.stats();
    assert_eq!(r.draw().unwrap(), 0);
    r.present().unwrap();
    assert_eq!(
        r.stats(),
        before,
        "no frame is submitted for an unchanged screen"
    );
    feed(&mut rt, b"\x1b[8;1Hxyz");
    assert_eq!(
        tick(&mut rt, &mut r),
        2,
        "the row written and the row the cursor left"
    );
    assert_eq!(
        r.stats().bytes_uploaded - before.bytes_uploaded,
        2 * row_bytes
    );
    feed(&mut rt, b"\x1b[8;1H");
    assert_eq!(
        tick(&mut rt, &mut r),
        1,
        "a cursor move inside a row redraws that row"
    );
    let blinking = [b"\x1b[?12h".as_slice(), b"\x1b[?12l".as_slice()];
    let phase_off = Overlay {
        cursor_phase_on: false,
        ..Overlay::default()
    };
    r.set_overlay(phase_off).unwrap();
    assert_eq!(
        r.draw().unwrap(),
        0,
        "the blink phase is ignored while the cursor is steady"
    );
    feed(&mut rt, blinking[0]);
    tick(&mut rt, &mut r);
    r.set_overlay(Overlay::default()).unwrap();
    assert_eq!(
        r.draw().unwrap(),
        1,
        "a blinking cursor redraws its own row"
    );
    r.present().unwrap();
    assert_eq!(
        px(&r, 0, 7, 0, 0),
        Theme::default().cursor,
        "visible in the on phase"
    );
}

#[test]
fn extending_a_selection_redraws_only_the_rows_that_changed() {
    let (_, mut r) = start(10, 6, b"\x1b[?25l");
    let draw = |r: &mut ReferenceRenderer, o: Overlay| {
        r.set_overlay(o).unwrap();
        r.draw().unwrap()
    };
    assert_eq!(
        draw(&mut r, select(SelectionKind::Linear, (2, 1), (5, 1))),
        1
    );
    assert_eq!(
        draw(&mut r, select(SelectionKind::Linear, (2, 1), (6, 1))),
        1,
        "one more cell, one row"
    );
    assert_eq!(
        draw(&mut r, select(SelectionKind::Linear, (2, 1), (6, 3))),
        3,
        "reading order adds the rows below"
    );
    assert_eq!(
        draw(&mut r, select(SelectionKind::Linear, (2, 1), (6, 3))),
        0,
        "the same selection is free"
    );
    assert_eq!(
        draw(&mut r, Overlay::default()),
        3,
        "clearing redraws what was selected"
    );
}

#[test]
fn a_changed_appearance_repaints_everything() {
    let (_, mut r) = start(6, 3, b"abc");
    let mut appearance = Appearance::default();
    appearance.theme.background = RgbColor {
        r: 10,
        g: 20,
        b: 30,
    };
    r.set_appearance(appearance.clone()).unwrap();
    assert_eq!(r.draw().unwrap(), 3);
    r.present().unwrap();
    assert_eq!(px(&r, 5, 2, 7, 15), appearance.theme.background);
    r.resize(100, 100).unwrap();
    assert_eq!(r.draw().unwrap(), 3, "a bigger surface needs a repaint");
    r.present().unwrap();
    assert_eq!(
        px(&r, 12, 6, 0, 0),
        appearance.theme.background,
        "beyond the grid is background"
    );
    let mut bad = appearance;
    bad.metrics.cell_width = 0;
    assert_eq!(r.set_appearance(bad), Err(RenderError::InvalidSize));
    assert_eq!(r.resize(0, 5), Err(RenderError::InvalidSize));
    assert_eq!(
        r.surface().width,
        100,
        "a refused change leaves the surface alone"
    );
}

#[test]
fn malformed_and_out_of_order_frames_are_refused_without_changing_state() {
    let (mut rt, mut r) = start(6, 2, b"ab");
    let good = rt.snapshot().unwrap();
    let mut short = good.clone();
    short.dirty[0].cells.pop();
    let mut outside = good.clone();
    outside.dirty[0].y = 9;
    let mut partial = good.clone();
    partial.dirty.pop();
    let mut twice = good.clone();
    twice.dirty[1] = twice.dirty[0].clone();
    for frame in [short, outside, partial, twice] {
        assert!(
            matches!(r.apply(&frame), Err(RenderError::InvalidFrame(_))),
            "{frame:?}"
        );
    }
    let mut resized = good.clone();
    resized.full = false;
    resized.cols = 7;
    assert_eq!(
        r.apply(&resized),
        Err(RenderError::NeedsFullFrame),
        "an incremental frame cannot change the grid"
    );
    assert_eq!(r.draw().unwrap(), 0, "refusals marked nothing dirty");
    let mut fresh = renderer(6, 2);
    let mut incremental = good;
    incremental.full = false;
    assert_eq!(
        fresh.apply(&incremental),
        Err(RenderError::NeedsFullFrame),
        "nothing to patch yet"
    );
}

/// Apply what the core has; a renderer that lost its copy is answered with a snapshot, as the host does.
fn sync<R: TerminalRenderer>(r: &mut R, rt: &mut TerminalRuntime, frame: &Frame) {
    if r.apply(frame) == Err(RenderError::NeedsFullFrame) {
        r.apply(&rt.snapshot().unwrap()).unwrap();
    }
}

/// The lifecycle contract any renderer must keep, up to recovery; `lose` makes the backend report
/// device loss. Leaves `r` showing the core's current screen, drawn but not presented.
fn lifecycle<R: TerminalRenderer>(r: &mut R, rt: &mut TerminalRuntime, lose: impl Fn(&mut R)) {
    r.suspend();
    r.suspend();
    feed(rt, b"while suspended");
    let missed = rt.take_frame().unwrap().unwrap();
    sync(r, rt, &missed);
    assert_eq!(
        (r.draw(), r.present()),
        (Ok(0), Ok(())),
        "a suspended renderer does no work"
    );
    r.resume().unwrap();
    r.resume().unwrap();
    feed(rt, b"!");
    let next = rt.take_frame().unwrap().unwrap();
    sync(r, rt, &next);
    assert_eq!(r.draw(), Ok(2), "resume repaints everything");
    lose(r);
    assert_eq!(r.draw(), Err(RenderError::DeviceLost));
    assert_eq!(r.present(), Err(RenderError::DeviceLost));
    assert_eq!(r.apply(&next), Err(RenderError::DeviceLost));
    r.resume().unwrap();
    assert_eq!(
        r.apply(&next),
        Err(RenderError::NeedsFullFrame),
        "device loss drops the copy"
    );
    r.apply(&rt.snapshot().unwrap()).unwrap();
    assert_eq!(r.draw(), Ok(2), "everything again, from core state");
}

#[test]
fn suspend_device_loss_and_destroy_recover_from_core_state() {
    let (mut rt, mut r) = start(10, 2, b"before");
    lifecycle(&mut r, &mut rt, ReferenceRenderer::lose_device);
    r.present().unwrap();
    let mut expected = renderer(10, 2);
    show(&mut expected, &rt.snapshot().unwrap());
    assert_eq!(
        r.surface(),
        expected.surface(),
        "the recovered image is the uninterrupted one"
    );
    assert_eq!(
        r.stats().frames_drawn,
        3,
        "the first screen, the resume and the recovery"
    );
    let next = rt.snapshot().unwrap();
    r.destroy();
    r.destroy();
    assert_eq!(r.apply(&next), Err(RenderError::Destroyed));
    assert_eq!(r.draw(), Err(RenderError::Destroyed));
    assert_eq!(r.resume(), Err(RenderError::Destroyed));
    assert_eq!(r.surface().rgb.len(), 0, "destroy released the buffers");
}

#[test]
fn the_layout_of_a_row_outside_the_grid_is_empty() {
    let mut rt = runtime(10, 3);
    feed(&mut rt, b"abc");
    let mut screen = Screen::new();
    screen.apply(&rt.snapshot().unwrap()).unwrap();
    let appearance = Appearance::default();
    assert!(!row_draws(&screen, 2, &appearance).is_empty());
    assert!(row_draws(&screen, 3, &appearance).is_empty());
    assert!(row_draws(&screen, u16::MAX, &appearance).is_empty());
}

#[test]
fn a_surface_shorter_than_the_grid_clips_instead_of_panicking() {
    let (mut rt, mut r) = start(6, 3, b"abc\r\ndef\r\nghi");
    r.resize(48, 20).unwrap();
    assert_eq!(r.draw().unwrap(), 3);
    r.present().unwrap();
    assert_eq!(r.surface().height, 20);
    let blank = (6 * W * H) as usize;
    let background = count(&r, 0..6, 0, Theme::default().background);
    assert!(background < blank, "the first row is drawn");
    // Row 2 starts below the surface: an incremental update of it is clipped, not a panic.
    feed(&mut rt, b"\x1b[3;1Hxyz");
    assert_eq!(tick(&mut rt, &mut r), 1);
    r.resize(48, 40).unwrap();
    assert_eq!(r.draw().unwrap(), 3);
    r.present().unwrap();
}

#[test]
fn absurd_metrics_and_surfaces_are_refused() {
    let mut huge = Appearance::default();
    huge.metrics.line_thickness = 0x5555_5556;
    huge.metrics.underline_y = 1;
    assert_eq!(huge.metrics.validate(), Err(RenderError::InvalidSize));
    let theme = Theme::default();
    let image = |w, h, len| Image {
        width: w,
        height: h,
        rgb: vec![0; len],
    };
    for bad in [image(0, 0, 0), image(4, 4, 10), image(1 << 14, 1 << 14, 0)] {
        let created = ReferenceRenderer::create(bad, Appearance::default());
        assert!(matches!(created, Err(RenderError::InvalidSize)));
    }
    let blank = Image::new(8, 8, theme.background).unwrap();
    assert!(ReferenceRenderer::create(blank, Appearance::default()).is_ok());
}

#[test]
fn the_screen_answers_for_cells_it_does_not_hold() {
    let mut screen = Screen::new();
    assert!(screen.row(0).is_empty());
    assert!(!screen.is_selected(0, 0));
    let mut rt = runtime(4, 2);
    feed(&mut rt, b"ab");
    screen.apply(&rt.snapshot().unwrap()).unwrap();
    screen.set_overlay(select(SelectionKind::Block, (0, 0), (3, 1)));
    assert!(screen.is_selected(3, 1));
    assert!(!screen.is_selected(4, 1) && !screen.is_selected(0, 2));
    assert!(screen.row(2).is_empty());
}

#[test]
fn a_destroyed_renderer_holds_an_empty_surface() {
    let (_, mut r) = start(4, 2, b"ab");
    r.destroy();
    assert_eq!((r.surface().width, r.surface().height), (0, 0));
    assert!(r.surface().rgb.is_empty());
}

#[test]
fn a_device_loss_reported_from_another_thread_is_recovered_by_resume() {
    let mut core = RendererCore::new(Appearance::default()).unwrap();
    let flag = core.lost_flag();
    std::thread::spawn(move || flag.store(true, std::sync::atomic::Ordering::SeqCst))
        .join()
        .unwrap();
    assert_eq!(core.live(), Err(RenderError::DeviceLost));
    assert_eq!(core.begin_draw(), Err(RenderError::DeviceLost));
    assert_eq!(core.resume(), Ok(Resume::DeviceRecovered));
    assert_eq!(core.live(), Ok(()));
    assert_eq!(core.resume(), Ok(Resume::Already));
    core.suspend();
    assert_eq!(core.begin_present(), Ok(false));
    assert_eq!(core.resume(), Ok(Resume::Resumed));
    core.destroy();
    assert_eq!(core.resume(), Err(RenderError::Destroyed));
    assert_eq!(core.live(), Err(RenderError::Destroyed));
}

#[test]
fn needs_draw_is_true_exactly_when_draw_would_paint() {
    let mut rt = runtime(10, 3);
    feed(&mut rt, b"abc");
    let mut r = renderer(10, 3);
    assert!(!r.needs_draw(), "no frame yet");
    r.apply(&rt.snapshot().unwrap()).unwrap();
    assert!(r.needs_draw());
    assert_eq!(r.draw().unwrap(), 3);
    assert!(!r.needs_draw(), "everything drawn");
    r.suspend();
    r.set_overlay(select(SelectionKind::Linear, (0, 0), (2, 0)))
        .unwrap();
    assert!(!r.needs_draw(), "a suspended renderer asks for nothing");
    r.resume().unwrap();
    assert!(r.needs_draw(), "resume repaints");
    assert_eq!(r.draw().unwrap(), 3);
    r.lose_device();
    assert!(!r.needs_draw(), "a lost device asks for nothing");
    r.resume().unwrap();
    assert!(!r.needs_draw(), "and nothing until a snapshot arrives");
    r.apply(&rt.snapshot().unwrap()).unwrap();
    assert!(r.needs_draw());
    r.destroy();
    assert!(!r.needs_draw());
}

#[test]
fn rewriting_a_row_with_the_same_cells_marks_nothing_dirty() {
    let (mut rt, mut r) = start(12, 3, b"\x1b[1;1Hsame text");
    feed(&mut rt, b"\x1b[1;1Hsame text");
    assert_eq!(
        tick(&mut rt, &mut r),
        0,
        "the cells and the cursor are the same"
    );
    assert!(!r.needs_draw());
    feed(&mut rt, b"\x1b[1;1Hsame test");
    assert_eq!(tick(&mut rt, &mut r), 1, "one letter changed");
}

#[test]
fn an_unsupported_backend_is_told_apart_from_a_lost_device() {
    let unsupported = RenderError::Unsupported("no adapter");
    assert_ne!(unsupported, RenderError::DeviceLost);
    assert_eq!(unsupported.to_string(), "renderer unsupported: no adapter");
}
