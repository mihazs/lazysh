//! A `herdr` stand-in on PATH that lists one running session bound to an owned socket.
#![allow(dead_code)] // each test binary uses one of the two helpers
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::Path,
};

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
