//! Optional HTTP/1 instrumentation. The default forward remains byte-transparent.
use super::*;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Body, Bytes, Frame, Incoming, SizeHint},
    header::{self, HeaderMap, HeaderValue},
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    collections::VecDeque,
    convert::Infallible,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::sync::mpsc;

const MAX_HTML: usize = 2 * 1024 * 1024;
const MAX_REQUEST: usize = 10 * 1024 * 1024;
struct Budgets {
    html: Arc<Semaphore>,
    upload: Arc<Semaphore>,
}
const PICKER: &str = include_str!("../../../src/previewPicker.js");

struct Driver(tokio::task::JoinHandle<()>);
impl Drop for Driver {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct ProxyBody {
    prefix: VecDeque<Frame<Bytes>>,
    incoming: Option<Incoming>,
    _driver: Option<Driver>,
    _html: Option<tokio::sync::OwnedSemaphorePermit>,
    _upload: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Body for ProxyBody {
    type Data = Bytes;
    type Error = hyper::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, Self::Error>>> {
        if let Some(frame) = self.prefix.pop_front() {
            return Poll::Ready(Some(Ok(frame)));
        }
        match self.incoming.as_mut() {
            Some(body) => Pin::new(body).poll_frame(cx),
            None => Poll::Ready(None),
        }
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}
fn text_response(status: StatusCode, text: &'static str) -> Response<ProxyBody> {
    let mut response = Response::new(ProxyBody {
        prefix: [Frame::data(Bytes::from_static(text.as_bytes()))].into(),
        incoming: None,
        _driver: None,
        _html: None,
        _upload: None,
    });
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
// Do not let Connection nominate framing, security-policy, or authorization fields.
// Unsupported hop-by-hop extensions fail closed instead of changing their meaning.
fn clean_headers(headers: &mut HeaderMap, websocket: bool) -> std::result::Result<(), ()> {
    for value in headers.get_all(header::CONNECTION) {
        for token in value.to_str().map_err(|_| ())?.split(',').map(str::trim) {
            if !token.eq_ignore_ascii_case("close")
                && !token.eq_ignore_ascii_case("keep-alive")
                && !(websocket && token.eq_ignore_ascii_case("upgrade"))
            {
                return Err(());
            }
        }
    }
    if headers.contains_key(header::TRANSFER_ENCODING)
        && headers.contains_key(header::CONTENT_LENGTH)
    {
        return Err(());
    }
    for name in [
        "connection",
        "proxy-connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
    ] {
        headers.remove(name);
    }
    if websocket {
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    } else {
        headers.remove(header::UPGRADE);
    }
    Ok(())
}
fn websocket(headers: &HeaderMap) -> bool {
    headers.get_all(header::UPGRADE).iter().count() == 1
        && headers
            .get(header::UPGRADE)
            .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
        && headers
            .get(header::CONNECTION)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(',')
                    .any(|s| s.trim().eq_ignore_ascii_case("upgrade"))
            })
}
fn eligible(headers: &HeaderMap, method: &Method, status: StatusCode) -> bool {
    method == Method::GET
        && status == StatusCode::OK
        && !headers.contains_key(header::CONTENT_RANGE)
        && headers
            .get(header::CONTENT_ENCODING)
            .is_none_or(|v| v.as_bytes().eq_ignore_ascii_case(b"identity"))
        && headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                let mut parts = v.split(';').map(str::trim);
                parts
                    .next()
                    .is_some_and(|m| m.eq_ignore_ascii_case("text/html"))
                    && parts.all(|p| {
                        p.eq_ignore_ascii_case("charset=utf-8")
                            || p.eq_ignore_ascii_case("charset=\"utf-8\"")
                    })
            })
        && headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_none_or(|n| n <= MAX_HTML as u64)
}
fn instrument(bytes: &[u8], token: &str) -> Option<Vec<u8>> {
    let _text = std::str::from_utf8(bytes).ok()?;
    // Keep header and meta CSP effective: append after all existing document markup.
    // An upstream policy may intentionally block us; never add a relaxed policy.
    let mut out = Vec::with_capacity(bytes.len() + PICKER.len() + 128);
    out.extend_from_slice(bytes);
    out.extend_from_slice(
        format!("<script data-lazysh-picker=\"{token}\">{PICKER}</script>").as_bytes(),
    );
    Some(out)
}
struct Upgrade {
    client: hyper::upgrade::OnUpgrade,
    remote: hyper::upgrade::OnUpgrade,
    _driver: Driver,
}
async fn request<F, Fut, S>(
    mut req: Request<Incoming>,
    connect: Arc<F>,
    token: String,
    local_port: u16,
    remote_host: String,
    upgrades: mpsc::Sender<Upgrade>,
    budgets: Arc<Budgets>,
) -> Response<ProxyBody>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<S>> + Send,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    if req.uri().scheme().is_some()
        || req.uri().authority().is_some()
        || req.method() == Method::CONNECT
        || req.method() == Method::TRACE
        || req.headers().get_all(header::HOST).iter().count() != 1
        || req
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            != Some(format!("127.0.0.1:{local_port}").as_str())
    {
        return text_response(
            StatusCode::BAD_REQUEST,
            "Only this preview's loopback origin is accepted",
        );
    }
    let is_ws = websocket(req.headers());
    if req.body().size_hint().lower() > MAX_REQUEST as u64 || (is_ws && !req.body().is_end_stream())
    {
        return text_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Request body exceeds the annotation proxy limit",
        );
    }
    let upload_permit = if !req.body().is_end_stream() {
        match budgets.upload.clone().try_acquire_owned() {
            Ok(permit) => Some(permit),
            Err(_) => {
                return text_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Two preview uploads are already active",
                )
            }
        }
    } else {
        None
    };
    if clean_headers(req.headers_mut(), is_ws).is_err() {
        return text_response(StatusCode::BAD_REQUEST, "Unsupported proxy headers");
    }
    if is_ws && req.method() != Method::GET {
        return text_response(StatusCode::BAD_REQUEST, "Invalid WebSocket request");
    }
    let client_upgrade = is_ws.then(|| hyper::upgrade::on(&mut req));
    let method = req.method().clone();
    let (mut parts, body) = req.into_parts();
    let Ok(Ok(body)) = timeout(
        Duration::from_secs(15),
        Limited::new(body, MAX_REQUEST).collect(),
    )
    .await
    else {
        return text_response(StatusCode::PAYLOAD_TOO_LARGE, "Request exceeds the annotation proxy limit; use the ordinary preview for large uploads");
    };
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::HOST,
        HeaderValue::from_str(&remote_host).expect("fixed loopback host"),
    );
    parts.headers.insert(
        header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );
    let req = Request::from_parts(parts, Full::new(body.to_bytes()));
    let Ok(Ok(remote)) = timeout(Duration::from_secs(15), connect()).await else {
        return text_response(
            StatusCode::BAD_GATEWAY,
            "The host development server is unavailable",
        );
    };
    let Ok((mut sender, connection)) = hyper::client::conn::http1::Builder::new()
        .max_buf_size(64 * 1024)
        .max_headers(64)
        .handshake(TokioIo::new(remote))
        .await
    else {
        return text_response(StatusCode::BAD_GATEWAY, "Invalid host HTTP response");
    };
    let driver = Driver(tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    }));
    let Ok(Ok(mut response)) = timeout(Duration::from_secs(15), sender.send_request(req)).await
    else {
        return text_response(
            StatusCode::BAD_GATEWAY,
            "The host HTTP response timed out or was invalid",
        );
    };
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        if !is_ws
            || !websocket(response.headers())
            || clean_headers(response.headers_mut(), true).is_err()
        {
            return text_response(StatusCode::BAD_GATEWAY, "Unsupported host upgrade");
        }
        let remote = hyper::upgrade::on(&mut response);
        if upgrades
            .try_send(Upgrade {
                client: client_upgrade.expect("validated upgrade"),
                remote,
                _driver: driver,
            })
            .is_err()
        {
            return text_response(StatusCode::BAD_GATEWAY, "Upgrade unavailable");
        }
        let (parts, _) = response.into_parts();
        return Response::from_parts(
            parts,
            ProxyBody {
                prefix: VecDeque::new(),
                incoming: None,
                _driver: None,
                _html: None,
                _upload: None,
            },
        );
    }
    if clean_headers(response.headers_mut(), false).is_err() {
        return text_response(StatusCode::BAD_GATEWAY, "Unsupported host proxy headers");
    }
    let html_permit = eligible(response.headers(), &method, response.status())
        .then(|| budgets.html.clone().try_acquire_owned().ok())
        .flatten();
    let inject = html_permit.is_some();
    let (mut parts, mut body) = response.into_parts();
    let mut prefix = VecDeque::new();
    if inject {
        let mut bytes = Vec::new();
        let result = timeout(Duration::from_secs(15), async {
            while let Some(frame) = body.frame().await {
                let frame = frame?;
                if let Some(data) = frame.data_ref() {
                    bytes.extend_from_slice(data);
                }
                prefix.push_back(frame);
                if bytes.len() > MAX_HTML {
                    return Ok::<bool, hyper::Error>(false);
                }
            }
            Ok(true)
        })
        .await;
        match result {
            Ok(Ok(true)) => {
                if let Some(html) = instrument(&bytes, &token) {
                    prefix = [Frame::data(Bytes::from(html))].into();
                    for name in [
                        "content-length",
                        "etag",
                        "last-modified",
                        "content-md5",
                        "digest",
                        "content-digest",
                        "repr-digest",
                    ] {
                        parts.headers.remove(name);
                    }
                    parts
                        .headers
                        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                }
                return Response::from_parts(
                    parts,
                    ProxyBody {
                        prefix,
                        incoming: None,
                        _driver: Some(driver),
                        _html: html_permit,
                        _upload: upload_permit,
                    },
                );
            }
            Ok(Ok(false)) => {}
            _ => {
                return text_response(
                    StatusCode::BAD_GATEWAY,
                    "The host HTML response timed out or was invalid",
                )
            }
        }
    }
    Response::from_parts(
        parts,
        ProxyBody {
            prefix,
            incoming: Some(body),
            _driver: Some(driver),
            _html: html_permit,
            _upload: upload_permit,
        },
    )
}

// Hyper deliberately normalizes some RFC-permitted framing combinations. Inspect the
// original first request before that normalization and close ordinary connections
// after one response, so a second uninspected request can never reach the host.
async fn request_head(io: &mut tokio::net::TcpStream) -> std::io::Result<Vec<u8>> {
    let invalid = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid preview request headers",
        )
    };
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 1024];
        let count = io.read(&mut chunk).await?;
        if count == 0 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            if end > 64 * 1024 {
                return Err(invalid());
            }
            let head = std::str::from_utf8(&bytes[..end]).map_err(|_| invalid())?;
            let mut lengths = 0;
            let mut encodings = 0;
            let mut fields = 0;
            for line in head.split("\r\n").skip(1) {
                fields += 1;
                let (name, _) = line.split_once(':').ok_or_else(invalid)?;
                if name.is_empty()
                    || name
                        .bytes()
                        .any(|b| !b.is_ascii_alphanumeric() && !b"!#$%&'*+-.^_`|~".contains(&b))
                {
                    return Err(invalid());
                }
                if name.eq_ignore_ascii_case("content-length") {
                    lengths += 1;
                }
                if name.eq_ignore_ascii_case("transfer-encoding") {
                    encodings += 1;
                }
            }
            if fields > 64 || lengths > 1 || encodings > 1 || (lengths > 0 && encodings > 0) {
                return Err(invalid());
            }
            return Ok(bytes);
        }
        if bytes.len() > 64 * 1024 {
            return Err(invalid());
        }
    }
}
struct Prefixed<S> {
    prefix: std::io::Cursor<Vec<u8>>,
    io: S,
}
impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let position = self.prefix.position() as usize;
        if position < self.prefix.get_ref().len() {
            let count = buffer
                .remaining()
                .min(self.prefix.get_ref().len() - position);
            buffer.put_slice(&self.prefix.get_ref()[position..position + count]);
            self.prefix.set_position((position + count) as u64);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.io).poll_read(cx, buffer)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

pub(super) async fn listener<F, Fut, S>(
    listener: TcpListener,
    mut cancelled: watch::Receiver<bool>,
    mut stopped: watch::Receiver<bool>,
    token: String,
    remote_host: String,
    connect: F,
) where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<S>> + Send,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let local_port = listener.local_addr().expect("bound listener").port();
    let connect = Arc::new(connect);
    let slots = Arc::new(Semaphore::new(16));
    let budgets = Arc::new(Budgets {
        html: Arc::new(Semaphore::new(4)),
        upload: Arc::new(Semaphore::new(2)),
    });
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
                let Ok((local, _)) = accepted else { break };
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
                let connect = connect.clone(); let token = token.clone(); let remote_host = remote_host.clone(); let budgets = budgets.clone();
                connections.spawn(async move {
                    let _slot = slot;
                    let mut local = local;
                    let Ok(Ok(prefix)) = timeout(Duration::from_secs(5), request_head(&mut local)).await else {
                        let _ = local.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                        return;
                    };
                    let local = Prefixed { prefix: std::io::Cursor::new(prefix), io: local };
                    let (upgrades, mut upgraded) = mpsc::channel(1);
                    let service = service_fn(move |req| {
                        let connect = connect.clone(); let token = token.clone(); let remote_host = remote_host.clone(); let upgrades = upgrades.clone(); let budgets = budgets.clone();
                        async move { Ok::<_, Infallible>(request(req, connect, token, local_port, remote_host, upgrades, budgets).await) }
                    });
                    let mut builder = hyper::server::conn::http1::Builder::new();
                    builder.keep_alive(false).timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(5)).max_buf_size(64 * 1024).max_headers(64);
                    let _ = timeout(Duration::from_secs(3600), async {
                        let _ = builder.serve_connection(TokioIo::new(local), service).with_upgrades().await;
                        if let Some(upgrade) = upgraded.recv().await {
                            let (Ok(client), Ok(remote)) = tokio::join!(upgrade.client, upgrade.remote) else { return };
                            let _driver = upgrade._driver;
                            let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(client), &mut TokioIo::new(remote)).await;
                        }
                    }).await;
                });
            }
        }
    }
    drop(listener);
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests;
