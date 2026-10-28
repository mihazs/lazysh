//! App-facing push commands participate in the same foreground authority.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use tauri::AppHandle;
use tauri_plugin_lazysh_push::RegistrationStatus;
type Result = std::result::Result<Guarded<RegistrationStatus>, GuardedError<String>>;
#[tauri::command]
pub fn push_registration_status(access: AccessLease, app: AppHandle) -> Result {
    access.run_sync(|| tauri_plugin_lazysh_push::commands::push_registration_status(app))
}
#[tauri::command]
pub async fn push_registration_register(access: AccessLease, app: AppHandle) -> Result {
    access
        .run(tauri_plugin_lazysh_push::commands::push_registration_register(app))
        .await
}
#[tauri::command]
pub async fn push_registration_enroll(access: AccessLease, app: AppHandle) -> Result {
    access
        .run(tauri_plugin_lazysh_push::commands::push_registration_enroll(app))
        .await
}
#[tauri::command]
pub async fn push_registration_disable(access: AccessLease, app: AppHandle) -> Result {
    access
        .run(tauri_plugin_lazysh_push::commands::push_registration_disable(app))
        .await
}
