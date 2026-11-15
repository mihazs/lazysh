use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::host::Host;
use crate::local::LocalState;
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
const MAX_REVISION: u64 = 9_007_199_254_740_991;
/// Bounded, strict and versioned: the same limits for every settings file the companion answers with.
fn strict<T: serde::de::DeserializeOwned>(
    text: &str,
    header: impl Fn(&T) -> (u8, u64),
) -> Result<T> {
    if text.len() > 4096 {
        return Err(SshError::new(
            "companion_settings",
            "Host settings exceed their limit",
        ));
    }
    let value: T = serde_json::from_str(text)?;
    let (schema_version, revision) = header(&value);
    if schema_version != 1 || revision > MAX_REVISION {
        return Err(SshError::new(
            "companion_settings",
            "Unsupported host settings schema",
        ));
    }
    Ok(value)
}
fn parse(text: &str) -> Result<Settings> {
    strict(text, |settings: &Settings| {
        (settings.schema_version, settings.revision)
    })
}
fn expected_revision(revision: u64) -> Result<u64> {
    if revision >= MAX_REVISION {
        return Err(SshError::new(
            "companion_settings",
            "Invalid settings revision",
        ));
    }
    Ok(revision)
}
fn update_command(settings: &Update) -> Result<String> {
    Ok(format!("lazysh-agent settings update --expected-revision {} --transcript-discovery-enabled {} --recorded-usage-enabled {} --device-tools-enabled {}",expected_revision(settings.expected_revision)?,settings.transcript_discovery_enabled,settings.recorded_usage_enabled,settings.device_tools_enabled))
}
#[tauri::command]
pub async fn get_companion_settings(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Settings>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            parse(
                &host
                    .companion(&access, "lazysh-agent settings show".into())
                    .await?,
            )
        })
        .await
}
#[tauri::command]
pub async fn update_companion_settings(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    settings: Update,
    access: AccessLease,
) -> std::result::Result<Guarded<Settings>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let command = update_command(&settings)?;
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            parse(&host.companion(&access, command).await?)
        })
        .await
}
/// The host browser switch has its own file and revision on the host (`host-browser.json`), so it is read and
/// written by its own commands and never travels with the three switches above.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostBrowser {
    schema_version: u8,
    revision: u64,
    host_browser_enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostBrowserUpdate {
    expected_revision: u64,
    host_browser_enabled: bool,
}
fn parse_host_browser(text: &str) -> Result<HostBrowser> {
    strict(text, |settings: &HostBrowser| {
        (settings.schema_version, settings.revision)
    })
}
/// A companion that predates `settings host-browser` fails with clap's unknown-subcommand usage error. That is
/// the one failure the panel treats as "update the companion"; every other failure keeps its own text.
fn unsupported_companion(error: SshError) -> SshError {
    if error.kind() == "remote_command_failed"
        && error
            .message()
            .starts_with("error: unrecognized subcommand")
    {
        return SshError::new(
            "host_browser_companion_required",
            "Update the host companion to change the host browser setting",
        );
    }
    error
}
fn host_browser_command(update: Option<&HostBrowserUpdate>) -> Result<String> {
    Ok(match update {
        None => "lazysh-agent settings host-browser show".into(),
        Some(update) => format!(
            "lazysh-agent settings host-browser update --expected-revision {} --host-browser-enabled {}",
            expected_revision(update.expected_revision)?,
            update.host_browser_enabled
        ),
    })
}
async fn run_host_browser(
    state: &AppState,
    local: &LocalState,
    session_id: &str,
    update: Option<&HostBrowserUpdate>,
    access: &AccessLease,
) -> Result<HostBrowser> {
    let command = host_browser_command(update)?;
    let host = Host::resolve(state, local, session_id, access).await?;
    parse_host_browser(
        &host
            .companion(access, command)
            .await
            .map_err(unsupported_companion)?,
    )
}
#[tauri::command]
pub async fn get_host_browser_settings(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<HostBrowser>, GuardedError<crate::ssh::SshError>> {
    access
        .run(run_host_browser(&state, &local, &session_id, None, &access))
        .await
}
#[tauri::command]
pub async fn update_host_browser_settings(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    settings: HostBrowserUpdate,
    access: AccessLease,
) -> std::result::Result<Guarded<HostBrowser>, GuardedError<crate::ssh::SshError>> {
    access
        .run(run_host_browser(
            &state,
            &local,
            &session_id,
            Some(&settings),
            &access,
        ))
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
    #[test]
    fn host_browser_commands_only_format_typed_values_and_require_strict_responses() {
        let update = |expected_revision, host_browser_enabled| HostBrowserUpdate {
            expected_revision,
            host_browser_enabled,
        };
        assert_eq!(
            host_browser_command(None).unwrap(),
            "lazysh-agent settings host-browser show"
        );
        assert_eq!(
            host_browser_command(Some(&update(3, true))).unwrap(),
            "lazysh-agent settings host-browser update --expected-revision 3 --host-browser-enabled true"
        );
        assert!(host_browser_command(Some(&update(9_007_199_254_740_991, true))).is_err());
        assert!(parse_host_browser(
            r#"{"schemaVersion":1,"revision":0,"hostBrowserEnabled":false}"#
        )
        .is_ok());
        for text in [
            r#"{"schemaVersion":2,"revision":0,"hostBrowserEnabled":false}"#,
            r#"{"schemaVersion":1,"revision":9007199254740992,"hostBrowserEnabled":false}"#,
            r#"{"schemaVersion":1,"revision":0,"hostBrowserEnabled":"false"}"#,
            r#"{"schemaVersion":1,"revision":0}"#,
            // The three switches never travel with this file.
            r#"{"schemaVersion":1,"revision":0,"hostBrowserEnabled":false,"deviceToolsEnabled":true}"#,
        ] {
            assert!(parse_host_browser(text).is_err(), "{text}");
        }
        assert!(parse_host_browser(&" ".repeat(4097)).is_err());
    }
    #[test]
    fn only_the_unknown_subcommand_usage_error_of_an_old_companion_asks_for_an_update() {
        // Verbatim stderr of a released companion 1.1.5 asked for `settings host-browser show`.
        let old = SshError::new(
            "remote_command_failed",
            "error: unrecognized subcommand 'host-browser'\n\nUsage: lazysh-agent settings <COMMAND>\n\nFor more information, try '--help'.",
        );
        assert_eq!(
            unsupported_companion(old).kind(),
            "host_browser_companion_required"
        );
        for error in [
            SshError::new("remote_command_failed", "SettingsConflict"),
            SshError::new("remote_command_failed", "HostBrowserDisabled"),
            SshError::new("disconnected", "error: unrecognized subcommand"),
        ] {
            let kind = error.kind();
            assert_eq!(unsupported_companion(error).kind(), kind);
        }
    }
}
