//! Locate the Cline credential the Cline CLI already holds.
//!
//! This module reads; it never writes. Cline's access token is short-lived
//! (five hours) and refreshing it rotates the refresh token, so a refresh
//! performed here would invalidate the copy `~/.cline` holds and log the
//! user's own CLI out. Refreshing belongs to the CLI that owns the file — the
//! widget reports "sign-in expired" instead, exactly as it would for any other
//! credential it does not own.

#[path = "store_schema.rs"]
mod store_schema;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::cache::home_dir;
use crate::error::{AppError, Result};

/// The Cline CLI's provider store, relative to the home directory.
pub const AUTH_FILE: &str = ".cline/data/settings/providers.json";

/// Env override, for a machine where the CLI is not installed at all. Cline
/// issues these from Settings → API Keys at app.cline.bot.
pub const API_KEY_ENV: &str = "CLINE_API_KEY";

pub const SIGNED_OUT: &str =
    "Cline is not signed in. Run `cline auth` to sign in, or set CLINE_API_KEY.";
pub const EXPIRED: &str = "Cline sign-in expired. Run `cline auth` to sign in again.";

/// A credential and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    /// Sent verbatim as the bearer token. Cline's own tokens carry a
    /// `workos:` prefix that the API requires, so nothing is stripped here.
    pub token: String,
    /// The Cline user id (`usr-…`) the token belongs to, when the store
    /// records it. Saves a `/users/me` round trip on every refresh.
    pub account_id: Option<String>,
    pub source: String,
    /// The store's own expiry has passed, so the API will reject this token.
    ///
    /// Returned rather than withheld: the account id travels with it, which
    /// is what lets the vendor serve its cached ledger — correctly aged — for
    /// the hours between two Cline sessions, instead of blanking the bar
    /// every night. Only the CLI can mint a fresh token; see the module note.
    pub expired: bool,
}

/// One candidate found on disk, before expiry is considered.
struct Candidate {
    token: String,
    account_id: Option<String>,
    expires_ms: Option<i64>,
}

/// Store precedence from Cline CLI 3.0.74's `resolveProviderSettingsPath`.
pub fn default_paths() -> Result<Vec<PathBuf>> {
    let path = if let Some(path) = cli_path("CLINE_PROVIDER_SETTINGS_PATH")? {
        path
    } else if let Some(path) = cli_path("CLINE_DATA_DIR")? {
        path.join("settings/providers.json")
    } else if let Some(path) = cli_path("CLINE_DIR")? {
        path.join("data/settings/providers.json")
    } else {
        home_dir()?.join(AUTH_FILE)
    };
    #[cfg(windows)]
    if path != home_dir()?.join(AUTH_FILE) {
        return Err(AppError::Credentials(
            "Cline profile environment overrides are unavailable on Windows; configure explicit auth_paths or an API key".into(),
        ));
    }
    if path.as_os_str().len() > 4096 {
        return Err(AppError::Credentials(
            "Cline credential store path is invalid".into(),
        ));
    }
    Ok(vec![path])
}
fn cli_path(name: &str) -> Result<Option<PathBuf>> {
    let Some(value) = std::env::var_os(name) else {
        return Ok(None);
    };
    let invalid = || AppError::Credentials("Cline credential store path is invalid".into());
    let value = value.to_str().ok_or_else(invalid)?;
    // ECMAScript trim includes BOM and excludes Unicode White_Space's NEL.
    let value = trim_cli(value);
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 4096 || value.contains('\0') {
        return Err(invalid());
    }
    Ok(Some(value.into()))
}

fn trim_cli(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

/// Read whichever credential the CLI wrote into `path`.
///
/// A missing or malformed file yields `None` rather than an error so a second
/// configured path still gets its turn.
pub fn read_from(path: &Path) -> Option<Credential> {
    let text = read_store(path)?;
    let now = now_ms();
    selected_candidate(&text).map(|found| Credential {
        token: found.token,
        account_id: found.account_id,
        source: path.display().to_string(),
        expired: found.expires_ms.is_some_and(|expires| expires <= now),
    })
}

/// Follow ordinary symlinks to a regular store; reject devices and bound growth.
fn read_store(path: &Path) -> Option<String> {
    use std::io::Read;
    const LIMIT: u64 = 1024 * 1024;
    let before = std::fs::metadata(path).ok()?;
    if !before.is_file() || before.len() > LIMIT {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A regular-file-to-FIFO replacement must not block during open.
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > LIMIT {
        return None;
    }
    let mut text = String::new();
    file.take(LIMIT + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= LIMIT).then_some(text)
}

/// Follow the CLI's selected Cline-family provider, never token-expiry ranking.
fn selected_candidate(text: &str) -> Option<Candidate> {
    let value: Value = serde_json::from_str(text).ok()?;
    let providers = value.get("providers")?.as_object()?;
    if !store_schema::valid(&value) {
        return None;
    }
    let canonical = providers.get("cline");
    if value.get("lastUsedProvider").and_then(Value::as_str) == Some("cline-pass") {
        if let Some(pass) = providers.get("cline-pass") {
            let settings = cline_settings(pass)?;
            // Direct auth, including an empty object, overrides inherited auth.
            if settings.get("auth").is_some() {
                return candidate(pass);
            }
        }
        return canonical.and_then(candidate);
    }
    canonical.and_then(candidate)
}
fn cline_settings(provider: &Value) -> Option<&Value> {
    let settings = provider.get("settings")?;
    matches!(
        settings.get("provider")?.as_str(),
        Some("cline" | "cline-pass")
    )
    .then_some(settings)
}

fn candidate(provider: &Value) -> Option<Candidate> {
    let settings = cline_settings(provider)?;
    let auth = settings.get("auth")?;
    let token = auth
        .get("accessToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())?
        .to_string();
    Some(Candidate {
        token,
        account_id: auth
            .get("accountId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
        expires_ms: auth
            .get("expiresAt")
            .and_then(Value::as_f64)
            .map(|n| n as i64),
    })
}

/// Production resolver: the env override, then configured paths, then the
/// platform default. Tests use [`resolve_from`], which takes both as inputs.
pub fn resolve(
    configured: Option<&[PathBuf]>,
    env_var_name: &str,
    inline_key: Option<&str>,
) -> Result<Credential> {
    let env_key = crate::config::optional_api_key(env_var_name, inline_key);
    if env_key.is_some() {
        return resolve_from(env_key.as_deref(), &[]);
    }
    let paths = match configured {
        Some(paths) if !paths.is_empty() => paths.to_vec(),
        _ => default_paths()?,
    };
    resolve_from(None, &paths)
}

/// Resolve one credential from the environment, then each path in turn.
pub fn resolve_from(env_key: Option<&str>, paths: &[PathBuf]) -> Result<Credential> {
    if let Some(key) = env_key.map(str::trim).filter(|key| !key.is_empty()) {
        return Ok(Credential {
            token: key.to_string(),
            account_id: None,
            source: API_KEY_ENV.to_string(),
            expired: false,
        });
    }
    for path in paths {
        if let Some(credential) = read_from(path) {
            return Ok(credential);
        }
    }
    Err(AppError::Credentials(message_for(paths)))
}

/// Reached only when no store held a token at all — a lapsed one is returned
/// flagged rather than withheld, so "expired" is reported by the vendor with
/// the cached figures beside it.
fn message_for(_paths: &[PathBuf]) -> String {
    SIGNED_OUT.to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW_MS: i64 = 1_788_000_000_000;

    fn store(entries: &str) -> String {
        format!(r#"{{"version":1,"providers":{{{entries}}}}}"#)
    }

    fn entry(name: &str, token: &str, expires: i64) -> String {
        format!(
            r#""{name}":{{"updatedAt":"2026-11-04T00:00:00.000Z","settings":{{"provider":"{name}","auth":{{"accessToken":"{token}","accountId":"usr-1","expiresAt":{expires}}}}}}}"#
        )
    }

    fn saved_store(token: &str, expires: i64) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let path = directory.path().join("providers.json");
        std::fs::write(&path, store(&entry("cline", token, expires))).expect("write store");
        (directory, path)
    }

    #[test]
    fn canonical_entry_is_not_replaced_by_a_newer_legacy_account() {
        let text = store(&format!(
            "{},{}",
            entry("cline-pass", "different", NOW_MS + 3_600_000),
            entry("cline", "current", NOW_MS + 60_000)
        ));

        let found = selected_candidate(&text).expect("a live credential");
        assert_eq!(found.token, "current");
        assert_eq!(found.account_id.as_deref(), Some("usr-1"));
    }

    #[test]
    fn canonical_entry_is_selected_without_ranking_other_accounts() {
        let text = store(&format!(
            "{},{}",
            entry("cline-pass", "lapsed", NOW_MS - 1),
            entry("cline", "live", NOW_MS + 1_000)
        ));

        let found = selected_candidate(&text).expect("a live credential");
        assert_eq!(found.token, "live");
    }

    #[test]
    fn a_lapsed_token_is_returned_flagged_not_withheld() {
        let (_dir, path) = saved_store("lapsed", 1);

        let credential = read_from(&path).expect("a lapsed credential is still a credential");
        assert!(credential.expired);
        assert_eq!(credential.account_id.as_deref(), Some("usr-1"));
    }

    #[test]
    fn keeps_the_workos_prefix_the_api_requires() {
        let text = store(&entry("cline", "workos:eyJhbGciOi", NOW_MS + 1000));
        assert_eq!(
            selected_candidate(&text).expect("credential").token,
            "workos:eyJhbGciOi"
        );
    }

    #[test]
    fn an_entry_without_an_expiry_is_still_usable() {
        let text = store(
            r#""cline":{"updatedAt":"2026-11-04T00:00:00.000Z","settings":{"provider":"cline","auth":{"accessToken":"forever"}}}"#,
        );
        let found = selected_candidate(&text).expect("credential");
        assert_eq!(found.token, "forever");
        assert!(found.account_id.is_none());
    }

    #[test]
    fn malformed_stores_are_not_credentials() {
        for text in [
            "not json".to_string(),
            "{}".to_string(),
            store(""),
            store(r#""cline":{"settings":{}}"#),
            store(r#""cline":{"settings":{"auth":{"accessToken":"  "}}}"#),
        ] {
            assert!(
                selected_candidate(&text).is_none(),
                "unexpectedly accepted {text}"
            );
        }
    }

    #[test]
    fn env_key_wins_over_every_path() {
        let credential = resolve_from(Some("sk-cline"), &[PathBuf::from("/nonexistent")])
            .expect("env credential");
        assert_eq!(credential.token, "sk-cline");
        assert_eq!(credential.source, API_KEY_ENV);
    }

    #[test]
    fn a_missing_store_reports_signed_out_not_expired() {
        let error = resolve_from(None, &[PathBuf::from("/nonexistent/providers.json")])
            .expect_err("no credential");
        assert!(error.to_string().contains("not signed in"));
    }

    #[test]
    fn an_expired_store_resolves_to_a_flagged_credential() {
        let (_dir, path) = saved_store("lapsed", 1);

        let credential = resolve_from(None, &[path]).expect("a lapsed credential resolves");
        assert!(credential.expired);
    }
}
