mod bound_push;
#[cfg(unix)]
mod ntfy_android;
mod push_delivery;
#[path = "../tests/support/mod.rs"]
mod support;
use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{oneshot, Semaphore},
    task::{JoinHandle, JoinSet},
};
use tower::ServiceExt;
const ADMIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
fn event() -> Event {
    Event {
        event_id: Uuid::new_v4(),
        kind: Kind::NeedsAttention,
    }
}
fn config(path: &std::path::Path, url: &str) -> Config {
    Config::new(path.into(), ADMIN, url, TARGET).unwrap()
}
async fn call(
    service: &Service,
    method: &str,
    path: &str,
    token: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = service
        .router()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into())),
    )
}
async fn source(service: &Service, secret: &str, alias: &str) -> Uuid {
    let account = service.db(|s| s.status()).await.unwrap().account_id;
    let id = Uuid::new_v4();
    let value = Source {
        account_id: account,
        id,
        alias: alias.into(),
        token_hash: digest(secret).to_vec(),
    };
    assert_eq!(
        call(
            service,
            "POST",
            "/v1/admin/sources",
            ADMIN,
            serde_json::to_value(value).unwrap()
        )
        .await
        .0,
        StatusCode::OK
    );
    id
}
async fn enable(service: &Service) {
    assert_eq!(
        call(
            service,
            "POST",
            "/v1/admin/destination/enable",
            ADMIN,
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
}
async fn enqueue(service: &Service, token: &str, event: &Event) -> Receipt {
    let (status, body) = call(
        service,
        "POST",
        "/v1/events",
        token,
        serde_json::to_value(event).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}
struct TlsReceiver {
    url: String,
    client: reqwest::Client,
    requests: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
    task: JoinHandle<()>,
}
impl TlsReceiver {
    async fn new(code: u16, held: bool) -> Self {
        let identity = support::identity();
        let cert = reqwest::Certificate::from_pem(identity.pem.as_bytes()).unwrap();
        let acceptor = identity.acceptor;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "https://localhost:{}/events",
            listener.local_addr().unwrap().port()
        );
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .add_root_certificate(cert)
            .timeout(Duration::from_millis(400))
            .build()
            .unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let capture = requests.clone();
        let entered = Arc::new(Semaphore::new(0));
        let signal = entered.clone();
        let release = Arc::new(Semaphore::new(if held { 0 } else { 100 }));
        let gate = release.clone();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                 connection=listener.accept()=>{let (tcp,_)=connection.unwrap();let acceptor=acceptor.clone();let capture=capture.clone();let signal=signal.clone();let gate=gate.clone();tasks.spawn(async move{
                  let mut stream=acceptor.accept(tcp).await.unwrap();let mut bytes=Vec::new();let header_end=loop{
                   let mut byte=[0];if stream.read_exact(&mut byte).await.is_err(){return;}bytes.push(byte[0]);assert!(bytes.len()<8192);if bytes.ends_with(b"\r\n\r\n"){break bytes.len();}
                  };
                  let headers=String::from_utf8(bytes).unwrap();let length:usize=headers.lines().find_map(|l|l.to_lowercase().strip_prefix("content-length: ").map(str::to_owned)).unwrap().parse().unwrap();assert!(length<4096);
                  let mut body=vec![0;length];stream.read_exact(&mut body).await.unwrap();assert!(header_end>0);
                  capture.lock().unwrap().push((headers,serde_json::from_slice(&body).unwrap()));signal.add_permits(1);
                  let _permit=gate.acquire().await.unwrap();let response=format!("HTTP/1.1 {code} Fixture\r\nContent-Length: 0\r\nConnection: close\r\nLocation: http://127.0.0.1:1/leak\r\n\r\n");let _=stream.write_all(response.as_bytes()).await;
                 });},
                 _=tasks.join_next(),if !tasks.is_empty()=>{},
                }
            }
        });
        Self {
            url,
            client,
            requests,
            entered,
            release,
            task,
        }
    }
    fn service(&self, path: &std::path::Path) -> Service {
        Service::open_with(config(path, &self.url), self.client.clone(), false).unwrap()
    }
    async fn received(&self) {
        tokio::time::timeout(Duration::from_secs(3), self.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
}
impl Drop for TlsReceiver {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn start(service: Service) -> (oneshot::Sender<()>, JoinHandle<std::io::Result<()>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (stop, done) = oneshot::channel();
    (
        stop,
        tokio::spawn(serve(listener, service, async {
            let _ = done.await;
        })),
    )
}
async fn stop(stop: oneshot::Sender<()>, task: JoinHandle<std::io::Result<()>>) {
    let _ = stop.send(());
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
async fn state(service: &Service, source: Uuid, id: &str, expected: &str) {
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            if service
                .db({
                    let id = id.to_owned();
                    move |s| s.receipt(source, &id)
                })
                .await
                .unwrap()
                .state
                == expected
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn authenticated_ingest_tls_delivery_scoped_dedup_and_closed_payload() {
    let receiver = TlsReceiver::new(204, false).await;
    let directory = tempfile::tempdir().unwrap();
    let service = receiver.service(directory.path());
    let id = source(&service, SOURCE, "build-server").await;
    assert!(!service.db(|s| s.status()).await.unwrap().enabled);
    assert_eq!(
        call(
            &service,
            "POST",
            "/v1/events",
            SOURCE,
            serde_json::to_value(event()).unwrap()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &service,
            "GET",
            "/v1/admin/status",
            SOURCE,
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    enable(&service).await;
    let ev = event();
    let saved = enqueue(&service, SOURCE, &ev).await;
    assert_eq!(
        enqueue(&service, SOURCE, &ev).await.receipt_id,
        saved.receipt_id
    );
    let other = secret();
    let other_id = source(&service, &other, "other-server").await;
    let second = enqueue(&service, &other, &ev).await;
    assert_ne!(second.receipt_id, saved.receipt_id);
    assert_eq!(
        call(
            &service,
            "GET",
            &format!("/v1/receipts/{}", saved.receipt_id),
            &other,
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let altered = Event {
        event_id: ev.event_id,
        kind: Kind::Done,
    };
    assert_eq!(
        call(
            &service,
            "POST",
            "/v1/events",
            SOURCE,
            serde_json::to_value(altered).unwrap()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &service,
            "POST",
            "/v1/events",
            SOURCE,
            serde_json::json!({"eventId":Uuid::new_v4(),"kind":"done","prompt":"private"})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (done, task) = start(service.clone()).await;
    receiver.received().await;
    receiver.received().await;
    state(&service, id, &saved.receipt_id, "accepted").await;
    state(&service, other_id, &second.receipt_id, "accepted").await;
    stop(done, task).await;
    let capture = receiver.requests.lock().unwrap();
    let (headers, body) = &capture[0];
    assert!(headers
        .to_lowercase()
        .contains(&format!("authorization: bearer {TARGET}")));
    assert!(headers.to_lowercase().contains("idempotency-key:"));
    assert_eq!(body.as_object().unwrap().len(), 5);
    assert_eq!(body["alias"], "build-server");
    assert!(body.get("sourceId").is_none());
    assert!(!body.to_string().contains(SOURCE));
}
async fn queued_public_job(service: Service) -> (Service, Uuid, Receipt) {
    let id = source(&service, SOURCE, "public").await;
    enable(&service).await;
    let saved = enqueue(&service, SOURCE, &event()).await;
    (service, id, saved)
}
type Stop = (oneshot::Sender<()>, JoinHandle<std::io::Result<()>>);
async fn held_public_job(
    receiver: &TlsReceiver,
    directory: &std::path::Path,
) -> (Service, Uuid, Receipt, Stop) {
    let (service, id, receipt) = queued_public_job(receiver.service(directory)).await;
    let stop = start(service.clone()).await;
    receiver.received().await;
    (service, id, receipt, stop)
}
#[tokio::test]
async fn held_post_disable_reenable_restart_and_rotated_target_do_not_freshen_old_work() {
    let receiver = TlsReceiver::new(200, true).await;
    let directory = tempfile::tempdir().unwrap();
    let (service, id, saved, (done, task)) = held_public_job(&receiver, directory.path()).await;
    assert_eq!(
        call(
            &service,
            "POST",
            "/v1/admin/destination/disable",
            ADMIN,
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    state(&service, id, &saved.receipt_id, "cancelled_unknown").await;
    receiver.release.add_permits(1);
    stop(done, task).await;
    drop(service);
    let service = receiver.service(directory.path());
    assert!(!service.db(|s| s.status()).await.unwrap().enabled);
    enable(&service).await;
    assert_eq!(
        enqueue(
            &service,
            SOURCE,
            &Event {
                event_id: Uuid::parse_str(&saved.event_id).unwrap(),
                kind: Kind::NeedsAttention
            }
        )
        .await
        .state,
        "cancelled_unknown"
    );
    let changed = Config::new(
        directory.path().into(),
        ADMIN,
        &receiver.url,
        &"d".repeat(64),
    )
    .unwrap();
    assert!(Service::open(changed).is_err());
    drop(service);
    let changed = Config::new(
        directory.path().into(),
        ADMIN,
        &receiver.url,
        &"d".repeat(64),
    )
    .unwrap();
    Service::reconfigure(changed).unwrap();
    let changed = Config::new(
        directory.path().into(),
        ADMIN,
        &receiver.url,
        &"d".repeat(64),
    )
    .unwrap();
    let service = Service::open(changed).unwrap();
    assert!(!service.db(|s| s.status()).await.unwrap().enabled);
    assert_eq!(
        service
            .db(move |s| s.receipt(id, &saved.receipt_id))
            .await
            .unwrap()
            .state,
        "cancelled_unknown"
    );
    assert_eq!(receiver.requests.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn restart_unknown_post_retries_exact_receipt_id_and_source_revoke_is_final() {
    let receiver = TlsReceiver::new(200, true).await;
    let directory = tempfile::tempdir().unwrap();
    let (service, id, saved, (done, task)) = held_public_job(&receiver, directory.path()).await;
    stop(done, task).await;
    drop(service);
    let service = receiver.service(directory.path());
    let (done, task) = start(service.clone()).await;
    receiver.received().await;
    {
        let rows = receiver.requests.lock().unwrap();
        assert_eq!(rows[0].1["receiptId"], rows[1].1["receiptId"]);
    }
    assert_eq!(
        call(
            &service,
            "POST",
            &format!("/v1/admin/sources/{id}/revoke"),
            ADMIN,
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    state(&service, id, &saved.receipt_id, "cancelled_unknown").await;
    assert_eq!(
        call(
            &service,
            "POST",
            "/v1/events",
            SOURCE,
            serde_json::to_value(event()).unwrap()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    receiver.release.add_permits(2);
    stop(done, task).await;
}
#[tokio::test]
async fn redirect_timeout_shutdown_and_single_worker_are_bounded() {
    for code in [302, 200] {
        let receiver = TlsReceiver::new(code, code == 200).await;
        let directory = tempfile::tempdir().unwrap();
        let (service, id, saved) = queued_public_job(receiver.service(directory.path())).await;
        let (done, task) = start(service.clone()).await;
        receiver.received().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        assert!(serve(listener, service.clone(), std::future::pending())
            .await
            .is_err());
        state(&service, id, &saved.receipt_id, "queued").await;
        stop(done, task).await;
        assert!(!service.0.worker.load(Ordering::SeqCst));
        assert_eq!(receiver.requests.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn queue_capacity_and_idempotent_source_recovery_never_overwrite_identity() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        Service::open(config(directory.path(), "https://example.invalid/events")).unwrap();
    let id = source(&service, SOURCE, "public").await;
    let source = Source {
        account_id: service.db(|s| s.status()).await.unwrap().account_id,
        id,
        alias: "public".into(),
        token_hash: digest(SOURCE).to_vec(),
    };
    for _ in 0..2 {
        assert_eq!(
            call(
                &service,
                "POST",
                "/v1/admin/sources",
                ADMIN,
                serde_json::to_value(&source).unwrap()
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    let conflicting = Source {
        alias: "different".into(),
        ..source
    };
    assert_eq!(
        call(
            &service,
            "POST",
            "/v1/admin/sources",
            ADMIN,
            serde_json::to_value(conflicting).unwrap()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    enable(&service).await;
    service
        .db(move |s| {
            for _ in 0..store::CAPACITY {
                s.ingest(id, event())?;
            }
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        call(
            &service,
            "POST",
            "/v1/events",
            SOURCE,
            serde_json::to_value(event()).unwrap()
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}
#[test]
fn capabilities_are_private_no_overwrite_and_errors_do_not_echo_secrets() {
    let directory = tempfile::tempdir().unwrap();
    lazysh_common::fs::private_directory(directory.path()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = directory.path().join("capability");
    client::keygen(&path).unwrap();
    assert!(client::keygen(&path).is_err());
    let token = client::read_token(&path).unwrap();
    assert!(valid_token(&token));
    for value in [
        "http://localhost/events",
        "https://user:secret@localhost/events",
        "https://localhost/events?secret=value",
        "https://localhost/events#secret",
    ] {
        assert!(https(value).is_err());
    }
    let cap = client::Capability {
        schema_version: 1,
        origin: "https://example.invalid".into(),
        account_id: Uuid::new_v4().to_string(),
        source_id: Uuid::new_v4(),
        alias: "public".into(),
        secret: SOURCE.into(),
    };
    let file = directory.path().join("envelope");
    client::write_private(&file, &serde_json::to_vec(&cap).unwrap()).unwrap();
    let saved = client::read_capability(&file).unwrap();
    assert_eq!(saved.source_id, cap.source_id);
    assert!(client::write_private(&file, b"overwrite").is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let public = ApiError::unauthorized().into_response();
    assert_eq!(public.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn real_loopback_http_ingest_reaches_owned_tls_receiver_then_receipt() {
    let receiver = TlsReceiver::new(202, false).await;
    let directory = tempfile::tempdir().unwrap();
    let service = receiver.service(directory.path());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (shutdown, done) = oneshot::channel();
    let owned = service.clone();
    let task = tokio::spawn(serve(listener, owned, async {
        let _ = done.await;
    }));
    let client = reqwest::Client::new();
    let status: Status = client
        .get(format!("{origin}/v1/admin/status"))
        .bearer_auth(ADMIN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let source = Source {
        account_id: status.account_id,
        id,
        alias: "public-worker".into(),
        token_hash: digest(SOURCE).to_vec(),
    };
    for (path, body) in [
        ("/v1/admin/sources", serde_json::to_value(&source).unwrap()),
        ("/v1/admin/destination/enable", serde_json::Value::Null),
    ] {
        assert!(client
            .post(format!("{origin}{path}"))
            .bearer_auth(ADMIN)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
    }
    let saved: Receipt = client
        .post(format!("{origin}/v1/events"))
        .bearer_auth(SOURCE)
        .json(&event())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    receiver.received().await;
    state(&service, id, &saved.receipt_id, "accepted").await;
    let receipt: Receipt = client
        .get(format!("{origin}/v1/receipts/{}", saved.receipt_id))
        .bearer_auth(SOURCE)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(receipt.state, "accepted");
    assert!(receipt.may_have_reached_destination);
    stop(shutdown, task).await;
    drop(service);
    assert!(Service::open(config(directory.path(), &receiver.url)).is_ok());
}

const OFFLINE_ENDPOINT: &str = "https://example.invalid/events";
async fn offline_job() -> (tempfile::TempDir, Service, Uuid, Receipt) {
    let directory = tempfile::tempdir().unwrap();
    let (service, id, receipt) =
        queued_public_job(Service::open(config(directory.path(), OFFLINE_ENDPOINT)).unwrap()).await;
    (directory, service, id, receipt)
}
fn admit_three(s: &mut store::Store, finish_last: bool) -> Result<(), ApiError> {
    for attempt in 1..=3 {
        let job = s.claim()?.unwrap();
        assert_eq!(job.attempts, attempt);
        if finish_last || attempt < 3 {
            s.finish(&job, false)?;
            s.connection.execute("UPDATE events SET next=0", [])?;
        }
    }
    Ok(())
}
#[tokio::test]
async fn retry_ceiling_expiry_and_same_identity_reconfiguration_remain_disabled() {
    let (directory, service, id, saved) = offline_job().await;
    service
        .db(|s| {
            admit_three(s, true)?;
            assert!(s.claim()?.is_none());
            Ok(())
        })
        .await
        .unwrap();
    state(&service, id, &saved.receipt_id, "failed_unknown").await;
    let expiring = enqueue(&service, SOURCE, &event()).await;
    service
        .db(|s| {
            s.connection
                .execute("UPDATE events SET expires=0 WHERE state='queued'", [])?;
            assert!(s.claim()?.is_none());
            Ok(())
        })
        .await
        .unwrap();
    state(&service, id, &expiring.receipt_id, "expired").await;
    drop(service);
    Service::reconfigure(config(directory.path(), OFFLINE_ENDPOINT)).unwrap();
    assert!(
        !Service::open(config(directory.path(), OFFLINE_ENDPOINT))
            .unwrap()
            .db(|s| s.status())
            .await
            .unwrap()
            .enabled
    );
}

#[tokio::test]
async fn recovery_envelope_survives_lost_tls_provision_ack_without_second_identity() {
    let destination = TlsReceiver::new(200, false).await;
    let directory = tempfile::tempdir().unwrap();
    let service = destination.service(directory.path());
    let provisions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = provisions.clone();
    let router = service.router().layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let counter = counter.clone();
            async move {
                if request.uri().path() == "/v1/admin/sources" {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
                next.run(request).await
            }
        },
    ));
    let (router, committed) = support::hold_first_provision(router);
    let tls = support::Server::new(router).await;
    let origin = tls.origin.clone();
    let ca = directory.path().join("relay-ca.pem");
    client::write_private(&ca, tls.pem.as_bytes()).unwrap();
    let client = client::transport(Some(&ca)).unwrap();
    let envelope = directory.path().join("source-envelope");
    let pending = {
        let client = client.clone();
        let origin = origin.clone();
        let envelope = envelope.clone();
        tokio::spawn(async move {
            client::create_source(&client, &origin, ADMIN, "public", &envelope).await
        })
    };
    tokio::time::timeout(Duration::from_secs(5), committed.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    let original = client::read_capability(&envelope).unwrap();
    let saved = std::fs::read(&envelope).unwrap();
    assert_eq!(
        client::resume_source(&client, &origin, ADMIN, &envelope)
            .await
            .unwrap(),
        original.source_id
    );
    assert_eq!(std::fs::read(&envelope).unwrap(), saved);
    assert_eq!(
        service
            .db(|s| Ok(s
                .connection
                .query_row("SELECT count(*) FROM sources", [], |r| r.get::<_, i64>(0))?))
            .await
            .unwrap(),
        1
    );
    {
        use std::os::unix::fs::PermissionsExt;
        let unsafe_ancestor = directory.path().join("unsafe");
        let leaf = unsafe_ancestor.join("private-leaf");
        std::fs::create_dir_all(&leaf).unwrap();
        std::fs::set_permissions(&leaf, std::fs::Permissions::from_mode(0o700)).unwrap();
        let unsafe_cap = leaf.join("capability");
        std::fs::copy(&envelope, &unsafe_cap).unwrap();
        std::fs::set_permissions(&unsafe_ancestor, std::fs::Permissions::from_mode(0o777)).unwrap();
        let before = provisions.load(Ordering::SeqCst);
        let error = client::resume_source(&client, &origin, ADMIN, &unsafe_cap)
            .await
            .unwrap_err();
        assert_eq!(error, "Unsafe capability output namespace");
        assert_eq!(provisions.load(Ordering::SeqCst), before);
        assert_eq!(std::fs::read(&unsafe_cap).unwrap(), saved);
    }
    assert!(
        client::resume_source(&client, "https://different.invalid", ADMIN, &envelope)
            .await
            .unwrap_err()
            .contains("origin mismatch")
    );
    service
        .db(|s| {
            s.connection
                .execute("UPDATE account SET id=?1", [Uuid::new_v4().to_string()])?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(client::resume_source(&client, &origin, ADMIN, &envelope)
        .await
        .unwrap_err()
        .contains("account mismatch"));
}

#[tokio::test]
async fn interrupted_third_admission_cannot_restart_into_a_fourth_post() {
    let (directory, service, id, saved) = offline_job().await;
    service
        .db(|s| {
            admit_three(s, false)?;
            Ok(())
        })
        .await
        .unwrap();
    drop(service);
    let service = Service::open(config(directory.path(), OFFLINE_ENDPOINT)).unwrap();
    assert!(service.db(|s| s.claim()).await.unwrap().is_none());
    state(&service, id, &saved.receipt_id, "failed_unknown").await;
    assert!(
        service
            .db(move |s| s.receipt(id, &saved.receipt_id))
            .await
            .unwrap()
            .may_have_reached_destination
    );
}

#[tokio::test]
async fn shared_source_validator_preserves_the_server_error_response() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(config(directory.path(), OFFLINE_ENDPOINT)).unwrap();
    let input = Source {
        account_id: service.db(|s| s.status()).await.unwrap().account_id,
        id: Uuid::new_v4(),
        alias: "invalid\ncontrol".into(),
        token_hash: vec![0; 32],
    };
    let (status, body) = call(
        &service,
        "POST",
        "/v1/admin/sources",
        ADMIN,
        serde_json::to_value(input).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({"error":"invalid_source"}));
}

fn publisher_files(
    directory: &std::path::Path,
    tls: &support::Server,
    account: String,
    id: Uuid,
) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let capability = client::Capability {
        schema_version: 1,
        origin: tls.origin.clone(),
        account_id: account,
        source_id: id,
        alias: "public".into(),
        secret: SOURCE.into(),
    };
    let capfile = directory.join("publisher.json");
    let ca = directory.join("publisher.pem");
    client::write_private(&capfile, &serde_json::to_vec(&capability).unwrap()).unwrap();
    client::write_private(&ca, tls.pem.as_bytes()).unwrap();
    (capfile, ca)
}
async fn bound_status_of(service: &Service) -> BoundStatus {
    let (code, value) = call(
        service,
        "GET",
        "/v1/bound-events",
        SOURCE,
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    serde_json::from_value(value).unwrap()
}
fn bound_event(status: &BoundStatus, event: &Event) -> BoundEvent {
    BoundEvent {
        schema_version: 1,
        account_id: status.account_id,
        source_id: status.source_id,
        generation: status.generation,
        event_id: event.event_id,
        kind: event.kind,
    }
}
async fn bound_post(service: &Service, event: &BoundEvent) -> (StatusCode, serde_json::Value) {
    call(
        service,
        "POST",
        "/v1/bound-events",
        SOURCE,
        serde_json::to_value(event).unwrap(),
    )
    .await
}
async fn assert_no_events(service: &Service) {
    assert_eq!(
        service
            .db(|s| Ok(s
                .connection
                .query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))?))
            .await
            .unwrap(),
        0
    );
}
fn wrong_bound_targets(expected: &BoundEvent) -> Vec<serde_json::Value> {
    ["accountId", "sourceId", "generation"]
        .into_iter()
        .map(|field| {
            let mut wrong = serde_json::to_value(expected).unwrap();
            wrong[field] = if field == "generation" {
                serde_json::json!(expected.generation + 1)
            } else {
                serde_json::json!(Uuid::new_v4())
            };
            wrong
        })
        .collect()
}
#[tokio::test]
async fn bound_admission_checks_transaction_identity_and_preserves_original_receipt_generation() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(config(directory.path(), OFFLINE_ENDPOINT)).unwrap();
    let id = source(&service, SOURCE, "public").await;
    enable(&service).await;
    let status = bound_status_of(&service).await;
    assert_eq!(status.source_id, id);
    let event = event();
    let expected = bound_event(&status, &event);
    for wrong in wrong_bound_targets(&expected) {
        assert_eq!(
            call(&service, "POST", "/v1/bound-events", SOURCE, wrong)
                .await
                .0,
            StatusCode::PRECONDITION_FAILED
        );
    }
    assert_no_events(&service).await;
    let (code, value) = bound_post(&service, &expected).await;
    assert_eq!(code, StatusCode::OK);
    let original: BoundReceipt = serde_json::from_value(value).unwrap();
    for enabled in [false, true] {
        service.db(move |s| s.policy(enabled)).await.unwrap();
        let (code, value) = bound_post(&service, &expected).await;
        assert_eq!(code, StatusCode::OK);
        let receipt: BoundReceipt = serde_json::from_value(value).unwrap();
        assert_eq!(receipt.generation, original.generation);
        assert_eq!(receipt.receipt.receipt_id, original.receipt.receipt_id);
        assert_eq!(receipt.receipt.state, "cancelled");
    }
    let mut altered = expected.clone();
    altered.kind = Kind::Done;
    assert_eq!(bound_post(&service, &altered).await.0, StatusCode::CONFLICT);
    altered = expected.clone();
    altered.generation += 1;
    assert_eq!(bound_post(&service, &altered).await.0, StatusCode::CONFLICT);
    service
        .db(|s| {
            s.connection
                .execute("UPDATE account SET id=?1", [Uuid::new_v4().to_string()])?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        bound_post(&service, &expected).await.0,
        StatusCode::PRECONDITION_FAILED
    );
    service.db(move |s| s.revoke(id)).await.unwrap();
    assert_eq!(
        bound_post(&service, &expected).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn captured_publisher_uses_one_private_capability_and_exact_ca_snapshot_before_any_post() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(config(&directory.path().join("state"), OFFLINE_ENDPOINT)).unwrap();
    let id = source(&service, SOURCE, "public").await;
    enable(&service).await;
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = requests.clone();
    let router = service.router().layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let counted = counted.clone();
            async move {
                counted.fetch_add(1, Ordering::SeqCst);
                next.run(request).await
            }
        },
    ));
    let tls = support::Server::new(router).await;
    let account = service.db(|s| s.status()).await.unwrap().account_id;
    let (capfile, ca) = publisher_files(directory.path(), &tls, account, id);
    let captured = client::CapturedPublisher::load(&capfile, Some(&ca)).unwrap();
    let binding = captured.binding().clone();
    assert_eq!(binding.fingerprint().len(), 64);
    let status = captured.bound_status().await.unwrap();
    assert!(status.enabled);
    let transport = client::transport(Some(&ca)).unwrap();
    for wrong in wrong_bound_targets(&bound_event(&status, &event())) {
        let response = transport
            .post(format!("{}/v1/bound-events", tls.origin))
            .bearer_auth(SOURCE)
            .json(&wrong)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
    }
    assert_no_events(&service).await;
    let saved = event();
    let saved_id = saved.event_id;
    let original = captured
        .publish_bound(saved, &binding, status.generation)
        .await
        .unwrap();
    let mut bytes = std::fs::read(&capfile).unwrap();
    bytes.push(b'\n');
    std::fs::write(&capfile, &bytes).unwrap();
    let changed = client::CapturedPublisher::load(&capfile, Some(&ca)).unwrap();
    let before = requests.load(Ordering::SeqCst);
    assert_eq!(
        changed
            .publish_bound(event(), &binding, status.generation)
            .await
            .unwrap_err(),
        client::BoundError::Binding
    );
    assert_eq!(requests.load(Ordering::SeqCst), before);
    let current = changed.binding().clone();
    let mut pem = std::fs::read(&ca).unwrap();
    pem.push(b'\n');
    std::fs::write(&ca, pem).unwrap();
    let different_ca = client::CapturedPublisher::load(&capfile, Some(&ca)).unwrap();
    assert_ne!(different_ca.binding().ca_hash, current.ca_hash);
    assert_eq!(
        different_ca
            .publish_bound(event(), &current, status.generation)
            .await
            .unwrap_err(),
        client::BoundError::Binding
    );
    assert_eq!(requests.load(Ordering::SeqCst), before);
    // Files disappear after capture: no secret/trust reread and no implicit freshening.
    std::fs::remove_file(capfile).unwrap();
    std::fs::remove_file(ca).unwrap();
    service.db(|s| s.policy(false)).await.unwrap();
    let receipt = captured
        .publish_bound(
            Event {
                event_id: saved_id,
                kind: Kind::NeedsAttention,
            },
            &binding,
            status.generation,
        )
        .await
        .unwrap();
    assert_eq!(receipt.receipt.receipt_id, original.receipt.receipt_id);
    assert_eq!(receipt.generation, status.generation);
    assert_eq!(
        captured
            .publish_bound(event(), &binding, status.generation)
            .await
            .unwrap_err(),
        client::BoundError::TargetChanged
    );
}

#[tokio::test]
async fn old_or_downgraded_relay_never_falls_back_to_the_manual_event_route() {
    for supports_get in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let account = Uuid::new_v4();
        let id = Uuid::new_v4();
        let manual = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = manual.clone();
        let status = BoundStatus {
            schema_version: 1,
            account_id: account,
            source_id: id,
            generation: 1,
            enabled: true,
        };
        let mut router = Router::new().route(
            "/v1/events",
            post(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    StatusCode::OK
                }
            }),
        );
        if supports_get {
            router = router.route(
                "/v1/bound-events",
                get(move || {
                    let status = status.clone();
                    async move { Json(status) }
                })
                .post(|| async { StatusCode::NOT_FOUND }),
            );
        }
        let tls = support::Server::new(router).await;
        let (capfile, ca) = publisher_files(directory.path(), &tls, account.to_string(), id);
        let captured = client::CapturedPublisher::load(&capfile, Some(&ca)).unwrap();
        if supports_get {
            assert!(captured.bound_status().await.is_ok());
            assert_eq!(
                captured
                    .publish_bound(event(), captured.binding(), 1)
                    .await
                    .unwrap_err(),
                client::BoundError::Unsupported
            );
        } else {
            assert_eq!(
                captured.bound_status().await.unwrap_err(),
                client::BoundError::Unsupported
            );
        }
        assert_eq!(manual.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn bound_https_responses_cannot_forge_receipt_identity_or_expand_the_closed_wire() {
    let mode = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let selected = mode.clone();
    let router = Router::new().route(
        "/v1/bound-events",
        post(move |h: HeaderMap, Json(event): Json<BoundEvent>| {
            let selected = selected.clone();
            async move {
                assert_eq!(token(&h).unwrap(), SOURCE);
                let mut value = serde_json::to_value(BoundReceipt {
                    schema_version: 1,
                    account_id: event.account_id,
                    source_id: event.source_id,
                    generation: event.generation,
                    receipt: Receipt {
                        receipt_id: Uuid::new_v4().to_string(),
                        event_id: event.event_id.to_string(),
                        kind: event.kind.as_str().into(),
                        alias: "public".into(),
                        state: "queued".into(),
                        may_have_reached_destination: false,
                    },
                })
                .unwrap();
                let (pointer, replacement) = match selected.load(Ordering::SeqCst) {
                    0 => ("/accountId", serde_json::json!(Uuid::new_v4())),
                    1 => ("/sourceId", serde_json::json!(Uuid::new_v4())),
                    2 => ("/generation", serde_json::json!(event.generation + 1)),
                    3 => ("/receipt/eventId", serde_json::json!(Uuid::new_v4())),
                    4 => ("/receipt/kind", serde_json::json!("working")),
                    5 => ("/receipt/receiptId", serde_json::json!("invalid")),
                    6 => ("/receipt/state", serde_json::json!("future_state")),
                    7 => ("/schemaVersion", serde_json::json!(2)),
                    8 => ("/generation", serde_json::json!(-1)),
                    9 => (
                        "/receipt/mayHaveReachedDestination",
                        serde_json::json!("true"),
                    ),
                    _ => ("/receipt/alias", serde_json::json!("x".repeat(5000))),
                };
                *value.pointer_mut(pointer).unwrap() = replacement;
                Json(value)
            }
        }),
    );
    let directory = tempfile::tempdir().unwrap();
    let tls = support::Server::new(router).await;
    let (capfile, ca) = publisher_files(
        directory.path(),
        &tls,
        Uuid::new_v4().to_string(),
        Uuid::new_v4(),
    );
    let captured = client::CapturedPublisher::load(&capfile, Some(&ca)).unwrap();
    for variant in 0..=10 {
        mode.store(variant, Ordering::SeqCst);
        assert_eq!(
            captured
                .publish_bound(event(), captured.binding(), 1)
                .await
                .unwrap_err(),
            client::BoundError::InvalidResponse,
            "variant={variant}"
        );
    }
    for (error, retryable) in [
        (client::BoundError::Binding, false),
        (client::BoundError::Unsupported, false),
        (client::BoundError::Unauthorized, false),
        (client::BoundError::TargetChanged, false),
        (client::BoundError::Conflict, false),
        (client::BoundError::Disabled, false),
        (client::BoundError::Capacity, true),
        (client::BoundError::Unavailable, true),
        (client::BoundError::InvalidResponse, true),
    ] {
        assert_eq!(error.retryable(), retryable);
        assert!(!error.to_string().contains(SOURCE));
    }
}
