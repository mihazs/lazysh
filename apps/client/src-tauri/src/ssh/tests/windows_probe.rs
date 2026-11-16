//! Throwaway exploration of what the app does against an owned Windows sshd. Prints `PROBE` lines; asserts nothing.
use super::*;
use crate::app_lock::{Guarded, GuardedError};
use futures_util::FutureExt;
use tauri::Manager;

fn flat<T, E: std::fmt::Debug>(
    result: std::result::Result<Guarded<T>, GuardedError<E>>,
) -> std::result::Result<T, String> {
    match result {
        Ok(value) => Ok(value.into_inner().unwrap()),
        Err(error) => Err(format!("{:?}", error.into_inner().map_err(|_| "locked"))),
    }
}
fn say<T: std::fmt::Debug>(tag: &str, label: &str, value: &T) {
    eprintln!("PROBE [{tag}] {label} => {value:?}");
}

async fn explore(shell: Shell, subsystem: &str) {
    let tag = format!("{} | {subsystem}", shell.name());
    let tag = tag.as_str();
    let owned = Owned::start(shell, &format!("{subsystem}\n")).await;
    let (app, id) = owned.app_session().await;
    let dir = owned.directory.path().to_path_buf();
    let home = flat(host_home(access_lease(), app.state(), app.state(), id.clone()).await);
    say(tag, "host_home", &home);
    let list =
        |path: String| list_directory(access_lease(), app.state(), app.state(), id.clone(), path);
    if let Ok(home) = &home {
        let listed = flat(list(home.clone()).await).map(|entries| entries.len());
        say(tag, "list_directory(host_home) entries", &listed);
    }
    let forms = [
        ("slash-drive", format!("/{}", owned_sshd::slashes(&dir))),
        ("forward", owned_sshd::slashes(&dir)),
        ("backslash", dir.display().to_string()),
    ];
    for (label, form) in &forms {
        let file = format!("{form}/{label}.txt");
        let uploaded = flat(
            upload_file(
                access_lease(),
                app.state(),
                id.clone(),
                file.clone(),
                b"hello".to_vec(),
            )
            .await,
        )
        .map(|uploaded| uploaded.path);
        say(tag, &format!("upload {file}"), &uploaded);
        say(
            tag,
            &format!("local file {label}.txt exists"),
            &dir.join(format!("{label}.txt")).exists(),
        );
        let read = flat(
            read_file(
                access_lease(),
                app.state(),
                app.state(),
                id.clone(),
                file.clone(),
            )
            .await,
        );
        say(tag, &format!("read {file}"), &read);
        let listed = flat(list(form.clone()).await)
            .map(|entries| entries.into_iter().map(|e| e.name).collect::<Vec<_>>());
        say(tag, &format!("list {form}"), &listed.map(|n| n.len()));
    }
    let discovered = flat(
        crate::previews::discover_preview_ports(
            access_lease(),
            app.state(),
            id.clone(),
            None,
            Some(false),
        )
        .await,
    )
    .map(|listeners| listeners.len());
    say(tag, "discover_preview_ports", &discovered);

    let session = app.state::<AppState>().session(&id).await.unwrap();
    let lease = access_lease();
    let repo = portable_files::git_repo(&dir, "repo");
    let raw = [
        "git --version".to_string(),
        "GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 git --version".to_string(),
        "if command -v ss >/dev/null 2>&1; then ss -H -ltnp; else lsof -nP -iTCP -sTCP:LISTEN -F pcn; fi"
            .to_string(),
        format!("git --no-pager -C {} diff", quote(&owned_sshd::slashes(&repo))),
        format!("git --no-pager -C {} diff", owned_sshd::slashes(&repo)),
    ];
    for command in raw {
        let seen = observe(&session, &lease, shell, command.clone()).await;
        eprintln!(
            "PROBE [{tag}] exec `{command}` => status {:?} stdout {:?} stderr {:?}",
            seen.status, seen.stdout, seen.stderr
        );
    }
    for (label, form) in [
        ("forward", owned_sshd::slashes(&repo)),
        ("backslash", repo.display().to_string()),
    ] {
        let status = flat(
            crate::repository::repository_status(
                app.state(),
                app.state(),
                id.clone(),
                form.clone(),
                access_lease(),
            )
            .await,
        )
        .map(|status| serde_json::to_string(&status).unwrap());
        say(tag, &format!("repository_status {label}"), &status);
        for staged in [false, true] {
            let diff = flat(
                get_diff(
                    access_lease(),
                    app.state(),
                    app.state(),
                    id.clone(),
                    form.clone(),
                    staged,
                )
                .await,
            );
            say(tag, &format!("get_diff {label} staged={staged}"), &diff);
        }
    }
    let forwarded = std::panic::AssertUnwindSafe(portable_files::preview_forward(&app, &id))
        .catch_unwind()
        .await
        .map_err(|panic| {
            panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|text| text.to_string()))
        });
    say(tag, "preview_forward", &forwarded);
    if let Ok(port) = forwarded {
        let ended = std::panic::AssertUnwindSafe(portable_files::forward_ends_with_session(
            &app,
            id.clone(),
            port,
        ))
        .catch_unwind()
        .await
        .is_ok();
        say(tag, "forward_ends_with_session", &ended);
    }
    eprintln!("PROBE [{tag}] sshd log {}", owned.sshd.log());
    drop(session);
    owned.finish().await;
}

#[tokio::test]
#[ignore = "exploration"]
async fn windows_probe() {
    for shell in [Shell::Cmd, Shell::PowerShell] {
        for subsystem in [
            "Subsystem sftp sftp-server.exe",
            "Subsystem sftp internal-sftp",
        ] {
            std::panic::AssertUnwindSafe(Box::pin(explore(shell, subsystem)))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| eprintln!("PROBE explore panicked for {subsystem}"));
        }
    }
}
