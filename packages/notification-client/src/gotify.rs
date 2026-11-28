//! Read-only receiver for the relay's Gotify destination.
//!
//! The relay posts `title: "lazysh"`, `message: "<alias>: <kind>"` and priority 5 for
//! `needs_attention` (2 otherwise). A Gotify client token reads those messages back.
//! Only a fresh, closed-schema `needs_attention` message becomes an [`Attention`], and it
//! carries nothing of the message: no alias, text or server date reaches a notification.
use crate::remote::{self, fresh, public_alias, valid_access_token, PollError, Poller};
use chrono::{DateTime, Utc};
use reqwest::Url;
use serde::Deserialize;
use zeroize::Zeroizing;

/// Newest messages read per poll; older unseen ones are dropped, never replayed.
const PAGE: usize = 20;

/// One new attention event; `id` is the Gotify message id, for the caller's logs only.
#[derive(Debug, PartialEq, Eq)]
pub struct Attention {
    pub id: u64,
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

impl Reader {
    /// `origin` is the HTTPS address of the user's Gotify server; a reverse-proxy path prefix is kept.
    pub fn new(client: reqwest::Client, origin: &str, token: &str) -> Result<Self, String> {
        let url = crate::https(origin)?;
        Self::at(client, url, token)
    }
    fn at(client: reqwest::Client, mut url: Url, token: &str) -> Result<Self, String> {
        if !valid_access_token(token) {
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
        let (body, reference) = remote::fetch(
            self.client
                .get(self.url.clone())
                .header("X-Gotify-Key", self.token.as_str()),
        )
        .await?;
        let page: Page = serde_json::from_slice(&body).map_err(|_| PollError::Invalid)?;
        Ok(self.admit(page.messages, reference))
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

impl Poller for Reader {
    async fn poll_new(&mut self) -> Result<usize, PollError> {
        self.poll().await.map(|events| events.len())
    }
}

/// The relay's closed Gotify event: public alias, finite kind and a bounded age.
fn attention(message: &Message, reference: DateTime<Utc>) -> bool {
    let age = DateTime::parse_from_rfc3339(&message.date)
        .map(|date| (reference - date.with_timezone(&Utc)).num_seconds());
    message.title == "lazysh"
        && message.priority == 5
        && message
            .message
            .strip_suffix(": needs_attention")
            .is_some_and(public_alias)
        && age.is_ok_and(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::testing::{header_values, now, serve};
    use axum::http::StatusCode;

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
            "/message",
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
        assert_eq!(
            header_values(&seen, "x-gotify-key"),
            vec![Some("client-token".to_owned()); 3]
        );
    }

    #[tokio::test]
    async fn a_page_that_is_not_gotifys_message_list_is_invalid_and_not_echoed() {
        let (url, _) = serve(
            "/message",
            StatusCode::OK,
            vec!["private server text".into()],
            None,
        )
        .await;
        let mut reader = Reader::at(reqwest::Client::new(), url, "client-token").unwrap();
        assert_eq!(reader.poll().await.unwrap_err(), PollError::Invalid);
    }
}
