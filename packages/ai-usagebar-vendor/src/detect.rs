use crate::{config::Config, vendor::VendorId};
use std::path::Path;
/// Cheap, local-only probe: files, sqlite, saved keys, env vars. Never the
/// network. `true` means the vendor's fetch would find *a* credential — not
/// that the credential is still valid, which only the wire can tell.
///
/// Exhaustive over [`VendorId`] on purpose: a new vendor fails to compile
/// until it says how it is detected.
pub fn has_local_credentials(vendor: VendorId, config: &Config) -> bool {
    match vendor {
        VendorId::Anthropic => anthropic_present(config),
        VendorId::AnthropicApi => key_present(config, vendor),
        VendorId::Openai => {
            config
                .openai
                .resolve_auth_path(None)
                .is_ok_and(|path| crate::openai::creds::read_from(&path).is_ok())
                || config.openai.accounts.iter().any(|account| {
                    crate::openai::creds::read_from(&account.codex_auth_path).is_ok()
                })
        }
        VendorId::Copilot => copilot_present(),
        VendorId::Zai => key_present(config, vendor),
        VendorId::Openrouter => key_present(config, vendor),
        VendorId::Deepseek => key_present(config, vendor),
        VendorId::Deepinfra => key_present(config, vendor),
        VendorId::Kimi => crate::kimi::resolve_auth(&config.kimi).is_ok(),
        VendorId::Kilo => key_present(config, vendor),
        VendorId::Novita => key_present(config, vendor),
        VendorId::Synthetic => key_present(config, vendor),
        VendorId::Moonshot => key_present(config, vendor),
        VendorId::Grok => key_present(config, vendor),
        VendorId::Supergrok => crate::supergrok::scope::ScopePaths::with_overrides(
            config.supergrok.auth_path.as_deref(),
            config.supergrok.config_path.as_deref(),
        )
        .is_ok_and(|paths| crate::supergrok::direct::read_billing_key(&paths.auth).is_ok()),
        // File-exists only: decrypting would mean a `secret-tool` / Keychain
        // subprocess, and a probe that runs at every frontend start must not
        // spawn one.
        VendorId::Grokbot => crate::grokbot::secrets_path(&config.grokbot)
            .map(|path| crate::grokbot::creds::secrets_present_at(&path))
            .unwrap_or(false),
        VendorId::Antigravity => antigravity_present(),
        VendorId::Cursor => cursor_present(config),
        VendorId::Minimax => key_present(config, vendor),
        VendorId::Kiro => {
            let path = match config.kiro.db_path.clone() {
                Some(path) => path,
                None => match crate::kiro::db::default_db_path() {
                    Ok(path) => path,
                    Err(_) => return false,
                },
            };
            crate::kiro::db::read_credentials(&path).is_ok()
        }
        VendorId::NousResearch => {
            // `read_unlocked`, not `read`: the latter takes the store lock,
            // which creates the lock file and a 0700 config dir as a side
            // effect. A probe must leave no trace.
            let store = crate::nous::credentials::CredentialStore::at(
                crate::nous::credentials::default_credentials_path(),
            );
            matches!(store.read_unlocked(), Ok(Some(_)))
        }
        // An explicit key wins; otherwise the read-only credential the
        // official OpenCode CLI already wrote (a signed-in user appears even
        // before configuring anything).
        VendorId::OpenCodeGo => {
            key_present(config, vendor)
                || crate::opencode_go::creds::probe(config.opencode_go.auth_paths.as_deref())
        }
        VendorId::CommandCode => {
            crate::commandcode::creds::resolve(config.commandcode.auth_paths.as_deref()).is_ok()
        }
        VendorId::Cline => crate::cline::creds::resolve(
            config.cline.auth_paths.as_deref(),
            &config.cline.api_key_env,
            config.cline.api_key.as_deref(),
        )
        .is_ok(),
        VendorId::Ollama => key_present(config, vendor),
        VendorId::OrcaRouter => key_present(config, vendor),
        VendorId::Lyceum => key_present(config, vendor),
        // File-exists only, like Grok Bot: parsing the JSON here would be
        // wasted work — the fetch reads the same file and reports honestly.
        VendorId::ModelStudio => crate::modelstudio::config_path(&config.modelstudio)
            .map(|path| crate::modelstudio::creds::config_present_at(&path))
            .unwrap_or(false),
        VendorId::MuseCode => crate::muse::creds::path(&config.muse)
            .map(|path| path.is_file())
            .unwrap_or(false),
        VendorId::Devin => {
            crate::devin::credentials_path(&config.devin)
                .map(|path| path.is_file())
                .unwrap_or(false)
                || config
                    .devin
                    .accounts
                    .iter()
                    .any(|a| a.credentials_path.is_file())
        }
        // File-exists only: the keyring decrypt happens at fetch time, which
        // reports the real failure honestly. Droid is opt-in, so this probe
        // only feeds `detect` reporting, never auto-enable.
        VendorId::Droid => crate::droid::keyring_path()
            .map(|path| path.is_file())
            .unwrap_or(false),
    }
}

/// A key vendor: the configured env var (`api_key_env`, defaulting to
/// `VendorId::api_key_env`) or the inline `api_key`, exactly as the fetch
/// resolves them. `Config::api_key_env_for` / `inline_api_key` are the shared
/// per-vendor lookup, so a new key vendor needs no arm of its own here. A
/// named `[[<vendor>.accounts]]` key counts too: those accounts get tabs of
/// their own, so a config with only named keys can still fetch.
fn key_present(config: &Config, vendor: VendorId) -> bool {
    crate::config::optional_api_key(
        config.api_key_env_for(vendor),
        config.inline_api_key(vendor),
    )
    .is_some()
        || config
            .api_key_accounts(vendor)
            .unwrap_or(&[])
            .iter()
            .any(|account| {
                crate::config::optional_api_key(
                    account.api_key_env.as_deref().unwrap_or(""),
                    account.api_key.as_deref(),
                )
                .is_some()
            })
}

/// The default Claude account exactly as the fetch resolves it: an explicit
/// `credentials_path` is a strict file read; the platform default adds the
/// macOS Keychain fallback inside `creds::resolve` (gated there, not here).
/// Any named account with a resolvable credential counts as present too.
fn anthropic_present(config: &Config) -> bool {
    use crate::anthropic::creds::{CredsTarget, default_path, resolve};
    let target = match config.anthropic.credentials_path.clone() {
        Some(path) => CredsTarget::Explicit(path),
        None => match default_path() {
            Ok(path) => CredsTarget::Default(path),
            Err(_) => return false,
        },
    };
    resolve(&target).is_ok()
        || config.anthropic.all_accounts().iter().any(|account| {
            resolve(&CredsTarget::Named {
                path: account.credentials_path.clone(),
                config_dir: account.config_dir(),
            })
            .is_ok()
        })
}

/// GitHub Copilot detection is a **new** heuristic, deliberately different
/// from the fetch: the fetch spawns `gh auth token` and lets the GitHub CLI
/// decide, but a probe that runs at every frontend start must not fork a
/// subprocess per vendor. So this asks the two questions `gh auth token`
/// would answer from: an explicit `GITHUB_COPILOT_TOKEN`, or the `hosts.yml`
/// that `gh auth login` has written, at the path `gh` itself would read
/// (`copilot::credentials::default_hosts_path`). A present `hosts.yml` is
/// treated as a login; if the session inside it has been revoked, the fetch
/// reports that, as it would for any stale credential.
fn copilot_present() -> bool {
    if std::env::var_os("GITHUB_COPILOT_TOKEN").is_some_and(|value| !value.is_empty()) {
        return true;
    }
    crate::copilot::credentials::default_hosts_path()
        .is_ok_and(|path| copilot_hosts_present_at(&path))
}

/// A `hosts.yml` counts when it is a regular, non-empty file: `gh auth logout`
/// of the last host leaves an empty document behind, which is not a login.
pub(crate) fn copilot_hosts_present_at(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}

/// Antigravity has no API key: it is "present" when a product is running and
/// reachable, which is a local port question. The env override counts on its
/// own, as it does for the fetch's candidate list. Cheapest check first.
fn antigravity_present() -> bool {
    if std::env::var_os("ANTIGRAVITY_LS_ADDRESS").is_some_and(|value| !value.is_empty()) {
        return true;
    }
    if !crate::antigravity::fetch::discover_ls_ports().is_empty() {
        return true;
    }
    // Antigravity also reports with every product closed, from the Google
    // session it saved. Detecting only a *running* server would skip a
    // provider that works — and because a vendor is looked at once, the miss
    // would stick until `--all`. Our own cached token is the prompt-free
    // signal that the remote path is live; the keyring is deliberately not
    // consulted here.
    crate::cache::Cache::for_vendor(crate::vendor::VendorId::Antigravity.slug()).is_ok_and(
        |cache| {
            crate::antigravity::cloud::has_persisted_session(
                &crate::antigravity::cloud::oauth_cache_path(&cache),
            )
        },
    )
}

fn cursor_present(config: &Config) -> bool {
    let db_path = match config.cursor.db_path.clone() {
        Some(path) => path,
        None => match crate::cursor::db::default_db_path() {
            Ok(path) => path,
            Err(_) => return false,
        },
    };
    let agent_auth_path = match config.cursor.agent_auth_path.clone() {
        Some(path) => path,
        None => match crate::cursor::db::default_agent_auth_path() {
            Ok(path) => path,
            Err(_) => return false,
        },
    };
    crate::cursor::db::resolve_access_token(&db_path, &agent_auth_path).is_ok()
}
