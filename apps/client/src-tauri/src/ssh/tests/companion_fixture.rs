//! Owned local SSH acceptance; publisher fixture is cfg(test), never a production URL.
use super::*;
use std::path::Path;
use tauri::Manager;
pub(super) fn environment(directory: &Path) -> String {
    let bin = directory.join("bin");
    fs::create_dir(&bin).unwrap();
    fs::write(
        bin.join("lazysh-agent"),
        b"#!/bin/sh\nprintf 'owned-legacy-unchanged\\n'\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(bin.join("lazysh-agent"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(directory.join(".zshrc"), b"").unwrap();
    assert!(!directory.to_str().unwrap().chars().any(char::is_whitespace));
    format!("SetEnv PATH={}:/usr/bin:/bin HOME={} CODEX_HOME={} XDG_CONFIG_HOME={} XDG_DATA_HOME={} LAZYSH_STATE_DIR={} ZDOTDIR={} BASH_ENV=/dev/null ENV=/dev/null\n",bin.display(),directory.display(),directory.join(".codex").display(),directory.join(".config").display(),directory.join("data").display(),directory.join("state").display(),directory.display())
}
pub(super) async fn verify(app: &tauri::App<tauri::test::MockRuntime>, id: &str, directory: &Path) {
    let binary = PathBuf::from(
        std::env::var_os("LAZYSH_TEST_AGENT_BIN")
            .expect("An explicitly owned current-source release companion binary is required"),
    );
    assert!(binary.is_absolute() && binary.is_file());
    assert!(fs::metadata(&binary).unwrap().len() <= 64 * 1024 * 1024);
    let session = app.state::<AppState>().session(id).await.unwrap();
    let lease = access_lease();
    assert_eq!(
        crate::companion::exec(&session, "lazysh-agent --version".into(), &lease)
            .await
            .unwrap()
            .trim(),
        "owned-legacy-unchanged"
    );
    let legacy = fs::read(directory.join("bin/lazysh-agent")).unwrap();
    let state = directory.join("state");
    fs::create_dir(&state).unwrap();
    for name in ["events.sqlite3", "settings.json"] {
        fs::write(state.join(name), format!("untouched {name}")).unwrap();
    }
    let busy = session
        .companion_install
        .clone()
        .try_acquire_owned()
        .unwrap();
    assert_eq!(
        crate::companion::owned_install(session.clone(), &lease, &binary)
            .await
            .unwrap_err()
            .kind(),
        "companion_install_busy"
    );
    drop(busy);
    let first = serde_json::to_value(
        crate::companion::owned_install(session.clone(), &lease, &binary)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["status"], "installed");
    assert_eq!(first["cleanup"], "complete");
    let destination = PathBuf::from(first["path"].as_str().unwrap());
    assert!(destination.starts_with(directory.canonicalize().unwrap()));
    assert_eq!(fs::read(&destination).unwrap(), fs::read(&binary).unwrap());
    let version = crate::companion::exec(&session, "lazysh-agent --version".into(), &lease)
        .await
        .unwrap();
    assert_eq!(
        version.trim(),
        format!("lazysh-agent {}", env!("CARGO_PKG_VERSION"))
    );
    let second = serde_json::to_value(
        crate::companion::owned_install(session.clone(), &lease, &binary)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(second["status"], "reused");
    assert_eq!(second["cleanup"], "complete");
    #[cfg(target_os = "linux")]
    hooks_roundtrip(&session, &lease, directory).await;
    let saved = destination.with_extension("owned-backup");
    fs::rename(&destination, &saved).unwrap();
    std::os::unix::fs::symlink(&binary, &destination).unwrap();
    assert!(
        crate::companion::exec(&session, "lazysh-agent --version".into(), &lease)
            .await
            .is_err(),
        "present invalid managed path must not fall back"
    );
    fs::remove_file(&destination).unwrap();
    fs::rename(&saved, &destination).unwrap();
    fs::write(
        &destination,
        b"#!/bin/sh\nprintf 'lazysh-agent 999.0.0\\n'\n",
    )
    .unwrap();
    assert_eq!(
        crate::companion::owned_install(session.clone(), &lease, &binary)
            .await
            .unwrap_err()
            .kind(),
        "companion_newer_installed"
    );
    assert!(String::from_utf8(fs::read(&destination).unwrap())
        .unwrap()
        .contains("999.0.0"));
    for name in ["events.sqlite3", "settings.json"] {
        assert_eq!(
            fs::read(state.join(name)).unwrap(),
            format!("untouched {name}").as_bytes()
        );
    }
    assert_eq!(
        fs::read(directory.join("bin/lazysh-agent")).unwrap(),
        legacy
    );
    assert!(
        fs::read_dir(directory).unwrap().all(|v| !v
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".lazysh-install-")),
        "verified staging is cleaned without deleting managed state"
    );
}

#[cfg(target_os = "linux")]
async fn hooks_roundtrip(session: &Session, lease: &AccessLease, directory: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let executable = directory.join("bin/codex");
    let marker = directory.join("agent-was-executed");
    fs::write(
        &executable,
        format!(
            "#!/bin/sh\ntouch {}\n",
            crate::ssh::quote(marker.to_str().unwrap())
        ),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    fs::copy(&executable, directory.join("bin/copilot")).unwrap();
    fs::copy(&executable, directory.join("bin/amp")).unwrap();
    let copilot_profile = directory.join(".copilot");
    fs::create_dir(&copilot_profile).unwrap();
    let amp_profile = directory.join(".config/amp");
    fs::create_dir_all(&amp_profile).unwrap();
    let detected_profile = directory.join(".codex");
    fs::create_dir(&detected_profile).unwrap();
    let discovery = crate::companion::hooks::discover(session, lease)
        .await
        .unwrap();
    let detected = discovery["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["agent"] == "codex")
        .expect("Owned installed Codex must be discovered over SSH");
    assert_eq!(detected["executable"]["path"], executable.to_str().unwrap());
    assert_eq!(
        detected["profiles"][0]["path"],
        detected_profile.to_str().unwrap()
    );
    assert_eq!(detected["profiles"][0]["state"], "directory");
    assert!(
        !marker.exists() && !detected_profile.join("hooks.json").exists(),
        "Discovery must not execute the agent or install hooks"
    );
    let legacy_copilot = discovery["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["agent"] == "copilot")
        .unwrap();
    assert_eq!(legacy_copilot["setup"], "manual");
    assert_eq!(legacy_copilot["profiles"], serde_json::json!([]));
    let v2 = crate::companion::hooks::discover_version(session, lease, 2)
        .await
        .unwrap();
    assert_eq!(v2["schemaVersion"], 2);
    let managed = v2["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["agent"] == "copilot")
        .unwrap();
    assert_eq!(managed["setup"], "managed");
    assert_eq!(
        managed["profiles"][0]["path"],
        copilot_profile.to_str().unwrap()
    );
    assert!(!marker.exists());
    let newest = crate::companion::hooks::discover_version(session, lease, 3)
        .await
        .unwrap();
    let amp = newest["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["agent"] == "amp")
        .unwrap();
    assert_eq!(amp["setup"], "managed");
    assert_eq!(amp["profiles"][0]["path"], amp_profile.to_str().unwrap());
    for old in [&discovery, &v2] {
        let row = old["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["agent"] == "amp")
            .unwrap();
        assert_eq!(row["setup"], "manual");
        assert_eq!(row["profiles"], serde_json::json!([]));
    }
    assert!(!marker.exists());
    for agent in [
        "claude", "codex", "droid", "gemini", "cursor", "opencode", "cline", "copilot", "amp",
    ] {
        let profile = directory.join(format!("owned {agent} profile's $ path"));
        fs::create_dir(&profile).unwrap();
        let json_name = match agent {
            "claude" | "gemini" => Some("settings.json"),
            "codex" | "droid" | "cursor" => Some("hooks.json"),
            _ => None,
        };
        let foreign = if agent == "droid" {
            "{\"ForeignEvent\":[{ \"keep\" : true }]}"
        } else {
            "{\"foreign\": { \"keep\" : true }}"
        };
        if let Some(name) = json_name {
            fs::write(profile.join(name), foreign).unwrap();
        }
        let invoke = |action: &str, plan: Option<&str>| {
            let request = serde_json::from_value(serde_json::json!({"agent":agent,"action":action,"profileRoot":profile,"expectedPlan":plan})).unwrap();
            crate::companion::hooks::execute(session, request, lease)
        };
        let opaque = profile.join("config.json");
        if agent == "copilot" {
            fs::write(&opaque, "// preserve opaque Copilot config\n{}").unwrap();
        }
        let before = invoke("status", None).await.unwrap();
        let configured = invoke("install", before["installPlan"].as_str())
            .await
            .unwrap();
        assert_eq!(configured["outcome"]["status"], "configured");
        let mut current = invoke("status", None).await.unwrap();
        assert_eq!(current["state"], "configured");
        assert_eq!(current["reporting"], "notChecked");
        if agent == "cursor" {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(
                    &fs::read(profile.join("hooks.json")).unwrap()
                )
                .unwrap()["version"],
                1
            );
        }
        if agent == "copilot" {
            let config: serde_json::Value =
                serde_json::from_slice(&fs::read(profile.join("hooks/lazysh.json")).unwrap())
                    .unwrap();
            assert_eq!(
                config["hooks"]["Stop"][0]["exec"],
                current["binary"]["path"]
            );
            assert_eq!(
                config["hooks"]["Stop"][0]["args"],
                serde_json::json!(["ingest", "--agent", "copilot"])
            );
            assert_eq!(config["hooks"]["Stop"][0]["timeoutSec"], 5);
        }
        if agent == "amp" {
            let text = fs::read_to_string(profile.join("plugins/lazysh.js")).unwrap();
            let binding = serde_json::to_string(&current["binary"]["path"]).unwrap();
            assert!(text.contains(&format!("childProcess.spawn({binding},")));
            fs::write(profile.join("plugins/lazysh.ts"), "foreign Amp plugin").unwrap();
            current = invoke("status", None).await.unwrap();
            assert_eq!(current["state"], "configured");
            assert_eq!(current["reason"], "HooksAmpShadow");
            assert!(current["installPlan"].is_null());
        }
        let removed = invoke("remove", current["removePlan"].as_str())
            .await
            .unwrap();
        assert_eq!(removed["outcome"]["status"], "removed");
        if let Some(name) = json_name {
            assert!(fs::read_to_string(profile.join(name))
                .unwrap()
                .contains("{ \"keep\" : true }"));
        } else if agent == "copilot" {
            assert!(!profile.join("hooks/lazysh.json").exists());
            assert_eq!(
                fs::read_to_string(&opaque).unwrap(),
                "// preserve opaque Copilot config\n{}"
            );
        } else {
            assert!(!profile.join("plugins/lazysh.js").exists());
            if agent == "amp" {
                assert_eq!(
                    fs::read_to_string(profile.join("plugins/lazysh.ts")).unwrap(),
                    "foreign Amp plugin"
                );
            }
        }
    }
}
