//! The host's notification policy: two opt-in switches (nested-agent suppression, quiet while the host desktop is
//! unlocked) that the companion keeps in their own file with their own revision, so they are read and written by
//! their own commands and never travel with `settings.json`.
use crate::{
    app_lock::{AccessLease, Guarded, GuardedError},
    host::Host,
    local::LocalState,
    ssh::{AppState, Result, SshError},
};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_REVISION: u64 = 9_007_199_254_740_991;
const LIMIT: usize = 4096;
/// The failure kind the panel turns into "update the host companion".
const COMPANION_REQUIRED: &str = "notification_policy_companion_required";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    schema_version: u8,
    revision: u64,
    nested_agent_suppression_enabled: bool,
    suppress_while_desktop_unlocked: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyUpdate {
    expected_revision: u64,
    nested_agent_suppression_enabled: bool,
    suppress_while_desktop_unlocked: bool,
}
/// Bounded, strict and versioned, like every other settings file the companion answers with.
fn parse(text: &str) -> Result<Policy> {
    let policy = (text.len() <= LIMIT)
        .then(|| serde_json::from_str::<Policy>(text).ok())
        .flatten()
        .filter(|policy| policy.schema_version == 1 && policy.revision <= MAX_REVISION);
    policy.ok_or_else(|| {
        SshError::new(
            "notification_policy",
            "Unsupported host notification policy",
        )
    })
}
/// A companion that predates `settings notifications` fails with clap's unknown-subcommand usage error. That is the
/// one failure the panel treats as "update the companion"; every other failure keeps the companion's own text.
fn companion_required(error: SshError) -> SshError {
    if error.kind() == "remote_command_failed"
        && error
            .message()
            .starts_with("error: unrecognized subcommand")
    {
        return SshError::new(
            COMPANION_REQUIRED,
            "Update the host companion to change the notification switches",
        );
    }
    error
}
fn command(update: Option<&PolicyUpdate>) -> Result<String> {
    let Some(update) = update else {
        return Ok("lazysh-agent settings notifications show".into());
    };
    if update.expected_revision >= MAX_REVISION {
        return Err(SshError::new(
            "notification_policy",
            "Invalid notification policy revision",
        ));
    }
    Ok(format!("lazysh-agent settings notifications update --expected-revision {} --nested-agent-suppression-enabled {} --suppress-while-desktop-unlocked {}", update.expected_revision, update.nested_agent_suppression_enabled, update.suppress_while_desktop_unlocked))
}
async fn run(
    state: &AppState,
    local: &LocalState,
    session_id: &str,
    update: Option<&PolicyUpdate>,
    access: &AccessLease,
) -> Result<Policy> {
    let command = command(update)?;
    let host = Host::resolve(state, local, session_id, access).await?;
    parse(
        &host
            .companion(access, command)
            .await
            .map_err(companion_required)?,
    )
}
#[tauri::command]
pub async fn get_notification_policy(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Policy>, GuardedError<SshError>> {
    access
        .run(run(&state, &local, &session_id, None, &access))
        .await
}
#[tauri::command]
pub async fn update_notification_policy(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    policy: PolicyUpdate,
    access: AccessLease,
) -> std::result::Result<Guarded<Policy>, GuardedError<SshError>> {
    access
        .run(run(&state, &local, &session_id, Some(&policy), &access))
        .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_only_format_typed_values_and_refuse_an_unrepresentable_revision() {
        let update = |expected_revision| PolicyUpdate {
            expected_revision,
            nested_agent_suppression_enabled: true,
            suppress_while_desktop_unlocked: false,
        };
        assert_eq!(
            command(None).unwrap(),
            "lazysh-agent settings notifications show"
        );
        assert_eq!(
            command(Some(&update(3))).unwrap(),
            "lazysh-agent settings notifications update --expected-revision 3 --nested-agent-suppression-enabled true --suppress-while-desktop-unlocked false"
        );
        assert!(command(Some(&update(MAX_REVISION))).is_err());
    }
    #[test]
    fn the_policy_is_read_only_exactly_as_the_companion_prints_it() {
        // Stdout of `settings notifications show` and `update` (keys in the order the companion prints them).
        for printed in [
            r#"{"nestedAgentSuppressionEnabled":false,"revision":0,"schemaVersion":1,"suppressWhileDesktopUnlocked":false}"#,
            r#"{"nestedAgentSuppressionEnabled":true,"revision":2,"schemaVersion":1,"suppressWhileDesktopUnlocked":true}"#,
        ] {
            assert!(parse(printed).is_ok(), "{printed}");
        }
        for text in [
            r#"{"schemaVersion":2,"revision":0,"nestedAgentSuppressionEnabled":false,"suppressWhileDesktopUnlocked":false}"#,
            r#"{"schemaVersion":1,"revision":9007199254740992,"nestedAgentSuppressionEnabled":false,"suppressWhileDesktopUnlocked":false}"#,
            r#"{"schemaVersion":1,"revision":0,"nestedAgentSuppressionEnabled":"false","suppressWhileDesktopUnlocked":false}"#,
            r#"{"schemaVersion":1,"revision":0,"nestedAgentSuppressionEnabled":false}"#,
            // The three switches never travel with this file.
            r#"{"schemaVersion":1,"revision":0,"nestedAgentSuppressionEnabled":false,"suppressWhileDesktopUnlocked":false,"deviceToolsEnabled":true}"#,
        ] {
            assert!(parse(text).is_err(), "{text}");
        }
        assert!(parse(&" ".repeat(LIMIT + 1)).is_err());
    }
    #[test]
    fn only_the_unknown_subcommand_usage_error_of_an_old_companion_asks_for_an_update() {
        // Verbatim stderr of a companion that predates the subcommand (checked against a build of main before it).
        let old = SshError::new(
            "remote_command_failed",
            "error: unrecognized subcommand 'notifications'\n\nUsage: lazysh-agent settings <COMMAND>\n\nFor more information, try '--help'.",
        );
        assert_eq!(companion_required(old).kind(), COMPANION_REQUIRED);
        for error in [
            SshError::new("remote_command_failed", "NotificationPolicyConflict"),
            SshError::new("remote_command_failed", "NotificationPolicyBusy"),
            SshError::new("disconnected", "error: unrecognized subcommand"),
        ] {
            let kind = error.kind();
            assert_eq!(companion_required(error).kind(), kind);
        }
    }
}
