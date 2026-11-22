//! Owned OpenSSH acceptance of the Herdr event stream: the real companion's `herdr-events` over one real SSH
//! exec channel, against an owned real Herdr server, through the client's own start and stop commands.
//! The stub agent reports its state with `herdr pane report-agent`; no agent CLI or provider runs, and the
//! server, its socket and the SSH session's HOME all live in the test's private directory.
use super::transcript_watch_fixture::{collector, frame_of, old_companion, until};
use super::*;
use crate::transcript_watch::{agent_watch_start, agent_watch_stop, WatchTarget};
use serde_json::Value;
use std::{path::Path, process::Command, process::Stdio, time::Instant};
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;

/// The companion and the Herdr binary on the SSH session's PATH, in a private HOME.
pub(super) fn environment(directory: &Path) -> String {
    let settings = super::transcript_image_fixture::companion_path(directory);
    let resolved = Command::new("sh")
        .args(["-c", "command -v herdr"])
        .output()
        .unwrap();
    assert!(resolved.status.success(), "the case needs herdr on PATH");
    let herdr = fs::canonicalize(String::from_utf8(resolved.stdout).unwrap().trim()).unwrap();
    std::os::unix::fs::symlink(herdr, directory.join("bin/herdr")).unwrap();
    settings
}

/// `herdr` as the SSH session sees it: nothing inherited but the private HOME.
fn herdr(directory: &Path) -> Command {
    let mut command = Command::new(directory.join("bin/herdr"));
    command
        .env_clear()
        .env("HOME", directory)
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", directory.join("bin").display()),
        )
        .env("SHELL", "/bin/sh")
        .current_dir(directory);
    command
}
fn run(directory: &Path, args: &[&str]) -> Vec<u8> {
    let output = herdr(directory).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "herdr {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
fn report(directory: &Path, pane: &str, state: &str) {
    run(
        directory,
        &[
            "pane",
            "report-agent",
            pane,
            "--source",
            "lazysh-test",
            "--agent",
            "codex",
            "--state",
            state,
        ],
    );
}

/// Boxed from a small frame: a debug test thread's stack cannot hold this check's future beside the other
/// owned-OpenSSH checks' (the whole run overflows it otherwise).
pub(super) fn verify<'a>(
    app: &'a App,
    id: &'a str,
    directory: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>> {
    Box::pin(check(app, id, directory))
}

async fn check(app: &App, id: &str, directory: &Path) {
    // Pin the built-in rules; never fetch a newer catalog.
    fs::create_dir_all(directory.join(".config/herdr")).unwrap();
    fs::write(
        directory.join(".config/herdr/config.toml"),
        "[update]\nversion_check = false\nmanifest_check = false\n",
    )
    .unwrap();
    let mut server = herdr(directory)
        .arg("server")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut ready = false;
    for _ in 0..200 {
        ready = herdr(directory)
            .args(["api", "snapshot"])
            .output()
            .unwrap()
            .status
            .success();
        if ready {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(ready, "the owned Herdr server did not become ready");
    let home = directory.to_str().unwrap();
    for label in ["shown", "background"] {
        run(
            directory,
            &["workspace", "create", "--label", label, "--cwd", home],
        );
    }
    let hidden =
        lazysh_common::test_support::unfocused_herdr_pane(&run(directory, &["api", "snapshot"]));
    let pane = hidden["pane_id"].as_str().unwrap().to_owned();
    report(directory, &pane, "working");

    let target = || WatchTarget::HerdrEvents {
        herdr_session: "default".into(),
    };
    let (events, seen) = collector();
    let token = agent_watch_start(
        access_lease(),
        app.state(),
        app.state(),
        id.into(),
        target(),
        events,
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    until(&seen, frame_of("hello")).await;
    // A blocked agent and a finished one in a hidden workspace reach the client's channel within a bound.
    for (state, expected) in [("blocked", "blocked"), ("idle", "done")] {
        let reported = Instant::now();
        report(directory, &pane, state);
        let (frame, _) = until(&seen, |event| {
            event["type"] == "frame"
                && event["frame"]["type"] == "status"
                && event["frame"]["status"] == expected
        })
        .await;
        eprintln!(
            "herdr report {state} to the status frame in the client over real SSH: {:?}",
            reported.elapsed()
        );
        assert!(reported.elapsed() < Duration::from_secs(5));
        assert_eq!(frame["frame"]["paneId"], pane.as_str());
        assert_eq!(frame["frame"]["workspaceId"], hidden["workspace_id"]);
        assert_eq!(frame["frame"]["agent"], "codex");
        assert_eq!(frame["frame"]["cwd"], hidden["cwd"]);
    }
    // Stopping closes the channel, which ends the host process.
    agent_watch_stop(app.state(), id.into(), token)
        .await
        .unwrap();
    until(&seen, |event| event["type"] == "closed").await;
    old_companion(app, id, directory, target).await;
    let _ = herdr(directory).args(["server", "stop"]).output();
    let _ = server.kill();
    let _ = server.wait();
}
