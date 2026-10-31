pub mod audio;
pub mod fs;
pub mod private_state;
pub mod record_checkpoint;
#[cfg(feature = "service")]
pub mod server;
#[cfg(feature = "secrets")]
pub mod service_secrets;
pub mod storage_filesystem;
pub mod storage_namespace;
#[cfg(feature = "test-support")]
pub mod test_support;

pub fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
}

#[macro_export]
macro_rules! impl_from_error {
    ($error:ty, $variant:ident, $source:ty) => {
        impl From<$source> for $error {
            fn from(error: $source) -> Self {
                Self::$variant(error)
            }
        }
    };
}

#[cfg(target_os = "ios")]
pub type IosHandle<T> = T;
#[cfg(not(target_os = "ios"))]
pub type IosHandle<T> = std::marker::PhantomData<fn() -> T>;

#[cfg(feature = "url")]
pub mod urls;

mod hex_digest;
pub use hex_digest::valid_sha256;

mod guarded_target;
pub use guarded_target::valid_guarded_target;

/// Exact public Herdr workspace, tab or pane identifier; no labels or aliases.
pub fn valid_herdr_id(value: &str, kind: Option<char>) -> bool {
    let mut parts = value.split(':');
    let valid = |part: &str, prefix| {
        part.starts_with(prefix)
            && part.len() > 1
            && part[1..]
                .bytes()
                .all(|byte| b"123456789ABCDEFGHJKMNPQRSTVWXYZ0".contains(&byte))
    };
    value.len() <= 50
        && valid(parts.next().unwrap_or(""), 'w')
        && match kind {
            None => parts.next().is_none(),
            Some(kind) => {
                parts.next().is_some_and(|part| valid(part, kind)) && parts.next().is_none()
            }
        }
}
