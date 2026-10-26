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

pub fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
