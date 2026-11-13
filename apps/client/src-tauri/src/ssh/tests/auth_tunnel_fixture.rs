//! Sign-in tunnels (#1511) over real SSH sessions. The first group runs against the in-process SSH
//! test server, which accepts `direct-tcpip` channels and echoes what they carry, so it proves the
//! consent, caps, lifecycle and cleanup of whole flows. The second group (ignored, needs OpenSSH)
//! opens real `direct-tcpip` channels to a fake OAuth callback server on the host's loopback.
use super::owned_sshd::{free_port, OwnedSshd};
use super::*;
use crate::auth_tunnel::testing::{
    callback_request, event_log, event_where, exchange, status, Behaviour, CallbackServer,
    CALLBACK, CODE, STATE,
};
use crate::auth_tunnel::{begin, AuthTunnel, AuthTunnelState, Config, Consent, Hint, Limits};
use crate::previews::PreviewState;
use serde_json::json;
use std::net::IpAddr;
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;
type Log = Arc<StdMutex<Vec<serde_json::Value>>>;
const LOOPBACK: IpAddr = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);

fn hint(port: u16) -> Hint {
    serde_json::from_value(json!({"port": port, "path": CALLBACK, "evidence": "launcher"})).unwrap()
}
fn allow() -> Consent {
    serde_json::from_value(json!({"kind": "allow"})).unwrap()
}
fn policy(name: &str) -> Consent {
    serde_json::from_value(json!({"kind": "policy", "policy": name})).unwrap()
}
fn ended(reason: &str) -> impl Fn(&serde_json::Value) -> bool + '_ {
    move |event| event["type"] == "ended" && event["reason"] == reason
}
async fn closed(port: u16) {
    timeout(Duration::from_secs(5), async {
        while tokio::net::TcpStream::connect((LOOPBACK, port))
            .await
            .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the listener on {port} must close"));
}

/// An app with the tunnel and preview state, as the real one manages them.
fn app_with(state: AppState) -> App {
    let app = tauri::test::mock_app();
    app.manage(state);
    app.manage(AuthTunnelState::default());
    app.manage(PreviewState::default());
    app
}
async fn start(
    app: &App,
    session: &str,
    hint: Hint,
    consent: Consent,
    config: Config,
) -> (Result<AuthTunnel>, Log) {
    let (events, log) = event_log();
    let tunnel = begin(
        &access_lease(),
        &app.state(),
        &app.state(),
        &app.state(),
        session.into(),
        hint,
        consent,
        events,
        config,
    )
    .await;
    (tunnel, log)
}
/// The error of a start that must be refused, with the short bounds.
async fn refused(fixture: &Fixture, hint: Hint) -> SshError {
    start(&fixture.app, &fixture.session, hint, allow(), quick())
        .await
        .0
        .unwrap_err()
}
fn quick() -> Config {
    Config {
        limits: Limits::quick(),
        device_port: None,
    }
}

/// A password session on the in-process server, and the app around it.
struct Fixture {
    app: App,
    host: Host,
    session: String,
    _directory: tempfile::TempDir,
    _server: TestServer,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new() -> Self {
        let (host, _server, task) = server(false).await;
        let (directory, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let session = password_terminal(&state, &host, Channel::new(|_| Ok(())))
            .await
            .session_id;
        Self {
            app: app_with(state),
            host,
            session,
            _directory: directory,
            _server,
            task,
        }
    }
    async fn another_session(&self) -> String {
        let state = self.app.state::<AppState>();
        password_terminal(&state, &self.host, Channel::new(|_| Ok(())))
            .await
            .session_id
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn a_flow_listens_on_the_announced_port_and_forwards_one_request_through_the_session() {
    let fixture = Fixture::new().await;
    let port = free_port();
    let (tunnel, log) = start(&fixture.app, &fixture.session, hint(port), allow(), quick()).await;
    let tunnel = tunnel.unwrap();
    assert_eq!(
        tunnel.port, port,
        "the redirect URI is never rewritten, so the device port is the host's"
    );
    // The test server echoes what the channel carries: the host would have received exactly this.
    let request = callback_request(
        port,
        &format!("{CALLBACK}?code={CODE}&state={STATE}"),
        "Connection: keep-alive\r\nSec-Fetch-Mode: navigate\r\n",
    );
    let mut families = vec![LOOPBACK];
    if tunnel.addresses.contains(&"[::1]") {
        families.push(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST));
    }
    for family in families {
        let echoed = String::from_utf8(
            timeout(Duration::from_secs(5), async {
                let mut stream = tokio::net::TcpStream::connect((family, port))
                    .await
                    .unwrap();
                stream.write_all(&request).await.unwrap();
                let mut seen = Vec::new();
                let mut chunk = [0; 1024];
                while !seen.ends_with(b"\r\n\r\n") {
                    let count = stream.read(&mut chunk).await.unwrap();
                    assert_ne!(count, 0, "{}", String::from_utf8_lossy(&seen));
                    seen.extend_from_slice(&chunk[..count]);
                }
                seen
            })
            .await
            .unwrap(),
        )
        .unwrap();
        assert!(
            echoed.starts_with(&format!(
                "GET {CALLBACK}?code={CODE}&state={STATE} HTTP/1.1\r\n"
            )),
            "{echoed}"
        );
        assert!(
            echoed.contains("Connection: close\r\n") && !echoed.contains("keep-alive"),
            "{echoed}"
        );
    }
    event_where(&log, |event| event["type"] == "callback").await;
    event_where(&log, ended("callbackDelivered")).await;
    closed(port).await;
}

#[tokio::test]
async fn nothing_listens_until_the_policy_or_the_user_says_yes() {
    let fixture = Fixture::new().await;
    let port = free_port();
    for (consent, kind) in [
        (policy("never"), "auth_tunnel_denied"),
        (policy("ask"), "auth_tunnel_consent_required"),
        (policy("always"), "allowed"),
    ] {
        let (tunnel, _) = start(&fixture.app, &fixture.session, hint(port), consent, quick()).await;
        match tunnel {
            Ok(tunnel) => {
                assert_eq!(kind, "allowed");
                tunnel_stop(&fixture.app, &fixture.session, &tunnel.id).await;
            }
            Err(error) => {
                assert_eq!(error.kind(), kind);
                assert!(
                    tokio::net::TcpStream::connect((LOOPBACK, port))
                        .await
                        .is_err(),
                    "{kind}: no listener was left behind"
                );
            }
        }
    }
    // A bare listener, a database port and the host's own SSH port are never a sign-in.
    let listener: Hint =
        serde_json::from_value(json!({"port": port, "evidence": "listener", "confirmed": true}))
            .unwrap();
    assert_eq!(
        refused(&fixture, listener).await.kind(),
        "auth_tunnel_no_url"
    );
    assert_eq!(
        start(
            &fixture.app,
            &fixture.session,
            hint(fixture.host.port),
            allow(),
            quick()
        )
        .await
        .0
        .unwrap_err()
        .kind(),
        "auth_tunnel_ssh_port"
    );
    assert_eq!(
        refused(&fixture, hint(6379)).await.kind(),
        "auth_tunnel_risky_port"
    );
    let no_path: Hint =
        serde_json::from_value(json!({"port": port, "path": "/a?code=1", "evidence": "launcher"}))
            .unwrap();
    assert_eq!(refused(&fixture, no_path).await.kind(), "invalid_path");
}

async fn tunnel_stop(app: &App, session: &str, id: &str) {
    crate::auth_tunnel::stop_auth_tunnel(app.state(), session.into(), id.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn a_session_may_hold_four_flows_and_the_app_eight() {
    let fixture = Fixture::new().await;
    let sessions = [
        fixture.session.clone(),
        fixture.another_session().await,
        fixture.another_session().await,
    ];
    let mut ports = Vec::new();
    for (index, session) in sessions.iter().enumerate().take(2) {
        for _ in 0..4 {
            let port = free_port();
            start(
                &fixture.app,
                session,
                hint(port),
                allow(),
                Config::default(),
            )
            .await
            .0
            .unwrap();
            ports.push(port);
        }
        let over = start(
            &fixture.app,
            session,
            hint(free_port()),
            allow(),
            Config::default(),
        )
        .await
        .0
        .unwrap_err();
        assert_eq!(over.kind(), "auth_tunnel_limit", "session {index}");
    }
    let app_wide = start(
        &fixture.app,
        &sessions[2],
        hint(free_port()),
        allow(),
        Config::default(),
    )
    .await
    .0
    .unwrap_err();
    assert_eq!(
        app_wide.kind(),
        "auth_tunnel_limit",
        "eight flows in the app"
    );
    // Freeing one makes room again, and a session sees only its own flows.
    let listed = crate::auth_tunnel::list_auth_tunnels(
        access_lease(),
        fixture.app.state(),
        fixture.app.state(),
        sessions[0].clone(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    assert_eq!(listed.len(), 4);
    tunnel_stop(&fixture.app, &sessions[0], &listed[0].id).await;
    start(
        &fixture.app,
        &sessions[2],
        hint(free_port()),
        allow(),
        Config::default(),
    )
    .await
    .0
    .unwrap();
}

#[tokio::test]
async fn a_port_the_device_cannot_give_fails_closed_and_says_who_holds_it() {
    let fixture = Fixture::new().await;
    let other_program = std::net::TcpListener::bind((LOOPBACK, 0)).unwrap();
    let port = other_program.local_addr().unwrap().port();
    let error = refused(&fixture, hint(port)).await;
    assert_eq!(error.kind(), "auth_tunnel_port_busy");
    assert!(
        error.message().contains("Another program"),
        "{}",
        error.message()
    );
    drop(other_program);

    // A program on the IPv6 loopback would receive the code of a browser that resolves localhost to ::1.
    if let Ok(squatter) = std::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, 0)) {
        let port = squatter.local_addr().unwrap().port();
        let error = refused(&fixture, hint(port)).await;
        assert_eq!(error.kind(), "auth_tunnel_port_busy");
        assert!(
            std::net::TcpListener::bind((LOOPBACK, port)).is_ok(),
            "the IPv4 listener was not left behind"
        );
    }

    let held = free_port();
    let first = start(&fixture.app, &fixture.session, hint(held), allow(), quick())
        .await
        .0
        .unwrap();
    let error = refused(&fixture, hint(held)).await;
    assert!(
        error.message().contains("Another sign-in tunnel"),
        "{}",
        error.message()
    );
    tunnel_stop(&fixture.app, &fixture.session, &first.id).await;

    let preview = crate::previews::start_preview(
        access_lease(),
        fixture.app.state(),
        fixture.app.state(),
        fixture.session.clone(),
        free_port(),
        None,
        None,
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    let preview_port = serde_json::to_value(preview).unwrap()["localPort"]
        .as_u64()
        .unwrap() as u16;
    let error = start(
        &fixture.app,
        &fixture.session,
        hint(preview_port),
        allow(),
        quick(),
    )
    .await
    .0
    .unwrap_err();
    assert!(
        error.message().contains("A preview holds"),
        "{}",
        error.message()
    );
    // The three refusals held nothing: the first port is free for a new flow.
    start(&fixture.app, &fixture.session, hint(held), allow(), quick())
        .await
        .0
        .unwrap();
}

#[tokio::test]
async fn the_seventh_flow_for_a_host_in_ten_minutes_asks_even_when_the_policy_is_always() {
    let fixture = Fixture::new().await;
    for _ in 0..6 {
        let (tunnel, _) = start(
            &fixture.app,
            &fixture.session,
            hint(free_port()),
            policy("always"),
            quick(),
        )
        .await;
        tunnel_stop(&fixture.app, &fixture.session, &tunnel.unwrap().id).await;
    }
    let (seventh, _) = start(
        &fixture.app,
        &fixture.session,
        hint(free_port()),
        policy("always"),
        quick(),
    )
    .await;
    assert_eq!(seventh.unwrap_err().kind(), "auth_tunnel_consent_required");
    let (answered, _) = start(
        &fixture.app,
        &fixture.session,
        hint(free_port()),
        allow(),
        quick(),
    )
    .await;
    answered.unwrap();
}

#[tokio::test]
async fn ending_the_session_ends_its_flows_with_the_hold_that_keeps_the_app_alive() {
    let (host, _server, task) = server(false).await;
    let (directory, mut state) = fixture_state();
    state.config().unwrap().hosts.push(host.clone());
    // Android's foreground service and wake lock follow this hold, one per session, for as long as the session lives.
    let (holds, mut hold_changes) = mpsc::unbounded_channel();
    state.background = crate::session_background::Controller::start(move |_, sessions| {
        holds.send(sessions > 0).unwrap();
        async { Ok(()) }
    });
    let session = password_terminal(&state, &host, Channel::new(|_| Ok(())))
        .await
        .session_id;
    let app = app_with(state);
    assert_eq!(
        timeout(Duration::from_secs(2), hold_changes.recv())
            .await
            .unwrap(),
        Some(true)
    );
    let port = free_port();
    let (tunnel, log) = start(&app, &session, hint(port), allow(), Config::default()).await;
    tunnel.unwrap();
    assert!(
        timeout(Duration::from_millis(300), hold_changes.recv())
            .await
            .is_err(),
        "a flow neither adds nor drops the hold"
    );
    assert!(tokio::net::TcpStream::connect((LOOPBACK, port))
        .await
        .is_ok());

    disconnect(app.state(), session).await.unwrap();
    event_where(&log, ended("sessionEnded")).await;
    closed(port).await;
    assert_eq!(
        timeout(Duration::from_secs(2), hold_changes.recv())
            .await
            .unwrap(),
        Some(false),
        "the hold ends with the session"
    );
    assert!(app.state::<AuthTunnelState>().is_empty().await);
    task.abort();
    drop(directory);
}

#[tokio::test]
async fn locking_the_app_ends_every_flow_and_stopping_one_is_still_allowed() {
    let fixture = Fixture::new().await;
    let access = unlocked_access();
    let lease = ready_lease(&access);
    let port = free_port();
    let (events, log) = event_log();
    begin(
        &lease,
        &fixture.app.state(),
        &fixture.app.state(),
        &fixture.app.state(),
        fixture.session.clone(),
        hint(port),
        allow(),
        events,
        Config::default(),
    )
    .await
    .unwrap();
    access.lock().unwrap();
    event_where(&log, ended("lockEnded")).await;
    closed(port).await;

    // The explicit hook the lock path calls reaches flows whose lease is not the one that locked.
    let port = free_port();
    let (tunnel, log) = start(
        &fixture.app,
        &fixture.session,
        hint(port),
        allow(),
        Config::default(),
    )
    .await;
    tunnel.unwrap();
    fixture
        .app
        .state::<AuthTunnelState>()
        .cancel_for_lock()
        .await;
    event_where(&log, ended("lockEnded")).await;
    closed(port).await;
    assert!(crate::app_lock::allowed_while_locked("stop_auth_tunnel"));
    assert!(!crate::app_lock::allowed_while_locked("start_auth_tunnel"));
}

#[tokio::test]
async fn stopping_a_flow_waits_for_its_listener_to_close_and_belongs_to_its_session() {
    let fixture = Fixture::new().await;
    let other = fixture.another_session().await;
    let port = free_port();
    let (tunnel, log) = start(
        &fixture.app,
        &fixture.session,
        hint(port),
        allow(),
        Config::default(),
    )
    .await;
    let tunnel = tunnel.unwrap();
    tunnel_stop(&fixture.app, &other, &tunnel.id).await;
    assert!(
        tokio::net::TcpStream::connect((LOOPBACK, port))
            .await
            .is_ok(),
        "another session cannot stop it"
    );
    tunnel_stop(&fixture.app, &fixture.session, &tunnel.id).await;
    assert!(
        tokio::net::TcpStream::connect((LOOPBACK, port))
            .await
            .is_err(),
        "the listener is closed when stop returns"
    );
    event_where(&log, ended("cancelled")).await;
}

#[tokio::test]
async fn a_session_that_is_gone_cannot_start_a_flow() {
    let fixture = Fixture::new().await;
    let error = start(
        &fixture.app,
        "not-a-session",
        hint(free_port()),
        allow(),
        quick(),
    )
    .await
    .0
    .unwrap_err();
    assert_eq!(error.kind(), "disconnected");
}

/// An owned, unprivileged OpenSSH server and one session on it.
struct Owned {
    app: App,
    session: String,
    sshd: OwnedSshd,
    _directory: tempfile::TempDir,
}
impl Owned {
    async fn new(settings: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let (key, user_key) = (ed25519_key(), ed25519_key());
        let authorized = directory.path().join("authorized_keys");
        fs::write(&authorized, user_key.public_key().to_openssh().unwrap()).unwrap();
        let port = free_port();
        let settings = format!("AuthorizedKeysFile {}\n{settings}", authorized.display());
        let sshd = OwnedSshd::start(directory.path(), port, &key, &settings, &[]).await;
        let state = AppState::new(directory.path().join("config")).unwrap();
        let host = test_support::owned_host("openssh", "OpenSSH fixture", port, &key);
        state.config().unwrap().hosts.push(host.clone());
        let session = start_session(
            &state,
            host.id,
            None,
            Some(user_key.to_openssh(Default::default()).unwrap().to_string()),
            None,
            80,
            24,
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap()
        .session_id;
        Self {
            app: app_with(state),
            session,
            sshd,
            _directory: directory,
        }
    }
    /// Starts a flow whose host port is `host_port`; the device port differs because both share this machine.
    async fn flow(&self, host_port: u16, extra: serde_json::Value) -> (AuthTunnel, Log) {
        let mut value = json!({"port": host_port, "path": CALLBACK, "evidence": "launcher"});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let config = Config {
            limits: Limits::quick(),
            device_port: Some(free_port()),
        };
        let (tunnel, log) = start(
            &self.app,
            &self.session,
            serde_json::from_value(value).unwrap(),
            allow(),
            config,
        )
        .await;
        (tunnel.unwrap(), log)
    }
}

#[tokio::test]
#[ignore = "requires an owned OpenSSH sshd; run with test:openssh-auth-tunnel"]
async fn openssh_auth_tunnel_delivers_callbacks_to_host_servers_bound_every_way() {
    let owned = Owned::new("").await;
    let hosts: [(IpAddr, serde_json::Value); 3] = [
        (LOOPBACK, json!({})),
        // `aws sso login` and `az login` bind every interface.
        (IpAddr::from([0, 0, 0, 0]), json!({})),
        (
            IpAddr::from([0, 0, 0, 0, 0, 0, 0, 1]),
            json!({"family": "v6"}),
        ),
    ];
    for (bind, extra) in hosts {
        let server = CallbackServer::on(bind, Behaviour::Answer(300_000)).await;
        let (tunnel, log) = owned.flow(server.port, extra).await;
        let get = callback_request(
            tunnel.port,
            &format!("{CALLBACK}?code={CODE}&state={STATE}"),
            "Sec-Fetch-Mode: navigate\r\n",
        );
        let response = exchange(LOOPBACK, tunnel.port, &get).await;
        let head = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap()
            + 4;
        assert_eq!(status(&response), "HTTP/1.1 200 OK", "{bind}");
        assert_eq!(
            response.len() - head,
            300_000,
            "{bind}: a page larger than one TCP segment arrives whole"
        );
        assert!(
            server.requests()[0].starts_with(&format!(
                "GET {CALLBACK}?code={CODE}&state={STATE} HTTP/1.1\r\n"
            )),
            "{bind}"
        );
        event_where(&log, ended("callbackDelivered")).await;
        closed(tunnel.port).await;
    }

    // `az login` posts the result with response_mode=form_post.
    let server = CallbackServer::start(Behaviour::Answer(20)).await;
    let (tunnel, _) = owned.flow(server.port, json!({})).await;
    let body = format!("code={CODE}&state={STATE}&id_token={}", "t".repeat(9000));
    let post = format!("POST {CALLBACK} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{body}", tunnel.port, body.len());
    assert_eq!(
        status(&exchange(LOOPBACK, tunnel.port, post.as_bytes()).await),
        "HTTP/1.1 200 OK"
    );
    assert!(
        server.requests()[0].ends_with(&format!("\r\n\r\n{body}")),
        "the form body arrives byte for byte"
    );
}

#[tokio::test]
#[ignore = "requires an owned OpenSSH sshd; run with test:openssh-auth-tunnel"]
async fn openssh_auth_tunnel_never_lets_another_protocol_or_page_reach_a_host_service() {
    let owned = Owned::new("").await;
    // The host runs something that is not a sign-in: an SSH-like banner server.
    let service = CallbackServer::start(Behaviour::Banner).await;
    let (tunnel, log) = owned.flow(service.port, json!({})).await;
    let port = tunnel.port;
    for (name, bytes, expected) in [
        (
            "an SSH client",
            b"SSH-2.0-OpenSSH_9.9\r\n\r\n".to_vec(),
            "HTTP/1.1 400 Bad Request",
        ),
        (
            "another Host",
            format!("GET {CALLBACK} HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n").into_bytes(),
            "HTTP/1.1 421 Misdirected Request",
        ),
        (
            "another path",
            callback_request(port, "/admin", ""),
            "HTTP/1.1 404 Not Found",
        ),
        (
            "a cross-origin fetch",
            callback_request(port, CALLBACK, "Sec-Fetch-Mode: cors\r\n"),
            "HTTP/1.1 403 Forbidden",
        ),
        (
            "a websocket",
            callback_request(
                port,
                CALLBACK,
                "Connection: Upgrade\r\nUpgrade: websocket\r\n",
            ),
            "HTTP/1.1 400 Bad Request",
        ),
        (
            "an oversized head",
            format!(
                "GET {CALLBACK} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX: {}\r\n\r\n",
                "a".repeat(20_000)
            )
            .into_bytes(),
            "HTTP/1.1 431 Request Header Fields Too Large",
        ),
    ] {
        assert_eq!(
            status(&exchange(LOOPBACK, port, &bytes).await),
            expected,
            "{name}"
        );
    }
    // A client that sends nothing, as an SSH client waiting for the server's banner does, gets nothing and holds no host connection.
    let mut silent = tokio::net::TcpStream::connect((LOOPBACK, port))
        .await
        .unwrap();
    let mut answer = Vec::new();
    timeout(Duration::from_secs(5), silent.read_to_end(&mut answer))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status(&answer), "HTTP/1.1 408 Request Timeout");
    assert_eq!(
        service.accepted.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "no refused connection opened a host channel"
    );
    assert!(log.lock().unwrap().is_empty());
}

#[tokio::test]
#[ignore = "requires an owned OpenSSH sshd; run with test:openssh-auth-tunnel"]
async fn openssh_auth_tunnel_ends_when_the_host_stops_listening_or_forbids_forwarding() {
    let owned = Owned::new("").await;
    // Nothing listens on the host's port: the SSH server answers "connect failed" to each channel.
    let (tunnel, log) = owned.flow(free_port(), json!({})).await;
    for _ in 0..2 {
        let response = exchange(
            LOOPBACK,
            tunnel.port,
            &callback_request(tunnel.port, &format!("{CALLBACK}?code=1"), ""),
        )
        .await;
        assert_eq!(status(&response), "HTTP/1.1 502 Bad Gateway");
    }
    event_where(&log, ended("hostStoppedListening")).await;
    closed(tunnel.port).await;

    let forbidding = Owned::new("AllowTcpForwarding no\n").await;
    let (tunnel, log) = forbidding.flow(free_port(), json!({})).await;
    let response = exchange(
        LOOPBACK,
        tunnel.port,
        &callback_request(tunnel.port, &format!("{CALLBACK}?code=1"), ""),
    )
    .await;
    assert_eq!(status(&response), "HTTP/1.1 502 Bad Gateway");
    event_where(&log, ended("forwardingDisabled")).await;
}

#[tokio::test]
#[ignore = "requires an owned OpenSSH sshd; run with test:openssh-auth-tunnel"]
async fn openssh_auth_tunnel_hundred_flows_leave_no_listener_and_no_channel() {
    let owned = Owned::new("").await;
    let server = CallbackServer::start(Behaviour::Answer(100)).await;
    for _ in 0..100 {
        let (tunnel, log) = owned.flow(server.port, json!({})).await;
        assert_eq!(
            status(
                &exchange(
                    LOOPBACK,
                    tunnel.port,
                    &callback_request(tunnel.port, &format!("{CALLBACK}?code=1"), "")
                )
                .await
            ),
            "HTTP/1.1 200 OK"
        );
        tunnel_stop(&owned.app, &owned.session, &tunnel.id).await;
        event_where(&log, ended("cancelled")).await;
        closed(tunnel.port).await;
    }
    timeout(Duration::from_secs(10), async {
        while server.open.load(std::sync::atomic::Ordering::SeqCst) != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("every direct-tcpip channel closed on the host side");
    assert_eq!(
        server.accepted.load(std::sync::atomic::Ordering::SeqCst),
        100
    );
    assert!(owned.app.state::<AuthTunnelState>().is_empty().await);
    assert!(!owned.sshd.log().contains("error"), "{}", owned.sshd.log());
}

/// The Mosh case of the OpenSSH interoperability check: a flow rides the retained SSH control
/// connection, follows it when it is restored, and reports it when it is gone.
pub(super) async fn verify_mosh(app: &App, mosh_id: &str, stage: MoshStage) {
    app.manage(AuthTunnelState::default());
    app.manage(PreviewState::default());
    let server = CallbackServer::start(Behaviour::Answer(50)).await;
    let config = Config {
        limits: Limits::quick(),
        device_port: Some(free_port()),
    };
    let (tunnel, log) = start(
        app,
        mosh_id,
        serde_json::from_value(
            json!({"port": server.port, "path": CALLBACK, "evidence": "launcher"}),
        )
        .unwrap(),
        allow(),
        config,
    )
    .await;
    let tunnel = tunnel.unwrap();
    let response = exchange(
        LOOPBACK,
        tunnel.port,
        &callback_request(tunnel.port, &format!("{CALLBACK}?code=1"), ""),
    )
    .await;
    match stage {
        MoshStage::Live | MoshStage::Restored => {
            assert_eq!(status(&response), "HTTP/1.1 200 OK");
            assert_eq!(server.requests().len(), 1);
            event_where(&log, ended("callbackDelivered")).await;
        }
        MoshStage::Closed => {
            assert_eq!(status(&response), "HTTP/1.1 502 Bad Gateway");
            event_where(&log, ended("controlConnectionLost")).await;
            assert!(server.requests().is_empty());
        }
    }
}
pub(super) enum MoshStage {
    Live,
    Closed,
    Restored,
}
