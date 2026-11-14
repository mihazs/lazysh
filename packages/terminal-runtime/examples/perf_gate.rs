//! Performance regression gate for the terminal runtime ([#1341](https://github.com/mihazs/lazysh/issues/1341)).
//! Run in release: `cargo run --release --example perf_gate [-- --inject slow|allocs]`.
//!
//! Exit 0: every metric is inside its limit. Exit 1: a metric regressed (the table says which).
//! Anything else is a crash. Noise handling, in order of preference (see "Regression benchmarks in
//! CI" in docs/architecture/terminal-benchmarks.md):
//!   1. counts that do not depend on the host (allocations, scrollback rows, bytes uploaded, memory
//!      per session) carry tight limits;
//!   2. timed metrics are ratios of two passes in the same process (frame cost over parse cost), so
//!      the host's speed and its load cancel, taken as the best of several passes, because noise only
//!      ever slows a pass down;
//!   3. the only absolute speed is a floor several times below any host this ran on, to catch a
//!      collapse and nothing finer;
//!   4. a timed metric below its limit is measured again, up to `ATTEMPTS` batches, before it fails.
//!
//! `--inject` slows the frame path down (`slow`) or makes it allocate more (`allocs`) so CI can prove
//! the gate fails when it should.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::{Size, TerminalRenderer, TerminalRuntime};
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::{black_box, spin_loop};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Instant;
use support::*;

/// Counts allocations; a counter increment is far cheaper than the allocation it counts.
struct Counting;
static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Relaxed);
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

// Limits, measured on the host recorded in docs/architecture/terminal-benchmarks.md.
const LIMIT_ROWS_KEPT: f64 = 5200.0;
const LIMIT_RSS_PER_SESSION_KIB: f64 = 5000.0;
const LIMIT_CHURN_GROWTH_KIB: f64 = 2048.0;
const LIMIT_ALLOCS_VT: f64 = 142.0;
const LIMIT_ALLOCS_FRAME: f64 = 260_000.0;
const LIMIT_UPLOAD_PER_MIB: f64 = 2.87;
const LIMIT_FRAME_RATIO_PLAIN: f64 = 0.05;
const LIMIT_FRAME_RATIO_ANSI: f64 = 0.40;
const LIMIT_VT_FLOOR_MIB_S: f64 = 100.0;

const MIB: usize = 1024 * 1024;
/// Bytes per timed pass; 8 MiB keeps a pass near a tenth of a second on the slowest stage.
const VOLUME: usize = 8 * MIB;
const RUNS: usize = 5;
const ATTEMPTS: usize = 3;

#[derive(Clone, Copy, PartialEq)]
enum Inject {
    None,
    Slow,
    Allocs,
}

enum Limit {
    AtLeast(f64),
    AtMost(f64),
}

struct Metric {
    name: &'static str,
    unit: &'static str,
    value: f64,
    limit: Limit,
    /// Where the limit comes from; printed so a failure explains itself.
    basis: &'static str,
}

impl Metric {
    fn ok(&self) -> bool {
        match self.limit {
            Limit::AtLeast(min) => self.value >= min,
            Limit::AtMost(max) => self.value <= max,
        }
    }
}

/// The frame stage a renderer pays on every refresh, with the injected regression if asked.
fn frame_stage(inject: Inject) -> impl FnMut(&mut TerminalRuntime) {
    move |rt| {
        let started = Instant::now();
        let frame = black_box(rt.take_frame().expect("frame"));
        match inject {
            Inject::None => {}
            Inject::Slow => {
                let until = Instant::now() + started.elapsed() * 3;
                while Instant::now() < until {
                    spin_loop();
                }
            }
            Inject::Allocs => {
                let cells = frame.iter().flat_map(|f| &f.dirty).map(|r| r.cells.len());
                (0..cells.sum::<usize>()).for_each(|n| drop(black_box(Box::new(n))));
            }
        }
    }
}

/// Best throughput of the VT alone and of VT plus a frame per chunk, and their ratio. A batch that
/// misses `min_ratio` is repeated (the bests carry over) before the ratio is reported.
fn frame_cost(data: &[u8], inject: Inject, min_ratio: f64) -> (f64, f64, f64) {
    let (mut vt, mut framed) = (0f64, 0f64);
    for _ in 0..ATTEMPTS {
        for _ in 0..RUNS {
            vt = vt.max(pass(data, None));
            framed = framed.max(pass(data, Some(&mut frame_stage(inject))));
        }
        if framed / vt >= min_ratio {
            break;
        }
    }
    (vt, framed, framed / vt)
}

fn allocations_per_mib(data: &[u8], stage: Option<&mut dyn FnMut(&mut TerminalRuntime)>) -> f64 {
    let before = ALLOCATIONS.load(Relaxed);
    pass(data, stage);
    (ALLOCATIONS.load(Relaxed) - before) as f64 / (data.len() / MIB) as f64
}

/// Reference renderer bytes uploaded per MiB of output for a full-screen-redraw workload with one
/// frame per credit window: what damage tracking is for.
fn uploaded_per_mib(data: &[u8]) -> f64 {
    let mut rt = runtime(80, 24);
    let mut renderer = reference_renderer(Size::new(80, 24));
    for window in data.chunks(WINDOW) {
        feed(&mut rt, window);
        if let Some(frame) = rt.take_frame().expect("frame") {
            draw_frame(&mut renderer, &frame);
        }
    }
    renderer.stats().bytes_uploaded as f64 / MIB as f64 / (data.len() / MIB) as f64
}

/// Resident growth in KiB across 80 more create, feed 1 MiB and drop rounds after 20 warm-up ones.
fn churn_growth(data: &[u8]) -> Option<u64> {
    let round = || sessions_rss_growth(1, data);
    (0..20).try_for_each(|_| round().map(drop))?;
    let before = rss_kib()?;
    (0..80).try_for_each(|_| round().map(drop))?;
    Some(rss_kib()?.saturating_sub(before))
}

fn main() {
    let mut args = std::env::args().skip(1);
    let inject = match (args.next().as_deref(), args.next().as_deref()) {
        (None, _) => Inject::None,
        (Some("--inject"), Some("slow")) => Inject::Slow,
        (Some("--inject"), Some("allocs")) => Inject::Allocs,
        _ => panic!("usage: perf_gate [--inject slow|allocs]"),
    };
    println!("host load average at start: {}", load_average());
    let mut metrics = Vec::new();

    // Memory first: resident figures are deltas, and the large inputs below would blur them.
    let lines = fit_lines(VOLUME, 80);
    let rows = rows_kept(80, 4 * MIB, &lines);
    metrics.push(Metric {
        name: "scrollback rows kept, 80 columns, default 4 MiB budget",
        unit: "rows",
        value: rows as f64,
        limit: Limit::AtLeast(LIMIT_ROWS_KEPT),
        basis: "the history a session keeps for its memory; vendored libghostty-vt, deterministic",
    });
    if let Some(grown) = sessions_rss_growth(10, &lines) {
        metrics.push(Metric {
            name: "resident memory per session after 8 MiB of 80-column lines",
            unit: "KiB",
            value: grown as f64 / 10.0,
            limit: Limit::AtMost(LIMIT_RSS_PER_SESSION_KIB),
            basis: "10 sessions at the default budget; allocator-dependent, so a margin",
        });
    }
    if let Some(grown) = churn_growth(&lines[..MIB]) {
        metrics.push(Metric {
            name: "resident growth over 80 session create/close rounds",
            unit: "KiB",
            value: grown as f64,
            limit: Limit::AtMost(LIMIT_CHURN_GROWTH_KIB),
            basis: "no growth over session churn",
        });
    }
    drop(lines);

    let (plain, ansi, redraw) = (plain(VOLUME), ansi_color(VOLUME), redraw(VOLUME));

    metrics.push(Metric {
        name: "allocations per MiB, VT only (plain text)",
        unit: "allocs",
        value: allocations_per_mib(&plain, None),
        limit: Limit::AtMost(LIMIT_ALLOCS_VT),
        basis: "the parse path must not allocate per byte; deterministic",
    });
    metrics.push(Metric {
        name: "allocations per MiB, VT plus a frame per chunk (plain text)",
        unit: "allocs",
        value: allocations_per_mib(&plain, Some(&mut frame_stage(inject))),
        limit: Limit::AtMost(LIMIT_ALLOCS_FRAME),
        basis: "the frame type's allocation cost; deterministic",
    });
    metrics.push(Metric {
        name: "reference renderer upload per MiB of output (full-screen redraw)",
        unit: "MiB",
        value: uploaded_per_mib(&redraw),
        limit: Limit::AtMost(LIMIT_UPLOAD_PER_MIB),
        basis: "dirty-row damage tracking; deterministic",
    });

    for (name, data, min_ratio) in [
        ("plain text", &plain, LIMIT_FRAME_RATIO_PLAIN),
        ("ANSI + truecolor", &ansi, LIMIT_FRAME_RATIO_ANSI),
    ] {
        let (vt, _, ratio) = frame_cost(data, inject, min_ratio);
        if name == "plain text" {
            metrics.push(Metric {
                name: "VT-only throughput (plain text), best of several passes",
                unit: "MiB/s",
                value: vt,
                limit: Limit::AtLeast(LIMIT_VT_FLOOR_MIB_S),
                basis: "a floor far below any host measured, for collapse only",
            });
        }
        metrics.push(Metric {
            name: if name == "plain text" {
                "frame cost, plain text: framed over VT-only throughput"
            } else {
                "frame cost, ANSI + truecolor: framed over VT-only throughput"
            },
            unit: "ratio",
            value: ratio,
            limit: Limit::AtLeast(min_ratio),
            basis: "same process, best of several passes; the host's speed cancels",
        });
    }

    println!("\n| metric | value | limit | basis | |\n|---|---|---|---|---|");
    for m in &metrics {
        let (op, bound) = match m.limit {
            Limit::AtLeast(v) => (">=", v),
            Limit::AtMost(v) => ("<=", v),
        };
        println!(
            "| {} | {:.3} {} | {op} {bound} | {} | {} |",
            m.name,
            m.value,
            m.unit,
            m.basis,
            if m.ok() { "ok" } else { "**FAIL**" }
        );
    }
    let failed = metrics.iter().filter(|m| !m.ok()).count();
    println!("\n{failed} of {} metrics failed", metrics.len());
    std::process::exit(i32::from(failed > 0));
}
