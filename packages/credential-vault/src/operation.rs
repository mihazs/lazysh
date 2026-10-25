use tokio::sync::watch;

#[derive(Clone)]
pub struct CredentialOperation {
    epoch: u64,
    current: watch::Sender<u64>,
}
impl CredentialOperation {
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn check(&self) -> Result<(), String> {
        if *self.current.borrow() == self.epoch {
            Ok(())
        } else {
            Err("Credential operation cancelled".into())
        }
    }
    pub async fn cancelled(&self) {
        let mut changes = self.current.subscribe();
        while self.check().is_ok() {
            if changes.changed().await.is_err() {
                break;
            }
        }
    }
}

pub struct CredentialOperations {
    current: watch::Sender<u64>,
}
impl Default for CredentialOperations {
    fn default() -> Self {
        let (current, _) = watch::channel(0);
        Self { current }
    }
}
impl CredentialOperations {
    pub fn begin(&self) -> CredentialOperation {
        CredentialOperation {
            epoch: *self.current.borrow(),
            current: self.current.clone(),
        }
    }
    pub fn cancel(&self) -> u64 {
        let mut epoch = 0;
        self.current.send_modify(|current| {
            *current = current.wrapping_add(1);
            epoch = *current;
        });
        epoch
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_before_blocking_dispatch_never_starts_the_queued_prompt() {
        use std::sync::{mpsc, Arc};
        tauri::async_runtime::block_on(async {
            let operations = CredentialOperations::default();
            let old = operations.begin();
            let prompts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let (queued, waiting) = tokio::sync::oneshot::channel();
            let (resume, ready) = mpsc::channel();
            let attempts = prompts.clone();
            let worker = tauri::async_runtime::spawn_blocking(move || {
                queued.send(()).unwrap();
                ready.recv().unwrap();
                old.check()?;
                attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok::<_, String>(())
            });
            waiting.await.unwrap();
            assert_eq!(operations.cancel(), 1);
            resume.send(()).unwrap();
            assert!(worker.await.unwrap().is_err());
            assert_eq!(prompts.load(std::sync::atomic::Ordering::SeqCst), 0);
            assert!(operations.begin().check().is_ok());
        });
    }
    #[test]
    fn captured_operation_stays_cancelled_after_a_later_operation_begins() {
        let operations = CredentialOperations::default();
        let old = operations.begin();
        operations.cancel();
        let new = operations.begin();
        assert!(old.check().is_err());
        assert!(new.check().is_ok());
        assert_ne!(old.epoch(), new.epoch());
    }
}
