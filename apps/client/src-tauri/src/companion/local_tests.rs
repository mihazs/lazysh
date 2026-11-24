//! The local companion: how a command line becomes argv, which executable is chosen, and a real
//! `lazysh-agent` serving a local session. The real-runtime cases need the companion this build
//! produced in `LAZYSH_TEST_AGENT_BIN` (a release build: hook setup refuses binaries over 64 MiB).
use super::*;
use crate::host::process_gone;
use crate::{
    app_lock::{AccessLease, AccessState, Guarded, GuardedError},
    local::{adopted_test_session, LocalState},
    ssh::{self, AppState, SshError},
};
use serde_json::{json, Value};
use std::{fs, future::Future};
use tauri::{test::MockRuntime, App, Manager};

fn line(argv: &[&str]) -> String {
    Cmd::new(&[], argv).render()
}

#[test]
fn local_companion_commands_carry_the_compiled_app_version() {
    let command = argv("lazysh-agent snapshot --limit 50", "/owned/lazysh-agent").unwrap();
    assert_eq!(
        command.render(),
        format!(
            "LAZYSH_APP_VERSION={} /owned/lazysh-agent snapshot --limit 50",
            env!("CARGO_PKG_VERSION")
        )
    );
}

#[test]
fn a_rendered_command_splits_back_into_exactly_its_argv() {
    for argv in [
        vec!["lazysh-agent", "snapshot", "--limit", "50"],
        vec![
            "lazysh-agent",
            "transcript",
            "--path",
            "/home/o wner/it's $(id); `x` | y & z > w < v # \\ \"q\".jsonl",
        ],
        vec!["lazysh-agent", "x", "--message=it's", "--pane-id=%7", ""],
        vec![
            "lazysh-agent",
            "x",
            "'",
            "''",
            "'a'",
            "a\nb",
            "tab\t",
            "世界",
        ],
    ] {
        assert_eq!(words(&line(&argv)).unwrap(), argv);
    }
    // The builders glue `--name=` to a quoted value.
    let glued = format!(
        "lazysh-agent reported-history --session-id={}",
        ssh::quote("a b'c")
    );
    assert_eq!(
        words(&glued).unwrap(),
        ["lazysh-agent", "reported-history", "--session-id=a b'c"]
    );
}

#[test]
fn shell_syntax_outside_quotes_is_refused_not_interpreted() {
    for line in [
        "lazysh-agent snapshot $(id)",
        "lazysh-agent snapshot;id",
        "lazysh-agent snapshot | id",
        "lazysh-agent snapshot `id`",
        "lazysh-agent snapshot && id",
        "lazysh-agent snapshot > out",
        "lazysh-agent snapshot\nid",
        "lazysh-agent snapshot\tid",
        "lazysh-agent snapshot \\x",
        "lazysh-agent snapshot \"x\"",
        "lazysh-agent snapshot 'unterminated",
        "lazysh-agent snapshot %7",
    ] {
        assert_eq!(
            words(line).unwrap_err().kind(),
            "companion_command",
            "{line}"
        );
    }
}

fn agent_in(directory: &Path) -> PathBuf {
    fs::create_dir_all(directory).unwrap();
    let file = directory.join(NAME);
    fs::write(&file, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    file
}

#[test]
fn the_bundled_companion_wins_over_the_path_and_a_relative_path_entry_is_never_searched() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (bundled, listed) = (agent_in(&root.join("app")), agent_in(&root.join("listed")));
    let path = std::env::join_paths([root.join("empty"), root.join("listed")]).unwrap();
    assert_eq!(
        find(Some(&root.join("app")), None, &path),
        Some((bundled.clone(), Source::Bundled))
    );
    assert_eq!(find(None, None, &path), Some((listed, Source::Path)));
    // A companion in the working directory is not one the user put on the PATH.
    assert_eq!(find(None, None, OsStr::new("")), None);
    assert_eq!(find(None, None, OsStr::new("relative:.")), None);
    fs::remove_file(bundled).unwrap();
    assert_eq!(find(Some(&root.join("app")), None, OsStr::new("")), None);
}

#[cfg(unix)]
#[test]
fn the_managed_copy_comes_after_the_bundle_and_before_the_path_and_must_be_the_users_own() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (bundled, managed, listed) = (
        agent_in(&root.join("app")),
        agent_in(&root.join("data")),
        agent_in(&root.join("listed")),
    );
    let path = std::env::join_paths([root.join("listed")]).unwrap();
    let find = || find(Some(&root.join("app")), Some(&root.join("data")), &path);
    let on_path = Some((listed.clone(), Source::Path));
    assert_eq!(find(), Some((bundled.clone(), Source::Bundled)));
    fs::remove_file(&bundled).unwrap();
    assert_eq!(find(), Some((managed.clone(), Source::Managed)));
    // Anyone else able to write the file could change what this account runs.
    fs::set_permissions(&managed, fs::Permissions::from_mode(0o770)).unwrap();
    assert_eq!(find(), on_path);
    fs::set_permissions(&managed, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(find(), on_path, "not executable");
    fs::remove_file(&managed).unwrap();
    symlink(&listed, &managed).unwrap();
    assert_eq!(find(), on_path, "a link is not a managed copy");
    // The PATH keeps working for a user-installed companion, and a plain file is skipped.
    fs::set_permissions(&listed, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(find(), None);
}

/// A stand-in executable that reports `version` the way the companion does.
#[cfg(unix)]
fn reporting(path: &Path, version: &str) {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        format!("#!/bin/sh\nprintf 'lazysh-agent {version}\\n'\n"),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn version_probe_recovers_after_a_transient_busy_executable() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("agent");
    reporting(&executable, "1.4.0");
    let writer = fs::OpenOptions::new()
        .write(true)
        .open(&executable)
        .unwrap();
    assert_eq!(
        std::process::Command::new(&executable)
            .output()
            .unwrap_err()
            .raw_os_error(),
        Some(libc::ETXTBSY)
    );
    let probe = version_of(&executable);
    tokio::pin!(probe);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut probe)
            .await
            .is_err(),
        "the probe must keep trying while the executable is busy"
    );
    drop(writer);
    assert_eq!(probe.await.as_deref(), Some("1.4.0"));
}

#[cfg(unix)]
#[tokio::test]
async fn the_bundled_companion_is_copied_privately_and_only_replaced_by_a_newer_one() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let bundled = temp.path().join("mount/usr/bin/lazysh-agent");
    let target = temp.path().join("data/lazysh/companion/lazysh-agent");
    let run = |path: &Path| {
        let mut attempts = 0;
        let output = loop {
            match std::process::Command::new(path).output() {
                Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && attempts < 100 => {
                    attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                result => break result.unwrap(),
            }
        };
        String::from_utf8(output.stdout).unwrap()
    };
    reporting(&bundled, "1.4.0");
    ensure_copy(&bundled, &target).await.unwrap();
    assert_eq!(run(&target), "lazysh-agent 1.4.0\n");
    let meta = fs::metadata(&target).unwrap();
    assert_eq!(
        (meta.mode() & 0o777, meta.nlink()),
        (0o700, 1),
        "owner-only, not a link"
    );
    assert_eq!(
        fs::metadata(target.parent().unwrap()).unwrap().mode() & 0o077,
        0
    );
    // The same version is kept: the file is not rewritten under a hook that runs it.
    let inode = meta.ino();
    ensure_copy(&bundled, &target).await.unwrap();
    assert_eq!(fs::metadata(&target).unwrap().ino(), inode);
    // An older copy gives way to the bundle; a newer one (an update that ran in place) stays.
    reporting(&bundled, "1.5.0");
    ensure_copy(&bundled, &target).await.unwrap();
    assert_eq!(run(&target), "lazysh-agent 1.5.0\n");
    reporting(&target, "2.0.0");
    ensure_copy(&bundled, &target).await.unwrap();
    assert_eq!(run(&target), "lazysh-agent 2.0.0\n");
    // A copy another account could change is not trusted, even at the right version.
    fs::set_permissions(&target, fs::Permissions::from_mode(0o770)).unwrap();
    ensure_copy(&bundled, &target).await.unwrap();
    assert_eq!(run(&target), "lazysh-agent 1.5.0\n");
    assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o700);
    // No staging file is left beside it.
    let names = fs::read_dir(target.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(names, ["lazysh-agent"]);
}

#[cfg(unix)]
#[tokio::test]
async fn nothing_is_copied_from_a_bundle_that_does_not_run_or_into_a_shared_directory() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("data/lazysh/companion/lazysh-agent");
    let bundled = agent_in(&temp.path().join("mount"));
    // A file that is not the companion prints no version.
    assert_eq!(
        ensure_copy(&bundled, &target).await.unwrap_err().kind(),
        "remote_command_failed"
    );
    assert!(!target.exists());
    reporting(&bundled, "1.4.0");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::set_permissions(target.parent().unwrap(), fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(
        ensure_copy(&bundled, &target).await.unwrap_err().kind(),
        "remote_command_failed"
    );
    assert!(!target.exists(), "a directory others can write is refused");
}

#[test]
fn an_installed_companion_stands_in_for_the_bundle_only_when_it_is_not_older() {
    for (installed, bundled, kept) in [
        ("1.4.0", "1.4.0", true),
        ("1.10.0", "1.9.0", true),
        ("1.3.9", "1.4.0", false),
        ("1.4.0-dev", "1.4.0-dev", true),
        ("1.4.0-dev", "1.4.0", false),
    ] {
        assert_eq!(at_least(installed, bundled), kept, "{installed} {bundled}");
    }
}

/// The capability the panel reads: the source is named exactly when a companion resolved.
#[cfg(desktop)]
async fn companion_tools() -> Value {
    let capability = serde_json::to_value(crate::local::local_capability().await).unwrap();
    capability["targets"][0]["tools"].clone()
}

#[cfg(desktop)]
#[tokio::test]
async fn the_local_capability_names_the_companion_source_exactly_when_it_has_one() {
    let tools = companion_tools().await;
    let source = &tools["companionSource"];
    assert_eq!(tools["companion"], json!(!source.is_null()));
    assert!(source.is_null() || ["bundled", "managed", "path"].contains(&source.as_str().unwrap()));
}

// ---- A real companion serving a local session.

/// The companion this build produced, placed beside the test executable the way the desktop
/// bundle places it beside the app, so resolution is the one a shipped app performs. The copy is
/// a distinct file: hook setup refuses a binary with more than one hard link.
fn bundle() -> PathBuf {
    static PLACED: std::sync::Once = std::sync::Once::new();
    let target = std::env::current_exe().unwrap().with_file_name(NAME);
    PLACED.call_once(|| {
        let source = std::env::var_os("LAZYSH_TEST_AGENT_BIN")
            .expect("build lazysh-agent from this checkout and pass it as LAZYSH_TEST_AGENT_BIN");
        let staged = target.with_extension("staging");
        fs::copy(source, &staged).unwrap();
        fs::rename(&staged, &target).unwrap();
    });
    target
}

/// Everything the companion and the agents it serves read, kept under one temporary directory.
fn variables(home: &Path) -> Vec<(String, String)> {
    let text = |path: PathBuf| path.to_str().unwrap().to_owned();
    vec![
        ("HOME".into(), text(home.into())),
        ("USERPROFILE".into(), text(home.into())),
        ("CLAUDE_CONFIG_DIR".into(), text(home.join(".claude"))),
        ("LAZYSH_STATE_DIR".into(), text(home.join("state"))),
        ("XDG_CONFIG_HOME".into(), text(home.join(".config"))),
        ("XDG_DATA_HOME".into(), text(home.join("data"))),
    ]
}
fn lease() -> AccessLease {
    AccessState::disabled().lease(None).unwrap()
}
async fn session(home: &Path) -> (App<MockRuntime>, String) {
    session_with(home, Vec::new()).await
}
/// A session whose commands also see `extra` variables, which win over the login PATH.
async fn session_with(home: &Path, extra: Vec<(String, String)>) -> (App<MockRuntime>, String) {
    let app = tauri::test::mock_app();
    app.manage(AppState::new(home.join("app")).unwrap());
    app.manage(LocalState::default());
    app.manage(crate::devices::DeviceStreams::default());
    app.state::<LocalState>()
        .set_test_env([variables(home), extra].concat());
    let id = adopted_test_session(&app.state::<LocalState>(), lease()).await;
    (app, id)
}
#[cfg(unix)]
#[tokio::test]
async fn local_companion_child_receives_the_app_version() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let script = temp.path().join("owned-agent");
    fs::write(&script, b"#!/bin/sh\nprintf '%s' \"$LAZYSH_APP_VERSION\"\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let (app, id) = session(temp.path()).await;
    let host = crate::host::Host::resolve(&app.state(), &app.state(), &id, &lease())
        .await
        .unwrap();
    let command = argv("lazysh-agent snapshot", script.to_str().unwrap()).unwrap();
    assert_eq!(
        host.run_bytes(&lease(), &command).await.unwrap(),
        env!("CARGO_PKG_VERSION").as_bytes()
    );
}

// Boxed when called, not when awaited: a command future held in a test's own state overflows
// the test thread's stack in debug.
fn call<T>(
    answer: impl Future<Output = std::result::Result<Guarded<T>, GuardedError<SshError>>>,
) -> impl Future<Output = std::result::Result<T, SshError>> {
    let answer = Box::pin(answer);
    async move {
        match answer.await {
            Ok(value) => Ok(value.into_inner().unwrap()),
            Err(error) => Err(error.into_inner().unwrap()),
        }
    }
}
async fn transcript(app: &App<MockRuntime>, id: &str, path: &Path) -> Result<Value> {
    call(crate::ssh::agent_transcript(
        lease(),
        app.state(),
        app.state(),
        id.into(),
        "claude".into(),
        path.to_str().unwrap().into(),
        0,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    ))
    .await
}

#[tokio::test]
#[ignore = "requires the companion this build produced in LAZYSH_TEST_AGENT_BIN"]
async fn real_local_companion_serves_the_board_transcripts_and_settings_without_a_shell() {
    bundle();
    // Placed beside the app executable, it resolves as the bundled companion.
    let tools = companion_tools().await;
    assert_eq!(
        (&tools["companion"], &tools["companionSource"]),
        (&json!(true), &json!("bundled"))
    );
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let recorded = home.join(".claude/projects/project/recorded.jsonl");
    fs::create_dir_all(recorded.parent().unwrap()).unwrap();
    fs::write(
        &recorded,
        "{\"type\":\"user\",\"uuid\":\"u1\",\"parentUuid\":null,\"timestamp\":\"2026-11-11T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Ship the feature\"}}\n\
         {\"type\":\"assistant\",\"uuid\":\"a1\",\"parentUuid\":\"u1\",\"timestamp\":\"2026-11-11T10:00:05Z\",\"message\":{\"role\":\"assistant\",\"id\":\"m1\",\"content\":[{\"type\":\"text\",\"text\":\"Done.\"}]}}\n",
    )
    .unwrap();
    let (app, id) = session(home).await;

    let board = call(crate::ssh::agent_snapshot(
        lease(),
        app.state(),
        app.state(),
        id.clone(),
    ))
    .await
    .unwrap();
    assert_eq!(board, json!({"schemaVersion": 1, "sessions": []}));

    let found = call(crate::ssh::agent_transcripts(
        lease(),
        app.state(),
        app.state(),
        id.clone(),
        "claude".into(),
    ))
    .await
    .unwrap();
    assert_eq!(found["sessions"][0]["name"], "recorded.jsonl");
    let read = transcript(&app, &id, &recorded).await.unwrap();
    let texts = read["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["blocks"][0]["text"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(texts, ["Ship the feature", "Done."]);

    // Settings round-trip through the companion's own revisioned store.
    let settings = |expected: u64, discovery: bool| {
        serde_json::from_value(
            json!({"expectedRevision": expected, "transcriptDiscoveryEnabled": discovery,
            "recordedUsageEnabled": true, "deviceToolsEnabled": true}),
        )
        .unwrap()
    };
    let updated = call(crate::companion_settings::update_companion_settings(
        app.state(),
        app.state(),
        id.clone(),
        settings(0, false),
        lease(),
    ))
    .await
    .unwrap();
    assert_eq!(serde_json::to_value(&updated).unwrap()["revision"], 1);
    let shown = call(crate::companion_settings::get_companion_settings(
        app.state(),
        app.state(),
        id.clone(),
        lease(),
    ))
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&shown).unwrap()["transcriptDiscoveryEnabled"],
        false
    );

    // Text that a shell would run is one argument of the companion, never a command.
    let marker = home.join("pwned");
    let hostile = home.join(format!("x'; touch {}; '", marker.display()));
    if cfg!(unix) {
        let error = transcript(&app, &id, &hostile).await.unwrap_err();
        assert_eq!(error.kind(), "remote_command_failed");
        assert!(!marker.exists(), "no shell ran the path");
    }
    let missing = transcript(&app, &id, &home.join("missing.jsonl")).await;
    assert_eq!(missing.unwrap_err().kind(), "remote_command_failed");
}

/// Runs a hook the way an agent does: the event on stdin, the pane identity in the environment.
#[cfg(unix)]
async fn hook(
    program: &Path,
    args: &[String],
    home: &Path,
    payload: &Value,
) -> tokio::process::Child {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new(program);
    child
        .args(args)
        .envs(variables(home))
        .env("TMUX_PANE", "%7")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = child.spawn().unwrap();
    // Dropping stdin ends the event, as the agent's hook runner does.
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(payload.to_string().as_bytes())
        .await
        .unwrap();
    child
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires the companion this build produced in LAZYSH_TEST_AGENT_BIN"]
async fn real_local_hooks_report_to_the_board_and_a_permission_request_is_answered() {
    let companion = bundle();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let (app, id) = session(home).await;
    let profile = home.join(".claude");
    let settings =
        crate::companion::hooks::install_keeping_foreign_settings(&app, &id, &profile, &lease())
            .await;
    // The profile runs a private copy in the managed folder, not the bundle, which an AppImage
    // runs from a mount that is gone once the app exits.
    let command = words(
        settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let managed = home.join("data/lazysh/companion").join(NAME);
    assert_eq!(command[0], managed.to_str().unwrap());
    assert_ne!(managed, companion);
    assert_eq!(
        fs::read(&managed).unwrap(),
        fs::read(&companion).unwrap(),
        "the same executable the app bundles"
    );

    let prompt = json!({"hook_event_name": "UserPromptSubmit", "session_id": "local-one",
        "cwd": "/work/local", "prompt": "hello"});
    let reported = hook(&managed, &command[1..], home, &prompt)
        .await
        .wait_with_output()
        .await
        .unwrap();
    assert!(reported.status.success());
    let board = call(crate::ssh::agent_snapshot(
        lease(),
        app.state(),
        app.state(),
        id.clone(),
    ))
    .await
    .unwrap();
    let row = &board["sessions"][0];
    assert_eq!(
        (
            row["sessionId"].as_str(),
            row["agent"].as_str(),
            row["state"].as_str()
        ),
        (Some("local-one"), Some("Claude Code"), Some("working"))
    );

    // A blocked PermissionRequest appears as an approval and the answer reaches the hook.
    let permission = json!({"hook_event_name": "PermissionRequest", "session_id": "local-two",
        "cwd": "/work/local", "tool_name": "Bash", "tool_input": {"command": "echo hi"}});
    let waiting = hook(
        &managed,
        &[
            "approval-request",
            "--agent",
            "claude",
            "--timeout-seconds",
            "60",
        ]
        .map(String::from),
        home,
        &permission,
    )
    .await;
    let request = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let listed = call(crate::approvals::agent_approvals(
                app.state(),
                app.state(),
                id.clone(),
                lease(),
            ))
            .await
            .unwrap();
            if let Some(request) = listed["requests"].as_array().and_then(|rows| rows.first()) {
                return request.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the waiting hook must appear in the approval list");
    let field = |name: &str| request[name].as_str().unwrap().to_owned();
    let answer = call(crate::approvals::resolve_agent_approval(
        app.state(),
        app.state(),
        id.clone(),
        field("id"),
        field("expectedHash"),
        field("sessionId"),
        Some(field("paneId")),
        "allow".into(),
        None,
        None,
        lease(),
    ))
    .await
    .unwrap();
    assert_eq!(answer, json!({"schemaVersion": 1, "accepted": true}));
    let decided = waiting.wait_with_output().await.unwrap();
    let decision: Value = serde_json::from_slice(&decided.stdout).unwrap();
    assert_eq!(
        decision["hookSpecificOutput"]["decision"]["behavior"],
        "allow"
    );
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires the companion this build produced in LAZYSH_TEST_AGENT_BIN"]
async fn real_local_hook_setup_on_windows_is_template_only() {
    bundle();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    // The request names an existing provider profile; the case is about what Windows does with it.
    fs::create_dir(home.join(".claude")).unwrap();
    let (app, id) = session(home).await;
    let request = |action: &str| {
        serde_json::from_value(json!({"agent": "claude", "action": action,
            "profileRoot": home.join(".claude"),
            // A status inspects; only a mutation names the plan it was shown.
            "expectedPlan": (action != "status").then(|| "0".repeat(64))}))
        .unwrap()
    };
    let hooks = |action: &str| {
        call(crate::companion::hooks::companion_hooks(
            app.state(),
            app.state(),
            id.clone(),
            request(action),
            lease(),
        ))
    };
    let status = hooks("status").await.unwrap();
    assert_eq!(
        (status["supported"].as_bool(), status["reason"].as_str()),
        (Some(false), Some("HooksAclUnsupported"))
    );
    assert_eq!(
        hooks("install").await.unwrap_err().kind(),
        "remote_command_failed"
    );
    let discovered = call(crate::companion::hooks::companion_hook_discovery(
        app.state(),
        app.state(),
        id.clone(),
        None,
        lease(),
    ))
    .await
    .unwrap();
    assert_eq!(discovered["schemaVersion"], 1);
}

// ---- Host devices on this device, driven through a fake Android SDK.

/// The fake SDK (`LAZYSH_TEST_FAKE_SDK_BIN`) laid out where `lazysh-agent devices` looks for the
/// real one: `adb` and `emulator` under `ANDROID_HOME`, `ffmpeg` first on the PATH. Returns the
/// variables that point a session at it and the directory its long-lived children announce
/// themselves in.
fn fake_sdk(home: &Path) -> (Vec<(String, String)>, PathBuf) {
    let source = std::env::var_os("LAZYSH_TEST_FAKE_SDK_BIN")
        .expect("build the fake_android_sdk example and pass it as LAZYSH_TEST_FAKE_SDK_BIN");
    let place = |directory: PathBuf, name: &str| {
        fs::create_dir_all(&directory).unwrap();
        let file = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_owned()
        };
        fs::copy(&source, directory.join(file)).unwrap();
    };
    let sdk = home.join("sdk");
    place(sdk.join("platform-tools"), "adb");
    place(sdk.join("emulator"), "emulator");
    place(home.join("bin"), "ffmpeg");
    let pids = home.join("pids");
    fs::create_dir_all(&pids).unwrap();
    let mut directories = vec![home.join("bin")];
    directories.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let path = std::env::join_paths(directories).unwrap();
    let text = |path: &Path| path.to_str().unwrap().to_owned();
    (
        vec![
            ("ANDROID_HOME".into(), text(&sdk)),
            ("ANDROID_SDK_ROOT".into(), text(&sdk)),
            ("PATH".into(), path.to_str().unwrap().to_owned()),
            ("LAZYSH_FAKE_SDK_PIDS".into(), text(&pids)),
        ],
        pids,
    )
}
/// The `<role>-<pid>` files the fake SDK's long-lived children left behind.
fn announced(directory: &Path) -> Vec<(String, u32)> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| {
            let name = entry.unwrap().file_name().into_string().unwrap();
            let (role, pid) = name.split_once('-').unwrap();
            (role.to_owned(), pid.parse().unwrap())
        })
        .collect()
}
/// Starts the stream of the fake device and waits for its first frame.
async fn streaming(app: &App<MockRuntime>, id: &str) -> (String, Value) {
    let token = call(crate::devices::stream::device_stream_start(
        lease(),
        app.state(),
        app.state(),
        app.state(),
        id.into(),
        "emulator-5554".into(),
        None,
        Some("android".into()),
    ))
    .await
    .unwrap();
    let first = call(crate::devices::stream::device_stream_next(
        lease(),
        app.state(),
        id.into(),
        token.clone(),
        0,
    ))
    .await
    .unwrap();
    (token, serde_json::to_value(first).unwrap())
}

#[tokio::test]
#[ignore = "requires the companion in LAZYSH_TEST_AGENT_BIN and the fake SDK in LAZYSH_TEST_FAKE_SDK_BIN"]
async fn real_local_companion_lists_devices_and_streams_frames_until_stopped_or_the_session_closes()
{
    bundle();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let (variables, pids) = fake_sdk(home);
    let (app, id) = session_with(home, variables).await;

    let listed = call(crate::devices::list_devices(
        lease(),
        app.state(),
        app.state(),
        id.clone(),
        "android".into(),
    ))
    .await
    .unwrap();
    assert_eq!(listed["devices"][0]["id"], "emulator-5554");
    assert_eq!(listed["devices"][0]["state"], "running");
    assert_eq!(listed["avds"][0]["id"], "Pixel_API_36");
    let screenshot = call(crate::devices::device_frame(
        lease(),
        app.state(),
        app.state(),
        id.clone(),
        "android".into(),
        "emulator-5554".into(),
    ))
    .await
    .unwrap();
    assert_eq!(
        (screenshot["mime"].as_str(), screenshot["id"].as_str()),
        (Some("image/jpeg"), Some("emulator-5554"))
    );
    let probe = call(crate::devices::android_device_probe(
        lease(),
        app.state(),
        app.state(),
        id.clone(),
        "emulator-5554".into(),
    ))
    .await
    .unwrap();
    assert_eq!(probe["stream"], true);
    // The device id stays one argument of the companion, which refuses it: no shell ran it.
    let marker = home.join("pwned");
    let hostile = format!("x'; touch {}; '", marker.display());
    let refused = call(crate::devices::android_device_probe(
        lease(),
        app.state(),
        app.state(),
        id.clone(),
        hostile,
    ))
    .await;
    assert_eq!(refused.unwrap_err().kind(), "remote_command_failed");
    assert!(!marker.exists());

    // Frames arrive in order, and stopping the stream removes everything it started.
    let (token, first) = streaming(&app, &id).await;
    assert_eq!(first["frame"]["id"], "emulator-5554");
    assert_eq!(first["frame"]["mime"], "image/jpeg");
    let after = first["sequence"].as_u64().unwrap();
    let second = call(crate::devices::stream::device_stream_next(
        lease(),
        app.state(),
        id.clone(),
        token.clone(),
        after,
    ))
    .await
    .unwrap();
    assert!(serde_json::to_value(second).unwrap()["sequence"].as_u64() > Some(after));
    crate::devices::stream::device_stream_stop(app.state(), id.clone(), token)
        .await
        .unwrap();
    let started = announced(&pids);
    assert_eq!(started.len(), 2, "{started:?}");
    for (_, pid) in &started {
        assert!(process_gone(*pid).await, "{pid} outlived its stream");
    }

    // Closing the session ends a running stream by itself.
    let (token, frame) = streaming(&app, &id).await;
    assert!(frame["frame"].is_object());
    crate::local::local_disconnect(app.state(), id.clone()).unwrap();
    let all = announced(&pids);
    assert_eq!(all.len(), 4, "{all:?}");
    for (_, pid) in &all {
        assert!(process_gone(*pid).await, "{pid} outlived its session");
    }
    crate::devices::stream::device_stream_stop(app.state(), id, token)
        .await
        .unwrap();
}
