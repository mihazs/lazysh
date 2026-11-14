use crate::app_lock::AccessLease;
use crate::ssh::{quote, AppState, Result, SshError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ZellijAction {
    NewTab { name: String, directory: String },
    GoToTab { index: u32 },
    /// By the tab's stable id from `list-tabs`, never by position: a tab that moved or went since the strip read is refused, not guessed.
    CloseTab { id: u32 },
    RenameTab { id: u32, name: String },
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
        ZellijAction::CloseTab { id } => format!("close-tab-by-id {id}"),
        // `--` keeps a name that starts with a dash a name, not an option.
        ZellijAction::RenameTab { id, name } => format!("rename-tab-by-id {id} -- {}", text(name, 200)?),
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
/// One tab of a session as `zellij action list-tabs --json` reports it. `id` is the stable `tab_id` that close and rename address; a Zellij that does not report one leaves it out and the tab can still be selected.
#[derive(Debug, PartialEq, Serialize)]
pub struct ZellijTab {
    position: u32,
    name: String,
    active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u32>,
}
const MAX_TABS: usize = 1000;
fn tabs_command(session: &str) -> Result<String> {
    Ok(format!(
        "zellij --session={} action list-tabs --json",
        text(session, 200)?
    ))
}
fn parse_tabs(output: &str) -> Result<Vec<ZellijTab>> {
    let invalid = || SshError::new("zellij_protocol", "Zellij returned an unreadable tab list");
    let rows: Vec<serde_json::Value> = serde_json::from_str(output).map_err(|_| invalid())?;
    if rows.len() > MAX_TABS {
        return Err(invalid());
    }
    rows.iter()
        .map(|row| {
            Ok(ZellijTab {
                position: row["position"]
                    .as_u64()
                    .and_then(|position| u32::try_from(position).ok())
                    .filter(|position| (*position as usize) < MAX_TABS)
                    .ok_or_else(invalid)?,
                // A tab name is host-controlled text shown in the strip: drop control characters and bound it.
                name: row["name"]
                    .as_str()
                    .ok_or_else(invalid)?
                    .chars()
                    .filter(|character| !character.is_control())
                    .take(200)
                    .collect(),
                active: row["active"].as_bool().ok_or_else(invalid)?,
                id: row["tab_id"].as_u64().and_then(|id| u32::try_from(id).ok()),
            })
        })
        .collect()
}
#[tauri::command]
pub async fn zellij_tabs(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    access: AccessLease,
) -> crate::ssh::AccessResult<Vec<ZellijTab>> {
    access
        .run(async {
            let command = tabs_command(&name)?;
            let session = state.session(&session_id).await?;
            parse_tabs(&crate::ssh::exec_for_access(&session, command, &access).await?)
        })
        .await
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
    fn closes_and_renames_a_tab_by_stable_id_with_a_literal_name() {
        assert_eq!(
            command("work", &ZellijAction::CloseTab { id: 7 }).unwrap(),
            "zellij --session='work' action close-tab-by-id 7"
        );
        assert_eq!(
            command("work", &ZellijAction::RenameTab { id: 7, name: "-x';$(touch nope)".into() }).unwrap(),
            "zellij --session='work' action rename-tab-by-id 7 -- '-x'\\'';$(touch nope)'"
        );
        assert!(command("work", &ZellijAction::RenameTab { id: 7, name: "a\nb".into() }).is_err());
        // A negative or fractional id is not a tab id: the command layer takes only an unsigned integer.
        for bad in [r#"{"type":"closeTab","id":-1}"#, r#"{"type":"closeTab","id":"1;id"}"#, r#"{"type":"closeTab"}"#, r#"{"type":"closeTab","id":1,"extra":true}"#] {
            assert!(serde_json::from_str::<ZellijAction>(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn lists_tabs_from_the_json_the_cli_prints_and_refuses_anything_else() {
        let tabs = parse_tabs(r#"[{"position":0,"name":"one\u001b[31m","active":false,"viewport_rows":9,"tab_id":4},{"position":1,"name":"two","active":true}]"#).unwrap();
        assert_eq!(
            tabs,
            vec![
                ZellijTab {
                    position: 0,
                    name: "one[31m".into(),
                    active: false,
                    id: Some(4)
                },
                // A Zellij that reports no `tab_id` still lists the tab, which can then be selected but not closed or renamed.
                ZellijTab {
                    position: 1,
                    name: "two".into(),
                    active: true,
                    id: None
                },
            ]
        );
        assert_eq!(
            parse_tabs(&format!(
                r#"[{{"position":0,"name":"{}","active":true}}]"#,
                "n".repeat(300)
            ))
            .unwrap()[0]
                .name
                .len(),
            200
        );
        for bad in [
            "",
            "{}",
            "[1]",
            r#"[{"position":-1,"name":"a","active":true}]"#,
            r#"[{"position":1000,"name":"a","active":true}]"#,
            r#"[{"position":0,"name":3,"active":true}]"#,
            r#"[{"position":0,"name":"a"}]"#,
        ] {
            assert_eq!(
                parse_tabs(bad).unwrap_err().kind(),
                "zellij_protocol",
                "{bad}"
            );
        }
        let many = format!(
            "[{}]",
            vec![r#"{"position":0,"name":"a","active":true}"#; MAX_TABS + 1].join(",")
        );
        assert!(parse_tabs(&many).is_err());
        assert_eq!(
            tabs_command("a'$(touch nope)").unwrap(),
            "zellij --session='a'\\''$(touch nope)' action list-tabs --json"
        );
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
        let (rendered, first_render) = std::sync::mpsc::channel();
        let drain = std::thread::spawn(move || {
            // The client clears the screen only for the server's first render,
            // after the session exists. The search keeps a boundary-spanning tail.
            const CLEAR: &[u8] = b"\x1b[2J";
            let mut tail = Vec::new();
            let mut rendered = Some(rendered);
            let mut bytes = [0u8; 8192];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                if rendered.is_some() {
                    tail.extend_from_slice(&bytes[..count]);
                    if tail.windows(CLEAR.len()).any(|window| window == CLEAR) {
                        let _ = rendered.take().unwrap().send(());
                    }
                    tail.drain(..tail.len().saturating_sub(CLEAR.len() - 1));
                }
            }
        });
        let _client = Client(child, Some(drain), Some(server));
        // Zellij 0.45.1 panics if a `list-sessions` probe disconnects from a
        // server that has not created its session yet, so probe only after the
        // attached client's first render.
        first_render
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("attached Zellij client renders its new session");
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
        // Zellij applies CLI actions asynchronously and lists a session before its
        // attached client reports tab state. Observe each state change within a
        // bounded deadline instead of reading it once.
        let wait = |description: &str,
                    probe: &dyn Fn() -> std::result::Result<u64, String>,
                    matches: &dyn Fn(u64) -> bool| {
            let mut last = String::new();
            for _ in 0..250 {
                match probe() {
                    Ok(value) if matches(value) => return value,
                    Ok(value) => last = format!("observed {value}"),
                    Err(error) => last = error,
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!("Attached Zellij client did not reach {description}: {last}");
        };
        let query = |subcommand: &str| -> std::result::Result<serde_json::Value, String> {
            let output = execute(format!(
                "zellij --session={} action {subcommand} --json",
                quote(&name)
            ));
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned());
            }
            serde_json::from_slice(&output.stdout)
                .map_err(|error| format!("{error}: {}", String::from_utf8_lossy(&output.stdout)))
        };
        let active_tab = || {
            let tabs = query("list-tabs")?;
            tabs.as_array()
                .and_then(|tabs| tabs.iter().find(|tab| tab["active"] == true))
                .and_then(|tab| tab["position"].as_u64())
                .ok_or_else(|| format!("attached client has no active tab: {tabs}"))
        };
        wait("attached first tab", &active_tab, &|position| position == 0);
        let directory = temp.path().to_str().unwrap().to_owned();
        run(command(
            &name,
            &ZellijAction::NewTab {
                name: "literal'$(touch nope)".into(),
                directory: directory.clone(),
            },
        )
        .unwrap());
        wait("new tab focus", &active_tab, &|position| position == 1);
        run(command(&name, &ZellijAction::GoToTab { index: 1 }).unwrap());
        wait("first tab by index", &active_tab, &|position| position == 0);
        run(command(&name, &ZellijAction::NextTab).unwrap());
        wait("next tab", &active_tab, &|position| position == 1);
        run(command(&name, &ZellijAction::PreviousTab).unwrap());
        wait("previous tab", &active_tab, &|position| position == 0);
        let focused_pane = || {
            let panes = query("list-panes")?;
            panes
                .as_array()
                .and_then(|panes| {
                    panes.iter().find(|pane| {
                        pane["is_focused"] == true
                            && pane["is_plugin"] == false
                            && pane["tab_position"] == 0
                    })
                })
                .and_then(|pane| pane["id"].as_u64())
                .ok_or_else(|| format!("active tab has no focused terminal pane: {panes}"))
        };
        let first = wait("initial pane focus", &focused_pane, &|_| true);
        run(command(
            &name,
            &ZellijAction::NewPane {
                horizontal: true,
                directory,
            },
        )
        .unwrap());
        let second = wait("new pane focus", &focused_pane, &|id| id != first);
        run(command(&name, &ZellijAction::NextPane).unwrap());
        wait("next pane focus", &focused_pane, &|id| id == first);
        run(command(&name, &ZellijAction::PreviousPane).unwrap());
        wait("previous pane focus", &focused_pane, &|id| id == second);
        run(command(&name, &ZellijAction::ZoomPane).unwrap());
        let tabs = run(format!(
            "zellij --session={} action list-tabs --json",
            quote(&name)
        ));
        assert!(tabs.contains("literal'$(touch nope)"));
        // The strip's reader accepts the CLI's real output: two tabs, the first (left active by `previous-tab`) selected.
        let listed = parse_tabs(&tabs).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|tab| (tab.position, tab.active))
                .collect::<Vec<_>>(),
            vec![(0, true), (1, false)]
        );
        assert_eq!(listed[1].name, "literal'$(touch nope)");
        // Real Zellij reports the stable id that rename and close address, so the strip can offer both.
        let second = listed[1].id.expect("Zellij lists a stable tab_id");
        assert_ne!(listed[0].id, listed[1].id);
        run(command(
            &name,
            &ZellijAction::RenameTab {
                id: second,
                name: "-renamed';$(touch nope)".into(),
            },
        )
        .unwrap());
        let renamed_second = || {
            let tabs = query("list-tabs")?;
            Ok(u64::from(
                tabs.as_array()
                    .is_some_and(|tabs| tabs.iter().any(|tab| tab["tab_id"] == second && tab["name"] == "-renamed';$(touch nope)")),
            ))
        };
        wait("renamed tab by id", &renamed_second, &|found| found == 1);
        // Rename and close act on the tab they name, not the focused one: the first tab is still active.
        assert_eq!(wait("first tab still focused", &active_tab, &|_| true), 0);
        run(command(&name, &ZellijAction::CloseTab { id: second }).unwrap());
        let tab_count = || Ok(query("list-tabs")?.as_array().map_or(0, |tabs| tabs.len() as u64));
        wait("closed tab by id", &tab_count, &|count| count == 1);
        assert_eq!(wait("first tab kept", &active_tab, &|_| true), 0);
        // The tab is gone: Zellij ignores its stable id (it never falls back to a position), so the remaining tab is untouched.
        execute(command(&name, &ZellijAction::CloseTab { id: second }).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(tab_count().unwrap(), 1);
        assert_eq!(active_tab().unwrap(), 0);
        assert!(!temp.path().join("nope").exists());
        run(format!("zellij kill-session -- {}", quote(&name)));
    }
}
