//! Read-only receiver for the relay's Apprise delivery to the user's own ntfy topic.
//!
//! Apprise posts the title `lazysh · <alias>` and, for a needs-attention event, the fixed
//! message `An agent needs your attention.`. Reading the topic back with a token that may
//! only read it, only a fresh, closed-schema message of that kind counts, and it carries
//! nothing of the message: no alias, text or server date reaches a notification. The relay's
//! encrypted bound-event envelope is not read: it is addressed to the enrolled device's own key.
use crate::remote::{
    self, fresh, public_alias, valid_access_token, PollError, Poller, EXPIRY_SECONDS,
};
use chrono::{DateTime, Utc};
use reqwest::Url;
use serde::Deserialize;
use std::collections::HashSet;
use zeroize::Zeroizing;

/// The relay's Apprise title prefix and needs-attention body.
const TITLE: &str = "lazysh · ";
const NEEDS_ATTENTION: &str = "An agent needs your attention.";

/// A topic name as ntfy accepts it: one to 64 letters, digits, `_` or `-`.
pub fn valid_topic(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// One line of ntfy's JSON stream. Fields ntfy adds later are ignored.
#[derive(Deserialize)]
struct Line {
    id: String,
    time: i64,
    event: String,
    #[serde(default)]
    topic: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    message: String,
}

pub struct Reader {
    client: reqwest::Client,
    url: Url,
    topic: String,
    /// `None` for a topic that needs no token.
    token: Option<Zeroizing<String>>,
    /// Ids in the previous reading; `None` until the first successful poll, which only
    /// records a baseline so history is never replayed as new attention. ntfy ids are random,
    /// so the window itself (the relay's 300 seconds) bounds what has to be remembered.
    seen: Option<HashSet<String>>,
}

impl Reader {
    /// `origin` is the HTTPS address of the user's ntfy server (a reverse-proxy path prefix is
    /// kept); an empty `token` reads the topic anonymously.
    pub fn new(
        client: reqwest::Client,
        origin: &str,
        topic: &str,
        token: &str,
    ) -> Result<Self, String> {
        Self::at(client, crate::https(origin)?, topic, token)
    }
    fn at(client: reqwest::Client, mut url: Url, topic: &str, token: &str) -> Result<Self, String> {
        if !valid_topic(topic) {
            return Err("Invalid ntfy topic".into());
        }
        if !token.is_empty() && !valid_access_token(token) {
            return Err("Invalid ntfy access token".into());
        }
        let path = format!("{}/{topic}/json", url.path().trim_end_matches('/'));
        url.set_path(&path);
        url.set_query(Some(&format!("poll=1&since={EXPIRY_SECONDS}s")));
        Ok(Self {
            client,
            url,
            topic: topic.into(),
            token: (!token.is_empty()).then(|| Zeroizing::new(token.into())),
            seen: None,
        })
    }

    /// Polls once; returns the ids of the attention events that arrived since the previous poll.
    pub async fn poll(&mut self) -> Result<Vec<String>, PollError> {
        let mut request = self.client.get(self.url.clone());
        if let Some(token) = &self.token {
            request = request.bearer_auth(token.as_str());
        }
        let (body, reference) = remote::fetch(request).await?;
        let lines = body
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).map_err(|_| PollError::Invalid))
            .collect::<Result<Vec<Line>, _>>()?;
        Ok(self.admit(lines, reference))
    }

    fn admit(&mut self, lines: Vec<Line>, reference: DateTime<Utc>) -> Vec<String> {
        let current = lines.iter().map(|line| line.id.clone()).collect();
        let Some(seen) = self.seen.replace(current) else {
            return vec![];
        };
        lines
            .into_iter()
            .filter(|line| !seen.contains(&line.id) && attention(line, &self.topic, reference))
            .map(|line| line.id)
            .collect()
    }
}

impl Poller for Reader {
    async fn poll_new(&mut self) -> Result<usize, PollError> {
        self.poll().await.map(|events| events.len())
    }
}

/// The relay's closed Apprise event: public alias, finite kind and a bounded age.
fn attention(line: &Line, topic: &str, reference: DateTime<Utc>) -> bool {
    line.event == "message"
        && line.topic == topic
        && line.message == NEEDS_ATTENTION
        && line.title.strip_prefix(TITLE).is_some_and(public_alias)
        && DateTime::from_timestamp(line.time, 0)
            .is_some_and(|time| fresh((reference - time).num_seconds()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::testing::{header_values, now, serve};
    use axum::http::StatusCode;

    const SERVER_NOW: &str = "Sat, 14 Nov 2026 12:00:00 GMT";
    fn line(id: &str, title: &str, message: &str, age: i64) -> Line {
        Line {
            id: id.into(),
            time: now().timestamp() - age,
            event: "message".into(),
            topic: "alerts".into(),
            title: title.into(),
            message: message.into(),
        }
    }
    fn alert(id: &str, age: i64) -> Line {
        line(id, "lazysh · build", NEEDS_ATTENTION, age)
    }
    fn reader() -> Reader {
        Reader::new(
            reqwest::Client::new(),
            "https://ntfy.example/prefix/",
            "alerts",
            "tk_token",
        )
        .unwrap()
    }

    #[test]
    fn only_a_fresh_needs_attention_event_with_a_public_alias_is_admitted() {
        let mut reader = reader();
        assert!(reader.admit(vec![alert("old", 0)], now()).is_empty());
        let mut other_event = alert("event", 0);
        other_event.event = "keepalive".into();
        let mut other_topic = alert("topic", 0);
        other_topic.topic = "elsewhere".into();
        let events = reader.admit(
            vec![
                line("a", "lazysh · build server-1", NEEDS_ATTENTION, 299),
                alert("late", 301),
                alert("b", -60),
                alert("future", -61),
                line("c", "lazysh · ", NEEDS_ATTENTION, 0),
                line("d", "lazysh · x\u{7f}y", NEEDS_ATTENTION, 0),
                line(
                    "e",
                    &format!("lazysh · {}", "a".repeat(65)),
                    NEEDS_ATTENTION,
                    0,
                ),
                line(
                    "f",
                    "lazysh · build ",
                    "An agent needs your attention.\n",
                    0,
                ),
                line("g", "lazysh · build", "An agent finished.", 0),
                line("h", "lazysh · build", "An agent is working.", 0),
                line("i", "Backup", NEEDS_ATTENTION, 0),
                line("j", "lazysh", NEEDS_ATTENTION, 0),
                other_event,
                other_topic,
            ],
            now(),
        );
        assert_eq!(events, ["a", "b"]);
        // An id already seen in the previous reading is never shown twice.
        assert!(reader.admit(vec![alert("a", 0)], now()).is_empty());
    }

    #[test]
    fn construction_requires_https_a_plain_topic_and_a_printable_token_and_keeps_the_proxy_prefix()
    {
        let client = reqwest::Client::new();
        for origin in [
            "http://ntfy.example",
            "https://u:p@ntfy.example",
            "https://ntfy.example/?x=1",
            "https://ntfy.example/#x",
        ] {
            assert!(
                Reader::new(client.clone(), origin, "alerts", "").is_err(),
                "{origin}"
            );
        }
        for topic in ["", "a/b", "a b", "a?x=1", "../x", "ü", &"t".repeat(65)] {
            assert!(
                Reader::new(client.clone(), "https://ntfy.example", topic, "").is_err(),
                "{topic}"
            );
        }
        for token in ["with space", "new\nline", &"t".repeat(513)] {
            assert!(Reader::new(client.clone(), "https://ntfy.example", "alerts", token).is_err());
        }
        assert!(Reader::new(client, "https://ntfy.example", "alerts", "").is_ok());
        assert_eq!(
            reader().url.as_str(),
            "https://ntfy.example/prefix/alerts/json?poll=1&since=300s"
        );
    }

    /// The JSON stream ntfy answers a poll with: one object per line.
    fn stream(events: &[(&str, &str, &str, i64)]) -> String {
        events
            .iter()
            .map(|(id, title, message, time)| serde_json::json!({"id":id,"time":time,"expires":time + 43200,"event":"message","topic":"alerts","title":title,"message":message,"priority":3,"tags":["warning"]}).to_string() + "\n")
            .collect()
    }
    fn at(url: Url, token: &str) -> Reader {
        Reader::at(reqwest::Client::new(), url, "alerts", token).unwrap()
    }

    #[tokio::test]
    async fn poll_baselines_then_admits_new_events_judged_by_the_servers_own_clock() {
        // The server says it is 2026-11-14 12:00 GMT, i.e. unix 1794052800; this machine's clock is irrelevant.
        let server_now = DateTime::parse_from_rfc2822(SERVER_NOW)
            .unwrap()
            .timestamp();
        let old = ("o", "lazysh · a", NEEDS_ATTENTION, server_now - 100);
        let fresh = ("f", "lazysh · b", NEEDS_ATTENTION, server_now - 10);
        let stale = ("s", "lazysh · c", NEEDS_ATTENTION, server_now - 301);
        let (url, seen) = serve(
            "/alerts/json",
            StatusCode::OK,
            vec![
                stream(&[old]),
                stream(&[old, fresh]),
                stream(&[old, fresh, stale]),
            ],
            Some(SERVER_NOW),
        )
        .await;
        let mut reader = at(url, "tk_reader");
        assert!(
            reader.poll().await.unwrap().is_empty(),
            "history is a baseline, never a notification"
        );
        assert_eq!(reader.poll().await.unwrap(), ["f"]);
        assert!(
            reader.poll().await.unwrap().is_empty(),
            "an event older than the relay's 300 s bound expires, and a seen one is not repeated"
        );
        assert_eq!(
            header_values(&seen, "authorization"),
            vec![Some("Bearer tk_reader".to_owned()); 3]
        );
    }

    #[tokio::test]
    async fn a_topic_without_a_token_is_read_without_an_authorization_header() {
        let (url, seen) = serve("/alerts/json", StatusCode::OK, vec![String::new()], None).await;
        assert!(at(url, "").poll().await.unwrap().is_empty());
        assert_eq!(header_values(&seen, "authorization"), [None]);
    }

    #[tokio::test]
    async fn a_page_that_is_not_ntfys_json_stream_is_invalid_and_not_echoed() {
        for body in ["<html>private server text</html>", "{\"id\":\"a\"}\n"] {
            let (url, _) = serve("/alerts/json", StatusCode::OK, vec![body.into()], None).await;
            assert_eq!(at(url, "").poll().await.unwrap_err(), PollError::Invalid);
        }
    }
}
