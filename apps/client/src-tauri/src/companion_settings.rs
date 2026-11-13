use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::{AppState, Result, SshError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    schema_version: u8,
    revision: u64,
    transcript_discovery_enabled: bool,
    recorded_usage_enabled: bool,
    device_tools_enabled: bool,
    /// Whether the companion updates itself when a newer app connects; absent from a companion
    /// that predates `lazysh-agent auto-update`.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    auto_update: Option<AutoUpdate>,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Policy {
    Off,
    Notify,
    Install,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Channel {
    Stable,
    Prerelease,
}
/// What the last scheduled check on the host found; the companion records it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastCheck {
    at: String,
    latest: Option<String>,
    available: bool,
}
/// `lazysh-agent auto-update status`. A newer companion may say more; only these fields are used.
/// `channel` and what follows come from a companion that has scheduled checks, an older one sends
/// only the policy, and the app then shows only the policy.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoUpdate {
    #[serde(skip_serializing)]
    schema_version: u8,
    revision: u64,
    policy: Policy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    channel: Option<Channel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    interval_hours: Option<u32>,
    #[serde(default)]
    window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_check: Option<LastCheck>,
}
/// How often, on which releases and when a companion that has scheduled checks updates itself.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schedule {
    channel: Channel,
    interval_hours: u32,
    window: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoUpdateChange {
    expected_revision: u64,
    policy: Policy,
    #[serde(default)]
    schedule: Option<Schedule>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    expected_revision: u64,
    transcript_discovery_enabled: bool,
    recorded_usage_enabled: bool,
    device_tools_enabled: bool,
    #[serde(default)]
    auto_update: Option<AutoUpdateChange>,
}
fn parse(text: &str) -> Result<Settings> {
    if text.len() > 4096 {
        return Err(SshError::new(
            "companion_settings",
            "Host settings exceed their limit",
        ));
    }
    let value: Settings = serde_json::from_str(text)?;
    if value.schema_version != 1 || value.revision > 9_007_199_254_740_991 {
        return Err(SshError::new(
            "companion_settings",
            "Unsupported host settings schema",
        ));
    }
    Ok(value)
}
fn update_command(settings: &Update) -> Result<String> {
    if settings.expected_revision >= 9_007_199_254_740_991 {
        return Err(SshError::new(
            "companion_settings",
            "Invalid settings revision",
        ));
    }
    Ok(format!("lazysh-agent settings update --expected-revision {} --transcript-discovery-enabled {} --recorded-usage-enabled {} --device-tools-enabled {}",settings.expected_revision,settings.transcript_discovery_enabled,settings.recorded_usage_enabled,settings.device_tools_enabled))
}
/// `HH:MM-HH:MM`, two different clock times: the only text of a window that reaches a command line.
fn valid_window(window: &str) -> bool {
    let bytes = window.as_bytes();
    let shaped = bytes.len() == 11
        && [(2, b':'), (5, b'-'), (8, b':')]
            .iter()
            .all(|&(index, separator)| bytes[index] == separator)
        && [0, 1, 3, 4, 6, 7, 9, 10]
            .iter()
            .all(|&index| bytes[index].is_ascii_digit());
    let pair =
        |index: usize| u32::from(bytes[index] - b'0') * 10 + u32::from(bytes[index + 1] - b'0');
    shaped
        && [0, 6].iter().all(|&at| pair(at) < 24)
        && [3, 9].iter().all(|&at| pair(at) < 60)
        && (pair(0), pair(3)) != (pair(6), pair(9))
}
/// A time or a version the host reports, kept to the characters such text has and a short length.
fn plain(text: &str) -> bool {
    text.len() <= 40
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".:-+".contains(&byte))
}
fn parse_auto_update(text: &str) -> Result<AutoUpdate> {
    let value: AutoUpdate = serde_json::from_str(text.trim())?;
    let check_ok = value
        .last_check
        .as_ref()
        .is_none_or(|check| plain(&check.at) && check.latest.as_deref().is_none_or(plain));
    let schedule_ok = value
        .interval_hours
        .is_none_or(|hours| (1..=720).contains(&hours))
        && value.window.as_deref().is_none_or(valid_window);
    if text.len() > 4096
        || value.schema_version != 1
        || value.revision > 9_007_199_254_740_991
        || !check_ok
        || !schedule_ok
    {
        return Err(SshError::new(
            "companion_settings",
            "Unsupported auto-update response",
        ));
    }
    Ok(value)
}
fn auto_update_command(change: &AutoUpdateChange) -> Result<String> {
    if change.expected_revision >= 9_007_199_254_740_991 {
        return Err(SshError::new(
            "companion_settings",
            "Invalid settings revision",
        ));
    }
    let policy = match change.policy {
        Policy::Off => "off",
        Policy::Notify => "notify",
        Policy::Install => "install",
    };
    let mut command = format!(
        "lazysh-agent auto-update set --expected-revision {} --policy {policy}",
        change.expected_revision
    );
    if let Some(schedule) = &change.schedule {
        let channel = match schedule.channel {
            Channel::Stable => "stable",
            Channel::Prerelease => "prerelease",
        };
        let window = schedule.window.as_deref().unwrap_or("none");
        if !(1..=720).contains(&schedule.interval_hours)
            || (window != "none" && !valid_window(window))
        {
            return Err(SshError::new(
                "companion_settings",
                "Invalid update schedule",
            ));
        }
        command.push_str(&format!(
            " --channel {channel} --interval-hours {} --window {window}",
            schedule.interval_hours
        ));
    }
    Ok(command)
}
#[tauri::command]
pub async fn get_companion_settings(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Settings>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            let mut settings = parse(
                &crate::companion::exec(&session, "lazysh-agent settings show".into(), &access)
                    .await?,
            )?;
            settings.auto_update = current_auto_update(&session, &access).await;
            Ok(settings)
        })
        .await
}
/// A companion without `auto-update` fails the command; that is "no such setting", not an error.
async fn current_auto_update(
    session: &crate::ssh::Session,
    access: &AccessLease,
) -> Option<AutoUpdate> {
    let text = crate::companion::exec(session, "lazysh-agent auto-update status".into(), access)
        .await
        .ok()?;
    parse_auto_update(&text).ok()
}
#[tauri::command]
pub async fn update_companion_settings(
    state: State<'_, AppState>,
    session_id: String,
    settings: Update,
    access: AccessLease,
) -> std::result::Result<Guarded<Settings>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let command = update_command(&settings)?;
            let change = settings
                .auto_update
                .as_ref()
                .map(auto_update_command)
                .transpose()?;
            let session = state.session(&session_id).await?;
            let mut saved = parse(&crate::companion::exec(&session, command, &access).await?)?;
            saved.auto_update = match change {
                Some(command) => Some(parse_auto_update(
                    &crate::companion::exec(&session, command, &access).await?,
                )?),
                None => current_auto_update(&session, &access).await,
            };
            Ok(saved)
        })
        .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_commands_only_format_typed_values_and_require_strict_responses() {
        let update = Update {
            expected_revision: 7,
            transcript_discovery_enabled: false,
            recorded_usage_enabled: true,
            device_tools_enabled: false,
            auto_update: None,
        };
        assert_eq!(update_command(&update).unwrap(),"lazysh-agent settings update --expected-revision 7 --transcript-discovery-enabled false --recorded-usage-enabled true --device-tools-enabled false");
        assert!(parse(r#"{"schemaVersion":1,"revision":1,"transcriptDiscoveryEnabled":false,"recordedUsageEnabled":true,"deviceToolsEnabled":true}"#).is_ok());
        let change = AutoUpdateChange {
            expected_revision: 3,
            policy: Policy::Off,
            schedule: None,
        };
        assert_eq!(
            auto_update_command(&change).unwrap(),
            "lazysh-agent auto-update set --expected-revision 3 --policy off"
        );
        // A newer companion may report more than the app reads; the app never invents the rest.
        let status = parse_auto_update(
            r#"{"schemaVersion":1,"revision":4,"policy":"install","appUpdate":null,"timer":{"kind":"systemd"}}"#,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"revision":4,"policy":"install","window":null})
        );
        // A companion with scheduled checks tells the schedule and what the last check found.
        let status = parse_auto_update(
            r#"{"schemaVersion":1,"revision":5,"policy":"notify","channel":"prerelease","intervalHours":6,"window":"22:00-06:00","lastCheck":{"at":"2026-11-13T10:00:00Z","latest":"1.60.0","available":true,"error":null,"failures":2},"nextCheckAt":"2026-11-13T16:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"revision":5,"policy":"notify","channel":"prerelease","intervalHours":6,"window":"22:00-06:00",
                "lastCheck":{"at":"2026-11-13T10:00:00Z","latest":"1.60.0","available":true}})
        );
        let scheduled = |policy, channel, interval_hours, window: Option<&str>| AutoUpdateChange {
            expected_revision: 5,
            policy,
            schedule: Some(Schedule {
                channel,
                interval_hours,
                window: window.map(str::to_owned),
            }),
        };
        assert_eq!(
            auto_update_command(&scheduled(Policy::Install, Channel::Prerelease, 6, Some("22:00-06:00"))).unwrap(),
            "lazysh-agent auto-update set --expected-revision 5 --policy install --channel prerelease --interval-hours 6 --window 22:00-06:00"
        );
        assert_eq!(
            auto_update_command(&scheduled(Policy::Notify, Channel::Stable, 24, None)).unwrap(),
            "lazysh-agent auto-update set --expected-revision 5 --policy notify --channel stable --interval-hours 24 --window none"
        );
        // Nothing but a clock window and a bounded interval reaches the command line.
        for (hours, window) in [
            (0, None),
            (721, None),
            (24, Some("25:00-06:00")),
            (24, Some("06:00-06:00")),
            (24, Some("0600-0700")),
            (24, Some("06:00-07:00; reboot")),
            (24, Some("06:00-07:0é")),
            (24, Some("none; id")),
        ] {
            assert!(
                auto_update_command(&scheduled(Policy::Off, Channel::Stable, hours, window))
                    .is_err(),
                "{hours} {window:?}"
            );
        }
        for text in [
            r#"{"schemaVersion":1,"revision":4,"policy":"off","intervalHours":0}"#,
            r#"{"schemaVersion":1,"revision":4,"policy":"off","window":"6:00-7:00"}"#,
            r#"{"schemaVersion":1,"revision":4,"policy":"off","channel":"nightly"}"#,
            r#"{"schemaVersion":1,"revision":4,"policy":"off","lastCheck":{"at":"x; id","latest":null,"available":false}}"#,
        ] {
            assert!(parse_auto_update(text).is_err(), "{text}");
        }
        for text in [
            r#"{"schemaVersion":2,"revision":4,"policy":"off"}"#,
            r#"{"schemaVersion":1,"revision":4,"policy":"always"}"#,
            r#"{"schemaVersion":1,"revision":-1,"policy":"off"}"#,
        ] {
            assert!(parse_auto_update(text).is_err(), "{text}");
        }
        for text in [
            r#"{"schemaVersion":2}"#,
            r#"{"schemaVersion":1,"revision":1,"transcriptDiscoveryEnabled":"false","recordedUsageEnabled":true,"deviceToolsEnabled":true}"#,
            r#"{"schemaVersion":1,"revision":1,"transcriptDiscoveryEnabled":false,"recordedUsageEnabled":true,"deviceToolsEnabled":true,"extra":1}"#,
        ] {
            assert!(parse(text).is_err());
        }
    }
}
