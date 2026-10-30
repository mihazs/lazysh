//! Headless identity, provider dispatch and cache freshness extracted from upstream TUI composition.
use crate::cache::DEFAULT_TTL;
use crate::config::{Config, CustomProviderConfig};
use crate::error::{AppError, Result};
use crate::outcome::fetch_api_keyed;
use crate::vendor::{VendorId, VendorOutcome};
use chrono::Utc;
use reqwest::Client;
use std::collections::HashSet;
use std::time::Duration;
/// What we display per vendor — raw snapshot + fetch metadata for native
/// panel rendering, or an error message when the fetch failed.
///
/// `Ready` is boxed because the snapshot is much larger than the other two
/// variants (silences `clippy::large_enum_variant`).
#[derive(Debug, Clone)]
pub enum TabState {
    Loading,
    Ready(Box<ReadyTab>),
    Error {
        message: String,
        /// Vendor plan already known from credentials when the quota fetch
        /// failed (Claude OAuth `subscriptionType`). Absent when the vendor
        /// has no plan without a snapshot.
        plan: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct ReadyTab {
    pub snapshot: crate::usage::VendorSnapshot,
    pub stale: bool,
    pub last_error: Option<(u16, String)>,
    /// Absolute moment the cache was written (i.e. the API response landed).
    /// Snapshotted once at TabState build time so the rendered "Updated …"
    /// timestamp stays stable across redraws instead of drifting with the
    /// passing wall clock.
    pub fetched_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Bar-number settings this vendor was configured with — the tank size a
    /// prepaid balance is metered against, and which of the two numbers goes on
    /// the bar. Resolved from config at fetch time rather than stored in the
    /// snapshot, so editing config.toml takes effect on the next redraw instead
    /// of waiting for the cache to expire.
    pub display: crate::balance::DisplayPrefs,
}

/// Where a tab's usage comes from: a built-in vendor, or a user-declared
/// `[[custom]]` HTTP provider. A custom tab carries its own display names so
/// the TUI and the report never need the config again just to label it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TabSource {
    Builtin(VendorId),
    Custom {
        id: String,
        name: String,
        short_name: String,
    },
}

impl TabState {
    pub fn error(message: impl AsRef<str>) -> Self {
        Self::error_with_plan(message, None)
    }

    pub fn error_with_plan(message: impl AsRef<str>, plan: Option<String>) -> Self {
        let plan = plan.and_then(|plan| {
            let cleaned = crate::display::sanitize_untrusted_field(plan.trim());
            if cleaned.is_empty() || cleaned.eq_ignore_ascii_case("unknown") {
                None
            } else {
                Some(cleaned)
            }
        });
        Self::Error {
            message: message.as_ref().to_string(),
            plan,
        }
    }
}

/// Identity of one TUI tab. Usually a whole vendor; Claude and OpenRouter can
/// also name a configured account. `account: None` is a plain vendor tab or
/// that vendor's default account.
/// `desktop` marks an account whose usage comes from the Claude Desktop app's
/// own token rather than a `claude` CLI credential.
/// Custom providers never carry an account or a desktop flag.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TabId {
    pub source: TabSource,
    pub account: Option<String>,
    pub desktop: bool,
}

impl TabId {
    /// A plain vendor tab (default account for Anthropic).
    pub fn vendor(vendor: VendorId) -> Self {
        Self {
            source: TabSource::Builtin(vendor),
            account: None,
            desktop: false,
        }
    }

    /// A named Anthropic account tab (`[[anthropic.accounts]]` label).
    pub fn account(label: impl Into<String>) -> Self {
        Self::account_for(VendorId::Anthropic, label)
    }

    /// A named account for a vendor that supports account arrays.
    pub fn account_for(vendor: VendorId, label: impl Into<String>) -> Self {
        Self {
            source: TabSource::Builtin(vendor),
            account: Some(label.into()),
            desktop: false,
        }
    }

    /// An Anthropic account whose usage is read from the Claude Desktop app's
    /// own token store (a saved `~/.claude-acc/profiles/<label>` account).
    pub fn desktop_account(label: impl Into<String>) -> Self {
        Self {
            source: TabSource::Builtin(VendorId::Anthropic),
            account: Some(label.into()),
            desktop: true,
        }
    }

    /// A user-declared `[[custom]]` provider tab.
    pub fn custom(spec: &CustomProviderConfig) -> Self {
        Self {
            source: TabSource::Custom {
                id: spec.id.clone(),
                name: spec.name.clone(),
                short_name: spec.short_name.clone(),
            },
            account: None,
            desktop: false,
        }
    }

    /// The built-in vendor behind this tab; `None` for a custom provider.
    /// (Named `vendor_id` because `TabId::vendor` is the constructor.)
    pub fn vendor_id(&self) -> Option<VendorId> {
        match &self.source {
            TabSource::Builtin(vendor) => Some(*vendor),
            TabSource::Custom { .. } => None,
        }
    }
}

/// Expand enabled vendors into the tab list. Claude, OpenRouter, and Codex
/// (OpenAI) yield their default account followed by configured named accounts;
/// every other vendor is a single tab. With no extra accounts and
/// `overview_vendors` unset, the result equals `config.enabled_vendors()` in
/// canonical order. When the list is set, listed vendors lead and unlisted
/// enabled vendors follow in that same canonical order.
///
/// Config-only and pure — no Desktop profiles. Production uses
/// [`tabs_with_desktop`]; this stays for the hermetic unit tests and any caller
/// that only wants configured accounts.
pub fn tabs_from_config(config: &Config) -> Vec<TabId> {
    build_tabs(config, &[])
}

/// The production aggregate-view tab list: configured accounts plus every saved
/// Claude Desktop profile that has usable credentials. Desktop discovery is
/// best-effort and macOS-only; anywhere else this equals [`tabs_from_config`].
pub fn tabs_with_desktop(config: &Config) -> Vec<TabId> {
    build_tabs(config, &desktop_profile_labels(config))
}

/// Enabled vendors in `[ui] overview_vendors` order. Unlisted vendors keep
/// the canonical order and follow the listed ones. Unset means canonical.
fn vendors_for_tabs(config: &Config) -> Vec<VendorId> {
    let enabled = config.enabled_vendors();
    let Some(wanted) = config.ui.overview_vendors.as_ref() else {
        return enabled;
    };
    let mut ordered = Vec::with_capacity(enabled.len());
    for vendor in wanted {
        if enabled.contains(vendor) && !ordered.contains(vendor) {
            ordered.push(*vendor);
        }
    }
    for vendor in enabled {
        if !ordered.contains(&vendor) {
            ordered.push(vendor);
        }
    }
    ordered
}

/// Core expansion, parameterized on the Desktop account labels so it stays pure
/// and unit-testable. Desktop accounts follow the CLI accounts and count toward
/// "Anthropic has accounts" for the default-tab suppression.
///
/// In aggregate views, a label present in both a `[[anthropic.accounts]]` CLI
/// entry and a Desktop profile is sourced from **Desktop**, and the CLI entry is
/// dropped. The same account in two stores means two of them refreshing one
/// rotating refresh token — each rotation invalidates the other's copy — and
/// the CLI copy can even refresh to a stale/wrong identity that still
/// authenticates but reports another account's (often zero) usage, which no
/// credential-health check can catch. The app-maintained Desktop token is the
/// one source that avoids both the rotation war and that silent misattribution.
fn build_tabs(config: &Config, desktop_labels: &[String]) -> Vec<TabId> {
    let desktop_set: HashSet<&str> = desktop_labels.iter().map(String::as_str).collect();
    let mut tabs = Vec::new();
    for vendor in vendors_for_tabs(config) {
        if vendor == VendorId::Anthropic {
            let accounts: Vec<_> = config
                .anthropic
                .all_accounts()
                .into_iter()
                .filter(|a| !desktop_set.contains(a.label.as_str()))
                .collect();
            // The default (unnamed) Claude tab is suppressible once every
            // account is named — but never when it would leave Anthropic with
            // no tab at all. Desktop accounts count as named accounts here.
            if config.anthropic.show_default_account
                || (accounts.is_empty() && desktop_labels.is_empty())
            {
                tabs.push(TabId::vendor(vendor));
            }
            for acct in accounts {
                tabs.push(TabId::account(acct.label));
            }
            for label in desktop_labels {
                tabs.push(TabId::desktop_account(label.clone()));
            }
        } else if let Some(accounts) = config.api_key_accounts(vendor) {
            if config.show_default_api_key_account(vendor) || accounts.is_empty() {
                tabs.push(TabId::vendor(vendor));
            }
            for account in accounts {
                tabs.push(TabId::account_for(vendor, account.label.clone()));
            }
        } else if vendor == VendorId::Openai {
            if config.openai.show_default_account || config.openai.accounts.is_empty() {
                tabs.push(TabId::vendor(vendor));
            }
            for account in &config.openai.accounts {
                tabs.push(TabId::account_for(vendor, account.label.clone()));
            }
        } else if vendor == VendorId::Copilot {
            if config.copilot.show_default_account || config.copilot.accounts.is_empty() {
                tabs.push(TabId::vendor(vendor));
            }
            for account in &config.copilot.accounts {
                tabs.push(TabId::account_for(vendor, account.label.clone()));
            }
        } else if vendor == VendorId::Devin {
            if config.devin.show_default_account || config.devin.accounts.is_empty() {
                tabs.push(TabId::vendor(vendor));
            }
            for account in &config.devin.accounts {
                tabs.push(TabId::account_for(vendor, account.label.clone()));
            }
        } else {
            tabs.push(TabId::vendor(vendor));
        }
    }
    // Custom providers follow every built-in vendor, in config order.
    for spec in config.enabled_custom() {
        tabs.push(TabId::custom(spec));
    }
    tabs
}

/// Labels of saved Claude Desktop profiles with usable credentials. macOS-only
/// (elsewhere there is no Desktop app); best-effort, so an unreadable profile
/// store just yields none rather than failing the whole tab list.
#[cfg(target_os = "macos")]
fn desktop_profile_labels(config: &Config) -> Vec<String> {
    let Ok(paths) = crate::claude_desktop::Paths::resolve(&config.anthropic) else {
        return Vec::new();
    };
    if !paths.available() {
        return Vec::new();
    }
    crate::claude_desktop::load_profiles(&paths.profiles_dir)
        .into_iter()
        .filter(|p| p.has_credentials)
        .map(|p| p.label)
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn desktop_profile_labels(_config: &Config) -> Vec<String> {
    Vec::new()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    Cached,
    Wire,
}

impl Freshness {
    /// The cache TTL this mode grants: zero for `Wire`, which the cache's
    /// pre-network hook treats as "never fresh" in every branch.
    pub fn ttl(self) -> Duration {
        match self {
            Freshness::Cached => DEFAULT_TTL,
            Freshness::Wire => Duration::ZERO,
        }
    }
}

/// Fetch and render one tab — returns a `TabState`.
pub async fn refresh_one(
    client: &Client,
    config: &Config,
    tab: &TabId,
    freshness: Freshness,
) -> TabState {
    match build_outcome(client, config, tab, freshness).await {
        Ok(outcome) => {
            // Resolve the cache age (a duration from "now" at fetch time) into an
            // absolute instant ONCE. Without this, sections_for would recompute
            // `Utc::now() - cache_age` on every draw and the displayed time would
            // tick upward in real time instead of holding at the last refresh.
            let now = Utc::now();
            let fetched_at = outcome
                .cache_age
                .map(|age| now - chrono::Duration::from_std(age).unwrap_or_default());
            TabState::Ready(Box::new(ReadyTab {
                snapshot: outcome.snapshot,
                stale: outcome.stale,
                last_error: outcome.last_error.map(|(code, message)| {
                    (code, crate::display::sanitize_untrusted_field(&message))
                }),
                fetched_at,
                display: match &tab.source {
                    TabSource::Builtin(vendor) => config.display_prefs(*vendor),
                    // A `[[custom]]` provider states its own percentages; it has
                    // no balance to meter and no headline to choose.
                    TabSource::Custom { .. } => crate::balance::DisplayPrefs::default(),
                },
            }))
        }
        Err(e) => TabState::error_with_plan(
            crate::display::sanitize_untrusted_field(&e.user_message()),
            e.plan().map(str::to_string),
        ),
    }
}

/// Key and cache for an API-key vendor tab: a named account's key with its own
/// `<slug>/<label>` cache, or the default key with the vendor-root cache, whose
/// path never moves (issue #14).
fn api_key_and_cache(
    config: &Config,
    vendor: VendorId,
    account: Option<&str>,
) -> Result<(String, crate::cache::Cache)> {
    let api_key = config.resolve_account_api_key_for(vendor, account)?;
    let cache = match account {
        Some(label) => crate::cache::Cache::for_vendor_account(vendor.slug(), label)?,
        None => crate::cache::Cache::for_vendor(vendor.slug())?,
    }
    // The fetch goes out with this key and a provider's answer can quote it
    // back: the cache redacts it at the first point of writing, so the key
    // never reaches `.last_error` (nor the pair the fetch returns with it).
    .redacting(&api_key);
    Ok((api_key, cache))
}

// The key-based vendors' fetch wrap is `crate::outcome::fetch_api_keyed`,
// shared with the widget/CLI; the cache side is attached by `api_key_and_cache`.

async fn build_outcome(
    client: &Client,
    config: &Config,
    tab: &TabId,
    freshness: Freshness,
) -> Result<VendorOutcome> {
    let vendor = match &tab.source {
        TabSource::Builtin(vendor) => *vendor,
        TabSource::Custom { id, .. } => {
            // A custom provider owns its TTL and its cache slot; the cache is
            // keyed by the provider id under one shared `custom` vendor dir.
            let spec = config.custom_by_id(id).ok_or_else(|| {
                AppError::Other(format!("custom provider {id} is not configured"))
            })?;
            let api_key = spec.resolve_api_key()?;
            let cache = crate::cache::Cache::for_vendor_account("custom", id)?.redacting(&api_key);
            let outcome =
                crate::custom::fetch_snapshot(client, spec, &api_key, &cache, spec.cache_ttl())
                    .await?;
            return Ok(outcome.into());
        }
    };
    // The built-in vendors share one TTL; a wire-only read (the key check)
    // grants none. A vendor that owns its TTL (the custom branch above) is
    // already out of this match.
    let ttl = freshness.ttl();
    match vendor {
        VendorId::Anthropic => {
            // A named account resolves to its own file + `anthropic/<label>`
            // cache, shared with the widget via `account_target` (#14/#17).
            // The default tab keeps the pre-existing resolution: config
            // `credentials_path` is an explicit strict read, and only the
            // platform default gets the macOS Keychain fallback.
            let (creds_target, cache) = match tab.account.as_deref() {
                Some(label) if tab.desktop => {
                    crate::anthropic::desktop_creds::account_target(config, label)?
                }
                Some(label) => config.anthropic.account_target(label)?,
                None => (
                    config.anthropic.default_creds_target(),
                    crate::cache::Cache::for_vendor("anthropic")?,
                ),
            };
            let endpoints = crate::anthropic::fetch::Endpoints::default();
            let outcome =
                crate::anthropic::fetch_snapshot(client, &creds_target, &cache, &endpoints, ttl)
                    .await?;
            Ok(outcome.map(crate::usage::VendorSnapshot::Anthropic))
        }
        VendorId::AnthropicApi => {
            let key = crate::config::resolve_api_key(
                "Anthropic_API",
                &config.anthropic_api.api_key_env,
                config.anthropic_api.api_key.as_deref(),
            )?;
            let cache = crate::cache::Cache::for_vendor("anthropic_api")?.redacting(&key);
            let endpoints = crate::anthropic_api::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::anthropic_api::fetch_snapshot(
                        client,
                        &key,
                        &cache,
                        &endpoints,
                        ttl,
                        config.anthropic_api.monthly_limit,
                    )
                    .await
                    .map(Into::into)
                },
                &key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Openrouter => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let management_key = config.openrouter_management_key(tab.account.as_deref());
            let endpoints = crate::openrouter::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::openrouter::fetch_snapshot(
                        client,
                        &api_key,
                        management_key.as_deref(),
                        &cache,
                        &endpoints,
                        ttl,
                    )
                    .await
                    .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Zai => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let endpoints = crate::zai::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::zai::fetch_snapshot(
                        client,
                        &api_key,
                        &cache,
                        &endpoints,
                        ttl,
                        config.zai.plan_tier.as_deref(),
                    )
                    .await
                    .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Openai => {
            let label = tab.account.as_deref();
            let cache = match label {
                Some(label) => crate::cache::Cache::for_vendor_account("openai", label)?,
                None => crate::cache::Cache::for_vendor("openai")?,
            };
            let route = || config.openai.fetch_auth_path(label);
            let endpoints = crate::openai::fetch::Endpoints::default();
            let outcome =
                crate::openai::fetch_snapshot_routed(client, route, &cache, &endpoints, ttl)
                    .await?;
            Ok(outcome.into())
        }
        VendorId::Copilot => {
            let label = tab.account.as_deref();
            let token = config.copilot.resolve_token_async(label).await?;
            let cache = match label {
                Some(label) => crate::cache::Cache::for_vendor_account("copilot", label)?,
                None => crate::cache::Cache::for_vendor("copilot")?,
            };
            let endpoints = crate::copilot::fetch::Endpoints::default();
            let outcome =
                crate::copilot::fetch_snapshot(client, &token, &cache, &endpoints, ttl).await?;
            Ok(outcome.into())
        }
        VendorId::Deepseek => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let endpoints = crate::deepseek::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::deepseek::fetch_snapshot(client, &api_key, &cache, &endpoints, ttl)
                        .await
                        .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Deepinfra => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let endpoints = crate::deepinfra::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::deepinfra::fetch::fetch_snapshot(
                        client, &api_key, &cache, &endpoints, ttl,
                    )
                    .await
                    .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Kimi => {
            let (auth, endpoints) = crate::kimi::resolve_auth(&config.kimi)?;
            // The API key is the value the user entered and the only one a
            // provider answer could echo back. The Kimi Code CLI's OAuth
            // token is not exposed by `Auth` — `bearer_token` resolves it at
            // fetch time and refreshes rotate it — so that variant carries
            // an empty (no-op) secret.
            let secret = match &auth {
                crate::kimi::fetch::Auth::ApiKey(key) => key.clone(),
                crate::kimi::fetch::Auth::KimiCode(_) => String::new(),
            };
            let cache = crate::cache::Cache::for_vendor("kimi")?.redacting(&secret);
            let outcome = fetch_api_keyed(
                async {
                    crate::kimi::fetch::fetch_snapshot_with_auth(
                        client, &auth, &cache, &endpoints, ttl,
                    )
                    .await
                    .map(Into::into)
                },
                &secret,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Kilo => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let endpoints = crate::kilo::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::kilo::fetch_snapshot(
                        client,
                        &api_key,
                        &cache,
                        &endpoints,
                        ttl,
                        config.kilo.organization_id.as_deref(),
                    )
                    .await
                    .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Novita => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let endpoints = crate::novita::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::novita::fetch_snapshot(client, &api_key, &cache, &endpoints, ttl)
                        .await
                        .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Synthetic => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let endpoints = crate::synthetic::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::synthetic::fetch_snapshot(
                        client,
                        &api_key,
                        &cache,
                        &endpoints,
                        ttl,
                        config.synthetic.plan_tier.as_deref(),
                    )
                    .await
                    .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Moonshot => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let (endpoints, currency) =
                crate::moonshot::fetch::Endpoints::for_region(&config.moonshot.region);
            let outcome = fetch_api_keyed(
                async {
                    crate::moonshot::fetch_snapshot(
                        client, &api_key, &cache, &endpoints, ttl, currency,
                    )
                    .await
                    .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Grok => {
            let (key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let endpoints = crate::grok::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::grok::fetch_snapshot(
                        client,
                        &key,
                        &cache,
                        &endpoints,
                        ttl,
                        config.grok.team_id.as_deref(),
                    )
                    .await
                    .map(Into::into)
                },
                &key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Supergrok => {
            let cache = crate::cache::Cache::for_vendor("supergrok")?;
            let scope_paths = crate::supergrok::scope::ScopePaths::with_overrides(
                config.supergrok.auth_path.as_deref(),
                config.supergrok.config_path.as_deref(),
            )?;
            let outcome = crate::supergrok::fetch_snapshot(
                &config.supergrok.grok_binary,
                &scope_paths,
                &cache,
                ttl,
            )
            .await?;
            Ok(outcome.into())
        }
        VendorId::Antigravity => {
            // No API key: the local Antigravity server is the source, and the
            // saved Google session stands in while nothing is running.
            let cache = crate::cache::Cache::for_vendor("antigravity")?;
            let oauth = crate::antigravity::cloud::OauthClient::from_config(
                config.antigravity.oauth_client_id.as_deref(),
                config.antigravity.oauth_client_secret.as_deref(),
            );
            let outcome = crate::antigravity::fetch_snapshot(
                client,
                &cache,
                ttl,
                oauth.as_ref(),
                config.antigravity.agy_binary.as_deref(),
                config.antigravity.ide_language_server,
            )
            .await?;
            Ok(outcome.into())
        }
        VendorId::Grokbot => {
            // The desktop app's own session is the login; refreshed pairs
            // persist only inside the vendor cache.
            let creds = crate::grokbot::resolve_credentials(&config.grokbot)?;
            let cache = crate::cache::Cache::for_vendor("grokbot")?;
            let endpoints = crate::grokbot::fetch::Endpoints::default();
            let outcome =
                crate::grokbot::fetch::fetch_snapshot_with(client, &creds, &cache, &endpoints, ttl)
                    .await?;
            Ok(outcome.into())
        }
        VendorId::ModelStudio => {
            // The bl CLI's own console session is the login; its region/site
            // pair picks the gateway, and only a token fingerprint persists.
            let creds = crate::modelstudio::resolve_credentials(&config.modelstudio)?;
            let cache = crate::cache::Cache::for_vendor("modelstudio")?;
            let endpoints =
                crate::modelstudio::fetch::Endpoints::for_gateway(creds.region, creds.site);
            let outcome =
                crate::modelstudio::fetch_snapshot_with(client, &creds, &cache, &endpoints, ttl)
                    .await?;
            Ok(outcome.into())
        }
        VendorId::MuseCode => {
            let cache = crate::cache::Cache::for_vendor("muse-code")?;
            Ok(crate::muse::fetch::fetch_snapshot(&config.muse, &cache)
                .await?
                .into())
        }
        VendorId::Devin => {
            let (creds_cfg, cache) = match tab.account.as_deref() {
                Some(label) => {
                    let creds_path = config.devin.resolve_credentials_path(Some(label))?;
                    let mut acct_cfg = config.devin.clone();
                    acct_cfg.credentials_path = Some(creds_path);
                    let cache = crate::cache::Cache::for_vendor_account("devin", label)?;
                    (acct_cfg, cache)
                }
                None => (
                    config.devin.clone(),
                    crate::cache::Cache::for_vendor("devin")?,
                ),
            };
            let outcome = crate::devin::fetch::fetch_snapshot(&creds_cfg, &cache, ttl).await?;
            Ok(outcome.into())
        }
        VendorId::Droid => {
            let cache = crate::cache::Cache::for_vendor("droid")?;
            let outcome = crate::droid::fetch::fetch_snapshot(&config.droid, &cache, ttl).await?;
            Ok(outcome.into())
        }
        VendorId::Minimax => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let endpoints = crate::minimax::fetch::Endpoints::for_region(&config.minimax.region);
            let outcome = fetch_api_keyed(
                async {
                    crate::minimax::fetch_snapshot(client, &api_key, &cache, &endpoints, ttl)
                        .await
                        .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Cursor => {
            let cache = crate::cache::Cache::for_vendor("cursor")?;
            let db_path = config
                .cursor
                .db_path
                .clone()
                .map(Ok)
                .unwrap_or_else(crate::cursor::db::default_db_path)?;
            let agent_auth_path = config
                .cursor
                .agent_auth_path
                .clone()
                .map(Ok)
                .unwrap_or_else(crate::cursor::db::default_agent_auth_path)?;
            let endpoints = crate::cursor::fetch::Endpoints::default();
            let outcome = crate::cursor::fetch_snapshot(
                client,
                &db_path,
                &agent_auth_path,
                &cache,
                &endpoints,
                ttl,
            )
            .await?;
            Ok(outcome.into())
        }
        VendorId::Kiro => {
            let cache = crate::cache::Cache::for_vendor("kiro")?;
            let db_path = config
                .kiro
                .db_path
                .clone()
                .map(Ok)
                .unwrap_or_else(crate::kiro::db::default_db_path)?;
            let outcome = crate::kiro::fetch_snapshot(client, &db_path, &cache, ttl).await?;
            Ok(outcome.into())
        }
        VendorId::NousResearch => {
            let store = crate::nous::credentials::CredentialStore::default();
            let endpoints = crate::nous::fetch::Endpoints::default();
            let account = crate::nous::fetch::fetch_account_with_refresh(
                client,
                &store,
                &endpoints,
                Utc::now(),
            )
            .await?;
            // Nous keeps no cache of its own, so every read is a live one.
            Ok(crate::outcome::Outcome::fresh(
                crate::usage::VendorSnapshot::NousResearch(account),
            ))
        }
        VendorId::OpenCodeGo => {
            let api_key = crate::opencode_go::creds::resolve_key(
                &config.opencode_go.api_key_env,
                config.opencode_go.api_key.as_deref(),
                config.opencode_go.auth_paths.as_deref(),
            )?;
            let cache = crate::cache::Cache::for_vendor("opencode-go")?.redacting(&api_key);
            let endpoints = crate::opencode_go::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::opencode_go::fetch::fetch_snapshot(
                        client, &api_key, &cache, &endpoints, ttl,
                    )
                    .await
                    .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Cline => {
            let credential = crate::cline::creds::resolve(
                config.cline.auth_paths.as_deref(),
                &config.cline.api_key_env,
                config.cline.api_key.as_deref(),
            )?;
            let cache = crate::cache::Cache::for_vendor("cline")?;
            let endpoints = crate::cline::fetch::Endpoints::default();
            let outcome = crate::cline::fetch::fetch_snapshot(
                client,
                &credential,
                &cache,
                &endpoints,
                ttl,
                Utc::now(),
            )
            .await?;
            Ok(outcome.into())
        }
        VendorId::CommandCode => {
            let credential =
                crate::commandcode::creds::resolve(config.commandcode.auth_paths.as_deref())?;
            let cache = crate::cache::Cache::for_vendor("commandcode")?;
            let endpoints = crate::commandcode::fetch::Endpoints::default();
            let outcome = crate::commandcode::fetch::fetch_snapshot(
                client,
                &credential.token,
                &cache,
                &endpoints,
                ttl,
            )
            .await?;
            Ok(outcome.into())
        }
        VendorId::Ollama => {
            let api_key = crate::config::resolve_api_key(
                "Ollama",
                &config.ollama.api_key_env,
                config.ollama.api_key.as_deref(),
            )?;
            let cache = crate::cache::Cache::for_vendor("ollama")?.redacting(&api_key);
            let endpoints = crate::ollama::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::ollama::fetch_snapshot(
                        client,
                        &api_key,
                        &config.ollama.plan,
                        &cache,
                        &endpoints,
                        ttl,
                    )
                    .await
                    .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::OrcaRouter => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let endpoints = crate::orcarouter::fetch::Endpoints::default();
            let outcome = fetch_api_keyed(
                async {
                    crate::orcarouter::fetch_snapshot(client, &api_key, &cache, &endpoints, ttl)
                        .await
                        .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
        VendorId::Lyceum => {
            let (api_key, cache) = api_key_and_cache(config, vendor, tab.account.as_deref())?;
            let outcome = fetch_api_keyed(
                async {
                    crate::lyceum::fetch::fetch_snapshot(client, &api_key, &cache, ttl)
                        .await
                        .map(Into::into)
                },
                &api_key,
            )
            .await?;
            Ok(outcome)
        }
    }
}
