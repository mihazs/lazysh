//! `TerminalRuntime::read_rows` against the xterm.js 5.5.0 results the adapter's `readRows` gives
//! (`translateToString(true, start, end)` then `trimEnd`) for the same bytes. The expectations in
//! `fixtures/read-rows.json` come from xterm itself: `apps/client/src/readRowsFixture.test.ts`
//! replays the same bytes through xterm.js and fails if they drift (`UPDATE_READ_ROWS=1` rewrites
//! them). Herdr's phone-layout detection, `herdrNavigationCells.ts`, reads nothing else.

mod support;

use lazysh_terminal_runtime::{Config, Size, TerminalRuntime, MAX_READ_ROWS};
use serde_json::Value;
use support::*;

fn load() -> Vec<Value> {
    let path = format!("{}/fixtures/read-rows.json", env!("CARGO_MANIFEST_DIR"));
    let json: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    json["cases"].as_array().unwrap().clone()
}

fn replay(case: &Value) -> TerminalRuntime {
    let number = |key: &str| case[key].as_u64().unwrap();
    let mut rt = TerminalRuntime::new(Config {
        size: Size::new(number("cols") as u16, number("rows") as u16),
        scrollback_bytes: 1 << 20,
        ..Config::default()
    })
    .unwrap();
    feed(&mut rt, case["write"].as_str().unwrap().as_bytes());
    rt
}

#[test]
fn rows_read_the_same_text_as_the_xterm_backend() {
    for case in load() {
        let rt = replay(&case);
        let id = case["id"].as_str().unwrap();
        for query in case["queries"].as_array().unwrap() {
            let first = query["first"].as_u64().unwrap() as usize;
            let count = query["count"].as_u64().unwrap() as usize;
            let columns = query["columns"]
                .as_array()
                .map(|span| span[0].as_u64().unwrap() as u16..span[1].as_u64().unwrap() as u16);
            let expected: Vec<&str> = query["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row.as_str().unwrap())
                .collect();
            assert_eq!(
                rt.read_rows(first, count, columns.clone()).unwrap(),
                expected,
                "{id}: rows {first}+{count} columns {columns:?}"
            );
        }
        assert!(
            !case["queries"].as_array().unwrap().is_empty(),
            "{id} has no query"
        );
    }
}

#[test]
fn a_soft_wrapped_line_is_several_rows_and_alternate_screen_rows_are_the_visible_ones() {
    let mut rt = runtime(10, 3);
    feed(&mut rt, b"0123456789ABCDE");
    assert_eq!(
        rt.read_rows(0, 3, None).unwrap(),
        ["0123456789", "ABCDE", ""]
    );
    feed(&mut rt, b"\x1b[?1049h\x1b[Halt");
    assert_eq!(rt.read_rows(0, 1, None).unwrap(), ["alt"]);
}

#[test]
fn a_query_is_bounded_and_does_not_move_the_viewport() {
    let mut rt = runtime(20, 3);
    let text: String = (0..30).map(|i| format!("row {i}\r\n")).collect();
    feed(&mut rt, text.as_bytes());
    rt.scroll_viewport(-5);
    let (before, view) = (rt.viewport_text().unwrap(), rt.take_frame().unwrap());
    let rows = rt.read_rows(0, usize::MAX, None).unwrap();
    assert_eq!(
        rows.len(),
        MAX_READ_ROWS,
        "count is clamped, not an allocation request"
    );
    assert_eq!(
        (rows[0].as_str(), rows[29].as_str(), rows[31].as_str()),
        ("row 0", "row 29", "")
    );
    assert_eq!(
        rt.read_rows(u32::MAX as usize + 1, 5, None).unwrap(),
        [""; 5],
        "a row index past u32 reads as empty"
    );
    assert_eq!(rt.viewport_text().unwrap(), before);
    assert!(
        view.is_some() && rt.take_frame().unwrap().is_none(),
        "reading marks nothing dirty"
    );
}

#[test]
fn herdr_chrome_is_found_at_the_visible_top_or_the_live_top_wherever_the_reader_is() {
    // Mirrors "follows the visible rows, not the live screen" in herdrNavigationCells.test.ts:
    // detection reads rows relative to `viewport().top`, and `herdrOnScreen` relative to the live
    // screen, `length - rows`.
    let mut rt = runtime(46, 3);
    let history: String = (0..5).map(|_| "history\r\n").collect();
    feed(&mut rt, history.as_bytes());
    let chrome = format!(
        "\x1b[44m{:<46}\x1b[0m\r\n\x1b[44m{:<36}| switch  \x1b[0m\r\nagent output",
        " Development  tab 1", " 1 blocked"
    );
    feed(&mut rt, chrome.as_bytes());
    let live = rt.viewport().unwrap();
    assert_eq!((live.rows, live.length, live.following), (3, 8, true));
    let edge = |rt: &TerminalRuntime, top: usize| rt.read_rows(top + 1, 1, Some(36..46)).unwrap();
    assert_eq!(edge(&rt, live.top), ["| switch"]);
    rt.scroll_viewport(-5);
    let scrolled = rt.viewport().unwrap();
    assert_eq!((scrolled.top, scrolled.following), (0, false));
    assert_eq!(
        edge(&rt, scrolled.top),
        [""],
        "the visible rows are history now"
    );
    assert_eq!(
        edge(&rt, scrolled.length - scrolled.rows),
        ["| switch"],
        "the live screen is still there"
    );
    rt.scroll_to_bottom();
    assert_eq!(rt.viewport().unwrap(), live);
}
