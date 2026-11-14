//! Memory of idle sessions, in a test binary of its own so no other test shares the process (the
//! resident set is process-wide).

mod support;

use lazysh_terminal_runtime::{Hub, HubConfig};
use std::time::Duration;
use support::*;

#[test]
fn ten_idle_detached_sessions_give_back_most_of_their_scrollback_memory() {
    let Some(start) = rss_kib() else {
        return; // no /proc: nothing to measure here
    };
    let hub = Hub::new(HubConfig {
        compress_after: Some(Duration::from_millis(100)),
        ..HubConfig::default()
    });
    let lines = fit_lines(8 << 20, 80);
    let fixtures: Vec<_> = (0..10)
        .map(|n| session(&hub, &format!("s{n}"), config(80, 24, 4 << 20)))
        .collect();
    fixtures.iter().for_each(|f| f.send(&lines));
    fixtures.iter().for_each(|f| f.settle(lines.len() as u64));
    let filled = rss_kib().unwrap() - start;
    assert!(
        filled > 30 * 1024,
        "ten sessions at 4 MiB of scrollback hold about 40 MiB, saw {filled} KiB"
    );
    wait_until(|| rss_kib().unwrap() - start < filled / 2);
    for fixture in &fixtures {
        assert_eq!(
            fixture.session.stats().unwrap().processed,
            lines.len() as u64
        );
    }
}
