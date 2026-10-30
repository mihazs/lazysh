//! App-private clipboard bridge. Renderer plugin commands are explicitly rejected.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
#[cfg(target_os = "android")]
use tauri::wry::prelude as native;
use tauri::{Manager, Runtime};
use tokio::sync::watch;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    token: String,
    kind: Kind,
}
#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Text,
    Image,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Payload {
    Text { text: String },
    Image { mime: String, bytes: String },
}
struct Issued {
    request: Request,
    native: String,
    #[cfg(any(target_os = "android", test))]
    document: u64,
    #[cfg(any(target_os = "android", test))]
    access: AccessLease,
    cancel: watch::Sender<bool>,
    finished: bool,
    #[cfg(any(target_os = "android", test))]
    admitted: bool,
    #[cfg(any(target_os = "android", test))]
    expires: std::time::Instant,
}
#[derive(Default)]
struct Owner(Mutex<Option<Issued>>);
static AUTHORITY: OnceLock<Arc<Owner>> = OnceLock::new();
fn authority() -> &'static Arc<Owner> {
    AUTHORITY.get_or_init(Default::default)
}
impl Owner {
    fn start(
        &self,
        request: Request,
        document: u64,
        access: AccessLease,
    ) -> Result<(watch::Receiver<bool>, String), String> {
        #[cfg(not(any(target_os = "android", test)))]
        let _ = (document, access);
        let mut pending = self.0.lock().map_err(|_| "clipboard_unavailable")?;
        if pending.is_some() {
            return Err("clipboard_busy".into());
        }
        let (cancel, stopped) = watch::channel(false);
        let native = uuid::Uuid::new_v4().to_string();
        *pending = Some(Issued {
            request,
            native: native.clone(),
            #[cfg(any(target_os = "android", test))]
            document,
            #[cfg(any(target_os = "android", test))]
            access,
            cancel,
            finished: false,
            #[cfg(any(target_os = "android", test))]
            admitted: false,
            #[cfg(any(target_os = "android", test))]
            expires: std::time::Instant::now() + std::time::Duration::from_secs(5),
        });
        Ok((stopped, native))
    }
    fn cancel(&self, client: Option<&str>) {
        if let Ok(mut pending) = self.0.lock() {
            if let Some(issued) = pending
                .as_mut()
                .filter(|issued| client.is_none_or(|client| client == issued.request.token))
            {
                issued.cancel.send_replace(true);
                if issued.finished {
                    *pending = None;
                }
            }
        }
    }
    #[cfg(any(target_os = "android", test))]
    fn valid(issued: &Issued) -> bool {
        !*issued.cancel.borrow() && std::time::Instant::now() < issued.expires
    }
    #[cfg(any(target_os = "android", test))]
    fn admit(
        &self,
        native: &str,
        kind: Kind,
        document: u64,
        action: impl FnOnce() -> bool,
    ) -> bool {
        let Ok(mut pending) = self.0.lock() else {
            return false;
        };
        let Some(issued) = pending.as_mut().filter(|issued| {
            issued.native == native
                && issued.request.kind == kind
                && issued.document == document
                && !issued.admitted
                && Self::valid(issued)
        }) else {
            return false;
        };
        issued.admitted = true;
        // Permit -> access -> fixed UI admission; no provider I/O under these monitors.
        let accepted = issued.access.with_current(action).unwrap_or(false);
        if !accepted {
            issued.cancel.send_replace(true);
        }
        accepted
    }
    #[cfg(any(target_os = "android", test))]
    fn current(&self, native: &str) -> bool {
        self.0.lock().is_ok_and(|pending| {
            pending.as_ref().is_some_and(|issued| {
                issued.native == native
                    && issued.admitted
                    && Self::valid(issued)
                    && issued.access.check().is_ok()
            })
        })
    }
    fn retire(&self, native: &str) {
        if let Ok(mut pending) = self.0.lock() {
            if let Some(issued) = pending.as_mut().filter(|issued| issued.native == native) {
                issued.finished = true;
                // Preserve the sender and original authority until Rust consumes the
                // response or revokes it; normal retirement is not cancellation.
                if *issued.cancel.borrow() {
                    *pending = None;
                }
            }
        }
    }
}
struct Clipboard<R: Runtime> {
    owner: Arc<Owner>,
    document: AtomicU64,
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    marker: std::marker::PhantomData<fn() -> R>,
}
struct Active<'a, R: Runtime>(&'a Clipboard<R>, String, String);
impl<R: Runtime> Drop for Active<'_, R> {
    fn drop(&mut self) {
        // AccessLease::run may drop its future on lock. Cleanup must survive that drop.
        self.0.owner.cancel(Some(&self.1));
        #[cfg(target_os = "android")]
        {
            let handle = self.0.handle.clone();
            let token = self.2.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle
                    .run_mobile_plugin_async::<()>("cancel", serde_json::json!({"token":token}))
                    .await;
            });
        }
        // Android acknowledges retirement only after queued admission is rejected or
        // the actual worker has finished. A hung provider keeps this slot occupied.
        #[cfg(not(target_os = "android"))]
        self.0.owner.retire(&self.2);
    }
}
fn token(value: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value) {
        Ok(())
    } else {
        Err("clipboard_unavailable".into())
    }
}
fn main_window<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("clipboard_unavailable".into())
    }
}
impl<R: Runtime> Clipboard<R> {
    async fn read(&self, request: Request, document: u64) -> Result<Payload, String> {
        #[cfg(target_os = "android")]
        return self
            .handle
            .run_mobile_plugin_async(
                "read",
                serde_json::json!({
                    "token":request.token, "kind":request.kind,
                    "document": document
                }),
            )
            .await
            .map_err(|_| "clipboard_unavailable".into());
        #[cfg(not(target_os = "android"))]
        {
            let _ = (request, document);
            Err("clipboard_unsupported".into())
        }
    }
}
async fn dispatch(
    access: &AccessLease,
    stopped: &mut watch::Receiver<bool>,
    read: impl std::future::Future<Output = Result<Payload, String>>,
) -> Result<Payload, String> {
    access.check().map_err(String::from)?;
    if *stopped.borrow() {
        return Err("clipboard_cancelled".into());
    }
    tokio::select! { biased;
        _ = access.cancelled() => Err("clipboard_cancelled".into()),
        _ = stopped.changed() => Err("clipboard_cancelled".into()),
        _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => Err("clipboard_unavailable".into()),
        value = read => value,
    }
}
#[tauri::command]
pub async fn clipboard_read<R: Runtime>(
    access: AccessLease,
    window: tauri::WebviewWindow<R>,
    request: Request,
) -> Result<Guarded<Payload>, GuardedError<String>> {
    access
        .run(async {
            main_window(&window)?;
            token(&request.token)?;
            let clipboard = window.state::<Clipboard<R>>();
            let document = clipboard.document.load(Ordering::SeqCst);
            access.check().map_err(String::from)?;
            let (mut stopped, native) =
                clipboard
                    .owner
                    .start(request.clone(), document, access.clone())?;
            let _active = Active(&*clipboard, request.token.clone(), native.clone());
            let native_request = Request {
                token: native,
                kind: request.kind,
            };
            let result = dispatch(
                &access,
                &mut stopped,
                clipboard.read(native_request, document),
            )
            .await;
            if *stopped.borrow() || clipboard.document.load(Ordering::SeqCst) != document {
                return Err("clipboard_cancelled".into());
            }
            result
        })
        .await
}
/// Exact-owner cleanup cannot read or acquire another operation, even after locking.
#[tauri::command]
pub fn clipboard_cancel<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    token: String,
) -> Result<(), String> {
    main_window(&window)?;
    self::token(&token)?;
    window.state::<Clipboard<R>>().owner.cancel(Some(&token));
    Ok(())
}
#[tauri::command]
pub fn clipboard_is_android() -> bool {
    cfg!(target_os = "android")
}
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("lazysh-clipboard")
        .invoke_handler(|invoke| { invoke.resolver.reject("clipboard_unavailable"); true })
        .setup(|app, api| {
            #[cfg(not(target_os = "android"))]
            let _ = api;
            app.manage(Clipboard::<R> {
                owner: authority().clone(),
                document: AtomicU64::new(0),
                #[cfg(target_os = "android")]
                handle: api.register_android_plugin("app.lazysh.client", "ClipboardPlugin")?,
                marker: std::marker::PhantomData,
            });
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() != "main" || !matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                return;
            }
            {
                let clipboard = webview.state::<Clipboard<R>>();
                let document = clipboard.document.fetch_add(1, Ordering::SeqCst) + 1;
                clipboard.owner.cancel(None);
                #[cfg(target_os = "android")]
                {
                    let handle = clipboard.handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle.run_mobile_plugin_async::<()>("invalidate", serde_json::json!({"document":document})).await;
                    });
                }
                #[cfg(not(target_os = "android"))]
                let _ = document;
            }
        })
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed, .. } if label == "main")
                || matches!(event, tauri::RunEvent::Exit)
            {
                app.state::<Clipboard<R>>().owner.cancel(None);
            }
        })
        .build()
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_lazysh_client_NativeClipboardAuthority_invalidate(
    _env: native::JNIEnv<'_>,
    _object: native::JObject<'_>,
) {
    authority().cancel(None);
}

#[cfg(target_os = "android")]
fn native_token(env: &mut native::JNIEnv<'_>, value: &native::JString<'_>) -> Option<String> {
    if env
        .call_method(value, "length", "()I", &[])
        .ok()?
        .i()
        .ok()?
        != 36
    {
        return None;
    }
    let value: String = env.get_string(value).ok()?.into();
    token(&value).ok()?;
    Some(value)
}
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_lazysh_client_NativeClipboardAuthority_admit(
    mut env: native::JNIEnv<'_>,
    _object: native::JObject<'_>,
    value: native::JString<'_>,
    kind: native::JString<'_>,
    document: native::jni::sys::jlong,
    action: native::JObject<'_>,
) -> native::jboolean {
    let admitted = (|| {
        if document < 0
            || !env
                .is_instance_of(&action, "app/lazysh/client/ClipboardAdmission")
                .ok()?
        {
            return None;
        }
        let native = native_token(&mut env, &value)?;
        if env
            .call_method(&kind, "length", "()I", &[])
            .ok()?
            .i()
            .ok()?
            > 5
        {
            return None;
        }
        let kind: String = env.get_string(&kind).ok()?.into();
        let kind = match kind.as_str() {
            "text" => Kind::Text,
            "image" => Kind::Image,
            _ => return None,
        };
        Some(authority().admit(&native, kind, document as u64, || {
            env.call_method(&action, "run", "()V", &[]).is_ok()
        }))
    })()
    .unwrap_or(false);
    let _ = env.exception_clear();
    u8::from(admitted)
}
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_lazysh_client_NativeClipboardAuthority_current(
    mut env: native::JNIEnv<'_>,
    _object: native::JObject<'_>,
    value: native::JString<'_>,
) -> native::jboolean {
    let current = native_token(&mut env, &value).is_some_and(|native| authority().current(&native));
    let _ = env.exception_clear();
    u8::from(current)
}
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_lazysh_client_NativeClipboardAuthority_retire(
    mut env: native::JNIEnv<'_>,
    _object: native::JObject<'_>,
    value: native::JString<'_>,
) {
    if let Some(native) = native_token(&mut env, &value) {
        authority().retire(&native);
    }
    let _ = env.exception_clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    fn access() -> (crate::app_lock::AccessState, AccessLease) {
        let state = crate::app_lock::AccessState::default();
        crate::app_lock::ready_fixture_authority(&state);
        let access = state
            .lease(state.status().unwrap().nonce.as_deref())
            .unwrap();
        (state, access)
    }
    fn issue(owner: &Owner, client: &str, access: AccessLease) -> (watch::Receiver<bool>, String) {
        owner
            .start(
                Request {
                    token: client.into(),
                    kind: Kind::Text,
                },
                7,
                access,
            )
            .unwrap()
    }
    #[test]
    fn cancel_before_native_admission_never_runs_the_clipboard_action() {
        let owner = Owner::default();
        let (_, access) = access();
        let (stopped, native) = issue(&owner, "A", access.clone());
        owner.cancel(Some("A"));
        assert!(*stopped.borrow());
        assert!(!owner.admit(&native, Kind::Text, 7, || panic!("cancelled queued read")));
        assert!(
            owner
                .start(
                    Request {
                        token: "B".into(),
                        kind: Kind::Text
                    },
                    7,
                    access
                )
                .is_err(),
            "cancelled owner waits for native retirement"
        );
        owner.retire(&native);
    }
    #[test]
    fn rebind_and_stale_cleanup_cannot_retarget_a_new_issued_permit() {
        let owner = Owner::default();
        let (_, access) = access();
        let (_, old) = issue(&owner, "A", access.clone());
        // Native Activity/WebView/focus invalidation happens synchronously before late dispatch.
        owner.cancel(None);
        assert!(!owner.admit(&old, Kind::Text, 7, || panic!("rebound queued read")));
        owner.retire(&old);
        let (_, new) = issue(&owner, "B", access);
        owner.cancel(Some("A"));
        owner.retire(&old);
        assert!(!owner.admit(&old, Kind::Text, 7, || panic!("old permit rebound to B")));
        assert!(!owner.admit(&new, Kind::Image, 7, || panic!("kind changed")));
        assert!(!owner.admit(&new, Kind::Text, 8, || panic!("document changed")));
        assert!(owner.admit(&new, Kind::Text, 7, || true));
        assert!(owner.current(&new));
        assert!(!owner.admit(&new, Kind::Text, 7, || panic!("one-shot replay")));
    }
    #[test]
    fn original_access_and_deadline_are_checked_at_actual_native_admission() {
        let owner = Owner::default();
        let (state, access) = access();
        let (_, native) = issue(&owner, "A", access);
        state.background().unwrap();
        state.foreground().unwrap();
        assert!(!owner.admit(&native, Kind::Text, 7, || panic!("revoked access")));
        owner.retire(&native);
        let (_, access) = self::access();
        let (_, native) = issue(&owner, "B", access);
        owner.0.lock().unwrap().as_mut().unwrap().expires = std::time::Instant::now();
        assert!(!owner.admit(&native, Kind::Text, 7, || panic!("expired admission")));
    }
    #[tokio::test]
    async fn already_signalled_cancel_is_selected_before_native_dispatch() {
        let (cancel, mut stopped) = watch::channel(false);
        cancel.send(true).unwrap();
        let called = std::sync::atomic::AtomicBool::new(false);
        let (_, access) = access();
        let result = dispatch(&access, &mut stopped, async {
            called.store(true, Ordering::SeqCst);
            Ok(Payload::Text {
                text: "must not read".into(),
            })
        })
        .await;
        assert!(result.is_err());
        assert!(!called.load(Ordering::SeqCst));
    }
    #[test]
    fn successful_native_retirement_keeps_response_ownership_until_rust_drop() {
        let owner = Owner::default();
        let (_, access) = access();
        let (stopped, native) = issue(&owner, "A", access.clone());
        assert!(owner.admit(&native, Kind::Text, 7, || true));
        owner.retire(&native);
        assert!(!stopped.has_changed().unwrap());
        assert!(!*stopped.borrow());
        assert!(owner
            .start(
                Request {
                    token: "B".into(),
                    kind: Kind::Text
                },
                7,
                access.clone()
            )
            .is_err());
        owner.cancel(Some("A"));
        assert!(owner
            .start(
                Request {
                    token: "B".into(),
                    kind: Kind::Text
                },
                7,
                access
            )
            .is_ok());
    }
    #[test]
    fn cleanup_only_is_allowed_after_lock_and_input_is_closed() {
        assert!(crate::app_lock::allowed_while_locked("clipboard_cancel"));
        assert!(!crate::app_lock::allowed_while_locked("clipboard_read"));
        assert!(token("00000000-0000-4000-8000-000000000001").is_ok());
        for invalid in ["private", "00000000000040008000000000000001"] {
            assert!(token(invalid).is_err());
        }
        assert!(serde_json::from_value::<Request>(
            serde_json::json!({"token":"private", "kind":"uri"})
        )
        .is_err());
    }
}
