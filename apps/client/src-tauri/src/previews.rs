use crate::ssh::{AppState, Result, SshError};
use serde::Serialize;
use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};
use tauri::State;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpListener,
    sync::{watch, Mutex, Semaphore},
    task::JoinSet,
    time::timeout,
};

const MAX_FORWARDS: usize = 16;
const MAX_PER_SESSION: usize = 4;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    id: String,
    remote_port: u16,
    remote_address: String,
    local_port: u16,
    url: String,
}
struct Forward {
    session_id: String,
    preview: Preview,
    stop: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
}
#[derive(Clone, Default)]
pub struct PreviewState(Arc<Mutex<HashMap<String, Forward>>>);

#[tauri::command]
pub async fn start_preview(
    state: State<'_, AppState>,
    previews: State<'_, PreviewState>,
    session_id: String,
    remote_port: u16,
    remote_address: Option<String>,
) -> Result<Preview> {
    if remote_port == 0 {
        return Err(SshError::new(
            "invalid_port",
            "Enter a port from 1 to 65535",
        ));
    }
    let remote_address = remote_address.unwrap_or_else(|| "127.0.0.1".into());
    if remote_address != "127.0.0.1" && remote_address != "::1" {
        return Err(SshError::new(
            "invalid_address",
            "Previews can connect only to host loopback addresses",
        ));
    }
    let session = state.session(&session_id).await?;
    let mut forwards = previews.0.lock().await;
    if forwards.len() >= MAX_FORWARDS
        || forwards
            .values()
            .filter(|f| f.session_id == session_id)
            .count()
            >= MAX_PER_SESSION
    {
        return Err(SshError::new(
            "preview_limit",
            "Close a preview before opening another",
        ));
    }
    // Keep the remote port when free, so dev-server redirects retain their port.
    let listener = match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, remote_port)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?,
    };
    let local_port = listener.local_addr()?.port();
    let id = uuid::Uuid::new_v4().to_string();
    let preview = Preview {
        id: id.clone(),
        remote_port,
        remote_address: remote_address.clone(),
        local_port,
        url: format!("http://127.0.0.1:{local_port}/"),
    };
    let (stop, stopped) = watch::channel(false);
    let (finished, completion) = watch::channel(false);
    forwards.insert(
        id.clone(),
        Forward {
            session_id,
            preview: preview.clone(),
            stop,
            finished: completion,
        },
    );
    drop(forwards);
    let store = previews.0.clone();
    let handle = session.handle.clone();
    let cancelled = session.cancel.subscribe();
    tauri::async_runtime::spawn(async move {
        relay_listener(listener, cancelled, stopped, move || {
            let handle = handle.clone();
            let remote_address = remote_address.clone();
            async move {
                let channel = handle
                    .channel_open_direct_tcpip(
                        remote_address,
                        u32::from(remote_port),
                        "127.0.0.1",
                        0,
                    )
                    .await?;
                Ok(channel.into_stream())
            }
        })
        .await;
        store.lock().await.remove(&id);
        let _ = finished.send(true);
    });
    Ok(preview)
}

async fn relay_listener<F, Fut, S>(
    listener: TcpListener,
    mut cancelled: watch::Receiver<bool>,
    mut stopped: watch::Receiver<bool>,
    connect: F,
) where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<S>> + Send + 'static,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let slots = Arc::new(Semaphore::new(16));
    let mut connections = JoinSet::new();
    if *cancelled.borrow() || *stopped.borrow() {
        return;
    }
    loop {
        tokio::select! {
            _ = cancelled.changed() => break,
            _ = stopped.changed() => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept() => {
                let Ok((mut local, _)) = accepted else { break };
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
                let connection = connect();
                connections.spawn(async move {
                    let _slot = slot;
                    let Ok(Ok(mut remote)) = timeout(Duration::from_secs(15), connection).await else { return };
                    // Bound abandoned sockets while allowing dev-server WebSocket sessions.
                    let _ = timeout(Duration::from_secs(3600), tokio::io::copy_bidirectional(&mut local, &mut remote)).await;
                });
            }
        }
    }
    drop(listener);
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

#[tauri::command]
pub async fn list_previews(
    state: State<'_, AppState>,
    previews: State<'_, PreviewState>,
    session_id: String,
) -> Result<Vec<Preview>> {
    state.session(&session_id).await?;
    Ok(previews
        .0
        .lock()
        .await
        .values()
        .filter(|f| f.session_id == session_id)
        .map(|f| f.preview.clone())
        .collect())
}

#[tauri::command]
pub async fn stop_preview(
    previews: State<'_, PreviewState>,
    session_id: String,
    preview_id: String,
) -> Result<()> {
    let forward = previews
        .0
        .lock()
        .await
        .get(&preview_id)
        .filter(|forward| forward.session_id == session_id)
        .map(|forward| (forward.stop.clone(), forward.finished.clone()));
    if let Some((stop, mut finished)) = forward {
        let _ = stop.send(true);
        if !*finished.borrow() {
            timeout(Duration::from_secs(2), finished.changed())
                .await
                .map_err(|_| SshError::new("timeout", "Preview shutdown did not finish"))?
                .map_err(|_| {
                    SshError::new(
                        "preview_closed",
                        "Preview worker ended without confirming shutdown",
                    )
                })?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Listener {
    port: u16,
    address: String,
    process: Option<String>,
    pid: Option<u32>,
    http: Option<bool>,
}
fn parse_listeners(text: &str) -> Vec<Listener> {
    let mut listeners = Vec::new();
    let mut process = None;
    let mut pid = None;
    for line in text.lines().take(4096) {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<u32>().ok();
            process = None;
            continue;
        }
        if let Some(value) = line.strip_prefix('c') {
            process = safe_process(value);
            continue;
        }
        let lsof = line.starts_with('n');
        let address = if let Some(value) = line.strip_prefix('n') {
            value.trim()
        } else if let Some(value) = line.split_whitespace().nth(3) {
            value
        } else {
            continue;
        };
        let Some((host, port)) = address.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port.parse::<u16>() else {
            continue;
        };
        if port == 0
            || !matches!(
                host,
                "127.0.0.1" | "0.0.0.0" | "*" | "[::]" | "[::1]" | "::" | "::1"
            )
        {
            continue;
        }
        if !listeners
            .iter()
            .any(|entry: &Listener| entry.port == port && entry.address == host)
        {
            let ss_process = line
                .split("users:((\"")
                .nth(1)
                .and_then(|tail| tail.split('"').next())
                .and_then(safe_process);
            let ss_pid = line
                .split(",pid=")
                .nth(1)
                .and_then(|tail| tail.split([',', ')']).next())
                .and_then(|value| value.parse().ok());
            listeners.push(Listener {
                port,
                address: host.to_owned(),
                process: if lsof { process.clone() } else { ss_process },
                pid: if lsof { pid } else { ss_pid },
                http: None,
            });
        }
        if listeners.len() == 256 {
            break;
        }
    }
    listeners.sort_by_key(|entry| entry.port);
    listeners
}
fn safe_process(value: &str) -> Option<String> {
    (!value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

#[tauri::command]
pub async fn discover_preview_ports(
    state: State<'_, AppState>,
    session_id: String,
    allow_ports: Option<Vec<u16>>,
    probe_http: Option<bool>,
) -> Result<Vec<Listener>> {
    if allow_ports
        .as_ref()
        .is_some_and(|ports| ports.len() > 1024 || ports.contains(&0))
    {
        return Err(SshError::new(
            "invalid_ports",
            "Choose at most 1024 ports from 1 to 65535",
        ));
    }
    let session = state.session(&session_id).await?;
    if allow_ports.as_ref().is_some_and(Vec::is_empty) {
        return Ok(Vec::new());
    }
    let text = crate::ssh::exec(&session, "if command -v ss >/dev/null 2>&1; then ss -H -ltnp; else lsof -nP -iTCP -sTCP:LISTEN -F pcn; fi".into()).await?;
    let listeners: Vec<_> = parse_listeners(&text)
        .into_iter()
        .filter(|listener| {
            allow_ports
                .as_ref()
                .is_none_or(|ports| ports.contains(&listener.port))
        })
        .collect();
    if !probe_http.unwrap_or(false) {
        return Ok(listeners);
    }
    let mut tasks = JoinSet::new();
    let mut result = Vec::new();
    for mut listener in listeners {
        if tasks.len() == 16 {
            if let Some(Ok(row)) = tasks.join_next().await {
                result.push(row);
            }
        }
        let session = session.clone();
        tasks.spawn(async move {
            let address = if listener.address.contains(':') { "::1" } else { "127.0.0.1" };
            let mut cancel = session.cancel.subscribe();
            let port = listener.port;
            let probe = async {
                let channel = session.handle.channel_open_direct_tcpip(address, u32::from(port), "127.0.0.1", 0).await?;
                read_http_status(channel.into_stream(), address, port).await
            };
            listener.http = Some(if *cancel.borrow() { false } else {
                tokio::select! {
                    _ = cancel.changed() => false,
                    result = timeout(Duration::from_millis(1500), probe) => matches!(result, Ok(Ok(true))),
                }
            });
            listener
        });
    }
    while let Some(Ok(row)) = tasks.join_next().await {
        result.push(row);
    }
    if *session.cancel.borrow() {
        return Err(SshError::new("disconnected", "Session is disconnected"));
    }
    result.sort_by_key(|row| row.port);
    Ok(result)
}

async fn read_http_status<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    address: &str,
    port: u16,
) -> Result<bool> {
    let address = if address.contains(':') {
        format!("[{address}]")
    } else {
        address.to_owned()
    };
    stream
        .write_all(
            format!("HEAD / HTTP/1.1\r\nHost: {address}:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await?;
    let mut status = [0; 12];
    stream.read_exact(&mut status).await?;
    let http = status.starts_with(b"HTTP/1.0 ") || status.starts_with(b"HTTP/1.1 ");
    Ok(http && status[9..].iter().all(u8::is_ascii_digit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpStream;

    #[tokio::test]
    async fn explicit_http_probe_uses_head_and_checks_the_status_line() {
        for (response, expected) in [
            (b"HTTP/1.1 200 OK\r\n\r\n".as_slice(), true),
            (b"HTTP/1.0 404 Not Found\r\n\r\n".as_slice(), true),
            (b"SSH-2.0-OpenSSH_10\r\n".as_slice(), false),
            (b"HTTP/1.1 xyz Bad\r\n\r\n".as_slice(), false),
        ] {
            let (client, mut server) = tokio::io::duplex(1024);
            let peer = tokio::spawn(async move {
                let mut request = [0; 512];
                let count = server.read(&mut request).await.unwrap();
                assert_eq!(
                    &request[..count],
                    b"HEAD / HTTP/1.1\r\nHost: [::1]:3000\r\nConnection: close\r\n\r\n"
                );
                server.write_all(response).await.unwrap();
            });
            assert_eq!(
                read_http_status(client, "::1", 3000).await.unwrap(),
                expected
            );
            peer.await.unwrap();
        }
    }

    #[tokio::test]
    async fn closing_a_preview_requires_the_owning_session() {
        use tauri::Manager;
        let app = tauri::test::mock_app();
        let previews = PreviewState::default();
        let (stop, stopped) = watch::channel(false);
        let (completion, finished) = watch::channel(false);
        previews.0.lock().await.insert(
            "one".into(),
            Forward {
                session_id: "owner".into(),
                preview: Preview {
                    id: "one".into(),
                    remote_port: 3000,
                    remote_address: "127.0.0.1".into(),
                    local_port: 41234,
                    url: "http://127.0.0.1:41234/".into(),
                },
                stop,
                finished,
            },
        );
        app.manage(previews.clone());
        stop_preview(app.state(), "other".into(), "one".into())
            .await
            .unwrap();
        assert!(!*stopped.borrow());
        assert_eq!(previews.0.lock().await.len(), 1);
        let mut closing = Box::pin(stop_preview(app.state(), "owner".into(), "one".into()));
        let result =
            std::future::poll_fn(|context| std::task::Poll::Ready(closing.as_mut().poll(context)))
                .await;
        assert!(
            result.is_pending(),
            "stop must wait for the owning worker to confirm teardown"
        );
        assert!(*stopped.borrow());
        previews.0.lock().await.remove("one");
        completion.send(true).unwrap();
        closing.await.unwrap();
        assert!(previews.0.lock().await.is_empty());
    }

    #[test]
    fn listener_process_fields_follow_ss_and_lsof_records() {
        let rows = parse_listeners("LISTEN 0 4096 127.0.0.1:5173 0.0.0.0:* users:((\"node\",pid=4312,fd=21))\np843\ncVite dev server\nn*:3000\nn[::1]:3000\np100\ncother\nn10.0.0.1:8080");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].process.as_deref(), Some("Vite dev server"));
        assert_eq!(rows[0].pid, Some(843));
        assert_eq!(rows[2].process.as_deref(), Some("node"));
        assert_eq!(rows[2].pid, Some(4312));
    }

    #[test]
    fn listener_discovery_accepts_only_loopback_reachable_addresses() {
        let rows = parse_listeners("LISTEN 0 128 127.0.0.1:5173 0.0.0.0:*\nLISTEN 0 128 10.0.0.8:9000 0.0.0.0:*\nn*:3000\nn[::1]:8000\nn*:3000\nn*:0\nn*:70000");
        assert_eq!(
            rows.iter().map(|v| v.port).collect::<Vec<_>>(),
            [3000, 5173, 8000]
        );
    }

    #[tokio::test]
    async fn relay_limits_connections_and_stop_closes_the_listener() {
        let remote = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let remote_address = remote.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut streams = Vec::new();
            for _ in 0..16 {
                let (mut stream, _) = remote.accept().await.unwrap();
                stream.write_all(&[1]).await.unwrap();
                streams.push(stream);
            }
            std::future::pending::<()>().await;
        });
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let (_cancel, cancelled) = watch::channel(false);
        let (stop, stopped) = watch::channel(false);
        let relay = tokio::spawn(relay_listener(
            listener,
            cancelled,
            stopped,
            move || async move { Ok(TcpStream::connect(remote_address).await?) },
        ));
        let mut clients = Vec::new();
        for _ in 0..16 {
            let mut client = TcpStream::connect(address).await.unwrap();
            let mut byte = [0];
            timeout(Duration::from_secs(2), client.read_exact(&mut byte))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(byte, [1]);
            clients.push(client);
        }
        let mut overflow = TcpStream::connect(address).await.unwrap();
        assert_eq!(
            timeout(Duration::from_secs(2), overflow.read(&mut [0]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        stop.send(true).unwrap();
        timeout(Duration::from_secs(2), relay)
            .await
            .unwrap()
            .unwrap();
        for client in &mut clients {
            assert_eq!(
                timeout(Duration::from_secs(2), client.read(&mut [0]))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        }
        server.abort();
    }

    #[tokio::test]
    async fn loopback_relay_carries_http_and_websocket_bytes_and_cancels_active_streams() {
        let remote = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let remote_address = remote.local_addr().unwrap();
        let echo = tokio::spawn(async move {
            let (mut stream, _) = remote.accept().await.unwrap();
            let mut bytes = [0; 1024];
            loop {
                let count = stream.read(&mut bytes).await.unwrap();
                if count == 0 {
                    break;
                }
                stream.write_all(&bytes[..count]).await.unwrap();
            }
        });
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let (cancel, cancelled) = watch::channel(false);
        let (_stop, stopped) = watch::channel(false);
        let relay = tokio::spawn(relay_listener(
            listener,
            cancelled,
            stopped,
            move || async move { Ok(TcpStream::connect(remote_address).await?) },
        ));
        let mut client = TcpStream::connect(address).await.unwrap();
        for message in [
            b"GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n".as_slice(),
            &[0x81, 0x82, 0, 1, 2, 3, 4, 5],
        ] {
            client.write_all(message).await.unwrap();
            let mut received = vec![0; message.len()];
            timeout(Duration::from_secs(2), client.read_exact(&mut received))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(received, message);
        }
        cancel.send(true).unwrap();
        timeout(Duration::from_secs(2), relay)
            .await
            .unwrap()
            .unwrap();
        let mut remaining = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut remaining))
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(2), echo)
            .await
            .unwrap()
            .unwrap();
    }
}
