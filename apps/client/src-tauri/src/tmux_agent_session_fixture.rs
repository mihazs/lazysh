//! Owned real SSH/tmux scripted agent session: a stand-in TUI (`tmux_agent_session_agent.sh`) runs in a real pane and
//! the session is driven only through the guarded inputs the Agent view uses. No provider, account or WebView.
use super::*;
use serde_json::{json, Value};
use std::path::Path;

const AGENT: &str = include_str!("tmux_agent_session_agent.sh");

fn lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}
/// The pane process has written `count` log lines; waits for them, then returns them all.
async fn log_until(path: &Path, count: usize) -> Vec<String> {
    timeout(BOUND, async {
        while lines(path).len() < count {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("agent log reached {count} lines: {:?}", lines(path)));
    lines(path)
}
/// What the stand-in agent writes for a prompt: backslash, quote, newline and tab escaped, as in its transcript.
fn escaped(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

struct Driver<'a> {
    app: &'a tauri::App<tauri::test::MockRuntime>,
    lease: &'a AccessLease,
    session: &'a str,
    source: &'a Value,
    receipt: Value,
    next: u64,
}
impl Driver<'_> {
    /// One guarded input, exactly as the Agent view sends it; the reply carries the next operation number.
    async fn input(&mut self, input: Value) -> Value {
        let reply = chat_fixture_call(
            self.app,
            self.lease,
            self.session,
            json!({"kind":"input","receipt":self.receipt,"source":self.source,"operation":self.next,"input":input}),
        )
        .await
        .unwrap();
        assert_eq!(reply["kind"], "delivered");
        assert_eq!(reply["nextOperation"], self.next + 1);
        self.next += 1;
        reply
    }
}

#[tokio::test]
#[ignore = "requires owned OpenSSH and tmux 3.4+; scripted agent session acceptance"]
async fn real_tmux_agent_session_runs_from_the_guarded_agent_view_inputs_only() {
    timeout(Duration::from_secs(60), session())
        .await
        .expect("bounded scripted agent session");
}

async fn session() {
    // The host runs the real companion: on the remote PATH for the client's commands and as the hook the agent calls.
    let host = tempfile::tempdir().unwrap();
    let companion = std::env::var_os("LAZYSH_TEST_AGENT_BIN")
        .map(std::path::PathBuf::from)
        .expect("build lazysh-agent from this checkout and pass it as LAZYSH_TEST_AGENT_BIN");
    fs::create_dir(host.path().join("bin")).unwrap();
    std::os::unix::fs::symlink(&companion, host.path().join("bin/lazysh-agent")).unwrap();
    let state_directory = host.path().join("state");
    let f = Fixture::with_environment(
        None,
        false,
        false,
        vec![
            ("PATH", host.path().join("bin").display().to_string()),
            ("LAZYSH_STATE_DIR", state_directory.display().to_string()),
        ],
    )
    .await;
    let servers = NamedServers {
        fixture: &f,
        names: vec!["chat-a".into()],
    };
    let script = f.dir.path().join("fixture-agent.sh");
    let transcript = f.dir.path().join("session.jsonl");
    let log = f.dir.path().join("agent.log");
    fs::write(&script, AGENT).unwrap();
    assert_eq!(
        servers.direct(
            "chat-a",
            &[
                "new-session",
                "-d",
                "-s",
                "recorded",
                "-P",
                "-F",
                "#{pane_id}",
                &format!(
                    "exec bash {} {} {} {} {}",
                    quote(script.to_str().unwrap()),
                    quote(transcript.to_str().unwrap()),
                    quote(log.to_str().unwrap()),
                    quote(companion.to_str().unwrap()),
                    quote(state_directory.to_str().unwrap())
                )
            ]
        ),
        "%0"
    );
    assert_eq!(log_until(&log, 1).await, ["READY"]);

    let (state, app, _access, lease) = chat_fixture_app(f.dir.path().join("session-config"));
    let parent = f.neutral(&state, &lease).await;
    let child = chat_fixture_attach(&app, &lease, &parent.session_id, "recorded").await;
    let source = json!({"agent":"claude","path":transcript.to_str().unwrap(),"view":"conversation","inlineImages":false});
    let bound = chat_fixture_bind(&app, &lease, &child, &source).await;
    let mut agent = Driver {
        app: &app,
        lease: &lease,
        session: &child,
        source: &source,
        receipt: bound["receipt"].clone(),
        next: 1,
    };

    let mut expected = vec!["READY".to_owned()];
    // Each step waits for exactly the lines it causes, so a missing or doubled delivery fails at that step.
    macro_rules! step {
        ($input:expr, $($line:expr),+) => {{
            let reply = agent.input($input).await;
            expected.extend([$($line.to_owned()),+]);
            assert_eq!(log_until(&log, expected.len()).await, expected);
            reply
        }};
    }
    // Send a prompt.
    step!(
        json!({"kind":"send","text":"hello agent"}),
        "SUBMIT hello agent"
    );
    // The agent asks a question; the answer is the digit of the chosen option.
    step!(
        json!({"kind":"send","text":"ask which layout"}),
        "SUBMIT ask which layout",
        "ASKING"
    );
    step!(json!({"kind":"select","option":2,"of":2}), "ANSWER 2");
    // One Shift+Tab moves the permission mode, and the reply names the mode the pane showed afterwards.
    let moved = step!(json!({"kind":"cycle_mode"}), "MODE accept edits on");
    assert_eq!(moved["mode"], "acceptEdits");
    // The agent asks to run a command: its permission hook blocks, the request is listed over the same SSH session with
    // the pane that asked, a decision that names another pane is refused, and the exact one lets the agent go on, once.
    step!(
        json!({"kind":"send","text":"permission please"}),
        "SUBMIT permission please",
        "PERMISSION_ASKED"
    );
    let request = timeout(BOUND, async {
        loop {
            let listed =
                crate::approvals::agent_approvals(app.state(), child.clone(), lease.clone())
                    .await
                    .unwrap()
                    .into_inner()
                    .unwrap();
            if let Some(request) = listed["requests"].as_array().and_then(|rows| rows.first()) {
                return request.clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the waiting permission hook is listed for the client");
    assert_eq!(request["paneId"], "%0");
    assert_eq!(request["toolName"], "Bash");
    assert_eq!(
        request["toolInput"],
        json!({"command":"git push --force-with-lease"})
    );
    let decide = |pane: &str, decision: &str| {
        crate::approvals::resolve_agent_approval(
            app.state(),
            child.clone(),
            request["id"].as_str().unwrap().into(),
            request["expectedHash"].as_str().unwrap().into(),
            request["sessionId"].as_str().unwrap().into(),
            Some(pane.into()),
            decision.into(),
            None,
            None,
            lease.clone(),
        )
    };
    assert!(decide("%7", "allow").await.is_err());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        lines(&log),
        expected,
        "a decision for another pane reaches the agent nowhere"
    );
    assert_eq!(
        decide("%0", "allow").await.unwrap().into_inner().unwrap(),
        json!({"schemaVersion":1,"accepted":true})
    );
    expected.push("PERMISSION allow".into());
    assert_eq!(log_until(&log, expected.len()).await, expected);
    assert!(
        decide("%0", "deny").await.is_err(),
        "a decided request cannot be decided again"
    );
    // A background command starts, and the agent records its end by itself a moment later.
    step!(
        json!({"kind":"send","text":"background wait"}),
        "SUBMIT background wait",
        "BACKGROUND"
    );
    assert_eq!(
        background_state(&transcript).await.as_deref(),
        Some("running")
    );
    expected.push("BACKGROUND_ENDED".into());
    assert_eq!(log_until(&log, expected.len()).await, expected);
    assert_eq!(background_state(&transcript).await.as_deref(), Some("done"));
    // A background sub-agent: the companion ties the call to the sub-agent's own file, which opens as a conversation of its
    // own, and the sub-agent's meta file ends the work by itself a moment later.
    step!(
        json!({"kind":"send","text":"subagent please"}),
        "SUBMIT subagent please",
        "SUBAGENT"
    );
    let running = work(&transcript, "agent").await;
    assert_eq!(running["state"], "running");
    let child_file = running["childPath"]
        .as_str()
        .expect("the sub-agent's own file is listed");
    assert!(child_file.ends_with("/subagents/agent-sub1.jsonl"));
    assert_eq!(
        message_texts(&conversation(Path::new(child_file)).await),
        ["Explore the layout", "Found two folders."]
    );
    expected.push("SUBAGENT_ENDED".into());
    assert_eq!(log_until(&log, expected.len()).await, expected);
    assert_eq!(work(&transcript, "agent").await["state"], "done");
    // A dynamic workflow: its progress file and journal give the tree, and the completed file ends it.
    step!(
        json!({"kind":"send","text":"workflow please"}),
        "SUBMIT workflow please",
        "WORKFLOW"
    );
    let running = work(&transcript, "workflow").await;
    assert_eq!(running["title"], "review-flow");
    assert_eq!(running["state"], "running");
    assert_eq!(running["workflow"]["agents"][0]["label"], "Planner");
    assert_eq!(running["workflow"]["agents"][0]["state"], "running");
    expected.push("WORKFLOW_ENDED".into());
    assert_eq!(log_until(&log, expected.len()).await, expected);
    let done = work(&transcript, "workflow").await;
    assert_eq!(done["state"], "done");
    assert_eq!(done["workflow"]["agents"][0]["state"], "done");
    assert_eq!(done["workflow"]["totals"]["tokens"], 2400);
    // A prompt over the single-command bound is pasted whole and submitted once.
    let long = format!("first line\n{}", "y".repeat(5000));
    step!(
        json!({"kind":"send_long","text":long}),
        format!("SUBMIT {}", escaped(&long))
    );
    // Stop reaches the agent once.
    step!(json!({"kind":"request_stop"}), "INTERRUPT");
    // A retry of an input the view already sent is refused and reaches the pane nowhere.
    let replay = chat_fixture_call(
        &app,
        &lease,
        &child,
        json!({"kind":"input","receipt":agent.receipt,"source":source,"operation":1,"input":{"kind":"send","text":"hello agent"}}),
    )
    .await;
    assert!(replay.is_err());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(lines(&log), expected);
    assert_eq!(
        servers.direct("chat-a", &["list-panes", "-a", "-F", "#{pane_id}"]),
        "%0"
    );

    // The records the agent wrote read back as the conversation the Agent view shows.
    let page = conversation(&transcript).await;
    let blocks: Vec<&Value> = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["blocks"].as_array().unwrap())
        .collect();
    let texts: Vec<&str> = blocks.iter().filter_map(|b| b["text"].as_str()).collect();
    for text in [
        "hello agent",
        "Answered: hello agent",
        "Chose Nested.",
        "Ran the command.",
        "Interrupted by the user.",
    ] {
        assert_eq!(
            texts.iter().filter(|seen| **seen == text).count(),
            1,
            "{text}"
        );
    }
    assert!(blocks.iter().any(|b| b["card"]["kind"] == "question"));
}

/// The conversation page the host companion serves for the transcript, as the Agent view reads it over SSH.
async fn conversation(transcript: &Path) -> Value {
    let binary = std::env::var_os("LAZYSH_TEST_AGENT_BIN")
        .expect("build lazysh-agent from this checkout and pass it as LAZYSH_TEST_AGENT_BIN");
    let output = tokio::process::Command::new(binary)
        .args([
            "transcript",
            "--agent",
            "claude",
            "--view",
            "conversation",
            "--path",
        ])
        .arg(transcript)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}
/// The work the companion lists for the conversation.
async fn work_list(transcript: &Path) -> Vec<Value> {
    conversation(transcript).await["work"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
/// The one listed work item of a kind (`agent`, `shell`, `workflow`).
async fn work(transcript: &Path, kind: &str) -> Value {
    let items: Vec<Value> = work_list(transcript)
        .await
        .into_iter()
        .filter(|item| item["kind"] == kind)
        .collect();
    assert_eq!(items.len(), 1, "one {kind} work item: {items:?}");
    items[0].clone()
}
/// The state of the one background command of the conversation, if the companion lists it.
async fn background_state(transcript: &Path) -> Option<String> {
    work_list(transcript)
        .await
        .into_iter()
        .find(|item| item["kind"] == "shell")?["state"]
        .as_str()
        .map(str::to_owned)
}
/// The text blocks of a conversation page, in order.
fn message_texts(page: &Value) -> Vec<String> {
    page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["blocks"].as_array().unwrap())
        .filter_map(|block| block["text"].as_str().map(str::to_owned))
        .collect()
}
