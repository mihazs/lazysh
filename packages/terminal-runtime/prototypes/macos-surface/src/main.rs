//! Composition probe for #1333: a native surface (an `NSView` hosting a `CAMetalLayer`) below the transparent `WKWebView` that wry
//! builds for the app, inside wry's `WryWebViewParent`. It paints a solid colour and reads its own window back from the window
//! server (not what it believes it drew) at the display's scale. Not shipped; see docs/architecture/macos-surface-composition-poc.md.
//!
//! Environment: `POC_OUT` (directory for the step images and `records.jsonl`), `POC_SCALE` (1 or 2: switch the display to such a
//! mode first, exit 3 when there is none), `POC_TRANSPARENT=0` (the control: a web view without wry's `drawsBackground` key).
//! Exit status: 0 every check passed, 1 a check failed, 2 the probe could not measure, 3 the display has no such scale.

#[cfg(target_os = "macos")]
mod capture;
#[cfg(target_os = "macos")]
mod host;
#[cfg(target_os = "macos")]
mod probe;
#[cfg(target_os = "macos")]
mod surface;

#[cfg(target_os = "macos")]
fn main() {
    host::run()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("the macOS surface probe only runs on macOS");
    std::process::exit(2)
}
