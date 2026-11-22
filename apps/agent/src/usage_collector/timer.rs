//! The collector's optional user-level OS timer ([ADR 0005](../../../../docs/architecture/adr-0005-background-usage-collection.md)).
//! No sudo, no elevation and no resident process: `enable` puts a fixed template in the user's own service
//! manager and `disable` takes out only what carries the lazysh marker. Every backend compiles on every
//! host, so each can be exercised with stand-in tools.
mod launchd;
mod render;
mod schtasks;
mod systemd;

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Systemd,
    Launchd,
    Schtasks,
}
impl Backend {
    /// The host's own service manager. Debug builds, which only tests use, may name another one so that
    /// every backend can be exercised against stand-in tools.
    pub fn host() -> Self {
        #[cfg(debug_assertions)]
        match std::env::var("LAZYSH_USAGE_TIMER_BACKEND_FOR_TESTS").as_deref() {
            Ok("systemd") => return Self::Systemd,
            Ok("launchd") => return Self::Launchd,
            Ok("schtasks") => return Self::Schtasks,
            _ => {}
        }
        if cfg!(windows) {
            Self::Schtasks
        } else if cfg!(target_os = "macos") {
            Self::Launchd
        } else {
            Self::Systemd
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Absent,
    Installed,
    /// Something is there that is not exactly what `enable` writes, or is not loaded.
    Drift,
    /// This account cannot hold a timer (no user service manager or login session).
    Unsupported,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    /// Nothing was changed: the account cannot have a timer.
    Unsupported,
    /// The system or an existing file refused; what was written is put back.
    Refused(&'static str),
}

/// What the timer would run: the absolute path of this executable.
pub fn executable() -> Result<String, Failure> {
    let path = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|_| Failure::Refused("The executable path is unavailable"))?;
    let path = path
        .to_str()
        .filter(|path| !path.chars().any(char::is_control))
        .ok_or(Failure::Refused(
            "The executable path cannot be written to a timer",
        ))?;
    // Windows canonical paths carry a verbatim prefix that Task Scheduler does not take.
    Ok(path.strip_prefix(r"\\?\").unwrap_or(path).to_owned())
}

/// Installs the timer. `before_write` runs once the account is known to be able to hold a timer and before
/// anything is written, so a caller can take its lifecycle lock without creating state on an unsupported host.
pub fn install(
    backend: Backend,
    exe: &str,
    before_write: &mut dyn FnMut() -> Result<(), Failure>,
) -> Result<(), Failure> {
    match backend {
        Backend::Systemd => systemd::install(exe, before_write),
        Backend::Launchd => launchd::install(exe, before_write),
        Backend::Schtasks => schtasks::install(exe, before_write),
    }
}
pub fn remove(backend: Backend) -> Result<(), Failure> {
    match backend {
        Backend::Systemd => systemd::remove(),
        Backend::Launchd => launchd::remove(),
        Backend::Schtasks => schtasks::remove(),
    }
}
pub fn state(backend: Backend, exe: &str) -> State {
    match backend {
        Backend::Systemd => systemd::state(exe),
        Backend::Launchd => launchd::state(exe),
        Backend::Schtasks => schtasks::state(exe),
    }
}

/// Whether the user manager keeps running with no session (Linux only); `None` when unknown or not applicable.
pub fn linger(backend: Backend) -> Option<bool> {
    (backend == Backend::Systemd)
        .then(systemd::linger)
        .flatten()
}

/// Run a service-manager tool with no input and no terminal; `None` when it cannot start.
fn tool(program: &str, args: &[&str]) -> Option<std::process::Output> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()
}
fn succeeds(program: &str, args: &[&str]) -> bool {
    tool(program, args).is_some_and(|output| output.status.success())
}

/// A file this module wrote, or the content it replaced, so a failed install puts everything back.
struct Placed {
    path: PathBuf,
    previous: Option<String>,
}
const MAX_FILE: u64 = 64 * 1024;
/// `Some(text)` for a regular file that carries the marker, `None` when absent. A link, a special file,
/// an unreadable one or a file without the marker is foreign and refused.
fn ours(path: &Path) -> Result<Option<String>, Failure> {
    let foreign = Failure::Refused("A file that lazysh did not write is in the way");
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(foreign),
        Ok(metadata) if !metadata.is_file() || metadata.len() > MAX_FILE => Err(foreign),
        Ok(_) => match fs::read_to_string(path) {
            Ok(text) if text.contains(render::MARKER) => Ok(Some(text)),
            _ => Err(foreign),
        },
    }
}
fn place(path: &Path, text: &str) -> Result<Placed, Failure> {
    let previous = ours(path)?;
    let refused = |_| Failure::Refused("The timer file cannot be written");
    let parent = path
        .parent()
        .ok_or(Failure::Refused("No timer directory"))?;
    fs::create_dir_all(parent).map_err(refused)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(refused)?;
    std::io::Write::write_all(&mut file, text.as_bytes()).map_err(refused)?;
    file.persist(path).map_err(|error| refused(error.error))?;
    Ok(Placed {
        path: path.to_owned(),
        previous,
    })
}
/// Whether `placed` replaced a timer file of ours, that is, whether an earlier install exists to go back to.
fn replaced(placed: &Placed) -> bool {
    placed.previous.is_some()
}
fn undo(placed: Placed) {
    let _ = match placed.previous {
        Some(text) => fs::write(&placed.path, text),
        None => fs::remove_file(&placed.path),
    };
}
/// Remove `path` only when it is ours; a foreign file is left alone and reported.
fn remove_ours(path: &Path) -> Result<(), Failure> {
    if ours(path)?.is_some() {
        fs::remove_file(path).map_err(|_| Failure::Refused("The timer file cannot be removed"))?;
    }
    Ok(())
}

/// The numeric user id the user's service manager is addressed by; there is none on Windows.
fn uid() -> u32 {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        unsafe { libc::geteuid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}
