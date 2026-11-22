//! Linux: a `systemd --user` service and timer in the user's configuration directory.
use super::{
    ours, place, remove_ours, render, render::NAME, replaced, succeeds, tool, undo, Failure, State,
};
use std::path::PathBuf;

fn files() -> Option<(PathBuf, PathBuf)> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))?;
    let directory = base.join("systemd/user");
    Some((
        directory.join(format!("{NAME}.service")),
        directory.join(format!("{NAME}.timer")),
    ))
}
fn timer_unit() -> String {
    format!("{NAME}.timer")
}
fn systemctl(args: &[&str]) -> bool {
    let arguments: Vec<&str> = ["--user"].into_iter().chain(args.iter().copied()).collect();
    succeeds("systemctl", &arguments)
}
fn reachable() -> bool {
    systemctl(&["show-environment"])
}

pub fn install(
    exe: &str,
    before_write: &mut dyn FnMut() -> Result<(), Failure>,
) -> Result<(), Failure> {
    if !reachable() {
        return Err(Failure::Unsupported);
    }
    before_write()?;
    if !render::systemd_path_ok(exe) {
        return Err(Failure::Refused(
            "The executable path cannot be written to a systemd unit",
        ));
    }
    let (service, timer) = files().ok_or(Failure::Refused("No user configuration directory"))?;
    let service = place(&service, &render::systemd_service(exe))?;
    let timer = match place(&timer, &render::systemd_timer()) {
        Ok(timer) => timer,
        Err(failure) => {
            undo(service);
            return Err(failure);
        }
    };
    if systemctl(&["daemon-reload"]) && systemctl(&["enable", "--now", &timer_unit()]) {
        return Ok(());
    }
    // An earlier install is put back and started again; only a first install is taken out of the manager.
    let earlier = replaced(&service) && replaced(&timer);
    undo(timer);
    undo(service);
    if earlier {
        systemctl(&["daemon-reload"]);
        systemctl(&["enable", "--now", &timer_unit()]);
    } else {
        systemctl(&["disable", &timer_unit()]);
        systemctl(&["daemon-reload"]);
    }
    Err(Failure::Refused("systemctl refused the timer"))
}

pub fn remove() -> Result<(), Failure> {
    let Some((service, timer)) = files() else {
        return Ok(());
    };
    let present = ours(&service)?.is_some() | ours(&timer)?.is_some();
    if !present {
        return Ok(());
    }
    let reachable = reachable();
    if reachable {
        systemctl(&["disable", "--now", &timer_unit()]);
    }
    remove_ours(&service)?;
    remove_ours(&timer)?;
    if reachable {
        systemctl(&["daemon-reload"]);
    }
    Ok(())
}

pub fn state(exe: &str) -> State {
    if !reachable() {
        return State::Unsupported;
    }
    let Some((service, timer)) = files() else {
        return State::Absent;
    };
    match (ours(&service), ours(&timer)) {
        (Ok(None), Ok(None)) => State::Absent,
        (Ok(Some(service)), Ok(Some(timer)))
            if service == render::systemd_service(exe)
                && timer == render::systemd_timer()
                && systemctl(&["is-enabled", &timer_unit()]) =>
        {
            State::Installed
        }
        _ => State::Drift,
    }
}

/// Whether the account's user manager keeps running with no session. Without it the timer only fires
/// while somebody is logged in, which `enable` never changes (that needs the owner to run
/// `loginctl enable-linger`). `None` when it cannot be read.
pub fn linger() -> Option<bool> {
    let uid = super::uid().to_string();
    let output = tool(
        "loginctl",
        &["show-user", &uid, "--property=Linger", "--value"],
    )?;
    match String::from_utf8_lossy(&output.stdout).trim() {
        "yes" if output.status.success() => Some(true),
        "no" if output.status.success() => Some(false),
        _ => None,
    }
}
