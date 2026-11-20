//! The control plane (`TerminalRuntime::control_*` and `take_control_events`, #1321) against what headless xterm.js
//! 5.5.0 answers for the same bytes and scrolls: `fixtures/control-plane.json`, written by
//! `apps/client/src/xterm/controlPlaneFixture.test.ts` (`UPDATE_CONTROL_PLANE=1` rewrites it) and replayed
//! here. The adapter's synchronous readers (modes, viewport, cursor, rows) are served from exactly these answers.

mod replay;
mod support;

use lazysh_terminal_runtime::{
    control_window, ControlEvent, Doorbell, Hooks, Hub, HubConfig, Offer, ScrollAction, Session,
    CONTROL_WINDOW_DEFAULT, CONTROL_WINDOW_MAX, MAX_READ_ROWS,
};
use replay::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use support::*;

#[test]
fn every_answer_matches_what_xterm_js_gives() {
    for case in fixture_cases("control-plane") {
        let id = case["id"].as_str().unwrap();
        let window = case["window"].as_u64().unwrap() as usize;
        let mut rt = replay(&case);
        let mut answers = vec![rt.control_snapshot(window).unwrap()];
        for step in case["steps"].as_array().unwrap() {
            let action: ScrollAction = serde_json::from_value(step.clone()).unwrap();
            answers.push(rt.control_scroll(action, window).unwrap());
        }
        let expected = case["snapshots"].as_array().unwrap();
        assert_eq!(answers.len(), expected.len(), "{id}");
        for (at, (answer, expected)) in answers.iter().zip(expected).enumerate() {
            assert_eq!(
                &serde_json::to_value(answer).unwrap(),
                expected,
                "{id}, answer {at}"
            );
        }
    }
}

fn numbered_rows(rt: &mut lazysh_terminal_runtime::TerminalRuntime, count: usize) {
    let text: Vec<_> = (0..count).map(|i| format!("row {i}")).collect();
    feed(rt, text.join("\r\n").as_bytes());
}

#[test]
fn reading_the_cursor_of_a_scrolled_reader_leaves_them_where_they_were() {
    let mut rt = runtime(20, 5);
    numbered_rows(&mut rt, 40);
    rt.control_scroll(ScrollAction::ToRow { row: 12 }, 8)
        .unwrap();
    let before = rt.viewport().unwrap();
    let answer = rt.control_snapshot(8).unwrap();
    assert_eq!(rt.viewport().unwrap(), before);
    assert_eq!(answer.state.viewport, before);
    assert!(!answer.state.viewport.following);
}

#[test]
fn a_window_is_bounded_and_always_holds_the_viewport() {
    let mut rt = runtime(20, 5);
    numbered_rows(&mut rt, 200);
    for action in [
        ScrollAction::ToBottom,
        ScrollAction::ToTop,
        ScrollAction::ToRow { row: 97 },
        ScrollAction::Pages { delta: -1 },
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
    // A window smaller than the screen still covers it, and a huge one is cut to what a text read may return.
    assert_eq!(rt.control_snapshot(0).unwrap().window.rows.len(), 5);
    let huge = rt.control_snapshot(usize::MAX).unwrap();
    assert!(huge.window.rows.len() <= MAX_READ_ROWS);
    // What a reader asks for becomes a bounded count before it reaches the core.
    assert_eq!(control_window(None), CONTROL_WINDOW_DEFAULT);
    assert_eq!(control_window(Some(0)), 1);
    assert_eq!(control_window(Some(40)), 40);
    assert_eq!(control_window(Some(usize::MAX)), CONTROL_WINDOW_MAX);
}

#[test]
fn a_resize_answers_with_the_size_the_core_has() {
    let mut rt = runtime(20, 5);
    numbered_rows(&mut rt, 10);
    let answer = rt.control_resize(30, 8, 16).unwrap();
    assert_eq!((answer.state.columns, answer.state.rows), (30, 8));
    assert_eq!(answer.state.viewport.rows, 8);
    for refused in [(0, 8), (30, 0), (u16::MAX, u16::MAX)] {
        assert!(rt.control_resize(refused.0, refused.1, 16).is_err());
    }
    // A transport that owns the size (Mosh) keeps it: the request is intent, and the answer says so.
    rt.apply_transport_size(lazysh_terminal_runtime::Size::new(25, 6))
        .unwrap();
    let answer = rt.control_resize(40, 10, 16).unwrap();
    assert_eq!((answer.state.columns, answer.state.rows), (25, 6));
}

#[test]
fn what_the_program_reports_comes_out_once_decoded_and_bounded() {
    let mut rt = runtime(20, 5);
    assert!(rt.take_control_events().is_empty());
    let reports = concat!(
        "\x07\x1b]0;build\x07\x1b]2;done \u{2713}\x1b\\",
        "\x1b]7;file://host/tmp/a%20b\x07\x1b]7;http://host/no\x07\x1b]7;nonsense\x07",
        "\x1b]52;c;aGVsbG8=\x07\x1b]52;c;?\x07\x1b]52;c;/w==\x07",
    );
    feed(&mut rt, reports.as_bytes());
    let title = |title: &str| ControlEvent::Title {
        title: title.into(),
    };
    assert_eq!(
        rt.take_control_events(),
        [
            title("done \u{2713}"),
            ControlEvent::Bell,
            ControlEvent::Cwd { path: "/tmp/a b".into() },
            ControlEvent::Clipboard { text: "hello".into() },
        ],
        "the latest title, then bells, directories and clipboard writes; a query, an escape and invalid UTF-8 are not offered"
    );
    assert!(rt.take_control_events().is_empty());
    // A flood of bells is one burst, and what the control plane does not report stays for `take_events`.
    feed(&mut rt, &b"\x07".repeat(500));
    assert_eq!(rt.take_control_events(), vec![ControlEvent::Bell; 8]);
    rt.control_resize(30, 8, 8).unwrap();
    assert_eq!(rt.take_events().geometry.map(|g| g.size.cols), Some(30));
}

#[test]
fn a_clipboard_write_is_offered_only_up_to_what_the_xterm_backend_accepts() {
    use base64::Engine;
    let mut rt = runtime(20, 5);
    for (size, offered) in [(64 * 1024, true), (64 * 1024 + 1, false)] {
        let text = "a".repeat(size);
        let payload = base64::engine::general_purpose::STANDARD.encode(&text);
        feed(&mut rt, format!("\x1b]52;c;{payload}\x07").as_bytes());
        let events = rt.take_control_events();
        assert_eq!(events.len(), usize::from(offered), "{size} bytes");
        if offered {
            assert_eq!(events, [ControlEvent::Clipboard { text }]);
        }
    }
}

#[test]
fn the_events_are_the_adapters_event_shapes() {
    let events = [
        (ControlEvent::Changed, json!({"type": "changed"})),
        (ControlEvent::Bell, json!({"type": "bell"})),
        (
            ControlEvent::Title { title: "t".into() },
            json!({"type": "title", "title": "t"}),
        ),
        (
            ControlEvent::Cwd { path: "/a".into() },
            json!({"type": "cwd", "path": "/a"}),
        ),
        (
            ControlEvent::Clipboard { text: "x".into() },
            json!({"type": "clipboard", "text": "x"}),
        ),
    ];
    for (event, wire) in events {
        assert_eq!(serde_json::to_value(&event).unwrap(), wire);
    }
}

/// A session whose output rings a doorbell that records what it sends.
struct Ringing {
    _hub: Hub,
    session: Session,
    bell: Arc<Doorbell>,
    sent: Arc<Mutex<Vec<ControlEvent>>>,
    /// Whether the host lets events leave (the app is not locked).
    open: Arc<AtomicBool>,
    /// Calls of the `changed` hook that ran to the end.
    hooked: Arc<AtomicU64>,
    active: bool,
    total: u64,
}

impl Ringing {
    /// Active, like the app's cores: it has been opened to be looked at.
    fn new() -> Self {
        let hub = Hub::new(HubConfig::default());
        let sent = Arc::new(Mutex::new(Vec::new()));
        let log = sent.clone();
        let open = Arc::new(AtomicBool::new(true));
        let permitted = open.clone();
        let bell = Arc::new(Doorbell::new(
            move |event| log.lock().unwrap().push(event),
            move || permitted.load(SeqCst),
        ));
        let hooked = Arc::new(AtomicU64::new(0));
        let (ring, done) = (bell.hook(), hooked.clone());
        let hooks = Hooks {
            changed: Some(Box::new(move || {
                ring();
                done.fetch_add(1, SeqCst);
            })),
            ..quiet_hooks()
        };
        let session = hub
            .create("doorbell", config(40, 5, 1 << 20), hooks)
            .unwrap();
        bell.bind(session.clone());
        session.set_active(true);
        Self {
            _hub: hub,
            session,
            bell,
            sent,
            open,
            hooked,
            active: true,
            total: 0,
        }
    }

    fn set_active(&mut self, active: bool) {
        self.session.set_active(active);
        self.active = active;
    }

    /// Feed `chunks` transport chunks of `text`, one at a time, each parsed (and, while active, announced) before
    /// the next: the order the worker runs them in is the order of the test.
    fn print(&mut self, text: &str, chunks: usize) {
        for _ in 0..chunks {
            let hooked = self.hooked.load(SeqCst);
            let offer = self.session.feed(text.as_bytes().to_vec()).unwrap();
            assert_eq!(offer, Offer::Accepted);
            self.total += text.len() as u64;
            wait_until(|| self.session.stats().unwrap().processed == self.total);
            if self.active {
                wait_until(|| self.hooked.load(SeqCst) > hooked);
            }
        }
    }

    /// What the doorbell sent since the last call.
    fn take(&self) -> Vec<ControlEvent> {
        std::mem::take(&mut *self.sent.lock().unwrap())
    }
}

#[test]
fn the_doorbell_rings_once_per_read_however_much_output_arrives() {
    let mut ringing = Ringing::new();
    ringing.print("line\r\n", 500);
    assert_eq!(
        ringing.take(),
        [ControlEvent::Changed],
        "500 chunks, one message"
    );
    ringing.bell.read();
    ringing.print("more\r\n", 50);
    assert_eq!(
        ringing.take(),
        [ControlEvent::Changed],
        "a read rearms it, and 50 chunks make one"
    );
}

#[test]
fn reports_leave_ahead_of_the_change_that_carries_them_and_none_waits_for_more_output() {
    let mut ringing = Ringing::new();
    ringing.bell.read();
    ringing.print("\x07\x1b]0;t\x07x\r\n", 1);
    let title = ControlEvent::Title { title: "t".into() };
    assert_eq!(
        ringing.take(),
        [title, ControlEvent::Bell, ControlEvent::Changed]
    );
    // A report that lands while a ring is unanswered waits for the read, which sends it without ringing again.
    ringing.print("\x07", 1);
    assert_eq!(ringing.take(), []);
    ringing.bell.read();
    assert_eq!(ringing.take(), [ControlEvent::Bell]);
    // Nothing is taken twice.
    ringing.bell.read();
    assert_eq!(ringing.take(), []);
}

#[test]
fn an_inactive_session_wakes_nobody_and_rings_once_to_catch_up_when_it_is_looked_at_again() {
    let mut ringing = Ringing::new();
    ringing.set_active(false);
    ringing.bell.read();
    ringing.print("hidden\x07\r\n", 20);
    assert_eq!(ringing.take(), [], "an inactive session wakes nobody");
    let text = ringing
        .session
        .with(|rt| rt.viewport_text().unwrap())
        .unwrap();
    assert!(text.contains("hidden"), "it kept parsing");
    ringing.set_active(true);
    ringing.bell.wake();
    let mut catch_up = vec![ControlEvent::Bell; 8];
    catch_up.push(ControlEvent::Changed);
    assert_eq!(ringing.take(), catch_up, "what it missed, once");
}

#[test]
fn nothing_leaves_while_the_host_refuses_and_nothing_is_lost_by_it() {
    let mut ringing = Ringing::new();
    ringing.open.store(false, SeqCst);
    ringing.print("\x07locked\r\n", 3);
    assert_eq!(
        ringing.take(),
        [],
        "nothing is sent while the app is locked"
    );
    ringing.open.store(true, SeqCst);
    // The refused ring was not counted as answered, so the next change rings and brings what was held.
    ringing.print("x", 1);
    assert_eq!(
        ringing.take(),
        [
            ControlEvent::Bell,
            ControlEvent::Bell,
            ControlEvent::Bell,
            ControlEvent::Changed
        ]
    );
}

/// What a snapshot must bring back: the visible text, the cursor, the modes, and (through a second snapshot) the
/// styles and the mouse encoding.
fn restored(program: &[u8]) -> lazysh_terminal_runtime::TerminalRuntime {
    let mut rt = runtime(20, 5);
    feed(&mut rt, program);
    let snapshot = rt.ansi_snapshot().unwrap();
    let mut fresh = runtime(20, 5);
    feed(&mut fresh, snapshot.as_bytes());
    assert_eq!(fresh.viewport_text().unwrap(), rt.viewport_text().unwrap());
    let (state, expected) = (
        fresh.control_snapshot(5).unwrap().state,
        rt.control_snapshot(5).unwrap().state,
    );
    assert_eq!(
        (state.cursor, state.modes),
        (expected.cursor, expected.modes)
    );
    assert_eq!(fresh.modes().unwrap(), rt.modes().unwrap());
    assert_eq!(fresh.ansi_snapshot().unwrap(), snapshot);
    fresh
}

#[test]
fn an_ansi_snapshot_rebuilds_the_visible_screen_cursor_and_modes_without_the_scrollback() {
    // Forty rows on five: history above a full screen, a coloured word, the cursor left mid-row and hidden,
    // bracketed paste, application cursor keys, focus reports and drag tracking in the SGR encoding.
    let mut program: Vec<u8> = (0..40)
        .flat_map(|i| format!("row {i}\r\n").into_bytes())
        .collect();
    program.extend(b"\x1b[1;31mred\x1b[0m plain\x1b[3;4H\x1b[?25l\x1b[?2004h\x1b[?1h\x1b[?1004h\x1b[?1002h\x1b[?1006h");
    let mut fresh = restored(&program);
    let state = fresh.control_snapshot(5).unwrap().state;
    assert_eq!((state.cursor.x, state.cursor.y), (3, 2));
    assert!(state.modes.bracketed_paste && state.modes.application_cursor_keys);
    assert_eq!(
        state.modes.mouse_tracking,
        lazysh_terminal_runtime::MouseTracking::Drag
    );
    assert_eq!(
        fresh.scrollback_rows().unwrap(),
        0,
        "the history is not carried over"
    );

    // A full-screen program: the alternate screen, its text and its cursor, and plain click tracking.
    let mut fresh =
        restored(b"shell\r\n\x1b[?1049h\x1b[2;3Heditor\x1b[5;1H-- INSERT --\x1b[4;7H\x1b[?1000h");
    let state = fresh.control_snapshot(5).unwrap().state;
    assert!(state.modes.alternate_screen && !state.modes.bracketed_paste);
    assert_eq!((state.cursor.x, state.cursor.y), (6, 3));
    // Leaving it shows a blank shell screen: the screen the program was not on is not carried over.
    feed(&mut fresh, b"\x1b[?1049l");
    assert_eq!(fresh.viewport_text().unwrap().trim(), "");
}
