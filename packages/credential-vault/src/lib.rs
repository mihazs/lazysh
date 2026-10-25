use serde::{Deserialize, Serialize};
pub mod access;
#[cfg(target_os = "macos")]
mod macos_resume;
mod operation;
pub use operation::{CredentialOperation, CredentialOperations};
use zeroize::Zeroize;
#[cfg(target_os = "macos")]
mod macos;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
#[cfg(any(target_os = "windows", test))]
mod chunked;

#[cfg(target_os = "windows")]
struct WindowsStore<'a>(&'a str);
#[cfg(target_os = "windows")]
impl chunked::Store for WindowsStore<'_> {
    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match keyring::Entry::new(self.0, key)
            .map_err(|_| "OS credential store unavailable")?
            .get_secret()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Cannot read OS credential store".into()),
        }
    }
    fn write(&self, key: &str, value: &[u8]) -> Result<(), String> {
        keyring::Entry::new(self.0, key)
            .map_err(|_| "OS credential store unavailable")?
            .set_secret(value)
            .map_err(|_| "Cannot save to OS credential store".into())
    }
    fn remove(&self, key: &str) -> Result<(), String> {
        delete_ordinary(self.0, key)
    }
}

#[cfg(all(desktop, not(target_os = "macos")))]
fn delete_ordinary(service: &str, key: &str) -> Result<(), String> {
    match keyring::Entry::new(service, key)
        .map_err(|_| "OS credential store unavailable")?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Cannot delete from OS credential store".into()),
    }
}

#[cfg(all(desktop, not(target_os = "windows")))]
fn read_ordinary(service: &str, key: &str, failure: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new(service, key)
        .map_err(|_| "OS credential store unavailable")?
        .get_password()
    {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(failure.into()),
    }
}

#[cfg(mobile)]
#[derive(Serialize)]
struct Item {
    key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    biometric: bool,
    #[serde(rename = "authEpoch")]
    auth_epoch: u64,
}
#[cfg(mobile)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Cancel {
    auth_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    background_generation: Option<u64>,
}
#[cfg(target_os = "ios")]
#[derive(Serialize)]
struct LifecycleRegistration {
    background: tauri::ipc::Channel<serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
pub struct ProtectionCapability {
    pub available: bool,
    pub reason: String,
}
#[cfg(mobile)]
#[derive(Deserialize)]
struct Presence {
    exists: bool,
}

#[cfg(mobile)]
fn mobile_error(error: tauri::plugin::mobile::PluginInvokeError) -> String {
    match error {
        tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) => response
            .message
            .unwrap_or_else(|| "Credential operation cancelled or unavailable".into()),
        _ => "Device credential service unavailable".into(),
    }
}

#[cfg(mobile)]
#[derive(Deserialize)]
struct Value {
    value: Option<String>,
}

pub struct Vault<R: Runtime> {
    operations: CredentialOperations,
    access: access::AccessState,
    #[cfg(target_os = "macos")]
    resume: macos_resume::MacResume,
    #[cfg(target_os = "macos")]
    resume_app: tauri::AppHandle<R>,
    #[cfg(target_os = "ios")]
    lifecycle_ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
    #[cfg(target_os = "macos")]
    mac: macos::MacVault,
    #[cfg(desktop)]
    service: String,
    #[cfg(desktop)]
    _runtime: std::marker::PhantomData<fn() -> R>,
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
}

fn validate(key: &str, value: Option<&str>) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 1024
        || key.contains('\0')
        || value.is_some_and(|v| v.len() > 128 * 1024)
    {
        return Err("Invalid vault item size".into());
    }
    Ok(())
}

#[cfg(mobile)]
#[derive(Serialize)]
struct ResumeRegistration {
    events: tauri::ipc::Channel<serde_json::Value>,
}
#[cfg(mobile)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResumeView {
    covered: bool,
    enabled: bool,
    generation: u64,
    native_generation: u64,
}

impl<R: Runtime> Vault<R> {
    pub fn access(&self) -> &access::AccessState {
        &self.access
    }
    pub fn resume_failure(&self) -> Result<(), String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin("resumeFailure", ())
                .map_err(mobile_error)
        }
        #[cfg(target_os = "macos")]
        {
            let resume = self.resume.clone();
            self.resume_app
                .run_on_main_thread(move || resume.failure())
                .map_err(|_| "Cannot update native privacy cover".into())
        }
        #[cfg(all(desktop, not(target_os = "macos")))]
        {
            Ok(())
        }
    }
    pub fn resume_capability(&self) -> Result<ProtectionCapability, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin("resumeCapability", ())
                .map_err(mobile_error)
        }
        #[cfg(target_os = "macos")]
        {
            let mut capability = self.protection_capability()?;
            capability.available &= self.resume.ready();
            if !self.resume.ready() {
                capability.reason = "Native privacy cover is not ready".into();
            }
            Ok(capability)
        }
        #[cfg(all(desktop, not(target_os = "macos")))]
        {
            Ok(ProtectionCapability {
                available: false,
                reason: "Native biometric resume lock is unavailable on this platform".into(),
            })
        }
    }
    pub fn register_resume(
        &self,
        events: tauri::ipc::Channel<serde_json::Value>,
    ) -> Result<(), String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin("registerResume", ResumeRegistration { events })
                .map_err(mobile_error)
        }
        #[cfg(target_os = "macos")]
        {
            if objc2::MainThreadMarker::new().is_some() {
                return Err("Register native resume protection off the UI thread".into());
            }
            let app = self.resume_app.clone();
            let resume = self.resume.clone();
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            self.resume_app
                .run_on_main_thread(move || {
                    let result = (|| {
                        let window = app
                            .get_webview_window("main")
                            .ok_or("Native window unavailable")?;
                        let window_ptr = window
                            .ns_window()
                            .map_err(|_| "Native window unavailable")?;
                        let view_ptr = window
                            .ns_view()
                            .map_err(|_| "Native content view unavailable")?;
                        resume.install(window_ptr as usize, view_ptr as usize)?;
                        resume.register(events)
                    })();
                    let _ = send.send(result);
                })
                .map_err(|_| "Cannot install native privacy cover")?;
            receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "Native privacy cover did not become ready")?
        }
        #[cfg(all(desktop, not(target_os = "macos")))]
        {
            let _ = events;
            Err("Native biometric resume lock is unavailable on this platform".into())
        }
    }
    pub fn resume_view(
        &self,
        covered: bool,
        generation: u64,
        native_generation: u64,
    ) -> Result<(), String> {
        if !covered
            && (self.access.is_locked()
                || self.access.generation().map_err(String::from)? != generation)
        {
            return Err("Resume authority changed before native reveal".into());
        }
        let enabled = covered || self.access.policy_enabled().unwrap_or(true);
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin(
                    "resumeView",
                    ResumeView {
                        covered,
                        enabled,
                        generation,
                        native_generation,
                    },
                )
                .map_err(mobile_error)
        }
        #[cfg(target_os = "macos")]
        {
            if objc2::MainThreadMarker::new().is_some() {
                return self
                    .resume
                    .apply(covered, enabled, generation, native_generation);
            }
            let resume = self.resume.clone();
            let access = self.access.clone();
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            self.resume_app
                .run_on_main_thread(move || {
                    if !covered
                        && (access.is_locked() || access.generation().ok() != Some(generation))
                    {
                        let _ =
                            send.send(Err("Resume authority changed before native reveal".into()));
                        return;
                    }
                    let _ =
                        send.send(resume.apply(covered, enabled, generation, native_generation));
                })
                .map_err(|_| "Cannot update native privacy cover")?;
            receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "Native privacy cover did not respond")?
        }
        #[cfg(all(desktop, not(target_os = "macos")))]
        {
            let _ = (enabled, generation, native_generation);
            if covered {
                Err("Native privacy cover is unavailable".into())
            } else {
                Ok(())
            }
        }
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        self.get_protected(key, false)
    }
    pub fn get_protected(&self, key: &str, biometric: bool) -> Result<Option<String>, String> {
        self.get_protected_for(key, biometric, &self.operation())
    }
    pub fn operation(&self) -> CredentialOperation {
        self.operations.begin()
    }
    pub fn begin_cancellation(&self) -> u64 {
        self.operations.cancel()
    }
    fn prepare_operation(
        &self,
        key: &str,
        value: Option<&str>,
        biometric: bool,
        operation: &CredentialOperation,
    ) -> Result<(), String> {
        operation.check()?;
        #[cfg(target_os = "ios")]
        if !self
            .lifecycle_ready
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(
                "Native credential service is initializing; retry after reopening the app".into(),
            );
        }
        validate(key, value)?;
        #[cfg(all(desktop, not(target_os = "macos")))]
        if biometric {
            return Err("Biometric credential protection is unavailable on this platform".into());
        }
        #[cfg(not(all(desktop, not(target_os = "macos"))))]
        let _ = biometric;
        Ok(())
    }
    pub fn get_protected_for(
        &self,
        key: &str,
        biometric: bool,
        operation: &CredentialOperation,
    ) -> Result<Option<String>, String> {
        self.prepare_operation(key, None, biometric, operation)?;
        #[cfg(target_os = "windows")]
        let result = chunked::get(&WindowsStore(&self.service), key);
        #[cfg(target_os = "macos")]
        let result = objc2::rc::autoreleasepool(|_| {
            self.mac
                .get(&self.service, key, biometric, operation.epoch())
        });
        #[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos"))))]
        let result = read_ordinary(
            &self.service,
            key,
            "Cannot read OS credential store. Unlock your keychain and try again.",
        );
        #[cfg(mobile)]
        let result = {
            self.handle
                .run_mobile_plugin::<Value>(
                    "read",
                    Item {
                        key: key.into(),
                        value: None,
                        biometric,
                        auth_epoch: operation.epoch(),
                    },
                )
                .map(|result| result.value)
                .map_err(mobile_error)
        };
        if let Err(error) = operation.check() {
            if let Ok(Some(mut value)) = result {
                value.zeroize();
            }
            return Err(error);
        }
        result
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.set_protected(key, value, false)
    }
    pub fn set_protected(&self, key: &str, value: &str, biometric: bool) -> Result<(), String> {
        self.set_protected_for(key, value, biometric, &self.operation())
    }
    pub fn set_protected_for(
        &self,
        key: &str,
        value: &str,
        biometric: bool,
        operation: &CredentialOperation,
    ) -> Result<(), String> {
        self.prepare_operation(key, Some(value), biometric, operation)?;
        #[cfg(target_os = "windows")]
        let result = chunked::set(&WindowsStore(&self.service), key, value);
        #[cfg(target_os = "macos")]
        let result = objc2::rc::autoreleasepool(|_| {
            self.mac
                .set(&self.service, key, value, biometric, operation.epoch())
        });
        #[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos"))))]
        let result = {
            keyring::Entry::new(&self.service, key)
                .map_err(|_| "OS credential store unavailable")?
                .set_password(value)
                .map_err(|_| "Cannot save to OS credential store".into())
        };
        #[cfg(mobile)]
        let result = {
            self.handle
                .run_mobile_plugin::<()>(
                    "write",
                    Item {
                        key: key.into(),
                        value: Some(value.into()),
                        biometric,
                        auth_epoch: operation.epoch(),
                    },
                )
                .map_err(mobile_error)
        };
        // A successful native commit cannot be retroactively cancelled while its reply is in flight.
        result
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        validate(key, None)?;
        #[cfg(target_os = "windows")]
        {
            chunked::delete(&WindowsStore(&self.service), key)
        }
        #[cfg(target_os = "macos")]
        {
            objc2::rc::autoreleasepool(|_| self.mac.delete(&self.service, key))
        }
        #[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos"))))]
        {
            delete_ordinary(&self.service, key)
        }
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<()>(
                    "remove",
                    Item {
                        key: key.into(),
                        value: None,
                        biometric: false,
                        auth_epoch: self.operation().epoch(),
                    },
                )
                .map_err(|_| "Cannot delete from device credential store".into())
        }
    }

    pub fn protection_capability(&self) -> Result<ProtectionCapability, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin("capability", ())
                .map_err(mobile_error)
        }
        #[cfg(target_os = "macos")]
        {
            objc2::rc::autoreleasepool(|_| self.mac.capability(&self.service))
        }
        #[cfg(all(desktop, not(target_os = "macos")))]
        {
            Ok(ProtectionCapability {
                available: false,
                reason: "Biometric credential protection is unavailable on this platform".into(),
            })
        }
    }
    pub fn cancel_authentication(&self) -> Result<(), String> {
        self.cancel_authentication_at(self.begin_cancellation())
    }
    pub fn cancel_authentication_at(&self, auth_epoch: u64) -> Result<(), String> {
        self.cancel_authentication_with_epoch(auth_epoch, None)
    }
    fn cancel_authentication_with_epoch(
        &self,
        auth_epoch: u64,
        background_generation: Option<u64>,
    ) -> Result<(), String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin(
                    "cancel",
                    Cancel {
                        auth_epoch,
                        background_generation,
                    },
                )
                .map_err(mobile_error)
        }
        #[cfg(target_os = "macos")]
        {
            let _ = background_generation;
            objc2::rc::autoreleasepool(|_| self.mac.cancel(auth_epoch))
        }
        #[cfg(all(desktop, not(target_os = "macos")))]
        {
            let _ = (auth_epoch, background_generation);
            Ok(())
        }
    }
    pub fn exists(&self, key: &str) -> Result<bool, String> {
        validate(key, None)?;
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<Presence>(
                    "exists",
                    Item {
                        key: key.into(),
                        value: None,
                        biometric: false,
                        auth_epoch: self.operation().epoch(),
                    },
                )
                .map(|value| value.exists)
                .map_err(mobile_error)
        }
        #[cfg(target_os = "macos")]
        {
            objc2::rc::autoreleasepool(|_| self.mac.exists(&self.service, key))
        }
        #[cfg(all(desktop, not(target_os = "macos")))]
        {
            match keyring::Entry::new(&self.service, key)
                .map_err(|_| "OS credential store unavailable")?
                .get_attributes()
            {
                Ok(_) => Ok(true),
                Err(keyring::Error::NoEntry) => Ok(false),
                Err(_) => Err("Cannot inspect OS credential store".into()),
            }
        }
    }
}

pub trait VaultExt<R: Runtime>: Manager<R> {
    fn vault(&self) -> &Vault<R> {
        self.state::<Vault<R>>().inner()
    }
}
impl<R: Runtime, T: Manager<R>> VaultExt<R> for T {}

#[cfg(any(mobile, all(test, desktop, not(target_os = "macos"))))]
fn cancel_suspended_authentication<R: Runtime>(
    app: &tauri::AppHandle<R>,
    background_generation: Option<u64>,
) {
    let Some(vault) = app.try_state::<Vault<R>>() else {
        return;
    };
    let auth_epoch = vault.begin_cancellation();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(vault) = app.try_state::<Vault<R>>() {
            let _ = vault.cancel_authentication_with_epoch(auth_epoch, background_generation);
        }
    });
}
#[cfg(any(target_os = "ios", all(test, desktop, not(target_os = "macos"))))]
fn observe_native_background<R: Runtime>(
    app: &tauri::AppHandle<R>,
    observed: &std::sync::atomic::AtomicU64,
    generation: u64,
) {
    if generation > observed.fetch_max(generation, std::sync::atomic::Ordering::SeqCst) {
        cancel_suspended_authentication(app, Some(generation));
    }
}

#[cfg(any(target_os = "ios", all(test, desktop, not(target_os = "macos"))))]
fn observe_native_background_message<R: Runtime>(
    app: &tauri::AppHandle<R>,
    observed: &std::sync::atomic::AtomicU64,
    message: tauri::ipc::InvokeResponseBody,
) {
    if let tauri::ipc::InvokeResponseBody::Json(json) = message {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&json) {
            if let Some(generation) = payload
                .get("generation")
                .and_then(serde_json::Value::as_u64)
            {
                observe_native_background(app, observed, generation);
            }
        }
    }
}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_lazysh_vault);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lazysh-vault")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let vault = Vault {
                operations: CredentialOperations::default(),
                access: access::AccessState::default(),
                handle: api.register_android_plugin("app.lazysh.vault", "VaultPlugin")?,
            };
            #[cfg(target_os = "ios")]
            let vault = Vault {
                operations: CredentialOperations::default(),
                access: access::AccessState::default(),
                lifecycle_ready: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                handle: api.register_ios_plugin(init_plugin_lazysh_vault)?,
            };
            #[cfg(desktop)]
            let vault = {
                let _ = api;
                Vault::<R> {
                    operations: CredentialOperations::default(),
                access: access::AccessState::default(),
                    #[cfg(target_os = "macos")]
                    mac: macos::MacVault::default(),
                    #[cfg(target_os = "macos")]
                    resume: macos_resume::MacResume::default(),
                    #[cfg(target_os = "macos")]
                    resume_app: app.clone(),
                    service: format!("{}.credentials", app.config().identifier),
                    _runtime: std::marker::PhantomData,
                }
            };
            app.manage(vault);
            #[cfg(target_os = "ios")]
            {
                let callback_app = app.clone();
                let observed = std::sync::atomic::AtomicU64::new(0);
                let background = tauri::ipc::Channel::<serde_json::Value>::new(move |message| {
                    observe_native_background_message(&callback_app, &observed, message);
                    Ok(())
                });
                let handle = app.vault().handle.clone();
                let ready = app.vault().lifecycle_ready.clone();
                tauri::async_runtime::spawn(async move {
                    if handle.run_mobile_plugin_async::<()>("registerLifecycle", LifecycleRegistration { background }).await.is_ok() { ready.store(true, std::sync::atomic::Ordering::SeqCst); }
                });
            }
            Ok(())
        })
        .on_event(|app, event| {
            #[cfg(target_os = "android")]
            if matches!(event, tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Suspended, .. } if label == "main") {
                cancel_suspended_authentication(app, None);
            }
            #[cfg(target_os="macos")]
            if matches!(event,tauri::RunEvent::WindowEvent {label,event:tauri::WindowEvent::Destroyed,..} if label=="main") { app.vault().resume.destroy(); }
            #[cfg(not(any(target_os = "android",target_os="macos")))]
            let _ = (app, event);
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(all(desktop, not(target_os = "macos")))]
    #[test]
    fn native_suspension_invalidates_preverification_operations_without_a_javascript_callback() {
        let app = tauri::test::mock_builder()
            .manage(Vault::<tauri::test::MockRuntime> {
                operations: CredentialOperations::default(),
                access: access::AccessState::default(),
                service: "app.lazysh.suspension-test".into(),
                _runtime: std::marker::PhantomData,
            })
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let waiting_for_network = app.vault().operation();
        let native_counter = std::sync::atomic::AtomicU64::new(0);
        observe_native_background(app.handle(), &native_counter, 0);
        assert!(waiting_for_network.check().is_ok());
        observe_native_background_message(
            app.handle(),
            &native_counter,
            tauri::ipc::InvokeResponseBody::Json("{\"generation\":1}".into()),
        );
        assert!(waiting_for_network.check().is_err());
        let resumed_request = app.vault().operation();
        assert!(resumed_request.check().is_ok());
        assert_eq!(resumed_request.epoch(), 1);
        observe_native_background(app.handle(), &native_counter, 1);
        observe_native_background(app.handle(), &native_counter, 0);
        assert!(resumed_request.check().is_ok());
    }
    #[test]
    fn bounds_reject_items_before_os_access() {
        assert!(validate("", None).is_err());
        assert!(validate("a\0b", None).is_err());
        assert!(validate("host", Some(&"x".repeat(128 * 1024 + 1))).is_err());
        assert!(validate("host", Some("password")).is_ok());
    }

    #[cfg(all(desktop, not(target_os = "macos")))]
    #[test]
    fn unsupported_platforms_never_downgrade_biometric_requests_to_ordinary_storage() {
        let vault = Vault::<tauri::test::MockRuntime> {
            operations: CredentialOperations::default(),
            access: access::AccessState::default(),
            service: "app.lazysh.biometric-policy-test".into(),
            _runtime: std::marker::PhantomData,
        };
        assert!(!vault.protection_capability().unwrap().available);
        assert!(vault.resume_view(false, 0, 0).is_err());
        vault
            .access()
            .initialize(false, false, "test".into())
            .unwrap();
        assert!(vault
            .resume_view(false, vault.access().generation().unwrap(), 0)
            .is_ok());
        assert!(vault
            .get_protected("host", true)
            .unwrap_err()
            .contains("unavailable"));
        assert!(vault
            .set_protected("host", "not-written-to-vault", true)
            .unwrap_err()
            .contains("unavailable"));
    }

    #[cfg(desktop)]
    #[test]
    #[ignore = "requires an available unlocked native OS credential store"]
    fn os_vault_roundtrip() {
        struct Cleanup(keyring::Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let account = format!("{}-{:?}", std::process::id(), std::time::SystemTime::now());
        let item =
            Cleanup(keyring::Entry::new("app.lazysh.client.integration-test", &account).unwrap());
        item.0
            .set_password("temporary lazysh integration fixture")
            .unwrap();
        assert_eq!(
            item.0.get_password().unwrap(),
            "temporary lazysh integration fixture"
        );
        item.0.set_password("updated fixture").unwrap();
        assert_eq!(item.0.get_password().unwrap(), "updated fixture");
        item.0.delete_credential().unwrap();
        assert!(matches!(
            item.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }
}
