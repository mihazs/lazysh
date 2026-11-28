//! A `herdr` stand-in on PATH that lists one running session bound to an owned socket.
#![allow(dead_code)] // each test binary uses one of the two helpers
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::Path,
    process::{Command, Stdio},
};
#[path = "executable_retry.rs"]
mod executable_retry;

/// Returns once the kernel will run `script`. A child another test thread forked while the file was open for writing
/// keeps it "text file busy" until that child execs, and the actor, which runs `herdr`, then ends before it is ready.
/// The script's own exit status does not matter, only that it started.
pub fn wait_runnable(script: &Path) {
    let probe = || {
        Command::new(script)
            .args(["session", "list", "--json"])
            .env_clear()
            .env("HOME", "/nonexistent")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };
    executable_retry::with_executable_retry(probe).unwrap();
}

/// Writes `directory/herdr`, which answers only `session list --json`.
pub fn install(directory: &Path, name: &str, socket: &Path) {
    let sessions =
        json!({"sessions":[{"name":name,"running":true,"socket_path":socket}]}).to_string();
    let herdr = directory.join("herdr");
    fs::write(
        &herdr,
        format!(
            "#!/bin/sh\n[ \"$*\" = 'session list --json' ] || exit 91\nprintf '%s' '{sessions}'\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&herdr, fs::Permissions::from_mode(0o700)).unwrap();
    wait_runnable(&herdr);
}

/// The one request line a client sent on `stream`.
pub fn request(stream: &UnixStream) -> Value {
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

/// An owned directory and the socket path inside it, with a `herdr` that lists it as session `name`.
pub fn owned(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join(format!("{name}.sock"));
    install(directory.path(), name, &socket);
    (directory, socket)
}
