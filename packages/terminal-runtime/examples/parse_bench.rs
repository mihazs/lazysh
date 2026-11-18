//! Parse/state-update throughput of the runtime on this machine. Not an app benchmark: no
//! transport, no renderer, no JS bridge. Run in release: `cargo run --release --example parse_bench`.
//! Prints one markdown table; the caller records host, toolchain and commit next to it.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::TerminalRuntime;
use support::*;

const RUNS: usize = 5;

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
        let rows = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]
            .map(|budget| rows_kept(*cols as u16, budget, data));
        println!("| {name} | {} | {} | {} |", rows[0], rows[1], rows[2]);
    }
    let Some(grown) = sessions_rss_growth(10, &workloads[1].2) else {
        return;
    };
    println!("\n10 sessions, 8 MiB of 80-column lines each, default budget: RSS +{grown} KiB\n");
}

fn main() {
    println!("host load average at start: {}", load_average());
    memory();
    let mut take_frame = |rt: &mut TerminalRuntime| {
        std::hint::black_box(rt.take_frame().expect("frame"));
    };
    println!("| workload | frames collected per chunk | MiB/s median | min | max |");
    println!("|---|---|---|---|---|");
    for (name, data) in &workloads() {
        for frames in [false, true] {
            let (mid, lo, hi) = median(
                (0..RUNS)
                    .map(|_| pass(data, if frames { Some(&mut take_frame) } else { None }))
                    .collect(),
            );
            println!(
                "| {name} | {} | {mid:.1} | {lo:.1} | {hi:.1} |",
                if frames { "yes" } else { "no" }
            );
        }
    }
}
