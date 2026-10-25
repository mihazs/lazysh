use crate::app_lock::{AccessLease, Guarded, GuardedError};
use tauri_plugin_opener::OpenerExt;

fn web_url(value: &str) -> Result<String, String> {
    if value.len() > 4096
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
        || value.contains('\\')
    {
        return Err("Enter a valid HTTP or HTTPS URL without credentials".into());
    }
    let (scheme, address) = value
        .split_once("://")
        .ok_or("Enter a complete HTTP or HTTPS URL")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("Only HTTP and HTTPS URLs can open in the browser".into());
    }
    let authority = address.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err("URL credentials and empty hosts are not allowed".into());
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| "Invalid browser URL")?;
    if !parsed.has_host()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.as_str().len() > 4096
    {
        return Err("Enter a valid HTTP or HTTPS URL without credentials".into());
    }
    Ok(parsed.to_string())
}

#[tauri::command]
pub fn open_web_url(
    app: tauri::AppHandle,
    url: String,
    access: AccessLease,
) -> std::result::Result<Guarded<()>, GuardedError<String>> {
    access.run_sync(|| {
        app.opener()
            .open_url(web_url(&url)?, None::<&str>)
            .map_err(|_| {
                "The system browser could not open this link. Copy its URL instead.".into()
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_protocols_credentials_and_ambiguous_urls() {
        for value in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "mailto:user@example.com",
            "https://user:pass@example.com",
            "https://@example.com",
            "https://:pass@example.com",
            "https:///example.com",
            "https:\\example.com",
            "https://example.com\\@evil.example",
            "https://exa\nmple.com",
            " https://example.com",
            "https://example.com/a b",
            "https://example.com:99999",
            "https://",
        ] {
            assert!(web_url(value).is_err(), "accepted {value:?}");
        }
        assert!(web_url(&format!("https://example.com/{}", "a".repeat(4096))).is_err());
    }
    #[test]
    fn canonicalizes_only_http_urls_without_reinterpreting_shell_characters() {
        assert_eq!(
            web_url("HTTPS://Example.COM").unwrap(),
            "https://example.com/"
        );
        assert_eq!(
            web_url("http://localhost:3000/a?x=%20#test").unwrap(),
            "http://localhost:3000/a?x=%20#test"
        );
        assert_eq!(
            web_url("https://example.com/@user").unwrap(),
            "https://example.com/@user"
        );
        assert_eq!(
            web_url("https://example.com/$(touch)/;a").unwrap(),
            "https://example.com/$(touch)/;a"
        );
    }
}
