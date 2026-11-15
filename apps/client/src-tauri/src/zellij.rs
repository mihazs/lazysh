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
    NextTab,
    PreviousTab,
    NextPane,
    PreviousPane,
    /// The terminal pane a notification names, by the number Zellij exports in `ZELLIJ_PANE_ID`. It takes several host calls (see `focus_pane`), so `zellij_action` runs it and `command` has no single line for it.
    FocusPane {
        pane: u32,
    },
    NewPane {
        horizontal: bool,
        directory: String,
    },
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
        ZellijAction::CloseTab { id } => vec!["close-tab-by-id".into(), id.to_string()],
        // `--` keeps a name that starts with a dash a name, not an option.
        ZellijAction::RenameTab { id, name } => vec![
            "rename-tab-by-id".into(),
            id.to_string(),
            "--".into(),
            text(name, 200)?,
        ],
        ZellijAction::NextTab => vec!["go-to-next-tab".into()],
        ZellijAction::PreviousTab => vec!["go-to-previous-tab".into()],
        ZellijAction::NextPane => vec!["focus-next-pane".into()],
        ZellijAction::PreviousPane => vec!["focus-previous-pane".into()],
        ZellijAction::FocusPane { .. } => {
            return Err(SshError::new(
                "invalid_target",
                "Focus a pane through its own host calls",
            ))
        }
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
/// The terminal pane the attached client has focused: the first row of `list-clients` (`CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND`).
fn client_focus(listing: &str) -> Option<u32> {
    listing
        .lines()
        .nth(1)?
        .split_whitespace()
        .nth(1)?
        .strip_prefix("terminal_")?
        .parse()
        .ok()
}
/// Focuses one terminal pane of the attached terminal. Zellij's own `action focus-pane-id` does not: from the command line
/// it moves the focus of the command's own client, which no terminal shows (measured on 0.46.0: the attached client keeps
/// its pane and tab). So this reads the pane's tab, goes to that tab, and steps `focus-next-pane` until the attached client
/// reports the pane, waiting for each change because Zellij applies a command asynchronously.
/// shortcut: the first attached client is the one read, and a tab where `focus-next-pane` does not reach the pane (a zoomed
/// or hidden floating pane) ends in `zellij_pane_unreachable` after one turn of the tab; upgrade when Zellij focuses an
/// attached client's pane from the command line.
async fn focus_pane<F, Fut>(session: &str, pane: u32, run: F) -> Result<()>
where
    F: Fn(Cmd) -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    let call = |args: &[&str]| {
        session_command(session, args.iter().map(|arg| (*arg).to_owned()).collect()).map(&run)
    };
    let focus = || async { Ok::<_, SshError>(client_focus(&call(&["list-clients"])?.await?)) };
    // Zellij applies a command asynchronously: wait for the focus to leave `before`.
    let settle = |before: Option<u32>| async move {
        let mut now = before;
        for _ in 0..25 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            now = focus().await?;
            if now != before {
                break;
            }
        }
        Ok::<_, SshError>(now)
    };
    let protocol = || SshError::new("zellij_protocol", "Zellij returned an unreadable pane list");
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(&call(&["list-panes", "--json"])?.await?).map_err(|_| protocol())?;
    let terminals = || {
        rows.iter()
            .filter(|row| row["is_plugin"] == false && row["is_suppressed"] != true)
    };
    let tab_of = |id: u32| {
        terminals()
            .find(|row| row["id"] == id)
            .and_then(|row| row["tab_position"].as_u64())
    };
    let tab = tab_of(pane)
        .ok_or_else(|| SshError::new("zellij_pane_gone", "Zellij has no pane with that number"))?;
    let mut now = focus().await?;
    if now.and_then(tab_of) != Some(tab) {
        // `go-to-tab` counts tabs from 1.
        call(&["go-to-tab", &(tab + 1).to_string()])?.await?;
        now = settle(now).await?;
    }
    for _ in 0..terminals().filter(|row| row["tab_position"] == tab).count() {
        if now == Some(pane) {
            return Ok(());
        }
        call(&["focus-next-pane"])?.await?;
        now = settle(now).await?;
    }
    if now == Some(pane) {
        Ok(())
    } else {
        Err(SshError::new(
            "zellij_pane_unreachable",
            "Zellij could not focus that pane",
        ))
    }
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
            if let ZellijAction::FocusPane { pane } = action {
                let host = Host::resolve(&state, &local, &session_id, &access).await?;
                return focus_pane(&name, pane, |cmd| {
                    let (host, access) = (&host, &access);
                    async move { host.run(access, &cmd).await }
                })
                .await;
            }
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
    /// Zellij as `focus_pane` sees it: tabs of terminal panes in `focus-next-pane` order, the attached client's focus, and a command that takes effect only at the second `list-clients` after it (Zellij applies commands asynchronously).
    struct FakeZellij {
        tabs: Vec<Vec<u32>>,
        focus: Vec<usize>,
        active: usize,
        attached: bool,
        pending: Option<(String, u8)>,
        calls: Vec<String>,
    }
    impl FakeZellij {
        fn new(tabs: Vec<Vec<u32>>) -> Self {
            let focus = vec![0; tabs.len()];
            Self {
                tabs,
                focus,
                active: 0,
                attached: true,
                pending: None,
                calls: Vec::new(),
            }
        }
        fn focused(&self) -> u32 {
            self.tabs[self.active][self.focus[self.active]]
        }
        fn run(&mut self, command: &str) -> Result<String> {
            let verb = command
                .split(" action ")
                .nth(1)
                .expect("an action")
                .to_owned();
            self.calls.push(verb.clone());
            match verb.as_str() {
                "list-panes --json" => {
                    let mut rows = vec![
                        r#"{"id":0,"is_plugin":true,"is_suppressed":true,"tab_position":0}"#
                            .to_owned(),
                    ];
                    for (tab, panes) in self.tabs.iter().enumerate() {
                        rows.extend(panes.iter().map(|id| format!(r#"{{"id":{id},"is_plugin":false,"is_suppressed":false,"tab_position":{tab}}}"#)));
                    }
                    Ok(format!("[{}]", rows.join(",")))
                }
                "list-clients" => {
                    if let Some((action, wait)) = self.pending.take() {
                        if wait > 0 {
                            self.pending = Some((action, wait - 1));
                        } else if let Some(index) = action.strip_prefix("go-to-tab ") {
                            self.active = index.parse::<usize>().unwrap() - 1;
                        } else {
                            self.focus[self.active] =
                                (self.focus[self.active] + 1) % self.tabs[self.active].len();
                        }
                    }
                    Ok(if self.attached {
                        format!("CLIENT_ID  ZELLIJ_PANE_ID RUNNING_COMMAND\n1          terminal_{}     N/A\n", self.focused())
                    } else {
                        "CLIENT_ID  ZELLIJ_PANE_ID RUNNING_COMMAND\n".into()
                    })
                }
                "focus-next-pane" => {
                    self.pending = Some((verb, 1));
                    Ok(String::new())
                }
                _ if verb.starts_with("go-to-tab ") => {
                    self.pending = Some((verb, 1));
                    Ok(String::new())
                }
                other => Err(SshError::new("fake", format!("unexpected {other}"))),
            }
        }
    }
    async fn focus_fake(
        fake: &std::cell::RefCell<FakeZellij>,
        session: &str,
        pane: u32,
    ) -> Result<()> {
        focus_pane(session, pane, |command| {
            let output = fake.borrow_mut().run(&command.render());
            async move { output }
        })
        .await
    }
    #[tokio::test(start_paused = true)]
    async fn focuses_a_pane_in_another_tab_and_in_the_same_tab_with_the_host_taking_its_time() {
        let fake = std::cell::RefCell::new(FakeZellij::new(vec![vec![0, 1], vec![2, 3, 4]]));
        // A hostile session name stays one literal word of every host command.
        focus_fake(&fake, "a'$(touch nope)", 4).await.unwrap();
        assert_eq!((fake.borrow().active, fake.borrow().focused()), (1, 4));
        assert!(fake.borrow().calls.contains(&"go-to-tab 2".to_owned()));
        assert!(!fake
            .borrow()
            .calls
            .iter()
            .any(|call| call.contains("focus-pane-id")));
        focus_fake(&fake, "work", 3).await.unwrap();
        focus_fake(&fake, "work", 1).await.unwrap();
        assert_eq!((fake.borrow().active, fake.borrow().focused()), (0, 1));
        // The pane the attached client already shows is left alone: no command changes the focus.
        let calls = fake.borrow().calls.len();
        focus_fake(&fake, "work", 1).await.unwrap();
        assert_eq!(
            fake.borrow().calls[calls..],
            ["list-panes --json", "list-clients"]
        );
    }
    #[tokio::test(start_paused = true)]
    async fn refuses_a_pane_that_has_gone_and_gives_up_on_a_client_that_never_moves() {
        let fake = std::cell::RefCell::new(FakeZellij::new(vec![vec![0, 1], vec![2]]));
        let error = focus_fake(&fake, "work", 9).await.unwrap_err();
        assert_eq!(error.kind(), "zellij_pane_gone");
        assert!(!fake
            .borrow()
            .calls
            .iter()
            .any(|call| call.starts_with("focus") || call.starts_with("go-to")));
        // No attached client reports a pane, so nothing can be focused: the call ends instead of cycling for ever.
        fake.borrow_mut().attached = false;
        let error = focus_fake(&fake, "work", 2).await.unwrap_err();
        assert_eq!(error.kind(), "zellij_pane_unreachable");
        assert!(
            fake.borrow().calls.len() < 80,
            "{}",
            fake.borrow().calls.len()
        );
        // A pane list that is not JSON is a protocol error, not a guess.
        let error = focus_pane("work", 1, |_| async { Ok("not json".to_owned()) })
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "zellij_protocol");
    }
    #[test]
    fn reads_the_attached_clients_pane_and_takes_no_action_shape_from_the_client() {
        let listing = |row: &str| format!("CLIENT_ID  ZELLIJ_PANE_ID RUNNING_COMMAND\n{row}\n");
        assert_eq!(
            client_focus(&listing("1          terminal_12     N/A")),
            Some(12)
        );
        for bad in [
            "",
            "CLIENT_ID  ZELLIJ_PANE_ID RUNNING_COMMAND\n",
            &listing("1  plugin_3  N/A"),
            &listing("1  terminal_x  N/A"),
            &listing("1  terminal_-1  N/A"),
        ] {
            assert_eq!(client_focus(bad), None, "{bad:?}");
        }
        // A pane number is an unsigned integer: a name, a negative or a plugin-style id never reaches the host.
        for bad in [
            r#"{"type":"focusPane","pane":-1}"#,
            r#"{"type":"focusPane","pane":"terminal_1;id"}"#,
            r#"{"type":"focusPane"}"#,
            r#"{"type":"focusPane","pane":1,"extra":true}"#,
        ] {
            assert!(serde_json::from_str::<ZellijAction>(bad).is_err(), "{bad}");
        }
        assert!(serde_json::from_str::<ZellijAction>(r#"{"type":"focusPane","pane":7}"#).is_ok());
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
        // A notification names the pane by number; the attached client (not `list-panes`, which marks a pane focused for the command's own client too) must show it.
        let number = |id: u64| u32::try_from(id).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let focus_by_number = |pane: u64| {
            runtime.block_on(focus_pane(&name, number(pane), |command| {
                let output = execute(command.render());
                async move {
                    if output.status.success() {
                        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
                    } else {
                        Err(SshError::new(
                            "zellij",
                            String::from_utf8_lossy(&output.stderr),
                        ))
                    }
                }
            }))
        };
        let attached_pane = || {
            client_focus(&run(format!(
                "zellij --session={} action list-clients",
                quote(&name)
            )))
            .map(u64::from)
        };
        focus_by_number(first).unwrap();
        assert_eq!(attached_pane(), Some(first));
        // A pane that has gone changes nothing.
        assert_eq!(
            focus_by_number(9999).unwrap_err().kind(),
            "zellij_pane_gone"
        );
        assert_eq!(attached_pane(), Some(first));
        focus_by_number(second).unwrap();
        assert_eq!(attached_pane(), Some(second));
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
        // A pane in another tab is focused too: its tab comes forward with it.
        let other_tab_pane = query("list-panes")
            .unwrap()
            .as_array()
            .and_then(|panes| {
                panes.iter().find(|pane| {
                    pane["is_plugin"] == false
                        && pane["tab_position"] == 1
                        && pane["is_suppressed"] != true
                })
            })
            .and_then(|pane| pane["id"].as_u64())
            .expect("the second tab has a terminal pane");
        focus_by_number(other_tab_pane).unwrap();
        assert_eq!(attached_pane(), Some(other_tab_pane));
        assert_eq!(wait("focus in another tab", &active_tab, &|_| true), 1);
        focus_by_number(first).unwrap();
        assert_eq!(attached_pane(), Some(first));
        assert_eq!(
            wait("focus back in the first tab", &active_tab, &|_| true),
            0
        );
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
        run(format!("zellij kill-session -- {}", quote(&name)));
    }
}
