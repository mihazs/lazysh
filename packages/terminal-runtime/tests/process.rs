//! Process-wide properties of the session service: the worker pool never grows with the number of
//! sessions, and creating and closing sessions does not leak. These read /proc, so this file holds
//! one test (tests in one binary share the process) and is Linux-only.
#![cfg(target_os = "linux")]

mod support;

use lazysh_terminal_runtime::{Config, Hub, HubConfig, Offer, Size};
use support::{quiet_hooks, rss_kib};

fn threads() -> usize {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("Threads:")?.trim().parse().ok())
        .unwrap()
}

fn churn(hub: &Hub, count: usize) {
    let text: Vec<u8> = (0..2_000)
        .flat_map(|n| {
            format!("line {n:06} the quick brown fox jumps over the lazy dog\r\n").into_bytes()
        })
        .collect();
    let sessions: Vec<_> = (0..count)
        .map(|n| {
            let config = Config {
                size: Size::new(80, 24),
                scrollback_bytes: 256 * 1024,
                ..Config::default()
            };
            let session = hub.create(format!("s{n}"), config, quiet_hooks()).unwrap();
            for chunk in text.chunks(16 * 1024) {
                while session.feed(chunk.to_vec()).unwrap() != Offer::Accepted {
                    std::thread::yield_now();
                }
            }
            session
        })
        .collect();
    for session in &sessions {
        while session.stats().unwrap().processed != text.len() as u64 {
            std::thread::yield_now();
        }
    }
    for session in &sessions {
        session.close();
    }
    assert_eq!(hub.live(), 0);
    assert_eq!(hub.scrollback_reserved(), 0);
}

#[test]
fn a_hundred_sessions_use_a_fixed_pool_and_churn_does_not_leak() {
    let threads_before = threads();
    let hub = Hub::new(HubConfig {
        workers: 2,
        ..HubConfig::default()
    });
    churn(&hub, 100); // warm-up: allocator arenas and the pool settle
    let threads_after = threads();
    assert_eq!(
        threads_after - threads_before,
        2,
        "100 sessions must not add threads beyond the 2-worker pool"
    );
    let baseline = rss_kib().unwrap() as usize;
    for _ in 0..3 {
        churn(&hub, 100);
    }
    let grown = (rss_kib().unwrap() as usize).saturating_sub(baseline);
    assert!(
        grown < 16 * 1024,
        "resident memory grew {grown} KiB over 300 more create/feed/close cycles"
    );
}
