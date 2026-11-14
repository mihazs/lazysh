//! Sign-in callbacks in terminal output (ADR 0004, detection tier 0; #1510).
//!
//! A command such as `aws sso login`, `codex login` or `gcloud auth login` starts a callback server
//! on the host and prints an authorize URL whose `redirect_uri` is `http://localhost:PORT/...`. On
//! the device that address is the device itself. [`Scanner`] reads the bytes a session prints, in
//! Rust before the renderer, so it also runs while the WebView is suspended, and reports a [`Hint`]:
//! the port, the host's own callback path and who the identity provider is. A hint is only a
//! sighting. It starts nothing and forwards nothing: a later step confirms it with the host's
//! listeners and the user's policy decides.
//!
//! Nothing secret leaves the scanner. Only the shape of the URL is read, so `code`, `state`,
//! `login_hint` and every other query value are never copied into a hint, a log line or an error.
mod scan;
mod strip;
mod url;

use serde::Serialize;
use std::{sync::Mutex, time::SystemTime};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// The redirect of an authorize URL printed as text.
    Url,
    /// The same, read from an OSC 8 hyperlink whose text is its own target.
    Osc8,
    /// A bare `http://localhost:PORT` on a line that talks about signing in. Only corroborates.
    Announcement,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    pub id: String,
    pub source: Source,
    /// `localhost`, `127.0.0.1` or `[::1]`, as the program wrote it.
    pub host: &'static str,
    /// 1024 to 65535.
    pub port: u16,
    /// The callback path, without a query.
    pub path: String,
    /// Host of the authorize URL, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idp_host: Option<String>,
    pub pkce: bool,
    /// A port of a database, cache, remote access or admin service: needs an explicit allow.
    pub sensitive: bool,
    pub first_seen_at: String,
}

/// One scanner per session, fed by the output path.
pub struct SessionHints(Mutex<scan::Scanner>);

impl SessionHints {
    /// `ssh_port` is the host's own SSH port, which is never reported as a callback.
    pub fn new(ssh_port: Option<u16>) -> Self {
        Self(Mutex::new(scan::Scanner::new(ssh_port)))
    }

    /// Scans one chunk of output and returns the hints it completed.
    pub fn scan(&self, bytes: &[u8], now: SystemTime) -> Vec<Hint> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .feed(bytes, now)
    }
}

#[cfg(test)]
mod tests;
