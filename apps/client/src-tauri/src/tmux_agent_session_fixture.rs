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
    let f = Fixture::new().await;
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
                    "exec bash {} {} {}",
                    quote(script.to_str().unwrap()),
                    quote(transcript.to_str().unwrap()),
                    quote(log.to_str().unwrap())
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
/// The state of the one background command of the conversation, if the companion lists it.
async fn background_state(transcript: &Path) -> Option<String> {
    let work = conversation(transcript).await["work"].clone();
    work.as_array()?.first()?["state"]
        .as_str()
        .map(str::to_owned)
}
