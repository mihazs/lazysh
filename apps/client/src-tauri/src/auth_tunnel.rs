//! Loopback tunnels for the localhost callback of a sign-in that runs on the host (`aws sso login`,
//! `gcloud auth login`, `codex login` and similar), so the browser on this device can finish it.
//!
//! This is not a port forward. A flow listens on the device loopback at the same port the host
//! announced (the redirect URI is never rewritten, because the CLI repeats it at the token
//! endpoint), checks the first request of every connection with [`guard`], forwards that one request
//! to the host's own loopback through an SSH `direct-tcpip` channel and ends after the callback.
//! Previews stay the manual, byte-transparent forward for dev servers.
//!
//! Nothing here logs or stores a request: the callback carries the authorization code and state, so
//! errors and events hold fixed texts, ports and reasons only.
use crate::app_lock::AccessLease;
use crate::previews::{serve_connections, PreviewState, Protected};
use crate::ssh::{AppState, Result, SshError, SshHandle};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    net::{Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};
use tauri::{ipc::Channel, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch, Mutex, Semaphore},
    task::JoinSet,
    time::{sleep_until, timeout, timeout_at, Instant},
};

mod guard;
mod policy;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;

use policy::Family;
pub use policy::{Consent, Hint};

const MAX_PER_SESSION: usize = 4;
const MAX_FLOWS: usize = 8;
const MAX_CONNECTIONS: usize = 8;
const HOST_WINDOW: Duration = Duration::from_secs(10 * 60);

/// The bounds of one flow. Tests shorten them; the product always uses [`Limits::default`].
#[derive(Clone)]
pub(crate) struct Limits {
    lifetime: Duration,
    pub(crate) after_callback: Duration,
    connection: Duration,
    head: Duration,
    response: usize,
}
#[cfg(test)]
impl Limits {
    /// Short bounds so a test that waits for an end does not wait long.
    pub(crate) fn quick() -> Self {
        Self {
            lifetime: Duration::from_secs(30),
            after_callback: Duration::from_millis(150),
            connection: Duration::from_secs(5),
            head: Duration::from_millis(300),
            response: 1024 * 1024,
        }
    }
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            lifetime: Duration::from_secs(10 * 60),
            after_callback: Duration::from_secs(15),
            connection: Duration::from_secs(60),
            head: guard::HEAD_TIMEOUT,
            response: 1024 * 1024,
        }
    }
}

/// What a test may change about a flow. The product always uses the default: the device port is the
/// host's port (the redirect URI is never rewritten) and the limits below.
#[derive(Clone, Default)]
pub(crate) struct Config {
    pub(crate) limits: Limits,
    /// A test shares one machine between "host" and "device", where the same port cannot be bound twice.
    pub(crate) device_port: Option<u16>,
}

/// The host's own loopback addresses a flow may connect to. No other address is ever dialled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostAddress {
    V4,
    V6,
}
impl HostAddress {
    pub(crate) fn host(self) -> &'static str {
        match self {
            Self::V4 => "127.0.0.1",
            Self::V6 => "::1",
        }
    }
}

/// Why opening the host side of a connection failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConnectError {
    /// Nothing listens on the host's port (the SSH server answered "connect failed").
    Refused,
    /// The SSH server forbids TCP forwarding.
    Prohibited,
    /// The SSH connection behind the session is gone.
    Lost,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndReason {
    /// The callback went through and its grace period passed.
    CallbackDelivered,
    Timeout,
    Cancelled,
    SessionEnded,
    LockEnded,
    HostStoppedListening,
    ForwardingDisabled,
    ControlConnectionLost,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TunnelEvent {
    /// A request with an authorization result reached the host. Its content is not reported.
    Callback,
    Ended {
        reason: EndReason,
    },
}

enum Signal {
    Callback,
    Reached,
    Refused,
    Ended(EndReason),
}

struct Shared<C> {
    rule: guard::Rule,
    hosts: Vec<HostAddress>,
    limits: Limits,
    connect: C,
    signals: mpsc::UnboundedSender<Signal>,
    slots: Arc<Semaphore>,
}

struct Flow<C, E> {
    listeners: Vec<TcpListener>,
    rule: guard::Rule,
    hosts: Vec<HostAddress>,
    limits: Limits,
    connect: C,
    session_ended: watch::Receiver<bool>,
    stop: watch::Receiver<Option<EndReason>>,
    events: E,
}

/// Serves one flow until it ends and returns why. The listeners are closed and every connection
/// is gone when this returns.
async fn run<C, Fut, S, E>(flow: Flow<C, E>) -> EndReason
where
    C: Fn(HostAddress) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = std::result::Result<S, ConnectError>> + Send + 'static,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    E: Fn(TunnelEvent),
{
    let Flow {
        listeners,
        rule,
        hosts,
        limits,
        connect,
        mut session_ended,
        mut stop,
        events,
    } = flow;
    let (signals, mut incoming) = mpsc::unbounded_channel();
    let (halt, halted) = watch::channel(false);
    let lifetime = Instant::now() + limits.lifetime;
    let after_callback = limits.after_callback;
    let shared = Arc::new(Shared {
        rule,
        hosts,
        limits,
        connect,
        signals,
        slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
    });
    let mut servers = JoinSet::new();
    for listener in listeners {
        let shared = shared.clone();
        servers.spawn(serve_connections(
            listener,
            halted.clone(),
            halted.clone(),
            move |local| handle(shared.clone(), local),
        ));
    }
    let mut callback_at: Option<Instant> = None;
    let mut refused = 0;
    let reason = loop {
        if let Some(reason) = *stop.borrow() {
            break reason;
        }
        if *session_ended.borrow() {
            break EndReason::SessionEnded;
        }
        tokio::select! {
            changed = stop.changed() => if changed.is_err() { break EndReason::Cancelled },
            _ = session_ended.changed() => break EndReason::SessionEnded,
            Some(signal) = incoming.recv() => match signal {
                Signal::Callback => if callback_at.is_none() {
                    callback_at = Some(Instant::now() + after_callback);
                    events(TunnelEvent::Callback);
                },
                Signal::Reached => refused = 0,
                // A callback in flight outlives a host that already closed its server.
                Signal::Refused => {
                    refused += 1;
                    if refused >= 2 && callback_at.is_none() {
                        break EndReason::HostStoppedListening;
                    }
                }
                Signal::Ended(reason) => break reason,
            },
            _ = sleep_until(callback_at.unwrap_or(lifetime)) => {
                break if callback_at.is_some() { EndReason::CallbackDelivered } else { EndReason::Timeout };
            }
            _ = sleep_until(lifetime) => break EndReason::Timeout,
        }
    };
    halt.send_replace(true);
    while servers.join_next().await.is_some() {}
    reason
}

async fn handle<C, Fut, S>(shared: Arc<Shared<C>>, mut local: TcpStream)
where
    C: Fn(HostAddress) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = std::result::Result<S, ConnectError>> + Send + 'static,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Ok(_slot) = shared.slots.clone().try_acquire_owned() else {
        return;
    };
    let started = Instant::now();
    let _ = timeout_at(started + shared.limits.connection, async {
        let admitted =
            match guard::admit(&mut local, &shared.rule, started + shared.limits.head).await {
                Ok(admitted) => admitted,
                Err(refusal) => return answer(&mut local, &refusal.response()).await,
            };
        let mut remote = match open(&shared).await {
            Ok(remote) => remote,
            Err(error) => {
                answer(
                    &mut local,
                    &guard::response(
                        "502 Bad Gateway",
                        "The host did not answer the sign-in callback.",
                    ),
                )
                .await;
                // After the answer: ending the flow drops this connection's task.
                return match error {
                    ConnectError::Refused => drop(shared.signals.send(Signal::Refused)),
                    ConnectError::Prohibited => drop(
                        shared
                            .signals
                            .send(Signal::Ended(EndReason::ForwardingDisabled)),
                    ),
                    ConnectError::Lost => drop(
                        shared
                            .signals
                            .send(Signal::Ended(EndReason::ControlConnectionLost)),
                    ),
                    ConnectError::Other => {}
                };
            }
        };
        let _ = shared.signals.send(Signal::Reached);
        if remote.write_all(&admitted.bytes).await.is_err() || remote.flush().await.is_err() {
            return answer(
                &mut local,
                &guard::response(
                    "502 Bad Gateway",
                    "The host did not answer the sign-in callback.",
                ),
            )
            .await;
        }
        if admitted.callback {
            let _ = shared.signals.send(Signal::Callback);
        }
        relay(&mut remote, &mut local, shared.limits.response).await;
        finish(&mut local).await;
    })
    .await;
}

/// The host's loopback addresses in the order the evidence suggests; the first that accepts wins.
async fn open<C, Fut, S>(shared: &Shared<C>) -> std::result::Result<S, ConnectError>
where
    C: Fn(HostAddress) -> Fut,
    Fut: Future<Output = std::result::Result<S, ConnectError>>,
{
    for address in &shared.hosts {
        match (shared.connect)(*address).await {
            Err(ConnectError::Refused) => continue,
            other => return other,
        }
    }
    Err(ConnectError::Refused)
}

/// Copies the host's response, at most `cap` bytes. Bytes the browser sends meanwhile (a pipelined
/// second request) are dropped; a browser that half-closes after its request still gets the answer.
async fn relay<R: AsyncRead + Unpin>(remote: &mut R, local: &mut TcpStream, cap: usize) {
    let (mut chunk, mut ignored, mut sent, mut listening) =
        (vec![0; 16 * 1024], [0; 1024], 0, true);
    while sent < cap {
        tokio::select! {
            read = remote.read(&mut chunk) => {
                let Ok(count) = read else { break };
                let count = count.min(cap - sent);
                if count == 0 || local.write_all(&chunk[..count]).await.is_err() {
                    break;
                }
                sent += count;
            }
            read = local.read(&mut ignored), if listening => match read {
                Ok(0) => listening = false,
                Ok(_) => {}
                Err(_) => break,
            },
        }
    }
}

async fn answer(local: &mut TcpStream, text: &str) {
    let _ = local.write_all(text.as_bytes()).await;
    finish(local).await;
}

/// Closes politely: a socket closed with unread request bytes sends a reset that can discard the
/// response the browser has not read yet, so the rest of the request is drained first.
async fn finish(local: &mut TcpStream) {
    let _ = local.shutdown().await;
    let _ = timeout(Duration::from_secs(1), async {
        let (mut sink, mut drained) = ([0; 4096], 0);
        while drained < guard::MAX_REQUEST {
            match local.read(&mut sink).await {
                Ok(0) | Err(_) => break,
                Ok(count) => drained += count,
            }
        }
    })
    .await;
}

struct Entry {
    tunnel: AuthTunnel,
    stop: watch::Sender<Option<EndReason>>,
    finished: watch::Receiver<bool>,
}
#[derive(Default)]
struct Registry {
    flows: HashMap<String, Entry>,
    starts: HashMap<String, VecDeque<Instant>>,
}

#[derive(Clone, Default)]
pub struct AuthTunnelState(Arc<Mutex<Registry>>);
impl AuthTunnelState {
    #[cfg(test)]
    pub(crate) async fn is_empty(&self) -> bool {
        self.0.lock().await.flows.is_empty()
    }
    pub(crate) async fn cancel_for_lock(&self) {
        for flow in self.0.lock().await.flows.values() {
            flow.stop.send_replace(Some(EndReason::LockEnded));
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthTunnel {
    pub(crate) id: String,
    session_id: String,
    pub(crate) port: u16,
    /// The device addresses that listen: always `127.0.0.1`, and `[::1]` when it was free.
    pub(crate) addresses: Vec<&'static str>,
}

/// Maps the SSH server's refusal of a `direct-tcpip` channel to what the flow should do.
fn classify(error: &SshError, handle: &SshHandle) -> ConnectError {
    if handle.is_closed() {
        ConnectError::Lost
    } else if error.message().contains("ConnectFailed") {
        ConnectError::Refused
    } else if error.message().contains("AdministrativelyProhibited") {
        ConnectError::Prohibited
    } else {
        ConnectError::Other
    }
}

async fn bind(port: u16) -> std::io::Result<Vec<TcpListener>> {
    let mut listeners = vec![TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?];
    // A browser may resolve localhost to either family. A device without IPv6 works, but another
    // program on `[::1]:port` would receive the sign-in code, so that case fails closed.
    match TcpListener::bind((Ipv6Addr::LOCALHOST, port)).await {
        Ok(listener) => listeners.push(listener),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => return Err(error),
        Err(_) => {}
    }
    Ok(listeners)
}

fn callback_path(path: Option<&str>) -> Result<String> {
    let path = path.unwrap_or("/");
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.len() > 256
        || !path.bytes().all(|byte| (0x21..0x7f).contains(&byte))
        || path.contains(['?', '#', '\\', '%'])
    {
        return Err(SshError::new(
            "invalid_path",
            "The callback path is not valid",
        ));
    }
    Ok(path.to_owned())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn begin(
    access: &AccessLease,
    state: &AppState,
    tunnels: &AuthTunnelState,
    previews: &PreviewState,
    session_id: String,
    hint: Hint,
    consent: Consent,
    events: Channel<TunnelEvent>,
    config: Config,
) -> Result<AuthTunnel> {
    let session = state.session(&session_id).await?;
    let origin = session.handle.origin();
    let host_key = origin.map_or_else(|| session_id.clone(), |host| host.id.clone());
    let path = callback_path(hint.path.as_deref())?;
    let mut registry = tunnels.0.lock().await;
    let now = Instant::now();
    let starts = registry.starts.entry(host_key.clone()).or_default();
    while starts
        .front()
        .is_some_and(|start| now.duration_since(*start) >= HOST_WINDOW)
    {
        starts.pop_front();
    }
    policy::admit(&hint, consent, origin.map(|host| host.port), starts.len())?;
    if registry.flows.len() >= MAX_FLOWS
        || registry
            .flows
            .values()
            .filter(|flow| flow.tunnel.session_id == session_id)
            .count()
            >= MAX_PER_SESSION
    {
        return Err(SshError::new(
            "auth_tunnel_limit",
            "Finish or cancel a sign-in tunnel before starting another",
        ));
    }
    let device_port = config.device_port.unwrap_or(hint.port);
    let listeners = match bind(device_port).await {
        Ok(listeners) => listeners,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            return Err(SshError::new(
                "auth_tunnel_port_busy",
                if registry
                    .flows
                    .values()
                    .any(|flow| flow.tunnel.port == device_port)
                {
                    format!(
                        "Another sign-in tunnel already holds port {device_port} on this device"
                    )
                } else if previews.uses_local_port(device_port).await {
                    format!(
                        "A preview holds port {device_port} on this device. Close it and try again"
                    )
                } else {
                    format!("Another program on this device uses port {device_port}. The sign-in cannot finish here until it stops")
                },
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err(SshError::new(
                "auth_tunnel_port_not_permitted",
                format!("This device does not let the app listen on port {device_port}"),
            ));
        }
        Err(error) => return Err(error.into()),
    };
    let tunnel = AuthTunnel {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        port: device_port,
        addresses: if listeners.len() == 2 {
            vec!["127.0.0.1", "[::1]"]
        } else {
            vec!["127.0.0.1"]
        },
    };
    let (stop, stopped) = watch::channel(None);
    let (finished, completion) = watch::channel(false);
    access.check()?;
    access.with_current(|| {
        registry.flows.insert(
            tunnel.id.clone(),
            Entry {
                tunnel: tunnel.clone(),
                stop,
                finished: completion,
            },
        );
        registry.starts.entry(host_key).or_default().push_back(now);
    })?;
    drop(registry);
    let hosts = match hint.family {
        Some(Family::V6) => vec![HostAddress::V6, HostAddress::V4],
        _ => vec![HostAddress::V4, HostAddress::V6],
    };
    let connect = {
        let (session, access, port) = (session.clone(), access.clone(), hint.port);
        move |address: HostAddress| {
            let (session, access) = (session.clone(), access.clone());
            async move {
                access.check().map_err(|_| ConnectError::Other)?;
                let handle = session.control_handle().map_err(|_| ConnectError::Lost)?;
                if handle.is_closed() {
                    return Err(ConnectError::Lost);
                }
                crate::previews::remote_stream(
                    &handle,
                    &access,
                    address.host(),
                    port,
                    Instant::now() + Duration::from_secs(15),
                )
                .await
                .map_err(|error| classify(&error, &handle))
            }
        }
    };
    let flow = Flow {
        listeners,
        rule: guard::Rule {
            port: device_port,
            path,
        },
        hosts,
        limits: config.limits,
        connect,
        session_ended: session.cancel.subscribe(),
        stop: stopped,
        events: {
            let events = events.clone();
            move |event| {
                let _ = events.send(event);
            }
        },
    };
    let store = tunnels.0.clone();
    let worker_access = access.clone();
    let worker_id = tunnel.id.clone();
    tauri::async_runtime::spawn(async move {
        let reason = tokio::select! { biased;
            _ = worker_access.cancelled() => EndReason::LockEnded,
            reason = run(flow) => reason,
        };
        store.lock().await.flows.remove(&worker_id);
        let _ = events.send(TunnelEvent::Ended { reason });
        let _ = finished.send(true);
    });
    Ok(tunnel)
}

/// Starts the tunnel for one sign-in. The renderer asks only after consent (the user pressed Allow,
/// or the host's saved policy says Always); the checks in [`policy`] hold even then.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_auth_tunnel(
    access: AccessLease,
    state: State<'_, AppState>,
    tunnels: State<'_, AuthTunnelState>,
    previews: State<'_, PreviewState>,
    session_id: String,
    hint: Hint,
    consent: Consent,
    events: Channel<TunnelEvent>,
) -> Protected<AuthTunnel> {
    access
        .run(begin(
            &access,
            &state,
            &tunnels,
            &previews,
            session_id,
            hint,
            consent,
            events,
            Config::default(),
        ))
        .await
}

#[tauri::command]
pub async fn list_auth_tunnels(
    access: AccessLease,
    state: State<'_, AppState>,
    tunnels: State<'_, AuthTunnelState>,
    session_id: String,
) -> Protected<Vec<AuthTunnel>> {
    access
        .run(async {
            state.session(&session_id).await?;
            Ok(tunnels
                .0
                .lock()
                .await
                .flows
                .values()
                .filter(|flow| flow.tunnel.session_id == session_id)
                .map(|flow| flow.tunnel.clone())
                .collect())
        })
        .await
}

#[tauri::command]
pub async fn stop_auth_tunnel(
    tunnels: State<'_, AuthTunnelState>,
    session_id: String,
    tunnel_id: String,
) -> Result<()> {
    let flow = tunnels
        .0
        .lock()
        .await
        .flows
        .get(&tunnel_id)
        .filter(|flow| flow.tunnel.session_id == session_id)
        .map(|flow| (flow.stop.clone(), flow.finished.clone()));
    if let Some((stop, mut finished)) = flow {
        stop.send_replace(Some(EndReason::Cancelled));
        if !*finished.borrow() {
            timeout(Duration::from_secs(2), finished.changed())
                .await
                .map_err(|_| SshError::new("timeout", "Sign-in tunnel shutdown did not finish"))?
                .map_err(|_| {
                    SshError::new(
                        "auth_tunnel_closed",
                        "Sign-in tunnel ended without confirming shutdown",
                    )
                })?;
        }
    }
    Ok(())
}
