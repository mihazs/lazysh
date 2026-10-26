//! Custom native SSH peer, not system pbcopy/physical clipboard acceptance.
use super::*;
use crate::host_clipboard::copy_uploaded;
use crate::ssh::test_support::{ready_lease, unlocked_access};
const UPLOAD: &str = "owned-upload";
const RAW: &str = "/original/--image 世界'$(literal).png";
async fn clipboard_peer(
    mode: usize,
) -> (
    AppState,
    tempfile::TempDir,
    TestServer,
    tokio::task::JoinHandle<()>,
    Arc<Session>,
    AccessState,
    AccessLease,
) {
    let authority = unlocked_access();
    let lease = ready_lease(&authority);
    let (state, directory, _host, server, task, session) = auxiliary_fixture(lease.clone()).await;
    server.clipboard_mode.store(mode, Ordering::SeqCst);
    session
        .clipboard
        .publish(UPLOAD.into(), RAW.into(), lease.clone());
    (state, directory, server, task, session, authority, lease)
}
#[tokio::test]
async fn host_clipboard_sends_one_fixed_command_and_exact_raw_stdin_without_terminal_input() {
    let (_state, _dir, peer, task, session, _authority, lease) = clipboard_peer(1).await;
    copy_uploaded(&session, &lease, UPLOAD).await.unwrap();
    assert_eq!(
        *peer.commands.lock().unwrap(),
        vec![crate::host_clipboard::COMMAND]
    );
    assert_eq!(*peer.input_data.lock().unwrap(), RAW.as_bytes());
    // The successful peer already closed its channel; prove local capacity is
    // retired by accepting a second explicit request, rather than expecting a
    // redundant close callback for a channel the server has removed.
    confirm_followup(&session, &lease, UPLOAD, &peer).await;
    task.abort();
}
#[tokio::test]
async fn host_clipboard_refuses_foreign_receipts_sessions_and_replacement_authority_before_exec() {
    let (_state, _dir, peer, task, session, authority, lease) = clipboard_peer(1).await;
    assert!(copy_uploaded(&session, &lease, "foreign").await.is_err());
    let (input, _) = mpsc::channel(1);
    let (cancel, _) = watch::channel(false);
    let other = Session::new(
        session.handle.clone(),
        input,
        cancel,
        lease.clone(),
        check_size,
    );
    assert!(copy_uploaded(&other, &lease, UPLOAD).await.is_err());
    authority.lock().unwrap();
    authority
        .authorize(authority.generation().unwrap())
        .unwrap();
    let replacement = ready_lease(&authority);
    assert!(copy_uploaded(&session, &replacement, UPLOAD).await.is_err());
    assert!(peer.commands.lock().unwrap().is_empty());
    task.abort();
}
#[tokio::test]
async fn host_clipboard_lost_ownership_after_delivered_bytes_is_unconfirmed_and_closes_its_channel()
{
    for reason in ["cancel", "supersede", "disconnect", "revoke"] {
        let (_state, _dir, peer, task, session, authority, lease) = clipboard_peer(2).await;
        let pending = start_copy(session.clone(), lease.clone());
        timeout(Duration::from_secs(3), peer.clipboard_eof.notified())
            .await
            .unwrap();
        assert!(
            copy_uploaded(&session, &lease, UPLOAD).await.is_err(),
            "busy requests must not queue"
        );
        match reason {
            "cancel" => {
                assert!(session.clipboard.cancel(UPLOAD, lease.generation()));
            }
            "supersede" => {
                session
                    .clipboard
                    .publish("newer".into(), "/newer".into(), lease.clone())
            }
            "disconnect" => {
                session.cancel.send_replace(true);
            }
            _ => {
                authority.lock().unwrap();
            }
        }
        assert!(timeout(Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        let channel = peer.command_channels.lock().unwrap()[0];
        assert!(observe_channel_close(&peer, channel).await);
        assert_eq!(*peer.input_data.lock().unwrap(), RAW.as_bytes());
        assert_eq!(peer.commands.lock().unwrap().len(), 1);
        if reason == "supersede" {
            assert!(!session.clipboard.cancel(UPLOAD, lease.generation()));
            peer.clipboard_mode.store(1, Ordering::SeqCst);
            confirm_followup(&session, &lease, "newer", &peer).await;
        }
        task.abort();
    }
}
#[tokio::test]
async fn host_clipboard_helper_failures_never_echo_output_or_remove_completed_paths() {
    for mode in [3, 4] {
        let (_state, _dir, peer, task, session, _authority, lease) = clipboard_peer(mode).await;
        let error = copy_uploaded(&session, &lease, UPLOAD).await.unwrap_err();
        assert!(!serde_json::to_string(&error).unwrap().contains("private"));
        peer.clipboard_mode.store(1, Ordering::SeqCst);
        confirm_followup(&session, &lease, UPLOAD, &peer).await;
        task.abort();
    }
}

async fn wait_retired(session: &Session) {
    timeout(Duration::from_secs(3), async {
        while !session.clipboard.available() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("copy capacity must remain reserved only until owned close retires");
}

async fn confirm_followup(session: &Session, lease: &AccessLease, id: &str, peer: &TestServer) {
    wait_retired(session).await;
    copy_uploaded(session, lease, id).await.unwrap();
    assert_eq!(peer.commands.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn host_clipboard_cancelled_pending_open_retains_capacity_until_late_confirmation_closes() {
    retained_open(false).await;
}
#[tokio::test]
async fn host_clipboard_timed_out_pending_open_retains_capacity_until_late_confirmation_closes() {
    retained_open(true).await;
}
async fn retained_open(expire: bool) {
    let (_state, _dir, peer, task, session, _authority, lease) = clipboard_peer(1).await;
    peer.hold_opens.store(true, Ordering::SeqCst);
    let pending = start_copy(session.clone(), lease.clone());
    timeout(Duration::from_secs(3), peer.open_started.notified())
        .await
        .unwrap();
    if expire {
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::time::resume();
    } else {
        assert!(session.clipboard.cancel(UPLOAD, lease.generation()));
    }
    assert!(timeout(Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    session
        .clipboard
        .publish("successor".into(), "/successor".into(), lease.clone());
    // Poll a successor once: it must reject busy synchronously, not admit a
    // second retained SSH open behind the stalled peer.
    let next = copy_uploaded(&session, &lease, "successor");
    tokio::pin!(next);
    let result = std::future::poll_fn(|cx| {
        std::task::Poll::Ready(std::future::Future::poll(next.as_mut(), cx))
    })
    .await;
    let ready =
        matches!(&result,std::task::Poll::Ready(Err(error)) if error.kind=="host_clipboard_busy");
    // Always retire held opens, including the genuine RED's extra opening.
    release_held_opens(&peer).await;
    if result.is_pending() {
        let _ = next.await;
    }
    assert!(
        ready,
        "pending clipboard open must retain the sole copy permit"
    );
    let channel = peer.opening_channel.lock().unwrap().unwrap();
    assert!(observe_channel_close(&peer, channel).await);
    assert!(
        peer.commands.lock().unwrap().is_empty(),
        "cancelled late confirmation must never exec"
    );
    wait_retired(&session).await;
    copy_uploaded(&session, &lease, "successor").await.unwrap();
    assert_eq!(peer.commands.lock().unwrap().len(), 1);
    task.abort();
}

fn start_copy(session: Arc<Session>, lease: AccessLease) -> tokio::task::JoinHandle<Result<()>> {
    tokio::spawn(async move { copy_uploaded(&session, &lease, UPLOAD).await })
}

#[tokio::test]
async fn host_clipboard_ready_success_cannot_win_a_caller_poll_after_deadline() {
    let (_state, _dir, peer, task, session, _authority, lease) = clipboard_peer(1).await;
    let mut pending = Box::pin(copy_uploaded(&session, &lease, UPLOAD));
    tokio::select! { biased;
        _ = peer.clipboard_eof.notified() => {},
        result = &mut pending => panic!("caller must remain held before peer completion: {result:?}"),
    }
    // An independent confirmed channel is a wire-order barrier: the peer sends
    // the clipboard status/EOF/close before confirming this later request. Keep
    // the clipboard caller unpolled while its successful result is queued.
    let barrier = open_owned_channel(
        &session.handle,
        &lease,
        tokio::time::Instant::now() + Duration::from_secs(3),
    )
    .await
    .unwrap();
    barrier.close().await.unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(6)).await;
    let result = pending.await;
    tokio::time::resume();
    task.abort();
    assert!(
        result.is_err(),
        "queued success must not override the absolute copy deadline"
    );
    assert_eq!(*peer.input_data.lock().unwrap(), RAW.as_bytes());
}
