//! The session service on this machine: pooled throughput with credit flow control, credit
//! (ack) latency, input-to-write latency under load, memory per session and churn. Host numbers
//! only: no transport, no JS bridge, no renderer, no device. `cargo run --release --example
//! session_bench`; the caller records host, toolchain and commit next to the output.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::{ffi, Hooks, Hub, HubConfig, KeyInput, Offer};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use support::*;

const PER_SESSION: usize = 16 * 1024 * 1024;

/// `PUMP_SLICE_KIB=16 cargo run ...` benchmarks another slice size than the default.
fn hub_config() -> HubConfig {
    let mut config = HubConfig::default();
    if let Some(kib) = std::env::var("PUMP_SLICE_KIB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    {
        config.pump_slice = kib * 1024;
    }
    config
}

/// Per-chunk time from `feed` to the credit that returns it.
type Latencies = Arc<Mutex<(VecDeque<(Instant, usize)>, Vec<f64>)>>;

fn timed_session(hub: &Hub, id: &str, latencies: &Latencies) -> Fixture {
    let writer = Recorder::new();
    let window = Window::new(WINDOW);
    let credited = Arc::new(Default::default());
    let hooks = Hooks {
        writer: writer.clone(),
        credit: {
            let (window, latencies) = (window.clone(), latencies.clone());
            Box::new(move |bytes| {
                let now = Instant::now();
                let mut guard = latencies.lock().unwrap();
                let (pending, samples) = &mut *guard;
                let mut left = bytes;
                while left > 0 {
                    let (at, len) = pending.pop_front().expect("credit for an unknown chunk");
                    samples.push(now.duration_since(at).as_secs_f64() * 1e3);
                    left -= len; // whole chunks only: the worker never splits one
                }
                drop(guard);
                window.release(bytes);
            })
        },
        changed: None,
    };
    let session = hub
        .create(id, config(80, 24, 4 * 1024 * 1024), hooks)
        .unwrap();
    Fixture {
        session,
        writer,
        window,
        credited,
    }
}

fn pooled(workers: usize, sessions: usize, data: &Arc<Vec<u8>>) -> (f64, Vec<f64>) {
    let hub = Hub::new(HubConfig {
        workers,
        ..hub_config()
    });
    let latencies: Latencies = Arc::default();
    let fixtures: Vec<_> = (0..sessions)
        .map(|n| Arc::new(timed_session(&hub, &format!("s{n}"), &latencies)))
        .collect();
    let start = Instant::now();
    let threads: Vec<_> = fixtures
        .iter()
        .map(|f| {
            let (f, data, latencies) = (f.clone(), data.clone(), latencies.clone());
            std::thread::spawn(move || {
                for chunk in data.chunks(CHUNK) {
                    f.window.acquire(chunk.len());
                    latencies
                        .lock()
                        .unwrap()
                        .0
                        .push_back((Instant::now(), chunk.len()));
                    assert_eq!(f.session.feed(chunk.to_vec()).unwrap(), Offer::Accepted);
                }
            })
        })
        .collect();
    threads.into_iter().for_each(|t| t.join().unwrap());
    fixtures.iter().for_each(|f| f.settle(data.len() as u64));
    let mib = (data.len() * sessions) as f64 / (1024.0 * 1024.0);
    let mut samples = std::mem::take(&mut latencies.lock().unwrap().1);
    samples.sort_by(f64::total_cmp);
    (mib / start.elapsed().as_secs_f64(), samples)
}

fn throughput() {
    println!("| workers | sessions | aggregate MiB/s median (min-max, 5 runs) | credit latency ms p50 / p95 / p99 (median run) |\n|---|---|---|---|");
    let data = Arc::new(plain(PER_SESSION));
    for (workers, sessions) in [(1, 1), (1, 5), (2, 5), (1, 10), (2, 10), (4, 10)] {
        let runs: Vec<_> = (0..5).map(|_| pooled(workers, sessions, &data)).collect();
        let (mid, lo, hi) = median(runs.iter().map(|r| r.0).collect());
        let mut by_speed = runs;
        by_speed.sort_by(|a, b| a.0.total_cmp(&b.0));
        let samples = &by_speed[2].1;
        println!(
            "| {workers} | {sessions} | {mid:.1} ({lo:.1}-{hi:.1}) | {:.3} / {:.3} / {:.3} |",
            percentile(samples, 0.50),
            percentile(samples, 0.95),
            percentile(samples, 0.99)
        );
    }
}

/// `send_key` from call to the writer having the bytes: lock wait for a worker's slice on this
/// very session, encode and the (in-memory) write. Idle, then while the probe session and nine
/// others flood the same 2 workers, with plain text and with the slowest-to-parse workload.
fn input_latency() {
    let key = KeyInput {
        key: ffi::GhosttyKey_GHOSTTY_KEY_ARROW_UP,
        mods: 0,
        text: None,
        composing: false,
        repeat: false,
        release: false,
    };
    let measure = |probe: &Fixture| {
        let mut samples: Vec<f64> = (0..5_000)
            .map(|_| {
                let at = Instant::now();
                probe.session.send_key(&key).unwrap();
                let took = at.elapsed().as_secs_f64() * 1e6;
                std::thread::sleep(std::time::Duration::from_micros(200));
                took
            })
            .collect();
        samples.sort_by(f64::total_cmp);
        [0.50, 0.95, 0.99, 1.0].map(|p| percentile(&samples, p))
    };
    println!("\n| input to write, microseconds (5000 keys) | p50 | p95 | p99 | max |\n|---|---|---|---|---|");
    let idle_hub = Hub::new(hub_config());
    let idle = measure(&session(&idle_hub, "probe", config(80, 24, 1 << 20)));
    println!(
        "| idle | {:.1} | {:.1} | {:.1} | {:.1} |",
        idle[0], idle[1], idle[2], idle[3]
    );
    for (name, data) in [
        ("plain", plain(PER_SESSION)),
        ("CJK/emoji/combining", unicode(PER_SESSION)),
    ] {
        let hub = Hub::new(hub_config());
        let data = Arc::new(data);
        let probe = Arc::new(session(&hub, "probe", config(80, 24, 4 << 20)));
        let flooders: Vec<_> =
            std::iter::once(probe.clone())
                .chain((1..10).map(|n| {
                    Arc::new(session(&hub, &format!("flood{n}"), config(80, 24, 4 << 20)))
                }))
                .map(|f| {
                    let data = data.clone();
                    std::thread::spawn(move || data.chunks(CHUNK).for_each(|c| f.send(c)))
                })
                .collect();
        let loaded = measure(&probe);
        flooders.into_iter().for_each(|t| t.join().unwrap());
        println!("| typing into a session flooded with {name}, 9 other sessions flooding, 2 workers | {:.1} | {:.1} | {:.1} | {:.1} |", loaded[0], loaded[1], loaded[2], loaded[3]);
    }
}

fn memory() {
    let text = Arc::new(plain(8 * 1024 * 1024));
    println!("\n| memory (RSS KiB) | baseline | after creating | per session |\n|---|---|---|---|");
    for (count, fill) in [(5, false), (10, false), (5, true), (10, true)] {
        let hub = Hub::new(hub_config());
        let before = rss_kib().unwrap();
        let fixtures: Vec<_> = (0..count)
            .map(|n| session(&hub, &format!("m{n}"), config(80, 24, 4 << 20)))
            .collect();
        if fill {
            fixtures.iter().for_each(|f| f.send(&text));
            fixtures.iter().for_each(|f| f.settle(text.len() as u64));
        }
        let after = rss_kib().unwrap();
        println!(
            "| {count} sessions, {} | {before} | {after} | {} |",
            if fill {
                "8 MiB of 80-column lines each, 4 MiB scrollback"
            } else {
                "empty"
            },
            (after - before) / count
        );
    }
    let hub = Hub::new(hub_config());
    let round = |hub: &Hub| {
        let fixtures: Vec<_> = (0..100)
            .map(|n| session(hub, &format!("c{n}"), config(80, 24, 256 * 1024)))
            .collect();
        fixtures.iter().for_each(|f| f.send(&text[..1 << 20]));
        fixtures.iter().for_each(|f| f.settle(1 << 20));
        fixtures.iter().for_each(|f| f.session.close());
        rss_kib().unwrap()
    };
    let start = rss_kib().unwrap();
    let rounds: Vec<u64> = (0..4).map(|_| round(&hub)).collect();
    println!("\nchurn, 100 sessions x 1 MiB each, created and closed per round: RSS before {start} KiB, after rounds {rounds:?} KiB");
}

fn main() {
    println!(
        "host load average at start: {}; pump slice {} KiB\n",
        load_average(),
        hub_config().pump_slice / 1024
    );
    throughput();
    input_latency();
    memory();
}
