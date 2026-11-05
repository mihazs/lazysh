use crate::app_lock::{AccessLease, Guarded, GuardedError};
use tauri::AppHandle;
use tauri_plugin_lazysh_apple_status::AppIconStatus;
#[cfg(not(target_os = "android"))]
use tauri_plugin_lazysh_apple_status::AppleStatusExt;

// Only the bundled lazysh artwork is selectable on any platform.
fn bundled(icon: &str) -> Result<(), String> {
    if matches!(icon, "default" | "amber") {
        Ok(())
    } else {
        Err("Choose a bundled lazysh app icon".into())
    }
}

/// Android launcher aliases. The renderer cannot call this plugin directly.
#[cfg(target_os = "android")]
struct LauncherIcons(tauri::plugin::PluginHandle<tauri::Wry>);
#[cfg(target_os = "android")]
impl LauncherIcons {
    async fn call(
        &self,
        command: &str,
        args: serde_json::Value,
        fallback: &str,
    ) -> Result<AppIconStatus, String> {
        self.0
            .run_mobile_plugin_async(command, args)
            .await
            .map_err(|error| match error {
                tauri::plugin::mobile::PluginInvokeError::InvokeRejected(error) => {
                    error.message.unwrap_or_else(|| fallback.into())
                }
                _ => "Android launcher icon service is unavailable".into(),
            })
    }
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("lazysh-app-icons")
        .invoke_handler(|invoke| {
            invoke.resolver.reject("unavailable");
            true
        })
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(LauncherIcons(
                    api.register_android_plugin("app.lazysh.client", "AppIconPlugin")?,
                ));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

async fn status(app: &AppHandle) -> Result<AppIconStatus, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<LauncherIcons>()
            .call(
                "status",
                serde_json::json!({}),
                "Cannot read the Android launcher icon",
            )
            .await
    }
    #[cfg(not(target_os = "android"))]
    {
        app.apple_status().app_icon_status().await
    }
}
async fn select(app: &AppHandle, icon: String) -> Result<AppIconStatus, String> {
    bundled(&icon)?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<LauncherIcons>()
            .call(
                "select",
                serde_json::json!({ "icon": icon }),
                "Android could not change the launcher icon",
            )
            .await
    }
    #[cfg(not(target_os = "android"))]
    {
        app.apple_status().set_app_icon(icon).await
    }
}

// Cosmetic device-local commands still require the caller's original access lease.
#[tauri::command]
pub async fn app_icon_status(
    app: AppHandle,
    access: AccessLease,
) -> Result<Guarded<AppIconStatus>, GuardedError<String>> {
    access.run(async { status(&app).await }).await
}
#[tauri::command]
pub async fn set_app_icon(
    app: AppHandle,
    icon: String,
    access: AccessLease,
) -> Result<Guarded<AppIconStatus>, GuardedError<String>> {
    access.run(async { select(&app, icon).await }).await
}
