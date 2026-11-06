//! Apprise API stateful-key destination: the Apprise server owns every downstream
//! service URL and secret, so the relay only knows one `/notify/<KEY>` endpoint.
use crate::store::Delivery;
use reqwest::StatusCode;

pub(crate) const MAX_TAGS: usize = 8;
const MAX_KEY: usize = 128;
const MAX_TAG: usize = 64;

fn token(value: &str, max: usize) -> bool {
    (1..=max).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Accepts only an exact `.../notify/<KEY>` path with Apprise's key charset and length.
pub(crate) fn endpoint(url: &reqwest::Url) -> Result<(), String> {
    let mut segments = url.path().rsplitn(3, '/');
    match (segments.next(), segments.next()) {
        (Some(key), Some("notify")) if token(key, MAX_KEY) => Ok(()),
        _ => Err("Require the HTTPS Apprise /notify/<key> endpoint".into()),
    }
}

/// Returns the sorted, deduplicated tag set so order never changes target identity.
pub(crate) fn tags(tags: &[String]) -> Result<Vec<String>, String> {
    if tags.len() > MAX_TAGS || !tags.iter().all(|tag| token(tag, MAX_TAG)) {
        return Err(format!(
            "Require at most {MAX_TAGS} Apprise tags of 1-{MAX_TAG} letters, digits, '_' or '-'"
        ));
    }
    let mut tags = tags.to_vec();
    tags.sort();
    tags.dedup();
    Ok(tags)
}

/// Fixed public sentence per finite state: no prompt, path, command or transcript.
pub(crate) fn body(kind: &str, alias: &str, tags: &[String]) -> serde_json::Value {
    let (body, kind) = match kind {
        "working" => ("An agent is working.", "info"),
        "needs_attention" => ("An agent needs your attention.", "warning"),
        _ => ("An agent finished.", "success"),
    };
    let mut payload = serde_json::json!({
        "title": format!("lazysh · {alias}"),
        "body": body,
        "type": kind,
        "format": "text",
    });
    if !tags.is_empty() {
        // Commas OR the tags; the validated charset cannot form AND expressions.
        payload["tag"] = tags.join(",").into();
    }
    payload
}

/// 200 is success and 424 means some downstream services failed. Other client
/// errors are permanent, while 408, 429 and server errors keep the bounded retry.
pub(crate) fn classify(status: StatusCode) -> Delivery {
    match status.as_u16() {
        200 => Delivery::Accepted,
        424 => Delivery::Partial,
        408 | 429 | 500..=599 => Delivery::Retry,
        _ => Delivery::Rejected,
    }
}
