#![cfg(unix)]
#[allow(dead_code)]
#[path = "../../notification-service/tests/support/mod.rs"]
mod tls;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use lazysh_notification_client::client;
use lazysh_notifications::{Config, Service};
use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{Mutex, Semaphore},
};

const ADMIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DESTINATION: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
#[derive(Clone)]
struct Delivery {
    bodies: Arc<Mutex<Vec<Value>>>,
    received: Arc<Semaphore>,
}
async fn destination(
    State(delivery): State<Delivery>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> StatusCode {
    assert_eq!(headers["authorization"], format!("Bearer {DESTINATION}"));
    assert_eq!(
        headers["idempotency-key"],
        body["receiptId"].as_str().unwrap()
    );
    delivery.bodies.lock().await.push(body);
    delivery.received.add_permits(1);
    StatusCode::NO_CONTENT
}
#[derive(Clone)]
struct BoundTap {
    posts: Arc<Mutex<Vec<Value>>>,
    hold_next: Arc<AtomicBool>,
    reject_posts: Arc<AtomicBool>,
    retry_posts: Arc<AtomicBool>,
    committed: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl BoundTap {
    fn new() -> Self {
        Self {
            posts: Arc::default(),
            hold_next: Arc::new(AtomicBool::new(false)),
            reject_posts: Arc::new(AtomicBool::new(false)),
            retry_posts: Arc::new(AtomicBool::new(false)),
            committed: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
    async fn wait_committed(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.committed.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
    async fn intercept(
        &self,
        mut request: axum::extract::Request,
        next: axum::middleware::Next,
    ) -> axum::response::Response {
        let bound = request.uri().path() == "/v1/bound-events"
            && request.method() == axum::http::Method::POST;
        if bound {
            let body = std::mem::take(request.body_mut());
            let bytes = axum::body::to_bytes(body, 4096).await.unwrap();
            self.posts
                .lock()
                .await
                .push(serde_json::from_slice(&bytes).unwrap());
            *request.body_mut() = axum::body::Body::from(bytes);
        }
        if bound && self.reject_posts.load(Ordering::SeqCst) {
            return axum::response::IntoResponse::into_response(StatusCode::NOT_FOUND);
        }
        if bound && self.retry_posts.load(Ordering::SeqCst) {
            return axum::response::IntoResponse::into_response(StatusCode::SERVICE_UNAVAILABLE);
        }
        let response = next.run(request).await;
        if bound && self.hold_next.swap(false, Ordering::SeqCst) {
            self.committed.add_permits(1);
            let _permit = self.release.acquire().await.unwrap();
        }
        response
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    _destination: tls::Server,
    relay: tls::Server,
    state: PathBuf,
    capability: PathBuf,
    ca: PathBuf,
    client: reqwest::Client,
    service: Service,
    delivery: Delivery,
    tap: BoundTap,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let delivery = Delivery {
            bodies: Arc::default(),
            received: Arc::new(Semaphore::new(0)),
        };
        let destination = tls::Server::new(
            Router::new()
                .route("/sink", post(destination))
                .with_state(delivery.clone()),
        )
        .await;
        let destination_ca = root.path().join("destination.pem");
        client::write_private(&destination_ca, destination.pem.as_bytes()).unwrap();
        let service = Service::open_with_test_client(
            Config::new(
                root.path().join("relay"),
                ADMIN,
                &format!("{}/sink", destination.origin),
                DESTINATION,
            )
            .unwrap(),
            client::transport(Some(&destination_ca)).unwrap(),
        )
        .unwrap();
        let tap = BoundTap::new();
        let interception = tap.clone();
        let router = service
            .router()
            .layer(axum::middleware::from_fn(move |request, next| {
                let interception = interception.clone();
                async move { interception.intercept(request, next).await }
            }));
        let relay = tls::Server::new(router).await;
        let ca = root.path().join("relay.pem");
        client::write_private(&ca, relay.pem.as_bytes()).unwrap();
        let client = client::transport(Some(&ca)).unwrap();
        let capability = root.path().join("source envelope");
        client::create_source(&client, &relay.origin, ADMIN, "public-worker", &capability)
            .await
            .unwrap();
        let state = root.path().join("agent");
        Self {
            _root: root,
            _destination: destination,
            relay,
            state,
            capability,
            ca,
            client,
            service,
            delivery,
            tap,
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
        command
            .args(args)
            .env("LAZYSH_STATE_DIR", &self.state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }
    async fn run(&self, args: &[&str], payload: Option<Value>) -> Value {
        let mut child = self.command(args).spawn().unwrap();
        let mut input = child.stdin.take().unwrap();
        if let Some(payload) = payload {
            input
                .write_all(&serde_json::to_vec(&payload).unwrap())
                .await
                .unwrap();
        }
        drop(input);
        let output = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let capability = client::read_capability(&self.capability).unwrap();
        for bytes in [&output.stdout, &output.stderr] {
            let text = String::from_utf8_lossy(bytes);
            assert!(!text.contains(ADMIN));
            assert!(!text.contains(&capability.secret));
        }
        if output.stdout.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&output.stdout).unwrap()
        }
    }
    async fn ingest(&self, state: &str) {
        self.run(&["ingest","--agent","generic"],Some(json!({"schemaVersion":1,"sessionId":"private-session","agent":"private-agent","project":"ssh://private-host/private-path","state":state,"summary":"private-prompt-transcript","paneId":"%private"}))).await;
    }
    async fn remote_enable(&self) {
        client::admin_action(
            &self.client,
            &self.relay.origin,
            ADMIN,
            "destination/enable",
        )
        .await
        .unwrap();
    }
    async fn configure(&self, revision: &str) -> Value {
        let mut command = self.command(&[
            "relay",
            "configure",
            "--expected-revision",
            revision,
            "--enable",
            "--capability-file",
        ]);
        command
            .arg(&self.capability)
            .arg("--relay-ca-file")
            .arg(&self.ca);
        child_report(command.spawn().unwrap(), 8).await
    }
    async fn held_flush(&self, args: &[&str]) -> tokio::process::Child {
        self.tap.hold_next.store(true, Ordering::SeqCst);
        let child = self.command(args).spawn().unwrap();
        self.tap.wait_committed().await;
        child
    }
    fn remote_count(&self) -> i64 {
        rusqlite::Connection::open_with_flags(
            self._root.path().join("relay/outbox.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap()
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap()
    }
    async fn ready() -> Self {
        let fixture = Self::new().await;
        fixture.remote_enable().await;
        fixture.configure("0").await;
        fixture.ingest("working").await;
        fixture
    }
    async fn command_output(&self, args: &[&str]) -> std::process::Output {
        tokio::time::timeout(Duration::from_secs(8), self.command(args).output())
            .await
            .unwrap()
            .unwrap()
    }
    async fn status(&self) -> Value {
        self.run(&["relay", "status"], None).await
    }
}
async fn child_report(child: tokio::process::Child, budget: u64) -> Value {
    let output = tokio::time::timeout(Duration::from_secs(budget), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
async fn wait_delivery(delivery: &Delivery, count: u32) {
    tokio::time::timeout(
        Duration::from_secs(5),
        delivery.received.acquire_many(count),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_agent_cli_default_off_normalized_transitions_reach_owned_tls_destination() {
    let fixture = Fixture::new().await;
    fixture.ingest("working").await;
    assert_eq!(fixture.status().await["pending"], 0);
    assert_eq!(
        fixture.run(&["relay", "flush"], None).await["stopped"],
        "disabled"
    );
    assert!(!fixture.state.join("relay-publisher.lock").exists());
    fixture.remote_enable().await;
    assert_eq!(fixture.configure("0").await["revision"], 1);
    fixture.ingest("working").await;
    for state in ["needs_attention", "needs_attention", "done"] {
        fixture.ingest(state).await;
    }
    assert_eq!(fixture.status().await["pending"], 2);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (shutdown, stop) = tokio::sync::oneshot::channel();
    let service = fixture.service.clone();
    let worker = tokio::spawn(async move {
        lazysh_notifications::serve(listener, service, async {
            let _ = stop.await;
        })
        .await
        .unwrap()
    });
    let report = fixture.run(&["relay", "flush"], None).await;
    assert_eq!(report["relayRecorded"], 2);
    assert_eq!(fixture.status().await["pending"], 0);
    wait_delivery(&fixture.delivery, 2).await;
    let bodies = fixture.delivery.bodies.lock().await;
    assert_eq!(bodies.len(), 2);
    assert_eq!(
        bodies
            .iter()
            .map(|b| b["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["needs_attention", "done"]
    );
    for body in bodies.iter() {
        assert_eq!(body.as_object().unwrap().len(), 5);
        assert_eq!(body["alias"], "public-worker");
        for field in ["eventId", "receiptId"] {
            uuid::Uuid::parse_str(body[field].as_str().unwrap()).unwrap();
        }
        assert!(!body.to_string().contains("private-"));
    }
    drop(bodies);
    shutdown.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), worker)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_bound_post_ack_restarts_with_the_same_event_and_original_receipt() {
    let fixture = Fixture::ready().await;
    let mut child = fixture.held_flush(&["relay", "flush"]).await;
    child.kill().await.unwrap();
    assert!(!child.wait_with_output().await.unwrap().status.success());
    assert_eq!(fixture.status().await["pending"], 1);
    let report = fixture.run(&["relay", "flush"], None).await;
    assert_eq!(report["relayRecorded"], 1);
    let posts = fixture.tap.posts.lock().await;
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[0], posts[1]);
    drop(posts);
    assert_eq!(fixture.status().await["retainedRecorded"], 1);
    assert_eq!(fixture.remote_count(), 1);
    fixture.tap.release.add_permits(1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn held_flush_keeps_exclusive_drain_and_disable_fences_its_late_local_completion() {
    let fixture = Fixture::ready().await;
    let child = fixture.held_flush(&["relay", "flush"]).await;
    let busy = fixture.command_output(&["relay", "flush"]).await;
    assert!(!busy.status.success());
    assert!(String::from_utf8_lossy(&busy.stderr).contains("RelayDrainBusy"));
    let disabled = fixture
        .run(&["relay", "disable", "--expected-revision", "1"], None)
        .await;
    assert_eq!(disabled["revision"], 2);
    assert_eq!(disabled["retainedUnknown"], 1);
    fixture.tap.release.add_permits(1);
    let report = child_report(child, 5).await;
    assert_eq!(report["stopped"], "configuration_changed");
    assert_eq!(report["relayRecorded"], 0);
    fixture.ingest("done").await;
    assert_eq!(fixture.status().await["pending"], 0);
    assert_eq!(fixture.configure("2").await["revision"], 3);
    fixture.ingest("needs_attention").await;
    assert_eq!(
        fixture.run(&["relay", "flush"], None).await["relayRecorded"],
        1
    );
    let posts = fixture.tap.posts.lock().await;
    assert_eq!(posts.len(), 2);
    assert_ne!(posts[0]["eventId"], posts[1]["eventId"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_private_capability_or_ca_bytes_cannot_freshen_queued_work() {
    let fixture = Fixture::ready().await;
    for path in [&fixture.capability, &fixture.ca] {
        let original = std::fs::read(path).unwrap();
        let mut changed = original.clone();
        changed.push(b'\n');
        std::fs::write(path, &changed).unwrap();
        let failed = fixture.command_output(&["relay", "flush"]).await;
        assert!(!failed.status.success());
        assert!(String::from_utf8_lossy(&failed.stderr).contains("RelayBindingMismatch"));
        assert!(fixture.tap.posts.lock().await.is_empty());
        assert_eq!(fixture.status().await["pending"], 1);
        std::fs::write(path, original).unwrap();
    }
    assert_eq!(
        fixture.run(&["relay", "flush"], None).await["relayRecorded"],
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_generation_change_blocks_new_admission_without_refresh_or_unbound_fallback() {
    let fixture = Fixture::ready().await;
    for action in ["destination/disable", "destination/enable"] {
        client::admin_action(&fixture.client, &fixture.relay.origin, ADMIN, action)
            .await
            .unwrap();
    }
    let report = fixture.run(&["relay", "flush"], None).await;
    assert_eq!(report["blocked"], 1);
    assert_eq!(report["lastFailure"], "RelayTargetChanged");
    let status = fixture.status().await;
    assert_eq!(status["retainedBlocked"], 1);
    assert_eq!(status["pending"], 0);
    assert_eq!(fixture.remote_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_deadline_preserves_unknown_outcome_and_persisted_retry_ownership() {
    let fixture = Fixture::ready().await;
    let child = fixture
        .held_flush(&["relay", "flush", "--deadline-seconds", "1"])
        .await;
    let report = child_report(child, 4).await;
    assert_eq!(report["stopped"], "deadline");
    assert_eq!(report["relayRecorded"], 0);
    assert_eq!(fixture.status().await["pending"], 1);
    fixture.tap.release.add_permits(1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_downgrade_after_configuration_never_falls_back_to_the_manual_endpoint() {
    let fixture = Fixture::ready().await;
    fixture.tap.reject_posts.store(true, Ordering::SeqCst);
    let report = fixture.run(&["relay", "flush"], None).await;
    assert_eq!(report["blocked"], 1);
    assert_eq!(report["lastFailure"], "RelayBoundProtocolUnsupported");
    assert_eq!(fixture.remote_count(), 0);
    assert_eq!(fixture.status().await["retainedBlocked"], 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_tls_trust_and_disabled_remote_cannot_enable_local_admission() {
    let fixture = Fixture::new().await;
    // The executable must keep its normal chain verification when no CA is supplied.
    let mut untrusted = fixture.command(&[
        "relay",
        "configure",
        "--expected-revision",
        "0",
        "--enable",
        "--capability-file",
    ]);
    untrusted.arg(&fixture.capability);
    let output = tokio::time::timeout(Duration::from_secs(5), untrusted.output())
        .await
        .unwrap()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(fixture.status().await["revision"], 0);
    let mut disabled = fixture.command(&[
        "relay",
        "configure",
        "--expected-revision",
        "0",
        "--enable",
        "--capability-file",
    ]);
    disabled
        .arg(&fixture.capability)
        .arg("--relay-ca-file")
        .arg(&fixture.ca);
    let output = tokio::time::timeout(Duration::from_secs(5), disabled.output())
        .await
        .unwrap()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("RelayDestinationDisabled"));
    assert_eq!(fixture.status().await["revision"], 0);
    assert!(fixture.tap.posts.lock().await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn third_retryable_cli_attempt_reports_terminal_unknown_without_a_fourth_post() {
    let fixture = Fixture::ready().await;
    fixture.tap.retry_posts.store(true, Ordering::SeqCst);
    for attempt in 1..=3 {
        let report = fixture.run(&["relay", "flush"], None).await;
        assert_eq!(report["attempted"], 1);
        assert_eq!(report["retryPending"], u64::from(attempt < 3));
        let status = fixture.status().await;
        assert_eq!(status["pending"], u64::from(attempt < 3));
        assert_eq!(status["retainedUnknown"], u64::from(attempt == 3));
        if attempt < 3 {
            // Wait for the actual persisted two-second retry policy, not a guessed scheduler delay.
            let connection = rusqlite::Connection::open_with_flags(
                fixture.state.join("events.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let next: i64 = connection
                .query_row("SELECT next_attempt FROM relay_outbox", [], |r| r.get(0))
                .unwrap();
            let due = std::time::UNIX_EPOCH + Duration::from_secs(next as u64);
            tokio::time::sleep(
                due.duration_since(std::time::SystemTime::now())
                    .unwrap_or_default(),
            )
            .await;
        }
    }
    assert_eq!(fixture.run(&["relay", "flush"], None).await["attempted"], 0);
    let posts = fixture.tap.posts.lock().await;
    assert_eq!(posts.len(), 3);
    assert!(posts.iter().all(|body| body == &posts[0]));
    assert_eq!(fixture.remote_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn termination_signal_finishes_the_original_claim_before_releasing_drain_ownership() {
    let fixture = Fixture::ready().await;
    let child = fixture.held_flush(&["relay", "flush"]).await;
    assert_eq!(
        unsafe { libc::kill(child.id().unwrap() as libc::pid_t, libc::SIGTERM) },
        0
    );
    let report = child_report(child, 4).await;
    assert_eq!(report["stopped"], "cancelled");
    assert_eq!(report["retryPending"], 1);
    assert_eq!(fixture.status().await["pending"], 1);
    fixture.tap.release.add_permits(1);
    // The terminated owner completed its local transaction before another drain can start.
    assert!(fixture
        .command_output(&["relay", "flush"])
        .await
        .status
        .success());
    // A later due retry is allowed; the next drain must never inherit the old owner.
}
