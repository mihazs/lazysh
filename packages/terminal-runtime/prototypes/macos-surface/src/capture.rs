//! What the window server shows of the probe's own window, and the display mode it shows it in (1x or 2x).
use std::ffi::{c_char, c_void, CString};
use std::path::Path;

use objc2_foundation::{NSPoint, NSRect, NSSize};
use surface_analysis::{Layout, Raster};

type Capture = unsafe extern "C" fn(NSRect, u32, u32, u32) -> *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGImageGetWidth(image: *mut c_void) -> usize;
    fn CGImageGetHeight(image: *mut c_void) -> usize;
    fn CGImageGetBytesPerRow(image: *mut c_void) -> usize;
    fn CGImageGetBitsPerPixel(image: *mut c_void) -> usize;
    fn CGImageGetBitsPerComponent(image: *mut c_void) -> usize;
    fn CGImageGetBitmapInfo(image: *mut c_void) -> u32;
    fn CGImageGetDataProvider(image: *mut c_void) -> *mut c_void;
    fn CGDataProviderCopyData(provider: *mut c_void) -> *mut c_void;
    fn CGImageRelease(image: *mut c_void);
    fn CGMainDisplayID() -> u32;
    fn CGDisplayCopyDisplayMode(display: u32) -> *mut c_void;
    fn CGDisplayCopyAllDisplayModes(display: u32, options: *const c_void) -> *mut c_void;
    fn CGDisplayModeGetWidth(mode: *mut c_void) -> usize;
    fn CGDisplayModeGetHeight(mode: *mut c_void) -> usize;
    fn CGDisplayModeGetPixelWidth(mode: *mut c_void) -> usize;
    fn CGBeginDisplayConfiguration(config: *mut *mut c_void) -> i32;
    fn CGConfigureDisplayWithDisplayMode(
        config: *mut c_void,
        display: u32,
        mode: *mut c_void,
        options: *const c_void,
    ) -> i32;
    fn CGCompleteDisplayConfiguration(config: *mut c_void, option: u32) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDataGetLength(data: *mut c_void) -> isize;
    fn CFDataGetBytePtr(data: *mut c_void) -> *const u8;
    fn CFArrayGetCount(array: *mut c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *mut c_void, index: isize) -> *mut c_void;
    fn CFRelease(object: *mut c_void);
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

const LIST_OPTION_INCLUDING_WINDOW: u32 = 1 << 3;
const IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
const IMAGE_BEST_RESOLUTION: u32 = 1 << 3;
const CONFIGURE_FOR_SESSION: u32 = 1;
const RTLD_DEFAULT: isize = -2;

/// The window as the window server composited it: transparent where nothing is drawn, premultiplied RGBA. Tries
/// `CGWindowListCreateImage` (looked up at run time: Apple obsoleted it for new code in macOS 15) and then `screencapture`.
pub fn window_image(window: u32) -> Result<Raster, String> {
    static REPORTED: std::sync::Once = std::sync::Once::new();
    let (raster, method) = match capture_with_cg(window) {
        Ok(raster) => (raster, "CGWindowListCreateImage"),
        Err(cg) => {
            let tool = capture_with_tool(window)
                .map_err(|tool| format!("CGWindowListCreateImage: {cg}; screencapture: {tool}"))?;
            (tool, "screencapture")
        }
    };
    REPORTED.call_once(|| println!("INFO the window is captured with {method}"));
    Ok(raster)
}

fn capture_with_cg(window: u32) -> Result<Raster, String> {
    let symbol = CString::new("CGWindowListCreateImage").unwrap();
    let function = unsafe { dlsym(RTLD_DEFAULT as *mut c_void, symbol.as_ptr()) };
    if function.is_null() {
        return Err("the symbol is not in this system".into());
    }
    let capture: Capture = unsafe { std::mem::transmute(function) };
    // CGRectNull: the window's own bounds.
    let null = NSRect::new(
        NSPoint::new(f64::INFINITY, f64::INFINITY),
        NSSize::new(0.0, 0.0),
    );
    unsafe {
        let image = capture(
            null,
            LIST_OPTION_INCLUDING_WINDOW,
            window,
            IMAGE_BOUNDS_IGNORE_FRAMING | IMAGE_BEST_RESOLUTION,
        );
        if image.is_null() {
            return Err("returned no image".into());
        }
        let result = read_image(image);
        CGImageRelease(image);
        result
    }
}

unsafe fn read_image(image: *mut c_void) -> Result<Raster, String> {
    let (width, height) = (CGImageGetWidth(image), CGImageGetHeight(image));
    let info = CGImageGetBitmapInfo(image);
    let (bits, parts) = (
        CGImageGetBitsPerPixel(image),
        CGImageGetBitsPerComponent(image),
    );
    // Alpha info is the low five bits (1, 3, 5: alpha last; 2, 4, 6: alpha first); byte order 0x2000 is 32 bit little endian.
    let (order, alpha) = (info & 0x7000, info & 0x1f);
    let layout = match (order, alpha) {
        (0x2000, 2 | 4 | 6) => Layout::Bgra,
        (0 | 0x4000, 2 | 4 | 6) => Layout::Argb,
        (0 | 0x4000, 1 | 3 | 5) => Layout::Rgba,
        _ => return Err(format!("unsupported pixel format: bitmap info {info:#x}")),
    };
    if bits != 32 || parts != 8 {
        return Err(format!(
            "unsupported pixel size: {bits} bits per pixel, {parts} per component"
        ));
    }
    let data = CGDataProviderCopyData(CGImageGetDataProvider(image));
    if data.is_null() {
        return Err("the image has no data".into());
    }
    let bytes = std::slice::from_raw_parts(CFDataGetBytePtr(data), CFDataGetLength(data) as usize);
    let raster = Raster::from_capture(width, height, CGImageGetBytesPerRow(image), layout, bytes);
    CFRelease(data);
    raster.ok_or_else(|| format!("the data is shorter than a {width}x{height} image"))
}

fn capture_with_tool(window: u32) -> Result<Raster, String> {
    let path =
        std::env::temp_dir().join(format!("surface-poc-{}-{window}.png", std::process::id()));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-t", "png", "-l", &window.to_string()])
        .arg(&path)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("exit status {status}"));
    }
    let decoded = read_png(&path);
    let _ = std::fs::remove_file(&path);
    decoded
}

fn read_png(path: &Path) -> Result<Raster, String> {
    let mut reader = png::Decoder::new(std::fs::File::open(path).map_err(|e| e.to_string())?)
        .read_info()
        .map_err(|e| e.to_string())?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err(format!(
            "unexpected PNG format {:?} {:?}",
            info.color_type, info.bit_depth
        ));
    }
    Raster::from_capture(
        info.width as usize,
        info.height as usize,
        info.line_size,
        Layout::Rgba,
        &buffer,
    )
    .ok_or_else(|| "the PNG is shorter than its header says".into())
}

/// Writes a capture as a PNG (what the step looked like), for the job's artifact.
pub fn write_png(raster: &Raster, path: &Path) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut encoder = png::Encoder::new(file, raster.width as u32, raster.height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer
        .write_image_data(&raster.rgba)
        .map_err(|e| e.to_string())
}

/// A display's mode, which a probe run puts back when it ends.
pub struct Restore {
    display: u32,
    mode: *mut c_void,
}

fn scale_of(mode: *mut c_void) -> f64 {
    unsafe { CGDisplayModeGetPixelWidth(mode) as f64 / CGDisplayModeGetWidth(mode).max(1) as f64 }
}

pub fn main_display() -> u32 {
    unsafe { CGMainDisplayID() }
}

/// Switches a display to a mode with `want` device pixels per point (1 or 2) that is large enough for the probe window.
/// `Ok(None)` when the display already has that scale; `Err` says what the display offers instead.
pub fn switch_to_scale(display: u32, want: f64) -> Result<Option<Restore>, String> {
    unsafe {
        let current = CGDisplayCopyDisplayMode(display);
        if current.is_null() {
            println!("INFO display {display} has no current mode");
        } else {
            println!(
                "INFO display {display}: {}x{} points at {}x",
                CGDisplayModeGetWidth(current),
                CGDisplayModeGetHeight(current),
                scale_of(current)
            );
            if (scale_of(current) - want).abs() < 0.01 {
                return Ok(None);
            }
        }
        let all = CGDisplayCopyAllDisplayModes(display, std::ptr::null());
        let modes: Vec<*mut c_void> = if all.is_null() {
            Vec::new()
        } else {
            (0..CFArrayGetCount(all))
                .map(|i| CFArrayGetValueAtIndex(all, i))
                .collect()
        };
        let offered = |m: &*mut c_void| {
            format!(
                "{}x{} at {}x",
                CGDisplayModeGetWidth(*m),
                CGDisplayModeGetHeight(*m),
                scale_of(*m)
            )
        };
        let pick = modes
            .iter()
            .filter(|m| {
                (scale_of(**m) - want).abs() < 0.01
                    && CGDisplayModeGetWidth(**m) >= 800
                    && CGDisplayModeGetHeight(**m) >= 500
            })
            .max_by_key(|m| CGDisplayModeGetWidth(**m) * CGDisplayModeGetHeight(**m));
        let Some(&mode) = pick else {
            return Err(format!(
                "display {display} offers no {want}x mode of at least 800x500 points; its modes: {}",
                modes.iter().map(offered).collect::<Vec<_>>().join(", ")
            ));
        };
        set_mode(display, mode)?;
        Ok((!current.is_null()).then_some(Restore {
            display,
            mode: current,
        }))
    }
}

unsafe fn set_mode(display: u32, mode: *mut c_void) -> Result<(), String> {
    let mut config = std::ptr::null_mut();
    let begin = CGBeginDisplayConfiguration(&mut config);
    if begin != 0 {
        return Err(format!("CGBeginDisplayConfiguration failed with {begin}"));
    }
    let set = CGConfigureDisplayWithDisplayMode(config, display, mode, std::ptr::null());
    if set != 0 {
        return Err(format!(
            "CGConfigureDisplayWithDisplayMode failed with {set}"
        ));
    }
    match CGCompleteDisplayConfiguration(config, CONFIGURE_FOR_SESSION) {
        0 => Ok(()),
        code => Err(format!("CGCompleteDisplayConfiguration failed with {code}")),
    }
}

impl Drop for Restore {
    fn drop(&mut self) {
        unsafe {
            let _ = set_mode(self.display, self.mode);
        }
    }
}
