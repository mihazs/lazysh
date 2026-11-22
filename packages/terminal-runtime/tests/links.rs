//! URL and host-path detection of the core against what `terminalLinks.ts` finds on the same
//! bytes in xterm.js 5.5.0 (`fixtures/links.json`; `apps/client/src/xterm/linksFixture.test.ts` replays
//! them through the TypeScript code and fails if the recorded results drift).

mod replay;
mod support;

use lazysh_terminal_runtime::CellRange;
use replay::*;
use serde_json::{json, Value};
use support::*;

/// Per-row results folded into links in reading order, each with every row it is reported on,
/// as `apps/client/src/xterm/linksFixture.test.ts` records them.
fn fold(per_row: Vec<Vec<Value>>) -> Vec<Value> {
    let mut links: Vec<Value> = Vec::new();
    for (row, found) in per_row.into_iter().enumerate() {
        for link in found {
            match links.iter_mut().find(|known| {
                known["start"] == link["start"]
                    && known["end"] == link["end"]
                    && known["text"] == link["text"]
            }) {
                Some(known) => known["rows"].as_array_mut().unwrap().push(json!(row)),
                None => {
                    let mut link = link;
                    link["rows"] = json!([row]);
                    links.push(link);
                }
            }
        }
    }
    links.sort_by_key(|link| {
        (
            link["start"][1].as_u64(),
            link["start"][0].as_u64(),
            link["rows"][0].as_u64(),
        )
    });
    links
}

fn range(range: CellRange) -> (Value, Value) {
    (
        json!([range.start.x, range.start.y]),
        json!([range.end.x, range.end.y]),
    )
}

#[test]
fn urls_and_paths_are_found_where_the_typescript_detection_finds_them() {
    for case in fixture_cases("links") {
        let rt = replay(&case);
        let id = case["id"].as_str().unwrap();
        let total = rt.viewport().unwrap().length;
        let urls = (0..total).map(|row| {
            rt.find_urls(row).unwrap().into_iter().map(|link| {
                let (start, end) = range(link.range);
                json!({"text": link.text, "start": start, "end": end, "line": null, "column": null})
            }).collect()
        });
        let paths = (0..total).map(|row| {
            rt.find_paths(row).unwrap().into_iter().map(|link| {
                let (start, end) = range(link.range);
                json!({"text": link.text, "path": link.path, "start": start, "end": end, "line": link.line, "column": link.column})
            }).collect()
        });
        assert_eq!(
            Value::Array(fold(urls.collect())),
            case.get("urls").cloned().unwrap_or(json!([])),
            "{id}: urls"
        );
        assert_eq!(
            Value::Array(fold(paths.collect())),
            case.get("paths").cloned().unwrap_or(json!([])),
            "{id}: paths"
        );
    }
}

#[test]
fn a_row_past_the_end_and_a_row_of_a_huge_wrapped_line_cost_nothing_unbounded() {
    let mut rt = runtime(10, 3);
    assert!(rt.find_urls(99).unwrap().is_empty() && rt.find_paths(99).unwrap().is_empty());
    let line = format!("https://example.com/{}", "a".repeat(6000));
    feed(&mut rt, line.as_bytes());
    let total = rt.viewport().unwrap().length;
    let found = rt.find_urls(total - 1).unwrap();
    assert!(found.len() <= 1, "one bounded answer");
}

#[test]
fn a_url_wrapped_over_rows_far_outside_the_control_window_still_resolves_on_each_row() {
    use lazysh_terminal_runtime::CONTROL_WINDOW_MAX;
    let url = format!("https://example.com/{}", "a".repeat(40));
    let mut rt = runtime(20, 5);
    // The URL (60 characters) soft-wraps over three rows, then more than the largest window of rows scrolls it away.
    let mut output = format!("{url}\r\n").into_bytes();
    output
        .extend((0..CONTROL_WINDOW_MAX + 200).flat_map(|i| format!("filler {i}\r\n").into_bytes()));
    feed(&mut rt, &output);
    let view = rt.viewport().unwrap();
    assert!(
        view.top > CONTROL_WINDOW_MAX + 100,
        "the URL is far above the viewport"
    );
    for row in 0..3 {
        let found = rt.find_urls(row).unwrap();
        assert_eq!(found.len(), 1, "row {row}");
        assert_eq!(found[0].text, url, "row {row}");
        assert_eq!(
            (found[0].range.start.y, found[0].range.end.y),
            (0, 2),
            "row {row}"
        );
    }
    assert!(rt.find_urls(3).unwrap().is_empty());
}

#[test]
fn an_osc8_hyperlink_is_found_on_its_cells_and_only_on_screen() {
    let mut rt = runtime(30, 3);
    feed(
        &mut rt,
        b"\x1b]8;;https://example.com/x\x1b\\link\x1b]8;;\x1b\\ plain",
    );
    let at = |rt: &lazysh_terminal_runtime::TerminalRuntime, x, y| {
        rt.hyperlink_at(lazysh_terminal_runtime::CellPos { x, y })
            .unwrap()
    };
    assert_eq!(at(&rt, 0, 0).as_deref(), Some("https://example.com/x"));
    assert_eq!(at(&rt, 3, 0).as_deref(), Some("https://example.com/x"));
    assert_eq!(
        (at(&rt, 4, 0), at(&rt, 6, 0), at(&rt, 0, 1), at(&rt, 99, 0)),
        (None, None, None, None)
    );
    let lines: String = (0..10).map(|i| format!("\r\nrow {i}")).collect();
    feed(&mut rt, lines.as_bytes());
    assert_eq!(
        at(&rt, 0, 0),
        None,
        "scrolled off the screen: not asked of the viewport"
    );
    rt.scroll_viewport(-100);
    assert_eq!(
        at(&rt, 0, 0).as_deref(),
        Some("https://example.com/x"),
        "in view again"
    );
}

use lazysh_terminal_runtime::{CellPos, ControlAnswer, ControlQuery, LinkHit, TerminalRuntime};

fn tap(rt: &TerminalRuntime, x: u16, y: usize) -> Option<LinkHit> {
    rt.link_at(CellPos { x, y }).unwrap()
}

fn url(uri: &str) -> Option<LinkHit> {
    Some(LinkHit::Url { uri: uri.into() })
}

#[test]
fn a_tap_lands_on_the_url_or_path_under_it_and_on_nothing_else() {
    let mut rt = runtime(60, 4);
    feed(
        &mut rt,
        b"see https://example.com/a?b=1 or ~/src/main.rs:12:3 now",
    );
    let end = "see https://example.com/a?b=1".len() as u16 - 1;
    assert_eq!(tap(&rt, 3, 0), None, "the space before");
    for x in [4, 10, end] {
        assert_eq!(tap(&rt, x, 0), url("https://example.com/a?b=1"), "x {x}");
    }
    assert_eq!(tap(&rt, end + 1, 0), None, "the space after");
    let at = "see https://example.com/a?b=1 or ".len() as u16;
    let Some(LinkHit::Path {
        text,
        path,
        line,
        column,
        range,
    }) = tap(&rt, at + 4, 0)
    else {
        panic!("a path under the tap");
    };
    assert_eq!(
        (text.as_str(), path.as_str(), line, column),
        ("~/src/main.rs:12:3", "~/src/main.rs", Some(12), Some(3))
    );
    assert_eq!((range.start.x, range.end.x), (at, at + 17));
    assert_eq!(tap(&rt, at + 18, 0), None, "the space after the path");
    assert_eq!(tap(&rt, 0, 0), None, "plain text");
    assert_eq!(tap(&rt, 10, 3), None, "an empty row");
    assert_eq!(tap(&rt, 99, 0), None, "past the columns");
    assert_eq!(tap(&rt, 10, 99), None, "past the last row");
}

#[test]
fn a_tap_on_any_row_of_a_wrapped_url_opens_all_of_it() {
    let url_text = format!("https://example.com/{}", "a".repeat(30));
    let mut rt = runtime(20, 5);
    feed(&mut rt, format!("{url_text} tail").as_bytes());
    // 20 columns: the URL fills rows 0 and 1 and takes the first ten cells of row 2.
    for (x, y) in [(0, 0), (19, 0), (0, 1), (10, 1), (19, 1), (0, 2), (9, 2)] {
        assert_eq!(tap(&rt, x, y), url(&url_text), "({x}, {y})");
    }
    assert_eq!(tap(&rt, 10, 2), None, "the space after it");
    assert_eq!(tap(&rt, 12, 2), None, "the word after it");
}

#[test]
fn a_program_s_osc8_hyperlink_beats_what_the_text_says_and_a_url_beats_a_path_inside_it() {
    let mut rt = runtime(60, 6);
    feed(
        &mut rt,
        concat!(
            "\x1b]8;;https://example.com/docs\x1b\\the docs\x1b]8;;\x1b\\ and ",
            // The label is itself a URL, the target another: the target is what opens, and what consent shows.
            "\x1b]8;;https://evil.example/\x1b\\https://good.example/\x1b]8;;\x1b\\\r\n",
            "https://example.com/src/main.rs:7\r\n",
        )
        .as_bytes(),
    );
    assert_eq!(tap(&rt, 0, 0), url("https://example.com/docs"));
    assert_eq!(tap(&rt, 7, 0), url("https://example.com/docs"));
    assert_eq!(tap(&rt, 8, 0), None, "the plain space after the label");
    let label = "the docs and ".len() as u16;
    assert_eq!(tap(&rt, label + 3, 0), url("https://evil.example/"));
    assert_eq!(tap(&rt, 20, 1), url("https://example.com/src/main.rs:7"));
}

#[test]
fn history_is_searched_by_row_and_only_the_screen_carries_hyperlinks() {
    let mut rt = runtime(40, 3);
    feed(
        &mut rt,
        b"\x1b]8;;https://example.com/osc\x1b\\label\x1b]8;;\x1b\\ https://example.com/printed",
    );
    let lines: String = (0..30).map(|i| format!("\r\nrow {i}")).collect();
    feed(&mut rt, lines.as_bytes());
    assert!(rt.viewport().unwrap().top > 0, "the first row is history");
    assert_eq!(
        tap(&rt, 2, 0),
        None,
        "a hyperlink in history is not asked of the viewport"
    );
    assert_eq!(tap(&rt, 10, 0), url("https://example.com/printed"));
    rt.scroll_viewport(-100);
    assert_eq!(tap(&rt, 2, 0), url("https://example.com/osc"));
}

#[test]
fn the_control_query_answers_in_the_clients_shape() {
    let mut rt = runtime(60, 3);
    feed(&mut rt, b"https://example.com/x ./a/b.rs:4");
    let ask = |x: u16| {
        let answer = rt
            .control_query(ControlQuery::LinkAt {
                cell: CellPos { x, y: 0 },
            })
            .unwrap();
        assert!(matches!(answer, ControlAnswer::Link(_)));
        serde_json::to_value(answer).unwrap()
    };
    assert_eq!(
        ask(3),
        json!({"kind": "url", "uri": "https://example.com/x"})
    );
    assert_eq!(
        ask(25),
        json!({
            "kind": "path", "text": "./a/b.rs:4", "path": "./a/b.rs", "line": 4,
            "range": {"start": {"x": 22, "y": 0}, "end": {"x": 31, "y": 0}}
        })
    );
    assert_eq!(ask(21), Value::Null);
    let query: ControlQuery =
        serde_json::from_value(json!({"kind": "linkAt", "cell": {"x": 1, "y": 2}})).unwrap();
    assert_eq!(
        query,
        ControlQuery::LinkAt {
            cell: CellPos { x: 1, y: 2 }
        }
    );
}
