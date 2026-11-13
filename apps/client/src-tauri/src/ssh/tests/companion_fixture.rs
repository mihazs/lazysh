//! Owned local SSH acceptance; publisher fixture is cfg(test), never a production URL.
use super::*;
use std::path::Path;
use tauri::Manager;
/// The owned host answers `curl` from its own `assets` directory instead of the network, so the real
/// bootstrap runs on the host while the test controls what "GitHub" serves through the `mode` file.
const CURL: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$ASSETS/curl.log"
out= url=
while [ "$#" -gt 0 ]; do
  case $1 in -o|--output) out=$2; shift;; https://*) url=$1;; esac
  shift
done
case $(cat "$ASSETS/mode") in
  fail) exit 6;;
  tamper) cp "$ASSETS/${url##*/}" "$out"; printf x >> "$out";;
  flip) cp "$ASSETS/${url##*/}" "$out"; printf '\001' | dd of="$out" bs=1 seek=100 conv=notrunc 2>/dev/null;;
  *) cp "$ASSETS/${url##*/}" "$out";;
esac
"#;
pub(super) fn environment(directory: &Path) -> String {
    let bin = directory.join("bin");
    fs::create_dir(&bin).unwrap();
    let assets = directory.join("assets");
    fs::create_dir(&assets).unwrap();
    fs::write(assets.join("mode"), "ok").unwrap();
    fs::write(
        bin.join("lazysh-agent"),
        b"#!/bin/sh\nprintf 'owned-legacy-unchanged\\n'\n",
    )
    .unwrap();
    fs::write(bin.join("curl"), CURL).unwrap();
    use std::os::unix::fs::PermissionsExt;
    for name in ["lazysh-agent", "curl"] {
        fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(directory.join(".zshrc"), b"").unwrap();
    assert!(!directory.to_str().unwrap().chars().any(char::is_whitespace));
    format!("SetEnv PATH={}:/usr/bin:/bin HOME={} CODEX_HOME={} XDG_CONFIG_HOME={} XDG_DATA_HOME={} LAZYSH_STATE_DIR={} ASSETS={} ZDOTDIR={} BASH_ENV=/dev/null ENV=/dev/null\n",bin.display(),directory.display(),directory.join(".codex").display(),directory.join(".config").display(),directory.join("data").display(),directory.join("state").display(),assets.display(),directory.display())
}
/// The current-source release companion the CI step built for owned SSH cases.
pub(super) fn owned_agent_binary() -> PathBuf {
    let binary = PathBuf::from(
        std::env::var_os("LAZYSH_TEST_AGENT_BIN")
            .expect("An explicitly owned current-source release companion binary is required"),
    );
    assert!(binary.is_absolute() && binary.is_file());
    assert!(fs::metadata(&binary).unwrap().len() <= 64 * 1024 * 1024);
    binary
}
/// Real published companions, fetched by CI against these pins: the hosts users actually have.
const OLD_COMPANIONS: [(&str, &str, u64); 2] = [
    (
        "1.28.0",
        "d8f0bab955d71e3d2f2d9731a2514c88f482b6809fe20593a9906737a977f1d0",
        11_481_648,
    ),
    (
        "1.33.4",
        "b37f2b673732b99fc2e751cf8974393a9329fc979d8e1ef205cf6829cc8b6804",
        11_514_416,
    ),
];
fn target() -> String {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    format!("{os}-agent-{arch}")
}
fn residue(managed: &Path) -> Vec<String> {
    fs::read_dir(managed)
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| {
                    name.starts_with(".update.") || name.starts_with(".lazysh-bootstrap")
                })
                .collect()
        })
        .unwrap_or_default()
}
fn curl_calls(directory: &Path) -> usize {
    fs::read_to_string(directory.join("assets/curl.log"))
        .map(|log| log.lines().count())
        .unwrap_or(0)
}
fn serve(directory: &Path, mode: &str) {
    fs::write(directory.join("assets/mode"), mode).unwrap();
}
/// Seeds the state files a host keeps, which no install may touch, and proves they are untouched.
fn keep_state(state: &Path) {
    fs::create_dir_all(state).unwrap();
    for name in STATE_FILES {
        fs::write(state.join(name), format!("untouched {name}")).unwrap();
    }
}
fn assert_state_kept(state: &Path) {
    for name in STATE_FILES {
        assert_eq!(
            fs::read(state.join(name)).unwrap(),
            format!("untouched {name}").as_bytes()
        );
    }
}
const STATE_FILES: [&str; 2] = ["events.sqlite3", "settings.json"];
/// Both routes must refuse in exactly the same way.
async fn both_routes_refuse(
    owned: &crate::companion::Owned,
    session: &Arc<Session>,
    lease: &AccessLease,
    kind: &str,
) {
    use crate::companion::install::Route;
    for route in [Route::Host, Route::Device] {
        let failure = owned
            .install(session.clone(), lease, route)
            .await
            .unwrap_err();
        assert_eq!(failure.kind(), kind, "{route:?}");
    }
}
pub(super) async fn verify(app: &tauri::App<tauri::test::MockRuntime>, id: &str, directory: &Path) {
    let sessions = app.state::<AppState>();
    let session = sessions.session(id).await.unwrap();
    device_fallback(&session, directory).await;
    host_update(&session, directory).await;
}
/// A finished device-route install releases its SFTP channel in the background; the next install starts after it.
async fn settled(session: &Session) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while session
            .companion_install
            .clone()
            .try_acquire_owned()
            .is_err()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the previous install released its channels");
}
async fn host_update(session: &Arc<Session>, directory: &Path) {
    settled(session).await;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    let candidate = owned_agent_binary();
    let version = env!("CARGO_PKG_VERSION");
    let lease = access_lease();
    let managed = directory.join("data/lazysh/companion");
    let agent = managed.join("lazysh-agent");
    let previous = managed.join("lazysh-agent.previous");
    let asset = |version: &str| directory.join(format!("assets/lazysh-{version}-{}.bin", target()));
    fs::copy(&candidate, asset(version)).unwrap();
    fs::remove_dir_all(directory.join("data")).unwrap();
    let state = directory.join("state");
    let hook = directory.join(".codex/hooks.json");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, "{\"owned\": \"hook configuration\"}").unwrap();
    let report = |installed: &super::super::super::companion::Installed| {
        serde_json::to_value(installed).unwrap()
    };
    let companion_version = || async {
        crate::companion::exec(session, "lazysh-agent --version".into(), &lease)
            .await
            .unwrap()
            .trim()
            .to_owned()
    };

    // A host with nothing installed: the host downloads, the device fetches only metadata.
    let owned = crate::companion::Owned::new(&candidate, version);
    let first = report(
        &owned
            .install(
                session.clone(),
                &lease,
                crate::companion::install::Route::Host,
            )
            .await
            .unwrap(),
    );
    assert_eq!(
        (first["status"].as_str(), first["cleanup"].as_str()),
        (Some("installed"), Some("complete"))
    );
    assert_eq!(first["path"], agent.to_str().unwrap());
    assert_eq!(fs::read(&agent).unwrap(), fs::read(&candidate).unwrap());
    assert_eq!(
        fs::metadata(&agent).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(companion_version().await, format!("lazysh-agent {version}"));
    assert_eq!(
        (owned.selects(), owned.downloads(), curl_calls(directory)),
        (1, 0, 1),
        "the host fetched the companion once and the device never did"
    );
    assert!(residue(&managed).is_empty() && !previous.exists());
    // The same version again is a no-op that never reaches the network.
    let second = report(
        &owned
            .install(
                session.clone(),
                &lease,
                crate::companion::install::Route::Host,
            )
            .await
            .unwrap(),
    );
    assert_eq!(second["status"], "reused");
    assert_eq!((owned.downloads(), curl_calls(directory)), (0, 1));

    // Hosts that have an older published companion upgrade in place, keeping it as the previous one.
    let old_dir = std::path::PathBuf::from(std::env::var_os("LAZYSH_TEST_OLD_COMPANIONS").expect(
        "A directory holding the pinned published 1.28.0 and 1.33.4 companions is required",
    ));
    for (old_version, digest, bytes) in OLD_COMPANIONS {
        let old =
            fs::read(old_dir.join(format!("lazysh-{old_version}-linux-agent-x64.bin"))).unwrap();
        assert_eq!(
            (
                old.len() as u64,
                format!("{:x}", Sha256::digest(&old)).as_str()
            ),
            (bytes, digest),
            "pinned published companion {old_version}"
        );
        let probe = std::process::Command::new(
            old_dir.join(format!("lazysh-{old_version}-linux-agent-x64.bin")),
        )
        .args(["update", "--status", "--json"])
        .output()
        .unwrap();
        if old_version == "1.28.0" {
            assert_eq!(
                probe.status.code(),
                Some(2),
                "a genuine old companion answers an unknown subcommand with a usage error"
            );
        }
        fs::write(&agent, &old).unwrap();
        fs::set_permissions(&agent, fs::Permissions::from_mode(0o700)).unwrap();
        let _ = fs::remove_file(&previous);
        keep_state(&state);
        assert_eq!(
            companion_version().await,
            format!("lazysh-agent {old_version}")
        );
        let before = curl_calls(directory);
        let updated = report(
            &owned
                .install(
                    session.clone(),
                    &lease,
                    crate::companion::install::Route::Host,
                )
                .await
                .unwrap(),
        );
        assert_eq!(updated["status"], "installed", "{old_version}");
        assert_eq!(fs::read(&agent).unwrap(), fs::read(&candidate).unwrap());
        assert_eq!(
            fs::read(&previous).unwrap(),
            old,
            "the old companion stays as the previous one"
        );
        assert_eq!(companion_version().await, format!("lazysh-agent {version}"));
        assert_eq!((owned.downloads(), curl_calls(directory) - before), (0, 1));
        assert_state_kept(&state);
        assert_eq!(
            fs::read(&hook).unwrap(),
            b"{\"owned\": \"hook configuration\"}"
        );
        assert!(residue(&managed).is_empty());
    }

    // What the host receives is never installed unless it is the pinned file.
    let installed = fs::read(&agent).unwrap();
    fs::write(
        &agent,
        fs::read(old_dir.join("lazysh-1.28.0-linux-agent-x64.bin")).unwrap(),
    )
    .unwrap();
    let kept = fs::read(&agent).unwrap();
    for (mode, kind, detail) in [
        (
            "tamper",
            "companion_verification_failed",
            Some("sizeMismatch"),
        ),
        (
            "flip",
            "companion_verification_failed",
            Some("digestMismatch"),
        ),
        ("fail", "companion_host_network", Some("dns")),
    ] {
        serve(directory, mode);
        let failure = owned
            .install(
                session.clone(),
                &lease,
                crate::companion::install::Route::Host,
            )
            .await
            .unwrap_err();
        assert_eq!((failure.kind(), failure.detail()), (kind, detail), "{mode}");
        assert_eq!(
            fs::read(&agent).unwrap(),
            kept,
            "{mode}: the installed companion is untouched"
        );
        assert!(residue(&managed).is_empty(), "{mode}");
    }
    // A host that cannot reach GitHub still has the labelled fallback, which uses this device.
    assert_eq!(owned.downloads(), 0);
    settled(session).await;
    let fallback = report(
        &owned
            .install(
                session.clone(),
                &lease,
                crate::companion::install::Route::Device,
            )
            .await
            .unwrap(),
    );
    assert_eq!(fallback["status"], "installed");
    assert_eq!(
        owned.downloads(),
        1,
        "only the offline fallback downloads on the device"
    );
    assert_eq!(fs::read(&agent).unwrap(), installed);
    serve(directory, "ok");
}
/// The explicit offline fallback (this device downloads and uploads over SFTP) and the guards both routes share.
async fn device_fallback(session: &Arc<Session>, directory: &Path) {
    let binary = owned_agent_binary();
    let lease = access_lease();
    let execs = || {
        session
            .handle
            .execs
            .load(std::sync::atomic::Ordering::Relaxed)
    };
    let started = execs();
    let device = crate::companion::install::Route::Device;
    let owned = || crate::companion::Owned::new(&binary, env!("CARGO_PKG_VERSION"));
    assert_eq!(
        crate::companion::exec(session, "lazysh-agent --version".into(), &lease)
            .await
            .unwrap()
            .trim(),
        "owned-legacy-unchanged"
    );
    assert_eq!(
        execs() - started,
        2,
        "the first command probes the host, then runs"
    );
    crate::companion::exec(session, "lazysh-agent --version".into(), &lease)
        .await
        .unwrap();
    assert_eq!(
        execs() - started,
        3,
        "a later command reuses the probe: one exec"
    );
    let legacy = fs::read(directory.join("bin/lazysh-agent")).unwrap();
    let state = directory.join("state");
    keep_state(&state);
    let busy = session
        .companion_install
        .clone()
        .try_acquire_owned()
        .unwrap();
    both_routes_refuse(&owned(), session, &lease, "companion_install_busy").await;
    drop(busy);
    let first = serde_json::to_value(
        owned()
            .install(session.clone(), &lease, device)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["status"], "installed");
    assert_eq!(first["cleanup"], "complete");
    let destination = PathBuf::from(first["path"].as_str().unwrap());
    assert!(destination.starts_with(directory.canonicalize().unwrap()));
    assert_eq!(fs::read(&destination).unwrap(), fs::read(&binary).unwrap());
    let version = crate::companion::exec(session, "lazysh-agent --version".into(), &lease)
        .await
        .unwrap();
    assert_eq!(
        version.trim(),
        format!("lazysh-agent {}", env!("CARGO_PKG_VERSION"))
    );
    let second = serde_json::to_value(
        owned()
            .install(session.clone(), &lease, device)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(second["status"], "reused");
    assert_eq!(second["cleanup"], "complete");
    #[cfg(target_os = "linux")]
    hooks_roundtrip(session, &lease, directory).await;
    let saved = destination.with_extension("owned-backup");
    fs::rename(&destination, &saved).unwrap();
    std::os::unix::fs::symlink(&binary, &destination).unwrap();
    assert!(
        crate::companion::exec(session, "lazysh-agent --version".into(), &lease)
            .await
            .is_err(),
        "present invalid managed path must not fall back"
    );
    // The host route refuses the same unsafe location rather than writing through it.
    let refused = owned()
        .install(
            session.clone(),
            &lease,
            crate::companion::install::Route::Host,
        )
        .await
        .unwrap_err();
    assert_eq!(refused.kind(), "companion_unsafe_location");
    fs::remove_file(&destination).unwrap();
    fs::rename(&saved, &destination).unwrap();
    fs::write(
        &destination,
        b"#!/bin/sh\nprintf 'lazysh-agent 999.0.0\\n'\n",
    )
    .unwrap();
    both_routes_refuse(&owned(), session, &lease, "companion_newer_installed").await;
    assert!(String::from_utf8(fs::read(&destination).unwrap())
        .unwrap()
        .contains("999.0.0"));
    assert_state_kept(&state);
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
