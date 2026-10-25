use crate::app_lock::{AccessLease, Guarded, GuardedError};
type Protected<T> = std::result::Result<Guarded<T>, GuardedError<String>>;
use std::{future::Future, time::Duration};
use tauri::AppHandle;
use tauri_plugin_lazysh_apple_speech::{AppleSpeechExt, Capability};

// Native plugin operations can outlive their caller's IPC future. Keep one
// owner until completion or lease revocation, then cancel the exact request.
async fn owned<T: Send + 'static>(
    access: AccessLease,
    operation: impl Future<Output = Result<T, String>> + Send + 'static,
    cancel: impl Future<Output = Result<(), String>> + Send + 'static,
) -> Result<T, String> {
    tokio::spawn(async move {
        tokio::select! { biased;
            _ = access.cancelled() => {
                let _ = tokio::time::timeout(Duration::from_secs(2), cancel).await;
                Err("App locked; Apple speech result discarded".to_owned())
            },
            result = operation => result,
        }
    })
    .await
    .map_err(|_| "Apple speech worker stopped".to_owned())?
}

async fn request<T, F, Fut>(
    access: &AccessLease,
    app: AppHandle,
    request_id: String,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(AppHandle, String) -> Fut,
    Fut: Future<Output = Result<T, String>> + Send + 'static,
{
    let cancel_app = app.clone();
    let cancel_id = request_id.clone();
    owned(access.clone(), operation(app, request_id), async move {
        cancel_app.apple_speech().cancel(cancel_id).await
    })
    .await
}

#[tauri::command]
pub async fn apple_speech_capability(access: AccessLease, app: AppHandle) -> Protected<Capability> {
    access
        .run(async { app.apple_speech().capability().await })
        .await
}
// Asset commands differ only in the plugin method; generate the complete IPC
// boundary so access admission and exact-request cancellation cannot diverge.
macro_rules! asset_command {
    ($command:ident, $method:ident) => {
        #[tauri::command]
        pub async fn $command(
            access: AccessLease,
            app: AppHandle,
            language: String,
            request_id: String,
        ) -> Protected<()> {
            access
                .run(request(
                    &access,
                    app,
                    request_id,
                    move |app, id| async move { app.apple_speech().$method(language, id).await },
                ))
                .await
        }
    };
}
asset_command!(apple_speech_install, install);
asset_command!(apple_speech_remove, remove);
#[tauri::command]
pub async fn apple_speech_transcribe(
    access: AccessLease,
    app: AppHandle,
    samples: Vec<f32>,
    language: String,
    request_id: String,
) -> Protected<String> {
    access
        .run(request(&access, app, request_id, move |app, id| async move {
            app.apple_speech().transcribe(samples, language, id).await
        }))
        .await
}
#[tauri::command]
pub async fn apple_speech_cancel(app: AppHandle, request_id: String) -> Result<(), String> {
    app.apple_speech().cancel(request_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_lock::AccessState;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn authorized() -> (AccessState, AccessLease) {
        let state = AccessState::default();
        state.initialize(true, true, "fixture".into()).unwrap();
        state.authorize(state.generation().unwrap()).unwrap();
        let nonce = state.status().unwrap().nonce.unwrap();
        let lease = state.lease(Some(&nonce)).unwrap();
        (state, lease)
    }

    #[tokio::test]
    async fn revoked_owned_operation_cancels_without_polling_queued_native_work() {
        let (state, lease) = authorized();
        state.background().unwrap();
        state.foreground().unwrap();
        state.authorize(state.generation().unwrap()).unwrap();
        let effects = Arc::new(AtomicUsize::new(0));
        let cancellations = Arc::new(AtomicUsize::new(0));
        let work = effects.clone();
        let cancel = cancellations.clone();
        let result = owned(
            lease,
            async move {
                work.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>("late text")
            },
            async move {
                cancel.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        assert_eq!(cancellations.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn native_cancel_wait_is_bounded_even_when_plugin_cancellation_never_replies() {
        let (state, lease) = authorized();
        state.background().unwrap();
        let started = tokio::time::Instant::now();
        let result = owned::<()>(lease, std::future::pending(), std::future::pending()).await;
        assert!(result.is_err());
        assert_eq!(started.elapsed(), Duration::from_secs(2));
    }
}
