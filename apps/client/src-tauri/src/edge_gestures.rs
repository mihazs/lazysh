//! Android gesture navigation claims the side edges for Back; the shell asks it to leave a bounded band to the app.
use tauri::AppHandle;

/// Widest side zone the renderer may claim, in dp (Preferences allows 16 to 48).
const MAX_ZONE_DP: u32 = 64;

#[cfg(target_os = "android")]
struct Exclusion(tauri::plugin::PluginHandle<tauri::Wry>);

fn validate(zone_dp: u32) -> Result<(), String> {
    if (1..=MAX_ZONE_DP).contains(&zone_dp) {
        Ok(())
    } else {
        Err("Invalid edge zone width.".into())
    }
}

/// Claims the left and right edge bands of the window (`left`, `right`) from the system Back gesture;
/// both false hands the edges back. A no-op outside Android, where nothing owns the edges.
#[tauri::command]
pub async fn edge_gesture_exclusion(
    app: AppHandle,
    left: bool,
    right: bool,
    zone_dp: u32,
) -> Result<(), String> {
    validate(zone_dp)?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<Exclusion>()
            .0
            .run_mobile_plugin_async(
                "setExclusion",
                serde_json::json!({ "left": left, "right": right, "zoneDp": zone_dp }),
            )
            .await
            .map_err(|_| "The system gesture exclusion is unavailable".to_owned())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, left, right);
        Ok(())
    }
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("lazysh-edge-gestures")
        // The renderer reaches this through the app command, never the plugin.
        .invoke_handler(|invoke| {
            invoke.resolver.reject("unavailable");
            true
        })
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(Exclusion(api.register_android_plugin(
                    "app.lazysh.client",
                    "EdgeGesturePlugin",
                )?));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_usable_zone_width_is_accepted() {
        assert!(validate(0).is_err());
        assert!(validate(65).is_err());
        assert!(validate(1).is_ok() && validate(24).is_ok() && validate(MAX_ZONE_DP).is_ok());
    }
}
