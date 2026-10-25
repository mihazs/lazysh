use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::{AppState, Result, SshError};
use tauri::{AppHandle, State};
use tauri_plugin_notification::{NotificationExt, PermissionState};

fn summary(agent: &str, project: &str) -> Result<String> {
    if agent.is_empty()
        || agent.len() > 320
        || project.len() > 1024
        || agent.chars().chain(project.chars()).any(char::is_control)
    {
        return Err(SshError::new(
            "invalid_notification",
            "Invalid agent notification summary",
        ));
    }
    Ok(if project.is_empty() {
        format!("{agent} needs your attention")
    } else {
        format!("{agent} · {project}")
    })
}

#[tauri::command]
pub async fn notify_agent_attention(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    agent: String,
    project: String,
    event_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<()>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let _session = state.session(&session_id).await?;
            if event_id.len() != 64 || !event_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(SshError::new(
                    "invalid_notification",
                    "Invalid inbox event identifier",
                ));
            }
            let body = summary(&agent, &project)?;
            if app.notification().permission_state()? != PermissionState::Granted {
                return Err(SshError::new(
                    "notification_permission",
                    "Enable notification permission from the inbox first",
                ));
            }
            app.notification()
                .builder()
                .title("lazysh · Needs you")
                .body(body)
                .action_type_id("lazysh-agent")
                .extra("lazyshEventId", event_id)
                .extra("lazyshSessionId", session_id)
                .show()?;
            Ok(())
        })
        .await
}

#[tauri::command]
pub fn notification_test(
    app: AppHandle,
    access: AccessLease,
) -> std::result::Result<Guarded<()>, GuardedError<crate::ssh::SshError>> {
    access.run_sync(|| {
        if app.notification().permission_state()? != PermissionState::Granted {
            return Err(SshError::new(
                "notification_permission",
                "Enable notification permission from the inbox first",
            ));
        }
        app.notification()
            .builder()
            .title("lazysh notifications")
            .body("Local notifications are enabled on this device.")
            .show()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notification_summary_is_bounded_and_excludes_transcript_payloads() {
        assert_eq!(summary("Claude", "/work").unwrap(), "Claude · /work");
        assert_eq!(summary("Codex", "").unwrap(), "Codex needs your attention");
        for (agent, project) in [
            ("", "work"),
            ("Claude\nsecret", "/work"),
            ("Claude", "/work\0secret"),
            ("Claude", &"x".repeat(1025)),
        ] {
            assert!(summary(agent, project).is_err());
        }
    }
}
