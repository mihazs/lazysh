use lazysh_common::{service_secrets, storage_namespace};
use std::path::Path;

pub(crate) fn validate_output_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let resolved =
        storage_namespace::resolve(parent).map_err(|_| "Unsafe capability output namespace")?;
    service_secrets::private(
        &std::fs::metadata(resolved).map_err(|_| "Cannot inspect capability output directory")?,
        true,
    )
}
