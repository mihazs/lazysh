//! Exact-receipt SFTP uploads. Cancellation stops future work, never removes a path.
use crate::{
    app_lock::AccessLease,
    ssh::{self, AccessResult, AppState, Result, SshError},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tauri::State;
use tokio::sync::watch;

const FILE_LIMIT: usize = 10 * 1024 * 1024;
const RESERVATION_TTL: Duration = Duration::from_secs(30);
const MAX_JOBS: usize = 2;
#[cfg(test)]
#[path = "attachment_upload/sftp_fixture.rs"]
mod sftp_fixture;
#[derive(Default, Clone)]
pub(crate) struct Uploads(Arc<Mutex<HashMap<String, Entry>>>);
struct Entry {
    job: Arc<Job>,
    claimed: bool,
    settled: bool,
}
struct Job {
    session_id: String,
    size: usize,
    access: AccessLease,
    cancel: watch::Sender<bool>,
    disconnected: watch::Receiver<bool>,
    expires: tokio::time::Instant,
}
impl Job {
    fn session_closed(&self) -> bool {
        *self.disconnected.borrow() || self.disconnected.has_changed().is_err()
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reserved {
    pub upload_id: String,
}
#[derive(Debug, Serialize)]
pub struct Uploaded {
    pub path: String,
}
#[derive(Serialize)]
pub struct Cancellation {
    pub outcome: &'static str,
}
fn unavailable() -> SshError {
    SshError::new(
        "upload_unavailable",
        "Upload receipt is unavailable for this session or access",
    )
}
pub(crate) fn cancelled() -> SshError {
    SshError::new("upload_cancelled", "Upload stopped. A partial or completed new remote file may remain; cancellation does not remove it.")
}

impl Uploads {
    fn reserve(
        &self,
        session_id: String,
        mut disconnected: watch::Receiver<bool>,
        access: AccessLease,
        size: usize,
    ) -> Result<Reserved> {
        if size > FILE_LIMIT {
            return Err(SshError::new(
                "file_too_large",
                "Upload is limited to 10 MiB",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (cancel, _) = watch::channel(false);
        let job = Arc::new(Job {
            session_id,
            size,
            access: access.clone(),
            cancel,
            disconnected: disconnected.clone(),
            expires: tokio::time::Instant::now() + RESERVATION_TTL,
        });
        access.with_current(|| {
            let mut entries = self.0.lock().map_err(|_| unavailable())?;
            if job.session_closed(){return Err(unavailable());}
            if entries.len() >= MAX_JOBS { return Err(SshError::new("upload_busy", "Two uploads are already reserved or sending. Cancel one or wait for it to finish.")); }
            entries.insert(id.clone(), Entry { job: job.clone(), claimed: false,settled:false });
            Ok(())
        })??;
        let registry = Arc::downgrade(&self.0);
        let watch_id = id.clone();
        tokio::spawn(async move {
            let mut cancellation = job.cancel.subscribe();
            let expired = tokio::select! { biased;
                _=access.cancelled()=>false,
                _=async {if !*disconnected.borrow() {let _=disconnected.changed().await;}}=>false,
                _=async {if !*cancellation.borrow() {let _=cancellation.changed().await;}}=>false,
                _=tokio::time::sleep_until(job.expires)=>true,
            };
            if expired {
                // The reservation deadline must not shorten the active transfer deadline.
                let claimed = registry
                    .upgrade()
                    .and_then(|registry| {
                        registry.lock().ok().map(|entries| {
                            entries.get(&watch_id).is_some_and(|entry| entry.claimed)
                        })
                    })
                    .unwrap_or(false);
                if claimed {
                    tokio::select! { _=access.cancelled()=>{}, _=disconnected.changed()=>{}, _=async {if !*cancellation.borrow() {let _=cancellation.changed().await;}}=>{} }
                }
            }
            abandon(&registry, &watch_id);
        });
        Ok(Reserved { upload_id: id })
    }
    fn claim(&self, id: &str, session_id: &str, access: &AccessLease, size: usize) -> Result<Work> {
        access.with_current(|| {
            let mut entries = self.0.lock().map_err(|_| unavailable())?;
            let entry = entries.get_mut(id).ok_or_else(unavailable)?;
            if entry.claimed
                || entry.job.session_id != session_id
                || entry.job.access.generation() != access.generation()
                || entry.job.size != size
                || tokio::time::Instant::now() >= entry.job.expires
                || *entry.job.cancel.borrow()
                || entry.job.session_closed()
            {
                return Err(unavailable());
            }
            entry.claimed = true;
            Ok(Work {
                permit: Arc::new(Retirement {
                    registry: Arc::downgrade(&self.0),
                    id: id.into(),
                }),
                job: entry.job.clone(),
            })
        })?
    }
    #[cfg(test)]
    fn cancel(&self, id: &str, session_id: &str, access: &AccessLease) -> Result<Cancellation> {
        self.cancel_with(id, session_id, access, || false)
    }
    fn cancel_with(
        &self,
        id: &str,
        session_id: &str,
        access: &AccessLease,
        completed: impl FnOnce() -> bool,
    ) -> Result<Cancellation> {
        access.with_current(|| {
            let mut entries = self.0.lock().map_err(|_| unavailable())?;
            let mut requested = false;
            if let Some(entry) = entries.get(id).filter(|entry| {
                !entry.settled
                    && entry.job.session_id == session_id
                    && entry.job.access.generation() == access.generation()
            }) {
                entry.job.cancel.send_replace(true);
                requested = true;
                if !entry.claimed {
                    entries.remove(id);
                }
            }
            // Outcome describes only the original file job. Revoking clipboard
            // authority must not turn a settled file into a cancelled transfer.
            completed();
            Ok(Cancellation {
                outcome: if requested {
                    "cancellation_requested"
                } else {
                    "unknown_or_settled"
                },
            })
        })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::test_support::{ready_lease, unlocked_access};
    fn reserve(
        uploads: &Uploads,
        lease: &AccessLease,
        disconnect: &watch::Sender<bool>,
        size: usize,
    ) -> String {
        uploads
            .reserve(
                "same-session".into(),
                disconnect.subscribe(),
                lease.clone(),
                size,
            )
            .unwrap()
            .upload_id
    }
    pub(super) fn fixture() -> (
        Uploads,
        crate::app_lock::AccessState,
        AccessLease,
        watch::Sender<bool>,
    ) {
        let access = unlocked_access();
        let lease = ready_lease(&access);
        let (disconnect, _) = watch::channel(false);
        (Uploads::default(), access, lease, disconnect)
    }
    fn pair(
        uploads: &Uploads,
        lease: &AccessLease,
        disconnect: &watch::Sender<bool>,
    ) -> (String, Work) {
        let pending = reserve(uploads, lease, disconnect, 1);
        let active = reserve(uploads, lease, disconnect, 1);
        let work = uploads.claim(&active, "same-session", lease, 1).unwrap();
        (pending, work)
    }
    async fn tick() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }
    #[tokio::test]
    async fn two_same_session_jobs_and_zero_bytes_obey_capacity_and_exact_sizes() {
        let (uploads, _access, lease, disconnect) = fixture();
        let zero = reserve(&uploads, &lease, &disconnect, 0);
        let large = reserve(&uploads, &lease, &disconnect, FILE_LIMIT);
        assert!(uploads
            .reserve("other".into(), disconnect.subscribe(), lease.clone(), 1)
            .is_err());
        assert!(uploads
            .claim(&zero, "same-session", &lease, FILE_LIMIT)
            .is_err());
        assert!(uploads
            .claim(&large, "other-session", &lease, FILE_LIMIT)
            .is_err());
        assert_eq!(
            uploads
                .cancel(&large, "other-session", &lease)
                .unwrap()
                .outcome,
            "unknown_or_settled"
        );
        assert_eq!(uploads.0.lock().unwrap().len(), 2);
        let zero_work = uploads.claim(&zero, "same-session", &lease, 0).unwrap();
        assert!(uploads.claim(&zero, "same-session", &lease, 0).is_err());
        let large_work = uploads
            .claim(&large, "same-session", &lease, FILE_LIMIT)
            .unwrap();
        drop(zero_work);
        drop(large_work);
        tick().await;
        assert!(uploads.0.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn cancelled_reservation_cannot_resurrect_and_running_cancel_retains_capacity_until_drop()
    {
        let (uploads, _access, lease, disconnect) = fixture();
        let first = reserve(&uploads, &lease, &disconnect, 1);
        assert_eq!(
            uploads
                .cancel(&first, "same-session", &lease)
                .unwrap()
                .outcome,
            "cancellation_requested"
        );
        assert!(uploads.claim(&first, "same-session", &lease, 1).is_err());
        let next = reserve(&uploads, &lease, &disconnect, 1);
        let work = uploads.claim(&next, "same-session", &lease, 1).unwrap();
        uploads.cancel(&next, "same-session", &lease).unwrap();
        work.cancelled().await;
        assert!(work.finish().is_err());
        assert_eq!(uploads.0.lock().unwrap().len(), 1);
        drop(work);
        assert!(uploads.0.lock().unwrap().is_empty());
        assert_eq!(
            uploads
                .cancel(&next, "same-session", &lease)
                .unwrap()
                .outcome,
            "unknown_or_settled"
        );
    }
    #[tokio::test(start_paused = true)]
    async fn pending_expiry_does_not_shorten_a_claimed_transfer_and_finished_receipt_is_unknown() {
        let (uploads, _access, lease, disconnect) = fixture();
        let (pending, work) = pair(&uploads, &lease, &disconnect);
        let active = work.permit.id.clone();
        tokio::time::advance(RESERVATION_TTL).await;
        tick().await;
        assert!(uploads.claim(&pending, "same-session", &lease, 1).is_err());
        assert_eq!(uploads.0.lock().unwrap().len(), 1);
        work.finish().unwrap();
        assert_eq!(
            uploads
                .cancel(&active, "same-session", &lease)
                .unwrap()
                .outcome,
            "unknown_or_settled"
        );
        drop(work);
        tick().await;
        assert!(uploads.0.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn cancellation_before_or_after_completion_cannot_resurrect_clipboard_authority_or_relabel_a_settled_file(
    ) {
        for cancel_first in [true, false] {
            let (uploads, _authority, lease, disconnect) = fixture();
            let id = reserve(&uploads, &lease, &disconnect, 1);
            let work = uploads.claim(&id, "same-session", &lease, 1).unwrap();
            let clipboard = Arc::new(crate::host_clipboard::UploadSlot::default());
            let (release, waiting) = tokio::sync::oneshot::channel();
            let entered = Arc::new(tokio::sync::Notify::new());
            let pending = {
                let clipboard = clipboard.clone();
                let id = id.clone();
                let lease = lease.clone();
                let entered = entered.clone();
                tokio::spawn(async move {
                    work.run_published(
                        async {
                            entered.notify_one();
                            waiting.await.unwrap();
                            Ok("/original".to_owned())
                        },
                        |path| clipboard.publish(id, path.clone(), lease),
                    )
                    .await
                })
            };
            entered.notified().await;
            if cancel_first {
                assert_eq!(
                    uploads
                        .cancel_with(&id, "same-session", &lease, || clipboard
                            .cancel(&id, lease.generation()))
                        .unwrap()
                        .outcome,
                    "cancellation_requested"
                );
                release.send(()).unwrap();
                assert!(pending.await.unwrap().is_err());
                assert!(!clipboard.cancel(&id, lease.generation()));
            } else {
                release.send(()).unwrap();
                assert_eq!(pending.await.unwrap().unwrap(), "/original");
                let mut revoked = false;
                let result = uploads
                    .cancel_with(&id, "same-session", &lease, || {
                        revoked = clipboard.cancel(&id, lease.generation());
                        revoked
                    })
                    .unwrap();
                assert!(
                    revoked,
                    "a completed receipt must be revoked even after its file resource retires"
                );
                assert_eq!(
                    result.outcome, "unknown_or_settled",
                    "clipboard revocation cannot claim that the completed file was cancelled"
                );
                assert!(!clipboard.cancel(&id, lease.generation()));
            }
        }
    }
    #[tokio::test]
    async fn lease_revocation_and_disconnect_retire_lost_receipts_and_active_work() {
        for revoke in [false, true] {
            let (uploads, access, lease, disconnect) = fixture();
            let (pending, work) = pair(&uploads, &lease, &disconnect);
            if revoke {
                access.lock().unwrap();
            } else {
                disconnect.send_replace(true);
            }
            assert!(
                work.finish().is_err(),
                "completion must observe disconnect before its watcher is scheduled"
            );
            tick().await;
            work.cancelled().await;
            assert!(!uploads.0.lock().unwrap().contains_key(&pending));
            assert!(work.finish().is_err());
            drop(work);
            assert!(uploads.0.lock().unwrap().is_empty());
        }
    }
}
fn abandon(registry: &Weak<Mutex<HashMap<String, Entry>>>, id: &str) {
    if let Some(registry) = registry.upgrade() {
        if let Ok(mut entries) = registry.lock() {
            if let Some(entry) = entries.get(id) {
                entry.job.cancel.send_replace(true);
                if !entry.claimed {
                    entries.remove(id);
                }
            }
        }
    }
}
struct Retirement {
    registry: Weak<Mutex<HashMap<String, Entry>>>,
    id: String,
}
impl Drop for Retirement {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            if let Ok(mut entries) = registry.lock() {
                entries.remove(&self.id);
            }
        }
    }
}
pub(crate) struct Work {
    permit: Arc<Retirement>,
    job: Arc<Job>,
}
impl Work {
    #[cfg(test)]
    async fn run<T>(&self, transfer: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        self.run_published(transfer, |_| {}).await
    }
    async fn run_published<T>(
        &self,
        transfer: impl std::future::Future<Output = Result<T>>,
        publish: impl FnOnce(&T),
    ) -> Result<T> {
        let result = tokio::select! {biased; _=self.cancelled()=>return Err(cancelled()),result=transfer=>result?};
        self.finish_with(|| publish(&result))?;
        Ok(result)
    }
    async fn cancelled(&self) {
        self.cancellation().await;
    }
    pub(crate) fn retention(&self) -> Arc<dyn Send + Sync> {
        self.permit.clone()
    }
    pub(crate) fn cancellation(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        let job = self.job.clone();
        Box::pin(async move {
            let mut cancel = job.cancel.subscribe();
            let mut disconnected = job.disconnected.clone();
            tokio::select! {biased;
                _=job.access.cancelled()=>{},
                _=async {if !*cancel.borrow(){let _=cancel.changed().await;}}=>{},
                _=async {if !*disconnected.borrow(){let _=disconnected.changed().await;}}=>{},
            }
        })
    }
    #[cfg(test)]
    fn finish(&self) -> Result<()> {
        self.finish_with(|| {})
    }
    fn finish_with(&self, publish: impl FnOnce()) -> Result<()> {
        self.job.access.with_current(|| {
            let registry = self.permit.registry.upgrade().ok_or_else(unavailable)?;
            let mut entries = registry.lock().map_err(|_| unavailable())?;
            if *self.job.cancel.borrow() || self.job.session_closed() {
                return Err(cancelled());
            }
            entries
                .get_mut(&self.permit.id)
                .ok_or_else(unavailable)?
                .settled = true;
            publish();
            self.job.cancel.send_replace(true);
            Ok(())
        })?
    }
}
impl Drop for Work {
    fn drop(&mut self) {
        self.job.cancel.send_replace(true);
    }
}

#[tauri::command]
pub async fn upload_reserve(
    lease: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    size: usize,
) -> AccessResult<Reserved> {
    lease
        .run(async {
            let session = state.session(&session_id).await?;
            state
                .uploads
                .reserve(session_id, session.cancel.subscribe(), lease.clone(), size)
        })
        .await
}
#[tauri::command]
pub async fn upload_cancel(
    lease: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    upload_id: String,
) -> AccessResult<Cancellation> {
    lease
        .run(async {
            let session = state.session(&session_id).await.ok();
            state
                .uploads
                .cancel_with(&upload_id, &session_id, &lease, || {
                    session.is_some_and(|session| {
                        session.clipboard.cancel(&upload_id, lease.generation())
                    })
                })
        })
        .await
}
#[tauri::command]
pub async fn upload_file(
    lease: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    upload_id: String,
    path: String,
    data: Vec<u8>,
) -> AccessResult<Uploaded> {
    lease
        .run(async {
            let work = state
                .uploads
                .claim(&upload_id, &session_id, &lease, data.len())?;
            let session = state.session(&session_id).await?;
            work.run_published(
                ssh::transfer_file(&session, &work.job.access, path, data, &work),
                |uploaded| {
                    session
                        .clipboard
                        .publish(upload_id, uploaded.path.clone(), lease.clone())
                },
            )
            .await
        })
        .await
}
