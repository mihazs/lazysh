use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::{quote, AppState, Result, SshError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Deserialize, Serialize)]
pub struct HerdrTree {
    pub workspaces: Vec<Workspace>,
    pub tabs: Vec<Tab>,
    pub panes: Vec<Pane>,
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
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub cwd: String,
    pub focused: bool,
    pub agent_status: String,
}

fn text(value: &str, max: usize) -> Result<()> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(SshError::new(
            "invalid_target",
            "Invalid Herdr name or path",
        ));
    }
    Ok(())
}
fn target(value: &str, kind: Option<char>) -> Result<()> {
    let mut parts = value.split(':');
    let workspace = parts.next().unwrap_or("");
    let valid = |part: &str, prefix| {
        part.starts_with(prefix) && part.len() > 1 && part[1..].bytes().all(|b| b.is_ascii_digit())
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
    if tree.workspaces.len() > 1000 || tree.tabs.len() > 2000 || tree.panes.len() > 4096 {
        return Err(SshError::new(
            "output_too_large",
            "Herdr workspace tree is too large",
        ));
    }
    for w in &tree.workspaces {
        target(&w.workspace_id, None)?;
    }
    for t in &tree.tabs {
        target(&t.workspace_id, None)?;
        target(&t.tab_id, Some('t'))?;
    }
    for p in &tree.panes {
        target(&p.workspace_id, None)?;
        target(&p.tab_id, Some('t'))?;
        target(&p.pane_id, Some('p'))?;
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
) -> std::result::Result<Guarded<HerdrTree>, GuardedError<crate::ssh::SshError>> {
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
) -> std::result::Result<Guarded<()>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let command = action_command(&name, &action)?;
            let session = state.session(&session_id).await?;
            crate::ssh::exec_for_access(&session, command, &access).await?;
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires herdr on PATH; runs an isolated headless server"]
    fn real_herdr_lifecycle_and_tree() {
        use std::process::{Command, Stdio};
        let temp = tempfile::tempdir().unwrap();
        let configure = |command: &mut Command| {
            command
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
            let output = cmd.arg("-c").arg(text).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
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
        let tree = parse(&run(command(session, "api snapshot".into()).unwrap())).unwrap();
        let workspace = tree.workspaces[0].workspace_id.clone();
        let pane = tree.panes[0].pane_id.clone();
        run(command(
            session,
            format!(
                "pane report-agent --source lazysh-test --agent lazysh-test --state idle {}",
                quote(&pane)
            ),
        )
        .unwrap());
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
        let tree = parse(&run(command(session, "api snapshot".into()).unwrap())).unwrap();
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
        let tree = parse(&run(command(session, "api snapshot".into()).unwrap())).unwrap();
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
