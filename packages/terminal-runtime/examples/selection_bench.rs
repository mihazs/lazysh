//! Host cost of the selection and search queries on a large scrollback ([#1320]): the text of
//! everything, a search that misses (the worst case: every row is read), a word under a finger, and the link detection a tap runs.
//! Core only: no bridge, no JavaScript, no device.
//! `cargo run --release --example selection_bench`; the caller records host, toolchain and commit
//! next to the output.
//!
//! [#1320]: https://github.com/mihazs/lazysh/issues/1320

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::{CellPos, Config, Direction, Size, TerminalRuntime};
use std::time::Instant;
use support::*;

fn millis<T>(runs: usize, mut work: impl FnMut() -> T) -> Vec<f64> {
    let mut samples: Vec<f64> = (0..runs)
        .map(|_| {
            let started = Instant::now();
            std::hint::black_box(work());
            started.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    samples
}

fn report(label: &str, samples: &[f64]) {
    println!(
        "{label}: {} runs, p50 {:.3} ms, p95 {:.3} ms, max {:.3} ms",
        samples.len(),
        samples[samples.len() / 2],
        samples[(samples.len() - 1) * 95 / 100],
        samples[samples.len() - 1],
    );
}

fn main() {
    for lines in [5_000usize, 20_000] {
        let mut rt = TerminalRuntime::new(Config {
            size: Size::new(80, 24),
            scrollback_bytes: 256 * 1024 * 1024,
            ..Config::default()
        })
        .unwrap();
        let text: String = (0..lines)
            .map(|i| {
                format!("line {i:06} the quick brown fox jumps over the lazy dog 0123456789\r\n")
            })
            .collect();
        feed(&mut rt, text.as_bytes());
        let all = rt.buffer_range().unwrap().unwrap();
        println!("-- {lines} lines, {} rows held", all.end.y + 1);
        let out = rt.selection_text(all).unwrap();
        report(
            &format!(
                "selection_text of everything ({:.1} MiB)",
                out.len() as f64 / 1048576.0
            ),
            &millis(7, || rt.selection_text(all).unwrap()),
        );
        report(
            "search that misses (every row read)",
            &millis(7, || {
                rt.search("no such text", Direction::Forward, None).unwrap()
            }),
        );
        report(
            "find_urls and find_paths on one row (a tap)",
            &millis(2000, || {
                let row = lines / 2;
                (rt.find_urls(row).unwrap(), rt.find_paths(row).unwrap())
            }),
        );
        report(
            "word_at under a finger",
            &millis(2000, || {
                rt.word_at(CellPos {
                    x: 12,
                    y: lines / 2,
                })
                .unwrap()
            }),
        );
    }
}
