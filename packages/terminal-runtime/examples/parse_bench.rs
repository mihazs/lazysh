//! Parse/state-update throughput of the runtime on this machine. Not an app benchmark: no
//! transport, no renderer, no JS bridge. Run in release: `cargo run --release --example parse_bench`.
//! Prints one markdown table; the caller records host, toolchain and commit next to it.

use lazysh_terminal_runtime::{Config, Offer, Size, TerminalRuntime};
use std::time::Instant;

const CHUNK: usize = 16 * 1024; // the transport's chunk size
const TOTAL: usize = 64 * 1024 * 1024;
const RUNS: usize = 5;

fn plain(total: usize) -> Vec<u8> {
    (0..)
        .flat_map(|n| {
            format!(
                "line {n:08} the quick brown fox jumps over the lazy dog 0123456789 abcdefghij\r\n"
            )
            .into_bytes()
        })
        .take(total)
        .collect()
}

fn ansi_color() -> Vec<u8> {
    (0..).flat_map(|n| format!("\x1b[{}m word{n}\x1b[0m \x1b[1;38;2;{};{};200mtruecolor\x1b[0m \x1b[48;5;{}m  \x1b[0m\r\n", 31 + n % 7, n % 256, (n * 7) % 256, n % 256).into_bytes()).take(TOTAL).collect()
}

/// Full-screen redraw: home, then 24 rows of positioned colored text, like a TUI repaint.
fn redraw() -> Vec<u8> {
    let frame: String = std::iter::once("\x1b[H".to_string())
        .chain((1..=24).map(|row| {
            format!(
                "\x1b[{row};1H\x1b[{}m{:<80}\x1b[0m",
                30 + row % 8,
                format!("row {row} status ▕██████▏ 42%")
            )
        }))
        .collect();
    frame.into_bytes().into_iter().cycle().take(TOTAL).collect()
}

fn unicode(total: usize) -> Vec<u8> {
    "日本語のテキスト 😀 e\u{301}\u{302} 👨\u{200d}👩\u{200d}👧 한국어 ‑ العربية\r\n"
        .as_bytes()
        .iter()
        .copied()
        .cycle()
        .take(total)
        .collect()
}

fn runtime() -> TerminalRuntime {
    TerminalRuntime::new(Config {
        size: Size::new(80, 24),
        ..Config::default()
    })
    .expect("runtime")
}

fn run(data: &[u8], collect_frames: bool) -> f64 {
    let mut rt = runtime();
    let start = Instant::now();
    for chunk in data.chunks(CHUNK) {
        assert_eq!(rt.offer(chunk.to_vec()), Offer::Accepted);
        rt.pump(usize::MAX);
        if collect_frames {
            std::hint::black_box(rt.take_frame().expect("frame"));
        }
    }
    data.len() as f64 / (1024.0 * 1024.0) / start.elapsed().as_secs_f64()
}

fn median(mut v: Vec<f64>) -> (f64, f64, f64) {
    v.sort_by(f64::total_cmp);
    (v[v.len() / 2], v[0], v[v.len() - 1])
}

fn rss_kib() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    Some(statm.split_whitespace().nth(1)?.parse::<u64>().ok()? * 4)
}

fn feed(rt: &mut TerminalRuntime, data: &[u8]) {
    for chunk in data.chunks(CHUNK) {
        assert_eq!(rt.offer(chunk.to_vec()), Offer::Accepted);
        rt.pump(usize::MAX);
    }
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
    let mut sessions: Vec<TerminalRuntime> = (0..10).map(|_| runtime()).collect();
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
    // Recorded with every result: the host load changes these numbers by tens of percent.
    println!(
        "host load average at start: {}",
        std::fs::read_to_string("/proc/loadavg")
            .unwrap_or_default()
            .trim()
    );
    memory();
    println!("| workload | frames collected per chunk | MiB/s median | min | max |");
    println!("|---|---|---|---|---|");
    let workloads: [(&str, Vec<u8>); 4] = [
        ("plain text", plain(TOTAL)),
        ("ANSI + truecolor", ansi_color()),
        ("full-screen redraw", redraw()),
        ("CJK/emoji/combining", unicode(TOTAL)),
    ];
    for (name, data) in &workloads {
        for frames in [false, true] {
            let (mid, lo, hi) = median((0..RUNS).map(|_| run(data, frames)).collect());
            println!(
                "| {name} | {} | {mid:.1} | {lo:.1} | {hi:.1} |",
                if frames { "yes" } else { "no" }
            );
        }
    }
}
