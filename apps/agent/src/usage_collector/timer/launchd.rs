//! macOS: a launchd agent of the user's login session.
use super::{
    ours, place, remove_ours, render, render::LAUNCHD_LABEL, succeeds, undo, Failure, State,
};
use std::path::PathBuf;

fn path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| {
        home.join("Library/LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist"))
    })
}
fn domain() -> String {
    format!("gui/{}", super::uid())
}
fn target() -> String {
    format!("{}/{LAUNCHD_LABEL}", domain())
}
fn launchctl(args: &[&str]) -> bool {
    succeeds("launchctl", args)
}

pub fn install(exe: &str) -> Result<(), Failure> {
    // Without a login session of the GUI domain (an SSH-only account) there is nowhere to load an agent.
    if !launchctl(&["print", &domain()]) {
        return Err(Failure::Unsupported);
    }
    let path = path().ok_or(Failure::Refused("No home directory"))?;
    let placed = place(&path, &render::launchd_plist(exe))?;
    launchctl(&["bootout", &target()]);
    if launchctl(&["bootstrap", &domain(), &path.to_string_lossy()]) {
        return Ok(());
    }
    undo(placed);
    Err(Failure::Refused("launchctl refused the agent"))
}

pub fn remove() -> Result<(), Failure> {
    let Some(path) = path() else {
        return Ok(());
    };
    if ours(&path)?.is_some() {
        launchctl(&["bootout", &target()]);
        remove_ours(&path)?;
    }
    Ok(())
}

pub fn state(exe: &str) -> State {
    let Some(path) = path() else {
        return State::Absent;
    };
    match ours(&path) {
        Ok(None) => State::Absent,
        Ok(Some(text))
            if text == render::launchd_plist(exe) && launchctl(&["print", &target()]) =>
        {
            State::Installed
        }
        _ => State::Drift,
    }
}
