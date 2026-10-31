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
}

fn text(value: &str, max: usize) -> Result<()> {
    crate::multiplexer::validate_text(value, max, "Invalid Herdr name or path")
}

fn target(value: &str, kind: Option<char>) -> Result<()> {
    let mut parts = value.split(':');
    let workspace = parts.next().unwrap_or("");
    let valid = |part: &str, prefix| {
        part.starts_with(prefix)
            && part.len() > 1
            && part[1..]
                .bytes()
                .all(|b| b"123456789ABCDEFGHJKMNPQRSTVWXYZ0".contains(&b))
    };
    if value.len() > 50
        || !valid(workspace, 'w')
        || match kind {
            None => parts.next().is_some(),
            Some(kind) => !parts.next().is_some_and(|p| valid(p, kind)) || parts.next().is_some(),
        }
    {
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
    let tree = value.result.snapshot;
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
        .run(crate::multiplexer::execute_action(
            &state,
            &access,
            &session_id,
            action_command(&name, &action),
        ))
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
    #[test]
    #[ignore = "requires herdr on PATH; runs an isolated headless server"]
    fn real_herdr_lifecycle_and_tree() {
        use std::process::{Command, Stdio};
        let temp = tempfile::tempdir().unwrap();
        let configure = |command: &mut Command| {
            command
                .env("HOME", temp.path())
                .env("ZDOTDIR", temp.path())
                .env("SHELL", "/bin/sh")
                .env_remove("ENV")
                .env_remove("BASH_ENV")
                .current_dir(temp.path())
                .env("XDG_CONFIG_HOME", temp.path())
                .env("HERDR_CONFIG_PATH", temp.path().join("config.toml"))
                .env_remove("HERDR_SOCKET_PATH")
                .env_remove("HERDR_SESSION");
        };
        let mut server = Command::new("herdr");
        configure(&mut server);
        let mut server = server
            .arg("server")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        struct Server<'a>(&'a mut std::process::Child);
        impl Drop for Server<'_> {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let _guard = Server(&mut server);
        let run = |text: String| {
            let mut cmd = Command::new("sh");
            configure(&mut cmd);
            lazysh_common::test_support::successful_output(cmd.arg("-c").arg(text))
        };
        let mut ready = false;
        for _ in 0..100 {
            let mut cmd = Command::new("herdr");
            configure(&mut cmd);
            if cmd
                .args(["api", "snapshot"])
                .output()
                .unwrap()
                .status
                .success()
            {
                ready = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(ready, "isolated Herdr server did not become ready");
        let session = "default";
        run(action_command(
            session,
            &HerdrAction::CreateWorkspace {
                label: "owned".into(),
                directory: temp.path().to_str().unwrap().into(),
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
                directory: temp.path().to_str().unwrap().into(),
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
                directory: temp.path().to_str().unwrap().into(),
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
                directory: temp.path().to_str().unwrap().into(),
            },
        )
        .unwrap());
        let tree = snapshot();
        assert_eq!(tree.workspaces.len(), 2);
        run(command(session, "server stop".into()).unwrap());
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
