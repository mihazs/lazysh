//! Private native display-idle ownership. No plugin commands are exposed to JavaScript.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, MutexGuard,
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;
#[cfg(any(not(any(target_os = "android", target_os = "ios")), test))]
mod policy;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub epoch: String,
    pub ticket: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    pub reason: String,
    pub active: bool,
    pub epoch: String,
    pub ticket: u64,
}
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_display_idle);

pub struct DisplayIdle<R: Runtime> {
    app: tauri::AppHandle<R>,
    document: Arc<AtomicU64>,
    applied: Arc<Mutex<u64>>,
    #[cfg(any(target_os = "android", target_os = "ios"))]
    handle: tauri::plugin::PluginHandle<R>,
}
impl<R: Runtime> Clone for DisplayIdle<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            document: self.document.clone(),
            applied: self.applied.clone(),
            #[cfg(any(target_os = "android", target_os = "ios"))]
            handle: self.handle.clone(),
        }
    }
}
impl<R: Runtime> DisplayIdle<R> {
    fn native(&self, command: &str, request: Option<&Request>) -> Result<Status, String> {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            self.handle
                .run_mobile_plugin(command, request)
                .map_err(|error| error.to_string())
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            desktop::command(&self.app, command, request.cloned())
        }
    }
    fn synchronized(&self) -> Result<MutexGuard<'_, u64>, String> {
        let mut applied = self
            .applied
            .lock()
            .map_err(|_| "Display lifecycle is unavailable.")?;
        let document = self.document.load(Ordering::SeqCst);
        if *applied != document {
            #[cfg(any(target_os = "android", target_os = "ios"))]
            self.handle
                .run_mobile_plugin::<()>("invalidate", ())
                .map_err(|error| error.to_string())?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::command(&self.app, "invalidate", None)?;
            *applied = document;
        }
        Ok(applied)
    }
    pub fn status(&self) -> Result<Status, String> {
        let document = self.synchronized()?;
        let mut status = self.native("status", None)?;
        status.epoch = format!("{}/{}", *document, status.epoch);
        Ok(status)
    }
    fn native_request(&self, request: &Request, current: bool) -> Result<Request, String> {
        let (document, epoch) = request
            .epoch
            .split_once('/')
            .ok_or("Invalid display ownership.")?;
        let document: u64 = document.parse().map_err(|_| "Invalid display ownership.")?;
        if request.ticket == 0
            || request.ticket > 9_007_199_254_740_991
            || uuid::Uuid::parse_str(epoch).is_err()
            || (current && self.document.load(Ordering::SeqCst) != document)
        {
            return Err("Display ownership has expired.".into());
        }
        Ok(Request {
            epoch: epoch.into(),
            ticket: request.ticket,
        })
    }
    pub fn acquire(&self, request: &Request) -> Result<Status, String> {
        let _serial = self.synchronized()?;
        let document = self.document.load(Ordering::SeqCst);
        let native = self.native_request(request, true)?;
        let mut status = self.native("acquire", Some(&native))?;
        if self.document.load(Ordering::SeqCst) != document {
            self.native("release", Some(&native))?;
            return Err("Display ownership expired during acquisition.".into());
        }
        status.epoch = request.epoch.clone();
        Ok(status)
    }
    pub fn release(&self, request: &Request) -> Result<Status, String> {
        let _serial = self.synchronized()?;
        let native = self.native_request(request, false)?;
        let mut status = self.native("release", Some(&native))?;
        status.epoch = request.epoch.clone();
        Ok(status)
    }
    /// Rotate synchronously before queuing platform cleanup, including renderer reload.
    pub fn invalidate(&self) {
        self.document.fetch_add(1, Ordering::SeqCst);
        let handle = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = handle.synchronized() {
                eprintln!("Display idle release failed: {error}");
            }
        });
    }
}
pub trait DisplayIdleExt<R: Runtime> {
    fn display_idle(&self) -> &DisplayIdle<R>;
}
impl<R: Runtime, T: Manager<R>> DisplayIdleExt<R> for T {
    fn display_idle(&self) -> &DisplayIdle<R> {
        self.state::<DisplayIdle<R>>().inner()
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lazysh-display-idle")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle =
                api.register_android_plugin("app.lazysh.displayidle", "DisplayIdlePlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_display_idle)?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let _ = api;
            app.manage(DisplayIdle {
                app: app.clone(),
                document: Arc::new(AtomicU64::new(0)),
                applied: Arc::new(Mutex::new(0)),
                #[cfg(any(target_os = "android", target_os = "ios"))]
                handle,
            });
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                webview.display_idle().invalidate();
            }
        })
        .on_event(|app, event| {
            let owner_left = matches!(event, tauri::RunEvent::WindowEvent {
                label, event: tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed, ..
            } if label == "main");
            if owner_left || matches!(event, tauri::RunEvent::Exit) {
                app.display_idle().invalidate();
            }
        })
        .build()
}
