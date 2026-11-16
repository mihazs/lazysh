//! Owned OpenSSH acceptance of the host browser bridge: the real companion's `host-browser serve` over one real
//! SSH exec channel, a real headless Chrome or Chromium, the app's own commands, and a companion that answers as
//! an older one or with the switch off does. The page is a solid color served from loopback; no account is used.
use super::*;
use crate::companion_settings::host_browser_clear_data;
use crate::host_browser::{
    host_browser_ack, host_browser_next, host_browser_pause, host_browser_resume,
    host_browser_start, host_browser_stop,
};
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::Path, process::Command};
use tauri::{
    ipc::{InvokeResponseBody, IpcResponse},
    Manager,
};

type App = tauri::App<tauri::test::MockRuntime>;

fn agent() -> PathBuf {
    PathBuf::from(std::env::var_os("LAZYSH_TEST_AGENT_BIN").expect(
        "Build lazysh-agent from this checkout and provide its private target binary explicitly",
    ))
}

/// The first Chrome-family browser on `PATH`, in the relay's own order of names.
fn browser() -> Option<PathBuf> {
    let found = Command::new("sh")
        .args([
            "-c",
            "for name in google-chrome-stable google-chrome chromium chromium-browser; do command -v $name && break; done",
        ])
        .output()
        .ok()?;
    String::from_utf8(found.stdout)
        .ok()?
        .lines()
        .next()
        .map(PathBuf::from)
}

/// Why this host cannot run the case, if it cannot: no browser, or a companion built before the relay.
pub(super) fn unavailable() -> Option<&'static str> {
    if browser().is_none() {
        return Some("no Chrome or Chromium on PATH");
    }
    let state = tempfile::tempdir().unwrap();
    std::fs::set_permissions(state.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let relay = Command::new(agent())
        .args(["host-browser", "serve"])
        .env("LAZYSH_STATE_DIR", state.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    // A companion without the relay stops at its usage error, exit code 2.
    (relay.status.code() == Some(2)).then_some("the companion has no `host-browser serve`")
}

/// The sshd environment: the companion and a Chromium wrapper (no sandbox: a runner may not allow one) first on
/// `PATH`, and a private companion state directory.
pub(super) fn environment(directory: &Path) -> String {
    let bin = directory.join("bin");
    std::fs::create_dir(&bin).unwrap();
    std::os::unix::fs::symlink(
        std::fs::canonicalize(agent()).unwrap(),
        bin.join("lazysh-agent"),
    )
    .unwrap();
    let wrapper = bin.join("chromium");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec '{}' --no-sandbox \"$@\"\n",
            browser().unwrap().display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(directory.join(".zshrc"), b"").unwrap();
    let state = directory.join("host-browser-state");
    std::fs::create_dir(&state).unwrap();
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
    // One SetEnv line: sshd keeps only the first.
    format!(
        "SetEnv PATH={}:/usr/bin:/bin HOME={} ZDOTDIR={} BASH_ENV=/dev/null ENV=/dev/null LAZYSH_STATE_DIR={}\n",
        bin.display(),
        directory.display(),
        directory.display(),
        state.display()
    )
}

/// Whether any process on this machine has `needle` in its command line.
fn running(needle: &str) -> bool {
    Command::new("pgrep")
        .args(["-f", needle])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn start(app: &App, id: &str, url: &str, keep_profile: bool) -> String {
    host_browser_start(
        access_lease(),
        app.state(),
        app.state(),
        id.into(),
        serde_json::from_value(json!({"width": 412, "height": 915})).unwrap(),
        Some(url.into()),
        Some(keep_profile),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap()
}

/// One pull: `None` for an idle answer, else the relay's tag and its message.
async fn pull(app: &App, id: &str, token: &str) -> Option<(u8, Vec<u8>)> {
    let response = host_browser_next(access_lease(), app.state(), id.into(), token.into())
        .await
        .map_err(|_| "a pull failed")
        .unwrap();
    let InvokeResponseBody::Raw(bytes) = response.body().unwrap() else {
        panic!("a pull must answer with bytes");
    };
    (bytes[0] != 0).then(|| (bytes[0], bytes[1..].to_vec()))
}

/// Pulls JSON messages until `wanted` takes one, within `limit`; `what` says what never came.
async fn until_json<T>(
    app: &App,
    id: &str,
    token: &str,
    (limit, what): (Duration, &str),
    wanted: impl Fn(&Value) -> Option<T>,
) -> T {
    timeout(limit, async {
        loop {
            if let Some((1, body)) = pull(app, id, token).await {
                if let Some(found) = wanted(&serde_json::from_slice(&body).unwrap()) {
                    return found;
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}"))
}

/// Pulls until the browser's closing message and returns its reason.
async fn closing_reason(app: &App, id: &str, token: &str) -> String {
    let wait = (
        Duration::from_secs(60),
        "the browser never said why it ended",
    );
    until_json(app, id, token, wait, |message| {
        (message["type"] == "closed").then(|| message["reason"].as_str().unwrap().to_string())
    })
    .await
}

/// Pauses or resumes the screencast and returns the `state` the relay answers with, which names only `state`.
async fn pause_or_resume(app: &App, id: &str, token: &str, pause: bool) -> String {
    let sent = if pause {
        host_browser_pause(access_lease(), app.state(), id.into(), token.into()).await
    } else {
        host_browser_resume(access_lease(), app.state(), id.into(), token.into()).await
    };
    sent.map_err(|_| "a pause or resume failed").unwrap();
    let wait = (Duration::from_secs(30), "the relay never answered");
    until_json(app, id, token, wait, |message| {
        match message["type"].as_str() {
            Some("state") => Some(message["state"].as_str().unwrap().to_string()),
            Some("closed") => panic!("the relay ended the session: {message}"),
            _ => None,
        }
    })
    .await
}

fn switch(state: &Path, revision: &str, enabled: &str) {
    let output = Command::new(agent())
        .args(["settings", "host-browser", "update"])
        .args(["--expected-revision", revision])
        .args(["--host-browser-enabled", enabled])
        .env("LAZYSH_STATE_DIR", state)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

/// Pulls until the browser reports the fixture page: it is up and has written its profile.
async fn until_page(app: &App, id: &str, token: &str) {
    let wait = (
        Duration::from_secs(90),
        "the fixture page never reached the app",
    );
    until_json(app, id, token, wait, |message| {
        match message["type"].as_str() {
            Some("page") if message["title"] == "Green" => Some(()),
            Some("closed") => panic!("the browser ended: {message}"),
            _ => None,
        }
    })
    .await
}

/// Waits until no browser process of this host's profiles is left: closing the channel must end it.
async fn browser_ended(profiles: &Path) {
    timeout(Duration::from_secs(10), async {
        while running(profiles.to_str().unwrap()) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("closing the channel must end the browser");
}

/// **Clear browser data** through the app's command: whether a kept profile was removed.
async fn clear_data(app: &App, id: &str) -> std::result::Result<bool, SshError> {
    match host_browser_clear_data(app.state(), app.state(), id.into(), access_lease()).await {
        Ok(answer) => {
            Ok(serde_json::to_value(answer.into_inner().unwrap()).unwrap()["cleared"] == true)
        }
        Err(error) => Err(error.into_inner().unwrap()),
    }
}

/// Every path under `directory`, to show that a refused command wrote nothing.
fn listing(directory: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(directory).into_iter().flatten().flatten() {
        found.push(entry.path());
        if entry.path().is_dir() {
            found.extend(listing(&entry.path()));
        }
    }
    found.sort();
    found
}

pub(super) async fn verify(app: &App, id: &str, directory: &Path) {
    let state = directory.join("host-browser-state");
    let (port, _server) =
        lazysh_common::test_support::loopback_page(lazysh_common::test_support::GREEN_PAGE, 120);
    let url = format!("http://127.0.0.1:{port}/");

    // The switch is off on a new host: the relay says so and nothing starts.
    let token = start(app, id, &url, false).await;
    assert_eq!(closing_reason(app, id, &token).await, "HostBrowserDisabled");
    host_browser_stop(app.state(), id.into(), token)
        .await
        .unwrap();
    assert!(!state.join("host-browser").exists(), "a profile was made");

    // The real relay streams a real browser's pixels, and its title and address as text.
    switch(&state, "0", "true");
    let token = start(app, id, &url, false).await;
    let (mut version, mut page_seen, mut green) = (None, false, None);
    timeout(Duration::from_secs(90), async {
        while version.is_none() || !page_seen || green.is_none() {
            match pull(app, id, &token).await {
                Some((1, body)) => {
                    let message: Value = serde_json::from_slice(&body).unwrap();
                    match message["type"].as_str() {
                        Some("state") => version = message["browser"].as_str().map(String::from),
                        Some("page") => {
                            page_seen |=
                                message["title"] == "Green" && message["url"] == url.as_str()
                        }
                        Some("closed") => panic!("the browser ended: {message}"),
                        _ => {}
                    }
                }
                Some((2, frame)) => {
                    let sequence = u32::from_be_bytes(frame[0..4].try_into().unwrap());
                    host_browser_ack(
                        access_lease(),
                        app.state(),
                        id.into(),
                        token.clone(),
                        sequence,
                        Some(1),
                    )
                    .await
                    .map_err(|_| "an ack failed")
                    .unwrap();
                    let image = image::load_from_memory(&frame[20..]).unwrap().to_rgb8();
                    let pixel = image.get_pixel(image.width() / 2, image.height() / 2).0;
                    // Early frames can show the blank page: wait for the fixture's color. A blank canvas never
                    // satisfies this.
                    if pixel[1] > 150 && pixel[0] < 60 && pixel[2] < 60 {
                        green = Some(pixel);
                    }
                }
                _ => {}
            }
        }
    })
    .await
    .expect("the fixture page never reached the app");
    let version = version.unwrap();
    assert!(version.contains("Chrom"));
    eprintln!("real relay over real SSH: {version}, center pixel {green:?}");
    let profiles = state.join("host-browser");
    assert!(
        running(profiles.to_str().unwrap()),
        "the browser is not running"
    );

    // Hiding the view pauses the screencast and showing it resumes it: neither ends the session.
    assert_eq!(pause_or_resume(app, id, &token, true).await, "paused");
    assert_eq!(pause_or_resume(app, id, &token, false).await, "running");

    // Stopping closes the channel: no browser process and no profile directory stay on the host.
    host_browser_stop(app.state(), id.into(), token)
        .await
        .unwrap();
    browser_ended(&profiles).await;
    let left: Vec<_> = std::fs::read_dir(&profiles)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .collect()
        })
        .unwrap_or_default();
    assert!(left.is_empty(), "a profile directory stayed: {left:?}");

    // Keep profile: the one kept profile outlives the session with what the browser wrote, Clear browser data is
    // refused while a browser uses it, removes it afterwards even with the switch off, and then has nothing left.
    let kept = profiles.join("kept");
    let token = start(app, id, &url, true).await;
    until_page(app, id, &token).await;
    let refused = clear_data(app, id).await.unwrap_err();
    assert_eq!(refused.kind(), "remote_command_failed");
    assert!(
        refused.message().contains("BrowserProfileInUse"),
        "{}",
        refused.message()
    );
    host_browser_stop(app.state(), id.into(), token)
        .await
        .unwrap();
    browser_ended(&profiles).await;
    assert!(
        std::fs::read_dir(&kept).unwrap().count() > 0,
        "the kept profile did not survive the session"
    );
    switch(&state, "1", "false");
    assert!(
        clear_data(app, id).await.unwrap(),
        "a kept profile was there"
    );
    assert!(!kept.exists(), "Clear browser data left the profile");
    assert!(
        !clear_data(app, id).await.unwrap(),
        "nothing was left to clear"
    );

    // A companion that predates the relay answers with a usage error: named once, never retried. One that
    // predates Clear browser data answers it the same way, which the app names as an update, writing nothing.
    let executable = directory.join("bin/lazysh-agent");
    let held = directory.join("bin/held-companion");
    std::fs::rename(&executable, &held).unwrap();
    std::fs::write(
        &executable,
        "#!/bin/sh\necho \"error: unrecognized subcommand 'host-browser'\" >&2\nexit 2\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let before = listing(&state);
    assert_eq!(
        clear_data(app, id).await.unwrap_err().kind(),
        "host_browser_companion_required"
    );
    assert_eq!(listing(&state), before, "a refused command wrote");
    let token = start(app, id, &url, false).await;
    assert_eq!(closing_reason(app, id, &token).await, "CompanionRequired");
    host_browser_stop(app.state(), id.into(), token)
        .await
        .unwrap();
    std::fs::remove_file(&executable).unwrap();
    std::fs::rename(&held, &executable).unwrap();
}
