//! The flow engine against real loopback sockets, with a fake OAuth callback server standing in for
//! the host's CLI. The same engine over a real OpenSSH `direct-tcpip` channel is in
//! `ssh/tests/auth_tunnel_fixture.rs`.
use super::policy::Policy;
use super::testing::{
    callback_request, exchange, status, Behaviour, CallbackServer, CALLBACK, CODE, STATE,
};
use super::*;
use serde_json::json;
use std::{
    pin::Pin,
    sync::{atomic::Ordering, Mutex as StdMutex},
};
use tokio::task::JoinHandle;

type Connecting =
    Pin<Box<dyn Future<Output = std::result::Result<TcpStream, ConnectError>> + Send>>;

/// A connector that reaches `port` on the host's IPv4 loopback and refuses IPv6, as an IPv4-only host does.
fn direct(port: u16) -> impl Fn(HostAddress) -> Connecting + Send + Sync + 'static {
    move |address| {
        Box::pin(async move {
            match address {
                HostAddress::V4 => TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                    .await
                    .map_err(|_| ConnectError::Refused),
                HostAddress::V6 => Err(ConnectError::Refused),
            }
        })
    }
}

/// One running flow on a free device port.
struct Tunnel {
    port: u16,
    stop: watch::Sender<Option<EndReason>>,
    session: watch::Sender<bool>,
    events: Arc<StdMutex<Vec<TunnelEvent>>>,
    result: JoinHandle<EndReason>,
}
impl Tunnel {
    async fn to(host: &CallbackServer, limits: Limits) -> Self {
        Self::with(
            direct(host.port),
            vec![HostAddress::V4, HostAddress::V6],
            limits,
        )
        .await
    }
    async fn with(
        connect: impl Fn(HostAddress) -> Connecting + Send + Sync + 'static,
        hosts: Vec<HostAddress>,
        limits: Limits,
    ) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, stopped) = watch::channel(None);
        let (session, session_ended) = watch::channel(false);
        let events = Arc::new(StdMutex::new(Vec::new()));
        let seen = events.clone();
        let result = tokio::spawn(run(Flow {
            listeners: vec![listener],
            rule: guard::Rule {
                port,
                path: CALLBACK.into(),
            },
            hosts,
            limits,
            connect,
            session_ended,
            stop: stopped,
            events: move |event| seen.lock().unwrap().push(event),
        }));
        Self {
            port,
            stop,
            session,
            events,
            result,
        }
    }
    async fn ended(self) -> EndReason {
        timeout(Duration::from_secs(10), self.result)
            .await
            .expect("the flow must end")
            .unwrap()
    }
    /// For flows on a paused clock, where a deadline is virtual time and the wait cannot hang.
    async fn ended_eventually(self) -> EndReason {
        self.result.await.unwrap()
    }
    fn get(&self, target: &str, extra: &str) -> Vec<u8> {
        callback_request(self.port, target, extra)
    }
    async fn send(&self, bytes: &[u8]) -> Vec<u8> {
        exchange(Ipv4Addr::LOCALHOST.into(), self.port, bytes).await
    }
}

/// The port can be bound again, which only a flow that dropped its listener allows. Other tests
/// bind ephemeral ports at the same moment, so a port taken meanwhile gets a moment to come back.
async fn released(port: u16) {
    timeout(Duration::from_secs(2), async {
        while TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .is_err()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the flow must release its port");
}

#[tokio::test]
async fn a_callback_reaches_the_host_unchanged_and_the_page_comes_back() {
    let host = CallbackServer::start(Behaviour::Answer(300_000)).await;
    let tunnel = Tunnel::to(&host, Limits::quick()).await;
    let request = tunnel.get(
        &format!("{CALLBACK}?code={CODE}&state={STATE}"),
        "Connection: keep-alive\r\nCookie: session=abc\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Site: cross-site\r\n",
    );
    let response = tunnel.send(&request).await;
    let head_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap()
        + 4;
    assert_eq!(status(&response), "HTTP/1.1 200 OK");
    assert_eq!(
        &response[head_end..],
        vec![b'x'; 300_000].as_slice(),
        "a page larger than one TCP segment arrives whole"
    );
    let seen = host.requests();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].starts_with(&format!(
        "GET {CALLBACK}?code={CODE}&state={STATE} HTTP/1.1\r\n"
    )));
    assert!(
        seen[0].contains(&format!("Host: localhost:{}\r\n", tunnel.port)),
        "the Host the browser used is kept"
    );
    assert!(seen[0].contains("Cookie: session=abc\r\n"));
    assert!(
        seen[0].contains("Connection: close\r\n") && !seen[0].contains("keep-alive"),
        "{}",
        seen[0]
    );
    let events = tunnel.events.clone();
    assert_eq!(tunnel.ended().await, EndReason::CallbackDelivered);
    assert_eq!(*events.lock().unwrap(), [TunnelEvent::Callback]);
}

#[tokio::test]
async fn a_form_post_callback_delivers_its_body_exactly() {
    let host = CallbackServer::start(Behaviour::Answer(10)).await;
    let tunnel = Tunnel::to(&host, Limits::quick()).await;
    let body = format!("code={CODE}&state={STATE}&id_token={}", "t".repeat(3000));
    let head = format!(
        "POST {CALLBACK} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nOrigin: https://login.example\r\n\r\n",
        tunnel.port,
        body.len()
    );
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, tunnel.port))
        .await
        .unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    stream.write_all(body.as_bytes()).await.unwrap();
    // A browser that stops sending after its request still gets the answer.
    stream.shutdown().await.unwrap();
    let mut response = Vec::new();
    timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status(&response), "HTTP/1.1 200 OK");
    let seen = host.requests();
    assert!(
        seen[0].ends_with(&format!("\r\n\r\n{body}")),
        "the body arrives byte for byte"
    );
    assert!(seen[0].contains("Origin: https://login.example\r\n"));
    assert_eq!(tunnel.ended().await, EndReason::CallbackDelivered);
}

#[tokio::test]
async fn the_second_loopback_family_is_tried_when_the_first_refuses() {
    let host = CallbackServer::start(Behaviour::Answer(1)).await;
    let port = host.port;
    let connect = move |address: HostAddress| -> Connecting {
        Box::pin(async move {
            match address {
                HostAddress::V4 => Err(ConnectError::Refused),
                HostAddress::V6 => TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                    .await
                    .map_err(|_| ConnectError::Refused),
            }
        })
    };
    let tunnel = Tunnel::with(
        connect,
        vec![HostAddress::V4, HostAddress::V6],
        Limits::quick(),
    )
    .await;
    assert_eq!(
        status(
            &tunnel
                .send(&tunnel.get(&format!("{CALLBACK}?code=1"), ""))
                .await
        ),
        "HTTP/1.1 200 OK"
    );
    assert_eq!(host.requests().len(), 1);
}

/// Each case is a request another app or a web page could send to the tunnel port. None may reach the host.
#[tokio::test]
async fn the_guard_answers_everything_but_a_callback_navigation_without_reaching_the_host() {
    let host = CallbackServer::start(Behaviour::Banner).await;
    let tunnel = Tunnel::to(&host, Limits::quick()).await;
    let port = tunnel.port;
    let raw = |request: String| request.into_bytes();
    let line = |method: &str, target: &str, extra: &str| {
        raw(format!(
            "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}\r\n"
        ))
    };
    let post_body = |length: &str| line("POST", CALLBACK, &format!("Content-Length: {length}\r\n"));
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("another Host", raw(format!("GET {CALLBACK} HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n")), "421"),
        ("another port in Host", raw(format!("GET {CALLBACK} HTTP/1.1\r\nHost: localhost:{}\r\n\r\n", port.wrapping_add(1))), "421"),
        ("no Host", raw(format!("GET {CALLBACK} HTTP/1.1\r\n\r\n")), "400"),
        ("two Hosts", raw(format!("GET {CALLBACK} HTTP/1.1\r\nHost: localhost:{port}\r\nHost: 127.0.0.1:{port}\r\n\r\n")), "400"),
        ("another path", line("GET", "/admin", ""), "404"),
        ("a path outside the callback", line("GET", "/oauth/callbackx", ""), "404"),
        ("a dot segment", line("GET", "/oauth/callback/../admin", ""), "404"),
        ("an escaped dot segment", line("GET", "/oauth/callback/%2e%2e/admin", ""), "404"),
        ("an escaped slash", line("GET", "/oauth/callback%2f..", ""), "404"),
        ("a network-path reference", line("GET", "//evil.example/oauth/callback", ""), "400"),
        ("an absolute URL", line("GET", &format!("http://127.0.0.1:{port}{CALLBACK}"), ""), "400"),
        ("a fragment", line("GET", "/oauth/callback#x", ""), "400"),
        ("a cross-origin fetch", line("GET", CALLBACK, "Sec-Fetch-Mode: cors\r\n"), "403"),
        ("a no-cors fetch", line("GET", CALLBACK, "Sec-Fetch-Mode: no-cors\r\n"), "403"),
        ("a websocket", line("GET", CALLBACK, "Connection: Upgrade\r\nUpgrade: websocket\r\n"), "400"),
        ("an h2c upgrade", line("GET", CALLBACK, "Connection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABk\r\n"), "400"),
        ("a chunked body", line("POST", CALLBACK, "Transfer-Encoding: chunked\r\n"), "400"),
        ("an Expect", line("POST", CALLBACK, "Content-Length: 1\r\nExpect: 100-continue\r\n"), "400"),
        ("two lengths", line("POST", CALLBACK, "Content-Length: 1\r\nContent-Length: 2\r\n"), "400"),
        ("a signed length", post_body("+5"), "400"),
        ("a GET with a body", line("GET", CALLBACK, "Content-Length: 4\r\n\r\nabcd"), "400"),
        ("a body over the cap", post_body("70000"), "413"),
        ("PUT", line("PUT", CALLBACK, ""), "405"),
        ("DELETE", line("DELETE", CALLBACK, ""), "405"),
        ("OPTIONS", line("OPTIONS", CALLBACK, ""), "405"),
        ("CONNECT", raw("CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: 127.0.0.1:22\r\n\r\n".into()), "405"),
        ("an SSH banner", b"SSH-2.0-OpenSSH_9.9\r\n\r\n".to_vec(), "400"),
        ("a TLS hello", b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03\r\n\r\n".to_vec(), "400"),
        ("an HTTP/2 preface", b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".to_vec(), "400"),
        ("a Redis command", b"*1\r\n$4\r\nPING\r\n\r\n".to_vec(), "400"),
        ("an oversized head", raw(format!("GET {CALLBACK} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Pad: {}\r\n\r\n", "a".repeat(20 * 1024))), "431"),
        ("too many fields", raw(format!("GET {CALLBACK} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{}\r\n", "X-A: b\r\n".repeat(80))), "431"),
        ("a head that never ends", raw(format!("GET {CALLBACK} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Slow: 1\r\n")), "408"),
    ];
    for (name, request, expected) in cases {
        let response = tunnel.send(&request).await;
        assert!(
            status(&response).starts_with(&format!("HTTP/1.1 {expected}")),
            "{name}: {}",
            String::from_utf8_lossy(&response)
        );
    }
    assert_eq!(
        host.accepted.load(Ordering::SeqCst),
        0,
        "no refused request opened a connection to the host"
    );
    assert!(tunnel.events.lock().unwrap().is_empty());
    tunnel.stop.send_replace(Some(EndReason::Cancelled));
    assert_eq!(tunnel.ended().await, EndReason::Cancelled);
}

#[tokio::test]
async fn a_pipelined_second_request_never_reaches_the_host() {
    let host = CallbackServer::start(Behaviour::Answer(5)).await;
    let tunnel = Tunnel::to(&host, Limits::quick()).await;
    let mut two = tunnel.get(&format!("{CALLBACK}?code=1"), "");
    two.extend(tunnel.get("/oauth/callback/second", ""));
    let response = tunnel.send(&two).await;
    assert_eq!(
        String::from_utf8_lossy(&response)
            .matches("HTTP/1.1 200")
            .count(),
        1
    );
    assert_eq!(host.requests().len(), 1);
    assert!(!host.requests()[0].contains("second"));
}

#[tokio::test]
async fn the_host_response_is_capped() {
    let host = CallbackServer::start(Behaviour::Answer(3 * 1024 * 1024)).await;
    let tunnel = Tunnel::to(&host, Limits::quick()).await;
    let response = tunnel
        .send(&tunnel.get(&format!("{CALLBACK}?code=1"), ""))
        .await;
    assert_eq!(response.len(), 1024 * 1024);
}

#[tokio::test]
async fn at_most_eight_connections_are_served_at_once() {
    let host = CallbackServer::start(Behaviour::Hold).await;
    let tunnel = Tunnel::to(&host, Limits::quick()).await;
    let mut clients = Vec::new();
    for _ in 0..8 {
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, tunnel.port))
            .await
            .unwrap();
        client
            .write_all(&tunnel.get(&format!("{CALLBACK}?code=1"), ""))
            .await
            .unwrap();
        clients.push(client);
    }
    timeout(Duration::from_secs(5), async {
        while host.accepted.load(Ordering::SeqCst) < 8 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let ninth = tunnel
        .send(&tunnel.get(&format!("{CALLBACK}?code=1"), ""))
        .await;
    assert!(
        ninth.is_empty(),
        "the ninth connection is closed unanswered"
    );
    assert_eq!(host.accepted.load(Ordering::SeqCst), 8);
}

#[tokio::test]
async fn the_flow_ends_for_each_reason_and_releases_its_port() {
    let host = CallbackServer::start(Behaviour::Answer(1)).await;
    for (name, expected) in [
        ("cancel", EndReason::Cancelled),
        ("session", EndReason::SessionEnded),
    ] {
        let tunnel = Tunnel::to(&host, Limits::quick()).await;
        let port = tunnel.port;
        match name {
            "cancel" => drop(tunnel.stop.send_replace(Some(EndReason::Cancelled))),
            _ => drop(tunnel.session.send_replace(true)),
        }
        assert_eq!(tunnel.ended().await, expected, "{name}");
        released(port).await;
    }
}

#[tokio::test]
async fn a_host_that_stopped_listening_ends_the_flow_after_two_refusals() {
    let tunnel = Tunnel::with(
        |_| Box::pin(async { Err(ConnectError::Refused) }),
        vec![HostAddress::V4, HostAddress::V6],
        Limits::quick(),
    )
    .await;
    for _ in 0..2 {
        assert_eq!(
            status(
                &tunnel
                    .send(&tunnel.get(&format!("{CALLBACK}?code=1"), ""))
                    .await
            ),
            "HTTP/1.1 502 Bad Gateway"
        );
    }
    assert!(
        tunnel.events.lock().unwrap().is_empty(),
        "nothing was delivered"
    );
    assert_eq!(tunnel.ended().await, EndReason::HostStoppedListening);
}

#[tokio::test]
async fn forwarding_that_the_server_forbids_and_a_lost_connection_end_the_flow_at_once() {
    for (error, expected) in [
        (ConnectError::Prohibited, EndReason::ForwardingDisabled),
        (ConnectError::Lost, EndReason::ControlConnectionLost),
    ] {
        let tunnel = Tunnel::with(
            move |_| Box::pin(async move { Err(error) }),
            vec![HostAddress::V4],
            Limits::quick(),
        )
        .await;
        assert_eq!(
            status(
                &tunnel
                    .send(&tunnel.get(&format!("{CALLBACK}?code=1"), ""))
                    .await
            ),
            "HTTP/1.1 502 Bad Gateway"
        );
        assert_eq!(tunnel.ended().await, expected);
    }
}

#[tokio::test]
async fn an_unrelated_failure_never_counts_as_a_stopped_host() {
    let tunnel = Tunnel::with(
        |_| Box::pin(async { Err(ConnectError::Other) }),
        vec![HostAddress::V4],
        Limits::quick(),
    )
    .await;
    for _ in 0..3 {
        assert_eq!(
            status(
                &tunnel
                    .send(&tunnel.get(&format!("{CALLBACK}?code=1"), ""))
                    .await
            ),
            "HTTP/1.1 502 Bad Gateway"
        );
    }
    assert!(!tunnel.result.is_finished());
    tunnel.stop.send_replace(Some(EndReason::Cancelled));
    assert_eq!(tunnel.ended().await, EndReason::Cancelled);
}

#[tokio::test(start_paused = true)]
async fn the_flow_closes_fifteen_seconds_after_the_callback() {
    let host = CallbackServer::start(Behaviour::Answer(1)).await;
    let tunnel = Tunnel::to(&host, Limits::default()).await;
    assert_eq!(
        status(
            &tunnel
                .send(&tunnel.get(&format!("{CALLBACK}?code=1"), ""))
                .await
        ),
        "HTTP/1.1 200 OK"
    );
    let delivered = Instant::now();
    assert_eq!(
        tunnel.ended_eventually().await,
        EndReason::CallbackDelivered
    );
    assert_eq!(delivered.elapsed(), Duration::from_secs(15));
}

#[tokio::test(start_paused = true)]
async fn the_flow_closes_after_ten_minutes_without_a_callback() {
    let host = CallbackServer::start(Behaviour::Answer(1)).await;
    let started = Instant::now();
    let tunnel = Tunnel::to(&host, Limits::default()).await;
    assert_eq!(tunnel.ended_eventually().await, EndReason::Timeout);
    assert_eq!(started.elapsed(), Duration::from_secs(600));
}

#[tokio::test]
async fn a_hundred_flows_leave_no_listener_and_no_connection() {
    let host = CallbackServer::start(Behaviour::Answer(1)).await;
    for _ in 0..100 {
        let tunnel = Tunnel::to(&host, Limits::quick()).await;
        let port = tunnel.port;
        assert_eq!(
            status(
                &tunnel
                    .send(&tunnel.get(&format!("{CALLBACK}?code=1"), ""))
                    .await
            ),
            "HTTP/1.1 200 OK"
        );
        tunnel.stop.send_replace(Some(EndReason::Cancelled));
        assert_eq!(tunnel.ended().await, EndReason::Cancelled);
        released(port).await;
    }
    timeout(Duration::from_secs(5), async {
        while host.open.load(Ordering::SeqCst) != 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("every host connection closed");
    assert_eq!(host.accepted.load(Ordering::SeqCst), 100);
}

#[tokio::test]
async fn the_authorization_code_and_state_never_appear_in_what_the_flow_reports() {
    let host = CallbackServer::start(Behaviour::Answer(1)).await;
    let tunnel = Tunnel::to(&host, Limits::quick()).await;
    let mut seen = Vec::new();
    // A refused request that carries the secrets is not echoed back.
    seen.push(
        tunnel
            .send(&tunnel.get(&format!("/other?code={CODE}&state={STATE}"), ""))
            .await,
    );
    seen.push(
        tunnel
            .send(&tunnel.get(
                &format!("{CALLBACK}?code={CODE}&state={STATE}"),
                "Sec-Fetch-Mode: cors\r\n",
            ))
            .await,
    );
    let events = tunnel.events.clone();
    let delivered = tunnel
        .send(&tunnel.get(&format!("{CALLBACK}?code={CODE}&state={STATE}"), ""))
        .await;
    assert_eq!(status(&delivered), "HTTP/1.1 200 OK");
    let reason = tunnel.ended().await;
    let mut reported = seen
        .iter()
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .collect::<Vec<_>>();
    reported.push(serde_json::to_string(&*events.lock().unwrap()).unwrap());
    reported.push(serde_json::to_string(&TunnelEvent::Ended { reason }).unwrap());
    for text in reported {
        assert!(!text.contains(CODE) && !text.contains(STATE), "{text}");
    }
}

#[tokio::test]
async fn a_browser_may_leave_the_port_out_of_host_only_on_port_80() {
    let admit = |port: u16, host: &str| {
        let request = format!("GET {CALLBACK}?code=1 HTTP/1.1\r\nHost: {host}\r\n\r\n");
        async move {
            let rule = guard::Rule {
                port,
                path: CALLBACK.into(),
            };
            let deadline = Instant::now() + Duration::from_secs(1);
            guard::admit(&mut request.as_bytes(), &rule, deadline)
                .await
                .is_ok()
        }
    };
    assert!(admit(80, "localhost").await && admit(80, "127.0.0.1").await);
    assert!(!admit(8085, "localhost").await && !admit(80, "evil.example").await);
    assert!(admit(8085, "localhost:8085").await && admit(80, "[::1]:80").await);
}

mod consent {
    use super::super::policy::admit;
    use super::*;

    fn hint(value: serde_json::Value) -> Hint {
        serde_json::from_value(value).unwrap()
    }
    fn kind(hint: &Hint, consent: Consent, ssh_port: Option<u16>, recent: usize) -> &'static str {
        admit(hint, consent, ssh_port, recent)
            .err()
            .map_or("allowed", |error| error.kind())
    }
    const ALWAYS: Consent = Consent::Policy {
        policy: Policy::Always,
    };
    const ALLOW: Consent = Consent::Allow {
        confirm_risky: false,
    };

    #[test]
    fn the_saved_policy_of_a_host_decides_without_asking() {
        let confirmed = hint(
            json!({"port": 8085, "evidence": "url", "confirmed": true, "owner": "sessionUser"}),
        );
        assert_eq!(kind(&confirmed, ALWAYS, None, 0), "allowed");
        assert_eq!(
            kind(
                &confirmed,
                Consent::Policy {
                    policy: Policy::Never
                },
                None,
                0
            ),
            "auth_tunnel_denied"
        );
        assert_eq!(
            kind(
                &confirmed,
                Consent::Policy {
                    policy: Policy::Ask
                },
                None,
                0
            ),
            "auth_tunnel_consent_required"
        );
        assert_eq!(kind(&confirmed, ALLOW, None, 0), "allowed");
    }

    #[test]
    fn always_never_applies_to_what_needs_a_person() {
        let launcher = hint(json!({"port": 8085, "evidence": "launcher"}));
        assert_eq!(
            kind(&launcher, ALWAYS, None, 0),
            "allowed",
            "a launcher request is evidence enough"
        );
        for (name, value) in [
            (
                "an unconfirmed URL",
                json!({"port": 8085, "evidence": "url"}),
            ),
            (
                "a root-owned listener",
                json!({"port": 8085, "evidence": "url", "confirmed": true, "owner": "otherUser"}),
            ),
            (
                "a privileged port",
                json!({"port": 1023, "evidence": "url", "confirmed": true}),
            ),
            (
                "a database port",
                json!({"port": 5432, "evidence": "url", "confirmed": true}),
            ),
        ] {
            assert_eq!(
                kind(&hint(value), ALWAYS, None, 0),
                "auth_tunnel_consent_required",
                "{name}"
            );
        }
        let confirmed = hint(json!({"port": 8085, "evidence": "url", "confirmed": true}));
        assert_eq!(kind(&confirmed, ALWAYS, None, 5), "allowed");
        assert_eq!(
            kind(&confirmed, ALWAYS, None, 6),
            "auth_tunnel_consent_required",
            "a seventh flow in the window asks"
        );
        assert_eq!(
            kind(&confirmed, ALLOW, None, 6),
            "allowed",
            "and a person can still say yes"
        );
    }

    #[test]
    fn privileged_and_service_ports_need_their_own_confirmation() {
        for port in [80, 443, 5432, 6379, 2375] {
            let risky = hint(json!({"port": port, "evidence": "url", "confirmed": true}));
            assert_eq!(
                kind(&risky, ALLOW, None, 0),
                "auth_tunnel_risky_port",
                "{port}"
            );
            assert_eq!(
                kind(
                    &risky,
                    Consent::Allow {
                        confirm_risky: true
                    },
                    None,
                    0
                ),
                "allowed",
                "{port}"
            );
        }
        let named = admit(
            &hint(json!({"port": 5432, "evidence": "url"})),
            ALLOW,
            None,
            0,
        )
        .unwrap_err();
        assert!(
            named.message().contains("PostgreSQL"),
            "{}",
            named.message()
        );
    }

    #[test]
    fn the_ssh_port_a_bare_listener_and_port_zero_are_never_tunnelled() {
        let confirm = Consent::Allow {
            confirm_risky: true,
        };
        let ssh = hint(json!({"port": 2222, "evidence": "url", "confirmed": true}));
        assert_eq!(kind(&ssh, confirm, Some(2222), 0), "auth_tunnel_ssh_port");
        assert_eq!(kind(&ssh, ALWAYS, Some(2222), 0), "auth_tunnel_ssh_port");
        let listener = hint(json!({"port": 3000, "evidence": "listener", "confirmed": true}));
        assert_eq!(kind(&listener, confirm, None, 0), "auth_tunnel_no_url");
        assert_eq!(
            kind(
                &hint(json!({"port": 0, "evidence": "url"})),
                confirm,
                None,
                0
            ),
            "invalid_port"
        );
    }

    #[test]
    fn a_hint_has_no_place_for_a_query_code_or_state() {
        for field in ["query", "url", "code", "state", "redirectUri"] {
            let mut value = json!({"port": 8085, "evidence": "url"});
            value[field] = json!("code=abc");
            assert!(serde_json::from_value::<Hint>(value).is_err(), "{field}");
        }
        let consent: Consent =
            serde_json::from_value(json!({"kind": "allow", "confirmRisky": true})).unwrap();
        assert_eq!(
            consent,
            Consent::Allow {
                confirm_risky: true
            }
        );
        let consent: Consent =
            serde_json::from_value(json!({"kind": "policy", "policy": "always"})).unwrap();
        assert_eq!(consent, ALWAYS);
    }
}
