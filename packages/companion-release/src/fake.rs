//! An in-process fake of GitHub's release API over HTTPS, with fault injection and a request log.
//! Test use only (feature `test-support`); it is never linked into a shipped build.
use crate::{extension, sha};
use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use bytes::Bytes;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, runtime::Runtime};

pub const PREFIX: &str = "/repos/mihazs/lazysh/";

/// One published release. Faults are set on the server, not here.
#[derive(Clone)]
pub struct Release {
    pub version: String,
    pub prerelease: bool,
    pub draft: bool,
    /// Commit the tag points at and `release.json` records.
    pub commit: String,
    /// Companion bytes by target (`linux-agent-x64`, ...).
    pub binaries: BTreeMap<String, Vec<u8>>,
}
impl Release {
    pub fn new(version: &str) -> Self {
        Self {
            version: version.into(),
            prerelease: false,
            draft: false,
            commit: sha(version.as_bytes())[..40].into(),
            binaries: BTreeMap::new(),
        }
    }
    pub fn binary(mut self, target: &str, bytes: &[u8]) -> Self {
        self.binaries.insert(target.into(), bytes.to_vec());
        self
    }
    fn name(&self, target: &str) -> String {
        format!(
            "lazysh-{}-{target}.{}",
            self.version,
            extension(target).unwrap()
        )
    }
    fn manifest(&self, empty: bool) -> Vec<u8> {
        let platforms = self
            .binaries
            .iter()
            .filter(|_| !empty)
            .map(|(target, bytes)| {
                json!({"schema":1,"sha":self.commit,"version":self.version,"target":target,
                    "signing":if target.starts_with("macos-"){"ad-hoc"}else{"unsigned"},
                    "files":[{"name":self.name(target),"bytes":bytes.len(),"sha256":sha(bytes)}]})
            })
            .collect::<Vec<_>>();
        serde_json::to_vec(
            &json!({"schema":1,"sha":self.commit,"version":self.version,"platforms":platforms}),
        )
        .unwrap()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fault {
    /// GitHub reports another SHA-256 for the companion assets than `release.json` records.
    ApiDigest,
    /// GitHub reports another size for the companion assets than `release.json` records.
    ApiSize,
    /// GitHub reports another SHA-256 for `release.json` than its bytes have.
    ManifestDigest,
    /// `release.json` is served with the declared length but other bytes.
    ManifestBytes,
    /// `release.json` lists no companion for any target.
    NoPlatform,
    /// The tag points at another commit than `release.json` records.
    MovedTag,
    /// Every API call answers this status, optionally with `Retry-After`.
    Status(u16, Option<u64>),
    /// Asset downloads redirect to this absolute URL.
    RedirectTo(String),
    /// `release.json` is bigger than its declared size.
    LongManifest,
    /// `release.json` ends after this many bytes (connection reset).
    DropManifest(usize),
    /// Companion bytes differ from the receipt but keep the length.
    TamperedAsset,
    /// Companion body is exactly these bytes, announced with their own length.
    Substitute(Vec<u8>),
    /// Companion body ends cleanly after fewer bytes (no declared length).
    ShortAsset,
    /// Companion body keeps going past the receipt's size (no declared length).
    LongAsset,
    /// Companion body announces a different `Content-Length`.
    LyingLength(u64),
    /// Companion body is reset after this many bytes.
    DropAsset(usize),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Logged {
    pub method: String,
    pub path: String,
    pub user_agent: String,
}
struct Inner {
    releases: Vec<Release>,
    fault: Option<Fault>,
    log: Vec<Logged>,
}
type Shared = Arc<Mutex<Inner>>;

/// Ids: the manifest of release `n` is `n*100+1`, its companion for target `t` is `n*100+2+index of t`.
fn manifest_id(index: usize) -> u64 {
    index as u64 * 100 + 1
}
fn binary_id(index: usize, position: usize) -> u64 {
    index as u64 * 100 + 2 + position as u64
}
fn release_json(index: usize, release: &Release, fault: &Option<Fault>) -> Value {
    let manifest = release.manifest(*fault == Some(Fault::NoPlatform));
    let mut assets = vec![
        json!({"id":manifest_id(index),"name":"release.json","size":manifest.len(),
        "digest":format!("sha256:{}",if *fault == Some(Fault::ManifestDigest){"0".repeat(64)}else{sha(&manifest)}),"state":"uploaded"}),
    ];
    for (position, (target, bytes)) in release.binaries.iter().enumerate() {
        let digest = if *fault == Some(Fault::ApiDigest) {
            "0".repeat(64)
        } else {
            sha(bytes)
        };
        let size = bytes.len() as u64 + u64::from(*fault == Some(Fault::ApiSize));
        assets.push(
            json!({"id":binary_id(index,position),"name":release.name(target),"size":size,
            "digest":format!("sha256:{digest}"),"state":"uploaded"}),
        );
    }
    for name in ["SHA256SUMS", "release-notes.md", "INSTALL-AND-UPDATE.md"] {
        assets.push(json!({"id":900+assets.len(),"name":name,"size":1,"digest":format!("sha256:{}",sha(name.as_bytes())),"state":"uploaded"}));
    }
    json!({"tag_name":format!("v{}",release.version),"draft":release.draft,"prerelease":release.prerelease,"assets":assets})
}
fn json_response(value: &Value) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_vec(value).unwrap(),
    )
        .into_response()
}
fn streamed(chunks: Vec<Result<Bytes, std::io::Error>>) -> Response {
    Response::new(Body::from_stream(futures_util::stream::iter(chunks)))
}

fn logged(state: &Shared, request: &Request) -> Option<Fault> {
    let mut inner = state.lock().unwrap();
    inner.log.push(Logged {
        method: request.method().to_string(),
        path: request
            .uri()
            .path_and_query()
            .map(|v| v.to_string())
            .unwrap_or_default(),
        user_agent: request
            .headers()
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned(),
    });
    inner.fault.clone()
}
async fn record(State(state): State<Shared>, request: Request, next: Next) -> Response {
    if let Some(Fault::Status(code, retry)) = logged(&state, &request) {
        if !request.uri().path().starts_with("/cdn/") {
            let mut response = StatusCode::from_u16(code).unwrap().into_response();
            if let Some(retry) = retry {
                response
                    .headers_mut()
                    .insert("retry-after", HeaderValue::from(retry));
            }
            return response;
        }
    }
    next.run(request).await
}
async fn latest(State(state): State<Shared>) -> Response {
    let state = state.lock().unwrap();
    // The newest stable one, like GitHub's `releases/latest`.
    match state
        .releases
        .iter()
        .enumerate()
        .rfind(|(_, r)| !r.draft && !r.prerelease)
    {
        Some((index, release)) => json_response(&release_json(index, release, &state.fault)),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn list(State(state): State<Shared>) -> Response {
    let state = state.lock().unwrap();
    let all = state
        .releases
        .iter()
        .enumerate()
        .rev()
        .map(|(index, release)| release_json(index, release, &state.fault))
        .collect::<Vec<_>>();
    json_response(&Value::Array(all))
}
async fn tagged(State(state): State<Shared>, Path(tag): Path<String>) -> Response {
    let state = state.lock().unwrap();
    match state
        .releases
        .iter()
        .enumerate()
        .find(|(_, r)| format!("v{}", r.version) == tag && !r.draft)
    {
        Some((index, release)) => json_response(&release_json(index, release, &state.fault)),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn reference(State(state): State<Shared>, Path(tag): Path<String>) -> Response {
    let state = state.lock().unwrap();
    match state
        .releases
        .iter()
        .find(|r| format!("v{}", r.version) == tag)
    {
        Some(release) => json_response(
            &json!({"ref":format!("refs/tags/{tag}"),"object":{"type":"commit",
            "sha":if state.fault==Some(Fault::MovedTag){"f".repeat(40)}else{release.commit.clone()}}}),
        ),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn asset(State(state): State<Shared>, Path(id): Path<u64>) -> Response {
    match &state.lock().unwrap().fault {
        Some(Fault::RedirectTo(url)) => redirect(url),
        _ => redirect(&format!("/cdn/{id}")),
    }
}
fn redirect(location: &str) -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .body(Body::empty())
        .unwrap()
}
async fn cdn(State(state): State<Shared>, Path(id): Path<u64>) -> Response {
    let state = state.lock().unwrap();
    let index = (id / 100) as usize;
    let Some(release) = state.releases.get(index) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let fault = &state.fault;
    if id % 100 == 1 {
        let mut bytes = release.manifest(*fault == Some(Fault::NoPlatform));
        let declared = bytes.len();
        match fault {
            Some(Fault::ManifestBytes) => bytes[0] ^= 1,
            Some(Fault::LongManifest) => {
                bytes.extend_from_slice(b"   ");
                return streamed(vec![Ok(Bytes::from(bytes))]);
            }
            Some(Fault::DropManifest(n)) => {
                return dropped(&bytes, *n);
            }
            _ => {}
        }
        debug_assert!(bytes.len() == declared);
        return bytes.into_response();
    }
    let Some((_, content)) = release.binaries.iter().nth((id % 100) as usize - 2) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut bytes = content.clone();
    match fault {
        Some(Fault::TamperedAsset) => bytes[0] ^= 1,
        Some(Fault::Substitute(other)) => bytes = other.clone(),
        Some(Fault::ShortAsset) => {
            bytes.truncate(bytes.len() / 2);
            return streamed(vec![Ok(Bytes::from(bytes))]);
        }
        Some(Fault::LongAsset) => {
            bytes.extend_from_slice(&[0; 4096]);
            return streamed(vec![Ok(Bytes::from(bytes))]);
        }
        Some(Fault::LyingLength(n)) => {
            // A streamed body, so the announced length is the server's own claim.
            let mut response = streamed(vec![Ok(Bytes::from(bytes))]);
            response
                .headers_mut()
                .insert(header::CONTENT_LENGTH, HeaderValue::from(*n));
            return response;
        }
        Some(Fault::DropAsset(n)) => return dropped(&bytes, *n),
        _ => {}
    }
    bytes.into_response()
}
fn dropped(bytes: &[u8], after: usize) -> Response {
    streamed(vec![
        Ok(Bytes::copy_from_slice(&bytes[..after.min(bytes.len())])),
        Err(std::io::Error::other("connection reset")),
    ])
}

pub struct Server {
    /// `https://localhost:PORT/repos/mihazs/lazysh/`
    pub api: String,
    /// The certificate clients must trust.
    pub ca_pem: String,
    state: Shared,
    runtime: Option<Runtime>,
}
impl Server {
    /// Each server has its own certificate: trusting another server's `ca_pem` makes it untrusted.
    pub fn start(releases: Vec<Release>) -> Self {
        let state: Shared = Arc::new(Mutex::new(Inner {
            releases,
            fault: None,
            log: Vec::new(),
        }));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let router = Router::new()
            .route(&format!("{PREFIX}releases/latest"), get(latest))
            .route(&format!("{PREFIX}releases"), get(list))
            .route(&format!("{PREFIX}releases/tags/{{tag}}"), get(tagged))
            .route(&format!("{PREFIX}git/ref/tags/{{tag}}"), get(reference))
            .route(&format!("{PREFIX}releases/assets/{{id}}"), get(asset))
            .route("/cdn/{id}", get(cdn))
            .layer(middleware::from_fn_with_state(state.clone(), record))
            .with_state(state.clone());
        let generated = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let ca_pem = generated.cert.pem();
        let key =
            rustls::pki_types::PrivatePkcs8KeyDer::from(generated.signing_key.serialize_der());
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![generated.cert.der().clone()], key.into())
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
        let port = listener.local_addr().unwrap().port();
        runtime.spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    continue;
                };
                let (acceptor, router) = (acceptor.clone(), router.clone());
                tokio::spawn(async move {
                    let Ok(stream) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let _ = hyper_util::server::conn::auto::Builder::new(
                        hyper_util::rt::TokioExecutor::new(),
                    )
                    .serve_connection(
                        hyper_util::rt::TokioIo::new(stream),
                        hyper_util::service::TowerToHyperService::new(router),
                    )
                    .await;
                });
            }
        });
        Self {
            api: format!("https://localhost:{port}{PREFIX}"),
            ca_pem,
            state,
            runtime: Some(runtime),
        }
    }
    /// Replace the published releases (oldest first; the newest stable one is `latest`).
    pub fn publish(&self, releases: Vec<Release>) {
        self.state.lock().unwrap().releases = releases;
    }
    pub fn fault(&self, fault: Option<Fault>) {
        self.state.lock().unwrap().fault = fault;
    }
    pub fn requests(&self) -> Vec<Logged> {
        self.state.lock().unwrap().log.clone()
    }
    /// How many times a companion binary (not `release.json`) was requested.
    pub fn companion_downloads(&self) -> usize {
        self.requests()
            .iter()
            .filter(|r| {
                r.path
                    .strip_prefix(&format!("{PREFIX}releases/assets/"))
                    .and_then(|id| id.parse::<u64>().ok())
                    .is_some_and(|id| id % 100 != 1)
            })
            .count()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}
