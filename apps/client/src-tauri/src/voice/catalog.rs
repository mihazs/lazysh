use super::{begin, chunk, finish, Result, VoiceState, MAX_MODEL};
use crate::app_lock::{AccessLease, Guarded, GuardedError};
type Protected<T> = std::result::Result<Guarded<T>, GuardedError<String>>;
use reqwest::{Client, Url};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};
use tokio::sync::watch;

const REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel<'a> {
    id: &'a str,
    file: &'a str,
    label: &'a str,
    bytes: u64,
    sha256: &'a str,
    revision: &'a str,
}
// Sizes and SHA-256 values are the publisher's Git LFS object identities at REVISION.
const MODELS: [CatalogModel<'static>; 4] = [
    CatalogModel {
        id: "tiny.en",
        file: "ggml-tiny.en.bin",
        label: "Tiny · English",
        bytes: 77_704_715,
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
        revision: REVISION,
    },
    CatalogModel {
        id: "tiny",
        file: "ggml-tiny.bin",
        label: "Tiny · Multilingual",
        bytes: 77_691_713,
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        revision: REVISION,
    },
    CatalogModel {
        id: "base.en",
        file: "ggml-base.en.bin",
        label: "Base · English",
        bytes: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        revision: REVISION,
    },
    CatalogModel {
        id: "base",
        file: "ggml-base.bin",
        label: "Base · Multilingual",
        bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        revision: REVISION,
    },
];
#[tauri::command]
pub fn voice_model_catalog() -> Vec<CatalogModel<'static>> {
    MODELS.to_vec()
}

struct Job {
    id: String,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
struct Jobs {
    active: Option<Job>,
    cancelled: VecDeque<String>,
    published: VecDeque<String>,
}
#[derive(Default)]
pub(super) struct Downloads(Mutex<Jobs>);
pub(super) fn cancel_for_lock(state: &VoiceState) {
    if let Ok(mut jobs) = state.downloads.0.lock() {
        if let Some(job) = jobs.active.as_ref() {
            job.cancel.send_replace(true);
            let id = job.id.clone();
            remember(&mut jobs.cancelled, &id);
        }
    }
}
fn remember(list: &mut VecDeque<String>, id: &str) {
    if !list.iter().any(|entry| entry == id) {
        list.push_back(id.to_owned());
    }
    // One active download; retain 128 completed/cancelled IDs to reject late queued requests.
    if list.len() > 128 {
        list.pop_front();
    }
}
fn valid_request(id: &str) -> bool {
    id.len() == 36 && uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
}
fn cancel(state: &VoiceState, id: &str) -> Result<bool> {
    if !valid_request(id) {
        return Err("Invalid model download request".into());
    }
    let mut jobs = state
        .downloads
        .0
        .lock()
        .map_err(|_| "Model download lock failed")?;
    if jobs.published.iter().any(|entry| entry == id) {
        return Ok(false);
    }
    remember(&mut jobs.cancelled, id);
    if let Some(job) = jobs.active.as_ref().filter(|job| job.id == id) {
        job.cancel.send_replace(true);
    }
    Ok(true)
}
#[tauri::command]
pub fn voice_download_cancel(state: State<'_, VoiceState>, request_id: String) -> Result<bool> {
    cancel(&state, &request_id)
}

struct Download<'a> {
    state: &'a VoiceState,
    id: String,
    import_id: Option<String>,
    cancel: watch::Receiver<bool>,
}
impl<'a> Download<'a> {
    fn reserve(state: &'a VoiceState, id: &str) -> Result<Self> {
        if !valid_request(id) {
            return Err("Invalid model download request".into());
        }
        let mut jobs = state
            .downloads
            .0
            .lock()
            .map_err(|_| "Model download lock failed")?;
        if jobs
            .cancelled
            .iter()
            .chain(jobs.published.iter())
            .any(|entry| entry == id)
        {
            return Err("Model download expired or cancelled".into());
        }
        if jobs.active.is_some() {
            return Err("Wait for the current model download to finish or cancel".into());
        }
        let (sender, receiver) = watch::channel(false);
        jobs.active = Some(Job {
            id: id.into(),
            cancel: sender,
        });
        Ok(Self {
            state,
            id: id.into(),
            import_id: None,
            cancel: receiver,
        })
    }
    fn publish(&mut self) -> Result<()> {
        let mut jobs = self
            .state
            .downloads
            .0
            .lock()
            .map_err(|_| "Model download lock failed")?;
        if !jobs
            .active
            .as_ref()
            .is_some_and(|job| job.id == self.id && !*job.cancel.borrow())
        {
            return Err("Model download cancelled".into());
        }
        // Cancellation and the existing exclusive publication commit linearize under this lock.
        let import_id = self.import_id.take().ok_or("Model import expired")?;
        finish(self.state, &import_id, false)?;
        remember(&mut jobs.published, &self.id);
        jobs.active = None;
        Ok(())
    }
}
impl Drop for Download<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.import_id.take() {
            let _ = finish(self.state, &id, true);
        }
        if let Ok(mut jobs) = self.state.downloads.0.lock() {
            if jobs.active.as_ref().is_some_and(|job| job.id == self.id) {
                jobs.active = None;
            }
            if !jobs.published.iter().any(|id| id == &self.id) {
                remember(&mut jobs.cancelled, &self.id);
            }
        }
    }
}
async fn cancellation(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}
fn publisher_url(url: &Url) -> bool {
    super::download::https_without_credentials(url)
        && url.host_str().is_some_and(|host| {
            host == "huggingface.co"
                || host.ends_with(".huggingface.co")
                || host == "hf.co"
                || host.ends_with(".hf.co")
        })
}
fn client() -> Result<Client> {
    super::download::client(publisher_url, "Unsupported model download redirect")
        .map_err(|_| "Cannot initialize model download".into())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress<'a> {
    request_id: &'a str,
    received: u64,
    total: u64,
    stage: &'static str,
}

async fn download(
    state: &VoiceState,
    model: &CatalogModel<'_>,
    request_id: &str,
    client: Client,
    url: &str,
    mut progress: impl FnMut(DownloadProgress<'_>) -> Result<()>,
) -> Result<()> {
    if !(1024..=MAX_MODEL).contains(&model.bytes) {
        return Err("Model exceeds the 160 MiB limit".into());
    }
    let mut job = Download::reserve(state, request_id)?;
    job.import_id = Some(begin(state, model.file.into(), model.bytes)?);
    let mut response = tokio::select! {
        biased;
        _ = cancellation(&mut job.cancel) => return Err("Model download cancelled".into()),
        response = client.get(url).header(reqwest::header::ACCEPT_ENCODING, "identity").send() => response.map_err(|_| "Model download connection failed or timed out")?,
    };
    if response.status() != reqwest::StatusCode::OK {
        return Err("Model publisher did not return a downloadable file".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length != model.bytes || length > MAX_MODEL)
    {
        return Err("Model download size differs from the pinned catalog".into());
    }
    progress(DownloadProgress {
        request_id,
        received: 0,
        total: model.bytes,
        stage: "downloading",
    })?;
    let mut received = 0u64;
    let mut hash = Sha256::new();
    let mut reported = Instant::now();
    let mut reported_bytes = 0;
    let mut prefix = [0u8; 4];
    let mut prefix_len = 0;
    loop {
        let bytes = tokio::select! {
            biased;
            _ = cancellation(&mut job.cancel) => return Err("Model download cancelled".into()),
            next = response.chunk() => next.map_err(|_| "Model download interrupted or timed out")?,
        };
        let Some(bytes) = bytes else { break };
        if bytes.is_empty() {
            continue;
        }
        let buffered = if received == 0 { prefix_len as u64 } else { 0 };
        if bytes.len() as u64 > model.bytes.saturating_sub(received + buffered) {
            return Err("Model download exceeds the pinned size".into());
        }
        let mut offset = 0;
        if received == 0 {
            offset = bytes.len().min(4 - prefix_len);
            prefix[prefix_len..prefix_len + offset].copy_from_slice(&bytes[..offset]);
            prefix_len += offset;
            if prefix_len < 4 {
                continue;
            }
            chunk(
                state,
                job.import_id.as_deref().ok_or("Model import expired")?,
                0,
                &prefix,
            )?;
            hash.update(prefix);
            received = 4;
        }
        for part in bytes[offset..].chunks(1024 * 1024) {
            if *job.cancel.borrow() {
                return Err("Model download cancelled".into());
            }
            chunk(
                state,
                job.import_id.as_deref().ok_or("Model import expired")?,
                received,
                part,
            )?;
            hash.update(part);
            received += part.len() as u64;
        }
        if reported_bytes == 0
            || received == model.bytes
            || received - reported_bytes >= 1024 * 1024
            || reported.elapsed() >= Duration::from_millis(250)
        {
            progress(DownloadProgress {
                request_id,
                received,
                total: model.bytes,
                stage: "downloading",
            })?;
            reported = Instant::now();
            reported_bytes = received;
        }
    }
    if received != model.bytes {
        return Err("Model download is incomplete".into());
    }
    progress(DownloadProgress {
        request_id,
        received,
        total: model.bytes,
        stage: "verifying",
    })?;
    if format!("{:x}", hash.finalize()) != model.sha256 {
        return Err("Model SHA-256 verification failed; no model was installed".into());
    }
    job.publish()?;
    let _ = progress(DownloadProgress {
        request_id,
        received,
        total: model.bytes,
        stage: "installed",
    });
    Ok(())
}
#[tauri::command]
pub async fn voice_download_model(
    access: AccessLease,
    state: State<'_, VoiceState>,
    id: String,
    request_id: String,
    events: Channel<serde_json::Value>,
) -> Protected<()> {
    access
        .run(async {
            let model = MODELS
                .iter()
                .find(|model| model.id == id)
                .ok_or("Unknown Whisper catalog model")?;
            let url = format!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/{REVISION}/{}",
                model.file
            );
            download(&state, model, &request_id, client()?, &url, |event| {
                access.check()?;
                events
                    .send(
                        serde_json::to_value(event)
                            .map_err(|_| "Invalid model download progress")?,
                    )
                    .map_err(|_| "Model download progress channel unavailable".into())
            })
            .await
        })
        .await
}

#[cfg(test)]
mod tests;
