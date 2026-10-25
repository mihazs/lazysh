//! Official Mosh core for Linux, macOS, and Android; other targets expose no client.
pub const SUPPORTED: bool = cfg!(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "android"
));
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
mod native;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
pub use native::{Client, Error, Update};
