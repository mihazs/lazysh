//! Lost-connection reporting (#1067). A terminal whose transport disappears without a
//! remote exit is closed with `lost`, which lets the renderer reconnect; a remote
//! `exit` and a local close are not. The OpenSSH case stops and restarts an owned
//! sshd to prove the retry boundary and that a fresh connection reattaches the
//! surviving tmux pane.
use super::owned_sshd::terminal_output_until;
use super::*;
use tokio::io::AsyncWriteExt;

type Events = mpsc::UnboundedReceiver<serde_json::Value>;

/// Skips output, still acknowledging it, and returns the terminal's Closed event.
async fn closed_event(state: &AppState, id: &str, rx: &mut Events) -> serde_json::Value {
    let session = state.session(id).await.ok();
    timeout(Duration::from_secs(15), async {
        loop {
            let event = rx
                .recv()
                .await
                .expect("terminal events ended without Closed");
            if event["type"] == "closed" {
                return event;
            }
            if let (Some(session), Some(data)) = (&session, event["data"].as_array()) {
                let _ = acknowledge(session, data.len() as u32);
            }
        }
    })
    .await
    .expect("terminal Closed event deadline")
}

async fn type_into(state: &AppState, id: &str, text: &str) {
    let data = crate::terminal_input::InputSequence::parse(text.into(), None).unwrap();
    let session = state.session(id).await.unwrap();
    session
        .input
        .try_send(Input::Data(data, access_lease()))
        .unwrap();
}

/// How a relayed route fails: `Cut` drops both sockets without an SSH disconnect; `Stall`
/// stops forwarding but keeps them open, like a route that vanished during a Wi-Fi to
/// cellular switch: no EOF, no reset, no reply.
enum RouteFailure {
    Cut,
    Stall,
}

/// A password terminal relayed through loopback, whose route fails on demand.
struct RelayedTerminal {
    _directory: tempfile::TempDir,
    _server: TestServer,
    task: tokio::task::JoinHandle<()>,
    state: AppState,
    id: String,
    rx: Events,
    fail: Option<tokio::sync::oneshot::Sender<RouteFailure>>,
}
impl RelayedTerminal {
    async fn start() -> Self {
        let (mut host, _server, task) = server(false).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = host.port;
        host.port = listener.local_addr().unwrap().port();
        let (fail, failing) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut client, _) = listener.accept().await.unwrap();
            let mut server = tokio::net::TcpStream::connect(("127.0.0.1", target))
                .await
                .unwrap();
            let failure = tokio::select! {
                _ = tokio::io::copy_bidirectional(&mut client, &mut server) => return,
                failure = failing => failure,
            };
            if let Ok(RouteFailure::Stall) = failure {
                std::future::pending::<()>().await;
            }
            let _ = client.shutdown().await;
        });
        let (_directory, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let (events, rx) = json_events();
        let id = password_terminal(&state, &host, events).await.session_id;
        Self {
            _directory,
            _server,
            task,
            state,
            id,
            rx,
            fail: Some(fail),
        }
    }
    fn fail(&mut self, failure: RouteFailure) {
        let _ = self.fail.take().unwrap().send(failure);
    }
    async fn closed(&mut self) -> serde_json::Value {
        let closed = closed_event(&self.state, &self.id, &mut self.rx).await;
        self.task.abort();
        closed
    }
}

#[tokio::test]
async fn dropped_transport_closes_the_terminal_as_lost() {
    let mut terminal = RelayedTerminal::start().await;
    terminal.fail(RouteFailure::Cut);
    let closed = terminal.closed().await;
    assert_eq!(closed["lost"], true, "{closed}");
}

#[tokio::test]
async fn network_change_probe_closes_a_silent_route_as_lost() {
    let mut terminal = RelayedTerminal::start().await;
    let ids = vec![terminal.id.clone()];
    // A route that still answers survives the probe.
    probe_connections_inner(&terminal.state, &ids, Duration::from_secs(5)).await;
    assert!(terminal.state.session(&terminal.id).await.is_ok());

    terminal.fail(RouteFailure::Stall);
    let started = tokio::time::Instant::now();
    probe_connections_inner(&terminal.state, &ids, Duration::from_millis(500)).await;
    let closed = terminal.closed().await;
    assert_eq!(closed["lost"], true, "{closed}");
    // Well before three 15 s keepalives could have given up on the silent route.
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(10), "{elapsed:?}");
}

#[tokio::test]
async fn local_close_is_not_reported_as_lost() {
    let mut fixture = json_terminal_fixture().await;
    let session = fixture
        .state
        .session(&fixture.connected.session_id)
        .await
        .unwrap();
    session
        .adopted
        .store(true, std::sync::atomic::Ordering::SeqCst);
    disconnect_inner(&fixture.state, fixture.connected.session_id.clone())
        .await
        .unwrap();
    let closed = closed_event(&fixture.state, "", &mut fixture.rx).await;
    assert!(closed.get("lost").is_none(), "{closed}");
    fixture.task.abort();
}

/// sshd started as the current account with a private HOME and tmux socket directory.
struct Remote {
    directory: tempfile::TempDir,
    host_key: russh::keys::PrivateKey,
    user_key: russh::keys::PrivateKey,
    settings: String,
    port: u16,
}
impl Remote {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let user_key = ed25519_key();
        let authorized = root.join("authorized_keys");
        fs::write(&authorized, user_key.public_key().to_openssh().unwrap()).unwrap();
        fs::create_dir(root.join("tmux")).unwrap();
        // A private HOME must not trigger zsh's interactive first-user setup.
        fs::write(root.join(".zshrc"), b"").unwrap();
        let settings = format!(
            "AuthorizedKeysFile {}\nSetEnv PATH=/usr/bin:/bin HOME={root} ZDOTDIR={root} BASH_ENV=/dev/null ENV=/dev/null TMUX_TMPDIR={root}/tmux\n",
            authorized.display(),
            root = root.display(),
        );
        Self {
            directory,
            host_key: ed25519_key(),
            user_key,
            settings,
            port: owned_sshd::free_port(),
        }
    }
    async fn start(&self) -> owned_sshd::OwnedSshd {
        owned_sshd::OwnedSshd::start(
            self.directory.path(),
            self.port,
            &self.host_key,
            &self.settings,
            &[],
        )
        .await
    }
    fn host(&self) -> Host {
        Host {
            default_multiplexer: None,
            default_multiplexer_next: None,
            transport: None,
            mosh: None,
            et: None,
            id: "lost".into(),
            name: "Lost connection fixture".into(),
            hostname: "127.0.0.1".into(),
            port: self.port,
            username: std::env::var("USER").unwrap(),
            fingerprint: Some(
                self.host_key
                    .public_key()
                    .fingerprint(HashAlg::Sha256)
                    .to_string(),
            ),
            jump_host_id: None,
            credentials_stored: false,
            client_environment: false,
            biometric_unlock: false,
            forward_agent: false,
        }
    }
    async fn connect(&self, state: &AppState, events: Channel<SshEvent>) -> Result<Connected> {
        start_session(
            state,
            "lost".into(),
            None,
            Some(
                self.user_key
                    .to_openssh(Default::default())
                    .unwrap()
                    .to_string(),
            ),
            None,
            80,
            24,
            events,
        )
        .await
    }
}

async fn remote(state: &AppState, id: &str, command: &str) -> String {
    let session = state.session(id).await.unwrap();
    exec(&session, &access_lease(), command.into())
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires OpenSSH sshd and tmux; run with test:connection-loss"]
async fn openssh_lost_connection_retries_until_sshd_returns_and_reattaches_tmux() {
    timeout(Duration::from_secs(120), async {
        let remote_host = Remote::new();
        let sshd = remote_host.start().await;
        let config = tempfile::tempdir().unwrap();
        let state = AppState::new(config.path().into()).unwrap();
        state.config().unwrap().hosts.push(remote_host.host());

        // A remote exit ends the session for good; it must not invite a reconnect.
        let (events, mut rx) = json_events();
        let exiting = remote_host
            .connect(&state, events)
            .await
            .unwrap()
            .session_id;
        type_into(&state, &exiting, "exit\r").await;
        let closed = closed_event(&state, &exiting, &mut rx).await;
        assert!(closed.get("lost").is_none(), "{closed}");

        let (events, mut shell_rx) = json_events();
        let shell = remote_host
            .connect(&state, events)
            .await
            .unwrap()
            .session_id;
        remote(&state, &shell, "tmux new-session -d -s keep -x 80 -y 24").await;
        let pane = remote(
            &state,
            &shell,
            "tmux display-message -p -t keep '#{pane_pid}'",
        )
        .await;
        let (events, mut tmux_rx) = json_events();
        let attached = attach_tmux_inner(
            &state,
            access_lease(),
            shell.clone(),
            None,
            "keep".into(),
            80,
            24,
            events,
        )
        .await
        .unwrap()
        .session_id;
        type_into(&state, &attached, "printf 'BEFORE_%s_LOSS\\n' \"$$\"\r").await;
        let marker = format!("BEFORE_{}_LOSS", pane.trim());
        terminal_output_until(&state, &attached, &mut tmux_rx, &marker).await;

        // Stop sshd and its connection processes: the route is gone, the pane is not.
        sshd.kill_tree();
        for (id, rx) in [(&shell, &mut shell_rx), (&attached, &mut tmux_rx)] {
            let closed = closed_event(&state, id, rx).await;
            assert_eq!(closed["lost"], true, "{closed}");
        }

        // A retry while the server is down fails as a transport error, not a credential one.
        let refused = remote_host
            .connect(&state, Channel::new(|_| Ok(())))
            .await
            .err()
            .unwrap();
        assert_eq!(refused.kind(), "ssh_error", "{refused:?}");

        let _sshd = remote_host.start().await;
        let (events, _rx) = json_events();
        let shell = remote_host
            .connect(&state, events)
            .await
            .unwrap()
            .session_id;
        let (events, mut tmux_rx) = json_events();
        let reattached = attach_tmux_inner(
            &state,
            access_lease(),
            shell.clone(),
            None,
            "keep".into(),
            80,
            24,
            events,
        )
        .await
        .unwrap()
        .session_id;
        // tmux redraws the surviving pane, including output written before the loss.
        terminal_output_until(&state, &reattached, &mut tmux_rx, &marker).await;
        assert_eq!(
            remote(
                &state,
                &shell,
                "tmux display-message -p -t keep '#{pane_pid}'"
            )
            .await,
            pane
        );
        remote(&state, &shell, "tmux kill-server").await;
    })
    .await
    .expect("lost-connection case deadline");
}
