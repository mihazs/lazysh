use super::*;

#[test]
fn isolated_navigation_requires_positive_capability_and_exact_selection() {
    for bytes in [
        &b"guard_invalid\n"[..],
        &br#"{"id":"guard","result":{"type":"guard_navigation_capabilities","schema_version":1,"isolated":true,"extra":true}}"#[..],
    ] {
        let status = if bytes.starts_with(b"{") { Some(0) } else { Some(2) };
        let result = if status == Some(0) { response(status, bytes, b"") } else { response(status, b"", bytes) };
        assert_eq!(navigation_capability(result), Ok(false));
    }
    let capable = br#"{"id":"guard","result":{"type":"guard_navigation_capabilities","schema_version":1,"isolated":true}}"#;
    assert_eq!(
        navigation_capability(response(Some(0), capable, b"")),
        Ok(true)
    );
    assert_eq!(
        navigation_capability(Err(Fault::Unavailable)),
        Err(Fault::Unavailable)
    );
    let target = NavigationTarget::Pane {
        workspace: "w1".into(),
        tab: "w1:t2".into(),
        pane: "w1:p3".into(),
        terminal: "original".into(),
    };
    let mut selection = NavigationSelection {
        workspace: "w1".into(),
        tab: "w1:t2".into(),
        pane: "w1:p3".into(),
        terminal: "other".into(),
    };
    assert!(!target.matches(&selection));
    selection.terminal = "original".into();
    assert!(target.matches(&selection));
}
use serde_json::json;

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
    let (requests, mut queue) = mpsc::channel(1);
    let binding = Binding {
        requests,
        busy: Arc::default(),
    };
    let lease = crate::app_lock::AccessState::disabled()
        .lease(None)
        .unwrap();
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
        navigation: 0,
        startup: Startup {
            boot: secret.clone(),
            ownership: secret.clone(),
            name: "original".into(),
        },
        handle: fixture.session.handle.clone(),
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
