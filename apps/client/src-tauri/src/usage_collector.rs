//! Read-only view of a host's usage collector: the companion's `usage-collector status`, revalidated before it
//! reaches the renderer. The host's answer is untrusted text, so only the fields the page shows are kept and
//! every enumeration, bound and string is checked.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::{self, AppState, Result, SshError};
use serde::{Deserialize, Serialize};
use tauri::State;

/// What an older companion's missing `usage-collector` command is answered with (exit 2, 126 or 127).
pub(crate) const COMPANION_REQUIRED: &str = "lazysh-usage-collector-companion-required-v1";
const SAMPLES: u16 = 24;
const MAX_TEXT: usize = 512 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    schema_version: u8,
    observed_at: String,
    policy_revision: u64,
    account_quota_enabled: bool,
    collector: Collector,
    last_run: Option<LastRun>,
    samples: Summary,
    recent: Vec<Sample>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Collector {
    enabled: bool,
    interval_minutes: u32,
    timer: Timer,
}
#[derive(Debug, Serialize, Deserialize)]
struct Timer {
    state: String,
    linger: Option<bool>,
}
#[derive(Debug, Serialize, Deserialize)]
struct LastRun {
    at: String,
    outcome: String,
    reason: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
struct Summary {
    state: String,
    count: u64,
    oldest: Option<String>,
    newest: Option<String>,
    bytes: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    recorded_at: String,
    source: String,
    truncated: bool,
    entries: Vec<Entry>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    name: String,
    status: String,
    stale: bool,
    fetched_at: Option<String>,
    rows: Vec<Metric>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metric {
    label: String,
    percent: f64,
    reading: String,
    reset_at: Option<String>,
    window_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Reply {
    Ready { status: Box<Status> },
    CompanionRequired,
}

fn safe(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.chars().count() <= max
        && !text.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
fn time(text: &Option<String>) -> bool {
    text.as_deref().is_none_or(|text| safe(text, 40))
}
impl Status {
    fn valid(&self) -> bool {
        let collector = &self.collector;
        let summary = &self.samples;
        self.schema_version == 1
            && safe(&self.observed_at, 40)
            && (5..=1440).contains(&collector.interval_minutes)
            && ["absent", "installed", "drift", "unsupported"]
                .contains(&collector.timer.state.as_str())
            && ["ok", "invalid"].contains(&summary.state.as_str())
            && time(&summary.oldest)
            && time(&summary.newest)
            && self.last_run.as_ref().is_none_or(|run| {
                safe(&run.at, 40)
                    && ["recorded", "skipped", "unavailable"].contains(&run.outcome.as_str())
                    && run.reason.as_deref().is_none_or(|reason| safe(reason, 40))
            })
            && self.recent.len() <= usize::from(SAMPLES)
            && self.recent.iter().all(|sample| {
                safe(&sample.recorded_at, 40)
                    && ["builtin", "external_cli"].contains(&sample.source.as_str())
                    && sample.entries.len() <= 32
                    && sample.entries.iter().all(|entry| {
                        safe(&entry.id, 160)
                            && safe(&entry.name, 160)
                            && ["ready", "error"].contains(&entry.status.as_str())
                            && time(&entry.fetched_at)
                            && entry.rows.len() <= 16
                            && entry.rows.iter().all(|row| {
                                safe(&row.label, 160)
                                    && row.percent.is_finite()
                                    && (0.0..=65535.0).contains(&row.percent)
                                    && ["used", "left"].contains(&row.reading.as_str())
                                    && time(&row.reset_at)
                            })
                    })
            })
    }
}

fn parse(text: &str) -> Result<Reply> {
    if text.trim() == COMPANION_REQUIRED {
        return Ok(Reply::CompanionRequired);
    }
    let invalid = || {
        SshError::new(
            "usage_collector",
            "The host's usage collector report is not valid",
        )
    };
    if text.len() > MAX_TEXT {
        return Err(invalid());
    }
    let status: Status = serde_json::from_str(text).map_err(|_| invalid())?;
    if !status.valid() {
        return Err(invalid());
    }
    Ok(Reply::Ready {
        status: Box::new(status),
    })
}

#[tauri::command]
pub async fn usage_collector_status(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Reply>, GuardedError<SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            let command = crate::companion::required_command(
                &session,
                format!("lazysh-agent usage-collector status --limit {SAMPLES}"),
                COMPANION_REQUIRED,
                &access,
            )
            .await?;
            parse(&ssh::exec_for_access(&session, command, &access).await?)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn status() -> Value {
        json!({
            "schemaVersion":1,"observedAt":"2026-11-14T12:05:00Z","policyRevision":2,"accountQuotaEnabled":true,
            "collector":{"enabled":true,"intervalMinutes":30,"timer":{"state":"installed","linger":false}},
            "lastRun":{"at":"2026-11-14T12:00:00Z","outcome":"recorded","reason":null},
            "samples":{"state":"ok","count":1,"oldest":"2026-11-14T12:00:00Z","newest":"2026-11-14T12:00:00Z","bytes":400},
            "recent":[{"recordedAt":"2026-11-14T12:00:00Z","source":"builtin","truncated":false,"entries":[
                {"id":"anthropic","name":"Claude","status":"ready","stale":false,"fetchedAt":"2026-11-14T11:59:00Z",
                 "rows":[{"label":"Session","percent":42.5,"reading":"used","resetAt":null,"windowSeconds":null}]}]}]
        })
    }
    fn parsed(value: &Value) -> Result<Reply> {
        parse(&value.to_string())
    }

    #[test]
    fn a_valid_report_passes_through_and_an_old_companion_is_named() {
        let Ok(Reply::Ready { status: ready }) = parsed(&status()) else {
            panic!("a valid report is accepted");
        };
        assert_eq!(ready.recent[0].entries[0].rows[0].percent, 42.5);
        assert!(matches!(
            parse(&format!("{COMPANION_REQUIRED}\n")),
            Ok(Reply::CompanionRequired)
        ));
        let wire = serde_json::to_value(parsed(&status()).unwrap()).unwrap();
        assert_eq!(wire["state"], "ready");
        assert_eq!(wire["status"]["recent"][0]["entries"][0]["name"], "Claude");
        assert_eq!(
            serde_json::to_value(Reply::CompanionRequired).unwrap(),
            json!({"state":"companion_required"})
        );
    }

    #[test]
    fn a_host_cannot_put_anything_else_in_front_of_the_page() {
        type Mutation = (&'static str, fn(&mut Value));
        let mutations: [Mutation; 9] = [
            ("schema", |v| v["schemaVersion"] = json!(2)),
            ("interval", |v| v["collector"]["intervalMinutes"] = json!(4)),
            ("timer", |v| {
                v["collector"]["timer"]["state"] = json!("loaded")
            }),
            ("outcome", |v| v["lastRun"]["outcome"] = json!("fine")),
            ("source", |v| v["recent"][0]["source"] = json!("elsewhere")),
            ("percent", |v| {
                v["recent"][0]["entries"][0]["rows"][0]["percent"] = json!(-1.0)
            }),
            ("reading", |v| {
                v["recent"][0]["entries"][0]["rows"][0]["reading"] = json!("free")
            }),
            ("control", |v| {
                v["recent"][0]["entries"][0]["name"] = json!("a\u{1b}[31mb")
            }),
            ("bidi", |v| {
                v["recent"][0]["entries"][0]["id"] = json!("a\u{202e}b")
            }),
        ];
        for (name, change) in mutations {
            let mut value = status();
            change(&mut value);
            assert!(parsed(&value).is_err(), "{name}");
        }
        assert!(parse("not json").is_err());
        assert!(parse(&" ".repeat(MAX_TEXT + 1)).is_err());
    }

    #[test]
    fn an_unknown_future_field_is_ignored_rather_than_refused() {
        let mut value = status();
        value["somethingNew"] = json!(true);
        assert!(parsed(&value).is_ok());
    }
}
