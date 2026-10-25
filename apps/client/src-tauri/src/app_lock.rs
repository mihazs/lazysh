//! Native resume lock: the renderer can request access, never grant it.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager};
pub use tauri_plugin_lazysh_vault::access::{
    AccessLease, AccessState, AccessStatus, Guarded, GuardedError, HEADER,
};
use tauri_plugin_lazysh_vault::VaultExt;
use tokio::sync::Mutex;
use zeroize::Zeroizing;
const ACCOUNT: &str = "resume-lock-proof-v1";
mod policy;
use policy::{PolicyStore, Proof};
fn policy_store(app: &AppHandle) -> Result<PolicyStore, String> {
    app.path()
        .app_config_dir()
        .map(|directory| PolicyStore::new(directory.join("resume-lock-policy.json")))
        .map_err(|_| "Cannot locate native resume protection policy".into())
}
struct NativeProof<'a> {
    app: &'a AppHandle,
    operation: &'a tauri_plugin_lazysh_vault::CredentialOperation,
}
impl Proof for NativeProof<'_> {
    fn exists(&self) -> Result<bool, String> {
        self.app.vault().exists(ACCOUNT)
    }
    fn create_verified(&self) -> Result<(), String> {
        self.operation.check()?;
        let proof = Zeroizing::new(format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ));
        self.app
            .vault()
            .set_protected_for(ACCOUNT, &proof, true, self.operation)?;
        self.authenticate()
    }
    fn authenticate(&self) -> Result<(), String> {
        let proof = self
            .app
            .vault()
            .get_protected_for(ACCOUNT, true, self.operation)?
            .map(Zeroizing::new)
            .ok_or("Resume proof is unavailable")?;
        if proof.len() != 64 || !proof.bytes().all(|value| value.is_ascii_hexdigit()) {
            return Err("Resume proof is invalid".into());
        }
        self.operation.check()
    }
    fn remove(&self) -> Result<(), String> {
        self.app.vault().delete(ACCOUNT)
    }
}
#[derive(Default)]
pub struct Runtime {
    native: AtomicU64,
    ready: AtomicBool,
    operation: Arc<Mutex<()>>,
    pending: AtomicU64,
    cleaned: tokio::sync::Notify,
    render_revision: AtomicU64,
    render: Arc<Mutex<()>>,
}
async fn owned_configuration<T: Send + 'static>(
    guard: tokio::sync::OwnedMutexGuard<()>,
    work: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    tokio::spawn(async move {
        let _guard = guard;
        work.await
    })
    .await
    .map_err(|_| "Resume configuration stopped unexpectedly".to_owned())?
}
fn configuration_start(
    access: &AccessLease,
    operation: &tauri_plugin_lazysh_vault::CredentialOperation,
) -> Result<(), String> {
    access.check().map_err(String::from)?;
    operation.check()
}
fn repeated_ready_cover(authority: &AccessState) -> Result<Option<bool>, String> {
    let status = authority.status()?;
    Ok(status.initialized.then(|| authority.is_locked()))
}
fn publish(app: &AppHandle) {
    if let Ok(status) = app.vault().access().status() {
        let _ = app.emit("lazysh-app-lock", status);
    }
}
fn view(app: AppHandle, covered: bool) {
    let Ok(generation) = app.vault().access().generation() else {
        return;
    };
    let runtime = app.state::<Runtime>();
    let native = runtime.native.load(Ordering::SeqCst);
    let revision = runtime.render_revision.fetch_add(1, Ordering::SeqCst) + 1;
    let render = runtime.render.clone();
    tauri::async_runtime::spawn(async move {
        let _serial = render.lock_owned().await;
        if app
            .state::<Runtime>()
            .render_revision
            .load(Ordering::SeqCst)
            != revision
            || app.vault().access().generation().ok() != Some(generation)
            || app.vault().access().is_locked() != covered
        {
            return;
        }
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = app.vault().resume_view(covered, generation, native);
        })
        .await;
    });
}
fn failure(app: AppHandle) {
    let native = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = native.vault().resume_failure();
    });
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }
}
async fn await_cleanup(app: &AppHandle) {
    let state = app.state::<Runtime>();
    loop {
        let notified = state.cleaned.notified();
        if state.pending.load(Ordering::SeqCst) == 0 {
            return;
        }
        notified.await;
    }
}

fn revoke(app: &AppHandle) {
    revoke_for(app, false, None);
}
fn revoke_for(app: &AppHandle, replacement: bool, native: Option<u64>) {
    let protected = if replacement {
        app.vault()
            .access()
            .replace_renderer_with(|| {
                app.state::<Runtime>()
                    .pending
                    .fetch_add(1, Ordering::SeqCst);
            })
            .is_ok()
    } else {
        app.vault()
            .access()
            .background_with(|enabled| {
                if enabled {
                    app.state::<Runtime>()
                        .pending
                        .fetch_add(1, Ordering::SeqCst);
                }
            })
            .unwrap_or(false)
    };
    if let Some(native) = native {
        app.state::<Runtime>()
            .native
            .fetch_max(native, Ordering::SeqCst);
    }
    // Authority mutation completes before state-specific cancellation acquires its locks.
    let epoch = app.vault().begin_cancellation();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = handle.vault().cancel_authentication_at(epoch);
    });
    if !protected {
        publish(app);
        return;
    }
    app.state::<crate::voice::VoiceState>().cancel_for_lock();
    app.state::<crate::voice::cloud::CloudState>()
        .cancel_for_lock();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        handle
            .state::<crate::share::ShareState>()
            .cancel_for_lock()
            .await;
        handle
            .state::<crate::sync::SyncState>()
            .cancel_for_lock()
            .await;
        handle
            .state::<crate::devices::DeviceStreams>()
            .cancel_for_lock()
            .await;
        handle
            .state::<crate::previews::PreviewState>()
            .cancel_for_lock()
            .await;
        if replacement {
            handle
                .state::<crate::ssh::AppState>()
                .cancel_for_renderer_rebind()
                .await;
            handle
                .state::<crate::local::LocalState>()
                .cancel_for_renderer_rebind()
                .await;
        }
        let last = handle
            .state::<Runtime>()
            .pending
            .fetch_sub(1, Ordering::SeqCst)
            == 1;
        if last
            && handle
                .vault()
                .access()
                .finish_renderer_replacement_if(|| {
                    handle.state::<Runtime>().pending.load(Ordering::SeqCst) == 0
                })
                .unwrap_or(false)
        {
            publish(&handle);
            view(handle.clone(), handle.vault().access().is_locked());
        }
        handle.state::<Runtime>().cleaned.notify_waiters();
    });
    publish(app);
}
async fn initialize(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let (capability, enabled) = tauri::async_runtime::spawn_blocking(move || {
        let capability = handle.vault().resume_capability()?;
        let enabled = if cfg!(any(
            target_os = "android",
            target_os = "ios",
            target_os = "macos"
        )) {
            policy_store(&handle)?.initialize(&NativeProof {
                app: &handle,
                operation: &handle.vault().operation(),
            })?
        } else {
            false
        };
        Ok::<_, String>((capability, enabled))
    })
    .await
    .map_err(|_| "Cannot initialize resume protection")??;
    app.vault()
        .access()
        .initialize(capability.available, enabled, capability.reason)
        .map_err(String::from)?;
    publish(&app);
    view(app.clone(), enabled);
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window("main") {
        window
            .show()
            .map_err(|_| "Cannot show the protected workspace")?;
    }
    Ok(())
}
async fn unlock(
    app: AppHandle,
    expected: u64,
    native: u64,
    operation: tauri_plugin_lazysh_vault::CredentialOperation,
) -> Result<(), String> {
    await_cleanup(&app).await;
    let guard = app
        .state::<Runtime>()
        .operation
        .clone()
        .try_lock_owned()
        .map_err(|_| "Resume authentication is already active")?;
    if app.state::<Runtime>().native.load(Ordering::SeqCst) != native
        || app.vault().access().generation().ok() != Some(expected)
    {
        return Err("Resume authentication belongs to an earlier foreground".into());
    }
    operation.check()?;
    let _guard = guard;
    let handle = app.clone();
    let proof = tauri::async_runtime::spawn_blocking(move || {
        handle
            .vault()
            .get_protected_for(ACCOUNT, true, &operation)
            .map(|v| v.map(Zeroizing::new))
    })
    .await
    .map_err(|_| "Resume authentication failed")??;
    if !proof
        .as_ref()
        .is_some_and(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("Resume proof is missing or invalidated; protection remains locked".into());
    }
    app.vault()
        .access()
        .authorize(expected)
        .map_err(String::from)?;
    publish(&app);
    Ok(())
}
pub fn install(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    if !cfg!(any(
        target_os = "android",
        target_os = "ios",
        target_os = "macos"
    )) {
        handle
            .vault()
            .access()
            .initialize(
                false,
                false,
                "Native resume biometrics are unavailable on this platform".into(),
            )
            .map_err(String::from)?;
        return Ok(());
    }
    let callback = handle.clone();
    let events = tauri::ipc::Channel::<serde_json::Value>::new(move |message| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = message {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
                if let (Some(kind), Some(generation)) = (
                    value.get("kind").and_then(|v| v.as_str()),
                    value.get("nativeGeneration").and_then(|v| v.as_u64()),
                ) {
                    let runtime = callback.state::<Runtime>();
                    let observed = runtime.native.load(Ordering::SeqCst);
                    if generation < observed {
                        return Ok(());
                    }
                    match kind {
                        "ready" => {
                            let first = !runtime.ready.swap(true, Ordering::SeqCst);
                            if !first && generation > observed {
                                revoke(&callback);
                            }
                            runtime.native.fetch_max(generation, Ordering::SeqCst);
                            if first {
                                let handle = callback.clone();
                                tauri::async_runtime::spawn(async move {
                                    if let Err(error) = initialize(handle.clone()).await {
                                        eprintln!("Native resume initialization failed: {error}");
                                        failure(handle.clone());
                                        let _ = handle.emit("lazysh-app-lock-error", error);
                                    }
                                });
                            } else if let Ok(Some(covered)) =
                                repeated_ready_cover(callback.vault().access())
                            {
                                publish(&callback);
                                view(callback.clone(), covered);
                            }
                        }
                        "rebind" => {
                            revoke_for(&callback, true, Some(generation));
                        }
                        "background" => {
                            revoke_for(&callback, false, Some(generation));
                        }
                        "foreground" => {
                            runtime.native.fetch_max(generation, Ordering::SeqCst);
                            let _ = callback.vault().access().foreground();
                            publish(&callback);
                            if callback.vault().access().policy_enabled() == Some(false) {
                                view(callback.clone(), false);
                            }
                        }
                        "unlock" => {
                            let expected =
                                callback.vault().access().generation().unwrap_or(u64::MAX);
                            let operation = callback.vault().operation();
                            let handle = callback.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(error) =
                                    unlock(handle.clone(), expected, generation, operation).await
                                {
                                    failure(handle.clone());
                                    let _ = handle.emit("lazysh-app-lock-error", error);
                                }
                            });
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    });
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = handle.vault().register_resume(events) {
            eprintln!("Native resume registration failed: {error}");
            failure(handle.clone());
            let _ = handle.emit("lazysh-app-lock-error", error);
        }
    });
    Ok(())
}
#[tauri::command]
pub fn app_lock_status(app: AppHandle) -> Result<AccessStatus, String> {
    app.vault().access().status().map_err(Into::into)
}
#[tauri::command]
pub async fn app_lock_configure(
    access: AccessLease,
    app: AppHandle,
    enabled: bool,
) -> Result<AccessStatus, String> {
    await_cleanup(&app).await;
    access.check().map_err(String::from)?;
    let guard = app
        .state::<Runtime>()
        .operation
        .clone()
        .try_lock_owned()
        .map_err(|_| "Resume authentication is already active")?;
    let status = app.vault().access().status().map_err(String::from)?;
    if !status.initialized || !status.supported || status.locked {
        return Err("Unlock the app before changing resume protection".into());
    }
    if status.enabled == enabled {
        return Ok(status);
    }
    let operation = app.vault().operation();
    let mut expected = access.generation();
    // This owner survives a dropped IPC caller through policy mutation and reconciliation.
    owned_configuration(guard, async move {
        configuration_start(&access, &operation)?;
        let mut resolved_policy = None;
        let result = async {
            if enabled {
                expected = app
                    .vault()
                    .access()
                    .prepare_enable(expected)
                    .map_err(String::from)?;
                publish(&app);
                let handle = app.clone();
                let native = app.state::<Runtime>().native.load(Ordering::SeqCst);
                tauri::async_runtime::spawn_blocking(move || {
                    handle.vault().resume_view(true, expected, native)
                })
                .await
                .map_err(|_| "Cannot install native privacy cover")??;
            }
            let handle = app.clone();
            // Unknown worker completion remains restrictive; the owner and its operation
            // guard survive caller cancellation through proof and policy commits.
            resolved_policy = Some(true);
            let mutation = tauri::async_runtime::spawn_blocking(move || {
                let store = policy_store(&handle).map_err(|message| policy::ChangeError {
                    message,
                    locked: true,
                })?;
                let proof = NativeProof {
                    app: &handle,
                    operation: &operation,
                };
                if enabled {
                    store.enable(&proof)
                } else {
                    store.disable(&proof)
                }
            })
            .await
            .map_err(|_| "Resume protection update stopped; its commit may have completed")?;
            match mutation {
                Ok(()) => resolved_policy = Some(enabled),
                Err(error) => {
                    resolved_policy = Some(error.locked);
                    return Err(error.message);
                }
            }
            app.vault()
                .access()
                .configure_after_proof(expected, enabled)
                .map_err(String::from)
        }
        .await;
        if let Err(error) = result {
            let handle = app.clone();
            let present = tauri::async_runtime::spawn_blocking(move || {
                let store = policy_store(&handle)?;
                let enabled = match resolved_policy {
                    Some(enabled) => enabled,
                    None => store.initialize(&NativeProof {
                        app: &handle,
                        operation: &handle.vault().operation(),
                    })?,
                };
                if enabled {
                    store.write(true)?;
                }
                Ok::<_, String>(enabled)
            })
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(true);
            app.vault()
                .access()
                .reconcile_policy(present)
                .map_err(String::from)?;
            publish(&app);
            view(app.clone(), present);
            return Err(format!(
                "{error}. The update may have committed; check the current protection state."
            ));
        }
        publish(&app);
        if !enabled {
            view(app.clone(), false);
        }
        app.vault().access().status().map_err(Into::into)
    })
    .await
}
#[tauri::command]
pub fn app_lock_ready(app: AppHandle, generation: String) -> Result<(), String> {
    let generation = generation
        .parse::<u64>()
        .map_err(|_| "Invalid resume generation")?;
    app.vault()
        .access()
        .ready(generation)
        .map_err(String::from)?;
    view(app, false);
    Ok(())
}
pub fn admit<R: tauri::Runtime>(invoke: &tauri::ipc::Invoke<R>) -> Result<(), String> {
    if allowed_while_locked(invoke.message.command()) {
        return Ok(());
    }
    let nonce = invoke
        .message
        .headers()
        .get(HEADER)
        .and_then(|value| value.to_str().ok());
    invoke
        .message
        .webview_ref()
        .vault()
        .access()
        .lease(nonce)
        .map(|_| ())
        .map_err(Into::into)
}
pub fn allowed_while_locked(command: &str) -> bool {
    matches!(
        command,
        "app_lock_status"
            | "app_lock_ready"
            | "app_lock_configure"
            | "ack_output"
            | "local_ack"
            | "disconnect"
            | "local_disconnect"
            | "stop_preview"
            | "device_stream_stop"
            | "voice_cancel"
            | "voice_download_cancel"
            | "voice_cloud_cancel"
            | "apple_speech_cancel"
            | "share_upload_cancel"
            | "share_thumbnail_cancel"
            | "transport_capabilities"
            | "local_capability"
            | "credential_protection"
            | "voice_model_catalog"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn dropped_configuration_caller_keeps_commit_and_operation_owned() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("policy.json");
        let operations = Arc::new(Mutex::new(()));
        let guard = operations.clone().lock_owned().await;
        let (started, waiting) = tokio::sync::oneshot::channel();
        let (finish, proceed) = tokio::sync::oneshot::channel();
        let policy = PolicyStore::new(path.clone());
        let caller = tokio::spawn(owned_configuration(guard, async move {
            started.send(()).unwrap();
            proceed.await.unwrap();
            tauri::async_runtime::spawn_blocking(move || policy.write(true))
                .await
                .unwrap()
        }));
        waiting.await.unwrap();
        caller.abort();
        assert!(operations.try_lock().is_err());
        finish.send(()).unwrap();
        let _completed = tokio::time::timeout(std::time::Duration::from_secs(2), operations.lock())
            .await
            .unwrap();
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains("\"enabled\":true"));
    }
    #[test]
    fn repeated_native_ready_never_reinitializes_or_unlocks_a_recreated_view() {
        let authority = AccessState::default();
        assert_eq!(repeated_ready_cover(&authority).unwrap(), None);
        authority
            .initialize(true, true, "synthetic".into())
            .unwrap();
        authority
            .authorize(authority.generation().unwrap())
            .unwrap();
        authority.ready(authority.generation().unwrap()).unwrap();
        let nonce = authority.status().unwrap().nonce.unwrap();
        assert_eq!(repeated_ready_cover(&authority).unwrap(), Some(false));
        authority.background().unwrap();
        authority.foreground().unwrap();
        assert_eq!(repeated_ready_cover(&authority).unwrap(), Some(true));
        assert!(authority.lease(Some(&nonce)).is_err());
        assert!(authority.status().unwrap().nonce.is_none());
        let disabled = AccessState::disabled();
        disabled.background().unwrap();
        assert_eq!(repeated_ready_cover(&disabled).unwrap(), Some(false));
    }
    #[test]
    fn actual_ipc_admission_rejects_missing_and_old_headers_after_reunlock() {
        let directory = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_lazysh_vault::init())
            .invoke_handler(|invoke: tauri::ipc::Invoke<tauri::test::MockRuntime>| {
                if let Err(error) = admit(&invoke) {
                    invoke.resolver.reject(error);
                    return true;
                }
                let handler: fn(tauri::ipc::Invoke<tauri::test::MockRuntime>) -> bool =
                    tauri::generate_handler![crate::ssh::list_hosts];
                handler(invoke)
            })
            .build(tauri::generate_context!(test = true))
            .unwrap();
        app.manage(crate::ssh::AppState::new(directory.path().into()).unwrap());
        let authority = app.vault().access();
        authority
            .initialize(true, true, "synthetic native IPC".into())
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let request = |nonce: Option<&str>| {
            let mut headers = tauri::http::HeaderMap::new();
            if let Some(nonce) = nonce {
                headers.insert("x-lazysh-access", nonce.parse().unwrap());
            }
            tauri::webview::InvokeRequest {
                cmd: "list_hosts".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://127.0.0.1:1420".parse().unwrap(),
                body: Default::default(),
                headers,
                invoke_key: tauri::test::INVOKE_KEY.into(),
            }
        };
        assert!(tauri::test::get_ipc_response(&window, request(None)).is_err());
        authority
            .authorize(authority.generation().unwrap())
            .unwrap();
        let old = authority.status().unwrap().nonce.unwrap();
        assert!(tauri::test::get_ipc_response(&window, request(Some(&old))).is_ok());
        authority.background().unwrap();
        assert!(tauri::test::get_ipc_response(&window, request(Some(&old))).is_err());
        authority.foreground().unwrap();
        authority
            .authorize(authority.generation().unwrap())
            .unwrap();
        assert!(tauri::test::get_ipc_response(&window, request(Some(&old))).is_err());
        assert!(tauri::test::get_ipc_response(&window, request(None)).is_err());
        assert!(tauri::test::get_ipc_response(
            &window,
            request(authority.status().unwrap().nonce.as_deref())
        )
        .is_ok());
    }
    #[tokio::test]
    async fn queued_configuration_never_freshens_its_proof_read_after_reunlock() {
        let state = AccessState::default();
        state.initialize(true, true, "synthetic".into()).unwrap();
        state.authorize(state.generation().unwrap()).unwrap();
        let access = state
            .lease(state.status().unwrap().nonce.as_deref())
            .unwrap();
        let operations = tauri_plugin_lazysh_vault::CredentialOperations::default();
        let operation = operations.begin();
        let reads = Arc::new(AtomicU64::new(0));
        let observed = reads.clone();
        let (release, queued) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            queued.await.unwrap();
            configuration_start(&access, &operation)?;
            observed.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(())
        });
        state.background().unwrap();
        operations.cancel();
        state.foreground().unwrap();
        state.authorize(state.generation().unwrap()).unwrap();
        release.send(()).unwrap();
        assert!(worker.await.unwrap().is_err());
        assert_eq!(reads.load(Ordering::SeqCst), 0);
    }
}
