//! Parse and state-update throughput of the runtime on the bytes of the recorded xterm.js baseline's streamed
//! workloads (W2 plain, W3 ANSI, W4 redraw, at its desktop and phone geometries), with the final screen checked
//! against the one the baseline expects. The files come from `bun bench/dumpWorkloads.ts <dir>` in apps/client, and
//! `node bench/harnessParse.mjs <dir>` measures xterm.js 5.5.0 headless on the same ones. No transport, bridge,
//! renderer or device. `cargo run --release --example harness_parse -- <dir>`.

#[path = "../tests/support/mod.rs"]
mod support;

use std::time::Instant;
use support::*;

const RUNS: usize = 5;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: harness_parse <dir>");
    println!("host load average at start: {}\n", load_average());
    println!("| workload | geometry | bytes | native core, MiB/s median (min to max) | final screen equals the baseline's |\n|---|---|---|---|---|");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "bin"))
        .collect();
    files.sort();
    for path in files {
        let name = path.file_stem().unwrap().to_str().unwrap();
        let (kind, geometry) = name.split_once('-').unwrap();
        let (cols, rows) = geometry.split_once('x').unwrap();
        let (cols, rows): (u16, u16) = (cols.parse().unwrap(), rows.parse().unwrap());
        let data = std::fs::read(&path).unwrap();
        let expected: Vec<String> =
            serde_json::from_slice(&std::fs::read(path.with_extension("screen.json")).unwrap())
                .unwrap();
        let mut last = None;
        let speeds = (0..RUNS)
            .map(|_| {
                let mut rt = runtime(cols, rows);
                let start = Instant::now();
                data.chunks(CHUNK)
                    .for_each(|chunk| feed_chunk(&mut rt, chunk));
                let mib_s = data.len() as f64 / (1024.0 * 1024.0) / start.elapsed().as_secs_f64();
                last = Some(screen(&mut rt));
                mib_s
            })
            .collect();
        let (mid, lo, hi) = median(speeds);
        println!(
            "| {kind} | {geometry} | {} | {mid:.1} ({lo:.1} to {hi:.1}) | {} |",
            data.len(),
            last == Some(expected)
        );
    }
}
