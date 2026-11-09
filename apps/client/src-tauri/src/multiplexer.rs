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

/// A connection intention, never a renderer-provided executable or shell command.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub kind: MultiplexerKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux_server: Option<String>,
    #[serde(default)]
    pub create_if_missing: bool,
}
impl Entry {
    pub(crate) fn server(&self) -> Result<crate::tmux_server::TmuxServer> {
        if !matches!(self.kind, MultiplexerKind::Tmux) && self.tmux_server.is_some() {
            return Err(SshError::new(
                "invalid_tmux_server",
                "tmux server context is only valid for tmux",
            ));
        }
        crate::tmux_server::TmuxServer::parse(self.tmux_server.as_deref())
    }
    pub(crate) fn validate(&self) -> Result<()> {
        attach_command(self.kind, &self.name)?;
        self.server()?;
        if self.name.trim().is_empty() {
            return Err(SshError::new(
                "invalid_target",
                "Enter a named multiplexer session",
            ));
        }
        if matches!(self.kind, MultiplexerKind::Herdr)
            && (self.name.len() > 64
                || matches!(self.name.as_str(), "." | "..")
                || !self
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
        {
            return Err(SshError::new("invalid_target", "Herdr session names need 1–64 ASCII letters, numbers, periods, underscores or hyphens, excluding . and .."));
        }
        Ok(())
    }
    pub(crate) fn command(&self) -> Result<String> {
        self.validate()?;
        match self.kind {
            MultiplexerKind::Tmux => Ok(format!(
                "{} attach-session -t {}",
                self.server()?.prefix(),
                tmux_arg(&format!("={}", self.name))
            )),
            MultiplexerKind::Zellij if !self.create_if_missing => {
                Ok(format!("zellij attach {}", quote(&self.name)))
            }
            _ => attach_command(self.kind, &self.name),
        }
    }
    fn preflight_command(&self, positive_unix: bool) -> Result<String> {
        self.validate()?;
        let (tool, version) = match self.kind {
            MultiplexerKind::Tmux => ("tmux", "-V"),
            MultiplexerKind::Herdr => ("herdr", "--version"),
            MultiplexerKind::Zellij => ("zellij", "--version"),
        };
        let mut command =
            format!("command -v {tool} >/dev/null 2>&1 && {tool} {version} >/dev/null 2>&1");
        if matches!(self.kind, MultiplexerKind::Tmux) {
            let server = self.server()?;
            let exists = format!(
                "{} has-session -t {} 2>/dev/null",
                server.prefix(),
                tmux_arg(&format!("={}", self.name))
            );
            if self.create_if_missing {
                let create = action_command_for(
                    &TmuxAction::CreateSession {
                        name: self.name.clone(),
                        directory: ".".into(),
                    },
                    &server,
                )?;
                command.push_str(&format!(
                    " && ({exists} || {{ {create} >/dev/null 2>&1; {exists}; }})"
                ));
            } else {
                command.push_str(&format!(" && {exists}"));
            }
        }
        Ok(
            if matches!(self.kind, MultiplexerKind::Herdr) && positive_unix {
                crate::herdr_path::with_path(&command)
            } else {
                format!("sh -c {}", quote(&command))
            },
        )
    }
    pub(crate) async fn prepare(
        &self,
        session: &crate::ssh::Session,
        lease: &AccessLease,
    ) -> Result<()> {
        let unavailable = || {
            SshError::new("multiplexer_unavailable", "Cannot enter the selected multiplexer. Check that it is installed and the named session can be opened.")
        };
        let positive_unix = if matches!(self.kind, MultiplexerKind::Herdr) {
            crate::herdr_path::admit(session, lease).await?
        } else {
            false
        };
        crate::ssh::exec_for_access(session, self.preflight_command(positive_unix)?, lease)
            .await
            .map_err(|error| {
                if error.kind() == "remote_command_failed" {
                    unavailable()
                } else {
                    error
                }
            })?;
        if !self.create_if_missing && !matches!(self.kind, MultiplexerKind::Tmux) {
            let command = match self.kind {
                MultiplexerKind::Herdr => "herdr session list --json",
                MultiplexerKind::Zellij => "zellij list-sessions --short --no-formatting",
                MultiplexerKind::Tmux => unreachable!(),
            };
            let output = crate::ssh::exec_for_access(
                session,
                if matches!(self.kind, MultiplexerKind::Herdr) && positive_unix {
                    crate::herdr_path::with_path(command)
                } else {
                    command.into()
                },
                lease,
            )
            .await?;
            if !persistent_sessions(self.kind, &output)?
                .iter()
                .any(|target| target.name == self.name)
            {
                return Err(unavailable());
            }
        }
        Ok(())
    }
}
// Saved defaults create only their explicitly named target in the default namespace.
pub(crate) fn default_entry_command(kind: MultiplexerKind, value: &str) -> Result<String> {
    Entry {
        kind,
        name: value.into(),
        tmux_server: None,
        create_if_missing: true,
    }
    .preflight_command(false)
}
pub(crate) async fn prepare_default_entry(
    session: &crate::ssh::Session,
    lease: &AccessLease,
    kind: MultiplexerKind,
    value: &str,
) -> Result<()> {
    Entry {
        kind,
        name: value.into(),
        tmux_server: None,
        create_if_missing: true,
    }
    .prepare(session, lease)
    .await
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
            let positive_unix = if matches!(kind, MultiplexerKind::Herdr) {
                crate::herdr_path::admit(&session, &access).await?
            } else {
                false
            };
            persistent_sessions(
                kind,
                &crate::ssh::exec_for_access(
                    &session,
                    if matches!(kind, MultiplexerKind::Herdr) && positive_unix {
                        crate::herdr_path::with_path(command)
                    } else {
                        command.into()
                    },
                    &access,
                )
                .await?,
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
    tools: Vec<Tool>,
    sessions: Vec<MuxSession>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Support {
    Full,
    Degraded,
}
#[derive(Debug, Serialize)]
pub struct Tool {
    kind: MultiplexerKind,
    version: Option<String>,
    support: Support,
    missing: &'static [&'static str],
}

fn numbers(value: &str) -> Option<Vec<u32>> {
    value.split('.').map(|part| part.parse().ok()).collect()
}
/// The one table from `(kind, version line)` to support; untested versions stay degraded.
fn tool(kind: MultiplexerKind, line: &str) -> Tool {
    let (name, missing): (_, &'static [&'static str]) = match kind {
        MultiplexerKind::Tmux => ("tmux", &["jump", "confirmedInput"]),
        MultiplexerKind::Zellij => ("zellij", &["tree", "close", "resize", "launch"]),
        MultiplexerKind::Herdr => (
            "herdr",
            &["create", "launch", "rename", "confirmedInput", "restore"],
        ),
    };
    let version = line.trim().strip_prefix(name).map(str::trim);
    let full = version.is_some_and(|version| match kind {
        // `next-3.6` is a tmux development build; a letter suffix is a patch release.
        MultiplexerKind::Tmux => numbers(
            version
                .strip_prefix("next-")
                .unwrap_or(version)
                .trim_end_matches(|c: char| c.is_ascii_lowercase()),
        )
        .is_some_and(|v| v.len() == 2 && (v[0], v[1]) >= (3, 4)),
        MultiplexerKind::Zellij => {
            numbers(version).is_some_and(|v| v.len() == 3 && v[..2] == [0, 45] && v[2] >= 1)
        }
        MultiplexerKind::Herdr => numbers(version)
            .is_some_and(|v| v.len() == 3 && v[..2] == [0, 9] && (3..=5).contains(&v[2])),
    });
    Tool {
        kind,
        version: version
            .filter(|v| !v.is_empty() && v.len() <= 64 && !v.chars().any(char::is_control))
            .map(str::to_owned),
        support: if full {
            Support::Full
        } else {
            Support::Degraded
        },
        missing: if full { &[] } else { missing },
    }
}
// A Windows OpenSSH login shell (PowerShell or cmd) cannot parse the POSIX discovery script.
fn host_shell(error: SshError) -> SshError {
    let message = error.message();
    if error.kind() == "remote_command_failed"
        && [
            "ParserError",
            "Missing '(' after 'if'",
            "is not recognized as",
            "was unexpected at this time",
        ]
        .iter()
        .any(|marker| message.contains(marker))
    {
        SshError::new(
            "unsupported_host_shell",
            "This host's login shell is not POSIX sh (for example PowerShell or cmd), so lazysh cannot read its multiplexers",
        )
    } else {
        error
    }
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
fn discovery_command(server: &crate::tmux_server::TmuxServer, positive_unix: bool) -> String {
    let tmux = server.prefix();
    // Version commands only print; none of them starts a server.
    let probe = |tool: &str, version: &str| {
        format!("if command -v {tool} >/dev/null 2>&1; then printf '{tool}\\t1\\t%s\\n' \"$({tool} {version} 2>/dev/null | head -n 1)\"; else printf '{tool}\\t0\\n'; fi")
    };
    let herdr = crate::herdr_path::select(&probe("herdr", "--version"), positive_unix);
    format!("{}; {herdr}; {}; if command -v tmux >/dev/null 2>&1 && {tmux} has-session 2>/dev/null; then {tmux} list-panes -a -F {}; fi", probe("tmux", "-V"), probe("zellij", "--version"), quote(PANE_FORMAT))
}

fn parse_tree(output: &str) -> Result<MultiplexerTree> {
    let mut lines = output.lines();
    let mut tools = Vec::new();
    let mut available = |kind: MultiplexerKind, name: &str| -> Result<bool> {
        let line = lines.next().unwrap_or_default();
        match line
            .strip_prefix(name)
            .and_then(|rest| rest.strip_prefix('\t'))
        {
            Some("0") => Ok(false),
            Some(found) if found.starts_with("1\t") => {
                tools.push(tool(kind, &found[2..]));
                Ok(true)
            }
            _ => Err(SshError::new(
                "invalid_output",
                "Invalid multiplexer discovery response",
            )),
        }
    };
    let tmux_available = available(MultiplexerKind::Tmux, "tmux")?;
    let herdr_available = available(MultiplexerKind::Herdr, "herdr")?;
    let zellij_available = available(MultiplexerKind::Zellij, "zellij")?;
    let mut tree = MultiplexerTree {
        tmux_available,
        herdr_available,
        zellij_available,
        tools,
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
            let output = crate::ssh::exec_for_access(
                &session,
                discovery_command(&server, crate::herdr_path::admit(&session, &access).await?),
                &access,
            )
            .await
            .map_err(host_shell)?;
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
    #[test]
    fn typed_entry_keeps_namespace_and_creation_policy_without_a_command_interface() {
        let entry: Entry = serde_json::from_value(
            serde_json::json!({"kind":"tmux","name":"work 'literal;","tmuxServer":"named 'server"}),
        )
        .unwrap();
        assert!(!entry.create_if_missing);
        let command = entry.command().unwrap();
        assert!(command.contains("tmux -u -L 'named '\\''server'"));
        assert!(entry
            .preflight_command(false)
            .unwrap()
            .contains("has-session"));
        assert!(!entry
            .preflight_command(false)
            .unwrap()
            .contains("new-session"));
        let zellij: Entry =
            serde_json::from_value(serde_json::json!({"kind":"zellij","name":"existing"})).unwrap();
        assert_eq!(zellij.command().unwrap(), "zellij attach 'existing'");
        for invalid in [
            serde_json::json!({"kind":"herdr","name":"work","tmuxServer":"other"}),
            serde_json::json!({"kind":"tmux","name":"work","tmuxServer":"/tmp/socket"}),
            serde_json::json!({"kind":"herdr","name":"../other"}),
            serde_json::json!({"kind":"zellij","name":"--option"}),
        ] {
            assert!(serde_json::from_value::<Entry>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
        assert!(serde_json::from_value::<Entry>(
            serde_json::json!({"kind":"herdr","name":"work","command":"arbitrary"})
        )
        .is_err());
    }
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
        let tree = parse_tree("tmux\t1\ttmux 3.4\nherdr\t0\nzellij\t1\tzellij 0.45.1\n$0\twork\t@2\t0\tagent\t1\t%4\t0\t1\tclaude\t/work\n$0\twork\t@2\t0\tagent\t1\t%5\t1\t0\tzsh\t/work\n").unwrap();
        assert_eq!(tree.sessions[0].windows[0].panes.len(), 2);
        assert_eq!(tree.sessions[0].windows[0].panes[1].id, "%5");
        assert!(parse_tree("tmux\t1\ttmux 3.4\nherdr\t0\nzellij\t0\nmalformed\n").is_err());
        assert!(parse_tree(
            "tmux\t1\ttmux 3.4\nherdr\t0\nzellij\t0\n$0\twork\t@2\t0\tagent\t1\t%4x\t0\t1\tzsh\t/work\n"
        )
        .is_err());
    }
    #[test]
    fn real_version_outputs_map_to_support_levels() {
        use MultiplexerKind::*;
        for (kind, line, version, support) in [
            (Tmux, "tmux 3.2a", Some("3.2a"), Support::Degraded),
            (Tmux, "tmux 3.3a", Some("3.3a"), Support::Degraded),
            (Tmux, "tmux 3.4", Some("3.4"), Support::Full),
            (Tmux, "tmux 3.5a", Some("3.5a"), Support::Full),
            (Tmux, "tmux next-3.6", Some("next-3.6"), Support::Full),
            (Tmux, "garbage", None, Support::Degraded),
            (Tmux, "", None, Support::Degraded),
            (Zellij, "zellij 0.45.1", Some("0.45.1"), Support::Full),
            (Zellij, "zellij 0.44.3", Some("0.44.3"), Support::Degraded),
            (Herdr, "herdr 0.9.3", Some("0.9.3"), Support::Full),
            (Herdr, "herdr 0.9.5", Some("0.9.5"), Support::Full),
            (Herdr, "herdr 0.8.2", Some("0.8.2"), Support::Degraded),
            (Herdr, "herdr \u{1b}[31m0.9.5", None, Support::Degraded),
        ] {
            let tool = tool(kind, line);
            assert_eq!(
                (tool.version.as_deref(), tool.support),
                (version, support),
                "{line}"
            );
            assert_eq!(tool.missing.is_empty(), support == Support::Full, "{line}");
        }
        assert_eq!(tool(Tmux, "tmux 3.2a").missing, ["jump", "confirmedInput"]);
        let tree = parse_tree("tmux\t1\ttmux 3.2a\nherdr\t0\nzellij\t1\tzellij 0.45.1\n").unwrap();
        assert_eq!(
            serde_json::to_value(&tree).unwrap()["tools"],
            serde_json::json!([
                {"kind":"tmux","version":"3.2a","support":"degraded","missing":["jump","confirmedInput"]},
                {"kind":"zellij","version":"0.45.1","support":"full","missing":[]}
            ])
        );
        // The pre-version format is not accepted as a version-less success.
        assert!(parse_tree("tmux\t1\nherdr\t0\nzellij\t0\n").is_err());
    }
    #[test]
    fn non_posix_login_shells_are_reported_as_unsupported_host_shells() {
        let powershell = "At line:1 char:3\r\n+ if command -v tmux >/dev/null 2>&1; then printf 'tmux\\t1\\t%s\\n' ...\r\n+   ~\r\nMissing '(' after 'if' in if statement.\r\n    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\r\n    + FullyQualifiedErrorId : NoOpenParenthesisAfterIf";
        let pwsh = "ParserError: \nLine |\n   1 |  if command -v tmux >/dev/null 2>&1; then printf 'tmux\\t1\\t%s\\n' \"$(tmux -V 2>/dev/null | head -n 1)\"; …\n     |    ~\n     | Missing '(' after 'if' in if statement.";
        let cmd = "-v was unexpected at this time.";
        for message in [powershell, pwsh, cmd] {
            assert_eq!(
                host_shell(SshError::new("remote_command_failed", message)).kind(),
                "unsupported_host_shell"
            );
        }
        for error in [
            SshError::new("remote_command_failed", "sh: 1: tmux: Permission denied"),
            SshError::new("timeout", "ParserError"),
        ] {
            let kind = error.kind();
            assert_eq!(host_shell(error).kind(), kind);
        }
    }
    #[cfg(unix)]
    #[test]
    fn discovery_script_reports_installed_versions_without_starting_a_server() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let tools = tempfile::tempdir().unwrap();
        let calls = tools.path().join("calls");
        for (name, body) in [
            (
                "tmux",
                "case \"$*\" in -V) echo 'tmux 3.2a';; *has-session*) exit 1;; *) exit 9;; esac",
            ),
            ("zellij", "echo 'zellij 0.45.1'"),
        ] {
            let path = tools.path().join(name);
            std::fs::write(
                &path,
                format!(
                    "#!/bin/sh\nprintf '%s %s\\n' {name} \"$*\" >> {}\n{body}\n",
                    quote(calls.to_str().unwrap())
                ),
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        for name in ["sh", "head"] {
            let real = Command::new("/bin/sh")
                .args(["-c", &format!("command -v {name}")])
                .output()
                .unwrap();
            std::os::unix::fs::symlink(
                String::from_utf8(real.stdout).unwrap().trim(),
                tools.path().join(name),
            )
            .unwrap();
        }
        let output = Command::new("/bin/sh")
            .args([
                "-c",
                &discovery_command(&crate::tmux_server::TmuxServer::Default, false),
            ])
            .env_clear()
            .env("PATH", tools.path())
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        let tree =
            serde_json::to_value(parse_tree(&String::from_utf8(output.stdout).unwrap()).unwrap())
                .unwrap();
        assert_eq!(
            (
                &tree["tmuxAvailable"],
                &tree["herdrAvailable"],
                &tree["zellijAvailable"]
            ),
            (
                &serde_json::json!(true),
                &serde_json::json!(false),
                &serde_json::json!(true)
            )
        );
        assert_eq!(tree["tools"][0]["version"], "3.2a");
        assert_eq!(tree["tools"][0]["support"], "degraded");
        assert_eq!(tree["tools"][1]["support"], "full");
        assert_eq!(
            std::fs::read_to_string(calls).unwrap(),
            "tmux -V\nzellij --version\ntmux -u -L default has-session\n"
        );
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
            parse_tree(&format!("tmux\t1\t\nherdr\t0\nzellij\t0\n{rows}")).unwrap()
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
