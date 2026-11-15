//! Shared by the host browser tests: the real companion binary, the switch, process checks and a real browser.
use crate::binary;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

pub fn agent(state: &Path) -> Command {
    let mut command = Command::new(binary::path());
    command.env("LAZYSH_STATE_DIR", state);
    command
}

/// Change the host browser switch, as the app does through the settings command.
pub fn switch(state: &Path, revision: &str, enabled: &str) {
    let output = agent(state)
        .args(["settings", "host-browser", "update"])
        .args([
            "--expected-revision",
            revision,
            "--host-browser-enabled",
            enabled,
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

pub fn enable(state: &Path) {
    switch(state, "0", "true");
}

pub fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

pub fn wait_gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(pid), "process {pid} survived the launcher");
}

/// Everything a run left in the state directory, as text, so a leak shows as a missing needle.
pub fn state_text(state: &Path) -> String {
    fn walk(path: &Path, text: &mut String) {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            text.push_str(&entry.file_name().to_string_lossy());
            if entry.path().is_dir() {
                walk(&entry.path(), text);
            } else if let Ok(bytes) = fs::read(entry.path()) {
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
    }
    let mut text = String::new();
    walk(state, &mut text);
    text
}

/// The first supported Chrome-family browser on `PATH`; `None` on a host that has none.
pub fn chrome() -> Option<PathBuf> {
    [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
    ]
    .iter()
    .find_map(|name| {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    })
}

/// A state directory for each way the switch refuses, with the failure it gives: `never_set`, which is left
/// absent, one switched off explicitly, and one with a malformed file (a strict file is refused, not reset).
pub fn refusing_states(root: &Path, never_set: &Path) -> [(PathBuf, &'static str); 3] {
    let explicit = root.join("explicit");
    let malformed = root.join("malformed");
    for state in [&explicit, &malformed] {
        fs::create_dir(state).unwrap();
        fs::set_permissions(state, fs::Permissions::from_mode(0o700)).unwrap();
    }
    switch(&explicit, "0", "false");
    let file = malformed.join("host-browser.json");
    fs::write(&file, r#"{"hostBrowserEnabled":true,"x":1}"#).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    [
        (never_set.to_path_buf(), "HostBrowserDisabled"),
        (explicit, "HostBrowserDisabled"),
        (malformed, "InvalidArgument"),
    ]
}

/// A refusal started nothing: the fake browser in `root` never ran and `state` has no profile directory.
pub fn assert_nothing_started(root: &Path, state: &Path) {
    assert!(!root.join("args").exists(), "a browser was started");
    assert!(!state.join("host-browser").exists(), "a profile was made");
}
