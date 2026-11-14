//! Android gesture navigation claims the side edges for Back and the bottom edge for Home; the shell reports
//! those zones live and, on request, leaves a bounded band of the side edges to the app.
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Widest side zone the renderer may claim, in dp (Preferences allows 16 to 96).
const MAX_ZONE_DP: u32 = 96;
/// Android limits an exclusion to this many dp of height per edge; the shell clamps to it, so a larger row is refused here.
const MAX_ROW_DP: u32 = 200;
/// Taller than any window, so a corrupt row cannot pass for a real one.
const MAX_EDGE_DP: u32 = 20_000;

#[cfg(target_os = "android")]
struct Exclusion(tauri::plugin::PluginHandle<tauri::Wry>);

/// The system gesture zones as they reach into the web viewport, in dp (CSS px).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GestureInsets {
    pub left: u32,
    pub right: u32,
    pub bottom: u32,
    pub mandatory_bottom: u32,
    /// `gesture`, `buttons` or `unknown`.
    pub navigation: String,
}

impl GestureInsets {
    /// Where nothing owns the edges, so the renderer keeps true edge swipes.
    #[cfg_attr(target_os = "android", allow(dead_code))]
    fn unknown() -> Self {
        Self {
            left: 0,
            right: 0,
            bottom: 0,
            mandatory_bottom: 0,
            navigation: "unknown".into(),
        }
    }
}

fn validate(zone_dp: u32, row_top_dp: u32, row_bottom_dp: u32) -> Result<(), String> {
    if !(1..=MAX_ZONE_DP).contains(&zone_dp) {
        return Err("Invalid edge zone width.".into());
    }
    // An empty or inverted row claims nothing; hand the edges back with left and right false instead.
    if row_bottom_dp <= row_top_dp
        || row_bottom_dp > MAX_EDGE_DP
        || row_bottom_dp - row_top_dp > MAX_ROW_DP
    {
        return Err("Invalid edge row.".into());
    }
    Ok(())
}

/// Claims the left and right edge bands of the window (`left`, `right`), `zone_dp` wide and between `row_top_dp`
/// and `row_bottom_dp` tall (at most 200 dp, above the bottom gesture zone), from the system Back gesture;
/// both false hands the edges back. A no-op outside Android, where nothing owns the edges.
#[tauri::command]
pub async fn edge_gesture_exclusion(
    app: AppHandle,
    left: bool,
    right: bool,
    zone_dp: u32,
    row_top_dp: u32,
    row_bottom_dp: u32,
) -> Result<(), String> {
    validate(zone_dp, row_top_dp, row_bottom_dp)?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<Exclusion>()
            .0
            .run_mobile_plugin_async(
                "setExclusion",
                serde_json::json!({
                    "left": left,
                    "right": right,
                    "zoneDp": zone_dp,
                    "rowTopDp": row_top_dp,
                    "rowBottomDp": row_bottom_dp,
                }),
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

/// The live system gesture zones (`WindowInsetsCompat.Type.systemGestures()` and `mandatorySystemGestures()`).
/// The shell also dispatches a `lazysh-gesture-insets` window event whenever they change.
#[tauri::command]
pub async fn edge_gesture_insets(app: AppHandle) -> Result<GestureInsets, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<Exclusion>()
            .0
            .run_mobile_plugin_async::<GestureInsets>("getInsets", serde_json::json!({}))
            .await
            .map_err(|_| "The system gesture zones are unavailable".to_owned())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(GestureInsets::unknown())
    }
}

/// A plugin the renderer reaches through app commands, never through the plugin's own invoke handler.
pub(crate) fn command_only_plugin(name: &'static str) -> tauri::plugin::Builder<tauri::Wry> {
    tauri::plugin::Builder::new(name).invoke_handler(|invoke| {
        invoke.resolver.reject("unavailable");
        true
    })
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    command_only_plugin("lazysh-edge-gestures")
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
        assert!(validate(0, 600, 800).is_err());
        assert!(validate(97, 600, 800).is_err());
        assert!(validate(1, 600, 800).is_ok() && validate(24, 600, 800).is_ok());
        assert!(validate(MAX_ZONE_DP, 600, 800).is_ok());
    }

    #[test]
    fn a_row_is_at_most_the_android_cap_and_never_empty() {
        assert!(validate(24, 600, 800).is_ok());
        assert!(validate(24, 600, 801).is_err());
        assert!(validate(24, 800, 800).is_err());
        assert!(validate(24, 800, 600).is_err());
        assert!(validate(24, 0, 100).is_ok());
        assert!(validate(24, MAX_EDGE_DP, MAX_EDGE_DP + 1).is_err());
    }

    #[test]
    fn insets_cross_the_boundary_in_camel_case() {
        let insets: GestureInsets = serde_json::from_value(serde_json::json!({
            "left": 32, "right": 32, "bottom": 20, "mandatoryBottom": 24, "navigation": "gesture"
        }))
        .unwrap();
        assert_eq!(insets.mandatory_bottom, 24);
        let value = serde_json::to_value(GestureInsets::unknown()).unwrap();
        assert_eq!(value["mandatoryBottom"], 0);
        assert_eq!(value["navigation"], "unknown");
    }
}
