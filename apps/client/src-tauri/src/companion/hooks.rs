//! Closed lifecycle setup commands over the existing protected SSH channel, or run on this device.
use super::*;
use crate::{host::Host, local::LocalState};
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
    #[serde(rename = "kimi-code")]
    KimiCode,
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
/// Whether `value` is an absolute provider profile path under the rules of the host that will read it: a drive path
/// (`C:\Users\me\.claude`, `C:/Users/me`) or a UNC share (`\\server\share\me`) on a Windows device, a POSIX path
/// everywhere else. Neither accepts control characters, `.` or `..` segments, or more than 4096 bytes; a Windows path
/// also refuses device namespaces (`\\?\`, `\\.\`) and a colon after the drive (alternate data streams).
fn profile_path(value: &str, windows: bool) -> bool {
    if !windows {
        return resolve::path(value);
    }
    let bytes = value.as_bytes();
    let rest = if bytes.len() > 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
    {
        &value[3..]
    } else if let Some(share) = value.strip_prefix("\\\\") {
        let mut parts = share.splitn(3, '\\');
        match (parts.next(), parts.next(), parts.next()) {
            (Some(server), Some(name), Some(rest))
                if !server.is_empty() && !name.is_empty() && !matches!(server, "?" | ".") =>
            {
                rest
            }
            _ => return false,
        }
    } else {
        return false;
    };
    !rest.is_empty()
        && value.len() <= 4096
        && !value.chars().any(char::is_control)
        && !rest.contains(':')
        && !rest
            .split(['\\', '/'])
            .any(|part| matches!(part, "." | ".."))
}
impl Request {
    fn command(&self, windows: bool) -> Result<String> {
        if !profile_path(&self.profile_root, windows) {
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
            Agent::KimiCode => "kimi-code",
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
    local: State<'_, LocalState>,
    session_id: String,
    request: Request,
    access: AccessLease,
) -> std::result::Result<Guarded<serde_json::Value>, GuardedError<SshError>> {
    dispatch(state, local, session_id, access, Some(request), None).await
}
async fn dispatch(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    access: AccessLease,
    request: Option<Request>,
    schema_version: Option<u8>,
) -> std::result::Result<Guarded<serde_json::Value>, GuardedError<SshError>> {
    access
        .run(async {
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            match request {
                Some(request) => execute(&host, request, &access).await,
                None => match schema_version {
                    None => discover(&host, &access).await,
                    Some(version) => discover_version(&host, &access, version).await,
                },
            }
        })
        .await
}
pub(crate) async fn execute(
    host: &Host,
    request: Request,
    access: &AccessLease,
) -> Result<serde_json::Value> {
    let command = request.command(host.uses_windows_paths())?;
    // The plan a status prints covers the executable's own path, so every action runs from one.
    execute_command(host, &command, access, true).await
}
#[tauri::command]
pub async fn companion_hook_discovery(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    schema_version: Option<u8>,
    access: AccessLease,
) -> std::result::Result<Guarded<serde_json::Value>, GuardedError<SshError>> {
    dispatch(state, local, session_id, access, None, schema_version).await
}
pub(crate) async fn discover(host: &Host, access: &AccessLease) -> Result<serde_json::Value> {
    execute_command(host, discovery_command(None)?, access, false).await
}
pub(crate) async fn discover_version(
    host: &Host,
    access: &AccessLease,
    schema_version: u8,
) -> Result<serde_json::Value> {
    execute_command(
        host,
        discovery_command(Some(schema_version))?,
        access,
        false,
    )
    .await
}
fn discovery_command(schema_version: Option<u8>) -> Result<&'static str> {
    match schema_version {
        None | Some(1) => Ok("lazysh-agent hooks discover"),
        Some(2) => Ok("lazysh-agent hooks discover --schema-version 2"),
        Some(3) => Ok("lazysh-agent hooks discover --schema-version 3"),
        Some(4) => Ok("lazysh-agent hooks discover --schema-version 4"),
        _ => Err(error(
            "invalid_request",
            "Unsupported hook discovery schema",
        )),
    }
}
async fn execute_command(
    host: &Host,
    command: &str,
    access: &AccessLease,
    lasting: bool,
) -> Result<serde_json::Value> {
    let text = match host {
        Host::Remote(session) => {
            let unix = resolve::detect(session, access)
                .await?
                .and_then(resolve::Host::unix)
                .ok_or_else(|| {
                    error(
                        "companion_install_unsupported",
                        "Hook setup requires an identified Unix SSH shell",
                    )
                })?;
            ssh::exec_for_access(session, unix.command(command)?, access).await?
        }
        // The companion itself says what this platform supports (templates only on Windows).
        #[cfg(desktop)]
        Host::Local(_) => host.companion_at(access, command.into(), lasting).await?,
    };
    parse_response(&text)
}
fn parse_response(text: &str) -> Result<serde_json::Value> {
    if text.len() > 128 * 1024 {
        return Err(error("invalid_output", "Hook setup response is too large"));
    }
    serde_json::from_str(text).map_err(|_| error("invalid_output", "Invalid hook setup response"))
}

/// What a user does in the companion panel, through the real command: give a Claude profile a
/// foreign setting, inspect the plan, install exactly that plan, and return the profile's
/// `settings.json` after checking the setup kept the foreign setting.
#[cfg(all(test, unix))]
pub(crate) async fn install_keeping_foreign_settings(
    app: &tauri::App<tauri::test::MockRuntime>,
    session_id: &str,
    profile: &std::path::Path,
    lease: &AccessLease,
) -> serde_json::Value {
    use tauri::Manager;
    std::fs::create_dir_all(profile).unwrap();
    std::fs::write(profile.join("settings.json"), "{\"theme\": \"dark\"}").unwrap();
    let run = |action: &str, plan: Option<&str>| {
        let request = serde_json::from_value(serde_json::json!({
            "agent": "claude", "action": action, "profileRoot": profile, "expectedPlan": plan
        }))
        .unwrap();
        // Boxed when called: the command future would overflow a test thread's stack in debug.
        let answer = Box::pin(companion_hooks(
            app.state(),
            app.state(),
            session_id.into(),
            request,
            lease.clone(),
        ));
        async move {
            answer
                .await
                .map(|value| value.into_inner().unwrap())
                .unwrap()
        }
    };
    let status = run("status", None).await;
    assert_eq!(status["supported"], true);
    let installed = run("install", status["installPlan"].as_str()).await;
    assert_eq!(installed["outcome"]["status"], "configured");
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(profile.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        settings["theme"], "dark",
        "managed setup keeps other settings"
    );
    settings
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A Windows device's own absolute paths are accepted, as POSIX ones are on every other host, and each host refuses the
    /// other's form: this ran on every platform because the host kind is a parameter.
    #[test]
    fn a_profile_path_follows_the_path_rules_of_the_host_that_reads_it() {
        for windows_path in [
            r"C:\Users\me\.claude",
            "c:/Users/me/.claude",
            r"D:\profiles\a b\.codex",
            r"\\server\share\me\.claude",
        ] {
            assert!(profile_path(windows_path, true), "{windows_path}");
            assert!(!profile_path(windows_path, false), "{windows_path}");
        }
        assert!(profile_path("/home/me/.claude", false));
        assert!(!profile_path("/home/me/.claude", true));
        for refused in [
            "",
            r"C:\",
            r"C:\Users\..\me",
            r"C:\Users\.\me",
            "C:/Users/../me",
            r"C:\Users\me\.claude:stream",
            r"relative\path",
            r"C:me",
            r"\\?\C:\Users\me",
            r"\\.\pipe\x",
            r"\\server\share",
            r"\\server\share\",
            "C:\\Users\\me\n",
        ] {
            assert!(!profile_path(refused, true), "{refused:?}");
        }
        assert!(!profile_path(&format!("C:\\{}", "a".repeat(4100)), true));
    }
    #[test]
    fn a_windows_profile_path_reaches_the_companion_as_one_literal_argument() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "agent": "claude", "action": "status", "profileRoot": r"C:\Users\o'me\.claude"
        }))
        .unwrap();
        assert_eq!(
            request.command(true).unwrap(),
            r"lazysh-agent hooks status --agent claude --profile-root 'C:\Users\o'\''me\.claude'"
        );
        assert!(request.command(false).is_err());
    }
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
        assert_eq!(
            discovery_command(Some(4)).unwrap(),
            "lazysh-agent hooks discover --schema-version 4"
        );
        for version in [0, 5, u8::MAX] {
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
            request.command(false).unwrap(),
            "lazysh-agent hooks status --agent codex --profile-root '/owned/profile'\\''s $HOME'"
        );
        for (agent, name) in [
            (Agent::Gemini, "gemini"),
            (Agent::Cursor, "cursor"),
            (Agent::Cline, "cline"),
            (Agent::Droid, "droid"),
            (Agent::Copilot, "copilot"),
            (Agent::Amp, "amp"),
            (Agent::KimiCode, "kimi-code"),
        ] {
            request.agent = agent;
            assert!(request.command(false).unwrap().starts_with(&format!(
                "lazysh-agent hooks status --agent {name} --profile-root "
            )));
        }
        request.action = Action::Install;
        assert!(request.command(false).is_err());
        request.expected_plan = Some("a".repeat(64));
        assert!(request
            .command(false)
            .unwrap()
            .ends_with(&format!("--expected-plan '{}'", "a".repeat(64))));
        request.profile_root = "/owned/../foreign".into();
        assert!(request.command(false).is_err());
    }
}
