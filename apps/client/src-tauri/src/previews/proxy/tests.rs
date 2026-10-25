use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::net::TcpStream;
struct Fixture {
    port: u16,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
    upstream: tokio::task::JoinHandle<()>,
    calls: Arc<AtomicUsize>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        self.task.abort();
        self.upstream.abort();
    }
}
async fn fixture(response: Vec<u8>, upgrade: bool) -> Fixture {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let remote = upstream.local_addr().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let upstream = tokio::spawn(async move {
        loop {
            let (mut stream, _) = upstream.accept().await.unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            let mut headers = Vec::new();
            loop {
                headers.push(stream.read_u8().await.unwrap());
                if headers.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            assert!(String::from_utf8_lossy(&headers)
                .contains(&format!("host: 127.0.0.1:{}", remote.port())));
            stream.write_all(&response).await.unwrap();
            if upgrade {
                let mut bytes = [0; 6];
                stream.read_exact(&mut bytes).await.unwrap();
                stream.write_all(&bytes).await.unwrap();
            }
        }
    });
    let local = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = local.local_addr().unwrap().port();
    let (cancel, cancelled) = watch::channel(false);
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(async move {
        let _cancel = cancel;
        listener(
            local,
            cancelled,
            stopped,
            "11111111-1111-4111-8111-111111111111".into(),
            format!("127.0.0.1:{}", remote.port()),
            move || async move { Ok(TcpStream::connect(remote).await?) },
        )
        .await;
    });
    Fixture {
        port,
        stop,
        task,
        upstream,
        calls,
    }
}
fn response(headers: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{headers}\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}
async fn get(f: &Fixture) -> reqwest::Response {
    reqwest::get(format!("http://127.0.0.1:{}/login", f.port))
        .await
        .unwrap()
}
#[tokio::test]
async fn html_injection_preserves_security_headers_and_fixed_upstream_target() {
    let html = b"<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"></head><body><button>Save</button></body></html>";
    let f = fixture(response("Content-Type: text/html; charset=utf-8\r\nContent-Security-Policy: script-src 'none'; frame-ancestors 'none'\r\nX-Frame-Options: DENY\r\nETag: original\r\n", html), false).await;
    let r = get(&f).await;
    assert_eq!(
        r.headers()["content-security-policy"],
        "script-src 'none'; frame-ancestors 'none'"
    );
    assert_eq!(r.headers()["x-frame-options"], "DENY");
    assert_eq!(r.headers()["cache-control"], "no-store");
    assert!(!r.headers().contains_key("etag"));
    let bytes = r.bytes().await.unwrap();
    assert!(
        bytes.starts_with(html),
        "meta policies must occur before injected picker"
    );
    assert!(String::from_utf8_lossy(&bytes)
        .contains("data-lazysh-picker=\"11111111-1111-4111-8111-111111111111\""));
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn unsupported_html_and_other_assets_remain_byte_exact() {
    for (headers, body) in [
        (
            "Content-Type: text/html\r\nContent-Encoding: gzip\r\n",
            b"compressed bytes".to_vec(),
        ),
        (
            "Content-Type: text/html; charset=iso-8859-1\r\n",
            b"legacy page".to_vec(),
        ),
        ("Content-Type: text/html\r\n", vec![0xff, 0xfe, 0x80]),
        (
            "Content-Type: application/javascript\r\n",
            b"console.log('asset')".to_vec(),
        ),
        ("Content-Type: text/html\r\n", vec![b'x'; MAX_HTML + 1]),
    ] {
        let f = fixture(response(headers, &body), false).await;
        assert_eq!(get(&f).await.bytes().await.unwrap().as_ref(), body);
    }
    let body = vec![b'x'; MAX_HTML + 1];
    let mut wire = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
        body.len()
    )
    .into_bytes();
    wire.extend_from_slice(&body);
    wire.extend_from_slice(b"\r\n0\r\n\r\n");
    let f = fixture(wire, false).await;
    assert_eq!(get(&f).await.bytes().await.unwrap().as_ref(), body);
}
#[tokio::test]
async fn hostile_authority_hop_headers_and_ambiguous_framing_do_not_reach_host() {
    let f = fixture(response("Content-Type: text/plain\r\n", b"ok"), false).await;
    for request in [
        format!("GET http://evil.example/ HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n", f.port),
        "GET / HTTP/1.1\r\nHost: evil.example\r\n".into(),
        format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: authorization\r\n", f.port),
        format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nTransfer-Encoding: chunked\r\nContent-Length: 9\r\n", f.port),
        format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nContent-Length: 1\r\n", f.port),
    ] {
        let mut client = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap(); client.write_all(format!("{request}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut status = [0; 12]; timeout(Duration::from_secs(2), client.read_exact(&mut status)).await.unwrap().unwrap(); assert_eq!(&status, b"HTTP/1.1 400");
    }
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn websocket_upgrade_relays_bytes_and_stop_closes_active_socket() {
    let f = fixture(
        b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
            .to_vec(),
        true,
    )
    .await;
    let mut client = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    client.write_all(format!("GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", f.port).as_bytes()).await.unwrap();
    let mut headers = Vec::new();
    loop {
        headers.push(
            timeout(Duration::from_secs(2), client.read_u8())
                .await
                .unwrap()
                .unwrap(),
        );
        if headers.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    assert!(headers.starts_with(b"HTTP/1.1 101"));
    let frame = [0x81, 0x80, 0x01, 0x02, 0x03, 0x04];
    client.write_all(&frame).await.unwrap();
    let mut echoed = [0; 6];
    timeout(Duration::from_secs(2), client.read_exact(&mut echoed))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(echoed, frame);
    f.stop.send(true).unwrap();
    assert_eq!(
        timeout(Duration::from_secs(2), client.read(&mut [0]))
            .await
            .unwrap()
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn declared_oversized_request_is_rejected_without_collecting_or_contacting_host() {
    let f = fixture(response("Content-Type: text/plain\r\n", b"ok"), false).await;
    let mut client = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    client.write_all(format!("POST /upload HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", f.port, MAX_REQUEST + 1).as_bytes()).await.unwrap();
    let mut status = [0; 12];
    timeout(Duration::from_secs(2), client.read_exact(&mut status))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&status, b"HTTP/1.1 413");
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn body_permits_remain_held_until_upstream_response_and_release_on_cancel() {
    let remote = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = remote.local_addr().unwrap();
    let local = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = local.local_addr().unwrap().port();
    let (cancel, cancelled) = watch::channel(false);
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(listener(
        local,
        cancelled,
        stopped,
        "11111111-1111-4111-8111-111111111111".into(),
        address.to_string(),
        move || async move { Ok(TcpStream::connect(address).await?) },
    ));
    let client = reqwest::Client::new();
    let mut sends = Vec::new();
    for _ in 0..2 {
        let client = client.clone();
        sends.push(tokio::spawn(async move {
            client
                .post(format!("http://127.0.0.1:{port}/upload"))
                .body("x")
                .send()
                .await
        }));
    }
    let mut peers = Vec::new();
    for _ in 0..2 {
        let (mut peer, _) = timeout(Duration::from_secs(2), remote.accept())
            .await
            .unwrap()
            .unwrap();
        let mut head = Vec::new();
        loop {
            head.push(peer.read_u8().await.unwrap());
            if head.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        assert_eq!(peer.read_u8().await.unwrap(), b'x');
        peers.push(peer);
    }
    let busy = client
        .post(format!("http://127.0.0.1:{port}/upload"))
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(busy.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    stop.send(true).unwrap();
    timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    for peer in &mut peers {
        assert_eq!(
            timeout(Duration::from_secs(2), peer.read(&mut [0]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
    for send in sends {
        let _ = send.await.unwrap();
    }
    drop(cancel);
}
