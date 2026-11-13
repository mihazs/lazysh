//! Host cost of one Mosh display update: from the bytes of a frame (`begin` envelope, full repaint,
//! `end` envelope) to the first frame a renderer can draw, resize included. The grid alternates
//! between two sizes (or stays put, the usual case) so an update is a canonical resize, or none, followed by a repaint of every row.
//! Host numbers only: no transport, no bridge, no renderer, no device. `cargo run --release
//! --example mosh_bench`; the caller records host, toolchain and commit next to the output.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::{Config, Size, TerminalRuntime};
use std::time::Instant;
use support::*;

fn repaint(id: u64, cols: u16, rows: u16) -> Vec<u8> {
    let mut frame =
        format!("\x1b]7777;lazysh-mosh;1;begin;{id};{cols};{rows}\x1b\\\x1b[r\x1b[0m\x1b[H\x1b[2J");
    for row in 0..rows {
        frame += &format!("\x1b[{};1H\x1b[{}m", row + 1, 31 + row % 7);
        frame += &"mosh display text 0123456789 ".repeat(usize::from(cols) / 29 + 1)
            [..usize::from(cols)];
    }
    frame += &format!("\x1b[0m\x1b]7777;lazysh-mosh;1;end;{id}\x1b\\");
    frame.into_bytes()
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn main() {
    const UPDATES: u64 = 4000;
    for (label, sizes) in [
        ("80x24 (same size every update)", [(80, 24), (80, 24)]),
        ("80x24 <-> 40x12", [(80, 24), (40, 12)]),
        ("120x40 <-> 60x20", [(120, 40), (60, 20)]),
    ] {
        let mut rt = TerminalRuntime::new(Config {
            size: Size {
                cols: sizes[0].0,
                rows: sizes[0].1,
                cell_width_px: CELL_W,
                cell_height_px: CELL_H,
            },
            canonical_frames: true,
            ..Config::default()
        })
        .unwrap();
        let frames: Vec<Vec<u8>> = (0..UPDATES)
            .map(|i| {
                let (cols, rows) = sizes[(i % 2) as usize];
                repaint(i + 1, cols, rows)
            })
            .collect();
        let mut millis = Vec::with_capacity(frames.len());
        for frame in &frames {
            let started = Instant::now();
            feed(&mut rt, frame);
            let drawn = rt
                .take_frame()
                .unwrap()
                .expect("a repaint changes the screen");
            millis.push(started.elapsed().as_secs_f64() * 1e3);
            assert!(drawn.full && rt.display_failure().is_none());
        }
        millis.sort_by(f64::total_cmp);
        println!(
            "{label}: {UPDATES} updates, p50 {:.3} ms, p95 {:.3} ms, p99 {:.3} ms, max {:.3} ms",
            percentile(&millis, 0.5),
            percentile(&millis, 0.95),
            percentile(&millis, 0.99),
            millis[millis.len() - 1],
        );
    }
}
