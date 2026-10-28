//! Private relay half of the owned Bun/Android ntfy acceptance case.
use super::*;
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::MetadataExt, path::PathBuf};

fn fixture_authorized(headers: &HeaderMap, nonce: &str) -> bool {
    headers
        .get("X-Lazysh-Fixture")
        .and_then(|h| h.to_str().ok())
        == Some(nonce)
}

fn signal(nonce: String, gate: Arc<Semaphore>) -> axum::routing::MethodRouter {
    post(move |headers: HeaderMap| {
        let gate = gate.clone();
        let nonce = nonce.clone();
        async move {
            if !fixture_authorized(&headers, &nonce) {
                return StatusCode::UNAUTHORIZED;
            }
            gate.add_permits(1);
            StatusCode::NO_CONTENT
        }
    })
}

type ReplayWire = Arc<Mutex<Option<Zeroizing<String>>>>;
fn encrypted_replay(
    nonce: String,
    replay: ReplayWire,
    replays: Arc<std::sync::atomic::AtomicUsize>,
    service: Service,
) -> axum::routing::MethodRouter {
    post(move |headers: HeaderMap| {
        let nonce = nonce.clone();
        let replay = replay.clone();
        let replays = replays.clone();
        let service = service.clone();
        async move {
            if !fixture_authorized(&headers, &nonce) {
                return StatusCode::UNAUTHORIZED;
            }
            if replays.fetch_add(1, Ordering::SeqCst) >= 2 {
                return StatusCode::CONFLICT;
            }
            let encoded = { replay.lock().unwrap().clone() };
            let Some(encoded) = encoded else {
                return StatusCode::CONFLICT;
            };
            let Ok(wire) = serde_json::from_str::<push::EncryptedPush>(encoded.as_str()) else {
                return StatusCode::CONFLICT;
            };
            let Some(config) = service.0.config.push() else {
                return StatusCode::CONFLICT;
            };
            let Ok(request) = config.request(&wire, &service.0.client) else {
                return StatusCode::CONFLICT;
            };
            match request.send().await {
                Ok(response) if response.status().is_success() => StatusCode::NO_CONTENT,
                _ => StatusCode::BAD_GATEWAY,
            }
        }
    })
}

fn chain() -> (support::Identity, String, String, String) {
    let mut ca = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca.distinguished_name
        .push(rcgen::DnType::CommonName, "lazysh owned fixture CA");
    ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca.key_usages = vec![
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::CrlSign,
    ];
    let root_key = rcgen::KeyPair::generate().unwrap();
    let root = ca.self_signed(&root_key).unwrap();
    let key = rcgen::KeyPair::generate().unwrap();
    let leaf = rcgen::CertificateParams::new(vec!["localhost".into()])
        .unwrap()
        .signed_by(&key, &rcgen::Issuer::from_params(&ca, &root_key))
        .unwrap();
    let fingerprint = format!("{:x}", Sha256::digest(leaf.der().as_ref()));
    let pem = format!("{}{}", leaf.pem(), root.pem());
    let private = key.serialize_pem();
    let acceptor = support::server_acceptor(
        vec![leaf.der().clone(), root.der().clone()],
        rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
    );
    (
        support::Identity {
            acceptor,
            pem: root.pem(),
            rejected: None,
        },
        pem,
        private,
        fingerprint,
    )
}

#[tokio::test]
async fn tls_observer_distinguishes_trusted_http_from_rejected_handshake() {
    let rejected = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut identity = support::identity();
    identity.rejected = Some(rejected.clone());
    let server = support::Server::with_identity(
        Router::new().route(
            "/proof",
            post({
                let requests = requests.clone();
                move || {
                    let requests = requests.clone();
                    async move {
                        requests.fetch_add(1, Ordering::SeqCst);
                        StatusCode::NO_CONTENT
                    }
                }
            }),
        ),
        identity,
    )
    .await;
    let build = || {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
    };
    let trusted = build()
        .add_root_certificate(reqwest::Certificate::from_pem(server.pem.as_bytes()).unwrap())
        .build()
        .unwrap();
    let response = trusted
        .post(format!("{}/proof", server.origin))
        .send()
        .await;
    assert!(matches!(response,Ok(response) if response.status()==StatusCode::NO_CONTENT));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(build()
        .build()
        .unwrap()
        .post(format!("{}/proof", server.origin))
        .send()
        .await
        .is_err());
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while rejected.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(rejected.load(Ordering::SeqCst) > 0);
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "Rejected handshake must not become an HTTP request"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the owned real ntfy/Android acceptance task"]
async fn real_ntfy_android_encrypted_challenge() {
    assert_eq!(std::env::var("LAZYSH_ANDROID_NTFY").as_deref(), Ok("1"));
    let directory = PathBuf::from(
        std::env::var_os("LAZYSH_NTFY_FIXTURE_DIRECTORY")
            .expect("Owned fixture directory required"),
    );
    let nonce = std::env::var("LAZYSH_NTFY_FIXTURE_NONCE").expect("Owned fixture nonce required");
    assert!(
        nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid fixture nonce"
    );
    let metadata = fs::symlink_metadata(&directory).unwrap();
    assert!(
        directory.is_absolute()
            && metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.mode() & 0o777 == 0o700
            && metadata.uid() == fs::metadata("/proc/self").unwrap().uid(),
        "Private owned directory required"
    );
    let ntfy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ntfy_port = ntfy_listener.local_addr().unwrap().port();
    let ntfy_origin = format!("https://localhost:{ntfy_port}");
    let (identity, pem, key, fingerprint) = chain();
    for (name, bytes) in [
        ("ca.pem", identity.pem.as_bytes()),
        ("server.pem", pem.as_bytes()),
        ("server.key", key.as_bytes()),
    ] {
        client::write_private(&directory.join(name), bytes).unwrap();
    }
    let ca = reqwest::Certificate::from_pem(identity.pem.as_bytes()).unwrap();
    let push = push::PushConfig::generate_with_event_format(
        ntfy_origin.clone(),
        vec!["127.0.0.1".parse().unwrap()],
        "mailto:test@example.invalid".into(),
        push::EventFormat::BoundV2,
    )
    .unwrap()
    .with_test_root(ca);
    let device = push.slot_id();
    let service =
        Service::open(Config::web_push(directory.join("relay"), ADMIN, push).unwrap()).unwrap();
    let enrollment = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let response = call(
        &service,
        "POST",
        "/v1/admin/push/enrollment",
        ADMIN,
        serde_json::json!({"capability":enrollment}),
    )
    .await;
    assert_eq!(response.0, StatusCode::OK);
    let generation = response.1["generation"].as_i64().unwrap();
    let background = Arc::new(Semaphore::new(0));
    let complete = Arc::new(Semaphore::new(0));
    let replay: ReplayWire = Arc::new(Mutex::new(None));
    let replays = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let event_replay: ReplayWire = Arc::new(Mutex::new(None));
    let event_replays = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let event_requested = Arc::new(AtomicBool::new(false));
    let event_accepted = Arc::new(AtomicBool::new(false));
    let confirmed = Arc::new(AtomicBool::new(false));
    let source_id = source(&service, SOURCE, "owned public event").await;
    let (worker_stop, receiver) = watch::channel(false);
    let worker_service = service.clone();
    let worker = tokio::spawn(async move { worker_service.worker(receiver).await });
    let control = Router::new()
        .route(
            "/__fixture/background",
            signal(nonce.clone(), background.clone()),
        )
        .route(
            "/__fixture/complete",
            signal(nonce.clone(), complete.clone()),
        )
        .route(
            "/__fixture/replay",
            encrypted_replay(
                nonce.clone(),
                replay.clone(),
                replays.clone(),
                service.clone(),
            ),
        )
        .route(
            "/__fixture/event-replay",
            encrypted_replay(
                nonce.clone(),
                event_replay.clone(),
                event_replays.clone(),
                service.clone(),
            ),
        )
        .route(
            "/__fixture/event",
            post({
                let nonce = nonce.clone();
                let service = service.clone();
                let confirmed = confirmed.clone();
                let requested = event_requested.clone();
                let accepted = event_accepted.clone();
                let replay = event_replay.clone();
                move |headers: HeaderMap| {
                    let nonce = nonce.clone();
                    let service = service.clone();
                    let confirmed = confirmed.clone();
                    let requested = requested.clone();
                    let accepted = accepted.clone();
                    let replay = replay.clone();
                    async move {
                        if !fixture_authorized(&headers, &nonce) {
                            return StatusCode::UNAUTHORIZED;
                        }
                        if !confirmed.load(Ordering::SeqCst)
                            || requested.swap(true, Ordering::SeqCst)
                        {
                            return StatusCode::CONFLICT;
                        }
                        // An explicit test-operator action, not Android authority:
                        // the original admin/source APIs and production worker deliver it.
                        enable(&service).await;
                        let receipt = enqueue(&service, SOURCE, &event()).await;
                        let deadline = std::time::Instant::now() + Duration::from_secs(8);
                        while std::time::Instant::now() < deadline {
                            let id = receipt.receipt_id.clone();
                            let current = service
                                .db(move |store| store.receipt(source_id, &id))
                                .await
                                .unwrap();
                            if current.state == "accepted" {
                                let id = receipt.receipt_id.clone();
                                let snapshot: String = service
                                    .db(move |store| {
                                        Ok(store.connection.query_row(
                                            "SELECT subscription FROM event_push WHERE receipt=?1",
                                            [&id],
                                            |row| row.get(0),
                                        )?)
                                    })
                                    .await
                                    .unwrap();
                                let config = service.0.config.push().unwrap();
                                let wire = crate::push_event::encrypted(
                                    &config,
                                    &snapshot,
                                    &receipt,
                                    crate::store::now(),
                                )
                                .unwrap()
                                .unwrap();
                                let encoded = serde_json::to_string(&wire).unwrap();
                                assert!(encoded.len() <= 16384, "Bounded owned event replay");
                                *replay.lock().unwrap() = Some(Zeroizing::new(encoded));
                                accepted.store(true, Ordering::SeqCst);
                                return StatusCode::NO_CONTENT;
                            }
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        StatusCode::GATEWAY_TIMEOUT
                    }
                }
            }),
        );
    let confirms = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router=service.router().layer(axum::middleware::from_fn({
        let background=background.clone();let confirmed=confirmed.clone();let confirms=confirms.clone();let service=service.clone();let replay=replay.clone();
        move |request:axum::extract::Request,next:axum::middleware::Next| {
            let background=background.clone();let confirmed=confirmed.clone();let confirms=confirms.clone();let service=service.clone();let replay=replay.clone();
            async move {
                let subscription=request.uri().path()=="/v1/push/subscription";
                let confirmation=request.uri().path()=="/v1/push/confirm";
                if subscription && tokio::time::timeout(Duration::from_secs(8),background.acquire()).await.is_err() {
                    return StatusCode::GATEWAY_TIMEOUT.into_response();
                }
                if confirmation {
                    let saved=service.db(|store|Ok(store.connection.query_row("SELECT wire FROM push_device WHERE id=1",[],|r|r.get::<_,Option<String>>(0))?)).await;
                    if let Ok(Some(encoded))=saved {if encoded.len()<=16384 {*replay.lock().unwrap()=Some(Zeroizing::new(encoded));}}
                }
                let response=next.run(request).await;
                if confirmation && response.status()==StatusCode::OK {
                    confirms.fetch_add(1,Ordering::SeqCst);
                    let active=service.db(move |store|Ok(store.connection.query_row(
                        "SELECT active IS NOT NULL AND revoked=0 AND generation=?1 FROM push_device WHERE id=1",[generation],|r|r.get::<_,bool>(0))?)).await;
                    if matches!(active,Ok(true)) {confirmed.store(true,Ordering::SeqCst);}
                }
                response
            }
        }
    })).merge(control);
    let tls = support::Server::with_identity(router, identity).await;
    let untrusted_requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let untrusted_rejections = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut untrusted_identity = support::identity();
    untrusted_identity.rejected = Some(untrusted_rejections.clone());
    let untrusted = support::Server::with_identity(
        Router::new().route(
            "/v1/push/bootstrap",
            post({
                let requests = untrusted_requests.clone();
                move || {
                    let requests = requests.clone();
                    async move {
                        requests.fetch_add(1, Ordering::SeqCst);
                        StatusCode::NO_CONTENT
                    }
                }
            }),
        ),
        untrusted_identity,
    )
    .await;
    let config=format!("base-url: {}\nlisten-http: '-'\nlisten-https: {}\ncert-file: {}\nkey-file: {}\ncache-file: {}\nupstream-base-url: ''\nfirebase-key-file: ''\nlog-level: error\n",
        serde_json::to_string(&ntfy_origin).unwrap(),serde_json::to_string(&format!("127.0.0.1:{ntfy_port}")).unwrap(),
        serde_json::to_string(&directory.join("server.pem")).unwrap(),serde_json::to_string(&directory.join("server.key")).unwrap(),
        serde_json::to_string(&directory.join("ntfy.db")).unwrap());
    client::write_private(&directory.join("ntfy.yml"), config.as_bytes()).unwrap();
    client::write_private(&directory.join("input.pending"),serde_json::to_vec(&serde_json::json!({
        "nonce":nonce,"relayOrigin":tls.origin,"ntfyOrigin":ntfy_origin,"enrollment":enrollment,
        "untrustedOrigin":untrusted.origin,"deviceId":device,"generation":generation,"ntfyFingerprint":fingerprint
    })).unwrap().as_slice()).unwrap();
    fs::rename(
        directory.join("input.pending"),
        directory.join("input.json"),
    )
    .unwrap();
    drop(ntfy_listener);
    assert!(
        tokio::time::timeout(Duration::from_secs(540), complete.acquire())
            .await
            .is_ok(),
        "Native fixture completion deadline"
    );
    assert!(
        confirmed.load(Ordering::SeqCst),
        "Actual server confirmation required"
    );
    assert_eq!(
        confirms.load(Ordering::SeqCst),
        1,
        "No repeated native confirmation admitted"
    );
    assert_eq!(
        replays.load(Ordering::SeqCst),
        2,
        "Both owned encrypted replays must pass through real ntfy"
    );
    assert!(
        event_accepted.load(Ordering::SeqCst),
        "Production worker must obtain actual ntfy event acceptance"
    );
    assert_eq!(
        event_replays.load(Ordering::SeqCst),
        2,
        "Both owned bound-event replays must pass through ntfy"
    );
    worker_stop.send_replace(true);
    tokio::time::timeout(Duration::from_secs(3), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let revoked = service
        .db(|store| {
            Ok(store.connection.query_row(
                "SELECT revoked=1 AND active IS NULL FROM push_device WHERE id=1",
                [],
                |r| r.get::<_, bool>(0),
            )?)
        })
        .await;
    assert!(
        matches!(revoked, Ok(true)),
        "Authenticated remote cleanup required"
    );
    assert_eq!(
        untrusted_requests.load(Ordering::SeqCst),
        0,
        "Untrusted TLS cannot reach the HTTP handler"
    );
    assert!(
        untrusted_rejections.load(Ordering::SeqCst) > 0,
        "Owned peer must independently observe the rejected TLS handshake"
    );
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
    assert!(
        matches!(service.db(|store|store.status()).await,Ok(status) if !status.enabled),
        "Owned destination disabled after event proof"
    );
    println!("lazysh real ntfy relay: actualServerConfirmed=true oneConfirmation=true backgroundBeforeChallenge=true authenticatedRevocation=true boundEventAccepted=true eventReplayPublished=true eventDestinationDisabled=true");
}
