//! What the wgpu renderer does besides drawing (#1324): per workload the passes, instances against
//! layout draws and atlas traffic of the same frame stream as `wgpu_bench`; the cost of an idle
//! screen (a hundred thousand draw and present calls with nothing changed: submissions, context
//! switches of this process, nanoseconds per call); GPU memory by grid size; and glyph churn through
//! a small atlas (memory and live buffers before and after, evictions).
//! Run in release: `cargo run --release --example renderer_stats`; the caller records the environment.

#[path = "../../terminal-runtime/tests/support/mod.rs"]
mod support;

use lazysh_terminal_renderer_wgpu::{Target, WgpuRenderer};
use lazysh_terminal_runtime::{Appearance, TerminalRenderer, TerminalRuntime};
use std::time::Instant;
use support::{feed, feed_chunk, load_average, rss_kib, runtime, workloads, CHUNK, WINDOW};

const VOLUME: usize = 16 * 1024 * 1024;
const CELL: (u32, u32) = (8, 16);
const IDLE_CALLS: u32 = 100_000;

fn renderer(cols: u16, rows: u16, atlas_side: u32) -> WgpuRenderer {
    let target = Target::new(u32::from(cols) * CELL.0, u32::from(rows) * CELL.1);
    WgpuRenderer::create(target.with_atlas_side(atlas_side), Appearance::default())
        .expect("a GPU adapter is required")
}

fn show(r: &mut WgpuRenderer, rt: &mut TerminalRuntime) {
    if let Some(frame) = rt.take_frame().expect("frame") {
        r.apply(&frame).expect("apply");
        r.draw().expect("draw");
        r.present().expect("present");
    }
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
            let mut taken = 0;
            for chunk in data[..VOLUME].chunks(CHUNK) {
                feed_chunk(&mut rt, chunk);
                taken += chunk.len();
                if taken >= WINDOW {
                    taken = 0;
                    show(&mut r, &mut rt);
                }
            }
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
}
