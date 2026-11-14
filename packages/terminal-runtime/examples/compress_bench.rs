//! What compacting a session's scrollback costs and gives back, on this machine: resident memory of
//! ten filled sessions before and after, the time of the compaction itself and of its worst bounded
//! step, and the time to read the history or to attach a view afterwards (the pages are restored on
//! access). Every pass also checks that the text is unchanged. Host numbers only: no transport, no
//! renderer, no device. `cargo run --release --example compress_bench`; the caller records host,
//! toolchain and commit next to the output.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::TerminalRuntime;
use std::time::Instant;
use support::*;

const SESSIONS: usize = 10;
const OUTPUT: usize = 8 * 1024 * 1024;

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1e3
}

/// Compact until the VT reports no more work: (total ms, worst single step ms, steps).
fn compact(rt: &mut TerminalRuntime) -> (f64, f64, usize) {
    let (start, mut worst, mut steps) = (Instant::now(), 0f64, 0);
    loop {
        let step = Instant::now();
        let more = rt.compress_scrollback().expect("compress");
        worst = worst.max(ms(step));
        steps += 1;
        if !more {
            return (ms(start), worst, steps);
        }
    }
}

fn main() {
    println!("host load average at start: {}\n", load_average());
    println!("| content (80x24, default 4 MiB scrollback) | rows kept | RSS KiB per session filled | after compaction | compaction ms (worst step ms, steps) | full history read ms: before, after | attach snapshot ms: before, after |\n|---|---|---|---|---|---|---|");
    for (name, data) in [
        ("plain text", plain(OUTPUT)),
        ("ANSI + truecolor", ansi_color(OUTPUT)),
        ("CJK/emoji/combining", unicode(OUTPUT)),
        ("plain lines, 80 columns", fit_lines(OUTPUT, 80)),
    ] {
        let before = rss_kib().expect("/proc");
        let mut sessions: Vec<TerminalRuntime> = (0..SESSIONS).map(|_| runtime(80, 24)).collect();
        sessions.iter_mut().for_each(|rt| feed(rt, &data));
        let filled = rss_kib().expect("/proc") - before;
        let rt = &mut sessions[0];
        let (rows, text) = (rt.scrollback_rows().unwrap(), rt.screen_text().unwrap());
        let read = |rt: &mut TerminalRuntime| {
            let start = Instant::now();
            let text = rt.screen_text().unwrap();
            (ms(start), text)
        };
        let attach = |rt: &mut TerminalRuntime| {
            let start = Instant::now();
            rt.snapshot().unwrap();
            ms(start)
        };
        let (read_before, _) = read(rt);
        let attach_before = attach(rt);
        let (first, worst, steps) = compact(rt);
        let mut total = first;
        for rt in &mut sessions[1..] {
            total += compact(rt).0;
        }
        let compacted = rss_kib().expect("/proc").saturating_sub(before);
        let rt = &mut sessions[0];
        let attach_after = attach(rt);
        let (read_after, after_text) = read(rt);
        assert_eq!(text, after_text, "{name}: compaction changed the history");
        assert_eq!(rows, rt.scrollback_rows().unwrap());
        println!(
            "| {name} | {rows} | {} | {} | {:.1} (worst {worst:.2}, {steps} steps) | {read_before:.1}, {read_after:.1} | {attach_before:.2}, {attach_after:.2} |",
            filled / SESSIONS as u64,
            compacted / SESSIONS as u64,
            total / SESSIONS as f64,
        );
    }
}
