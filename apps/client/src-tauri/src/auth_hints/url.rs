//! What a printed URL says about a localhost callback. Only the shape is read: the query's `code`,
//! `state` and every other value are never copied out, so nothing secret can reach a hint.

/// Longest URL accepted (the same bound as `open_web_url`).
pub(super) const MAX_URL: usize = 4096;
const MAX_PATH: usize = 256;
/// Query parameters that carry the address the identity provider sends the browser back to.
const REDIRECT_KEYS: [&str; 6] = [
    "redirect_uri",
    "redirect_url",
    "redirecturi",
    "callback",
    "callback_url",
    "redirect",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Loopback {
    Localhost,
    V4,
    V6,
}
impl Loopback {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Localhost => "localhost",
            Self::V4 => "127.0.0.1",
            Self::V6 => "[::1]",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Target {
    pub host: Loopback,
    pub port: u16,
    pub path: String,
}

/// An authorize URL whose redirect is a localhost callback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Redirect {
    pub target: Target,
    pub idp_host: Option<String>,
    pub pkce: bool,
    /// The redirect is the last query parameter, so a line break could still cut its value short.
    pub last: bool,
}

fn strip_scheme(url: &str) -> Option<(bool, &str)> {
    let head = url.get(..8.min(url.len()))?;
    if head.len() >= 8 && head[..8].eq_ignore_ascii_case("https://") {
        return Some((true, &url[8..]));
    }
    (head.len() >= 7 && head[..7].eq_ignore_ascii_case("http://")).then(|| (false, &url[7..]))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let digits = bytes.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A redirect is encoded once in the query and some programs encode the whole URL twice.
fn decode_twice(value: &str) -> Option<String> {
    let once = percent_decode(value)?;
    if once.contains('%') {
        percent_decode(&once).or(Some(once))
    } else {
        Some(once)
    }
}

/// `http://localhost:PORT[/path]` with PORT 1024 to 65535 and nothing else: no credentials, no query
/// or fragment (the caller cuts those), an optional printable path of at most 256 bytes.
pub(super) fn loopback_target(value: &str) -> Option<Target> {
    let (secure, rest) = strip_scheme(value)?;
    if secure {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let (host, port) = authority.rsplit_once(':')?;
    let host = match host {
        "127.0.0.1" => Loopback::V4,
        "[::1]" => Loopback::V6,
        _ if host.eq_ignore_ascii_case("localhost") => Loopback::Localhost,
        _ => return None,
    };
    if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port.parse().ok().filter(|port| *port >= 1024)?;
    let path = tail.split(['?', '#']).next().unwrap_or_default();
    if path.len() > MAX_PATH || !path.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return None;
    }
    let path = if path.is_empty() { "/" } else { path };
    Some(Target {
        host,
        port,
        path: path.into(),
    })
}

/// Splits `scheme://host[:port]/path?query#fragment` without interpreting it further. A URL with
/// credentials has no host worth reporting.
fn parts(url: &str) -> Option<(&str, &str)> {
    let (_, rest) = strip_scheme(url)?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let tail = &rest[end..];
    let query = tail
        .split_once('?')
        .map_or("", |(_, query)| query.split('#').next().unwrap_or_default());
    Some((authority, query))
}

fn host_of(authority: &str) -> Option<String> {
    let host = if authority.starts_with('[') {
        authority.split_inclusive(']').next()?
    } else {
        authority.split(':').next()?
    };
    let host = host.to_ascii_lowercase();
    (!host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'[' | b']' | b':')))
    .then_some(host)
}

/// An authorize URL (any `http(s)` URL) with a localhost callback in one of the redirect parameters.
pub(super) fn redirect(url: &str) -> Option<Redirect> {
    if url.len() > MAX_URL {
        return None;
    }
    let (authority, query) = parts(url)?;
    let mut target = None;
    let mut pkce = false;
    let mut last = false;
    let pairs = query.split('&').count();
    for (index, pair) in query.split('&').enumerate() {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = key.to_ascii_lowercase();
        if (key == "code_challenge" && !value.is_empty()) || key == "code_challenge_method" {
            pkce = true;
        } else if target.is_none() && REDIRECT_KEYS.contains(&key.as_str()) {
            target = decode_twice(value).and_then(|value| loopback_target(&value));
            last = index + 1 == pairs;
        }
    }
    Some(Redirect {
        target: target?,
        idp_host: host_of(authority),
        pkce,
        last,
    })
}

/// `http://localhost:PORT[/path]` printed as a bare address: no query, no fragment, no credentials.
pub(super) fn bare_origin(url: &str) -> Option<Target> {
    if url.len() > MAX_URL || url.contains(['?', '#']) {
        return None;
    }
    loopback_target(url)
}

/// The last query parameter is a redirect, whatever its value: the URL may be cut inside it.
pub(super) fn ends_in_redirect(url: &str) -> bool {
    parts(url).is_some_and(|(_, query)| {
        let last = query.rsplit('&').next().unwrap_or_default();
        let key = last
            .split_once('=')
            .map_or(last, |(key, _)| key)
            .to_ascii_lowercase();
        REDIRECT_KEYS.contains(&key.as_str())
    })
}
