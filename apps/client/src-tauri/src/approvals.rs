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
                &crate::companion::exec(
                    &session,
                    "lazysh-agent approval-list --limit 20".into(),
                    &access,
                )
                .await?,
            )?)
        })
        .await
}

/// How an approval is answered beyond allow or deny: one of the request's own suggested permission updates (an
/// index into the listed `options`, allow only) or a message the agent reads (deny only).
#[derive(Default)]
struct Extras<'a> {
    option: Option<u8>,
    message: Option<&'a str>,
}

fn resolve_command(
    id: &str,
    hash: &str,
    agent_session_id: &str,
    pane_id: Option<&str>,
    decision: &str,
    extras: &Extras,
) -> Result<String> {
    if uuid::Uuid::parse_str(id).is_err()
        || hash.len() != 64
        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        || agent_session_id.is_empty()
        || agent_session_id.len() > 1024
        || agent_session_id.chars().any(char::is_control)
        || !matches!(decision, "allow" | "deny")
        || extras
            .option
            .is_some_and(|option| option >= 8 || decision != "allow")
        || extras.message.is_some_and(|message| {
            decision != "deny"
                || message.trim().is_empty()
                || message.chars().count() > 500
                || message.chars().any(char::is_control)
        })
    {
        return Err(SshError::new(
            "invalid_input",
            "Invalid approval identity or decision",
        ));
    }
    if pane_id.is_some_and(|pane| !lazysh_common::valid_pane_identity(pane)) {
        return Err(SshError::new("invalid_input", "Invalid approval pane"));
    }
    Ok(format!("lazysh-agent approval-resolve --id {} --expected-hash {} --session-id={} --decision {decision}{}", quote(id), quote(hash), quote(agent_session_id), pane_id.map(|pane| format!(" --pane-id={}", quote(pane))).unwrap_or_default())
        + &extras.option.map(|option| format!(" --option {option}")).unwrap_or_default()
        + &extras.message.map(|message| format!(" --message={}", quote(message))).unwrap_or_default())
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
    option: Option<u8>,
    message: Option<String>,
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
                &Extras {
                    option,
                    message: message.as_deref(),
                },
            )?;
            let session = state.session(&session_id).await?;
            Ok(serde_json::from_str(
                &crate::companion::exec(&session, command, &access).await?,
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
        let none = Extras::default();
        assert!(
            resolve_command(id, &hash, "session'$(cmd)", Some("%7"), "deny", &none)
                .unwrap()
                .contains("--session-id='session'\\''$(cmd)'")
        );
        for (request, digest, pane, decision) in [
            ("bad", hash.as_str(), Some("%7"), "allow"),
            (id, "bad", Some("%7"), "allow"),
            (id, hash.as_str(), Some("%7;cmd"), "allow"),
            (id, hash.as_str(), None, "allow;cmd"),
        ] {
            assert!(resolve_command(request, digest, "session", pane, decision, &none).is_err());
        }
    }

    #[test]
    fn a_tmux_zellij_or_herdr_pane_is_passed_as_one_quoted_argument_and_nothing_else_is() {
        let id = "b714333f-82b1-4ee0-a383-6fd6dc1eca01";
        let hash = "a".repeat(64);
        let command =
            |pane| resolve_command(id, &hash, "s", Some(pane), "allow", &Extras::default());
        for (pane, argument) in [
            ("%7", "--pane-id='%7'"),
            ("zellij:my work:3", "--pane-id='zellij:my work:3'"),
            ("herdr:work:w3V:p1", "--pane-id='herdr:work:w3V:p1'"),
        ] {
            assert!(command(pane).unwrap().contains(argument), "{pane}");
        }
        for pane in [
            "zellij:work",
            "zellij:work:x",
            "herdr:work",
            "herdr:w:w3V:p1;cmd",
            "herdr:a b:w3V:p1",
            "w3V:p1",
            "",
        ] {
            assert!(command(pane).is_err(), "{pane}");
        }
    }

    #[test]
    fn an_option_belongs_to_an_allow_and_a_message_to_a_deny_and_both_are_quoted() {
        let id = "b714333f-82b1-4ee0-a383-6fd6dc1eca01";
        let hash = "a".repeat(64);
        let command = |decision, option, message| {
            resolve_command(id, &hash, "s", None, decision, &Extras { option, message })
        };
        assert!(command("allow", Some(2), None)
            .unwrap()
            .ends_with("--decision allow --option 2"));
        assert!(command("deny", None, Some("it's $(bad)"))
            .unwrap()
            .ends_with("--decision deny --message='it'\\''s $(bad)'"));
        for refused in [
            command("deny", Some(0), None),
            command("allow", Some(8), None),
            command("allow", None, Some("no")),
            command("deny", None, Some("   ")),
            command("deny", None, Some("two\nlines")),
            command("deny", None, Some(&"x".repeat(501))),
        ] {
            assert!(refused.is_err());
        }
    }
}
