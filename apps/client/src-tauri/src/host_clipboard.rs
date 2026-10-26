//! One explicit Mac-host clipboard write, bound to an original completed upload.
use crate::{
    app_lock::AccessLease,
    ssh::{self, AccessResult, AppState, Result, Session, SshError},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::State;
use tokio::sync::{watch, Semaphore};

pub(crate) const COMMAND: &str = "LC_CTYPE=UTF-8 exec /usr/bin/pbcopy";
const COPY_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_LIMIT: usize = 4096;
struct Receipt {
    id: String,
    path: String,
    access: AccessLease,
    cancelled: watch::Sender<bool>,
}
pub(crate) struct UploadSlot {
    receipt: Mutex<Option<Arc<Receipt>>>,
    copying: Arc<Semaphore>,
}
impl Default for UploadSlot {
    fn default() -> Self {
        Self {
            receipt: Mutex::new(None),
            copying: Arc::new(Semaphore::new(1)),
        }
    }
}
impl UploadSlot {
    // Called only inside the upload registry's original-lease completion lock.
    pub(crate) fn publish(&self, id: String, path: String, access: AccessLease) {
        if let Ok(mut slot) = self.receipt.lock() {
            if let Some(old) = slot.take() {
                old.cancelled.send_replace(true);
            }
            *slot = Some(Arc::new(Receipt {
                id,
                path,
                access,
                cancelled: watch::channel(false).0,
            }));
        }
    }
    // The upload registry lock orders this with successful publication, even
    // after the original transfer has settled. Unknown IDs never clear a successor.
    pub(crate) fn cancel(&self, id: &str, generation: u64) -> bool {
        if let Ok(mut slot) = self.receipt.lock() {
            if slot.as_ref().is_some_and(|receipt| {
                receipt.id == id && receipt.access.generation() == generation
            }) {
                slot.take().unwrap().cancelled.send_replace(true);
                return true;
            }
        }
        false
    }
    #[cfg(test)]
    pub(crate) fn available(&self) -> bool {
        self.copying.available_permits() == 1
    }
    fn claim(&self, id: &str, access: &AccessLease) -> Result<Arc<Receipt>> {
        access.with_current(|| {
            self.receipt
                .lock()
                .map_err(|_| unavailable())?
                .as_ref()
                .filter(|receipt| {
                    receipt.id == id
                        && receipt.access.generation() == access.generation()
                        && !*receipt.cancelled.borrow()
                })
                .cloned()
                .ok_or_else(unavailable)
        })?
    }
}
fn unavailable() -> SshError {
    SshError::new(
        "host_clipboard_unavailable",
        "The original uploaded path is no longer available for host clipboard copying",
    )
}
fn unconfirmed() -> SshError {
    SshError::new("host_clipboard_unconfirmed", "The Mac host clipboard copy was not confirmed. The file remains uploaded; the clipboard may already have changed. Check that the SSH login can use /usr/bin/pbcopy.")
}
fn current(receipt: &Receipt, session: &Session) -> Result<()> {
    receipt.access.check()?;
    if *receipt.cancelled.borrow() || *session.cancel.borrow() {
        return Err(unconfirmed());
    }
    Ok(())
}
fn within_budget(
    receipt: &Receipt,
    session: &Session,
    deadline: tokio::time::Instant,
) -> Result<()> {
    current(receipt, session)?;
    if tokio::time::Instant::now() >= deadline {
        return Err(unconfirmed());
    }
    Ok(())
}
async fn stopped(receipt: &Receipt, session: &Session) {
    let mut cancelled = receipt.cancelled.subscribe();
    let mut disconnected = session.cancel.subscribe();
    tokio::select! { biased;
        _=receipt.access.cancelled()=>{},
        _=async { if !*cancelled.borrow() { let _=cancelled.changed().await; } }=>{},
        _=async { if !*disconnected.borrow() { let _=disconnected.changed().await; } }=>{},
    }
}
async fn copy(session: &Session, receipt: Arc<Receipt>) -> Result<()> {
    current(&receipt, session)?;
    let permit = session
        .clipboard
        .copying
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            SshError::new(
                "host_clipboard_busy",
                "The previous host clipboard request is still closing",
            )
        })?;
    let deadline = tokio::time::Instant::now() + COPY_TIMEOUT;
    let mut channel = tokio::select! { biased;
        _=stopped(&receipt,session)=>return Err(unconfirmed()),
        result=ssh::open_owned_channel_retained(&session.handle,&receipt.access,deadline,Arc::new(permit))=>result?,
    };
    // The retained opener owns copy capacity from admission through any late
    // confirmation and close, even when this caller cancels before it returns.
    let operation = async {
        within_budget(&receipt, session, deadline)?;
        channel.exec(true, COMMAND).await?;
        within_budget(&receipt, session, deadline)?;
        channel.data(receipt.path.as_bytes()).await?;
        within_budget(&receipt, session, deadline)?;
        channel.eof().await?;
        let mut size = 0usize;
        let mut status = None;
        while let Some(message) = channel.wait().await {
            match message {
                russh::ChannelMsg::Data { data } | russh::ChannelMsg::ExtendedData { data, .. } => {
                    size = size.saturating_add(data.len());
                }
                russh::ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
            if size > OUTPUT_LIMIT {
                return Err(unconfirmed());
            }
        }
        if status != Some(0) {
            return Err(unconfirmed());
        }
        within_budget(&receipt, session, deadline)?;
        Ok(())
    };
    let result = tokio::select! { biased;
        _=stopped(&receipt,session)=>Err(unconfirmed()),
        // Poll the absolute timer before a ready operation: a caller resumed
        // late must neither continue a blocked write nor accept queued success.
        _=tokio::time::sleep_until(deadline)=>Err(unconfirmed()),
        result=operation=>result,
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
    if result.is_ok() {
        current(&receipt, session)?;
    }
    result
}
pub(crate) async fn copy_uploaded(
    session: &Session,
    lease: &AccessLease,
    upload_id: &str,
) -> Result<()> {
    let receipt = session.clipboard.claim(upload_id, lease)?;
    copy(session, receipt).await
}
#[tauri::command]
pub async fn host_clipboard_copy(
    lease: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    upload_id: String,
) -> AccessResult<()> {
    lease
        .run(async {
            let session = state.session(&session_id).await?;
            copy_uploaded(&session, &lease, &upload_id).await
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::test_support::{ready_lease, unlocked_access};
    #[test]
    fn completed_receipts_are_exact_bounded_session_local_and_never_freshen_authority() {
        let authority = unlocked_access();
        let original = ready_lease(&authority);
        let slot = UploadSlot::default();
        let foreign = UploadSlot::default();
        slot.publish(
            "one".into(),
            "/original/世界 '$(literal)".into(),
            original.clone(),
        );
        let first = slot.claim("one", &original).unwrap();
        assert_eq!(first.path, "/original/世界 '$(literal)");
        assert!(foreign.claim("one", &original).is_err());
        assert!(!slot.cancel("wrong", original.generation()));
        assert!(slot.claim("one", &original).is_ok());
        slot.publish("two".into(), "/next".into(), original.clone());
        assert!(*first.cancelled.borrow());
        assert!(slot.claim("one", &original).is_err());
        assert!(!slot.cancel("one", original.generation()));
        assert!(slot.claim("two", &original).is_ok());
        authority.lock().unwrap();
        authority
            .authorize(authority.generation().unwrap())
            .unwrap();
        let replacement = ready_lease(&authority);
        assert!(slot.claim("two", &replacement).is_err());
        assert!(slot.claim("two", &original).is_err());
    }
}
