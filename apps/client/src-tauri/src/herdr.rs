use crate::app_lock::AccessLease;
use crate::ssh::{quote, AppState, Result, SshError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Deserialize, Serialize)]
pub struct HerdrTree {
    pub workspaces: Vec<Workspace>,
    pub tabs: Vec<Tab>,
    pub panes: Vec<Pane>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<Agent>>,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Workspace {
    pub workspace_id: String,
    pub label: String,
    pub focused: bool,
    pub agent_status: String,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Tab {
    pub tab_id: String,
    pub workspace_id: String,
    pub label: String,
    pub number: u32,
    pub focused: bool,
    pub agent_status: String,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Pane {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    pub focused: bool,
    pub agent_status: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Agent {
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub pane_id: String,
    pub agent_status: String,
    pub agent: Option<String>,
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "reported_session",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_session: Option<ReportedSessionRef>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ReportedSessionRef {
    source: String,
    agent: String,
    kind: String,
    value: String,
}

// Project only bounded provider IDs; path references and optional private metadata are discarded.
fn reported_session<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<ReportedSessionRef>, D::Error> {
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    let Some(reference) = raw.and_then(|v| serde_json::from_value::<ReportedSessionRef>(v).ok())
    else {
        return Ok(None);
    };
    let valid = matches!(
        (reference.source.as_str(), reference.agent.as_str()),
        ("herdr:codex", "codex") | ("herdr:claude", "claude") | ("herdr:opencode", "opencode")
    ) && reference.kind == "id"
        && !reference.value.is_empty()
        && reference.value.len() <= 256
        && reference.value.as_bytes()[0].is_ascii_alphanumeric()
        && reference
            .value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    Ok(valid.then_some(reference))
}

fn text(value: &str, max: usize) -> Result<()> {
    crate::multiplexer::validate_text(value, max, "Invalid Herdr name or path")
}

fn target(value: &str, kind: Option<char>) -> Result<()> {
    if !lazysh_common::valid_herdr_id(value, kind) {
        return Err(SshError::new(
            "invalid_target",
            "Invalid exact Herdr target",
        ));
    }
    Ok(())
}
fn command(session: &str, args: String) -> Result<String> {
    text(session, 200)?;
    Ok(format!("herdr --session {} {args}", quote(session)))
}
fn parse(output: &str) -> Result<HerdrTree> {
    #[derive(Deserialize)]
    struct Response {
        result: ResultBody,
    }
    #[derive(Deserialize)]
    struct ResultBody {
        r#type: String,
        snapshot: HerdrTree,
    }
    let value: Response = serde_json::from_str(output)?;
    if value.result.r#type != "session_snapshot" {
        return Err(SshError::new(
            "invalid_output",
            "Unsupported Herdr snapshot",
        ));
    }
    let mut tree = value.result.snapshot;
    if tree.workspaces.len() > 1000
        || tree.tabs.len() > 2000
        || tree.panes.len() > 4096
        || tree
            .agents
            .as_ref()
            .is_some_and(|agents| agents.len() > 4096)
    {
        return Err(SshError::new(
            "output_too_large",
            "Herdr workspace tree is too large",
        ));
    }
    let invalid = || SshError::new("invalid_output", "Invalid Herdr tree metadata");
    let status = |value: &str| matches!(value, "idle" | "working" | "blocked" | "done" | "unknown");
    let mut workspaces = std::collections::HashSet::new();
    for w in &tree.workspaces {
        target(&w.workspace_id, None)?;
        if !workspaces.insert(w.workspace_id.as_str()) || !status(&w.agent_status) {
            return Err(invalid());
        }
    }
    let mut tabs = std::collections::HashMap::new();
    for t in &tree.tabs {
        target(&t.workspace_id, None)?;
        target(&t.tab_id, Some('t'))?;
        if !workspaces.contains(t.workspace_id.as_str())
            || t.tab_id.split_once(':').map(|(workspace, _)| workspace)
                != Some(t.workspace_id.as_str())
            || tabs
                .insert(t.tab_id.as_str(), t.workspace_id.as_str())
                .is_some()
            || !status(&t.agent_status)
        {
            return Err(invalid());
        }
    }
    let mut panes = std::collections::HashMap::new();
    for p in &tree.panes {
        target(&p.workspace_id, None)?;
        target(&p.tab_id, Some('t'))?;
        target(&p.pane_id, Some('p'))?;
        if tabs.get(p.tab_id.as_str()).copied() != Some(p.workspace_id.as_str())
            || p.pane_id.split_once(':').map(|(workspace, _)| workspace)
                != Some(p.workspace_id.as_str())
            || panes.insert(p.pane_id.as_str(), p).is_some()
            || !status(&p.agent_status)
            || p.terminal_id
                .as_ref()
                .is_some_and(|v| text(v, 256).is_err())
            || p.cwd
                .as_ref()
                .is_some_and(|v| v.len() > 4096 || v.chars().any(char::is_control))
        {
            return Err(invalid());
        }
    }
    let mut identities = std::collections::HashSet::new();
    for a in tree.agents.iter().flatten() {
        if !identities.insert((&a.terminal_id, &a.pane_id))
            || text(&a.terminal_id, 256).is_err()
            || !status(&a.agent_status)
            || !panes.get(a.pane_id.as_str()).is_some_and(|p| {
                p.terminal_id.as_deref() == Some(a.terminal_id.as_str())
                    && p.tab_id == a.tab_id
                    && p.workspace_id == a.workspace_id
            })
            || a.agent.as_ref().is_some_and(|v| text(v, 200).is_err())
            || a.name.as_ref().is_some_and(|v| text(v, 64).is_err())
        {
            return Err(invalid());
        }
    }
    for agent in tree.agents.iter_mut().flatten() {
        if agent
            .agent_session
            .as_ref()
            .is_some_and(|r| agent.agent.as_deref() != Some(r.agent.as_str()))
        {
            agent.agent_session = None;
        }
    }
    Ok(tree)
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum HerdrAction {
    CreateWorkspace {
        label: String,
        directory: String,
    },
    RenameWorkspace {
        target: String,
        label: String,
    },
    FocusWorkspace {
        target: String,
    },
    CreateTab {
        workspace: String,
        label: String,
        directory: String,
    },
    RenameTab {
        target: String,
        label: String,
    },
    FocusTab {
        target: String,
    },
    FocusPane {
        target: String,
    },
    FocusAgent {
        target: String,
    },
    SplitPane {
        target: String,
        horizontal: bool,
        directory: String,
    },
    ZoomPane {
        target: String,
    },
}
fn action_command(session: &str, action: &HerdrAction) -> Result<String> {
    let text_arg = |value: &str, max| -> Result<String> {
        text(value, max)?;
        Ok(quote(value))
    };
    let args = match action {
        HerdrAction::CreateWorkspace { label, directory } => format!(
            "workspace create --no-focus --label {} --cwd {}",
            text_arg(label, 200)?,
            text_arg(directory, 4096)?
        ),
        HerdrAction::RenameWorkspace {
            target: value,
            label,
        } => {
            target(value, None)?;
            format!(
                "workspace rename {} {}",
                quote(value),
                text_arg(label, 200)?
            )
        }
        HerdrAction::FocusWorkspace { target: value } => {
            target(value, None)?;
            format!("workspace focus {}", quote(value))
        }
        HerdrAction::CreateTab {
            workspace,
            label,
            directory,
        } => {
            target(workspace, None)?;
            format!(
                "tab create --no-focus --workspace {} --label {} --cwd {}",
                quote(workspace),
                text_arg(label, 200)?,
                text_arg(directory, 4096)?
            )
        }
        HerdrAction::RenameTab {
            target: value,
            label,
        } => {
            target(value, Some('t'))?;
            format!("tab rename {} {}", quote(value), text_arg(label, 200)?)
        }
        HerdrAction::FocusTab { target: value } => {
            target(value, Some('t'))?;
            format!("tab focus {}", quote(value))
        }
        HerdrAction::FocusPane { target: value } => {
            target(value, Some('p'))?;
            text(session, 200)?;
            return Ok(format!(
                "lazysh-agent herdr-focus-pane --session {} --pane {}",
                quote(session),
                quote(value)
            ));
        }
        HerdrAction::FocusAgent { target: value } => {
            target(value, Some('p'))?;
            format!("agent focus {}", quote(value))
        }
        HerdrAction::SplitPane {
            target: value,
            horizontal,
            directory,
        } => {
            target(value, Some('p'))?;
            format!(
                "pane split --pane {} --direction {} --cwd {} --no-focus",
                quote(value),
                if *horizontal { "right" } else { "down" },
                text_arg(directory, 4096)?
            )
        }
        HerdrAction::ZoomPane { target: value } => {
            target(value, Some('p'))?;
            format!("pane zoom --pane {} --toggle", quote(value))
        }
    };
    command(session, args)
}
/// Herdr reports a stale exact target as one JSON error line on stderr. Both
/// 0.9.3 and 0.9.5 use these codes; 0.9.4+ also returns them for out-of-range
/// workspace numbers instead of crashing the server. Exact pane focus goes
/// through the companion, which reports Herdr's `pane_not_found` as its own class.
fn missing_target(error: SshError) -> SshError {
    #[derive(Deserialize)]
    struct Failure {
        error: Code,
    }
    #[derive(Deserialize)]
    struct Code {
        code: String,
    }
    let missing = error.kind() == "remote_command_failed"
        && (error.message() == "lazysh-agent: HerdrFocusMissing: operation failed"
            || serde_json::from_str::<Failure>(error.message()).is_ok_and(|failure| {
                matches!(
                    failure.error.code.as_str(),
                    "workspace_not_found" | "tab_not_found" | "pane_not_found" | "agent_not_found"
                )
            }));
    if missing {
        SshError::new(
            "herdr_target_missing",
            "The Herdr workspace, tab or pane no longer exists",
        )
    } else {
        error
    }
}
#[tauri::command]
pub async fn herdr_tree(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    access: AccessLease,
) -> crate::ssh::AccessResult<HerdrTree> {
    access
        .run(async {
            let command = command(&name, "api snapshot".into())?;
            let session = state.session(&session_id).await?;
            let command = crate::herdr_path::select(
                &command,
                crate::herdr_path::admit(&session, &access).await?,
            );
            parse(&crate::ssh::exec_for_access(&session, command, &access).await?)
        })
        .await
}
#[tauri::command]
pub async fn herdr_action(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    action: HerdrAction,
    access: AccessLease,
) -> crate::ssh::AccessResult<()> {
    access
        .run(async {
            let command = action_command(&name, &action)?;
            let session = state.session(&session_id).await?;
            let pane = match &action {
                HerdrAction::FocusPane { target } => Some(target.as_str()),
                _ => None,
            };
            let command = if pane.is_some() {
                crate::companion::required_command(&session, command, "lazysh-herdr-companion-required", &access).await?
            } else {
                command
            };
            let command = crate::herdr_path::select(&command, crate::herdr_path::admit(&session, &access).await?);
            let focus = matches!(
                action,
                HerdrAction::FocusWorkspace { .. }
                    | HerdrAction::FocusTab { .. }
                    | HerdrAction::FocusPane { .. }
                    | HerdrAction::FocusAgent { .. }
            );
            let retained = if focus {
                crate::herdr_guard::retire_for_view(&session, &access)
                    .await?
                    .map(|permit| permit as std::sync::Arc<dyn Send + Sync>)
            } else {
                None
            };
            let output = crate::ssh::exec_bounded(
                &session,
                command,
                &access,
                crate::ssh::OP_TIMEOUT,
                crate::ssh::FILE_LIMIT as usize,
                retained,
            )
            .await
            .map_err(missing_target)?;
            if let Some(pane) = pane {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Focused {
                    schema_version: u8,
                    status: String,
                    pane_id: String,
                }
                if output.trim()=="lazysh-herdr-companion-required" {return Err(SshError::new("herdr_focus_companion_required","Install or update the companion from Agents for exact Herdr pane navigation"));}
                let reply: Focused = serde_json::from_str(&output)?;
                if reply.schema_version != 1 || reply.status != "focused" || reply.pane_id != pane {
                    return Err(SshError::new(
                        "invalid_output",
                        "Invalid exact Herdr focus reply",
                    ));
                }
            }
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reported_snapshot() -> serde_json::Value {
        serde_json::json!({"result":{"type":"session_snapshot","snapshot":{
            "workspaces":[{"workspace_id":"w1","label":"Owned","focused":true,"agent_status":"working"}],
            "tabs":[{"workspace_id":"w1","tab_id":"w1:t2","label":"Agent","number":1,"focused":true,"agent_status":"working"}],
            "panes":[{"workspace_id":"w1","tab_id":"w1:t2","pane_id":"w1:p3","terminal_id":"terminal-3","focused":true,"agent_status":"working"}],
            "agents":[{"terminal_id":"terminal-3","workspace_id":"w1","tab_id":"w1:t2","pane_id":"w1:p3","agent":"codex","name":null,"agent_status":"working"}]
        }}})
    }
    #[test]
    fn projects_reported_agents_without_fabricating_events_or_retaining_private_fields() {
        for status in ["idle", "working", "blocked", "done", "unknown"] {
            let mut source = reported_snapshot();
            let agent = &mut source["result"]["snapshot"]["agents"][0];
            agent["agent_status"] = status.into();
            for key in [
                "tokens",
                "state_labels",
                "agent_session",
                "title",
                "terminal_title",
                "display_agent",
            ] {
                agent[key] = serde_json::json!({"private":"not retained"});
            }
            let tree = parse(&source.to_string()).unwrap();
            assert_eq!(tree.agents.as_ref().unwrap()[0].agent_status, status);
            let projected = serde_json::to_value(&tree.agents.as_ref().unwrap()[0]).unwrap();
            assert_eq!(
                projected,
                serde_json::json!({"terminal_id":"terminal-3","workspace_id":"w1","tab_id":"w1:t2","pane_id":"w1:p3","agent":"codex","name":null,"agent_status":status})
            );
            assert!(!serde_json::to_string(&tree)
                .unwrap()
                .contains("not retained"));
        }
    }
    #[test]
    fn projects_only_closed_id_references_and_discards_paths_or_conflicts() {
        for provider in ["codex", "claude", "opencode"] {
            let mut source = reported_snapshot();
            let agent = &mut source["result"]["snapshot"]["agents"][0];
            agent["agent"] = provider.into();
            let reference = serde_json::json!({"source":format!("herdr:{provider}"),"agent":provider,"kind":"id","value":"ID_a-2"});
            agent["agent_session"] = reference.clone();
            agent["agent_session"]["private"] = "discard".into();
            let tree = parse(&source.to_string()).unwrap();
            assert_eq!(
                serde_json::to_value(&tree.agents.as_ref().unwrap()[0].agent_session).unwrap(),
                reference
            );
            for change in [
                serde_json::json!({"kind":"path"}),
                serde_json::json!({"value":"/private/file"}),
                serde_json::json!({"value":"a".repeat(257)}),
                serde_json::json!({"value":"é"}),
                serde_json::json!({"value":""}),
                serde_json::json!({"agent":"other"}),
                serde_json::json!({"source":"private"}),
            ] {
                let mut invalid = source.clone();
                let raw = &mut invalid["result"]["snapshot"]["agents"][0]["agent_session"];
                for (key, value) in change.as_object().unwrap() {
                    raw[key] = value.clone();
                }
                let tree = parse(&invalid.to_string()).unwrap();
                assert!(tree.agents.as_ref().unwrap()[0].agent_session.is_none());
                assert!(!serde_json::to_string(&tree).unwrap().contains("discard"));
            }
            source["result"]["snapshot"]["agents"][0]["agent"] = "other".into();
            assert!(parse(&source.to_string()).unwrap().agents.unwrap()[0]
                .agent_session
                .is_none());
        }
    }
    #[test]
    fn accepts_herdr_public_alphabet_in_snapshots_and_exact_action_targets() {
        for suffix in [
            "Z",
            "2E",
            "2N",
            "C",
            "F",
            "123456789ABCDEFG",
            "HJKMNPQRSTVWXYZ0",
        ] {
            let workspace = format!("w{suffix}");
            let tab = format!("{workspace}:t{suffix}");
            let pane = format!("{workspace}:p{suffix}");
            let mut source = reported_snapshot();
            let snapshot = &mut source["result"]["snapshot"];
            for collection in ["workspaces", "tabs", "panes", "agents"] {
                snapshot[collection][0]["workspace_id"] = workspace.clone().into();
                if collection != "workspaces" {
                    snapshot[collection][0]["tab_id"] = tab.clone().into();
                }
                if matches!(collection, "panes" | "agents") {
                    snapshot[collection][0]["pane_id"] = pane.clone().into();
                }
            }
            let tree = parse(&source.to_string()).unwrap();
            assert_eq!(tree.agents.unwrap()[0].pane_id, pane);
            assert!(target(&workspace, None).is_ok());
            assert!(target(&tab, Some('t')).is_ok());
            assert_eq!(
                action_command(
                    "owned",
                    &HerdrAction::FocusPane {
                        target: pane.clone()
                    }
                )
                .unwrap(),
                format!("lazysh-agent herdr-focus-pane --session 'owned' --pane '{pane}'")
            );
            assert_eq!(
                action_command(
                    "owned",
                    &HerdrAction::FocusAgent {
                        target: pane.clone()
                    }
                )
                .unwrap(),
                format!("herdr --session 'owned' agent focus '{pane}'")
            );
        }
        for suffix in ["I", "L", "O", "U", "a", "é", "-", "_", "1;id", "1:2", ""] {
            assert!(target(&format!("w{suffix}"), None).is_err());
            assert!(target(&format!("w1:p{suffix}"), Some('p')).is_err());
        }
    }
    #[test]
    fn accepts_legacy_snapshots_and_absent_null_or_known_directories() {
        let mut legacy = reported_snapshot();
        legacy["result"]["snapshot"]
            .as_object_mut()
            .unwrap()
            .remove("agents");
        legacy["result"]["snapshot"]["panes"][0]
            .as_object_mut()
            .unwrap()
            .remove("terminal_id");
        let tree = parse(&legacy.to_string()).unwrap();
        assert!(tree.agents.is_none());
        assert!(serde_json::to_value(&tree).unwrap().get("agents").is_none());
        let mut empty = reported_snapshot();
        empty["result"]["snapshot"]["agents"] = serde_json::json!([]);
        let projected = serde_json::to_value(parse(&empty.to_string()).unwrap()).unwrap();
        assert_eq!(projected["agents"], serde_json::json!([]));
        for directory in [
            None,
            Some(serde_json::Value::Null),
            Some(serde_json::json!("/owned/project")),
        ] {
            let mut source = reported_snapshot();
            if let Some(value) = directory.clone() {
                source["result"]["snapshot"]["panes"][0]["cwd"] = value;
            }
            let tree = parse(&source.to_string()).unwrap();
            assert_eq!(
                tree.panes[0].cwd.as_deref(),
                directory.as_ref().and_then(|value| value.as_str())
            );
        }
    }
    #[test]
    fn rejects_inconsistent_agent_and_parent_identity_or_unbounded_metadata() {
        for (path, value) in [
            (
                "/result/snapshot/agents/0/agent_status",
                serde_json::json!("needs_attention"),
            ),
            (
                "/result/snapshot/agents/0/terminal_id",
                serde_json::json!("different-terminal"),
            ),
            (
                "/result/snapshot/agents/0/pane_id",
                serde_json::json!("w1:p99"),
            ),
            (
                "/result/snapshot/agents/0/workspace_id",
                serde_json::json!("w2"),
            ),
            (
                "/result/snapshot/agents/0/tab_id",
                serde_json::json!("w1:t99"),
            ),
            (
                "/result/snapshot/agents/0/agent",
                serde_json::json!("x".repeat(201)),
            ),
            (
                "/result/snapshot/agents/0/name",
                serde_json::json!("x".repeat(65)),
            ),
            (
                "/result/snapshot/agents/0/terminal_id",
                serde_json::json!("x".repeat(257)),
            ),
            (
                "/result/snapshot/agents/0/terminal_id",
                serde_json::json!("terminal\n3"),
            ),
            (
                "/result/snapshot/tabs/0/workspace_id",
                serde_json::json!("w2"),
            ),
            (
                "/result/snapshot/panes/0/tab_id",
                serde_json::json!("w1:t99"),
            ),
        ] {
            let mut source = reported_snapshot();
            *source.pointer_mut(path).unwrap() = value;
            assert!(parse(&source.to_string()).is_err(), "accepted {path}");
        }
        let mut source = reported_snapshot();
        source["result"]["snapshot"]["panes"][0]
            .as_object_mut()
            .unwrap()
            .remove("terminal_id");
        assert!(
            parse(&source.to_string()).is_err(),
            "agent without matching terminal"
        );
    }
    #[test]
    fn rejects_duplicate_tree_identities_and_excess_collection_counts() {
        for key in ["workspaces", "tabs", "panes", "agents"] {
            let mut source = reported_snapshot();
            let rows = source["result"]["snapshot"][key].as_array_mut().unwrap();
            rows.push(rows[0].clone());
            assert!(parse(&source.to_string()).is_err(), "duplicate {key}");
        }
        for (key, count) in [
            ("workspaces", 1001),
            ("tabs", 2001),
            ("panes", 4097),
            ("agents", 4097),
        ] {
            let mut source = reported_snapshot();
            let rows = source["result"]["snapshot"][key].as_array_mut().unwrap();
            rows.resize(count, rows[0].clone());
            assert_eq!(
                parse(&source.to_string()).unwrap_err().kind(),
                "output_too_large",
                "{key}"
            );
        }
    }
    /// One isolated stock Herdr server; `bin` precedes PATH for pane programs.
    struct RealHerdr {
        temp: tempfile::TempDir,
        server: std::process::Child,
    }
    impl RealHerdr {
        fn start() -> Self {
            let temp = tempfile::tempdir().unwrap();
            std::fs::create_dir(temp.path().join("bin")).unwrap();
            // Pin the built-in detection rules; never fetch a newer catalog.
            std::fs::write(
                temp.path().join("config.toml"),
                "[update]\nversion_check = false\nmanifest_check = false\n",
            )
            .unwrap();
            let mut server = Self::configured(temp.path(), "herdr");
            let server = server
                .arg("server")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let herdr = Self { temp, server };
            let ready = (0..100).any(|_| {
                let ready = herdr
                    .command("herdr")
                    .args(["api", "snapshot"])
                    .output()
                    .unwrap()
                    .status
                    .success();
                if !ready {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                ready
            });
            assert!(ready, "isolated Herdr server did not become ready");
            herdr
        }
        fn configured(home: &std::path::Path, program: &str) -> std::process::Command {
            let mut command = std::process::Command::new(program);
            let path = std::env::join_paths(std::iter::once(home.join("bin")).chain(
                std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
            ))
            .unwrap();
            command
                .env("HOME", home)
                .env("ZDOTDIR", home)
                .env("SHELL", "/bin/sh")
                .env("PATH", path)
                .env_remove("ENV")
                .env_remove("BASH_ENV")
                .current_dir(home)
                .env("XDG_CONFIG_HOME", home)
                .env("HERDR_CONFIG_PATH", home.join("config.toml"))
                .env_remove("HERDR_SOCKET_PATH")
                .env_remove("HERDR_SESSION");
            command
        }
        fn command(&self, program: &str) -> std::process::Command {
            Self::configured(self.temp.path(), program)
        }
        fn run(&self, text: String) -> String {
            lazysh_common::test_support::successful_output(self.command("sh").arg("-c").arg(text))
        }
        fn path(&self) -> &std::path::Path {
            self.temp.path()
        }
    }
    impl Drop for RealHerdr {
        fn drop(&mut self) {
            let _ = self.server.kill();
            let _ = self.server.wait();
        }
    }
    #[test]
    #[ignore = "requires herdr on PATH and current-source LAZYSH_TEST_AGENT_BIN; runs an isolated headless server"]
    fn real_herdr_lifecycle_and_tree() {
        let herdr = RealHerdr::start();
        let temp = herdr.path();
        // Exact pane focus runs the companion from the owned `bin` that precedes PATH.
        std::fs::copy(
            std::env::var_os("LAZYSH_TEST_AGENT_BIN")
                .expect("LAZYSH_TEST_AGENT_BIN must name a current-source companion"),
            temp.join("bin").join("lazysh-agent"),
        )
        .unwrap();
        let run = |text: String| herdr.run(text);
        let session = "default";
        run(action_command(
            session,
            &HerdrAction::CreateWorkspace {
                label: "owned".into(),
                directory: temp.to_str().unwrap().into(),
            },
        )
        .unwrap());
        let snapshot = || parse(&run(command(session, "api snapshot".into()).unwrap())).unwrap();
        let tree = snapshot();
        let workspace = tree.workspaces[0].workspace_id.clone();
        let pane = tree.panes[0].pane_id.clone();
        let terminal = tree.panes[0].terminal_id.clone().unwrap();
        let tab = tree.panes[0].tab_id.clone();
        run(command(
            session,
            format!(
                "pane report-agent --source lazysh-test --agent codex --state blocked {}",
                quote(&pane)
            ),
        )
        .unwrap());
        let reported = snapshot();
        let agents = reported.agents.as_ref().unwrap();
        assert_eq!(agents.len(), 1);
        let agent = &agents[0];
        assert_eq!(agent.agent.as_deref(), Some("codex"));
        assert_eq!(agent.agent_status, "blocked");
        assert_eq!(agent.terminal_id, terminal);
        assert_eq!(agent.workspace_id, workspace);
        assert_eq!(agent.tab_id, tab);
        assert_eq!(agent.pane_id, pane);
        run(command(
            session,
            format!("pane report-agent-session {} --source herdr:codex --agent codex --agent-session-id lazysh-owned-634", quote(&pane)),
        ).unwrap());
        let referenced = snapshot();
        let projected = referenced
            .agents
            .as_ref()
            .unwrap()
            .iter()
            .find(|agent| agent.pane_id == pane && agent.terminal_id == terminal)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&projected.agent_session).unwrap(),
            serde_json::json!({"source":"herdr:codex","agent":"codex","kind":"id","value":"lazysh-owned-634"})
        );
        run(action_command(
            session,
            &HerdrAction::FocusAgent {
                target: pane.clone(),
            },
        )
        .unwrap());
        run(action_command(
            session,
            &HerdrAction::ZoomPane {
                target: pane.clone(),
            },
        )
        .unwrap());
        run(action_command(
            session,
            &HerdrAction::SplitPane {
                target: pane,
                horizontal: true,
                directory: temp.to_str().unwrap().into(),
            },
        )
        .unwrap());
        run(action_command(
            session,
            &HerdrAction::RenameWorkspace {
                target: workspace.clone(),
                label: "literal'$(touch nope)".into(),
            },
        )
        .unwrap());
        run(action_command(
            session,
            &HerdrAction::CreateTab {
                workspace: workspace.clone(),
                label: "tab".into(),
                directory: temp.to_str().unwrap().into(),
            },
        )
        .unwrap());
        let tree = snapshot();
        assert_eq!(tree.workspaces[0].label, "literal'$(touch nope)");
        assert_eq!(tree.tabs.len(), 2);
        assert_eq!(tree.panes.len(), 3);
        let tab = tree.tabs[1].tab_id.clone();
        run(action_command(
            session,
            &HerdrAction::RenameTab {
                target: tab.clone(),
                label: "second".into(),
            },
        )
        .unwrap());
        run(action_command(session, &HerdrAction::FocusTab { target: tab }).unwrap());
        run(action_command(session, &HerdrAction::FocusWorkspace { target: workspace }).unwrap());
        run(action_command(
            session,
            &HerdrAction::CreateWorkspace {
                label: "new workspace".into(),
                directory: temp.to_str().unwrap().into(),
            },
        )
        .unwrap());
        let tree = snapshot();
        assert_eq!(tree.workspaces.len(), 2);
        // Stale exact targets fail as one recognizable error and the server survives.
        let gone = |kind: char| format!("{}:{kind}999", tree.workspaces[0].workspace_id);
        for action in [
            HerdrAction::FocusWorkspace {
                target: "w999".into(),
            },
            HerdrAction::FocusTab { target: gone('t') },
            HerdrAction::FocusPane { target: gone('p') },
            HerdrAction::FocusAgent { target: gone('p') },
            HerdrAction::ZoomPane { target: gone('p') },
        ] {
            let output = herdr
                .command("sh")
                .arg("-c")
                .arg(action_command(session, &action).unwrap())
                .output()
                .unwrap();
            assert!(!output.status.success());
            let failure = SshError::new(
                "remote_command_failed",
                String::from_utf8(output.stderr).unwrap().trim(),
            );
            assert_eq!(missing_target(failure).kind(), "herdr_target_missing");
        }
        assert_eq!(snapshot().workspaces.len(), 2);
        run(command(session, "server stop".into()).unwrap());
    }
    // The fake `codex` is a POSIX shell script made executable with a Unix mode.
    #[cfg(unix)]
    #[test]
    #[ignore = "requires herdr on PATH; runs an isolated headless server"]
    fn real_herdr_codex_state_is_detected_and_an_idle_prompt_matches_the_version() {
        use std::os::unix::fs::PermissionsExt;
        let herdr = RealHerdr::start();
        let home = herdr.path();
        // A process named `codex` repaints controlled screen and title text, so
        // stock Herdr applies its own Codex detection rules to a known terminal.
        let script = home.join("bin/codex");
        std::fs::write(
            &script,
            "#!/bin/sh\nlast=\nwhile :; do b=$(cat \"$HOME/body\" 2>/dev/null); \
             if [ \"$b\" != \"$last\" ]; then printf '\\033[2J\\033[H%s\\n' \"$b\"; last=$b; fi; \
             printf '\\033]0;%s\\007' \"$(cat \"$HOME/title\" 2>/dev/null)\"; sleep 0.1; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let paint = |body: &str, title: &str| {
            for (name, text) in [("body", body), ("title", title)] {
                let staged = home.join(format!("{name}.next"));
                std::fs::write(&staged, text).unwrap();
                std::fs::rename(staged, home.join(name)).unwrap();
            }
        };
        paint("\u{203a} ", "");
        let session = "default";
        herdr.run(
            action_command(
                session,
                &HerdrAction::CreateWorkspace {
                    label: "codex".into(),
                    directory: home.to_str().unwrap().into(),
                },
            )
            .unwrap(),
        );
        let snapshot =
            || parse(&herdr.run(command(session, "api snapshot".into()).unwrap())).unwrap();
        let tree = snapshot();
        let workspace = &tree
            .workspaces
            .iter()
            .find(|w| w.label == "codex")
            .unwrap()
            .workspace_id;
        let pane = tree
            .panes
            .iter()
            .find(|p| &p.workspace_id == workspace)
            .unwrap()
            .pane_id
            .clone();
        herdr.run(command(session, format!("pane run {} codex", quote(&pane))).unwrap());
        let expect = |status: &str| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                let tree = snapshot();
                let agent =
                    tree.agents.unwrap().into_iter().find(|agent| {
                        agent.pane_id == pane && agent.agent.as_deref() == Some("codex")
                    });
                if let Some(agent) = agent.filter(|agent| agent.agent_status == status) {
                    let pane = tree
                        .panes
                        .iter()
                        .find(|p| p.pane_id == agent.pane_id)
                        .unwrap();
                    assert_eq!(pane.agent_status, status);
                    return agent;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "Herdr never reported {status} for the codex pane"
                );
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        };
        // Herdr 0.9.3 has no idle rule for an idle Codex prompt and reports
        // Unknown; 0.9.4 and later settle the same prompt to Idle.
        let version = herdr.run("herdr --version".into());
        let idle = if version.trim() == "herdr 0.9.3" {
            "unknown"
        } else {
            "idle"
        };
        expect(idle);
        paint(
            "\u{2022} Working (12s \u{2022} esc to interrupt)\n\n\u{203a} ",
            "",
        );
        expect("working");
        paint("\u{203a} ", "Action Required");
        expect("blocked");
        paint("\u{203a} ", "");
        expect(idle);
        // Herdr's own Codex session report is the exact pane context the client
        // joins with a companion lifecycle report; it never changes Herdr's state.
        herdr.run(
            command(
                session,
                format!(
                    "pane report-agent-session {} --source herdr:codex --agent codex --agent-session-id lazysh-owned-990",
                    quote(&pane)
                ),
            )
            .unwrap(),
        );
        let agent = expect(idle);
        assert_eq!(
            serde_json::to_value(&agent.agent_session).unwrap(),
            serde_json::json!({"source":"herdr:codex","agent":"codex","kind":"id","value":"lazysh-owned-990"})
        );
        herdr.run(command(session, "server stop".into()).unwrap());
    }
    #[test]
    fn maps_only_herdr_missing_target_failures() {
        let failed = |message: &str| SshError::new("remote_command_failed", message);
        for code in [
            "workspace_not_found",
            "tab_not_found",
            "pane_not_found",
            "agent_not_found",
        ] {
            let message = format!(
                r#"{{"error":{{"code":"{code}","message":"gone"}},"id":"cli:workspace:focus"}}"#
            );
            assert_eq!(
                missing_target(failed(&message)).kind(),
                "herdr_target_missing"
            );
        }
        assert_eq!(
            missing_target(failed("lazysh-agent: HerdrFocusMissing: operation failed")).kind(),
            "herdr_target_missing"
        );
        for kept in [
            failed("lazysh-agent: HerdrFocusInvalid: operation failed"),
            failed(r#"{"error":{"code":"server_unavailable","message":"x"},"id":"cli"}"#),
            failed("workspace_not_found"),
            SshError::new(
                "timeout",
                r#"{"error":{"code":"workspace_not_found","message":"x"}}"#,
            ),
        ] {
            let kind = kept.kind();
            assert_eq!(missing_target(kept).kind(), kind);
        }
    }
    #[test]
    fn rejects_nonexact_targets_and_quotes_session_and_labels() {
        assert!(action_command(
            "test",
            &HerdrAction::FocusAgent {
                target: "w1:p2 --current".into()
            }
        )
        .is_err());
        assert!(action_command(
            "test",
            &HerdrAction::FocusAgent {
                target: "w1:t2".into()
            }
        )
        .is_err());
        assert_eq!(
            action_command(
                "a'$(echo x)",
                &HerdrAction::RenameTab {
                    target: "w1:t2".into(),
                    label: "a;$(echo x)".into()
                }
            )
            .unwrap(),
            "herdr --session 'a'\\''$(echo x)' tab rename 'w1:t2' 'a;$(echo x)'"
        );
    }
}
