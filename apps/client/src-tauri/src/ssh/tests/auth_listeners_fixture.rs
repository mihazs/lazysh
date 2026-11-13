//! Owned OpenSSH acceptance of the sign-in listener check: the real companion's `listeners` over one
//! real SSH exec channel, then the `ss` fallback for a companion that predates it or is missing. The
//! listeners are real sockets of this process; no identity provider or login command runs.
use super::*;
use crate::auth_listeners::{check_auth_listener, Presence, Verdict};
use std::{net::TcpListener, path::Path};
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;

async fn check(app: &App, id: &str, port: u16, seen: u64) -> Verdict {
    match check_auth_listener(access_lease(), app.state(), id.into(), port, seen).await {
        Ok(verdict) => verdict.into_inner().unwrap(),
        Err(error) => panic!(
            "the listener check failed: {:?}",
            error.into_inner().unwrap()
        ),
    }
}

fn free_port() -> u16 {
    owned_sshd::free_port()
}

pub(super) async fn verify(app: &App, id: &str, directory: &Path) {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    let exe = std::env::current_exe()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();

    // The real companion: owner, name and the age of this process, read on the host.
    let first = check(app, id, port, 0).await;
    let listener = first
        .listener
        .clone()
        .expect("the companion sees our socket");
    assert_eq!(
        (
            listener.source,
            listener.bind,
            listener.owned_by_session_user,
            listener.pid
        ),
        ("companion", "loopback", true, Some(std::process::id()))
    );
    assert!(
        listener
            .comm
            .as_deref()
            .is_some_and(|name| exe.starts_with(name)),
        "{listener:?}"
    );
    let age = listener
        .age_seconds
        .expect("the companion reports the process age");
    // A hint exactly as old as the process was seen as the process started; one seen 10 minutes
    // before the process started belongs to some other sign-in.
    assert_eq!(check(app, id, port, age).await.state, Presence::Confirmed);
    assert_eq!(check(app, id, port, age + 600).await.state, Presence::Stale);
    // A port nothing listens on, and one the app must refuse to ask about.
    assert_eq!(check(app, id, free_port(), 0).await.state, Presence::Absent);
    let refused = check_auth_listener(access_lease(), app.state(), id.into(), 80, 0).await;
    assert_eq!(
        refused.err().unwrap().into_inner().unwrap().kind(),
        "invalid_port"
    );

    // A companion that predates `listeners` answers with a usage error: the check falls back to `ss`,
    // which names our process but cannot say how old it is.
    use std::os::unix::fs::PermissionsExt;
    let executable = directory.join("bin/lazysh-agent");
    let held = directory.join("bin/held-companion");
    fs::rename(&executable, &held).unwrap();
    for script in [
        "#!/bin/sh\nexit 2\n",
        "#!/bin/sh\necho 'not the documented answer'\n",
        "#!/bin/sh\necho x >&2\nexit 1\n",
    ] {
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let verdict = check(app, id, port, 3).await;
        let fallback = verdict.listener.expect("ss shows our socket");
        assert_eq!(verdict.state, Presence::Unproven, "{script}");
        assert_eq!(
            (
                fallback.source,
                fallback.owned_by_session_user,
                fallback.age_seconds,
                fallback.pid
            ),
            ("fallback", true, None, Some(std::process::id()))
        );
        assert_eq!(check(app, id, free_port(), 3).await.state, Presence::Absent);
    }
    // No companion at all.
    fs::remove_file(&executable).unwrap();
    assert_eq!(check(app, id, port, 3).await.state, Presence::Unproven);
    fs::rename(&held, &executable).unwrap();
    assert_eq!(check(app, id, port, age).await.state, Presence::Confirmed);
    drop(socket);
}
