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
    let launch = LaunchState::new(Some(LaunchTarget::Host {
        id: id.into(),
        mux: None,
    }));
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

/// Shared adversarial changes to every frozen credential-binding field.
pub(crate) fn changed_host_bindings(original: &Host) -> Vec<(&'static str, Host)> {
    let value = serde_json::to_value(original).unwrap();
    [
        ("id", serde_json::json!("another")),
        ("hostname", serde_json::json!("other.invalid")),
        ("port", serde_json::json!(23)),
        ("username", serde_json::json!("another")),
        ("fingerprint", serde_json::json!("SHA256:changed")),
        ("jumpHostId", serde_json::json!("other-route")),
        ("forwardAgent", serde_json::json!(true)),
        ("biometricUnlock", serde_json::json!(true)),
    ]
    .into_iter()
    .map(|(field, changed)| {
        let mut host = value.clone();
        host[field] = changed;
        (field, serde_json::from_value(host).unwrap())
    })
    .collect()
}

/// Spawns an owned fixture server with no inherited terminal I/O.
pub(crate) fn spawn_quiet(command: &mut std::process::Command) -> std::process::Child {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

/// Waits for an owned fixture server to accept TCP, failing fast if it exits first.
pub(crate) async fn wait_for_listener(
    child: &mut std::process::Child,
    address: std::net::SocketAddr,
    diagnostics: impl Fn() -> String,
) {
    timeout(Duration::from_secs(5), async {
        loop {
            if child.try_wait().unwrap().is_some() {
                panic!("owned server exited before listening: {}", diagnostics());
            }
            if tokio::net::TcpStream::connect(address).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("owned server did not listen in time");
}

/// The saved host an owned loopback sshd on `port` stands for, pinned to its host key.
pub(crate) fn owned_host(
    id: &str,
    name: &str,
    port: u16,
    host_key: &russh::keys::PrivateKey,
) -> Host {
    Host {
        default_multiplexer: None,
        default_multiplexer_next: None,
        transport: None,
        mosh: None,
        et: None,
        id: id.into(),
        name: name.into(),
        hostname: "127.0.0.1".into(),
        port,
        username: std::env::var("USER").unwrap(),
        fingerprint: Some(
            host_key
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
        ),
        jump_host_id: None,
        credentials_stored: false,
        client_environment: false,
        biometric_unlock: false,
        forward_agent: false,
    }
}
