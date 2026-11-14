//! The transport-independent session service: bytes in through `Session::feed` from threads that
//! honour a credit window, replies and input out through a `PtyWriter`, lifecycle and budget.

mod support;

use lazysh_terminal_runtime::{
    ffi, Config, Hooks, Hub, HubConfig, HubError, MouseInput, Offer, Origin, Session, SessionError,
    TerminalRuntime,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::*};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use support::*;

fn hub_with_hello() -> (Hub, Fixture) {
    let hub = Hub::new(HubConfig::default());
    let f = session(&hub, "a", config(40, 10, 1 << 20));
    f.send(b"hello");
    f.settle(5);
    (hub, f)
}

fn assert_closed(session: &Session) {
    assert!(matches!(
        session.feed(b"x".to_vec()),
        Err(SessionError::Closed)
    ));
    assert!(matches!(session.stats(), Err(SessionError::Closed)));
    assert!(matches!(session.send_paste("x"), Err(SessionError::Closed)));
}

fn reference_text(config: Config, bytes: &[u8]) -> String {
    let mut runtime = TerminalRuntime::new(config).unwrap();
    for chunk in bytes.chunks(CHUNK) {
        assert_eq!(runtime.offer(chunk.to_vec()), Offer::Accepted);
        runtime.pump(usize::MAX);
    }
    runtime.screen_text().unwrap()
}

#[test]
fn concurrent_sessions_receive_every_byte_in_order_under_a_bounded_window() {
    let hub = Hub::new(HubConfig {
        workers: 2,
        ..HubConfig::default()
    });
    let config = config(80, 24, 16 * 1024 * 1024);
    let workload = numbered_lines(40_000); // about 2 MiB per session
    let expected = reference_text(config, &workload);
    let fixtures: Vec<_> = (0..6)
        .map(|n| Arc::new(session(&hub, &format!("s{n}"), config)))
        .collect();
    let producers: Vec<_> = fixtures
        .iter()
        .map(|fixture| {
            let (fixture, workload) = (fixture.clone(), workload.clone());
            std::thread::spawn(move || {
                let mut peak = 0;
                for chunk in workload.chunks(CHUNK) {
                    fixture.send(chunk);
                    peak = peak.max(fixture.session.stats().unwrap().queued);
                }
                peak
            })
        })
        .collect();
    for producer in producers {
        let peak = producer.join().unwrap();
        assert!(
            peak <= WINDOW,
            "queued {peak} bytes over a {WINDOW} byte window"
        );
    }
    for fixture in &fixtures {
        fixture.settle(workload.len() as u64);
        assert_eq!(fixture.credited.load(SeqCst), workload.len() as u64);
        let text = fixture
            .session
            .with(|rt| rt.screen_text())
            .unwrap()
            .unwrap();
        assert_eq!(
            text, expected,
            "history differs: a byte was lost or reordered"
        );
    }
}

#[test]
fn no_wakeup_is_lost_when_chunks_arrive_as_the_worker_goes_idle() {
    // Many tiny chunks from several producers keep racing the worker's "queue is empty" decision.
    let hub = Hub::new(HubConfig {
        workers: 1,
        ..HubConfig::default()
    });
    let f = Arc::new(session(&hub, "a", config(80, 24, 1 << 20)));
    let total = Arc::new(AtomicU64::new(0));
    let producers: Vec<_> = (0..4)
        .map(|n| {
            let (f, total) = (f.clone(), total.clone());
            std::thread::spawn(move || {
                for i in 0..20_000usize {
                    let chunk = vec![b'a' + n as u8; 1 + i % 7];
                    total.fetch_add(chunk.len() as u64, SeqCst);
                    f.window.acquire(chunk.len());
                    assert_eq!(f.session.feed(chunk).unwrap(), Offer::Accepted);
                    if i % 97 == 0 {
                        std::thread::yield_now();
                    }
                }
            })
        })
        .collect();
    for producer in producers {
        producer.join().unwrap();
    }
    f.settle(total.load(SeqCst));
    assert_eq!(f.credited.load(SeqCst), total.load(SeqCst));
    assert_eq!(f.session.stats().unwrap().queued, 0);
}

#[test]
fn a_panicking_host_hook_costs_only_its_own_session() {
    let hub = Hub::new(HubConfig {
        workers: 1,
        ..HubConfig::default()
    });
    let doomed = hub
        .create(
            "doomed",
            config(10, 2, 1 << 20),
            Hooks {
                credit: Box::new(|_| panic!("host bug")),
                ..quiet_hooks()
            },
        )
        .unwrap();
    let healthy = session(&hub, "healthy", config(10, 2, 1 << 20));
    doomed.feed(b"x".to_vec()).unwrap();
    wait_until(|| hub.get("doomed").is_none());
    assert_closed(&doomed);
    healthy.send(b"still alive");
    healthy.settle(11);
    assert_eq!(hub.live(), 1);
}

#[test]
fn credit_is_returned_only_after_the_bytes_were_processed() {
    let hub = Hub::new(HubConfig::default());
    let session = Arc::new(OnceLock::<Session>::new());
    let credited = Arc::new(AtomicU64::new(0));
    let early = Arc::new(AtomicBool::new(false));
    let hooks = Hooks {
        writer: Recorder::new(),
        credit: {
            let (session, credited, early) = (session.clone(), credited.clone(), early.clone());
            Box::new(move |bytes| {
                let total = credited.fetch_add(bytes as u64, SeqCst) + bytes as u64;
                let processed = session.get().unwrap().stats().unwrap().processed;
                early.fetch_or(processed < total, SeqCst);
            })
        },
        changed: None,
    };
    session
        .set(hub.create("a", config(80, 24, 1 << 20), hooks).unwrap())
        .ok();
    let session = session.get().unwrap();
    let data = numbered_lines(5_000);
    for chunk in data.chunks(CHUNK) {
        // Credit is not modelled here: the ingress capacity alone is the bound.
        while session.feed(chunk.to_vec()).unwrap() != Offer::Accepted {
            std::thread::yield_now();
        }
    }
    wait_until(|| credited.load(SeqCst) == data.len() as u64);
    assert!(
        !early.load(SeqCst),
        "a credit was returned before its bytes were parsed"
    );
}

#[test]
fn a_chunk_over_the_window_is_handed_back_and_nothing_is_lost() {
    let hub = Hub::new(HubConfig {
        workers: 1,
        ..HubConfig::default()
    });
    // Park the only worker inside session A's credit hook so B's queue cannot drain.
    let parked = Arc::new((Mutex::new(false), Condvar::new()));
    let entered = Arc::new(AtomicBool::new(false));
    let blocker = hub
        .create(
            "a",
            config(10, 2, 1 << 20),
            Hooks {
                writer: Recorder::new(),
                credit: {
                    let (parked, entered) = (parked.clone(), entered.clone());
                    Box::new(move |_| {
                        entered.store(true, SeqCst);
                        let mut open = parked.0.lock().unwrap();
                        while !*open {
                            open = parked.1.wait(open).unwrap();
                        }
                    })
                },
                changed: None,
            },
        )
        .unwrap();
    blocker.feed(b"x".to_vec()).unwrap();
    wait_until(|| entered.load(SeqCst));
    let small = Config {
        ingress_bytes: 1000,
        ..config(40, 3, 1 << 20)
    };
    let b = session(&hub, "b", small);
    let first = vec![b'a'; 600];
    let second = vec![b'b'; 600];
    assert_eq!(b.session.feed(first).unwrap(), Offer::Accepted);
    assert_eq!(
        b.session.feed(second.clone()).unwrap(),
        Offer::Full(second.clone()),
        "the rejected chunk comes back byte for byte"
    );
    assert_eq!(
        b.session.feed(vec![0; 1001]).unwrap(),
        Offer::TooLarge(vec![0; 1001])
    );
    assert_eq!(b.session.stats().unwrap().queued, 600);
    *parked.0.lock().unwrap() = true;
    parked.1.notify_all();
    b.settle(600);
    assert_eq!(
        b.session.feed(second).unwrap(),
        Offer::Accepted,
        "credit returned, the retry fits"
    );
    b.settle(1200);
    assert_eq!(b.credited.load(SeqCst), 1200);
}

#[test]
fn replies_leave_in_order_tagged_as_replies_and_are_dropped_while_input_is_gated() {
    let hub = Hub::new(HubConfig::default());
    let f = session(&hub, "a", config(40, 10, 1 << 20));
    let query = b"\x1b[3;5H\x1b[6n";
    f.send(query);
    f.settle(query.len() as u64);
    wait_until(|| !f.writer.sent().is_empty());
    assert_eq!(f.writer.sent(), [(Origin::Reply, b"\x1b[3;5R".to_vec())]);

    f.writer.open.store(false, Release);
    f.send(b"\x1b[6n");
    f.settle((query.len() + 4) as u64);
    wait_until(|| f.session.stats().unwrap().replies_dropped > 0);
    f.writer.open.store(true, Release);
    f.send(b"\x1b[5n");
    f.settle((query.len() + 8) as u64);
    wait_until(|| f.writer.sent().len() == 2);
    let sent = f.writer.sent();
    assert_eq!(
        sent[1],
        (Origin::Reply, b"\x1b[0n".to_vec()),
        "the reply produced while gated is never delivered late"
    );
    assert_eq!(
        f.session.stats().unwrap().replies_dropped,
        6,
        "the refused reply was counted"
    );
}

#[test]
fn user_input_is_encoded_from_terminal_modes_and_gated_by_the_writer() {
    let hub = Hub::new(HubConfig::default());
    let f = session(&hub, "a", config(40, 10, 1 << 20));
    let up = key(ffi::GhosttyKey_GHOSTTY_KEY_ARROW_UP, 0, None);
    assert_eq!(f.session.send_key(&up).unwrap(), 3);
    assert_eq!(
        f.session.send_focus(true).unwrap(),
        0,
        "focus reports are off until the program asks"
    );
    assert_eq!(f.session.send_paste("a\nb").unwrap(), 3);

    let modes = b"\x1b[?1h\x1b[?1004h\x1b[?2004h\x1b[?1000h\x1b[?1006h";
    f.send(modes);
    f.settle(modes.len() as u64);
    assert_eq!(f.session.send_key(&up).unwrap(), 3);
    assert_eq!(f.session.send_focus(true).unwrap(), 3);
    assert_eq!(f.session.send_focus(false).unwrap(), 3);
    assert_eq!(f.session.send_paste("hi").unwrap(), 14);
    let click = MouseInput {
        action: ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_PRESS,
        button: Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_LEFT),
        mods: 0,
        x: 55.0,
        y: 30.0,
    };
    f.session.send_mouse(click).unwrap();

    let sent = f.writer.sent();
    assert!(sent.iter().all(|(origin, _)| *origin == Origin::User));
    let bytes: Vec<&[u8]> = sent.iter().map(|(_, bytes)| bytes.as_slice()).collect();
    assert_eq!(
        bytes,
        [
            &b"\x1b[A"[..],
            b"a\rb",
            b"\x1bOA",
            b"\x1b[I",
            b"\x1b[O",
            b"\x1b[200~hi\x1b[201~",
            b"\x1b[<0;6;2M",
        ]
    );

    f.writer.open.store(false, Release);
    assert!(matches!(
        f.session.send_key(&up),
        Err(SessionError::Refused)
    ));
    assert_eq!(f.session.stats().unwrap().input_refused, 1);
    assert_eq!(f.writer.sent().len(), 7, "a refused key reaches nobody");
}

/// #1043: the reader scrolled into history, tapped the toolbar Enter and the agent's reply stayed out of
/// view. Typing and pasting return to the live screen (unless the preference is off); a refused key,
/// a mouse report and a focus report do not move the reader.
#[test]
fn typing_returns_a_scrolled_back_reader_to_the_live_screen_unless_it_was_refused() {
    let hub = Hub::new(HubConfig::default());
    let (f, wakeups) = session_watched(&hub, "a", config(40, 5, 1 << 20));
    f.session.attach().unwrap();
    let text = numbered_lines(100);
    f.send(&text);
    f.settle(text.len() as u64);
    let live = f.session.with(|rt| rt.viewport_text().unwrap()).unwrap();
    f.session.take_frame().unwrap();
    let scrolled_back = || {
        f.session.with(|rt| rt.scroll_viewport(-20)).unwrap();
        // The view has drawn the history the reader scrolled to.
        f.session.take_frame().unwrap().expect("history redraw");
        assert_ne!(
            f.session.with(|rt| rt.viewport_text().unwrap()).unwrap(),
            live
        );
    };
    let viewport = || f.session.with(|rt| rt.viewport_text().unwrap()).unwrap();
    let enter = key(ffi::GhosttyKey_GHOSTTY_KEY_ENTER, 0, None);

    scrolled_back();
    f.writer.open.store(false, Release);
    assert!(f.session.send_key(&enter).is_err());
    assert_ne!(viewport(), live, "a refused key moves nothing");
    f.writer.open.store(true, Release);
    f.session.send_focus(true).unwrap();
    assert_ne!(viewport(), live, "a focus report is not typing");

    let woken = wakeups.load(SeqCst);
    assert_eq!(f.session.send_key(&enter).unwrap(), 1);
    assert_eq!(viewport(), live, "toolbar Enter returns to the live screen");
    assert_eq!(
        wakeups.load(SeqCst),
        woken + 1,
        "the attached view is told to redraw"
    );
    assert_eq!(f.session.send_key(&enter).unwrap(), 1);
    assert_eq!(
        wakeups.load(SeqCst),
        woken + 1,
        "already live: nothing moved"
    );
    let redraw = f.session.take_frame().unwrap().expect("the redraw");
    assert!(lines(&redraw)
        .iter()
        .any(|row| row.contains("line 0000099")));

    scrolled_back();
    assert_eq!(f.session.send_paste("x").unwrap(), 1);
    assert_eq!(viewport(), live, "pasting returns to the live screen too");
    f.session.take_frame().unwrap().expect("the redraw");

    f.session.set_scroll_on_user_input(false);
    scrolled_back();
    assert_eq!(f.session.send_key(&enter).unwrap(), 1);
    assert_ne!(
        viewport(),
        live,
        "the preference keeps the reader in history"
    );
}

#[test]
fn a_view_can_detach_and_reattach_without_losing_screen_or_scrollback() {
    let hub = Hub::new(HubConfig::default());
    let changes = Arc::new(AtomicU64::new(0));
    let writer = Recorder::new();
    let session = hub
        .create(
            "a",
            config(30, 5, 1 << 20),
            Hooks {
                writer,
                credit: Box::new(|_| {}),
                changed: Some({
                    let changes = changes.clone();
                    Box::new(move || {
                        changes.fetch_add(1, SeqCst);
                    })
                }),
            },
        )
        .unwrap();
    let feed = |bytes: &[u8], total: u64| {
        assert_eq!(session.feed(bytes.to_vec()).unwrap(), Offer::Accepted);
        wait_until(|| session.stats().unwrap().processed == total);
    };
    feed(&numbered_lines(100), numbered_lines(100).len() as u64);
    assert_eq!(changes.load(SeqCst), 0, "a detached session wakes nobody");

    let first = session.attach().unwrap();
    assert!(first.full);
    let before = lines(&first);
    let history = session.with(|rt| rt.screen_text()).unwrap().unwrap();
    let rows = session.with(|rt| rt.scrollback_rows()).unwrap().unwrap();
    assert!(rows > 90);

    session.detach();
    let second = session.attach().unwrap();
    assert_eq!(lines(&second), before, "re-attach redraws the same screen");
    assert_eq!(
        session.with(|rt| rt.screen_text()).unwrap().unwrap(),
        history
    );
    assert_eq!(
        session.with(|rt| rt.scrollback_rows()).unwrap().unwrap(),
        rows
    );

    let more = numbered_lines(1);
    feed(&more, (numbered_lines(100).len() + more.len()) as u64);
    wait_until(|| changes.load(SeqCst) > 0);
}

#[test]
fn the_budget_clamps_scrollback_refuses_when_exhausted_and_is_returned_on_close() {
    let hub = Hub::new(HubConfig {
        scrollback_budget: 1 << 20,
        ..HubConfig::default()
    });
    let a = session(&hub, "a", config(80, 24, 600 * 1024));
    let b = session(&hub, "b", config(80, 24, 600 * 1024));
    assert_eq!(a.session.scrollback_granted(), 600 * 1024);
    assert_eq!(
        b.session.scrollback_granted(),
        (1 << 20) - 600 * 1024,
        "clamped to what is left"
    );
    assert_eq!(hub.scrollback_reserved(), 1 << 20);
    let refused = hub.create("c", config(80, 24, 600 * 1024), quiet_hooks());
    assert!(matches!(
        refused,
        Err(HubError::Budget { available: 0, .. })
    ));
    assert!(matches!(
        hub.create("a", config(80, 24, 1024), quiet_hooks()),
        Err(HubError::Duplicate(_))
    ));
    a.session.close();
    assert_eq!(hub.scrollback_reserved(), (1 << 20) - 600 * 1024);
    let c = session(&hub, "c", config(80, 24, 600 * 1024));
    assert_eq!(c.session.scrollback_granted(), 600 * 1024);
}

#[test]
fn one_session_cannot_reserve_more_than_its_cap_whatever_it_asks_for() {
    let hub = Hub::new(HubConfig {
        scrollback_budget: 8 << 20,
        session_scrollback_max: 3 << 20,
        ..HubConfig::default()
    });
    let greedy = session(&hub, "greedy", config(80, 24, usize::MAX));
    assert_eq!(greedy.session.scrollback_granted(), 3 << 20);
    let second = session(&hub, "second", config(80, 24, 8 << 20));
    let third = session(&hub, "third", config(80, 24, 8 << 20));
    assert_eq!(second.session.scrollback_granted(), 3 << 20);
    assert_eq!(
        third.session.scrollback_granted(),
        2 << 20,
        "the rest of the budget is still there for the next session"
    );
    assert_eq!(hub.scrollback_reserved(), 8 << 20);
}

#[test]
fn closing_frees_the_session_and_later_use_reports_closed() {
    let (hub, f) = hub_with_hello();
    assert_eq!(hub.live(), 1);
    f.session.close();
    f.session.close();
    assert_eq!(hub.live(), 0);
    assert!(hub.get("a").is_none());
    assert_closed(&f.session);
    // The id is free again and the new session starts from an empty screen.
    let again = session(&hub, "a", config(40, 10, 1 << 20));
    assert_eq!(
        again
            .session
            .with(|rt| rt.viewport_text())
            .unwrap()
            .unwrap()
            .trim(),
        ""
    );
}

#[test]
fn dropping_the_hub_closes_its_sessions_and_stops_its_workers() {
    let (hub, f) = hub_with_hello();
    drop(hub);
    assert_closed(&f.session);
}

/// Floods nine detached sessions on a single worker, feeds the attached session one chunk, and
/// counts the bytes the worker parsed for the floods between the feed and that session's screen
/// update. Before the attached-first queue every other session's turn came first (eight turns of
/// one 16 KiB slice here); now it is at most the turn in progress.
#[test]
fn an_attached_session_is_served_ahead_of_detached_floods_on_its_worker() {
    let hub = Hub::new(HubConfig {
        workers: 1,
        ..HubConfig::default()
    });
    let stop = Arc::new(AtomicBool::new(false));
    let floods: Vec<_> = (0..9)
        .map(|n| Arc::new(session(&hub, &format!("flood{n}"), config(80, 24, 1 << 20))))
        .collect();
    let flooded = {
        let counters: Vec<_> = floods.iter().map(|f| f.credited.clone()).collect();
        Arc::new(move || counters.iter().map(|c| c.load(SeqCst)).sum::<u64>())
    };
    let producers: Vec<_> = floods
        .iter()
        .map(|flood| {
            let (flood, stop, data) = (flood.clone(), stop.clone(), plain(1 << 20));
            std::thread::spawn(move || {
                while !stop.load(SeqCst) {
                    data.chunks(CHUNK).for_each(|chunk| flood.send(chunk));
                }
            })
        })
        .collect();
    wait_until(|| {
        floods
            .iter()
            .all(|flood| flood.session.stats().unwrap().queued > 0)
    });

    let updated_at = Arc::new(AtomicU64::new(u64::MAX));
    let probe = hub
        .create(
            "probe",
            config(80, 24, 1 << 20),
            Hooks {
                writer: Recorder::new(),
                credit: Box::new(|_| {}),
                changed: Some({
                    let (flooded, updated_at) = (flooded.clone(), updated_at.clone());
                    Box::new(move || updated_at.store(flooded(), SeqCst))
                }),
            },
        )
        .unwrap();
    probe.attach().unwrap();
    probe.feed(b"echo".to_vec()).unwrap();
    // Read after the feed returns: a pause here can only hide turns, never invent them.
    let before = flooded();
    wait_until(|| updated_at.load(SeqCst) != u64::MAX);
    let parsed_meanwhile = updated_at.load(SeqCst).saturating_sub(before);

    stop.store(true, SeqCst);
    producers.into_iter().for_each(|t| t.join().unwrap());
    let slice = HubConfig::default().pump_slice as u64;
    assert!(
        parsed_meanwhile <= 4 * slice,
        "the worker parsed {parsed_meanwhile} bytes for detached sessions before the attached one's screen update (slice {slice})"
    );
}

/// Priority must not starve: an attached session that is refilled the moment its credit returns
/// is never idle, yet a detached one on the same worker still finishes (it gets a turn after every
/// few of the attached session's).
#[test]
fn a_detached_session_keeps_parsing_while_the_attached_one_never_idles() {
    let hub = Hub::new(HubConfig {
        workers: 1,
        ..HubConfig::default()
    });
    let stop = Arc::new(AtomicBool::new(false));
    let active_handle: Arc<OnceLock<Session>> = Arc::default();
    let chunk = plain(CHUNK);
    let active = hub
        .create(
            "active",
            config(80, 24, 1 << 20),
            Hooks {
                writer: Recorder::new(),
                credit: {
                    let (stop, active_handle, chunk) =
                        (stop.clone(), active_handle.clone(), chunk.clone());
                    Box::new(move |_| {
                        if let (false, Some(active)) = (stop.load(SeqCst), active_handle.get()) {
                            let _ = active.feed(chunk.clone());
                        }
                    })
                },
                changed: None,
            },
        )
        .unwrap();
    assert!(active_handle.set(active.clone()).is_ok());
    active.attach().unwrap();
    let background = session(&hub, "background", config(80, 24, 1 << 20));
    active.feed(chunk).unwrap();
    background.send(&plain(WINDOW));
    background.settle(WINDOW as u64);
    stop.store(true, SeqCst);
}
