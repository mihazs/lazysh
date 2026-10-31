//! Auth-free OpenSSH cancellation: the owned credential helper never returns a token.
use super::*;
use std::path::Path;
use tauri::Manager;
pub(super) fn environment(directory: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    let binary = PathBuf::from(
        std::env::var_os("LAZYSH_TEST_AGENT_BIN")
            .expect("An owned current-source companion binary is required"),
    );
    assert!(binary.is_absolute() && binary.is_file());
    let bin = directory.join("bin");
    fs::create_dir(&bin).unwrap();
    std::os::unix::fs::symlink(binary, bin.join("lazysh-agent")).unwrap();
    for (tool, source) in [
        ("sh", "/bin/sh"),
        ("env", "/usr/bin/env"),
        ("uname", "/usr/bin/uname"),
        ("id", "/usr/bin/id"),
        ("stat", "/usr/bin/stat"),
    ] {
        std::os::unix::fs::symlink(source, bin.join(tool)).unwrap();
    }
    let helper = bin.join("gh");
    fs::write(&helper,"#!/bin/sh\n/bin/sleep 120 &\nprintf '%s %s %s %s' \"$(/bin/ps -o ppid= -p \"$PPID\")\" \"$PPID\" \"$$\" \"$!\" > \"$OWNED_USAGE_PIDS\"\nwait\n").unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.join("usage-config/lazysh");
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join("account-usage.toml"),"[anthropic]\nenabled=false\n[openai]\nenabled=false\n[zai]\nenabled=false\n[openrouter]\nenabled=false\n[copilot]\nenabled=true\n").unwrap();
    fs::write(directory.join(".zshrc"), b"").unwrap();
    format!("PermitUserRC no\nSetEnv PATH={} HOME={} ZDOTDIR={} XDG_CONFIG_HOME={} XDG_CACHE_HOME={} XDG_DATA_HOME={} GH_CONFIG_DIR={} GITHUB_COPILOT_TOKEN= GH_TOKEN= GITHUB_TOKEN= OWNED_USAGE_PIDS={} BASH_ENV=/dev/null ENV=/dev/null\n",bin.display(),directory.display(),directory.display(),directory.join("usage-config").display(),directory.join("usage-cache").display(),directory.join("usage-data").display(),directory.join("gh-config").display(),directory.join("usage-pids").display())
}
struct Group(i32);
impl Drop for Group {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}
async fn pids(path: &Path) -> Vec<i32> {
    timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(text) = fs::read_to_string(path) {
                let ids = text
                    .split_whitespace()
                    .filter_map(|s| s.parse::<i32>().ok())
                    .collect::<Vec<_>>();
                if ids.len() == 4 {
                    return ids;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned quota helper did not start while channel stdin remained open")
}
async fn query(
    app: &tauri::App<tauri::test::MockRuntime>,
    id: &str,
) -> lazysh_account_usage::Response {
    let access = crate::ssh::test_support::unlocked_access();
    crate::account_usage::account_usage(
        crate::ssh::test_support::ready_lease(&access),
        app.state(),
        app.state(),
        app.state(),
        id.into(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap()
}
async fn verify_managed_quota(app: &tauri::App<tauri::test::MockRuntime>, id: &str, config: &Path) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut bytes = [0; 8192];
        let count = stream.read(&mut bytes).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes[..count])
            .to_ascii_lowercase()
            .contains("authorization: bearer owned-quota-secret"));
        let body = r#"{"used":42,"limit":100,"private":"not-for-the-ui"}"#;
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    fs::write(config,format!("[anthropic]\nenabled=false\n[openai]\nenabled=false\n[zai]\nenabled=false\n[openrouter]\nenabled=false\n[[custom]]\nid=\"owned-native\"\nname=\"Owned quota\"\nshort_name=\"own\"\nenabled=true\nurl=\"http://{address}/quota\"\nallow_http=true\napi_key=\"owned-quota-secret\"\n[[custom.metrics]]\nlabel=\"Requests\"\nused=\"/used\"\nlimit=\"/limit\"\n")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(config, fs::Permissions::from_mode(0o600)).unwrap();
    let response = query(app, id).await;
    if response.state != "ready" {
        server.abort();
    }
    assert_eq!(
        response.state, "ready",
        "managed companion must work without a PATH installation: source={:?}",
        response.source
    );
    assert_eq!(response.source.as_deref(), Some("builtin"));
    let serialized = serde_json::to_value(&response).unwrap();
    assert_eq!(
        serialized["report"]["entries"][0]["rows"][0]["percent"],
        42.0
    );
    assert!(!serialized.to_string().contains("owned-quota-secret"));
    assert!(!serialized.to_string().contains("not-for-the-ui"));
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
pub(super) async fn verify(app: &tauri::App<tauri::test::MockRuntime>, id: &str, directory: &Path) {
    let session = app.state::<AppState>().session(id).await.unwrap();
    app.manage(crate::local::LocalState::default());
    app.manage(crate::account_usage::UsageState::default());
    let executable = directory.join("bin/lazysh-agent");
    let held = directory.join("bin/held-companion");
    fs::rename(&executable, &held).unwrap();
    assert_eq!(
        query(app, id).await.state,
        "companion_required",
        "missing companion must offer installation"
    );
    fs::write(&executable, "#!/bin/sh\nexit 2\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        query(app, id).await.state,
        "companion_required",
        "older companion must offer update"
    );
    fs::remove_file(&executable).unwrap();
    let managed = directory.join("usage-data/lazysh/companion/lazysh-agent");
    fs::create_dir_all(managed.parent().unwrap()).unwrap();
    fs::copy(&held, &managed).unwrap();
    fs::set_permissions(&managed, fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.join("usage-config/lazysh/account-usage.toml");
    let previous = fs::read(&config).unwrap();
    verify_managed_quota(app, id, &config).await;
    fs::write(config, previous).unwrap();
    fs::remove_file(managed).unwrap();
    fs::rename(&held, &executable).unwrap();
    let file = directory.join("usage-pids");
    for event in ["close", "eof", "TERM", "HUP", "INT", "lease"] {
        let _ = fs::remove_file(&file);
        let access = crate::ssh::test_support::unlocked_access();
        let lease = crate::ssh::test_support::ready_lease(&access);
        let command = crate::companion::account_usage_command(&session, &lease)
            .await
            .unwrap();
        let mut channel = None;
        let mut request = None;
        if event == "lease" {
            let session = session.clone();
            let lease = lease.clone();
            request = Some(tokio::spawn(async move {
                exec_bounded(
                    &session,
                    command,
                    &lease,
                    Duration::from_secs(25),
                    1024 * 1024,
                    None,
                )
                .await
            }));
        } else {
            let owned = open_owned_channel(
                &session.handle,
                &lease,
                tokio::time::Instant::now() + Duration::from_secs(3),
            )
            .await
            .unwrap();
            owned.exec(true, command.as_str()).await.unwrap();
            channel = Some(owned);
        }
        let owned = pids(&file).await;
        let _cleanup = Group(owned[1]);
        assert_eq!(unsafe { libc::getpgid(owned[1]) }, owned[1]);
        match event {
            "close" => channel.as_ref().unwrap().close().await.unwrap(),
            "eof" => channel.as_ref().unwrap().eof().await.unwrap(),
            "lease" => {
                access.lock().unwrap();
                assert_eq!(
                    request.take().unwrap().await.unwrap().unwrap_err().kind(),
                    "app_locked"
                );
            }
            signal => channel
                .as_ref()
                .unwrap()
                .signal(match signal {
                    "TERM" => russh::Sig::TERM,
                    "HUP" => russh::Sig::HUP,
                    _ => russh::Sig::INT,
                })
                .await
                .unwrap(),
        }
        timeout(Duration::from_secs(3), async {
            loop {
                if owned.iter().all(|pid| unsafe { libc::kill(*pid, 0) } == -1) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{event} left an owned worker/helper/descendant alive"));
        drop(channel);
    }
}
