//! First-party configuration and deadline policy around the pinned quota collectors.
use ai_usagebar_core::{self as core, Config};
use std::{path::Path, time::Duration};
pub fn load_config(path: Option<&Path>) -> Result<Config, String> {
    load_config_with(path, core::has_local_credentials)
}
fn load_config_with(
    path: Option<&Path>,
    available: impl Fn(core::VendorId, &Config) -> bool,
) -> Result<Config, String> {
    let mut config = if let Some(path) = path {
        explicit_config(path)?
    } else {
        let defaults = Config::default();
        let mut value = toml::Value::try_from(&defaults)
            .map_err(|_| "Account usage availability is unavailable".to_string())?;
        for vendor in core::VendorId::all() {
            let table = value
                .get_mut(vendor.config_section())
                .and_then(toml::Value::as_table_mut)
                .ok_or("Account usage provider is unavailable")?;
            table.insert(
                "enabled".into(),
                toml::Value::Boolean(available(*vendor, &defaults)),
            );
        }
        value
            .try_into()
            .map_err(|_| "Account usage availability is unavailable".to_string())?
    };
    config.context.enabled = false;
    config.notifications.enabled = false;
    Ok(config)
}
fn explicit_config(path: &Path) -> Result<Config, String> {
    use std::io::Read;
    let file = std::fs::File::open(path)
        .map_err(|_| "Account usage configuration is unreadable".to_string())?;
    #[cfg(unix)]
    let metadata = file
        .metadata()
        .map_err(|_| "Account usage configuration permissions are unavailable".to_string())?;
    let mut data = String::new();
    file.take(1024 * 1024 + 1)
        .read_to_string(&mut data)
        .map_err(|_| "Account usage configuration is unreadable".to_string())?;
    if data.len() > 1024 * 1024 {
        return Err("Account usage configuration is too large".into());
    }
    let mut config: Config =
        toml::from_str(&data).map_err(|_| "Account usage configuration is invalid".to_string())?;
    config.expand_paths();
    config
        .validate()
        .map_err(|_| "Account usage configuration is invalid".to_string())?;
    #[cfg(unix)]
    if config.has_inline_secrets() {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(
                "Account usage configuration containing credentials must be private".into(),
            );
        }
    }
    core::register_secret_env_vars(&config.custom_secret_env_vars());
    core::register_secret_env_vars(&config.provider_secret_env_vars());
    Ok(config)
}
pub(crate) fn external_compatible(path: &Path) -> bool {
    explicit_config(path).is_ok_and(|config| {
        !config.context.enabled
            && !config.notifications.enabled
            && (cfg!(unix) || !config.has_inline_secrets())
    })
}
pub async fn collect_json(config: &Config, deadline: Duration) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(core::HTTP_CLIENT_TIMEOUT)
        .redirect(core::same_origin_redirect_policy())
        .build()
        .map_err(|_| "Account usage HTTP client unavailable")?;
    let targets = core::targets(config)?;
    let stop = tokio::time::Instant::now() + deadline.min(Duration::from_secs(18));
    let mut groups: Vec<(String, Vec<(usize, core::ReportTarget)>)> = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        let key = core::provider_key(target);
        if let Some((_, items)) = groups.iter_mut().find(|(name, _)| *name == key) {
            items.push((index, target.clone()));
        } else {
            groups.push((key, vec![(index, target.clone())]));
        }
    }
    let mut entries = targets
        .iter()
        .map(core::unavailable_entry)
        .collect::<Vec<_>>();
    let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let mut tasks = tokio::task::JoinSet::new();
    for (_, items) in groups {
        let config = config.clone();
        let client = client.clone();
        let slots = slots.clone();
        tasks.spawn(async move {
            let Ok(Ok(_permit)) = tokio::time::timeout_at(stop, slots.acquire_owned()).await else {
                return Vec::new();
            };
            let mut output = Vec::new();
            for (index, target) in items {
                let entry = if tokio::time::Instant::now() >= stop {
                    core::unavailable_entry(&target)
                } else {
                    tokio::time::timeout_at(stop, core::refresh_target(&client, &config, &target))
                        .await
                        .unwrap_or_else(|_| core::unavailable_entry(&target))
                };
                output.push((index, entry));
            }
            output
        });
    }
    while let Some(result) = tasks.join_next().await {
        if let Ok(output) = result {
            for (index, entry) in output {
                entries[index] = entry;
            }
        }
    }
    Ok(core::render_entries(config, &entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_config_enables_available_providers_in_memory_without_real_probes() {
        let config = load_config_with(None, |vendor, _| vendor == core::VendorId::Openai).unwrap();
        for vendor in core::VendorId::all() {
            assert_eq!(
                config.is_enabled(*vendor),
                *vendor == core::VendorId::Openai
            );
        }
        assert!(!config.context.enabled);
        assert!(!config.notifications.enabled);
    }
    #[test]
    fn explicit_config_preserves_disabled_providers_without_probing_or_writing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.toml");
        let input =
            "[openai]\nenabled = false\n[context]\nenabled=true\n[notifications]\nenabled=true\n";
        std::fs::write(&path, input).unwrap();
        let config = load_config_with(Some(&path), |_, _| {
            panic!("explicit configuration must not probe accounts")
        })
        .unwrap();
        assert!(!config.openai.enabled);
        assert!(!config.context.enabled);
        assert!(!config.notifications.enabled);
        assert_eq!(std::fs::read_to_string(path).unwrap(), input);
    }
    #[cfg(unix)]
    #[test]
    fn insecure_inline_credentials_are_refused_without_changing_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.toml");
        std::fs::write(&path, "[zai]\napi_key='fixture-only'\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_config_with(Some(&path), |_, _| false).is_err());
        assert_eq!(std::fs::metadata(path).unwrap().mode() & 0o777, 0o644);
    }
    #[test]
    fn malformed_and_oversize_configuration_errors_do_not_return_input() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.toml");
        std::fs::write(&path, "SUPER-PRIVATE-BROKEN-CONFIG=").unwrap();
        let error = load_config_with(Some(&path), |_, _| false).err().unwrap();
        assert!(!error.contains("SUPER-PRIVATE"));
        std::fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(load_config_with(Some(&path), |_, _| false).is_err());
    }
    #[tokio::test]
    async fn expired_collection_retains_entries_without_starting_authentication() {
        let config = load_config_with(None, |vendor, _| vendor == core::VendorId::Openai).unwrap();
        let report = collect_json(&config, Duration::ZERO).await.unwrap();
        let value: serde_json::Value = serde_json::from_str(&report).unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 1);
        assert_eq!(value["entries"][0]["id"], "openai");
        assert_eq!(value["entries"][0]["status"], "error");
        assert!(value["entries"][0]["sections"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
