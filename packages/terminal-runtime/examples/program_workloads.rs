//! The program workloads of the benchmark suite (W5 vim, W6 tmux and Zellij, W7 Mosh resize and reconnect, W8 agent screens and
//! streaming, W11 background, resume and surface recreation) on the core, replaying the bytes and holding the screens that
//! `e2e/terminal-programs.spec.ts` replays through xterm.js. The file comes from `bun bench/programWorkloads.ts <file> [agent tokens]`
//! in apps/client; every run ends on the recorded screen or the example panics. Host numbers only: no transport, bridge, renderer
//! or device, and a "frame" is the dirty-row frame a renderer would draw, not a draw.
//! `cargo run --release --example program_workloads -- <file> [repetitions]`.

#[path = "../tests/support/mod.rs"]
mod support;

use base64::Engine;
use lazysh_terminal_runtime::{Config, Size, TerminalRuntime};
use serde::Deserialize;
use std::time::Instant;
use support::*;

#[derive(Deserialize)]
struct Check {
    cursor: (u16, u16),
    lines: Option<Vec<String>>,
    size: Option<(u16, u16)>,
    row1: Option<String>,
}

#[derive(Deserialize)]
struct Replay {
    id: String,
    title: String,
    variant: String,
    cols: u16,
    rows: u16,
    kind: String,
    repeatable: bool,
    steps: Vec<String>,
    checks: Vec<Option<Check>>,
}

/// Deliveries of the W11 stream while nothing is drawn: about 2 MiB of Herdr redraws, as in the xterm.js spec.
const COPIES: usize = 40;

fn runtime_for(replay: &Replay) -> TerminalRuntime {
    TerminalRuntime::new(Config {
        size: Size {
            cols: replay.cols,
            rows: replay.rows,
            cell_width_px: CELL_W,
            cell_height_px: CELL_H,
        },
        canonical_frames: replay.kind == "mosh",
        ..Config::default()
    })
    .expect("runtime")
}

/// What a step is delivered as: its bytes, or a Mosh body inside the begin and end envelopes naming its size.
fn delivery(replay: &Replay, steps: &[Vec<u8>], index: usize) -> Vec<u8> {
    let Some((cols, rows)) = replay.checks[index].as_ref().and_then(|check| check.size) else {
        return steps[index].clone();
    };
    let id = index + 1;
    let mut out = format!("\x1b]7777;lazysh-mosh;1;begin;{id};{cols};{rows}\x1b\\").into_bytes();
    out.extend(&steps[index]);
    out.extend(format!("\x1b]7777;lazysh-mosh;1;end;{id}\x1b\\").bytes());
    out
}

fn holds(rt: &mut TerminalRuntime, check: &Option<Check>) -> bool {
    let Some(check) = check else { return true };
    let frame = rt.snapshot().expect("snapshot");
    let rows = lines(&frame);
    let cursor = frame.cursor.viewport.map(|at| (at.x, at.y));
    let size = (rt.size().cols, rt.size().rows);
    cursor == Some(check.cursor)
        && check.size.is_none_or(|expected| expected == size)
        && check.row1.as_ref().is_none_or(|row| rows[1] == *row)
        && check.lines.as_ref().is_none_or(|expected| {
            // `lines` keeps only the rows of the frame, trimmed like the recorded ones.
            rows.len() == expected.len() && rows.iter().zip(expected).all(|(a, b)| a == b)
        })
}

fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1e3
}

fn spread(mut values: Vec<f64>) -> String {
    values.sort_by(f64::total_cmp);
    format!(
        "{:.3} / {:.3} / {:.3}",
        percentile(&values, 0.5),
        percentile(&values, 0.95),
        percentile(&values, 0.99)
    )
}

/// Parse volume of the recorded stream delivered back to back, and the same for the hidden-then-resumed run of W11.
fn volume(replay: &Replay, steps: &[Vec<u8>], copies: usize) -> (TerminalRuntime, f64) {
    let bytes: usize = steps.iter().map(Vec::len).sum();
    let mut rt = runtime_for(replay);
    let started = Instant::now();
    for _ in 0..copies {
        steps.iter().for_each(|step| feed_chunk(&mut rt, step));
    }
    (
        rt,
        (copies * bytes) as f64 / 1048576.0 / (ms(started) / 1e3),
    )
}

/// W5 to W8: fresh sessions take the steps one at a time; time to parse a step, and to parse it and take the frame of the rows it changed.
fn stream(replay: &Replay, steps: &[Vec<u8>], reps: usize) -> (String, String, String) {
    let (mut apply, mut frames) = (Vec::new(), Vec::new());
    for _ in 0..reps {
        let mut rt = runtime_for(replay);
        for index in 0..steps.len() {
            let data = delivery(replay, steps, index);
            let started = Instant::now();
            feed_chunk(&mut rt, &data);
            apply.push(ms(started));
            let drawn = rt.take_frame().expect("frame");
            frames.push(ms(started));
            assert!(
                drawn.is_some(),
                "{}: step {index} changed nothing",
                replay.variant
            );
            assert!(
                holds(&mut rt, &replay.checks[index]),
                "{}: step {index} is not the recorded screen",
                replay.variant
            );
        }
        assert!(rt.display_failure().is_none());
    }
    let other = if replay.repeatable {
        // The same stream delivered back to back, to about 2 MiB: the parse throughput of the recorded bytes.
        let bytes: usize = steps.iter().map(Vec::len).sum();
        let copies = (2usize << 20).div_ceil(bytes);
        let (mut rt, mib_s) = volume(replay, steps, copies);
        assert!(
            holds(&mut rt, replay.checks.last().unwrap()),
            "{}: not the recorded screen after {copies} deliveries",
            replay.variant
        );
        format!("{copies} deliveries in a row: {mib_s:.1} MiB/s")
    } else {
        String::new()
    };
    (spread(apply), spread(frames), other)
}

/// W11: the output is parsed while nothing is drawn, then the surface resumes (the frame of what changed) and is recreated (every row).
fn background(replay: &Replay, steps: &[Vec<u8>], reps: usize) -> String {
    let (mut parse, mut resume, mut recreate) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..reps {
        let (mut rt, mib_s) = volume(replay, steps, COPIES);
        parse.push(mib_s);
        let started = Instant::now();
        assert!(
            rt.take_frame().expect("frame").is_some(),
            "{}: nothing to draw on resume",
            replay.variant
        );
        resume.push(ms(started));
        let started = Instant::now();
        let _ = rt.snapshot().expect("snapshot");
        recreate.push(ms(started));
        assert!(
            holds(&mut rt, replay.checks.last().unwrap()),
            "{}: not the recorded screen",
            replay.variant
        );
    }
    let (mid, lo, hi) = median(parse);
    format!(
        "hidden parse of {COPIES} deliveries {mid:.1} MiB/s ({lo:.1} to {hi:.1}); resume frame {} ms; recreated surface (snapshot) {} ms",
        spread(resume),
        spread(recreate)
    )
}

fn main() {
    let mut args = std::env::args().skip(1);
    let file = args
        .next()
        .expect("usage: program_workloads <file> [repetitions]");
    let reps: usize = args.next().map_or(100, |n| n.parse().expect("repetitions"));
    let replays: Vec<Replay> =
        serde_json::from_slice(&std::fs::read(&file).expect("workload file"))
            .expect("workload file is the output of bench/programWorkloads.ts");
    println!("host load average at start: {}", load_average());
    println!("{reps} fresh sessions per workload; p50 / p95 / p99 in ms\n");
    println!("| workload | variant | geometry | steps | bytes | parse a step, ms | parse and take the frame, ms | other |\n|---|---|---|---|---|---|---|---|");
    for replay in &replays {
        let steps: Vec<Vec<u8>> = replay
            .steps
            .iter()
            .map(|step| {
                base64::engine::general_purpose::STANDARD
                    .decode(step)
                    .expect("base64")
            })
            .collect();
        assert_eq!(replay.checks.len(), steps.len());
        let (apply, frames, other) = if replay.id == "W11" {
            ("-".into(), "-".into(), background(replay, &steps, reps))
        } else {
            stream(replay, &steps, reps)
        };
        println!(
            "| {} {} | {} | {}x{} | {} | {} | {apply} | {frames} | {other} |",
            replay.id,
            replay.title,
            replay.variant,
            replay.cols,
            replay.rows,
            steps.len(),
            steps.iter().map(Vec::len).sum::<usize>(),
        );
    }
}
