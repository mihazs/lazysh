use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::share::service::{valid_id as job_id, Enrollment};
type Protected<T> = std::result::Result<Guarded<T>, GuardedError<String>>;
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_lazysh_vault::VaultExt;
use tokio::sync::{watch, Mutex as AsyncMutex, OwnedMutexGuard};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, String>;
const ACCOUNT: &str = "cloud-transcription-enrollment-v1";
const MAX_RESPONSE: usize = 128 * 1024;
const HINTS: &[&str] = &["auto", "en", "es", "fr", "de", "pt", "ja", "zh"];
const MAX_DEVICE: u64 = 86400 * 16000;
const MAX_GLOBAL: u64 = MAX_DEVICE * 128;
const MAX_DATE: u64 = 8_640_000_000_000;
fn origin(value: &str) -> Result<String> {
    crate::share::service::origin(value, "Enter an HTTPS transcription service origin")
        .map(|url| url.origin().ascii_serialization())
}
fn token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn request_id(value: &str) -> bool {
    value.len() == 36 && uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn decode(value: &str) -> Result<Enrollment> {
    if value.len() > 4096 {
        return Err("Invalid cloud enrollment".into());
    }
    let enrollment: Enrollment =
        serde_json::from_str(value).map_err(|_| "Invalid cloud enrollment")?;
    if enrollment.version != 1
        || !token(&enrollment.token)
        || origin(&enrollment.origin)? != enrollment.origin
    {
        return Err("Invalid cloud enrollment".into());
    }
    Ok(enrollment)
}
async fn load(
    app: AppHandle,
    state: &CloudState,
    access: AccessLease,
) -> Result<Option<Enrollment>> {
    let operation = app.vault().operation();
    vault(state, move || {
        access.check()?;
        let stored = app
            .vault()
            .get_protected_for(ACCOUNT, false, &operation)?
            .map(Zeroizing::new);
        stored.map(|value| decode(&value)).transpose()
    })
    .await
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    schema_version: u8,
    model: String,
    languages: Vec<String>,
    max_wav_bytes: usize,
    sample_rate: u32,
    max_samples: usize,
}
impl Capabilities {
    fn validate(&self) -> Result<()> {
        if self.schema_version != 1
            || !matches!(self.model.as_str(), "gpt-transcribe" | "whisper.cpp")
            || self.max_wav_bytes != 960044
            || self.sample_rate != 16000
            || self.max_samples != 480000
            || self.languages.is_empty()
            || self.languages.len() > HINTS.len()
            || self
                .languages
                .iter()
                .any(|value| !HINTS.contains(&value.as_str()))
            || self
                .languages
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.languages.len()
        {
            return Err("Unsupported transcription service capabilities".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quota {
    window_start: u64,
    window_end: u64,
    device_limit_samples: u64,
    device_used_samples: u64,
    device_remaining_samples: u64,
    global_limit_samples: u64,
    global_used_samples: u64,
    global_remaining_samples: u64,
}
impl Quota {
    fn validate(&self) -> Result<()> {
        if self.window_start > MAX_DATE
            || self.window_end > MAX_DATE
            || !self.window_start.is_multiple_of(86400)
            || self.window_end.checked_sub(self.window_start) != Some(86400)
            || self.device_limit_samples == 0
            || self.device_limit_samples > MAX_DEVICE
            || self.device_used_samples > MAX_DEVICE
            || self.global_limit_samples == 0
            || self.global_limit_samples > MAX_GLOBAL
            || self.global_used_samples > MAX_GLOBAL
            || self.device_remaining_samples
                != self
                    .device_limit_samples
                    .saturating_sub(self.device_used_samples)
            || self.global_remaining_samples
                != self
                    .global_limit_samples
                    .saturating_sub(self.global_used_samples)
        {
            return Err("Invalid transcription service quota".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    origin: String,
    checked_at: u64,
    capabilities: Capabilities,
    quota: Quota,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(8_640_000_000_000_000) as u64
}
fn client() -> Result<Client> {
    Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Cannot initialize cloud transcription connection".into())
}
async fn response(mut response: Response, max: usize) -> Result<Zeroizing<Vec<u8>>> {
    if response.status() != reqwest::StatusCode::OK {
        return Err(match response.status().as_u16() {
            401 | 403 => "Transcription service device token was rejected or revoked",
            404 => "Transcription job expired or service address is incorrect",
            409 => "Transcription service has an active or cancelled job; retry explicitly later",
            429 => "Transcription service audio quota is exhausted",
            413 => "Transcription service rejected the audio size",
            502 => "Transcription provider is unavailable; audio quota may have been consumed",
            _ => "Transcription service rejected the request",
        }
        .into());
    }
    if response
        .content_length()
        .is_some_and(|bytes| bytes > max as u64)
    {
        return Err("Transcription service response is too large".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Cannot read transcription service response")?
    {
        if bytes.len() + chunk.len() > max {
            return Err("Transcription service response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn verify(enrollment: &Enrollment, client: &Client) -> Result<Snapshot> {
    let bytes = response(
        client
            .get(format!("{}/v1/capabilities", enrollment.origin))
            .bearer_auth(&enrollment.token)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| "Cannot contact transcription service")?,
        4096,
    )
    .await?;
    let capabilities: Capabilities = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid transcription capabilities response")?;
    capabilities.validate()?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct QuotaResponse {
        schema_version: u8,
        quota: Quota,
    }
    let bytes = response(
        client
            .get(format!("{}/v1/quota", enrollment.origin))
            .bearer_auth(&enrollment.token)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| "Cannot contact transcription service")?,
        4096,
    )
    .await?;
    let value: QuotaResponse =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid transcription quota response")?;
    if value.schema_version != 1 {
        return Err("Unsupported transcription quota response".into());
    }
    value.quota.validate()?;
    Ok(Snapshot {
        origin: enrollment.origin.clone(),
        checked_at: now(),
        capabilities,
        quota: value.quota,
    })
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Cleanup {
    NotNeeded,
    Confirmed,
    Unconfirmed,
    Completed,
}
#[derive(Clone, Copy, Serialize)]
pub struct Cancelled {
    cancelled: bool,
    cleanup: Cleanup,
}
struct Slot {
    id: String,
    owner: String,
    session_id: Option<String>,
    epoch: u64,
    created: Instant,
    running: bool,
    cancel: watch::Sender<bool>,
    finished: watch::Receiver<Option<Cancelled>>,
    access: Option<AccessLease>,
}
#[derive(Default)]
struct Inner {
    epoch: u64,
    verified: Option<Snapshot>,
    active: Option<Slot>,
    last: Option<(String, Cancelled)>,
    closed_owners: std::collections::HashSet<String>,
}
#[derive(Clone)]
pub struct CloudState {
    inner: Arc<Mutex<Inner>>,
    changing: Arc<AsyncMutex<()>>,
    vault_work: Arc<tokio::sync::Semaphore>,
}
impl Default for CloudState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            changing: Arc::new(AsyncMutex::new(())),
            vault_work: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
}
async fn vault<T: Send + 'static>(
    state: &CloudState,
    task: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let permit = state
        .vault_work
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Cloud vault is busy; wait for the operating-system credential request")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        task()
    })
    .await
    .map_err(|_| "Cloud vault operation failed".to_owned())?
}
impl CloudState {
    /// Invalidate recordings on lock without permanently closing their window.
    pub(crate) fn cancel_for_lock(&self) {
        let _ = self.changed();
    }
    fn changed(&self) -> Result<u64> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Cloud transcription lock failed")?;
        inner.epoch = inner.epoch.wrapping_add(1);
        inner.verified = None;
        if let Some(slot) = inner.active.as_ref() {
            slot.cancel.send_replace(true);
        }
        if inner.active.as_ref().is_some_and(|slot| !slot.running) {
            inner.active = None;
        }
        Ok(inner.epoch)
    }
    #[cfg(test)]
    fn begin(&self, owner: &str, session_id: Option<String>) -> Result<String> {
        self.begin_scoped(owner, session_id, None)
    }
    fn begin_scoped(
        &self,
        owner: &str,
        session_id: Option<String>,
        access: Option<AccessLease>,
    ) -> Result<String> {
        let _configuration = self
            .changing
            .try_lock()
            .map_err(|_| "Cloud enrollment is changing or being checked")?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Cloud transcription lock failed")?;
        if inner.closed_owners.contains(owner) {
            return Err("Recording window is closed".into());
        }
        let snapshot = inner
            .verified
            .as_ref()
            .ok_or("Check the enrolled transcription service before recording")?;
        if snapshot.quota.device_remaining_samples < 1600
            || snapshot.quota.global_remaining_samples < 1600
        {
            return Err("Transcription service audio quota is exhausted".into());
        }
        if inner
            .active
            .as_ref()
            .is_some_and(|slot| slot.running || slot.created.elapsed() < Duration::from_secs(120))
        {
            return Err("Wait for the current cloud recording to finish or cancel".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (cancel, _) = watch::channel(false);
        let (_, finished) = watch::channel(None);
        inner.active = Some(Slot {
            id: id.clone(),
            owner: owner.into(),
            session_id,
            epoch: inner.epoch,
            created: Instant::now(),
            running: false,
            cancel,
            finished,
            access,
        });
        Ok(id)
    }
    fn begin_for_access(
        &self,
        owner: &str,
        session_id: Option<String>,
        access: &AccessLease,
    ) -> Result<String> {
        access.check()?;
        // A policy change can revoke a begin reply without a background event.
        // Inspect its lease outside both locks, then cancel by immutable UUID.
        let previous = self
            .inner
            .lock()
            .map_err(|_| "Cloud transcription lock failed")?
            .active
            .as_ref()
            .and_then(|slot| slot.access.clone().map(|lease| (slot.id.clone(), lease)));
        if let Some((id, lease)) = previous {
            if lease.check().is_err() {
                // signal removes only unclaimed reservations; owned workers
                // retain their slot until their existing cleanup finishes.
                self.signal(&id, None)?;
            }
        }
        access.with_current(|| self.begin_scoped(owner, session_id, Some(access.clone())))?
    }
    fn signal(
        &self,
        id: &str,
        owner: Option<&str>,
    ) -> Result<(Option<watch::Receiver<Option<Cancelled>>>, Cancelled)> {
        if !request_id(id) {
            return Err("Invalid cloud recording identifier".into());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Cloud transcription lock failed")?;
        if let Some(slot) = inner
            .active
            .as_ref()
            .filter(|slot| slot.id == id && owner.is_none_or(|owner| slot.owner == owner))
        {
            slot.cancel.send_replace(true);
            if slot.running {
                return Ok((
                    Some(slot.finished.clone()),
                    Cancelled {
                        cancelled: true,
                        cleanup: Cleanup::Unconfirmed,
                    },
                ));
            }
            inner.active = None;
            let result = Cancelled {
                cancelled: true,
                cleanup: Cleanup::NotNeeded,
            };
            inner.last = Some((id.into(), result));
            return Ok((None, result));
        }
        Ok((
            None,
            inner
                .last
                .as_ref()
                .filter(|(previous, _)| previous == id)
                .map(|(_, result)| *result)
                .unwrap_or(Cancelled {
                    cancelled: false,
                    cleanup: Cleanup::NotNeeded,
                }),
        ))
    }
    fn destroy(&self, owner: &str) {
        let id = self.inner.lock().ok().and_then(|mut inner| {
            inner.closed_owners.insert(owner.into());
            inner
                .active
                .as_ref()
                .filter(|slot| slot.owner == owner)
                .map(|slot| slot.id.clone())
        });
        if let Some(id) = id {
            let _ = self.signal(&id, Some(owner));
        }
    }
}
async fn commit(
    state: CloudState,
    guard: OwnedMutexGuard<()>,
    epoch: u64,
    snapshot: Option<Snapshot>,
    write: impl FnOnce() -> Result<()> + Send + 'static,
) -> Result<()> {
    let admission = state.clone();
    vault(&admission, move || {
        let _guard = guard;
        write()?;
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Cloud transcription lock failed")?;
        if inner.epoch != epoch {
            return Err("Cloud enrollment changed".into());
        }
        inner.verified = snapshot;
        Ok(())
    })
    .await
}
#[derive(Serialize)]
pub struct Status {
    configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
}
#[tauri::command]
pub async fn voice_cloud_status(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, CloudState>,
) -> Protected<Status> {
    access
        .run(async {
            Ok(match load(app, &state, access.clone()).await? {
                Some(enrollment) => Status {
                    configured: true,
                    origin: Some(enrollment.origin.clone()),
                },
                None => Status {
                    configured: false,
                    origin: None,
                },
            })
        })
        .await
}
#[tauri::command]
pub async fn voice_cloud_enroll(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, CloudState>,
    origin: String,
    token: String,
) -> Protected<Snapshot> {
    access
        .run(async {
            let operation = app.vault().operation();
            let token = Zeroizing::new(token);
            if !self::token(&token) {
                return Err("Enter the service's 64-character device token".into());
            }
            let enrollment = Enrollment {
                version: 1,
                origin: self::origin(&origin)?,
                token: token.to_string(),
            };
            let guard = state.changing.clone().lock_owned().await;
            let epoch = state.changed()?;
            let snapshot = verify(&enrollment, &client()?).await?;
            let encoded = Zeroizing::new(
                serde_json::to_string(&enrollment).map_err(|_| "Cannot encode cloud enrollment")?,
            );
            commit(
                state.inner().clone(),
                guard,
                epoch,
                Some(snapshot.clone()),
                move || {
                    app.vault()
                        .set_protected_for(ACCOUNT, &encoded, false, &operation)
                },
            )
            .await?;
            Ok(snapshot)
        })
        .await
}
#[tauri::command]
pub async fn voice_cloud_refresh(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, CloudState>,
) -> Protected<Snapshot> {
    access
        .run(async {
            let _configuration = state.changing.lock().await;
            let epoch = state
                .inner
                .lock()
                .map_err(|_| "Cloud transcription lock failed")?
                .epoch;
            let enrollment = load(app, &state, access.clone())
                .await?
                .ok_or("Enroll a transcription service first")?;
            let snapshot = verify(&enrollment, &client()?).await?;
            access.with_current(|| {
                let mut inner = state
                    .inner
                    .lock()
                    .map_err(|_| "Cloud transcription lock failed")?;
                if inner.epoch != epoch {
                    return Err("Cloud enrollment changed".into());
                }
                inner.verified = Some(snapshot.clone());
                Ok(snapshot)
            })?
        })
        .await
}
#[tauri::command]
pub async fn voice_cloud_forget(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, CloudState>,
) -> Protected<()> {
    access
        .run(async {
            let operation = app.vault().operation();
            let guard = state.changing.clone().lock_owned().await;
            let epoch = state.changed()?;
            commit(state.inner().clone(), guard, epoch, None, move || {
                operation.check()?;
                app.vault().delete(ACCOUNT)
            })
            .await
        })
        .await
}
#[tauri::command]
pub fn voice_cloud_begin(
    access: AccessLease,
    state: State<'_, CloudState>,
    window: WebviewWindow,
    session_id: Option<String>,
) -> Protected<String> {
    access.run_sync(|| {
        if session_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
        {
            return Err("Invalid recording session".into());
        }
        state.begin_for_access(window.label(), session_id, &access)
    })
}
#[tauri::command]
pub async fn voice_cloud_cancel(
    state: State<'_, CloudState>,
    window: WebviewWindow,
    request_id: String,
) -> Result<Cancelled> {
    cancel(&state, &request_id, Some(window.label())).await
}
async fn cancel(state: &CloudState, id: &str, owner: Option<&str>) -> Result<Cancelled> {
    let (finished, result) = state.signal(id, owner)?;
    if let Some(mut finished) = finished {
        return Ok(tokio::time::timeout(Duration::from_secs(7), async {
            loop {
                if let Some(result) = *finished.borrow() {
                    return result;
                }
                if finished.changed().await.is_err() {
                    return result;
                }
            }
        })
        .await
        .unwrap_or(result));
    }
    Ok(result)
}
fn wav(samples: &[f32]) -> Result<Zeroizing<Vec<u8>>> {
    if !(1600..=480000).contains(&samples.len())
        || samples
            .iter()
            .any(|sample| !sample.is_finite() || sample.abs() > 1.0)
    {
        return Err("Audio must contain 0.1–30 seconds of finite mono 16 kHz samples".into());
    }
    let size = (samples.len() * 2) as u32;
    let mut bytes = Zeroizing::new(lazysh_common::audio::pcm16_mono_16khz_header(size));
    bytes.reserve_exact(size as usize);
    for value in samples {
        let value = (value * if *value < 0.0 { 32768.0 } else { 32767.0 }).round() as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    Ok(bytes)
}
struct Work {
    state: CloudState,
    id: String,
    epoch: u64,
    cancel: watch::Receiver<bool>,
    finished: watch::Sender<Option<Cancelled>>,
    access: Option<AccessLease>,
}
impl Work {
    fn claim(
        state: CloudState,
        id: &str,
        owner: &str,
        session_id: Option<&str>,
        language: &str,
    ) -> Result<Self> {
        // Check the reservation's immutable lease without holding the recording
        // mutex; begin_scoped is admitted under the authority in the opposite order.
        let reservation_access = state
            .inner
            .lock()
            .map_err(|_| "Cloud transcription lock failed")?
            .active
            .as_ref()
            .filter(|slot| slot.id == id)
            .and_then(|slot| slot.access.clone());
        if let Some(access) = reservation_access.as_ref() {
            access.check()?;
        }
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Cloud transcription lock failed")?;
        if inner.closed_owners.contains(owner) {
            return Err("Recording window is closed".into());
        }
        if !inner.verified.as_ref().is_some_and(|snapshot| {
            snapshot
                .capabilities
                .languages
                .iter()
                .any(|hint| hint == language)
        }) {
            return Err("Unsupported cloud transcription language".into());
        }
        let epoch = inner.epoch;
        let slot = inner
            .active
            .as_mut()
            .filter(|slot| {
                slot.id == id && slot.owner == owner && slot.session_id.as_deref() == session_id
            })
            .ok_or("Cloud recording expired or cancelled")?;
        if slot.running
            || slot.epoch != epoch
            || slot.created.elapsed() >= Duration::from_secs(120)
            || *slot.cancel.borrow()
        {
            return Err("Cloud recording expired or cancelled".into());
        }
        let access = slot.access.clone();
        let (finished, receiver) = watch::channel(None);
        slot.finished = receiver;
        slot.running = true;
        let cancel = slot.cancel.subscribe();
        drop(inner);
        Ok(Self {
            state,
            id: id.into(),
            epoch,
            cancel,
            finished,
            access,
        })
    }
    fn bind_access(&mut self, access: AccessLease) {
        self.access = Some(access.clone());
        let state = self.state.clone();
        let id = self.id.clone();
        let mut finished = self.finished.subscribe();
        // One watcher per owned recording, terminated by its finalization.
        tokio::spawn(async move {
            tokio::select! { biased;
                _ = access.cancelled() => { let _ = state.signal(&id, None); },
                _ = finished.changed() => {},
            }
        });
    }
    fn check(&self) -> Result<()> {
        if let Some(access) = self.access.as_ref() {
            access.check()?;
        }
        let inner = self
            .state
            .inner
            .lock()
            .map_err(|_| "Cloud transcription lock failed")?;
        if inner.epoch != self.epoch
            || *self.cancel.borrow()
            || !inner.active.as_ref().is_some_and(|slot| slot.id == self.id)
        {
            return Err("Cloud transcription cancelled".into());
        }
        Ok(())
    }
    fn finish(&mut self, result: Result<Completed>, cleanup: Cleanup) -> Result<Completed> {
        let access_valid = self
            .access
            .as_ref()
            .is_none_or(|lease| lease.check().is_ok());
        let mut inner = self
            .state
            .inner
            .lock()
            .map_err(|_| "Cloud transcription lock failed")?;
        let valid = access_valid
            && inner.epoch == self.epoch
            && !*self.cancel.borrow()
            && inner.active.as_ref().is_some_and(|slot| slot.id == self.id);
        let response = if valid {
            result
        } else {
            Err("Cloud transcription cancelled".into())
        };
        if let Ok(result) = response.as_ref() {
            if let Some(snapshot) = inner.verified.as_mut() {
                snapshot.quota = result.quota.clone();
                snapshot.checked_at = result.checked_at;
            }
        }
        let finished = Cancelled {
            cancelled: !valid,
            cleanup: if response.is_ok() {
                Cleanup::Completed
            } else {
                cleanup
            },
        };
        if inner.active.as_ref().is_some_and(|slot| slot.id == self.id) {
            inner.active = None;
        }
        inner.last = Some((self.id.clone(), finished));
        self.finished.send_replace(Some(finished));
        response
    }
}
impl Drop for Work {
    fn drop(&mut self) {
        if self.finished.borrow().is_none() {
            if let Ok(mut inner) = self.state.inner.lock() {
                if inner.active.as_ref().is_some_and(|slot| slot.id == self.id) {
                    inner.active = None;
                }
            }
            self.finished.send_replace(Some(Cancelled {
                cancelled: true,
                cleanup: Cleanup::Unconfirmed,
            }));
        }
    }
}
async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}
async fn credential<T>(
    cancel: &mut watch::Receiver<bool>,
    future: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {biased;_=cancelled(cancel)=>Err("Cloud transcription cancelled".into()),result=future=>result}
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completed {
    request_id: String,
    text: String,
    quota: Quota,
    checked_at: u64,
}
async fn remove(client: &Client, enrollment: &Enrollment, id: &str) -> Cleanup {
    match client
        .delete(format!("{}/v1/transcriptions/{id}", enrollment.origin))
        .bearer_auth(&enrollment.token)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if [204, 404].contains(&response.status().as_u16()) => Cleanup::Confirmed,
        _ => Cleanup::Unconfirmed,
    }
}
async fn run(
    work: &mut Work,
    enrollment: Enrollment,
    client: Client,
    audio: Zeroizing<Vec<u8>>,
    language: String,
) -> (Result<Completed>, Cleanup) {
    let mut server_id = None;
    let mut attempted = false;
    let result=async {
        work.check()?;
        let bound=work.state.inner.lock().map_err(|_|"Cloud transcription lock failed")?.verified.as_ref().map(|snapshot|snapshot.origin.clone());
        if bound.as_deref()!=Some(&enrollment.origin) {return Err("Cloud enrollment changed".into());}
        attempted=true;
        let response=tokio::select!{biased;_=cancelled(&mut work.cancel)=>return Err("Cloud transcription cancelled".into()), result=async {
            response(client.post(format!("{}/v1/transcriptions",enrollment.origin)).bearer_auth(&enrollment.token).header("content-type","application/json")
                .body(serde_json::json!({"language":language}).to_string()).timeout(Duration::from_secs(10)).send().await.map_err(|_|"Cannot register cloud transcription")?,4096).await
        }=>result?};
        #[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)] struct Registered {schema_version:u8,job_id:String,upload_within_seconds:u32}
        let registered:Registered=serde_json::from_slice(&response).map_err(|_|"Invalid cloud registration response")?;
        if registered.schema_version!=1 || !job_id(&registered.job_id) || registered.upload_within_seconds!=30 {return Err("Invalid cloud registration response".into());}
        server_id=Some(registered.job_id.clone());work.check()?;
        let response=tokio::select!{biased;_=cancelled(&mut work.cancel)=>return Err("Cloud transcription cancelled".into()), result=async {
            self::response(client.put(format!("{}/v1/transcriptions/{}/audio",enrollment.origin,registered.job_id)).bearer_auth(&enrollment.token).header("content-type","audio/wav")
                .body(audio.to_vec()).timeout(Duration::from_secs(60)).send().await.map_err(|_|"Cloud transcription failed; service audio quota may have been consumed")?,MAX_RESPONSE).await
        }=>result?};
        #[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)] struct Final {schema_version:u8,job_id:String,text:String,quota:Quota}
        let value:Final=serde_json::from_slice(&response).map_err(|_|"Invalid cloud transcription response")?;
        if value.schema_version!=1 || value.job_id!=registered.job_id || value.text.len()>16384 || value.text.contains('\0') {return Err("Invalid cloud transcription response".into());}value.quota.validate()?;
        work.check()?;Ok(Completed {request_id:work.id.clone(),text:value.text,quota:value.quota,checked_at:now()})
    }.await;
    let cleanup = if result.is_ok() {
        Cleanup::Completed
    } else if let Some(id) = server_id {
        remove(&client, &enrollment, &id).await
    } else if attempted {
        Cleanup::Unconfirmed
    } else {
        Cleanup::NotNeeded
    };
    (result, cleanup)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Native-injected lease plus the existing recording contract.
pub async fn voice_cloud_transcribe(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, CloudState>,
    window: WebviewWindow,
    request_id: String,
    samples: Vec<f32>,
    language: String,
    session_id: Option<String>,
) -> Protected<Completed> {
    access
        .run(async {
            let samples = Zeroizing::new(samples);
            let mut work = Work::claim(
                state.inner().clone(),
                &request_id,
                window.label(),
                session_id.as_deref(),
                &language,
            )?;
            work.bind_access(access.clone());
            let audio = match wav(&samples) {
                Ok(audio) => audio,
                Err(error) => return work.finish(Err(error), Cleanup::NotNeeded),
            };
            drop(samples);
            let worker_access = access.clone();
            // This one bounded worker owns cleanup even when its IPC caller disappears.
            tokio::spawn(async move {
                let scope = work.state.clone();
                let (result, cleanup) =
                    match credential(&mut work.cancel, load(app, &scope, worker_access)).await {
                        Ok(Some(enrollment)) => match client() {
                            Ok(client) => run(&mut work, enrollment, client, audio, language).await,
                            Err(error) => (Err(error), Cleanup::NotNeeded),
                        },
                        Ok(None) => (
                            Err("Enroll a transcription service first".into()),
                            Cleanup::NotNeeded,
                        ),
                        Err(error) => (Err(error), Cleanup::NotNeeded),
                    };
                work.finish(result, cleanup)
            })
            .await
            .map_err(|_| "Cloud transcription stopped unexpectedly".to_owned())?
        })
        .await
}
pub fn install_cleanup(app: &tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<CloudState>().inner().clone();
    if let Some(window) = app.get_webview_window("main") {
        let owner = window.label().to_owned();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                state.destroy(&owner);
            }
        });
    }
    Ok(())
}
#[cfg(test)]
mod tests;
