//! Headless provider quota projection, preserving the upstream schema-one JSON contract.
use crate::config::Config;
use crate::tui::app::{Freshness, TabId, TabSource, TabState, refresh_one, tabs_with_desktop};
use crate::tui::panels::{Section, sections_with_metadata_for};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;
const PACE_TOLERANCE: u32 = 5;
/// Version of the tolerant, machine-readable `usage --json` contract.
/// Increment only when an incompatible change cannot be represented by adding
/// or omitting fields.
const USAGE_SCHEMA_VERSION: u8 = 1;

/// One configured vendor or account.
pub struct Entry {
    id: String,
    name: String,
    display_name: String,
    /// The vendor's `{vendor_short}` code. Frontends that want a Waybar-style
    /// provider tag take it from here rather than keeping their own table.
    short_name: String,
    /// The vendor's bar glyph. Same rule as `short_name`: one table, in Rust.
    icon: String,
    /// Built-in vendor slug whose brand mark this entry should be drawn with.
    /// A built-in is its own brand; a `[[custom]]` provider has one only when
    /// it declared `brand`. The asset itself stays with the frontend — each
    /// ships its own artwork — so this names the provider, never a file.
    brand: Option<String>,
    plan: Option<String>,
    sections: Vec<ReportSection>,
    error: Option<String>,
    stale: bool,
    fetched_at: Option<DateTime<Utc>>,
    /// Structured banked-reset inventory for rich frontends. The human-readable
    /// block remains in `sections` for the text report and older consumers.
    reset_credits: Option<crate::usage::ResetCredits>,
}

#[derive(Debug, Clone)]
pub enum ReportTarget {
    Tab(TabId),
    AntigravityAccount(TabId, Box<crate::antigravity::statusline::AccountSession>),
}

fn report_target_id(target: &ReportTarget) -> String {
    match target {
        ReportTarget::Tab(tab) => tab_id(tab),
        ReportTarget::AntigravityAccount(_, account) => {
            format!("antigravity@{}", account.id_suffix)
        }
    }
}

fn expand_antigravity_tabs(
    tabs: &[TabId],
    accounts: &[crate::antigravity::statusline::AccountSession],
) -> Vec<ReportTarget> {
    let mut targets = Vec::new();
    for tab in tabs {
        if tab.vendor_id() == Some(crate::vendor::VendorId::Antigravity) && !accounts.is_empty() {
            targets.extend(
                accounts.iter().cloned().map(|account| {
                    ReportTarget::AntigravityAccount(tab.clone(), Box::new(account))
                }),
            );
        } else {
            targets.push(ReportTarget::Tab(tab.clone()));
        }
    }
    targets
}

fn report_targets_matching(targets: &[ReportTarget], entry_id: &str) -> Vec<ReportTarget> {
    targets
        .iter()
        .filter(|target| report_target_id(target) == entry_id)
        .cloned()
        .collect()
}

fn report_targets_for_filter(
    targets: &[ReportTarget],
    provider: &str,
    account: Option<&str>,
) -> Vec<ReportTarget> {
    let exact = account.map(|label| format!("{provider}@{label}"));
    targets
        .iter()
        .filter(|target| {
            let id = report_target_id(target);
            exact.as_ref().map_or_else(
                || id == provider || id.starts_with(&format!("{provider}@")),
                |wanted| id == *wanted,
            )
        })
        .cloned()
        .collect()
}

/// Lossless machine-readable projection of a TUI panel row. `metrics` remains
/// available in JSON as a convenience view over only the gauge rows; callers
/// that need every reported value should consume this ordered list.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ReportSection {
    Metric {
        label: String,
        percent: u16,
        value: String,
        detail: String,
        /// Which of `percent` and `value` this metric puts on the bar —
        /// `"percent"` or `"value"`. A consumer that honours it draws the named
        /// one and leaves the other in the detail line, rather than inferring a
        /// balance row from its label. Always present, so no consumer has to
        /// guess; not every consumer reads it — Waybar and GNOME take their bar
        /// text from per-vendor formats instead.
        headline: String,
        severity: String,
        reset_at: Option<DateTime<Utc>>,
        /// Full length of the reset window in seconds, present only when the
        /// vendor states it exactly (rolling 5h/7d windows). A frontend that
        /// wants a pace indicator needs both this and `reset_at`; a calendar
        /// month or an unstated window omits the field rather than guessing.
        #[serde(skip_serializing_if = "Option::is_none")]
        window_secs: Option<u64>,
        /// Sub-group heading the metric belongs under (SuperGrok's product
        /// slices under `"Breakdown"`), so a frontend can draw it compactly
        /// beneath that heading instead of as a peer of the overall meter.
        /// Absent for metrics that stand on their own.
        #[serde(skip_serializing_if = "Option::is_none")]
        group: Option<String>,
        /// Amount the window refills by when it reopens (Synthetic's weekly
        /// credit tick, e.g. `"2%"`). Present only for refill-style windows;
        /// a frontend countdown reads "Regenerates X in …" instead of
        /// "Resets in …".
        #[serde(skip_serializing_if = "Option::is_none")]
        regen: Option<String>,
        /// The percentage with its decimal precision preserved (Synthetic's
        /// weekly budget, e.g. `29.52`). Present only when the vendor's API
        /// reports a fraction; a frontend that prints a figure uses this and
        /// leaves the rounded `percent` to meters and severity colours.
        #[serde(skip_serializing_if = "Option::is_none")]
        percent_precise: Option<f64>,
        /// How a frontend should read the percentage (`"left"` for
        /// refill-style windows): what remains, whatever the global
        /// reading. Fixed windows omit the field and follow the setting.
        #[serde(skip_serializing_if = "Option::is_none")]
        reading: Option<String>,
        /// A per-model quota pool rather than one of the provider's shared
        /// windows (Antigravity's "Gemini 4 Argon"): a frontend that shows one
        /// figure for the provider ranks it below the shared windows, so an
        /// exhausted model does not read as an exhausted provider. Present
        /// only when true.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        model_pool: bool,
    },
    Text {
        label: String,
        value: String,
        /// Spend behind `value`, in USD cents. Present on Cursor's On-Demand
        /// row so a frontend can meter that prepaid cap without parsing the
        /// formatted `$spent / $cap` string. Omitted for every other text row.
        #[serde(skip_serializing_if = "Option::is_none")]
        used_cents: Option<i64>,
        /// Prepaid cap in USD cents. Present only when the cap is positive.
        /// Spend with no cap stays a plain amount in `value`.
        #[serde(skip_serializing_if = "Option::is_none")]
        limit_cents: Option<i64>,
        /// How much of `limit_cents` is already used, rounded half up the same
        /// way a bar percentage is. Above 100 when spend passes the cap.
        /// Present only together with a positive cap.
        #[serde(skip_serializing_if = "Option::is_none")]
        percent: Option<u16>,
        /// Bar colour for `percent`, on the same scale as a metric's.
        #[serde(skip_serializing_if = "Option::is_none")]
        severity: Option<String>,
    },
    Block {
        label: String,
        body: Vec<String>,
    },
    Spacer,
}

impl ReportSection {
    fn label(&self) -> Option<&str> {
        match self {
            Self::Metric { label, .. } | Self::Text { label, .. } | Self::Block { label, .. } => {
                Some(label)
            }
            Self::Spacer => None,
        }
    }
}

async fn entry_for(
    client: &reqwest::Client,
    config: &Config,
    tab: &TabId,
    freshness: Freshness,
) -> Entry {
    let state = refresh_one(client, config, tab, freshness).await;
    entry_from_state_with_config(config, tab, &state, Utc::now())
}

fn entry_from_state_with_config(
    config: &Config,
    tab: &TabId,
    state: &TabState,
    now: chrono::DateTime<Utc>,
) -> Entry {
    let mut entry = entry_from_state(tab, state, now);
    if let TabSource::Custom { id, .. } = &tab.source {
        entry.brand = config
            .custom_by_id(id)
            .and_then(|provider| provider.brand.clone());
    }
    entry
}

/// Consumed percent of a prepaid cap, rounded half up for a non-negative
/// spend. `None` when the cap is not positive. The result is not clamped at
/// 100: spend past the cap is a real percentage, and the bar shows it.
///
/// Half up matches `Math.round` on the non-negative integers a frontend would
/// divide itself. A tie (`.5`) only happens when the cap is even, so adding
/// `limit / 2` before the truncating division is the same rounding.
fn consumed_percent(used: i64, limit: i64) -> Option<u16> {
    if limit <= 0 {
        return None;
    }
    let used = i128::from(used.max(0));
    let limit = i128::from(limit);
    let pct = (used * 100 + limit / 2) / limit;
    Some(u16::try_from(pct).unwrap_or(u16::MAX))
}

fn entry_from_state(tab: &TabId, state: &TabState, now: chrono::DateTime<Utc>) -> Entry {
    let mut entry = Entry {
        id: tab_id(tab),
        name: tab_name(tab),
        display_name: tab_display_name(tab),
        // #164's naming (a custom tab has no VendorId) with #162's plan
        // (an error card still names the plan from the OAuth blob).
        short_name: tab_short_name(tab),
        icon: tab_icon(tab),
        brand: tab_brand(tab),
        plan: match state {
            TabState::Error { plan, .. } => plan
                .as_deref()
                .map(crate::display::sanitize_untrusted_field)
                .filter(|plan| !plan.is_empty()),
            _ => None,
        },
        sections: Vec::new(),
        error: match state {
            TabState::Error { message, .. } => {
                Some(crate::display::sanitize_untrusted_field(message))
            }
            _ => None,
        },
        stale: matches!(state, TabState::Ready(ready) if ready.stale),
        fetched_at: match state {
            TabState::Ready(ready) => ready.fetched_at,
            _ => None,
        },
        reset_credits: reset_credits_for(state),
    };
    // The error is already a first-class entry field. Do not duplicate the
    // TUI's interactive retry instructions as report data.
    if entry.error.is_some() {
        return entry;
    }
    for projected in sections_with_metadata_for(state, now, PACE_TOLERANCE) {
        match projected.section {
            Section::Title { left, .. } => entry.plan = Some(left),
            Section::Metric {
                label,
                pct,
                value_label,
                footnote,
                severity,
                ..
            } => {
                entry.sections.push(ReportSection::Metric {
                    label,
                    percent: pct,
                    value: value_label,
                    detail: footnote,
                    headline: projected.headline.as_str().into(),
                    severity: severity.as_str().into(),
                    reset_at: projected.reset_at,
                    window_secs: projected
                        .window
                        .filter(|window| window.num_seconds() > 0)
                        .map(|window| window.num_seconds() as u64),
                    group: projected.group.map(str::to_string),
                    regen: projected.regen,
                    percent_precise: projected.percent_precise,
                    reading: projected.reading.map(str::to_string),
                    model_pool: projected.model_pool,
                });
            }
            Section::Text { label, value } => {
                // A cap is only meaningful next to the spend it meters, and
                // only when that cap is positive. Anything else stays off
                // the JSON.
                let used_cents = projected.used_cents;
                let limit_cents = used_cents.and(projected.limit_cents.filter(|limit| *limit > 0));
                let percent = match (used_cents, limit_cents) {
                    (Some(used), Some(limit)) => consumed_percent(used, limit),
                    _ => None,
                };
                let severity = percent.map(|percent| {
                    crate::pango::severity_for(i32::from(percent))
                        .as_str()
                        .to_string()
                });
                entry.sections.push(ReportSection::Text {
                    label,
                    value,
                    used_cents,
                    limit_cents,
                    percent,
                    severity,
                });
            }
            Section::Block { label, body } => {
                entry.sections.push(ReportSection::Block { label, body });
            }
            Section::Spacer => entry.sections.push(ReportSection::Spacer),
        }
    }
    entry
}

fn entry_from_antigravity_account(
    tab: &TabId,
    account: &crate::antigravity::statusline::AccountSession,
    now: DateTime<Utc>,
) -> Entry {
    let state = TabState::Ready(Box::new(crate::tui::app::ReadyTab {
        snapshot: crate::usage::VendorSnapshot::Antigravity(account.snapshot.clone()),
        stale: now.signed_duration_since(account.updated_at)
            > crate::antigravity::statusline::STALE_AFTER,
        last_error: None,
        fetched_at: Some(account.updated_at),
        display: crate::balance::DisplayPrefs::default(),
    }));
    let mut entry = entry_from_state(tab, &state, now);
    entry.id = format!("antigravity@{}", account.id_suffix);
    entry.name = format!("antigravity · {}", account.masked_email);
    entry.display_name = format!("Antigravity · {}", account.masked_email);
    entry
}

fn reset_credits_for(state: &TabState) -> Option<crate::usage::ResetCredits> {
    match state {
        TabState::Ready(ready) => ready.snapshot.reset_credits().cloned(),
        _ => None,
    }
}

/// Stable machine id shared by aggregate views and the macOS menu bar:
/// `<vendor>@<label>` for named accounts, `custom:<id>` for a `[[custom]]`
/// provider (which never has accounts). Also the entry half of the
/// notification dedupe key.
pub(crate) fn tab_id(tab: &TabId) -> String {
    match &tab.source {
        TabSource::Custom { id, .. } => format!("custom:{id}"),
        TabSource::Builtin(vendor) => match &tab.account {
            Some(account) => format!("{}@{account}", vendor.slug()),
            None => vendor.slug().to_string(),
        },
    }
}

fn tab_name(tab: &TabId) -> String {
    match &tab.source {
        TabSource::Builtin(vendor) => format_tab_name(tab, vendor.slug()),
        TabSource::Custom { name, .. } => format_tab_name(tab, name),
    }
}

fn tab_display_name(tab: &TabId) -> String {
    match &tab.source {
        TabSource::Builtin(vendor) => format_tab_name(tab, vendor.display_name()),
        TabSource::Custom { name, .. } => format_tab_name(tab, name),
    }
}

/// The `{vendor_short}` code: the vendor's own for a built-in, the configured
/// `short_name` for a custom provider.
fn tab_short_name(tab: &TabId) -> String {
    match &tab.source {
        TabSource::Builtin(vendor) => vendor.short_name().to_string(),
        TabSource::Custom { short_name, .. } => {
            crate::display::sanitize_untrusted_field(short_name)
        }
    }
}

/// The bar glyph: the vendor's own for a built-in. A custom provider has no
/// glyph of its own, so its `short_name` stands in, as Zai and Kimi's do.
fn tab_icon(tab: &TabId) -> String {
    match &tab.source {
        TabSource::Builtin(vendor) => vendor.bar_icon().to_string(),
        TabSource::Custom { short_name, .. } => {
            crate::display::sanitize_untrusted_field(short_name)
        }
    }
}

/// The provider whose mark draws this entry. Built-in tabs carry everything
/// needed to derive it; a custom tab's optional brand stays in `Config` rather
/// than widening the public `TabSource` enum and is attached by
/// `entry_from_state_with_config`.
fn tab_brand(tab: &TabId) -> Option<String> {
    match &tab.source {
        TabSource::Builtin(vendor) => Some(vendor.slug().to_string()),
        TabSource::Custom { .. } => None,
    }
}

fn format_tab_name(tab: &TabId, vendor_name: &str) -> String {
    let name = match &tab.account {
        // Mark a Desktop-sourced account so a mixed CLI+Desktop setup is legible;
        // for a Desktop-only user every Claude row simply reads "· <label> (desktop)".
        Some(account) if tab.desktop => format!("{vendor_name} · {account} (desktop)"),
        Some(account) => format!("{vendor_name} · {account}"),
        None => vendor_name.to_string(),
    };
    crate::display::sanitize_untrusted_field(&name)
}

/// Resolve the `primary` the report should name to an id `entries` actually
/// carries.
///
/// `config.ui.primary` is a vendor slug, but with named accounts the entry
/// ids are `vendor@account`, so the raw slug names an id no entry has —
/// `primary: "anthropic"` next to `anthropic@claude-me`. The first entry of
/// that vendor (the bare slug, or the first `{slug}@…` account) wins; a slug
/// with no matching entry is kept as-is, because the config naming a
/// disabled or absent vendor is information worth reporting, not something
/// to paper over with a guess. `None` (unset) stays `None`.
fn resolve_primary(primary: Option<&str>, entries: &[Entry]) -> Option<String> {
    primary.map(|slug| {
        // The `@` suffix keeps a slug that is a prefix of another vendor's
        // ("openai" vs "openrouter") from matching that vendor's accounts.
        entries
            .iter()
            .find(|entry| entry.id == slug || entry.id.starts_with(&format!("{slug}@")))
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| slug.to_string())
    })
}

fn render_json_document(
    entries: &[Entry],
    primary: Option<&str>,
    overview: Option<&[&str]>,
) -> String {
    render_json_value(entries, primary, overview).to_string()
}

fn render_json_value(
    entries: &[Entry],
    primary: Option<&str>,
    overview: Option<&[&str]>,
) -> serde_json::Value {
    let mut value = json!({
        "schema_version": USAGE_SCHEMA_VERSION,
        "primary": resolve_primary(primary, entries),
        "entries": json_rows(entries),
    });
    if let Some(order) = overview {
        value["overview_vendors"] = json!(order);
    }
    value
}

fn json_rows(entries: &[Entry]) -> Vec<serde_json::Value> {
    entries
        .iter()
        .map(|entry| {
            let metrics = entry
                .sections
                .iter()
                .filter_map(|section| match section {
                    ReportSection::Metric {
                        label,
                        percent,
                        value,
                        detail,
                        headline,
                        severity,
                        reset_at,
                        window_secs,
                        group,
                        regen,
                        percent_precise,
                        reading,
                        model_pool,
                    } => {
                        let mut metric = json!({
                            "label": label,
                            "percent": percent,
                            "value": value,
                            "detail": detail,
                            "headline": headline,
                            "severity": severity,
                            "reset_at": reset_at,
                        });
                        // Same rule as the `sections` serializer: absent, not null.
                        if let Some(secs) = window_secs {
                            metric["window_secs"] = json!(secs);
                        }
                        if let Some(group) = group {
                            metric["group"] = json!(group);
                        }
                        if let Some(regen) = regen {
                            metric["regen"] = json!(regen);
                        }
                        if let Some(precise) = percent_precise {
                            metric["percent_precise"] = json!(precise);
                        }
                        if let Some(reading) = reading {
                            metric["reading"] = json!(reading);
                        }
                        if *model_pool {
                            metric["model_pool"] = json!(true);
                        }
                        Some(metric)
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            let mut row = json!({
                "id": entry.id,
                "name": entry.name,
                "display_name": entry.display_name,
                "short_name": entry.short_name,
                "icon": entry.icon,
                "plan": entry.plan,
                "status": if entry.error.is_some() { "error" } else { "ready" },
                "error": entry.error,
                "stale": entry.stale,
                "fetched_at": entry.fetched_at,
                "reset_credits": entry.reset_credits,
                "metrics": metrics,
                "sections": entry.sections,
            });
            // Optional additive fields are absent, not null, so older and
            // newer producers keep the documented tolerant JSON contract.
            if let Some(brand) = &entry.brand {
                row["brand"] = json!(brand);
            }
            row
        })
        .collect()
}

pub fn targets(config: &Config) -> std::result::Result<Vec<ReportTarget>, String> {
    let tabs = tabs_with_desktop(config);
    if tabs.len() > 128 {
        return Err("Too many provider accounts".into());
    }
    let accounts = if tabs
        .iter()
        .any(|tab| tab.vendor_id() == Some(crate::vendor::VendorId::Antigravity))
    {
        crate::antigravity::statusline::active_accounts().unwrap_or_default()
    } else {
        Vec::new()
    };
    let targets = expand_antigravity_tabs(&tabs, &accounts);
    if targets.len() > 128 {
        return Err("Too many provider accounts".into());
    }
    Ok(targets)
}
pub fn provider_key(target: &ReportTarget) -> String {
    match target {
        ReportTarget::Tab(tab) | ReportTarget::AntigravityAccount(tab, _) => match &tab.source {
            TabSource::Builtin(v) => v.slug().into(),
            TabSource::Custom { id, .. } => format!("custom:{id}"),
        },
    }
}
pub async fn refresh_target(
    client: &reqwest::Client,
    config: &Config,
    target: &ReportTarget,
) -> Entry {
    match target {
        ReportTarget::Tab(tab) => entry_for(client, config, tab, Freshness::Cached).await,
        ReportTarget::AntigravityAccount(tab, account) => {
            entry_from_antigravity_account(tab, account, Utc::now())
        }
    }
}
pub fn unavailable_entry(target: &ReportTarget) -> Entry {
    match target {
        ReportTarget::Tab(tab) | ReportTarget::AntigravityAccount(tab, _) => entry_from_state(
            tab,
            &TabState::error("Account usage refresh timed out"),
            Utc::now(),
        ),
    }
}
pub fn render_entries(config: &Config, entries: &[Entry]) -> String {
    let overview = config
        .ui
        .overview_vendors
        .as_ref()
        .map(|v| v.iter().map(|v| v.slug()).collect::<Vec<_>>());
    render_json_document(
        entries,
        config.ui.primary.map(|v| v.slug()),
        overview.as_deref(),
    )
}
