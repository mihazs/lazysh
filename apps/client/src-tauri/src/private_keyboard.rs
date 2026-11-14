use tauri::AppHandle;

/// Android handle for the soft-keyboard shaping; the renderer cannot call this plugin directly.
#[cfg(target_os = "android")]
struct Keyboard(tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("lazysh-private-keyboard")
        .invoke_handler(|invoke| {
            invoke.resolver.reject("unavailable");
            true
        })
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(Keyboard(api.register_android_plugin(
                    "app.lazysh.client",
                    "PrivateKeyboardPlugin",
                )?));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

/// Whether the focused terminal editor should ask the soft keyboard to act as a private, plain key source.
/// Cosmetic and device-local; the app-lock gate in front of every command is the only authority it needs.
#[tauri::command]
pub async fn terminal_private_keyboard(app: AppHandle, active: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<Keyboard>()
            .0
            .run_mobile_plugin_async::<()>("set", serde_json::json!({ "active": active }))
            .await
            .map_err(|_| "The keyboard mode could not be changed".to_owned())
    }
    // Other platforms have no soft keyboard to shape: the report is accepted and ignored.
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, active);
        Ok(())
    }
}
