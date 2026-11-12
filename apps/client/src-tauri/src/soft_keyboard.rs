//! Android soft keyboard. The page can only focus an input; showing the keyboard for an input that
//! already has focus, hiding it, reading whether it is really up, or showing it beside a hardware
//! keyboard takes the window's IME controller. Other platforms have no such call: iOS shows and
//! hides the keyboard with focus, and the page reads its state from the viewport.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use serde::Deserialize;
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

/// Android IME controller of the single main window; absent elsewhere.
#[cfg(target_os = "android")]
struct Ime(tauri::plugin::PluginHandle<tauri::Wry>);

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Show,
    Hide,
    Status,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct Visible {
    visible: bool,
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("lazysh-soft-keyboard")
        .invoke_handler(|invoke| {
            invoke.resolver.reject("unavailable");
            true
        })
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(Ime(api.register_android_plugin(
                "app.lazysh.client",
                "SoftKeyboardPlugin",
            )?));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

/// `Some(visible)` where Android reports the keyboard; `None` where the page's focus and viewport decide.
async fn run(app: &AppHandle, action: Action) -> Result<Option<bool>, String> {
    #[cfg(target_os = "android")]
    {
        let command = match action {
            Action::Show => "show",
            Action::Hide => "hide",
            Action::Status => "status",
        };
        app.state::<Ime>()
            .0
            .run_mobile_plugin_async::<Visible>(command, serde_json::json!({}))
            .await
            .map(|reply| Some(reply.visible))
            .map_err(|_| "The Android keyboard is unavailable".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, action);
        Ok(None)
    }
}

/// Shows or hides the Android soft keyboard, or reads whether it is up. The caller's access lease
/// is required, like every device-local command.
#[tauri::command]
pub async fn soft_keyboard(
    app: AppHandle,
    action: Action,
    access: AccessLease,
) -> Result<Guarded<Option<bool>>, GuardedError<String>> {
    access.run(async { run(&app, action).await }).await
}
