//! VT conformance fixtures: each case feeds exact bytes and asserts what a renderer or the
//! transport would observe (cells, cursor, modes, encoded input, replies), never source text.

mod support;

use lazysh_terminal_runtime::{
    ffi, ActiveScreen, CellWide, CursorVisualStyle, KeyInput, MouseInput, Offer, RenderCursor,
    RgbColor, Size, SizeAuthority, SizeOutcome, TerminalRuntime,
};
use support::*;

#[test]
fn plain_text_wraps_at_the_right_edge() {
    let mut rt = runtime(10, 3);
    feed(&mut rt, b"0123456789ABC");
    assert_eq!(screen(&mut rt), ["0123456789", "ABC", ""]);
}

#[test]
fn ansi_indexed_and_truecolor_attributes_reach_the_cells() {
    let mut rt = runtime(20, 2);
    feed(
        &mut rt,
        b"\x1b[1;31mR\x1b[0m\x1b[38;2;1;2;3;48;2;9;8;7mT\x1b[0m\x1b[48;5;196mI\x1b[0mN",
    );
    let frame = rt.snapshot().unwrap();
    let cells = &frame.dirty[0].cells;
    assert!(cells[0].style.bold);
    assert!(
        cells[0].fg.is_some(),
        "indexed red resolves to an RGB value"
    );
    assert_eq!(cells[1].fg, Some(RgbColor { r: 1, g: 2, b: 3 }));
    assert_eq!(cells[1].bg, Some(RgbColor { r: 9, g: 8, b: 7 }));
    assert!(cells[2].bg.is_some());
    assert_eq!(
        (cells[3].fg, cells[3].bg, cells[3].style.bold),
        (None, None, false),
        "reset restores defaults"
    );
}

#[test]
fn cjk_is_two_cells_and_the_cursor_advances_by_two() {
    let mut rt = runtime(10, 2);
    feed(&mut rt, "日本a".as_bytes());
    let frame = rt.snapshot().unwrap();
    let wides: Vec<_> = frame.dirty[0]
        .cells
        .iter()
        .take(5)
        .map(|c| c.wide)
        .collect();
    assert_eq!(
        wides,
        [
            CellWide::Wide,
            CellWide::SpacerTail,
            CellWide::Wide,
            CellWide::SpacerTail,
            CellWide::Narrow
        ]
    );
    assert_eq!(frame.cursor.viewport.unwrap().x, 5);
    assert_eq!(lines(&frame)[0], "日本a");
}

#[test]
fn combining_marks_and_zwj_emoji_stay_in_one_cell() {
    let mut rt = runtime(10, 2);
    feed(&mut rt, "e\u{301}👨\u{200d}👩\u{200d}👧x".as_bytes());
    let frame = rt.snapshot().unwrap();
    let cells = &frame.dirty[0].cells;
    assert_eq!(cells[0].text, "e\u{301}");
    assert_eq!(cells[1].text, "👨\u{200d}👩\u{200d}👧");
    assert_eq!(cells[1].wide, CellWide::Wide);
    assert_eq!(
        cells[3].text, "x",
        "the whole family is one two-cell cluster"
    );
}

#[test]
fn alternate_screen_preserves_the_primary_screen() {
    let mut rt = runtime(10, 3);
    feed(&mut rt, b"primary");
    feed(&mut rt, b"\x1b[?1049h\x1b[2J\x1b[HALT");
    assert!(rt.modes().unwrap().alternate_screen);
    let frame = rt.snapshot().unwrap();
    assert_eq!(frame.active_screen, ActiveScreen::Alternate);
    assert_eq!(lines(&frame)[0], "ALT");
    feed(&mut rt, b"\x1b[?1049l");
    assert!(!rt.modes().unwrap().alternate_screen);
    assert_eq!(screen(&mut rt)[0], "primary");
}

#[test]
fn cursor_position_visibility_and_style() {
    let mut rt = runtime(20, 10);
    feed(&mut rt, b"\x1b[5;10H\x1b[?25l\x1b[5 q");
    let cursor = rt.snapshot().unwrap().cursor;
    let at = cursor.viewport.unwrap();
    assert_eq!((at.x, at.y), (9, 4));
    assert!(!cursor.visible);
    assert!(cursor.blinking);
    assert_eq!(cursor.visual_style, CursorVisualStyle::Bar);
    feed(&mut rt, b"\x1b[?25h\x1b[2 q");
    let cursor = rt.snapshot().unwrap().cursor;
    assert!(cursor.visible && !cursor.blinking);
    assert_eq!(cursor.visual_style, CursorVisualStyle::Block);
}

#[test]
fn bracketed_paste_follows_the_mode_and_cannot_close_its_own_bracket() {
    let mut rt = runtime(20, 3);
    assert_eq!(rt.encode_paste("a\nb\r\nc").unwrap(), b"a\rb\rc");
    feed(&mut rt, b"\x1b[?2004h");
    assert!(rt.modes().unwrap().bracketed_paste);
    assert_eq!(
        rt.encode_paste("hi\nthere").unwrap(),
        b"\x1b[200~hi\nthere\x1b[201~"
    );
    assert_eq!(
        rt.encode_paste("x\x1b[201~rm -rf /").unwrap(),
        b"\x1b[200~xrm -rf /\x1b[201~"
    );
}

#[test]
fn mouse_reports_follow_tracking_mode_and_sgr_format() {
    let press = MouseInput {
        action: ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_PRESS,
        button: Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_LEFT),
        mods: 0,
        x: 55.0,
        y: 30.0,
    };
    let mut rt = runtime(40, 10);
    assert!(
        rt.encode_mouse(press).unwrap().is_empty(),
        "no tracking, no report"
    );
    feed(&mut rt, b"\x1b[?1000h\x1b[?1006h");
    assert!(rt.modes().unwrap().mouse_tracking);
    // x 55px / 10px = column 6 (1-based), y 30px / 20px = row 2 (1-based).
    assert_eq!(rt.encode_mouse(press).unwrap(), b"\x1b[<0;6;2M");
    let release = MouseInput {
        action: ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_RELEASE,
        ..press
    };
    assert_eq!(rt.encode_mouse(release).unwrap(), b"\x1b[<0;6;2m");
}

#[test]
fn keys_depend_on_terminal_modes() {
    let mut rt = runtime(20, 3);
    let up = key(ffi::GhosttyKey_GHOSTTY_KEY_ARROW_UP, 0, None);
    assert_eq!(rt.encode_key(&up).unwrap(), b"\x1b[A");
    feed(&mut rt, b"\x1b[?1h");
    assert_eq!(rt.encode_key(&up).unwrap(), b"\x1bOA");
    assert_eq!(
        rt.encode_key(&key(ffi::GhosttyKey_GHOSTTY_KEY_ENTER, 0, None))
            .unwrap(),
        b"\r"
    );
    let ctrl_c = key(ffi::GhosttyKey_GHOSTTY_KEY_C, 1 << 1, Some("c"));
    assert_eq!(rt.encode_key(&ctrl_c).unwrap(), [0x03]);
}

#[test]
fn ime_commit_is_sent_once_and_composition_sends_nothing() {
    let mut rt = runtime(20, 3);
    let commit = key(ffi::GhosttyKey_GHOSTTY_KEY_UNIDENTIFIED, 0, Some("é日"));
    assert_eq!(rt.encode_key(&commit).unwrap(), "é日".as_bytes());
    let composing = KeyInput {
        composing: true,
        ..commit.clone()
    };
    assert!(
        rt.encode_key(&composing).unwrap().is_empty(),
        "pre-edit must never reach the peer"
    );
}

#[test]
fn terminal_replies_go_back_to_the_peer_in_order() {
    let mut rt = runtime(40, 10);
    feed(&mut rt, b"\x1b[3;5H\x1b[6n\x1b[c");
    let (replies, dropped) = rt.take_replies();
    assert_eq!(dropped, 0);
    assert!(
        replies.starts_with(b"\x1b[3;5R"),
        "cursor position report first: {replies:?}"
    );
    assert!(
        replies[6..].starts_with(b"\x1b[?"),
        "then primary device attributes: {replies:?}"
    );
    assert!(
        rt.take_replies().0.is_empty(),
        "taken replies are not repeated"
    );
}

#[test]
fn reply_queue_is_bounded_and_counts_what_it_refuses() {
    let mut rt = runtime(40, 10);
    // 20k status queries; replies are never taken, as with a stalled transport.
    feed(&mut rt, &b"\x1b[5n".repeat(20_000));
    let (replies, dropped) = rt.take_replies();
    assert!(replies.len() <= 64 * 1024 && !replies.is_empty());
    assert_eq!(
        replies.len() as u64 + dropped,
        20_000 * 4,
        "every reply byte is kept or counted"
    );
}

#[test]
fn escape_sequences_and_utf8_split_across_chunks_parse_identically() {
    let transcript =
        "\x1b[1;38;2;10;20;30m日本語\x1b[0m e\u{301} 😀\x1b[2;3Hxy\x1b]0;title\x07\x1b[?1049hALT"
            .as_bytes();
    let mut whole = runtime(30, 5);
    feed(&mut whole, transcript);
    let mut split = runtime(30, 5);
    for byte in transcript {
        assert_eq!(split.offer(vec![*byte]), Offer::Accepted);
        split.pump(usize::MAX);
    }
    assert_eq!(whole.snapshot().unwrap(), split.snapshot().unwrap());
}

#[test]
fn arbitrary_binary_never_corrupts_later_output() {
    let mut rt = runtime(20, 3);
    let junk: Vec<u8> = (0..=255u8)
        .cycle()
        .take(4096)
        .filter(|b| *b != 0x1b && *b != 0x9b)
        .collect();
    feed(&mut rt, &junk);
    feed(&mut rt, b"\x1b[2J\x1b[Hok");
    assert_eq!(screen(&mut rt)[0], "ok");
}

#[test]
fn backpressure_returns_chunks_and_credits_follow_processing() {
    let mut rt = TerminalRuntime::new(lazysh_terminal_runtime::Config {
        ingress_bytes: 1000,
        ..Default::default()
    })
    .unwrap();
    let a = vec![b'a'; 600];
    let b = vec![b'b'; 600];
    assert_eq!(rt.offer(a), Offer::Accepted);
    assert_eq!(
        rt.offer(b.clone()),
        Offer::Full(b.clone()),
        "rejected chunk comes back intact"
    );
    assert_eq!(rt.ingress().available(), 400);
    assert_eq!(rt.offer(vec![0; 1001]), Offer::TooLarge(vec![0; 1001]));
    assert_eq!(rt.pump(usize::MAX), 600, "credit equals bytes processed");
    assert_eq!(rt.offer(b), Offer::Accepted);
    assert_eq!(rt.pump(usize::MAX), 600);
    assert_eq!(rt.processed_bytes(), 1200);
}

#[test]
fn chunks_are_processed_in_arrival_order() {
    let mut rt = runtime(10, 2);
    for part in ["A", "B", "C"] {
        assert_eq!(rt.offer(part.as_bytes().to_vec()), Offer::Accepted);
    }
    assert_eq!(
        rt.pump(1),
        1,
        "a budget of one byte still takes exactly one whole chunk"
    );
    assert_eq!(rt.pump(usize::MAX), 2);
    assert_eq!(screen(&mut rt)[0], "ABC");
}

#[test]
fn an_unchanged_screen_yields_no_frame_and_a_write_yields_only_its_rows() {
    let mut rt = runtime(20, 10);
    feed(&mut rt, b"hello");
    assert!(rt.take_frame().unwrap().expect("first frame").full);
    assert!(
        rt.take_frame().unwrap().is_none(),
        "idle terminal produces no work"
    );
    feed(&mut rt, b"\x1b[8;1Hxyz");
    let frame = rt.take_frame().unwrap().expect("incremental frame");
    assert!(!frame.full);
    // The row the cursor left is redrawn too; no other row may be.
    let ys: Vec<u16> = frame.dirty.iter().map(|row| row.y).collect();
    assert_eq!(ys, [0, 7]);
    assert_eq!(lines(&frame), ["hello", "xyz"]);
    assert!(rt.take_frame().unwrap().is_none());
}

#[test]
fn cursor_only_changes_yield_a_frame_without_rows() {
    // libghostty-vt marks no row dirty for these; a renderer fed only by take_frame kept a stale cursor.
    type Check = fn(&RenderCursor) -> bool;
    let steps: [(&str, &[u8], Check); 4] = [
        ("a move inside the row", b"\x1b[1;1H", |c| {
            c.viewport.unwrap().x == 0
        }),
        ("the cursor style", b"\x1b[4 q", |c| {
            c.visual_style == CursorVisualStyle::Underline
        }),
        ("visibility", b"\x1b[?25l", |c| !c.visible),
        ("blinking", b"\x1b[?25h\x1b[?12h", |c| {
            c.visible && c.blinking
        }),
    ];
    let mut rt = runtime(10, 3);
    feed(&mut rt, b"abc");
    rt.take_frame().unwrap();
    for (what, bytes, check) in steps {
        feed(&mut rt, bytes);
        let frame = rt
            .take_frame()
            .unwrap()
            .unwrap_or_else(|| panic!("no frame for {what}"));
        assert!(!frame.full && frame.dirty.is_empty(), "{what}");
        assert!(check(&frame.cursor), "{what}: {:?}", frame.cursor);
        assert!(
            rt.take_frame().unwrap().is_none(),
            "{what} is reported once"
        );
    }
}

#[test]
fn a_recreated_surface_gets_the_full_state_and_the_session_keeps_running() {
    let mut rt = runtime(10, 3);
    feed(&mut rt, b"one\r\ntwo");
    rt.take_frame().unwrap();
    assert_eq!(
        screen(&mut rt),
        ["one", "two", ""],
        "snapshot is complete even after frames were consumed"
    );
    feed(&mut rt, b"!");
    assert_eq!(lines(&rt.take_frame().unwrap().unwrap()), ["two!"]);
}

fn size(cols: u16, rows: u16) -> Size {
    Size {
        cols,
        rows,
        cell_width_px: CELL_W,
        cell_height_px: CELL_H,
    }
}

#[test]
fn ui_requests_resize_a_locally_owned_terminal_and_redraw_fully() {
    let mut rt = runtime(10, 3);
    feed(&mut rt, b"abc");
    rt.take_frame().unwrap();
    assert_eq!(rt.request_size(size(20, 6)).unwrap(), SizeOutcome::Applied);
    let frame = rt.take_frame().unwrap().expect("resize dirties the screen");
    assert_eq!((frame.cols, frame.rows, frame.full), (20, 6, true));
    assert_eq!(frame.dirty.len(), 6);
    assert_eq!(lines(&frame)[0], "abc");
}

#[test]
fn transport_size_is_authoritative_and_ui_requests_are_only_intent() {
    let mut rt = runtime(10, 3);
    rt.apply_transport_size(size(24, 8)).unwrap();
    assert_eq!(rt.authority(), SizeAuthority::Transport);
    assert_eq!(
        rt.request_size(size(50, 20)).unwrap(),
        SizeOutcome::Deferred(size(50, 20))
    );
    assert_eq!(rt.size(), size(24, 8), "UI intent must not change the grid");
    assert_eq!(rt.size_intent(), Some(size(50, 20)));
    assert_eq!(rt.snapshot().unwrap().cols, 24);
    rt.release_transport_authority().unwrap();
    assert_eq!(
        (rt.authority(), rt.size()),
        (SizeAuthority::Local, size(50, 20))
    );
}

#[test]
fn invalid_sizes_are_rejected_without_touching_the_grid() {
    let mut rt = runtime(10, 3);
    for bad in [size(0, 5), size(5, 0), size(u16::MAX, u16::MAX)] {
        assert!(rt.request_size(bad).is_err());
        assert!(rt.apply_transport_size(bad).is_err());
    }
    assert_eq!(
        (rt.size(), rt.authority()),
        (size(10, 3), SizeAuthority::Local)
    );
}

/// Pins today's behaviour: libghostty-vt reflows soft-wrapped lines on resize. Mosh's canonical
/// framebuffer needs a top-anchored non-reflowing resize (#1317); when that lands this changes.
#[test]
fn narrowing_reflows_wrapped_lines_today() {
    let mut rt = runtime(10, 4);
    feed(&mut rt, b"0123456789ABCDE");
    rt.request_size(size(5, 4)).unwrap();
    assert_eq!(screen(&mut rt)[..3], ["01234", "56789", "ABCDE"]);
}

#[test]
fn scrollback_is_bounded_and_keeps_the_newest_lines() {
    let mut rt = TerminalRuntime::new(lazysh_terminal_runtime::Config {
        scrollback_bytes: 64 * 1024,
        ..Default::default()
    })
    .unwrap();
    let text: String = (0..20_000).map(|n| format!("line {n}\r\n")).collect();
    feed(&mut rt, text.as_bytes());
    let kept = rt.scrollback_rows().unwrap();
    assert!(
        kept > 0 && kept < 20_000,
        "bounded scrollback kept {kept} rows"
    );
    let all = rt.screen_text().unwrap();
    assert!(all.contains("line 19999") && !all.contains("line 0\n"));
}

#[test]
fn scrolling_the_viewport_shows_history_and_returns_to_the_bottom() {
    let mut rt = runtime(20, 5);
    let text: String = (0..100).map(|n| format!("row {n}\r\n")).collect();
    feed(&mut rt, text.as_bytes());
    let bottom = rt.viewport_text().unwrap();
    rt.scroll_viewport(-10);
    assert_ne!(rt.viewport_text().unwrap(), bottom);
    assert!(
        rt.viewport_text().unwrap().contains("row 8")
            || rt.viewport_text().unwrap().contains("row 9")
    );
    rt.scroll_to_bottom();
    assert_eq!(rt.viewport_text().unwrap(), bottom);
}

#[test]
fn sessions_do_not_share_state() {
    let mut a = runtime(10, 2);
    let mut b = runtime(10, 2);
    feed(&mut a, b"only-a");
    feed(&mut b, b"\x1b[?1049hB");
    assert_eq!(screen(&mut a)[0], "only-a");
    assert!(!a.modes().unwrap().alternate_screen && b.modes().unwrap().alternate_screen);
}

#[test]
fn bell_clipboard_and_directory_events_are_surfaced_once() {
    let mut rt = runtime(20, 3);
    feed(
        &mut rt,
        b"\x07\x1b]52;c;aGVsbG8=\x07\x1b]7;file:///tmp/work\x07",
    );
    let events = rt.take_events();
    assert_eq!(events.bell, 1);
    assert_eq!(events.clipboard_writes.len(), 1);
    assert_eq!(events.pwd_changes.len(), 1);
    assert_eq!(rt.take_events(), Default::default());
}

#[test]
fn ignored_clipboard_and_directory_events_stay_bounded_and_are_counted() {
    let mut rt = runtime(20, 3);
    // 100 OSC 52 and 100 OSC 7 sequences, each in its own chunk, while the host never takes events.
    for n in 0..100 {
        let osc = format!("\x1b]52;c;aGVsbG8=\x07\x1b]7;file:///dir{n}\x07");
        feed(&mut rt, osc.as_bytes());
    }
    let events = rt.take_events();
    assert_eq!(events.clipboard_writes.len(), 8);
    assert_eq!(events.pwd_changes.len(), 8);
    assert_eq!(events.dropped, 92 + 92);
    assert_eq!(
        events.pwd_changes.last().unwrap(),
        b"file:///dir99",
        "the current directory is the newest one"
    );
    assert_eq!(rt.take_events(), Default::default());
}

#[test]
fn viewport_text_supports_screen_inspection() {
    let mut rt = runtime(30, 4);
    feed(&mut rt, "tab one │ tab two\r\n> prompt".as_bytes());
    let text = rt.viewport_text().unwrap();
    assert!(text.starts_with("tab one │ tab two\n> prompt"), "{text:?}");
}

/// The VT worker pool of #1319 moves a session between threads, so a runtime must stay `Send`
/// and keep its state (including the mouse encoder) after the move.
#[test]
fn a_runtime_moves_to_another_thread_and_keeps_running() {
    let mut rt = runtime(10, 2);
    feed(&mut rt, b"\x1b[?1000h\x1b[?1006ha");
    let worker = std::thread::spawn(move || {
        feed(&mut rt, b"b");
        let press = MouseInput {
            action: ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_PRESS,
            button: Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_LEFT),
            mods: 0,
            x: 5.0,
            y: 5.0,
        };
        (screen(&mut rt)[0].clone(), rt.encode_mouse(press).unwrap())
    });
    assert_eq!(
        worker.join().unwrap(),
        ("ab".to_string(), b"\x1b[<0;1;1M".to_vec())
    );
}
