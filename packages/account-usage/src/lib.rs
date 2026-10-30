//! Bounded account-quota reports shared by the companion and native client.
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub const OUTPUT_LIMIT: usize = 1024 * 1024;
const LIMIT: usize = OUTPUT_LIMIT;
#[cfg(feature = "collector")]
mod collect;
#[cfg(feature = "collector")]
mod collector;
#[cfg(feature = "collector")]
pub use collect::{read, worker_main};
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub schema_version: u8,
    pub state: String,
    pub source: Option<String>,
    pub report: Option<Report>,
}
impl Response {
    pub fn unavailable(state: &'static str) -> Self {
        Self {
            schema_version: 1,
            state: state.to_owned(),
            source: None,
            report: None,
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub primary: Option<String>,
    pub entries: Vec<Entry>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub plan: Option<String>,
    pub status: String,
    pub stale: bool,
    pub fetched_at: Option<String>,
    pub rows: Vec<Row>,
    pub reset_credits: Option<ResetCredits>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredits {
    pub available: u32,
    pub credits: Vec<ResetCredit>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredit {
    pub title: Option<String>,
    pub expires_at: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Row {
    #[serde(rename_all = "camelCase")]
    Metric {
        label: String,
        percent: f64,
        value: String,
        detail: String,
        headline: String,
        reading: String,
        reset_at: Option<String>,
        window_seconds: Option<u64>,
        regen: Option<String>,
        model_pool: bool,
    },
    #[serde(rename_all = "camelCase")]
    Text {
        label: String,
        value: String,
        used_cents: Option<i64>,
        limit_cents: Option<i64>,
        percent: Option<f64>,
    },
}
fn text(v: &Value, key: &str, max: usize) -> Option<String> {
    let s = v.get(key)?.as_str()?.trim();
    safe(s, max).then(|| s.to_owned())
}

fn time(v: &Value, key: &str) -> Option<String> {
    let s = text(v, key, 40)?;
    chrono::DateTime::parse_from_rfc3339(&s).ok().map(|_| s)
}

fn percent(v: &Value, key: &str) -> Option<f64> {
    v.get(key)?
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 65535.0)
}
// Positive allowlist from pinned ai-usagebar 1.46 report projection; unknown text can contain context.
fn quota_text(label: &str) -> bool {
    matches!(
        label,
        "Spend (mo)"
            | "Extra usage"
            | "Usage credits"
            | "Credits"
            | "Spent"
            | "Subscription credits"
            | "Top-up credits"
            | "Total usable credits"
            | "Owed"
            | "Available balance"
            | "Amount used"
            | "Additional usage"
            | "Prepaid API"
            | "On-Demand"
            | "On-demand"
            | "Monthly usage"
            | "Included usage"
            | "Overage balance"
            | "Extra usage balance"
            | "Balance"
            | "Credit"
            | "Credit balance"
            | "Kilo"
            | "DeepSeek"
            | "DeepInfra"
            | "Novita"
            | "Moonshot"
            | "Grok"
            | "OpenRouter"
    )
}
fn row(v: &Value) -> Option<Row> {
    let label = text(v, "label", 160)?;
    let value = text(v, "value", 512)?;
    match v.get("type")?.as_str()? {
        "metric" if v.get("group").and_then(Value::as_str) != Some("Sessions") => {
            let headline = text(v, "headline", 10)?;
            if !matches!(headline.as_str(), "percent" | "value") {
                return None;
            }
            let reading = match v.get("reading").and_then(Value::as_str) {
                None | Some("used") => "used",
                Some("left") => "left",
                _ => return None,
            };
            Some(Row::Metric {
                label,
                value,
                percent: percent(v, "percent_precise").or_else(|| percent(v, "percent"))?,
                detail: text(v, "detail", 512).unwrap_or_default(),
                headline,
                reading: reading.into(),
                reset_at: time(v, "reset_at"),
                window_seconds: v
                    .get("window_secs")
                    .and_then(Value::as_u64)
                    .filter(|n| *n > 0 && *n <= 10 * 366 * 86400),
                regen: text(v, "regen", 80),
                model_pool: v
                    .get("model_pool")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        }
        "text" if quota_text(&label) => Some(Row::Text {
            label,
            value,
            used_cents: v
                .get("used_cents")
                .and_then(Value::as_i64)
                .filter(|n| *n >= 0 && *n <= 9_007_199_254_740_991),
            limit_cents: v
                .get("limit_cents")
                .and_then(Value::as_i64)
                .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991),
            percent: percent(v, "percent"),
        }),
        _ => None,
    }
}
pub fn normalize(bytes: &[u8], source: &str) -> Response {
    fn parse(bytes: &[u8]) -> Option<Report> {
        if bytes.len() > LIMIT {
            return None;
        }
        let v: Value = serde_json::from_slice(bytes).ok()?;
        if v.get("schema_version")?.as_u64() != Some(1) {
            return None;
        }
        let entries = v.get("entries")?.as_array()?;
        if entries.len() > 128 {
            return None;
        }
        let mut output = Vec::new();
        for entry in entries {
            let id = text(entry, "id", 160)?;
            if output.iter().any(|e: &Entry| e.id == id) {
                return None;
            }
            let status = text(entry, "status", 10)?;
            if !matches!(status.as_str(), "ready" | "error") {
                return None;
            }
            let sections = entry.get("sections")?.as_array()?;
            if sections.len() > 128 {
                return None;
            }
            let credits = entry
                .get("reset_credits")
                .filter(|c| !c.is_null())
                .and_then(|c| {
                    let available = u32::try_from(c.get("available")?.as_u64()?).ok()?;
                    let credits = c.get("credits")?.as_array()?;
                    if credits.len() > 64 {
                        return None;
                    }
                    Some(ResetCredits {
                        available,
                        credits: credits
                            .iter()
                            .map(|r| ResetCredit {
                                title: text(r, "title", 80),
                                expires_at: time(r, "expires_at"),
                            })
                            .collect(),
                    })
                });
            output.push(Entry {
                id,
                name: text(entry, "display_name", 160).or_else(|| text(entry, "name", 160))?,
                short_name: text(entry, "short_name", 24).unwrap_or_else(|| "AI".into()),
                plan: text(entry, "plan", 160),
                status,
                stale: entry.get("stale")?.as_bool()?,
                fetched_at: time(entry, "fetched_at"),
                rows: sections.iter().filter_map(row).take(64).collect(),
                reset_credits: credits,
            });
        }
        // Upstream report already follows overview_vendors ordering; never guess an account from a terminal process.
        Some(Report {
            primary: text(&v, "primary", 160),
            entries: output,
        })
    }
    match parse(bytes) {
        Some(report) => Response {
            schema_version: 1,
            state: "ready".into(),
            source: Some(source.into()),
            report: Some(report),
        },
        None => Response::unavailable("invalid_report"),
    }
}

/// Revalidate a companion response before it enters the renderer.
pub fn from_wire(bytes: &[u8]) -> Response {
    fn checked(bytes: &[u8]) -> Option<Response> {
        if bytes.len() > OUTPUT_LIMIT {
            return None;
        }
        let mut response: Response = serde_json::from_slice(bytes).ok()?;
        if response.schema_version != 1
            || !matches!(
                response.state.as_str(),
                "ready" | "invalid_report" | "busy" | "disconnected" | "timeout" | "unavailable"
            )
            || response
                .source
                .as_deref()
                .is_some_and(|s| !matches!(s, "builtin" | "external_cli"))
        {
            return None;
        }
        if response.state == "ready" && (response.report.is_none() || response.source.is_none()) {
            return None;
        }
        if let Some(report) = response.report.as_mut() {
            if report.entries.len() > 128 || report.primary.as_ref().is_some_and(|s| !safe(s, 160))
            {
                return None;
            }
            let mut seen = std::collections::HashSet::new();
            for entry in &mut report.entries {
                if !safe(&entry.id, 160)
                    || !seen.insert(entry.id.clone())
                    || !safe(&entry.name, 160)
                    || !safe(&entry.short_name, 24)
                    || entry.plan.as_ref().is_some_and(|s| !safe(s, 160))
                    || !matches!(entry.status.as_str(), "ready" | "error")
                    || !valid_time(entry.fetched_at.as_deref())
                    || entry.rows.len() > 64
                {
                    return None;
                }
                entry.rows.retain(|row| match row {
                    Row::Text { label, .. } => quota_text(label),
                    _ => true,
                });
                for row in &entry.rows {
                    match row {
                        Row::Metric {
                            label,
                            percent,
                            value,
                            detail,
                            headline,
                            reading,
                            reset_at,
                            window_seconds,
                            regen,
                            ..
                        } => {
                            if !safe(label, 160)
                                || !safe(value, 512)
                                || !safe_optional(detail, 512)
                                || !valid_percent(*percent)
                                || !matches!(headline.as_str(), "percent" | "value")
                                || !matches!(reading.as_str(), "used" | "left")
                                || !valid_time(reset_at.as_deref())
                                || window_seconds.is_some_and(|n| n == 0 || n > 10 * 366 * 86400)
                                || regen.as_ref().is_some_and(|s| !safe(s, 80))
                            {
                                return None;
                            }
                        }
                        Row::Text {
                            label,
                            value,
                            used_cents,
                            limit_cents,
                            percent,
                        } => {
                            if !safe(label, 160)
                                || !safe(value, 512)
                                || used_cents.is_some_and(|n| !valid_cents(n, false))
                                || limit_cents.is_some_and(|n| !valid_cents(n, true))
                                || percent.is_some_and(|n| !valid_percent(n))
                                || (limit_cents.is_some() && used_cents.is_none())
                                || (percent.is_some() && limit_cents.is_none())
                            {
                                return None;
                            }
                        }
                    }
                }
                if let Some(credits) = &entry.reset_credits {
                    if credits.credits.len() > 64
                        || credits.credits.iter().any(|c| {
                            c.title.as_ref().is_some_and(|s| !safe(s, 80))
                                || !valid_time(c.expires_at.as_deref())
                        })
                    {
                        return None;
                    }
                }
            }
        }
        Some(response)
    }
    checked(bytes).unwrap_or_else(|| Response::unavailable("invalid_report"))
}
fn valid_time(value: Option<&str>) -> bool {
    value.is_none_or(|s| safe(s, 40) && chrono::DateTime::parse_from_rfc3339(s).is_ok())
}
fn valid_percent(n: f64) -> bool {
    n.is_finite() && (0.0..=65535.0).contains(&n)
}
fn valid_cents(n: i64, positive: bool) -> bool {
    n >= i64::from(positive) && n <= 9_007_199_254_740_991
}

fn safe_optional(s: &str, max: usize) -> bool {
    s.chars().count() <= max
        && !s
            .chars()
            .any(|c| c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'))
}
fn safe(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && safe_optional(s, max)
}
