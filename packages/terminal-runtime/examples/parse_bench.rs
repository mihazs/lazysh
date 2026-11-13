//! Parse/state-update throughput of the runtime on this machine. Not an app benchmark: no
//! transport, no renderer, no JS bridge. Run in release: `cargo run --release --example parse_bench`.
//! Prints one markdown table; the caller records host, toolchain and commit next to it.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::{Config, Size, TerminalRuntime};
use std::time::Instant;
use support::*;

const RUNS: usize = 5;

fn run(data: &[u8], collect_frames: bool) -> f64 {
    let mut rt = runtime(80, 24);
    let start = Instant::now();
    for chunk in data.chunks(CHUNK) {
        feed_chunk(&mut rt, chunk);
        if collect_frames {
            std::hint::black_box(rt.take_frame().expect("frame"));
        }
    }
    data.len() as f64 / (1024.0 * 1024.0) / start.elapsed().as_secs_f64()
}

fn with_scrollback(cols: u16, bytes: usize) -> TerminalRuntime {
    TerminalRuntime::new(Config {
        size: Size::new(cols, 24),
        scrollback_bytes: bytes,
        ..Config::default()
    })
    .expect("runtime")
}

/// Numbered lines that exactly fill `cols` minus one column, so none wraps.
fn fit_lines(total: usize, cols: usize) -> Vec<u8> {
    (0..)
        .flat_map(|n| format!("{n:0>w$}\r\n", w = cols - 1).into_bytes())
        .take(total)
        .collect()
}

/// Scrollback rows kept per byte budget, width and content (libghostty-vt budgets bytes, lazysh
/// lines), then resident growth for 10 sessions (measured before the large throughput inputs
/// exist, so RSS only reflects the sessions).
fn memory() {
    const OUTPUT: usize = 8 * 1024 * 1024;
    let workloads = [
        ("plain lines, 40 columns", 40, fit_lines(OUTPUT, 40)),
        ("plain lines, 80 columns", 80, fit_lines(OUTPUT, 80)),
        ("plain lines, 160 columns", 160, fit_lines(OUTPUT, 160)),
        ("CJK/emoji/combining, 80 columns", 80, unicode(OUTPUT)),
    ];
    println!("| scrollback rows kept after 8 MiB of output | 256 KiB budget | 1 MiB | 4 MiB (default) |\n|---|---|---|---|");
    for (name, cols, data) in &workloads {
        let rows = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024].map(|budget| {
            let mut rt = with_scrollback(*cols, budget);
            feed(&mut rt, data);
            rt.scrollback_rows().unwrap()
        });
        println!("| {name} | {} | {} | {} |", rows[0], rows[1], rows[2]);
    }
    let Some(before) = rss_kib() else { return };
    let mut sessions: Vec<TerminalRuntime> = (0..10).map(|_| runtime(80, 24)).collect();
    for session in &mut sessions {
        feed(session, &workloads[1].2);
    }
    println!(
        "\n10 sessions, 8 MiB of 80-column lines each, default budget: RSS +{} KiB (baseline {} KiB)\n",
        rss_kib().unwrap_or(0).saturating_sub(before),
        before
    );
}

fn main() {
    println!("host load average at start: {}", load_average());
    memory();
    println!("| workload | frames collected per chunk | MiB/s median | min | max |");
    println!("|---|---|---|---|---|");
    for (name, data) in &workloads() {
        for frames in [false, true] {
            let (mid, lo, hi) = median((0..RUNS).map(|_| run(data, frames)).collect());
            println!(
                "| {name} | {} | {mid:.1} | {lo:.1} | {hi:.1} |",
                if frames { "yes" } else { "no" }
            );
        }
    }
}
