//! Selection, copy, word and search queries of the core against what the xterm backend answers for
//! the same bytes (`fixtures/selection.json`; `apps/client/src/selectionFixture.test.ts` replays the
//! bytes through xterm.js 5.5.0 and the code lazysh uses today, and fails if the answers drift).

mod support;

use lazysh_terminal_runtime::{CellPos, CellRange, Direction, SearchHit};
use serde_json::Value;
use support::*;

fn pos(value: &Value) -> CellPos {
    CellPos {
        x: value[0].as_u64().unwrap() as u16,
        y: value[1].as_u64().unwrap() as usize,
    }
}

#[test]
fn selected_and_copied_text_matches_the_xterm_backend() {
    for case in fixture_cases("selection") {
        let rt = replay(&case);
        let id = case["id"].as_str().unwrap();
        for s in case["selections"].as_array().unwrap() {
            let range = CellRange {
                start: pos(&s["start"]),
                end: pos(&s["end"]),
            };
            assert_eq!(
                rt.selection_text(range).unwrap(),
                s["text"].as_str().unwrap(),
                "{id}: {range:?}"
            );
        }
        let all = rt.buffer_range().unwrap().expect("a non-empty buffer");
        assert_eq!(
            rt.selection_text(all).unwrap(),
            case["all"].as_str().unwrap(),
            "{id}: select all"
        );
        assert_eq!(
            rt.copy_screen().unwrap(),
            case["screen"].as_str().unwrap(),
            "{id}: copy screen"
        );
    }
}

#[test]
fn the_word_under_a_cell_matches_terminal_word_at() {
    for case in fixture_cases("selection") {
        let rt = replay(&case);
        let id = case["id"].as_str().unwrap();
        for w in case["words"].as_array().unwrap() {
            let range = rt.word_at(pos(&w["at"])).unwrap();
            assert_eq!(
                (range.start, range.end),
                (pos(&w["range"][0]), pos(&w["range"][1])),
                "{id}: word at {}",
                w["at"]
            );
        }
    }
}

#[test]
fn search_finds_the_same_matches_as_the_find_box_does_today() {
    for case in fixture_cases("selection") {
        let rt = replay(&case);
        let id = case["id"].as_str().unwrap();
        for q in case["searches"].as_array().unwrap() {
            let direction = if q["direction"] == 1 {
                Direction::Forward
            } else {
                Direction::Backward
            };
            let expected = q["hit"].as_object().map(|hit| SearchHit {
                row: hit["row"].as_u64().unwrap() as usize,
                column: hit["column"].as_u64().unwrap() as usize,
                length: hit["length"].as_u64().unwrap() as usize,
            });
            assert_eq!(
                rt.search(
                    q["query"].as_str().unwrap(),
                    direction,
                    q["from"].as_u64().map(|row| row as usize)
                )
                .unwrap(),
                expected,
                "{id}: search {q}"
            );
        }
    }
}

#[test]
fn a_logical_line_is_the_whole_soft_wrapped_chain_and_nothing_else() {
    let mut rt = runtime(10, 5);
    feed(&mut rt, b"first\r\n0123456789ABCDEFGHIJklm\r\nlast");
    let chain = rt.line_at(2).unwrap();
    assert_eq!(
        (chain.start, chain.end),
        (CellPos { x: 0, y: 1 }, CellPos { x: 9, y: 3 })
    );
    assert_eq!(rt.line_at(1).unwrap(), chain);
    assert_eq!(rt.line_at(3).unwrap(), chain);
    assert_eq!(rt.selection_text(chain).unwrap(), "0123456789ABCDEFGHIJklm");
    let single = rt.line_at(0).unwrap();
    assert_eq!(
        (single.start.y, single.end.y),
        (0, 0),
        "a hard break ends the line"
    );
    assert_eq!(
        rt.line_at(999).unwrap().end.y,
        4,
        "a row past the end is the last one"
    );
}
