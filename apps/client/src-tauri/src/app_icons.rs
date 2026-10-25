use tauri::AppHandle;
use tauri_plugin_lazysh_apple_status::{AppIconStatus, AppleStatusExt};

// Cosmetic device-local commands: no SSH, credentials, resume proof or lock mutation.
#[tauri::command]
pub async fn app_icon_status(app: AppHandle) -> Result<AppIconStatus, String> {
    app.apple_status().app_icon_status().await
}
#[tauri::command]
pub async fn set_app_icon(app: AppHandle, icon: String) -> Result<AppIconStatus, String> {
    app.apple_status().set_app_icon(icon).await
}
