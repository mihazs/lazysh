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
/// `lazysh-agent auto-update status`. A newer companion may say more; only these fields are used.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoUpdate {
    #[serde(skip_serializing)]
    schema_version: u8,
    revision: u64,
    policy: Policy,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoUpdateChange {
    expected_revision: u64,
    policy: Policy,
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
fn parse_auto_update(text: &str) -> Result<AutoUpdate> {
    let value: AutoUpdate = serde_json::from_str(text.trim())?;
    if text.len() > 4096 || value.schema_version != 1 || value.revision > 9_007_199_254_740_991 {
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
    Ok(format!(
        "lazysh-agent auto-update set --expected-revision {} --policy {policy}",
        change.expected_revision
    ))
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
        };
        assert_eq!(
            auto_update_command(&change).unwrap(),
            "lazysh-agent auto-update set --expected-revision 3 --policy off"
        );
        // A newer companion may report more than the app reads; the app never invents the rest.
        let status = parse_auto_update(
            r#"{"schemaVersion":1,"revision":4,"policy":"install","appUpdate":null,"channel":"stable"}"#,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"revision":4,"policy":"install"})
        );
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
