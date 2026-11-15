//! Real-rmux acceptance for Jump To and confirmed Chat input (#1675): the product path of the tmux fixtures, on rmux 0.10.x.
use super::*;
use crate::multiplexer::{tmux_action, MultiplexerKind::Rmux, TmuxAction};
use serde_json::json;

/// An owned rmux daemon on one `-L` label, stopped on drop even when an assertion fails.
struct Daemon {
    binary: PathBuf,
    sockets: PathBuf,
    home: PathBuf,
    label: &'static str,
}
impl Daemon {
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(&self.binary);
        command
            .env_remove("TMUX")
            .env_remove("RMUX")
            .env("HOME", &self.home)
            .env("SHELL", "/bin/sh")
            .env("RMUX_TMPDIR", &self.sockets)
            .args(["-u", "-L", self.label])
            .args(args);
        command
    }
    fn run(&self, args: &[&str]) -> String {
        let output = self.command(args).output().unwrap();
        assert!(
            output.status.success(),
            "rmux {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end_matches('\n')
            .to_owned()
    }
    /// The `client_tty|client_control_mode` of every client of this server, sorted.
    fn clients(&self) -> Vec<String> {
        let rows = self
            .command(&[
                "list-clients",
                "-F",
                "#{client_tty}|#{client_session}|#{client_control_mode}",
            ])
            .output()
            .unwrap();
        let mut rows = String::from_utf8(rows.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        rows.sort();
        rows
    }
    fn session(&self, name: &str, command: &str) -> String {
        self.run(&[
            "new-session",
            "-d",
            "-s",
            name,
            "-P",
            "-F",
            "#{session_id}:#{window_id}:#{pane_id}",
            command,
        ])
    }
}
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.command(&["kill-server"]).output();
    }
}

pub(super) struct Lab {
    pub(super) fixture: Fixture,
    pub(super) binary: PathBuf,
    pub(super) sockets: tempfile::TempDir,
    _tools: tempfile::TempDir,
}
impl Lab {
    pub(super) async fn new() -> Self {
        let binary = PathBuf::from(std::env::var("LAZYSH_TEST_RMUX").unwrap());
        assert!(binary.is_absolute());
        let tools = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(&binary, tools.path().join("rmux")).unwrap();
        let sockets = tempfile::tempdir_in("/tmp").unwrap();
        let fixture = Fixture::with_environment(
            None,
            false,
            false,
            vec![
                ("PATH", tools.path().display().to_string()),
                ("RMUX_TMPDIR", sockets.path().display().to_string()),
            ],
        )
        .await;
        // An empty .zshrc keeps zsh's first-run wizard from taking the typed input in the pane.
        fs::write(fixture.dir.path().join(".zshrc"), "").unwrap();
        Self {
            fixture,
            binary,
            sockets,
            _tools: tools,
        }
    }
    fn daemon(&self, label: &'static str) -> Daemon {
        Daemon {
            binary: self.binary.clone(),
            sockets: self.sockets.path().to_owned(),
            home: self.fixture.dir.path().to_owned(),
            label,
        }
    }
}
/// The terminal the product attaches to `name` on `label`, with its Jump To control client.
async fn attach(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    parent: &str,
    label: &str,
    name: &str,
) -> String {
    attach_multiplexer(
        lease.clone(),
        app.state(),
        parent.into(),
        Some(label.into()),
        Rmux,
        name.into(),
        80,
        24,
        Channel::new(|_| Ok(())),
        None,
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap()
    .session_id
}
async fn snapshot(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    id: &str,
) -> Probe<serde_json::Value> {
    crate::tmux_jump::tmux_jump_snapshot(lease.clone(), app.state(), app.state(), id.into())
        .await
        .map_err(|error| format!("{:?}", error.into_inner()))
        .and_then(|reply| reply.into_inner().map_err(|error| format!("{error:?}")))
        .map(|snapshot| serde_json::to_value(snapshot).unwrap())
}
async fn clients_settle(daemon: &Daemon, expected: usize) {
    timeout(BOUND, async {
        while daemon.clients().len() != expected {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "clients never settled at {expected}: {:?}",
            daemon.clients()
        )
    });
}

#[tokio::test]
#[ignore = "requires owned OpenSSH and an absolute LAZYSH_TEST_RMUX binary"]
async fn real_rmux_jump_moves_the_bound_client_detaches_cleanly_and_isolates_labels() {
    timeout(Duration::from_secs(60), jump_probe())
        .await
        .expect("bounded rmux jump fixture");
}
async fn jump_probe() {
    let lab = Lab::new().await;
    // A hostile label proves quoting; both servers hand out the same ids, so one binding must never read the other.
    let (alpha, beta) = (lab.daemon("alpha"), lab.daemon("世界 '$(printf NO);"));
    for daemon in [&alpha, &beta] {
        assert_eq!(daemon.session("same", "sleep 120"), "$0:@0:%0");
    }
    let (_authority, lease) = unlocked_authority();
    let (app, state) = herdr_native_app(&lab.fixture);
    let (source, _events) = herdr_echo_source(&lab.fixture, &state, &lease).await;
    let child = attach(&app, &lease, &source.session_id, "alpha", "same").await;
    // Jump To is bound to the display client: one display client and one control client on alpha, none on beta.
    let first = snapshot(&app, &lease, &child).await.unwrap();
    assert_eq!(first["current"]["sessionId"], "$0");
    assert_eq!(first["sessions"][0]["name"], "same");
    let directory = lab.fixture.dir.path().to_str().unwrap().to_owned();
    for (name, label) in [
        ("destination", None),
        ("beta-only", Some("世界 '$(printf NO);")),
    ] {
        let created = tmux_action(
            app.state(),
            child.clone(),
            TmuxAction::CreateSession {
                name: name.into(),
                directory: directory.clone(),
            },
            label.map(Into::into),
            None,
            lease.clone(),
        )
        .await;
        // The terminal is bound to alpha, so naming the other label is refused and creates nothing.
        assert_eq!(created.is_ok(), label.is_none(), "{name}");
    }
    let moved = snapshot(&app, &lease, &child).await.unwrap();
    let destination = moved["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "destination")
        .unwrap();
    super::jump_to_first_window(&app, &lease, &child, &moved, destination).await;
    // The display client moved; the control client stayed where it attached.
    let rows = alpha.clients();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(
        rows.iter().any(|row| row.ends_with("|destination|0")),
        "{rows:?}"
    );
    assert!(rows.iter().any(|row| row.ends_with("|same|1")), "{rows:?}");
    assert_eq!(
        beta.run(&["list-windows", "-a", "-F", "#{window_id}"]),
        "@0"
    );
    assert_eq!(beta.clients(), Vec::<String>::new());
    // A busy pane streams `%output` into the control stream, including inside command blocks; navigation stays bound.
    let pane = alpha.run(&["display-message", "-p", "-t", "same", "#{pane_id}"]);
    alpha.run(&["respawn-pane", "-k", "-t", &pane, "yes | head -c 200000000"]);
    timeout(BOUND, async {
        while !alpha
            .run(&["capture-pane", "-p", "-t", &pane])
            .contains('y')
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the pane is streaming output");
    for _ in 0..5 {
        assert_eq!(
            snapshot(&app, &lease, &child).await.unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    // Closing the terminal ends control mode cleanly while the SSH connection stays up: no client is left on alpha.
    disconnect(app.state(), child.clone()).await.unwrap();
    clients_settle(&alpha, 0).await;
    assert!(state.session(&source.session_id).await.is_ok());
    // A daemon replaced under the same label reuses every id; the old binding must never follow it.
    let again = attach(&app, &lease, &source.session_id, "alpha", "same").await;
    assert!(snapshot(&app, &lease, &again).await.is_ok());
    alpha.run(&["kill-server"]);
    alpha.session("replacement", "sleep 120");
    assert!(snapshot(&app, &lease, &again).await.is_err());
    // The same label on the other server still answers for its own session.
    let beta_child = attach(
        &app,
        &lease,
        &source.session_id,
        "世界 '$(printf NO);",
        "same",
    )
    .await;
    assert_eq!(
        snapshot(&app, &lease, &beta_child).await.unwrap()["sessions"][0]["name"],
        "same"
    );
    disconnect(app.state(), beta_child).await.unwrap();
    clients_settle(&beta, 0).await;
}

/// A pane that records every byte it receives.
fn recorder(path: &std::path::Path) -> String {
    format!(
        "stty raw -echo; exec cat > {}",
        quote(path.to_str().unwrap())
    )
}
#[tokio::test]
#[ignore = "requires owned OpenSSH and an absolute LAZYSH_TEST_RMUX binary"]
async fn real_rmux_chat_input_reaches_only_the_confirmed_pane_and_is_refused_after_a_daemon_restart(
) {
    timeout(Duration::from_secs(90), chat_probe())
        .await
        .expect("bounded rmux input fixture");
}
async fn chat_probe() {
    let lab = Lab::new().await;
    let daemon = lab.daemon("chat-a");
    let outputs =
        ["selected-input", "other-window-input"].map(|name| lab.fixture.dir.path().join(name));
    assert_eq!(
        daemon.session("recorded", &recorder(&outputs[0])),
        "$0:@0:%0"
    );
    daemon.run(&["new-window", "-d", "-t", "$0", &recorder(&outputs[1])]);
    timeout(BOUND, async {
        while !outputs.iter().all(|path| path.exists()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned raw cat workloads ready");
    let (_authority, lease) = unlocked_authority();
    let (app, state) = herdr_native_app(&lab.fixture);
    let (source, _events) = herdr_echo_source(&lab.fixture, &state, &lease).await;
    let child = attach(&app, &lease, &source.session_id, "chat-a", "recorded").await;
    chat_fixture_adopt(&app, &lease, &child).await;
    let shown = chat_fixture_call(&app, &lease, &child, json!({"kind":"snapshot"}))
        .await
        .unwrap();
    assert_eq!(shown["sessionName"], "recorded");
    assert_eq!(shown["paneIndex"], 0);
    let claude = json!({"agent":"claude","path":"/owned/history","view":"conversation","inlineImages":false});
    let input = |current: &serde_json::Value, operation: u32, input: serde_json::Value| json!({"kind":"input","receipt":current["receipt"],"source":claude,"operation":operation,"input":input});
    let delivered = |next| json!({"kind":"delivered","nextOperation":next});
    let bound = chat_fixture_bind(&app, &lease, &child, &claude).await;
    assert_eq!(bound["destination"]["paneId"], "%0");
    // Keys: one literal prompt with multi-byte text and every shell and format metacharacter, then Escape.
    let text = "hé 世界; '$#{pane_id}\\";
    for (operation, request, next) in [
        (1, json!({"kind":"send","text":text}), 2),
        (2, json!({"kind":"request_stop"}), 3),
    ] {
        let reply = chat_fixture_call(&app, &lease, &child, input(&bound, operation, request))
            .await
            .unwrap();
        assert_eq!(reply, delivered(next));
    }
    let mut expected = format!("{text}\r\u{1b}").into_bytes();
    chat_fixture_bytes(&outputs[0], &expected).await;
    // A prompt with a line break is one bracketed paste: multi-byte text must arrive as typed, not double-encoded.
    let tty = daemon.run(&["display-message", "-p", "-t", "%0", "#{pane_tty}"]);
    std::fs::write(&tty, "\x1b[?2004h").unwrap();
    let pasted = "two é\n世界 line";
    let current = chat_fixture_bind(&app, &lease, &child, &claude).await;
    let reply = chat_fixture_call(
        &app,
        &lease,
        &child,
        input(&current, 1, json!({"kind":"send","text":pasted})),
    )
    .await
    .unwrap();
    assert_eq!(reply, delivered(2));
    expected.extend_from_slice(format!("\x1b[200~{pasted}\x1b[201~\r").as_bytes());
    chat_fixture_bytes(&outputs[0], &expected).await;
    // A long prompt of 3-byte characters is cut on character boundaries over several commands and arrives whole.
    std::fs::write(&tty, "\x1b[?2004l").unwrap();
    let long = "世界 ".repeat(1800);
    assert!(long.len() > 4096 * 2);
    let current = chat_fixture_bind(&app, &lease, &child, &claude).await;
    let reply = chat_fixture_call(
        &app,
        &lease,
        &child,
        input(&current, 1, json!({"kind":"send_long","text":long})),
    )
    .await
    .unwrap();
    assert_eq!(reply, delivered(2));
    expected.extend_from_slice(format!("{long}\r").as_bytes());
    chat_fixture_bytes(&outputs[0], &expected).await;
    assert_eq!(
        daemon.run(&["list-buffers"]),
        "",
        "the private buffer is gone"
    );
    // rmux 0.10 would paste a TAB as the two characters `\t`: refused, and nothing reaches the pane.
    let current = chat_fixture_bind(&app, &lease, &child, &claude).await;
    chat_fixture_rejected(
        &app,
        &lease,
        &child,
        input(&current, 1, json!({"kind":"send","text":"a\tb"})),
        &outputs[0],
        &expected,
    )
    .await;
    // Navigation survives a refused input.
    assert!(snapshot(&app, &lease, &child).await.is_ok());
    // The mode cycle reads the status line back through capture-pane while the pane's output streams into the control stream.
    let current = chat_fixture_bind(&app, &lease, &child, &claude).await;
    std::fs::write(&tty, "\x1b[2J\x1b[Hauto mode on\r\n\r\n  \u{23f5}\u{23f5} accept edits on (shift+tab to cycle)\r\n").unwrap();
    let request = input(&current, 1, json!({"kind":"cycle_mode"}));
    super::chat_fixture_cycled(&app, &lease, &child, request, 2, "acceptEdits").await;
    expected.extend_from_slice(b"\x1b[Z");
    chat_fixture_bytes(&outputs[0], &expected).await;
    // The display client moved to another session after the destination was confirmed: input is refused.
    let current = chat_fixture_bind(&app, &lease, &child, &claude).await;
    daemon.session("elsewhere", "sleep 120");
    let display = daemon
        .clients()
        .into_iter()
        .find(|row| row.ends_with("|recorded|0"))
        .unwrap();
    daemon.run(&[
        "switch-client",
        "-c",
        display.split('|').next().unwrap(),
        "-t",
        "elsewhere",
    ]);
    chat_fixture_rejected(
        &app,
        &lease,
        &child,
        input(&current, 1, json!({"kind":"send","text":"moved away"})),
        &outputs[0],
        &expected,
    )
    .await;
    assert!(
        tokio::fs::read(&outputs[1]).await.unwrap().is_empty(),
        "no other pane received input"
    );
    // A daemon restart under the same label reuses every id: the old receipt and binding are refused.
    let fresh = attach(&app, &lease, &source.session_id, "chat-a", "elsewhere").await;
    chat_fixture_adopt(&app, &lease, &fresh).await;
    let before = chat_fixture_bind(&app, &lease, &fresh, &claude).await;
    daemon.run(&["kill-server"]);
    daemon.session(
        "elsewhere",
        &recorder(&lab.fixture.dir.path().join("restarted-input")),
    );
    assert!(chat_fixture_call(
        &app,
        &lease,
        &fresh,
        input(&before, 1, json!({"kind":"send","text":"after restart"}))
    )
    .await
    .is_err());
    assert!(
        !lab.fixture.dir.path().join("restarted-input").exists()
            || tokio::fs::read(lab.fixture.dir.path().join("restarted-input"))
                .await
                .unwrap()
                .is_empty()
    );
}
