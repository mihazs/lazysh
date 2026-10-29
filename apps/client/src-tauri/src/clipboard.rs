//! App-private clipboard bridge. The mobile plugin has no renderer invoke handler.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{Manager, Runtime};
use tokio::sync::watch;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    token: String,
    kind: Kind,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
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
#[derive(Default)]
struct Owner(Mutex<Option<(String, watch::Sender<bool>)>>);
impl Owner {
    fn start(&self, token: &str) -> Result<watch::Receiver<bool>, String> {
        let mut slot = self.0.lock().map_err(|_| "clipboard_unavailable")?;
        if slot.is_some() {
            return Err("clipboard_busy".into());
        }
        let (cancel, stopped) = watch::channel(false);
        *slot = Some((token.into(), cancel));
        Ok(stopped)
    }
    fn cancel(&self, token: Option<&str>) {
        if let Ok(slot) = self.0.lock() {
            if let Some((owned, cancel)) = slot.as_ref() {
                if token.is_none_or(|token| token == owned) {
                    let _ = cancel.send(true);
                }
            }
        }
    }
    fn finish(&self, token: &str) {
        if let Ok(mut slot) = self.0.lock() {
            if slot.as_ref().is_some_and(|(owned, _)| token == owned) {
                *slot = None;
            }
        }
    }
}
struct Clipboard<R: Runtime> {
    owner: Owner,
    document: AtomicU64,
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    marker: std::marker::PhantomData<fn() -> R>,
}
struct Active<'a, R: Runtime>(&'a Clipboard<R>, String);
impl<R: Runtime> Drop for Active<'_, R> {
    fn drop(&mut self) {
        // AccessLease::run may drop its future on lock. Cleanup must survive that drop.
        #[cfg(target_os = "android")]
        {
            let handle = self.0.handle.clone();
            let token = self.1.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle
                    .run_mobile_plugin_async::<()>("cancel", serde_json::json!({"token":token}))
                    .await;
            });
        }
        self.0.owner.finish(&self.1);
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
#[tauri::command]
pub async fn clipboard_read<R: Runtime>(
    access: AccessLease,
    window: tauri::WebviewWindow<R>,
    request: Request,
) -> Result<Guarded<Payload>, GuardedError<String>> {
    access.run(async {
        main_window(&window)?;
        token(&request.token)?;
        let clipboard = window.state::<Clipboard<R>>();
        let document = clipboard.document.load(Ordering::SeqCst);
        let mut stopped = access
            .with_current(|| clipboard.owner.start(&request.token))
            .map_err(String::from)??;
        let operation = request.token.clone();
        let _active = Active(&*clipboard, operation);
        let result = tokio::select! {
            value = clipboard.read(request, document) => value,
            _ = access.cancelled() => Err("clipboard_cancelled".into()),
            _ = stopped.changed() => Err("clipboard_cancelled".into()),
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => Err("clipboard_unavailable".into()),
        };
        if *stopped.borrow() || clipboard.document.load(Ordering::SeqCst) != document {
            return Err("clipboard_cancelled".into());
        }
        result
    }).await
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
        .setup(|app, api| {
            #[cfg(not(target_os = "android"))]
            let _ = api;
            app.manage(Clipboard::<R> {
                owner: Owner::default(),
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_and_exact_cancellation_never_adopt_a_foreign_owner() {
        let owner = Owner::default();
        let stopped = owner.start("original").unwrap();
        assert!(owner.start("replacement").is_err());
        owner.cancel(Some("foreign"));
        assert!(!*stopped.borrow());
        owner.finish("foreign");
        assert!(owner.start("replacement").is_err());
        owner.cancel(None);
        assert!(*stopped.borrow());
        owner.finish("original");
        assert!(owner.start("replacement").is_ok());
    }
    #[test]
    fn cleanup_only_is_allowed_after_lock_and_input_is_closed() {
        assert!(crate::app_lock::allowed_while_locked("clipboard_cancel"));
        assert!(!crate::app_lock::allowed_while_locked("clipboard_read"));
        assert!(token("00000000-0000-4000-8000-000000000001").is_ok());
        for invalid in ["private", "00000000000040008000000000000001"] {
            assert!(token(invalid).is_err());
        }
        assert!(serde_json::from_value::<Request>(serde_json::json!({
            "token":"private", "kind":"uri"
        }))
        .is_err());
    }
    #[tokio::test]
    async fn access_revocation_drops_the_read_owner_before_it_can_be_reused() {
        let authority = crate::app_lock::AccessState::default();
        crate::app_lock::ready_fixture_authority(&authority);
        let lease = authority
            .lease(authority.status().unwrap().nonce.as_deref())
            .unwrap();
        let clipboard = Clipboard::<tauri::test::MockRuntime> {
            owner: Owner::default(),
            document: AtomicU64::new(0),
            marker: std::marker::PhantomData,
        };
        let mut entered = false;
        let result = lease
            .run(async {
                let _receiver = clipboard.owner.start("original").unwrap();
                let _active = Active(&clipboard, "original".into());
                entered = true;
                authority.background().unwrap();
                std::future::pending::<Result<(), String>>().await
            })
            .await;
        assert!(entered && result.is_err());
        assert!(clipboard.owner.start("replacement").is_ok());
    }
}
