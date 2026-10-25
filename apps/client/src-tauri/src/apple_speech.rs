use tauri::AppHandle;
use tauri_plugin_lazysh_apple_speech::{AppleSpeechExt, Capability};

#[tauri::command]
pub async fn apple_speech_capability(app: AppHandle) -> Result<Capability, String> {
    app.apple_speech().capability().await
}
#[tauri::command]
pub async fn apple_speech_install(
    app: AppHandle,
    language: String,
    request_id: String,
) -> Result<(), String> {
    app.apple_speech().install(language, request_id).await
}
#[tauri::command]
pub async fn apple_speech_remove(
    app: AppHandle,
    language: String,
    request_id: String,
) -> Result<(), String> {
    app.apple_speech().remove(language, request_id).await
}
#[tauri::command]
pub async fn apple_speech_transcribe(
    app: AppHandle,
    samples: Vec<f32>,
    language: String,
    request_id: String,
) -> Result<String, String> {
    app.apple_speech()
        .transcribe(samples, language, request_id)
        .await
}
#[tauri::command]
pub async fn apple_speech_cancel(app: AppHandle, request_id: String) -> Result<(), String> {
    app.apple_speech().cancel(request_id).await
}
