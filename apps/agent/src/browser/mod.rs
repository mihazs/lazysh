//! Host browser-open requests. A launcher shim hands an http(s) URL to the attached device
//! over a per-user Unix socket; with no device attached it delegates to the real opener.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use crate::Error;
use crate::Result;
use clap::{Args, Subcommand};
use serde_json::Value;
use std::{ffi::OsString, path::Path, process::ExitCode};

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod launcher;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod listeners;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod shim;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod socket;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod url;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod watch;

/// Version of the `browser-watch` frames and of the launcher request.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) const PROTOCOL: u8 = 1;

#[derive(Args)]
pub struct ShimArgs {
    #[command(subcommand)]
    pub command: ShimCommand,
    /// Print the machine-readable report the app reads.
    #[arg(long, global = true)]
    pub json: bool,
}
#[derive(Subcommand)]
pub enum ShimCommand {
    /// Create the managed launcher wrappers and one marked block per shell startup file.
    Install,
    /// Report installed wrappers, startup-file blocks and whether a device is attached.
    Status,
    /// Remove exactly what install wrote.
    Uninstall,
}

/// Run as the launcher named `launcher` (a shim name or `browser-open`).
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn open(launcher: &str, args: &[OsString]) -> ExitCode {
    launcher::run(launcher, args)
}
/// When this binary was started through one of the managed wrappers (a symlink named
/// `xdg-open` and so on), behave as that launcher, whatever its arguments.
pub fn invoked_as_launcher() -> Option<ExitCode> {
    let mut args = std::env::args_os();
    let name = Path::new(&args.next()?).file_name()?.to_str()?.to_owned();
    shim_names()
        .contains(&name.as_str())
        .then(|| open(&name, &args.collect::<Vec<_>>()))
}
/// The wrappers `browser-shim install` creates. `open` exists only where it means "open a URL".
pub(crate) fn shim_names() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &[
            "lazysh-open",
            "xdg-open",
            "sensible-browser",
            "x-www-browser",
            "open",
        ]
    } else if cfg!(target_os = "linux") {
        &[
            "lazysh-open",
            "xdg-open",
            "sensible-browser",
            "x-www-browser",
        ]
    } else {
        &[]
    }
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn watch(heartbeat_seconds: u64) -> Result<()> {
    watch::run(std::time::Duration::from_secs(heartbeat_seconds))
}
/// Install, inspect or remove the wrappers; the report carries `complete` (false when part of it failed).
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn shim(command: ShimCommand) -> Result<Value> {
    shim::run(command)
}
/// A short human summary of a `shim` report.
pub fn render(report: &Value) -> String {
    let row = |label: &Value, state: &Value, reason: &Value| {
        let reason = reason.as_str().map(|reason| format!(" ({reason})"));
        format!(
            "  {}: {}{}\n",
            label.as_str().unwrap_or("?"),
            state.as_str().unwrap_or("?"),
            reason.unwrap_or_default()
        )
    };
    let mut text = String::new();
    if let Some(directory) = report["shims"]["directory"].as_str() {
        text += &format!("wrappers in {directory}\n");
    }
    for entry in report["shims"]["entries"].as_array().into_iter().flatten() {
        text += &row(&entry["name"], &entry["state"], &Value::Null);
    }
    text += "startup files\n";
    for entry in report["startup"].as_array().into_iter().flatten() {
        text += &row(&entry["path"], &entry["state"], &entry["reason"]);
    }
    if let Some(attached) = report["watcher"]["attached"].as_bool() {
        text += &format!("device attached: {}\n", if attached { "yes" } else { "no" });
    }
    text
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn open(_: &str, _: &[OsString]) -> ExitCode {
    ExitCode::FAILURE
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn watch(_: u64) -> Result<()> {
    Err(Error::Browser("BrowserUnsupported"))
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn shim(_: ShimCommand) -> Result<Value> {
    Err(Error::Browser("BrowserUnsupported"))
}
