#![cfg(unix)]
use super::*;
use axum::{body::Body, http::Request as HttpRequest};
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::net::TcpListener;
use tokio::{
    sync::{oneshot, Semaphore},
    task::JoinSet,
};
use tower::ServiceExt;

const ADMIN: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
fn config(path: PathBuf, d: u64, g: u64) -> Config {
    Config::new(path, ADMIN, "fixture-provider-key", d, g).unwrap()
}
fn wav(samples: usize) -> Vec<u8> {
    let mut bytes = lazysh_common::audio::pcm16_mono_16khz_header(samples as u32 * 2);
    bytes.resize(44 + samples * 2, 0x51);
    bytes
}
async fn request(
    service: &Service,
    method: &str,
    path: &str,
    token: &str,
    content: &str,
    body: impl Into<Body>,
) -> (StatusCode, serde_json::Value) {
    let response = service
        .router()
        .oneshot(
            HttpRequest::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, content)
                .body(body.into())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 131072).await.unwrap();
    let value = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}
async fn enroll_device(service: &Service) -> (String, String) {
    let (status, value) = request(
        service,
        "POST",
        "/v1/devices",
        ADMIN,
        "application/json",
        r#"{"label":"fixture phone"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    (
        value["device"]["id"].as_str().unwrap().into(),
        value["token"].as_str().unwrap().into(),
    )
}
async fn job(service: &Service, token: &str, language: &str) -> String {
    let (status, value) = request(
        service,
        "POST",
        "/v1/transcriptions",
        token,
        "application/json",
        serde_json::json!({"language":language}).to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value["jobId"].as_str().unwrap().into()
}
async fn assert_completed_quota(service: &Service, token: &str, samples: u64) {
    assert!(service.0.jobs.lock().unwrap().is_empty());
    assert_eq!(
        request(service, "GET", "/v1/quota", token, "application/json", "")
            .await
            .1["quota"]["deviceUsedSamples"],
        samples
    );
}
async fn connect_server(
    service: &Service,
) -> (
    oneshot::Sender<()>,
    tokio::task::JoinHandle<std::io::Result<()>>,
    tokio::net::TcpStream,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let running = service.clone();
    let server = tokio::spawn(serve(listener, running, async {
        let _ = stopped.await;
    }));
    let stream = tokio::net::TcpStream::connect(address).await.unwrap();
    (stop, server, stream)
}
#[test]
fn wav_contract_rejects_wrong_formats_lengths_and_extra_chunks() {
    assert_eq!(wav_samples(&wav(1600)).unwrap(), 1600);
    assert_eq!(wav_samples(&wav(480000)).unwrap(), 480000);
    for bytes in [wav(1599), wav(480001), vec![], b"RIFF".to_vec()] {
        assert!(wav_samples(&bytes).is_err());
    }
    for offset in [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40] {
        let mut bytes = wav(1600);
        bytes[offset] ^= 1;
        assert!(wav_samples(&bytes).is_err(), "offset={offset}");
    }
    let mut bytes = wav(1600);
    bytes.push(0);
    assert!(wav_samples(&bytes).is_err());
}
#[tokio::test]
async fn enrollment_auth_separation_revocation_and_pending_cancel_are_real() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(config(directory.path().join("state"), 10, 20)).unwrap();
    let (id, token) = enroll_device(&service).await;
    for (path, credential, status) in [
        ("/v1/devices", token.as_str(), StatusCode::FORBIDDEN),
        ("/v1/quota", ADMIN, StatusCode::FORBIDDEN),
        ("/v1/quota", "invalid", StatusCode::UNAUTHORIZED),
    ] {
        assert_eq!(
            request(&service, "GET", path, credential, "application/json", "")
                .await
                .0,
            status
        );
    }
    let first = job(&service, &token, "auto").await;
    let (_, other_token) = enroll_device(&service).await;
    let other_job = job(&service, &other_token, "auto").await;
    assert_eq!(
        request(
            &service,
            "DELETE",
            &format!("/v1/transcriptions/{first}"),
            &other_token,
            "application/json",
            ""
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &service,
            "PUT",
            &format!("/v1/transcriptions/{first}/audio"),
            &other_token,
            "audio/wav",
            wav(1600)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &service,
            "DELETE",
            &format!("/v1/transcriptions/{other_job}"),
            &other_token,
            "application/json",
            ""
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &service,
            "POST",
            "/v1/transcriptions",
            &token,
            "application/json",
            r#"{"language":"en"}"#
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &service,
            "DELETE",
            &format!("/v1/transcriptions/{first}"),
            &token,
            "application/json",
            ""
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &service,
            "PUT",
            &format!("/v1/transcriptions/{first}/audio"),
            &token,
            "audio/wav",
            wav(1600)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &service,
            "POST",
            "/v1/transcriptions",
            &token,
            "application/json",
            r#"{"language":"arbitrary-provider-option"}"#
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&service, "GET", "/v1/quota", &token, "application/json", "")
            .await
            .1["quota"]["deviceUsedSamples"],
        0
    );
    job(&service, &token, "pt").await;
    assert_eq!(
        request(
            &service,
            "DELETE",
            &format!("/v1/devices/{id}"),
            ADMIN,
            "application/json",
            ""
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert!(service.0.jobs.lock().unwrap().is_empty());
    assert_eq!(
        request(&service, "GET", "/v1/quota", &token, "application/json", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let raw = std::fs::read(directory.path().join("state/quota.sqlite3")).unwrap();
    assert!(!raw
        .windows(token.len())
        .any(|window| window == token.as_bytes()));
}
#[tokio::test]
async fn quotas_are_atomic_global_durable_and_clock_rollback_does_not_reset_them() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state");
    let service = Service::open(config(path.clone(), 1, 1)).unwrap();
    let (id, _) = enroll_device(&service).await;
    let (other, _) = enroll_device(&service).await;
    let mut workers = JoinSet::new();
    for _ in 0..16 {
        let service = service.clone();
        let id = id.clone();
        workers.spawn(async move {
            service
                .store(move |store| store.quota(&id, 100, 1600, 16000, 16000))
                .await
        });
    }
    let mut successes = 0;
    while let Some(result) = workers.join_next().await {
        match result.unwrap() {
            Ok(_) => successes += 1,
            Err(error) => assert_eq!(error.1, "quota_exceeded"),
        }
    }
    assert_eq!(successes, 10);
    let other_key = other.clone();
    assert_eq!(
        service
            .store(move |store| store.quota(&other_key, 100, 1600, 16000, 16000))
            .await
            .unwrap_err()
            .1,
        "quota_exceeded"
    );
    drop(service);
    let service = Service::open(config(path, 1, 1)).unwrap();
    let key = id.clone();
    let quota = service
        .store(move |store| store.quota(&key, 100, 0, 16000, 16000))
        .await
        .unwrap();
    assert_eq!(quota.device_used_samples, 16000);
    let key = id.clone();
    assert_eq!(
        service
            .store(move |store| store.quota(&key, 99, 1600, 16000, 16000))
            .await
            .unwrap_err()
            .1,
        "clock_rollback"
    );
    let quota = service
        .store(move |store| store.quota(&id, 101, 1600, 16000, 16000))
        .await
        .unwrap();
    assert_eq!(quota.device_used_samples, 1600);
    assert_eq!(quota.global_used_samples, 1600);
}

#[derive(Default)]
struct Upstream {
    whisper: bool,
    requests: AtomicUsize,
    mode: AtomicUsize,
    bodies: Mutex<Vec<Vec<u8>>>,
}
async fn provider(State(state): State<Arc<Upstream>>, request: Request) -> Response {
    if state.whisper {
        assert!(!request.headers().contains_key(header::AUTHORIZATION));
    } else {
        assert_eq!(
            request.headers()[header::AUTHORIZATION],
            "Bearer fixture-provider-key"
        );
    }
    let body = to_bytes(request.into_body(), MAX_WAV + 4096).await.unwrap();
    state.bodies.lock().unwrap().push(body.to_vec());
    state.requests.fetch_add(1, Ordering::SeqCst);
    match state.mode.load(Ordering::SeqCst) {
        1 => (
            StatusCode::TEMPORARY_REDIRECT,
            [(header::LOCATION, "http://127.0.0.1:1/secret")],
            "private upstream error",
        )
            .into_response(),
        2 => (StatusCode::INTERNAL_SERVER_ERROR, "private upstream error").into_response(),
        3 => (StatusCode::OK, "x".repeat(65537)).into_response(),
        4 => (StatusCode::OK, r#"{"text":true}"#).into_response(),
        5 => (
            StatusCode::OK,
            serde_json::json!({"text":"x".repeat(16385)}).to_string(),
        )
            .into_response(),
        _ => Json(serde_json::json!({"text":"fixture transcript"})).into_response(),
    }
}
async fn provider_service(
    directory: &std::path::Path,
) -> (Service, Arc<Upstream>, tokio::task::JoinHandle<()>) {
    provider_service_for(directory, false).await
}
async fn provider_service_for(
    directory: &std::path::Path,
    whisper: bool,
) -> (Service, Arc<Upstream>, tokio::task::JoinHandle<()>) {
    let upstream = Arc::new(Upstream {
        whisper,
        ..Upstream::default()
    });
    let router = Router::new()
        .route("/v1/audio/transcriptions", post(provider))
        .route("/inference", post(provider))
        .with_state(upstream.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/audio/transcriptions",
        listener.local_addr().unwrap()
    );
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let configuration = if whisper {
        Config::whisper_cpp(
            directory.join("state"),
            ADMIN,
            port.try_into().unwrap(),
            100,
            200,
        )
        .unwrap()
    } else {
        config(directory.join("state"), 100, 200)
    };
    let mut service = Service::open(configuration).unwrap();
    if !whisper {
        Arc::get_mut(&mut service.0).unwrap().provider.endpoint = endpoint;
    }
    (service, upstream, task)
}
#[tokio::test]
async fn provider_contract_language_bounds_no_redirect_retry_or_transcript_persistence() {
    for whisper in [false, true] {
        check_provider_contract(whisper).await;
    }
}
async fn check_provider_contract(whisper: bool) {
    let directory = tempfile::tempdir().unwrap();
    let (service, upstream, task) = provider_service_for(directory.path(), whisper).await;
    let (_, token) = enroll_device(&service).await;
    let capabilities = request(
        &service,
        "GET",
        "/v1/capabilities",
        &token,
        "application/json",
        "",
    )
    .await;
    assert_eq!(
        capabilities.1["model"],
        if whisper {
            "whisper.cpp"
        } else {
            "gpt-transcribe"
        }
    );
    for mode in 0..=5 {
        upstream.mode.store(mode, Ordering::SeqCst);
        let id = job(&service, &token, if mode == 0 { "pt" } else { "auto" }).await;
        let (status, value) = request(
            &service,
            "PUT",
            &format!("/v1/transcriptions/{id}/audio"),
            &token,
            "audio/wav",
            wav(1600),
        )
        .await;
        assert_eq!(
            status,
            if mode == 0 {
                StatusCode::OK
            } else {
                StatusCode::BAD_GATEWAY
            },
            "{value}"
        );
        if mode == 0 {
            assert_eq!(value["text"], "fixture transcript");
        } else {
            assert!(!value.to_string().contains("private upstream error"));
        }
        assert_eq!(upstream.requests.load(Ordering::SeqCst), mode + 1);
        assert_eq!(service.0.providers.available_permits(), 4);
        assert!(service.0.jobs.lock().unwrap().is_empty());
    }
    {
        let bodies = upstream.bodies.lock().unwrap();
        let first = String::from_utf8_lossy(&bodies[0]);
        for required in [
            "name=\"file\"; filename=\"dictation.wav\"",
            "name=\"response_format\"\r\n\r\njson",
            "name=\"language\"\r\n\r\npt",
        ] {
            assert!(first.contains(required), "missing {required}");
        }
        assert_eq!(
            first.contains("name=\"model\"\r\n\r\ngpt-transcribe"),
            !whisper
        );
        let automatic = String::from_utf8_lossy(&bodies[1]);
        assert_eq!(automatic.contains("name=\"language\""), whisper);
        if whisper {
            assert!(!first.contains("name=\"model\""));
            assert!(automatic.contains("name=\"language\"\r\n\r\nauto"));
        }
    }
    let quota = request(&service, "GET", "/v1/quota", &token, "application/json", "")
        .await
        .1;
    assert_eq!(quota["quota"]["deviceUsedSamples"], 9600);
    drop(service);
    task.abort();
    let _ = task.await;
    for entry in std::fs::read_dir(directory.path().join("state")).unwrap() {
        let raw = std::fs::read(entry.unwrap().path()).unwrap();
        for hidden in ["fixture transcript", "fixture-provider-key", token.as_str()] {
            assert!(!raw
                .windows(hidden.len())
                .any(|window| window == hidden.as_bytes()));
        }
        assert!(!raw.windows(100).any(|window| window == [0x51; 100]));
    }
}

#[tokio::test]
async fn http_quota_rejection_never_calls_provider_and_revocation_keeps_global_usage() {
    let directory = tempfile::tempdir().unwrap();
    let (mut service, upstream, task) = provider_service(directory.path()).await;
    let inner = Arc::get_mut(&mut service.0).unwrap();
    inner.device_limit = 16000;
    inner.global_limit = 16000;
    let (device, token) = enroll_device(&service).await;
    for (samples, status, expected_requests) in [
        (16001, StatusCode::TOO_MANY_REQUESTS, 0),
        (16000, StatusCode::OK, 1),
        (1600, StatusCode::TOO_MANY_REQUESTS, 1),
    ] {
        let id = job(&service, &token, "auto").await;
        assert_eq!(
            request(
                &service,
                "PUT",
                &format!("/v1/transcriptions/{id}/audio"),
                &token,
                "audio/wav",
                wav(samples)
            )
            .await
            .0,
            status
        );
        assert_eq!(upstream.requests.load(Ordering::SeqCst), expected_requests);
    }
    assert_eq!(
        request(
            &service,
            "DELETE",
            &format!("/v1/devices/{device}"),
            ADMIN,
            "application/json",
            ""
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (_, other) = enroll_device(&service).await;
    let id = job(&service, &other, "auto").await;
    assert_eq!(
        request(
            &service,
            "PUT",
            &format!("/v1/transcriptions/{id}/audio"),
            &other,
            "audio/wav",
            wav(1600)
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let quota = request(&service, "GET", "/v1/quota", &other, "application/json", "")
        .await
        .1;
    assert_eq!(quota["quota"]["deviceUsedSamples"], 0);
    assert_eq!(quota["quota"]["globalUsedSamples"], 16000);
    assert_eq!(quota["quota"]["globalRemainingSamples"], 0);
    assert_eq!(upstream.requests.load(Ordering::SeqCst), 1);
    task.abort();
    let _ = task.await;
}

async fn stalled_upstream(
    directory: &std::path::Path,
    response_started: bool,
) -> (
    Service,
    Arc<Semaphore>,
    oneshot::Receiver<()>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/audio/transcriptions",
        listener.local_addr().unwrap()
    );
    let entered = Arc::new(Semaphore::new(0));
    let permit = entered.clone();
    let (closed, closure) = oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut raw = Vec::new();
        let mut chunk = [0; 4096];
        let mut length = None;
        loop {
            let read = stream.read(&mut chunk).await.unwrap();
            assert!(read > 0);
            raw.extend_from_slice(&chunk[..read]);
            if length.is_none() {
                if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&raw[..end]);
                    let size = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap();
                    length = Some(end + 4 + size);
                }
            }
            if length.is_some_and(|size| raw.len() >= size) {
                break;
            }
        }
        if response_started {
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nContent-Type: application/json\r\n\r\n{\"text\":\"").await.unwrap();
        }
        permit.add_permits(1);
        let read = stream.read(&mut chunk).await.unwrap_or(0);
        assert_eq!(read, 0);
        let _ = closed.send(());
    });
    let mut service = Service::open(config(directory.join("state"), 100, 200)).unwrap();
    Arc::get_mut(&mut service.0).unwrap().provider.endpoint = endpoint;
    (service, entered, closure, task)
}
#[tokio::test]
async fn cancel_and_revoke_abort_real_upstream_wait_without_refunding_dispatched_audio() {
    for (revoke_device, response_started, whisper) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (false, false, true),
        (true, false, true),
        (false, true, true),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let (mut service, entered, closed, upstream) =
            stalled_upstream(directory.path(), response_started).await;
        if whisper {
            Arc::get_mut(&mut service.0).unwrap().provider.key = None;
        }
        let (device, token) = enroll_device(&service).await;
        let id = job(&service, &token, "en").await;
        let copy = service.clone();
        let key = token.clone();
        let path = format!("/v1/transcriptions/{id}/audio");
        let request_task = tokio::spawn(async move {
            request(&copy, "PUT", &path, &key, "audio/wav", wav(1600)).await
        });
        let _ = timeout(Duration::from_secs(3), entered.acquire())
            .await
            .unwrap()
            .unwrap();
        let (path, key) = if revoke_device {
            (format!("/v1/devices/{device}"), ADMIN)
        } else {
            (format!("/v1/transcriptions/{id}"), token.as_str())
        };
        assert_eq!(
            request(&service, "DELETE", &path, key, "application/json", "")
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        let result = timeout(Duration::from_secs(3), request_task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.1["error"], "cancelled");
        timeout(Duration::from_secs(3), closed)
            .await
            .unwrap()
            .unwrap();
        upstream.await.unwrap();
        assert_eq!(service.0.providers.available_permits(), 4);
        let global = service.0.store.lock().unwrap().devices().unwrap();
        assert_eq!(global.len(), if revoke_device { 0 } else { 1 });
        if !revoke_device {
            assert_eq!(
                request(&service, "GET", "/v1/quota", &token, "application/json", "")
                    .await
                    .1["quota"]["deviceUsedSamples"],
                1600
            );
        }
    }
}

#[tokio::test]
async fn invalid_oversized_expired_or_capacity_rejected_uploads_never_reach_provider_or_consume_quota(
) {
    let directory = tempfile::tempdir().unwrap();
    let (service, upstream, task) = provider_service(directory.path()).await;
    let (_, token) = enroll_device(&service).await;
    for (content, bytes, status) in [
        (
            "audio/wav",
            vec![0; MAX_WAV + 1],
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        ("audio/wav", b"not audio".to_vec(), StatusCode::BAD_REQUEST),
        (
            "application/octet-stream",
            wav(1600),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
    ] {
        let id = job(&service, &token, "auto").await;
        assert_eq!(
            request(
                &service,
                "PUT",
                &format!("/v1/transcriptions/{id}/audio"),
                &token,
                content,
                bytes
            )
            .await
            .0,
            status
        );
    }
    let id = job(&service, &token, "auto").await;
    service
        .0
        .jobs
        .lock()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()
        .created = Instant::now() - Duration::from_secs(31);
    assert_eq!(
        request(
            &service,
            "PUT",
            &format!("/v1/transcriptions/{id}/audio"),
            &token,
            "audio/wav",
            wav(1600)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let id = job(&service, &token, "auto").await;
    let permit = service
        .0
        .providers
        .clone()
        .acquire_many_owned(4)
        .await
        .unwrap();
    assert_eq!(
        request(
            &service,
            "PUT",
            &format!("/v1/transcriptions/{id}/audio"),
            &token,
            "audio/wav",
            wav(1600)
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    drop(permit);
    assert_eq!(upstream.requests.load(Ordering::SeqCst), 0);
    assert_completed_quota(&service, &token, 0).await;
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn oversized_or_malformed_control_json_is_redacted_and_device_limit_is_real() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(config(directory.path().join("state"), 1, 2)).unwrap();
    for body in [
        r#"{"AUDIO_SECRET_MARKER":true}"#.to_owned(),
        serde_json::json!({"label":"AUDIO_SECRET_MARKER".repeat(1000)}).to_string(),
    ] {
        let result = request(
            &service,
            "POST",
            "/v1/devices",
            ADMIN,
            "application/json",
            body,
        )
        .await;
        assert_eq!(result.0, StatusCode::BAD_REQUEST);
        assert_eq!(result.1["error"], "invalid_request");
        assert!(!result.1.to_string().contains("AUDIO_SECRET_MARKER"));
    }
    for _ in 0..128 {
        enroll_device(&service).await;
    }
    assert_eq!(
        request(
            &service,
            "POST",
            "/v1/devices",
            ADMIN,
            "application/json",
            r#"{"label":"overflow"}"#
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &service,
            "GET",
            "/v1/devices",
            ADMIN,
            "application/json",
            ""
        )
        .await
        .1["devices"]
            .as_array()
            .unwrap()
            .len(),
        128
    );
}

#[tokio::test]
async fn partial_upload_cancellation_cleans_job_without_a_quota_debit() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(config(directory.path().join("state"), 1, 2)).unwrap();
    let (_, token) = enroll_device(&service).await;
    let id = job(&service, &token, "auto").await;
    let (stop, server, mut stream) = connect_server(&service).await;
    stream.write_all(format!("PUT /v1/transcriptions/{id}/audio HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: audio/wav\r\nContent-Length: 3244\r\n\r\nRIFF").as_bytes()).await.unwrap();
    timeout(Duration::from_secs(3), async {
        loop {
            if service.0.providers.available_permits() == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        request(
            &service,
            "DELETE",
            &format!("/v1/transcriptions/{id}"),
            &token,
            "application/json",
            ""
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let mut response = [0; 4096];
    let count = timeout(Duration::from_secs(3), stream.read(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&response[..count]).contains("409 Conflict"));
    assert_eq!(service.0.providers.available_permits(), 4);
    assert_completed_quota(&service, &token, 0).await;
    let _ = stop.send(());
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn real_client_disconnect_and_server_shutdown_release_upstream_resources() {
    use tokio::io::AsyncWriteExt;
    for disconnect in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let (service, entered, closed, upstream) = stalled_upstream(directory.path(), false).await;
        let (_, token) = enroll_device(&service).await;
        let id = job(&service, &token, "auto").await;
        let (stop, server, mut stream) = connect_server(&service).await;
        let bytes = wav(1600);
        stream.write_all(format!("PUT /v1/transcriptions/{id}/audio HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\n\r\n",bytes.len()).as_bytes()).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        let _ = timeout(Duration::from_secs(3), entered.acquire())
            .await
            .unwrap()
            .unwrap();
        if disconnect {
            drop(stream);
            timeout(Duration::from_secs(3), closed)
                .await
                .unwrap()
                .unwrap();
            let _ = stop.send(());
        } else {
            let _ = stop.send(());
            timeout(Duration::from_secs(3), closed)
                .await
                .unwrap()
                .unwrap();
        }
        server.await.unwrap().unwrap();
        upstream.await.unwrap();
        assert_eq!(service.0.providers.available_permits(), 4);
        assert!(service.0.jobs.lock().unwrap().is_empty());
    }
}

#[cfg(unix)]
#[test]
fn private_state_and_secret_files_refuse_links_public_permissions_and_special_files() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("key");
    std::fs::write(&key, "fixture-key").unwrap();
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(read_secret(&key).unwrap().as_str(), "fixture-key");
    let link = dir.path().join("link");
    symlink(&key, &link).unwrap();
    assert!(read_secret(&link).is_err());
    let hard = dir.path().join("hard");
    std::fs::hard_link(&key, &hard).unwrap();
    assert!(read_secret(&key).is_err());
    std::fs::remove_file(&hard).unwrap();
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_secret(&key).is_err());
    let state = dir.path().join("state");
    std::fs::create_dir(&state).unwrap();
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&key, state.join("quota.sqlite3")).unwrap();
    assert!(Service::open(config(state.clone(), 1, 2)).is_err());
    std::fs::remove_file(state.join("quota.sqlite3")).unwrap();
    let service = Service::open(config(state.clone(), 1, 2)).unwrap();
    for _ in 0..3 {
        assert!(Service::open(config(state.clone(), 1, 2)).is_err());
    }
    drop(service);
    assert_eq!(std::fs::read_to_string(key).unwrap(), "fixture-key");
}

#[tokio::test]
async fn provider_deadline_covers_header_and_body_wait_and_keeps_debited_quota() {
    for response_started in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (service, entered, closed, upstream) =
            stalled_upstream(directory.path(), response_started).await;
        let (_, token) = enroll_device(&service).await;
        let id = job(&service, &token, "auto").await;
        let copy = service.clone();
        let credential = token.clone();
        let task = tokio::spawn(async move {
            request(
                &copy,
                "PUT",
                &format!("/v1/transcriptions/{id}/audio"),
                &credential,
                "audio/wav",
                wav(1600),
            )
            .await
        });
        let _ = timeout(Duration::from_secs(3), entered.acquire())
            .await
            .unwrap()
            .unwrap();
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(46)).await;
        tokio::time::resume();
        let result = timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.0, StatusCode::BAD_GATEWAY);
        assert_eq!(result.1["error"], "provider_unavailable");
        timeout(Duration::from_secs(3), closed)
            .await
            .unwrap()
            .unwrap();
        upstream.await.unwrap();
        assert_eq!(service.0.providers.available_permits(), 4);
        assert_completed_quota(&service, &token, 1600).await;
    }
}

struct BlockedStore {
    release: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl BlockedStore {
    fn new(service: Service) -> Self {
        let (release, gate) = std::sync::mpsc::channel();
        let (ready, started) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let _store = service.0.store.lock().unwrap();
            ready.send(()).unwrap();
            let _ = gate.recv_timeout(Duration::from_secs(10));
        });
        started.recv_timeout(Duration::from_secs(3)).unwrap();
        Self {
            release: Some(release),
            thread: Some(thread),
        }
    }
    fn release(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
impl Drop for BlockedStore {
    fn drop(&mut self) {
        self.release();
    }
}
async fn first_poll<F: Future>(future: F, started: oneshot::Sender<()>) -> F::Output {
    tokio::pin!(future);
    let mut started = Some(started);
    std::future::poll_fn(|context| {
        let result = future.as_mut().poll(context);
        if let Some(started) = started.take() {
            let _ = started.send(());
        }
        result
    })
    .await
}

#[tokio::test]
async fn dropped_database_callers_retain_owned_work_capacity_until_blocking_tasks_finish() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(config(directory.path().join("state"), 1, 2)).unwrap();
    let mut blocked = BlockedStore::new(service.clone());
    let mut callers = Vec::new();
    for _ in 0..4 {
        let copy = service.clone();
        let (send, ready) = oneshot::channel();
        callers.push(tokio::spawn(async move {
            first_poll(copy.store(|_| Ok(())), send).await
        }));
        ready.await.unwrap();
    }
    for caller in callers {
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
    }
    assert_eq!(
        service.0.store_work.available_permits(),
        0,
        "blocking work must retain its own capacity after callers disappear"
    );
    let copy = service.clone();
    let (send, ready) = oneshot::channel();
    let fifth = tokio::spawn(async move { first_poll(copy.store(|_| Ok(())), send).await });
    ready.await.unwrap();
    assert!(
        !fifth.is_finished(),
        "work beyond the blocking budget must wait asynchronously"
    );
    fifth.abort();
    let _ = fifth.await;
    blocked.release();
    timeout(Duration::from_secs(3), async {
        loop {
            if service.0.store_work.available_permits() == 4 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn dropped_revoke_handler_cannot_commit_deletion_without_cancelling_the_job() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(config(directory.path().join("state"), 1, 2)).unwrap();
    let (id, token) = enroll_device(&service).await;
    job(&service, &token, "auto").await;
    let cancellation = service
        .0
        .jobs
        .lock()
        .unwrap()
        .get(&id)
        .unwrap()
        .cancel
        .subscribe();
    let mut blocked = BlockedStore::new(service.clone());
    let copy = service.clone();
    let (send, ready) = oneshot::channel();
    let task = tokio::spawn(async move {
        first_poll(
            revoke(State(copy), Extension(Identity::Admin), Path(id)),
            send,
        )
        .await
    });
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(
        service.0.admission.try_lock().is_err(),
        "queued revocation must retain admission after its caller drops"
    );
    blocked.release();
    timeout(Duration::from_secs(3), async {
        loop {
            let key = token.clone();
            if service
                .store(move |store| store.authenticate(&key))
                .await
                .unwrap()
                .is_none()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        *cancellation.borrow(),
        "a committed revocation must cancel its existing job even after its HTTP caller disappears"
    );
    assert!(service.0.jobs.lock().unwrap().is_empty());
}
