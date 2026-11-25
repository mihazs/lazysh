//! Whether platform accessibility is active (#1329, #1335). The native terminal draws on a GPU surface with no text a reader can reach, so
//! the client's registry refuses it for a new session while this says yes, whether or not the user also turned on the in-app
//! Screen reader announcements. The Kotlin plugin (`ScreenReaderPlugin.kt`) asks Android's accessibility manager: touch
//! exploration, which TalkBack and its kin turn on, or an enabled service that speaks or brailles the screen. Linux
//! asks AT-SPI whether the desktop has enabled accessibility. UIKit and AppKit report VoiceOver directly.
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

#[cfg(all(target_os = "linux", native_terminal_core))]
fn linux_accessibility_active() -> Result<bool, String> {
    use gtk::gio;
    use gtk::glib::variant::ToVariant;

    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .map_err(|_| "The Linux accessibility bus is unavailable".to_string())?;
    let reply = bus.call_sync(
        Some("org.a11y.Bus"),
        "/org/a11y/bus",
        "org.freedesktop.DBus.Properties",
        "Get",
        Some(&("org.a11y.Status", "IsEnabled").to_variant()),
        None,
        gio::DBusCallFlags::NONE,
        600,
        gio::Cancellable::NONE,
    );
    match reply {
        Ok(value) => value
            .get::<(gtk::glib::Variant,)>()
            .and_then(|(value,)| value.get::<bool>())
            .ok_or_else(|| "Invalid Linux accessibility status".to_string()),
        Err(_) => Err("The Linux accessibility status is unavailable".into()),
    }
}

#[cfg(all(any(target_os = "ios", target_os = "macos"), native_terminal_core))]
pub(crate) fn apple_voice_over_active() -> bool {
    #[cfg(target_os = "ios")]
    return objc2_ui_kit::UIAccessibilityIsVoiceOverRunning();
    #[cfg(target_os = "macos")]
    return objc2_app_kit::NSWorkspace::sharedWorkspace().isVoiceOverEnabled();
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
    #[cfg(all(target_os = "linux", native_terminal_core))]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(linux_accessibility_active)
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(all(any(target_os = "ios", target_os = "macos"), native_terminal_core))]
    {
        let (answer, asked) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = answer.send(apple_voice_over_active());
        })
        .map_err(|error| error.to_string())?;
        asked.await.map_err(|error| error.to_string())
    }
    #[cfg(not(any(
        target_os = "android",
        all(target_os = "linux", native_terminal_core),
        all(any(target_os = "ios", target_os = "macos"), native_terminal_core)
    )))]
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
