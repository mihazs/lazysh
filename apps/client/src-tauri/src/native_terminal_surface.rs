//! The surface a native terminal draws on. On Android (#1327) the renderer places a session's `SurfaceView`
//! behind the transparent WebView at a DOM anchor and asks for its state; the Kotlin plugin owns the
//! surface and its lifecycle, Rust owns the session state and the renderer: with the `native-terminal` feature the
//! JNI entry points of [`android`] draw a session's core on the surface (`JniSurface.kt`); without it, or when no
//! GPU or core is there, the pane keeps its background. Developer-only: a release build refuses every command
//! (`native_surface_disabled`).
//! On Linux (#1331) the same three commands place a Wayland subsurface below the web view ([`linux`]), in a
//! build with the `native-terminal` feature only. Every other build has no surface.
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(all(target_os = "android", native_terminal_core))]
mod android;
#[cfg(all(target_os = "linux", native_terminal_core))]
pub(crate) mod linux;
#[cfg(all(target_os = "macos", native_terminal_core))]
mod macos;
#[cfg(native_terminal_core)]
pub(crate) mod panes;
#[cfg(all(target_os = "windows", native_terminal_core))]
mod windows;

#[cfg(all(any(target_os = "macos", target_os = "windows"), native_terminal_core))]
pub(crate) mod desktop;
#[cfg(all(any(target_os = "macos", target_os = "windows"), native_terminal_core))]
use desktop as desktop_platform;
#[cfg(all(target_os = "linux", native_terminal_core))]
use linux as desktop_platform;

#[cfg(not(target_os = "android"))]
macro_rules! desktop_surface {
    ($method:ident($($arg:expr),*), $fallback:expr) => {{
        #[cfg(all(any(target_os = "linux", target_os = "macos", target_os = "windows"), native_terminal_core))]
        { desktop_platform::$method($($arg),*).await }
        #[cfg(not(all(any(target_os = "linux", target_os = "macos", target_os = "windows"), native_terminal_core)))]
        { $fallback }
    }};
}

/// Longest session id the shell accepts; the renderer's ids are UUIDs, a local terminal's `local:` and a UUID.
const MAX_SESSION_LEN: usize = 64;
/// The largest texture side every GPU the app targets accepts, in pixels.
const MAX_PIXELS: f64 = 16_384.0;
/// A phone's ratio is 2 to 4; anything past this is a corrupt page, not a display.
const MAX_DPR: f64 = 8.0;
/// The preferences allow 10 to 32 CSS pixels; a renderer draws what a page could still ask for beyond that.
const MIN_FONT_PX: f64 = 4.0;
const MAX_FONT_PX: f64 = 128.0;
/// A CSS `font-family` list: a few names.
const MAX_FONT_FAMILY: usize = 1024;

/// A surface is refused on every platform by a build made with `LAZYSH_NATIVE_TERMINAL=off` (the kill switch, see `build.rs`).
fn ensure_enabled() -> Result<(), String> {
    if cfg!(native_terminal_disabled) {
        Err(crate::terminal_core::DISABLED_IN_BUILD.into())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "android")]
struct Surfaces(tauri::plugin::PluginHandle<tauri::Wry>);

/// What the shell knows about a session's surface. `generation` counts the surfaces the session has had
/// and is 0 until the first exists: it rises on every stop/start, never on a resize. `drawing` says whether the
/// renderer host drew on the surface that exists (`false`: the pane shows its background and nothing else) and `reason`
/// why not; both are absent where the host cannot tell (a platform with no renderer client, a surface not made yet).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceState {
    pub placed: bool,
    pub ready: bool,
    pub generation: u32,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drawing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'));
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

/// The cursor styles of the preferences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    Block,
    Underline,
    Bar,
}

#[cfg(native_terminal_core)]
impl CursorStyle {
    pub(crate) fn with_blink(self, blink: bool) -> lazysh_terminal_runtime::CursorDefault {
        use lazysh_terminal_runtime::{CursorDefault, CursorVisualStyle};
        let style = match self {
            Self::Bar => CursorVisualStyle::Bar,
            Self::Block => CursorVisualStyle::Block,
            Self::Underline => CursorVisualStyle::Underline,
        };
        CursorDefault { style, blink }
    }
}

/// How the renderer draws a session: the preferences that decide its colours, glyphs and cursor. The theme is the
/// client's `TerminalTheme`, as `terminal_core_theme` takes it, and `font_size` is in CSS pixels (what a pinch
/// changes); the cursor is the one a program that never chose its own has.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
// The look is read by the renderer's host, which only a build with the native terminal has.
#[cfg_attr(not(native_terminal_core), allow(dead_code))]
pub struct SurfaceLook {
    theme: serde_json::Value,
    font_family: String,
    font_size: f64,
    cursor_style: CursorStyle,
    cursor_blink: bool,
    bright_bold: bool,
    bold_color: Option<String>,
}

impl SurfaceLook {
    /// A readable font size and a short family list without control characters: what a renderer can draw and a
    /// page cannot use to make the host do work. The theme and the colours are checked where they are read.
    fn validate(&self) -> Result<(), String> {
        let family = !self.font_family.trim().is_empty()
            && self.font_family.len() <= MAX_FONT_FAMILY
            && !self.font_family.chars().any(char::is_control);
        let size =
            self.font_size.is_finite() && (MIN_FONT_PX..=MAX_FONT_PX).contains(&self.font_size);
        if family && size {
            Ok(())
        } else {
            Err("Invalid terminal look.".into())
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
    ensure_enabled()?;
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
    desktop_surface!(place(&app, session, anchor, background), {
        let _ = app;
        Err(unavailable())
    })
}

/// Tells the renderer how the session looks (the preferences the page applies): from its next surface on, and
/// at once on one that is drawing. Kept by the shell, so it may come before the surface exists.
#[tauri::command]
pub async fn native_terminal_surface_look(
    app: AppHandle,
    session: String,
    look: SurfaceLook,
) -> Result<(), String> {
    ensure_enabled()?;
    validate_session(&session)?;
    look.validate()?;
    #[cfg(native_terminal_core)]
    {
        panes::remember(&session, &look)?;
        relook(&app, session).await
    }
    #[cfg(not(native_terminal_core))]
    {
        let _ = app;
        Err("This build has no native terminal surface.".into())
    }
}

/// The surface the platform drew `session` on takes the look just remembered; none is not an error.
#[cfg(all(target_os = "android", native_terminal_core))]
async fn relook(_: &AppHandle, session: String) -> Result<(), String> {
    android::relook(&session)
}

#[cfg(all(target_os = "linux", native_terminal_core))]
async fn relook(app: &AppHandle, session: String) -> Result<(), String> {
    linux::relook(app, session).await
}

#[cfg(all(any(target_os = "macos", target_os = "windows"), native_terminal_core))]
async fn relook(app: &AppHandle, session: String) -> Result<(), String> {
    desktop::relook(app, session).await
}

#[cfg(all(
    native_terminal_core,
    not(any(
        target_os = "android",
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    ))
))]
async fn relook(_: &AppHandle, _: String) -> Result<(), String> {
    Err(unavailable())
}

/// One cell of the renderer's grid, in device pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CellSize {
    width: u32,
    height: u32,
}

/// A font size a renderer can draw and a ratio a display can have; NaN is neither.
fn cell_request_is_sane(font_size: f64, dpr: f64) -> bool {
    (MIN_FONT_PX..=MAX_FONT_PX).contains(&font_size) && dpr > 0.0 && dpr <= MAX_DPR
}

/// The cell the renderer draws for a font size in CSS pixels on a display of `dpr` device pixels per CSS pixel, so
/// the page can tell how many columns and rows a pane holds (#2397). It answers from the renderer's own rule and
/// reads nothing of a session; a build without the native terminal has no renderer to ask.
#[tauri::command]
pub async fn native_terminal_surface_cell(font_size: f64, dpr: f64) -> Result<CellSize, String> {
    ensure_enabled()?;
    if !cell_request_is_sane(font_size, dpr) {
        return Err("Invalid terminal cell request.".into());
    }
    #[cfg(native_terminal_core)]
    {
        let cell = crate::native_renderer::cell_metrics(font_size as f32, dpr as f32)
            .map_err(|error| error.to_string())?;
        Ok(CellSize {
            width: cell.cell_width,
            height: cell.cell_height,
        })
    }
    #[cfg(not(native_terminal_core))]
    {
        Err("This build has no native terminal surface.".into())
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
    desktop_surface!(remove(&app, session), {
        let _ = app;
        Ok(())
    })
}

/// The session's surface as it is now.
#[tauri::command]
pub async fn native_terminal_surface_state(
    app: AppHandle,
    session: String,
) -> Result<SurfaceState, String> {
    ensure_enabled()?;
    validate_session(&session)?;
    #[cfg(target_os = "android")]
    {
        call(&app, "state", serde_json::json!({ "session": session })).await
    }
    #[cfg(not(target_os = "android"))]
    desktop_surface!(state(&app, session), {
        let _ = app;
        Err(unavailable())
    })
}

/// What the surface's keyboard editor delivered since the last call, once and in order: committed text, keys (as the core takes them)
/// and the composing text to draw at the cursor. Waits until there is something. The page forwards it to the core under its own
/// lease, so a locked app is refused here (the command is not allowed while locked) and a replaced renderer's keys are refused there.
#[tauri::command]
pub async fn native_terminal_surface_input(
    app: AppHandle,
    session: String,
) -> Result<serde_json::Value, String> {
    validate_session(&session)?;
    #[cfg(target_os = "android")]
    {
        call(&app, "input", serde_json::json!({ "session": session })).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("This build has no native terminal input.".into())
    }
}

/// Gives the session's keyboard editor focus and opens the soft keyboard, or takes both away.
#[tauri::command]
pub async fn native_terminal_surface_focus(
    app: AppHandle,
    session: String,
    focused: bool,
    keyboard: Option<bool>,
    if_idle: Option<bool>,
) -> Result<(), String> {
    validate_session(&session)?;
    #[cfg(target_os = "android")]
    {
        call::<()>(
            &app,
            "focus",
            serde_json::json!({ "session": session, "focused": focused, "keyboard": keyboard.unwrap_or(true), "ifIdle": if_idle.unwrap_or(false) }),
        )
        .await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, focused, keyboard, if_idle);
        Err("This build has no native terminal input.".into())
    }
}

#[cfg(not(any(
    target_os = "android",
    all(
        any(target_os = "linux", target_os = "macos", target_os = "windows"),
        native_terminal_core
    )
)))]
fn unavailable() -> String {
    "This build has no native terminal surface.".into()
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
        // A local terminal's id, which is the core's key in the registry.
        assert!(validate_session("local:0b1c2d3e-4f50-6789-abcd-ef0123456789").is_ok());
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

    fn page_look(extra: serde_json::Value) -> Result<SurfaceLook, serde_json::Error> {
        let mut look = serde_json::json!({
            "theme": {}, "fontFamily": "monospace", "fontSize": 14, "cursorStyle": "bar",
            "cursorBlink": true, "brightBold": false,
        });
        look.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(look)
    }

    #[test]
    fn the_look_is_read_from_the_pages_preferences_and_only_a_drawable_one_passes() {
        let look =
            page_look(serde_json::json!({"boldColor": "#336699", "cursorStyle": "underline"}))
                .unwrap();
        assert_eq!(
            (
                look.cursor_style,
                look.font_size,
                look.bold_color.as_deref()
            ),
            (CursorStyle::Underline, 14.0, Some("#336699"))
        );
        assert!(look.validate().is_ok());
        for size in [MIN_FONT_PX, 10.0, 32.0, MAX_FONT_PX] {
            assert!(
                page_look(serde_json::json!({"fontSize": size}))
                    .unwrap()
                    .validate()
                    .is_ok(),
                "{size}"
            );
        }
        let long = "a".repeat(MAX_FONT_FAMILY + 1);
        for bad in [
            serde_json::json!({"fontSize": MIN_FONT_PX - 0.5}),
            serde_json::json!({"fontSize": MAX_FONT_PX + 1.0}),
            serde_json::json!({"fontSize": 0}),
            serde_json::json!({"fontSize": -14}),
            serde_json::json!({"fontFamily": ""}),
            serde_json::json!({"fontFamily": "  "}),
            serde_json::json!({"fontFamily": long}),
            serde_json::json!({"fontFamily": "mono\nspace"}),
        ] {
            assert!(page_look(bad.clone()).unwrap().validate().is_err(), "{bad}");
        }
        // A size no JSON can hold as a finite number never reaches the check.
        assert!(page_look(serde_json::json!({"fontSize": "14"})).is_err());
        let wrong = [
            serde_json::json!({"cursorStyle": "hollow"}),
            serde_json::json!({"theme": null, "cursorBlink": "yes"}),
        ];
        for bad in wrong {
            assert!(page_look(bad).is_err());
        }
        assert!(
            serde_json::from_value::<SurfaceLook>(
                serde_json::json!({"theme": {}, "fontFamily": "m", "fontSize": 14})
            )
            .is_err(),
            "a look without its cursor and bold preferences is refused"
        );
    }

    #[test]
    fn a_cell_is_asked_for_a_font_and_a_display_that_can_exist() {
        assert!(cell_request_is_sane(14.0, 2.625) && cell_request_is_sane(MIN_FONT_PX, 1.0));
        assert!(cell_request_is_sane(MAX_FONT_PX, MAX_DPR));
        for (size, dpr) in [
            (0.0, 1.0),
            (MIN_FONT_PX - 0.5, 1.0),
            (MAX_FONT_PX + 1.0, 1.0),
            (14.0, 0.0),
            (14.0, -1.0),
            (14.0, MAX_DPR + 0.5),
            (f64::NAN, 1.0),
            (14.0, f64::NAN),
            (f64::INFINITY, 1.0),
            (14.0, f64::INFINITY),
        ] {
            assert!(!cell_request_is_sane(size, dpr), "{size} at {dpr}");
        }
    }

    #[test]
    fn a_cell_crosses_the_boundary_as_its_width_and_height() {
        let cell = serde_json::to_value(CellSize {
            width: 22,
            height: 44,
        })
        .unwrap();
        assert_eq!(cell, serde_json::json!({"width": 22, "height": 44}));
    }

    #[cfg(native_terminal_disabled)]
    #[test]
    fn the_surface_is_refused_disabled_in_this_build() {
        assert_eq!(
            ensure_enabled(),
            Err("The native terminal is disabled in this build".into())
        );
    }

    #[cfg(not(native_terminal_disabled))]
    #[test]
    fn the_surface_is_not_refused_without_the_kill_switch() {
        assert_eq!(ensure_enabled(), Ok(()));
    }

    #[test]
    fn only_the_plugins_stable_code_reaches_the_page() {
        assert_eq!(
            rejection(
                "InvokeRejected(ErrorResponse { code: None, message: Some(\"native_surface_disabled\") })"
            ),
            "native_surface_disabled"
        );
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
            "native_terminal_surface_look",
            "native_terminal_surface_cell",
            "native_terminal_surface_state",
            "native_terminal_surface_input",
            "native_terminal_surface_focus",
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
        // Whether the renderer drew, and why not, reach the page when the plugin says; a shell that cannot tell leaves both out.
        assert_eq!((state.drawing, state.reason.as_deref()), (None, None));
        assert!(serde_json::to_value(&state)
            .unwrap()
            .get("drawing")
            .is_none());
        let refused: SurfaceState = serde_json::from_value(serde_json::json!({
            "placed": true, "ready": true, "generation": 1, "width": 10, "height": 10,
            "drawing": false, "reason": "no adapter could create a device"
        }))
        .unwrap();
        let sent = serde_json::to_value(&refused).unwrap();
        assert_eq!(
            (sent["drawing"].as_bool(), sent["reason"].as_str()),
            (Some(false), Some("no adapter could create a device"))
        );
    }
}
