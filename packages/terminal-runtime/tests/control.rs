//! The control plane (`TerminalRuntime::control_snapshot` and `control_scroll`, #1321) against what headless
//! xterm.js 5.5.0 answers for the same bytes and scrolls: `fixtures/control-plane.json`, written by
//! `apps/client/src/xterm/controlPlaneFixture.test.ts` (`UPDATE_CONTROL_PLANE=1` rewrites it) and replayed
//! here. The adapter's synchronous readers (modes, viewport, cursor, rows) are served from exactly these answers.

mod support;

use lazysh_terminal_runtime::{
    Config, ControlSnapshot, MouseTracking, ScrollAction, Size, TerminalRuntime,
};
use serde_json::{json, Value};
use support::*;

fn action(step: &Value) -> ScrollAction {
    let delta = || step["delta"].as_i64().unwrap() as isize;
    match step["kind"].as_str().unwrap() {
        "lines" => ScrollAction::Lines(delta()),
        "pages" => ScrollAction::Pages(delta()),
        "toTop" => ScrollAction::Top,
        "toBottom" => ScrollAction::Bottom,
        "toRow" => ScrollAction::Row(step["row"].as_u64().unwrap() as usize),
        other => panic!("unknown scroll {other}"),
    }
}

/// The answer in the shape the client reads (`NativeCoreSnapshot` without the history setting).
fn wire(snapshot: &ControlSnapshot) -> Value {
    let (state, window) = (&snapshot.state, &snapshot.window);
    json!({
        "state": {
            "columns": state.columns,
            "rows": state.rows,
            "cursor": {"x": state.cursor.0, "y": state.cursor.1},
            "modes": {
                "bracketedPaste": state.modes.bracketed_paste,
                "mouseTracking": match state.modes.mouse_tracking {
                    MouseTracking::None => "none",
                    MouseTracking::X10 => "x10",
                    MouseTracking::Vt200 => "vt200",
                    MouseTracking::Drag => "drag",
                    MouseTracking::Any => "any",
                },
                "alternateScreen": state.modes.alternate_screen,
                "applicationCursorKeys": state.modes.application_cursor_keys,
            },
            "viewport": {
                "top": state.viewport.top,
                "rows": state.viewport.rows,
                "length": state.viewport.length,
                "following": state.viewport.following,
            },
        },
        "window": {"first": window.first, "rows": window.rows},
    })
}

#[test]
fn every_answer_matches_what_xterm_js_gives() {
    for case in fixture_cases("control-plane") {
        let id = case["id"].as_str().unwrap();
        let number = |key: &str| case[key].as_u64().unwrap() as usize;
        let mut rt = replay(&case);
        let window = number("window");
        let mut answers = vec![rt.control_snapshot(window).unwrap()];
        for step in case["steps"].as_array().unwrap() {
            answers.push(rt.control_scroll(action(step), window).unwrap());
        }
        let expected = case["snapshots"].as_array().unwrap();
        assert_eq!(answers.len(), expected.len(), "{id}");
        for (at, (answer, expected)) in answers.iter().zip(expected).enumerate() {
            assert_eq!(&wire(answer), expected, "{id}, answer {at}");
        }
    }
}

#[test]
fn reading_the_cursor_of_a_scrolled_reader_leaves_them_where_they_were() {
    let mut rt = runtime(20, 5);
    feed(
        &mut rt,
        (0..40)
            .map(|i| format!("row {i}"))
            .collect::<Vec<_>>()
            .join("\r\n")
            .as_bytes(),
    );
    rt.control_scroll(ScrollAction::Row(12), 8).unwrap();
    let before = rt.viewport().unwrap();
    let answer = rt.control_snapshot(8).unwrap();
    assert_eq!(rt.viewport().unwrap(), before);
    assert_eq!(answer.state.viewport, before);
    assert!(!answer.state.viewport.following);
}

#[test]
fn a_window_is_bounded_and_always_holds_the_viewport() {
    let mut rt = runtime(20, 5);
    feed(
        &mut rt,
        (0..200)
            .map(|i| format!("row {i}"))
            .collect::<Vec<_>>()
            .join("\r\n")
            .as_bytes(),
    );
    for action in [
        ScrollAction::Bottom,
        ScrollAction::Top,
        ScrollAction::Row(97),
        ScrollAction::Pages(-1),
    ] {
        let answer = rt.control_scroll(action, 16).unwrap();
        let (viewport, window) = (answer.state.viewport, answer.window);
        assert!(window.rows.len() <= 16);
        assert!(
            window.first <= viewport.top
                && viewport.top + viewport.rows <= window.first + window.rows.len()
        );
        assert_eq!(
            window.rows[viewport.top - window.first],
            format!("row {}", viewport.top)
        );
    }
    // A request for more than the bridge ever returns is cut, and one smaller than the screen still covers it.
    let huge = rt.control_snapshot(usize::MAX).unwrap();
    assert!(huge.window.rows.len() <= lazysh_terminal_runtime::MAX_READ_ROWS);
    assert_eq!(rt.control_snapshot(0).unwrap().window.rows.len(), 5);
}
