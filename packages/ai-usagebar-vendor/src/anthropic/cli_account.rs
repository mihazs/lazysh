use crate::{config::AnthropicAccount, error::Result};
use serde_json::Value;
use std::path::Path;
const CLAUDE_JSON: &str = ".claude.json";
/// Path to the home `.claude.json` that records the live CLI identity.
pub fn home_claude_json() -> Result<std::path::PathBuf> {
    Ok(crate::cache::home_dir()?.join(CLAUDE_JSON))
}

/// The identity marker inside an account's own `CLAUDE_CONFIG_DIR`.
pub fn marker_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join(CLAUDE_JSON)
}

/// The account UUID recorded in a `.claude.json`, if any.
pub fn account_uuid_in(claude_json: &Path) -> Option<String> {
    oauth_account_in(claude_json)?
        .get("accountUuid")?
        .as_str()
        .filter(|uuid| !uuid.is_empty())
        .map(str::to_string)
}

/// The e-mail recorded alongside it, for display only.
pub fn account_email_in(claude_json: &Path) -> Option<String> {
    oauth_account_in(claude_json)?
        .get("emailAddress")?
        .as_str()
        .filter(|email| !email.is_empty())
        .map(str::to_string)
}

/// Which managed label the live CLI login belongs to.
///
/// `None` when the CLI is signed into something we do not manage — a plain
/// `claude` login done by hand, say. Callers surface that as "unknown" rather
/// than hiding it: it is exactly the case where the named copies may have gone
/// stale behind our back.
pub fn resolve_active_label(
    home_claude_json: &Path,
    accounts: &[AnthropicAccount],
) -> Option<String> {
    let live = account_uuid_in(home_claude_json)?;
    accounts
        .iter()
        .find(|account| {
            account_uuid_in(&account.config_dir().join(CLAUDE_JSON)) == Some(live.clone())
        })
        .map(|account| account.label.clone())
}

fn oauth_account_in(claude_json: &Path) -> Option<Value> {
    let bytes = std::fs::read(claude_json).ok()?;
    let document: Value = serde_json::from_slice(&bytes).ok()?;
    document
        .get("oauthAccount")
        .filter(|v| v.is_object())
        .cloned()
}
