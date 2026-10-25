//! OS theme links stay native until a fresh, ready foreground lease reads them.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const LIMIT: usize = 16 * 1024;
const INVALID: &str = "Invalid theme link";

fn theme_code(url: &str) -> Result<String, &'static str> {
    if url.len() > LIMIT {
        return Err(INVALID);
    }
    let data = url.strip_prefix("lazysh://theme?data=").ok_or(INVALID)?;
    if data.is_empty()
        || data.len() % 4 == 1
        || !data
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(INVALID);
    }
    Ok(format!("lazysh-theme:{data}"))
}

#[derive(Clone, Serialize)]
pub struct Candidate {
    receipt: String,
    code: String,
}
#[derive(Default)]
struct Pending {
    candidate: Option<Candidate>,
    revision: u64,
}
#[derive(Default)]
pub struct ThemeLinks(Mutex<Pending>);
impl ThemeLinks {
    fn offer(&self, url: &str, expected: Option<u64>) -> bool {
        let Ok(code) = theme_code(url) else {
            return false;
        };
        let Ok(mut pending) = self.0.lock() else {
            return false;
        };
        if expected.is_some_and(|revision| pending.revision != revision) {
            return false;
        }
        if pending
            .candidate
            .as_ref()
            .is_some_and(|value| value.code == code)
        {
            return false;
        }
        pending.revision = pending.revision.wrapping_add(1);
        pending.candidate = Some(Candidate {
            receipt: uuid::Uuid::new_v4().to_string(),
            code,
        });
        true
    }
    fn read(&self) -> Result<Option<Candidate>, String> {
        self.0
            .lock()
            .map(|pending| pending.candidate.clone())
            .map_err(|_| "Theme link is unavailable".into())
    }
    fn acknowledge(&self, receipt: &str) -> Result<(), String> {
        if uuid::Uuid::parse_str(receipt).is_err() {
            return Err("Invalid theme receipt".into());
        }
        let mut pending = self.0.lock().map_err(|_| "Theme link is unavailable")?;
        if pending
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.receipt == receipt)
        {
            pending.candidate = None;
        }
        Ok(())
    }
}

pub fn install<R: tauri::Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        // One candidate only: the latest accepted route replaces an unreviewed one.
        // Agent URLs continue through their existing native Apple status receiver.
        for url in event.urls().iter().take(8) {
            if handle.state::<ThemeLinks>().offer(url.as_str(), None) {
                let _ = handle.emit("lazysh-theme-link", ());
            }
        }
    });
    let revision = app
        .state::<ThemeLinks>()
        .0
        .lock()
        .map_err(|_| "Theme link is unavailable")?
        .revision;
    if let Some(urls) = app.deep_link().get_current()? {
        // A warm event observed during cold-start retrieval wins over that snapshot.
        for url in urls.iter().rev().take(8) {
            if app
                .state::<ThemeLinks>()
                .offer(url.as_str(), Some(revision))
            {
                break;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn theme_link_status(
    state: tauri::State<'_, ThemeLinks>,
    access: AccessLease,
) -> Result<Guarded<bool>, GuardedError<String>> {
    access.run_sync(|| {
        state
            .0
            .lock()
            .map(|pending| pending.candidate.is_some())
            .map_err(|_| "Theme link is unavailable".to_owned())
    })
}
#[tauri::command]
pub fn theme_link_read(
    state: tauri::State<'_, ThemeLinks>,
    access: AccessLease,
) -> Result<Guarded<Option<Candidate>>, GuardedError<String>> {
    access.run_sync(|| state.read())
}
#[tauri::command]
pub fn theme_link_ack(
    state: tauri::State<'_, ThemeLinks>,
    receipt: String,
    access: AccessLease,
) -> Result<Guarded<()>, GuardedError<String>> {
    access.run_sync(|| {
        access
            .with_current(|| state.acknowledge(&receipt))
            .map_err(String::from)?
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn native_plugin_routes_metadata_without_replaying_or_permanently_deduplicating_links() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tauri::{Emitter, Listener};
        use tauri_plugin_deep_link::DeepLinkExt;
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_deep_link::init())
            .manage(ThemeLinks::default())
            .build(tauri::generate_context!(test = true))
            .unwrap();
        app.listen_any("deep-link://new-url", |event| {
            assert_eq!(event.payload(), "null")
        });
        let oversized_raw = format!("{}lazysh://theme?data=YWJj", " ".repeat(LIMIT));
        app.deep_link()
            .handle_cli_arguments(["lazysh", oversized_raw.as_str()].into_iter());
        assert!(app.deep_link().get_current().unwrap().is_none());
        // This mirrors real cold CLI ingress, before application listeners exist.
        app.deep_link()
            .handle_cli_arguments(["lazysh", "lazysh://theme?data=YWJj"].into_iter());
        install(&app).unwrap();
        let pending = app.state::<ThemeLinks>();
        let first = pending.read().unwrap().unwrap();
        pending.acknowledge(&first.receipt).unwrap();
        let delivered = Arc::new(AtomicUsize::new(0));
        let observed = delivered.clone();
        let reentrant = app.handle().clone();
        let listener = app.deep_link().on_open_url(move |event| {
            assert_eq!(event.urls()[0].as_str(), "lazysh://theme?data=YWJj");
            observed.fetch_add(1, Ordering::SeqCst);
            reentrant.emit("deep-link://new-url", ()).unwrap();
        });
        app.emit("deep-link://new-url", ()).unwrap();
        assert!(
            pending.read().unwrap().is_none(),
            "cold cache must not replay after acknowledgement"
        );
        assert_eq!(delivered.load(Ordering::SeqCst), 0);
        app.deep_link()
            .handle_cli_arguments(["lazysh", "lazysh://theme?data=YWJj"].into_iter());
        assert_eq!(
            app.deep_link().get_current().unwrap().unwrap()[0].as_str(),
            "lazysh://theme?data=YWJj"
        );
        let reopened = pending.read().unwrap().unwrap();
        pending.acknowledge(&reopened.receipt).unwrap();
        app.emit("deep-link://new-url", ()).unwrap();
        assert!(pending.read().unwrap().is_none());
        assert_eq!(delivered.load(Ordering::SeqCst), 1);
        app.deep_link()
            .handle_cli_arguments(["lazysh", "lazysh://theme?data=YWJj"].into_iter());
        assert!(pending.read().unwrap().is_some());
        assert_eq!(delivered.load(Ordering::SeqCst), 2);
        app.unlisten(listener);
        app.deep_link()
            .handle_cli_arguments(["lazysh", "lazysh://theme?data=YWJj"].into_iter());
        assert_eq!(delivered.load(Ordering::SeqCst), 2);
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let unguarded = tauri::webview::InvokeRequest {
            cmd: "plugin:deep-link|get_current".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://127.0.0.1:1420".parse().unwrap(),
            body: Default::default(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        };
        assert!(
            tauri::test::get_ipc_response(&window, unguarded).is_err(),
            "plugin frontend get_current must not bypass the guarded pending API"
        );
    }
    #[test]
    fn accepts_only_the_bounded_canonical_theme_route() {
        assert_eq!(
            theme_code("lazysh://theme?data=YWJj").unwrap(),
            "lazysh-theme:YWJj"
        );
        for value in [
            "https://theme?data=YWJj",
            "lazysh://agents/id",
            "lazysh://@theme?data=YWJj",
            "lazysh://theme:80?data=YWJj",
            "lazysh://theme/?data=YWJj",
            "lazysh://theme?data=YWJj#",
            "lazysh://theme?data=YWJj&data=YWJj",
            "lazysh://theme?data=YWJj&x=y",
            "lazysh://theme?data=%41%41",
            "lazysh://theme?data=",
            "lazysh://theme?data=A",
            "lazysh://theme?data=AA==",
            " lazysh://theme?data=AA",
            "lazysh://theme?data=AA\n",
        ] {
            assert!(theme_code(value).is_err(), "accepted {value:?}");
        }
        assert!(theme_code(&format!("lazysh://theme?data={}", "A".repeat(LIMIT))).is_err());
    }
    #[test]
    fn typed_platform_urls_reject_real_credentials_and_preserve_canonical_semantics() {
        for value in [
            "lazysh://user@theme?data=YWJj",
            "lazysh://:password@theme?data=YWJj",
            "lazysh://theme:80?data=YWJj",
            "lazysh://other?data=YWJj",
            "lazysh://theme/?data=YWJj",
            "lazysh://theme?data=YWJj#fragment",
            "lazysh://theme?data=YWJj&data=YWJj",
        ] {
            if let Ok(parsed) = reqwest::Url::parse(value) {
                assert!(theme_code(parsed.as_str()).is_err());
            }
        }
        // Apple RunEvent::Opened already contains parsed URLs. Original empty
        // userinfo/outer whitespace spelling may no longer exist at this boundary.
        for value in ["lazysh://@theme?data=YWJj", " lazysh://theme?data=YWJj "] {
            let parsed = reqwest::Url::parse(value).unwrap();
            assert_eq!(theme_code(parsed.as_str()).unwrap(), "lazysh-theme:YWJj");
        }
    }
    #[test]
    fn cold_snapshot_and_old_receipt_never_replace_or_clear_a_new_link() {
        let links = ThemeLinks::default();
        assert!(links.offer("lazysh://theme?data=YWJj", None));
        let old = links.read().unwrap().unwrap();
        assert!(links.offer("lazysh://theme?data=ZGVm", None));
        assert!(!links.offer("lazysh://theme?data=YWJj", Some(0)));
        links.acknowledge(&old.receipt).unwrap();
        let latest = links.read().unwrap().unwrap();
        assert_eq!(latest.code, "lazysh-theme:ZGVm");
        links.acknowledge(&latest.receipt).unwrap();
        assert!(links.read().unwrap().is_none());
    }
    #[test]
    fn pending_payload_survives_lock_but_old_leases_cannot_read_or_ack_it() {
        use crate::app_lock::AccessState;
        let authority = AccessState::default();
        authority
            .initialize(true, true, "synthetic".into())
            .unwrap();
        authority
            .authorize(authority.generation().unwrap())
            .unwrap();
        authority.ready(authority.generation().unwrap()).unwrap();
        let lease = authority
            .lease(authority.status().unwrap().nonce.as_deref())
            .unwrap();
        let links = ThemeLinks::default();
        links.offer("lazysh://theme?data=YWJj", None);
        let value = lease.run_sync::<_, String>(|| links.read()).unwrap();
        authority.background().unwrap();
        assert!(tauri::ipc::IpcResponse::body(value).is_err());
        assert!(lease.run_sync::<_, String>(|| links.read()).is_err());
        authority.foreground().unwrap();
        authority
            .authorize(authority.generation().unwrap())
            .unwrap();
        assert!(lease.run_sync::<_, String>(|| links.read()).is_err());
        let receipt = links.read().unwrap().unwrap().receipt;
        assert!(lease
            .run_sync::<_, String>(|| links.acknowledge(&receipt))
            .is_err());
        assert!(links.read().unwrap().is_some());
        authority.ready(authority.generation().unwrap()).unwrap();
        let fresh = authority
            .lease(authority.status().unwrap().nonce.as_deref())
            .unwrap();
        assert!(fresh.run_sync::<_, String>(|| links.read()).is_ok());
    }
}
