//! The two ways the probe reads its own window back: `PrintWindow` asks Windows to render the window's full content
//! (DirectComposition included) into a bitmap, and a screen copy reads what the desktop compositor put on screen.
use crate::pixels::Frame;
use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::{
        BitBlt, ClientToScreen, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
        GdiFlush, GetDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    },
    Storage::Xps::{PrintWindow, PW_CLIENTONLY},
    UI::WindowsAndMessaging::GetClientRect,
};

/// Windows 8.1 and later: render the window's DirectComposition content too (`PW_RENDERFULLCONTENT`, not in windows-sys).
const PW_RENDERFULLCONTENT: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Readback {
    PrintWindow,
    Screen,
}

/// The window's client area, which is also the coordinate space of the page and of the child windows.
pub fn client(hwnd: HWND, how: Readback) -> Result<Frame, String> {
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        let mut origin = POINT { x: 0, y: 0 };
        if GetClientRect(hwnd, &mut rect) == 0 || ClientToScreen(hwnd, &mut origin) == 0 {
            return Err("the window has no client area".into());
        }
        let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
        let screen = GetDC(null_mut());
        let dc = CreateCompatibleDC(screen);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits = null_mut();
        let bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        let previous = SelectObject(dc, bitmap);
        let copied = match how {
            Readback::PrintWindow => {
                PrintWindow(hwnd, dc, PW_CLIENTONLY | PW_RENDERFULLCONTENT) != 0
            }
            Readback::Screen => {
                BitBlt(
                    dc,
                    0,
                    0,
                    w,
                    h,
                    screen,
                    origin.x,
                    origin.y,
                    SRCCOPY | CAPTUREBLT,
                ) != 0
            }
        };
        GdiFlush();
        let frame = (copied && !bits.is_null()).then(|| Frame {
            w: w as usize,
            h: h as usize,
            bgra: std::slice::from_raw_parts(bits as *const u8, w as usize * h as usize * 4)
                .to_vec(),
        });
        SelectObject(dc, previous);
        DeleteObject(bitmap);
        DeleteDC(dc);
        ReleaseDC(null_mut(), screen);
        frame.ok_or_else(|| format!("{how:?} copied nothing"))
    }
}
