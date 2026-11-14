//! Owned OpenSSH acceptance of the agent board and remote approvals: a current-source
//! companion installed by the client, real hook processes on the host and the client's
//! own snapshot, approval list and decision commands. No agent CLI or provider runs.
use super::*;
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;

pub(super) fn environment(directory: &Path) -> String {
    fs::create_dir(directory.join("bin")).unwrap();
    // A private HOME must not trigger zsh's interactive first-user setup.
    fs::write(directory.join(".zshrc"), b"").unwrap();
    assert!(!directory.to_str().unwrap().chars().any(char::is_whitespace));
    format!("SetEnv PATH={}:/usr/bin:/bin HOME={} XDG_CONFIG_HOME={} XDG_DATA_HOME={} LAZYSH_STATE_DIR={} ZDOTDIR={} BASH_ENV=/dev/null ENV=/dev/null\n",directory.join("bin").display(),directory.display(),directory.join(".config").display(),directory.join("data").display(),directory.join("state").display(),directory.display())
}

type App = tauri::App<tauri::test::MockRuntime>;

async fn board(app: &App, id: &str) -> Vec<Value> {
    let snapshot = agent_snapshot(access_lease(), app.state(), id.into())
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    assert_eq!(snapshot["schemaVersion"], 1);
    snapshot["sessions"].as_array().unwrap().clone()
}

fn row<'a>(rows: &'a [Value], session: &str) -> &'a Value {
    let matching: Vec<_> = rows
        .iter()
        .filter(|row| row["sessionId"] == session)
        .collect();
    assert_eq!(matching.len(), 1, "one board row for {session}: {rows:?}");
    matching[0]
}

async fn approvals(app: &App, id: &str) -> Vec<Value> {
    let listed = crate::approvals::agent_approvals(app.state(), id.into(), access_lease())
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    assert_eq!(listed["schemaVersion"], 1);
    listed["requests"].as_array().unwrap().clone()
}

async fn decide(
    app: &App,
    id: &str,
    request: &Value,
    hash: &str,
    pane: Option<&str>,
    decision: &str,
) -> std::result::Result<Value, String> {
    decide_with(app, id, request, hash, pane, (decision, None, None)).await
}

/// A decision with a suggested permission update (allow) or a message for the agent (deny).
async fn decide_with(
    app: &App,
    id: &str,
    request: &Value,
    hash: &str,
    pane: Option<&str>,
    (decision, option, message): (&str, Option<u8>, Option<&str>),
) -> std::result::Result<Value, String> {
    crate::approvals::resolve_agent_approval(
        app.state(),
        id.into(),
        request["id"].as_str().unwrap().into(),
        hash.into(),
        request["sessionId"].as_str().unwrap().into(),
        pane.map(str::to_owned),
        decision.into(),
        option,
        message.map(str::to_owned),
        access_lease(),
    )
    .await
    .map(|value| value.into_inner().unwrap())
    .map_err(|error| error.into_inner().unwrap().kind().to_owned())
}

/// The companion refuses a stale or mismatched identity by exiting non-zero; a
/// transport or lock failure would surface as a different kind.
async fn refused(
    app: &App,
    id: &str,
    request: &Value,
    hash: &str,
    pane: Option<&str>,
    decision: &str,
) {
    assert_eq!(
        decide(app, id, request, hash, pane, decision)
            .await
            .unwrap_err(),
        "remote_command_failed"
    );
}

/// Runs one hook command on the host exactly as an agent would: the event on stdin
/// and the pane identity inherited from the multiplexer environment.
async fn hook(session: &Session, command: &str, pane: &str, payload: Value) -> String {
    exec(
        session,
        &access_lease(),
        format!(
            "printf '%s' {} | TMUX_PANE={} {command}",
            quote(&payload.to_string()),
            quote(pane)
        ),
    )
    .await
    .unwrap()
}

struct WaitingHook {
    task: tokio::task::JoinHandle<Result<String>>,
    pid: PathBuf,
}

/// Starts a blocking Claude PermissionRequest hook on the host. Its process ID is
/// recorded so the test can end it the way Claude does after an answer at the host.
fn waiting_hook(
    session: Arc<Session>,
    directory: &Path,
    companion: &Path,
    name: &str,
    pane: &str,
    payload: Value,
) -> WaitingHook {
    let input = directory.join(format!("{name}.json"));
    fs::write(&input, payload.to_string()).unwrap();
    let pid = directory.join(format!("{name}.pid"));
    let command = format!(
        "TMUX_PANE={}; export TMUX_PANE; echo $$ > {}; exec {} approval-request --agent claude --timeout-seconds 90 < {}",
        quote(pane),
        quote(pid.to_str().unwrap()),
        quote(companion.to_str().unwrap()),
        quote(input.to_str().unwrap())
    );
    let task = tokio::spawn(async move {
        exec_bounded(
            &session,
            command,
            &access_lease(),
            Duration::from_secs(120),
            64 * 1024,
            None,
        )
        .await
    });
    WaitingHook { task, pid }
}

async fn pending(app: &App, id: &str, session: &str) -> Value {
    timeout(Duration::from_secs(20), async {
        loop {
            if let Some(request) = approvals(app, id)
                .await
                .into_iter()
                .find(|request| request["sessionId"] == session)
            {
                return request;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the waiting hook must appear in the client's approval list")
}

async fn hook_decision(hook: WaitingHook) -> Value {
    let output = timeout(Duration::from_secs(20), hook.task)
        .await
        .expect("the waiting hook must return after a decision")
        .unwrap()
        .unwrap();
    serde_json::from_str::<Value>(&output).unwrap()["hookSpecificOutput"]["decision"].clone()
}

pub(super) async fn verify(app: &App, id: &str, directory: &Path) {
    let binary = super::companion_fixture::owned_agent_binary();
    let session = app.state::<AppState>().session(id).await.unwrap();
    let lease = access_lease();
    let installed = serde_json::to_value(
        crate::companion::Owned::new(&binary, env!("CARGO_PKG_VERSION"))
            .install(
                session.clone(),
                &lease,
                crate::companion::install::Route::Device,
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(installed["status"], "installed");
    let companion = PathBuf::from(installed["path"].as_str().unwrap());
    assert!(
        board(app, id).await.is_empty(),
        "a fresh host has no reports"
    );

    // Managed Claude setup from the client writes the hook commands the agent will run.
    let profile = directory.join(".claude");
    fs::create_dir(&profile).unwrap();
    fs::write(profile.join("settings.json"), "{\"theme\": \"dark\"}").unwrap();
    let invoke = |action: &str, plan: Option<&str>| {
        let request = serde_json::from_value(
            json!({"agent":"claude","action":action,"profileRoot":profile,"expectedPlan":plan}),
        )
        .unwrap();
        crate::companion::hooks::execute(&session, request, &lease)
    };
    let status = invoke("status", None).await.unwrap();
    let configured = invoke("install", status["installPlan"].as_str())
        .await
        .unwrap();
    assert_eq!(configured["outcome"]["status"], "configured");
    let settings: Value =
        serde_json::from_slice(&fs::read(profile.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        settings["theme"], "dark",
        "managed setup keeps other settings"
    );
    let command = |event: &str| {
        let groups = settings["hooks"][event].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        groups[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let prompt = command("UserPromptSubmit");
    for event in ["PreToolUse", "Stop", "Notification"] {
        assert_eq!(
            command(event),
            prompt,
            "every lifecycle event uses one companion command"
        );
    }
    assert_eq!(
        prompt,
        format!(
            "{} ingest --agent claude",
            quote(companion.to_str().unwrap())
        )
    );

    // An event recorded eight days ago ages out of the client's board.
    let aged = lazysh_agent::Event {
        session_id: "board-aged".into(),
        agent: "Claude Code".into(),
        project: "/work/aged".into(),
        state: lazysh_agent::SessionState::Done,
        summary: "Turn finished".into(),
        pane_id: None,
        waiting: None,
    };
    let recorded = chrono::Utc::now() - chrono::TimeDelta::days(8);
    let mut store = lazysh_agent::Store::open(&directory.join("state")).unwrap();
    store.ingest(&aged, recorded).unwrap();
    assert_eq!(
        store.snapshot(100, recorded).unwrap().sessions.len(),
        1,
        "the aged report is stored in the companion's state directory"
    );
    drop(store);
    assert!(
        board(app, id).await.is_empty(),
        "the aged report is not shown"
    );

    // Real hook events move one session through Working, Needs you and Done in one row.
    let alpha = |event: &str, extra: Value| {
        let mut payload = json!({"hook_event_name":event,"session_id":"board-alpha","cwd":"/work/alpha","prompt":"PRIVATE-PROMPT","tool_input":{"token":"SECRET-TOKEN"}});
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        payload
    };
    let steps = [
        (
            alpha("UserPromptSubmit", json!({})),
            "working",
            "Working on your prompt",
        ),
        (
            alpha("PreToolUse", json!({"tool_name":"Bash"})),
            "working",
            "Bash",
        ),
        (
            alpha(
                "Notification",
                json!({"notification_type":"permission_prompt"}),
            ),
            "needs_attention",
            "Agent needs attention",
        ),
        (alpha("Stop", json!({})), "done", "Turn finished"),
    ];
    for (count, (payload, state, summary)) in steps.into_iter().enumerate() {
        assert_eq!(hook(&session, &prompt, "%3", payload).await, "");
        let rows = board(app, id).await;
        assert_eq!(rows.len(), 1, "{rows:?}");
        let alpha = row(&rows, "board-alpha");
        assert_eq!(alpha["agent"], "Claude Code");
        assert_eq!(alpha["project"], "/work/alpha");
        assert_eq!(alpha["state"], state);
        assert_eq!(alpha["summary"], summary);
        assert_eq!(alpha["paneId"], "%3");
        assert_eq!(alpha["eventCount"], count + 1);
    }
    let text = serde_json::to_string(&board(app, id).await).unwrap();
    assert!(!text.contains("PRIVATE-PROMPT") && !text.contains("SECRET-TOKEN"));
    assert_eq!(
        hook(&session, &prompt, "%4", json!({"hook_event_name":"UserPromptSubmit","session_id":"board-beta","cwd":"/work/beta"})).await,
        ""
    );
    let rows = board(app, id).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["sessionId"], "board-beta", "newest report first");
    assert_eq!(row(&rows, "board-beta")["state"], "working");
    assert_eq!(row(&rows, "board-alpha")["state"], "done");

    // A waiting PermissionRequest hook is listed with its exact identity and puts its
    // session in Needs you; only that exact identity can answer it, exactly once.
    let tool = json!({"command":"git push --force-with-lease"});
    let request = |session: &str| json!({"hook_event_name":"PermissionRequest","session_id":session,"cwd":"/work/gamma","tool_name":"Bash","tool_input":tool});
    let allowed = waiting_hook(
        session.clone(),
        directory,
        &companion,
        "allowed",
        "%7",
        request("approval-allow"),
    );
    let listed = pending(app, id, "approval-allow").await;
    assert_eq!(listed["agent"], "claude");
    assert_eq!(listed["paneId"], "%7");
    assert_eq!(listed["project"], "/work/gamma");
    assert_eq!(listed["toolName"], "Bash");
    assert_eq!(listed["toolInput"], tool);
    let waiting = row(&board(app, id).await, "approval-allow").clone();
    assert_eq!(waiting["state"], "needs_attention");
    assert_eq!(waiting["summary"], "Bash");
    let hash = listed["expectedHash"].as_str().unwrap();
    let altered = format!(
        "{}{}",
        if hash.starts_with('0') { "1" } else { "0" },
        &hash[1..]
    );
    refused(app, id, &listed, &altered, Some("%7"), "allow").await;
    refused(app, id, &listed, hash, Some("%8"), "allow").await;
    refused(app, id, &listed, hash, None, "allow").await;
    assert_eq!(
        approvals(app, id).await.len(),
        1,
        "mismatched identities leave the request pending"
    );
    assert_eq!(
        decide(app, id, &listed, hash, Some("%7"), "allow")
            .await
            .unwrap(),
        json!({"schemaVersion":1,"accepted":true})
    );
    assert_eq!(hook_decision(allowed).await, json!({"behavior":"allow"}));
    refused(app, id, &listed, hash, Some("%7"), "deny").await;
    assert!(approvals(app, id).await.is_empty());

    let denied = waiting_hook(
        session.clone(),
        directory,
        &companion,
        "denied",
        "%9",
        request("approval-deny"),
    );
    let listed = pending(app, id, "approval-deny").await;
    decide(
        app,
        id,
        &listed,
        listed["expectedHash"].as_str().unwrap(),
        Some("%9"),
        "deny",
    )
    .await
    .unwrap();
    assert_eq!(hook_decision(denied).await["behavior"], "deny");

    // Claude's suggested permission updates are listed as the request's options. An allow with
    // one returns exactly that update to Claude; a deny with a message returns the message.
    let suggestion = json!({"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"git push:*"}],"behavior":"allow","destination":"localSettings"});
    let mut with_options = request("approval-option");
    with_options["permission_suggestions"] = json!([suggestion]);
    let optioned = waiting_hook(
        session.clone(),
        directory,
        &companion,
        "optioned",
        "%12",
        with_options.clone(),
    );
    let listed = pending(app, id, "approval-option").await;
    assert_eq!(listed["options"], json!([suggestion]));
    let hash = listed["expectedHash"].as_str().unwrap();
    for refused_answer in [
        ("allow", Some(1), None),
        ("deny", Some(0), None),
        ("allow", None, Some("no")),
    ] {
        decide_with(app, id, &listed, hash, Some("%12"), refused_answer)
            .await
            .unwrap_err();
    }
    decide_with(
        app,
        id,
        &listed,
        hash,
        Some("%12"),
        ("allow", Some(0), None),
    )
    .await
    .unwrap();
    assert_eq!(
        hook_decision(optioned).await,
        json!({"behavior":"allow","updatedPermissions":[suggestion]})
    );
    let messaged = waiting_hook(
        session.clone(),
        directory,
        &companion,
        "messaged",
        "%13",
        with_options,
    );
    let listed = pending(app, id, "approval-option").await;
    decide_with(
        app,
        id,
        &listed,
        listed["expectedHash"].as_str().unwrap(),
        Some("%13"),
        ("deny", None, Some("Push to a branch, not with force")),
    )
    .await
    .unwrap();
    assert_eq!(
        hook_decision(messaged).await,
        json!({"behavior":"deny","message":"Push to a branch, not with force"})
    );

    // Claude ends the hook when the prompt is answered at the host: the remote request
    // disappears and its identity can no longer be answered.
    let host = waiting_hook(
        session.clone(),
        directory,
        &companion,
        "host",
        "%11",
        request("approval-host"),
    );
    let listed = pending(app, id, "approval-host").await;
    let pid = fs::read_to_string(&host.pid).unwrap();
    assert!(std::process::Command::new("kill")
        .args(["-TERM", pid.trim()])
        .status()
        .unwrap()
        .success());
    let _ = timeout(Duration::from_secs(20), host.task).await.unwrap();
    assert!(approvals(app, id).await.is_empty());
    refused(
        app,
        id,
        &listed,
        listed["expectedHash"].as_str().unwrap(),
        Some("%11"),
        "allow",
    )
    .await;
    assert!(board(app, id)
        .await
        .iter()
        .all(|row| row["sessionId"] != "board-aged"));

    // Remove from the client takes out only the managed hooks.
    let status = invoke("status", None).await.unwrap();
    let removed = invoke("remove", status["removePlan"].as_str())
        .await
        .unwrap();
    assert_eq!(removed["outcome"]["status"], "removed");
    let settings: Value =
        serde_json::from_slice(&fs::read(profile.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        settings["theme"], "dark",
        "managed removal keeps other settings"
    );
    let events = settings["hooks"].as_object().unwrap();
    assert!(events.contains_key("UserPromptSubmit"));
    assert!(
        events.values().all(|groups| groups == &json!([])),
        "managed removal leaves no companion hook: {settings}"
    );
}
