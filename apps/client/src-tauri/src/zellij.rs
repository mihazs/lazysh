use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::{quote, AppState, Result, SshError};
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ZellijAction {
    NewTab { name: String, directory: String },
    GoToTab { index: u32 },
    NextTab,
    PreviousTab,
    NewPane { horizontal: bool, directory: String },
    ZoomPane,
}
fn text(value: &str, max: usize) -> Result<String> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(SshError::new(
            "invalid_target",
            "Invalid Zellij name or path",
        ));
    }
    Ok(quote(value))
}
fn command(session: &str, action: &ZellijAction) -> Result<String> {
    let session = text(session, 200)?;
    let args = match action {
        ZellijAction::NewTab { name, directory } => format!(
            "new-tab --name={} --cwd={}",
            text(name, 200)?,
            text(directory, 4096)?
        ),
        ZellijAction::GoToTab { index } => {
            if *index == 0 || *index > 1000 {
                return Err(SshError::new(
                    "invalid_target",
                    "Choose a tab number from 1 to 1000",
                ));
            }
            format!("go-to-tab {index}")
        }
        ZellijAction::NextTab => "go-to-next-tab".into(),
        ZellijAction::PreviousTab => "go-to-previous-tab".into(),
        ZellijAction::NewPane {
            horizontal,
            directory,
        } => format!(
            "new-pane --direction {} --cwd={}",
            if *horizontal { "right" } else { "down" },
            text(directory, 4096)?
        ),
        ZellijAction::ZoomPane => "toggle-fullscreen".into(),
    };
    Ok(format!("zellij --session={session} action {args}"))
}
#[tauri::command]
pub async fn zellij_action(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    action: ZellijAction,
    access: AccessLease,
) -> std::result::Result<Guarded<()>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let command = command(&name, &action)?;
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
    fn validates_tab_numbers_and_keeps_labels_and_paths_literal() {
        assert!(command("test", &ZellijAction::GoToTab { index: 0 }).is_err());
        assert!(command("test", &ZellijAction::GoToTab { index: 1001 }).is_err());
        assert_eq!(command("a'$(echo x)", &ZellijAction::NewTab { name: "title;$(echo no)".into(), directory: "/a b".into() }).unwrap(), "zellij --session='a'\\''$(echo x)' action new-tab --name='title;$(echo no)' --cwd='/a b'");
    }
    #[test]
    #[ignore = "requires zellij on PATH; runs an isolated temporary session"]
    fn real_zellij_lifecycle_and_actions() {
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap();
        let name = format!("ls-{}", uuid::Uuid::new_v4().simple());
        let run = |text: String| {
            let output = Command::new("sh")
                .arg("-c")
                .arg(text)
                .env("XDG_RUNTIME_DIR", temp.path())
                .env("XDG_CACHE_HOME", temp.path())
                .env("XDG_CONFIG_HOME", temp.path())
                .env_remove("ZELLIJ")
                .env_remove("ZELLIJ_SESSION_NAME")
                .env("TERM", "xterm-256color")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
        };
        struct Server(String, std::path::PathBuf);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = Command::new("zellij")
                    .args(["kill-session", "--", &self.0])
                    .env("XDG_RUNTIME_DIR", &self.1)
                    .env("XDG_CACHE_HOME", &self.1)
                    .env("XDG_CONFIG_HOME", &self.1)
                    .output();
            }
        }
        let _server = Server(name.clone(), temp.path().to_path_buf());
        run(format!(
            "zellij attach --create-background {}",
            quote(&name)
        ));
        let mut names = String::new();
        for _ in 0..100 {
            names = run("zellij list-sessions --short --no-formatting".into());
            if names.lines().any(|line| line == name) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(names.lines().any(|line| line == name), "{names:?}");
        let directory = temp.path().to_str().unwrap().to_owned();
        run(command(
            &name,
            &ZellijAction::NewTab {
                name: "literal'$(touch nope)".into(),
                directory: directory.clone(),
            },
        )
        .unwrap());
        run(command(&name, &ZellijAction::GoToTab { index: 1 }).unwrap());
        run(command(&name, &ZellijAction::NextTab).unwrap());
        run(command(&name, &ZellijAction::PreviousTab).unwrap());
        run(command(
            &name,
            &ZellijAction::NewPane {
                horizontal: true,
                directory,
            },
        )
        .unwrap());
        run(command(&name, &ZellijAction::ZoomPane).unwrap());
        let tabs = run(format!(
            "zellij --session={} action list-tabs --json",
            quote(&name)
        ));
        assert!(tabs.contains("literal'$(touch nope)"));
        assert!(!temp.path().join("nope").exists());
        run(format!("zellij kill-session -- {}", quote(&name)));
    }
}
