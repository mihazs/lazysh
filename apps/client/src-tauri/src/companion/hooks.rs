//! Closed lifecycle setup commands over the existing protected SSH channel.
use super::*;
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
    Droid,
    Gemini,
    Cursor,
    Opencode,
    Cline,
    Copilot,
    Amp,
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
            Agent::Droid => "droid",
            Agent::Gemini => "gemini",
            Agent::Cursor => "cursor",
            Agent::Opencode => "opencode",
            Agent::Cline => "cline",
            Agent::Copilot => "copilot",
            Agent::Amp => "amp",
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
    dispatch(state, session_id, access, Some(request), None).await
}
async fn dispatch(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
    request: Option<Request>,
    schema_version: Option<u8>,
) -> std::result::Result<Guarded<serde_json::Value>, GuardedError<SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            match request {
                Some(request) => execute(&session, request, &access).await,
                None => match schema_version {
                    None => discover(&session, &access).await,
                    Some(version) => discover_version(&session, &access, version).await,
                },
            }
        })
        .await
}
pub(crate) async fn execute(
    session: &Session,
    request: Request,
    access: &AccessLease,
) -> Result<serde_json::Value> {
    let command = request.command()?;
    execute_command(session, &command, access).await
}
#[tauri::command]
pub async fn companion_hook_discovery(
    state: State<'_, AppState>,
    session_id: String,
    schema_version: Option<u8>,
    access: AccessLease,
) -> std::result::Result<Guarded<serde_json::Value>, GuardedError<SshError>> {
    dispatch(state, session_id, access, None, schema_version).await
}
pub(crate) async fn discover(session: &Session, access: &AccessLease) -> Result<serde_json::Value> {
    execute_command(session, discovery_command(None)?, access).await
}
pub(crate) async fn discover_version(
    session: &Session,
    access: &AccessLease,
    schema_version: u8,
) -> Result<serde_json::Value> {
    execute_command(session, discovery_command(Some(schema_version))?, access).await
}
fn discovery_command(schema_version: Option<u8>) -> Result<&'static str> {
    match schema_version {
        None | Some(1) => Ok("lazysh-agent hooks discover"),
        Some(2) => Ok("lazysh-agent hooks discover --schema-version 2"),
        Some(3) => Ok("lazysh-agent hooks discover --schema-version 3"),
        _ => Err(error(
            "invalid_request",
            "Unsupported hook discovery schema",
        )),
    }
}
async fn execute_command(
    session: &Session,
    command: &str,
    access: &AccessLease,
) -> Result<serde_json::Value> {
    let unix = resolve::detect(session, access).await?.ok_or_else(|| {
        error(
            "companion_install_unsupported",
            "Hook setup requires an identified Unix SSH shell",
        )
    })?;
    let text = ssh::exec_for_access(session, unix.command(command)?, access).await?;
    parse_response(&text)
}
fn parse_response(text: &str) -> Result<serde_json::Value> {
    if text.len() > 128 * 1024 {
        return Err(error("invalid_output", "Hook setup response is too large"));
    }
    serde_json::from_str(text).map_err(|_| error("invalid_output", "Invalid hook setup response"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hook_discovery_defaults_to_v1_and_only_explicit_versions_change_the_command() {
        for version in [None, Some(1)] {
            assert_eq!(
                discovery_command(version).unwrap(),
                "lazysh-agent hooks discover"
            );
        }
        assert_eq!(
            discovery_command(Some(2)).unwrap(),
            "lazysh-agent hooks discover --schema-version 2"
        );
        assert_eq!(
            discovery_command(Some(3)).unwrap(),
            "lazysh-agent hooks discover --schema-version 3"
        );
        for version in [0, 4, u8::MAX] {
            assert!(discovery_command(Some(version)).is_err());
        }
    }
    #[test]
    fn hook_responses_reject_oversized_and_malformed_output() {
        assert!(parse_response("not JSON").is_err());
        assert!(parse_response(&format!("\"{}\"", "x".repeat(128 * 1024))).is_err());
        assert_eq!(
            parse_response("{\"schemaVersion\":1}").unwrap()["schemaVersion"],
            1
        );
    }
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
        for (agent, name) in [
            (Agent::Gemini, "gemini"),
            (Agent::Cursor, "cursor"),
            (Agent::Cline, "cline"),
            (Agent::Droid, "droid"),
            (Agent::Copilot, "copilot"),
            (Agent::Amp, "amp"),
        ] {
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
