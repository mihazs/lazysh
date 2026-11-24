//! The History lines setting counts lines, libghostty-vt budgets bytes: `scrollback_bytes_for_lines`
//! must keep the requested rows of ordinary output at every width, and the budget must still bound
//! the history (it is not an invitation to keep everything).
mod support;

use lazysh_terminal_runtime::{scrollback_bytes_for_lines, Hub, HubConfig, SessionError};
use support::*;

#[test]
fn the_lines_budget_keeps_the_requested_rows_of_ordinary_output_and_bounds_the_history() {
    for (name, workload) in [
        ("plain", plain_rows as Workload),
        ("coloured", colour_rows),
        ("syntax", syntax_rows),
    ] {
        for cols in [20u16, 40, 80, 120, 200, 279] {
            for lines in [100usize, 1_000, 5_000, 20_000] {
                let budget = scrollback_bytes_for_lines(lines, cols);
                let rt = fed_scrollback(cols, budget, 3 * lines, workload);
                let kept = rt.scrollback_rows().unwrap();
                assert!(
                    kept >= lines,
                    "{name} at {cols} columns, {lines} lines requested: kept only {kept} rows of {budget} bytes"
                );
                assert!(
                    kept * usize::from(cols) * 8 <= budget,
                    "{name} at {cols} columns, {lines} lines requested: kept {kept} rows, the budget does not bound the history"
                );
            }
        }
    }
}

/// The setting changes while the session is open (#2505): the running terminal keeps the new number of rows from then on.
#[test]
fn a_running_terminal_follows_a_new_history_budget() {
    let (cols, width) = (80u16, 80usize);
    let lines = |lines| scrollback_bytes_for_lines(lines, cols);
    let mut rt = fed_scrollback(cols, lines(1_000), 12_000, plain_rows);
    let small = rt.scrollback_rows().unwrap();
    assert!(small >= 1_000, "opened for 1,000 lines, kept {small}");

    rt.set_scrollback_bytes(lines(5_000)).unwrap();
    feed(&mut rt, &plain_rows(12_000, 12_000, width));
    let large = rt.scrollback_rows().unwrap();
    assert!(
        large >= 5_000 && large > small + 2_000,
        "raised to 5,000 lines, kept {large} (was {small})"
    );

    rt.set_scrollback_bytes(lines(100)).unwrap();
    let lowered = rt.scrollback_rows().unwrap();
    assert!(
        (100..small).contains(&lowered),
        "lowered to 100 lines, kept {lowered} at once (was {large})"
    );
    feed(&mut rt, &plain_rows(24_000, 4_000, width));
    let after = rt.scrollback_rows().unwrap();
    assert!(
        (100..small).contains(&after) && after * width * 8 <= lines(100),
        "lowered to 100 lines, kept {after} afterwards"
    );
    assert!(
        rt.screen_text().unwrap().trim_end().ends_with("27999"),
        "the newest row survives"
    );
}

/// A hub session keeps the hub's accounting straight when its budget changes, and the same clamps as at creation.
#[test]
fn a_session_changes_its_history_budget_within_the_hub_budget() {
    let hub = Hub::new(HubConfig {
        scrollback_budget: 8 << 20,
        session_scrollback_max: 6 << 20,
        ..HubConfig::default()
    });
    let a = session(&hub, "a", config(80, 24, 1 << 20));
    let b = session(&hub, "b", config(80, 24, 1 << 20));
    assert_eq!(hub.scrollback_reserved(), 2 << 20);

    assert_eq!(a.session.set_scrollback_bytes(4 << 20).unwrap(), 4 << 20);
    assert_eq!(
        (a.session.scrollback_granted(), hub.scrollback_reserved()),
        (4 << 20, 5 << 20)
    );
    // Over the per-session cap: clamped. Over what the hub has left once its own grant is given back: clamped.
    assert_eq!(a.session.set_scrollback_bytes(64 << 20).unwrap(), 6 << 20);
    assert_eq!(a.session.set_scrollback_bytes(7 << 20).unwrap(), 6 << 20);
    assert_eq!(b.session.set_scrollback_bytes(4 << 20).unwrap(), 2 << 20);
    assert_eq!(hub.scrollback_reserved(), 8 << 20);
    // Lowering gives the bytes back to the others.
    assert_eq!(a.session.set_scrollback_bytes(1 << 20).unwrap(), 1 << 20);
    assert_eq!(b.session.set_scrollback_bytes(6 << 20).unwrap(), 6 << 20);
    assert_eq!(hub.scrollback_reserved(), 7 << 20);

    let granted = a.session.scrollback_granted();
    a.session.close();
    assert_eq!(
        hub.scrollback_reserved(),
        6 << 20,
        "closing frees what the session held ({granted})"
    );
    assert!(matches!(
        a.session.set_scrollback_bytes(1 << 20),
        Err(SessionError::Closed)
    ));
    assert_eq!(
        hub.scrollback_reserved(),
        6 << 20,
        "a closed session reserves nothing"
    );
}
