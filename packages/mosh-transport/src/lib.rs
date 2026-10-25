//! Official Mosh core for supported desktop targets; unsupported targets advertise no Mosh capability.
pub const SUPPORTED: bool = cfg!(any(target_os = "linux", target_os = "macos"));
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod native;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use native::{Client, Error, Update};
