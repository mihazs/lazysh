use crate::app_lock::AccessLease;
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
    NextPane,
    PreviousPane,
    NewPane { horizontal: bool, directory: String },
    ZoomPane,
}
fn text(value: &str, max: usize) -> Result<String> {
    crate::multiplexer::validate_text(value, max, "Invalid Zellij name or path")?;
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
        ZellijAction::NextPane => "focus-next-pane".into(),
        ZellijAction::PreviousPane => "focus-previous-pane".into(),
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
) -> crate::ssh::AccessResult<()> {
    access
        .run(crate::multiplexer::execute_action(
            &state,
            &access,
            &session_id,
            command(&name, &action),
        ))
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
    fn navigation_is_fixed_and_keeps_hostile_session_names_literal() {
        for (action, verb) in [
            (ZellijAction::NextTab, "go-to-next-tab"),
            (ZellijAction::PreviousTab, "go-to-previous-tab"),
            (ZellijAction::NextPane, "focus-next-pane"),
            (ZellijAction::PreviousPane, "focus-previous-pane"),
        ] {
            assert_eq!(
                command("a'$(touch nope);x", &action).unwrap(),
                format!("zellij --session='a'\\''$(touch nope);x' action {verb}")
            );
        }
    }
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    #[test]
    #[ignore = "requires zellij on PATH; runs an isolated temporary session"]
    fn real_zellij_lifecycle_and_actions() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap();
        let name = format!("ls-{}", uuid::Uuid::new_v4().simple());
        let execute = |text: String| {
            Command::new("sh")
                .arg("-c")
                .arg(text)
                .env("XDG_RUNTIME_DIR", temp.path())
                .env("XDG_CACHE_HOME", temp.path())
                .env("XDG_CONFIG_HOME", temp.path())
                .env_remove("ZELLIJ")
                .env_remove("ZELLIJ_SESSION_NAME")
                .env("TERM", "xterm-256color")
                .output()
                .unwrap()
        };
        let run = |text: String| {
            let output = execute(text);
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
        let server = Server(name.clone(), temp.path().to_path_buf());
        let layout = temp.path().join("test-layout.kdl");
        std::fs::write(&layout, "layout { pane; }\n").unwrap();
        let config = temp.path().join("config.kdl");
        std::fs::write(
            &config,
            "show_release_notes false\nshow_startup_tips false\n",
        )
        .unwrap();
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut builder = CommandBuilder::new("zellij");
        builder.args([
            "--config",
            config.to_str().unwrap(),
            "--layout",
            layout.to_str().unwrap(),
            "attach",
            "--create",
            &name,
        ]);
        for key in ["XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] {
            builder.env(key, temp.path());
        }
        builder.env_remove("ZELLIJ");
        builder.env_remove("ZELLIJ_SESSION_NAME");
        builder.env("TERM", "xterm-256color");
        builder.env("SHELL", "/bin/sh");
        builder.cwd(temp.path());
        struct Client(
            Box<dyn portable_pty::Child + Send + Sync>,
            Option<std::thread::JoinHandle<()>>,
            Option<Server>,
        );
        impl Drop for Client {
            fn drop(&mut self) {
                // Tear down the server before joining its PTY drain, including on panic.
                drop(self.2.take());
                let _ = self.0.kill();
                let _ = self.0.wait();
                if let Some(drain) = self.1.take() {
                    let _ = drain.join();
                }
            }
        }
        let mut reader = pty.master.try_clone_reader().unwrap();
        let child = pty.slave.spawn_command(builder).unwrap();
        drop(pty.slave);
        let drain = std::thread::spawn(move || {
            let mut bytes = [0u8; 8192];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
            }
        });
        let _client = Client(child, Some(drain), Some(server));
        let mut names = String::new();
        for _ in 0..100 {
            let output = execute("zellij list-sessions --short --no-formatting".into());
            names = String::from_utf8(output.stdout).unwrap();
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
        let active_tab = || {
            let tabs: serde_json::Value = serde_json::from_str(&run(format!(
                "zellij --session={} action list-tabs --json",
                quote(&name)
            )))
            .unwrap();
            tabs.as_array()
                .unwrap()
                .iter()
                .find(|tab| tab["active"] == true)
                .expect("attached client has an active tab")["position"]
                .as_u64()
                .unwrap()
        };
        assert_eq!(active_tab(), 0);
        run(command(&name, &ZellijAction::NextTab).unwrap());
        assert_eq!(active_tab(), 1);
        run(command(&name, &ZellijAction::PreviousTab).unwrap());
        assert_eq!(active_tab(), 0);
        let focused_pane = || {
            let panes: serde_json::Value = serde_json::from_str(&run(format!(
                "zellij --session={} action list-panes --json",
                quote(&name)
            )))
            .unwrap();
            panes
                .as_array()
                .unwrap()
                .iter()
                .find(|pane| {
                    pane["is_focused"] == true
                        && pane["is_plugin"] == false
                        && pane["tab_position"] == 0
                })
                .expect("active tab has a focused terminal pane")["id"]
                .as_u64()
                .unwrap()
        };
        let wait_focus = |description: &str, matches: &dyn Fn(u64) -> bool| {
            for _ in 0..100 {
                let id = focused_pane();
                if matches(id) {
                    return id;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!(
                "Attached Zellij client did not reach {description}: {}",
                run(format!(
                    "zellij --session={} action list-panes --json",
                    quote(&name)
                ))
            );
        };
        let first = focused_pane();
        run(command(
            &name,
            &ZellijAction::NewPane {
                horizontal: true,
                directory,
            },
        )
        .unwrap());
        // Pane startup is asynchronous; observe its focus before testing navigation.
        let second = wait_focus("new pane focus", &|id| id != first);
        run(command(&name, &ZellijAction::NextPane).unwrap());
        wait_focus("next pane focus", &|id| id == first);
        run(command(&name, &ZellijAction::PreviousPane).unwrap());
        wait_focus("previous pane focus", &|id| id == second);
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
