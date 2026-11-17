use super::*;
use lazysh_parakeet_runtime::{
    Recognizer, VerifiedBundle, ARCHIVE_SHA256, ARCHIVE_URL, MAX_SAMPLES,
};
use reqwest::{Client, Url};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::Path,
    sync::{atomic::Ordering, Mutex},
    time::Duration,
};
use tokio::sync::watch;

// The private cache is trusted from the operating system's own notion of ownership: mode bits on Unix, the owner
// SID and DACL on Windows.
#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

const CACHE_ERROR: &str =
    "Private Parakeet model storage is unavailable or is in use by another app process";
const CANCELLED: &str = "Parakeet result cancelled; native work may still be finishing";
const ARCHIVE_NAME: &str = "parakeet-v3-int8.tar.bz2";
/// Peak extra disk use while installing: the download, the private verification snapshot and the four extracted
/// files coexist (docs/voice-parakeet.md). Preparing an already stored archive needs only the last two.
const PEAK_DISK_BYTES: u64 = 1_644_999_670;
const PUBLISH_FAILED: &str = "Cannot install Parakeet model; destination may already exist";
// The release asset URL is mutable upstream; a replaced archive must read as such, not as a network fault.
const REPUBLISHED: &str = "The downloaded Parakeet archive does not match the one this lazysh version pins, so nothing was installed. The publisher may have replaced it; if this persists, update lazysh";
struct Cache {
    root: PathBuf,
    _lock: File,
}
impl Drop for Cache {
    fn drop(&mut self) {
        // A concurrent fork can retain this open file description after the owner drops it.
        let _ = self._lock.unlock();
    }
}
impl Cache {
    fn new(root: PathBuf) -> Result<Self> {
        let parent = platform::trusted_parent(&root)?;
        let root = parent.join("parakeet");
        match platform::create_private_directory(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(CACHE_ERROR.into()),
        }
        private(&root, true)?;
        let lock_path = root.join("cache.lock");
        if lock_path.symlink_metadata().is_ok() {
            private(&lock_path, false)?;
        }
        let lock = open_lock(&lock_path).map_err(|_| CACHE_ERROR)?;
        platform::private(
            &lock_path,
            &lock.metadata().map_err(|_| CACHE_ERROR)?,
            false,
        )?;
        lock.try_lock().map_err(|_| CACHE_ERROR)?;
        let cache = Self { root, _lock: lock };
        // Exclusive process ownership precedes cleanup; never remove another live recognizer's files.
        for entry in fs::read_dir(&cache.root).map_err(|_| CACHE_ERROR)? {
            let entry = entry.map_err(|_| CACHE_ERROR)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.strip_suffix(".part").is_some_and(valid_id) {
                private(&entry.path(), false)?;
                fs::remove_file(entry.path()).map_err(|_| CACHE_ERROR)?;
            } else if name.strip_prefix("lazysh-parakeet-").is_some_and(|tail| {
                tail.len() == 6 && tail.bytes().all(|c| c.is_ascii_alphanumeric())
            }) {
                private(&entry.path(), true)?;
                fs::remove_dir_all(entry.path()).map_err(|_| CACHE_ERROR)?;
            }
        }
        Ok(cache)
    }
    fn archive(&self) -> PathBuf {
        self.root.join(ARCHIVE_NAME)
    }
    fn installed(&self) -> bool {
        private(&self.archive(), false).is_ok()
    }
    fn open_archive(&self) -> Result<File> {
        let path = self.archive();
        let file = open_archive(&path).map_err(|_| "Download the Parakeet model first")?;
        let metadata = file.metadata().map_err(|_| CACHE_ERROR)?;
        platform::private(&path, &metadata, false)?;
        if metadata.len() != ARCHIVE_BYTES {
            return Err("Stored Parakeet archive is not the one this lazysh version pins (an earlier version may have installed it); remove it and download again".into());
        }
        Ok(file)
    }
}
/// The model lives on private storage that may be small, so a lack of space is refused before any byte is written.
fn require_free_space(directory: &Path, needed: u64) -> Result<()> {
    if platform::free_space(directory)? < needed {
        return Err(format!(
            "Parakeet needs about {:.1} GB of free storage to prepare its model; free some space and try again",
            needed as f64 / 1e9
        ));
    }
    Ok(())
}
fn open_lock(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    platform::owner_only(&mut options);
    platform::no_follow(&mut options);
    options.open(path)
}
fn open_archive(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    platform::no_follow(&mut options);
    options.open(path)
}
/// A new download that is not private on arrival is removed before any byte is written to it.
fn create_partial(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    platform::owner_only(&mut options);
    let file = options.open(path)?;
    if let Err(error) = platform::private(path, &file.metadata()?, false) {
        let _ = fs::remove_file(path);
        return Err(std::io::Error::other(error));
    }
    Ok(file)
}
/// `path` is a private, unlinked directory or regular file of the expected kind (never a link followed).
fn private(path: &Path, directory: bool) -> Result<()> {
    platform::private(
        path,
        &fs::symlink_metadata(path).map_err(|_| CACHE_ERROR)?,
        directory,
    )
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id)
}
struct Slot {
    id: String,
    cancel: watch::Sender<bool>,
    stage: &'static str,
    received: u64,
    access: AccessLease,
}
#[derive(Default)]
struct Inner {
    active: Option<Slot>,
    engine: Option<Recognizer>,
    expired: VecDeque<String>,
    committed: VecDeque<String>,
}
pub(super) struct Manager {
    cache: Cache,
    inner: Mutex<Inner>,
    capacity: Arc<AtomicBool>,
    peak_disk: u64,
}
impl Manager {
    pub(super) fn new(root: PathBuf, capacity: Arc<AtomicBool>) -> Result<Arc<Self>> {
        Self::with_peak_disk(root, capacity, PEAK_DISK_BYTES)
    }
    fn with_peak_disk(
        root: PathBuf,
        capacity: Arc<AtomicBool>,
        peak_disk: u64,
    ) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            cache: Cache::new(root)?,
            inner: Mutex::new(Inner::default()),
            capacity,
            peak_disk,
        }))
    }
    pub(super) fn status(&self) -> Status {
        // Filesystem latency must not hold the slot mutex needed by authority-gated reserve/commit.
        let installed = self.cache.installed();
        let Ok(inner) = self.inner.lock() else {
            return Status::unavailable("Parakeet state is unavailable".into());
        };
        let slot = inner.active.as_ref();
        let access = slot.map(|slot| slot.access.clone());
        let mut status = Status {
            available: true,
            reason: String::new(),
            installed,
            ready: inner.engine.is_some(),
            busy: self.capacity.load(Ordering::Acquire),
            stage: slot
                .map_or("idle", |s| {
                    if *s.cancel.borrow() {
                        "finishing"
                    } else {
                        s.stage
                    }
                })
                .into(),
            request_id: slot.map(|s| s.id.clone()),
            received: slot.map_or(0, |s| s.received),
            total: ARCHIVE_BYTES,
        };
        drop(inner);
        // Reserve takes authority before the slot lock; do not invert that order here.
        if access.is_some_and(|lease| lease.check().is_err()) {
            status.stage = "finishing".into();
        }
        status
    }
    fn reserve(
        self: &Arc<Self>,
        access: &AccessLease,
        id: &str,
        stage: &'static str,
    ) -> Result<Work> {
        if !valid_id(id) {
            return Err("Invalid Parakeet request".into());
        }
        access.with_current(|| {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Parakeet state is unavailable")?;
            if inner
                .expired
                .iter()
                .chain(inner.committed.iter())
                .any(|old| old == id)
            {
                return Err("Parakeet request expired or cancelled".into());
            }
            if inner.active.is_some() || self.capacity.swap(true, Ordering::AcqRel) {
                return Err("Wait for the native speech worker to finish".into());
            }
            let (cancel, receiver) = watch::channel(false);
            inner.active = Some(Slot {
                id: id.into(),
                cancel,
                stage,
                received: 0,
                access: access.clone(),
            });
            Ok(Work {
                manager: self.clone(),
                id: id.into(),
                access: access.clone(),
                cancel: receiver,
                engine: inner.engine.take(),
                keep_engine: true,
                partial: None,
            })
        })?
    }
    pub(super) fn cancel(&self, id: &str) -> Result<Cancelled> {
        if !valid_id(id) {
            return Err("Invalid Parakeet request".into());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Parakeet state is unavailable")?;
        if inner.committed.iter().any(|old| old == id) {
            return Ok(Cancelled {
                cancelled: false,
                finishing: false,
            });
        }
        remember(&mut inner.expired, id);
        let mut finishing = false;
        if let Some(slot) = inner.active.as_ref().filter(|slot| slot.id == id) {
            slot.cancel.send_replace(true);
            finishing = true;
        }
        Ok(Cancelled {
            cancelled: true,
            finishing,
        })
    }
    pub(super) fn cancel_active(&self) {
        if let Ok(inner) = self.inner.lock() {
            if let Some(slot) = inner.active.as_ref() {
                slot.cancel.send_replace(true);
            }
        }
    }
    pub(super) async fn install(
        self: &Arc<Self>,
        access: &AccessLease,
        id: &str,
        events: Channel<Status>,
    ) -> Result<()> {
        let mut work = self.reserve(access, id, "downloading")?;
        if self.cache.archive().exists() {
            return Err("Remove the existing Parakeet model before installing".into());
        }
        require_free_space(&self.cache.root, self.peak_disk)?;
        work.keep_engine = false;
        let partial = self.cache.root.join(format!("{id}.part"));
        let mut file = create_partial(&partial).map_err(|_| "Cannot create Parakeet download")?;
        work.partial = Some(partial.clone());
        transfer(
            &mut work,
            &mut file,
            publisher_client()?,
            ARCHIVE_URL,
            ARCHIVE_BYTES,
            ARCHIVE_SHA256,
            |status| {
                let _ = access.with_current(|| events.send(status));
            },
        )
        .await?;
        // No lease/permit lives only in this awaiter: Work moves into the blocking closure.
        tokio::task::spawn_blocking(move || install_worker(work, file, partial))
            .await
            .map_err(|_| "Parakeet preparation worker failed".to_owned())?
    }
    pub(super) async fn transcribe(
        self: &Arc<Self>,
        access: &AccessLease,
        id: &str,
        samples: Vec<f32>,
    ) -> Result<Transcript> {
        if !(1600..=MAX_SAMPLES).contains(&samples.len())
            || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.)
        {
            return Err("Audio must contain 0.1–30 seconds of finite mono 16 kHz samples".into());
        }
        let mut work = self.reserve(access, id, "preparing")?;
        tokio::task::spawn_blocking(move || {
            work.check()?;
            if work.engine.is_none() {
                let archive = work.manager.cache.open_archive()?;
                // The stored archive already occupies its share of the peak.
                let extra = work.manager.peak_disk.saturating_sub(ARCHIVE_BYTES);
                require_free_space(&work.manager.cache.root, extra)?;
                work.prepare(archive)?;
            }
            work.check()?;
            work.progress("transcribing", ARCHIVE_BYTES);
            let text = work
                .engine
                .as_mut()
                .ok_or("Parakeet model is unavailable")?
                .transcribe(&samples)
                .map_err(|error| error.to_string())?;
            work.check()?;
            Ok(Transcript {
                request_id: work.id.clone(),
                text,
            })
        })
        .await
        .map_err(|_| "Parakeet transcription worker failed".to_owned())?
    }
    pub(super) async fn remove(self: &Arc<Self>, access: &AccessLease, id: &str) -> Result<()> {
        let mut work = self.reserve(access, id, "removing")?;
        tokio::task::spawn_blocking(move || {
            work.check()?;
            work.keep_engine = false;
            drop(work.engine.take());
            work.commit(|| match fs::remove_file(work.manager.cache.archive()) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("Cannot remove Parakeet archive".into()),
            })
        })
        .await
        .map_err(|_| "Parakeet model removal worker failed".to_owned())?
    }
}
fn remember(ids: &mut VecDeque<String>, id: &str) {
    if !ids.iter().any(|old| old == id) {
        ids.push_back(id.into());
    }
    if ids.len() > 128 {
        ids.pop_front();
    }
}
fn install_worker(mut work: Work, mut file: File, partial: PathBuf) -> Result<()> {
    work.check()?;
    file.sync_all()
        .map_err(|_| "Cannot save Parakeet archive")?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "Cannot rewind Parakeet archive")?;
    work.prepare(file)?;
    work.commit(|| platform::publish(&partial, &work.manager.cache.archive()))?;
    work.keep_engine = true;
    platform::sync_directory(&work.manager.cache.root)
        .map_err(|_| "Cannot synchronize Parakeet model directory")?;
    drop(work);
    Ok(())
}
struct Work {
    manager: Arc<Manager>,
    id: String,
    access: AccessLease,
    cancel: watch::Receiver<bool>,
    engine: Option<Recognizer>,
    keep_engine: bool,
    partial: Option<PathBuf>,
}
impl Work {
    fn commit<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        self.access.with_current(|| {
            let mut inner = self
                .manager
                .inner
                .lock()
                .map_err(|_| "Parakeet state is unavailable")?;
            if !inner.active.as_ref().is_some_and(|slot| slot.id == self.id) {
                return Err(CANCELLED.into());
            }
            self.check_cancel()?;
            let value = action()?;
            remember(&mut inner.committed, &self.id);
            Ok(value)
        })?
    }
    fn check_cancel(&self) -> Result<()> {
        if *self.cancel.borrow() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
    fn check(&self) -> Result<()> {
        self.access.check()?;
        self.check_cancel()
    }
    async fn cancelled(&mut self) {
        tokio::select! {biased; _=self.access.cancelled()=>{}, _=crate::voice::cancelled(&mut self.cancel)=>{}}
    }
    fn progress(&self, stage: &'static str, received: u64) {
        if let Ok(mut inner) = self.manager.inner.lock() {
            if let Some(slot) = inner.active.as_mut().filter(|slot| slot.id == self.id) {
                slot.stage = stage;
                slot.received = received;
            }
        }
    }
    fn prepare(&mut self, file: File) -> Result<()> {
        self.check()?;
        self.progress("preparing", ARCHIVE_BYTES);
        let bundle = VerifiedBundle::read_in(file, &self.manager.cache.root)
            .map_err(|error| error.to_string())?;
        self.check()?;
        self.progress("loading", ARCHIVE_BYTES);
        let engine = Recognizer::new(bundle).map_err(|error| error.to_string())?;
        self.engine = Some(engine);
        self.check()
    }
}
impl Drop for Work {
    fn drop(&mut self) {
        if !self.keep_engine {
            drop(self.engine.take());
        }
        if let Some(path) = self.partial.take() {
            let _ = fs::remove_file(path);
        }
        if let Ok(mut inner) = self.manager.inner.lock() {
            if inner.active.as_ref().is_some_and(|slot| slot.id == self.id) {
                inner.engine = self.engine.take();
                inner.active = None;
                remember(&mut inner.expired, &self.id);
                self.manager.capacity.store(false, Ordering::Release);
            }
        }
    }
}
fn publisher_url(url: &Url) -> bool {
    super::super::download::https_without_credentials(url)
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}
// Only the production caller chooses these fixed catalog arguments; no URL/hash IPC exists.
async fn transfer(
    work: &mut Work,
    file: &mut File,
    client: Client,
    url: &str,
    expected: u64,
    digest: &str,
    mut progress: impl FnMut(Status),
) -> Result<()> {
    if expected == 0 || expected > ARCHIVE_BYTES {
        return Err("Invalid Parakeet catalog size".into());
    }
    let mut response = tokio::select! {biased; _=work.cancelled()=>return Err(CANCELLED.into()), result=client.get(url).header(reqwest::header::ACCEPT_ENCODING,"identity").send()=>result.map_err(|_| "Parakeet model download failed or timed out")?};
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "Parakeet model download failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != expected)
    {
        return Err(REPUBLISHED.into());
    }
    let mut hash = Sha256::new();
    let mut received = 0;
    let mut reported = std::time::Instant::now();
    while let Some(bytes) = tokio::select! {biased; _=work.cancelled()=>return Err(CANCELLED.into()), result=response.chunk()=>result.map_err(|_| "Parakeet download interrupted or timed out")?}
    {
        if bytes.len() as u64 > expected - received {
            return Err(REPUBLISHED.into());
        }
        work.check()?;
        file.write_all(&bytes)
            .map_err(|_| "Cannot save Parakeet archive; check free disk space")?;
        hash.update(&bytes);
        received += bytes.len() as u64;
        work.progress("downloading", received);
        if received == expected || reported.elapsed() >= Duration::from_millis(100) {
            progress(work.manager.status());
            reported = std::time::Instant::now();
        }
    }
    if received != expected || format!("{:x}", hash.finalize()) != digest {
        return Err(REPUBLISHED.into());
    }
    work.check()
}
fn publisher_client() -> Result<Client> {
    super::super::download::client(publisher_url, "Unsupported Parakeet download redirect")
        .map_err(|_| "Cannot initialize Parakeet model download".into())
}

#[cfg(test)]
mod tests;
