//! Desktop receive path for the relay's remote "needs you" events: while the app runs and the
//! user has opted in, it polls the user's own Gotify server with a read token and shows the
//! generic desktop notification. Off by default; nothing but the closed relay event is read.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use lazysh_notification_client::gotify::{valid_gotify_token, PollError, Reader};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_lazysh_vault::VaultExt;
use tauri_plugin_notification::{NotificationExt, PermissionState};
use zeroize::{Zeroize, Zeroizing};

type Protected<T> = std::result::Result<Guarded<T>, GuardedError<String>>;
const ACCOUNT: &str = "remote-attention-v1";
const META: &str = "remote-attention.json";
const INTERVAL: Duration = Duration::from_secs(15);

/// The secret half; the origin and the on/off switch are not secret and live in [`Meta`].
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Secret {
    token: String,
}
impl Drop for Secret {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Meta {
    origin: String,
    enabled: bool,
}

#[derive(Default)]
struct Shared {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    generation: u64,
    error: Option<&'static str>,
}
/// Serializes start, stop and every report of the running poller.
#[derive(Default)]
pub struct RemoteState(Arc<Mutex<Shared>>);
fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
impl RemoteState {
    fn stop(&self) {
        let mut shared = lock(&self.0);
        shared.generation += 1;
        shared.error = None;
        if let Some(task) = shared.task.take() {
            task.abort();
        }
    }
    fn start(
        &self,
        reader: Reader,
        interval: Duration,
        show: impl Fn() -> Result<(), &'static str> + Send + 'static,
    ) {
        self.stop();
        let mut shared = lock(&self.0);
        let generation = shared.generation;
        let state = self.0.clone();
        shared.task = Some(tauri::async_runtime::spawn(async move {
            let report = {
                let state = state.clone();
                move |outcome: Result<usize, PollError>| {
                    let mut shared = lock(&state);
                    if shared.generation != generation {
                        return;
                    }
                    shared.error = outcome.err().map(PollError::code);
                    // Shown under the lock, so a pause that returned can never be followed by one.
                    if outcome.is_ok_and(|events| events > 0) {
                        shared.error = show().err();
                    }
                }
            };
            reader.watch(interval, report).await;
            let mut shared = lock(&state);
            if shared.generation == generation {
                shared.task = None;
            }
        }));
    }
    fn begin(&self, app: &AppHandle, reader: Reader) {
        let app = app.clone();
        self.start(reader, INTERVAL, move || notify(&app));
    }
    fn snapshot(&self) -> (bool, Option<&'static str>) {
        let shared = lock(&self.0);
        (shared.task.is_some(), shared.error)
    }
}

/// The relay's disclosure rule: nothing of the event, not even its alias, reaches the text.
fn notify(app: &AppHandle) -> Result<(), &'static str> {
    if app.notification().permission_state().ok() != Some(PermissionState::Granted) {
        return Err("notification_permission");
    }
    app.notification()
        .builder()
        .title("lazysh · Needs you")
        .body("An agent needs your attention.")
        .action_type_id("lazysh-agent")
        .show()
        .map_err(|_| "notification_failed")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    supported: bool,
    configured: bool,
    enabled: bool,
    running: bool,
    origin: Option<String>,
    /// A finite code the interface maps to its own text; never server or OS text.
    error: Option<&'static str>,
}

fn meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(META))
        .map_err(|_| "storage".to_owned())
}
fn read_meta(path: &Path) -> Result<Option<Meta>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "storage".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("storage".into()),
    }
}
fn write_meta(path: &Path, meta: &Meta) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(meta).map_err(|_| "storage")?;
    std::fs::create_dir_all(path.parent().ok_or("storage")?)
        .and_then(|()| std::fs::write(&temporary, bytes))
        .and_then(|()| std::fs::rename(&temporary, path))
        .map_err(|_| "storage".into())
}
fn status(app: &AppHandle, state: &RemoteState) -> RemoteStatus {
    let meta = if cfg!(desktop) {
        meta_path(app)
            .and_then(|path| read_meta(&path))
            .ok()
            .flatten()
    } else {
        None
    };
    let (running, error) = state.snapshot();
    RemoteStatus {
        supported: cfg!(desktop),
        configured: meta.is_some(),
        enabled: meta.as_ref().is_some_and(|meta| meta.enabled),
        running,
        origin: meta.map(|meta| meta.origin),
        error,
    }
}
fn client() -> Result<reqwest::Client, String> {
    lazysh_notification_client::http_client().map_err(|_| "storage".into())
}
fn failure(error: PollError) -> String {
    error.code().into()
}
fn require_desktop() -> Result<(), String> {
    if cfg!(desktop) {
        Ok(())
    } else {
        Err("unsupported".into())
    }
}
/// Reads the saved token and starts the poller; the first poll only records a baseline.
fn resume(app: &AppHandle, state: &RemoteState, origin: &str) -> Result<(), String> {
    let stored = Zeroizing::new(
        app.vault()
            .get(ACCOUNT)
            .map_err(|_| "storage")?
            .ok_or("credentials")?,
    );
    let secret: Secret = serde_json::from_str(&stored).map_err(|_| "credentials")?;
    state.begin(app, Reader::new(client()?, origin, &secret.token)?);
    Ok(())
}

/// Restarts an enabled receiver at launch. Nothing is read from the credential store unless the
/// user opted in, and a damaged settings file never stops the app from starting.
pub fn install(app: &tauri::App) {
    if !cfg!(desktop) {
        return;
    }
    let handle = app.handle().clone();
    if let Ok(Some(Meta {
        origin,
        enabled: true,
    })) = meta_path(&handle).and_then(|path| read_meta(&path))
    {
        tauri::async_runtime::spawn_blocking(move || {
            let state = handle.state::<RemoteState>();
            if let Err(code) = resume(&handle, &state, &origin) {
                lock(&state.0).error = Some(if code == "credentials" {
                    "credentials"
                } else {
                    "storage"
                });
            }
        });
    }
}

#[tauri::command]
pub fn remote_notifications_status(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, RemoteState>,
) -> Protected<RemoteStatus> {
    access.run_sync(|| Ok(status(&app, &state)))
}

/// Verifies the token with one poll, saves it and starts receiving.
#[tauri::command]
pub async fn remote_notifications_configure(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, RemoteState>,
    origin: String,
    token: String,
) -> Protected<RemoteStatus> {
    let token = Zeroizing::new(token);
    access
        .run(async {
            require_desktop()?;
            if !valid_gotify_token(&token) {
                return Err("token".to_owned());
            }
            let url = lazysh_notification_client::https(origin.trim()).map_err(|_| "origin")?;
            let origin = url.as_str().trim_end_matches('/').to_owned();
            let mut reader = Reader::new(client()?, &origin, &token).map_err(|_| "origin")?;
            reader.poll().await.map_err(failure)?;
            let stored = Zeroizing::new(
                serde_json::to_string(&Secret {
                    token: token.to_string(),
                })
                .map_err(|_| "storage")?,
            );
            let saved = app.clone();
            let meta = Meta {
                origin,
                enabled: true,
            };
            tauri::async_runtime::spawn_blocking(move || {
                saved.vault().set(ACCOUNT, &stored)?;
                write_meta(&meta_path(&saved)?, &meta)
            })
            .await
            .map_err(|_| "storage")?
            .map_err(|_| "storage")?;
            state.begin(&app, reader);
            Ok(status(&app, &state))
        })
        .await
}

/// Stops receiving and keeps the saved token, so Resume needs no new entry.
#[tauri::command]
pub async fn remote_notifications_pause(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, RemoteState>,
) -> Protected<RemoteStatus> {
    access
        .run(async {
            require_desktop()?;
            state.stop();
            let path = meta_path(&app)?;
            if let Some(mut meta) = read_meta(&path)? {
                meta.enabled = false;
                write_meta(&path, &meta)?;
            }
            Ok(status(&app, &state))
        })
        .await
}

#[tauri::command]
pub async fn remote_notifications_resume(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, RemoteState>,
) -> Protected<RemoteStatus> {
    access
        .run(async {
            require_desktop()?;
            let path = meta_path(&app)?;
            let mut meta = read_meta(&path)?.ok_or("credentials")?;
            let handle = app.clone();
            let origin = meta.origin.clone();
            let state_handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                resume(&handle, &state_handle.state::<RemoteState>(), &origin)
            })
            .await
            .map_err(|_| "storage")??;
            meta.enabled = true;
            write_meta(&path, &meta)?;
            Ok(status(&app, &state))
        })
        .await
}

/// Stops receiving and removes the token and address from this device. The token stays valid
/// at the Gotify server until its client is deleted there.
#[tauri::command]
pub async fn remote_notifications_forget(
    access: AccessLease,
    app: AppHandle,
    state: State<'_, RemoteState>,
) -> Protected<RemoteStatus> {
    access
        .run(async {
            require_desktop()?;
            state.stop();
            let removed = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                removed.vault().delete(ACCOUNT).map_err(|_| "storage")?;
                match std::fs::remove_file(meta_path(&removed)?) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                        Err("storage".to_owned())
                    }
                    _ => Ok(()),
                }
            })
            .await
            .map_err(|_| "storage")??;
            Ok(status(&app, &state))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::share::test_support::{tls_front, tls_proxy};
    use axum::{http::header, response::IntoResponse, routing::get, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const SERVER_NOW: &str = "Thu, 01 Jan 2026 00:01:00 GMT";
    fn page(events: &[(u64, &str)]) -> String {
        let messages: Vec<_> = events
            .iter()
            .map(|(id, text)| serde_json::json!({"id":id,"appid":1,"title":"lazysh","message":text,"priority":if text.ends_with("needs_attention") {5} else {2},"date":"2026-01-01T00:00:30Z"}))
            .collect();
        serde_json::json!({"messages":messages}).to_string()
    }
    /// A Gotify server behind verified TLS whose message list the test controls.
    struct Server {
        reader: Reader,
        messages: Arc<Mutex<String>>,
        requests: Arc<AtomicUsize>,
        status: Arc<Mutex<u16>>,
    }
    async fn server() -> Server {
        let messages = Arc::new(Mutex::new(page(&[])));
        let status = Arc::new(Mutex::new(200u16));
        let requests = Arc::new(AtomicUsize::new(0));
        let (list, code, count) = (messages.clone(), status.clone(), requests.clone());
        let app = Router::new().route(
            "/message",
            get(move || {
                count.fetch_add(1, Ordering::SeqCst);
                let (body, code) = (list.lock().unwrap().clone(), *code.lock().unwrap());
                async move {
                    (
                        axum::http::StatusCode::from_u16(code).unwrap(),
                        [(header::DATE, SERVER_NOW)],
                        body,
                    )
                        .into_response()
                }
            }),
        );
        let backend = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = backend.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(backend, app).await.unwrap() });
        let front = tls_front().await;
        let client =
            lazysh_notification_client::client_with_root(Some(front.root.clone())).unwrap();
        let reader = Reader::new(client, &front.origin, "client-token").unwrap();
        tls_proxy(front.listener, front.acceptor, destination);
        Server {
            reader,
            messages,
            requests,
            status,
        }
    }
    async fn until(mut condition: impl FnMut() -> bool) {
        for _ in 0..400 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("deadline");
    }

    #[tokio::test]
    async fn one_generic_alert_per_new_attention_event_and_nothing_after_a_pause() {
        let server = server().await;
        let shown = Arc::new(AtomicUsize::new(0));
        let state = RemoteState::default();
        let count = shown.clone();
        state.start(server.reader, Duration::from_millis(20), move || {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        assert_eq!(state.snapshot(), (true, None));
        until(|| server.requests.load(Ordering::SeqCst) >= 2).await;
        assert_eq!(
            shown.load(Ordering::SeqCst),
            0,
            "an empty or old server raises nothing"
        );
        // Working and done events, and a message in any other shape, never alert.
        *server.messages.lock().unwrap() = page(&[(3, "build: done"), (2, "build: working")]);
        let seen = server.requests.load(Ordering::SeqCst);
        until(|| server.requests.load(Ordering::SeqCst) >= seen + 3).await;
        assert_eq!(shown.load(Ordering::SeqCst), 0);
        *server.messages.lock().unwrap() =
            page(&[(4, "build: needs_attention"), (3, "build: done")]);
        until(|| shown.load(Ordering::SeqCst) == 1).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            shown.load(Ordering::SeqCst),
            1,
            "the same event is never shown twice"
        );
        state.stop();
        assert_eq!(state.snapshot(), (false, None));
        // A request sent just before the stop may still reach the server; count only after it landed.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let stopped = server.requests.load(Ordering::SeqCst);
        *server.messages.lock().unwrap() = page(&[(5, "build: needs_attention")]);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            server.requests.load(Ordering::SeqCst),
            stopped,
            "a paused receiver contacts nothing"
        );
        assert_eq!(shown.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_revoked_token_ends_the_receiver_with_a_finite_code_and_a_blocked_display_is_reported(
    ) {
        let server = server().await;
        let state = RemoteState::default();
        state.start(server.reader, Duration::from_millis(20), || {
            Err("notification_permission")
        });
        until(|| server.requests.load(Ordering::SeqCst) >= 1).await;
        *server.messages.lock().unwrap() = page(&[(1, "build: needs_attention")]);
        until(|| state.snapshot().1 == Some("notification_permission")).await;
        *server.status.lock().unwrap() = 401;
        until(|| state.snapshot() == (false, Some("unauthorized"))).await;
        let rejected = server.requests.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            server.requests.load(Ordering::SeqCst),
            rejected,
            "a rejected token is not retried"
        );
    }

    #[test]
    fn saved_settings_hold_no_secret_and_a_damaged_file_is_reported_not_trusted() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested").join(META);
        assert!(read_meta(&path).unwrap().is_none());
        write_meta(
            &path,
            &Meta {
                origin: "https://gotify.example.com".into(),
                enabled: true,
            },
        )
        .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            r#"{"origin":"https://gotify.example.com","enabled":true}"#
        );
        write_meta(
            &path,
            &Meta {
                origin: "https://gotify.example.com".into(),
                enabled: false,
            },
        )
        .unwrap();
        assert!(!read_meta(&path).unwrap().unwrap().enabled);
        for damaged in ["", "{", r#"{"origin":"x","enabled":true,"token":"secret"}"#] {
            std::fs::write(&path, damaged).unwrap();
            assert_eq!(read_meta(&path).err().as_deref(), Some("storage"));
        }
    }
}
