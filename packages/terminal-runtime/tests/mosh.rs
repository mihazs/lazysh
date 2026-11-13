//! Mosh's canonical framebuffer in the core ([#1317]). The oracle is the xterm backend's
//! `moshResize.ts` and its `apps/client/e2e/mosh-resize.spec.ts` scenarios; the bytes are the
//! frames the real Mosh client emitted (`apps/client/e2e/fixtures/mosh-resize-frames.json`, from
//! `LAZYSH_MOSH_FIXTURE` or, in a checkout, its place in the repository).
//!
//! [#1317]: https://github.com/mihazs/lazysh/issues/1317

mod support;

use lazysh_terminal_runtime::{
    Config, DisplayFailure, Hub, HubConfig, Offer, Size, SizeAuthority, SizeOutcome,
    TerminalRuntime,
};
use serde_json::Value;
use support::*;

fn size(cols: u16, rows: u16) -> Size {
    Size {
        cols,
        rows,
        cell_width_px: CELL_W,
        cell_height_px: CELL_H,
    }
}

fn mosh(cols: u16, rows: u16) -> TerminalRuntime {
    TerminalRuntime::new(Config {
        size: size(cols, rows),
        canonical_frames: true,
        ..Config::default()
    })
    .unwrap()
}

/// One display update as the transport wraps it.
fn frame(id: u64, cols: u16, rows: u16, body: &str) -> Vec<u8> {
    format!(
        "\x1b]7777;lazysh-mosh;1;begin;{id};{cols};{rows}\x1b\\{body}\x1b]7777;lazysh-mosh;1;end;{id}\x1b\\"
    )
    .into_bytes()
}

fn dims(rt: &TerminalRuntime) -> (u16, u16) {
    (rt.size().cols, rt.size().rows)
}

struct Captured {
    cols: u16,
    rows: u16,
    visible_rows: usize,
    cursor: (u16, u16),
    long_row: String,
    bytes: Vec<u8>,
}

fn captured() -> Vec<Captured> {
    let path = std::env::var("LAZYSH_MOSH_FIXTURE").unwrap_or_else(|_| {
        format!(
            "{}/../../apps/client/e2e/fixtures/mosh-resize-frames.json",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let json: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("fixture {path}: {err}")),
    )
    .unwrap();
    let number = |frame: &Value, key: &str| frame[key].as_u64().unwrap() as usize;
    json["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|frame| {
            let hex = frame["bytesHex"].as_str().unwrap();
            Captured {
                cols: number(frame, "cols") as u16,
                rows: number(frame, "rows") as u16,
                visible_rows: number(frame, "expectedVisibleRows"),
                cursor: (
                    frame["expectedCursor"][0].as_u64().unwrap() as u16,
                    frame["expectedCursor"][1].as_u64().unwrap() as u16,
                ),
                long_row: frame["expectedLongRow"].as_str().unwrap().to_string(),
                bytes: (0..hex.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                    .collect(),
            }
        })
        .collect()
}

#[test]
fn captured_frames_apply_their_geometry_without_duplicating_rows_or_making_history() {
    let frames = captured();
    assert_eq!(frames.len(), 6);
    let mut rt = mosh(40, 12);
    for (index, expected) in frames.iter().enumerate() {
        // The UI asks for this size first, as the xterm scenario does; as intent it changes nothing.
        assert_eq!(
            rt.request_size(size(expected.cols, expected.rows)).unwrap(),
            SizeOutcome::Deferred(size(expected.cols, expected.rows))
        );
        feed(&mut rt, &expected.bytes);
        assert_eq!(dims(&rt), (expected.cols, expected.rows), "frame {index}");
        assert_eq!(
            rt.scrollback_rows().unwrap(),
            0,
            "frame {index} made history"
        );
        let text = rt.screen_text().unwrap();
        for row in 0..expected.visible_rows {
            let prefix = format!("OWNED_ROW_{row:02}");
            let copies = text
                .lines()
                .filter(|line| line.starts_with(&prefix))
                .count();
            assert_eq!(copies, 1, "frame {index}: {prefix} appears {copies} times");
        }
        let snapshot = rt.snapshot().unwrap();
        let cursor = snapshot.cursor.viewport.expect("cursor on screen");
        assert_eq!((cursor.x, cursor.y), expected.cursor, "frame {index}");
        let rows = lines(&snapshot);
        assert_eq!(rows[1], expected.long_row, "frame {index}");
        let first = &snapshot.dirty.iter().find(|row| row.y == 0).unwrap().cells[0];
        let red = first.fg.expect("red foreground");
        assert!(
            first.style.bold && red.r > red.g && red.r > red.b,
            "frame {index}: bold red"
        );
    }
    assert!(
        rt.take_replies().0.is_empty(),
        "a frame must never answer the host"
    );
    assert_eq!(rt.display_failure(), None);
}

#[test]
fn a_local_resize_still_duplicates_rows_where_a_canonical_one_does_not() {
    // The same bytes without the canonical mode and a UI-owned size: what the mode is for.
    let frames = captured();
    let mut rt = runtime(40, 12);
    for expected in &frames[..2] {
        rt.request_size(size(expected.cols, expected.rows)).unwrap();
        feed(&mut rt, &expected.bytes);
    }
    assert!(
        rt.scrollback_rows().unwrap() > 0,
        "a plain shrink pushes the top rows into scrollback"
    );
    assert_eq!(
        rt.display_failure(),
        None,
        "no envelope is read without the mode"
    );
}

#[test]
fn a_resize_is_top_anchored_and_keeps_the_cursor_and_pen() {
    let mut rt = mosh(40, 12);
    feed(
        &mut rt,
        &frame(1, 40, 12, "\x1b[HTOP\x1b[12;1H\x1b[1;31mBOTTOM"),
    );
    feed(&mut rt, &frame(2, 40, 6, ""));
    assert_eq!(rt.scrollback_rows().unwrap(), 0);
    let rows = screen(&mut rt);
    assert_eq!((rows.len(), rows[0].as_str()), (6, "TOP"));
    assert!(
        rows.iter().all(|row| !row.contains("BOTTOM")),
        "the tail is dropped, not scrolled"
    );
    let cursor = rt.snapshot().unwrap().cursor.viewport.unwrap();
    assert_eq!(
        (cursor.x, cursor.y),
        (6, 5),
        "the cursor is clamped into the new grid"
    );
    feed(&mut rt, &frame(3, 40, 12, "X"));
    let grown = rt.snapshot().unwrap();
    let rows = lines(&grown);
    assert_eq!(
        (rows[0].as_str(), rows[5].as_str()),
        ("TOP", "      X"),
        "rows stay where they were"
    );
    assert!(
        rows[6..].iter().all(String::is_empty),
        "growing adds blank rows at the bottom"
    );
    let x = &grown.dirty.iter().find(|row| row.y == 5).unwrap().cells[6];
    assert_eq!(x.text, "X");
    assert!(
        x.style.bold && x.fg.is_some(),
        "the pen survives the resize"
    );
    assert_eq!(
        rt.scrollback_rows().unwrap(),
        0,
        "growing does not pull anything back or push it out"
    );
}

#[test]
fn history_is_neither_reflowed_nor_duplicated() {
    let mut rt = mosh(40, 6);
    let lines_out: Vec<String> = (0..16)
        .map(|i| format!("HISTORY_{i:02}_abcdefghijklmnopqrstuvwxyz"))
        .collect();
    feed(
        &mut rt,
        &frame(1, 40, 6, &format!("\x1b[H{}", lines_out.join("\r\n"))),
    );
    let history = rt.scrollback_rows().unwrap();
    assert!(history > 2);
    let before: Vec<String> = rt
        .screen_text()
        .unwrap()
        .lines()
        .take(history)
        .map(str::to_string)
        .collect();
    feed(&mut rt, &frame(2, 20, 3, ""));
    assert_eq!(
        rt.scrollback_rows().unwrap(),
        history,
        "no row appeared or vanished"
    );
    let narrow: Vec<String> = rt
        .screen_text()
        .unwrap()
        .lines()
        .take(history)
        .map(str::to_string)
        .collect();
    for (old, new) in before.iter().zip(&narrow) {
        // Shortcut recorded in the design document: Ghostty has no per-row retained width, so
        // the cells beyond a narrower grid are cut where the xterm backend only hides them.
        assert_eq!(new, &old[..20], "history is cut, never wrapped");
    }
    feed(&mut rt, &frame(3, 40, 12, ""));
    assert_eq!(rt.scrollback_rows().unwrap(), history);
}

#[test]
fn geometry_events_report_each_applied_size_and_who_decided_it() {
    let mut rt = mosh(40, 12);
    feed(&mut rt, &frame(1, 40, 12, "a"));
    assert_eq!(
        rt.take_events().geometry,
        None,
        "an unchanged size is not an event"
    );
    feed(&mut rt, &frame(2, 40, 6, ""));
    feed(&mut rt, &frame(3, 20, 6, ""));
    let geometry = rt
        .take_events()
        .geometry
        .expect("latest size since the last take");
    assert_eq!(
        (geometry.size, geometry.authority),
        (size(20, 6), SizeAuthority::Transport)
    );
    assert_eq!(rt.take_events().geometry, None);
    let mut plain = runtime(10, 3);
    plain.request_size(size(12, 4)).unwrap();
    assert_eq!(
        plain.take_events().geometry.map(|g| g.authority),
        Some(SizeAuthority::Local)
    );
}

#[test]
fn an_envelope_split_at_any_byte_applies_once_and_in_order() {
    let bytes = frame(7, 30, 5, "\x1b[HSPLIT");
    for cut in 0..=bytes.len() {
        let mut rt = mosh(40, 12);
        for part in [&bytes[..cut], &bytes[cut..]] {
            if !part.is_empty() {
                assert!(matches!(rt.offer(part.to_vec()), Offer::Accepted));
                rt.pump(usize::MAX);
            }
        }
        assert_eq!(dims(&rt), (30, 5), "cut at {cut}");
        assert_eq!(screen(&mut rt)[0], "SPLIT", "cut at {cut}");
        assert_eq!(rt.display_failure(), None, "cut at {cut}");
    }
}

#[test]
fn bytewise_output_stays_ordered_despite_mid_frame_ui_requests() {
    let frames = captured();
    let mut rt = mosh(40, 12);
    for expected in &frames[..2] {
        for (i, byte) in expected.bytes.iter().enumerate() {
            feed(&mut rt, &[*byte]);
            if i == 7 {
                rt.request_size(size(20, 1)).unwrap();
            }
        }
    }
    assert_eq!(
        screen(&mut rt)[4],
        "OWNED_ROW_04_世界",
        "UTF-8 and CSI survive one-byte chunks"
    );
    let mut big = frame(1000, 40, 12, "\x1b[H");
    big.extend(std::iter::repeat_n(b"\x1b[0m".iter(), 5000).flatten());
    big.extend_from_slice(b"SAFE");
    let mut rt = mosh(40, 12);
    for chunk in big.chunks(16 * 1024) {
        feed(&mut rt, chunk);
        rt.request_size(size(30, 2)).unwrap();
    }
    assert_eq!((dims(&rt), screen(&mut rt)[0].as_str()), ((40, 12), "SAFE"));
    assert_eq!(rt.display_failure(), None);
}

#[test]
fn malformed_stale_nested_and_unfinished_envelopes_fail_the_display() {
    let osc = |payload: &str| format!("\x1b]7777;{payload}\x1b\\").into_bytes();
    let invalid = [
        "lazysh-mosh;2;begin;1;40;12",
        "lazysh-mosh;1;begin;9007199254740992;40;12",
        "lazysh-mosh;1;begin;1;1;12",
        "lazysh-mosh;1;begin;1;513;12",
        "lazysh-mosh;1;begin;1;300;200",
        "lazysh-mosh;1;begin;0;40;12",
        "lazysh-mosh;1;begin;1;040;12",
        "lazysh-mosh;1;begin;1;40;12;extra",
        "lazysh-mosh;1;end;1",
        "lazysh-mosh;1;halt;1",
        "lazysh-mosh;",
    ];
    for payload in invalid {
        let mut rt = mosh(40, 12);
        feed(&mut rt, &osc(payload));
        assert_eq!(
            rt.display_failure(),
            Some(DisplayFailure::InvalidFrame),
            "{payload}"
        );
        assert_eq!(dims(&rt), (40, 12), "{payload} must not resize");
    }
    let begin = |id| frame(id, 40, 12, "");
    let mut nested = mosh(40, 12);
    feed(&mut nested, &osc("lazysh-mosh;1;begin;1;40;12"));
    feed(&mut nested, &osc("lazysh-mosh;1;begin;2;30;5"));
    assert_eq!(
        (nested.display_failure(), dims(&nested)),
        (Some(DisplayFailure::InvalidFrame), (40, 12))
    );
    let mut stale = mosh(40, 12);
    feed(&mut stale, &begin(5));
    feed(&mut stale, &begin(5));
    assert_eq!(stale.display_failure(), Some(DisplayFailure::InvalidFrame));
    let mut overlong = mosh(40, 12);
    feed(
        &mut overlong,
        &osc(&format!("lazysh-mosh;1;end;{}", "1".repeat(200))),
    );
    assert_eq!(
        overlong.display_failure(),
        Some(DisplayFailure::InvalidFrame)
    );
    let mut unterminated = mosh(40, 12);
    feed(
        &mut unterminated,
        b"\x1b]7777;lazysh-mosh;1;begin;1;40;12\x1bX",
    );
    assert_eq!(
        unterminated.display_failure(),
        Some(DisplayFailure::InvalidFrame)
    );

    let mut open = mosh(40, 12);
    feed(&mut open, &osc("lazysh-mosh;1;begin;1;40;12"));
    assert_eq!(
        open.display_failure(),
        None,
        "an open frame is not a failure until the stream ends"
    );
    assert_eq!(open.finish_canonical(), Some(DisplayFailure::PartialFrame));
    assert_eq!(
        open.take_events().display_failure,
        Some(DisplayFailure::PartialFrame)
    );
    assert_eq!(
        open.finish_canonical(),
        Some(DisplayFailure::PartialFrame),
        "idempotent"
    );
    assert_eq!(open.take_events().display_failure, None, "reported once");
}

#[test]
fn other_osc_7777_and_ordinary_output_are_left_to_the_vt() {
    let mut rt = mosh(40, 12);
    feed(
        &mut rt,
        b"\x1b]7777;other;1;begin;1;10;5\x1b\\\x1b]7777;lazy\x07\x1b]7777\x1b\\ok",
    );
    assert_eq!((dims(&rt), rt.display_failure()), ((40, 12), None));
    assert_eq!(screen(&mut rt)[0], "ok");
}

#[test]
fn a_failed_display_stops_following_the_transport_and_forwards_nothing() {
    let mut rt = mosh(40, 12);
    feed(&mut rt, &frame(1, 30, 6, ""));
    feed(&mut rt, b"\x1b]7777;lazysh-mosh;1;end;9\x1b\\");
    assert_eq!(rt.display_failure(), Some(DisplayFailure::InvalidFrame));
    feed(&mut rt, &frame(2, 20, 3, ""));
    assert_eq!(dims(&rt), (30, 6), "frames after a failure are ignored");
    assert_eq!(rt.request_size(size(50, 20)).unwrap(), SizeOutcome::Dropped);
    assert_eq!(rt.size_intent(), None, "nothing is recorded or forwarded");
}

#[test]
fn ui_sizes_are_intent_checked_against_the_transport_limits() {
    let mut rt = mosh(40, 12);
    assert_eq!(
        rt.authority(),
        SizeAuthority::Transport,
        "intent only, even before the first frame"
    );
    assert_eq!(
        rt.request_size(size(80, 24)).unwrap(),
        SizeOutcome::Deferred(size(80, 24))
    );
    assert_eq!(dims(&rt), (40, 12));
    for bad in [size(1, 5), size(513, 5), size(200, 200)] {
        assert!(rt.request_size(bad).is_err(), "{bad:?}");
    }
    assert_eq!(
        rt.size_intent(),
        Some(size(80, 24)),
        "a refused size is not an intent"
    );
}

#[test]
fn closing_keeps_the_final_geometry_and_never_applies_a_pending_intent() {
    let mut rt = mosh(40, 12);
    feed(&mut rt, &frame(1, 41, 12, "\x1b[12;1HQUEUED_BOTTOM\x1b[H"));
    rt.request_size(size(70, 20)).unwrap();
    assert_eq!(rt.finish_canonical(), None);
    assert_eq!(
        (dims(&rt), rt.authority(), rt.size_intent()),
        ((41, 12), SizeAuthority::Local, None)
    );
    assert_eq!(screen(&mut rt)[11], "QUEUED_BOTTOM");
    assert_eq!(rt.request_size(size(50, 10)).unwrap(), SizeOutcome::Applied);
    assert_eq!(dims(&rt), (50, 10), "the UI owns the size again");
}

#[test]
fn a_canonical_resize_is_a_full_redraw_for_the_renderer() {
    let mut rt = mosh(40, 12);
    feed(&mut rt, &frame(1, 40, 12, "\x1b[Hone"));
    rt.take_frame().unwrap();
    feed(&mut rt, &frame(2, 20, 6, ""));
    let frame = rt
        .take_frame()
        .unwrap()
        .expect("a resize dirties the screen");
    assert_eq!((frame.cols, frame.rows, frame.full), (20, 6, true));
}

#[test]
fn a_mosh_session_on_the_worker_pool_applies_frames_split_across_feeds() {
    let hub = Hub::new(HubConfig::default());
    let session = hub
        .create(
            "mosh",
            Config {
                canonical_frames: true,
                ..config(40, 12, 1 << 20)
            },
            quiet_hooks(),
        )
        .unwrap();
    let bytes = frame(1, 30, 5, "\x1b[Hfrom the pool");
    let mut total = 0;
    for part in bytes.chunks(9) {
        assert_eq!(session.feed(part.to_vec()).unwrap(), Offer::Accepted);
        total += part.len() as u64;
    }
    wait_until(|| session.stats().unwrap().processed == total);
    let (size, failure, events) = session
        .with(|rt| (rt.size(), rt.display_failure(), rt.take_events()))
        .unwrap();
    assert_eq!((size.cols, size.rows, failure), (30, 5, None));
    assert_eq!(
        events.geometry.map(|g| g.authority),
        Some(SizeAuthority::Transport)
    );
    assert_eq!(lines(&session.attach().unwrap())[0], "from the pool");
}

#[test]
fn both_screens_resize_and_the_saved_cursor_and_pen_survive() {
    // The xterm scenario "resizes both buffers through one row while the alternate buffer is active".
    let mut rt = mosh(40, 12);
    feed(&mut rt, b"\x1b[1;32mSURVIVING\x1b7\x1b[0m\x1b[12;1HCLIPPED");
    feed(&mut rt, &frame(1, 40, 1, ""));
    assert_eq!(
        screen(&mut rt),
        ["SURVIVING"],
        "the surviving prefix is untouched"
    );
    feed(&mut rt, &frame(2, 40, 12, ""));
    feed(&mut rt, b"\x1b8Z");
    let restored = rt.snapshot().unwrap();
    assert_eq!(
        lines(&restored)[0],
        "SURVIVINGZ",
        "DECRC finds the program's own saved cursor"
    );
    let z = &restored.dirty[0].cells[9];
    assert!(z.style.bold && z.fg.is_some(), "and its saved pen");
    feed(&mut rt, b"\x1b[?1049h\x1b[HALT");
    feed(&mut rt, &frame(3, 20, 1, ""));
    feed(&mut rt, &frame(4, 40, 12, ""));
    assert_eq!(screen(&mut rt)[0], "ALT");
    feed(&mut rt, b"\x1b[?1049l");
    assert_eq!(
        (screen(&mut rt)[0].as_str(), rt.scrollback_rows().unwrap()),
        ("SURVIVINGZ", 0)
    );
}

#[test]
fn a_reader_scrolled_into_history_keeps_their_place() {
    let mut rt = mosh(40, 6);
    let text: String = (0..30).map(|i| format!("L{i:02}\r\n")).collect();
    feed(&mut rt, text.as_bytes());
    rt.scroll_viewport(-3);
    let before = rt.viewport_text().unwrap();
    feed(&mut rt, &frame(1, 30, 6, ""));
    assert_eq!(rt.viewport_text().unwrap(), before);
}
