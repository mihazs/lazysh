//! Host cost of one control-plane answer (#1321): the state plus a window of row text, as the adapter pulls it
//! at most once per refresh interval. Core only: no bridge, no JavaScript, no device. Measured while the reader
//! follows the output and while they are scrolled back (the cursor read then moves the viewport and back).
//! `cargo run --release --example control_bench`; the caller records host, toolchain and commit next to the output.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::{Config, ScrollAction, Size, TerminalRuntime};
use support::{feed, Timings};

fn measure(label: &str, mut query: impl FnMut() -> usize) {
    let mut bytes = 0;
    let timings = Timings::of(5_000, || bytes = query());
    println!("{label}: {timings}, {bytes} bytes of row text");
}

fn main() {
    for (cols, rows, lines) in [(80u16, 24u16, 10_000usize), (46, 30, 10_000), (200, 60, 10_000)] {
        let mut rt = TerminalRuntime::new(Config {
            size: Size::new(cols, rows),
            scrollback_bytes: 16 << 20,
            ..Config::default()
        })
        .unwrap();
        let text: String = (0..lines)
            .map(|line| format!("agent output {line} with some text to fill a row\r\n"))
            .collect();
        feed(&mut rt, text.as_bytes());
        let held = rt.viewport().unwrap().length;
        println!("{cols}x{rows}, {held} rows held:");
        for window in [rows as usize, 256] {
            measure(&format!("  following, window {window}"), || {
                let answer = rt.control_snapshot(window).unwrap();
                answer.window.rows.iter().map(String::len).sum()
            });
        }
        rt.control_scroll(ScrollAction::Row(held / 2), 256).unwrap();
        measure("  scrolled back, window 256", || {
            let answer = rt.control_snapshot(256).unwrap();
            answer.window.rows.iter().map(String::len).sum()
        });
    }
}
