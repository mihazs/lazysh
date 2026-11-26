//! The Win32 child surface below the app's transparent WebView2 (#1332).
use super::desktop::{display, drawing, on_main, Pane, PANES};
use super::{panes::look, Anchor, SurfaceState};
use crate::native_renderer::{policy, Host};
use lazysh_terminal_renderer_wgpu::{Target, Window};
use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, Win32WindowHandle, WindowsDisplayHandle,
};
use std::{io, num::NonZeroIsize, ptr::null_mut, sync::OnceLock};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::{
    Foundation::HWND,
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetWindowPos, HWND_BOTTOM,
        SWP_NOACTIVATE, WNDCLASSW, WS_CHILD, WS_VISIBLE,
    },
};

const CLASS: *const u16 = windows_sys::w!("LazyshNativeTerminalSurface");

fn win32_error() -> String {
    io::Error::last_os_error().to_string()
}

pub(super) struct Surface(HWND);

impl Surface {
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

impl Drop for Surface {
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

pub(super) const DISPLAY_UNAVAILABLE: &str = "The WebView2 surface is unavailable";

pub(crate) async fn place(
    app: &AppHandle,
    session: String,
    anchor: Anchor,
    background: u32,
) -> Result<SurfaceState, String> {
    display()?;
    let handle = app.clone();
    on_main(app, move || {
        PANES.with_borrow_mut(|panes| {
            let scale = anchor.dpr as f32;
            let wanted = look(&session, scale, background);
            if let Some(pane) = panes.get_mut(&session) {
                let (width, height) = pane.surface.position(anchor)?;
                return pane.update(width, height, wanted, anchor, background);
            }
            let (core, inbox) = drawing(&session)?;
            let window = handle
                .get_webview_window("main")
                .ok_or("The app window is gone")?;
            let parent = window.hwnd().map_err(|error| error.to_string())?.0;
            let child = Surface::new(parent)?;
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
            let pane = Pane::new(renderer, child, width, height, wanted, anchor, background);
            let state = pane.state();
            panes.insert(session, pane);
            Ok(state)
        })
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
