use crate::app_lock::AccessLease;
use crate::ssh::{quote, AppState, Result, SshError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ZellijAction {
    NewTab {
        name: String,
        directory: String,
    },
    GoToTab {
        index: u32,
    },
    NextTab,
    PreviousTab,
    NextPane,
    PreviousPane,
    NewPane {
        horizontal: bool,
        directory: String,
    },
    ZoomPane,
    /// Jump To: a tab by its stable id. Zellij 0.45.1's `focus-pane-id` only flags the pane for the CLI and leaves the
    /// attached client where it was, so a pane is not a destination; the tab keeps its own focused pane.
    Jump {
        #[serde(rename = "tabId")]
        tab_id: u32,
    },
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
        ZellijAction::Jump { tab_id } => format!("go-to-tab-by-id {tab_id}"),
    };
    Ok(format!("zellij --session={session} action {args}"))
}
/// One tab of a session as `zellij action list-tabs --json` reports it; the strip shows only these three facts.
#[derive(Debug, PartialEq, Serialize)]
pub struct ZellijTab {
    position: u32,
    name: String,
    active: bool,
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
            })
        })
        .collect()
}
/// One terminal pane of a tab in Jump To.
#[derive(Debug, PartialEq, Serialize)]
pub struct ZellijPane {
    id: u32,
    title: String,
    focused: bool,
}
/// One tab of the session with its terminal panes, by the stable ids `go-to-tab-by-id` and `focus-pane-id` take.
#[derive(Debug, PartialEq, Serialize)]
pub struct ZellijTreeTab {
    id: u32,
    position: u32,
    name: String,
    active: bool,
    panes: Vec<ZellijPane>,
}
#[derive(Debug, PartialEq, Serialize)]
pub struct ZellijTree {
    tabs: Vec<ZellijTreeTab>,
}
const MAX_PANES: usize = 5000;
/// Tabs with their state, then every pane with its tab; the first command's output is `parse_tree`'s first argument.
fn tree_commands(session: &str) -> Result<[String; 2]> {
    let session = text(session, 200)?;
    Ok([
        format!("zellij --session={session} action list-tabs --json --state"),
        format!("zellij --session={session} action list-panes --json --all"),
    ])
}
fn bounded_text(row: &serde_json::Value, key: &str) -> Option<String> {
    // Titles and tab names are host-controlled text shown in Jump To: drop control characters and bound them.
    Some(
        row[key]
            .as_str()?
            .chars()
            .filter(|character| !character.is_control())
            .take(200)
            .collect(),
    )
}
fn parse_tree(tabs: &str, panes: &str) -> Result<ZellijTree> {
    let invalid = || SshError::new("zellij_protocol", "Zellij returned an unreadable tree");
    let id = |row: &serde_json::Value, key: &str| {
        row[key]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
    };
    let tab_rows: Vec<serde_json::Value> = serde_json::from_str(tabs).map_err(|_| invalid())?;
    let pane_rows: Vec<serde_json::Value> = serde_json::from_str(panes).map_err(|_| invalid())?;
    if tab_rows.len() > MAX_TABS || pane_rows.len() > MAX_PANES {
        return Err(invalid());
    }
    let mut tabs = tab_rows
        .iter()
        .map(|row| {
            Ok(ZellijTreeTab {
                id: id(row, "tab_id").ok_or_else(invalid)?,
                position: id(row, "position")
                    .filter(|position| (*position as usize) < MAX_TABS)
                    .ok_or_else(invalid)?,
                name: bounded_text(row, "name").ok_or_else(invalid)?,
                active: row["active"].as_bool().ok_or_else(invalid)?,
                panes: Vec::new(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    for row in &pane_rows {
        // Plugin panes (bars, link) and suppressed ones are not places to jump to.
        if row["is_plugin"].as_bool().ok_or_else(invalid)? || row["is_suppressed"] == true {
            continue;
        }
        let tab = id(row, "tab_id").ok_or_else(invalid)?;
        let pane = ZellijPane {
            id: id(row, "id").ok_or_else(invalid)?,
            title: bounded_text(row, "title").ok_or_else(invalid)?,
            focused: row["is_focused"].as_bool().ok_or_else(invalid)?,
        };
        // A tab closed between the two reads has no row; its panes go with it.
        if let Some(tab) = tabs.iter_mut().find(|candidate| candidate.id == tab) {
            tab.panes.push(pane);
        }
    }
    tabs.sort_by_key(|tab| tab.position);
    Ok(ZellijTree { tabs })
}
#[tauri::command]
pub async fn zellij_tree(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    access: AccessLease,
) -> crate::ssh::AccessResult<ZellijTree> {
    access
        .run(async {
            let [tabs, panes] = tree_commands(&name)?;
            let session = state.session(&session_id).await?;
            let tabs = crate::ssh::exec_for_access(&session, tabs, &access).await?;
            let panes = crate::ssh::exec_for_access(&session, panes, &access).await?;
            parse_tree(&tabs, &panes)
        })
        .await
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
            tabs_command("a'$(touch nope)").unwrap(),
            "zellij --session='a'\\''$(touch nope)' action list-tabs --json"
        );
    }
    fn tab(id: u32, position: u32, active: bool) -> String {
        format!(
            r#"{{"tab_id":{id},"position":{position},"name":"t{id}","active":{active},"viewport_rows":9}}"#
        )
    }
    fn pane(id: u32, tab: u32, focused: bool, plugin: bool, suppressed: bool) -> String {
        format!(
            r#"{{"id":{id},"tab_id":{tab},"title":"p{id}\u001b[31m","is_focused":{focused},"is_plugin":{plugin},"is_suppressed":{suppressed}}}"#
        )
    }
    #[test]
    fn jumps_to_a_tab_by_id_and_keeps_hostile_session_names_literal() {
        let hostile = "a'$(touch nope);x";
        assert_eq!(
            command(hostile, &ZellijAction::Jump { tab_id: 7 }).unwrap(),
            "zellij --session='a'\\''$(touch nope);x' action go-to-tab-by-id 7"
        );
        let typed: ZellijAction = serde_json::from_str(r#"{"type":"jump","tabId":2}"#).unwrap();
        assert_eq!(
            command("s", &typed).unwrap(),
            "zellij --session='s' action go-to-tab-by-id 2"
        );
        for bad in [
            r#"{"type":"jump","tabId":-1}"#,
            r#"{"type":"jump","tabId":"1; id"}"#,
            r#"{"type":"jump","tabId":1,"paneId":5}"#,
            r#"{"type":"jump"}"#,
        ] {
            assert!(serde_json::from_str::<ZellijAction>(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn reads_the_tree_from_both_listings_and_refuses_anything_else() {
        assert_eq!(
            tree_commands("a'$(touch nope)").unwrap(),
            [
                "zellij --session='a'\\''$(touch nope)' action list-tabs --json --state",
                "zellij --session='a'\\''$(touch nope)' action list-panes --json --all",
            ]
        );
        // Tabs arrive out of order; plugin and suppressed panes and a pane of a vanished tab are not destinations.
        let tabs = format!("[{},{}]", tab(5, 1, true), tab(2, 0, false));
        let panes = format!(
            "[{}]",
            [
                pane(0, 2, false, true, false),
                pane(1, 2, true, false, false),
                pane(4, 5, false, false, false),
                pane(6, 5, true, false, false),
                pane(7, 5, false, false, true),
                pane(9, 99, true, false, false),
            ]
            .join(",")
        );
        let tree = parse_tree(&tabs, &panes).unwrap();
        let summary: Vec<_> = tree
            .tabs
            .iter()
            .map(|tab| {
                (
                    tab.id,
                    tab.position,
                    tab.active,
                    tab.panes
                        .iter()
                        .map(|pane| (pane.id, pane.focused))
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (2, 0, false, vec![(1, true)]),
                (5, 1, true, vec![(4, false), (6, true)])
            ]
        );
        assert_eq!(tree.tabs[0].panes[0].title, "p1[31m");
        assert_eq!(
            serde_json::to_value(&tree.tabs[1]).unwrap()["panes"][1],
            serde_json::json!({"id":6,"title":"p6[31m","focused":true})
        );
        let bad_tab = |row: &str| parse_tree(&format!("[{row}]"), "[]");
        for row in [
            r#"{"position":0,"name":"a","active":true}"#,
            r#"{"tab_id":-1,"position":0,"name":"a","active":true}"#,
            r#"{"tab_id":1,"position":1000,"name":"a","active":true}"#,
            r#"{"tab_id":1,"position":0,"name":3,"active":true}"#,
            r#"{"tab_id":1,"position":0,"name":"a"}"#,
        ] {
            assert_eq!(bad_tab(row).unwrap_err().kind(), "zellij_protocol", "{row}");
        }
        for row in [
            r#"{"id":1,"tab_id":2,"title":"a","is_focused":true}"#,
            r#"{"id":"1","tab_id":2,"title":"a","is_focused":true,"is_plugin":false}"#,
            r#"{"id":1,"tab_id":2,"title":"a","is_plugin":false}"#,
            r#"{"id":1,"tab_id":2,"title":4,"is_focused":true,"is_plugin":false}"#,
        ] {
            assert_eq!(
                parse_tree(&format!("[{}]", tab(2, 0, true)), &format!("[{row}]"))
                    .unwrap_err()
                    .kind(),
                "zellij_protocol",
                "{row}"
            );
        }
        for bad in ["", "{}", "[1]"] {
            assert!(
                parse_tree(bad, "[]").is_err() && parse_tree("[]", bad).is_err(),
                "{bad}"
            );
        }
        let many = |count: usize| {
            format!(
                "[{}]",
                vec![pane(1, 2, false, false, false); count].join(",")
            )
        };
        assert!(parse_tree("[]", &many(MAX_PANES + 1)).is_err());
        assert!(parse_tree("[]", &many(MAX_PANES)).is_ok());
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
        // Jump To's tree: both listings through the product commands, parsed as the app does.
        let [tabs_command, panes_command] = tree_commands(&name).unwrap();
        let read_tree =
            || parse_tree(&run(tabs_command.clone()), &run(panes_command.clone())).unwrap();
        // Zellij flags the tab and the pane it leaves for a moment after the ones it enters, so wait for exactly one.
        let current_tab = || {
            let active: Vec<_> = read_tree()
                .tabs
                .iter()
                .filter(|tab| tab.active)
                .map(|tab| u64::from(tab.id))
                .collect();
            match active[..] {
                [only] => Ok(only),
                _ => Err(format!("active tabs {active:?}")),
            }
        };
        let current_pane = |position: usize| {
            let focused: Vec<_> = read_tree().tabs[position]
                .panes
                .iter()
                .filter(|pane| pane.focused)
                .map(|pane| u64::from(pane.id))
                .collect();
            match focused[..] {
                [only] => Ok(only),
                _ => Err(format!("focused panes {focused:?}")),
            }
        };
        let tree = read_tree();
        assert_eq!(tree.tabs.len(), 2);
        let (home, other) = (&tree.tabs[0], &tree.tabs[1]);
        assert!(home.active && !other.active);
        assert_eq!(other.name, "literal'$(touch nope)");
        let mut home_panes: Vec<_> = home.panes.iter().map(|pane| u64::from(pane.id)).collect();
        home_panes.sort_unstable();
        assert_eq!(home_panes, vec![first.min(second), first.max(second)]);
        assert_eq!(current_pane(0), Ok(second));
        assert_eq!(other.panes.len(), 1);
        let (home_id, other_id, other_pane) =
            (u64::from(home.id), other.id, u64::from(other.panes[0].id));
        // A jump moves the current tab, and the pane that tab last focused becomes the current pane.
        run(command(&name, &ZellijAction::Jump { tab_id: other_id }).unwrap());
        wait("jump to the second tab", &current_tab, &|id| {
            id == u64::from(other_id)
        });
        assert_eq!(current_pane(1), Ok(other_pane));
        run(command(&name, &ZellijAction::Jump { tab_id: home.id }).unwrap());
        wait("jump back to the first tab", &current_tab, &|id| {
            id == home_id
        });
        assert_eq!(current_pane(0), Ok(second));
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
        assert!(!temp.path().join("nope").exists());
        run(format!("zellij kill-session -- {}", quote(&name)));
    }
}
