//! What a host process may ask the device to open.

pub(crate) const MAX_URL: usize = 4096;

fn after_scheme(text: &str) -> Option<&str> {
    ["https://", "http://"].into_iter().find_map(|scheme| {
        let head = text.get(..scheme.len())?;
        head.eq_ignore_ascii_case(scheme)
            .then(|| &text[scheme.len()..])
    })
}

/// A launcher argument that looks like a web URL, valid or not.
pub(crate) fn is_web(text: &str) -> bool {
    after_scheme(text).is_some()
}

/// http(s), printable ASCII only (no controls, spaces, backslashes or bidi marks), no
/// credentials, at most 4096 bytes. Mirrors the app's `web_url` so both sides agree.
pub(crate) fn valid(text: &str) -> bool {
    let Some(rest) = after_scheme(text) else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    text.len() <= MAX_URL
        && text
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && b != b'\\')
        && !authority.is_empty()
        && !authority.contains('@')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_clean_web_urls() {
        for good in [
            "https://login.example.com/authorize?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F",
            "HTTP://127.0.0.1:36151/oauth/callback",
            "https://[::1]:8080/x#frag",
        ] {
            assert!(valid(good), "{good}");
        }
        let oversized = format!("https://example.com/{}", "a".repeat(MAX_URL));
        for bad in [
            "file:///etc/passwd",
            "mailto:a@b.c",
            "myapp://callback",
            "javascript:alert(1)",
            "https://",
            "https:///path",
            "https://user:pass@example.com/",
            "https://example.com/a b",
            "https://example.com/\u{7}",
            "https://example.com/\u{202e}evil",
            "https://exa\\mple.com/",
            "https://example.com/é",
            "",
            &oversized,
        ] {
            assert!(!valid(bad), "{bad:?}");
        }
        assert!(valid(&format!(
            "https://example.com/{}",
            "a".repeat(MAX_URL - 20)
        )));
    }
}
