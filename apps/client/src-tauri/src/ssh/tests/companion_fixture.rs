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
    format!("SetEnv PATH={}:/usr/bin:/bin HOME={} XDG_DATA_HOME={} LAZYSH_STATE_DIR={} ZDOTDIR={} BASH_ENV=/dev/null ENV=/dev/null\n",bin.display(),directory.display(),directory.join("data").display(),directory.join("state").display(),directory.display())
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
    for agent in ["claude", "codex", "opencode"] {
        let profile = directory.join(format!("owned {agent} profile's $ path"));
        fs::create_dir(&profile).unwrap();
        let json_name = match agent {
            "claude" => Some("settings.json"),
            "codex" => Some("hooks.json"),
            _ => None,
        };
        let foreign = "{\"foreign\": { \"keep\" : true }}";
        if let Some(name) = json_name {
            fs::write(profile.join(name), foreign).unwrap();
        }
        let invoke = |action: &str, plan: Option<&str>| {
            let request = serde_json::from_value(serde_json::json!({"agent":agent,"action":action,"profileRoot":profile,"expectedPlan":plan})).unwrap();
            crate::companion::hooks::execute(session, request, lease)
        };
        let before = invoke("status", None).await.unwrap();
        let configured = invoke("install", before["installPlan"].as_str())
            .await
            .unwrap();
        assert_eq!(configured["outcome"]["status"], "configured");
        let current = invoke("status", None).await.unwrap();
        assert_eq!(current["state"], "configured");
        assert_eq!(current["reporting"], "notChecked");
        let removed = invoke("remove", current["removePlan"].as_str())
            .await
            .unwrap();
        assert_eq!(removed["outcome"]["status"], "removed");
        if let Some(name) = json_name {
            assert!(fs::read_to_string(profile.join(name))
                .unwrap()
                .contains("{ \"keep\" : true }"));
        } else {
            assert!(!profile.join("plugins/lazysh.js").exists());
        }
    }
}
