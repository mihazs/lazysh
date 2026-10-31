//! Closed lifecycle setup commands over the existing protected SSH channel.
use super::*;
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
    Gemini,
    Cursor,
    Opencode,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Status,
    Install,
    Remove,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    agent: Agent,
    action: Action,
    profile_root: String,
    expected_plan: Option<String>,
}
impl Request {
    fn command(&self) -> Result<String> {
        if !resolve::path(&self.profile_root) {
            return Err(error(
                "invalid_request",
                "Select an absolute existing provider profile",
            ));
        }
        let action = match self.action {
            Action::Status => "status",
            Action::Install => "install",
            Action::Remove => "remove",
        };
        let agent = match self.agent {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Gemini => "gemini",
            Agent::Cursor => "cursor",
            Agent::Opencode => "opencode",
        };
        let suffix = match (&self.action, &self.expected_plan) {
            (Action::Status, None) => String::new(),
            (Action::Install | Action::Remove, Some(plan)) if lazysh_common::valid_sha256(plan) => {
                format!(" --expected-plan {}", ssh::quote(plan))
            }
            _ => {
                return Err(error(
                    "invalid_request",
                    "Inspect the exact hook setup plan first",
                ))
            }
        };
        Ok(format!(
            "lazysh-agent hooks {action} --agent {agent} --profile-root {}{suffix}",
            ssh::quote(&self.profile_root)
        ))
    }
}
#[tauri::command]
pub async fn companion_hooks(
    state: State<'_, AppState>,
    session_id: String,
    request: Request,
    access: AccessLease,
) -> std::result::Result<Guarded<serde_json::Value>, GuardedError<SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            execute(&session, request, &access).await
        })
        .await
}
pub(crate) async fn execute(
    session: &Session,
    request: Request,
    access: &AccessLease,
) -> Result<serde_json::Value> {
    let command = request.command()?;
    let unix = resolve::detect(session, access).await?.ok_or_else(|| {
        error(
            "companion_install_unsupported",
            "Hook setup requires an identified Unix SSH shell",
        )
    })?;
    let text = ssh::exec_for_access(session, unix.command(&command)?, access).await?;
    serde_json::from_str(&text).map_err(|_| error("invalid_output", "Invalid hook setup response"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_commands_quote_profiles_and_reject_uninspected_mutations() {
        let mut request = Request {
            agent: Agent::Codex,
            action: Action::Status,
            profile_root: "/owned/profile's $HOME".into(),
            expected_plan: None,
        };
        assert_eq!(
            request.command().unwrap(),
            "lazysh-agent hooks status --agent codex --profile-root '/owned/profile'\\''s $HOME'"
        );
        for (agent, name) in [(Agent::Gemini, "gemini"), (Agent::Cursor, "cursor")] {
            request.agent = agent;
            assert!(request.command().unwrap().starts_with(&format!(
                "lazysh-agent hooks status --agent {name} --profile-root "
            )));
        }
        request.action = Action::Install;
        assert!(request.command().is_err());
        request.expected_plan = Some("a".repeat(64));
        assert!(request
            .command()
            .unwrap()
            .ends_with(&format!("--expected-plan '{}'", "a".repeat(64))));
        request.profile_root = "/owned/../foreign".into();
        assert!(request.command().is_err());
    }
}
