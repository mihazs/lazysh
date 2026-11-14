//! What the wgpu renderer does besides drawing (#1324): per workload the passes, instances against
//! layout draws and atlas traffic of the same frame stream as `wgpu_bench`; the cost of an idle
//! screen (a hundred thousand draw and present calls with nothing changed: submissions, context
//! switches of this process, nanoseconds per call); GPU memory by grid size; and glyph churn through
//! a small atlas (memory and live buffers before and after, evictions); the cursor blink timer over
//! real time (wakeups and submissions per second, steady against blinking, three sessions on one
//! timer); and forced device loss (time to recover the picture).
//! Run in release: `cargo run --release --example renderer_stats`; the caller records the environment.

mod common;

use common::support::{feed, load_average, rss_kib, runtime, workloads};
use common::{play, show};
use lazysh_terminal_renderer_wgpu::{Target, WgpuRenderer};
use lazysh_terminal_runtime::{
    Appearance, BlinkClock, Overlay, TerminalRenderer, TerminalRuntime, BLINK_HALF_PERIOD,
};
use std::time::{Duration, Instant};

const VOLUME: usize = 16 * 1024 * 1024;
const CELL: (u32, u32) = (8, 16);
const IDLE_CALLS: u32 = 100_000;

fn renderer(cols: u16, rows: u16, atlas_side: u32) -> WgpuRenderer {
    let target = Target::new(u32::from(cols) * CELL.0, u32::from(rows) * CELL.1);
    WgpuRenderer::create(target.with_atlas_side(atlas_side), Appearance::default())
        .expect("a GPU adapter is required")
}

/// Voluntary and involuntary context switches of this process (Linux): what a polling loop would spend.
fn context_switches() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .filter(|l| l.contains("ctxt_switches"))
        .filter_map(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
        .sum()
}

fn main() {
    println!("host load average at start: {}", load_average());
    let probe = renderer(80, 24, 2048);
    println!("adapter: {:?}\n", probe.adapter());
    drop(probe);

    println!("| grid | workload | frames | rows drawn | passes | layout draws | instances | glyph hits | glyph misses | atlas upload KiB | evictions | uploaded MiB |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (grid, (cols, rows)) in [("80x24", (80, 24)), ("152x38", (152, 38))] {
        for (name, data) in &workloads() {
            let mut r = renderer(cols, rows, 2048);
            let mut rt = runtime(cols, rows);
            play(&mut r, &mut rt, data, VOLUME);
            let (g, s) = (r.gpu_stats(), r.stats());
            println!(
                "| {grid} | {name} | {} | {} | {} | {} | {} | {} | {} | {:.1} | {} | {:.2} |",
                s.frames_drawn,
                s.rows_drawn,
                g.passes,
                g.layout_draws,
                g.instances,
                g.glyph_hits,
                g.glyph_misses,
                g.atlas_upload_bytes as f64 / 1024.0,
                g.atlas_evictions,
                s.bytes_uploaded as f64 / 1048576.0,
            );
        }
    }

    println!("\nIdle screen: {IDLE_CALLS} draw + present calls with nothing changed\n");
    let mut r = renderer(80, 24, 2048);
    let mut rt = runtime(80, 24);
    feed(&mut rt, b"idle screen\r\n$ ");
    show(&mut r, &mut rt);
    let (gpu, stats, switches) = (r.gpu_stats(), r.stats(), context_switches());
    let started = Instant::now();
    for _ in 0..IDLE_CALLS {
        assert!(!r.needs_draw());
        r.draw().unwrap();
        r.present().unwrap();
    }
    let elapsed = started.elapsed();
    let after = r.gpu_stats();
    println!("| submissions | passes | frames drawn | frames presented | context switches | ns per call |");
    println!("|---|---|---|---|---|---|");
    println!(
        "| {} | {} | {} | {} | {} | {:.0} |",
        after.submissions - gpu.submissions,
        after.passes - gpu.passes,
        r.stats().frames_drawn - stats.frames_drawn,
        r.stats().frames_presented - stats.frames_presented,
        context_switches() - switches,
        elapsed.as_secs_f64() * 1e9 / f64::from(IDLE_CALLS),
    );

    println!("\nGPU memory the renderer created, by grid (8x16 px cells, 2048-texel atlas)\n");
    println!("| grid | atlas KiB | target KiB | instance buffer KiB | total KiB |");
    println!("|---|---|---|---|---|");
    for (grid, (cols, rows)) in [
        ("80x24", (80, 24)),
        ("152x38", (152, 38)),
        ("300x80", (300, 80)),
    ] {
        let (mut r, mut rt) = (renderer(cols, rows, 2048), runtime(cols, rows));
        feed(&mut rt, "日本語 plain text ".repeat(100).as_bytes());
        show(&mut r, &mut rt);
        let m = r.memory();
        let kib = |b: u64| b as f64 / 1024.0;
        println!(
            "| {grid} | {:.0} | {:.0} | {:.0} | {:.0} |",
            kib(m.atlas_bytes),
            kib(m.target_bytes),
            kib(m.instance_bytes),
            kib(m.total())
        );
    }

    println!("\nGlyph churn: 20 warm-up frames, then 4000 frames of 60 clusters never seen before (80x24 grid), resident set read every 1000 frames\n");
    println!("| atlas side | slots | memory bytes before | after | live buffers before | after | resident set KiB after 20 | 1020 | 2020 | 3020 | 4020 frames | atlas evictions | atlas spills | passes |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for side in [64, 512, 2048] {
        let mut r = renderer(80, 24, side);
        let mut rt = runtime(80, 24);
        let mut n = 0u32;
        let mut churn = |r: &mut WgpuRenderer, rt: &mut TerminalRuntime, frames: u32| {
            for _ in 0..frames {
                let text: String = (0..60)
                    .filter_map(|i| char::from_u32(0x4e00 + n * 7 + i))
                    .collect();
                n += 1;
                feed(rt, format!("\r\n{text}").as_bytes());
                show(r, rt);
            }
        };
        churn(&mut r, &mut rt, 20);
        let (mem, live) = (r.memory().total(), r.live_resources().unwrap());
        let mut rss = vec![rss_kib().unwrap_or(0)];
        for _ in 0..4 {
            churn(&mut r, &mut rt, 1000);
            rss.push(rss_kib().unwrap_or(0));
        }
        let g = r.gpu_stats();
        let rss: Vec<_> = rss.iter().map(u64::to_string).collect();
        println!(
            "| {side} | {} | {mem} | {} | {} | {} | {} | {} | {} | {} |",
            r.atlas_slots().0,
            r.memory().total(),
            live.buffers,
            r.live_resources().unwrap().buffers,
            rss.join(" | "),
            g.atlas_evictions,
            g.atlas_spills,
            g.passes,
        );
    }

    blink_and_recovery();
}

const BLINK_SECONDS: u64 = 10;
const SESSIONS: usize = 3;

/// The host's single timer over real time: sleep to the instant the clock names, set the phase on
/// every session, draw and present; count what that cost the process and the GPU.
fn blink_and_recovery() {
    println!("\nCursor blink over {BLINK_SECONDS} s of real time, {SESSIONS} sessions on one timer (80x24, half period {} ms)\n", BLINK_HALF_PERIOD.as_millis());
    println!("| cursor | wakeups | wakeups per second | submissions per session | rows drawn per session | context switches | wake lateness p50 / max (us) |");
    println!("|---|---|---|---|---|---|---|");
    for (name, style) in [("blinking block", "\x1b[1 q"), ("steady block", "\x1b[2 q")] {
        let mut sessions: Vec<_> = (0..SESSIONS)
            .map(|_| {
                let (mut r, mut rt) = (renderer(80, 24, 2048), runtime(80, 24));
                feed(&mut rt, format!("prompt $ {style}").as_bytes());
                show(&mut r, &mut rt);
                r
            })
            .collect();
        let before: Vec<_> = sessions
            .iter()
            .map(|r| (r.gpu_stats(), r.stats()))
            .collect();
        let switches = context_switches();
        let clock = BlinkClock::new(BLINK_HALF_PERIOD, Duration::ZERO);
        let (start, end) = (Instant::now(), Duration::from_secs(BLINK_SECONDS));
        let (mut wakes, mut lateness) = (0u64, Vec::new());
        loop {
            let now = start.elapsed();
            let due = match clock.next_wake(now, sessions.iter()) {
                Some(at) if at <= end => at,
                _ => {
                    // Nothing to do before the end: the process sleeps through the rest.
                    std::thread::sleep(end.saturating_sub(now));
                    break;
                }
            };
            std::thread::sleep(due.saturating_sub(now));
            lateness.push(start.elapsed().saturating_sub(due).as_micros() as f64);
            wakes += 1;
            let overlay = Overlay {
                cursor_phase_on: clock.phase_on(due),
                ..Overlay::default()
            };
            for r in &mut sessions {
                r.set_overlay(overlay).unwrap();
                r.draw().unwrap();
                r.present().unwrap();
            }
        }
        lateness.sort_by(f64::total_cmp);
        let (gpu, stats) = (sessions[0].gpu_stats(), sessions[0].stats());
        println!(
            "| {name} | {wakes} | {:.2} | {} | {} | {} | {} |",
            wakes as f64 / BLINK_SECONDS as f64,
            gpu.submissions - before[0].0.submissions,
            stats.rows_drawn - before[0].1.rows_drawn,
            context_switches() - switches,
            if lateness.is_empty() {
                "none".to_string()
            } else {
                format!(
                    "{:.0} / {:.0}",
                    lateness[lateness.len() / 2],
                    lateness[lateness.len() - 1]
                )
            },
        );
    }

    println!("\nForced device loss: 20 losses of a 80x24 renderer showing a screen of text, recovered from the core's snapshot (ms)\n");
    println!("| step | p50 | min | max |");
    println!("|---|---|---|---|");
    let (mut r, mut rt) = (renderer(80, 24, 2048), runtime(80, 24));
    feed(
        &mut rt,
        "日本語 recovery test \x1b[1mbold\x1b[0m\r\n$ "
            .repeat(12)
            .as_bytes(),
    );
    show(&mut r, &mut rt);
    let (mut resume, mut redraw) = (Vec::new(), Vec::new());
    for _ in 0..20 {
        r.lose_device();
        let started = Instant::now();
        r.resume().unwrap();
        resume.push(started.elapsed().as_secs_f64() * 1e3);
        r.apply(&rt.snapshot().unwrap()).unwrap();
        r.draw().unwrap();
        r.present().unwrap();
        redraw.push(started.elapsed().as_secs_f64() * 1e3);
    }
    for (step, mut v) in [
        ("resume (device, pipeline, resources)", resume),
        ("resume + snapshot + draw + present", redraw),
    ] {
        v.sort_by(f64::total_cmp);
        println!(
            "| {step} | {:.1} | {:.1} | {:.1} |",
            v[v.len() / 2],
            v[0],
            v[v.len() - 1]
        );
    }
    println!(
        "\ndevice recoveries counted by the renderer: {}",
        r.gpu_stats().device_recoveries
    );
}
