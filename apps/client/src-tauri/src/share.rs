use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};
use tauri_plugin_lazysh_vault::VaultExt;
use tokio::sync::{watch, Mutex};
use zeroize::{Zeroize, Zeroizing};

type Result<T> = std::result::Result<T, String>;
const ACCOUNT: &str = "share-service-enrollment-v1";
const MAX_FILE: usize = 10 * 1024 * 1024;
const MAX_RESPONSE: usize = 256 * 1024;
const IDLE: Duration = Duration::from_secs(120);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Enrollment {
    version: u8,
    origin: String,
    token: String,
}
impl Drop for Enrollment {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
fn origin(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "Enter a valid HTTPS service origin")?;
    let authority = value
        .split_once("://")
        .map(|(_, address)| address.split(['/', '?', '#']).next().unwrap_or_default())
        .unwrap_or_default();
    if value.len() > 2048
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
        || value.contains('\\')
        || authority.is_empty()
        || authority.contains('@')
        || url.scheme() != "https"
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an HTTPS origin without credentials, path, query or fragment".into());
    }
    Ok(url)
}
fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
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
fn valid_mime(value: &str) -> bool {
    value.len() <= 128
        && value.split_once('/').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes()
                    .chain(b.bytes())
                    .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
        })
}
fn decode(value: &str) -> Result<Enrollment> {
    if value.len() > 4096 {
        return Err("Invalid sharing service enrollment".into());
    }
    let enrollment: Enrollment =
        serde_json::from_str(value).map_err(|_| "Invalid sharing service enrollment")?;
    if enrollment.version != 1
        || !valid_token(&enrollment.token)
        || origin(&enrollment.origin)?.origin().ascii_serialization() != enrollment.origin
    {
        return Err("Invalid sharing service enrollment".into());
    }
    Ok(enrollment)
}
async fn load(app: AppHandle) -> Result<Option<Enrollment>> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = app.vault().get(ACCOUNT)?.map(Zeroizing::new);
        value.map(|value| decode(&value)).transpose()
    })
    .await
    .map_err(|_| "Cannot read the sharing service credentials".to_owned())?
}
#[derive(Serialize)]
pub struct ShareStatus {
    configured: bool,
    origin: Option<String>,
}
#[tauri::command]
pub async fn share_status(app: AppHandle) -> Result<ShareStatus> {
    Ok(match load(app).await? {
        Some(enrollment) => ShareStatus {
            configured: true,
            origin: Some(enrollment.origin.clone()),
        },
        None => ShareStatus {
            configured: false,
            origin: None,
        },
    })
}

struct Pending {
    enrollment: Enrollment,
    name: String,
    mime: String,
    ttl: u64,
    data: Zeroizing<Vec<u8>>,
}
struct Upload {
    size: usize,
    touched: Instant,
    pending: Option<Pending>,
    cancel: watch::Sender<bool>,
}
type Uploads = Mutex<HashMap<String, Upload>>;
#[derive(Default)]
pub struct ShareState {
    uploads: Arc<Uploads>,
    thumbnail: Arc<Mutex<Option<ThumbnailWork>>>,
    changing: Arc<AtomicBool>,
    generation: AtomicU64,
}
struct Changing(Arc<AtomicBool>);
impl Drop for Changing {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn changing(state: &ShareState) -> Result<Changing> {
    state
        .changing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Sharing service configuration is already changing")?;
    state.generation.fetch_add(1, Ordering::AcqRel);
    Ok(Changing(state.changing.clone()))
}
async fn cancel_all(state: &ShareState) {
    let mut uploads = state.uploads.lock().await;
    for upload in uploads.values() {
        let _ = upload.cancel.send(true);
    }
    uploads.retain(|_, upload| upload.pending.is_none());
    drop(uploads);
    if let Some(work) = state.thumbnail.lock().await.as_ref() {
        let _ = work.cancel.send(true);
    }
}
fn configured_token(
    origin: &str,
    supplied: Zeroizing<String>,
    previous: Option<Enrollment>,
) -> Result<Zeroizing<String>> {
    if supplied.is_empty() {
        let previous = previous.ok_or("Enter the management token for this service")?;
        if previous.origin != origin {
            return Err("Enter the management token when changing sharing services".into());
        }
        return Ok(Zeroizing::new(previous.token.clone()));
    }
    if !valid_token(&supplied) {
        return Err("Enter the service's 64-character management token".into());
    }
    Ok(supplied)
}
#[tauri::command]
pub async fn share_configure(
    app: AppHandle,
    state: State<'_, ShareState>,
    origin: String,
    token: String,
) -> Result<ShareStatus> {
    let token = Zeroizing::new(token);
    let url = self::origin(&origin)?;
    if !token.is_empty() && !valid_token(&token) {
        return Err("Enter the service's 64-character management token".into());
    }
    let _changing = changing(&state)?;
    cancel_all(&state).await;
    let canonical_origin = url.origin().ascii_serialization();
    let previous = if token.is_empty() {
        load(app.clone()).await?
    } else {
        None
    };
    let token = configured_token(&canonical_origin, token, previous)?;
    let enrollment = Enrollment {
        version: 1,
        origin: canonical_origin,
        token: token.to_string(),
    };
    let origin = enrollment.origin.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let encoded = Zeroizing::new(
            serde_json::to_string(&enrollment)
                .map_err(|_| "Cannot encode sharing service configuration")?,
        );
        app.vault().set(ACCOUNT, &encoded)
    })
    .await
    .map_err(|_| "Cannot save sharing service configuration".to_owned())??;
    Ok(ShareStatus {
        configured: true,
        origin: Some(origin),
    })
}
#[tauri::command]
pub async fn share_forget(app: AppHandle, state: State<'_, ShareState>) -> Result<()> {
    let _changing = changing(&state)?;
    cancel_all(&state).await;
    tauri::async_runtime::spawn_blocking(move || app.vault().delete(ACCOUNT))
        .await
        .map_err(|_| "Cannot remove sharing service credentials".to_owned())?
}

fn client() -> Result<Client> {
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "Cannot initialize sharing service connection".into())
}
async fn response(mut response: Response, expected: reqwest::StatusCode) -> Result<Vec<u8>> {
    if response.status() != expected {
        return Err(match response.status().as_u16() {
            401 | 403 => "Sharing service token was rejected or revoked",
            404 => "Share expired, was deleted, or the service address is incorrect",
            413 => "File exceeds the service's upload limit",
            415 => "File content did not match its declared type",
            507 => "Sharing service storage is full",
            429 | 503 => "Sharing service is busy; retry later",
            _ => "Sharing service rejected the request",
        }
        .into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err("Sharing service response exceeds 256 KiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Cannot read sharing service response")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("Sharing service response exceeds 256 KiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedFile {
    id: String,
    name: String,
    mime: String,
    size: u64,
    created_at: u64,
    expires_at: u64,
    url: String,
}
impl SharedFile {
    fn validate(&self, origin: &str) -> Result<()> {
        if !valid_id(&self.id)
            || !valid_name(&self.name)
            || !valid_mime(&self.mime)
            || self.size > MAX_FILE as u64
            || self.created_at > 8_640_000_000_000
            || self.expires_at > 8_640_000_000_000
            || self.expires_at < self.created_at.saturating_add(60)
            || self.expires_at > self.created_at.saturating_add(7 * 24 * 60 * 60)
            || self.url != format!("{origin}/s/{}", self.id)
        {
            return Err("Sharing service returned an invalid file or download address".into());
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Created {
    schema_version: u8,
    share: SharedFile,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct History {
    schema_version: u8,
    shares: Vec<SharedFile>,
    next_cursor: Option<String>,
}
fn cursor(value: &str) -> Result<()> {
    let (time, id) = value
        .split_once(':')
        .ok_or("Invalid sharing history cursor")?;
    if value.len() > 90
        || !valid_id(id)
        || time
            .parse::<u64>()
            .ok()
            .filter(|time| *time <= i64::MAX as u64)
            .is_none()
    {
        return Err("Invalid sharing history cursor".into());
    }
    Ok(())
}
async fn list(
    client: Client,
    enrollment: &Enrollment,
    limit: u32,
    next: Option<String>,
) -> Result<History> {
    if !(1..=50).contains(&limit) {
        return Err("Sharing history page size must be between 1 and 50".into());
    }
    let mut url = Url::parse(&format!("{}/v1/shares", enrollment.origin))
        .map_err(|_| "Invalid sharing service origin")?;
    url.query_pairs_mut()
        .append_pair("limit", &limit.to_string());
    if let Some(next) = next {
        cursor(&next)?;
        url.query_pairs_mut().append_pair("cursor", &next);
    }
    let bytes = response(
        client
            .get(url)
            .bearer_auth(&enrollment.token)
            .send()
            .await
            .map_err(|_| "Cannot reach the configured sharing service")?,
        reqwest::StatusCode::OK,
    )
    .await?;
    let history: History =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid sharing history response")?;
    if history.schema_version != 1 || history.shares.len() > limit as usize {
        return Err("Unsupported sharing history response".into());
    }
    for share in &history.shares {
        share.validate(&enrollment.origin)?;
    }
    if let Some(next) = &history.next_cursor {
        cursor(next)?;
    }
    Ok(history)
}
#[tauri::command]
pub async fn share_list(
    app: AppHandle,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<History> {
    let enrollment = load(app)
        .await?
        .ok_or("Configure a sharing service first")?;
    list(client()?, &enrollment, limit.unwrap_or(50), cursor).await
}
async fn delete(client: Client, enrollment: &Enrollment, id: &str) -> Result<()> {
    if !valid_id(id) {
        return Err("Invalid shared file identifier".into());
    }
    let url = format!("{}/v1/shares/{id}", enrollment.origin);
    response(
        client
            .delete(url)
            .bearer_auth(&enrollment.token)
            .send()
            .await
            .map_err(|_| "Cannot reach the configured sharing service")?,
        reqwest::StatusCode::NO_CONTENT,
    )
    .await?;
    Ok(())
}
#[tauri::command]
pub async fn share_delete(app: AppHandle, id: String) -> Result<()> {
    let enrollment = load(app)
        .await?
        .ok_or("Configure a sharing service first")?;
    delete(client()?, &enrollment, &id).await
}

fn prune(uploads: &mut HashMap<String, Upload>) {
    uploads.retain(|_, upload| {
        if upload.pending.is_some() && upload.touched.elapsed() >= IDLE {
            let _ = upload.cancel.send(true);
            false
        } else {
            true
        }
    });
}
fn expire(uploads: Weak<Uploads>, id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDLE).await;
        loop {
            let Some(uploads) = uploads.upgrade() else {
                return;
            };
            let remaining = {
                let mut uploads = uploads.lock().await;
                prune(&mut uploads);
                uploads
                    .get(&id)
                    .filter(|upload| upload.pending.is_some())
                    .map(|upload| IDLE.saturating_sub(upload.touched.elapsed()))
            };
            drop(uploads);
            match remaining {
                Some(remaining) => tokio::time::sleep(remaining).await,
                None => return,
            }
        }
    });
}
fn insert(
    uploads: &mut HashMap<String, Upload>,
    enrollment: Enrollment,
    name: String,
    mime: String,
    size: usize,
    ttl: u64,
) -> Result<String> {
    prune(uploads);
    if size > MAX_FILE
        || !valid_name(&name)
        || !valid_mime(&mime)
        || !(60..=7 * 24 * 60 * 60).contains(&ttl)
    {
        return Err(
            "Choose a valid file up to 10 MiB and an expiry between one minute and seven days"
                .into(),
        );
    }
    if uploads.len() >= 2
        || uploads.values().map(|upload| upload.size).sum::<usize>() + size > 2 * MAX_FILE
    {
        return Err("Two share uploads are already pending or sending".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (cancel, _) = watch::channel(false);
    uploads.insert(
        id.clone(),
        Upload {
            size,
            touched: Instant::now(),
            pending: Some(Pending {
                enrollment,
                name,
                mime,
                ttl,
                data: Zeroizing::new(Vec::with_capacity(size)),
            }),
            cancel,
        },
    );
    Ok(id)
}
#[derive(Serialize)]
pub struct UploadStarted {
    id: String,
}
#[tauri::command]
pub async fn share_upload_begin(
    app: AppHandle,
    state: State<'_, ShareState>,
    name: String,
    mime: String,
    size: u64,
    ttl_seconds: u64,
) -> Result<UploadStarted> {
    if state.changing.load(Ordering::Acquire) {
        return Err("Sharing service configuration is changing".into());
    }
    let generation = state.generation.load(Ordering::Acquire);
    if size > MAX_FILE as u64 {
        return Err("Shared files are limited to 10 MiB".into());
    }
    let enrollment = load(app)
        .await?
        .ok_or("Configure a sharing service first")?;
    let mut uploads = state.uploads.lock().await;
    if state.changing.load(Ordering::Acquire)
        || generation != state.generation.load(Ordering::Acquire)
    {
        return Err("Sharing service changed; choose the file again".into());
    }
    let id = insert(
        &mut uploads,
        enrollment,
        name,
        mime,
        size as usize,
        ttl_seconds,
    )?;
    expire(Arc::downgrade(&state.uploads), id.clone());
    Ok(UploadStarted { id })
}
fn chunk(uploads: &mut HashMap<String, Upload>, id: &str, offset: u64, data: &[u8]) -> Result<()> {
    prune(uploads);
    let upload = uploads
        .get_mut(id)
        .ok_or("Upload expired or was cancelled")?;
    let pending = upload.pending.as_mut().ok_or("Upload is already sending")?;
    if data.is_empty()
        || data.len() > 256 * 1024
        || offset != pending.data.len() as u64
        || pending.data.len() + data.len() > upload.size
    {
        return Err("Invalid share chunk size or offset".into());
    }
    pending.data.extend_from_slice(data);
    upload.touched = Instant::now();
    Ok(())
}
#[tauri::command]
pub async fn share_upload_chunk(
    state: State<'_, ShareState>,
    id: String,
    offset: u64,
    data: Vec<u8>,
) -> Result<()> {
    chunk(&mut *state.uploads.lock().await, &id, offset, &data)
}
async fn send(client: Client, mut pending: Pending) -> Result<Created> {
    let mut url = Url::parse(&format!("{}/v1/shares", pending.enrollment.origin))
        .map_err(|_| "Invalid sharing service origin")?;
    url.query_pairs_mut()
        .append_pair("filename", &pending.name)
        .append_pair("ttlSeconds", &pending.ttl.to_string());
    let bytes = std::mem::take(&mut *pending.data);
    let result = client
        .post(url)
        .bearer_auth(&pending.enrollment.token)
        .header(reqwest::header::CONTENT_TYPE, &pending.mime)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Cannot upload to the configured sharing service")?;
    let bytes = response(result, reqwest::StatusCode::CREATED).await?;
    let created: Created =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid sharing upload response")?;
    if created.schema_version != 1 {
        return Err("Unsupported sharing upload response".into());
    }
    created.share.validate(&pending.enrollment.origin)?;
    Ok(created)
}
async fn finish(state: &ShareState, id: String, client: Client) -> Result<Created> {
    let (pending, mut cancelled) = {
        let mut uploads = state.uploads.lock().await;
        prune(&mut uploads);
        let upload = uploads
            .get_mut(&id)
            .ok_or("Upload expired or was cancelled")?;
        let pending = upload.pending.as_ref().ok_or("Upload is already sending")?;
        if pending.data.len() != upload.size {
            return Err("Upload is incomplete; send every file chunk before finishing".into());
        }
        (
            upload.pending.take().ok_or("Upload is already sending")?,
            upload.cancel.subscribe(),
        )
    };
    struct ReleaseUpload {
        uploads: Arc<Uploads>,
        id: String,
    }
    impl Drop for ReleaseUpload {
        fn drop(&mut self) {
            if let Ok(mut uploads) = self.uploads.try_lock() {
                uploads.remove(&self.id);
            } else {
                let uploads = self.uploads.clone();
                let id = self.id.clone();
                tauri::async_runtime::spawn(async move {
                    uploads.lock().await.remove(&id);
                });
            }
        }
    }
    let _release = ReleaseUpload {
        uploads: state.uploads.clone(),
        id,
    };
    let result = tokio::select! { _ = cancelled.changed() => Err("Upload cancelled. If the service already accepted it, remove it from sharing history.".into()), result = send(client, pending) => result };
    result
}
#[tauri::command]
pub async fn share_upload_finish(state: State<'_, ShareState>, id: String) -> Result<Created> {
    finish(&state, id, client()?).await
}
#[tauri::command]
pub async fn share_upload_cancel(state: State<'_, ShareState>, id: String) -> Result<()> {
    let mut uploads = state.uploads.lock().await;
    if let Some(upload) = uploads.get(&id) {
        let _ = upload.cancel.send(true);
        if upload.pending.is_some() {
            uploads.remove(&id);
        }
    }
    Ok(())
}

const THUMBNAIL_INPUT_LIMIT: usize = 2 * 1024 * 1024;
const THUMBNAIL_OUTPUT_LIMIT: usize = 512 * 1024;
struct ThumbnailWork {
    request_id: String,
    cancel: watch::Sender<bool>,
}
struct ThumbnailLease {
    state: Arc<Mutex<Option<ThumbnailWork>>>,
    request_id: String,
}
impl Drop for ThumbnailLease {
    fn drop(&mut self) {
        let clear = |work: &mut Option<ThumbnailWork>| {
            if work
                .as_ref()
                .is_some_and(|work| work.request_id == self.request_id)
            {
                *work = None;
            }
        };
        if let Ok(mut work) = self.state.try_lock() {
            clear(&mut work);
        } else {
            let state = self.state.clone();
            let id = self.request_id.clone();
            tauri::async_runtime::spawn(async move {
                let mut work = state.lock().await;
                if work.as_ref().is_some_and(|work| work.request_id == id) {
                    *work = None;
                }
            });
        }
    }
}
#[derive(Serialize)]
pub struct Thumbnail {
    mime: &'static str,
    data: Vec<u8>,
    width: u32,
    height: u32,
}
fn thumbnail_dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 8 * 1024 * 1024
    {
        return Err("Image previews support at most 8 megapixels and 8192 pixels per side".into());
    }
    Ok(())
}
fn little16(bytes: &[u8]) -> u32 {
    u32::from(u16::from_le_bytes([bytes[0], bytes[1]]))
}
fn webp_preflight(bytes: &[u8]) -> Result<()> {
    const UNSUPPORTED: &str = "Only simple WebP files with one VP8 or VP8L chunk can be previewed; download the original instead";
    if bytes.len() < 20 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("Invalid WebP container".into());
    }
    let declared =
        u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| "Invalid WebP size")?) as u64;
    let chunk_size = u32::from_le_bytes(
        bytes[16..20]
            .try_into()
            .map_err(|_| "Invalid WebP chunk size")?,
    ) as u64;
    if declared + 8 != bytes.len() as u64
        || 20 + chunk_size + (chunk_size & 1) != bytes.len() as u64
    {
        return Err(UNSUPPORTED.into());
    }
    let payload = &bytes[20..20 + chunk_size as usize];
    let (width, height) = match &bytes[12..16] {
        b"VP8 "
            if payload.len() >= 10
                && payload[0] & 1 == 0
                && payload[3..6] == [0x9d, 0x01, 0x2a] =>
        {
            let width = little16(&payload[6..8]);
            let height = little16(&payload[8..10]);
            if width & 0xc000 != 0 || height & 0xc000 != 0 {
                return Err(UNSUPPORTED.into());
            }
            (width, height)
        }
        b"VP8L" if payload.len() >= 5 && payload[0] == 0x2f => {
            let bits = u32::from_le_bytes(
                payload[1..5]
                    .try_into()
                    .map_err(|_| "Invalid WebP dimensions")?,
            );
            if bits >> 29 != 0 {
                return Err(UNSUPPORTED.into());
            }
            ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
        }
        _ => return Err(UNSUPPORTED.into()),
    };
    thumbnail_dimensions(width, height)
}
fn gif_preflight(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 13 {
        return Err("Invalid GIF header".into());
    }
    let (width, height) = (little16(&bytes[6..8]), little16(&bytes[8..10]));
    thumbnail_dimensions(width, height)?;
    let mut offset = 13usize;
    if bytes[10] & 0x80 != 0 {
        offset += 3 * (1usize << ((bytes[10] & 7) + 1));
    }
    loop {
        match bytes.get(offset) {
            Some(0x21) => {
                offset += 2;
                loop {
                    let size = usize::from(*bytes.get(offset).ok_or("Invalid GIF extension")?);
                    offset += 1;
                    if size == 0 {
                        break;
                    }
                    offset = offset
                        .checked_add(size)
                        .filter(|end| *end <= bytes.len())
                        .ok_or("Invalid GIF extension size")?;
                }
            }
            Some(0x2c) => {
                let frame = bytes
                    .get(offset + 1..offset + 10)
                    .ok_or("Invalid GIF frame header")?;
                let (left, top, frame_width, frame_height) = (
                    little16(&frame[..2]),
                    little16(&frame[2..4]),
                    little16(&frame[4..6]),
                    little16(&frame[6..8]),
                );
                thumbnail_dimensions(frame_width, frame_height)?;
                if left + frame_width > width || top + frame_height > height {
                    return Err("GIF preview frame exceeds its bounded canvas; download the original instead".into());
                }
                return Ok(());
            }
            _ => return Err("GIF preview has no valid bounded first frame".into()),
        }
    }
}
fn thumbnail(bytes: &[u8]) -> Result<Thumbnail> {
    use image::{ImageDecoder, ImageFormat, ImageReader};
    use std::io::Cursor;
    if bytes.len() > THUMBNAIL_INPUT_LIMIT {
        return Err("Image previews are limited to 2 MiB".into());
    }
    let format = image::guess_format(bytes)
        .map_err(|_| "Only PNG, JPEG, GIF and WebP images can be previewed")?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err("Only PNG, JPEG, GIF and WebP images can be previewed".into());
    }
    match format {
        ImageFormat::WebP => webp_preflight(bytes)?,
        ImageFormat::Gif => gif_preflight(bytes)?,
        _ => {}
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "Cannot read image dimensions within preview limits")?;
    thumbnail_dimensions(width, height)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "Cannot decode this image within preview limits")?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| "Cannot decode this image within preview limits")?;
    decoded.apply_orientation(orientation);
    let image = image::DynamicImage::ImageRgba8(
        decoded
            .thumbnail(decoded.width().min(256), decoded.height().min(256))
            .to_rgba8(),
    );
    let (width, height) = (image.width(), image.height());
    let mut data = Cursor::new(Vec::new());
    image
        .write_to(&mut data, ImageFormat::Png)
        .map_err(|_| "Cannot encode image thumbnail")?;
    let data = data.into_inner();
    if data.len() > THUMBNAIL_OUTPUT_LIMIT {
        return Err("Encoded thumbnail exceeds the preview limit".into());
    }
    Ok(Thumbnail {
        mime: "image/png",
        data,
        width,
        height,
    })
}
async fn thumbnail_bytes(client: Client, enrollment: &Enrollment, id: &str) -> Result<Vec<u8>> {
    if !valid_id(id) {
        return Err("Invalid shared file identifier".into());
    }
    let mut response = client
        .get(format!("{}/s/{id}", enrollment.origin))
        .send()
        .await
        .map_err(|_| "Cannot read the shared image")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Image link expired, was deleted, or the service refused it".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > THUMBNAIL_INPUT_LIMIT as u64)
    {
        return Err("Image previews are limited to 2 MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Cannot read the shared image")?
    {
        if bytes.len() + chunk.len() > THUMBNAIL_INPUT_LIMIT {
            return Err("Image previews are limited to 2 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn share_thumbnail(
    app: AppHandle,
    state: State<'_, ShareState>,
    id: String,
    request_id: String,
) -> Result<Thumbnail> {
    if !valid_id(&id) || uuid::Uuid::parse_str(&request_id).is_err() {
        return Err("Invalid image preview request".into());
    }
    if state.changing.load(Ordering::Acquire) {
        return Err("Sharing service configuration is changing".into());
    }
    let generation = state.generation.load(Ordering::Acquire);
    let (cancel, mut cancelled) = watch::channel(false);
    {
        let mut work = state.thumbnail.lock().await;
        if work.is_some() {
            return Err("Wait for the current image preview to finish".into());
        }
        *work = Some(ThumbnailWork {
            request_id: request_id.clone(),
            cancel,
        });
    }
    let lease = Arc::new(ThumbnailLease {
        state: state.thumbnail.clone(),
        request_id,
    });
    tokio::select! {
        _ = cancelled.changed() => Err("Image preview cancelled".into()),
        result = async {
            let enrollment = load(app).await?.ok_or("Configure a sharing service first")?;
            if state.changing.load(Ordering::Acquire) || generation != state.generation.load(Ordering::Acquire) { return Err("Sharing service changed; open the preview again".into()); }
            let bytes = thumbnail_bytes(client()?, &enrollment, &id).await?;
            let decoding = lease.clone();
            tauri::async_runtime::spawn_blocking(move || { let _lease = decoding; thumbnail(&bytes) }).await.map_err(|_| "Image decoder stopped".to_owned())?
        } => result,
    }
}
#[tauri::command]
pub async fn share_thumbnail_cancel(
    state: State<'_, ShareState>,
    request_id: String,
) -> Result<()> {
    if let Some(work) = state.thumbnail.lock().await.as_ref() {
        if work.request_id == request_id {
            let _ = work.cancel.send(true);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
