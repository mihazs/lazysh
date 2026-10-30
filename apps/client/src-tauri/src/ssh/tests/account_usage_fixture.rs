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
    let helper = bin.join("gh");
    fs::write(&helper,"#!/bin/sh\n/bin/sleep 120 &\nprintf '%s %s %s %s' \"$OWNED_SUPERVISOR_PID\" \"$PPID\" \"$$\" \"$!\" > \"$OWNED_USAGE_PIDS\"\nwait\n").unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.join("usage-config/lazysh");
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join("account-usage.toml"),"[anthropic]\nenabled=false\n[openai]\nenabled=false\n[zai]\nenabled=false\n[openrouter]\nenabled=false\n[copilot]\nenabled=true\n").unwrap();
    fs::write(directory.join(".zshrc"), b"").unwrap();
    format!("PermitUserRC no\nSetEnv PATH={}:/usr/bin:/bin HOME={} ZDOTDIR={} XDG_CONFIG_HOME={} XDG_CACHE_HOME={} GH_CONFIG_DIR={} GITHUB_COPILOT_TOKEN= GH_TOKEN= GITHUB_TOKEN= OWNED_USAGE_PIDS={} BASH_ENV=/dev/null ENV=/dev/null\n",bin.display(),directory.display(),directory.display(),directory.join("usage-config").display(),directory.join("usage-cache").display(),directory.join("gh-config").display(),directory.join("usage-pids").display())
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
pub(super) async fn verify(app: &tauri::App<tauri::test::MockRuntime>, id: &str, directory: &Path) {
    let session = app.state::<AppState>().session(id).await.unwrap();
    let file = directory.join("usage-pids");
    for event in ["close", "eof", "TERM", "HUP", "INT", "lease"] {
        let _ = fs::remove_file(&file);
        let access = crate::ssh::test_support::unlocked_access();
        let lease = crate::ssh::test_support::ready_lease(&access);
        let mut channel = None;
        let mut request = None;
        if event == "lease" {
            let session = session.clone();
            let lease = lease.clone();
            request = Some(tokio::spawn(async move {
                exec_bounded(
                    &session,
                    "exec env OWNED_SUPERVISOR_PID=$$ lazysh-agent account-usage --watch-channel"
                        .into(),
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
            owned
                .exec(
                    true,
                    "exec env OWNED_SUPERVISOR_PID=$$ lazysh-agent account-usage --watch-channel",
                )
                .await
                .unwrap();
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
