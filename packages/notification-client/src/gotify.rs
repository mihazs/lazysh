//! Read-only receiver for the relay's Gotify destination.
//!
//! The relay posts `title: "lazysh"`, `message: "<alias>: <kind>"` and priority 5 for
//! `needs_attention` (2 otherwise). A Gotify client token reads those messages back.
//! Only a fresh, closed-schema `needs_attention` message becomes an [`Attention`], and it
//! carries nothing of the message: no alias, text or server date reaches a notification.
use chrono::{DateTime, Utc};
use reqwest::{header::DATE, Url};
use serde::Deserialize;
use std::time::Duration;
use zeroize::Zeroizing;

/// Newest messages read per poll; older unseen ones are dropped, never replayed.
const PAGE: usize = 20;
const MAX_BODY: usize = 1024 * 1024;
/// The relay's own bound for an event: 300 seconds from issuance.
const EXPIRY_SECONDS: i64 = 300;
const FUTURE_SECONDS: i64 = 60;

/// One new attention event; `id` is the Gotify message id, for the caller's logs only.
#[derive(Debug, PartialEq, Eq)]
pub struct Attention {
    pub id: u64,
}

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

#[derive(Deserialize)]
struct Page {
    messages: Vec<Message>,
}
#[derive(Deserialize)]
struct Message {
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    date: String,
}

pub struct Reader {
    client: reqwest::Client,
    url: Url,
    token: Zeroizing<String>,
    /// Highest message id already seen; `None` until the first successful poll, which only
    /// records a baseline so history is never replayed as new attention.
    newest: Option<u64>,
}

/// Gotify tokens are opaque printable ASCII, as the relay accepts them.
pub fn valid_gotify_token(value: &str) -> bool {
    (1..=512).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_graphic())
}

impl Reader {
    /// `origin` is the HTTPS address of the user's Gotify server; a reverse-proxy path prefix is kept.
    pub fn new(client: reqwest::Client, origin: &str, token: &str) -> Result<Self, String> {
        let url = crate::https(origin)?;
        Self::at(client, url, token)
    }
    fn at(client: reqwest::Client, mut url: Url, token: &str) -> Result<Self, String> {
        if !valid_gotify_token(token) {
            return Err("Invalid Gotify client token".into());
        }
        let path = format!("{}/message", url.path().trim_end_matches('/'));
        url.set_path(&path);
        url.set_query(Some(&format!("limit={PAGE}")));
        Ok(Self {
            client,
            url,
            token: Zeroizing::new(token.into()),
            newest: None,
        })
    }

    /// Polls once; returns the attention events that arrived since the previous poll.
    pub async fn poll(&mut self) -> Result<Vec<Attention>, PollError> {
        let mut response = self
            .client
            .get(self.url.clone())
            .header("X-Gotify-Key", self.token.as_str())
            .send()
            .await
            .map_err(|_| PollError::Unreachable)?;
        match response.status().as_u16() {
            200 => {}
            401 | 403 => return Err(PollError::Unauthorized),
            _ => return Err(PollError::Unreachable),
        }
        // The server's own clock dates its messages, so compare against its Date header and
        // only fall back to ours; a skewed desktop clock must not silently drop events.
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
        let page: Page = serde_json::from_slice(&body).map_err(|_| PollError::Invalid)?;
        Ok(self.admit(page.messages, reference))
    }

    /// Polls until the future is dropped (or the server rejects the token), reporting every
    /// outcome as the number of new attention events. Failures back off up to 16 times `interval`.
    pub async fn watch(
        mut self,
        interval: Duration,
        mut report: impl FnMut(Result<usize, PollError>),
    ) {
        let mut failures = 0u32;
        loop {
            let outcome = self.poll().await;
            failures = if outcome.is_ok() {
                0
            } else {
                failures.saturating_add(1)
            };
            let rejected = outcome.as_ref().err() == Some(&PollError::Unauthorized);
            report(outcome.map(|events| events.len()));
            if rejected {
                return;
            }
            tokio::time::sleep(interval * 2u32.pow(failures.min(4))).await;
        }
    }

    fn admit(&mut self, messages: Vec<Message>, reference: DateTime<Utc>) -> Vec<Attention> {
        let newest = messages.iter().map(|message| message.id).max().unwrap_or(0);
        let previous = match self.newest {
            Some(previous) if newest >= previous => previous,
            // The first poll, or a server whose ids went backwards (restored database): a new baseline.
            _ => {
                self.newest = Some(newest);
                return vec![];
            }
        };
        self.newest = Some(newest);
        let mut fresh: Vec<_> = messages
            .into_iter()
            .filter(|message| message.id > previous && attention(message, reference))
            .map(|message| Attention { id: message.id })
            .collect();
        fresh.sort_by_key(|event| event.id);
        fresh
    }
}

/// The relay's closed Gotify event: public alias, finite kind and a bounded age.
fn attention(message: &Message, reference: DateTime<Utc>) -> bool {
    let alias = message.message.strip_suffix(": needs_attention");
    let age = DateTime::parse_from_rfc3339(&message.date)
        .map(|date| (reference - date.with_timezone(&Utc)).num_seconds());
    message.title == "lazysh"
        && message.priority == 5
        && alias.is_some_and(|alias| {
            (1..=64).contains(&alias.len())
                && alias
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b" _-.".contains(&byte))
        })
        && age.is_ok_and(|age| (-FUTURE_SECONDS..=EXPIRY_SECONDS).contains(&age))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{header, HeaderMap, StatusCode},
        response::IntoResponse,
        routing::get,
        Router,
    };
    use std::sync::{Arc, Mutex};

    const NOW: &str = "2026-11-14T12:00:00Z";
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(NOW)
            .unwrap()
            .with_timezone(&Utc)
    }
    fn message(id: u64, text: &str, age: i64) -> Message {
        Message {
            id,
            title: "lazysh".into(),
            message: text.into(),
            priority: 5,
            date: (now() - chrono::Duration::seconds(age)).to_rfc3339(),
        }
    }
    fn reader() -> Reader {
        Reader::at(
            reqwest::Client::new(),
            Url::parse("https://gotify.example/prefix/").unwrap(),
            "client-token",
        )
        .unwrap()
    }

    #[test]
    fn only_a_fresh_needs_attention_event_with_a_public_alias_is_admitted() {
        let mut reader = reader();
        assert!(reader
            .admit(vec![message(7, "old: needs_attention", 0)], now())
            .is_empty());
        let mut done = message(8, "build.server-1: done", 0);
        done.priority = 2;
        let mut other_title = message(9, "build: needs_attention", 0);
        other_title.title = "Backup".into();
        let mut quiet = message(10, "build: needs_attention", 0);
        quiet.priority = 2;
        let events = reader.admit(
            vec![
                message(14, "build server-1: needs_attention", 299),
                message(13, "build: needs_attention", 301),
                message(12, "build: needs_attention", -61),
                message(11, "build: needs_attention\nrm -rf /", 0),
                message(17, ": needs_attention", 0),
                message(18, "x\u{7f}y: needs_attention", 0),
                message(19, &format!("{}: needs_attention", "a".repeat(65)), 0),
                message(20, "build: needs_attention ", 0),
                done,
                other_title,
                quiet,
                Message {
                    date: "yesterday".into(),
                    ..message(15, "build: needs_attention", 0)
                },
                message(16, "build: needs_attention", -60),
            ],
            now(),
        );
        assert_eq!(events, [Attention { id: 14 }, Attention { id: 16 }]);
        // Already seen ids are never shown twice.
        assert!(reader
            .admit(vec![message(16, "build: needs_attention", 0)], now())
            .is_empty());
    }

    #[test]
    fn a_server_whose_ids_went_backwards_starts_a_new_baseline() {
        let mut reader = reader();
        reader.admit(vec![message(50, "a: needs_attention", 0)], now());
        assert!(reader
            .admit(vec![message(3, "a: needs_attention", 0)], now())
            .is_empty());
        assert_eq!(
            reader.admit(vec![message(4, "a: needs_attention", 0)], now()),
            [Attention { id: 4 }]
        );
    }

    #[test]
    fn construction_requires_https_and_a_printable_token_and_keeps_the_proxy_prefix() {
        let client = reqwest::Client::new();
        for origin in [
            "http://gotify.example",
            "https://u:p@gotify.example",
            "https://gotify.example/?x=1",
            "https://gotify.example/#x",
        ] {
            assert!(
                Reader::new(client.clone(), origin, "token").is_err(),
                "{origin}"
            );
        }
        for token in ["", "with space", "new\nline", &"t".repeat(513)] {
            assert!(Reader::new(client.clone(), "https://gotify.example", token).is_err());
        }
        assert_eq!(
            reader().url.as_str(),
            "https://gotify.example/prefix/message?limit=20"
        );
    }

    /// Serves the bodies in order (the last repeats) on loopback HTTP and records each token header seen.
    async fn serve(
        status: StatusCode,
        bodies: Vec<String>,
        date: Option<&'static str>,
    ) -> (Url, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(vec![]));
        let record = seen.clone();
        let app = Router::new().route(
            "/message",
            get(move |headers: HeaderMap| {
                let mut seen = record.lock().unwrap();
                seen.push(headers["x-gotify-key"].to_str().unwrap().to_owned());
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
    fn page(messages: &[(u64, &str, &str)]) -> String {
        let messages: Vec<_> = messages
            .iter()
            .map(|(id, text, date)| serde_json::json!({"id":id,"appid":1,"title":"lazysh","message":text,"priority":5,"date":date,"extras":{"x":1}}))
            .collect();
        serde_json::json!({"messages":messages,"paging":{"size":messages.len(),"limit":20,"since":0}}).to_string()
    }

    #[tokio::test]
    async fn poll_baselines_then_admits_new_events_judged_by_the_servers_own_clock() {
        // The server dates its events in 2026 and says it is 12:00 GMT; this machine's clock is irrelevant.
        let old = (1, "a: needs_attention", "2026-11-14T10:00:00Z");
        let fresh = (2, "b: needs_attention", "2026-11-14T13:59:30+02:00");
        let stale = (3, "c: needs_attention", "2026-11-14T11:00:00Z");
        let (url, seen) = serve(
            StatusCode::OK,
            vec![
                page(&[old]),
                page(&[fresh, old]),
                page(&[stale, fresh, old]),
            ],
            Some("Sat, 14 Nov 2026 12:00:00 GMT"),
        )
        .await;
        let mut reader = Reader::at(reqwest::Client::new(), url, "client-token").unwrap();
        assert_eq!(
            reader.poll().await.unwrap(),
            [],
            "history is a baseline, never a notification"
        );
        assert_eq!(reader.poll().await.unwrap(), [Attention { id: 2 }]);
        assert_eq!(
            reader.poll().await.unwrap(),
            [],
            "an event older than the relay's 300 s bound expires"
        );
        assert_eq!(*seen.lock().unwrap(), ["client-token"; 3]);
    }

    #[tokio::test]
    async fn watch_reports_each_poll_sends_nothing_once_dropped_and_ends_when_the_token_is_rejected(
    ) {
        let old = (1, "a: needs_attention", "2026-11-14T11:59:50Z");
        let fresh = (2, "b: needs_attention", "2026-11-14T11:59:55Z");
        let (url, seen) = serve(
            StatusCode::OK,
            vec![page(&[old]), page(&[fresh, old])],
            Some("Sat, 14 Nov 2026 12:00:00 GMT"),
        )
        .await;
        let reports = Arc::new(Mutex::new(vec![]));
        let sink = reports.clone();
        let reader = Reader::at(reqwest::Client::new(), url, "client-token").unwrap();
        let task = tokio::spawn(reader.watch(Duration::from_millis(5), move |outcome| {
            sink.lock().unwrap().push(outcome)
        }));
        while reports.lock().unwrap().len() < 3 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        task.abort();
        let _ = task.await;
        let requests = seen.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(
            seen.lock().unwrap().len(),
            requests,
            "a dropped watcher sends nothing"
        );
        assert_eq!(reports.lock().unwrap()[..3], [Ok(0), Ok(1), Ok(0)]);

        let (url, seen) = serve(StatusCode::UNAUTHORIZED, vec![String::new()], None).await;
        let reports = Arc::new(Mutex::new(vec![]));
        let sink = reports.clone();
        let reader = Reader::at(reqwest::Client::new(), url, "revoked-token").unwrap();
        reader
            .watch(Duration::from_millis(5), move |outcome| {
                sink.lock().unwrap().push(outcome)
            })
            .await;
        assert_eq!(*reports.lock().unwrap(), [Err(PollError::Unauthorized)]);
        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "a rejected token is not retried"
        );
    }

    #[tokio::test]
    async fn poll_reports_finite_failure_classes_without_server_text() {
        for (status, expected) in [
            (StatusCode::UNAUTHORIZED, PollError::Unauthorized),
            (StatusCode::FORBIDDEN, PollError::Unauthorized),
            (StatusCode::BAD_GATEWAY, PollError::Unreachable),
            (StatusCode::OK, PollError::Invalid),
        ] {
            let (url, _) = serve(status, vec!["private server text".into()], None).await;
            let mut reader = Reader::at(reqwest::Client::new(), url, "client-token").unwrap();
            assert_eq!(reader.poll().await.unwrap_err(), expected);
        }
        let (url, _) = serve(StatusCode::OK, vec!["x".repeat(MAX_BODY + 1)], None).await;
        let mut reader = Reader::at(reqwest::Client::new(), url, "client-token").unwrap();
        assert_eq!(reader.poll().await.unwrap_err(), PollError::Invalid);
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", closed.local_addr().unwrap())).unwrap();
        drop(closed);
        assert_eq!(
            Reader::at(reqwest::Client::new(), url, "client-token")
                .unwrap()
                .poll()
                .await
                .unwrap_err(),
            PollError::Unreachable
        );
    }
}
