//! The Android surface a native terminal draws on (#1327). The renderer places a session's `SurfaceView`
//! behind the transparent WebView at a DOM anchor and asks for its state; the Kotlin plugin owns the
//! surface and its lifecycle, Rust owns the session state and will own the renderer. Developer-only:
//! nothing in the app calls these yet, and a release build refuses every command (`native_surface_disabled`).
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

/// Longest session id the shell accepts; the renderer's ids are UUIDs.
const MAX_SESSION_LEN: usize = 64;
/// The largest texture side every GPU the app targets accepts, in pixels.
const MAX_PIXELS: f64 = 16_384.0;
/// A phone's ratio is 2 to 4; anything past this is a corrupt page, not a display.
const MAX_DPR: f64 = 8.0;

#[cfg(target_os = "android")]
struct Surfaces(tauri::plugin::PluginHandle<tauri::Wry>);

/// What the shell knows about a session's surface. `generation` counts the surfaces the session has had
/// and is 0 until the first exists: it rises on every stop/start, never on a resize.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceState {
    pub placed: bool,
    pub ready: bool,
    pub generation: u32,
    pub width: u32,
    pub height: u32,
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    crate::edge_gestures::command_only_plugin("lazysh-native-terminal-surface")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(Surfaces(api.register_android_plugin(
                "app.lazysh.client",
                "NativeTerminalSurfacePlugin",
            )?));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

fn validate_session(session: &str) -> Result<(), String> {
    let ok = !session.is_empty()
        && session.len() <= MAX_SESSION_LEN
        && session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err("Invalid terminal session id.".into())
    }
}

/// An element's `getBoundingClientRect()` in CSS pixels and the page's `devicePixelRatio`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Anchor {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    dpr: f64,
}

impl Anchor {
    /// Finite, non-empty, no larger than what a GPU holds, near the window.
    fn validate(&self) -> Result<(), String> {
        let Self {
            x,
            y,
            width,
            height,
            dpr,
        } = *self;
        let finite = [x, y, width, height, dpr].iter().all(|v| v.is_finite());
        let sized =
            width > 0.0 && height > 0.0 && width * dpr <= MAX_PIXELS && height * dpr <= MAX_PIXELS;
        let near = x.abs() * dpr <= MAX_PIXELS * 4.0 && y.abs() * dpr <= MAX_PIXELS * 4.0;
        if finite && dpr > 0.0 && dpr <= MAX_DPR && sized && near {
            Ok(())
        } else {
            Err("Invalid surface anchor.".into())
        }
    }
}

/// Puts the session's surface at the anchor and creates the session on first use. `background` is `0xRRGGBB`,
/// what shows until a renderer draws.
#[tauri::command]
pub async fn native_terminal_surface_place(
    app: AppHandle,
    session: String,
    anchor: Anchor,
    background: u32,
) -> Result<SurfaceState, String> {
    validate_session(&session)?;
    anchor.validate()?;
    if background > 0xff_ffff {
        return Err("Invalid surface background.".into());
    }
    #[cfg(target_os = "android")]
    {
        let Anchor {
            x,
            y,
            width,
            height,
            dpr,
        } = anchor;
        call(&app, "place", serde_json::json!({
            "session": session, "x": x, "y": y, "width": width, "height": height, "dpr": dpr, "background": background,
        }))
        .await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(unavailable())
    }
}

/// Ends the session's surface; its generation count goes with it. A session that was never placed is not an error.
#[tauri::command]
pub async fn native_terminal_surface_remove(app: AppHandle, session: String) -> Result<(), String> {
    validate_session(&session)?;
    #[cfg(target_os = "android")]
    {
        call::<()>(&app, "remove", serde_json::json!({ "session": session })).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

/// The session's surface as it is now.
#[tauri::command]
pub async fn native_terminal_surface_state(
    app: AppHandle,
    session: String,
) -> Result<SurfaceState, String> {
    validate_session(&session)?;
    #[cfg(target_os = "android")]
    {
        call(&app, "state", serde_json::json!({ "session": session })).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[cfg(not(target_os = "android"))]
fn unavailable() -> String {
    "The native terminal surface exists on Android only.".into()
}

/// The Kotlin plugin rejects with a stable code (`native_surface_*`); it is the only plugin text that reaches the page.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn rejection(text: &str) -> String {
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .find(|word| word.starts_with("native_surface_"))
        .map_or_else(
            || "The native terminal surface is unavailable.".to_owned(),
            str::to_owned,
        )
}

#[cfg(target_os = "android")]
async fn call<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    command: &str,
    args: serde_json::Value,
) -> Result<T, String> {
    app.state::<Surfaces>()
        .0
        .run_mobile_plugin_async(command, args)
        .await
        .map_err(|error| rejection(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_id_is_a_short_token() {
        assert!(validate_session("0b1c2d3e-4f50-6789-abcd-ef0123456789").is_ok());
        assert!(
            validate_session("a").is_ok() && validate_session(&"a".repeat(MAX_SESSION_LEN)).is_ok()
        );
        assert!(validate_session("").is_err());
        assert!(validate_session(&"a".repeat(MAX_SESSION_LEN + 1)).is_err());
        assert!(
            validate_session("a b").is_err()
                && validate_session("a/b").is_err()
                && validate_session("é").is_err()
        );
    }

    fn anchor(x: f64, y: f64, width: f64, height: f64, dpr: f64) -> Result<(), String> {
        Anchor {
            x,
            y,
            width,
            height,
            dpr,
        }
        .validate()
    }

    #[test]
    fn an_anchor_is_a_real_box_inside_what_a_gpu_holds() {
        assert!(anchor(0.0, 0.0, 411.0, 600.0, 2.625).is_ok());
        assert!(
            anchor(-40.0, -10.0, 100.0, 100.0, 1.0).is_ok(),
            "a partly scrolled-off pane starts above the page"
        );
        assert!(
            anchor(0.0, 0.0, 0.0, 10.0, 2.0).is_err() && anchor(0.0, 0.0, 10.0, -1.0, 2.0).is_err()
        );
        assert!(
            anchor(0.0, 0.0, 10.0, 10.0, 0.0).is_err()
                && anchor(0.0, 0.0, 10.0, 10.0, MAX_DPR + 0.5).is_err()
        );
        assert!(anchor(0.0, 0.0, 10.0, 10.0, MAX_DPR).is_ok());
        assert!(
            anchor(0.0, 0.0, 16_384.0, 10.0, 1.0).is_ok()
                && anchor(0.0, 0.0, 16_385.0, 10.0, 1.0).is_err()
        );
        assert!(
            anchor(0.0, 0.0, 5_000.0, 10.0, 4.0).is_err(),
            "pixels, not CSS pixels, are bounded"
        );
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(anchor(bad, 0.0, 10.0, 10.0, 2.0).is_err());
            assert!(anchor(0.0, 0.0, bad, 10.0, 2.0).is_err());
            assert!(anchor(0.0, 0.0, 10.0, 10.0, bad).is_err());
        }
        assert!(anchor(1e9, 0.0, 10.0, 10.0, 2.0).is_err());
    }

    #[test]
    fn the_anchor_is_read_from_the_pages_rect() {
        let parsed: Anchor = serde_json::from_value(
            serde_json::json!({"x": 1.5, "y": 2, "width": 300, "height": 200.25, "dpr": 2.625}),
        )
        .unwrap();
        assert_eq!(
            parsed,
            Anchor {
                x: 1.5,
                y: 2.0,
                width: 300.0,
                height: 200.25,
                dpr: 2.625
            }
        );
        assert!(
            serde_json::from_value::<Anchor>(
                serde_json::json!({"x": 1, "y": 2, "width": 3, "height": 4})
            )
            .is_err(),
            "a missing dpr is refused"
        );
    }

    #[test]
    fn only_the_plugins_stable_code_reaches_the_page() {
        assert_eq!(rejection("InvokeRejected(ErrorResponse { code: None, message: Some(\"native_surface_disabled\") })"), "native_surface_disabled");
        assert_eq!(rejection("native_surface_anchor"), "native_surface_anchor");
        assert_eq!(
            rejection("java.lang.IllegalStateException: surface at /data/user/0/app.lazysh.client"),
            "The native terminal surface is unavailable."
        );
    }

    #[test]
    fn a_locked_app_can_remove_a_surface_but_not_place_or_read_one() {
        use crate::app_lock::allowed_while_locked;
        assert!(allowed_while_locked("native_terminal_surface_remove"));
        for protected in [
            "native_terminal_surface_place",
            "native_terminal_surface_state",
        ] {
            assert!(!allowed_while_locked(protected), "{protected}");
        }
    }

    #[test]
    fn the_state_crosses_the_boundary_in_camel_case() {
        let state: SurfaceState = serde_json::from_value(serde_json::json!({
            "placed": true, "ready": true, "generation": 2, "width": 1080, "height": 640
        }))
        .unwrap();
        assert_eq!((state.generation, state.width), (2, 1080));
        assert_eq!(serde_json::to_value(&state).unwrap()["generation"], 2);
    }
}
