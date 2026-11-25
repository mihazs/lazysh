//! The Win32 child surface below the app's transparent WebView2 (#1332).
use super::{panes::look, Anchor, SurfaceState};
use crate::native_renderer::{policy, Host, Look};
use lazysh_terminal_renderer_wgpu::{Target, Window};
use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, Win32WindowHandle, WindowsDisplayHandle,
};
use std::{
    cell::RefCell, collections::HashMap, io, num::NonZeroIsize, ptr::null_mut, sync::OnceLock,
};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::{
    Foundation::HWND,
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetWindowPos, HWND_BOTTOM,
        SWP_NOACTIVATE, WNDCLASSW, WS_CHILD, WS_VISIBLE,
    },
};

thread_local! {
    static PANES: RefCell<HashMap<String, Pane>> = RefCell::new(HashMap::new());
}

const CLASS: *const u16 = windows_sys::w!("LazyshNativeTerminalSurface");

fn win32_error() -> String {
    io::Error::last_os_error().to_string()
}

struct Child(HWND);

impl Child {
    fn new(parent: HWND) -> Result<Self, String> {
        static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
        REGISTERED
            .get_or_init(|| {
                // SAFETY: All fields either contain a static value or are zero-initialized handles.
                let class = WNDCLASSW {
                    lpfnWndProc: Some(DefWindowProcW),
                    hInstance: unsafe { GetModuleHandleW(std::ptr::null()) },
                    lpszClassName: CLASS,
                    ..unsafe { std::mem::zeroed() }
                };
                if unsafe { RegisterClassW(&class) } == 0 {
                    return Err(win32_error());
                }
                Ok(())
            })
            .clone()?;

        // SAFETY: The UI thread owns the live parent and the registered class is process-wide.
        // WS_CLIPSIBLINGS would clip the terminal by the web view occupying the same client area.
        let child = unsafe {
            CreateWindowExW(
                0,
                CLASS,
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                1,
                1,
                parent,
                null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        };
        if child.is_null() {
            return Err(win32_error());
        }
        Ok(Self(child))
    }

    fn position(&self, anchor: Anchor) -> Result<(u32, u32), String> {
        let (x, y, width, height) = pixels(anchor);
        // SAFETY: The child handle is live and this runs on its owner thread.
        if unsafe { SetWindowPos(self.0, HWND_BOTTOM, x, y, width, height, SWP_NOACTIVATE) } == 0 {
            return Err(win32_error());
        }
        Ok((width as u32, height as u32))
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        // SAFETY: The owner thread destroys its child once after the renderer has stopped.
        unsafe { DestroyWindow(self.0) };
    }
}

fn pixels(anchor: Anchor) -> (i32, i32, i32, i32) {
    let px = |css: f64| (css * anchor.dpr).round() as i32;
    let x = px(anchor.x);
    let y = px(anchor.y);
    (
        x,
        y,
        (px(anchor.x + anchor.width) - x).max(1),
        (px(anchor.y + anchor.height) - y).max(1),
    )
}

struct Pane {
    // Field drop order keeps the HWND live until the renderer has stopped.
    renderer: Host,
    child: Child,
    state: SurfaceState,
    look: Look,
    scale: f32,
    background: u32,
}

static DISPLAY: OnceLock<Result<(), String>> = OnceLock::new();

pub(crate) fn install(app: &tauri::App) {
    let _ = DISPLAY.set((|| {
        let window = app
            .get_webview_window("main")
            .ok_or("The app window is gone")?;
        window
            .as_ref()
            .set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)))
            .map_err(|error| error.to_string())?;
        window.on_window_event(|event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                PANES.with_borrow_mut(HashMap::clear);
            }
        });
        Ok(())
    })());
}

pub(crate) fn display() -> Result<(), String> {
    DISPLAY
        .get()
        .cloned()
        .unwrap_or_else(|| Err("The WebView2 surface is unavailable".into()))
}

async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&AppHandle, &mut HashMap<String, Pane>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (reply, answer) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = reply.send(PANES.with_borrow_mut(|panes| work(&handle, panes)));
    })
    .map_err(|error| error.to_string())?;
    answer.await.map_err(|error| error.to_string())?
}

pub(super) async fn place(
    app: &AppHandle,
    session: String,
    anchor: Anchor,
    background: u32,
) -> Result<SurfaceState, String> {
    display()?;
    on_main(app, move |app, panes| {
        let scale = anchor.dpr as f32;
        let wanted = look(&session, scale, background);
        if let Some(pane) = panes.get_mut(&session) {
            let (width, height) = pane.child.position(anchor)?;
            if (pane.state.width, pane.state.height) != (width, height) {
                pane.renderer.resize(width, height)?;
                (pane.state.width, pane.state.height) = (width, height);
            }
            if pane.look != wanted {
                pane.renderer.set_look(wanted.clone())?;
                pane.look = wanted;
            }
            (pane.scale, pane.background) = (scale, background);
            return Ok(pane.state.clone());
        }
        let (core, inbox) = crate::terminal_core::live(&session)
            .ok()
            .and_then(|core| core.drawing())
            .ok_or("The session has no native core to draw")?;
        let window = app
            .get_webview_window("main")
            .ok_or("The app window is gone")?;
        let parent = window.hwnd().map_err(|error| error.to_string())?.0;
        let child = Child::new(parent)?;
        let (width, height) = child.position(anchor)?;
        let hwnd =
            NonZeroIsize::new(child.0 as isize).ok_or("The terminal child window is gone")?;
        // SAFETY: The Pane drops the renderer before destroying its child window.
        let drawable = unsafe {
            Window::new(
                RawDisplayHandle::Windows(WindowsDisplayHandle::new()),
                RawWindowHandle::Win32(Win32WindowHandle::new(hwnd)),
            )
        };
        let mut policy = policy();
        // Direct3D 12 is the Windows policy’s first backend and the one with composition evidence.
        policy.backends.truncate(1);
        let target = Target::on_window(drawable, width, height).with_policy(policy);
        let renderer = Host::attach(core, inbox, target, 1, wanted.clone())?;
        let state = SurfaceState {
            placed: true,
            ready: true,
            generation: 1,
            width,
            height,
            ..SurfaceState::default()
        };
        panes.insert(
            session,
            Pane {
                renderer,
                child,
                state: state.clone(),
                look: wanted,
                scale,
                background,
            },
        );
        Ok(state)
    })
    .await
}

pub(super) async fn relook(app: &AppHandle, session: String) -> Result<(), String> {
    on_main(app, move |_, panes| {
        if let Some(pane) = panes.get_mut(&session) {
            let wanted = look(&session, pane.scale, pane.background);
            if pane.look != wanted {
                pane.renderer.set_look(wanted.clone())?;
                pane.look = wanted;
            }
        }
        Ok(())
    })
    .await
}

pub(super) async fn remove(app: &AppHandle, session: String) -> Result<(), String> {
    on_main(app, move |_, panes| {
        panes.remove(&session);
        Ok(())
    })
    .await
}

pub(super) async fn state(app: &AppHandle, session: String) -> Result<SurfaceState, String> {
    on_main(app, move |_, panes| {
        Ok(panes
            .get(&session)
            .map(|pane| pane.state.clone())
            .unwrap_or_default())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_edges_map_to_physical_client_pixels() {
        let anchor = Anchor {
            x: 60.4,
            y: -0.8,
            width: 150.4,
            height: 120.4,
            dpr: 1.25,
        };
        assert_eq!(pixels(anchor), (76, -1, 188, 151));
        assert_eq!(pixels(Anchor { dpr: 2.0, ..anchor }), (121, -2, 301, 241));
    }
}
