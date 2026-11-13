//! Cursor blink, selection, display scale, refresh rate and device loss (#1326) on the real core
//! and real renderers. Time is virtual (a `Duration` on the host's clock), so the blink and pacing
//! tests count wakeups and submissions without sleeping.

mod common;

use common::*;
use lazysh_terminal_renderer_wgpu::WgpuRenderer;
use lazysh_terminal_runtime::{
    Appearance, BlinkClock, CellMetrics, FramePacer, Overlay, RenderError, Selection,
    SelectionKind, TerminalRenderer, BLINK_HALF_PERIOD,
};
use std::time::{Duration, Instant};

const BLINKING_BLOCK: &[u8] = b"\x1b[1 q";
const STEADY_BLOCK: &[u8] = b"\x1b[2 q";
const SECONDS_60: Duration = Duration::from_secs(60);

/// A renderer showing `text` with the cursor style `style`, drawn and presented.
fn shown(style: &[u8], text: &str) -> (lazysh_terminal_runtime::TerminalRuntime, WgpuRenderer) {
    let mut rt = runtime(20, 4, &[text.as_bytes(), style].concat());
    let mut r = gpu(20, 4);
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.draw().unwrap();
    r.present().unwrap();
    (rt, r)
}

/// The host's one timer over `renderers` from `from` to `to`: wake when the clock says so, set the
/// phase on every renderer, draw and present. Returns the wakeups.
fn run_timer(
    renderers: &mut [WgpuRenderer],
    clock: &BlinkClock,
    from: Duration,
    to: Duration,
) -> u64 {
    let (mut now, mut wakes) = (from, 0);
    while let Some(at) = clock.next_wake(now, renderers.iter()) {
        if at > to {
            break;
        }
        (now, wakes) = (at, wakes + 1);
        let overlay = Overlay {
            cursor_phase_on: clock.phase_on(now),
            ..Overlay::default()
        };
        for r in renderers.iter_mut() {
            r.set_overlay(overlay).unwrap();
            r.draw().unwrap();
            r.present().unwrap();
        }
    }
    wakes
}

#[test]
fn a_blinking_cursor_costs_one_row_and_one_pass_per_phase_and_one_timer_serves_every_session() {
    let mut renderers: Vec<_> = (0..3).map(|_| shown(BLINKING_BLOCK, "blink").1).collect();
    let before: Vec<_> = renderers
        .iter()
        .map(|r| (r.gpu_stats(), r.stats()))
        .collect();
    let clock = BlinkClock::new(BLINK_HALF_PERIOD, Duration::ZERO);
    let wakes = run_timer(&mut renderers, &clock, Duration::ZERO, SECONDS_60);
    let expected = SECONDS_60.as_millis() / BLINK_HALF_PERIOD.as_millis();
    assert_eq!(
        u128::from(wakes),
        expected,
        "one wakeup per phase change, not per session"
    );
    for (r, (gpu, stats)) in renderers.iter().zip(before) {
        assert_eq!(
            r.gpu_stats().submissions - gpu.submissions,
            wakes,
            "one submission per phase"
        );
        assert_eq!(r.gpu_stats().passes - gpu.passes, wakes);
        assert_eq!(
            r.stats().rows_drawn - stats.rows_drawn,
            wakes,
            "only the cursor's row"
        );
    }
}

#[test]
fn the_blink_phase_draws_the_cursor_and_the_cell_under_it_like_the_reference() {
    let mut rt = runtime(
        12,
        3,
        &["ab日c\r\nline".as_bytes(), BLINKING_BLOCK].concat(),
    );
    let mut pair = Pair::new(12, 3);
    pair.show(&rt.snapshot().unwrap());
    pair.assert_same("phase on");
    let mut images = Vec::new();
    for phase in [false, true, false, true] {
        pair.overlay(Overlay {
            cursor_phase_on: phase,
            ..Overlay::default()
        });
        pair.assert_same(if phase { "phase on" } else { "phase off" });
        images.push(pair.gpu.read_image().unwrap());
    }
    assert_ne!(
        images[0], images[1],
        "the cursor really appears and disappears"
    );
    assert_eq!(
        (&images[0], &images[1]),
        (&images[2], &images[3]),
        "and the phases repeat exactly"
    );
}

#[test]
fn a_steady_or_hidden_cursor_arms_no_timer_and_keeps_the_gpu_asleep() {
    let clock = BlinkClock::new(BLINK_HALF_PERIOD, Duration::ZERO);
    let (mut rt, steady) = shown(STEADY_BLOCK, "steady");
    let mut renderers = [steady];
    let before = renderers[0].gpu_stats();
    assert_eq!(
        clock.next_wake(Duration::ZERO, renderers.iter()),
        None,
        "no timer to arm"
    );
    assert_eq!(
        run_timer(&mut renderers, &clock, Duration::ZERO, SECONDS_60),
        0
    );
    // Even a host that toggled the phase anyway costs nothing: a steady cursor ignores it.
    renderers[0]
        .set_overlay(Overlay {
            cursor_phase_on: false,
            ..Overlay::default()
        })
        .unwrap();
    assert!(!renderers[0].needs_draw());
    assert_eq!(renderers[0].draw().unwrap(), 0);
    assert_eq!(
        renderers[0].gpu_stats(),
        before,
        "60 s of idle: no submission at all"
    );
    // A blinking cursor that is hidden (DECTCEM) wants no timer either, and one that is shown again does.
    support::feed(&mut rt, &[BLINKING_BLOCK, b"\x1b[?25l"].concat());
    renderers[0]
        .apply(&rt.take_frame().unwrap().unwrap())
        .unwrap();
    assert_eq!(clock.next_wake(Duration::ZERO, renderers.iter()), None);
    support::feed(&mut rt, b"\x1b[?25h");
    renderers[0]
        .apply(&rt.take_frame().unwrap().unwrap())
        .unwrap();
    assert!(clock.next_wake(Duration::ZERO, renderers.iter()).is_some());
}

#[test]
fn a_suspended_lost_or_destroyed_renderer_wants_no_timer() {
    let (mut rt, mut r) = shown(BLINKING_BLOCK, "x");
    assert!(r.wants_blink_timer());
    r.suspend();
    assert!(!r.wants_blink_timer(), "a hidden surface blinks nothing");
    r.resume().unwrap();
    assert!(r.wants_blink_timer());
    r.lose_device();
    assert!(!r.wants_blink_timer(), "a lost device blinks nothing");
    r.resume().unwrap();
    assert!(
        !r.wants_blink_timer(),
        "nor does a renderer that waits for its snapshot"
    );
    r.apply(&rt.snapshot().unwrap()).unwrap();
    assert!(r.wants_blink_timer());
    r.destroy();
    assert!(!r.wants_blink_timer());
}

#[test]
fn a_selection_drag_redraws_only_the_rows_it_changes_and_matches_the_reference() {
    let mut rt = runtime(
        14,
        6,
        "0123456789abcd\r\nabcdefghijklmn\r\nline three 日本\r\nfour\r\nfive\r\nsix\x1b[?25l"
            .as_bytes(),
    );
    let mut pair = Pair::new(14, 6);
    pair.show(&rt.snapshot().unwrap());
    let anchor = (3, 1);
    let mut previous = pair.gpu.stats().rows_drawn;
    for (step, head) in [(5, 1), (9, 1), (9, 2), (2, 2), (6, 4), (6, 3), (3, 1)]
        .into_iter()
        .enumerate()
    {
        let before = pair.gpu.gpu_stats();
        pair.overlay(Overlay {
            selection: Some(Selection {
                kind: SelectionKind::Linear,
                anchor,
                head,
            }),
            ..Overlay::default()
        });
        let after = pair.gpu.gpu_stats();
        let drawn = pair.gpu.stats().rows_drawn - previous;
        previous = pair.gpu.stats().rows_drawn;
        assert_eq!(
            after.submissions - before.submissions,
            1,
            "step {step}: one pass"
        );
        assert!(
            drawn <= 3,
            "step {step}: {drawn} rows for moving the head from one cell to the next"
        );
        pair.assert_same(&format!("selection step {step}"));
    }
    pair.overlay(Overlay::default());
    pair.assert_same("selection cleared");
    let held = pair.gpu.gpu_stats();
    pair.overlay(Overlay::default());
    assert_eq!(
        pair.gpu.gpu_stats(),
        held,
        "clearing a cleared selection is free"
    );
}

#[test]
fn a_display_scale_change_repaints_from_the_held_screen_at_every_scale() {
    let text = "Hi 日本 e\u{301} \u{1F600}\r\n\x1b[1mbold\x1b[0m \x1b[4mline\x1b[0m\r\n\x1b[7minv\x1b[0m\x1b[2 q\x1b[3;2H";
    let rt_text = text.as_bytes();
    let mut rt = runtime(16, 3, rt_text);
    let first = Appearance::default();
    let mut pair = Pair::at(gpu_at(16, 3, &first), 16, 3, &first);
    pair.show(&rt.snapshot().unwrap());
    pair.assert_same("1x");
    for (n, d) in [(2, 1), (3, 1), (3, 2), (5, 4), (1, 1)] {
        let appearance = Appearance {
            metrics: CellMetrics::default().scaled(n, d).unwrap(),
            ..Appearance::default()
        };
        let before = pair.gpu.gpu_stats();
        let (gpu_rows, cpu_rows) = pair.rescale(16, 3, &appearance);
        assert_eq!(
            (gpu_rows, cpu_rows),
            (3, 3),
            "{n}/{d}: every row, no snapshot needed"
        );
        pair.assert_same(&format!("{n}/{d}x"));
        let fresh = {
            let mut fresh = Pair::at(gpu_at(16, 3, &appearance), 16, 3, &appearance);
            fresh.show(&rt.snapshot().unwrap());
            fresh.gpu.read_image().unwrap()
        };
        assert_eq!(
            pair.gpu.read_image().unwrap(),
            fresh,
            "{n}/{d}x: as if created at that scale"
        );
        assert!(
            pair.gpu.gpu_stats().glyph_misses > before.glyph_misses,
            "{n}/{d}x: masks of the new size"
        );
        let m = appearance.metrics;
        assert_eq!(
            pair.gpu.memory().target_bytes,
            u64::from(16 * m.cell_width * 3 * m.cell_height * 4)
        );
    }
}

#[test]
fn a_scale_the_atlas_cannot_hold_is_refused_and_changes_nothing() {
    let (mut rt, _) = shown(STEADY_BLOCK, "keep me");
    let small = target(20, 4).with_atlas_side(64);
    let mut r = WgpuRenderer::create(small, Appearance::default()).unwrap();
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.draw().unwrap();
    let before = r.read_image().unwrap();
    let huge = Appearance {
        metrics: CellMetrics {
            cell_width: 16,
            cell_height: 80,
            underline_y: 60,
            strikethrough_y: 40,
            line_thickness: 2,
        },
        ..Appearance::default()
    };
    assert_eq!(r.set_appearance(huge), Err(RenderError::InvalidSize));
    assert!(!r.needs_draw(), "a refused appearance repaints nothing");
    assert_eq!(
        r.read_image().unwrap(),
        before,
        "and the picture is as it was"
    );
    assert_eq!(r.draw().unwrap(), 0);
}

#[test]
fn output_between_two_refreshes_costs_one_frame_at_any_refresh_rate() {
    let mut rt = runtime(40, 6, b"");
    let mut r = gpu(40, 6);
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.draw().unwrap();
    r.present().unwrap();
    let mut pacer = FramePacer::new(60);
    for (second, hz) in [60u64, 120, 90].into_iter().enumerate() {
        pacer.set_refresh_hz(hz as u32);
        let before = (r.gpu_stats().submissions, r.stats().frames_drawn);
        let mut frames = 0u64;
        // One second of continuous output, a burst every millisecond, the host checking its pacer
        // every 100 microseconds (a millisecond tick would quantize a 120 Hz display to 111 frames).
        for tick in 0..10_000u64 {
            let now = Duration::from_micros(second as u64 * 2_000_000 + tick * 100);
            if tick % 10 == 0 {
                support::feed(&mut rt, format!("\r\ntick {hz} {tick}").as_bytes());
                if let Some(frame) = rt.take_frame().unwrap() {
                    r.apply(&frame).unwrap();
                }
            }
            if pacer
                .next_frame(now, r.needs_draw())
                .is_some_and(|due| due <= now)
            {
                r.draw().unwrap();
                r.present().unwrap();
                pacer.drew(now);
                frames += 1;
            }
        }
        let rate = hz;
        assert!(
            frames.abs_diff(rate) <= 2,
            "{hz} Hz: {frames} frames in one second"
        );
        assert_eq!(
            r.gpu_stats().submissions - before.0,
            frames,
            "{hz} Hz: one submission per frame"
        );
        assert_eq!(r.stats().frames_drawn - before.1, frames);
        // The output stops: nothing needs drawing, the pacer arms no timer, and nothing is submitted.
        if r.needs_draw() {
            r.draw().unwrap();
            r.present().unwrap();
        }
        assert_eq!(
            pacer.next_frame(Duration::from_secs(second as u64 * 2 + 1), r.needs_draw()),
            None
        );
    }
}

#[test]
fn a_forced_device_loss_recovers_the_same_picture_in_bounded_time_every_time() {
    let mut rt = runtime(
        30,
        4,
        "before the loss 日本 \x1b[1mbold\x1b[0m\r\nsecond \x1b[4mline\x1b[0m".as_bytes(),
    );
    let mut pair = Pair::new(30, 4);
    pair.show(&rt.snapshot().unwrap());
    pair.assert_same("before any loss");
    let live = pair.gpu.live_resources().unwrap();
    let mut worst = Duration::ZERO;
    for cycle in 1..=5u64 {
        pair.gpu.lose_device();
        assert_eq!(pair.gpu.draw(), Err(RenderError::DeviceLost));
        assert_eq!(pair.gpu.present(), Err(RenderError::DeviceLost));
        let started = Instant::now();
        pair.gpu.resume().unwrap();
        pair.gpu.apply(&rt.snapshot().unwrap()).unwrap();
        assert_eq!(
            pair.gpu.draw().unwrap(),
            4,
            "everything again, from core state"
        );
        pair.gpu.present().unwrap();
        worst = worst.max(started.elapsed());
        pair.assert_same(&format!("after loss {cycle}"));
        assert_eq!(pair.gpu.gpu_stats().device_recoveries, cycle);
        assert_eq!(
            pair.gpu.live_resources().unwrap(),
            live,
            "a recovered device holds what a new one does"
        );
    }
    assert!(worst < Duration::from_secs(5), "recovery took {worst:?}");
    let stats = pair.gpu.gpu_stats();
    assert!(stats.recovery_time > Duration::ZERO && stats.recovery_time < Duration::from_secs(20));
    eprintln!("5 recoveries: resume + snapshot + draw + present worst {worst:?}, device and resources {:?} in total", stats.recovery_time);
}

#[test]
fn a_loss_in_the_middle_of_a_burst_and_a_reset_behind_the_renderers_back_both_recover() {
    let mut rt = runtime(20, 3, b"start");
    let mut pair = Pair::new(20, 3);
    pair.show(&rt.snapshot().unwrap());
    // A frame arrives, then the device goes before it is drawn.
    support::feed(&mut rt, b"\r\nmid burst");
    pair.gpu.apply(&rt.take_frame().unwrap().unwrap()).unwrap();
    pair.gpu.lose_device();
    assert_eq!(pair.gpu.draw(), Err(RenderError::DeviceLost));
    pair.gpu.resume().unwrap();
    pair.show_snapshot(&mut rt);
    pair.assert_same("loss between apply and draw");
    // The device is reset without the renderer being told: it learns from the device itself.
    support::feed(&mut rt, b"\r\nafter reset");
    pair.gpu.apply(&rt.take_frame().unwrap().unwrap()).unwrap();
    pair.gpu.draw().unwrap();
    pair.gpu.reset_device_behind_the_renderers_back();
    let mut seen = None;
    for _ in 0..1_000 {
        match pair.gpu.present().and_then(|()| pair.gpu.draw().map(drop)) {
            Err(error) => {
                seen = Some(error);
                break;
            }
            Ok(()) => std::thread::sleep(Duration::from_millis(1)),
        }
    }
    assert_eq!(
        seen,
        Some(RenderError::DeviceLost),
        "a reset device is reported as lost"
    );
    pair.gpu.resume().unwrap();
    pair.show_snapshot(&mut rt);
    pair.assert_same("after the unannounced reset");
}
