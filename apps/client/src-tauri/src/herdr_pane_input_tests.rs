//! The bridge against a scripted stand-in for the companion process, joined by an in-memory stream. The real companion,
//! Herdr and OpenSSH are exercised by `tmux_jump_fixture::herdr_pane_input`.
use super::*;
use crate::ssh::test_support::{ready_lease, unlocked_access};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::Notify,
};

enum Answer {
    /// Answers with this outcome under the request's id.
    Reply(Value),
    /// The same, once the gate opens.
    Hold(Arc<Notify>, Value),
    /// Ends the stream without an answer: a lost acknowledgement.
    Silence,
    /// An event line the actor volunteers right after the previous answer, without a request.
    Event(Value),
}
struct Host {
    received: Arc<Mutex<Vec<Value>>>,
    ended: Arc<AtomicBool>,
}
impl Host {
    fn requests(&self) -> Vec<Value> {
        self.received.lock().unwrap().clone()
    }
    async fn ended(&self) -> bool {
        for _ in 0..200 {
            if self.ended.load(Ordering::SeqCst) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }
}
const READY: &str = "{\"event\":\"ready\"}";
/// The stream a stand-in companion talks on: `greeting`, then one answer per request.
fn stand_in(greeting: &'static str, answers: Vec<Answer>) -> (tokio::io::DuplexStream, Host) {
    let (near, far) = tokio::io::duplex(64 * 1024);
    let received = Arc::new(Mutex::new(Vec::new()));
    let ended = Arc::new(AtomicBool::new(false));
    let (log, done) = (received.clone(), ended.clone());
    tokio::spawn(async move {
        let (read, mut write) = tokio::io::split(far);
        write
            .write_all(format!("{greeting}\n").as_bytes())
            .await
            .unwrap();
        let mut requests = BufReader::new(read).lines();
        let mut answers = answers.into_iter().peekable();
        loop {
            while let Some(Answer::Event(event)) =
                answers.next_if(|answer| matches!(answer, Answer::Event(_)))
            {
                write
                    .write_all(format!("{event}\n").as_bytes())
                    .await
                    .unwrap();
            }
            let Ok(Some(line)) = requests.next_line().await else {
                break;
            };
            let request: Value = serde_json::from_str(&line).unwrap();
            log.lock().unwrap().push(request.clone());
            let (mut outcome, gate) = match answers.next() {
                Some(Answer::Reply(outcome)) => (outcome, None),
                Some(Answer::Hold(gate, outcome)) => (outcome, Some(gate)),
                _ => break,
            };
            if let Some(gate) = gate {
                gate.notified().await;
            }
            outcome["id"] = request["id"].clone();
            if write
                .write_all(format!("{outcome}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
        done.store(true, Ordering::SeqCst);
    });
    (near, Host { received, ended })
}
/// A command that ends right after it said `greeting` (or without a word when that is empty).
fn closed_host(greeting: &'static str) -> tokio::io::DuplexStream {
    let (near, mut far) = tokio::io::duplex(1024);
    tokio::spawn(async move {
        if !greeting.is_empty() {
            far.write_all(format!("{greeting}\n").as_bytes())
                .await
                .unwrap();
        }
    });
    near
}

fn source(name: &str) -> Source {
    serde_json::from_value(
        json!({"agent":"claude","path":format!("/owned/{name}.jsonl"),"view":"records","inlineImages":false}),
    )
    .unwrap()
}
fn pane_json(terminal: &str) -> Value {
    json!({"paneId":"w1:p1","terminalId":terminal,"focused":false,"agent":"claude","cwd":"/work","label":"main","title":"t"})
}
fn occupant(terminal: &str) -> Answer {
    Answer::Reply(json!({"outcome":"occupant","pane":pane_json(terminal)}))
}
fn delivered() -> Answer {
    Answer::Reply(json!({"outcome":"delivered"}))
}
fn outcome(kind: &str, reason: &str) -> Answer {
    Answer::Reply(json!({"outcome":kind,"reason":reason}))
}

struct Harness {
    slot: Slot,
    lease: AccessLease,
    cancel: watch::Sender<bool>,
}
impl Harness {
    fn new() -> Self {
        Self::with(
            crate::app_lock::AccessState::disabled()
                .lease(None)
                .unwrap(),
        )
    }
    fn with(lease: AccessLease) -> Self {
        Self {
            slot: Slot::default(),
            lease,
            cancel: watch::channel(false).0,
        }
    }
    async fn actor(&self, stream: tokio::io::DuplexStream) -> Result<Actor> {
        Actor::start(stream, self.lease.clone(), self.cancel.subscribe()).await
    }
    async fn act(&self, action: Value, stream: Option<tokio::io::DuplexStream>) -> Result<Reply> {
        let action: Action = serde_json::from_value(action).unwrap();
        action.validate()?;
        let actor = match stream {
            Some(stream) => Some(self.actor(stream).await?),
            None => None,
        };
        let mut slot = self.slot.0.try_lock().map_err(|_| busy())?;
        drive(&mut slot, &self.lease, action, |_| async move {
            actor.ok_or_else(invalid)
        })
        .await
    }
    async fn prepare(&self, name: &str, stream: tokio::io::DuplexStream) -> Result<Reply> {
        let action =
            json!({"kind":"prepare","herdrSession":"main","pane":"w1:p1","source":source(name)});
        self.act(action, Some(stream)).await
    }
    /// Prepare and confirm one destination; returns the receipt.
    async fn confirmed(&self, name: &str, stream: tokio::io::DuplexStream) -> String {
        let prepared = self.prepare(name, stream).await.unwrap();
        let Reply::Prepared { candidate, .. } = prepared else {
            panic!("{prepared:?}")
        };
        match self
            .act(
                json!({"kind":"confirm","candidate":candidate,"source":source(name)}),
                None,
            )
            .await
            .unwrap()
        {
            Reply::Bound {
                receipt,
                next_operation: 1,
                ..
            } => receipt,
            other => panic!("{other:?}"),
        }
    }
    async fn input(
        &self,
        receipt: &str,
        name: &str,
        operation: u32,
        input: Value,
    ) -> Result<Reply> {
        self.act(
            json!({"kind":"input","receipt":receipt,"source":source(name),"operation":operation,"input":input}),
            None,
        )
        .await
    }
    /// An input that finds no confirmation to type under: refused as stale, with nothing sent.
    async fn stale(&self, receipt: &str, name: &str, operation: u32) {
        let result = self.input(receipt, name, operation, send("x")).await;
        assert_eq!(kind(result), "herdr_pane_input_stale");
    }
    fn bound(&self) -> bool {
        self.slot.0.try_lock().unwrap().is_some()
    }
}
fn send(text: &str) -> Value {
    json!({"kind":"send","text":text})
}
fn kind<T: std::fmt::Debug>(result: Result<T>) -> &'static str {
    result.unwrap_err().kind()
}

#[tokio::test]
async fn a_confirmed_destination_takes_each_operation_once_and_never_a_repeat() {
    let (stream, host) = stand_in(
        READY,
        vec![occupant("t1"), occupant("t1"), delivered(), delivered()],
    );
    let h = Harness::new();
    let receipt = h.confirmed("a", stream).await;
    assert_eq!(
        h.input(&receipt, "a", 1, send("héllo\nwörld"))
            .await
            .unwrap(),
        Reply::Delivered { next_operation: 2 }
    );
    assert_eq!(
        h.input(&receipt, "a", 2, json!({"kind":"request_stop"}))
            .await
            .unwrap(),
        Reply::Delivered { next_operation: 3 }
    );
    // A repeated or skipped operation never reaches the host, and it retires the confirmation.
    h.stale(&receipt, "a", 2).await;
    assert!(!h.bound());
    h.stale(&receipt, "a", 3).await;
    assert_eq!(
        host.requests(),
        [
            json!({"op":"preflight","id":1,"pane":"w1:p1"}),
            json!({"op":"preflight","id":2,"pane":"w1:p1"}),
            json!({"op":"send","id":3,"pane":"w1:p1","terminal":"t1","text":"héllo\nwörld"}),
            json!({"op":"escape","id":4,"pane":"w1:p1","terminal":"t1"}),
        ]
    );
    // Retiring the confirmation ended the actor.
    assert!(host.ended().await);
}

#[tokio::test]
async fn only_text_and_escape_are_pane_input_and_they_keep_the_draft_bounds() {
    let action = |input: Value| {
        serde_json::from_value::<Action>(
            json!({"kind":"input","receipt":"22345678-1234-4234-8234-123456789abc",
            "source":source("a"),"operation":1,"input":input}),
        )
        .unwrap()
    };
    assert!(action(send("ok")).validate().is_ok());
    assert!(action(json!({"kind":"request_stop"})).validate().is_ok());
    assert!(action(send(&"é".repeat(2048))).validate().is_ok());
    for bad in [
        json!({"kind":"send_long","text":"x".repeat(5000)}),
        json!({"kind":"pick","rows":-1,"enter":false,"seen":["Pick one","1. Yes","Enter to confirm"]}),
        json!({"kind":"dismiss","seen":["Pick one","1. Yes","Enter to confirm"]}),
        json!({"kind":"cycle_mode"}),
        json!({"kind":"submit","of":3}),
        json!({"kind":"select","option":2,"of":3}),
        send(""),
        send(&"x".repeat(4097)),
        send("a\u{1b}[31m"),
    ] {
        assert!(action(bad).validate().is_err());
    }
    let prepare = |pane: &str, session: &str| {
        serde_json::from_value::<Action>(
            json!({"kind":"prepare","herdrSession":session,"pane":pane,"source":source("a")}),
        )
        .unwrap()
    };
    assert!(prepare("w1:p1", "main").validate().is_ok());
    for (pane, session) in [
        ("w1", "main"),
        ("p1", "main"),
        ("w1:p1", ""),
        ("w1:p1", "-x"),
        ("w1:p1", "a\nb"),
    ] {
        assert!(
            prepare(pane, session).validate().is_err(),
            "{pane} {session:?}"
        );
    }
    for bad in [
        json!({"kind":"prepare","herdrSession":"a","pane":"w1:p1","source":source("a"),"extra":1}),
        json!({"kind":"input","receipt":"not-a-token","source":source("a"),"operation":1,"input":send("x")}),
        json!({"kind":"confirm","candidate":"22345678-1234-4234-8234-123456789abc","source":source("a"),"operation":1}),
    ] {
        let valid =
            serde_json::from_value::<Action>(bad).is_ok_and(|action| action.validate().is_ok());
        assert!(!valid);
    }
    let zero = serde_json::from_value::<Action>(
        json!({"kind":"input","receipt":"22345678-1234-4234-8234-123456789abc",
        "source":source("a"),"operation":0,"input":send("x")}),
    )
    .unwrap();
    assert!(zero.validate().is_err());
}

#[tokio::test]
async fn a_refusal_keeps_the_confirmation_and_the_operation_number() {
    let (stream, host) = stand_in(
        READY,
        vec![
            occupant("t1"),
            occupant("t1"),
            outcome("refused", "server_refused"),
            delivered(),
        ],
    );
    let h = Harness::new();
    let receipt = h.confirmed("a", stream).await;
    let refusal = h.input(&receipt, "a", 1, send("first")).await.unwrap_err();
    assert_eq!(
        (refusal.kind(), refusal.message()),
        ("herdr_pane_input_refused", "server_refused")
    );
    assert!(h.bound());
    // Operation 1 is still the next one: nothing was written for it.
    assert_eq!(
        h.input(&receipt, "a", 1, send("second")).await.unwrap(),
        Reply::Delivered { next_operation: 2 }
    );
    assert_eq!(host.requests().len(), 4);
}

#[tokio::test]
async fn a_pane_that_changed_occupant_or_is_gone_retires_the_confirmation() {
    for reason in ["occupant_changed", "pane_not_found"] {
        let (stream, _host) = stand_in(
            READY,
            vec![occupant("t1"), occupant("t1"), outcome("refused", reason)],
        );
        let h = Harness::new();
        let receipt = h.confirmed("a", stream).await;
        assert_eq!(
            kind(h.input(&receipt, "a", 1, send("x")).await),
            "herdr_pane_input_stale",
            "{reason}"
        );
        assert!(!h.bound());
    }
    // Between the user's look and the confirmation another terminal took the pane.
    let (stream, host) = stand_in(READY, vec![occupant("t1"), occupant("t2")]);
    let h = Harness::new();
    let prepared = h.prepare("a", stream).await.unwrap();
    let Reply::Prepared {
        candidate,
        occupant,
    } = prepared
    else {
        panic!()
    };
    assert_eq!(occupant.terminal_id, "t1");
    let confirmed = h
        .act(
            json!({"kind":"confirm","candidate":candidate,"source":source("a")}),
            None,
        )
        .await;
    assert_eq!(kind(confirmed), "herdr_pane_input_stale");
    assert!(!h.bound());
    assert!(host.ended().await);
}

#[tokio::test]
async fn a_lost_acknowledgement_is_uncertain_ends_the_actor_and_is_never_resent() {
    let (stream, host) = stand_in(
        READY,
        vec![occupant("t1"), occupant("t1"), Answer::Silence, delivered()],
    );
    let h = Harness::new();
    let receipt = h.confirmed("a", stream).await;
    assert_eq!(
        kind(h.input(&receipt, "a", 1, send("once")).await),
        "herdr_pane_input_uncertain"
    );
    assert!(!h.bound());
    // The same operation, or the next one, finds no confirmation and writes nothing.
    h.stale(&receipt, "a", 1).await;
    h.stale(&receipt, "a", 2).await;
    assert_eq!(host.requests().len(), 3);
}

#[tokio::test]
async fn a_retired_server_epoch_retires_the_confirmation_with_its_reason() {
    for (reason, expected) in [
        ("server_replaced", "herdr_pane_input_retired"),
        ("peer_pidfd_unsupported", "herdr_pane_input_unsupported"),
    ] {
        let (stream, host) = stand_in(
            READY,
            vec![occupant("t1"), occupant("t1"), outcome("retired", reason)],
        );
        let h = Harness::new();
        let receipt = h.confirmed("a", stream).await;
        let error = h.input(&receipt, "a", 1, send("x")).await.unwrap_err();
        assert_eq!(error.kind(), expected);
        assert!(!h.bound());
        assert!(host.ended().await);
    }
}

#[tokio::test]
async fn an_actor_that_retires_while_idle_ends_the_destination_before_any_request() {
    let (stream, host) = stand_in(
        READY,
        vec![
            occupant("t1"),
            occupant("t1"),
            // The pinned server went away while nothing was in flight.
            Answer::Event(json!({"event":"retired","reason":"server_exited"})),
        ],
    );
    let h = Harness::new();
    let receipt = h.confirmed("a", stream).await;
    assert!(host.ended().await);
    let error = h.input(&receipt, "a", 1, send("x")).await.unwrap_err();
    assert_eq!(error.kind(), "herdr_pane_input_retired");
    assert!(!h.bound());
    assert_eq!(host.requests().len(), 2);
}

#[tokio::test]
async fn a_stale_source_a_revoked_lease_or_another_receipt_never_reach_the_host() {
    // Source A, then B, then A again: only the destination confirmed for the source of the input takes it.
    let (stream, host) = stand_in(READY, vec![occupant("t1"), occupant("t1")]);
    let h = Harness::new();
    let receipt = h.confirmed("a", stream).await;
    h.stale(&receipt, "b", 1).await;
    assert!(!h.bound());
    h.stale(&receipt, "a", 1).await;
    assert_eq!(host.requests().len(), 2);

    // A receipt that is not the current one leaves the current confirmation alone.
    let (stream, host) = host_with_one_delivery();
    let h = Harness::new();
    let receipt = h.confirmed("a", stream).await;
    let other = uuid::Uuid::new_v4().to_string();
    h.stale(&other, "a", 1).await;
    assert!(h.bound());
    assert!(h.input(&receipt, "a", 1, send("x")).await.is_ok());
    assert_eq!(host.requests().len(), 3);

    // Source A, then B, then A again, each confirmed anew: only the last destination takes input, never an earlier receipt
    // that happens to be for the same source.
    let (first_stream, _first) = host_with_one_delivery();
    let (second_stream, _second) = host_with_one_delivery();
    let (third_stream, third_host) = host_with_one_delivery();
    let h = Harness::new();
    let first = h.confirmed("a", first_stream).await;
    let second = h.confirmed("b", second_stream).await;
    let third = h.confirmed("a", third_stream).await;
    h.stale(&first, "a", 1).await;
    h.stale(&second, "b", 1).await;
    assert!(h.bound());
    assert!(h.input(&third, "a", 1, send("x")).await.is_ok());
    assert_eq!(third_host.requests().len(), 3);

    // The lease the destination was confirmed under ended: not even a request is written.
    let authority = unlocked_access();
    let h = Harness::with(ready_lease(&authority));
    let (stream, host) = host_with_one_delivery();
    let receipt = h.confirmed("a", stream).await;
    authority.lock().unwrap();
    h.stale(&receipt, "a", 1).await;
    assert_eq!(host.requests().len(), 2);
}
fn host_with_one_delivery() -> (tokio::io::DuplexStream, Host) {
    stand_in(READY, vec![occupant("t1"), occupant("t1"), delivered()])
}

#[tokio::test]
async fn a_caller_that_goes_away_mid_request_loses_the_destination_and_the_late_answer() {
    let gate = Arc::new(Notify::new());
    let (stream, host) = stand_in(
        READY,
        vec![
            occupant("t1"),
            occupant("t1"),
            Answer::Hold(gate.clone(), json!({"outcome":"delivered"})),
            delivered(),
        ],
    );
    let h = Arc::new(Harness::new());
    let receipt = h.confirmed("a", stream).await;
    let running = {
        let (h, receipt) = (h.clone(), receipt.clone());
        tokio::spawn(async move { h.input(&receipt, "a", 1, send("held")).await })
    };
    for _ in 0..200 {
        if host.requests().len() == 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(host.requests().len(), 3);
    running.abort();
    let _ = running.await;
    gate.notify_one();
    assert!(!h.bound());
    // Operation 1 is spent and the late answer goes nowhere; nothing more is ever written.
    h.stale(&receipt, "a", 1).await;
    h.stale(&receipt, "a", 2).await;
    assert!(host.ended().await);
    assert_eq!(host.requests().len(), 3);
}

#[tokio::test]
async fn a_host_that_cannot_run_the_actor_is_one_unsupported_state() {
    for (greeting, expected) in [
        (COMPANION_REQUIRED, "herdr_pane_input_unsupported"),
        (
            "{\"event\":\"retired\",\"reason\":\"peer_pidfd_unsupported\"}",
            "herdr_pane_input_unsupported",
        ),
        // The command ended without a word: another operating system, or a companion without it.
        ("", "herdr_pane_input_unsupported"),
        (
            "{\"event\":\"retired\",\"reason\":\"server_unreachable\"}",
            "herdr_pane_input_retired",
        ),
        ("garbage", "herdr_pane_input_retired"),
    ] {
        let h = Harness::new();
        let result = h.actor(closed_host(greeting)).await.map(|_| ());
        assert_eq!(result.unwrap_err().kind(), expected, "{greeting}");
    }
    // A pane that Herdr does not know is a refusal of the read, not an unsupported host.
    let (stream, _host) = stand_in(READY, vec![outcome("refused", "pane_not_found")]);
    let h = Harness::new();
    let prepared = h.prepare("a", stream).await;
    let error = prepared.unwrap_err();
    assert_eq!(
        (error.kind(), error.message()),
        ("herdr_pane_input_refused", "pane_not_found")
    );
    assert!(!h.bound());
}

#[tokio::test]
async fn the_end_of_the_session_ends_the_actor_and_a_second_caller_is_busy() {
    let (stream, host) = stand_in(READY, vec![occupant("t1"), occupant("t1")]);
    let h = Harness::new();
    let _receipt = h.confirmed("a", stream).await;
    let held = h.slot.0.try_lock().unwrap();
    assert_eq!(
        kind(
            h.act(
                json!({"kind":"release","receipt":uuid::Uuid::new_v4().to_string()}),
                None
            )
            .await
        ),
        "herdr_pane_input_busy"
    );
    drop(held);
    h.cancel.send_replace(true);
    assert!(host.ended().await);
    // A session that is already over starts nothing.
    let (stream, _host) = stand_in(READY, vec![]);
    assert_eq!(
        kind(h.actor(stream).await.map(|_| ())),
        "herdr_pane_input_retired"
    );
}

#[tokio::test]
async fn release_ends_the_actor_only_for_the_current_receipt() {
    let (stream, host) = stand_in(READY, vec![occupant("t1"), occupant("t1")]);
    let h = Harness::new();
    let receipt = h.confirmed("a", stream).await;
    let other = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        h.act(json!({"kind":"release","receipt":other}), None)
            .await
            .unwrap(),
        Reply::Released
    );
    assert!(h.bound());
    assert_eq!(
        h.act(json!({"kind":"release","receipt":receipt}), None)
            .await
            .unwrap(),
        Reply::Released
    );
    assert!(!h.bound());
    assert!(host.ended().await);
}

#[test]
fn replies_and_errors_leave_as_the_renderer_expects() {
    let occupant: Occupant = serde_json::from_value(pane_json("t1")).unwrap();
    assert_eq!(
        serde_json::to_value(Reply::Bound {
            receipt: "r".into(),
            occupant,
            next_operation: 1
        })
        .unwrap(),
        json!({"kind":"bound","receipt":"r","occupant":pane_json("t1"),"nextOperation":1})
    );
    assert_eq!(
        serde_json::to_value(Reply::Delivered { next_operation: 2 }).unwrap(),
        json!({"kind":"delivered","nextOperation":2})
    );
    assert_eq!(
        serde_json::to_value(Reply::Released).unwrap(),
        json!({"kind":"released"})
    );
    // The actor's occupant is exact: an unknown field or another pane is no occupant.
    let mut extra = pane_json("t1");
    extra["extra"] = json!(1);
    assert!(serde_json::from_value::<Occupant>(extra).is_err());
    let moved: Occupant = serde_json::from_value(pane_json("t1")).unwrap();
    assert!(moved.valid("w1:p1") && !moved.valid("w1:p2"));
    assert!(Outcome::parse(&json!({"id":2,"outcome":"delivered"}), 3).is_none());
    assert!(Outcome::parse(&json!({"id":3,"outcome":"refused"}), 3).is_none());
    assert!(Outcome::parse(&json!({"id":3,"outcome":"surprise"}), 3).is_none());
}
