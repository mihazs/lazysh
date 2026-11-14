//! What the tunnel tests share: the host's side of a sign-in, a fake OAuth callback server such as the
//! one `aws sso login` or `codex login` starts on the host's loopback, and the device's side, a
//! browser's request. The server records every request it receives, so a test can prove what
//! reached the host and, as important, what did not.
use super::TunnelEvent;
use std::{
    net::IpAddr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::timeout,
};

pub(crate) const CODE: &str = "c0de-SECRET-9f2a";
pub(crate) const STATE: &str = "st4te-SECRET-77b1";
pub(crate) const CALLBACK: &str = "/oauth/callback";

/// What a browser sends to the callback address; `extra` adds header lines.
pub(crate) fn callback_request(port: u16, target: &str, extra: &str) -> Vec<u8> {
    format!("GET {target} HTTP/1.1\r\nHost: localhost:{port}\r\nUser-Agent: test\r\n{extra}\r\n")
        .into_bytes()
}

/// Sends `bytes` to the device address and returns everything the tunnel answers before it closes.
pub(crate) async fn exchange(address: IpAddr, port: u16, bytes: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect((address, port)).await.unwrap();
    stream.write_all(bytes).await.unwrap();
    let mut out = Vec::new();
    let _ = timeout(Duration::from_secs(5), stream.read_to_end(&mut out))
        .await
        .expect("the tunnel must answer");
    out
}

pub(crate) fn status(response: &[u8]) -> String {
    String::from_utf8_lossy(response)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// A channel that records what a flow reports, as the renderer would receive it.
pub(crate) fn event_log() -> (Channel<TunnelEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(text) = body {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(&text).unwrap());
        }
        Ok(())
    });
    (channel, seen)
}

/// Waits for the first recorded event that satisfies `wanted`.
pub(crate) async fn event_where(
    seen: &Arc<Mutex<Vec<serde_json::Value>>>,
    wanted: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    timeout(Duration::from_secs(10), async {
        loop {
            if let Some(found) = seen.lock().unwrap().iter().find(|event| wanted(event)) {
                return found.clone();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the expected tunnel event did not arrive")
}

pub(crate) enum Behaviour {
    /// Read one request, answer with a body of this many bytes and close, as the CLI's server does.
    Answer(usize),
    /// Say something that is not HTTP and keep the connection, like an SSH or database server.
    Banner,
    /// Accept and never answer, to hold connection slots.
    Hold,
}

pub(crate) struct CallbackServer {
    pub(crate) port: u16,
    requests: Arc<Mutex<Vec<Vec<u8>>>>,
    pub(crate) accepted: Arc<AtomicUsize>,
    /// Connections that are still open on the server's side.
    pub(crate) open: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}
impl CallbackServer {
    pub(crate) async fn start(behaviour: Behaviour) -> Self {
        Self::on(IpAddr::from([127, 0, 0, 1]), behaviour).await
    }
    /// `address` picks the bind the CLI uses: `127.0.0.1`, `::1` or the wildcard `0.0.0.0`.
    pub(crate) async fn on(address: IpAddr, behaviour: Behaviour) -> Self {
        let listener = TcpListener::bind((address, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (accepted, open) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let behaviour = Arc::new(behaviour);
        let task = tokio::spawn({
            let (requests, accepted, open) = (requests.clone(), accepted.clone(), open.clone());
            async move {
                while let Ok((mut stream, _)) = listener.accept().await {
                    accepted.fetch_add(1, Ordering::SeqCst);
                    open.fetch_add(1, Ordering::SeqCst);
                    let (requests, open, behaviour) =
                        (requests.clone(), open.clone(), behaviour.clone());
                    tokio::spawn(async move {
                        match &*behaviour {
                            Behaviour::Answer(size) => {
                                let request = read_request(&mut stream).await;
                                requests.lock().unwrap().push(request);
                                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n");
                                let _ = stream.write_all(head.as_bytes()).await;
                                let _ = stream.write_all(&vec![b'x'; *size]).await;
                            }
                            Behaviour::Banner => {
                                let _ = stream.write_all(b"SSH-2.0-OpenSSH_9.9\r\n").await;
                                std::future::pending::<()>().await;
                            }
                            Behaviour::Hold => std::future::pending::<()>().await,
                        }
                        open.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            }
        });
        Self {
            port,
            requests,
            accepted,
            open,
            task,
        }
    }
    /// The requests that reached the server, as text.
    pub(crate) fn requests(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .collect()
    }
}
impl Drop for CallbackServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Reads one HTTP request, with its body, the way a callback server does.
async fn read_request(stream: &mut TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let count = stream.read(&mut chunk).await.unwrap_or(0);
        if count == 0 {
            return bytes;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .map_or(0, |value| value.trim().parse::<usize>().unwrap());
            if bytes.len() >= end + 4 + length {
                return bytes;
            }
        }
    }
}
