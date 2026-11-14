//! The local companion: how a command line becomes argv, which executable is chosen, and a real
//! `lazysh-agent` serving a local session. The real-runtime cases need the companion this build
//! produced in `LAZYSH_TEST_AGENT_BIN` (a release build: hook setup refuses binaries over 64 MiB).
use super::*;
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
        Some(bundled.clone())
    );
    assert_eq!(find(None, None, &path), Some(listed));
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
    assert_eq!(find(), Some(bundled.clone()));
    fs::remove_file(&bundled).unwrap();
    assert_eq!(find(), Some(managed.clone()));
    // Anyone else able to write the file could change what this account runs.
    fs::set_permissions(&managed, fs::Permissions::from_mode(0o770)).unwrap();
    assert_eq!(find(), Some(listed.clone()));
    fs::set_permissions(&managed, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(find(), Some(listed.clone()), "not executable");
    fs::remove_file(&managed).unwrap();
    symlink(&listed, &managed).unwrap();
    assert_eq!(find(), Some(listed.clone()), "a link is not a managed copy");
    // The PATH keeps working for a user-installed companion, and a plain file is skipped.
    fs::set_permissions(&listed, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(find(), None);
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
    let app = tauri::test::mock_app();
    app.manage(AppState::new(home.join("app")).unwrap());
    app.manage(LocalState::default());
    app.state::<LocalState>().set_test_env(variables(home));
    let id = adopted_test_session(&app.state::<LocalState>(), lease()).await;
    (app, id)
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
    ))
    .await
}

#[tokio::test]
#[ignore = "requires the companion this build produced in LAZYSH_TEST_AGENT_BIN"]
async fn real_local_companion_serves_the_board_transcripts_and_settings_without_a_shell() {
    bundle();
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
    // The profile now runs the bundled companion by its absolute path.
    let command = words(
        settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(command[0], companion.to_str().unwrap());

    let prompt = json!({"hook_event_name": "UserPromptSubmit", "session_id": "local-one",
        "cwd": "/work/local", "prompt": "hello"});
    let reported = hook(&companion, &command[1..], home, &prompt)
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
        &companion,
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
    let (app, id) = session(home).await;
    let request = |action: &str| {
        serde_json::from_value(json!({"agent": "claude", "action": action,
            "profileRoot": home.join(".claude"), "expectedPlan": "0".repeat(64)}))
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
