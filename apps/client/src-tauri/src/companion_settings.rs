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
/// What `get_companion_settings` answers: the settings, and the feature switches when the companion has them.
#[derive(Serialize)]
pub struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    features: Option<HostFeatures>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostFeatures {
    schema_version: u8,
    revision: u64,
    simulator_streaming_enabled: bool,
    port_scan_enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeaturesUpdate {
    expected_revision: u64,
    simulator_streaming_enabled: bool,
    port_scan_enabled: bool,
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
fn parse_features(text: &str) -> Result<HostFeatures> {
    strict(text, |features: &HostFeatures| {
        (features.schema_version, features.revision)
    })
}
fn features_command(update: &FeaturesUpdate) -> Result<String> {
    Ok(format!("lazysh-agent settings features update --expected-revision {} --simulator-streaming-enabled {} --port-scan-enabled {}",expected_revision(update.expected_revision)?,update.simulator_streaming_enabled,update.port_scan_enabled))
}
/// What a companion without `settings features` prints, so an absent or older one reads as "no host switches".
const FEATURES_COMPANION_REQUIRED: &str = "lazysh-host-features-companion-required-v1";
/// `None` when the companion cannot say: the host has none, or an older one. Both switches then count as enabled.
/// This desktop's own companion is the app's version, so it always has them.
async fn read_features(host: &Host, access: &AccessLease) -> Result<Option<HostFeatures>> {
    let line = "lazysh-agent settings features show";
    let session = match host {
        Host::Remote(session) => session,
        #[cfg(desktop)]
        Host::Local(_) => {
            // No local companion (or one without the switches) means no switches: a local session still scans.
            return match host.companion(access, line.into()).await {
                Ok(text) => parse_features(&text).map(Some),
                Err(error) if error.kind() == "remote_command_failed" => Ok(None),
                Err(error) => Err(error),
            };
        }
    };
    let unix = crate::companion::positive_unix(session, access).await?;
    let command = crate::companion::required_command(
        session,
        line.into(),
        FEATURES_COMPANION_REQUIRED,
        access,
    )
    .await?;
    match crate::ssh::exec_for_access(session, command, access).await {
        Ok(text) if text.trim() == FEATURES_COMPANION_REQUIRED => Ok(None),
        Ok(text) => parse_features(&text).map(Some),
        // Only a positively identified Unix host proves that a failing companion is a real error.
        Err(error) if !unix && error.kind() == "remote_command_failed" => Ok(None),
        Err(error) => Err(error),
    }
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
    local: State<'_, LocalState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<SettingsView>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            let mut settings = parse(
                &host
                    .companion(&access, "lazysh-agent settings show".into())
                    .await?,
            )?;
            settings.auto_update = current_auto_update(&host, &access).await;
            // Unreadable feature switches must not hide the settings: the panel then offers none.
            let features = read_features(&host, &access).await.unwrap_or(None);
            Ok(SettingsView { settings, features })
        })
        .await
}
/// A companion without `auto-update` fails the command; that is "no such setting", not an error.
async fn current_auto_update(host: &Host, access: &AccessLease) -> Option<AutoUpdate> {
    let text = host
        .companion(access, "lazysh-agent auto-update status".into())
        .await
        .ok()?;
    parse_auto_update(&text).ok()
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
            let change = settings
                .auto_update
                .as_ref()
                .map(auto_update_command)
                .transpose()?;
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            let mut saved = parse(&host.companion(&access, command).await?)?;
            saved.auto_update = match change {
                Some(command) => Some(parse_auto_update(&host.companion(&access, command).await?)?),
                None => current_auto_update(&host, &access).await,
            };
            Ok(saved)
        })
        .await
}
/// The host's feature switches, or `null` when its companion does not have them.
#[tauri::command]
pub async fn get_host_features(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Option<HostFeatures>>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            read_features(&host, &access).await
        })
        .await
}
#[tauri::command]
pub async fn update_host_features(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    features: FeaturesUpdate,
    access: AccessLease,
) -> std::result::Result<Guarded<HostFeatures>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let command = features_command(&features)?;
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            parse_features(&host.companion(&access, command).await?)
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
/// A companion that predates `settings host-browser` (or `host-browser --clear-data`) fails with clap's
/// unknown-subcommand (or unknown-argument) usage error. That is the one failure the panel treats as "update the
/// companion"; every other failure keeps its own text.
fn unsupported_companion(error: SshError) -> SshError {
    if error.kind() == "remote_command_failed"
        && [
            "error: unrecognized subcommand",
            "error: unexpected argument",
        ]
        .iter()
        .any(|usage| error.message().starts_with(usage))
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
/// What `lazysh-agent host-browser --clear-data` prints: whether a kept profile existed and was removed.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostBrowserCleared {
    schema_version: u8,
    cleared: bool,
}
fn parse_cleared(text: &str) -> Result<HostBrowserCleared> {
    strict(text, |cleared: &HostBrowserCleared| {
        (cleared.schema_version, 0)
    })
}
/// **Clear browser data**: removes the profile that Keep profile left on the host. Like the companion's own
/// command it works while the host browser switch is off, and the host refuses it while a browser uses the
/// profile. It sends no value, so there is nothing for the app to store or log.
const CLEAR_DATA: &str = "lazysh-agent host-browser --clear-data";
#[tauri::command]
pub async fn host_browser_clear_data(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<HostBrowserCleared>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            parse_cleared(
                &host
                    .companion(&access, CLEAR_DATA.into())
                    .await
                    .map_err(unsupported_companion)?,
            )
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
    #[test]
    fn feature_commands_only_format_typed_values_and_require_strict_responses() {
        let update = FeaturesUpdate {
            expected_revision: 3,
            simulator_streaming_enabled: false,
            port_scan_enabled: true,
        };
        assert_eq!(features_command(&update).unwrap(),"lazysh-agent settings features update --expected-revision 3 --simulator-streaming-enabled false --port-scan-enabled true");
        assert!(features_command(&FeaturesUpdate {
            expected_revision: MAX_REVISION,
            ..update
        })
        .is_err());
        assert!(parse_features(r#"{"schemaVersion":1,"revision":2,"simulatorStreamingEnabled":false,"portScanEnabled":true}"#).is_ok());
        for text in [
            r#"{"schemaVersion":2,"revision":2,"simulatorStreamingEnabled":false,"portScanEnabled":true}"#,
            r#"{"schemaVersion":1,"revision":2,"simulatorStreamingEnabled":"no","portScanEnabled":true}"#,
            r#"{"schemaVersion":1,"revision":2,"simulatorStreamingEnabled":false,"portScanEnabled":true,"extra":1}"#,
            r#"{"schemaVersion":1,"revision":2,"simulatorStreamingEnabled":false}"#,
        ] {
            assert!(parse_features(text).is_err());
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
        // Verbatim stdout of `settings host-browser show|update` (keys in the order the companion prints them).
        for printed in [
            r#"{"hostBrowserEnabled":false,"revision":0,"schemaVersion":1}"#,
            r#"{"hostBrowserEnabled":true,"revision":1,"schemaVersion":1}"#,
        ] {
            assert!(parse_host_browser(printed).is_ok(), "{printed}");
        }
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
        // A companion with `host-browser` but without `--clear-data`, and one that predates the command.
        for usage in [
            "error: unexpected argument '--clear-data' found\n\nUsage: lazysh-agent host-browser [OPTIONS]",
            "error: unrecognized subcommand 'host-browser'",
        ] {
            assert_eq!(
                unsupported_companion(SshError::new("remote_command_failed", usage)).kind(),
                "host_browser_companion_required"
            );
        }
        for error in [
            SshError::new("remote_command_failed", "SettingsConflict"),
            SshError::new("remote_command_failed", "BrowserProfileInUse"),
            SshError::new("remote_command_failed", "HostBrowserDisabled"),
            SshError::new("disconnected", "error: unrecognized subcommand"),
        ] {
            let kind = error.kind();
            assert_eq!(unsupported_companion(error).kind(), kind);
        }
    }
    #[test]
    fn clear_data_reads_only_the_strict_answer_of_the_companion() {
        // Verbatim stdout of `host-browser --clear-data` (keys in the order the companion prints them).
        for (printed, cleared) in [
            (r#"{"cleared":true,"schemaVersion":1}"#, true),
            (r#"{"cleared":false,"schemaVersion":1}"#, false),
        ] {
            assert_eq!(
                parse_cleared(printed).unwrap().cleared,
                cleared,
                "{printed}"
            );
        }
        for text in [
            r#"{"schemaVersion":2,"cleared":true}"#,
            r#"{"schemaVersion":1,"cleared":"true"}"#,
            r#"{"schemaVersion":1}"#,
            // A path, a count or an address of a profile never reaches the renderer.
            r#"{"schemaVersion":1,"cleared":true,"profile":"/home/user/.local/state/lazysh/host-browser/kept"}"#,
        ] {
            assert!(parse_cleared(text).is_err(), "{text}");
        }
        assert!(parse_cleared(&" ".repeat(4097)).is_err());
    }
}
