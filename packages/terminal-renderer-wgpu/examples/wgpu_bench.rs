//! The same Frame stream through the CPU reference renderer and the wgpu renderer, on this
//! machine's GPU (#1323, #1324). Per workload, grid and frame cadence it prints throughput of the whole
//! pipeline (VT, take_frame, renderer) and the per-frame cost of draw plus present, where present
//! waits for the GPU to finish, so the figure is submit-to-done latency, not a CPU-only submit
//! cost. Offscreen and headless: no compositor, no display refresh, no fonts, not Android. A last
//! table counts what the GPU side did (submissions, instances against layout draws, atlas hits).
//! Run in release: `cargo run --release --example wgpu_bench`; the caller records the environment.

#[path = "../../terminal-runtime/tests/support/mod.rs"]
mod support;

use lazysh_terminal_renderer_wgpu::{Target, WgpuRenderer};
use lazysh_terminal_runtime::{
    Appearance, Frame, Image, ReferenceRenderer, Size, TerminalRenderer, Theme,
};
use std::time::Instant;
use support::{
    feed_chunk, load_average, median, percentile, rss_kib, runtime, workloads, CHUNK, WINDOW,
};

const RUNS: usize = 5;
const VOLUME: usize = 16 * 1024 * 1024;
const CELL: (u32, u32) = (8, 16);
const REPAINT_PASSES: usize = 20;

struct Sample {
    mib_per_s: f64,
    frame_ms: Vec<f64>,
    frames: u64,
    rows: u64,
    uploaded: u64,
}

/// One pass: feed `data`, take a frame every `every` bytes and hand it to `renderer`.
fn run<R: TerminalRenderer>(data: &[u8], size: Size, every: usize, mut renderer: R) -> Sample {
    let mut rt = runtime(size.cols, size.rows);
    let (mut taken, mut frame_ms) = (0, Vec::new());
    let start = Instant::now();
    for chunk in data.chunks(CHUNK) {
        feed_chunk(&mut rt, chunk);
        taken += chunk.len();
        if taken < every {
            continue;
        }
        taken = 0;
        let Some(frame) = rt.take_frame().expect("frame") else {
            continue;
        };
        renderer.apply(&frame).expect("apply");
        let begun = Instant::now();
        renderer.draw().expect("draw");
        renderer.present().expect("present");
        frame_ms.push(begun.elapsed().as_secs_f64() * 1e3);
    }
    let mib_per_s = data.len() as f64 / (1024.0 * 1024.0) / start.elapsed().as_secs_f64();
    let stats = renderer.stats();
    Sample {
        mib_per_s,
        frame_ms,
        frames: stats.frames_drawn,
        rows: stats.rows_drawn,
        uploaded: stats.bytes_uploaded,
    }
}

/// The 80x24 screens of `data` after every 256 KiB of its first 16 MiB: 64 full frames, the same
/// screens whatever renderer is shown them.
fn screens(data: &[u8]) -> Vec<Frame> {
    let mut rt = runtime(80, 24);
    let (mut taken, mut frames) = (0, Vec::new());
    for chunk in data[..VOLUME].chunks(CHUNK) {
        feed_chunk(&mut rt, chunk);
        taken += chunk.len();
        if taken >= WINDOW {
            taken = 0;
            frames.push(rt.snapshot().expect("snapshot"));
        }
    }
    frames
}

/// Draw plus present of each screen as a full repaint, `REPAINT_PASSES` times over; the first pass
/// (glyph atlas, caches) is not counted. Milliseconds per frame, sorted. A renderer only redraws
/// rows whose cells changed, so every frame sets the appearance again, which marks every row stale.
fn repaint<R: TerminalRenderer>(
    frames: &[Frame],
    mut renderer: R,
    appearance: &Appearance,
) -> Vec<f64> {
    let mut frame_ms = Vec::new();
    for pass in 0..=REPAINT_PASSES {
        for frame in frames {
            renderer.apply(frame).expect("apply");
            renderer
                .set_appearance(appearance.clone())
                .expect("appearance");
            let begun = Instant::now();
            renderer.draw().expect("draw");
            renderer.present().expect("present");
            if pass > 0 {
                frame_ms.push(begun.elapsed().as_secs_f64() * 1e3);
            }
        }
    }
    frame_ms.sort_by(f64::total_cmp);
    frame_ms
}

fn cell(samples: &[Sample]) -> String {
    let (mid, lo, hi) = median(samples.iter().map(|s| s.mib_per_s).collect());
    let mut all: Vec<f64> = samples.iter().flat_map(|s| s.frame_ms.clone()).collect();
    all.sort_by(f64::total_cmp);
    format!(
        "{mid:.1} ({lo:.1} to {hi:.1}) | {:.3} / {:.3}",
        percentile(&all, 0.5),
        percentile(&all, 0.99)
    )
}

/// Time to create the first renderer (instance, adapter, device, pipeline) and the resident memory
/// it and four more add, measured before any workload buffers exist.
fn startup(appearance: &Appearance) -> WgpuRenderer {
    let target = Target::new(80 * CELL.0, 24 * CELL.1);
    let rss = rss_kib();
    let started = Instant::now();
    let first = WgpuRenderer::create(target.clone(), appearance.clone())
        .expect("a GPU adapter is required");
    let created = started.elapsed();
    let after_first = rss_kib();
    let more: Vec<WgpuRenderer> = (0..4)
        .map(|_| WgpuRenderer::create(target.clone(), appearance.clone()).unwrap())
        .collect();
    println!("adapter: {:?}", first.adapter());
    println!(
        "first renderer created in {:.0} ms; resident set +{} KiB for the first, +{} KiB for four more (80x24)\n",
        created.as_secs_f64() * 1e3,
        after_first.zip(rss).map_or(0, |(a, b)| a.saturating_sub(b)),
        rss_kib().zip(after_first).map_or(0, |(a, b)| a.saturating_sub(b)),
    );
    drop(more);
    first
}

fn main() {
    let appearance = Appearance::default();
    println!("host load average at start: {}", load_average());
    let _probe = startup(&appearance);
    println!(
        "{} MiB per workload, {RUNS} runs, MiB/s median (min to max) of the whole pipeline; frame ms is draw + present per frame (p50 / p99) over all runs\n",
        VOLUME >> 20
    );
    println!("| grid | workload | frame cadence | reference MiB/s | reference frame ms | wgpu MiB/s | wgpu frame ms | frames | rows drawn | reference MiB copied | wgpu MiB uploaded |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|");
    for (grid, size) in [("80x24", Size::new(80, 24)), ("152x38", Size::new(152, 38))] {
        let (width, height) = (u32::from(size.cols) * CELL.0, u32::from(size.rows) * CELL.1);
        for (name, data) in &workloads() {
            let data = &data[..VOLUME];
            for (cadence, every) in [("per chunk", CHUNK), ("per window", WINDOW)] {
                let cpu: Vec<Sample> = (0..RUNS)
                    .map(|_| {
                        let blank = Image::new(width, height, Theme::default().background).unwrap();
                        run(
                            data,
                            size,
                            every,
                            ReferenceRenderer::create(blank, appearance.clone()).unwrap(),
                        )
                    })
                    .collect();
                let gpu: Vec<Sample> = (0..RUNS)
                    .map(|_| {
                        let renderer =
                            WgpuRenderer::create(Target::new(width, height), appearance.clone())
                                .unwrap();
                        run(data, size, every, renderer)
                    })
                    .collect();
                let (c, g) = (cpu.last().unwrap(), gpu.last().unwrap());
                println!(
                    "| {grid} | {name} | {cadence} | {} | {} | {} | {} | {:.1} | {:.2} |",
                    cell(&cpu),
                    cell(&gpu),
                    g.frames,
                    g.rows,
                    c.uploaded as f64 / 1048576.0,
                    g.uploaded as f64 / 1048576.0
                );
            }
        }
    }
    println!(
        "\nFull repaint of 64 screens per workload, taken after every 256 KiB of the first 16 MiB (80x24, 8x16 px cells, {REPAINT_PASSES} passes after a warm-up pass): draw + present ms per frame, p50 / p99\n"
    );
    println!("| workload | reference | wgpu |");
    println!("|---|---|---|");
    let (width, height) = (80 * CELL.0, 24 * CELL.1);
    for (name, data) in &workloads() {
        let frames = screens(data);
        let blank = Image::new(width, height, Theme::default().background).unwrap();
        let cpu = repaint(
            &frames,
            ReferenceRenderer::create(blank, appearance.clone()).unwrap(),
            &appearance,
        );
        let gpu = repaint(
            &frames,
            WgpuRenderer::create(Target::new(width, height), appearance.clone()).unwrap(),
            &appearance,
        );
        let p = |v: &[f64]| format!("{:.3} / {:.3}", percentile(v, 0.5), percentile(v, 0.99));
        println!("| {name} | {} | {} |", p(&cpu), p(&gpu));
    }
}
