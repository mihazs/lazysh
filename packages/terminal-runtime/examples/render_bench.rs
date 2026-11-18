//! Cost of the renderer pipeline above the VT, per stage, on this machine. Not an app benchmark and
//! not a renderer shootout: no transport, no JS bridge, no GPU, and the reference renderer is a
//! correctness vehicle, not a candidate. It shows what every renderer pays before it draws anything
//! (a `Frame` per refresh, the renderer-side `Screen` copy) and what a CPU renderer adds.
//! Run in release: `cargo run --release --example render_bench`. Prints one markdown table; the
//! caller records host, toolchain and commit next to it.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::{Screen, Size, TerminalRenderer};
use std::time::Instant;
use support::{
    draw_frame, feed_chunk, load_average, median, reference_renderer, runtime, workloads, CHUNK,
    WINDOW,
};

const RUNS: usize = 5;

/// Bytes of each shared fixture that one pass feeds.
const VOLUME: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Vt,
    Frame,
    Screen,
    Reference,
}

const STAGES: [Stage; 4] = [Stage::Vt, Stage::Frame, Stage::Screen, Stage::Reference];

struct Sample {
    mib_per_s: f64,
    frames: u64,
    rows: u64,
    bytes_uploaded: u64,
}

/// One pass over `data` with a frame after every `every` bytes, doing the work up to `stage`.
/// The reference stage ends by checking that incremental drawing equals a full repaint.
fn run(data: &[u8], size: Size, every: usize, stage: Stage) -> Sample {
    let mut rt = runtime(size.cols, size.rows);
    let (mut renderer, mut screen) = (reference_renderer(size), Screen::new());
    let (mut frames, mut taken) = (0u64, 0usize);
    let start = Instant::now();
    for chunk in data.chunks(CHUNK) {
        feed_chunk(&mut rt, chunk);
        taken += chunk.len();
        if stage == Stage::Vt || taken < every {
            continue;
        }
        taken = 0;
        let Some(frame) = rt.take_frame().expect("frame") else {
            continue;
        };
        frames += 1;
        match stage {
            Stage::Vt | Stage::Frame => {
                std::hint::black_box(&frame);
            }
            Stage::Screen => {
                screen.apply(&frame).expect("apply");
                std::hint::black_box(screen.take_dirty());
            }
            Stage::Reference => draw_frame(&mut renderer, &frame),
        }
    }
    let mib_per_s = data.len() as f64 / (1024.0 * 1024.0) / start.elapsed().as_secs_f64();
    if stage == Stage::Reference {
        if let Some(frame) = rt.take_frame().expect("frame") {
            draw_frame(&mut renderer, &frame);
        }
        let mut fresh = reference_renderer(size);
        draw_frame(&mut fresh, &rt.snapshot().expect("snapshot"));
        assert!(
            renderer.surface() == fresh.surface(),
            "incremental drawing diverged from a full repaint"
        );
    }
    let stats = renderer.stats();
    Sample {
        mib_per_s,
        frames,
        rows: stats.rows_drawn,
        bytes_uploaded: stats.bytes_uploaded,
    }
}

fn main() {
    println!("host load average at start: {}", load_average());
    let geometries = [("80x24", Size::new(80, 24)), ("152x38", Size::new(152, 38))];
    let workloads = workloads();
    println!(
        "\n{} MiB per workload, {RUNS} runs, MiB/s median (min to max); a frame is taken per 16 KiB chunk or per {} KiB of output\n",
        VOLUME >> 20,
        WINDOW >> 10
    );
    println!("| grid | workload | frame cadence | VT only | + take_frame | + Screen::apply | + reference draw and present | frames | rows drawn | MiB uploaded |");
    println!("|---|---|---|---|---|---|---|---|---|---|");
    for (grid, size) in geometries {
        for (name, data) in &workloads {
            let data = &data[..VOLUME];
            for (cadence, every) in [("per chunk", CHUNK), ("per window", WINDOW)] {
                let mut cells = Vec::new();
                let mut last = None;
                for stage in STAGES {
                    let samples: Vec<Sample> =
                        (0..RUNS).map(|_| run(data, size, every, stage)).collect();
                    let (mid, lo, hi) = median(samples.iter().map(|s| s.mib_per_s).collect());
                    cells.push(format!("{mid:.1} ({lo:.1} to {hi:.1})"));
                    last = samples.into_iter().last();
                }
                let last = last.expect("a sample");
                println!(
                    "| {grid} | {name} | {cadence} | {} | {} | {} | {:.1} |",
                    cells.join(" | "),
                    last.frames,
                    last.rows,
                    last.bytes_uploaded as f64 / 1048576.0
                );
            }
        }
    }
}
