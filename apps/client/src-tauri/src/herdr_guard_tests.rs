use super::*;
use serde_json::json;

#[test]
fn mosh_guard_startup_requires_the_exact_positive_fd_capability() {
    assert!(startup_fd_capability(
        r#"{"schemaVersion":1,"startupFd":true}"#
    ));
    for rejected in [
        "",
        "guard_invalid",
        r#"{"schemaVersion":1,"startupFd":false}"#,
        r#"{"schemaVersion":2,"startupFd":true}"#,
        r#"{"schemaVersion":1,"startupFd":1}"#,
        r#"{"schemaVersion":1,"startupFd":true,"ticket":"private"}"#,
        r#"{"schemaVersion":1,"startupFd":true,"startupFd":false}"#,
    ] {
        assert!(!startup_fd_capability(rejected));
    }
}

#[cfg(unix)]
#[test]
fn guard_commands_run_the_exact_guarded_argv_on_the_chosen_herdr_and_never_the_other() {
    use crate::herdr_backend::{
        sandbox::{assert_both_backends, Sandbox},
        HerdrBackend::{Managed, System},
    };
    assert_both_backends(&[
        command("owned", false),
        command("owned", true),
        attach_command("owned"),
    ]);
    let sandbox = Sandbox::new(true);
    for (backend, name) in [(System, "system"), (Managed, "managed")] {
        let receipt = attach_receipt(backend, "own'ed $(x)").unwrap();
        assert_eq!(
            sandbox.run_wrapped(&receipt),
            (
                format!("{name} --session own'ed $(x) --guarded-attach --startup-fd 3\n"),
                true
            )
        );
    }
}

fn private_frame() -> Vec<u8> {
    encode_frame(json!({"boot":"ab".repeat(32),"ticket":"cd".repeat(32)}))
}
fn encode_frame(body: serde_json::Value) -> Vec<u8> {
    let body = serde_json::to_vec(&body).unwrap();
    let mut bytes = PREFIX.to_vec();
    bytes.extend_from_slice(format!("{:08x}:", body.len()).as_bytes());
    bytes.extend_from_slice(&body);
    bytes.push(0x1f);
    bytes
}
fn source(selector: &str) -> Source {
    serde_json::from_value(json!({"agent":"hermes","path":"/owned/{literal}<source>","view":"records","inlineImages":false,"transcriptSessionId":selector})).unwrap()
}

fn target() -> Target {
    serde_json::from_value(json!({"workspace":"w1","tab":"w1:t2","pane":"w1:p3","terminal":"term4","runtime_generation":u64::MAX,"viewport":{"x":0,"y":1,"width":80,"height":24}})).unwrap()
}

#[test]
fn observed_reply_names_the_attached_server_beside_the_exact_destination() {
    let value = serde_json::to_value(Reply::Observed {
        server: "original".into(),
        destination: target().public(),
    })
    .unwrap();
    assert_eq!(value["kind"], "observed");
    assert_eq!(value["server"], "original");
    assert_eq!(value["destination"]["pane"], "w1:p3");
    assert_eq!(
        value["destination"]["runtimeGeneration"],
        u64::MAX.to_string()
    );
}

#[test]
fn observe_reply_requires_a_strict_target_and_preserves_generation() {
    let value = json!({"id":"guard","result":{"type":"guard_observed","guard":{"target":{
        "workspace":"w1","tab":"w1:t2","pane":"w1:p3","terminal":"term4",
        "runtime_generation":u64::MAX,"viewport":{"x":0,"y":1,"width":80,"height":24}
    }}}});
    let bytes = serde_json::to_vec(&value).unwrap();
    let WireResult::GuardObserved { guard } = response(Some(0), &bytes, b"").unwrap() else {
        panic!("expected observation")
    };
    assert!(guard.target.valid());
    assert_eq!(
        guard.target.public().runtime_generation,
        u64::MAX.to_string()
    );
    let mut invalid = value;
    invalid["result"]["guard"]["extra"] = json!(true);
    assert!(matches!(
        response(Some(0), &serde_json::to_vec(&invalid).unwrap(), b""),
        Err(Fault::Protocol)
    ));
}

#[test]
fn history_scroll_rejects_invalid_generation_coordinates_and_lines() {
    let destination = serde_json::to_value(target().public()).unwrap();
    let action = |destination, x, y, lines| json!({"kind":"scroll_history","destination":destination,"x":x,"y":y,"lines":lines});
    for (x, y, lines) in [(0, 1, 1), (79, 24, -200), (1, 2, 200)] {
        let parsed: Action =
            serde_json::from_value(action(destination.clone(), x, y, lines)).unwrap();
        assert!(parsed.validate().is_ok());
    }
    for (x, y, lines) in [
        (0, 0, 1),
        (80, 1, 1),
        (0, 25, 1),
        (0, 1, 0),
        (0, 1, 201),
        (0, 1, -201),
    ] {
        let parsed: Action =
            serde_json::from_value(action(destination.clone(), x, y, lines)).unwrap();
        assert!(matches!(parsed.validate(), Err(Fault::Invalid)));
    }
    for generation in ["0", "01", "+1", "18446744073709551616"] {
        let mut bad = destination.clone();
        bad["runtimeGeneration"] = json!(generation);
        let parsed: Action = serde_json::from_value(action(bad, 0, 1, 1)).unwrap();
        assert!(matches!(parsed.validate(), Err(Fault::Invalid)));
    }
    let mut bad = action(destination, 0, 1, 1);
    bad["extra"] = json!(true);
    assert!(serde_json::from_value::<Action>(bad).is_err());
    assert!(serde_json::from_value::<Action>(json!({"kind":"observe","extra":true})).is_err());
}

#[test]
fn only_a_complete_first_frame_can_supply_private_authority() {
    let mut bytes = private_frame();
    for split in 0..bytes.len() {
        assert!(frame(&bytes[..split]).unwrap().is_none());
    }
    let length = bytes.len();
    bytes.extend_from_slice(b"public rendered terminal bytes");
    let (ticket, used) = frame(&bytes).unwrap().unwrap();
    assert_eq!(used, length);
    assert!(ticket.boot.0 == "ab".repeat(32) && ticket.ticket.0 == "cd".repeat(32));
    assert_eq!(&bytes[used..], b"public rendered terminal bytes");
    let mut spoof = b"untrusted output before frame".to_vec();
    spoof.extend_from_slice(&bytes);
    assert!(matches!(frame(&spoof), Err(Fault::Protocol)));
}

#[test]
fn malformed_and_excessive_startup_fails_without_marker_search() {
    let valid = private_frame();
    let mut uppercase = valid.clone();
    uppercase[PREFIX.len()] = b'A';
    let mut oversized = PREFIX.to_vec();
    oversized.extend_from_slice(b"00000201:");
    let mut terminator = valid.clone();
    *terminator.last_mut().unwrap() = b'\n';
    for malformed in [uppercase, oversized, terminator] {
        assert!(matches!(frame(&malformed), Err(Fault::Protocol)));
    }
    for body in [
        json!({"boot":null,"ticket":"ab".repeat(32)}),
        json!({"boot":"AB".repeat(32),"ticket":"ab".repeat(32)}),
        json!({"boot":"ab".repeat(32),"ticket":"cd".repeat(32),"extra":true}),
    ] {
        assert!(matches!(frame(&encode_frame(body)), Err(Fault::Protocol)));
    }
}

#[test]
fn exact_fixed_probe_reply_is_distinct_from_legacy_or_forged_output() {
    let failure = br#"{"id":"guard","error":{"code":"guard_invalid","message":"guard_invalid"}}"#;
    assert!(matches!(
        response(Some(1), b"", failure),
        Err(Fault::Invalid)
    ));
    for (status, stdout, stderr) in [
        (Some(0), failure.as_slice(), b"".as_slice()),
        (Some(1), b"unexpected stdout".as_slice(), failure.as_slice()),
        (Some(2), b"".as_slice(), b"herdr api commands: schema snapshot".as_slice()),
        (Some(1), b"".as_slice(), br#"{"id":"other","error":{"code":"guard_invalid","message":"guard_invalid"}}"#.as_slice()),
        (Some(1), b"".as_slice(), br#"{"id":"guard","error":{"code":"guard_invalid","message":"private diagnostic"}}"#.as_slice()),
        (Some(1), b"".as_slice(), br#"{"id":"guard","result":null,"error":{"code":"guard_invalid","message":"guard_invalid"}}"#.as_slice()),
    ] {
        assert!(matches!(response(status, stdout, stderr), Err(Fault::Protocol)));
    }
}

#[test]
fn shared_source_preserves_selector_and_literal_data_without_public_credentials() {
    let original = source("A{literal}<selector>");
    original.validate().unwrap();
    let digest = source_hash(&original).unwrap();
    assert!(lazysh_common::valid_sha256(&digest));
    assert_ne!(digest, source_hash(&source("B")).unwrap());
    assert_eq!(
        digest,
        source_hash(&source("A{literal}<selector>")).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&original).unwrap()["path"],
        "/owned/{literal}<source>"
    );
    let secret = "ef".repeat(32);
    let target = target();
    assert!(target.valid());
    let reply = serde_json::to_value(Reply::Prepared {
        candidate: uuid::Uuid::new_v4().to_string(),
        destination: target.public(),
    })
    .unwrap();
    assert_eq!(
        reply["destination"]["runtimeGeneration"],
        u64::MAX.to_string()
    );
    assert!(!reply.to_string().contains(&secret));
    assert!(!reply.to_string().contains("boot") && !reply.to_string().contains("ownership"));
}

#[tokio::test]
async fn dropped_waiter_does_not_release_an_owned_queued_permit() {
    let (binding, mut queue, lease) = queued_binding();
    let (cancel, mut cancellation) = watch::channel(false);
    let worker = binding.clone();
    let original = lease.clone();
    let first = tokio::spawn(async move {
        worker
            .call(&original, &mut cancel.subscribe(), Action::Status)
            .await
    });
    let work = queue.recv().await.unwrap();
    first.abort();
    let _ = first.await;
    assert!(work.reply.is_closed());
    assert!(binding.busy.load(Ordering::SeqCst));
    let second = binding
        .call(&lease, &mut cancellation, Action::Status)
        .await
        .err()
        .unwrap();
    assert_eq!(second.kind(), "herdr_chat_busy");
    drop(work);
    assert!(!binding.busy.load(Ordering::SeqCst));
}

#[test]
fn startup_rejects_a_large_chunk_before_extending_and_preserves_coalesced_credit() {
    let mut buffer = private_frame();
    let previous = buffer.clone();
    assert_eq!(
        extend_startup(&mut buffer, &vec![b'x'; STARTUP_LIMIT + 1]),
        Err(Fault::Protocol)
    );
    assert_eq!(buffer, previous);
    let mut coalesced = private_frame();
    coalesced.extend(vec![b'r'; ssh::OUTPUT_WINDOW as usize]);
    let mut received = Vec::new();
    extend_startup(&mut received, &coalesced).unwrap();
    let (_, used) = frame(&received).unwrap().unwrap();
    assert_eq!(&received[used..], vec![b'r'; ssh::OUTPUT_WINDOW as usize]);
    let partial = private_frame();
    let mut held = partial[..partial.len() - 1].to_vec();
    let snapshot = held.clone();
    assert_eq!(
        extend_startup(&mut held, &vec![b'x'; STARTUP_LIMIT]),
        Err(Fault::Protocol)
    );
    assert_eq!(held, snapshot);
}

#[tokio::test]
async fn revoked_original_binding_lease_cannot_dispatch_through_a_fresh_call_lease() {
    use crate::ssh::test_support::{ready_lease, unlocked_access};
    let original = unlocked_access();
    let owner = ready_lease(&original);
    let fixture = ssh::guard_admission_fixture(owner.clone()).await;
    let call_lease = crate::app_lock::AccessState::disabled()
        .lease(None)
        .unwrap();
    let source = source("A");
    let token = uuid::Uuid::new_v4().to_string();
    let secret = Secret::try_from("ab".repeat(32)).unwrap();
    let mut control = Control {
        startup: Startup {
            boot: secret.clone(),
            ownership: secret.clone(),
            name: "original".into(),
        },
        route: Route::Ssh(fixture.session.handle.clone()),
        preparation: 1,
        bound: Some(Bound {
            token: token.clone(),
            remote: secret,
            target: target(),
            source: source.clone(),
            owner,
            next: 1,
            confirmed: true,
        }),
    };
    assert!(!control.affects_binding(&Action::Observe {}));
    assert!(!control.affects_binding(&Action::ScrollHistory {
        destination: target().public(),
        x: 0,
        y: 1,
        lines: 1,
    }));
    assert!(control
        .bound
        .as_ref()
        .is_some_and(|bound| bound.token == token && bound.confirmed));
    fixture.hold();
    let mut cancel = fixture.session.cancel.subscribe();
    let worker = tokio::spawn(async move {
        control
            .action(
                Action::Input {
                    receipt: token,
                    source,
                    operation: 1,
                    input: Input::RequestStop,
                },
                &call_lease,
                &mut cancel,
                &mut None,
            )
            .await
    });
    fixture.opened().await;
    original.lock().unwrap();
    fixture.release().await;
    assert!(tokio::time::timeout(Duration::from_secs(10), worker)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    fixture.closed().await;
    assert_eq!(
        fixture.private_execs(),
        0,
        "revoked binding dispatched a new private RPC"
    );
}

#[tokio::test]
async fn incomplete_startup_observes_original_cancellation_and_closes_without_claim() {
    use crate::ssh::test_support::assert_pending;
    let access = crate::ssh::test_support::unlocked_access();
    let lease = crate::ssh::test_support::ready_lease(&access);
    let fixture = ssh::guard_admission_fixture(lease.clone()).await;
    fixture.quiet();
    let mut channel = fixture.channel(&lease).await;
    channel.exec(true, "owned partial startup").await.unwrap();
    let partial = &private_frame()[..PREFIX.len() + 9];
    channel.data(partial).await.unwrap();
    let mut acquisition = Box::pin(acquire(
        &fixture.session,
        &lease,
        "original",
        &mut channel,
        Vec::new(),
    ));
    assert_pending(acquisition.as_mut()).await;
    access.lock().unwrap();
    assert!(acquisition.await.is_err());
    drop(channel);
    fixture.closed().await;
    assert_eq!(fixture.private_execs(), 0);
}

#[tokio::test]
async fn startup_deadline_and_eof_never_fall_back_or_claim() {
    let access = crate::ssh::test_support::unlocked_access();
    let lease = crate::ssh::test_support::ready_lease(&access);
    for close in [false, true] {
        let fixture = ssh::guard_admission_fixture(lease.clone()).await;
        fixture.quiet();
        let mut channel = fixture.channel(&lease).await;
        channel.exec(true, "owned missing startup").await.unwrap();
        if close {
            channel.close().await.unwrap();
        }
        let started = tokio::time::Instant::now();
        assert!(acquire(
            &fixture.session,
            &lease,
            "original",
            &mut channel,
            Vec::new()
        )
        .await
        .is_err());
        assert!(started.elapsed() < DEADLINE + Duration::from_secs(1));
        drop(channel);
        fixture.closed().await;
        assert_eq!(fixture.private_execs(), 0);
    }
}

#[tokio::test]
async fn a_held_ready_response_at_the_absolute_deadline_is_uncertain_without_repoll() {
    let (sender, response) = oneshot::channel();
    assert!(sender.send(WireResult::Ok {}).is_ok());
    let deadline = tokio::time::Instant::now() + Duration::from_millis(10);
    // Hold the already-ready result until the actual deadline, reproducing the
    // timeout_at ready-inner-first boundary without a network/cause claim.
    tokio::time::sleep_until(deadline).await;
    let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = polls.clone();
    let result = response_before(deadline, async move {
        observed.fetch_add(1, Ordering::SeqCst);
        response.await.map_err(|_| Fault::Unavailable)
    })
    .await;
    assert!(matches!(result, Err(Fault::Uncertain)));
    assert_eq!(polls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn view_retirement_keeps_input_reserved_after_actor_reply_until_view_finishes() {
    for body in [
        json!({"kind":"retire_for_view"}),
        json!({"kind":"retireForView"}),
    ] {
        assert!(serde_json::from_value::<Action>(body).is_err());
    }
    let (binding, mut queue, lease) = queued_binding();
    let (cancel, mut cancellation) = watch::channel(false);
    let permit = binding.reserve().unwrap();
    let owner = permit.clone();
    let caller = binding.clone();
    let original = lease.clone();
    let retirement = tokio::spawn(async move {
        caller
            .call_reserved(&original, &mut cancellation, Action::RetireForView, owner)
            .await
    });
    let work = queue.recv().await.unwrap();
    assert!(matches!(work.action, Action::RetireForView));
    work.reply
        .send(Ok(Reply::Released))
        .unwrap_or_else(|_| panic!("owned waiter disappeared"));
    drop(work._permit);
    retirement.await.unwrap().unwrap();
    assert_eq!(
        binding
            .call(&lease, &mut cancel.subscribe(), Action::Status)
            .await
            .err()
            .unwrap()
            .kind(),
        "herdr_chat_busy"
    );
    drop(permit);
    assert!(!binding.busy.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_view_change_waits_for_the_turn_in_flight_instead_of_being_refused() {
    let (binding, _queue, _lease) = queued_binding();
    let turn = binding.reserve().unwrap();
    // An input call is refused while the turn runs, a view change waits for it to end.
    assert!(binding.reserve().is_err());
    let waiting = {
        let binding = binding.clone();
        tokio::spawn(async move { binding.reserve_waiting(Duration::from_secs(30)).await.map(|_| ()) })
    };
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished());
    drop(turn);
    waiting.await.unwrap().unwrap();
    // A turn that never ends still ends the wait with the busy refusal.
    let _held = binding.reserve().unwrap();
    assert_eq!(
        binding
            .reserve_waiting(Duration::from_millis(20))
            .await
            .err()
            .unwrap()
            .kind(),
        "herdr_chat_busy"
    );
}

fn queued_binding() -> (Binding, mpsc::Receiver<Work>, AccessLease) {
    let (requests, queue) = mpsc::channel(1);
    let binding = Binding {
        requests,
        busy: Arc::default(),
        released: Arc::default(),
    };
    let lease = crate::app_lock::AccessState::disabled()
        .lease(None)
        .unwrap();
    (binding, queue, lease)
}

#[test]
fn dialog_answers_never_reach_the_herdr_guard() {
    let input = |input| {
        json!({"kind":"input","receipt":"22345678-1234-4234-8234-123456789abc",
            "source":{"agent":"claude","path":"/owned","view":"records","inlineImages":false},"operation":1,"input":input})
    };
    for answer in [
        json!({"kind":"select","option":1,"of":2}),
        json!({"kind":"submit","of":2}),
        json!({"kind":"cycle_mode"}),
        json!({"kind":"pick","rows":1,"enter":true,"seen":["Select model","1. One","2. Two","Enter to select"]}),
        json!({"kind":"dismiss","seen":["Select model","1. One","2. Two","Enter to select"]}),
    ] {
        let action: Action = serde_json::from_value(input(answer)).unwrap();
        assert!(matches!(action.validate(), Err(Fault::Invalid)));
    }
    let stop: Action = serde_json::from_value(input(json!({"kind":"request_stop"}))).unwrap();
    assert!(stop.validate().is_ok());
}

#[test]
fn a_long_prompt_is_a_tmux_paste_and_a_herdr_pane_refuses_it() {
    let long = Input::SendLong {
        text: "x".repeat(5000),
    };
    assert!(long.validate().is_ok());
    assert!(guarded_input(&long).is_err());
    assert!(guarded_input(&Input::Send { text: "ok".into() }).is_ok());
    let action: Action = serde_json::from_value(json!({"kind":"input","receipt":"22345678-1234-4234-8234-123456789abc",
        "source":{"agent":"claude","path":"/records/a.jsonl","view":"conversation","inlineImages":false},"operation":1,
        "input":{"kind":"send_long","text":"y".repeat(5000)}}))
    .unwrap();
    assert!(action.validate().is_err());
}

/// A display that yields its chunks one read at a time, as a PTY does.
struct Chunks(std::collections::VecDeque<Vec<u8>>);
impl io::Read for Chunks {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let Some(mut chunk) = self.0.pop_front() else {
            return Ok(0);
        };
        if chunk.len() > out.len() {
            self.0.push_front(chunk.split_off(out.len()));
        }
        out[..chunk.len()].copy_from_slice(&chunk);
        Ok(chunk.len())
    }
}
fn chunked(bytes: &[u8], size: usize) -> Chunks {
    Chunks(bytes.chunks(size).map(<[u8]>::to_vec).collect())
}
fn displayed(reader: &mut impl io::Read) -> io::Result<Vec<u8>> {
    let (mut shown, mut buffer) = (Vec::new(), [0u8; 64]);
    loop {
        match reader.read(&mut buffer)? {
            0 => return Ok(shown),
            count => shown.extend_from_slice(&buffer[..count]),
        }
    }
}

#[test]
fn a_local_display_never_shows_its_private_first_frame() {
    let mut stream = private_frame();
    stream.extend_from_slice(b"public rendered terminal bytes");
    // The frame may arrive in any split, including one that ends exactly where it ends.
    for size in [1, 3, 7, private_frame().len(), stream.len()] {
        let (ticket, delivered) = oneshot::channel();
        let mut reader = StartupReader::new(chunked(&stream, size), ticket);
        assert_eq!(
            displayed(&mut reader).unwrap(),
            b"public rendered terminal bytes",
            "split {size}"
        );
        let ticket = delivered.blocking_recv().unwrap();
        assert!(ticket.boot.0 == "ab".repeat(32) && ticket.ticket.0 == "cd".repeat(32));
    }
}

#[test]
fn a_local_display_that_does_not_open_with_the_frame_is_refused() {
    let mut late = b"untrusted output before the frame".to_vec();
    late.extend_from_slice(&private_frame());
    let mut oversized = PREFIX.to_vec();
    oversized.extend_from_slice(format!("{:08x}:", FRAME_BODY + 1).as_bytes());
    for stream in [late, oversized] {
        let (ticket, mut delivered) = oneshot::channel();
        let mut reader = StartupReader::new(chunked(&stream, 5), ticket);
        let error = displayed(&mut reader).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(delivered.try_recv().is_err());
    }
}

#[test]
fn a_local_display_that_ends_before_its_frame_supplies_no_ticket() {
    let (ticket, mut delivered) = oneshot::channel();
    let partial = &private_frame()[..private_frame().len() - 1];
    let mut reader = StartupReader::new(chunked(partial, 4), ticket);
    assert!(displayed(&mut reader).unwrap().is_empty());
    drop(reader);
    assert!(matches!(
        delivered.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    ));
}

#[cfg(unix)]
mod local_exchange {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A `herdr` on the PATH of the exchange that runs `script` and records where `$LOG` points.
    struct FakeHerdr {
        directory: tempfile::TempDir,
    }
    impl FakeHerdr {
        fn new(script: &str) -> Self {
            let directory = tempfile::tempdir().unwrap();
            std::fs::create_dir(directory.path().join("bin")).unwrap();
            let herdr = directory.path().join("bin/herdr");
            std::fs::write(&herdr, format!("#!/bin/sh\n{script}\n")).unwrap();
            std::fs::set_permissions(&herdr, std::fs::Permissions::from_mode(0o755)).unwrap();
            Self { directory }
        }
        fn at(&self, name: &str) -> std::path::PathBuf {
            self.directory.path().join(name)
        }
        fn local(&self) -> Local {
            Local {
                env: vec![
                    (
                        "PATH".into(),
                        format!("{}:/usr/bin:/bin", self.at("bin").display()),
                    ),
                    ("LOG".into(), self.directory.path().display().to_string()),
                ],
            }
        }
        async fn call(&self, name: &str) -> WireOutcome<WireResult> {
            let lease = crate::app_lock::AccessState::disabled()
                .lease(None)
                .unwrap();
            let (_open, mut cancel) = watch::channel(false);
            rpc(
                &Route::Local(self.local()),
                name,
                &lease,
                &mut cancel,
                "lazysh.guard.release",
                &json!({"receipt":"r"}),
                &mut None,
            )
            .await
        }
    }

    #[tokio::test]
    async fn the_request_reaches_herdr_on_stdin_and_the_name_stays_one_argument() {
        let herdr = FakeHerdr::new(
            r#"printf '%s\n' "$@" > "$LOG/argv"; cat > "$LOG/stdin"; printf '{"id":"guard","result":{"type":"ok"}}'"#,
        );
        assert!(matches!(
            herdr.call("own'ed $(touch NO) `x`").await,
            Ok(WireResult::Ok {})
        ));
        assert_eq!(
            std::fs::read_to_string(herdr.at("argv")).unwrap(),
            "--session\nown'ed $(touch NO) `x`\napi\nguarded\n"
        );
        let request: serde_json::Value =
            serde_json::from_slice(&std::fs::read(herdr.at("stdin")).unwrap()).unwrap();
        assert_eq!(
            request,
            json!({"id":"guard","method":"lazysh.guard.release","params":{"receipt":"r"}})
        );
        assert!(!herdr.at("NO").exists());
    }

    #[tokio::test]
    async fn a_refusal_on_stderr_with_exit_one_keeps_its_meaning() {
        for (code, expected) in [
            ("guard_stale", Fault::Stale),
            ("guard_busy", Fault::Busy),
            ("guard_uncertain", Fault::Uncertain),
            ("anything_else", Fault::Protocol),
        ] {
            let herdr = FakeHerdr::new(&format!(
                r#"cat > /dev/null; printf '{{"id":"guard","error":{{"code":"{code}","message":"{code}"}}}}' >&2; exit 1"#
            ));
            assert_eq!(herdr.call("n").await.err(), Some(expected), "{code}");
        }
        // Output on the wrong stream, or with the wrong status, is not a reply.
        let herdr = FakeHerdr::new(
            r#"cat > /dev/null; printf '{"id":"guard","result":{"type":"ok"}}'; exit 3"#,
        );
        assert_eq!(herdr.call("n").await.err(), Some(Fault::Protocol));
    }

    #[tokio::test]
    async fn a_reply_over_the_budget_is_a_protocol_fault() {
        // The request is drained first: a child that exits before reading it breaks the pipe under load.
        let herdr = FakeHerdr::new("cat > /dev/null; head -c 40000 /dev/zero | tr '\\0' x");
        assert_eq!(herdr.call("n").await.err(), Some(Fault::Protocol));
    }

    #[tokio::test]
    async fn an_exchange_past_its_deadline_is_uncertain_and_its_process_ends() {
        let herdr = FakeHerdr::new(r#"echo $$ > "$LOG/pid"; exec sleep 30"#);
        let started = tokio::time::Instant::now();
        assert_eq!(herdr.call("n").await.err(), Some(Fault::Uncertain));
        assert!(started.elapsed() < DEADLINE + Duration::from_secs(2));
        let pid = std::fs::read_to_string(herdr.at("pid")).unwrap();
        // A killed child may linger as a zombie until it is reaped; it must not run.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = std::process::Command::new("ps")
                    .args(["-o", "stat=", "-p", pid.trim()])
                    .output()
                    .unwrap();
                let state = String::from_utf8_lossy(&state.stdout);
                if state.trim().is_empty() || state.trim().starts_with('Z') {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the guard process outlived its exchange");
    }

    #[tokio::test]
    async fn only_the_exact_invalid_probe_reply_admits_the_guard_on_this_device() {
        let lease = crate::app_lock::AccessState::disabled()
            .lease(None)
            .unwrap();
        let probe = |script: &'static str| {
            let lease = lease.clone();
            async move {
                let herdr = FakeHerdr::new(script);
                let (_open, mut cancel) = watch::channel(false);
                available_local(herdr.local(), "n", &lease, &mut cancel).await
            }
        };
        assert!(
            probe(r#"cat > /dev/null; printf '{"id":"guard","error":{"code":"guard_invalid","message":"guard_invalid"}}' >&2; exit 1"#).await
        );
        // Stock Herdr does not know the subcommand, and a Herdr that is not there cannot start.
        assert!(!probe("cat > /dev/null; echo 'unknown option' >&2; exit 2").await);
        assert!(!probe(r#"printf '{"id":"guard","result":{"type":"ok"}}'"#).await);
        let missing = Local {
            env: vec![("PATH".into(), "/nonexistent".into())],
        };
        let (_open, mut cancel) = watch::channel(false);
        assert!(!available_local(missing, "n", &lease, &mut cancel).await);
    }
}
