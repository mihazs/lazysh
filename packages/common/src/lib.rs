pub mod audio;
pub mod fs;
#[cfg(feature = "service")]
pub mod server;
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
