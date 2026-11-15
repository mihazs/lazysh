use crate::app_lock::AccessLease;
use crate::host::{Cmd, Host};
use crate::local::LocalState;
use crate::ssh::{quote, AppState, Result, SshError, FILE_LIMIT, OP_TIMEOUT};
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
/// `herdr --session <session> <args…>` as argv: the remote arm renders it into one command
/// line, the local arm runs it directly, so no label or path is ever shell syntax.
fn command(session: &str, args: &[&str]) -> Result<Cmd> {
    text(session, 200)?;
    let mut argv = vec!["herdr", "--session", session];
    argv.extend(args);
    Ok(Cmd::new(&[], &argv).herdr())
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
    CloseTab {
        target: String,
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
/// The command an action runs; exact pane focus is the one action that is a companion
/// command (`lazysh-agent`) and not a Herdr one.
fn action_command(session: &str, action: &HerdrAction) -> Result<Cmd> {
    match action {
        HerdrAction::CreateWorkspace { label, directory } => {
            text(label, 200)?;
            text(directory, 4096)?;
            command(
                session,
                &[
                    "workspace",
                    "create",
                    "--no-focus",
                    "--label",
                    label,
                    "--cwd",
                    directory,
                ],
            )
        }
        HerdrAction::RenameWorkspace {
            target: value,
            label,
        } => {
            target(value, None)?;
            text(label, 200)?;
            command(session, &["workspace", "rename", value, label])
        }
        HerdrAction::FocusWorkspace { target: value } => {
            target(value, None)?;
            command(session, &["workspace", "focus", value])
        }
        HerdrAction::CreateTab {
            workspace,
            label,
            directory,
        } => {
            target(workspace, None)?;
            text(label, 200)?;
            text(directory, 4096)?;
            command(
                session,
                &[
                    "tab",
                    "create",
                    "--no-focus",
                    "--workspace",
                    workspace,
                    "--label",
                    label,
                    "--cwd",
                    directory,
                ],
            )
        }
        HerdrAction::RenameTab {
            target: value,
            label,
        } => {
            target(value, Some('t'))?;
            text(label, 200)?;
            command(session, &["tab", "rename", value, label])
        }
        HerdrAction::CloseTab { target: value } => {
            target(value, Some('t'))?;
            command(session, &["tab", "close", value])
        }
        HerdrAction::FocusTab { target: value } => {
            target(value, Some('t'))?;
            command(session, &["tab", "focus", value])
        }
        HerdrAction::FocusPane { target: value } => {
            target(value, Some('p'))?;
            text(session, 200)?;
            Ok(Cmd::new(
                &[],
                &[
                    "lazysh-agent",
                    "herdr-focus-pane",
                    "--session",
                    session,
                    "--pane",
                    value,
                ],
            ))
        }
        HerdrAction::FocusAgent { target: value } => {
            target(value, Some('p'))?;
            command(session, &["agent", "focus", value])
        }
        HerdrAction::SplitPane {
            target: value,
            horizontal,
            directory,
        } => {
            target(value, Some('p'))?;
            text(directory, 4096)?;
            command(
                session,
                &[
                    "pane",
                    "split",
                    "--pane",
                    value,
                    "--direction",
                    if *horizontal { "right" } else { "down" },
                    "--cwd",
                    directory,
                    "--no-focus",
                ],
            )
        }
        HerdrAction::ZoomPane { target: value } => {
            target(value, Some('p'))?;
            command(session, &["pane", "zoom", "--pane", value, "--toggle"])
        }
    }
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

async fn read_tree(host: &Host, name: &str, access: &AccessLease) -> Result<HerdrTree> {
    parse(
        &host
            .run(access, &command(name, &["api", "snapshot"])?)
            .await?,
    )
}

fn selected_agent(tree: &HerdrTree, pane: &str, terminal: &str, agent: &str, id: &str) -> bool {
    let Some(rows) = tree.agents.as_ref() else {
        return false;
    };
    let matches: Vec<_> = rows
        .iter()
        .filter(|row| {
            row.agent_session
                .as_ref()
                .is_some_and(|reference| reference.agent == agent && reference.value == id)
        })
        .collect();
    matches.len() == 1
        && matches[0].pane_id == pane
        && matches[0].terminal_id == terminal
        && matches[0].agent.as_deref() == Some(agent)
}

/// Printed instead of a page when the host companion predates `herdr-conversation`.
const CONVERSATION_COMPANION_REQUIRED: &str = "lazysh-herdr-conversation-companion-required";

fn conversation_page(raw: &str, agent: &str) -> Result<serde_json::Value> {
    if raw.trim() == CONVERSATION_COMPANION_REQUIRED {
        return Err(SshError::new(
            "herdr_conversation_companion_required",
            "Update the companion to read this agent conversation",
        ));
    }
    let page: serde_json::Value = serde_json::from_str(raw)?;
    if page["schemaVersion"] != 1 || page["view"] != "active_branch" || page["agent"] != agent {
        return Err(SshError::new(
            "invalid_output",
            "Invalid agent conversation",
        ));
    }
    Ok(page)
}

/// Fails unless the live Herdr tree still names this pane's one agent session.
pub(crate) async fn check_selected(
    session: &crate::ssh::Session,
    name: &str,
    pane: &str,
    terminal: &str,
    agent: &str,
    id: &str,
    access: &AccessLease,
) -> Result<()> {
    target(pane, Some('p'))?;
    text(terminal, 256)?;
    let tree = parse(
        &command(name, &["api", "snapshot"])?
            .exec_ssh(session, access, OP_TIMEOUT, FILE_LIMIT as usize)
            .await?,
    )?;
    if selected_agent(&tree, pane, terminal, agent, id) {
        return Ok(());
    }
    Err(SshError::new(
        "herdr_target_missing",
        "The selected agent session is no longer available",
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HerdrConversationTarget {
    herdr_session: String,
    pane_id: String,
    terminal_id: String,
    agent: String,
    agent_session_id: String,
    window: Option<crate::ssh::TranscriptWindow>,
}

#[tauri::command]
pub async fn agent_herdr_conversation(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    target: HerdrConversationTarget,
    access: AccessLease,
) -> crate::ssh::AccessResult<serde_json::Value> {
    let HerdrConversationTarget {
        herdr_session,
        pane_id,
        terminal_id,
        agent,
        agent_session_id,
        window,
    } = target;
    access
        .run(async {
            self::target(&pane_id, Some('p'))?;
            text(&terminal_id, 256)?;
            if !matches!(agent.as_str(), "claude" | "codex")
                || uuid::Uuid::parse_str(&agent_session_id)
                    .ok()
                    .is_none_or(|id| id.to_string() != agent_session_id)
            {
                return Err(SshError::new(
                    "invalid_input",
                    "Invalid agent session reference",
                ));
            }
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            let command = format!(
                "lazysh-agent herdr-conversation --agent {} --session-id {}",
                quote(&agent),
                quote(&agent_session_id)
            ) + &window.unwrap_or_default().flags()?;
            // The check of the pane and the read of the conversation do not depend on each other, so they overlap; what the
            // check found still decides first, and the tree is read again after the conversation (below).
            let (before, raw) = tokio::join!(
                read_tree(&host, &herdr_session, &access),
                host.companion_required(&access, command, CONVERSATION_COMPANION_REQUIRED)
            );
            if !selected_agent(&before?, &pane_id, &terminal_id, &agent, &agent_session_id) {
                return Err(SshError::new(
                    "herdr_target_missing",
                    "The selected agent session is no longer available",
                ));
            }
            let raw = raw?;
            let page = conversation_page(&raw, &agent)?;
            let after = read_tree(&host, &herdr_session, &access).await?;
            // A local session cannot be swapped for another one under the same id; closing it cancels the read.
            let same_session = match &host {
                Host::Remote(session) => {
                    std::sync::Arc::ptr_eq(session, &state.session(&session_id).await?)
                }
                #[cfg(desktop)]
                Host::Local(_) => true,
            };
            if !selected_agent(&after, &pane_id, &terminal_id, &agent, &agent_session_id)
                || !same_session
            {
                return Err(SshError::new(
                    "herdr_target_missing",
                    "The selected agent session changed",
                ));
            }
            Ok(page)
        })
        .await
}
#[tauri::command]
pub async fn herdr_tree(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    name: String,
    access: AccessLease,
) -> crate::ssh::AccessResult<HerdrTree> {
    access
        .run(async {
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            read_tree(&host, &name, &access).await
        })
        .await
}
/// Printed instead of the focus reply when the host companion predates `herdr-focus-pane`.
const FOCUS_COMPANION_REQUIRED: &str = "lazysh-herdr-companion-required";

#[tauri::command]
pub async fn herdr_action(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    name: String,
    action: HerdrAction,
    access: AccessLease,
) -> crate::ssh::AccessResult<()> {
    access
        .run(async {
            let cmd = action_command(&name, &action)?;
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            let pane = match &action {
                HerdrAction::FocusPane { target } => Some(target.as_str()),
                _ => None,
            };
            let output = match &host {
                Host::Remote(session) => {
                    let command = cmd.render();
                    let command = if pane.is_some() {
                        crate::companion::required_command(session, command, FOCUS_COMPANION_REQUIRED, &access).await?
                    } else {
                        command
                    };
                    let command = crate::herdr_path::select(&command, crate::herdr_path::admit(session, &access).await?);
                    // Closing a tab moves the view like a focus does, so the input turn bound to the old view is retired first.
                    let moves_view = matches!(
                        action,
                        HerdrAction::FocusWorkspace { .. }
                            | HerdrAction::FocusTab { .. }
                            | HerdrAction::FocusPane { .. }
                            | HerdrAction::FocusAgent { .. }
                            | HerdrAction::CloseTab { .. }
                    );
                    let retained = if moves_view {
                        crate::herdr_guard::retire_for_view(session, &access)
                            .await?
                            .map(|permit| permit as std::sync::Arc<dyn Send + Sync>)
                    } else {
                        None
                    };
                    crate::ssh::exec_bounded(session, command, &access, OP_TIMEOUT, FILE_LIMIT as usize, retained).await
                }
                // No input guard is bound to a local session yet, so a view change has no turn to retire.
                #[cfg(desktop)]
                Host::Local(_) if pane.is_some() => {
                    host.companion_required(&access, cmd.render(), FOCUS_COMPANION_REQUIRED).await
                }
                #[cfg(desktop)]
                Host::Local(_) => host.run(&access, &cmd).await,
            }
            .map_err(missing_target)?;
            if let Some(pane) = pane {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Focused {
                    schema_version: u8,
                    status: String,
                    pane_id: String,
                }
                if output.trim() == FOCUS_COMPANION_REQUIRED {
                    return Err(SshError::new("herdr_focus_companion_required","Install or update the companion from Agents for exact Herdr pane navigation"));
                }
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
    #[cfg(unix)]
    use crate::host::tests::local::{lease, ok, Isolated};
    #[cfg(unix)]
    use tauri::Manager;

    #[test]
    fn conversation_target_requires_exact_ipc_fields() {
        let target = serde_json::json!({"herdrSession":"owned","paneId":"w1:p3","terminalId":"terminal-3","agent":"codex","agentSessionId":"id"});
        assert!(serde_json::from_value::<HerdrConversationTarget>(target.clone()).is_ok());
        let mut missing = target.clone();
        missing.as_object_mut().unwrap().remove("terminalId");
        assert!(serde_json::from_value::<HerdrConversationTarget>(missing).is_err());
        let mut extra = target;
        extra["unexpected"] = true.into();
        assert!(serde_json::from_value::<HerdrConversationTarget>(extra).is_err());
    }

    #[test]
    fn old_companion_is_reported_as_an_update_requirement_not_a_parse_failure() {
        let page = r#"{"schemaVersion":1,"view":"active_branch","agent":"claude","messages":[]}"#;
        assert_eq!(
            conversation_page(page, "claude").unwrap()["agent"],
            "claude"
        );
        for wrong in [
            page.replace("claude", "codex"),
            page.replace("active_branch", "record_stream"),
        ] {
            assert_eq!(
                conversation_page(&wrong, "claude").unwrap_err().kind(),
                "invalid_output"
            );
        }
        let old = format!("{CONVERSATION_COMPANION_REQUIRED}\n");
        assert_eq!(
            conversation_page(&old, "claude").unwrap_err().kind(),
            "herdr_conversation_companion_required"
        );
    }

    fn reported_snapshot() -> serde_json::Value {
        serde_json::json!({"result":{"type":"session_snapshot","snapshot":{
            "workspaces":[{"workspace_id":"w1","label":"Owned","focused":true,"agent_status":"working"}],
            "tabs":[{"workspace_id":"w1","tab_id":"w1:t2","label":"Agent","number":1,"focused":true,"agent_status":"working"}],
            "panes":[{"workspace_id":"w1","tab_id":"w1:t2","pane_id":"w1:p3","terminal_id":"terminal-3","focused":true,"agent_status":"working"}],
            "agents":[{"terminal_id":"terminal-3","workspace_id":"w1","tab_id":"w1:t2","pane_id":"w1:p3","agent":"codex","name":null,"agent_status":"working"}]
        }}})
    }
    #[test]
    fn selected_conversation_requires_one_exact_live_herdr_row() {
        let id = "11111111-1111-4111-8111-111111111111";
        let mut source = reported_snapshot();
        source["result"]["snapshot"]["agents"][0]["agent_session"] =
            serde_json::json!({"source":"herdr:codex","agent":"codex","kind":"id","value":id});
        let tree = parse(&source.to_string()).unwrap();
        assert!(selected_agent(&tree, "w1:p3", "terminal-3", "codex", id));
        assert!(!selected_agent(&tree, "w1:p4", "terminal-3", "codex", id));
        assert!(!selected_agent(&tree, "w1:p3", "replacement", "codex", id));
        assert!(!selected_agent(&tree, "w1:p3", "terminal-3", "claude", id));
        let mut stale = source.clone();
        stale["result"]["snapshot"]["agents"][0]["agent_session"]["value"] =
            "22222222-2222-4222-8222-222222222222".into();
        assert!(!selected_agent(
            &parse(&stale.to_string()).unwrap(),
            "w1:p3",
            "terminal-3",
            "codex",
            id
        ));
        let snapshot = &mut source["result"]["snapshot"];
        let mut second = snapshot["agents"][0].clone();
        second["pane_id"] = "w1:p4".into();
        second["terminal_id"] = "terminal-4".into();
        snapshot["agents"].as_array_mut().unwrap().push(second);
        let mut pane = snapshot["panes"][0].clone();
        pane["pane_id"] = "w1:p4".into();
        pane["terminal_id"] = "terminal-4".into();
        snapshot["panes"].as_array_mut().unwrap().push(pane);
        assert!(!selected_agent(
            &parse(&source.to_string()).unwrap(),
            "w1:p3",
            "terminal-3",
            "codex",
            id
        ));
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
                .unwrap()
                .render(),
                format!("lazysh-agent herdr-focus-pane --session owned --pane {pane}")
            );
            assert_eq!(
                action_command(
                    "owned",
                    &HerdrAction::FocusAgent {
                        target: pane.clone()
                    }
                )
                .unwrap()
                .render(),
                format!("herdr --session owned agent focus {pane}")
            );
        }
        for suffix in ["I", "L", "O", "U", "a", "é", "-", "_", "1;id", "1:2", ""] {
            assert!(target(&format!("w{suffix}"), None).is_err());
            assert!(target(&format!("w1:p{suffix}"), Some('p')).is_err());
        }
    }
    #[test]
    fn closes_a_tab_by_exact_id_and_refuses_a_workspace_pane_or_injected_id() {
        assert_eq!(
            action_command(
                "owned",
                &HerdrAction::CloseTab {
                    target: "w1:t2".into()
                }
            )
            .unwrap()
            .render(),
            "herdr --session owned tab close w1:t2"
        );
        for bad in ["", "w1", "w1:p2", "w1:t", "t2", "w1:t2;id", "-a"] {
            assert!(
                action_command("owned", &HerdrAction::CloseTab { target: bad.into() }).is_err(),
                "{bad}"
            );
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
    /// Polls until the isolated Herdr server behind `herdr` answers a snapshot.
    fn wait_until_ready(herdr: impl Fn() -> std::process::Command) {
        let ready = (0..100).any(|_| {
            let ready = herdr()
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
            wait_until_ready(|| herdr.command("herdr"));
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
        /// The command as the remote arm sends it, run through `sh`.
        fn run(&self, cmd: Cmd) -> String {
            lazysh_common::test_support::successful_output(
                self.command("sh").arg("-c").arg(cmd.render()),
            )
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
        let run = |cmd: Cmd| herdr.run(cmd);
        let session = "default";
        run(action_command(
            session,
            &HerdrAction::CreateWorkspace {
                label: "owned".into(),
                directory: temp.to_str().unwrap().into(),
            },
        )
        .unwrap());
        let snapshot = || parse(&run(command(session, &["api", "snapshot"]).unwrap())).unwrap();
        let tree = snapshot();
        let workspace = tree.workspaces[0].workspace_id.clone();
        let pane = tree.panes[0].pane_id.clone();
        let terminal = tree.panes[0].terminal_id.clone().unwrap();
        let tab = tree.panes[0].tab_id.clone();
        run(command(
            session,
            &[
                "pane",
                "report-agent",
                "--source",
                "lazysh-test",
                "--agent",
                "codex",
                "--state",
                "blocked",
                &pane,
            ],
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
            &[
                "pane",
                "report-agent-session",
                &pane,
                "--source",
                "herdr:codex",
                "--agent",
                "codex",
                "--agent-session-id",
                "lazysh-owned-634",
            ],
        )
        .unwrap());
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
        run(action_command(
            session,
            &HerdrAction::FocusTab {
                target: tab.clone(),
            },
        )
        .unwrap());
        run(action_command(session, &HerdrAction::FocusWorkspace { target: workspace }).unwrap());
        // Closing the second tab leaves the workspace's first tab and its panes untouched.
        let before = snapshot();
        run(action_command(session, &HerdrAction::CloseTab { target: tab }).unwrap());
        let closed = snapshot();
        assert_eq!(closed.tabs.len(), 1);
        assert_eq!(closed.tabs[0].tab_id, before.tabs[0].tab_id);
        assert_eq!(closed.panes.len(), 2);
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
            HerdrAction::CloseTab { target: gone('t') },
            HerdrAction::FocusPane { target: gone('p') },
            HerdrAction::FocusAgent { target: gone('p') },
            HerdrAction::ZoomPane { target: gone('p') },
        ] {
            let output = herdr
                .command("sh")
                .arg("-c")
                .arg(action_command(session, &action).unwrap().render())
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
        run(command(session, &["server", "stop"]).unwrap());
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
            || parse(&herdr.run(command(session, &["api", "snapshot"]).unwrap())).unwrap();
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
        herdr.run(command(session, &["pane", "run", &pane, "codex"]).unwrap());
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
        let version = herdr.run(Cmd::new(&[], &["herdr", "--version"]));
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
                &[
                    "pane",
                    "report-agent-session",
                    &pane,
                    "--source",
                    "herdr:codex",
                    "--agent",
                    "codex",
                    "--agent-session-id",
                    "lazysh-owned-990",
                ],
            )
            .unwrap(),
        );
        let agent = expect(idle);
        assert_eq!(
            serde_json::to_value(&agent.agent_session).unwrap(),
            serde_json::json!({"source":"herdr:codex","agent":"codex","kind":"id","value":"lazysh-owned-990"})
        );
        herdr.run(command(session, &["server", "stop"]).unwrap());
    }
    /// Stops the isolated Herdr server a local-session test started.
    #[cfg(unix)]
    struct LocalServer(std::process::Child);
    #[cfg(unix)]
    impl Drop for LocalServer {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires herdr on PATH; runs an isolated headless server"]
    async fn real_local_session_shows_the_tree_focuses_a_tab_and_creates_workspaces_with_literal_names(
    ) {
        let home = Isolated::new();
        let (app, id) = home.session_on_process_path().await;
        // The session's host tools and this server see the same temporary HOME and XDG_CONFIG_HOME.
        let server = home
            .command("herdr")
            .arg("server")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let _server = LocalServer(server);
        wait_until_ready(|| home.command("herdr"));
        let tree = || {
            ok(herdr_tree(
                app.state(),
                app.state(),
                id.clone(),
                "default".into(),
                lease(),
            ))
        };
        let act = |action| {
            ok(herdr_action(
                app.state(),
                app.state(),
                id.clone(),
                "default".into(),
                action,
                lease(),
            ))
        };
        assert!(tree().await.workspaces.is_empty());
        let work = home.path().join("work dir 'q'");
        std::fs::create_dir(&work).unwrap();
        let directory = work.to_str().unwrap().to_owned();
        let label = "literal 'quote' \"double\" $(touch nope)#;";
        let created = ok(crate::herdr_create::herdr_workspace_create(
            app.state(),
            app.state(),
            id.clone(),
            "default".into(),
            serde_json::from_value(serde_json::json!({"target":{"type":"directory","label":label,"directory":directory}})).unwrap(),
            lease(),
        ))
        .await;
        let created = serde_json::to_value(created).unwrap();
        let snapshot = tree().await;
        assert_eq!(snapshot.workspaces.len(), 1);
        assert_eq!(snapshot.workspaces[0].label, label);
        assert_eq!(created["workspaceId"], snapshot.workspaces[0].workspace_id);
        assert_eq!(snapshot.panes[0].cwd.as_deref(), Some(directory.as_str()));
        let workspace = snapshot.workspaces[0].workspace_id.clone();
        act(HerdrAction::CreateTab {
            workspace,
            label: "tab 'two' $(touch nope);".into(),
            directory: directory.clone(),
        })
        .await;
        let snapshot = tree().await;
        assert_eq!(snapshot.tabs.len(), 2);
        assert!(snapshot.tabs[0].focused && !snapshot.tabs[1].focused);
        assert_eq!(snapshot.tabs[1].label, "tab 'two' $(touch nope);");
        act(HerdrAction::FocusTab {
            target: snapshot.tabs[1].tab_id.clone(),
        })
        .await;
        let focused = tree().await;
        assert!(!focused.tabs[0].focused && focused.tabs[1].focused);
        // A stale exact target is one recognizable error and the server survives.
        let gone = herdr_action(
            app.state(),
            app.state(),
            id.clone(),
            "default".into(),
            HerdrAction::FocusWorkspace {
                target: "w999".into(),
            },
            lease(),
        )
        .await
        .unwrap_err();
        assert_eq!(gone.into_inner().unwrap().kind(), "herdr_target_missing");
        assert_eq!(tree().await.tabs.len(), 2);
        assert!(!home.path().join("nope").exists());
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
            .unwrap()
            .render(),
            "herdr --session 'a'\\''$(echo x)' tab rename w1:t2 'a;$(echo x)'"
        );
    }
}
