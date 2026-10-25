use tauri::AppHandle;
use tauri_plugin_lazysh_apple_status::{AppleStatusExt, Capability, Snapshot};

#[tauri::command]
pub async fn apple_status_capability(app: AppHandle) -> Result<Capability, String> {
    app.apple_status().capability().await
}

#[tauri::command]
pub async fn apple_status_configure(
    app: AppHandle,
    subscription_id: String,
    enabled: bool,
) -> Result<(), String> {
    app.apple_status().configure(subscription_id, enabled).await
}

#[tauri::command]
pub async fn apple_status_publish(
    app: AppHandle,
    snapshot: Snapshot,
    start_activity: bool,
) -> Result<(), String> {
    app.apple_status().publish(snapshot, start_activity).await
}
