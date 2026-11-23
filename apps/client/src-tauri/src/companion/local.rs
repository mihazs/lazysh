//! The companion on this device: no SSH and no POSIX probe. The builders' one-line commands are
//! split back into argv and run on the executable found here, never through a shell.
use super::{error, words, Result};
use crate::host::Cmd;
use serde::Serialize;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

const NAME: &str = if cfg!(windows) {
    "lazysh-agent.exe"
} else {
    "lazysh-agent"
};

fn runnable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}
/// The managed copy sits where the remote installer puts it. Another account must not be able
/// to replace what this one runs: it is the user's own file, not a link, writable by nobody else.
fn owned_managed(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::symlink_metadata(path).is_ok_and(|meta| {
            // A link is refused by its type: its own mode says nothing (Linux gives every link 0777, which the
            // write check below happened to reject; macOS gives it 0755, which it accepted).
            // SAFETY: geteuid has no preconditions.
            !meta.file_type().is_symlink()
                && meta.uid() == unsafe { libc::geteuid() }
                && meta.mode() & 0o022 == 0
        }) && runnable(path)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}
/// `data` replaces the platform data directory, so a test never writes the real one.
fn managed_dir(data: Option<PathBuf>) -> Option<PathBuf> {
    // shortcut: no Windows managed copy; the companion installer for Windows is #490.
    if cfg!(windows) {
        return None;
    }
    let data = match data {
        Some(data) => data,
        None => {
            let home = crate::local::home_dir()?;
            if cfg!(target_os = "macos") {
                home.join("Library/Application Support")
            } else {
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .filter(|dir| dir.is_absolute())
                    .unwrap_or_else(|| home.join(".local/share"))
            }
        }
    };
    Some(data.join("lazysh/companion"))
}
/// Where the resolved companion came from, as the companion panel names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Source {
    Bundled,
    Managed,
    Path,
}
/// Bundled beside the app executable, then the managed copy, then the PATH.
fn find(
    exe_dir: Option<&Path>,
    managed_dir: Option<&Path>,
    path: &OsStr,
) -> Option<(PathBuf, Source)> {
    let bundled = exe_dir
        .map(|dir| dir.join(NAME))
        .filter(|file| runnable(file))
        .map(|file| (file, Source::Bundled));
    let managed = managed_dir
        .map(|dir| dir.join(NAME))
        .filter(|file| owned_managed(file))
        .map(|file| (file, Source::Managed));
    bundled.or(managed).or_else(|| {
        std::env::split_paths(path)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(NAME))
            .find(|file| runnable(file))
            .map(|file| (file, Source::Path))
    })
}
async fn resolve() -> Option<(String, Source)> {
    let path = crate::host::local_path().await;
    let exe = std::env::current_exe().ok()?;
    let (file, source) = find(exe.parent(), managed_dir(None).as_deref(), &path)?;
    Some((file.into_os_string().into_string().ok()?, source))
}
/// Which companion a local session would run, or `None` when it cannot run one at all.
pub(crate) async fn source() -> Option<Source> {
    resolve().await.map(|(_, source)| source)
}
/// The argv of a companion command line with the program resolved to an absolute path.
pub(crate) async fn command(line: &str) -> Result<Cmd> {
    let (program, _) = resolve().await.ok_or_else(|| {
        error(
            "remote_command_failed",
            "lazysh-agent is not available on this device",
        )
    })?;
    argv(line, &program)
}
fn argv(line: &str, program: &str) -> Result<Cmd> {
    let mut words = words(line)?.into_iter();
    if words.next().as_deref() != Some("lazysh-agent") {
        return Err(error("companion_command", "Invalid companion command"));
    }
    Ok(words.fold(
        Cmd::new(
            &[("LAZYSH_APP_VERSION", env!("CARGO_PKG_VERSION"))],
            &[program],
        ),
        |cmd, word| cmd.arg(&word),
    ))
}

/// `lazysh-agent --version` of an executable that answers in time: the bare version.
async fn version_of(path: &Path) -> Option<String> {
    let run = async {
        let mut attempts = 0;
        loop {
            let output = tokio::process::Command::new(path)
                .arg("--version")
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .output()
                .await;
            match output {
                Err(ref error)
                    if error.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 100 =>
                {
                    attempts += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                result => break result,
            }
        }
    };
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), run)
        .await
        .ok()?
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let version = text.trim().strip_prefix("lazysh-agent ")?;
    output.status.success().then(|| version.to_owned())
}
/// Whether an installed version can stand in for the bundled one: not older when both are release
/// versions, otherwise the very same text.
fn at_least(installed: &str, bundled: &str) -> bool {
    match (
        lazysh_companion_release::version(installed),
        lazysh_companion_release::version(bundled),
    ) {
        (Some(installed), Some(bundled)) => installed >= bundled,
        _ => installed == bundled,
    }
}
/// Copies `from` to `to` beside it as a new file, so a hook that runs `to` during the replacement
/// sees the old or the new executable, never a partial one. The directory is the user's own.
#[cfg(unix)]
fn place(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    let dir = to.parent().expect("a managed copy has a directory");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    // SAFETY: geteuid has no preconditions.
    let own = std::fs::symlink_metadata(dir).is_ok_and(|meta| {
        meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0
    });
    if !own {
        return Err(std::io::Error::other(
            "the managed directory is not private",
        ));
    }
    let staged = dir.join(format!(".{NAME}.{}", std::process::id()));
    let _ = std::fs::remove_file(&staged);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&staged)?;
    let copied = std::io::copy(&mut std::fs::File::open(from)?, &mut file)
        .and_then(|_| file.sync_all())
        .and_then(|_| std::fs::rename(&staged, to));
    if copied.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    copied
}
#[cfg(not(unix))]
fn place(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("no managed copy on this platform"))
}
/// Leaves `target` a private copy of `bundled`, or an executable at least as new that is already there.
async fn ensure_copy(bundled: &Path, target: &Path) -> Result<()> {
    let wanted = version_of(bundled).await.ok_or_else(|| {
        error(
            "remote_command_failed",
            "The bundled lazysh-agent did not report its version",
        )
    })?;
    let kept = owned_managed(target)
        && version_of(target)
            .await
            .is_some_and(|installed| at_least(&installed, &wanted));
    if kept {
        return Ok(());
    }
    let (from, to) = (bundled.to_owned(), target.to_owned());
    let placed = tokio::task::spawn_blocking(move || place(&from, &to)).await;
    if matches!(placed, Ok(Ok(()))) && owned_managed(target) {
        return Ok(());
    }
    Err(error(
        "remote_command_failed",
        "The bundled lazysh-agent could not be copied to the managed folder",
    ))
}
/// Hook setup binds hooks to the executable that runs it, and its plan covers that file. The
/// companion bundled beside the app can sit on an ephemeral mount (an AppImage), so setup runs a
/// private, version-checked copy of it in the managed directory instead. Any other companion
/// (managed, on the `PATH`, or a platform without a managed directory) already has a lasting path.
pub(crate) async fn stable_command(line: &str, data: Option<PathBuf>) -> Result<Cmd> {
    let bundled = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(NAME)))
        .filter(|file| runnable(file));
    let (Some(bundled), Some(managed)) = (bundled, managed_dir(data)) else {
        return command(line).await;
    };
    let target = managed.join(NAME);
    ensure_copy(&bundled, &target).await?;
    let program = target.to_str().ok_or_else(|| {
        error(
            "remote_command_failed",
            "The managed folder is not valid text",
        )
    })?;
    argv(line, program)
}

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;
