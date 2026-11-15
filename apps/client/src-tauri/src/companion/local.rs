//! The companion on this device: no SSH and no POSIX probe. The builders' one-line commands are
//! split back into argv and run on the executable found here, never through a shell.
use super::{error, Result};
use crate::host::Cmd;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

const NAME: &str = if cfg!(windows) {
    "lazysh-agent.exe"
} else {
    "lazysh-agent"
};

/// A command line made only of bare safe words and `ssh::quote`d text, the form every companion
/// builder writes, as the words it stands for. Anything a shell would interpret is refused.
fn words(line: &str) -> Result<Vec<String>> {
    let (mut words, mut word, mut started, mut quoted) = (Vec::new(), String::new(), false, false);
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '\'') => quoted = false,
            (true, c) => word.push(c),
            (false, '\'') => (quoted, started) = (true, true),
            // `quote` writes a literal single quote as `'\''`.
            (false, '\\') if chars.as_str().starts_with('\'') => {
                chars.next();
                word.push('\'');
                started = true;
            }
            (false, ' ') if started => {
                words.push(std::mem::take(&mut word));
                started = false;
            }
            (false, ' ') => {}
            (false, c) if c.is_ascii_alphanumeric() || "-_./:,+@=".contains(c) => {
                word.push(c);
                started = true;
            }
            _ => return Err(error("companion_command", "Invalid companion command")),
        }
    }
    if quoted {
        return Err(error("companion_command", "Invalid companion command"));
    }
    if started {
        words.push(word);
    }
    Ok(words)
}

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
            // SAFETY: geteuid has no preconditions.
            meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0
        }) && runnable(path)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}
fn managed_dir() -> Option<PathBuf> {
    // shortcut: no Windows managed copy; the companion installer for Windows is #490.
    if cfg!(windows) {
        return None;
    }
    let home = crate::local::home_dir()?;
    let data = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"))
    };
    Some(data.join("lazysh/companion"))
}
/// Bundled beside the app executable, then the managed copy, then the PATH.
fn find(exe_dir: Option<&Path>, managed_dir: Option<&Path>, path: &OsStr) -> Option<PathBuf> {
    let bundled = exe_dir
        .map(|dir| dir.join(NAME))
        .filter(|file| runnable(file));
    let managed = managed_dir
        .map(|dir| dir.join(NAME))
        .filter(|file| owned_managed(file));
    bundled.or(managed).or_else(|| {
        std::env::split_paths(path)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(NAME))
            .find(|file| runnable(file))
    })
}
async fn program() -> Option<String> {
    let path = crate::host::login_path()
        .await
        .cloned()
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    let exe = std::env::current_exe().ok()?;
    find(exe.parent(), managed_dir().as_deref(), &path)?
        .into_os_string()
        .into_string()
        .ok()
}
/// Whether a local session can run the companion at all.
pub(crate) async fn available() -> bool {
    program().await.is_some()
}
/// The argv of a companion command line with the program resolved to an absolute path.
pub(crate) async fn command(line: &str) -> Result<Cmd> {
    let mut words = words(line)?.into_iter();
    if words.next().as_deref() != Some("lazysh-agent") {
        return Err(error("companion_command", "Invalid companion command"));
    }
    let program = program().await.ok_or_else(|| {
        error(
            "remote_command_failed",
            "lazysh-agent is not available on this device",
        )
    })?;
    Ok(words.fold(Cmd::new(&[], &[program.as_str()]), |cmd, word| {
        cmd.arg(&word)
    }))
}

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;
