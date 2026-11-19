//! The surface under test: a child window of the app's window, painted by GDI or presented by a Direct3D 12 swapchain,
//! stacked below the web view or above it with the page's overlay cut out of it.
use crate::{gpu::Swapchain, pixels::Rect};
use std::{
    ptr::{null, null_mut},
    sync::atomic::{AtomicU32, Ordering},
};
use windows_sys::Win32::{
    Foundation::HWND,
    Graphics::Gdi::{
        CombineRgn, CreateRectRgn, CreateSolidBrush, DeleteObject, SetWindowRgn, RGN_DIFF,
    },
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetWindowPos, HWND_BOTTOM,
        HWND_TOP, SWP_NOACTIVATE, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
    },
};

#[derive(Clone, Copy, Debug)]
pub enum Order {
    /// Below the web view, the way the Linux and Android surfaces sit: the transparent page must show it.
    Below,
    /// The same, with `WS_CLIPSIBLINGS`, which makes Windows clip the surface by the web view's window above it.
    BelowClipped,
    /// Above the web view, with the overlay's rectangle cut out of the surface by `SetWindowRgn`.
    AboveCutOut,
}

#[derive(Clone, Copy, Debug)]
pub enum Paint {
    /// The window class's background brush: GDI writes no alpha.
    Gdi,
    /// A flip-model swapchain, which is what the wgpu renderer presents with.
    Direct3D12,
}

pub struct Child {
    // The swapchain goes before the window it presents to.
    swapchain: Option<Swapchain>,
    hwnd: HWND,
    order: Order,
    colour: [u8; 3],
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

impl Child {
    pub fn new(parent: HWND, order: Order, paint: Paint, colour: [u8; 3]) -> Result<Self, String> {
        static SERIAL: AtomicU32 = AtomicU32::new(0);
        let class_name = wide(&format!(
            "lazysh-surface-poc-{}",
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let [r, g, b] = colour.map(u32::from);
        let mut style = WS_CHILD | WS_VISIBLE;
        if !matches!(order, Order::Below) {
            style |= WS_CLIPSIBLINGS;
        }
        let hwnd = unsafe {
            let class = WNDCLASSW {
                lpfnWndProc: Some(DefWindowProcW),
                hInstance: GetModuleHandleW(null()),
                hbrBackground: if matches!(paint, Paint::Gdi) {
                    CreateSolidBrush(r | g << 8 | b << 16)
                } else {
                    null_mut()
                },
                lpszClassName: class_name.as_ptr(),
                ..std::mem::zeroed()
            };
            if RegisterClassW(&class) == 0 {
                return Err("RegisterClassW failed".into());
            }
            CreateWindowExW(
                0,
                class_name.as_ptr(),
                null(),
                style,
                0,
                0,
                1,
                1,
                parent,
                null_mut(),
                class.hInstance,
                null(),
            )
        };
        if hwnd.is_null() {
            return Err("CreateWindowExW failed".into());
        }
        let swapchain = matches!(paint, Paint::Direct3D12).then(|| Swapchain::new(hwnd as isize));
        let mut child = Self {
            swapchain: None,
            hwnd,
            order,
            colour,
        };
        child.swapchain = swapchain.transpose()?;
        Ok(child)
    }

    pub fn adapter(&self) -> Option<&str> {
        self.swapchain.as_ref().map(|s| s.adapter.as_str())
    }

    /// Puts the surface at the anchor, in the web view's coordinates (it fills the parent's client area), and below or above the web view.
    pub fn place(&mut self, anchor: Rect, overlay: Rect) -> Result<(), String> {
        let above = matches!(self.order, Order::AboveCutOut);
        unsafe {
            if SetWindowPos(
                self.hwnd,
                if above { HWND_TOP } else { HWND_BOTTOM },
                anchor.x,
                anchor.y,
                anchor.w,
                anchor.h,
                SWP_NOACTIVATE,
            ) == 0
            {
                return Err("SetWindowPos failed".into());
            }
            if above {
                // Window coordinates: the surface minus the overlay. The window owns the region it is given.
                let (x, y) = (overlay.x - anchor.x, overlay.y - anchor.y);
                let (whole, hole) = (
                    CreateRectRgn(0, 0, anchor.w, anchor.h),
                    CreateRectRgn(x, y, x + overlay.w, y + overlay.h),
                );
                CombineRgn(whole, whole, hole, RGN_DIFF);
                DeleteObject(hole);
                SetWindowRgn(self.hwnd, whole, 1);
            }
        }
        self.swapchain
            .as_mut()
            .map_or(Ok(()), |s| s.present(anchor.w, anchor.h, self.colour))
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        self.swapchain = None;
        unsafe { DestroyWindow(self.hwnd) };
    }
}
