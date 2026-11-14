//! URL and host-path detection of the core against what `terminalLinks.ts` finds on the same
//! bytes in xterm.js 5.5.0 (`fixtures/links.json`; `apps/client/src/xterm/linksFixture.test.ts` replays
//! them through the TypeScript code and fails if the recorded results drift).

mod support;

use lazysh_terminal_runtime::CellRange;
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
