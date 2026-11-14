//! The request guard in front of every sign-in tunnel connection. Another app or a web page on the
//! device can connect to the tunnel's loopback port, so nothing reaches the host until the first
//! request parses as one browser navigation to the flow's callback path. Everything else is
//! answered here and never forwarded.
use std::time::Duration;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    time::{timeout_at, Instant},
};

/// The request line and fields must fit in this many bytes.
pub(super) const MAX_HEAD: usize = 16 * 1024;
/// Head and body together.
pub(super) const MAX_REQUEST: usize = 64 * 1024;
const MAX_TARGET: usize = 2048;

/// What the flow accepts: the port every `Host` must name and the path the callback lives under.
pub(super) struct Rule {
    pub(super) port: u16,
    pub(super) path: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Refusal {
    Malformed,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    Timeout,
    Misdirected,
    TooLarge,
    HeadTooLarge,
}
impl Refusal {
    /// A complete response with fixed text: no part of the refused request is echoed back.
    pub(super) fn response(&self) -> String {
        let (status, text) = match self {
            Self::Malformed => ("400 Bad Request", "This is not a sign-in callback request."),
            Self::Forbidden => (
                "403 Forbidden",
                "Only a browser navigation is accepted here.",
            ),
            Self::NotFound => ("404 Not Found", "This path is not the sign-in callback."),
            Self::MethodNotAllowed => ("405 Method Not Allowed", "Use GET or POST."),
            Self::Timeout => ("408 Request Timeout", "The request did not arrive in time."),
            Self::Misdirected => (
                "421 Misdirected Request",
                "This is not the sign-in address.",
            ),
            Self::TooLarge => ("413 Content Too Large", "The request is too large."),
            Self::HeadTooLarge => (
                "431 Request Header Fields Too Large",
                "The request is too large.",
            ),
        };
        response(status, text)
    }
}
/// A local answer in the one shape every tunnel reply has (never cached, always closing).
pub(super) fn response(status: &str, text: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{text}",
        text.len()
    )
}

/// One checked request, ready for the host.
pub(super) struct Admitted {
    /// The request line and fields with `Connection: close`, then the whole body. Bytes that
    /// followed the request on the connection (a pipelined second request) are not here.
    pub(super) bytes: Vec<u8>,
    /// The request carries an authorization `code` or `error`, or is a POST.
    pub(super) callback: bool,
}

struct Inspected {
    head_len: usize,
    head: Vec<u8>,
    body_len: usize,
    callback: bool,
}

const FORBIDDEN_ESCAPES: [&str; 5] = ["%2e", "%2f", "%5c", "%00", "%25"];

fn inside(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    root.is_empty()
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `Ok(None)` while the head is incomplete.
fn inspect(buffer: &[u8], rule: &Rule) -> Result<Option<Inspected>, Refusal> {
    let mut fields = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut fields);
    let head_len = match request.parse(buffer) {
        Ok(httparse::Status::Complete(length)) => length,
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(httparse::Error::TooManyHeaders) => return Err(Refusal::HeadTooLarge),
        Err(_) => return Err(Refusal::Malformed),
    };
    let method = request.method.unwrap_or_default();
    if method != "GET" && method != "POST" {
        return Err(Refusal::MethodNotAllowed);
    }
    let target = request.path.unwrap_or_default();
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    // Origin form only: no scheme, no network-path reference, no fragment, no escapes that hide
    // a separator or a dot segment.
    if !target.starts_with('/')
        || target.starts_with("//")
        || target.len() > MAX_TARGET
        || !target.bytes().all(|byte| (0x21..0x7f).contains(&byte))
        || target.contains(['#', '\\'])
    {
        return Err(Refusal::Malformed);
    }
    let lowered = path.to_ascii_lowercase();
    if FORBIDDEN_ESCAPES
        .iter()
        .any(|escape| lowered.contains(escape))
        || path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        || !inside(path, &rule.path)
    {
        return Err(Refusal::NotFound);
    }
    let minor = request.version.unwrap_or(1);
    let mut hosts = request
        .headers
        .iter()
        .filter(|field| field.name.eq_ignore_ascii_case("host"));
    let (Some(host), None) = (hosts.next(), hosts.next()) else {
        return Err(Refusal::Malformed);
    };
    let host = std::str::from_utf8(host.value)
        .map_err(|_| Refusal::Malformed)?
        .trim()
        .to_ascii_lowercase();
    // A browser leaves the port out of `Host` when it is the scheme's default.
    let port = rule.port;
    let named = |name: &str| host == format!("{name}:{port}") || (port == 80 && host == name);
    if !(named("localhost") || named("127.0.0.1") || named("[::1]")) {
        return Err(Refusal::Misdirected);
    }
    let mut body_len = None;
    let mut head = format!("{method} {target} HTTP/1.{minor}\r\n").into_bytes();
    for field in request.headers.iter() {
        let name = field.name.to_ascii_lowercase();
        match name.as_str() {
            "upgrade" | "transfer-encoding" | "expect" | "http2-settings" => {
                return Err(Refusal::Malformed)
            }
            "sec-fetch-mode" if !field.value.eq_ignore_ascii_case(b"navigate") => {
                return Err(Refusal::Forbidden)
            }
            "content-length" => {
                let digits = std::str::from_utf8(field.value)
                    .map_err(|_| Refusal::Malformed)?
                    .trim();
                if body_len.is_some()
                    || digits.is_empty()
                    || digits.len() > 9
                    || !digits.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return Err(Refusal::Malformed);
                }
                body_len = Some(digits.parse::<usize>().map_err(|_| Refusal::Malformed)?);
            }
            // Hop-by-hop fields describe the browser's connection, not the host's.
            "connection"
            | "keep-alive"
            | "proxy-connection"
            | "proxy-authorization"
            | "te"
            | "trailer" => continue,
            _ => {}
        }
        head.extend_from_slice(field.name.as_bytes());
        head.extend_from_slice(b": ");
        head.extend_from_slice(field.value);
        head.extend_from_slice(b"\r\n");
    }
    head.extend_from_slice(b"Connection: close\r\n\r\n");
    let body_len = body_len.unwrap_or(0);
    if method == "GET" && body_len > 0 {
        return Err(Refusal::Malformed);
    }
    if head_len + body_len > MAX_REQUEST {
        return Err(Refusal::TooLarge);
    }
    let callback = method == "POST"
        || query
            .split('&')
            .any(|pair| matches!(pair.split('=').next(), Some("code" | "error")));
    Ok(Some(Inspected {
        head_len,
        head,
        body_len,
        callback,
    }))
}

/// At least one and at most `wanted` bytes; the peer closing early or the deadline passing refuses.
async fn read_some<R: AsyncRead + Unpin>(
    io: &mut R,
    wanted: usize,
    deadline: Instant,
) -> Result<Vec<u8>, Refusal> {
    let mut chunk = vec![0; wanted];
    let count = timeout_at(deadline, io.read(&mut chunk))
        .await
        .map_err(|_| Refusal::Timeout)?
        .map_err(|_| Refusal::Malformed)?;
    if count == 0 {
        return Err(Refusal::Malformed);
    }
    chunk.truncate(count);
    Ok(chunk)
}

/// Reads the first request of a connection, which must be complete within `deadline`.
pub(super) async fn admit<R: AsyncRead + Unpin>(
    io: &mut R,
    rule: &Rule,
    deadline: Instant,
) -> Result<Admitted, Refusal> {
    let mut buffer = Vec::with_capacity(2048);
    let inspected = loop {
        let wanted = MAX_HEAD.saturating_sub(buffer.len()).min(4096);
        if wanted == 0 {
            return Err(Refusal::HeadTooLarge);
        }
        buffer.extend_from_slice(&read_some(io, wanted, deadline).await?);
        if let Some(inspected) = inspect(&buffer, rule)? {
            break inspected;
        }
    };
    let mut body = buffer.split_off(inspected.head_len);
    body.truncate(inspected.body_len);
    while body.len() < inspected.body_len {
        let wanted = (inspected.body_len - body.len()).min(4096);
        body.extend_from_slice(&read_some(io, wanted, deadline).await?);
    }
    let mut bytes = inspected.head;
    bytes.extend_from_slice(&body);
    Ok(Admitted {
        bytes,
        callback: inspected.callback,
    })
}

/// How long the guard waits for a complete head unless a test shortens it.
pub(super) const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
