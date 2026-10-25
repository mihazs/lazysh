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
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    sync::{atomic::Ordering, Mutex},
    time::Duration,
};
use tokio::sync::watch;

const CACHE_ERROR: &str =
    "Private Parakeet model storage is unavailable or is in use by another app process";
const CANCELLED: &str = "Parakeet result cancelled; native work may still be finishing";
const ARCHIVE_NAME: &str = "parakeet-v3-int8.tar.bz2";
struct Cache {
    root: PathBuf,
    _lock: File,
}
impl Cache {
    fn new(root: PathBuf) -> Result<Self> {
        let parent = root
            .parent()
            .ok_or(CACHE_ERROR)?
            .canonicalize()
            .map_err(|_| CACHE_ERROR)?;
        let uid = unsafe { libc::geteuid() };
        for ancestor in parent.ancestors() {
            let metadata = fs::symlink_metadata(ancestor).map_err(|_| CACHE_ERROR)?;
            if !metadata.is_dir()
                || !matches!(metadata.uid(), 0) && metadata.uid() != uid
                || metadata.mode() & 0o022 != 0
                    && !(metadata.uid() == 0 && metadata.mode() & 0o1000 != 0)
            {
                return Err(CACHE_ERROR.into());
            }
        }
        let root = parent.join("parakeet");
        let mut builder = fs::DirBuilder::new();
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
        match builder.create(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(CACHE_ERROR.into()),
        }
        private(&fs::symlink_metadata(&root).map_err(|_| CACHE_ERROR)?, true)?;
        let lock_path = root.join("cache.lock");
        if let Ok(metadata) = fs::symlink_metadata(&lock_path) {
            private(&metadata, false)?;
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(lock_path)
            .map_err(|_| CACHE_ERROR)?;
        private(&lock.metadata().map_err(|_| CACHE_ERROR)?, false)?;
        lock.try_lock().map_err(|_| CACHE_ERROR)?;
        // Exclusive process ownership precedes cleanup; never remove another live recognizer's files.
        for entry in fs::read_dir(&root).map_err(|_| CACHE_ERROR)? {
            let entry = entry.map_err(|_| CACHE_ERROR)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let metadata = fs::symlink_metadata(entry.path()).map_err(|_| CACHE_ERROR)?;
            if name.strip_suffix(".part").is_some_and(valid_id) {
                private(&metadata, false)?;
                fs::remove_file(entry.path()).map_err(|_| CACHE_ERROR)?;
            } else if name.strip_prefix("lazysh-parakeet-").is_some_and(|tail| {
                tail.len() == 6 && tail.bytes().all(|c| c.is_ascii_alphanumeric())
            }) {
                private(&metadata, true)?;
                fs::remove_dir_all(entry.path()).map_err(|_| CACHE_ERROR)?;
            }
        }
        Ok(Self { root, _lock: lock })
    }
    fn archive(&self) -> PathBuf {
        self.root.join(ARCHIVE_NAME)
    }
    fn installed(&self) -> bool {
        fs::symlink_metadata(self.archive()).is_ok_and(|m| private(&m, false).is_ok())
    }
    fn open_archive(&self) -> Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.archive())
            .map_err(|_| "Download the Parakeet model first")?;
        let metadata = file.metadata().map_err(|_| CACHE_ERROR)?;
        private(&metadata, false)?;
        if metadata.len() != ARCHIVE_BYTES {
            return Err(
                "Stored Parakeet archive has an invalid size; remove it and download again".into(),
            );
        }
        Ok(file)
    }
}
fn private(metadata: &fs::Metadata, directory: bool) -> Result<()> {
    if metadata.file_type().is_symlink()
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || (!directory && metadata.nlink() != 1)
    {
        return Err(CACHE_ERROR.into());
    }
    Ok(())
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
}
impl Manager {
    pub(super) fn new(root: PathBuf, capacity: Arc<AtomicBool>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            cache: Cache::new(root)?,
            inner: Mutex::new(Inner::default()),
            capacity,
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
        work.keep_engine = false;
        let partial = self.cache.root.join(format!("{id}.part"));
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&partial)
            .map_err(|_| "Cannot create Parakeet download")?;
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
                work.prepare(work.manager.cache.open_archive()?)?;
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
    work.commit(|| publish(&partial, &work.manager.cache.archive()))?;
    work.keep_engine = true;
    File::open(&work.manager.cache.root)
        .and_then(|root| root.sync_all())
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
        tokio::select! {biased; _=self.access.cancelled()=>{}, _=async { loop { if *self.cancel.borrow() || self.cancel.changed().await.is_err() { break; } } }=>{}}
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
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|length| length != expected)
    {
        return Err("Publisher returned an unexpected Parakeet archive".into());
    }
    let mut hash = Sha256::new();
    let mut received = 0;
    let mut reported = std::time::Instant::now();
    while let Some(bytes) = tokio::select! {biased; _=work.cancelled()=>return Err(CANCELLED.into()), result=response.chunk()=>result.map_err(|_| "Parakeet download interrupted or timed out")?}
    {
        if bytes.len() as u64 > expected - received {
            return Err("Parakeet archive exceeds the catalog size".into());
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
        return Err("Parakeet archive SHA-256 or size verification failed".into());
    }
    work.check()
}
fn publish(source: &Path, destination: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| CACHE_ERROR)?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| CACHE_ERROR)?;
    // SAFETY: Both private-cache names are terminated and live through the call.
    // Linux NOREPLACE atomically publishes one name without a hard-link crash window.
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err("Cannot install Parakeet model; destination may already exist".into());
    }
    Ok(())
}
fn publisher_client() -> Result<Client> {
    super::super::download::client(publisher_url, "Unsupported Parakeet download redirect")
        .map_err(|_| "Cannot initialize Parakeet model download".into())
}

#[cfg(test)]
mod tests;
