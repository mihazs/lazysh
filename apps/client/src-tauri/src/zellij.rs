use crate::app_lock::AccessLease;
use crate::host::{Cmd, Host};
use crate::local::LocalState;
use crate::ssh::{AppState, Result, SshError};
use serde::{Deserialize, Serialize};
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
    Ok(value.to_owned())
}
/// `zellij --session=<name> action <args>` as argv; names and paths stay single words.
fn session_command(session: &str, args: Vec<String>) -> Result<Cmd> {
    let mut argv = vec![
        "zellij".to_owned(),
        format!("--session={}", text(session, 200)?),
        "action".to_owned(),
    ];
    argv.extend(args);
    Ok(Cmd::new(
        &[],
        &argv.iter().map(String::as_str).collect::<Vec<_>>(),
    ))
}
fn command(session: &str, action: &ZellijAction) -> Result<Cmd> {
    let args = match action {
        ZellijAction::NewTab { name, directory } => vec![
            "new-tab".into(),
            format!("--name={}", text(name, 200)?),
            format!("--cwd={}", text(directory, 4096)?),
        ],
        ZellijAction::GoToTab { index } => {
            if *index == 0 || *index > 1000 {
                return Err(SshError::new(
                    "invalid_target",
                    "Choose a tab number from 1 to 1000",
                ));
            }
            vec!["go-to-tab".into(), index.to_string()]
        }
        ZellijAction::NextTab => vec!["go-to-next-tab".into()],
        ZellijAction::PreviousTab => vec!["go-to-previous-tab".into()],
        ZellijAction::NextPane => vec!["focus-next-pane".into()],
        ZellijAction::PreviousPane => vec!["focus-previous-pane".into()],
        ZellijAction::NewPane {
            horizontal,
            directory,
        } => vec![
            "new-pane".into(),
            "--direction".into(),
            if *horizontal { "right" } else { "down" }.into(),
            format!("--cwd={}", text(directory, 4096)?),
        ],
        ZellijAction::ZoomPane => vec!["toggle-fullscreen".into()],
    };
    session_command(session, args)
}
/// One tab of a session as `zellij action list-tabs --json` reports it; the strip shows only these three facts.
#[derive(Debug, PartialEq, Serialize)]
pub struct ZellijTab {
    position: u32,
    name: String,
    active: bool,
}
const MAX_TABS: usize = 1000;
fn tabs_command(session: &str) -> Result<Cmd> {
    session_command(session, vec!["list-tabs".into(), "--json".into()])
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
            })
        })
        .collect()
}
#[tauri::command]
pub async fn zellij_tabs(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    name: String,
    access: AccessLease,
) -> crate::ssh::AccessResult<Vec<ZellijTab>> {
    access
        .run(async {
            let command = tabs_command(&name)?;
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            parse_tabs(&host.run(&access, &command).await?)
        })
        .await
}
#[tauri::command]
pub async fn zellij_action(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    name: String,
    action: ZellijAction,
    access: AccessLease,
) -> crate::ssh::AccessResult<()> {
    access
        .run(async {
            let command = command(&name, &action);
            Host::resolve(&state, &local, &session_id, &access)
                .await?
                .run(&access, &command?)
                .await?;
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::quote;
    #[test]
    fn validates_tab_numbers_and_keeps_labels_and_paths_literal() {
        assert!(command("test", &ZellijAction::GoToTab { index: 0 }).is_err());
        assert!(command("test", &ZellijAction::GoToTab { index: 1001 }).is_err());
        assert_eq!(command("a'$(echo x)", &ZellijAction::NewTab { name: "title;$(echo no)".into(), directory: "/a b".into() }).unwrap().render(), "zellij '--session=a'\\''$(echo x)' action new-tab '--name=title;$(echo no)' '--cwd=/a b'");
    }
    #[test]
    fn lists_tabs_from_the_json_the_cli_prints_and_refuses_anything_else() {
        let tabs = parse_tabs(r#"[{"position":0,"name":"one\u001b[31m","active":false,"viewport_rows":9},{"position":1,"name":"two","active":true}]"#).unwrap();
        assert_eq!(
            tabs,
            vec![
                ZellijTab {
                    position: 0,
                    name: "one[31m".into(),
                    active: false
                },
                ZellijTab {
                    position: 1,
                    name: "two".into(),
                    active: true
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
            tabs_command("a'$(touch nope)").unwrap().render(),
            "zellij '--session=a'\\''$(touch nope)' action list-tabs --json"
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
                command("a'$(touch nope);x", &action).unwrap().render(),
                format!("zellij '--session=a'\\''$(touch nope);x' action {verb}")
            );
        }
    }
    /// A fresh 80x24 PTY and the Zellij command to run on it.
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    fn zellij_client() -> (portable_pty::PtyPair, portable_pty::CommandBuilder) {
        let pty = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        (pty, portable_pty::CommandBuilder::new("zellij"))
    }
    /// A Zellij session and the client attached to it, torn down even when the test panics.
    #[cfg(unix)]
    struct Attached {
        home: std::path::PathBuf,
        name: String,
        client: Box<dyn portable_pty::Child + Send + Sync>,
        drain: Option<std::thread::JoinHandle<()>>,
    }
    #[cfg(unix)]
    impl Drop for Attached {
        fn drop(&mut self) {
            let _ = std::process::Command::new("zellij")
                .args(["kill-session", "--", &self.name])
                .env("XDG_RUNTIME_DIR", &self.home)
                .env("XDG_CACHE_HOME", &self.home)
                .env("XDG_CONFIG_HOME", &self.home)
                .output();
            let _ = self.client.kill();
            let _ = self.client.wait();
            if let Some(drain) = self.drain.take() {
                let _ = drain.join();
            }
        }
    }
    /// Retries `probe` for five seconds: Zellij applies actions asynchronously.
    #[cfg(unix)]
    async fn until<T, F: std::future::Future<Output = Option<T>>>(
        what: &str,
        mut probe: impl FnMut() -> F,
    ) -> T {
        for _ in 0..250 {
            if let Some(found) = probe().await {
                return found;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("Zellij never reached {what}");
    }
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires zellij on PATH; runs an isolated temporary session"]
    async fn real_local_session_lists_zellij_sessions_and_switches_tabs() {
        use crate::host::tests::local::{lease, ok, Isolated};
        use crate::multiplexer::MultiplexerKind;
        use tauri::Manager;
        let home = Isolated::new();
        let (app, id) = home.session().await;
        let name = format!("ls-{}", uuid::Uuid::new_v4().simple());
        std::fs::create_dir(home.path().join("zellij")).unwrap();
        std::fs::write(
            home.path().join("zellij/config.kdl"),
            "show_release_notes false\nshow_startup_tips false\n",
        )
        .unwrap();
        let created = home
            .command("zellij")
            .args(["attach", "--create-background", &name])
            .output()
            .unwrap();
        assert!(created.status.success(), "{created:?}");
        // The client gives the headless session focus state: only an attached client has an active tab.
        let (pty, mut builder) = zellij_client();
        builder.args(["attach", &name]);
        for (key, value) in home.command("zellij").get_envs() {
            match value {
                Some(value) => builder.env(key, value),
                None => builder.env_remove(key),
            }
        }
        let mut reader = pty.master.try_clone_reader().unwrap();
        let client = pty.slave.spawn_command(builder).unwrap();
        drop(pty.slave);
        let drain = std::thread::spawn(move || {
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        let _attached = Attached {
            home: home.path().to_path_buf(),
            name: name.clone(),
            client,
            drain: Some(drain),
        };
        let listed = until("a listed session", || async {
            let sessions = ok(crate::multiplexer::multiplexer_sessions(
                app.state(),
                app.state(),
                id.clone(),
                MultiplexerKind::Zellij,
                lease(),
            ))
            .await;
            serde_json::to_value(&sessions)
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["name"] == name)
                .then_some(())
        });
        listed.await;
        // A session that has not reported its tabs yet answers with an unreadable list.
        let tabs = || {
            let answer = Box::pin(zellij_tabs(
                app.state(),
                app.state(),
                id.clone(),
                name.clone(),
                lease(),
            ));
            async move { answer.await.ok().and_then(|tabs| tabs.into_inner().ok()) }
        };
        let act = |action| {
            ok(zellij_action(
                app.state(),
                app.state(),
                id.clone(),
                name.clone(),
                action,
                lease(),
            ))
        };
        let active = |position: u32, count: usize| {
            let tabs = &tabs;
            async move {
                let tabs = tabs().await?;
                (tabs.len() == count
                    && tabs
                        .iter()
                        .any(|tab| tab.active && tab.position == position))
                .then_some(tabs)
            }
        };
        until("the first tab", || active(0, 1)).await;
        let literal = "literal 'quote' $(touch nope)";
        let directory = home.path().join("tab dir 'q'");
        std::fs::create_dir(&directory).unwrap();
        act(ZellijAction::NewTab {
            name: literal.into(),
            directory: directory.to_str().unwrap().into(),
        })
        .await;
        let tabs_now = until("the new tab", || active(1, 2)).await;
        assert_eq!(tabs_now[1].name, literal);
        assert!(!home.path().join("nope").exists());
        act(ZellijAction::GoToTab { index: 1 }).await;
        until("the first tab by number", || active(0, 2)).await;
        act(ZellijAction::NextTab).await;
        until("the next tab", || active(1, 2)).await;
        act(ZellijAction::PreviousTab).await;
        until("the previous tab", || active(0, 2)).await;
    }
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    #[test]
    #[ignore = "requires zellij on PATH; runs an isolated temporary session"]
    fn real_zellij_lifecycle_and_actions() {
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
        let (pty, mut builder) = zellij_client();
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
        .unwrap()
        .render());
        wait("new tab focus", &active_tab, &|position| position == 1);
        run(command(&name, &ZellijAction::GoToTab { index: 1 })
            .unwrap()
            .render());
        wait("first tab by index", &active_tab, &|position| position == 0);
        run(command(&name, &ZellijAction::NextTab).unwrap().render());
        wait("next tab", &active_tab, &|position| position == 1);
        run(command(&name, &ZellijAction::PreviousTab).unwrap().render());
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
        .unwrap()
        .render());
        let second = wait("new pane focus", &focused_pane, &|id| id != first);
        run(command(&name, &ZellijAction::NextPane).unwrap().render());
        wait("next pane focus", &focused_pane, &|id| id == first);
        run(command(&name, &ZellijAction::PreviousPane)
            .unwrap()
            .render());
        wait("previous pane focus", &focused_pane, &|id| id == second);
        run(command(&name, &ZellijAction::ZoomPane).unwrap().render());
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
        assert!(!temp.path().join("nope").exists());
        run(format!("zellij kill-session -- {}", quote(&name)));
    }
}
