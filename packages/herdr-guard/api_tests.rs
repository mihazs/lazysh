// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::guarded_input::protocol::{ClaimParams, Input, InputParams, PrepareParams, Secret};
use interprocess::local_socket::traits::Listener as _;
use std::os::unix::fs::DirBuilderExt;

struct OwnedDirectory(std::path::PathBuf);
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn pair() -> (LocalStream, LocalStream, OwnedDirectory) {
    let mut suffix = [0_u8; 8];
    getrandom::fill(&mut suffix).unwrap();
    let directory = OwnedDirectory(std::path::PathBuf::from(format!(
        "/tmp/hga283-{}-{:x}",
        std::process::id(),
        u64::from_le_bytes(suffix)
    )));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory.0)
        .unwrap();
    let listener = crate::ipc::bind_local_listener(&directory.0.join("api.sock")).unwrap();
    let client = crate::ipc::connect_local_stream(&directory.0.join("api.sock")).unwrap();
    let server = listener.accept().unwrap();
    (client, server, directory)
}
fn next(
    receiver: &mut tokio::sync::mpsc::UnboundedReceiver<ApiRequestMessage>,
) -> ApiRequestMessage {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if let Ok(message) = receiver.try_recv() {
            return message;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("owned API actor observation deadline");
}
fn abandoned(
    request: Request,
    admitted: impl FnOnce(&ApiRequestMessage),
) -> (ApiRequestMessage, Vec<ApiRequestMessage>) {
    let (client, server, _directory) = pair();
    let (sender, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let worker = std::thread::spawn(move || {
        serve(
            server,
            request,
            512,
            &sender,
            &Arc::new(AtomicBool::new(true)),
        )
    });
    let first = next(&mut receive);
    admitted(&first);
    drop(client);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !worker.is_finished() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(worker.is_finished(), "owned API worker cleanup deadline");
    let result = worker.join().unwrap();
    assert!(result.is_ok() || result.as_ref().is_err_and(is_connection_closed_error));
    let mut cleanup = Vec::new();
    while let Ok(message) = receive.try_recv() {
        cleanup.push(message);
        assert!(cleanup.len() <= 1, "duplicate abandonment operations");
    }
    (first, cleanup)
}

#[test]
fn observed_rpc_disconnect_cancels_original_queued_input_and_wakes_retirement() {
    let boot = Secret::generate().unwrap();
    let receipt = Secret::generate().unwrap();
    let request = Request {
        id: "owned-guard-test".into(),
        method: Method::GuardInput(InputParams {
            boot: boot.clone(),
            receipt: receipt.clone(),
            source: "ab".repeat(32),
            operation: 1,
            input: Input::RequestStop,
            cancellation: Cancellation::default(),
        }),
    };
    let (first, mut cleanup) = abandoned(request, |_| {});
    let Method::GuardInput(params) = first.request.method else {
        panic!("wrong original operation");
    };
    assert!(params.cancellation.cancelled());
    assert_eq!(cleanup.len(), 1);
    let Method::GuardRelease(release) = cleanup.remove(0).request.method else {
        panic!("abandonment replayed input");
    };
    assert!(release.boot == boot && release.receipt == receipt);
}

#[test]
fn observed_preparation_abandonment_is_scoped_to_its_original_number() {
    let boot = Secret::generate().unwrap();
    let ownership = Secret::generate().unwrap();
    let request = Request {
        id: "owned-guard-test".into(),
        method: Method::GuardPrepare(PrepareParams {
            boot: boot.clone(),
            ownership: ownership.clone(),
            preparation: 7,
            source: "ab".repeat(32),
            cancellation: Cancellation::default(),
        }),
    };
    let (first, mut cleanup) = abandoned(request, |_| {});
    let Method::GuardPrepare(params) = first.request.method else {
        panic!("wrong original preparation");
    };
    assert!(params.cancellation.cancelled());
    assert_eq!(cleanup.len(), 1);
    let Method::GuardCancelPreparation(cancel) = cleanup.remove(0).request.method else {
        panic!("abandonment renewed ownership");
    };
    assert!(cancel.boot == boot && cancel.ownership == ownership && cancel.preparation == 7);
}

#[test]
fn observed_lost_claim_revokes_minted_ownership_without_replay_or_attachment() {
    let now = std::time::Instant::now();
    let (mut registry, ack) = crate::guarded_input::state::tests::registered(now);
    let request = Request {
        id: "owned-guard-test".into(),
        method: Method::GuardClaim(ClaimParams {
            boot: ack.boot.clone(),
            ticket: ack.ticket.clone(),
            cancellation: Cancellation::default(),
        }),
    };
    let mut minted = None;
    let (first, cleanup) = abandoned(request, |message| {
        let Method::GuardClaim(params) = &message.request.method else {
            panic!("wrong claim");
        };
        minted = Some(
            registry
                .claim(
                    &params.boot,
                    &params.ticket,
                    params.cancellation.clone(),
                    now,
                )
                .unwrap(),
        );
    });
    let Method::GuardClaim(params) = first.request.method else {
        panic!("wrong original claim");
    };
    assert!(params.cancellation.cancelled());
    assert!(cleanup.is_empty()); // There is no replayed claim or new client.
    let owner = minted.unwrap();
    assert_eq!(
        registry
            .begin_preparation(
                &owner.boot,
                &owner.ownership,
                1,
                "ab".repeat(32),
                Cancellation::default(),
                now
            )
            .err(),
        Some("guard_stale")
    );
    crate::guarded_input::state::tests::assert_spent_ticket(
        &mut registry,
        &ack.boot,
        &ack.ticket,
        now,
    );
}

#[test]
fn guarded_publication_does_not_swallow_closed_peer_write_failure() {
    let (client, mut server, _directory) = pair();
    drop(client);
    let result = finish(
        &mut server,
        "guard-test",
        "lazysh.guard.claim",
        Ok("{\"id\":\"guard-test\",\"result\":{\"type\":\"ok\"}}".into()),
    );
    assert!(
        result.is_err(),
        "uncertain guarded publication reported success"
    );
}

#[test]
fn invalid_preparation_availability_probe_never_enters_the_actor() {
    use interprocess::local_socket::traits::Stream as _;
    use std::io::Read;
    let (client, server, _directory) = pair();
    client
        .set_recv_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let (sender, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let placeholder = Secret::try_from("0".repeat(64)).unwrap();
    let request = Request {
        id: "guard".into(),
        method: Method::GuardCancelPreparation(CancelPreparationParams {
            boot: placeholder.clone(),
            ownership: placeholder,
            preparation: 0,
        }),
    };
    serve(
        server,
        request,
        512,
        &sender,
        &Arc::new(AtomicBool::new(true)),
    )
    .unwrap();
    let mut response = Vec::new();
    client.take(1024).read_to_end(&mut response).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&response).unwrap(),
        serde_json::json!({"id":"guard","error":{"code":"guard_invalid","message":"guard_invalid"}})
    );
    assert!(matches!(
        receive.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
}
