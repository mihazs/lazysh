use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::{quote, AppState, Result, SshError};
use tauri::State;

#[tauri::command]
pub async fn agent_approvals(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<serde_json::Value>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            Ok(serde_json::from_str(
                &crate::ssh::exec_for_access(
                    &session,
                    "lazysh-agent approval-list --limit 20".into(),
                    &access,
                )
                .await?,
            )?)
        })
        .await
}

fn resolve_command(
    id: &str,
    hash: &str,
    agent_session_id: &str,
    pane_id: Option<&str>,
    decision: &str,
) -> Result<String> {
    if uuid::Uuid::parse_str(id).is_err()
        || hash.len() != 64
        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        || agent_session_id.is_empty()
        || agent_session_id.len() > 1024
        || agent_session_id.chars().any(char::is_control)
        || !matches!(decision, "allow" | "deny")
    {
        return Err(SshError::new(
            "invalid_input",
            "Invalid approval identity or decision",
        ));
    }
    if pane_id.is_some_and(|pane| {
        !pane.starts_with('%')
            || pane.len() < 2
            || pane.len() > 32
            || !pane[1..].bytes().all(|b| b.is_ascii_digit())
    }) {
        return Err(SshError::new("invalid_input", "Invalid approval pane"));
    }
    Ok(format!("lazysh-agent approval-resolve --id {} --expected-hash {} --session-id={} --decision {decision}{}", quote(id), quote(hash), quote(agent_session_id), pane_id.map(|pane| format!(" --pane-id={}", quote(pane))).unwrap_or_default()))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn resolve_agent_approval(
    state: State<'_, AppState>,
    session_id: String,
    id: String,
    expected_hash: String,
    agent_session_id: String,
    pane_id: Option<String>,
    decision: String,
    access: AccessLease,
) -> std::result::Result<Guarded<serde_json::Value>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let command = resolve_command(
                &id,
                &expected_hash,
                &agent_session_id,
                pane_id.as_deref(),
                &decision,
            )?;
            let session = state.session(&session_id).await?;
            Ok(serde_json::from_str(
                &crate::ssh::exec_for_access(&session, command, &access).await?,
            )?)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_commands_bind_exact_identity_without_shell_interpolation() {
        let id = "b714333f-82b1-4ee0-a383-6fd6dc1eca01";
        let hash = "a".repeat(64);
        assert!(
            resolve_command(id, &hash, "session'$(cmd)", Some("%7"), "deny")
                .unwrap()
                .contains("--session-id='session'\\''$(cmd)'")
        );
        for (request, digest, pane, decision) in [
            ("bad", hash.as_str(), Some("%7"), "allow"),
            (id, "bad", Some("%7"), "allow"),
            (id, hash.as_str(), Some("%7;cmd"), "allow"),
            (id, hash.as_str(), None, "allow;cmd"),
        ] {
            assert!(resolve_command(request, digest, "session", pane, decision).is_err());
        }
    }
}
