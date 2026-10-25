use crate::app_lock::{AccessLease, Guarded, GuardedError};
use tauri::AppHandle;
use tauri_plugin_lazysh_apple_status::{AppIconStatus, AppleStatusExt};

// Cosmetic device-local commands still require the caller's original access lease.
#[tauri::command]
pub async fn app_icon_status(
    app: AppHandle,
    access: AccessLease,
) -> Result<Guarded<AppIconStatus>, GuardedError<String>> {
    access
        .run(async { app.apple_status().app_icon_status().await })
        .await
}
#[tauri::command]
pub async fn set_app_icon(
    app: AppHandle,
    icon: String,
    access: AccessLease,
) -> Result<Guarded<AppIconStatus>, GuardedError<String>> {
    access
        .run(async { app.apple_status().set_app_icon(icon).await })
        .await
}
