use serde::{Deserialize, Serialize};
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationStatus {
    pub supported: bool,
    pub configured: bool,
    pub enabled: bool,
    pub token_present: bool,
    pub busy: bool,
    pub reason: String,
}

struct Push<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

struct ControlSequence(std::sync::atomic::AtomicU64);

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Control {
    operation_epoch: u64,
}

#[cfg(not(target_os = "android"))]
fn unsupported() -> RegistrationStatus {
    RegistrationStatus {
        supported: false,
        configured: false,
        enabled: false,
        token_present: false,
        busy: false,
        reason: "Remote push registration is currently available only on configured Android builds. Local inbox notifications remain available.".into(),
    }
}

fn call<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    epoch: u64,
) -> Result<RegistrationStatus, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<Push<R>>()
            .handle
            .run_mobile_plugin(
                command,
                Control {
                    operation_epoch: epoch,
                },
            )
            .map_err(|_| {
                "Cannot complete native push registration; check configuration and retry".into()
            })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app.state::<Push<R>>(), epoch);
        if command == "status" {
            Ok(unsupported())
        } else {
            Err(unsupported().reason)
        }
    }
}

pub mod commands {
    use super::*;
    #[tauri::command]
    pub fn push_registration_status<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<RegistrationStatus, String> {
        call(&app, "status", 0)
    }

    #[tauri::command]
    pub async fn push_registration_register<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<RegistrationStatus, String> {
        let epoch = app
            .state::<ControlSequence>()
            .0
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        tauri::async_runtime::spawn_blocking(move || call(&app, "register", epoch))
            .await
            .map_err(|_| "Native push registration interrupted".to_string())?
    }

    #[tauri::command]
    pub async fn push_registration_disable<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<RegistrationStatus, String> {
        let epoch = app
            .state::<ControlSequence>()
            .0
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        tauri::async_runtime::spawn_blocking(move || call(&app, "disable", epoch))
            .await
            .map_err(|_| "Native push revocation interrupted".to_string())?
    }
}
pub use commands::*;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("lazysh-push")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let push = Push {
                handle: api.register_android_plugin("app.lazysh.push", "PushPlugin")?,
            };
            #[cfg(not(target_os = "android"))]
            let push = {
                let _ = api;
                Push::<R> {
                    _runtime: std::marker::PhantomData,
                }
            };
            app.manage(push);
            app.manage(ControlSequence(std::sync::atomic::AtomicU64::new(0)));
            Ok(())
        })
        .build()
}
