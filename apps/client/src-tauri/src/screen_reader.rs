//! Whether a mobile screen reader is on (#1329, #1335). The native terminal draws on a GPU surface with no text a reader can reach, so
//! the client's registry refuses it for a new session while this says yes, whether or not the user also turned on the in-app
//! Screen reader announcements. The Kotlin plugin (`ScreenReaderPlugin.kt`) asks Android's accessibility manager: touch
//! exploration, which TalkBack and its kin turn on, or an enabled service that speaks or brailles the screen. UIKit
//! reports VoiceOver directly. Desktop continues to use the registry's in-app preference.
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

/// Android's accessibility state, read from the application's one plugin handle; absent elsewhere.
#[cfg(target_os = "android")]
struct Readers(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct Status {
    active: bool,
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    crate::edge_gestures::command_only_plugin("lazysh-screen-reader")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(Readers(api.register_android_plugin(
                "app.lazysh.client",
                "ScreenReaderPlugin",
            )?));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

/// Whether a screen reader is on. Like the probe it reads the device and nothing of the user's, so a locked app may ask: the
/// engine Auto resolves to is announced at launch, before the app is unlocked.
#[tauri::command]
pub async fn screen_reader_active(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<Readers>()
            .0
            .run_mobile_plugin_async::<Status>("status", serde_json::json!({}))
            .await
            .map(|status| status.active)
            .map_err(|_| "The Android accessibility state is unavailable".to_string())
    }
    #[cfg(all(target_os = "ios", native_terminal_core))]
    {
        let (answer, asked) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = answer.send(objc2_ui_kit::UIAccessibilityIsVoiceOverRunning());
        })
        .map_err(|error| error.to_string())?;
        asked.await.map_err(|error| error.to_string())
    }
    #[cfg(not(any(target_os = "android", all(target_os = "ios", native_terminal_core))))]
    {
        let _ = app;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_locked_app_can_ask_whether_a_screen_reader_is_on() {
        assert!(crate::app_lock::allowed_while_locked(
            "screen_reader_active"
        ));
    }
}
