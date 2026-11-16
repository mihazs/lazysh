//! What the desktop receivers for the user's own Gotify and ntfy servers share: the relay's
//! closed event window, finite failure classes, one bounded read judged by the server's own
//! clock, and the polling loop. Neither receiver shows anything of an event but its arrival.
use crate::{gotify, ntfy};
use chrono::{DateTime, Utc};
use reqwest::header::DATE;
use serde::{Deserialize, Serialize};
use std::{future::Future, time::Duration};

pub(crate) const MAX_BODY: usize = 1024 * 1024;
/// The relay's own bound for an event: 300 seconds from issuance.
pub(crate) const EXPIRY_SECONDS: i64 = 300;
const FUTURE_SECONDS: i64 = 60;

/// Finite failure classes; never the server's text, URL or token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PollError {
    Unauthorized,
    Unreachable,
    Invalid,
}
impl PollError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Unreachable => "unreachable",
            Self::Invalid => "invalid",
        }
    }
}

/// Access tokens are opaque printable ASCII, as the relay accepts them.
pub fn valid_access_token(value: &str) -> bool {
    (1..=512).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_graphic())
}

/// The public alias the relay puts in an event: one to 64 letters, digits, spaces, `_`, `-` or `.`.
pub(crate) fn public_alias(alias: &str) -> bool {
    (1..=64).contains(&alias.len())
        && alias
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" _-.".contains(&byte))
}

/// An event's age on the server's own clock is inside the relay's bound.
pub(crate) fn fresh(age_seconds: i64) -> bool {
    (-FUTURE_SECONDS..=EXPIRY_SECONDS).contains(&age_seconds)
}

/// One GET: the body (at most [`MAX_BODY`]) and the server's clock. Events are compared against
/// the server's `Date` header and only fall back to ours; a skewed desktop clock must not
/// silently drop them.
pub(crate) async fn fetch(
    request: reqwest::RequestBuilder,
) -> Result<(Vec<u8>, DateTime<Utc>), PollError> {
    let mut response = request.send().await.map_err(|_| PollError::Unreachable)?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err(PollError::Unauthorized),
        _ => return Err(PollError::Unreachable),
    }
    let reference = response
        .headers()
        .get(DATE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| DateTime::parse_from_rfc2822(value).ok())
        .map_or_else(Utc::now, |date| date.with_timezone(&Utc));
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| PollError::Unreachable)? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(PollError::Invalid);
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, reference))
}

/// A source the desktop can poll; each poll reports how many new attention events arrived.
pub trait Poller: Send {
    fn poll_new(&mut self) -> impl Future<Output = Result<usize, PollError>> + Send;
}

/// Polls until the future is dropped (or the server rejects the token), reporting every
/// outcome as the number of new attention events. Failures back off up to 16 times `interval`.
pub async fn watch(
    mut source: impl Poller,
    interval: Duration,
    mut report: impl FnMut(Result<usize, PollError>),
) {
    let mut failures = 0u32;
    loop {
        let outcome = source.poll_new().await;
        failures = if outcome.is_ok() {
            0
        } else {
            failures.saturating_add(1)
        };
        let rejected = outcome.as_ref().err() == Some(&PollError::Unauthorized);
        report(outcome);
        if rejected {
            return;
        }
        tokio::time::sleep(interval * 2u32.pow(failures.min(4))).await;
    }
}

/// Which server the desktop reads. Gotify is the default, so a saved setting without it is Gotify.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Gotify,
    Ntfy,
}
impl Provider {
    pub fn is_gotify(&self) -> bool {
        *self == Self::Gotify
    }
    /// The finite code of the first rejected credential field, or none. Gotify needs a client
    /// token; ntfy needs a topic and may run without a token.
    pub fn check(self, topic: &str, token: &str) -> Result<(), &'static str> {
        match self {
            Self::Gotify if !valid_access_token(token) => Err("token"),
            Self::Ntfy if !ntfy::valid_topic(topic) => Err("topic"),
            Self::Ntfy if !token.is_empty() && !valid_access_token(token) => Err("token"),
            _ => Ok(()),
        }
    }
}

/// A reader for whichever server the user chose.
pub enum Receiver {
    Gotify(gotify::Reader),
    Ntfy(ntfy::Reader),
}
impl Receiver {
    pub fn open(
        server: Provider,
        client: reqwest::Client,
        origin: &str,
        topic: &str,
        token: &str,
    ) -> Result<Self, String> {
        match server {
            Provider::Gotify => gotify::Reader::new(client, origin, token).map(Self::Gotify),
            Provider::Ntfy => ntfy::Reader::new(client, origin, topic, token).map(Self::Ntfy),
        }
    }
}
impl Poller for Receiver {
    async fn poll_new(&mut self) -> Result<usize, PollError> {
        match self {
            Self::Gotify(reader) => reader.poll_new().await,
            Self::Ntfy(reader) => reader.poll_new().await,
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use axum::{
        http::{header, HeaderMap, StatusCode},
        response::IntoResponse,
        routing::get,
        Router,
    };
    use chrono::{DateTime, Utc};
    use reqwest::Url;
    use std::sync::{Arc, Mutex};

    /// The fixed instant that the reader tests treat as the server's current time.
    pub(crate) fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-14T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    /// Serves the bodies in order (the last repeats) at `path` on loopback HTTP, with the
    /// `Date` header when given, and records the headers of every request.
    pub(crate) async fn serve(
        path: &'static str,
        status: StatusCode,
        bodies: Vec<String>,
        date: Option<&'static str>,
    ) -> (Url, Arc<Mutex<Vec<HeaderMap>>>) {
        let seen = Arc::new(Mutex::new(vec![]));
        let record = seen.clone();
        let app = Router::new().route(
            path,
            get(move |headers: HeaderMap| {
                let mut seen = record.lock().unwrap();
                seen.push(headers);
                let body = bodies[(seen.len() - 1).min(bodies.len() - 1)].clone();
                async move {
                    let mut response = (status, body).into_response();
                    if let Some(date) = date {
                        response
                            .headers_mut()
                            .insert(header::DATE, date.parse().unwrap());
                    }
                    response
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, seen)
    }

    /// The value of `name` on each recorded request (`None` where it was absent).
    pub(crate) fn header_values(seen: &Mutex<Vec<HeaderMap>>, name: &str) -> Vec<Option<String>> {
        let seen = seen.lock().unwrap();
        seen.iter()
            .map(|headers| {
                headers
                    .get(name)
                    .map(|value| value.to_str().unwrap().to_owned())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{testing::serve, *};
    use axum::http::StatusCode;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    #[tokio::test]
    async fn fetch_reports_finite_failure_classes_without_server_text() {
        for (status, expected) in [
            (StatusCode::UNAUTHORIZED, PollError::Unauthorized),
            (StatusCode::FORBIDDEN, PollError::Unauthorized),
            (StatusCode::TOO_MANY_REQUESTS, PollError::Unreachable),
            (StatusCode::BAD_GATEWAY, PollError::Unreachable),
        ] {
            let (url, _) = serve("/", status, vec!["private server text".into()], None).await;
            let outcome = fetch(reqwest::Client::new().get(url)).await;
            assert_eq!(outcome.unwrap_err(), expected, "{status}");
        }
        let (url, _) = serve("/", StatusCode::OK, vec!["x".repeat(MAX_BODY + 1)], None).await;
        let outcome = fetch(reqwest::Client::new().get(url)).await;
        assert_eq!(outcome.unwrap_err(), PollError::Invalid);
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", closed.local_addr().unwrap());
        drop(closed);
        let outcome = fetch(reqwest::Client::new().get(url)).await;
        assert_eq!(outcome.unwrap_err(), PollError::Unreachable);
    }

    #[tokio::test]
    async fn fetch_returns_the_body_and_the_servers_own_clock() {
        let date = "Sat, 14 Nov 2026 12:00:00 GMT";
        let (url, _) = serve("/", StatusCode::OK, vec!["body".into()], Some(date)).await;
        let (body, reference) = fetch(reqwest::Client::new().get(url)).await.unwrap();
        assert_eq!(body, b"body");
        assert_eq!(reference.to_rfc3339(), "2026-11-14T12:00:00+00:00");
    }

    /// Plays the scripted outcomes (the last repeats) and counts the polls.
    struct Script(Vec<Result<usize, PollError>>, Arc<AtomicUsize>);
    impl Poller for Script {
        async fn poll_new(&mut self) -> Result<usize, PollError> {
            let polled = self.1.fetch_add(1, Ordering::SeqCst);
            self.0[polled.min(self.0.len() - 1)]
        }
    }

    #[tokio::test]
    async fn watch_reports_each_poll_and_sends_nothing_once_dropped() {
        let polls = Arc::new(AtomicUsize::new(0));
        let reports = Arc::new(Mutex::new(vec![]));
        let sink = reports.clone();
        let script = Script(vec![Ok(0), Ok(1), Ok(0)], polls.clone());
        let task = tokio::spawn(watch(script, Duration::from_millis(5), move |outcome| {
            sink.lock().unwrap().push(outcome)
        }));
        while reports.lock().unwrap().len() < 3 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        task.abort();
        let _ = task.await;
        let polled = polls.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(
            polls.load(Ordering::SeqCst),
            polled,
            "a dropped watcher polls nothing"
        );
        assert_eq!(reports.lock().unwrap()[..3], [Ok(0), Ok(1), Ok(0)]);
    }

    #[tokio::test]
    async fn watch_ends_when_the_token_is_rejected_and_is_not_retried() {
        let polls = Arc::new(AtomicUsize::new(0));
        let reports = Arc::new(Mutex::new(vec![]));
        let sink = reports.clone();
        let script = Script(vec![Err(PollError::Unauthorized)], polls.clone());
        watch(script, Duration::from_millis(5), move |outcome| {
            sink.lock().unwrap().push(outcome)
        })
        .await;
        assert_eq!(*reports.lock().unwrap(), [Err(PollError::Unauthorized)]);
        assert_eq!(polls.load(Ordering::SeqCst), 1);
    }
}
