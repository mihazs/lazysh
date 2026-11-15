#[cfg(any(windows, test))]
pub(crate) use lazysh_common::storage_namespace::is_link;
pub(crate) use lazysh_common::storage_namespace::{create, resolve};
