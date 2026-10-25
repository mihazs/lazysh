use super::*;
use axum::{
    body::to_bytes,
    extract::{Request, State as ServerState},
    http::{header, StatusCode},
    response::{IntoResponse, Response as ServerResponse},
    routing::{get, post, put},
    Json, Router,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    io::copy_bidirectional,
    net::{TcpListener, TcpStream},
    sync::{oneshot, Semaphore},
    task::JoinSet,
};
use tokio_rustls::{
    rustls::{
        pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
        ServerConfig,
    },
    TlsAcceptor,
};
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const JOB: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
fn capabilities() -> Capabilities {
    Capabilities {
        schema_version: 1,
        model: "gpt-transcribe".into(),
        languages: vec!["auto".into(), "en".into(), "pt".into()],
        max_wav_bytes: 960044,
        sample_rate: 16000,
        max_samples: 480000,
    }
}
fn quota() -> Quota {
    Quota {
        window_start: 8640000,
        window_end: 8726400,
        device_limit_samples: 3200,
        device_used_samples: 1600,
        device_remaining_samples: 1600,
        global_limit_samples: 1600,
        global_used_samples: 1600,
        global_remaining_samples: 0,
    }
}
fn snapshot(origin: &str) -> Snapshot {
    let mut quota = quota();
    quota.global_limit_samples = 6400;
    quota.global_remaining_samples = 4800;
    Snapshot {
        origin: origin.into(),
        checked_at: now(),
        capabilities: capabilities(),
        quota,
    }
}
fn ready(origin: &str) -> CloudState {
    let state = CloudState::default();
    state.inner.lock().unwrap().verified = Some(snapshot(origin));
    state
}
#[test]
fn strict_origin_enrollment_and_quota_contract_allow_reduced_limits_without_cross_authority() {
    for invalid in [
        "http://voice.example",
        "https://user@voice.example",
        "https://voice.example/x",
        "https://voice.example?x=y",
        "https://voice.example/#frag",
        "https://voice.example\\path",
        "https://voice.example\n",
    ] {
        assert!(origin(invalid).is_err(), "{invalid}");
    }
    assert_eq!(
        origin("https://VOICE.example:443/").unwrap(),
        "https://voice.example"
    );
    let value =
        serde_json::json!({"version":1,"origin":"https://voice.example","token":TOKEN}).to_string();
    assert!(decode(&value).is_ok());
    for invalid in [
        value.replace("\"version\":1", "\"version\":2"),
        value.replace(TOKEN, "secret"),
        value.replace("voice.example", "voice.example/path"),
        "x".repeat(4097),
    ] {
        assert!(decode(&invalid).is_err());
    }
    let mut value = quota();
    value.validate().unwrap();
    assert!(value.global_limit_samples < value.device_limit_samples);
    value.device_limit_samples = 1;
    value.device_remaining_samples = 0;
    value.validate().unwrap();
    value.global_limit_samples = 1;
    value.global_remaining_samples = 0;
    value.validate().unwrap();
    value.device_remaining_samples = 1;
    assert!(value.validate().is_err());
    value.device_remaining_samples = 0;
    value.window_end += 1;
    assert!(value.validate().is_err());
    let mut caps = capabilities();
    caps.languages = vec!["pt".into()];
    caps.validate().unwrap();
    caps.languages.push("pt".into());
    assert!(caps.validate().is_err());
}
#[test]
fn pcm_wav_encoding_is_canonical_bounded_and_preserves_signed_extremes() {
    let mut samples = vec![0.0; 1600];
    samples[..4].copy_from_slice(&[-1.0, 1.0, -0.5, 0.5]);
    let bytes = wav(&samples).unwrap();
    assert_eq!(bytes.len(), 3244);
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..16], b"WAVEfmt ");
    assert_eq!(&bytes[36..40], b"data");
    assert_eq!(&bytes[44..52], &[0, 128, 255, 127, 0, 192, 0, 64]);
    assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 3200);
    assert_eq!(wav(&vec![0.0; 480000]).unwrap().len(), 960044);
    for samples in [
        vec![0.0; 1599],
        vec![0.0; 480001],
        vec![f32::NAN; 1600],
        vec![f32::INFINITY; 1600],
        vec![1.1; 1600],
    ] {
        assert!(wav(&samples).is_err());
    }
}
#[tokio::test]
async fn local_reservations_cancel_before_claim_and_bind_owner_session_and_epoch() {
    let state = ready("https://voice.example");
    let id = state.begin("main", Some("session-one".into())).unwrap();
    assert!(state.begin("main", None).is_err());
    assert!(Work::claim(state.clone(), &id, "other", Some("session-one"), "en").is_err());
    assert!(Work::claim(state.clone(), &id, "main", Some("session-two"), "en").is_err());
    assert!(cancel(&state, &id, Some("main")).await.unwrap().cancelled);
    assert!(Work::claim(state.clone(), &id, "main", Some("session-one"), "en").is_err());
    let next = state.begin("main", None).unwrap();
    let _ = cancel(&state, &id, Some("main")).await.unwrap();
    assert_eq!(
        state.inner.lock().unwrap().active.as_ref().unwrap().id,
        next
    );
    state.destroy("other");
    assert!(state.inner.lock().unwrap().active.is_some());
    state.destroy("main");
    assert!(state.inner.lock().unwrap().active.is_none());
    assert!(
        state.begin("main", None).is_err(),
        "a queued begin cannot resurrect a destroyed recording owner"
    );
    let state = ready("https://voice.example");
    let id = state.begin("main", None).unwrap();
    state.changed().unwrap();
    assert!(Work::claim(state, &id, "main", None, "en").is_err());
}
#[tokio::test]
async fn expiry_and_configuration_guard_prevent_stale_or_mid_change_reservations() {
    let state = ready("https://voice.example");
    let old = state.begin("main", None).unwrap();
    state.inner.lock().unwrap().active.as_mut().unwrap().created =
        Instant::now() - Duration::from_secs(121);
    assert!(Work::claim(state.clone(), &old, "main", None, "en").is_err());
    let new = state.begin("main", None).unwrap();
    assert_ne!(old, new);
    state.signal(&new, None).unwrap();
    let _configuration = state.changing.lock().await;
    assert!(state.begin("main", None).is_err());
}
#[tokio::test]
async fn dropped_configuration_commit_retains_its_owned_guard_until_mutation_finishes() {
    let state = CloudState::default();
    let guard = state.changing.clone().lock_owned().await;
    let epoch = state.changed().unwrap();
    let (release, gate) = std::sync::mpsc::channel();
    let (started, ready) = oneshot::channel();
    let written = Arc::new(AtomicUsize::new(0));
    let committed = written.clone();
    let copy = state.clone();
    let task = tokio::spawn(async move {
        commit(
            copy,
            guard,
            epoch,
            Some(snapshot("https://voice.example")),
            move || {
                let _ = started.send(());
                let _ = gate.recv_timeout(Duration::from_secs(5));
                committed.store(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
    });
    ready.await.unwrap();
    task.abort();
    let _ = task.await;
    assert!(state.changing.try_lock().is_err());
    assert!(state.begin("main", None).is_err());
    release.send(()).unwrap();
    let guard = tokio::time::timeout(Duration::from_secs(3), state.changing.lock())
        .await
        .unwrap();
    assert_eq!(written.load(Ordering::SeqCst), 1);
    assert!(state.inner.lock().unwrap().verified.is_some());
    drop(guard);
}

#[tokio::test]
async fn cancellation_releases_recording_while_a_blocking_vault_read_stays_bounded() {
    let state = ready("https://voice.example");
    let id = state.begin("main", None).unwrap();
    let mut work = Work::claim(state.clone(), &id, "main", None, "en").unwrap();
    let scope = state.clone();
    let (release, gate) = std::sync::mpsc::channel();
    let (started, ready) = oneshot::channel();
    let task = tokio::spawn(async move {
        let loaded = credential(
            &mut work.cancel,
            vault(&scope, move || {
                let _ = started.send(());
                let _ = gate.recv_timeout(Duration::from_secs(5));
                Ok(())
            }),
        )
        .await;
        work.finish(
            loaded.and_then(|_| Err("fixture must not dispatch".into())),
            Cleanup::NotNeeded,
        )
    });
    ready.await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), cancel(&state, &id, Some("main")))
        .await
        .expect("local cancellation must not wait for the OS credential dialog")
        .unwrap();
    assert!(result.cancelled);
    assert!(matches!(result.cleanup, Cleanup::NotNeeded));
    assert!(state.inner.lock().unwrap().active.is_none());
    assert_eq!(
        state.vault_work.available_permits(),
        0,
        "the detached OS call still owns its bounded capacity"
    );
    assert!(
        vault(&state, || Ok(())).await.is_err(),
        "new credential work must fail busy while the old OS call remains blocked"
    );
    assert!(task.await.unwrap().is_err());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if state.vault_work.available_permits() == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

struct Backend {
    posts: AtomicUsize,
    puts: AtomicUsize,
    deletes: AtomicUsize,
    mode: AtomicUsize,
    entered: Semaphore,
    release: Semaphore,
    bodies: Mutex<Vec<Vec<u8>>>,
}
impl Default for Backend {
    fn default() -> Self {
        Self {
            posts: AtomicUsize::new(0),
            puts: AtomicUsize::new(0),
            deletes: AtomicUsize::new(0),
            mode: AtomicUsize::new(0),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            bodies: Mutex::new(Vec::new()),
        }
    }
}
async fn caps(ServerState(state): ServerState<Arc<Backend>>) -> Json<serde_json::Value> {
    let mut value = serde_json::to_value(capabilities()).unwrap();
    if state.mode.load(Ordering::SeqCst) == 1 {
        value["sampleRate"] = 44100.into();
    }
    Json(value)
}
async fn limits() -> Json<serde_json::Value> {
    Json(serde_json::json!({"schemaVersion":1,"quota":quota()}))
}
async fn register_job(
    ServerState(state): ServerState<Arc<Backend>>,
    request: Request,
) -> ServerResponse {
    assert_eq!(
        request.headers()[header::AUTHORIZATION],
        format!("Bearer {TOKEN}")
    );
    let body = to_bytes(request.into_body(), 1024).await.unwrap();
    let args: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(args["language"] == "pt" || args["language"] == "en");
    state.posts.fetch_add(1, Ordering::SeqCst);
    if state.mode.load(Ordering::SeqCst) == 2 {
        state.entered.add_permits(1);
        let _ = state.release.acquire().await;
    }
    let id = if state.mode.load(Ordering::SeqCst) == 3 {
        "../escape"
    } else {
        JOB
    };
    Json(serde_json::json!({"schemaVersion":1,"jobId":id,"uploadWithinSeconds":30})).into_response()
}
async fn upload(ServerState(state): ServerState<Arc<Backend>>, request: Request) -> ServerResponse {
    assert_eq!(
        request.headers()[header::AUTHORIZATION],
        format!("Bearer {TOKEN}")
    );
    assert_eq!(request.headers()[header::CONTENT_TYPE], "audio/wav");
    let body = to_bytes(request.into_body(), 960044).await.unwrap();
    assert_eq!(&body[..4], b"RIFF");
    assert_eq!(body.len(), 3244);
    state.bodies.lock().unwrap().push(body.to_vec());
    state.puts.fetch_add(1, Ordering::SeqCst);
    let mode = state.mode.load(Ordering::SeqCst);
    if mode == 4 {
        state.entered.add_permits(1);
        let _ = state.release.acquire().await;
    }
    if mode == 5 {
        return (StatusCode::TOO_MANY_REQUESTS, "PRIVATE_ERROR_BODY").into_response();
    }
    if mode == 6 {
        return (
            StatusCode::TEMPORARY_REDIRECT,
            [(header::LOCATION, "https://localhost:1/leak")],
            "PRIVATE_ERROR_BODY",
        )
            .into_response();
    }
    if mode == 7 {
        return (StatusCode::OK, "x".repeat(MAX_RESPONSE + 1)).into_response();
    }
    Json(serde_json::json!({"schemaVersion":1,"jobId":if mode==8 {TOKEN}else{JOB},"text":if mode==9 {"x".repeat(16385)}else{"fixture text".into()},"quota":quota()})).into_response()
}
async fn delete_job(ServerState(state): ServerState<Arc<Backend>>) -> StatusCode {
    state.deletes.fetch_add(1, Ordering::SeqCst);
    if state.mode.load(Ordering::SeqCst) == 10 {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::NO_CONTENT
    }
}
struct Fixture {
    origin: String,
    enrollment: Enrollment,
    client: Client,
    state: Arc<Backend>,
    backend: tokio::task::JoinHandle<()>,
    tls: tokio::task::JoinHandle<()>,
    stop: oneshot::Sender<()>,
}
impl Fixture {
    async fn new() -> Self {
        let state = Arc::new(Backend {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            ..Default::default()
        });
        let router = Router::new()
            .route("/v1/capabilities", get(caps))
            .route("/v1/quota", get(limits))
            .route("/v1/transcriptions", post(register_job))
            .route("/v1/transcriptions/{id}/audio", put(upload))
            .route("/v1/transcriptions/{id}", axum::routing::delete(delete_job))
            .with_state(state.clone());
        let front = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = front.local_addr().unwrap();
        let origin = format!("https://localhost:{}", address.port());
        let certificate = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let root = reqwest::Certificate::from_der(certificate.cert.der().as_ref()).unwrap();
        let config = ServerConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.cert.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                certificate.signing_key.serialize_der(),
            )),
        )
        .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel();
        let backend = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let tls = tokio::spawn(async move {
            let mut sockets = JoinSet::new();
            loop {
                tokio::select! {accepted=front.accept()=>{let Ok((socket,_))=accepted else{return;};let acceptor=acceptor.clone();sockets.spawn(async move{if let Ok(mut incoming)=acceptor.accept(socket).await{if let Ok(mut outgoing)=TcpStream::connect(destination).await{let _=copy_bidirectional(&mut incoming,&mut outgoing).await;}}});},_=sockets.join_next(),if !sockets.is_empty()=>{}}
            }
        });
        let client = Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .resolve("localhost", address)
            .add_root_certificate(root)
            .connect_timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        Self {
            enrollment: Enrollment {
                version: 1,
                origin: origin.clone(),
                token: TOKEN.into(),
            },
            origin,
            client,
            state,
            backend,
            tls,
            stop,
        }
    }
    async fn stop(self) {
        self.state.release.add_permits(10);
        let _ = self.stop.send(());
        self.tls.abort();
        let _ = self.tls.await;
        tokio::time::timeout(Duration::from_secs(3), self.backend)
            .await
            .unwrap()
            .unwrap();
    }
}
#[tokio::test]
async fn real_https_capabilities_and_quota_are_required_before_cloud_availability() {
    let fixture = Fixture::new().await;
    let snapshot = verify(&fixture.enrollment, &fixture.client).await.unwrap();
    assert_eq!(snapshot.origin, fixture.origin);
    assert_eq!(snapshot.capabilities.languages[2], "pt");
    assert_eq!(snapshot.quota.global_remaining_samples, 0);
    fixture.state.mode.store(1, Ordering::SeqCst);
    assert!(verify(&fixture.enrollment, &fixture.client).await.is_err());
    assert_eq!(fixture.state.posts.load(Ordering::SeqCst), 0);
    fixture.stop().await;
}
#[tokio::test]
async fn native_worker_uploads_canonical_wav_once_and_rejects_bad_results_without_echoing_remote_errors(
) {
    for mode in [0, 3, 5, 6, 7, 8, 9] {
        let fixture = Fixture::new().await;
        fixture.state.mode.store(mode, Ordering::SeqCst);
        let state = ready(&fixture.origin);
        let id = state.begin("main", None).unwrap();
        let mut work = Work::claim(state.clone(), &id, "main", None, "pt").unwrap();
        let (result, cleanup) = run(
            &mut work,
            fixture.enrollment.clone(),
            fixture.client.clone(),
            wav(&vec![0.0; 1600]).unwrap(),
            "pt".into(),
        )
        .await;
        let result = work.finish(result, cleanup);
        if mode == 0 {
            let value = result.unwrap();
            assert_eq!(value.text, "fixture text");
            assert_eq!(value.request_id, id);
            assert_eq!(fixture.state.deletes.load(Ordering::SeqCst), 0);
        } else {
            let error = result.err().unwrap();
            assert!(!error.contains("PRIVATE_ERROR_BODY"));
            assert_eq!(
                fixture.state.deletes.load(Ordering::SeqCst),
                if mode == 3 { 0 } else { 1 }
            );
        }
        assert_eq!(fixture.state.posts.load(Ordering::SeqCst), 1);
        assert_eq!(
            fixture.state.puts.load(Ordering::SeqCst),
            if mode == 3 { 0 } else { 1 }
        );
        assert!(state.inner.lock().unwrap().active.is_none());
        fixture.stop().await;
    }
}
#[tokio::test]
async fn cancellation_with_unknown_registration_never_uploads_and_known_job_deletes_same_origin() {
    for mode in [2, 4, 10] {
        let fixture = Fixture::new().await;
        fixture
            .state
            .mode
            .store(if mode == 10 { 4 } else { mode }, Ordering::SeqCst);
        let state = ready(&fixture.origin);
        let id = state.begin("main", None).unwrap();
        let mut work = Work::claim(state.clone(), &id, "main", None, "en").unwrap();
        let enrollment = fixture.enrollment.clone();
        let client = fixture.client.clone();
        let task = tokio::spawn(async move {
            let (result, cleanup) = run(
                &mut work,
                enrollment,
                client,
                wav(&vec![0.0; 1600]).unwrap(),
                "en".into(),
            )
            .await;
            work.finish(result, cleanup)
        });
        let _ = tokio::time::timeout(Duration::from_secs(3), fixture.state.entered.acquire())
            .await
            .unwrap()
            .unwrap();
        if mode == 10 {
            fixture.state.mode.store(10, Ordering::SeqCst);
        }
        let result = cancel(&state, &id, Some("main")).await.unwrap();
        assert!(result.cancelled);
        assert!(if mode == 4 {
            matches!(result.cleanup, Cleanup::Confirmed)
        } else {
            matches!(result.cleanup, Cleanup::Unconfirmed)
        });
        assert!(task.await.unwrap().is_err());
        assert_eq!(
            fixture.state.puts.load(Ordering::SeqCst),
            if mode == 2 { 0 } else { 1 }
        );
        assert_eq!(
            fixture.state.deletes.load(Ordering::SeqCst),
            if mode == 2 { 0 } else { 1 }
        );
        assert!(state.inner.lock().unwrap().active.is_none());
        fixture.stop().await;
    }
}
