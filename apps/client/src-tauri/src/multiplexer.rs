use crate::app_lock::AccessLease;
use crate::host::{Cmd, Host};
use crate::local::LocalState;
use crate::ssh::{quote, AppState, Result, SshError};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MultiplexerKind {
    Tmux,
    Rmux,
    Herdr,
    Zellij,
}
impl MultiplexerKind {
    /// tmux and rmux share one command stack: attach, tree, actions and `-L` labels.
    pub(crate) fn binary(self) -> Option<crate::tmux_server::Binary> {
        match self {
            Self::Tmux => Some(crate::tmux_server::Binary::Tmux),
            Self::Rmux => Some(crate::tmux_server::Binary::Rmux),
            Self::Herdr | Self::Zellij => None,
        }
    }
    pub(crate) fn is_tmux_family(self) -> bool {
        self.binary().is_some()
    }
}
#[derive(Debug, Serialize)]
pub struct PersistentSession {
    name: String,
}
/// One tmux argument word. tmux parses a trailing semicolon again after the shell, or the
/// process launcher, has split argv.
pub(crate) fn tmux_word(value: &str) -> String {
    match value.strip_suffix(';') {
        Some(prefix) => format!("{prefix}\\;"),
        None => value.to_owned(),
    }
}
pub(crate) fn tmux_arg(value: &str) -> String {
    quote(&tmux_word(value))
}

/// The server-scoped user option that names one tmux server instance. tmux reuses `$0` and `%0` after a server restart,
/// so a close, rename or resize carries the token its confirmation was read under and tmux itself refuses it on a
/// replacement server (#2044). The token is random per read and set only when unset (`set-option -o`), so concurrent
/// reads converge and a replacement server, which never saw it, differs.
const SERVER_TOKEN: &str = "@lazysh_server";
fn server_token(value: &str) -> Result<&str> {
    if value.len() == 32
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(value)
    } else {
        Err(SshError::new(
            "invalid_target",
            "Invalid tmux server identity",
        ))
    }
}
fn fresh_server_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
/// One tmux command string, the words quoted for the server's own parser (single quotes, `#` doubled for tmux's formats;
/// rmux keeps a name as typed).
fn tmux_command_string(binary: crate::tmux_server::Binary, words: &[&str]) -> String {
    words
        .iter()
        .map(|word| format!("'{}'", binary.literal_name(word).replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
}
/// Runs `inner` only on the tmux server that carries `token`; on any other it fails with "can't find pane" and does
/// nothing. The check and the command are one tmux invocation, so a server replaced in between cannot be targeted.
fn fenced(binary: crate::tmux_server::Binary, token: &str, inner: &[&str]) -> Result<Vec<String>> {
    server_token(token)?;
    Ok(vec![
        "if-shell".into(),
        "-F".into(),
        format!("#{{==:#{{{SERVER_TOKEN}}},{token}}}"),
        tmux_command_string(binary, inner),
        "select-pane -t '%lazysh-stale-server'".into(),
    ])
}

const HERDR_SESSIONS: &str = "herdr session list --json";

pub(crate) fn attach_command(kind: MultiplexerKind, value: &str) -> Result<String> {
    text(value, 200)?;
    Ok(match kind {
        MultiplexerKind::Tmux | MultiplexerKind::Rmux => {
            format!(
                "{} attach-session -t {}",
                crate::tmux_server::TmuxServer::default_for(kind.binary().unwrap_or_default())
                    .prefix(),
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
    /// Herdr only: the backend this connection captures; unset keeps whatever it already captured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<crate::herdr_backend::HerdrBackend>,
}
impl Entry {
    pub(crate) fn server(&self) -> Result<crate::tmux_server::TmuxServer> {
        let Some(binary) = self.kind.binary() else {
            if self.tmux_server.is_some() {
                return Err(SshError::new(
                    "invalid_tmux_server",
                    "tmux server context is only valid for tmux and rmux",
                ));
            }
            return Ok(crate::tmux_server::TmuxServer::default());
        };
        crate::tmux_server::TmuxServer::parse_for(binary, self.tmux_server.as_deref())
    }
    pub(crate) fn validate(&self) -> Result<()> {
        attach_command(self.kind, &self.name)?;
        self.server()?;
        if self.backend.is_some_and(|backend| !backend.is_system())
            && !matches!(self.kind, MultiplexerKind::Herdr)
        {
            return Err(SshError::new(
                "invalid_target",
                "Only Herdr has a managed backend",
            ));
        }
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
    /// The attach command as argv, for a local PTY to execute with no shell in between.
    pub(crate) fn argv(&self) -> Result<Vec<String>> {
        self.validate()?;
        if self.backend.is_some_and(|backend| !backend.is_system()) {
            return Err(SshError::new(
                "invalid_target",
                "A local session runs the system Herdr",
            ));
        }
        let server = self.server()?;
        let (name, target) = (tmux_word(&self.name), tmux_word(&format!("={}", self.name)));
        let words = match (self.kind, self.create_if_missing) {
            // `-A` attaches the session when it exists and creates it otherwise.
            (MultiplexerKind::Tmux, true) => {
                vec![
                    "tmux",
                    "-u",
                    "-L",
                    server.label(),
                    "new-session",
                    "-A",
                    "-s",
                    &name,
                ]
            }
            (MultiplexerKind::Tmux, false) => {
                vec![
                    "tmux",
                    "-u",
                    "-L",
                    server.label(),
                    "attach-session",
                    "-t",
                    &target,
                ]
            }
            // shortcut: rmux is attached over SSH only; a local PTY needs its own verified `new-session -A` and Windows story.
            (MultiplexerKind::Rmux, _) => {
                return Err(SshError::new(
                    "invalid_target",
                    "rmux sessions in local terminals are not available yet",
                ))
            }
            (MultiplexerKind::Herdr, _) => vec!["herdr", "--session", &self.name],
            (MultiplexerKind::Zellij, true) => vec!["zellij", "attach", "--create", &self.name],
            (MultiplexerKind::Zellij, false) => vec!["zellij", "attach", &self.name],
        };
        Ok(words.into_iter().map(str::to_owned).collect())
    }
    pub(crate) fn command(&self) -> Result<String> {
        self.validate()?;
        match self.kind {
            MultiplexerKind::Tmux | MultiplexerKind::Rmux => Ok(format!(
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
    fn preflight_command(
        &self,
        backend: crate::herdr_backend::HerdrBackend,
        positive_unix: bool,
    ) -> Result<String> {
        self.validate()?;
        let (tool, version) = match self.kind {
            MultiplexerKind::Tmux => ("tmux", "-V"),
            // rmux is admitted by its capability record, never by `-V` (which prints tmux branding).
            MultiplexerKind::Rmux => ("rmux", "capabilities --json"),
            MultiplexerKind::Herdr => ("herdr", "--version"),
            MultiplexerKind::Zellij => ("zellij", "--version"),
        };
        let mut command =
            format!("command -v {tool} >/dev/null 2>&1 && {tool} {version} >/dev/null 2>&1");
        if self.kind.is_tmux_family() {
            let server = self.server()?;
            let exists = format!(
                "{} has-session -t {} 2>/dev/null",
                server.prefix(),
                tmux_arg(&format!("={}", self.name))
            );
            if self.create_if_missing {
                let create = action_cmd(
                    &TmuxAction::CreateSession {
                        name: self.name.clone(),
                        directory: ".".into(),
                    },
                    &server,
                )?
                .render();
                command.push_str(&format!(
                    " && ({exists} || {{ {create} >/dev/null 2>&1; {exists}; }})"
                ));
            } else {
                command.push_str(&format!(" && {exists}"));
            }
        }
        Ok(
            if matches!(self.kind, MultiplexerKind::Herdr)
                && (positive_unix || !backend.is_system())
            {
                backend.wrap(&command, positive_unix)?
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
        let herdr = matches!(self.kind, MultiplexerKind::Herdr);
        let backend = if herdr {
            crate::herdr_backend::choose(&session.handle, self.backend)?
        } else {
            Default::default()
        };
        let positive_unix = herdr && crate::herdr_path::admit(session, lease).await?;
        crate::ssh::exec_for_access(
            session,
            self.preflight_command(backend, positive_unix)?,
            lease,
        )
        .await
        .map_err(unavailable_if_failed)?;
        if !self.create_if_missing && !self.kind.is_tmux_family() {
            let live = if herdr {
                let output = crate::ssh::exec_for_access(
                    session,
                    backend.wrap(HERDR_SESSIONS, positive_unix)?,
                    lease,
                )
                .await?;
                herdr_live(&output)?
            } else {
                zellij_live(
                    crate::ssh::exec_for_access_status(
                        session,
                        zellij_full_sessions_command().render(),
                        lease,
                    )
                    .await?,
                )?
            };
            if !live.contains(&self.name) {
                return Err(unavailable());
            }
        }
        Ok(())
    }
    /// `prepare` on this device, before a local terminal exists: the tool runs and the named
    /// session can be attached. Argv with no shell in between; a tmux session is checked only
    /// for an attach, as `new-session -A` creates it, and Herdr and Zellij create their own.
    #[cfg(desktop)]
    pub(crate) async fn prepare_local(&self, host: &Host, lease: &AccessLease) -> Result<()> {
        self.validate()?;
        let (tool, version): (_, &[&str]) = match self.kind {
            MultiplexerKind::Tmux => ("tmux", &["-V"]),
            MultiplexerKind::Herdr => ("herdr", &["--version"]),
            MultiplexerKind::Zellij => ("zellij", &["--version"]),
            MultiplexerKind::Rmux => {
                return Err(SshError::new(
                    "invalid_target",
                    "rmux sessions in local terminals are not available yet",
                ))
            }
        };
        let argv = [&[tool], version].concat();
        let probe = Cmd::new(&[], &argv);
        let herdr = matches!(self.kind, MultiplexerKind::Herdr);
        host.run(lease, &if herdr { probe.herdr() } else { probe })
            .await
            .map_err(unavailable_if_failed)?;
        if self.create_if_missing {
            return Ok(());
        }
        let live = match self.kind {
            MultiplexerKind::Tmux => {
                let exists = self.server()?.cmd(&[
                    "has-session",
                    "-t",
                    &tmux_word(&format!("={}", self.name)),
                ]);
                return host
                    .run(lease, &exists)
                    .await
                    .map(drop)
                    .map_err(unavailable_if_failed);
            }
            MultiplexerKind::Herdr => herdr_live(
                &host
                    .run(
                        lease,
                        &Cmd::new(&[], &["herdr", "session", "list", "--json"]).herdr(),
                    )
                    .await?,
            )?,
            _ => zellij_live(
                host.run_status(lease, &zellij_full_sessions_command())
                    .await?,
            )?,
        };
        if live.contains(&self.name) {
            Ok(())
        } else {
            Err(unavailable())
        }
    }
}
fn unavailable() -> SshError {
    SshError::new("multiplexer_unavailable", "Cannot enter the selected multiplexer. Check that it is installed and the named session can be opened.")
}
/// A command that exits non-zero, or cannot start, means the tool or the session is not there;
/// a closed session, a revoked lease or a timeout stays what it is.
fn unavailable_if_failed(error: SshError) -> SshError {
    if error.kind() == "remote_command_failed" {
        unavailable()
    } else {
        error
    }
}
fn herdr_live(output: &str) -> Result<Vec<String>> {
    Ok(persistent_sessions(MultiplexerKind::Herdr, output)?
        .into_iter()
        .map(|target| target.name)
        .collect())
}
/// `--short` also lists a serialized exited session, which `zellij attach` resurrects (#2047).
fn zellij_live(output: crate::ssh::ExecOutput) -> Result<Vec<String>> {
    zellij_live_sessions(&zellij_output(output)?)
}
/// A target that must already exist: reconnect and restore never create it.
pub(crate) fn reattach_entry(kind: MultiplexerKind, value: &str) -> Entry {
    Entry {
        kind,
        name: value.into(),
        tmux_server: None,
        create_if_missing: false,
        backend: None,
    }
}
// Saved defaults create only their explicitly named target in the default namespace.
pub(crate) fn default_entry_command(kind: MultiplexerKind, value: &str) -> Result<String> {
    Entry {
        kind,
        name: value.into(),
        tmux_server: None,
        create_if_missing: true,
        backend: None,
    }
    .preflight_command(Default::default(), false)
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
        backend: None,
    }
    .prepare(session, lease)
    .await
}

/// Names of the live and the exited (resurrectable) Zellij sessions. With no session left Zellij prints
/// "No active zellij sessions found." and exits 1, which is an empty list; any other failure stays one.
fn zellij_sessions_command() -> Cmd {
    Cmd::new(
        &[("LC_ALL", "C")],
        &["zellij", "list-sessions", "--short", "--no-formatting"],
    )
}

fn zellij_full_sessions_command() -> Cmd {
    Cmd::new(
        &[("LC_ALL", "C")],
        &["zellij", "list-sessions", "--no-formatting"],
    )
}

/// The names of the sessions whose server is running, from the unshortened listing. Each line is
/// `<name> [Created <age> ago]`, followed by `(EXITED - attach to resurrect)` for a serialized session without a
/// server; an unrecognised line is an error rather than a guess, so reattach fails closed.
pub(crate) fn zellij_live_sessions(output: &str) -> Result<Vec<String>> {
    let mut live = Vec::new();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let Some(at) = line.rfind(" [Created ") else {
            return Err(SshError::new(
                "invalid_output",
                "Unrecognised Zellij session listing",
            ));
        };
        // The marker follows the `]` that closes the zellij-written age, never the name.
        if !line[at..].contains("(EXITED") {
            live.push(line[..at].to_owned());
        }
    }
    Ok(live)
}

fn zellij_output(output: crate::ssh::ExecOutput) -> Result<String> {
    if output.status == Some(1)
        && output.stdout.is_empty()
        && output.stderr == b"No active zellij sessions found.\n"
    {
        return Ok(String::new());
    }
    output.text()
}

pub(crate) fn persistent_sessions(
    kind: MultiplexerKind,
    output: &str,
) -> Result<Vec<PersistentSession>> {
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
        MultiplexerKind::Tmux | MultiplexerKind::Rmux => {
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
    local: State<'_, LocalState>,
    session_id: String,
    kind: MultiplexerKind,
    access: AccessLease,
) -> crate::ssh::AccessResult<Vec<PersistentSession>> {
    access
        .run(async {
            let host = Host::resolve(&state, &local, &session_id, &access).await?;
            let cmd = match kind {
                MultiplexerKind::Herdr => {
                    Cmd::new(&[], &["herdr", "session", "list", "--json"]).herdr()
                }
                MultiplexerKind::Zellij => zellij_sessions_command(),
                MultiplexerKind::Tmux | MultiplexerKind::Rmux => {
                    return Err(SshError::new(
                        "invalid_target",
                        "Use the tmux workspace tree",
                    ))
                }
            };
            let output = if matches!(kind, MultiplexerKind::Zellij) {
                zellij_output(host.run_status(&access, &cmd).await?)?
            } else {
                host.run(&access, &cmd).await?
            };
            persistent_sessions(kind, &output)
        })
        .await
}

const PANE_FORMAT: &str = "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{@lazysh_server}\t#{pane_width}\t#{pane_height}\t#{pane_title}";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiplexerTree {
    tmux_available: bool,
    herdr_available: bool,
    zellij_available: bool,
    rmux_available: bool,
    tools: Vec<Tool>,
    /// The identity of the tmux server these rows came from (see `SERVER_TOKEN`); destructive actions carry it back.
    #[serde(skip_serializing_if = "Option::is_none")]
    server_token: Option<String>,
    sessions: Vec<MuxSession>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Support {
    Full,
    Degraded,
    /// Present but not admitted; `Tool::reason` says why.
    Unsupported,
}
#[derive(Debug, Serialize)]
pub struct Tool {
    kind: MultiplexerKind,
    version: Option<String>,
    support: Support,
    missing: &'static [&'static str],
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}
/// What `rmux capabilities --json` prints about the installed binary; the daemon is never asked.
#[derive(Deserialize)]
struct RmuxCapabilities {
    version: String,
    binary_contract_version: u32,
    wire_version: u32,
    public_contract: Vec<String>,
    control_mode: RmuxControlMode,
}
#[derive(Deserialize)]
struct RmuxControlMode {
    entrypoint: String,
}
// shortcut: rmux stays Limited until its Jump To control client and confirmed input are verified on a real rmux (#1675).
const RMUX_MISSING: &[&str] = &["jump", "confirmedInput", "history"];
/// Admission from the binary contract and control mode, not from `rmux -V`; `daemon` is `stale` when the running
/// daemon refused this client's protocol, which only a daemon restart fixes.
fn rmux_tool(capabilities: &str, daemon: &str) -> Tool {
    let parsed = serde_json::from_str::<RmuxCapabilities>(capabilities)
        .ok()
        .filter(|rmux| {
            rmux.binary_contract_version == 1
                && rmux
                    .public_contract
                    .iter()
                    .any(|contract| contract == "control-mode")
                && rmux.control_mode.entrypoint == "rmux -C"
                && rmux.wire_version == 8
        });
    let unsupported = |version: Option<String>, reason| Tool {
        kind: MultiplexerKind::Rmux,
        version,
        support: Support::Unsupported,
        missing: &[],
        reason: Some(reason),
    };
    let Some(rmux) = parsed else {
        return unsupported(None, "capabilities");
    };
    let version = Some(rmux.version)
        .filter(|v| !v.is_empty() && v.len() <= 64 && !v.chars().any(char::is_control));
    if daemon == "stale" {
        return unsupported(version, "daemonWire");
    }
    Tool {
        kind: MultiplexerKind::Rmux,
        version,
        support: Support::Degraded,
        missing: RMUX_MISSING,
        reason: None,
    }
}

fn numbers(value: &str) -> Option<Vec<u32>> {
    value.split('.').map(|part| part.parse().ok()).collect()
}
/// The one table from `(kind, version line)` to support; untested versions stay degraded.
fn tool(kind: MultiplexerKind, line: &str) -> Tool {
    if matches!(kind, MultiplexerKind::Rmux) {
        let (capabilities, daemon) = line.rsplit_once('\t').unwrap_or((line, "ok"));
        return rmux_tool(capabilities, daemon);
    }
    let name = match kind {
        MultiplexerKind::Rmux => unreachable!("rmux is admitted by capabilities above"),
        MultiplexerKind::Tmux => "tmux",
        MultiplexerKind::Zellij => "zellij",
        MultiplexerKind::Herdr => "herdr",
    };
    let version = line.trim().strip_prefix(name).map(str::trim);
    let missing: &'static [&'static str] = match kind {
        MultiplexerKind::Rmux => unreachable!("rmux is admitted by capabilities above"),
        MultiplexerKind::Tmux => &["jump", "confirmedInput"],
        // Input to one named pane (`--pane-id`) and the JSON pane list are verified only on the tested 0.45.1.
        // `dump-screen --path` (stdout when omitted) exists from 0.45; older Zellij takes a positional path.
        MultiplexerKind::Zellij
            if version
                .and_then(numbers)
                .is_some_and(|v| v.as_slice() >= [0, 45].as_slice()) =>
        {
            &[
                "tree",
                "rename",
                "close",
                "resize",
                "launch",
                "confirmedInput",
            ]
        }
        MultiplexerKind::Zellij => &[
            "tree",
            "rename",
            "close",
            "resize",
            "launch",
            "confirmedInput",
            "history",
        ],
        MultiplexerKind::Herdr => &[
            "create",
            "launch",
            "rename",
            "confirmedInput",
            "restore",
            "history",
        ],
    };
    let full = version.is_some_and(|version| match kind {
        MultiplexerKind::Rmux => unreachable!("rmux is admitted by capabilities above"),
        // `next-3.6` is a tmux development build; a letter suffix is a patch release.
        MultiplexerKind::Tmux => numbers(
            version
                .strip_prefix("next-")
                .unwrap_or(version)
                .trim_end_matches(|c: char| c.is_ascii_lowercase()),
        )
        .is_some_and(|v| v.len() == 2 && (v[0], v[1]) >= (3, 4)),
        MultiplexerKind::Zellij => numbers(version).is_some_and(|v| v == [0, 45, 1]),
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
        reason: None,
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
    width: u32,
    height: u32,
    title: String,
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
// Version commands only print; none of them starts a server.
fn probe(tool: &str, version: &str) -> String {
    format!("if command -v {tool} >/dev/null 2>&1; then printf '{tool}\\t1\\t%s\\n' \"$({tool} {version} 2>/dev/null | head -n 1)\"; else printf '{tool}\\t0\\n'; fi")
}
/// The chosen Herdr's probe. A managed Herdr that cannot run here reads as absent, never as the system one.
fn herdr_probe(backend: crate::herdr_backend::HerdrBackend, positive_unix: bool) -> String {
    let absent = "printf 'herdr\\t0\\n'";
    backend
        .wrap_or(
            &probe("herdr", "--version"),
            positive_unix,
            &format!("{absent}; exit 0"),
        )
        .unwrap_or_else(|_| absent.into())
}
fn discovery_command(
    server: &crate::tmux_server::TmuxServer,
    backend: crate::herdr_backend::HerdrBackend,
    positive_unix: bool,
) -> String {
    let panes = quote(PANE_FORMAT);
    // rmux is admitted by `capabilities --json`; `-N` and read-only commands never start its daemon. A daemon that refuses this
    // client's protocol is reported as `stale`, which only restarting it fixes.
    let rmux_server = match server.binary() {
        crate::tmux_server::Binary::Rmux => server.clone(),
        crate::tmux_server::Binary::Tmux => {
            crate::tmux_server::TmuxServer::default_for(crate::tmux_server::Binary::Rmux)
        }
    };
    let rmux = rmux_server.probe_prefix();
    let rmux_probe = format!("if command -v rmux >/dev/null 2>&1; then c=$(rmux capabilities --json 2>/dev/null | tr -d '\\r\\n' | head -c 65536); d=ok; if {rmux} list-sessions 2>&1 | grep -Eq 'incompatible protocol|unsupported RMUX wire version'; then d=stale; fi; printf 'rmux\\t1\\t%s\\t%s\\n' \"$c\" \"$d\"; else printf 'rmux\\t0\\n'; fi");
    // Both families name the server first (see `SERVER_TOKEN`), then list its panes; rmux's `-N` never starts a daemon, and where
    // tmux stays quiet about an already named server rmux exits 1, which must not stop the listing.
    let token = fresh_server_token();
    let listing = if matches!(server.binary(), crate::tmux_server::Binary::Rmux) {
        format!("if command -v rmux >/dev/null 2>&1; then {rmux} set-option -s -o -q {SERVER_TOKEN} {token} >/dev/null 2>&1; {rmux} list-panes -a -F {panes} 2>/dev/null || true; fi")
    } else {
        let tmux = server.prefix();
        format!("if command -v tmux >/dev/null 2>&1 && {tmux} has-session 2>/dev/null; then {tmux} set-option -s -o -q {SERVER_TOKEN} {token} && {tmux} list-panes -a -F {panes}; fi")
    };
    format!(
        "{}; {}; {}; {rmux_probe}; {listing}",
        probe("tmux", "-V"),
        herdr_probe(backend, positive_unix),
        probe("zellij", "--version")
    )
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
    let rmux_available = available(MultiplexerKind::Rmux, "rmux")?;
    let mut tree = MultiplexerTree {
        tmux_available,
        herdr_available,
        zellij_available,
        rmux_available,
        tools,
        server_token: None,
        sessions: Vec::new(),
    };
    for (index, line) in lines.enumerate() {
        if index >= 4096 {
            return Err(SshError::new(
                "output_too_large",
                "More than 4096 multiplexer panes",
            ));
        }
        // The title is last and program-set, so a stray tab stays inside it instead of shifting the fields.
        let f = line.splitn(15, '\t').collect::<Vec<_>>();
        if f.len() != 15 {
            return Err(SshError::new(
                "invalid_output",
                "Multiplexer names or paths contain unsupported control characters",
            ));
        }
        id(f[0], '$')?;
        id(f[2], '@')?;
        id(f[6], '%')?;
        // Every row of one read names the same server; an empty token means none could be set.
        if !f[11].is_empty() {
            server_token(f[11])?;
        }
        if index == 0 {
            tree.server_token = (!f[11].is_empty()).then(|| f[11].to_owned());
        } else if tree.server_token.as_deref().unwrap_or("") != f[11] {
            return Err(SshError::new(
                "invalid_output",
                "Inconsistent tmux server identity",
            ));
        }
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
            width: number(f[12])?,
            height: number(f[13])?,
            title: f[14]
                .chars()
                .filter(|c| !c.is_control())
                .take(200)
                .collect(),
        });
    }
    Ok(tree)
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResizeDirection {
    Left,
    Right,
    Up,
    Down,
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
    CloseWindow {
        target: String,
    },
    SelectWindow {
        target: String,
    },
    SelectPane {
        target: String,
    },
    // The four below carry the `serverToken` of the tree the person acted on (see `SERVER_TOKEN`).
    CloseSession {
        target: String,
        server: String,
    },
    ClosePane {
        target: String,
        server: String,
    },
    RenamePane {
        target: String,
        title: String,
        server: String,
    },
    ResizePane {
        target: String,
        direction: ResizeDirection,
        amount: u32,
        server: String,
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
fn action_command_for(
    action: &TmuxAction,
    server: &crate::tmux_server::TmuxServer,
) -> Result<String> {
    Ok(action_cmd(action, server)?.render())
}
#[cfg(test)]
fn action_command(action: &TmuxAction) -> Result<String> {
    action_command_for(action, &crate::tmux_server::TmuxServer::default())
}
pub(crate) fn action_cmd(
    action: &TmuxAction,
    server: &crate::tmux_server::TmuxServer,
) -> Result<Cmd> {
    let binary = server.binary();
    // tmux expands `#` in names as a format, so a literal one is doubled; rmux stores a name as typed.
    let word = |value: &str| tmux_word(&binary.literal_name(value));
    let directory = |value: &str| -> Result<String> {
        text(value, 4096)?;
        Ok(tmux_word(&binary.literal_directory(value)))
    };
    let args: Vec<String> = match action {
        TmuxAction::CreateSession {
            name: value,
            directory: path,
        } => {
            name(value)?;
            vec![
                "new-session".into(),
                "-d".into(),
                "-s".into(),
                word(value),
                "-c".into(),
                directory(path)?,
            ]
        }
        TmuxAction::RenameSession {
            target,
            name: value,
        } => {
            id(target, '$')?;
            name(value)?;
            vec![
                "rename-session".into(),
                "-t".into(),
                word(target),
                word(value),
            ]
        }
        TmuxAction::CreateWindow {
            target,
            name: value,
            directory: path,
        } => {
            id(target, '$')?;
            text(value, 200)?;
            vec![
                "new-window".into(),
                "-d".into(),
                "-t".into(),
                word(target),
                "-n".into(),
                word(value),
                "-c".into(),
                directory(path)?,
            ]
        }
        TmuxAction::RenameWindow {
            target,
            name: value,
        } => {
            id(target, '@')?;
            text(value, 200)?;
            vec![
                "rename-window".into(),
                "-t".into(),
                word(target),
                word(value),
            ]
        }
        TmuxAction::CloseWindow { target } => {
            id(target, '@')?;
            vec!["kill-window".into(), "-t".into(), word(target)]
        }
        TmuxAction::SelectWindow { target } => {
            id(target, '@')?;
            vec!["select-window".into(), "-t".into(), word(target)]
        }
        TmuxAction::SelectPane { target } => {
            id(target, '%')?;
            // The pane's window first: select-pane alone marks it active in a window the attached client may not show.
            vec![
                "select-window".into(),
                "-t".into(),
                word(target),
                ";".into(),
                "select-pane".into(),
                "-t".into(),
                word(target),
            ]
        }
        TmuxAction::CloseSession { target, server } => {
            id(target, '$')?;
            fenced(binary, server, &["kill-session", "-t", target])?
        }
        TmuxAction::ClosePane { target, server } => {
            id(target, '%')?;
            fenced(binary, server, &["kill-pane", "-t", target])?
        }
        TmuxAction::RenamePane {
            target,
            title: value,
            server,
        } => {
            id(target, '%')?;
            text(value, 200)?;
            fenced(binary, server, &["select-pane", "-t", target, "-T", value])?
        }
        TmuxAction::ResizePane {
            target,
            direction,
            amount,
            server,
        } => {
            id(target, '%')?;
            if !(1..=500).contains(amount) {
                return Err(SshError::new("invalid_target", "Resize by 1 to 500 cells"));
            }
            let flag = match direction {
                ResizeDirection::Left => "-L",
                ResizeDirection::Right => "-R",
                ResizeDirection::Up => "-U",
                ResizeDirection::Down => "-D",
            };
            fenced(
                binary,
                server,
                &["resize-pane", "-t", target, flag, &amount.to_string()],
            )?
        }
        TmuxAction::SplitPane {
            target,
            horizontal,
            directory: path,
        } => {
            id(target, '%')?;
            vec![
                "split-window".into(),
                "-d".into(),
                if *horizontal { "-h" } else { "-v" }.into(),
                "-t".into(),
                word(target),
                "-c".into(),
                directory(path)?,
            ]
        }
        TmuxAction::ZoomPane { target } => {
            id(target, '%')?;
            vec!["resize-pane".into(), "-Z".into(), "-t".into(), word(target)]
        }
    };
    Ok(server.cmd(&args.iter().map(String::as_str).collect::<Vec<_>>()))
}

/// What a local host runs where the remote one runs `discovery_command`: the same output
/// lines, from PATH lookups and argv instead of a shell script.
#[cfg(desktop)]
async fn local_discovery(
    host: &Host,
    access: &AccessLease,
    server: &crate::tmux_server::TmuxServer,
) -> Result<String> {
    // A failed command means "no": the tool is absent, or tmux has no server. Anything else
    // (a closed session, a revoked lease, a timeout) ends the discovery.
    async fn ran(host: &Host, access: &AccessLease, cmd: &Cmd) -> Result<Option<String>> {
        match host.run(access, cmd).await {
            Ok(output) => Ok(Some(output)),
            Err(error) if error.kind() == "remote_command_failed" => Ok(None),
            Err(error) => Err(error),
        }
    }
    let mut output = String::new();
    let mut tmux = false;
    for (tool, flag) in [
        ("tmux", "-V"),
        ("herdr", "--version"),
        ("zellij", "--version"),
    ] {
        // No native Windows tmux exists; it is reached through a WSL target.
        if (cfg!(windows) && tool == "tmux") || !crate::host::local_program(tool).await {
            output.push_str(&format!("{tool}\t0\n"));
            continue;
        }
        tmux |= tool == "tmux";
        let probe = Cmd::new(&[], &[tool, flag]);
        let probe = if tool == "herdr" {
            probe.herdr()
        } else {
            probe
        };
        let version = ran(host, access, &probe).await?.unwrap_or_default();
        output.push_str(&format!(
            "{tool}\t1\t{}\n",
            version.lines().next().unwrap_or_default()
        ));
    }
    // rmux is reached over SSH only; the line keeps the discovery output the shape `parse_tree` reads.
    output.push_str("rmux\t0\n");
    if tmux
        && ran(host, access, &server.cmd(&["has-session"]))
            .await?
            .is_some()
    {
        host.run(
            access,
            &server.cmd(&[
                "set-option",
                "-s",
                "-o",
                "-q",
                SERVER_TOKEN,
                &fresh_server_token(),
            ]),
        )
        .await?;
        let panes = server.cmd(&["list-panes", "-a", "-F", PANE_FORMAT]);
        output.push_str(&host.run(access, &panes).await?);
    }
    Ok(output)
}

/// The binary a command's `kind` expects (tmux when absent); a Herdr or Zellij kind is refused.
pub(crate) fn family_binary(
    kind: Option<MultiplexerKind>,
) -> Result<Option<crate::tmux_server::Binary>> {
    kind.map(|kind| {
        kind.binary()
            .ok_or_else(|| SshError::new("invalid_target", "Use the tmux or rmux workspace tree"))
    })
    .transpose()
}

/// The host a tmux-family command runs on and the server it addresses; `kind` names the family (tmux when absent).
pub(crate) async fn tmux_target(
    state: &AppState,
    local: &LocalState,
    session_id: &str,
    requested: Option<&str>,
    kind: Option<MultiplexerKind>,
    access: &AccessLease,
) -> Result<(Host, crate::tmux_server::TmuxServer)> {
    use crate::tmux_server::TmuxServer;
    let binary = family_binary(kind)?;
    let host = Host::resolve(state, local, session_id, access).await?;
    let server = match &host {
        Host::Remote(session) => TmuxServer::for_session(&session.bindings, requested, binary)?,
        #[cfg(desktop)]
        Host::Local(_) => {
            // shortcut: rmux is reached over SSH only; a local rmux needs its own verified discovery and Windows story (#1148).
            if binary == Some(crate::tmux_server::Binary::Rmux) {
                return Err(SshError::new(
                    "invalid_target",
                    "rmux sessions in local terminals are not available yet",
                ));
            }
            TmuxServer::attached_or(
                crate::local::tmux_server(local, session_id, access)
                    .map_err(|error| SshError::new("disconnected", error))?,
                requested,
                binary,
            )?
        }
    };
    Ok((host, server))
}

/// The current pane of the exact session (`=name:`), wrapped lines joined, newest `lines` of its history.
pub(crate) fn history_command(
    session: &str,
    server: &crate::tmux_server::TmuxServer,
    lines: usize,
) -> Result<String> {
    name(session)?;
    Ok(format!(
        "{} capture-pane -p -J -S -{lines} -t {}",
        server.prefix(),
        tmux_arg(&format!("={session}:"))
    ))
}

#[tauri::command]
pub async fn multiplexer_tree(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    tmux_server: Option<String>,
    kind: Option<MultiplexerKind>,
    access: AccessLease,
) -> crate::ssh::AccessResult<MultiplexerTree> {
    access
        .run(async {
            let (host, server) = tmux_target(
                &state,
                &local,
                &session_id,
                tmux_server.as_deref(),
                kind,
                &access,
            )
            .await?;
            let output = match &host {
                Host::Remote(session) => crate::ssh::exec_for_access(
                    session,
                    discovery_command(
                        &server,
                        crate::herdr_backend::captured(&session.handle),
                        crate::herdr_path::admit(session, &access).await?,
                    ),
                    &access,
                )
                .await
                .map_err(host_shell)?,
                #[cfg(desktop)]
                Host::Local(_) => local_discovery(&host, &access, &server).await?,
            };
            parse_tree(&output)
        })
        .await
}

#[tauri::command]
pub async fn tmux_action(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    action: TmuxAction,
    tmux_server: Option<String>,
    kind: Option<MultiplexerKind>,
    access: AccessLease,
) -> crate::ssh::AccessResult<()> {
    access
        .run(async {
            let (host, server) = tmux_target(
                &state,
                &local,
                &session_id,
                tmux_server.as_deref(),
                kind,
                &access,
            )
            .await?;
            host.run(&access, &action_cmd(&action, &server)?).await?;
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zellij_reattach_lists_only_sessions_with_a_running_server() {
        let live = zellij_live_sessions(
            "my notes [Created 2s ago] \nold [Created 1h ago] (EXITED - attach to resurrect)\nfake [Created 1s ago] (EXITED - x) [Created 9s ago] \n",
        )
        .unwrap();
        // A name that imitates the marker is still the live session it is: the marker is read after the last age.
        assert_eq!(live, ["my notes", "fake [Created 1s ago] (EXITED - x)"]);
        assert!(zellij_live_sessions("").unwrap().is_empty());
        assert!(zellij_live_sessions("garbage\n").is_err());
    }
    #[test]
    fn zellij_reattach_quotes_a_hostile_name_and_never_creates() {
        let hostile = "a'$(touch pwned);`id`\"x";
        let command = reattach_entry(MultiplexerKind::Zellij, hostile)
            .command()
            .unwrap();
        assert_eq!(command, "zellij attach 'a'\\''$(touch pwned);`id`\"x'");
        assert!(reattach_entry(MultiplexerKind::Zellij, "-c")
            .command()
            .is_err());
        assert!(reattach_entry(MultiplexerKind::Zellij, "a\nb")
            .command()
            .is_err());
    }
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
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
            .preflight_command(Default::default(), false)
            .unwrap()
            .contains("has-session"));
        assert!(!entry
            .preflight_command(Default::default(), false)
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
            (MultiplexerKind::Rmux, "rmux"),
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
        let tree = parse_tree("tmux\t1\ttmux 3.4\nherdr\t0\nzellij\t1\tzellij 0.45.1\nrmux\t0\n$0\twork\t@2\t0\tagent\t1\t%4\t0\t1\tclaude\t/work\t0123456789abcdef0123456789abcdef\t80\t24\tbuild\n$0\twork\t@2\t0\tagent\t1\t%5\t1\t0\tzsh\t/work\t0123456789abcdef0123456789abcdef\t40\t24\ta\tb\x1b[31m\n").unwrap();
        assert_eq!(
            tree.server_token.as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert_eq!(tree.sessions[0].windows[0].panes.len(), 2);
        let panes = &tree.sessions[0].windows[0].panes;
        assert_eq!(panes[1].id, "%5");
        assert_eq!(
            (panes[0].width, panes[0].height, panes[0].title.as_str()),
            (80, 24, "build")
        );
        // A program-set title keeps a stray tab and drops control characters; it never shifts the other fields.
        assert_eq!((panes[1].width, panes[1].title.as_str()), (40, "ab[31m"));
        assert!(
            parse_tree("tmux\t1\ttmux 3.4\nherdr\t0\nzellij\t0\nrmux\t0\nmalformed\n").is_err()
        );
        assert!(parse_tree(
            "tmux\t1\ttmux 3.4\nherdr\t0\nzellij\t0\nrmux\t0\n$0\twork\t@2\t0\tagent\t1\t%4x\t0\t1\tzsh\t/work\t\t80\t24\t\n"
        )
        .is_err());
        // One read names one server: a differing or malformed token is refused, an empty one means none was set.
        let row = |token: &str, pane: &str| {
            format!("$0\twork\t@2\t0\tagent\t1\t{pane}\t0\t1\tzsh\t/work\t{token}\t80\t24\tt\n")
        };
        let read = |rows: String| {
            parse_tree(&format!(
                "tmux\t1\ttmux 3.4\nherdr\t0\nzellij\t0\nrmux\t0\n{rows}"
            ))
        };
        let good = "0123456789abcdef0123456789abcdef";
        assert!(read(row("", "%4")).unwrap().server_token.is_none());
        assert!(read(row(good, "%4") + &row("fedcba9876543210fedcba9876543210", "%5")).is_err());
        assert!(read(row(good, "%4") + &row("", "%5")).is_err());
        for bad in [
            "short",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcde'",
        ] {
            assert!(read(row(bad, "%4")).is_err(), "{bad}");
        }
        // The pre-geometry eleven-field rows and a non-numeric size are refused, not guessed.
        for row in [
            "$0\twork\t@2\t0\tagent\t1\t%4\t0\t1\tzsh\t/work",
            "$0\twork\t@2\t0\tagent\t1\t%4\t0\t1\tzsh\t/work\t80\t24\tbuild",
            "$0\twork\t@2\t0\tagent\t1\t%4\t0\t1\tzsh\t/work\t\twide\t24\t",
        ] {
            assert!(
                parse_tree(&format!(
                    "tmux\t1\ttmux 3.4\nherdr\t0\nzellij\t0\nrmux\t0\n{row}\n"
                ))
                .is_err(),
                "{row}"
            );
        }
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
            (Zellij, "zellij 0.45.2", Some("0.45.2"), Support::Degraded),
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
        assert!(tool(Zellij, "zellij 0.44.3")
            .missing
            .contains(&"confirmedInput"));
        assert!(!tool(Zellij, "zellij 0.45.1")
            .missing
            .contains(&"confirmedInput"));
        let tree = parse_tree("tmux\t1\ttmux 3.2a\nherdr\t0\nzellij\t1\tzellij 0.45.1\nrmux\t0\n")
            .unwrap();
        assert_eq!(
            serde_json::to_value(&tree).unwrap()["tools"],
            serde_json::json!([
                {"kind":"tmux","version":"3.2a","support":"degraded","missing":["jump","confirmedInput"]},
                {"kind":"zellij","version":"0.45.1","support":"full","missing":[]}
            ])
        );
        // The pre-version format is not accepted as a version-less success.
        assert!(parse_tree("tmux\t1\nherdr\t0\nzellij\t0\nrmux\t0\n").is_err());
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
    /// Makes the host tools a discovery script may call visible on a `PATH` that holds only stub multiplexers.
    #[cfg(unix)]
    fn link_system_tools(directory: &std::path::Path, names: &[&str]) {
        for name in names {
            let real = std::process::Command::new("/bin/sh")
                .args(["-c", &format!("command -v {name}")])
                .output()
                .unwrap();
            std::os::unix::fs::symlink(
                String::from_utf8(real.stdout).unwrap().trim(),
                directory.join(name),
            )
            .unwrap();
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
        link_system_tools(tools.path(), &["sh", "head"]);
        let output = Command::new("/bin/sh")
            .args([
                "-c",
                &discovery_command(
                    &crate::tmux_server::TmuxServer::default(),
                    Default::default(),
                    false,
                ),
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
    const RMUX_CAPABILITIES: &str = r#"{"version":"0.10.0","binary_contract_version":1,"wire_version":8,"public_contract":["cli","json-output","format-tokens","control-mode"],"capabilities":["rpc.detached"],"control_mode":{"entrypoint":"rmux -C"}}"#;
    #[test]
    fn rmux_is_admitted_by_its_capability_record_and_never_by_a_version_line() {
        use Support::*;
        let no_control_mode = RMUX_CAPABILITIES.replace("control-mode", "cli");
        let wire_nine = RMUX_CAPABILITIES.replace("\"wire_version\":8", "\"wire_version\":9");
        let contract_two = RMUX_CAPABILITIES.replace(
            "\"binary_contract_version\":1",
            "\"binary_contract_version\":2",
        );
        let not_a_control_client = RMUX_CAPABILITIES.replace("rmux -C", "rmux");
        for (capabilities, daemon, support, version, reason) in [
            (RMUX_CAPABILITIES, "ok", Degraded, Some("0.10.0"), None),
            (
                RMUX_CAPABILITIES,
                "stale",
                Unsupported,
                Some("0.10.0"),
                Some("daemonWire"),
            ),
            (
                wire_nine.as_str(),
                "ok",
                Unsupported,
                None,
                Some("capabilities"),
            ),
            (
                contract_two.as_str(),
                "ok",
                Unsupported,
                None,
                Some("capabilities"),
            ),
            (
                no_control_mode.as_str(),
                "ok",
                Unsupported,
                None,
                Some("capabilities"),
            ),
            (
                not_a_control_client.as_str(),
                "ok",
                Unsupported,
                None,
                Some("capabilities"),
            ),
            // `rmux -V` prints tmux branding, and an rmux without `capabilities` prints nothing.
            ("tmux 3.4", "ok", Unsupported, None, Some("capabilities")),
            ("", "ok", Unsupported, None, Some("capabilities")),
        ] {
            let tool = tool(MultiplexerKind::Rmux, &format!("{capabilities}\t{daemon}"));
            assert_eq!(
                (tool.support, tool.version.as_deref(), tool.reason),
                (support, version, reason),
                "{capabilities} {daemon}"
            );
            assert_eq!(
                tool.missing.is_empty(),
                support == Unsupported,
                "{capabilities} {daemon}"
            );
        }
        let tree = parse_tree(&format!(
            "tmux\t0\nherdr\t0\nzellij\t0\nrmux\t1\t{RMUX_CAPABILITIES}\tstale\n"
        ))
        .unwrap();
        let tree = serde_json::to_value(&tree).unwrap();
        assert_eq!(tree["rmuxAvailable"], true);
        assert_eq!(
            tree["tools"],
            serde_json::json!([{"kind":"rmux","version":"0.10.0","support":"unsupported","missing":[],"reason":"daemonWire"}])
        );
        let tree = parse_tree(&format!(
            "tmux\t0\nherdr\t0\nzellij\t0\nrmux\t1\t{RMUX_CAPABILITIES}\tok\n"
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&tree).unwrap()["tools"],
            serde_json::json!([{"kind":"rmux","version":"0.10.0","support":"degraded","missing":["jump","confirmedInput","history"]}])
        );
    }
    #[cfg(unix)]
    #[test]
    fn rmux_discovery_never_starts_a_daemon_and_reports_a_stale_one() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let tools = tempfile::tempdir().unwrap();
        let calls = tools.path().join("calls");
        let stale = tools.path().join("stale");
        let stub = format!(
            r#"#!/bin/sh
printf '%s\n' "$*" >> {calls}
case "$*" in
  "capabilities --json") printf '{{\n  "version": "0.10.0",\n  "binary_contract_version": 1,\n  "wire_version": 8,\n  "public_contract": ["cli", "control-mode"],\n  "control_mode": {{"entrypoint": "rmux -C"}}\n}}\n';;
  *list-sessions*) if [ -e {stale} ]; then echo 'rmux: unsupported RMUX wire version 7; supported range is 8..=8' >&2; exit 1; fi; echo 'work: 1 windows';;
  *set-option*) ;;
  *list-panes*) printf '$0\twork\t@1\t0\tsh\t1\t%%0\t0\t1\tsh\t/tmp\t\t80\t24\tsh\n';;
  *) exit 9;;
esac
"#,
            calls = quote(calls.to_str().unwrap()),
            stale = quote(stale.to_str().unwrap())
        );
        let path = tools.path().join("rmux");
        std::fs::write(&path, stub).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        link_system_tools(tools.path(), &["sh", "head", "tr", "grep"]);
        let discover = |server: &crate::tmux_server::TmuxServer| {
            let output = Command::new("/bin/sh")
                .args(["-c", &discovery_command(server, Default::default(), false)])
                .env_clear()
                .env("PATH", tools.path())
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            serde_json::to_value(parse_tree(&String::from_utf8(output.stdout).unwrap()).unwrap())
                .unwrap()
        };
        let rmux = crate::tmux_server::TmuxServer::parse_for(
            crate::tmux_server::Binary::Rmux,
            Some("a b"),
        )
        .unwrap();
        let tree = discover(&rmux);
        assert_eq!(
            (&tree["tmuxAvailable"], &tree["rmuxAvailable"]),
            (&serde_json::json!(false), &serde_json::json!(true))
        );
        assert_eq!(tree["tools"][0]["support"], "degraded");
        assert_eq!(tree["sessions"][0]["windows"][0]["panes"][0]["id"], "%0");
        // Browsing a tmux server still probes rmux, in its default namespace.
        let tree = discover(&crate::tmux_server::TmuxServer::default());
        assert_eq!(tree["rmuxAvailable"], true);
        assert_eq!(tree["sessions"], serde_json::json!([]));
        std::fs::write(&stale, "").unwrap();
        let tree = discover(&rmux);
        assert_eq!(tree["tools"][0]["support"], "unsupported");
        assert_eq!(tree["tools"][0]["reason"], "daemonWire");
        let log = std::fs::read_to_string(calls).unwrap();
        let calls = log.lines().collect::<Vec<_>>();
        assert!(calls.contains(&"capabilities --json"));
        for call in calls.iter().filter(|call| **call != "capabilities --json") {
            assert!(
                call.starts_with("-u -N -L "),
                "discovery must never start a daemon: {call}"
            );
            assert!(
                !call.contains("new-session") && !call.contains("attach"),
                "{call}"
            );
        }
        assert!(calls.contains(&"-u -N -L a b list-sessions"));
        assert!(calls
            .iter()
            .any(|call| call.starts_with("-u -N -L a b list-panes -a -F ")));
    }
    #[test]
    fn rmux_reuses_the_tmux_command_stack_with_its_own_binary() {
        let entry: Entry = serde_json::from_value(
            serde_json::json!({"kind":"rmux","name":"work 'literal;","tmuxServer":"named 'server"}),
        )
        .unwrap();
        assert_eq!(
            entry.command().unwrap(),
            "rmux -u -L 'named '\\''server' attach-session -t '=work '\\''literal\\;'"
        );
        let preflight = entry.preflight_command(Default::default(), false).unwrap();
        assert!(preflight.contains("rmux capabilities --json"));
        assert!(!preflight.contains("rmux -V") && !preflight.contains("tmux"));
        assert!(preflight.contains("has-session") && !preflight.contains("new-session"));
        assert_eq!(
            attach_command(MultiplexerKind::Rmux, "work").unwrap(),
            "rmux -u -L 'default' attach-session -t '=work'"
        );
        assert!(default_entry_command(MultiplexerKind::Rmux, "created")
            .unwrap()
            .contains("new-session -d -s"));
        for invalid in [
            serde_json::json!({"kind":"rmux","name":"work","tmuxServer":"/tmp/socket"}),
            serde_json::json!({"kind":"rmux","name":""}),
        ] {
            assert!(serde_json::from_value::<Entry>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
        let rmux = crate::tmux_server::TmuxServer::parse_for(
            crate::tmux_server::Binary::Rmux,
            Some("lab"),
        )
        .unwrap();
        assert_eq!(
            action_command_for(
                &TmuxAction::SelectWindow {
                    target: "@3".into()
                },
                &rmux
            )
            .unwrap(),
            "rmux -u -L lab select-window -t @3"
        );
        // tmux expands `#` in names, so it is doubled for tmux; rmux stores what it is given.
        let create = TmuxAction::CreateSession {
            name: "a#(b)".into(),
            directory: "/w#1".into(),
        };
        assert_eq!(
            action_command_for(&create, &rmux).unwrap(),
            "rmux -u -L lab new-session -d -s 'a#(b)' -c '#{l:/w##1}'"
        );
        // rmux receives a literal format for each start directory.
        let split = |directory: &str| {
            action_command_for(
                &TmuxAction::SplitPane {
                    target: "%1".into(),
                    horizontal: true,
                    directory: directory.into(),
                },
                &rmux,
            )
            .unwrap()
        };
        assert!(split("/w#{x}##").ends_with("-c '#{l:/w##{x#}####}'"));
        assert!(split("/w#(y)##").ends_with("-c '#{l:/w##(y)####}'"));
        // All three actions use the same literal encoding.
        assert!(action_command_for(&create, &rmux)
            .unwrap()
            .ends_with("-c '#{l:/w##1}'"));
        assert!(action_command(&create)
            .unwrap()
            .ends_with("new-session -d -s 'a##(b)' -c '/w##1'"));
        assert!(persistent_sessions(MultiplexerKind::Rmux, "").is_err());
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
            "tmux -u -L default new-session -d -s 'a'\\''$(touch nope)' -c '/work/##(touch nope)'"
        );
    }
    /// Kills the isolated tmux server a test started, even when the test panics.
    #[cfg(unix)]
    struct TmuxServer<'a>(&'a crate::host::tests::local::Isolated, String);
    #[cfg(unix)]
    impl Drop for TmuxServer<'_> {
        fn drop(&mut self) {
            let _ = self
                .0
                .command("tmux")
                .args(["-L", &self.1, "kill-server"])
                .output();
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires tmux on PATH; runs an isolated temporary server"]
    async fn real_local_session_discovers_tmux_and_applies_actions_with_literal_names() {
        use crate::host::tests::local::{lease, ok, Isolated};
        use tauri::Manager;
        let home = Isolated::new();
        let (app, id) = home.session().await;
        let server = format!("ls-{}", uuid::Uuid::new_v4().simple());
        let _server = TmuxServer(&home, server.clone());
        let tree = || {
            ok(multiplexer_tree(
                app.state(),
                app.state(),
                id.clone(),
                Some(server.clone()),
                None,
                lease(),
            ))
        };
        let act = |action| {
            ok(tmux_action(
                app.state(),
                app.state(),
                id.clone(),
                action,
                Some(server.clone()),
                None,
                lease(),
            ))
        };
        // No server runs yet: tmux is found by its PATH lookup and no session is listed.
        let before = tree().await;
        assert!(before.tmux_available && before.sessions.is_empty());
        assert!(before
            .tools
            .iter()
            .any(|tool| matches!(tool.kind, MultiplexerKind::Tmux)));
        // Herdr runs through the same lookup; with no server running it lists no session.
        if before.herdr_available {
            let herdr = ok(multiplexer_sessions(
                app.state(),
                app.state(),
                id.clone(),
                MultiplexerKind::Herdr,
                lease(),
            ))
            .await;
            assert!(herdr.is_empty());
        }
        let work = home.path().join("work dir 'q'");
        std::fs::create_dir(&work).unwrap();
        let directory = work.to_str().unwrap().to_owned();
        let name = "literal 'quote' \"double\" $(touch nope)#(printf bad);".to_owned();
        act(TmuxAction::CreateSession {
            name: name.clone(),
            directory: directory.clone(),
        })
        .await;
        let after = tree().await;
        assert_eq!(after.sessions.len(), 1);
        assert_eq!(after.sessions[0].name, name);
        assert_eq!(after.sessions[0].windows[0].panes[0].path, directory);
        assert!(!home.path().join("nope").exists());
        let (session, pane) = (
            after.sessions[0].id.clone(),
            after.sessions[0].windows[0].panes[0].id.clone(),
        );
        act(TmuxAction::SplitPane {
            target: pane.clone(),
            horizontal: true,
            directory: directory.clone(),
        })
        .await;
        act(TmuxAction::ZoomPane {
            target: pane.clone(),
        })
        .await;
        act(TmuxAction::SelectPane { target: pane }).await;
        act(TmuxAction::CreateWindow {
            target: session.clone(),
            name: "second".into(),
            directory,
        })
        .await;
        act(TmuxAction::RenameSession {
            target: session,
            name: "renamed;".into(),
        })
        .await;
        let tree_now = tree().await;
        let session = &tree_now.sessions[0];
        assert_eq!(
            (session.name.as_str(), session.windows.len()),
            ("renamed;", 2)
        );
        assert_eq!(session.windows[0].panes.len(), 2);
        let window = session.windows[1].id.clone();
        act(TmuxAction::RenameWindow {
            target: window.clone(),
            name: "new #{session_name} title;".into(),
        })
        .await;
        act(TmuxAction::SelectWindow { target: window }).await;
        let tree_now = tree().await;
        assert_eq!(
            tree_now.sessions[0].windows[1].name,
            "new #{session_name} title;"
        );
        assert!(tree_now.sessions[0].windows[1].active);
        let listed = ok(crate::ssh::list_multiplexer_sessions(
            lease(),
            app.state(),
            app.state(),
            id.clone(),
            Some(server.clone()),
            None,
        ))
        .await;
        assert_eq!(listed.len(), 1);
        let listed = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(
            (&listed["name"], &listed["windows"], &listed["attached"]),
            (&"renamed;".into(), &2.into(), &false.into())
        );
        // Another named server is another namespace: it knows none of these sessions.
        let other = ok(multiplexer_tree(
            app.state(),
            app.state(),
            id.clone(),
            Some("ls-other".into()),
            None,
            lease(),
        ))
        .await;
        assert!(other.sessions.is_empty());
    }
    #[test]
    fn history_reads_the_exact_sessions_current_pane_with_every_name_literal() {
        let server = crate::tmux_server::TmuxServer::parse(Some("named 'server")).unwrap();
        assert_eq!(
            history_command("work'$(touch nope);", &server, 20000).unwrap(),
            "tmux -u -L 'named '\\''server' capture-pane -p -J -S -20000 -t '=work'\\''$(touch nope);:'"
        );
        for invalid in ["", "a:b", "a.b", "a\nb"] {
            assert!(history_command(invalid, &server, 1).is_err(), "{invalid:?}");
        }
    }
    #[test]
    fn history_is_missing_only_where_the_cli_is_untested_or_older() {
        use MultiplexerKind::*;
        for (kind, line, missing) in [
            (Tmux, "tmux 3.2a", false),
            (Zellij, "zellij 0.45.1", false),
            (Zellij, "zellij 0.46.0", false),
            (Zellij, "zellij 0.44.3", true),
            (Zellij, "zellij", true),
            (Herdr, "herdr 0.9.5", false),
            (Herdr, "herdr 0.8.2", true),
        ] {
            assert_eq!(
                tool(kind, line).missing.contains(&"history"),
                missing,
                "{line}"
            );
        }
    }
    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    fn token() -> String {
        TOKEN.into()
    }
    /// What the shell hands tmux: the fence, the inner command quoted for tmux's parser, and the stale-server error.
    fn fence(inner: &str) -> String {
        format!(
            "tmux -u -L default if-shell -F {} {} {}",
            quote(&format!("#{{==:#{{@lazysh_server}},{TOKEN}}}")),
            quote(inner),
            quote("select-pane -t '%lazysh-stale-server'")
        )
    }
    #[test]
    fn layout_actions_run_only_on_the_server_the_confirmation_was_read_from() {
        let command = |action| action_command(&action).unwrap();
        assert_eq!(
            command(TmuxAction::ClosePane {
                target: "%12".into(),
                server: token()
            }),
            fence("'kill-pane' '-t' '%12'")
        );
        assert_eq!(
            command(TmuxAction::CloseSession {
                target: "$3".into(),
                server: token()
            }),
            fence("'kill-session' '-t' '$3'")
        );
        // The title is quoted for tmux's own parser inside the fence: no substitution, no second command, one format level.
        assert_eq!(
            command(TmuxAction::RenamePane {
                target: "%1".into(),
                title: "a'$(touch nope)#{pane_id};".into(),
                server: token()
            }),
            fence("'select-pane' '-t' '%1' '-T' 'a'\\''$(touch nope)##{pane_id};'")
        );
        for (direction, flag) in [
            (ResizeDirection::Left, 'L'),
            (ResizeDirection::Right, 'R'),
            (ResizeDirection::Up, 'U'),
            (ResizeDirection::Down, 'D'),
        ] {
            assert_eq!(
                command(TmuxAction::ResizePane {
                    target: "%1".into(),
                    direction,
                    amount: 5,
                    server: token()
                }),
                fence(&format!("'resize-pane' '-t' '%1' '-{flag}' '5'"))
            );
        }
        let refused = |action| action_command(&action).is_err();
        for bad in ["", "1", "%", "%1;kill-server", "$1", "@1", "%1 %2", "-a"] {
            assert!(
                refused(TmuxAction::ClosePane {
                    target: bad.into(),
                    server: token()
                }),
                "{bad}"
            );
            assert!(
                refused(TmuxAction::RenamePane {
                    target: bad.into(),
                    title: "t".into(),
                    server: token()
                }),
                "{bad}"
            );
            assert!(
                refused(TmuxAction::ResizePane {
                    target: bad.into(),
                    direction: ResizeDirection::Up,
                    amount: 1,
                    server: token()
                }),
                "{bad}"
            );
        }
        // A missing, short, upper-case or quote-carrying token never reaches tmux.
        for bad in [
            "",
            "abc",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcde'",
            "0123456789abcdef0123456789abcdef;",
        ] {
            assert!(
                refused(TmuxAction::ClosePane {
                    target: "%1".into(),
                    server: bad.into()
                }),
                "{bad}"
            );
            assert!(
                refused(TmuxAction::CloseSession {
                    target: "$1".into(),
                    server: bad.into()
                }),
                "{bad}"
            );
        }
        assert!(refused(TmuxAction::CloseSession {
            target: "%1".into(),
            server: token()
        }));
        assert!(refused(TmuxAction::CloseSession {
            target: "$1;x".into(),
            server: token()
        }));
        assert!(refused(TmuxAction::RenamePane {
            target: "%1".into(),
            title: "".into(),
            server: token()
        }));
        assert!(refused(TmuxAction::RenamePane {
            target: "%1".into(),
            title: "a\nb".into(),
            server: token()
        }));
        for amount in [0, 501] {
            assert!(
                refused(TmuxAction::ResizePane {
                    target: "%1".into(),
                    direction: ResizeDirection::Left,
                    amount,
                    server: token()
                }),
                "{amount}"
            );
        }
    }
    #[test]
    fn the_bridge_accepts_only_the_listed_layout_actions_and_directions() {
        let action = |value| serde_json::from_value::<TmuxAction>(value);
        let server = TOKEN;
        assert!(action(
            serde_json::json!({"type":"resizePane","target":"%1","direction":"left","amount":3,"server":server})
        )
        .is_ok());
        assert!(action(
            serde_json::json!({"type":"resizePane","target":"%1","direction":"sideways","amount":3,"server":server})
        )
        .is_err());
        assert!(action(
            serde_json::json!({"type":"resizePane","target":"%1","direction":"left","amount":-1,"server":server})
        )
        .is_err());
        assert!(action(
            serde_json::json!({"type":"closePane","target":"%1","server":server,"force":true})
        )
        .is_err());
        // An action without the server identity cannot be built at all.
        for missing in [
            serde_json::json!({"type":"closePane","target":"%1"}),
            serde_json::json!({"type":"closeSession","target":"$1"}),
            serde_json::json!({"type":"renamePane","target":"%1","title":"x"}),
            serde_json::json!({"type":"resizePane","target":"%1","direction":"left","amount":3}),
        ] {
            assert!(action(missing.clone()).is_err(), "{missing}");
        }
        assert!(action(
            serde_json::json!({"type":"renamePane","target":"%1","title":"x","server":server})
        )
        .is_ok());
        assert!(
            action(serde_json::json!({"type":"closeSession","target":"$1","server":server}))
                .is_ok()
        );
    }
    #[test]
    #[ignore = "requires tmux on PATH; runs an isolated temporary server"]
    fn real_tmux_lifecycle_and_literal_names() {
        lifecycle_and_literal_names(crate::tmux_server::Binary::Tmux);
    }
    #[test]
    #[ignore = "requires the pinned rmux on PATH; runs an isolated temporary daemon"]
    fn real_rmux_lifecycle_and_literal_names() {
        lifecycle_and_literal_names(crate::tmux_server::Binary::Rmux);
    }
    /// Drives product discovery and every `TmuxAction` against a real server; the parsed tree must equal the binary's own `list-panes -a`.
    fn lifecycle_and_literal_names(binary: crate::tmux_server::Binary) {
        use crate::tmux_server::{Binary, TmuxServer};
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("tmux.sock");
        let server = TmuxServer::default_for(binary);
        // tmux gets an explicit socket path; rmux resolves `-L` under RMUX_TMPDIR, so the product prefix runs unchanged.
        let scoped = |command: String| {
            let command = match binary {
                Binary::Tmux => command.replacen(
                    "tmux ",
                    &format!("tmux -f /dev/null -S {} ", quote(socket.to_str().unwrap())),
                    1,
                ),
                Binary::Rmux => command,
            };
            let mut process = Command::new("sh");
            process.arg("-c").arg(command).env_remove("TMUX");
            // rmux gets a private home, a plain shell and its own socket directory; the tmux case keeps the environment it always ran in.
            if matches!(binary, Binary::Rmux) {
                process
                    .env_remove("RMUX")
                    .env("HOME", temp.path())
                    .env("SHELL", "/bin/sh")
                    .env("RMUX_TMPDIR", temp.path());
            }
            process
        };
        let run =
            |command: String| lazysh_common::test_support::successful_output(&mut scoped(command));
        let read_tree = || {
            // As a discovery read does: name the server (rmux exits 1 when it is already named), then list its panes.
            run(format!(
                "{} set-option -s -o -q {SERVER_TOKEN} {}{}",
                server.prefix(),
                fresh_server_token(),
                if matches!(binary, Binary::Rmux) {
                    " || true"
                } else {
                    ""
                }
            ));
            let rows = run(format!(
                "{} list-panes -a -F {}",
                server.prefix(),
                quote(PANE_FORMAT)
            ));
            let tree =
                parse_tree(&format!("tmux\t1\t\nherdr\t0\nzellij\t0\nrmux\t0\n{rows}")).unwrap();
            if matches!(binary, Binary::Rmux) {
                let product =
                    parse_tree(&run(discovery_command(&server, Default::default(), false)))
                        .unwrap();
                let product = serde_json::to_value(&product).unwrap();
                // A pane's command changes from the multiplexer to its shell while it starts, and rmux names an unnamed
                // window after that command, so two reads never compare either; an explicit window name is asserted below.
                let stable = |value: serde_json::Value| {
                    let mut sessions = value["sessions"].clone();
                    for session in sessions.as_array_mut().unwrap() {
                        for window in session["windows"].as_array_mut().unwrap() {
                            window["name"] = serde_json::Value::Null;
                            for pane in window["panes"].as_array_mut().unwrap() {
                                pane["command"] = serde_json::Value::Null;
                            }
                        }
                    }
                    sessions
                };
                assert_eq!(
                    stable(product.clone()),
                    stable(serde_json::to_value(&tree).unwrap())
                );
                assert_eq!(product["rmuxAvailable"], true);
                let rmux = product["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|tool| tool["kind"] == "rmux")
                    .unwrap();
                assert_eq!(rmux["support"], "degraded", "{rmux}");
            }
            tree
        };
        struct Server(Binary, std::path::PathBuf, std::path::PathBuf);
        impl Drop for Server {
            fn drop(&mut self) {
                let mut kill = Command::new(self.0.name());
                match self.0 {
                    Binary::Tmux => kill.arg("-S").arg(&self.1),
                    Binary::Rmux => kill.args(["-L", "default"]).env("RMUX_TMPDIR", &self.2),
                };
                let _ = kill.arg("kill-server").output();
            }
        }
        let _server = Server(binary, socket.clone(), temp.path().to_owned());
        let directory = temp.path().to_str().unwrap().to_owned();
        let name = "literal'$(touch nope)#(printf bad);".to_owned();
        run(action_command_for(
            &TmuxAction::CreateSession {
                name: name.clone(),
                directory: directory.clone(),
            },
            &server,
        )
        .unwrap());
        let tree = read_tree();
        assert_eq!(tree.sessions[0].name, name);
        assert!(!temp.path().join("nope").exists());
        let session = tree.sessions[0].id.clone();
        let pane = tree.sessions[0].windows[0].panes[0].id.clone();
        run(action_command_for(
            &TmuxAction::SplitPane {
                target: pane.clone(),
                horizontal: true,
                directory: directory.clone(),
            },
            &server,
        )
        .unwrap());
        run(action_command_for(
            &TmuxAction::ZoomPane {
                target: pane.clone(),
            },
            &server,
        )
        .unwrap());
        run(action_command_for(&TmuxAction::SelectPane { target: pane }, &server).unwrap());
        run(action_command_for(
            &TmuxAction::CreateWindow {
                target: session.clone(),
                name: "second".into(),
                directory,
            },
            &server,
        )
        .unwrap());
        run(action_command_for(
            &TmuxAction::RenameSession {
                target: session,
                name: "renamed".into(),
            },
            &server,
        )
        .unwrap());
        let tree = read_tree();
        assert_eq!(tree.sessions[0].name, "renamed");
        assert_eq!(tree.sessions[0].windows.len(), 2);
        // Selecting a pane that is not in the shown window brings its window forward and makes that pane the active one.
        run(action_command_for(
            &TmuxAction::SplitPane {
                target: tree.sessions[0].windows[1].panes[0].id.clone(),
                horizontal: false,
                directory: temp.path().to_str().unwrap().to_owned(),
            },
            &server,
        )
        .unwrap());
        let tree = read_tree();
        assert!(tree.sessions[0].windows[0].active && !tree.sessions[0].windows[1].active);
        let hidden = tree.sessions[0].windows[1]
            .panes
            .iter()
            .find(|pane| !pane.active)
            .unwrap()
            .id
            .clone();
        run(action_command_for(
            &TmuxAction::SelectPane {
                target: hidden.clone(),
            },
            &server,
        )
        .unwrap());
        let tree = read_tree();
        assert!(!tree.sessions[0].windows[0].active && tree.sessions[0].windows[1].active);
        let shown = tree.sessions[0].windows[1]
            .panes
            .iter()
            .find(|pane| pane.active)
            .unwrap();
        assert_eq!(shown.id, hidden);
        let window = &tree.sessions[0].windows[1].id;
        run(action_command_for(
            &TmuxAction::RenameWindow {
                target: window.clone(),
                name: "new #{session_name} title;".into(),
            },
            &server,
        )
        .unwrap());
        run(action_command_for(
            &TmuxAction::SelectWindow {
                target: window.clone(),
            },
            &server,
        )
        .unwrap());
        let tree = read_tree();
        assert_eq!(
            tree.sessions[0].windows[1].name,
            "new #{session_name} title;"
        );
        let first = tree.sessions[0].windows[0].id.clone();
        run(action_command_for(
            &TmuxAction::CloseWindow {
                target: window.clone(),
            },
            &server,
        )
        .unwrap());
        let tree = read_tree();
        assert_eq!(
            tree.sessions[0]
                .windows
                .iter()
                .map(|w| w.id.clone())
                .collect::<Vec<_>>(),
            vec![first]
        );
        // The window is gone: closing it again fails and takes nothing else with it.
        let again = scoped(
            action_command_for(
                &TmuxAction::CloseWindow {
                    target: window.clone(),
                },
                &server,
            )
            .unwrap(),
        )
        .output()
        .unwrap();
        assert!(!again.status.success());
        assert_eq!(read_tree().sessions[0].windows.len(), 1);
        if matches!(binary, Binary::Tmux) {
            // History reads the pane's scrollback from tmux, not from a client: line 1 survives 5000 lines.
            run("tmux set-option -g history-limit 50000".into());
            run(action_command_for(
                &TmuxAction::CreateSession {
                    name: "history".into(),
                    directory: temp.path().to_str().unwrap().to_owned(),
                },
                &server,
            )
            .unwrap());
            run("tmux send-keys -t '=history:' 'seq 1 5000' Enter".into());
            let history = crate::multiplexer_history::read_numbered_5000(
                || {
                    run(
                        history_command("history", &server, crate::multiplexer_history::MAX_LINES)
                            .unwrap(),
                    )
                },
                None,
            );
            assert!(!history.truncated);
            assert!(history.text.lines().any(|line| line == "1"));
            assert!(history.lines >= 5000);
            // The history session is done: the layout actions below run in the one session the test built.
            run("tmux kill-session -t '=history:'".into());
        }
        let action_command = |action: &TmuxAction| action_command_for(action, &server);
        // Pane title, geometry and close, each read back from the parsed tree.
        let tree = read_tree();
        let live = || {
            read_tree()
                .server_token
                .expect("the server carries its token")
        };
        let first = &tree.sessions[0].windows[0];
        assert_eq!(first.panes.len(), 2);
        let (left, right) = (first.panes[0].id.clone(), first.panes[1].id.clone());
        // The earlier zoom is still on: undo it so both panes have their own geometry.
        run(action_command(&TmuxAction::ZoomPane {
            target: left.clone(),
        })
        .unwrap());
        run(action_command(&TmuxAction::RenamePane {
            target: left.clone(),
            title: "build #{pane_id} 'x';$(touch nope)".into(),
            server: live(),
        })
        .unwrap());
        let widths = |tree: &MultiplexerTree| {
            let panes = &tree.sessions[0].windows[0].panes;
            (panes[0].width, panes[1].width)
        };
        let before = read_tree();
        assert_eq!(
            before.sessions[0].windows[0].panes[0].title,
            "build #{pane_id} 'x';$(touch nope)"
        );
        assert!(!temp.path().join("nope").exists());
        run(action_command(&TmuxAction::ResizePane {
            target: left,
            direction: ResizeDirection::Right,
            amount: 5,
            server: live(),
        })
        .unwrap());
        let (grown, shrunk) = widths(&read_tree());
        assert_eq!(
            (grown, shrunk),
            (widths(&before).0 + 5, widths(&before).1 - 5)
        );
        run(action_command(&TmuxAction::ClosePane {
            target: right.clone(),
            server: live(),
        })
        .unwrap());
        let panes = read_tree().sessions[0].windows[0].panes.len();
        assert_eq!(panes, 1);
        // A pane that is gone is refused by tmux and nothing else is touched.
        let again = scoped(
            action_command(&TmuxAction::ClosePane {
                target: right,
                server: live(),
            })
            .unwrap(),
        )
        .output()
        .unwrap();
        assert!(!again.status.success());
        let tree = read_tree();
        assert_eq!(tree.sessions[0].windows[0].panes.len(), 1);
        let doomed = tree.sessions[0].id.clone();
        run(action_command(&TmuxAction::CreateSession {
            name: "second".into(),
            directory: temp.path().to_str().unwrap().into(),
        })
        .unwrap());
        run(action_command(&TmuxAction::CloseSession {
            target: doomed,
            server: live(),
        })
        .unwrap());
        let tree = read_tree();
        assert_eq!(
            tree.sessions
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            ["second"]
        );
        // A directory whose name holds a format, a quote, a trailing `;` or a `#` that is no format is the one a new session, window and split pane start in.
        let panes_start_in =
            |directory: &str, count: usize, select: &dyn Fn(&MultiplexerTree) -> Vec<String>| {
                let expected = vec![directory.to_owned(); count];
                let mut found = select(&read_tree());
                // A new pane reports its directory once its shell has started.
                for _ in 0..50 {
                    if found == expected {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    found = select(&read_tree());
                }
                assert_eq!(found, expected, "{binary:?}");
            };
        let paths = |panes: &[MuxPane]| {
            panes
                .iter()
                .map(|pane| pane.path.clone())
                .collect::<Vec<_>>()
        };
        let directories = [
            "it's #{x};",
            "w#{pane_id}#(echo hi)##b",
            "no#(echo hi)##format",
            "style#[b]#{literal}## and } trailing ",
        ];
        for (index, odd) in directories.iter().enumerate() {
            let odd = temp.path().canonicalize().unwrap().join(odd);
            std::fs::create_dir(&odd).unwrap();
            let odd = odd.to_str().unwrap().to_owned();
            let label = format!("odd{index}");
            run(action_command_for(
                &TmuxAction::CreateSession {
                    name: label.clone(),
                    directory: odd.clone(),
                },
                &server,
            )
            .unwrap());
            panes_start_in(&odd, 1, &|tree| {
                let session = tree.sessions.iter().find(|session| session.name == label);
                paths(&session.unwrap().windows[0].panes)
            });
            let session = read_tree().sessions[0].id.clone();
            run(action_command_for(
                &TmuxAction::CreateWindow {
                    target: session,
                    name: label.clone(),
                    directory: odd.clone(),
                },
                &server,
            )
            .unwrap());
            let window = |tree: &MultiplexerTree| {
                let window = tree.sessions[0]
                    .windows
                    .iter()
                    .find(|window| window.name == label);
                window
                    .unwrap()
                    .panes
                    .iter()
                    .map(|pane| (pane.id.clone(), pane.path.clone()))
                    .collect::<Vec<_>>()
            };
            run(action_command_for(
                &TmuxAction::SplitPane {
                    target: window(&read_tree())[0].0.clone(),
                    horizontal: true,
                    directory: odd.clone(),
                },
                &server,
            )
            .unwrap());
            panes_start_in(&odd, 2, &|tree| {
                window(tree).into_iter().map(|pane| pane.1).collect()
            });
        }
        // The server is replaced on the same socket: tmux hands out the same ids again, and every action built from
        // the old server's tree is refused without touching the replacement (#2044).
        let stale = live();
        run(format!("{} kill-server", server.prefix()));
        if matches!(binary, Binary::Tmux) {
            // kill-server returns before the old server has exited, and a command sent meanwhile reaches it ("server exited
            // unexpectedly"): wait until nothing answers, so the next one starts the replacement.
            for _ in 0..100 {
                let probe = scoped(format!("{} has-session", server.prefix()))
                    .output()
                    .unwrap();
                if String::from_utf8_lossy(&probe.stderr).contains("no server running") {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        run(action_command(&TmuxAction::CreateSession {
            name: "replacement".into(),
            directory: temp.path().to_str().unwrap().into(),
        })
        .unwrap());
        let replacement = read_tree();
        // tmux numbers from zero on every server, so these are the ids the first server also used.
        let (old_session, old_pane) = (
            replacement.sessions[0].id.clone(),
            replacement.sessions[0].windows[0].panes[0].id.clone(),
        );
        assert_eq!((old_session.as_str(), old_pane.as_str()), ("$0", "%0"));
        let stale_actions = |token: &str| {
            [
                action_command(&TmuxAction::ClosePane {
                    target: old_pane.clone(),
                    server: token.into(),
                }),
                action_command(&TmuxAction::CloseSession {
                    target: old_session.clone(),
                    server: token.into(),
                }),
                action_command(&TmuxAction::RenamePane {
                    target: old_pane.clone(),
                    title: "stale".into(),
                    server: token.into(),
                }),
                action_command(&TmuxAction::ResizePane {
                    target: old_pane.clone(),
                    direction: ResizeDirection::Left,
                    amount: 1,
                    server: token.into(),
                }),
            ]
            .map(Result::unwrap)
        };
        assert_ne!(replacement.server_token.as_deref(), Some(stale.as_str()));
        for command in stale_actions(&stale) {
            let output = scoped(command.clone()).output().unwrap();
            assert!(!output.status.success(), "{command}");
        }
        let survivors = read_tree();
        assert_eq!(survivors.sessions[0].name, "replacement");
        assert!(!survivors.sessions[0].windows[0].panes[0]
            .title
            .contains("stale"));
        // The same actions with the replacement's own token run.
        for command in stale_actions(&live()).into_iter().take(1) {
            let again = scoped(command).output().unwrap();
            assert!(again.status.success());
        }
        assert!(!scoped(format!("{} has-session", server.prefix()))
            .output()
            .unwrap()
            .status
            .success());
    }

    #[test]
    fn closes_a_window_by_exact_id_and_refuses_anything_else() {
        assert_eq!(
            action_command(&TmuxAction::CloseWindow {
                target: "@12".into()
            })
            .unwrap(),
            "tmux -u -L default kill-window -t @12"
        );
        for bad in ["", "12", "@", "@1;kill-server", "$1", "%1", "@1 @2", "-a"] {
            assert!(
                action_command(&TmuxAction::CloseWindow { target: bad.into() }).is_err(),
                "{bad}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_chosen_herdr_answers_discovery_preflight_and_listing_and_never_the_other() {
        use crate::herdr_backend::{
            sandbox::Sandbox,
            HerdrBackend::{Managed, System},
        };
        let sandbox = Sandbox::new(true);
        let entry: Entry =
            serde_json::from_value(serde_json::json!({"kind":"herdr","name":"work"})).unwrap();
        for (backend, name) in [(System, "system"), (Managed, "managed")] {
            sandbox.assert_ran(backend, &[entry.preflight_command(backend, true).unwrap()]);
            sandbox.assert_reaches(backend, &[HERDR_SESSIONS]);
            assert_eq!(
                sandbox.run_wrapped(&herdr_probe(backend, true)),
                (format!("herdr\t1\t{name} --version\n"), true)
            );
        }
        // A managed Herdr that is not installed is absent, however good the system one is.
        assert_eq!(
            Sandbox::new(false).run_wrapped(&herdr_probe(Managed, true)),
            ("herdr\t0\n".into(), true)
        );
        assert_eq!(herdr_probe(Managed, false), "printf 'herdr\\t0\\n'");
    }

    #[test]
    fn a_managed_entry_belongs_to_herdr_and_to_ssh_hosts() {
        let entry = |value: serde_json::Value| serde_json::from_value::<Entry>(value).unwrap();
        let managed = entry(serde_json::json!({"kind":"herdr","name":"work","backend":"managed"}));
        assert!(managed.validate().is_ok());
        assert_eq!(managed.argv().unwrap_err().kind(), "invalid_target");
        assert!(
            entry(serde_json::json!({"kind":"herdr","name":"work","backend":"system"}))
                .argv()
                .is_ok()
        );
        for kind in ["tmux", "zellij"] {
            let wrong = entry(serde_json::json!({"kind":kind,"name":"work","backend":"managed"}));
            assert_eq!(wrong.validate().unwrap_err().kind(), "invalid_target");
        }
        let path = serde_json::json!({"kind":"herdr","name":"work","backend":"/opt/herdr"});
        assert!(serde_json::from_value::<Entry>(path).is_err());
    }

    /// Runs the product's Zellij listing the way the SSH exec does: one command string through a POSIX shell.
    #[cfg(unix)]
    fn list_zellij_sessions(
        path: &std::path::Path,
        environment: &[(&str, &std::path::Path)],
    ) -> Result<String> {
        let mut command = std::process::Command::new("sh");
        command
            .arg("-c")
            .arg(zellij_sessions_command().render())
            .env("PATH", path);
        for (key, value) in environment {
            command.env(key, value);
        }
        let output = command.output().unwrap();
        zellij_output(crate::ssh::ExecOutput {
            status: output
                .status
                .code()
                .and_then(|code| u32::try_from(code).ok()),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
    #[cfg(unix)]
    #[test]
    fn lists_zellij_sessions_and_reads_a_host_without_any_as_an_empty_list_not_a_failure() {
        let temp = tempfile::tempdir().unwrap();
        let fake = temp.path().join("zellij");
        std::fs::write(
            &fake,
            "#!/bin/sh\ncase \"$(cat \"$FAKE_MODE\")\" in\n live) printf 'one\\ntwo\\n';;\n none) echo 'No active zellij sessions found.' >&2; exit 1;;\n exit1) echo 'configuration invalid' >&2; exit 1;;\n dirty) echo unexpected; echo 'No active zellij sessions found.' >&2; exit 1;;\n *) echo boom >&2; exit 2;;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mode = temp.path().join("mode");
        let path = format!("{}:/usr/bin:/bin", temp.path().display());
        let run = |mode_text: &str| {
            std::fs::write(&mode, mode_text).unwrap();
            list_zellij_sessions(
                std::path::Path::new(&path),
                &[("FAKE_MODE", mode.as_path())],
            )
        };
        let live = run("live").unwrap();
        let names: Vec<_> = persistent_sessions(MultiplexerKind::Zellij, &live)
            .unwrap()
            .into_iter()
            .map(|session| session.name)
            .collect();
        assert_eq!(names, ["one", "two"]);
        let none = run("none").unwrap();
        assert!(persistent_sessions(MultiplexerKind::Zellij, &none)
            .unwrap()
            .is_empty());
        let exit1 = run("exit1").unwrap_err();
        assert_eq!(exit1.kind(), "remote_command_failed");
        assert!(exit1.message().contains("configuration invalid"));
        assert!(
            run("dirty").is_err(),
            "no-session text with unexpected stdout is a failure"
        );
        assert!(run("broken").is_err(), "any other failure stays a failure");
        // A PATH holding only a shell: the host has no zellij, wherever the test machine keeps its own.
        let bare = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/bin/sh", bare.path().join("sh")).unwrap();
        let missing = list_zellij_sessions(bare.path(), &[]);
        assert!(missing.is_err(), "a host without zellij stays a failure");
    }
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires zellij on PATH; runs isolated background sessions"]
    fn real_zellij_discovery_lists_live_and_exited_sessions_and_an_empty_list_for_none() {
        use std::process::Command;
        // The IPC socket path may not exceed 107 bytes, so the private tree is short.
        let temp = tempfile::Builder::new()
            .prefix("zd")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temp.path();
        for child in ["rt", "cache", "cfg", "sock", "home"] {
            std::fs::create_dir(root.join(child)).unwrap();
            std::fs::set_permissions(root.join(child), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        std::fs::write(
            root.join("cfg/config.kdl"),
            "show_release_notes false\nshow_startup_tips false\nsession_serialization true\nserialization_interval 1\ndefault_shell \"/bin/sh\"\n",
        )
        .unwrap();
        let zellij = |arguments: &[&str]| {
            let mut command = Command::new("zellij");
            command
                .args(arguments)
                .env("XDG_RUNTIME_DIR", root.join("rt"))
                .env("XDG_CACHE_HOME", root.join("cache"))
                .env("XDG_CONFIG_HOME", root.join("cfg"))
                .env("ZELLIJ_SOCKET_DIR", root.join("sock"))
                .env("HOME", root.join("home"))
                .env("TERM", "xterm-256color")
                .env_remove("ZELLIJ")
                .env_remove("ZELLIJ_SESSION_NAME");
            command.output().unwrap()
        };
        // Servers carry their own socket path on the command line; only ours name this private tree.
        let servers = || -> Vec<i32> {
            let mark = root.join("sock").display().to_string();
            std::fs::read_dir("/proc")
                .unwrap()
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    let pid: i32 = entry.file_name().to_str()?.parse().ok()?;
                    let line = std::fs::read(entry.path().join("cmdline")).ok()?;
                    String::from_utf8_lossy(&line)
                        .contains(&mark)
                        .then_some(pid)
                })
                .collect()
        };
        struct Servers<'a>(&'a dyn Fn() -> Vec<i32>);
        impl Drop for Servers<'_> {
            fn drop(&mut self) {
                for pid in (self.0)() {
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
            }
        }
        let _cleanup = Servers(&servers);
        let list = || {
            let output = list_zellij_sessions(
                std::path::Path::new(&std::env::var("PATH").unwrap()),
                &[
                    ("XDG_RUNTIME_DIR", &root.join("rt")),
                    ("XDG_CACHE_HOME", &root.join("cache")),
                    ("XDG_CONFIG_HOME", &root.join("cfg")),
                    ("ZELLIJ_SOCKET_DIR", &root.join("sock")),
                    ("HOME", &root.join("home")),
                ],
            );
            let output = output.unwrap();
            let mut names: Vec<_> = persistent_sessions(MultiplexerKind::Zellij, &output)
                .unwrap()
                .into_iter()
                .map(|session| session.name)
                .collect();
            names.sort();
            names
        };
        let wait = |description: &str, ready: &dyn Fn() -> bool| {
            for _ in 0..500 {
                if ready() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!("Zellij did not reach {description}");
        };
        assert!(
            list().is_empty(),
            "a host with Zellij and no session lists nothing"
        );
        let config = root.join("cfg/config.kdl");
        for name in ["live-one", "exited-one"] {
            let output = zellij(&[
                "--config",
                config.to_str().unwrap(),
                "attach",
                "--create-background",
                name,
            ]);
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let metadata = root
                .join("cache/zellij/contract_version_1/session_info")
                .join(name);
            wait("its session metadata", &|| {
                metadata.join("session-metadata.kdl").exists()
            });
        }
        // A command pane is what Zellij serializes, so ending the server of a session with one leaves it to resurrect.
        assert!(zellij(&[
            "--session",
            "exited-one",
            "action",
            "new-pane",
            "--",
            "sleep",
            "600"
        ])
        .status
        .success());
        wait("both sessions listed", &|| {
            list() == ["exited-one", "live-one"]
        });
        // Zellij serializes the command pane's layout; ending its server then leaves `exited-one` to resurrect.
        let layout =
            root.join("cache/zellij/contract_version_1/session_info/exited-one/session-layout.kdl");
        wait("a serialized layout", &|| layout.exists());
        let exited: Vec<i32> = servers()
            .into_iter()
            .filter(|pid| {
                std::fs::read(format!("/proc/{pid}/cmdline"))
                    .is_ok_and(|line| String::from_utf8_lossy(&line).contains("exited-one"))
            })
            .collect();
        assert!(!exited.is_empty());
        for pid in exited {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        wait("exited-one marked exited", &|| {
            String::from_utf8_lossy(&zellij(&["list-sessions", "--no-formatting"]).stdout)
                .lines()
                .any(|line| line.starts_with("exited-one") && line.contains("EXITED"))
        });
        assert_eq!(
            list(),
            ["exited-one", "live-one"],
            "an exited session is still listed, and is what an attach would resurrect"
        );
    }
}
