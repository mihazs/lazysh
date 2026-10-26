use crate::app_lock::{AccessLease, Guarded, GuardedError};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_lazysh_display_idle::{DisplayIdleExt, Request, Status};
use tokio::sync::watch;
type Protected<T> = Result<Guarded<T>, GuardedError<String>>;
#[derive(Default)]
pub struct Runtime(Mutex<Option<(Request, watch::Sender<bool>)>>);
fn validate(request: &Request) -> Result<(), String> {
    if request.epoch.len() > 96 || request.ticket == 0 || request.ticket > 9_007_199_254_740_991 {
        return Err("Invalid display ownership.".into());
    }
    Ok(())
}
fn stop(state: &Runtime, request: Option<&Request>) {
    let mut owner = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if request.is_none_or(|request| {
        owner
            .as_ref()
            .is_some_and(|(old, _)| old.epoch == request.epoch && old.ticket == request.ticket)
    }) {
        if let Some((_, cancel)) = owner.take() {
            let _ = cancel.send(true);
        }
    }
}
fn acquire_owned<T>(
    state: &Runtime,
    access: &AccessLease,
    request: Request,
    cancel: watch::Sender<bool>,
    acquire: impl FnOnce(&mut dyn FnMut() -> Result<(), String>) -> Result<T, String>,
) -> Result<T, String> {
    acquire(&mut || {
        access
            .with_current(|| {
                let previous = state
                    .0
                    .lock()
                    .map_err(|_| "Display ownership is unavailable.")?
                    .replace((request.clone(), cancel.clone()));
                if let Some((_, cancel)) = previous {
                    let _ = cancel.send(true);
                }
                Ok(())
            })
            .map_err(String::from)?
    })
}
pub fn revoke(app: &AppHandle) {
    stop(&app.state::<Runtime>(), None);
    app.display_idle().invalidate();
}
async fn revoked(original: AccessLease, mut stopped: watch::Receiver<bool>) -> bool {
    tokio::select! { _ = original.cancelled() => true, _ = stopped.changed() => false }
}
async fn native_call<T: Send + 'static>(
    call: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(call)
        .await
        .map_err(|_| "Native display operation stopped.".to_owned())?
}
#[tauri::command]
pub async fn board_keep_awake_status(access: AccessLease, app: AppHandle) -> Protected<Status> {
    access
        .run(async { native_call(move || app.display_idle().status()).await })
        .await
}
#[tauri::command]
pub async fn board_keep_awake_acquire(
    access: AccessLease,
    app: AppHandle,
    request: Request,
) -> Protected<Status> {
    access
        .run(async {
            validate(&request)?;
            access.check().map_err(String::from)?;
            let (cancel, stopped) = watch::channel(false);
            let watcher_app = app.clone();
            let watcher_request = request.clone();
            let original = access.clone();
            tauri::async_runtime::spawn(async move {
                if revoked(original, stopped).await {
                    let _ =
                        native_call(move || watcher_app.display_idle().release(&watcher_request))
                            .await;
                }
            });
            let worker_access = access.clone();
            native_call(move || {
                worker_access.check().map_err(String::from)?;
                acquire_owned(
                    &app.state::<Runtime>(),
                    &worker_access,
                    request.clone(),
                    cancel,
                    |admitted| {
                        app.display_idle().acquire(
                            &request,
                            || worker_access.check().map_err(String::from),
                            admitted,
                        )
                    },
                )
            })
            .await
        })
        .await
}
/// Cleanup authority is restricted to an already issued exact owner; it cannot acquire.
#[tauri::command]
pub async fn board_keep_awake_release(
    app: AppHandle,
    state: State<'_, Runtime>,
    request: Request,
) -> Result<Status, String> {
    validate(&request)?;
    stop(&state, Some(&request));
    native_call(move || app.display_idle().release(&request)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn original_authority() -> (crate::app_lock::AccessState, AccessLease) {
        let authority = crate::app_lock::AccessState::default();
        crate::app_lock::ready_fixture_authority(&authority);
        let original = authority
            .lease(authority.status().unwrap().nonce.as_deref())
            .unwrap();
        (authority, original)
    }
    #[test]
    fn cleanup_is_exact_and_never_grants_acquisition_authority() {
        let owner = Request {
            epoch: "native-owner".into(),
            ticket: 1,
        };
        let (cancel, observed) = watch::channel(false);
        let state = Runtime(Mutex::new(Some((owner.clone(), cancel))));
        stop(
            &state,
            Some(&Request {
                ticket: 2,
                ..owner.clone()
            }),
        );
        assert!(!*observed.borrow());
        stop(&state, Some(&owner));
        assert!(*observed.borrow());
        assert!(crate::app_lock::allowed_while_locked(
            "board_keep_awake_release"
        ));
        for protected in ["board_keep_awake_acquire", "board_keep_awake_status"] {
            assert!(!crate::app_lock::allowed_while_locked(protected));
        }
    }
    #[test]
    fn native_boundary_rejects_negative_fractional_and_unsafe_tickets() {
        for ticket in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!(9_007_199_254_740_992u64),
        ] {
            let value = serde_json::json!({"epoch":"native-owner", "ticket":ticket});
            assert!(serde_json::from_value::<Request>(value)
                .map_or(true, |request| validate(&request).is_err()));
        }
    }
    #[tokio::test]
    async fn watcher_releases_original_lease_after_an_immediate_reunlock() {
        let (authority, original) = original_authority();
        authority.background().unwrap();
        authority.foreground().unwrap();
        authority
            .authorize(authority.generation().unwrap())
            .unwrap();
        let (_hold, stopped) = watch::channel(false);
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(1),
            revoked(original, stopped)
        )
        .await
        .unwrap());
    }
    #[tokio::test]
    async fn rejected_acquisitions_preserve_newer_original_lease_watcher() {
        for revoked_at_admission in [false, true] {
            let (authority, original) = original_authority();
            let current = Request {
                epoch: "current".into(),
                ticket: 2,
            };
            let (cancel, observed) = watch::channel(false);
            let state = Runtime(Mutex::new(Some((current.clone(), cancel))));
            let (stale, _stale_observed) = watch::channel(false);
            assert!(acquire_owned::<()>(
                &state,
                &original,
                Request {
                    ticket: 1,
                    ..current.clone()
                },
                stale,
                |admitted| {
                    if revoked_at_admission {
                        authority.background().unwrap();
                        admitted()
                    } else {
                        Err("Display ownership has expired.".into())
                    }
                }
            )
            .is_err());
            assert!(
                !*observed.borrow(),
                "a rejected request stopped the current watcher"
            );
            authority.background().unwrap();
            assert!(
                revoked(original, observed).await,
                "current original lease must still own cleanup"
            );
        }
    }
    #[test]
    fn delayed_old_completion_cannot_replace_the_newer_admitted_watcher() {
        let state = Runtime::default();
        let (_authority, original) = original_authority();
        let first = Request {
            epoch: "current".into(),
            ticket: 1,
        };
        let (old_cancel, old_observed) = watch::channel(false);
        let (new_cancel, new_observed) = watch::channel(false);
        let (admitted_tx, admitted_rx) = std::sync::mpsc::channel();
        let (complete_tx, complete_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let state = &state;
            let original = &original;
            let old_request = first.clone();
            let old = scope.spawn(move || {
                acquire_owned(state, original, old_request, old_cancel, |admitted| {
                    admitted()?;
                    admitted_tx.send(()).unwrap();
                    complete_rx
                        .recv_timeout(std::time::Duration::from_secs(1))
                        .unwrap();
                    Ok(())
                })
            });
            admitted_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap();
            acquire_owned(
                state,
                original,
                Request {
                    ticket: 2,
                    ..first.clone()
                },
                new_cancel,
                |admitted| admitted(),
            )
            .unwrap();
            complete_tx.send(()).unwrap();
            old.join().unwrap().unwrap();
        });
        assert!(*old_observed.borrow());
        assert!(!*new_observed.borrow());
        stop(
            &state,
            Some(&Request {
                ticket: 1,
                ..first.clone()
            }),
        );
        assert!(!*new_observed.borrow());
        stop(&state, Some(&Request { ticket: 2, ..first }));
        assert!(*new_observed.borrow());
    }
}
