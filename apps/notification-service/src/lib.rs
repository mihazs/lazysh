pub use lazysh_notification_client::{
    client, client_with_root, digest, http_client, https, secret, valid_token, BoundEvent,
    BoundReceipt, BoundStatus, Event, Kind, Receipt, Source, Status,
};
mod apprise;
pub mod push;
mod push_enrollment;
mod push_event;
mod store;
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::sync::{watch, Notify};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, Default, clap::ValueEnum)]
pub enum DestinationFormat {
    #[default]
    Webhook,
    Gotify,
    Apprise,
}

pub struct Config {
    directory: PathBuf,
    admin_hash: [u8; 32],
    target_hash: [u8; 32],
    destination: Destination,
}
enum Destination {
    Http {
        format: DestinationFormat,
        endpoint: reqwest::Url,
        /// Empty only for an explicitly unauthenticated Apprise destination.
        bearer: Zeroizing<String>,
        tags: Vec<String>,
    },
    WebPush(Arc<push::PushConfig>),
}
impl Config {
    pub fn new(
        directory: PathBuf,
        admin: &str,
        endpoint: &str,
        bearer: &str,
    ) -> Result<Self, String> {
        Self::with_format(
            directory,
            admin,
            endpoint,
            bearer,
            DestinationFormat::Webhook,
        )
    }
    pub fn with_format(
        directory: PathBuf,
        admin: &str,
        endpoint: &str,
        bearer: &str,
        format: DestinationFormat,
    ) -> Result<Self, String> {
        let token_valid = match format {
            DestinationFormat::Webhook => valid_token(bearer),
            DestinationFormat::Gotify => opaque_token(bearer),
            DestinationFormat::Apprise => {
                return Self::apprise(directory, admin, endpoint, Some(bearer), &[])
            }
        };
        if !valid_token(admin) || !token_valid || admin == bearer {
            return Err(match format {
                DestinationFormat::Gotify => {
                    "Require a valid admin capability and a distinct Gotify application token"
                }
                _ => "Require distinct 256-bit hexadecimal admin and destination capabilities",
            }
            .into());
        }
        let endpoint = https(endpoint)?;
        if matches!(format, DestinationFormat::Gotify) && !endpoint.path().ends_with("/message") {
            return Err("Require the HTTPS Gotify message endpoint".into());
        }
        // Preserve existing webhook identities; Gotify is a different destination
        // even when its endpoint and application token happen to be identical.
        let label = match format {
            DestinationFormat::Gotify => "gotify\0",
            _ => "",
        };
        Ok(Self::http(
            directory,
            admin,
            format,
            endpoint,
            bearer,
            label,
            vec![],
        ))
    }
    /// Apprise API stateful key; `bearer` is an optional reverse-proxy token because
    /// Apprise API accepts unauthenticated requests by default.
    pub fn apprise(
        directory: PathBuf,
        admin: &str,
        endpoint: &str,
        bearer: Option<&str>,
        tags: &[String],
    ) -> Result<Self, String> {
        if !valid_token(admin)
            || bearer.is_some_and(|bearer| !opaque_token(bearer) || bearer == admin)
        {
            return Err(
                "Require a valid admin capability and a distinct Apprise proxy token".into(),
            );
        }
        let endpoint = https(endpoint)?;
        apprise::endpoint(&endpoint)?;
        let tags = apprise::tags(tags)?;
        Ok(Self::http(
            directory,
            admin,
            DestinationFormat::Apprise,
            endpoint,
            bearer.unwrap_or_default(),
            "apprise\0",
            tags,
        ))
    }
    fn http(
        directory: PathBuf,
        admin: &str,
        format: DestinationFormat,
        endpoint: reqwest::Url,
        bearer: &str,
        label: &str,
        tags: Vec<String>,
    ) -> Self {
        let mut identity = format!(
            "{label}{}\0{}",
            endpoint,
            digest(bearer)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        if !tags.is_empty() {
            identity = format!("{identity}\0{}", tags.join(","));
        }
        Self {
            directory,
            admin_hash: digest(admin),
            target_hash: digest(&identity),
            destination: Destination::Http {
                format,
                endpoint,
                bearer: Zeroizing::new(bearer.into()),
                tags,
            },
        }
    }
    pub fn web_push(
        directory: PathBuf,
        admin: &str,
        push: push::PushConfig,
    ) -> Result<Self, String> {
        if !valid_token(admin) {
            return Err("Require a 256-bit hexadecimal admin capability".into());
        }
        Ok(Self {
            directory,
            admin_hash: digest(admin),
            target_hash: push.identity(),
            destination: Destination::WebPush(Arc::new(push)),
        })
    }
    fn push(&self) -> Option<Arc<push::PushConfig>> {
        match &self.destination {
            Destination::WebPush(push) => Some(push.clone()),
            _ => None,
        }
    }
    fn reserved(&self, hash: &[u8]) -> bool {
        hash == self.admin_hash
            || matches!(&self.destination, Destination::Http { bearer, .. } if !bearer.is_empty() && hash == digest(bearer))
    }
}
/// Gotify application tokens and Apprise proxy tokens are opaque printable ASCII.
fn opaque_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && value.bytes().all(|byte| byte.is_ascii_graphic())
}
#[derive(Debug)]
pub struct ApiError(StatusCode, &'static str);
impl ApiError {
    fn storage() -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, "storage_unavailable")
    }
    fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "unauthorized")
    }
    fn target_changed() -> Self {
        Self(StatusCode::PRECONDITION_FAILED, "bound_target_changed")
    }
    fn conflict() -> Self {
        Self(StatusCode::CONFLICT, "identity_conflict")
    }
    fn capacity() -> Self {
        Self(StatusCode::TOO_MANY_REQUESTS, "capacity_exhausted")
    }
    fn disabled() -> Self {
        Self(StatusCode::CONFLICT, "destination_disabled")
    }
    fn not_found() -> Self {
        Self(StatusCode::NOT_FOUND, "not_found")
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(_: rusqlite::Error) -> Self {
        Self::storage()
    }
}
#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(ErrorBody { error: self.1 })).into_response()
    }
}
#[derive(Clone)]
pub struct Service(Arc<Inner>);
struct Inner {
    store: Arc<Mutex<store::Store>>,
    config: Config,
    client: reqwest::Client,
    changed: watch::Sender<u64>,
    wake: Notify,
    worker: AtomicBool,
    #[cfg(test)]
    challenge_push_accepted: Arc<ChallengePushObservation>,
}
// Only an unambiguous single completed push attempt gets a category. This
// test-only receipt never stores a challenge, endpoint, response or credential.
#[cfg(test)]
#[derive(Default)]
struct ChallengePushObservation(std::sync::atomic::AtomicU8);
#[cfg(test)]
impl ChallengePushObservation {
    fn start(&self) {
        let mut state = self.0.load(Ordering::SeqCst);
        loop {
            let next = if state == 0 { 1 } else { 4 };
            match self
                .0
                .compare_exchange(state, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => break,
                Err(current) => state = current,
            }
        }
    }
    fn finish(&self, accepted: bool) {
        let _ = self.0.compare_exchange(
            1,
            if accepted { 3 } else { 2 },
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }
    fn category(&self) -> &'static str {
        match self.0.load(Ordering::SeqCst) {
            2 => "notAccepted",
            3 => "accepted",
            _ => "unknown",
        }
    }
}
impl Service {
    pub fn open(config: Config) -> Result<Self, String> {
        let client = match config.push() {
            Some(push) => push.client()?,
            None => http_client()?,
        };
        Self::open_with(config, client, false)
    }
    /// Owned HTTPS fixtures can add their test certificate without changing CLI trust.
    #[cfg(feature = "test-support")]
    pub fn open_with_test_client(config: Config, client: reqwest::Client) -> Result<Self, String> {
        Self::open_with(config, client, false)
    }
    pub fn reconfigure(config: Config) -> Result<(), String> {
        store::Store::open(&config, true).map(|_| ())
    }
    fn open_with(config: Config, client: reqwest::Client, replace: bool) -> Result<Self, String> {
        let store = store::Store::open(&config, replace)?;
        Ok(Self(Arc::new(Inner {
            store: Arc::new(Mutex::new(store)),
            config,
            client,
            changed: watch::channel(0).0,
            wake: Notify::new(),
            worker: AtomicBool::new(false),
            #[cfg(test)]
            challenge_push_accepted: Arc::new(ChallengePushObservation::default()),
        })))
    }
    async fn db<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut store::Store) -> Result<T, ApiError> + Send + 'static,
    ) -> Result<T, ApiError> {
        let store = self.0.store.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = store.lock().map_err(|_| ApiError::storage())?;
            f(&mut state)
        })
        .await
        .map_err(|_| ApiError::storage())?
    }
    fn admin(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let token = token(headers)?;
        if !bool::from(digest(token).ct_eq(&self.0.config.admin_hash)) {
            return Err(ApiError::unauthorized());
        }
        Ok(())
    }
    async fn source(&self, headers: &HeaderMap) -> Result<Uuid, ApiError> {
        let token = token(headers)?.to_owned();
        self.db(move |s| s.authenticate(&token)).await
    }
    fn changed(&self) {
        self.0.changed.send_modify(|v| *v = v.wrapping_add(1));
        self.0.wake.notify_one();
    }
    pub fn router(&self) -> Router {
        Router::new()
            .route("/v1/admin/status", get(status))
            .route("/v1/admin/sources", post(provision))
            .route("/v1/admin/sources/{id}/revoke", post(revoke))
            .route("/v1/admin/destination/{action}", post(policy))
            .route("/v1/source/status", get(source_status))
            .route("/v1/events", post(ingest))
            .route("/v1/bound-events", get(bound_status).post(bound_ingest))
            .route("/v1/receipts/{id}", get(receipt))
            .merge(push_enrollment::routes())
            .layer(DefaultBodyLimit::max(4096))
            .with_state(self.clone())
    }
    async fn worker(&self, mut stop: watch::Receiver<bool>) -> Result<(), ApiError> {
        loop {
            if *stop.borrow() {
                return Ok(());
            }
            let mut changes = self.0.changed.subscribe();
            let Some(job) = self.db(|s| s.claim()).await? else {
                tokio::select! {biased;_=stop.changed()=>return Ok(()),_=self.0.wake.notified()=>{},_=tokio::time::sleep(Duration::from_millis(200))=>{}};
                continue;
            };
            let body = serde_json::json!({"schemaVersion":1,"receiptId":job.receipt.receipt_id,"eventId":job.receipt.event_id,"kind":job.receipt.kind,"alias":job.receipt.alias});
            let request = match &self.0.config.destination {
                Destination::Http {
                    format,
                    endpoint,
                    bearer,
                    tags,
                } => {
                    let request = self
                        .0
                        .client
                        .post(endpoint.clone())
                        .header("Idempotency-Key", &job.receipt.receipt_id);
                    match format {
                        DestinationFormat::Webhook => {
                            request.bearer_auth(bearer.as_str()).json(&body)
                        }
                        DestinationFormat::Gotify => request
                            .header("X-Gotify-Key", bearer.as_str())
                            .json(&serde_json::json!({
                                "title":"lazysh",
                                "message":format!("{}: {}",job.receipt.alias,job.receipt.kind),
                                "priority":if job.receipt.kind=="needs_attention" {5} else {2},
                            })),
                        DestinationFormat::Apprise => {
                            let request = request.json(&apprise::body(
                                &job.receipt.kind,
                                &job.receipt.alias,
                                tags,
                            ));
                            if bearer.is_empty() {
                                request
                            } else {
                                request.bearer_auth(bearer.as_str())
                            }
                        }
                    }
                }
                Destination::WebPush(config) => config
                    .request(
                        job.push.as_ref().ok_or_else(ApiError::storage)?,
                        &self.0.client,
                    )
                    .map_err(|_| ApiError::storage())?,
            }
            .send();
            tokio::pin!(request);
            let classified = matches!(
                &self.0.config.destination,
                Destination::Http {
                    format: DestinationFormat::Apprise,
                    ..
                }
            );
            let outcome = loop {
                tokio::select! {biased;
                 _=stop.changed()=>{return Ok(())},
                 _=changes.changed()=>{let id=job.receipt.receipt_id.clone();if !self.db(move|s|Ok(s.connection.query_row("SELECT state='sending' FROM events WHERE receipt=?1",[id],|r|r.get::<_,bool>(0))?)).await? {break store::Delivery::Retry;}},
                 result=&mut request=>break match result {
                     Ok(response) if classified => apprise::classify(response.status()),
                     result => result.is_ok_and(|r|r.status().is_success()).into(),
                 },
                }
            };
            self.db(move |s| s.finish(&job, outcome)).await?;
        }
    }
}
fn token(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| valid_token(s))
        .ok_or_else(ApiError::unauthorized)
}
async fn status(State(s): State<Service>, h: HeaderMap) -> Result<Json<Status>, ApiError> {
    s.admin(&h)?;
    s.db(|s| s.status()).await.map(Json)
}
async fn source_status(State(s): State<Service>, h: HeaderMap) -> Result<Json<Status>, ApiError> {
    s.source(&h).await?;
    s.db(|s| s.status()).await.map(Json)
}
async fn provision(
    State(s): State<Service>,
    h: HeaderMap,
    Json(source): Json<Source>,
) -> Result<Json<serde_json::Value>, ApiError> {
    s.admin(&h)?;
    source
        .validate()
        .map_err(|code| ApiError(StatusCode::BAD_REQUEST, code))?;
    if s.0.config.reserved(&source.token_hash) {
        return Err(ApiError::conflict());
    }
    s.db(move |s| s.source(&source)).await?;
    Ok(Json(serde_json::json!({"provisioned":true})))
}
async fn revoke(
    State(s): State<Service>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    s.admin(&h)?;
    s.db(move |s| s.revoke(id)).await?;
    s.changed();
    Ok(Json(serde_json::json!({"revoked":true})))
}
async fn policy(
    State(s): State<Service>,
    h: HeaderMap,
    Path(action): Path<String>,
) -> Result<Json<Status>, ApiError> {
    s.admin(&h)?;
    let enabled = match action.as_str() {
        "enable" => true,
        "disable" => false,
        _ => return Err(ApiError::not_found()),
    };
    let result = s.db(move |s| s.policy(enabled)).await?;
    s.changed();
    Ok(Json(result))
}
async fn ingest(
    State(s): State<Service>,
    h: HeaderMap,
    Json(event): Json<Event>,
) -> Result<Json<Receipt>, ApiError> {
    let source = s.source(&h).await?;
    let receipt = s.db(move |s| s.ingest(source, event)).await?;
    s.0.wake.notify_one();
    Ok(Json(receipt))
}
async fn bound_status(
    State(s): State<Service>,
    h: HeaderMap,
) -> Result<Json<BoundStatus>, ApiError> {
    let token = Zeroizing::new(token(&h)?.to_owned());
    s.db(move |s| s.bound_status(&token)).await.map(Json)
}
async fn bound_ingest(
    State(s): State<Service>,
    h: HeaderMap,
    Json(event): Json<BoundEvent>,
) -> Result<Json<BoundReceipt>, ApiError> {
    let token = Zeroizing::new(token(&h)?.to_owned());
    let receipt = s.db(move |s| s.ingest_bound(&token, event)).await?;
    s.0.wake.notify_one();
    Ok(Json(receipt))
}
async fn receipt(
    State(s): State<Service>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Receipt>, ApiError> {
    let source = s.source(&h).await?;
    s.db(move |s| s.receipt(source, &id.to_string()))
        .await
        .map(Json)
}

pub async fn serve(
    listener: tokio::net::TcpListener,
    service: Service,
    shutdown: impl std::future::Future<Output = ()> + Send,
) -> std::io::Result<()> {
    lazysh_common::server::require_loopback(
        &listener,
        std::io::Error::other("Require loopback behind an HTTPS proxy"),
    )?;
    if service
        .0
        .worker
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(std::io::Error::other("Worker already running"));
    }
    let (stop, rx) = watch::channel(false);
    let owned = service.clone();
    let mut worker = tokio::spawn(async move {
        let _slot = WorkerSlot(owned.0.clone());
        owned.worker(rx).await
    });
    let (result, joined) = tokio::select! {biased;
     outcome=&mut worker=>(match outcome{Ok(Ok(()))=>Ok(()),_=>Err(std::io::Error::other("Webhook worker stopped"))},true),
     result=lazysh_common::server::serve(listener,service.router(),shutdown,8192,32)=>(result,false),
    };
    stop.send_replace(true);
    if !joined {
        let _ = worker.await;
    }
    result
}
struct WorkerSlot(Arc<Inner>);
impl Drop for WorkerSlot {
    fn drop(&mut self) {
        self.0.worker.store(false, Ordering::SeqCst);
    }
}
#[cfg(all(test, unix))]
mod tests;
