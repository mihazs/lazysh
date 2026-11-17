//! Real-binary helpers for the usage collection policy and a host whose `account-usage` can run offline.
use serde_json::Value;
#[cfg(unix)]
use std::path::PathBuf;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

pub fn run(state: &Path, args: &[&str]) -> Output {
    Command::new(crate::binary::path())
        .args(args)
        .env("LAZYSH_STATE_DIR", state)
        .output()
        .unwrap()
}
pub fn json(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
pub fn set_quota(state: &Path, revision: &str, enabled: &str) -> Output {
    run(
        state,
        &[
            "usage-collection",
            "update",
            "--expected-revision",
            revision,
            "--account-quota-enabled",
            enabled,
        ],
    )
}

/// A private profile that lets the external `ai-usagebar` run, and a fake one that records that it did.
#[cfg(unix)]
pub struct Host {
    _directory: tempfile::TempDir,
    root: PathBuf,
    pub state: PathBuf,
    pub started: PathBuf,
}
#[cfg(unix)]
impl Host {
    /// The real binary with this host's home, profile, stand-in `ai-usagebar` and state directory.
    pub fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(crate::binary::path());
        command
            .args(args)
            .env_clear()
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("XDG_CACHE_HOME", self.root.join("cache"))
            .env("PATH", self.root.join("tools"))
            .env("LAZYSH_STATE_DIR", &self.state)
            .env("OWNED_STARTED", &self.started);
        command
    }
}
#[cfg(unix)]
pub fn host() -> Host {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_owned();
    let config = if cfg!(target_os = "macos") {
        root.join("Library/Application Support/lazysh")
    } else {
        root.join("config/lazysh")
    };
    let tools = root.join("tools");
    fs::create_dir_all(&config).unwrap();
    fs::create_dir(&tools).unwrap();
    let profile = config.join("account-usage.toml");
    fs::write(
        &profile,
        "[context]\nenabled=false\n[notifications]\nenabled=false\n[anthropic]\nenabled=false\n[openai]\nenabled=false\n[openrouter]\nenabled=false\n[zai]\nenabled=false\n",
    )
    .unwrap();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o600)).unwrap();
    let started = root.join("started");
    let report = r#"{"schema_version":1,"entries":[{"id":"owned","name":"Owned","status":"ready","stale":false,"sections":[{"type":"text","label":"Balance","value":"$12.30"}]}]}"#;
    let executable = tools.join("ai-usagebar");
    fs::write(
        &executable,
        format!("#!/bin/sh\necho started > \"$OWNED_STARTED\"\nprintf '%s' '{report}'\n"),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    Host {
        state: root.join("state"),
        _directory: directory,
        root,
        started,
    }
}
