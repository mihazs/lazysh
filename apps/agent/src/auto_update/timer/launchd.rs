//! macOS: a launchd agent in `~/Library/LaunchAgents`, loaded into the user's login session. It
//! needs a logged-in graphical session (the `gui/<uid>` domain); an SSH-only login without one has
//! none, and `enable` then says so instead of pretending.
use super::{install_files, ours, remove_ours, render, state_of, tool, State};
use crate::{Error, Result};
use std::path::PathBuf;

pub const KIND: &str = "launchd";

fn domain() -> String {
    // SAFETY: getuid has no preconditions and cannot fail.
    format!("gui/{}", unsafe { libc::getuid() })
}
fn service() -> String {
    format!("{}/{}", domain(), render::LAUNCHD_LABEL)
}
fn launchctl(args: &[&str]) -> bool {
    tool("launchctl", args).is_some_and(|output| output.success)
}
fn path() -> Option<PathBuf> {
    dirs::home_dir()
        .filter(|home| home.is_absolute())
        .map(|home| {
            home.join("Library/LaunchAgents")
                .join(format!("{}.plist", render::LAUNCHD_LABEL))
        })
}

pub fn state(exe: Option<&str>) -> State {
    let supported = launchctl(&["print", &domain()]);
    let found = vec![path().and_then(|path| ours(&path).ok().flatten())];
    let enabled = supported && launchctl(&["print", &service()]);
    let expected = exe.map(|exe| vec![render::launchd_plist(exe)]);
    state_of(supported, &found, expected, enabled)
}

pub fn enable(exe: &str) -> Result<()> {
    if !launchctl(&["print", &domain()]) {
        return Err(Error::AutoUpdate("timerUnsupported"));
    }
    let path = path().ok_or(Error::AutoUpdate("timerUnsupported"))?;
    let file = path.to_string_lossy().into_owned();
    install_files(
        &[(path, render::launchd_plist(exe))],
        // Unloading first makes a changed file take effect; there is nothing to unload the first time.
        || {
            launchctl(&["bootout", &service()]);
            launchctl(&["bootstrap", &domain(), &file])
        },
        || {
            launchctl(&["bootout", &service()]);
        },
    )
}

pub fn disable() -> Result<()> {
    let Some(path) = path() else {
        return Ok(());
    };
    if matches!(ours(&path), Ok(Some(_))) {
        launchctl(&["bootout", &service()]);
        remove_ours(&[path]);
    }
    Ok(())
}
