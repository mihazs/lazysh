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
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    expected_revision: u64,
    transcript_discovery_enabled: bool,
    recorded_usage_enabled: bool,
    device_tools_enabled: bool,
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
#[tauri::command]
pub async fn get_companion_settings(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Settings>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            parse(
                &crate::companion::exec(&session, "lazysh-agent settings show".into(), &access)
                    .await?,
            )
        })
        .await
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
            let session = state.session(&session_id).await?;
            parse(&crate::companion::exec(&session, command, &access).await?)
        })
        .await
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamSettings {
    schema_version: u8,
    revision: u64,
    enabled: bool,
}
fn parse_stream(text: &str) -> Result<StreamSettings> {
    if text.len() > 4096 {
        return Err(SshError::new(
            "companion_settings",
            "Host stream settings exceed their limit",
        ));
    }
    let value: StreamSettings = serde_json::from_str(text)?;
    if value.schema_version != 1 || value.revision > 9_007_199_254_740_991 {
        return Err(SshError::new(
            "companion_settings",
            "Unsupported host stream settings schema",
        ));
    }
    Ok(value)
}
#[tauri::command]
pub async fn companion_stream_settings(
    state: State<'_, AppState>,
    session_id: String,
    expected_revision: Option<u64>,
    enabled: Option<bool>,
    access: AccessLease,
) -> std::result::Result<Guarded<StreamSettings>, GuardedError<SshError>> {
    access.run(async {
        let command = match (expected_revision, enabled) {
            (None, None) => "lazysh-agent settings stream-show".to_owned(),
            (Some(revision), Some(enabled)) if revision < 9_007_199_254_740_991 => format!("lazysh-agent settings stream-update --expected-revision {revision} --enabled {enabled}"),
            _ => return Err(SshError::new("companion_settings", "Invalid stream settings update")),
        };
        let session = state.session(&session_id).await?;
        parse_stream(&crate::companion::exec(&session, command, &access).await?)
    }).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_policy_requires_an_exact_bounded_response() {
        assert!(parse_stream(r#"{"schemaVersion":1,"revision":0,"enabled":true}"#).is_ok());
        for value in [
            r#"{"schemaVersion":2,"revision":0,"enabled":true}"#,
            r#"{"schemaVersion":1,"revision":0,"enabled":"true"}"#,
            r#"{"schemaVersion":1,"revision":0,"enabled":true,"extra":1}"#,
        ] {
            assert!(parse_stream(value).is_err());
        }
    }
    #[test]
    fn settings_commands_only_format_typed_values_and_require_strict_responses() {
        let update = Update {
            expected_revision: 7,
            transcript_discovery_enabled: false,
            recorded_usage_enabled: true,
            device_tools_enabled: false,
        };
        assert_eq!(update_command(&update).unwrap(),"lazysh-agent settings update --expected-revision 7 --transcript-discovery-enabled false --recorded-usage-enabled true --device-tools-enabled false");
        assert!(parse(r#"{"schemaVersion":1,"revision":1,"transcriptDiscoveryEnabled":false,"recordedUsageEnabled":true,"deviceToolsEnabled":true}"#).is_ok());
        for text in [
            r#"{"schemaVersion":2}"#,
            r#"{"schemaVersion":1,"revision":1,"transcriptDiscoveryEnabled":"false","recordedUsageEnabled":true,"deviceToolsEnabled":true}"#,
            r#"{"schemaVersion":1,"revision":1,"transcriptDiscoveryEnabled":false,"recordedUsageEnabled":true,"deviceToolsEnabled":true,"extra":1}"#,
        ] {
            assert!(parse(text).is_err());
        }
    }
}
