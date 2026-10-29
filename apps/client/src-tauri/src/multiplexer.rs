use crate::app_lock::AccessLease;
use crate::ssh::{quote, AppState, Result, SshError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MultiplexerKind {
    Tmux,
    Herdr,
    Zellij,
}
#[derive(Debug, Serialize)]
pub struct PersistentSession {
    name: String,
}
pub(crate) fn tmux_arg(value: &str) -> String {
    // tmux parses a trailing semicolon again after the remote shell has parsed argv.
    match value.strip_suffix(';') {
        Some(prefix) => quote(&format!("{prefix}\\;")),
        None => quote(value),
    }
}

pub(crate) fn attach_command(kind: MultiplexerKind, value: &str) -> Result<String> {
    text(value, 200)?;
    Ok(match kind {
        MultiplexerKind::Tmux => {
            format!(
                "{} attach-session -t {}",
                crate::tmux_server::TmuxServer::Default.prefix(),
                tmux_arg(&format!("={value}"))
            )
        }
        MultiplexerKind::Herdr => format!("herdr --session {}", quote(value)),
        MultiplexerKind::Zellij => {
            if value.starts_with('-') {
                return Err(SshError::new(
                    "invalid_target",
                    "Zellij session names must not begin with a dash",
                ));
            }
            format!("zellij attach --create {}", quote(value))
        }
    })
}

// Default entry creates only the explicitly named target in the default namespace.
pub(crate) fn default_entry_command(kind: MultiplexerKind, value: &str) -> Result<String> {
    attach_command(kind, value)?;
    if value.trim().is_empty() {
        return Err(SshError::new(
            "invalid_target",
            "Enter a named default multiplexer session",
        ));
    }
    // The pinned Herdr CLI uses these names as private session directories.
    if matches!(kind, MultiplexerKind::Herdr)
        && (value.len() > 64
            || matches!(value, "." | "..")
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
    {
        return Err(SshError::new("invalid_target","Herdr session names need 1–64 ASCII letters, numbers, periods, underscores or hyphens, excluding . and .."));
    }
    let (tool, version) = match kind {
        MultiplexerKind::Tmux => ("tmux", "-V"),
        MultiplexerKind::Herdr => ("herdr", "--version"),
        MultiplexerKind::Zellij => ("zellij", "--version"),
    };
    let mut command =
        format!("command -v {tool} >/dev/null 2>&1 && {tool} {version} >/dev/null 2>&1");
    if matches!(kind, MultiplexerKind::Tmux) {
        let server = crate::tmux_server::TmuxServer::Default;
        let create = action_command_for(
            &TmuxAction::CreateSession {
                name: value.into(),
                directory: ".".into(),
            },
            &server,
        )?;
        let exists = format!(
            "{} has-session -t {} 2>/dev/null",
            server.prefix(),
            tmux_arg(&format!("={value}"))
        );
        // A competing creator is accepted only after checking this exact name.
        command.push_str(&format!(
            " && ({exists} || {{ {create} >/dev/null 2>&1; {exists}; }})"
        ));
    }
    Ok(format!("sh -c {}", quote(&command)))
}
pub(crate) async fn prepare_default_entry(
    session: &crate::ssh::Session,
    lease: &AccessLease,
    kind: MultiplexerKind,
    value: &str,
) -> Result<()> {
    let command = default_entry_command(kind, value)?;
    crate::ssh::exec_for_access(session,command,lease).await.map(|_|()).map_err(|error| {
        if error.kind()=="remote_command_failed" {SshError::new("multiplexer_unavailable","Cannot enter the selected multiplexer. Check that it is installed and the named session can be opened.")} else {error}
    })
}

fn persistent_sessions(kind: MultiplexerKind, output: &str) -> Result<Vec<PersistentSession>> {
    let names: Vec<String> = match kind {
        MultiplexerKind::Herdr => {
            #[derive(Deserialize)]
            struct Sessions {
                sessions: Vec<HerdrSession>,
            }
            #[derive(Deserialize)]
            struct HerdrSession {
                name: String,
                running: bool,
            }
            serde_json::from_str::<Sessions>(output)?
                .sessions
                .into_iter()
                .filter(|s| s.running)
                .map(|s| s.name)
                .collect()
        }
        MultiplexerKind::Zellij => output.lines().map(str::to_owned).collect(),
        MultiplexerKind::Tmux => {
            return Err(SshError::new(
                "invalid_target",
                "Use the tmux workspace tree",
            ))
        }
    };
    if names.len() > 1000 {
        return Err(SshError::new(
            "output_too_large",
            "More than 1000 multiplexer sessions",
        ));
    }
    names
        .into_iter()
        .map(|value| {
            text(&value, 200)?;
            Ok(PersistentSession { name: value })
        })
        .collect()
}

#[tauri::command]
pub async fn multiplexer_sessions(
    state: State<'_, AppState>,
    session_id: String,
    kind: MultiplexerKind,
    access: AccessLease,
) -> crate::ssh::AccessResult<Vec<PersistentSession>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            let command = match kind {
                MultiplexerKind::Herdr => "herdr session list --json",
                MultiplexerKind::Zellij => "zellij list-sessions --short --no-formatting",
                MultiplexerKind::Tmux => {
                    return Err(SshError::new(
                        "invalid_target",
                        "Use the tmux workspace tree",
                    ))
                }
            };
            persistent_sessions(
                kind,
                &crate::ssh::exec_for_access(&session, command.into(), &access).await?,
            )
        })
        .await
}

const PANE_FORMAT: &str = "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiplexerTree {
    tmux_available: bool,
    herdr_available: bool,
    zellij_available: bool,
    sessions: Vec<MuxSession>,
}
#[derive(Debug, Serialize)]
pub struct MuxSession {
    id: String,
    name: String,
    windows: Vec<MuxWindow>,
}
#[derive(Debug, Serialize)]
pub struct MuxWindow {
    id: String,
    index: u32,
    name: String,
    active: bool,
    panes: Vec<MuxPane>,
}
#[derive(Debug, Serialize)]
pub struct MuxPane {
    id: String,
    index: u32,
    active: bool,
    command: String,
    path: String,
}

fn id(value: &str, prefix: char) -> Result<()> {
    if !value.starts_with(prefix)
        || value.len() < 2
        || !value[1..].bytes().all(|b| b.is_ascii_digit())
        || value.len() > 20
    {
        return Err(SshError::new(
            "invalid_target",
            "Invalid multiplexer target",
        ));
    }
    Ok(())
}
pub(crate) fn validate_text(value: &str, max: usize, message: &str) -> Result<()> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(SshError::new("invalid_target", message));
    }
    Ok(())
}
fn text(value: &str, max: usize) -> Result<()> {
    validate_text(value, max, "Enter nonempty text without control characters")
}

fn name(value: &str) -> Result<()> {
    text(value, 200)?;
    if value.contains([':', '.']) {
        return Err(SshError::new(
            "invalid_target",
            "tmux session names cannot contain colons or periods",
        ));
    }
    Ok(())
}
fn discovery_command(server: &crate::tmux_server::TmuxServer) -> String {
    let tmux = server.prefix();
    format!("for tool in tmux herdr zellij; do if command -v \"$tool\" >/dev/null 2>&1; then printf '%s\\t1\\n' \"$tool\"; else printf '%s\\t0\\n' \"$tool\"; fi; done; if command -v tmux >/dev/null 2>&1 && {tmux} has-session 2>/dev/null; then {tmux} list-panes -a -F {}; fi", quote(PANE_FORMAT))
}
fn parse_tree(output: &str) -> Result<MultiplexerTree> {
    let mut lines = output.lines();
    let mut available = |tool| -> Result<bool> {
        match lines.next() {
            Some(line) if line == format!("{tool}\t1") => Ok(true),
            Some(line) if line == format!("{tool}\t0") => Ok(false),
            _ => Err(SshError::new(
                "invalid_output",
                "Invalid multiplexer discovery response",
            )),
        }
    };
    let mut tree = MultiplexerTree {
        tmux_available: available("tmux")?,
        herdr_available: available("herdr")?,
        zellij_available: available("zellij")?,
        sessions: Vec::new(),
    };
    for (index, line) in lines.enumerate() {
        if index >= 4096 {
            return Err(SshError::new(
                "output_too_large",
                "More than 4096 multiplexer panes",
            ));
        }
        let f = line.split('\t').collect::<Vec<_>>();
        if f.len() != 11 {
            return Err(SshError::new(
                "invalid_output",
                "Multiplexer names or paths contain unsupported control characters",
            ));
        }
        id(f[0], '$')?;
        id(f[2], '@')?;
        id(f[6], '%')?;
        let number = |value: &str| {
            value
                .parse::<u32>()
                .map_err(|_| SshError::new("invalid_output", "Invalid multiplexer index"))
        };
        let active = |value| match value {
            "0" => Ok(false),
            "1" => Ok(true),
            _ => Err(SshError::new(
                "invalid_output",
                "Invalid multiplexer active state",
            )),
        };
        let si = tree
            .sessions
            .iter()
            .position(|s| s.id == f[0])
            .unwrap_or_else(|| {
                tree.sessions.push(MuxSession {
                    id: f[0].into(),
                    name: f[1].into(),
                    windows: Vec::new(),
                });
                tree.sessions.len() - 1
            });
        let session = &mut tree.sessions[si];
        let wi = session
            .windows
            .iter()
            .position(|w| w.id == f[2])
            .unwrap_or_else(|| {
                session.windows.push(MuxWindow {
                    id: f[2].into(),
                    index: 0,
                    name: f[4].into(),
                    active: false,
                    panes: Vec::new(),
                });
                session.windows.len() - 1
            });
        let window = &mut session.windows[wi];
        window.index = number(f[3])?;
        window.active = active(f[5])?;
        if window.panes.iter().any(|p| p.id == f[6]) {
            return Err(SshError::new(
                "invalid_output",
                "Duplicate multiplexer pane",
            ));
        }
        window.panes.push(MuxPane {
            id: f[6].into(),
            index: number(f[7])?,
            active: active(f[8])?,
            command: f[9].into(),
            path: f[10].into(),
        });
    }
    Ok(tree)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum TmuxAction {
    CreateSession {
        name: String,
        directory: String,
    },
    RenameSession {
        target: String,
        name: String,
    },
    CreateWindow {
        target: String,
        name: String,
        directory: String,
    },
    RenameWindow {
        target: String,
        name: String,
    },
    SelectWindow {
        target: String,
    },
    SelectPane {
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
#[cfg(test)]
fn action_command(action: &TmuxAction) -> Result<String> {
    action_command_for(action, &crate::tmux_server::TmuxServer::Default)
}
pub(crate) fn action_command_for(
    action: &TmuxAction,
    server: &crate::tmux_server::TmuxServer,
) -> Result<String> {
    let quote = |value: &str| tmux_arg(&value.replace('#', "##"));
    let directory = |value: &str| -> Result<String> {
        text(value, 4096)?;
        Ok(quote(value))
    };
    let command = match action {
        TmuxAction::CreateSession {
            name: value,
            directory: path,
        } => {
            name(value)?;
            format!("new-session -d -s {} -c {}", quote(value), directory(path)?)
        }
        TmuxAction::RenameSession {
            target,
            name: value,
        } => {
            id(target, '$')?;
            name(value)?;
            format!("rename-session -t {} {}", quote(target), quote(value))
        }
        TmuxAction::CreateWindow {
            target,
            name: value,
            directory: path,
        } => {
            id(target, '$')?;
            text(value, 200)?;
            format!(
                "new-window -d -t {} -n {} -c {}",
                quote(target),
                quote(value),
                directory(path)?
            )
        }
        TmuxAction::RenameWindow {
            target,
            name: value,
        } => {
            id(target, '@')?;
            text(value, 200)?;
            format!("rename-window -t {} {}", quote(target), quote(value))
        }
        TmuxAction::SelectWindow { target } => {
            id(target, '@')?;
            format!("select-window -t {}", quote(target))
        }
        TmuxAction::SelectPane { target } => {
            id(target, '%')?;
            format!("select-pane -t {}", quote(target))
        }
        TmuxAction::SplitPane {
            target,
            horizontal,
            directory: path,
        } => {
            id(target, '%')?;
            format!(
                "split-window -d {} -t {} -c {}",
                if *horizontal { "-h" } else { "-v" },
                quote(target),
                directory(path)?
            )
        }
        TmuxAction::ZoomPane { target } => {
            id(target, '%')?;
            format!("resize-pane -Z -t {}", quote(target))
        }
    };
    Ok(format!("{} {command}", server.prefix()))
}

#[tauri::command]
pub async fn multiplexer_tree(
    state: State<'_, AppState>,
    session_id: String,
    tmux_server: Option<String>,
    access: AccessLease,
) -> crate::ssh::AccessResult<MultiplexerTree> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            let server =
                crate::tmux_server::TmuxServer::for_session(&session, tmux_server.as_deref())?;
            let output =
                crate::ssh::exec_for_access(&session, discovery_command(&server), &access).await?;
            parse_tree(&output)
        })
        .await
}
// All multiplexer actions share the same immutable access lease through dispatch.
pub(crate) async fn execute_action(
    state: &AppState,
    access: &AccessLease,
    session_id: &str,
    command: Result<String>,
) -> Result<()> {
    let command = command?;
    let session = state.session(session_id).await?;
    crate::ssh::exec_for_access(&session, command, access).await?;
    Ok(())
}

#[tauri::command]
pub async fn tmux_action(
    state: State<'_, AppState>,
    session_id: String,
    action: TmuxAction,
    tmux_server: Option<String>,
    access: AccessLease,
) -> crate::ssh::AccessResult<()> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            let server =
                crate::tmux_server::TmuxServer::for_session(&session, tmux_server.as_deref())?;
            let command = action_command_for(&action, &server)?;
            crate::ssh::exec_for_access(&session, command, &access).await?;
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn default_entry_refuses_missing_and_unrunnable_tools_before_attachment() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let tools = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/bin/sh", tools.path().join("sh")).unwrap();
        for (kind, tool) in [
            (MultiplexerKind::Tmux, "tmux"),
            (MultiplexerKind::Herdr, "herdr"),
            (MultiplexerKind::Zellij, "zellij"),
        ] {
            let command = default_entry_command(kind, "literal-session").unwrap();
            let run = || {
                Command::new("/bin/sh")
                    .args(["-c", &command])
                    .env_clear()
                    .env("PATH", tools.path())
                    .output()
                    .unwrap()
            };
            assert!(!run().status.success(), "missing {tool} must fail");
            let binary = tools.path().join(tool);
            std::fs::write(&binary, "#!/bin/sh\nexit 70\n").unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert!(!run().status.success(), "unrunnable {tool} must fail");
            std::fs::remove_file(binary).unwrap();
        }
        assert!(default_entry_command(MultiplexerKind::Tmux, "bad:name").is_err());
        assert!(default_entry_command(MultiplexerKind::Tmux, "bad.name").is_err());
        assert!(default_entry_command(MultiplexerKind::Zellij, "--flag").is_err());
    }
    #[test]
    fn parses_exact_ids_and_refuses_ambiguous_output() {
        let tree = parse_tree("tmux\t1\nherdr\t0\nzellij\t1\n$0\twork\t@2\t0\tagent\t1\t%4\t0\t1\tclaude\t/work\n$0\twork\t@2\t0\tagent\t1\t%5\t1\t0\tzsh\t/work\n").unwrap();
        assert_eq!(tree.sessions[0].windows[0].panes.len(), 2);
        assert_eq!(tree.sessions[0].windows[0].panes[1].id, "%5");
        assert!(parse_tree("tmux\t1\nherdr\t0\nzellij\t1\nmalformed\n").is_err());
        assert!(parse_tree(
            "tmux\t1\nherdr\t0\nzellij\t1\n$0\twork\t@2\t0\tagent\t1\t%4x\t0\t1\tzsh\t/work\n"
        )
        .is_err());
    }
    #[test]
    fn validates_targets_and_quotes_names_and_format_directories() {
        assert_eq!(
            attach_command(MultiplexerKind::Zellij, "named").unwrap(),
            "zellij attach --create 'named'"
        );
        assert!(attach_command(MultiplexerKind::Zellij, "--bad").is_err());
        let sessions = persistent_sessions(MultiplexerKind::Herdr, r#"{"sessions":[{"name":"running","running":true},{"name":"stopped","running":false}]}"#).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "running");
        assert!(action_command(&TmuxAction::SelectPane {
            target: "%1;kill-server".into()
        })
        .is_err());
        assert!(action_command(&TmuxAction::CreateSession {
            name: "x\n".into(),
            directory: ".".into()
        })
        .is_err());
        let command = action_command(&TmuxAction::CreateSession {
            name: "a'$(touch nope)".into(),
            directory: "/work/#(touch nope)".into(),
        })
        .unwrap();
        assert_eq!(
            command,
            "tmux -u -L 'default' new-session -d -s 'a'\\''$(touch nope)' -c '/work/##(touch nope)'"
        );
    }
    #[test]
    #[ignore = "requires tmux on PATH; runs an isolated temporary server"]
    fn real_tmux_lifecycle_and_literal_names() {
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("tmux.sock");
        let run = |command: String| {
            let command = command.replacen(
                "tmux ",
                &format!("tmux -f /dev/null -S {} ", quote(socket.to_str().unwrap())),
                1,
            );
            lazysh_common::test_support::successful_output(
                Command::new("sh").arg("-c").arg(command).env_remove("TMUX"),
            )
        };
        let read_tree = || {
            let rows = run(format!("tmux list-panes -a -F {}", quote(PANE_FORMAT)));
            parse_tree(&format!("tmux\t1\nherdr\t0\nzellij\t0\n{rows}")).unwrap()
        };
        struct Server(std::path::PathBuf);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = Command::new("tmux")
                    .arg("-S")
                    .arg(&self.0)
                    .arg("kill-server")
                    .output();
            }
        }
        let _server = Server(socket.clone());
        let directory = temp.path().to_str().unwrap().to_owned();
        let name = "literal'$(touch nope)#(printf bad);".to_owned();
        run(action_command(&TmuxAction::CreateSession {
            name: name.clone(),
            directory: directory.clone(),
        })
        .unwrap());
        let tree = read_tree();
        assert_eq!(tree.sessions[0].name, name);
        assert!(!temp.path().join("nope").exists());
        let session = tree.sessions[0].id.clone();
        let pane = tree.sessions[0].windows[0].panes[0].id.clone();
        run(action_command(&TmuxAction::SplitPane {
            target: pane.clone(),
            horizontal: true,
            directory: directory.clone(),
        })
        .unwrap());
        run(action_command(&TmuxAction::ZoomPane {
            target: pane.clone(),
        })
        .unwrap());
        run(action_command(&TmuxAction::SelectPane { target: pane }).unwrap());
        run(action_command(&TmuxAction::CreateWindow {
            target: session.clone(),
            name: "second".into(),
            directory,
        })
        .unwrap());
        run(action_command(&TmuxAction::RenameSession {
            target: session,
            name: "renamed".into(),
        })
        .unwrap());
        let tree = read_tree();
        assert_eq!(tree.sessions[0].name, "renamed");
        assert_eq!(tree.sessions[0].windows.len(), 2);
        let window = &tree.sessions[0].windows[1].id;
        run(action_command(&TmuxAction::RenameWindow {
            target: window.clone(),
            name: "new #{session_name} title;".into(),
        })
        .unwrap());
        run(action_command(&TmuxAction::SelectWindow {
            target: window.clone(),
        })
        .unwrap());
        let tree = read_tree();
        assert_eq!(
            tree.sessions[0].windows[1].name,
            "new #{session_name} title;"
        );
    }
}
