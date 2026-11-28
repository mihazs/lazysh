//! The pinned stock Herdr pane input actor against an owned fake server socket and a fake `herdr` on PATH, never a
//! user server. Replacement of the server process needs a second process and is exercised against the real stock
//! binary in `herdr_pane_input_stock.rs`.
#![cfg(target_os = "linux")]
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    process::Command,
    sync::Notify,
};
#[path = "support/binary.rs"]
mod binary;
#[path = "support/fake_herdr.rs"]
mod fake_herdr;
#[path = "support/pane_input_actor.rs"]
mod pane_input_actor;
use pane_input_actor::Actor;

/// What the fake `pane.send_input` does with a request.
#[derive(Clone, Copy)]
enum Input {
    Accept,
    Refuse,
    CloseWithoutReply,
}
struct Server {
    requests: Arc<Mutex<Vec<Value>>>,
    terminal: Arc<Mutex<String>>,
    end_subscription: Arc<Notify>,
}
impl Server {
    fn start(socket: &Path, input: Input) -> Self {
        let server = Self {
            requests: Arc::default(),
            terminal: Arc::new(Mutex::new("term-one".into())),
            end_subscription: Arc::default(),
        };
        let listener = UnixListener::bind(socket).unwrap();
        let (requests, terminal, end) = (
            server.requests.clone(),
            server.terminal.clone(),
            server.end_subscription.clone(),
        );
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                tokio::spawn(connection(
                    stream,
                    input,
                    requests.clone(),
                    terminal.clone(),
                    end.clone(),
                ));
            }
        });
        server
    }
    fn methods(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request["method"].as_str().unwrap().into())
            .collect()
    }
    fn inputs(&self) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "pane.send_input")
            .cloned()
            .collect()
    }
}
async fn connection(
    stream: UnixStream,
    input: Input,
    requests: Arc<Mutex<Vec<Value>>>,
    terminal: Arc<Mutex<String>>,
    end: Arc<Notify>,
) {
    let mut stream = BufReader::new(stream);
    let mut line = String::new();
    stream.read_line(&mut line).await.unwrap();
    let request: Value = serde_json::from_str(&line).unwrap();
    requests.lock().unwrap().push(request.clone());
    let id = request["id"].clone();
    let reply = match request["method"].as_str().unwrap() {
        "events.subscribe" => {
            let ack = json!({"id":id,"result":{"type":"subscription_started"}});
            stream
                .get_mut()
                .write_all(format!("{ack}\n").as_bytes())
                .await
                .unwrap();
            end.notified().await;
            return;
        }
        "pane.get" if request["params"]["pane_id"] == "w1:p1" => {
            let terminal = terminal.lock().unwrap().clone();
            json!({"id":id,"result":{"type":"pane_info","pane":{
                "pane_id":"w1:p1","terminal_id":terminal,"focused":true,"agent":"claude",
                "cwd":"/work","label":"build","title":"zsh"
            }}})
        }
        "pane.get" => json!({"id":id,"error":{"code":"pane_not_found","message":"x"}}),
        "pane.send_input" => match input {
            Input::Accept => json!({"id":id,"result":{"type":"ok"}}),
            Input::Refuse => json!({"id":id,"error":{"code":"pane_send_failed","message":"x"}}),
            Input::CloseWithoutReply => return,
        },
        other => panic!("unexpected method {other}"),
    };
    stream
        .get_mut()
        .write_all(format!("{reply}\n").as_bytes())
        .await
        .unwrap();
}

fn spawn_actor(directory: &Path, socket: &Path) -> Actor {
    fake_herdr::install(directory, "owned", socket);
    start_actor(directory)
}
fn start_actor(directory: &Path) -> Actor {
    let mut command = Command::new(binary::path());
    command
        .env_clear()
        .env("HOME", directory)
        .env("PATH", directory);
    Actor::spawn(command, "owned")
}
/// The actor's `ready` line. Looking the session up runs the `herdr` stand-in inside a 3 s budget; a starved CI runner can
/// miss it, and the actor then ends before any line. Nothing was pinned or written yet, so the start is tried again.
async fn started(directory: &Path, case: &str) -> Actor {
    for _ in 0..3 {
        let mut actor = start_actor(directory);
        let Some(ready) = actor.line().await else {
            continue;
        };
        assert_eq!(ready["event"], "ready", "{case}");
        // The pin is the process that serves the socket, here this test.
        assert_eq!(ready["pid"], std::process::id(), "{case}");
        return actor;
    }
    panic!("{case}: the actor ended three times before it was ready");
}
async fn ready(case: &str, input: Input) -> (tempfile::TempDir, Server, Actor) {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("owned.sock");
    let server = Server::start(&socket, input);
    fake_herdr::install(directory.path(), "owned", &socket);
    let actor = started(directory.path(), case).await;
    (directory, server, actor)
}
fn send(id: u64, text: &str) -> Value {
    json!({"op":"send","id":id,"pane":"w1:p1","terminal":"term-one","text":text})
}

#[tokio::test]
async fn types_the_text_and_enter_into_the_confirmed_pane_and_nothing_else() {
    let (_directory, server, mut actor) = ready("send", Input::Accept).await;
    let occupant = actor
        .ask(json!({"op":"preflight","id":1,"pane":"w1:p1"}))
        .await;
    assert_eq!(
        occupant,
        json!({"id":1,"outcome":"occupant","pane":{
            "paneId":"w1:p1","terminalId":"term-one","focused":true,"agent":"claude",
            "cwd":"/work","label":"build","title":"zsh"}})
    );
    assert!(server.inputs().is_empty(), "a preflight writes nothing");
    let text = "héllo\nsecond\tline";
    assert_eq!(
        actor.ask(send(2, text)).await,
        json!({"id":2,"outcome":"delivered"})
    );
    assert_eq!(
        actor
            .ask(json!({"op":"escape","id":3,"pane":"w1:p1","terminal":"term-one"}))
            .await,
        json!({"id":3,"outcome":"delivered"})
    );
    // The occupant is read again just before each write; the write is one request to the named pane.
    assert_eq!(
        server.inputs(),
        [
            json!({"id":"lazysh:pane-input:2","method":"pane.send_input","params":{"pane_id":"w1:p1","text":text,"keys":["enter"]}}),
            json!({"id":"lazysh:pane-input:3","method":"pane.send_input","params":{"pane_id":"w1:p1","keys":["esc"]}}),
        ]
    );
    assert_eq!(
        server.methods(),
        [
            "events.subscribe",
            "pane.get",
            "pane.get",
            "pane.send_input",
            "pane.get",
            "pane.send_input"
        ]
    );
    assert!(actor.exit_success().await);
}

#[tokio::test]
async fn refuses_without_writing_what_is_invalid_stale_or_aimed_at_another_occupant() {
    let (_directory, server, mut actor) = ready("refuse", Input::Accept).await;
    let long_enough = "é".repeat(2048);
    let too_long = "é".repeat(2049);
    for (request, reason) in [
        (send(1, ""), "invalid_request"),
        (send(1, &"x".repeat(4097)), "invalid_request"),
        (send(1, &too_long), "invalid_request"),
        (send(1, "tab\u{1b}[31m"), "invalid_request"),
        (send(1, "line\u{2028}break"), "invalid_request"),
        (
            json!({"op":"send","id":1,"pane":"pane-one","terminal":"term-one","text":"x"}),
            "invalid_request",
        ),
        (
            json!({"op":"send","id":1,"pane":"w1:p1","terminal":"","text":"x"}),
            "invalid_request",
        ),
        (send(0, "x"), "stale_operation"),
        (
            json!({"op":"send","id":1,"pane":"w9:p9","terminal":"term-one","text":"x"}),
            "pane_not_found",
        ),
        (
            json!({"op":"send","id":2,"pane":"w1:p1","terminal":"term-two","text":"x"}),
            "occupant_changed",
        ),
        // Spent ids never write again, whatever became of the first attempt.
        (send(2, "again"), "stale_operation"),
        (send(1, "again"), "stale_operation"),
    ] {
        let answer = actor.ask(request.clone()).await;
        assert_eq!(answer["outcome"], "refused", "{request}");
        assert_eq!(answer["reason"], reason, "{request}");
    }
    assert!(server.inputs().is_empty());
    // The largest accepted draft is 4,096 bytes of UTF-8.
    assert_eq!(
        actor.ask(send(3, &long_enough)).await["outcome"],
        "delivered"
    );
    assert_eq!(server.inputs().len(), 1);
    assert!(actor.exit_success().await);
}

#[tokio::test]
async fn a_changed_occupant_between_confirmation_and_send_is_refused() {
    let (_directory, server, mut actor) = ready("occupant", Input::Accept).await;
    assert_eq!(
        actor
            .ask(json!({"op":"preflight","id":1,"pane":"w1:p1"}))
            .await["outcome"],
        "occupant"
    );
    *server.terminal.lock().unwrap() = "term-replaced".into();
    let answer = actor.ask(send(2, "hello")).await;
    assert_eq!(
        answer,
        json!({"id":2,"outcome":"refused","reason":"occupant_changed"})
    );
    assert!(server.inputs().is_empty());
}

#[tokio::test]
async fn a_server_refusal_proves_nothing_was_written_and_the_actor_stays_usable() {
    let (_directory, server, mut actor) = ready("refusal", Input::Refuse).await;
    assert_eq!(
        actor.ask(send(1, "hello")).await,
        json!({"id":1,"outcome":"refused","reason":"pane_send_failed"})
    );
    assert_eq!(
        actor.ask(send(2, "hello")).await["reason"],
        "pane_send_failed"
    );
    assert_eq!(server.inputs().len(), 2, "each id is one attempt");
}

#[tokio::test]
async fn a_lost_acknowledgement_is_uncertain_ends_the_actor_and_is_never_resent() {
    let (_directory, server, mut actor) = ready("uncertain", Input::CloseWithoutReply).await;
    assert_eq!(
        actor.ask(send(1, "hello")).await,
        json!({"id":1,"outcome":"uncertain"})
    );
    assert!(actor.ended_with_failure().await);
    assert_eq!(server.inputs().len(), 1);
}

#[tokio::test]
async fn the_end_of_the_subscription_retires_the_epoch_before_any_further_write() {
    let (_directory, server, mut actor) = ready("subscription", Input::Accept).await;
    server.end_subscription.notify_one();
    assert_eq!(
        actor.line().await.unwrap(),
        json!({"event":"retired","reason":"subscription_closed"})
    );
    assert!(actor.ended_with_failure().await);
    assert!(server.inputs().is_empty());
}

#[tokio::test]
async fn malformed_requests_retire_and_a_missing_server_never_becomes_ready() {
    let (_directory, _server, mut actor) = ready("malformed", Input::Accept).await;
    actor
        .write("{\"op\":\"send\",\"id\":1,\"extra\":true}")
        .await;
    assert_eq!(
        actor.line().await.unwrap(),
        json!({"event":"retired","reason":"malformed_request"})
    );
    assert!(actor.ended_with_failure().await);

    let directory = tempfile::tempdir().unwrap();
    let mut absent = spawn_actor(directory.path(), &directory.path().join("none.sock"));
    assert_eq!(
        absent.line().await.unwrap(),
        json!({"event":"retired","reason":"server_unreachable"})
    );
    assert!(absent.ended_with_failure().await);
}

#[tokio::test]
async fn a_start_the_session_lookup_missed_is_tried_again_before_the_actor_is_judged() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("owned.sock");
    let _server = Server::start(&socket, Input::Accept);
    fake_herdr::install(directory.path(), "owned", &socket);
    // The first `herdr session list` fails the way a starved runner makes it fail; later ones answer.
    std::fs::rename(
        directory.path().join("herdr"),
        directory.path().join("herdr-real"),
    )
    .unwrap();
    let shim = directory.path().join("herdr");
    std::fs::write(
        &shim,
        "#!/bin/sh\nif [ ! -e \"$HOME/failed\" ]; then : > \"$HOME/failed\"; exit 75; fi\nexec \"$HOME/herdr-real\" \"$@\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&shim, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    fake_herdr::wait_runnable(&shim);
    let actor = started(directory.path(), "retry").await;
    assert!(directory.path().join("failed").exists());
    assert!(actor.exit_success().await);
}

#[test]
fn a_stand_in_a_forked_child_still_holds_open_is_waited_for_before_the_actor_runs_it() {
    use std::{
        io::{Read, Write},
        os::unix::process::CommandExt,
    };
    let directory = tempfile::tempdir().unwrap();
    let herdr = directory.path().join("herdr");
    let mut writer = std::fs::File::create(&herdr).unwrap();
    writer.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&herdr, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    // A child forked now inherits the open writer and holds it for 300 ms before it execs.
    let (mut forked, signal) = std::io::pipe().unwrap();
    let lingering = std::thread::spawn(move || {
        let mut child = std::process::Command::new("true");
        // SAFETY: the closure only writes a byte and sleeps, both async-signal-safe.
        unsafe {
            child.pre_exec(move || {
                (&signal).write_all(b"x")?;
                std::thread::sleep(std::time::Duration::from_millis(300));
                Ok(())
            })
        };
        child.status().unwrap();
    });
    forked.read_exact(&mut [0]).unwrap();
    drop(writer);
    let busy = std::process::Command::new(&herdr).status().unwrap_err();
    assert_eq!(busy.kind(), std::io::ErrorKind::ExecutableFileBusy);
    fake_herdr::wait_runnable(&herdr);
    assert!(std::process::Command::new(&herdr).status().is_ok());
    lingering.join().unwrap();
}
