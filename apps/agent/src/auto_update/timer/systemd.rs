//! Linux: a systemd user timer and service in `~/.config/systemd/user`, run by the user's own manager.
//! It runs while the user's manager does (a login session, or lingering where the user enabled it);
//! a host that nobody logs in to is covered by the companion's own opportunistic check instead.
//! `systemctl` is found on `PATH`, as for any command of the user.
use super::{install_files, ours, remove_ours, render, state_of, tool, State};
use crate::{Error, Result};
use std::path::PathBuf;

pub const KIND: &str = "systemd";

fn systemctl(args: &[&str]) -> bool {
    let mut words = vec!["--user"];
    words.extend(args);
    tool("systemctl", &words).is_some_and(|output| output.success)
}
/// Is there a user manager to talk to (`systemctl --user` fails on a bare SSH login without one).
fn reachable() -> bool {
    systemctl(&["show", "--property=Version"])
}
fn paths() -> Option<[PathBuf; 2]> {
    let directory = dirs::config_dir()
        .filter(|directory| directory.is_absolute())?
        .join("systemd/user");
    Some([
        directory.join(render::SYSTEMD_SERVICE),
        directory.join(render::SYSTEMD_TIMER),
    ])
}
fn expected(exe: &str) -> [String; 2] {
    [render::systemd_service(exe), render::systemd_timer()]
}

pub fn state(exe: Option<&str>) -> State {
    let supported = reachable();
    let found = paths().map_or_else(
        || vec![None, None],
        |paths| paths.iter().map(|path| ours(path).ok().flatten()).collect(),
    );
    let enabled = supported
        && tool(
            "systemctl",
            &["--user", "is-enabled", render::SYSTEMD_TIMER],
        )
        .is_some_and(|output| output.success && output.stdout.trim() == "enabled");
    state_of(
        supported,
        &found,
        exe.map(|exe| expected(exe).to_vec()),
        enabled,
    )
}

pub fn enable(exe: &str) -> Result<()> {
    if !reachable() {
        return Err(Error::AutoUpdate("timerUnsupported"));
    }
    let [service, timer] = paths().ok_or(Error::AutoUpdate("timerUnsupported"))?;
    let [service_text, timer_text] = expected(exe);
    install_files(
        &[(service, service_text), (timer, timer_text)],
        || systemctl(&["daemon-reload"]) && systemctl(&["enable", "--now", render::SYSTEMD_TIMER]),
        || {
            systemctl(&["disable", "--now", render::SYSTEMD_TIMER]);
            systemctl(&["daemon-reload"]);
        },
    )
}

pub fn disable() -> Result<()> {
    let Some(paths) = paths() else {
        return Ok(());
    };
    if paths.iter().any(|path| matches!(ours(path), Ok(Some(_)))) {
        systemctl(&["disable", "--now", render::SYSTEMD_TIMER]);
        remove_ours(&paths);
        systemctl(&["daemon-reload"]);
    }
    Ok(())
}
