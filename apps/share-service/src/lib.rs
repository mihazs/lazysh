mod storage;

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
    time::timeout,
};
use tokio_util::io::ReaderStream;

pub const MAX_UPLOAD: usize = 10 * 1024 * 1024;
pub const MAX_TTL: u64 = 7 * 24 * 60 * 60;
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn random_secret() -> String {
    rand::random::<[u8; 32]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn decode_secret(value: &str) -> Option<[u8; 32]> {
    if !valid_id(value) {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

pub struct Config {
    directory: PathBuf,
    origin: String,
    token: [u8; 32],
    max_storage: u64,
    max_files: u32,
}
impl Config {
    pub fn new(directory: PathBuf, public_origin: &str, token: &str) -> Result<Self, String> {
        let token = decode_secret(token).ok_or("Management token must contain 64 hexadecimal characters; generate it with lazysh-share keygen")?;
        let origin = url::Url::parse(public_origin).map_err(|_| "Invalid public HTTPS origin")?;
        let authority = public_origin
            .split_once("://")
            .map(|(_, address)| address.split(['/', '?', '#']).next().unwrap_or_default())
            .unwrap_or_default();
        if origin.scheme() != "https"
            || !origin.has_host()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || authority.is_empty()
            || authority.contains('@')
            || public_origin.contains('\\')
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
            || public_origin.len() > 2048
            || public_origin
                .chars()
                .any(|c| c.is_control() || c.is_whitespace())
        {
            return Err("Public origin must be an HTTPS origin without credentials, path, query or fragment".into());
        }
        Ok(Self {
            directory,
            origin: origin.origin().ascii_serialization(),
            token,
            max_storage: 256 * 1024 * 1024,
            max_files: 1000,
        })
    }
}

#[derive(Clone)]
pub struct Service {
    store: Arc<Mutex<storage::Store>>,
    token: [u8; 32],
    origin: String,
    requests: Arc<Semaphore>,
    downloads: Arc<Semaphore>,
}
impl Service {
    pub fn open(config: Config) -> Result<Self, String> {
        let store = storage::Store::open(&config).map_err(|_| "Cannot open private share storage; require a dedicated directory and only one running service")?;
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            token: config.token,
            origin: config.origin,
            requests: Arc::new(Semaphore::new(4)),
            downloads: Arc::new(Semaphore::new(4)),
        })
    }
    pub fn router(&self) -> Router {
        let protected = Router::new()
            .route("/v1/shares", post(upload).get(history))
            .route("/v1/shares/{id}", axum::routing::delete(delete))
            .route_layer(middleware::from_fn_with_state(self.clone(), authenticate));
        Router::new()
            .merge(protected)
            .route("/s/{id}", get(download))
            .layer(DefaultBodyLimit::max(MAX_UPLOAD))
            .layer(middleware::from_fn_with_state(self.clone(), bounded))
            .with_state(self.clone())
    }
    async fn cleanup(&self) {
        let store = self.store.clone();
        let _ = tokio::task::spawn_blocking(move || {
            store
                .lock()
                .map_err(|_| ())
                .and_then(|mut store| store.cleanup(now()).map_err(|_| ()))
        })
        .await;
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub created_at: u64,
    pub expires_at: u64,
    pub url: String,
}
impl Share {
    fn with_origin(mut self, origin: &str) -> Self {
        self.url = format!("{origin}/s/{}", self.id);
        self
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    schema_version: u8,
    share: Share,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct History {
    schema_version: u8,
    shares: Vec<Share>,
    next_cursor: Option<String>,
}
struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
impl From<storage::Error> for ApiError {
    fn from(error: storage::Error) -> Self {
        match error {
            storage::Error::Full => Self(StatusCode::INSUFFICIENT_STORAGE, "storage_full"),
            storage::Error::NotFound => Self(StatusCode::NOT_FOUND, "not_found"),
            _ => Self(StatusCode::INTERNAL_SERVER_ERROR, "storage_unavailable"),
        }
    }
}
fn unavailable() -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "storage_unavailable")
}

async fn authenticate(State(service): State<Service>, request: Request, next: Next) -> Response {
    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .and_then(|(_, token)| decode_secret(token));
    if supplied.map(|token| token.ct_eq(&service.token).unwrap_u8() == 1) != Some(true) {
        let mut response = ApiError(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return response;
    }
    next.run(request).await
}
async fn bounded(State(service): State<Service>, mut request: Request, next: Next) -> Response {
    let Ok(_permit) = service.requests.try_acquire_owned() else {
        return ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy").into_response();
    };
    let permit = Arc::new(_permit);
    request.extensions_mut().insert(permit.clone());
    match timeout(Duration::from_secs(20), next.run(request)).await {
        Ok(mut response) => {
            let headers = response.headers_mut();
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            headers.insert(
                "x-content-type-options",
                HeaderValue::from_static("nosniff"),
            );
            headers.insert(
                "content-security-policy",
                HeaderValue::from_static("default-src 'none'; sandbox"),
            );
            headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
            response
        }
        Err(_) => ApiError(StatusCode::REQUEST_TIMEOUT, "request_timeout").into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Upload {
    filename: String,
    #[serde(default = "default_ttl")]
    ttl_seconds: u64,
}
fn default_ttl() -> u64 {
    24 * 60 * 60
}
fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
}
fn validate_mime(headers: &HeaderMap, bytes: &[u8]) -> Result<String, ApiError> {
    let declared = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 128)
        .ok_or(ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content_type_required",
        ))?
        .parse::<mime::Mime>()
        .map_err(|_| ApiError(StatusCode::UNSUPPORTED_MEDIA_TYPE, "invalid_content_type"))?;
    let mime = declared.essence_str();
    let matches = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "application/pdf" => bytes.starts_with(b"%PDF-"),
        "text/plain" => std::str::from_utf8(bytes).is_ok() && !bytes.contains(&0),
        _ => declared.type_() != mime::STAR && declared.subtype() != mime::STAR,
    };
    if !matches {
        return Err(ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content_type_mismatch",
        ));
    }
    Ok(mime.to_owned())
}
async fn upload(
    State(service): State<Service>,
    Extension(permit): Extension<Arc<OwnedSemaphorePermit>>,
    Query(args): Query<Upload>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<(StatusCode, Json<Created>), ApiError> {
    if !valid_name(&args.filename) || !(60..=MAX_TTL).contains(&args.ttl_seconds) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_upload_metadata"));
    }
    let mime = validate_mime(&headers, &bytes)?;
    let store = service.store.clone();
    let share = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        store
            .lock()
            .map_err(|_| unavailable())?
            .create(
                args.filename,
                mime,
                &bytes,
                args.ttl_seconds,
                now(),
                &service.origin,
            )
            .map_err(ApiError::from)
    })
    .await
    .map_err(|_| unavailable())??;
    Ok((
        StatusCode::CREATED,
        Json(Created {
            schema_version: 1,
            share,
        }),
    ))
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    cursor: Option<String>,
    limit: Option<usize>,
}
async fn history(
    State(service): State<Service>,
    Extension(permit): Extension<Arc<OwnedSemaphorePermit>>,
    Query(args): Query<HistoryQuery>,
) -> Result<Json<History>, ApiError> {
    let limit = args.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_history_limit"));
    }
    let cursor = args
        .cursor
        .map(|cursor| {
            if cursor.len() > 90 {
                return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_history_cursor"));
            }
            let (time, id) = cursor
                .split_once(':')
                .ok_or(ApiError(StatusCode::BAD_REQUEST, "invalid_history_cursor"))?;
            let time = time
                .parse::<u64>()
                .ok()
                .filter(|time| *time <= i64::MAX as u64)
                .ok_or(ApiError(StatusCode::BAD_REQUEST, "invalid_history_cursor"))?;
            if !valid_id(id) {
                return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_history_cursor"));
            }
            Ok((time, id.to_owned()))
        })
        .transpose()?;
    let store = service.store.clone();
    let mut shares = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        store
            .lock()
            .map_err(|_| unavailable())?
            .history(cursor, limit + 1, now(), &service.origin)
            .map_err(ApiError::from)
    })
    .await
    .map_err(|_| unavailable())??;
    let next_cursor = if shares.len() > limit {
        shares.truncate(limit);
        shares
            .last()
            .map(|share| format!("{}:{}", share.created_at, share.id))
    } else {
        None
    };
    Ok(Json(History {
        schema_version: 1,
        shares,
        next_cursor,
    }))
}
async fn delete(
    State(service): State<Service>,
    Extension(permit): Extension<Arc<OwnedSemaphorePermit>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if !valid_id(&id) {
        return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
    }
    let store = service.store.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        store
            .lock()
            .map_err(|_| unavailable())?
            .delete(&id)
            .map_err(ApiError::from)
    })
    .await
    .map_err(|_| unavailable())??;
    Ok(StatusCode::NO_CONTENT)
}
async fn download(
    State(service): State<Service>,
    Extension(request_permit): Extension<Arc<OwnedSemaphorePermit>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    if !valid_id(&id) {
        return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
    }
    let permit = service
        .downloads
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy"))?;
    let store = service.store.clone();
    let (share, file) = tokio::task::spawn_blocking(move || {
        let _permit = request_permit;
        store
            .lock()
            .map_err(|_| unavailable())?
            .download(&id, now())
            .map_err(ApiError::from)
    })
    .await
    .map_err(|_| unavailable())??;
    // Keep the permit until the download body finishes or is dropped.
    let stream = ReaderStream::new(tokio::fs::File::from_std(file)).map(move |chunk| {
        let _keep = &permit;
        chunk
    });
    let mut response = Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    let encoded =
        percent_encoding::utf8_percent_encode(&share.name, percent_encoding::NON_ALPHANUMERIC);
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"download\"; filename*=UTF-8''{encoded}"
        ))
        .map_err(|_| unavailable())?,
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(share.size));
    Ok(response)
}

pub async fn serve(
    listener: TcpListener,
    service: Service,
    shutdown: impl Future<Output = ()> + Send,
) -> std::io::Result<()> {
    if !listener.local_addr()?.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Share service must bind to loopback behind an HTTPS proxy",
        ));
    }
    let cleaner = service.clone();
    let (stop_cleanup, mut stopped_cleanup) = tokio::sync::oneshot::channel::<()>();
    let cleanup = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            tokio::select! { _ = &mut stopped_cleanup => return, _ = interval.tick() => cleaner.cleanup().await }
        }
    });
    struct AbortCleanup(tokio::task::AbortHandle);
    impl Drop for AbortCleanup {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _cleanup_guard = AbortCleanup(cleanup.abort_handle());
    let connections = Arc::new(Semaphore::new(16));
    let router = service.router();
    let mut tasks = JoinSet::new();
    tokio::pin!(shutdown);
    let result = loop {
        tokio::select! {
            _ = &mut shutdown => break Ok(()),
            accepted = listener.accept() => {
                let (stream, _address): (tokio::net::TcpStream, SocketAddr) = match accepted { Ok(connection) => connection, Err(error) => break Err(error) };
                let Ok(permit) = connections.clone().try_acquire_owned() else { drop(stream); continue; };
                let router = router.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let mut builder = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new()).http1_only();
                    builder.http1().header_read_timeout(Duration::from_secs(5)).timer(hyper_util::rt::TokioTimer::new()).max_buf_size(64 * 1024).max_headers(64);
                    let _ = timeout(Duration::from_secs(60), builder.serve_connection(hyper_util::rt::TokioIo::new(stream), hyper_util::service::TowerToHyperService::new(router))).await;
                });
            },
            _ = tasks.join_next(), if !tasks.is_empty() => {},
        }
    };
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let _ = stop_cleanup.send(());
    let _ = cleanup.await;
    result
}

#[cfg(test)]
mod tests;
