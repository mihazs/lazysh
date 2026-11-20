use crate::app_lock::AccessLease;
use crate::host::{Cmd, Host};
use crate::local::LocalState;
use crate::ssh::{AppState, Result, SshError};
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
    /// By the tab's stable id from `list-tabs`, never by position: a tab that moved or went since the strip read is refused, not guessed.
    CloseTab {
        id: u32,
    },
    RenameTab {
        id: u32,
        name: String,
    },
    /// By the terminal pane's number from `list-panes` (`--pane-id terminal_N`), never the focused pane: a pane that went since the list was read is refused by Zellij.
    ClosePane {
        target: u32,
    },
    RenamePane {
        target: u32,
        name: String,
    },
    /// Moves the pane's divider toward `direction`. A Zellij resize has no cell count (it is a fixed step), so `amount` repeats the step.
    ResizePane {
        target: u32,
        direction: ResizeDirection,
        amount: u32,
    },
    RenameSession {
        name: String,
    },
    /// Ends the whole session and forgets it: every pane and program in it stops.
    CloseSession,
    NextTab,
    PreviousTab,
    NextPane,
    PreviousPane,
    NewPane {
        horizontal: bool,
        directory: String,
    },
    ZoomPane,
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResizeDirection {
    Left,
    Right,
    Up,
    Down,
}
const MAX_RESIZE_STEPS: u32 = 50;
fn text(value: &str, max: usize) -> Result<String> {
    crate::multiplexer::validate_text(value, max, "Invalid Zellij name or path")?;
    Ok(value.to_owned())
}
fn pane_id(target: u32) -> String {
    format!("terminal_{target}")
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
        ZellijAction::CloseTab { id } => vec!["close-tab-by-id".into(), id.to_string()],
        // `--` keeps a name that starts with a dash a name, not an option.
        ZellijAction::RenameTab { id, name } => vec![
            "rename-tab-by-id".into(),
            id.to_string(),
            "--".into(),
            text(name, 200)?,
        ],
        ZellijAction::ClosePane { target } => {
            vec!["close-pane".into(), "--pane-id".into(), pane_id(*target)]
        }
        ZellijAction::RenamePane { target, name } => vec![
            "rename-pane".into(),
            "--pane-id".into(),
            pane_id(*target),
            "--".into(),
            text(name, 200)?,
        ],
        ZellijAction::RenameSession { name } => {
            vec!["rename-session".into(), "--".into(), text(name, 200)?]
        }
        ZellijAction::ResizePane {
            target,
            direction,
            amount,
        } => {
            if !(1..=MAX_RESIZE_STEPS).contains(amount) {
                return Err(SshError::new("invalid_target", "Resize by 1 to 50 steps"));
            }
            vec![
                "resize".into(),
                "increase".into(),
                match direction {
                    ResizeDirection::Left => "left",
                    ResizeDirection::Right => "right",
                    ResizeDirection::Up => "up",
                    ResizeDirection::Down => "down",
                }
                .into(),
                "--pane-id".into(),
                pane_id(*target),
            ]
        }
        // Not an `action`. `kill-session` alone leaves a session older than the serialization interval listed as EXITED, so it
        // would come back in the session list and `attach` would resurrect it; `delete-session --force` kills a running
        // session and removes that record. `--` keeps a name that starts with a dash a name.
        ZellijAction::CloseSession => {
            return Ok(Cmd::new(
                &[],
                &[
                    "zellij",
                    "delete-session",
                    "--force",
                    "--",
                    &text(session, 200)?,
                ],
            ))
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
                id: row["tab_id"].as_u64().and_then(|id| u32::try_from(id).ok()),
            })
        })
        .collect()
}
/// One terminal pane as `zellij action list-panes --json --all` reports it. `id` is the number `--pane-id terminal_N` takes; plugin panes (the bars) have a separate numbering and are not listed.
#[derive(Debug, PartialEq, Serialize)]
pub struct ZellijPane {
    id: u32,
    title: String,
    command: String,
    tab: String,
    focused: bool,
    columns: u32,
    rows: u32,
}
const MAX_PANES: usize = 5000;
fn panes_command(session: &str) -> Result<Cmd> {
    session_command(
        session,
        vec!["list-panes".into(), "--json".into(), "--all".into()],
    )
}
fn parse_panes(output: &str) -> Result<Vec<ZellijPane>> {
    let invalid = || SshError::new("zellij_protocol", "Zellij returned an unreadable pane list");
    let rows: Vec<serde_json::Value> = serde_json::from_str(output).map_err(|_| invalid())?;
    if rows.len() > MAX_PANES {
        return Err(invalid());
    }
    // Titles, commands and tab names are host-controlled text shown in the panel: drop control characters and bound them.
    let bounded = |value: &serde_json::Value| -> Option<String> {
        Some(
            value
                .as_str()?
                .chars()
                .filter(|character| !character.is_control())
                .take(200)
                .collect(),
        )
    };
    let number = |value: &serde_json::Value| value.as_u64().and_then(|n| u32::try_from(n).ok());
    let mut panes = Vec::new();
    for row in &rows {
        if row["is_plugin"].as_bool().ok_or_else(invalid)? || row["is_suppressed"] == true {
            continue;
        }
        panes.push(ZellijPane {
            id: number(&row["id"]).ok_or_else(invalid)?,
            title: bounded(&row["title"]).ok_or_else(invalid)?,
            command: bounded(&row["pane_command"]).unwrap_or_default(),
            tab: bounded(&row["tab_name"]).unwrap_or_default(),
            focused: row["is_focused"].as_bool().ok_or_else(invalid)?,
            columns: number(&row["pane_columns"]).ok_or_else(invalid)?,
            rows: number(&row["pane_rows"]).ok_or_else(invalid)?,
        });
    }
    Ok(panes)
}
#[tauri::command]
pub async fn zellij_panes(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    name: String,
    access: AccessLease,
) -> crate::ssh::AccessResult<Vec<ZellijPane>> {
    access
        .run(async {
            let command = panes_command(&name)?;
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            parse_panes(&host.run(&access, &command).await?)
        })
        .await
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
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            let command = command?;
            // A Zellij resize has no cell count (it is one fixed step), so `amount` runs the step that many times.
            for _ in 0..match &action {
                ZellijAction::ResizePane { amount, .. } => *amount,
                _ => 1,
            } {
                host.run(&access, &command).await?;
            }
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
    fn closes_and_renames_a_tab_by_stable_id_with_a_literal_name() {
        assert_eq!(
            command("work", &ZellijAction::CloseTab { id: 7 })
                .unwrap()
                .render(),
            "zellij '--session=work' action close-tab-by-id 7"
        );
        assert_eq!(
            command(
                "work",
                &ZellijAction::RenameTab {
                    id: 7,
                    name: "-x';$(touch nope)".into()
                }
            )
            .unwrap()
            .render(),
            "zellij '--session=work' action rename-tab-by-id 7 -- '-x'\\'';$(touch nope)'"
        );
        assert!(command(
            "work",
            &ZellijAction::RenameTab {
                id: 7,
                name: "a\nb".into()
            }
        )
        .is_err());
        // A negative or fractional id is not a tab id: the command layer takes only an unsigned integer.
        for bad in [
            r#"{"type":"closeTab","id":-1}"#,
            r#"{"type":"closeTab","id":"1;id"}"#,
            r#"{"type":"closeTab"}"#,
            r#"{"type":"closeTab","id":1,"extra":true}"#,
        ] {
            assert!(serde_json::from_str::<ZellijAction>(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn closes_renames_and_resizes_one_named_pane_with_literal_text() {
        let hostile = "a'$(touch nope);x";
        let quoted = "'a'\\''$(touch nope);x'";
        let session = "'--session=a'\\''$(touch nope);x'";
        let command = |action| command(hostile, &action).unwrap().render();
        assert_eq!(
            command(ZellijAction::ClosePane { target: 12 }),
            format!("zellij {session} action close-pane --pane-id terminal_12")
        );
        assert_eq!(
            command(ZellijAction::RenamePane {
                target: 3,
                name: "-x';$(touch nope)".into()
            }),
            format!("zellij {session} action rename-pane --pane-id terminal_3 -- '-x'\\'';$(touch nope)'")
        );
        assert_eq!(
            command(ZellijAction::RenameSession {
                name: "-new';$(touch nope)".into()
            }),
            format!("zellij {session} action rename-session -- '-new'\\'';$(touch nope)'")
        );
        assert_eq!(
            command(ZellijAction::CloseSession),
            format!("zellij delete-session --force -- {quoted}")
        );
        // A Zellij resize has no cell count: one command is one step, and `zellij_action` runs it `amount` times.
        let step = |direction: &str| {
            format!("zellij {session} action resize increase {direction} --pane-id terminal_4")
        };
        for (direction, word) in [
            (ResizeDirection::Left, "left"),
            (ResizeDirection::Right, "right"),
            (ResizeDirection::Up, "up"),
            (ResizeDirection::Down, "down"),
        ] {
            assert_eq!(
                command(ZellijAction::ResizePane {
                    target: 4,
                    direction,
                    amount: 1
                }),
                step(word)
            );
        }
        assert_eq!(
            command(ZellijAction::ResizePane {
                target: 4,
                direction: ResizeDirection::Right,
                amount: 3
            }),
            step("right")
        );
        for amount in [0, MAX_RESIZE_STEPS + 1] {
            assert!(
                super::command(
                    "work",
                    &ZellijAction::ResizePane {
                        target: 4,
                        direction: ResizeDirection::Up,
                        amount
                    }
                )
                .is_err(),
                "{amount}"
            );
        }
        for action in [
            ZellijAction::RenamePane {
                target: 1,
                name: "".into(),
            },
            ZellijAction::RenamePane {
                target: 1,
                name: "a\nb".into(),
            },
            ZellijAction::RenameSession { name: "".into() },
            ZellijAction::RenameSession {
                name: "a\nb".into(),
            },
        ] {
            assert!(super::command("work", &action).is_err(), "{action:?}");
        }
        assert!(super::command("a\nb", &ZellijAction::CloseSession).is_err());
        // The bridge takes only an unsigned pane number, the four directions and no extra fields.
        for ok in [
            r#"{"type":"closePane","target":1}"#,
            r#"{"type":"renamePane","target":1,"name":"x"}"#,
            r#"{"type":"resizePane","target":1,"direction":"left","amount":2}"#,
            r#"{"type":"renameSession","name":"x"}"#,
            r#"{"type":"closeSession"}"#,
        ] {
            assert!(serde_json::from_str::<ZellijAction>(ok).is_ok(), "{ok}");
        }
        for bad in [
            r#"{"type":"closePane","target":-1}"#,
            r#"{"type":"closePane","target":"terminal_1;id"}"#,
            r#"{"type":"closePane"}"#,
            r#"{"type":"closePane","target":1,"force":true}"#,
            r#"{"type":"resizePane","target":1,"direction":"sideways","amount":2}"#,
            r#"{"type":"resizePane","target":1,"direction":"left","amount":-1}"#,
        ] {
            assert!(serde_json::from_str::<ZellijAction>(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn lists_terminal_panes_from_the_json_the_cli_prints_and_refuses_anything_else() {
        let panes = parse_panes(
            r#"[
            {"id":2,"is_plugin":true,"is_suppressed":false,"title":"tab-bar","is_focused":false,"pane_columns":50,"pane_rows":1},
            {"id":0,"is_plugin":false,"is_suppressed":false,"title":"build\u001b[31m","pane_command":"/bin/sh -c make","tab_name":"Tab #1","is_focused":true,"pane_columns":25,"pane_rows":48},
            {"id":1,"is_plugin":false,"title":"Pane #2","is_focused":false,"pane_columns":25,"pane_rows":48},
            {"id":4,"is_plugin":false,"is_suppressed":true,"title":"hidden","is_focused":false,"pane_columns":1,"pane_rows":1}
        ]"#,
        )
        .unwrap();
        assert_eq!(
            panes,
            vec![
                ZellijPane {
                    id: 0,
                    title: "build[31m".into(),
                    command: "/bin/sh -c make".into(),
                    tab: "Tab #1".into(),
                    focused: true,
                    columns: 25,
                    rows: 48
                },
                // A Zellij that reports no command or tab for a pane still lists it.
                ZellijPane {
                    id: 1,
                    title: "Pane #2".into(),
                    command: String::new(),
                    tab: String::new(),
                    focused: false,
                    columns: 25,
                    rows: 48
                },
            ]
        );
        assert_eq!(
            parse_panes(&format!(
                r#"[{{"id":0,"is_plugin":false,"title":"{}","is_focused":true,"pane_columns":1,"pane_rows":1}}]"#,
                "n".repeat(300)
            ))
            .unwrap()[0]
                .title
                .len(),
            200
        );
        for bad in [
            "",
            "{}",
            "[1]",
            r#"[{"id":-1,"is_plugin":false,"title":"a","is_focused":true,"pane_columns":1,"pane_rows":1}]"#,
            r#"[{"id":0,"title":"a","is_focused":true,"pane_columns":1,"pane_rows":1}]"#,
            r#"[{"id":0,"is_plugin":false,"title":3,"is_focused":true,"pane_columns":1,"pane_rows":1}]"#,
            r#"[{"id":0,"is_plugin":false,"title":"a","pane_columns":1,"pane_rows":1}]"#,
            r#"[{"id":0,"is_plugin":false,"title":"a","is_focused":true,"pane_rows":1}]"#,
            r#"[{"id":0,"is_plugin":false,"title":"a","is_focused":true,"pane_columns":"wide","pane_rows":1}]"#,
        ] {
            assert_eq!(
                parse_panes(bad).unwrap_err().kind(),
                "zellij_protocol",
                "{bad}"
            );
        }
        let many = format!(
            "[{}]",
            vec![r#"{"id":0,"is_plugin":true,"title":"a","is_focused":false}"#; MAX_PANES + 1]
                .join(",")
        );
        assert!(parse_panes(&many).is_err());
        assert_eq!(
            panes_command("a'$(touch nope)").unwrap().render(),
            "zellij '--session=a'\\''$(touch nope)' action list-panes --json --all"
        );
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
        let first_tab_attempts = std::sync::atomic::AtomicUsize::new(0);
        until("the first tab", || async {
            let observed = tabs().await;
            let ready = observed.as_ref().is_some_and(|tabs| {
                tabs.len() == 1 && tabs.iter().any(|tab| tab.active && tab.position == 0)
            });
            if !ready
                && first_tab_attempts.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 249
            {
                let summary = observed.as_ref().map(|tabs| {
                    (
                        tabs.len(),
                        tabs.iter().filter(|tab| tab.active).count(),
                        tabs.iter().any(|tab| tab.active && tab.position == 0),
                    )
                });
                eprintln!(
                    "Zellij first-tab final observation (total, active, first active): {summary:?}"
                );
            }
            observed.filter(|_| ready)
        })
        .await;
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
        // Shared, so a session the test renames is still the one torn down on a panic.
        struct Server(std::sync::Arc<std::sync::Mutex<String>>, std::path::PathBuf);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = Command::new("zellij")
                    .args(["delete-session", "--force", "--", &self.0.lock().unwrap()])
                    .env("XDG_RUNTIME_DIR", &self.1)
                    .env("XDG_CACHE_HOME", &self.1)
                    .env("XDG_CONFIG_HOME", &self.1)
                    .output();
            }
        }
        let live_name = std::sync::Arc::new(std::sync::Mutex::new(name.clone()));
        let server = Server(live_name.clone(), temp.path().to_path_buf());
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
        // Layout actions, each read back from the panes the product parses. The panes sit side by side here, before the zoom.
        let (first_pane, second_pane) = (first as u32, second as u32);
        let read_panes = |session: &str| -> std::result::Result<Vec<ZellijPane>, String> {
            let output = execute(panes_command(session).unwrap().render());
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned());
            }
            parse_panes(&String::from_utf8_lossy(&output.stdout))
                .map_err(|error| error.message().to_owned())
        };
        let columns = |id: u32| -> std::result::Result<u64, String> {
            read_panes(&name)?
                .iter()
                .find(|pane| pane.id == id)
                .map(|pane| u64::from(pane.columns))
                .ok_or_else(|| format!("pane {id} is not listed"))
        };
        let (left, right) = (
            wait("first pane geometry", &|| columns(first_pane), &|c| c > 0),
            wait("second pane geometry", &|| columns(second_pane), &|c| c > 0),
        );
        run(command(
            &name,
            &ZellijAction::RenamePane {
                target: first_pane,
                name: "-build';$(touch nope)".into(),
            },
        )
        .unwrap()
        .render());
        let titled = || {
            Ok(u64::from(read_panes(&name)?.iter().any(|pane| {
                pane.id == first_pane && pane.title == "-build';$(touch nope)"
            })))
        };
        wait("renamed pane by id", &titled, &|found| found == 1);
        // Rename acts on the pane it names, not the focused one: of the two panes the second keeps its focus and its title.
        let panes = read_panes(&name).unwrap();
        let focused: Vec<_> = panes
            .iter()
            .filter(|pane| pane.focused && [first_pane, second_pane].contains(&pane.id))
            .map(|pane| pane.id)
            .collect();
        assert_eq!(focused, [second_pane]);
        assert_ne!(
            panes
                .iter()
                .find(|pane| pane.id == second_pane)
                .unwrap()
                .title,
            "-build';$(touch nope)"
        );
        // One step moves the divider toward the direction: the first pane widens by what the second loses.
        run(command(
            &name,
            &ZellijAction::ResizePane {
                target: first_pane,
                direction: ResizeDirection::Right,
                amount: 1,
            },
        )
        .unwrap()
        .render());
        let widened = wait("first pane widened", &|| columns(first_pane), &|c| c > left);
        assert_eq!(
            wait("second pane narrowed", &|| columns(second_pane), &|c| c
                < right),
            right - (widened - left)
        );
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
        .unwrap()
        .render());
        let renamed_second = || {
            let tabs = query("list-tabs")?;
            Ok(u64::from(tabs.as_array().is_some_and(|tabs| {
                tabs.iter()
                    .any(|tab| tab["tab_id"] == second && tab["name"] == "-renamed';$(touch nope)")
            })))
        };
        wait("renamed tab by id", &renamed_second, &|found| found == 1);
        // Rename and close act on the tab they name, not the focused one: the first tab is still active.
        assert_eq!(wait("first tab still focused", &active_tab, &|_| true), 0);
        run(command(&name, &ZellijAction::CloseTab { id: second })
            .unwrap()
            .render());
        let tab_count = || {
            Ok(query("list-tabs")?
                .as_array()
                .map_or(0, |tabs| tabs.len() as u64))
        };
        wait("closed tab by id", &tab_count, &|count| count == 1);
        assert_eq!(wait("first tab kept", &active_tab, &|_| true), 0);
        // The tab is gone: Zellij ignores its stable id (it never falls back to a position), so the remaining tab is untouched.
        execute(
            command(&name, &ZellijAction::CloseTab { id: second })
                .unwrap()
                .render(),
        );
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(tab_count().unwrap(), 1);
        assert_eq!(active_tab().unwrap(), 0);
        assert!(!temp.path().join("nope").exists());
        // Close the second pane by its number: the first stays, with the name it was given.
        run(command(
            &name,
            &ZellijAction::ClosePane {
                target: second_pane,
            },
        )
        .unwrap()
        .render());
        let remaining = || {
            let panes = read_panes(&name)?;
            Ok(
                if panes.len() == 1
                    && panes[0].id == first_pane
                    && panes[0].title == "-build';$(touch nope)"
                {
                    1
                } else {
                    0
                },
            )
        };
        wait("closed pane by number", &remaining, &|found| found == 1);
        // A pane that is gone is not guessed at: closing its number again leaves the other pane alone.
        execute(
            command(
                &name,
                &ZellijAction::ClosePane {
                    target: second_pane,
                },
            )
            .unwrap()
            .render(),
        );
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(remaining().unwrap(), 1);
        assert!(!temp.path().join("nope").exists());
        // Rename the session, then close it, each read back from the session list the product parses.
        let sessions = |session_list: &str| -> Vec<String> {
            crate::multiplexer::persistent_sessions(
                crate::multiplexer::MultiplexerKind::Zellij,
                session_list,
            )
            .map(|sessions| {
                serde_json::to_value(sessions)
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|session| session["name"].as_str().unwrap().to_owned())
                    .collect()
            })
            .unwrap()
        };
        let list = || {
            let output = execute("zellij list-sessions --short --no-formatting".into());
            // With no session left Zellij prints that none is active and exits with a failure: an empty list, not an error.
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                output.status.success() || stderr.contains("No active zellij sessions found"),
                "{stderr}"
            );
            sessions(&String::from_utf8_lossy(&output.stdout))
        };
        let renamed = "-renamed session';$(touch nope)";
        run(command(
            &name,
            &ZellijAction::RenameSession {
                name: renamed.into(),
            },
        )
        .unwrap()
        .render());
        *live_name.lock().unwrap() = renamed.into();
        let mut names = Vec::new();
        for _ in 0..250 {
            names = list();
            if names.iter().any(|session| session == renamed) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(names.iter().any(|session| session == renamed), "{names:?}");
        assert!(!names.contains(&name), "{names:?}");
        // The renamed session answers to its new name, and the old one is refused.
        assert_eq!(read_panes(renamed).unwrap().len(), 1);
        assert!(read_panes(&name).is_err());
        run(command(renamed, &ZellijAction::CloseSession)
            .unwrap()
            .render());
        let mut names = vec![renamed.to_owned()];
        for _ in 0..250 {
            names = list();
            if !names.iter().any(|session| session == renamed) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!names.iter().any(|session| session == renamed), "{names:?}");
        assert!(!temp.path().join("nope").exists());
    }
}
