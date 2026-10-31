//! A real desktop executable must handle its fixed worker mode before GTK/Tauri startup.
use std::{fs, process::Command};
#[test]
fn exact_account_worker_mode_returns_private_report_without_a_display_server() {
    let owned = tempfile::tempdir().unwrap();
    let configuration = owned.path().join("config/lazysh");
    fs::create_dir_all(&configuration).unwrap();
    fs::write(configuration.join("account-usage.toml"),"[anthropic]\nenabled=false\n[openai]\nenabled=false\n[zai]\nenabled=false\n[openrouter]\nenabled=false\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh"))
        .arg("--account-usage-worker")
        .env_clear()
        .env("HOME", owned.path())
        .env("USERPROFILE", owned.path())
        .env("XDG_CONFIG_HOME", owned.path().join("config"))
        .env("XDG_CACHE_HOME", owned.path().join("cache"))
        .env("PATH", owned.path().join("no-tools"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "worker initialized the UI or failed"
    );
    assert!(output.stderr.is_empty());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["schemaVersion"], 1);
    assert_eq!(response["source"], "builtin");
    assert_eq!(fs::read_dir(&configuration).unwrap().count(), 1);
}
