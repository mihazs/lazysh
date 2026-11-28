//! The optional operating system timer: `auto-update enable` installs one, `disable` removes it, and
//! `status` reports what the system really has. It exists for hosts where nothing reads a snapshot for
//! days; the companion's own opportunistic check needs no timer.
//!
//! It is the user's own: a systemd user timer on Linux, a launchd agent on macOS, a Scheduled Task on
//! Windows. Nothing here uses `sudo` or elevation, writes outside the user's own configuration, or
//! touches a file that does not carry our marker. The timer only wakes `lazysh-agent auto-update
//! run` of the managed copy, which decides from the settings whether a check is due; so changing the
//! settings never means touching the timer.
use super::{AutoUpdate, Policy};
use crate::{Error, Result};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(crate) mod render;
#[cfg(target_os = "linux")]
mod systemd;
#[cfg(target_os = "linux")]
use systemd as os;
// The macOS and Windows drivers are also compiled where they are not used (Unix test builds), so that
// a change that breaks them fails on every developer's machine and in every CI, not only in the
// release build of that platform.
#[cfg(any(target_os = "macos", all(test, unix)))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod launchd;
#[cfg(target_os = "macos")]
use launchd as os;
#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
mod schtasks;
#[cfg(windows)]
use schtasks as os;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod unsupported;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
use unsupported as os;

/// What the system really has, read each time and never cached.
pub(super) struct State {
    /// Can this account have a timer at all (a user manager, a login domain, a scheduler).
    pub supported: bool,
    /// Our files, or our task, are there.
    pub installed: bool,
    /// The system will run it.
    pub enabled: bool,
    /// What is there is not what `enable` would write now (another path, an edited file), or only
    /// part of it is there or enabled.
    pub drift: bool,
}

/// The managed companion, as an absolute path a unit can carry as it is (see
/// [`render::path_is_representable`]). Anything else is not a path the app or the installer creates.
fn executable() -> Result<String> {
    crate::update::managed_executable()
        .and_then(|path| path.to_str().map(str::to_owned))
        .filter(|path| {
            Path::new(path).is_absolute()
                && render::path_is_representable(path, cfg!(target_os = "linux"))
        })
        .ok_or(Error::AutoUpdate("unsafeInstallLocation"))
}

pub(super) struct Output {
    pub success: bool,
    pub stdout: String,
}
/// Run a tool of the system with a time limit. `None` when it cannot start or overruns: a user
/// manager that does not answer must not hang the companion.
fn tool(program: &str, args: &[&str]) -> Option<Output> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // CREATE_NO_WINDOW: a tool started from a process without a console must not open one.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().ok()? {
            let mut stdout = Vec::new();
            if let Some(pipe) = child.stdout.take() {
                let _ = pipe.take(64 * 1024).read_to_end(&mut stdout);
            }
            return Some(Output {
                success: status.success(),
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
            });
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn failed() -> Error {
    Error::AutoUpdate("timerFailed")
}
/// The text of `path` when it is ours (a regular file carrying the marker), `None` when it is not
/// there, and a refusal for anything else: a file somebody else wrote, a link, a directory. Nothing
/// that is not ours is ever replaced or removed.
fn ours(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(metadata) if metadata.is_file() => {}
        _ => return Err(failed()),
    }
    let mut text = String::new();
    fs::File::open(path)
        .and_then(|file| file.take(16 * 1024).read_to_string(&mut text))
        .map_err(|_| failed())?;
    text.contains(render::MARKER)
        .then_some(Some(text))
        .ok_or_else(failed)
}
/// Replace `path` whole or not at all.
fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let directory = path.parent().ok_or_else(failed)?;
    fs::create_dir_all(directory).map_err(|_| failed())?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|_| failed())?;
    file.write_all(text.as_bytes()).map_err(|_| failed())?;
    file.persist(path).map_err(|_| failed())?;
    Ok(())
}
/// Write `files`, then `apply` them to the system; when that fails put every file back as it was
/// (removing the ones that were not there) and `undo` whatever `apply` did.
fn install_files(
    files: &[(PathBuf, String)],
    apply: impl FnOnce() -> bool,
    undo: impl FnOnce(),
) -> Result<()> {
    let before = files
        .iter()
        .map(|(path, _)| ours(path))
        .collect::<Result<Vec<_>>>()?;
    let put_back = |written: usize| {
        for ((path, _), earlier) in files.iter().zip(&before).take(written) {
            let _ = match earlier {
                Some(text) => write_atomic(path, text),
                None => fs::remove_file(path).map_err(|_| failed()),
            };
        }
    };
    for (index, (path, text)) in files.iter().enumerate() {
        if let Err(error) = write_atomic(path, text) {
            put_back(index);
            return Err(error);
        }
    }
    if apply() {
        return Ok(());
    }
    put_back(files.len());
    undo();
    Err(failed())
}
/// Remove the files of `paths` that are ours.
fn remove_ours(paths: &[PathBuf]) {
    for path in paths {
        if matches!(ours(path), Ok(Some(_))) {
            let _ = fs::remove_file(path);
        }
    }
}
/// What the system has, for files that should be exactly `expected` (when the managed companion is
/// known) and a timer the system `enabled` or not. Drift is anything short of both.
fn state_of(
    supported: bool,
    found: &[Option<String>],
    expected: Option<Vec<String>>,
    enabled: bool,
) -> State {
    let installed = found.iter().all(Option::is_some);
    let exact = installed
        && expected.is_some_and(|expected| {
            found
                .iter()
                .zip(&expected)
                .all(|(found, expected)| found.as_ref() == Some(expected))
        });
    let present = enabled || found.iter().any(Option::is_some);
    State {
        supported,
        installed,
        enabled,
        drift: present && !(exact && enabled),
    }
}

/// `timer` of `status`, `enable` and `disable`.
pub(super) fn status() -> Value {
    let state = os::state(executable().ok().as_deref());
    json!({"kind": os::KIND, "supported": state.supported, "installed": state.installed,
        "enabled": state.enabled, "drift": state.drift})
}

/// Install the timer. It refuses while the policy is `off` (a timer for a feature that is off would
/// only wake the companion for nothing) and when the system cannot have one, and a failure leaves
/// the files and the registration as they were.
pub(super) fn enable(settings: &AutoUpdate) -> Result<Value> {
    if settings.policy == Policy::Off {
        return Err(Error::AutoUpdate("policyOff"));
    }
    os::enable(&executable()?)?;
    Ok(json!({"schemaVersion": 1, "timer": status()}))
}

/// Remove the timer. Idempotent, and it removes only what carries our marker.
pub(super) fn disable() -> Result<Value> {
    os::disable()?;
    Ok(json!({"schemaVersion": 1, "timer": status()}))
}
