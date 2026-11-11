//! One host context for host tools: an SSH session or this desktop device.
//! The remote arm calls the existing SSH code unchanged; the local arm runs argv
//! directly (never a shell string) and reads files with `std::fs`.
use crate::{
    app_lock::AccessLease,
    local::LocalState,
    ssh::{self, AppState, FileEntry, Result, SshError, FILE_LIMIT, OP_TIMEOUT},
};
use std::{sync::Arc, time::Duration};
use tokio::io::AsyncReadExt;

pub(crate) enum Host {
    Remote(Arc<ssh::Session>),
    #[cfg(desktop)]
    Local(LocalHost),
}

/// A native-built command: constant environment plus argv. Remote hosts receive it
/// rendered as a POSIX command line; local hosts execute the argv itself.
pub(crate) struct Cmd {
    env: &'static [(&'static str, &'static str)],
    argv: Vec<String>,
}
impl Cmd {
    pub(crate) fn new(env: &'static [(&'static str, &'static str)], argv: &[&str]) -> Self {
        Self {
            env,
            argv: argv.iter().map(|arg| (*arg).to_owned()).collect(),
        }
    }
    pub(crate) fn arg(mut self, arg: &str) -> Self {
        self.argv.push(arg.to_owned());
        self
    }
    /// The POSIX command line sent over SSH; every argument is one shell word.
    pub(crate) fn render(&self) -> String {
        self.env
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .chain(self.argv.iter().map(|arg| {
                // No `=`: zsh expands a word that starts with it (EQUALS).
                if !arg.is_empty()
                    && arg
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_./:,+@".contains(&b))
                {
                    arg.clone()
                } else {
                    ssh::quote(arg)
                }
            }))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

impl Host {
    /// Resolves a session id; `local:` ids need an adopted, live local terminal.
    pub(crate) async fn resolve(
        state: &AppState,
        local: &LocalState,
        id: &str,
        lease: &AccessLease,
    ) -> Result<Self> {
        if id.starts_with("local:") {
            #[cfg(desktop)]
            return crate::local::usage_session(local, id, lease)
                .map(|cancel| Self::Local(LocalHost { cancel }))
                .map_err(|error| SshError::new("disconnected", error));
            #[cfg(not(desktop))]
            {
                let _ = (local, lease);
                return Err(SshError::new(
                    "disconnected",
                    "Local terminals require the desktop app",
                ));
            }
        }
        Ok(Self::Remote(state.session(id).await?))
    }
    /// Resolves a session for a tool that names `dir`; local Windows sessions refuse
    /// UNC and device paths here, before Git could open an SMB share with them.
    pub(crate) async fn resolve_dir(
        state: &AppState,
        local: &LocalState,
        id: &str,
        lease: &AccessLease,
        dir: &str,
    ) -> Result<Self> {
        let host = Self::resolve(state, local, id, lease).await?;
        #[cfg(desktop)]
        if matches!(host, Self::Local(_)) {
            local_fs::resolve(dir)?;
        }
        #[cfg(not(desktop))]
        let _ = dir;
        Ok(host)
    }
    /// A one-shot command with the default 30 s deadline and 1 MiB output bound.
    pub(crate) async fn run(&self, lease: &AccessLease, cmd: &Cmd) -> Result<String> {
        self.exec(lease, cmd, OP_TIMEOUT, FILE_LIMIT as usize).await
    }
    pub(crate) async fn exec(
        &self,
        lease: &AccessLease,
        cmd: &Cmd,
        deadline: Duration,
        limit: usize,
    ) -> Result<String> {
        match self {
            Self::Remote(session) => {
                ssh::exec_bounded(session, cmd.render(), lease, deadline, limit, None).await
            }
            #[cfg(desktop)]
            Self::Local(host) => ssh::command_text(host.exec(lease, cmd, deadline, limit).await?),
        }
    }
    /// Raw stdout bytes of a one-shot command with the default bounds.
    pub(crate) async fn run_bytes(&self, lease: &AccessLease, cmd: &Cmd) -> Result<Vec<u8>> {
        match self {
            Self::Remote(session) => {
                ssh::exec(session, lease, format!("{} | od -An -v -tu1", cmd.render()))
                    .await?
                    .split_whitespace()
                    .map(|byte| {
                        byte.parse::<u8>().map_err(|_| {
                            SshError::new("invalid_output", "Invalid command output encoding")
                        })
                    })
                    .collect()
            }
            #[cfg(desktop)]
            Self::Local(host) => host.exec(lease, cmd, OP_TIMEOUT, FILE_LIMIT as usize).await,
        }
    }
    pub(crate) async fn list_dir(
        &self,
        lease: &AccessLease,
        path: String,
    ) -> Result<Vec<FileEntry>> {
        match self {
            Self::Remote(session) => ssh::sftp_list_dir(session, lease, path).await,
            #[cfg(desktop)]
            Self::Local(host) => host.blocking(lease, move || local_fs::list(&path)).await,
        }
    }
    /// The login home directory: SFTP's canonical form of its starting directory over
    /// SSH, the desktop user's home for a local session. Always absolute.
    pub(crate) async fn home(&self, lease: &AccessLease) -> Result<String> {
        match self {
            Self::Remote(session) => ssh::sftp_home(session, lease).await,
            #[cfg(desktop)]
            Self::Local(host) => host.blocking(lease, local_fs::home).await,
        }
    }
    /// UTF-8 text preview limited to 1 MiB.
    pub(crate) async fn read_text(&self, lease: &AccessLease, path: String) -> Result<String> {
        match self {
            Self::Remote(session) => ssh::sftp_read_text(session, lease, path).await,
            #[cfg(desktop)]
            Self::Local(host) => ssh::preview_text(
                host.blocking(lease, move || local_fs::read(&path, FILE_LIMIT))
                    .await?,
            ),
        }
    }
    /// At most `limit + 1` bytes of a regular file; symbolic links are refused.
    pub(crate) async fn read_regular(
        &self,
        lease: &AccessLease,
        path: String,
        limit: u64,
    ) -> Result<Vec<u8>> {
        match self {
            Self::Remote(session) => tokio::time::timeout(OP_TIMEOUT, async {
                let sftp = ssh::sftp(session, lease).await?;
                let metadata = sftp.symlink_metadata(&path).await?;
                if metadata.is_symlink() || !metadata.is_regular() {
                    return Err(not_regular());
                }
                let file = sftp.open(path).await?;
                let mut bytes = Vec::new();
                file.take(limit + 1).read_to_end(&mut bytes).await?;
                Ok(bytes)
            })
            .await
            .map_err(|_| SshError::new("timeout", "Reading file timed out"))?,
            #[cfg(desktop)]
            Self::Local(host) => {
                host.blocking(lease, move || local_fs::read(&path, limit))
                    .await
            }
        }
    }
}
fn not_regular() -> SshError {
    SshError::new(
        "not_regular_file",
        "Preview requires a regular file; symbolic links are not followed",
    )
}

#[cfg(desktop)]
pub(crate) struct LocalHost {
    cancel: tokio::sync::watch::Receiver<bool>,
}
/// Multiplexer and shell start-up variables a lazysh started inside a multiplexer would leak.
#[cfg(desktop)]
const INHERITED: [&str; 7] = [
    "TMUX",
    "ZELLIJ",
    "ZELLIJ_SESSION_NAME",
    "HERDR_SESSION",
    "HERDR_SOCKET_PATH",
    "ENV",
    "BASH_ENV",
];
#[cfg(desktop)]
impl LocalHost {
    async fn exec(
        &self,
        lease: &AccessLease,
        cmd: &Cmd,
        deadline: Duration,
        limit: usize,
    ) -> Result<Vec<u8>> {
        use std::process::Stdio;
        let (program, args) = cmd
            .argv
            .split_first()
            .ok_or_else(|| SshError::new("invalid_command", "Empty command"))?;
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .envs(cmd.env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for name in INHERITED {
            command.env_remove(name);
        }
        lease
            .check()
            .map_err(|_| SshError::new("app_locked", "App access changed"))?;
        let path = ssh::until_closed(lease, self.cancel.clone(), async { Ok(login_path().await) })
            .await
            .map_err(|error| {
                if lease.check().is_err() {
                    SshError::new("app_locked", "App access changed")
                } else {
                    error
                }
            })?;
        if let Some(path) = path {
            command.env("PATH", path);
        }
        // Relative paths mean the home directory, as they do over SSH.
        if let Some(home) = crate::local::home_dir() {
            command.current_dir(home);
        }
        let (mut child, _tree) = lease
            .with_current(|| {
                // Hold the cancellation read guard until spawn completes, so close and
                // lease revocation cannot pass the authority check before the child starts.
                let cancelled = self.cancel.borrow();
                if *cancelled {
                    return Err(SshError::new("disconnected", "Session closed"));
                }
                lazysh_account_usage::spawn_owned(&mut command).map_err(|error| {
                    SshError::new(
                        "remote_command_failed",
                        format!("Could not start {program}: {error}"),
                    )
                })
            })
            .map_err(|_| SshError::new("app_locked", "App access changed"))??;
        let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take())
        else {
            return Err(SshError::new(
                "remote_command_failed",
                "Command pipes are unavailable",
            ));
        };
        let result = ssh::until_closed(lease, self.cancel.clone(), async {
            tokio::time::timeout(deadline, async {
                let (mut bytes, mut error) = (Vec::new(), Vec::new());
                let (mut out, mut err) = ([0u8; 8192], [0u8; 8192]);
                let (mut out_open, mut err_open) = (true, true);
                while out_open || err_open {
                    tokio::select! {
                        read = stdout.read(&mut out), if out_open => match read? {
                            0 => out_open = false,
                            n => bytes.extend_from_slice(&out[..n]),
                        },
                        read = stderr.read(&mut err), if err_open => match read? {
                            0 => err_open = false,
                            n => error.extend_from_slice(&err[..n]),
                        },
                    }
                    ssh::check_output_budget(bytes.len() + error.len(), limit)?;
                }
                let status = child.wait().await?;
                ssh::check_exit(status.code().map(|code| code as u32), &error)?;
                Ok(bytes)
            })
            .await
            .map_err(|_| SshError::new("timeout", "Local command timed out"))?
        })
        .await;
        if result.is_err() {
            // Kill and reap before returning; the tree guard then ends any descendants.
            let _ = child.kill().await;
        }
        result
    }
    async fn blocking<T: Send + 'static>(
        &self,
        lease: &AccessLease,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        ssh::until_closed(lease, self.cancel.clone(), async {
            tokio::time::timeout(OP_TIMEOUT, tokio::task::spawn_blocking(work))
                .await
                .map_err(|_| SshError::new("timeout", "Local file operation timed out"))?
                .map_err(|_| SshError::new("local_io", "Local file operation stopped"))?
        })
        .await
    }
}

/// The login shell's PATH, probed once with a constant command: a GUI start often
/// lacks the user-level tool directories a terminal has. Windows keeps its PATH.
#[cfg(desktop)]
async fn login_path() -> Option<&'static std::ffi::OsString> {
    #[cfg(unix)]
    {
        static PATH: tokio::sync::OnceCell<Option<std::ffi::OsString>> =
            tokio::sync::OnceCell::const_new();
        PATH.get_or_init(probe_login_path).await.as_ref()
    }
    #[cfg(not(unix))]
    {
        None
    }
}
#[cfg(all(desktop, unix))]
async fn probe_login_path() -> Option<std::ffi::OsString> {
    use std::{os::unix::ffi::OsStringExt, process::Stdio};
    const MARKER: &[u8] = b"__LAZYSH_LOGIN_PATH__";
    let shell = portable_pty::CommandBuilder::new_default_prog().get_shell();
    let mut command = tokio::process::Command::new(shell);
    command
        .args(["-lc", "printf '\\n__LAZYSH_LOGIN_PATH__%s\\n' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for name in INHERITED {
        command.env_remove(name);
    }
    let (child, _tree) = lazysh_account_usage::spawn_owned(&mut command).ok()?;
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    let path = output
        .stdout
        .split(|b| *b == b'\n')
        .rev()
        .find_map(|line| line.strip_prefix(MARKER))?;
    (!path.is_empty() && !path.contains(&0)).then(|| std::ffi::OsString::from_vec(path.to_vec()))
}
/// Whether `program` resolves on the PATH local commands receive.
#[cfg(desktop)]
pub(crate) async fn local_program(program: &str) -> bool {
    let path = match login_path().await {
        Some(path) => path.clone(),
        None => std::env::var_os("PATH").unwrap_or_default(),
    };
    let name = if cfg!(windows) {
        format!("{program}.exe")
    } else {
        program.to_owned()
    };
    std::env::split_paths(&path).any(|directory| directory.join(&name).is_file())
}

#[cfg(desktop)]
mod local_fs {
    use super::*;
    use std::{fs, io::Read, path::PathBuf};

    /// Absolute drive or POSIX paths; relative paths resolve under the home directory.
    pub(super) fn resolve(path: &str) -> Result<PathBuf> {
        let path = std::path::Path::new(path);
        let path = if path.is_absolute() {
            path.to_owned()
        } else {
            crate::local::home_dir()
                .ok_or_else(|| SshError::new("invalid_path", "The home directory is unavailable"))?
                .join(path)
        };
        // UNC and device namespaces stay closed; WSL paths arrive with their own target.
        #[cfg(windows)]
        if !matches!(path.components().next(), Some(std::path::Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
        {
            return Err(SshError::new(
                "invalid_path",
                "Enter a drive path such as C:\\Users",
            ));
        }
        Ok(path)
    }
    pub(super) fn home() -> Result<String> {
        crate::local::home_dir()
            .and_then(|home| home.into_os_string().into_string().ok())
            .ok_or_else(|| SshError::new("home_unavailable", "The home directory is unavailable"))
            .and_then(ssh::absolute_home)
    }
    pub(super) fn list(path: &str) -> Result<Vec<FileEntry>> {
        let mut entries = Vec::new();
        let mut name_bytes = 0usize;
        for entry in fs::read_dir(resolve(path)?)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            name_bytes += name.len();
            ssh::admit_entry(entries.len(), name_bytes)?;
            // Entry metadata does not follow symbolic links, like SFTP directory attributes.
            let (is_dir, size) = entry
                .metadata()
                .map(|metadata| (metadata.is_dir(), metadata.len()))
                .unwrap_or((false, 0));
            entries.push(FileEntry { name, is_dir, size });
        }
        ssh::sort_entries(&mut entries);
        Ok(entries)
    }
    pub(super) fn read(path: &str, limit: u64) -> Result<Vec<u8>> {
        let path = resolve(path)?;
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(not_regular());
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        // Refuse a link swapped in after the check, and never block on a FIFO.
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::custom_flags(
            &mut options,
            libc::O_NOFOLLOW | libc::O_NONBLOCK,
        );
        #[cfg(windows)]
        std::os::windows::fs::OpenOptionsExt::custom_flags(
            &mut options,
            0x0020_0000, // FILE_FLAG_OPEN_REPARSE_POINT
        );
        let file = options.open(&path)?;
        let metadata = file.metadata()?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(not_regular());
        }
        let mut bytes = Vec::new();
        file.take(limit + 1).read_to_end(&mut bytes)?;
        Ok(bytes)
    }
}

#[cfg(all(test, desktop))]
#[path = "host_tests.rs"]
mod tests;
