use super::*;
use std::{
    future::Future,
    pin::Pin,
    sync::atomic::{AtomicUsize, Ordering},
};

pub(crate) fn unlocked_access() -> AccessState {
    let access = AccessState::default();
    access.initialize(true, true, "test".into()).unwrap();
    access.authorize(access.generation().unwrap()).unwrap();
    access.ready(access.generation().unwrap()).unwrap();
    access
}
pub(crate) fn ready_lease(access: &AccessState) -> AccessLease {
    access.ready(access.generation().unwrap()).unwrap();
    access
        .lease(access.status().unwrap().nonce.as_deref())
        .unwrap()
}
pub(crate) async fn assert_pending<F: Future>(mut future: Pin<&mut F>) {
    std::future::poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
}
pub(crate) fn event_channel<T: Send + 'static>(
    decode: fn(String) -> T,
) -> (Channel<SshEvent>, mpsc::UnboundedReceiver<T>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let events = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = body {
            let _ = tx.send(decode(json));
        }
        Ok(())
    });
    (events, rx)
}
pub(crate) fn json_events() -> (
    Channel<SshEvent>,
    mpsc::UnboundedReceiver<serde_json::Value>,
) {
    event_channel(|json| serde_json::from_str(&json).unwrap())
}
pub(crate) fn counting_events(calls: &Arc<AtomicUsize>) -> Channel<SshEvent> {
    let calls = calls.clone();
    Channel::new(move |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
}

pub(crate) fn replacement_lease(access: &AccessState) -> AccessLease {
    assert!(access.finish_renderer_replacement().unwrap());
    access.foreground().unwrap();
    access.ready(access.generation().unwrap()).unwrap();
    assert!(access.lease(None).is_err());
    access
        .lease(access.status().unwrap().nonce.as_deref())
        .unwrap()
}

pub(crate) fn host_offer(
    id: &str,
    access: &AccessLease,
) -> (crate::desktop_launch::LaunchState, String) {
    use crate::desktop_launch::{LaunchState, LaunchTarget};
    let launch = LaunchState::new(Some(LaunchTarget::Host(id.into())));
    let receipt = launch.read(access).unwrap().host_receipt.unwrap();
    (launch, receipt)
}

pub(crate) fn prepared_host_offer(
    state: &AppState,
    host_id: &str,
) -> (
    AccessState,
    AccessLease,
    crate::desktop_launch::LaunchState,
    String,
) {
    let access = unlocked_access();
    let lease = ready_lease(&access);
    let (launch, receipt) = host_offer(host_id, &lease);
    launch.prepare_host(state, &receipt, &lease).unwrap();
    (access, lease, launch, receipt)
}
