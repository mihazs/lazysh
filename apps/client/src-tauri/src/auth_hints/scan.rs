//! The scanner: terminal bytes in, sign-in hints out. It works one byte at a time on plain text, so
//! the same output gives the same hints whatever way the transport split it into chunks.
use super::{
    strip::Stripper,
    url::{self, Target, MAX_URL},
    Hint, Source,
};
use std::time::{Duration, SystemTime};

/// A line shorter than this was not broken by a program wrapping a long URL.
const MIN_WRAP_WIDTH: usize = 40;
const MAX_CONTINUATIONS: usize = 16;
const MAX_CANDIDATES: usize = 8;
/// Callbacks reported per session per `REPEAT_WINDOW`: a host cannot flood the app with sign-ins.
const MAX_RECENT: usize = 12;
/// Ports of databases, caches, remote access and admin APIs: never a sign-in callback worth a tunnel
/// without the user naming it. (Ports below 1024 are not reported at all.)
const SENSITIVE_PORTS: [u16; 15] = [
    1433, 1521, 2049, 2375, 2376, 2379, 3306, 3389, 5432, 5900, 6379, 8500, 9200, 11211, 27017,
];
/// A callback printed again within this long is the same sign-in, not a new one.
const REPEAT_WINDOW: Duration = Duration::from_secs(600);

/// A URL that ran to the end of a wide line and may go on in the next one.
struct Pending {
    text: String,
    indent: usize,
    continuations: usize,
}

struct Seen {
    port: u16,
    path: String,
    strength: u8,
    pkce: bool,
    at: SystemTime,
}

pub(super) struct Scanner {
    strip: Stripper,
    plain: Vec<u8>,
    token: Vec<u8>,
    token_overflow: bool,
    // Line state.
    started: bool,
    width: usize,
    indent: usize,
    words: usize,
    keyword: bool,
    previous: String,
    candidates: Vec<Target>,
    pending: Option<Pending>,
    recent: Vec<Seen>,
    now: SystemTime,
    hints: Vec<Hint>,
    /// The session's own SSH port: a callback there would be the host's sshd, never a sign-in.
    refused: Option<u16>,
}

fn token_byte(byte: u8) -> bool {
    byte.is_ascii_graphic() && !matches!(byte, b'<' | b'>' | b'"' | b'\'' | b'`')
}

/// The first `http(s)://` inside a token (programs prefix it with `(`, `url=`, a bullet), to the end.
fn url_in(token: &str) -> Option<&str> {
    let lower = token.to_ascii_lowercase();
    let start = ["http://", "https://"]
        .iter()
        .filter_map(|scheme| lower.find(scheme))
        .min()?;
    (token.len() - start > "https://".len()).then(|| &token[start..])
}

/// A URL without the prose around it: trailing punctuation and a closing bracket the URL never
/// opened. Applied only when a URL is read, not to a line's end, where a wrap may have cut the URL
/// at a `.` or a `)`.
fn trimmed(mut url: &str) -> &str {
    while let Some(last) = url.chars().last() {
        let opener = match last {
            ')' => Some('('),
            ']' => Some('['),
            '}' => Some('{'),
            _ => None,
        };
        let unbalanced =
            opener.is_some_and(|opener| url.matches(last).count() > url.matches(opener).count());
        if ".,;:!?*".contains(last) || unbalanced {
            url = &url[..url.len() - last.len_utf8()];
        } else {
            break;
        }
    }
    url
}

fn bullet(token: &str) -> bool {
    matches!(token, "-" | "*" | "+" | ">")
        || (token.len() <= 3
            && (token.ends_with('.') || token.ends_with(')'))
            && token[..token.len() - 1].bytes().all(|b| b.is_ascii_digit())
            && token.len() > 1)
}

fn url_tail(token: &str) -> bool {
    let tail = |b: u8| b.is_ascii_alphanumeric() || b"-._~:/?#[]@!$&()*+,;=%".contains(&b);
    let lower = token.to_ascii_lowercase();
    !token.is_empty()
        && token.bytes().all(tail)
        && !bullet(token)
        && !lower.starts_with("http://")
        && !lower.starts_with("https://")
}

/// The rest of a URL a program broke across lines: URL characters only, not prose, a bullet or
/// another URL, and looking like a URL's tail. A missed join costs a hint; a wrong one reports a
/// callback that does not exist.
fn continues(token: &str) -> bool {
    if !url_tail(token) {
        return false;
    }
    let structured = token.bytes().any(|b| b"/?&=%#_~+@".contains(&b));
    let opaque = token.len() >= 12
        && token.bytes().any(|b| b.is_ascii_digit())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    structured || opaque
}

fn keyword(word: &str, previous: &str) -> bool {
    word.contains("login")
        || word.contains("signin")
        || word.contains("sign-in")
        || word.contains("oauth")
        || word.contains("authenticat")
        || word.contains("authoriz")
        || word == "sso"
        || (word == "in" && matches!(previous, "sign" | "log"))
}

impl Scanner {
    pub(super) fn new(refused: Option<u16>) -> Self {
        Self {
            refused,
            strip: Stripper::new(),
            plain: Vec::new(),
            token: Vec::new(),
            token_overflow: false,
            started: false,
            width: 0,
            indent: 0,
            words: 0,
            keyword: false,
            previous: String::new(),
            candidates: Vec::new(),
            pending: None,
            recent: Vec::new(),
            now: SystemTime::UNIX_EPOCH,
            hints: Vec::new(),
        }
    }

    pub(super) fn feed(&mut self, bytes: &[u8], now: SystemTime) -> Vec<Hint> {
        self.now = now;
        let mut plain = std::mem::take(&mut self.plain);
        self.strip.push(bytes, &mut plain);
        // A hyperlink is read first: its target is the whole URL even when the text was wrapped.
        for target in std::mem::take(&mut self.strip.links) {
            self.analyse(&target, Source::Osc8);
        }
        for &byte in &plain {
            self.text(byte);
        }
        plain.clear();
        self.plain = plain;
        std::mem::take(&mut self.hints)
    }

    fn text(&mut self, byte: u8) {
        match byte {
            b'\n' => self.end_line(),
            b' ' => {
                if !self.started {
                    self.indent += 1;
                }
                self.width += 1;
                self.end_token(false);
            }
            byte if token_byte(byte) => {
                self.started = true;
                self.width += 1;
                if self.token.len() < MAX_URL + 1 {
                    self.token.push(byte);
                } else {
                    self.token_overflow = true;
                }
            }
            _ => {
                self.started = true;
                self.width += 1;
                self.end_token(false);
            }
        }
    }

    fn end_line(&mut self) {
        self.end_token(true);
        if self.words == 0 {
            self.resolve();
        }
        if self.keyword {
            for target in std::mem::take(&mut self.candidates) {
                self.emit(Source::Announcement, target, None, false);
            }
        }
        self.candidates.clear();
        self.started = false;
        self.width = 0;
        self.indent = 0;
        self.words = 0;
        self.keyword = false;
        self.previous.clear();
    }

    fn end_token(&mut self, eol: bool) {
        let overflow = std::mem::take(&mut self.token_overflow);
        if self.token.is_empty() && !overflow {
            return;
        }
        let token = String::from_utf8_lossy(&std::mem::take(&mut self.token)).into_owned();
        let index = self.words;
        self.words += 1;
        let wide = eol && self.width >= MIN_WRAP_WIDTH;

        if let Some(mut pending) = self.pending.take() {
            if !overflow
                && index == 0
                && self.indent == pending.indent
                && pending.text.len() + token.len() <= MAX_URL
                // A redirect that ends the URL may be cut anywhere: the last piece of it can be a short
                // plain word (`9005`, `lback`) alone on its line.
                && (continues(&token)
                    || (eol && url::ends_in_redirect(&pending.text) && url_tail(&token)))
            {
                pending.text.push_str(&token);
                pending.continuations += 1;
                let more = wide && pending.continuations < MAX_CONTINUATIONS;
                self.pending = Some(pending);
                if !more {
                    self.resolve();
                }
                return;
            }
            self.pending = Some(pending);
            self.resolve();
        }
        if overflow {
            // A URL longer than 4096 bytes is refused whole; the rest of its line is not read as one.
            self.previous.clear();
            return;
        }
        match url_in(&token) {
            Some(url) => {
                if let Some(target) = url::bare_origin(trimmed(url)) {
                    if self.candidates.len() < MAX_CANDIDATES {
                        self.candidates.push(target);
                    }
                }
                if wide {
                    // It fills a wide line, so it may go on below. A redirect followed by another
                    // parameter is complete and reported now (the rest may add the code challenge);
                    // one that ends the line could be cut short and waits for the next line.
                    if url::redirect(trimmed(url)).is_some_and(|redirect| !redirect.last) {
                        self.analyse(url, Source::Url);
                    }
                    self.pending = Some(Pending {
                        text: url.into(),
                        indent: self.indent,
                        continuations: 0,
                    });
                } else {
                    self.analyse(url, Source::Url);
                }
                self.previous.clear();
            }
            None => {
                let word: String = token
                    .trim_matches(|c: char| !c.is_ascii_alphanumeric())
                    .to_ascii_lowercase();
                self.keyword |= keyword(&word, &self.previous);
                self.previous = word;
            }
        }
    }

    /// The wrapped URL, if any, has all the lines it will get.
    fn resolve(&mut self) {
        if let Some(pending) = self.pending.take() {
            self.analyse(&pending.text, Source::Url);
        }
    }

    fn analyse(&mut self, url: &str, source: Source) {
        if let Some(redirect) = url::redirect(trimmed(url)) {
            self.emit(source, redirect.target, redirect.idp_host, redirect.pkce);
        }
    }

    fn emit(&mut self, source: Source, target: Target, idp_host: Option<String>, pkce: bool) {
        if self.refused == Some(target.port) {
            return;
        }
        let now = self.now;
        let strength = u8::from(source != Source::Announcement);
        self.recent
            .retain(|seen| now.duration_since(seen.at).unwrap_or_default() < REPEAT_WINDOW);
        // The same callback again is the same sign-in; stronger evidence for it is news.
        if self.recent.iter().any(|seen| {
            seen.port == target.port
                && seen.path == target.path
                && seen.strength >= strength
                && (seen.pkce || !pkce)
        }) {
            return;
        }
        if self.recent.len() >= MAX_RECENT {
            return;
        }
        self.recent.push(Seen {
            port: target.port,
            path: target.path.clone(),
            strength,
            pkce,
            at: now,
        });
        self.hints.push(Hint {
            id: uuid::Uuid::new_v4().to_string(),
            source,
            host: target.host.as_str(),
            port: target.port,
            path: target.path,
            idp_host,
            pkce,
            sensitive: SENSITIVE_PORTS.contains(&target.port),
            first_seen_at: rfc3339(now),
        });
    }
}

#[cfg(test)]
impl Scanner {
    /// Bytes of host output held between chunks.
    pub(super) fn retained(&self) -> usize {
        self.token.len()
            + self.previous.len()
            + self
                .pending
                .as_ref()
                .map_or(0, |pending| pending.text.len())
            + self.strip.retained()
    }
}

/// `2026-11-13T10:00:00Z`: civil date from days since 1970 (Hinnant), so no date crate is needed.
pub(super) fn rfc3339(time: SystemTime) -> String {
    let seconds = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(0));
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}
