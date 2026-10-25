mod storage;

use axum::{
    body::to_bytes,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{watch, Semaphore},
    task::JoinSet,
    time::timeout,
};
use zeroize::Zeroizing;

pub use storage::read_secret;
pub const MAX_WAV: usize = 960_044;
const LANGUAGES: &[&str] = &["auto", "en", "es", "fr", "de", "pt", "ja", "zh"];
const ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
pub fn secret() -> String {
    rand::random::<[u8; 32]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
fn day() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86400
}

pub struct Config {
    directory: PathBuf,
    admin_hash: [u8; 32],
    provider_key: HeaderValue,
    device_limit: u64,
    global_limit: u64,
}
impl Config {
    pub fn new(
        directory: PathBuf,
        admin: &str,
        provider_key: &str,
        device_seconds: u64,
        global_seconds: u64,
    ) -> Result<Self, String> {
        if !valid_token(admin) {
            return Err("Admin token must contain 64 hexadecimal characters".into());
        }
        if !(1..=86400).contains(&device_seconds)
            || global_seconds == 0
            || global_seconds > 86400 * 128
        {
            return Err("Require positive daily audio quotas within the supported bounds".into());
        }
        if provider_key.is_empty()
            || provider_key.len() > 512
            || !provider_key.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err("Invalid provider key".into());
        }
        let mut provider_key = HeaderValue::from_str(&format!("Bearer {provider_key}"))
            .map_err(|_| "Invalid provider key")?;
        provider_key.set_sensitive(true);
        Ok(Self {
            directory,
            admin_hash: digest(admin),
            provider_key,
            device_limit: device_seconds * 16000,
            global_limit: global_seconds * 16000,
        })
    }
}
#[derive(Debug)]
pub(crate) struct ApiError(StatusCode, &'static str);
impl ApiError {
    fn storage() -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, "storage_unavailable")
    }
    fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "unauthorized")
    }
    fn cancelled() -> Self {
        Self(StatusCode::CONFLICT, "cancelled")
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(_: rusqlite::Error) -> Self {
        Self::storage()
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.0,
            Json(serde_json::json!({"schemaVersion":1,"error":self.1})),
        )
            .into_response();
        if self.0 == StatusCode::UNAUTHORIZED {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        response
    }
}
#[derive(Serialize)]
pub(crate) struct Device {
    id: String,
    label: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Quota {
    window_start: u64,
    window_end: u64,
    device_limit_samples: u64,
    device_used_samples: u64,
    device_remaining_samples: u64,
    global_limit_samples: u64,
    global_used_samples: u64,
    global_remaining_samples: u64,
}
struct Job {
    id: String,
    created: Instant,
    started: bool,
    language: String,
    cancel: watch::Sender<bool>,
}
struct Inner {
    store: Mutex<storage::Store>,
    admin_hash: [u8; 32],
    provider: Provider,
    device_limit: u64,
    global_limit: u64,
    jobs: Mutex<HashMap<String, Job>>,
    admission: Arc<tokio::sync::Mutex<()>>,
    providers: Arc<Semaphore>,
    store_work: Arc<Semaphore>,
}
#[derive(Clone)]
pub struct Service(Arc<Inner>);
impl Service {
    pub fn open(config: Config) -> Result<Self, String> {
        let store = storage::Store::open(&config)?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| "Cannot initialize provider transport")?;
        Ok(Self(Arc::new(Inner {
            store: Mutex::new(store),
            admin_hash: config.admin_hash,
            provider: Provider {
                client,
                key: config.provider_key,
                endpoint: ENDPOINT.into(),
            },
            device_limit: config.device_limit,
            global_limit: config.global_limit,
            jobs: Mutex::new(HashMap::new()),
            admission: Arc::new(tokio::sync::Mutex::new(())),
            providers: Arc::new(Semaphore::new(4)),
            store_work: Arc::new(Semaphore::new(4)),
        })))
    }
    async fn store<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut storage::Store) -> Result<T, ApiError> + Send + 'static,
    ) -> Result<T, ApiError> {
        let permit = self
            .0
            .store_work
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ApiError::storage())?;
        let service = self.clone();
        tokio::task::spawn_blocking(move || {
            // Detached DB work keeps its capacity even if its HTTP caller drops.
            let _permit = permit;
            let mut store = service.0.store.lock().map_err(|_| ApiError::storage())?;
            f(&mut store)
        })
        .await
        .map_err(|_| ApiError::storage())?
    }
    pub fn router(&self) -> Router {
        Router::new()
            .route(
                "/v1/devices",
                post(enroll).get(devices).layer(DefaultBodyLimit::max(4096)),
            )
            .route("/v1/devices/{id}", axum::routing::delete(revoke))
            .route("/v1/capabilities", get(capabilities))
            .route("/v1/quota", get(quota))
            .route(
                "/v1/transcriptions",
                post(register).layer(DefaultBodyLimit::max(1024)),
            )
            .route("/v1/transcriptions/{id}/audio", put(transcribe))
            .route("/v1/transcriptions/{id}", axum::routing::delete(cancel))
            .layer(middleware::from_fn_with_state(self.clone(), authenticate))
            .layer(middleware::from_fn(bounds))
            .with_state(self.clone())
    }
    fn cancel_all(&self) {
        if let Ok(mut jobs) = self.0.jobs.lock() {
            for job in jobs.values() {
                let _ = job.cancel.send(true);
            }
            jobs.clear();
        }
    }
}
#[derive(Clone)]
enum Identity {
    Admin,
    Device(String),
}
fn device(identity: Identity) -> Result<String, ApiError> {
    match identity {
        Identity::Device(id) => Ok(id),
        _ => Err(ApiError(StatusCode::FORBIDDEN, "device_token_required")),
    }
}
fn admin(identity: Identity) -> Result<(), ApiError> {
    match identity {
        Identity::Admin => Ok(()),
        _ => Err(ApiError(StatusCode::FORBIDDEN, "admin_token_required")),
    }
}
async fn authenticate(
    State(service): State<Service>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| valid_token(value))
        .ok_or_else(ApiError::unauthorized)?;
    let identity = if digest(token).ct_eq(&service.0.admin_hash).unwrap_u8() == 1 {
        Identity::Admin
    } else {
        let token = Zeroizing::new(token.to_owned());
        Identity::Device(
            service
                .store(move |store| store.authenticate(&token))
                .await?
                .ok_or_else(ApiError::unauthorized)?,
        )
    };
    request.extensions_mut().insert(identity);
    Ok(next.run(request).await)
}
async fn bounds(request: Request, next: Next) -> Response {
    let mut response = match timeout(Duration::from_secs(60), next.run(request)).await {
        Ok(response) => response,
        Err(_) => ApiError(StatusCode::REQUEST_TIMEOUT, "request_timeout").into_response(),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Label {
    label: String,
}
async fn enroll(
    State(service): State<Service>,
    Extension(identity): Extension<Identity>,
    payload: Result<Json<Label>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    admin(identity)?;
    let Json(label) = payload.map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_request"))?;
    if label.label.trim().is_empty()
        || label.label.len() > 64
        || label.label.chars().any(char::is_control)
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_label"));
    }
    let _admission = service.0.admission.lock().await;
    let (device, token) = service
        .store(move |store| store.enroll(&label.label))
        .await?;
    Ok(Json(
        serde_json::json!({"schemaVersion":1,"device":device,"token":token}),
    ))
}
async fn devices(
    State(service): State<Service>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<serde_json::Value>, ApiError> {
    admin(identity)?;
    let devices = service.store(|store| store.devices()).await?;
    Ok(Json(
        serde_json::json!({"schemaVersion":1,"devices":devices}),
    ))
}
async fn revoke(
    State(service): State<Service>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    admin(identity)?;
    if !valid_token(&id) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_device"));
    }
    let admission = service.0.admission.clone().lock_owned().await;
    let cancellation = service.clone();
    service
        .store(move |store| {
            // Cancellation cannot split durable revocation from live job cleanup or
            // release admission while a previous register could still insert a job.
            let _admission = admission;
            store.revoke(&id)?;
            if let Some(job) = cancellation
                .0
                .jobs
                .lock()
                .map_err(|_| ApiError::storage())?
                .remove(&id)
            {
                let _ = job.cancel.send(true);
            }
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn capabilities(
    Extension(identity): Extension<Identity>,
) -> Result<Json<serde_json::Value>, ApiError> {
    device(identity)?;
    Ok(Json(
        serde_json::json!({"schemaVersion":1,"model":"gpt-transcribe","languages":LANGUAGES,"maxWavBytes":MAX_WAV,"sampleRate":16000,"maxSamples":480000}),
    ))
}
async fn quota(
    State(service): State<Service>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let id = device(identity)?;
    let d = service.0.device_limit;
    let g = service.0.global_limit;
    let quota = service
        .store(move |store| store.quota(&id, day(), 0, d, g))
        .await?;
    Ok(Json(serde_json::json!({"schemaVersion":1,"quota":quota})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Register {
    language: String,
}
async fn register(
    State(service): State<Service>,
    Extension(identity): Extension<Identity>,
    payload: Result<Json<Register>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let device = device(identity)?;
    let Json(args) = payload.map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_request"))?;
    if !LANGUAGES.contains(&args.language.as_str()) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "unsupported_language"));
    }
    let _admission = service.0.admission.lock().await;
    let key = device.clone();
    let d = service.0.device_limit;
    let g = service.0.global_limit;
    service
        .store(move |store| store.quota(&key, day(), 0, d, g))
        .await?;
    let mut jobs = service.0.jobs.lock().map_err(|_| ApiError::storage())?;
    if let Some(job) = jobs.get(&device) {
        if job.started || job.created.elapsed() < Duration::from_secs(30) {
            return Err(ApiError(StatusCode::CONFLICT, "job_active"));
        }
    }
    let id = secret();
    let (cancel, _) = watch::channel(false);
    jobs.insert(
        device,
        Job {
            id: id.clone(),
            created: Instant::now(),
            started: false,
            language: args.language,
            cancel,
        },
    );
    Ok(Json(
        serde_json::json!({"schemaVersion":1,"jobId":id,"uploadWithinSeconds":30}),
    ))
}
async fn cancel(
    State(service): State<Service>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let device = device(identity)?;
    let mut jobs = service.0.jobs.lock().map_err(|_| ApiError::storage())?;
    if jobs.get(&device).is_none_or(|job| job.id != id) {
        return Err(ApiError(StatusCode::NOT_FOUND, "job_not_found"));
    }
    if let Some(job) = jobs.remove(&device) {
        let _ = job.cancel.send(true);
    }
    Ok(StatusCode::NO_CONTENT)
}
struct JobGuard {
    service: Service,
    device: String,
    id: String,
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.service.0.jobs.lock() {
            if jobs.get(&self.device).is_some_and(|job| job.id == self.id) {
                if let Some(job) = jobs.remove(&self.device) {
                    let _ = job.cancel.send(true);
                }
            }
        }
    }
}
async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    if !*cancel.borrow() {
        let _ = cancel.changed().await;
    }
}
fn wav_samples(bytes: &[u8]) -> Result<u64, ApiError> {
    let bad = || ApiError(StatusCode::BAD_REQUEST, "invalid_wav");
    if bytes.len() < 3244 || bytes.len() > MAX_WAV || !bytes.len().is_multiple_of(2) {
        return Err(bad());
    }
    let u16_at = |offset| u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap());
    let u32_at = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    if &bytes[..4] != b"RIFF"
        || &bytes[8..16] != b"WAVEfmt "
        || u32_at(4) as usize != bytes.len() - 8
        || u32_at(16) != 16
        || u16_at(20) != 1
        || u16_at(22) != 1
        || u32_at(24) != 16000
        || u32_at(28) != 32000
        || u16_at(32) != 2
        || u16_at(34) != 16
        || &bytes[36..40] != b"data"
        || u32_at(40) as usize != bytes.len() - 44
    {
        return Err(bad());
    }
    Ok(((bytes.len() - 44) / 2) as u64)
}
async fn transcribe(
    State(service): State<Service>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Json<serde_json::Value>, ApiError> {
    let device = device(identity)?;
    let (mut cancel, language) = {
        let mut jobs = service.0.jobs.lock().map_err(|_| ApiError::storage())?;
        let job = jobs
            .get_mut(&device)
            .filter(|job| job.id == id)
            .ok_or(ApiError(StatusCode::NOT_FOUND, "job_not_found"))?;
        if job.started {
            return Err(ApiError(StatusCode::CONFLICT, "job_started"));
        }
        if job.created.elapsed() >= Duration::from_secs(30) {
            jobs.remove(&device);
            return Err(ApiError(StatusCode::NOT_FOUND, "job_expired"));
        }
        job.started = true;
        (job.cancel.subscribe(), job.language.clone())
    };
    let _job = JobGuard {
        service: service.clone(),
        device: device.clone(),
        id: id.clone(),
    };
    let _permit = service
        .0
        .providers
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy"))?;
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("audio/wav")
    {
        return Err(ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "audio_wav_required",
        ));
    }
    let bytes = tokio::select! { biased;
        _=cancelled(&mut cancel)=>return Err(ApiError::cancelled()),
        result=timeout(Duration::from_secs(10),to_bytes(request.into_body(),MAX_WAV))=>result.map_err(|_|ApiError(StatusCode::REQUEST_TIMEOUT,"upload_timeout"))?.map_err(|_|ApiError(StatusCode::PAYLOAD_TOO_LARGE,"audio_too_large"))?
    };
    let samples = wav_samples(&bytes)?;
    let quota = {
        let _admission = service.0.admission.lock().await;
        if *cancel.borrow() {
            return Err(ApiError::cancelled());
        }
        let d = service.0.device_limit;
        let g = service.0.global_limit;
        service
            .store(move |store| store.quota(&device, day(), samples, d, g))
            .await?
    };
    let audio = Zeroizing::new(bytes.to_vec());
    drop(bytes);
    let text = tokio::select! { biased;
        _=cancelled(&mut cancel)=>return Err(ApiError::cancelled()),
        result=service.0.provider.transcribe(audio,&language)=>result?
    };
    Ok(Json(
        serde_json::json!({"schemaVersion":1,"jobId":id,"text":text.as_str(),"quota":quota}),
    ))
}
struct Provider {
    client: reqwest::Client,
    key: HeaderValue,
    endpoint: String,
}
impl Provider {
    async fn transcribe(
        &self,
        audio: Zeroizing<Vec<u8>>,
        language: &str,
    ) -> Result<Zeroizing<String>, ApiError> {
        #[cfg(test)]
        if self.endpoint == ENDPOINT {
            return Err(ApiError(
                StatusCode::BAD_GATEWAY,
                "test_provider_not_configured",
            ));
        }
        let file = reqwest::multipart::Part::bytes(audio.to_vec())
            .file_name("dictation.wav")
            .mime_str("audio/wav")
            .map_err(|_| ApiError::storage())?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", file)
            .text("model", "gpt-transcribe")
            .text("response_format", "json");
        if language != "auto" {
            form = form.text("language", language.to_owned());
        }
        let mut response = self
            .client
            .post(&self.endpoint)
            .header(header::AUTHORIZATION, self.key.clone())
            .multipart(form)
            .send()
            .await
            .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "provider_unavailable"))?;
        if !response.status().is_success() {
            return Err(ApiError(StatusCode::BAD_GATEWAY, "provider_rejected"));
        }
        let mut body = Zeroizing::new(Vec::new());
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "provider_unavailable"))?
        {
            if body.len() + chunk.len() > 65536 {
                return Err(ApiError(
                    StatusCode::BAD_GATEWAY,
                    "provider_response_too_large",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        #[derive(Deserialize)]
        struct Transcription {
            text: String,
        }
        let value: Transcription = serde_json::from_slice(&body)
            .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "provider_invalid_response"))?;
        let text = Zeroizing::new(value.text);
        if text.len() > 16384 || text.contains('\0') {
            return Err(ApiError(
                StatusCode::BAD_GATEWAY,
                "provider_invalid_response",
            ));
        }
        Ok(text)
    }
}

pub async fn serve(
    listener: TcpListener,
    service: Service,
    shutdown: impl Future<Output = ()> + Send,
) -> std::io::Result<()> {
    if !listener.local_addr()?.ip().is_loopback() {
        return Err(std::io::Error::other(
            "Require a loopback listener behind HTTPS",
        ));
    }
    let connections = Arc::new(Semaphore::new(16));
    let router = service.router();
    let mut tasks = JoinSet::new();
    tokio::pin!(shutdown);
    struct Stop(Service);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.cancel_all();
        }
    }
    let _stop = Stop(service);
    let result = loop {
        tokio::select! {
            _=&mut shutdown=>break Ok(()),
            accepted=listener.accept()=>{
                let (stream,_address):(tokio::net::TcpStream,SocketAddr)=match accepted {Ok(value)=>value,Err(error)=>break Err(error)};
                let Ok(permit)=connections.clone().try_acquire_owned() else {drop(stream);continue;};let router=router.clone();
                tasks.spawn(async move {
                    let _permit=permit; let mut builder=hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new()).http1_only();
                    builder.http1().header_read_timeout(Duration::from_secs(5)).timer(hyper_util::rt::TokioTimer::new()).max_buf_size(16384).max_headers(32);
                    let _=timeout(Duration::from_secs(60),builder.serve_connection(hyper_util::rt::TokioIo::new(stream),hyper_util::service::TowerToHyperService::new(router))).await;
                });
            },
            _=tasks.join_next(),if !tasks.is_empty()=>{},
        }
    };
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    result
}
#[cfg(test)]
mod tests;

#[cfg(all(test, not(unix)))]
mod unsupported_host_tests {
    #[test]
    fn refuses_service_and_secret_reads_before_touching_unsupported_storage() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state");
        let config =
            super::Config::new(path.clone(), &super::secret(), "fixture-key", 1, 2).unwrap();
        assert!(super::Service::open(config).is_err());
        assert!(!path.exists());
        assert!(super::read_secret(&directory.path().join("unread-secret"))
            .unwrap_err()
            .contains("Unix"));
    }
}
