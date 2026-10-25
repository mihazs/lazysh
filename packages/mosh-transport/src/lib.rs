//! Official Mosh core for Linux, macOS, Android, and iOS; other targets expose no client.
pub const SUPPORTED: bool = cfg!(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "android",
    target_os = "ios"
));
#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "android",
    target_os = "ios"
))]
mod native;
#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "android",
    target_os = "ios"
))]
pub use native::{Client, Error, Update};
