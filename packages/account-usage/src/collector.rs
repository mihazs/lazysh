//! First-party configuration and deadline policy around the pinned quota collectors.
use ai_usagebar_core::{self as core, Config};
use std::{path::Path, time::Duration};
pub fn load_config(path: Option<&Path>) -> Result<Config, String> {
    let codex_home = std::env::var_os("CODEX_HOME");
    load_config_with(path, codex_home.as_deref(), core::has_local_credentials)
}
fn load_config_with(
    path: Option<&Path>,
    codex_home: Option<&std::ffi::OsStr>,
    available: impl Fn(core::VendorId, &Config) -> bool,
) -> Result<Config, String> {
    let mut config = if let Some(path) = path {
        explicit_config(path)?
    } else {
        let defaults = automatic_config(codex_home)?;
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
fn automatic_config(codex_home: Option<&std::ffi::OsStr>) -> Result<Config, String> {
    let mut config = Config::default();
    if let Some(home) =
        codex_home.filter(|value| value.to_str().is_none_or(|text| !text.trim().is_empty()))
    {
        let invalid = || "Account usage Codex home is invalid".to_string();
        let text = home.to_str().ok_or_else(invalid)?;
        let path = Path::new(text);
        let auth = path.join("auth.json");
        if !path.is_absolute()
            || auth.as_os_str().len() > 4096
            || text.chars().any(char::is_control)
            || text
                .split(['/', '\\'])
                .any(|part| matches!(part, "." | ".."))
        {
            return Err(invalid());
        }
        config.openai.codex_auth_path = Some(auth);
    }
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
        let config =
            load_config_with(None, None, |vendor, _| vendor == core::VendorId::Openai).unwrap();
        for vendor in core::VendorId::all() {
            assert_eq!(
                config.is_enabled(*vendor),
                *vendor == core::VendorId::Openai
            );
        }
        assert!(!config.context.enabled);
        assert!(!config.notifications.enabled);
    }
    #[tokio::test]
    async fn automatic_codex_home_uses_owned_auth_for_detection_and_target_without_network() {
        let directory = tempfile::tempdir().unwrap();
        let auth = directory.path().join("auth.json");
        let input = br#"{"tokens":{"access_token":"owned-fixture-access","refresh_token":"owned-fixture-refresh","id_token":"owned-fixture-id"}}"#;
        std::fs::write(&auth, input).unwrap();
        let config = load_config_with(
            None,
            Some(directory.path().as_os_str()),
            |vendor, config| {
                if vendor != core::VendorId::Openai {
                    return false;
                }
                assert!(
                    config.openai.resolve_auth_path(None).unwrap() == auth,
                    "automatic availability must inspect the selected Codex home"
                );
                core::has_local_credentials(vendor, config)
            },
        )
        .unwrap();
        assert!(
            config.openai.enabled,
            "owned Codex credentials must enable automatic account discovery"
        );
        assert!(
            config.openai.fetch_auth_path(None).unwrap() == auth,
            "quota fetch and discovery must resolve the same owned auth file"
        );
        let json = collect_json(&config, Duration::ZERO).await.unwrap();
        let report = crate::normalize(json.as_bytes(), "builtin");
        assert_eq!(report.state, "ready");
        let entries = &report.report.unwrap().entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "openai");
        assert_eq!(
            entries[0].status, "error",
            "zero deadline does not establish provider quota acceptance"
        );
        assert_eq!(std::fs::read(&auth).unwrap(), input);
        assert!(!json.contains("owned-fixture"));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    #[test]
    #[ignore = "private owned subprocess selected only by its fixture"]
    fn owned_cline_store_probe() {
        assert_eq!(
            std::env::var("LAZYSH_OWNED_CLINE_PROBE").as_deref(),
            Ok("1")
        );
        let mut config = Config::default();
        config.cline.api_key_env.clear();
        if let Some(path) = std::env::var_os("LAZYSH_OWNED_CLINE_AUTH_PATH") {
            config.cline.auth_paths = Some(vec![path.into()]);
        }
        if std::env::var_os("LAZYSH_OWNED_CLINE_INLINE_KEY").is_some() {
            config.cline.api_key = Some("owned-inline-fixture".into());
        }
        let available = core::has_local_credentials(core::VendorId::Cline, &config);
        assert_eq!(
            available,
            std::env::var("LAZYSH_OWNED_CLINE_EXPECTED").as_deref() == Ok("present"),
            "Cline availability must follow its selected credential store"
        );
        #[cfg(target_os = "linux")]
        if std::env::var_os("LAZYSH_OWNED_CLINE_CACHE").is_some() {
            let mut only =
                load_config_with(None, |vendor, _| vendor == core::VendorId::Cline).unwrap();
            only.cline = config.cline.clone();
            only.cline.enabled = true;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let json = runtime
                .block_on(collect_json(&only, Duration::from_secs(1)))
                .unwrap();
            runtime.shutdown_background();
            let response =
                serde_json::to_value(crate::normalize(json.as_bytes(), "builtin")).unwrap();
            let entry = &response["report"]["entries"][0];
            assert_eq!(entry["id"], "cline");
            assert_eq!(
                entry["stale"], true,
                "expired synthetic tokens can only serve stale owned cache"
            );
            assert!(entry["rows"].as_array().unwrap().iter().any(|row|row["percent"]==37.0),"the selected Cline account must retain its own cached quota when a foreign token is newer");
            assert!(!json.contains("owned-cline-cache-token"));
            assert!(!json.contains("owned-foreign-fake-token"));
        }
        if let Some(path) = std::env::var_os("LAZYSH_OWNED_CLINE_SCHEMA") {
            let path = std::path::PathBuf::from(path);
            let corpus: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let steps = corpus["steps"].as_array().unwrap();
            assert_eq!(steps.len(), corpus["caseCount"].as_u64().unwrap() as usize);
            assert!(!steps.is_empty());
            let target = path.with_file_name("schema-current.json");
            config.cline.auth_paths = Some(vec![target.clone()]);
            config.cline.api_key = None;
            for (index, step) in steps.iter().enumerate() {
                let mut input = corpus["baseline"].clone();
                let parts = step["path"].as_array().unwrap();
                let mut parent = &mut input;
                for key in &parts[..parts.len() - 1] {
                    parent = parent.get_mut(key.as_str().unwrap()).unwrap();
                }
                let key = parts.last().unwrap().as_str().unwrap();
                if step["remove"] == true {
                    parent.as_object_mut().unwrap().remove(key);
                } else {
                    parent[key] = step["value"].clone();
                }
                std::fs::write(&target, serde_json::to_vec(&input).unwrap()).unwrap();
                let actual = core::has_local_credentials(core::VendorId::Cline, &config);
                if actual != step["valid"].as_bool().unwrap() {
                    std::fs::write(
                        std::env::var_os("LAZYSH_OWNED_CLINE_RECEIPT").unwrap(),
                        format!("schema-case:{index}"),
                    )
                    .unwrap();
                    panic!("owned Cline schema differential disagreement");
                }
            }
            std::fs::write(path.with_file_name("schema.count"), steps.len().to_string()).unwrap();
        }
        std::fs::write(
            std::env::var_os("LAZYSH_OWNED_CLINE_RECEIPT").expect("owned completion receipt"),
            if available { "present" } else { "missing" },
        )
        .unwrap();
    }
    #[tokio::test]
    async fn selected_cline_stores_preserve_cli_precedence_without_network_or_alternate_fallback() {
        use std::{ffi::OsString, process::Stdio};
        for (case, default_valid, overrides, expected) in [
            (
                "oversized-store",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@large-store")],
                false,
            ),
            (
                "regular-symlink",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@store-link")],
                cfg!(unix),
            ),
            (
                "fifo-store",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@store-fifo")],
                false,
            ),
            (
                "schema-differential",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@current"),
                    ("LAZYSH_OWNED_CLINE_SCHEMA", "@schema-corpus"),
                ],
                true,
            ),
            (
                "cache-canonical-over-legacy",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@canonical-over-legacy"),
                    ("LAZYSH_OWNED_CLINE_CACHE", "1"),
                ],
                true,
            ),
            (
                "cache-selected-legacy-over-canonical",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@selected-legacy"),
                    ("LAZYSH_OWNED_CLINE_CACHE", "1"),
                ],
                true,
            ),
            (
                "cache-pass-inherits-canonical",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@pass-inherits"),
                    ("LAZYSH_OWNED_CLINE_CACHE", "1"),
                ],
                true,
            ),
            (
                "cache-last-used-foreign-defaults-canonical",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@last-used-foreign"),
                    ("LAZYSH_OWNED_CLINE_CACHE", "1"),
                ],
                true,
            ),
            (
                "canonical-invalid-no-fallback",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@canonical-invalid")],
                false,
            ),
            (
                "selected-pass-invalid-no-fallback",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@pass-invalid")],
                false,
            ),
            (
                "legacy-only-without-selection",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@legacy-unselected")],
                false,
            ),
            (
                "missing-version",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@missing-version")],
                false,
            ),
            (
                "unsupported-version",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@unsupported-version")],
                false,
            ),
            (
                "missing-updated",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@missing-updated")],
                false,
            ),
            (
                "invalid-updated",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@invalid-updated")],
                false,
            ),
            (
                "missing-provider",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@missing-provider")],
                false,
            ),
            (
                "invalid-token-source",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@invalid-token-source")],
                false,
            ),
            (
                "invalid-expiry",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@invalid-expiry")],
                false,
            ),
            (
                "invalid-last-used",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@invalid-last-used")],
                false,
            ),
            (
                "invalid-modes",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@invalid-modes")],
                false,
            ),
            (
                "invalid-voice-mode",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@invalid-voice-mode")],
                false,
            ),
            (
                "invalid-repairs",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@invalid-repairs")],
                false,
            ),
            (
                "cache-control",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@current"),
                    ("LAZYSH_OWNED_CLINE_CACHE", "1"),
                ],
                true,
            ),
            (
                "mixed-cache",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@mixed"),
                    ("LAZYSH_OWNED_CLINE_CACHE", "1"),
                ],
                true,
            ),
            (
                "foreign-only",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@foreign")],
                false,
            ),
            (
                "other-foreign",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@other")],
                false,
            ),
            (
                "invalid-cline-with-foreign",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@invalid-cline")],
                false,
            ),
            (
                "mismatched-settings",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@mismatched")],
                false,
            ),
            (
                "legacy-cline-pass",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@legacy")],
                true,
            ),
            (
                "current-with-foreign",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@mixed")],
                true,
            ),
            ("profile", false, vec![("CLINE_DIR", "@profile")], true),
            (
                "data",
                false,
                vec![("CLINE_DATA_DIR", "@data"), ("CLINE_DIR", "missing")],
                true,
            ),
            (
                "file",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@file"),
                    ("CLINE_DATA_DIR", "missing"),
                    ("CLINE_DIR", "missing"),
                ],
                true,
            ),
            (
                "missing-selected",
                true,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "missing")],
                false,
            ),
            (
                "malformed-selected",
                true,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@malformed")],
                false,
            ),
            (
                "js-whitespace",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", " \u{feff}\t "),
                    ("CLINE_DATA_DIR", "@trimmed-data"),
                ],
                true,
            ),
            (
                "nel-is-not-js-whitespace",
                true,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@nel-file")],
                false,
            ),
            (
                "relative-selected",
                false,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "relative/providers.json")],
                true,
            ),
            ("blank-default", true, vec![("CLINE_DIR", "  ")], true),
            (
                "canonical-environment-path",
                true,
                vec![("CLINE_PROVIDER_SETTINGS_PATH", "@default")],
                true,
            ),
            (
                "explicit-path",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@oversized"),
                    ("LAZYSH_OWNED_CLINE_AUTH_PATH", "@file"),
                ],
                true,
            ),
            (
                "inline-key",
                false,
                vec![
                    ("CLINE_PROVIDER_SETTINGS_PATH", "@oversized"),
                    ("LAZYSH_OWNED_CLINE_INLINE_KEY", "1"),
                ],
                true,
            ),
        ] {
            if matches!(case, "regular-symlink" | "fifo-store") && !cfg!(unix) {
                continue;
            }
            // Windows known folders are not isolated by HOME/USERPROFILE.
            // Never use its real canonical credential store in this fixture.
            if cfg!(windows) && matches!(case, "blank-default" | "canonical-environment-path") {
                continue;
            }
            let expected = expected
                && (!cfg!(windows)
                    || matches!(
                        case,
                        "blank-default"
                            | "canonical-environment-path"
                            | "explicit-path"
                            | "inline-key"
                    ));
            let cached = case.starts_with("cache-") || case == "mixed-cache";
            if cached && !cfg!(target_os = "linux") {
                continue;
            }
            let directory = tempfile::tempdir().unwrap();
            if case == "schema-differential" {
                let corpus = include_str!("../tests/fixtures/cline-store-schema.json");
                std::fs::write(directory.path().join("schema-corpus.json"), corpus).unwrap();
            }
            let home = directory.path().join("home");
            let profile = directory.path().join("profile");
            let data = directory.path().join("data");
            let file = directory.path().join("selected.json");
            let malformed = directory.path().join("malformed.json");
            let default = home.join(".cline/data/settings/providers.json");
            let input = r#"{"version":1,"providers":{"cline":{"updatedAt":"2026-11-04T00:00:00.000Z","tokenSource":"oauth","settings":{"provider":"cline","auth":{"accessToken":"owned-cline-fixture","accountId":"owned-account","expiresAt":1}}}}}"#;
            for path in [
                &file,
                &profile.join("data/settings/providers.json"),
                &data.join("settings/providers.json"),
                &directory.path().join("relative/providers.json"),
            ] {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, input).unwrap();
            }
            std::fs::create_dir_all(default.parent().unwrap()).unwrap();
            std::fs::write(
                &default,
                if default_valid {
                    input
                } else {
                    "malformed-owned-store"
                },
            )
            .unwrap();
            std::fs::write(&malformed, "malformed-owned-store").unwrap();
            std::fs::write(
                directory.path().join("large-store.json"),
                vec![b' '; 1024 * 1024 + 1],
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::symlink;
                if case == "regular-symlink" {
                    symlink(&file, directory.path().join("store-link.json")).unwrap();
                }
                if case == "fifo-store" {
                    let status = std::process::Command::new("mkfifo")
                        .arg(directory.path().join("store-fifo.json"))
                        .status()
                        .unwrap();
                    assert!(status.success());
                }
            }

            let cline = serde_json::json!({"updatedAt":"2026-11-04T00:00:00.000Z","tokenSource":"oauth","settings":{"provider":"cline","auth":{"accessToken":"owned-cline-cache-token","accountId":"owned-cline-cache-account","expiresAt":1}}});
            let foreign = serde_json::json!({"updatedAt":"2026-11-04T00:00:00.000Z","tokenSource":"oauth","settings":{"provider":"openai-codex","auth":{"accessToken":"owned-foreign-fake-token","accountId":"owned-foreign-account","expiresAt":2}}});
            let mut legacy = cline.clone();
            legacy["settings"]["provider"] = serde_json::json!("cline-pass");
            legacy["settings"]["auth"]["accountId"] =
                serde_json::json!("owned-legacy-cache-account");
            legacy["settings"]["auth"]["accessToken"] =
                serde_json::json!("owned-legacy-cache-token");
            legacy["settings"]["auth"]["expiresAt"] = serde_json::json!(2);
            let mut invalid_cline = cline.clone();
            invalid_cline["settings"]["auth"]["accessToken"] = serde_json::json!("");
            let mut other = foreign.clone();
            other["settings"]["provider"] = serde_json::json!("oca");
            for (name, providers) in [
                ("current", serde_json::json!({"cline":cline})),
                ("foreign", serde_json::json!({"openai-codex":foreign})),
                ("other", serde_json::json!({"oca":other})),
                (
                    "mixed",
                    serde_json::json!({"cline":cline,"openai-codex":foreign}),
                ),
                (
                    "invalid-cline",
                    serde_json::json!({"cline":invalid_cline,"openai-codex":foreign}),
                ),
                ("mismatched", serde_json::json!({"cline":foreign})),
                ("legacy", serde_json::json!({"cline-pass":legacy})),
            ] {
                std::fs::write(
                    directory.path().join(format!("{name}.json")),
                    serde_json::to_vec(&serde_json::json!({"version":1,"lastUsedProvider":if name=="legacy" {"cline-pass"}else{"cline"},"providers":providers}))
                        .unwrap(),
                )
                .unwrap();
            }
            let mut canonical_newer = cline.clone();
            canonical_newer["settings"]["auth"]["expiresAt"] = serde_json::json!(2);
            let mut selected_legacy = legacy.clone();
            selected_legacy["settings"]["auth"]["expiresAt"] = serde_json::json!(1);
            let mut pass_without_auth = legacy.clone();
            pass_without_auth["settings"]
                .as_object_mut()
                .unwrap()
                .remove("auth");
            let mut pass_invalid = legacy.clone();
            pass_invalid["settings"]["auth"]["accessToken"] = serde_json::json!("");
            for (name, selected, providers) in [
                (
                    "canonical-over-legacy",
                    "cline",
                    serde_json::json!({"cline":cline,"cline-pass":legacy}),
                ),
                (
                    "selected-legacy",
                    "cline-pass",
                    serde_json::json!({"cline":canonical_newer,"cline-pass":selected_legacy}),
                ),
                (
                    "pass-inherits",
                    "cline-pass",
                    serde_json::json!({"cline":cline,"cline-pass":pass_without_auth}),
                ),
                (
                    "last-used-foreign",
                    "openai-codex",
                    serde_json::json!({"cline":cline,"cline-pass":legacy,"openai-codex":foreign}),
                ),
                (
                    "canonical-invalid",
                    "cline",
                    serde_json::json!({"cline":invalid_cline,"cline-pass":legacy}),
                ),
                (
                    "pass-invalid",
                    "cline-pass",
                    serde_json::json!({"cline":cline,"cline-pass":pass_invalid}),
                ),
                (
                    "legacy-unselected",
                    "cline",
                    serde_json::json!({"cline-pass":legacy}),
                ),
            ] {
                let mut value = serde_json::json!({"version":1,"lastUsedProvider":selected,"providers":providers});
                if name == "legacy-unselected" {
                    value.as_object_mut().unwrap().remove("lastUsedProvider");
                }
                std::fs::write(
                    directory.path().join(format!("{name}.json")),
                    serde_json::to_vec(&value).unwrap(),
                )
                .unwrap();
            }
            for name in [
                "missing-version",
                "unsupported-version",
                "missing-updated",
                "invalid-updated",
                "missing-provider",
                "invalid-token-source",
                "invalid-expiry",
                "invalid-last-used",
                "invalid-modes",
                "invalid-voice-mode",
                "invalid-repairs",
            ] {
                let mut value = serde_json::json!({"version":1,"providers":{"cline":cline}});
                match name {
                    "missing-version" => {
                        value.as_object_mut().unwrap().remove("version");
                    }
                    "unsupported-version" => value["version"] = serde_json::json!(2),
                    "missing-updated" => {
                        value["providers"]["cline"]
                            .as_object_mut()
                            .unwrap()
                            .remove("updatedAt");
                    }
                    "invalid-updated" => {
                        value["providers"]["cline"]["updatedAt"] =
                            serde_json::json!("not-a-timestamp")
                    }
                    "missing-provider" => {
                        value["providers"]["cline"]["settings"]
                            .as_object_mut()
                            .unwrap()
                            .remove("provider");
                    }
                    "invalid-token-source" => {
                        value["providers"]["cline"]["tokenSource"] = serde_json::json!("unknown")
                    }
                    "invalid-expiry" => {
                        value["providers"]["cline"]["settings"]["auth"]["expiresAt"] =
                            serde_json::json!(-1)
                    }
                    "invalid-last-used" => value["lastUsedProvider"] = serde_json::json!(true),
                    "invalid-modes" => value["modes"] = serde_json::json!([]),
                    "invalid-voice-mode" => {
                        value["modes"] = serde_json::json!({"voiceInput":{"modelId":"owned"}})
                    }
                    "invalid-repairs" => {
                        value["repairs"] = serde_json::json!({"bedrockProfile":"true"})
                    }
                    _ => unreachable!(),
                }
                std::fs::write(
                    directory.path().join(format!("{name}.json")),
                    serde_json::to_vec(&value).unwrap(),
                )
                .unwrap();
            }
            if cached {
                let cache = directory.path().join("cache/ai-usagebar/cline");
                std::fs::create_dir_all(&cache).unwrap();
                // SHA256 identifiers belong only to the fixed synthetic account/token above.
                let payload = serde_json::json!({"target":"https://api.cline.bot|user:d2dd244c787353bcfbd337e190ed80e4864a50d822a440691bbc3a4fcb330680|v3","credential":"b3a8a0e5d87a0913272a234bb81578f4da3c75406efa7fc54ef8828738b5ffe0","plan":{"name":"Owned cached plan","period_end":null},"windows":[{"percent":37.0,"reset":null},null,null]});
                let mut payload = payload;
                if case == "cache-selected-legacy-over-canonical" {
                    payload["credential"] = serde_json::json!(
                        "4a4ea91a223253952c2a00cb548bf087a89ad91d54edf7fcd49451b84a9b708f"
                    );
                    payload["target"]=serde_json::json!("https://api.cline.bot|user:6f45ec30e1f3cd055cb830918e3fe274f10d05a4d12cd36339cee5a87c84f05c|v3");
                }
                std::fs::write(
                    cache.join("usage.json"),
                    serde_json::to_vec(&payload).unwrap(),
                )
                .unwrap();
            }

            let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "collector::tests::owned_cline_store_probe",
                    "--ignored",
                ])
                .env_clear()
                .env("HOME", &home)
                .env("USERPROFILE", &home)
                .env("XDG_CACHE_HOME", directory.path().join("cache"))
                .env("LAZYSH_OWNED_CLINE_PROBE", "1")
                .env(
                    "LAZYSH_OWNED_CLINE_RECEIPT",
                    directory.path().join("probe.result"),
                )
                .env(
                    "LAZYSH_OWNED_CLINE_EXPECTED",
                    if expected { "present" } else { "missing" },
                )
                .current_dir(directory.path())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            for (name, value) in overrides {
                let value = match value {
                    "@profile" => profile.as_os_str().to_owned(),
                    "@data" => data.as_os_str().to_owned(),
                    "@file" => file.as_os_str().to_owned(),
                    "@default" => default.as_os_str().to_owned(),
                    "@malformed" => malformed.as_os_str().to_owned(),
                    "@trimmed-data" => {
                        OsString::from(format!("\u{feff} {} \t\u{feff}", data.display()))
                    }
                    "@nel-file" => OsString::from(format!("\u{85}{}", file.display())),
                    "@oversized" => OsString::from("x".repeat(4097)),
                    value if value.starts_with('@') => directory
                        .path()
                        .join(format!("{}.json", &value[1..]))
                        .into_os_string(),
                    value => value.into(),
                };
                command.env(name, value);
            }
            let mut child = command.spawn().unwrap();
            let status = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                Ok(status) => status.unwrap(),
                Err(_) => {
                    child.kill().await.unwrap();
                    let _ = child.wait().await;
                    panic!("owned Cline probe exceeded its deadline");
                }
            };
            assert!(
                status.success(),
                "selected Cline store case failed: {case}; receipt={}",
                std::fs::read_to_string(directory.path().join("probe.result"))
                    .unwrap_or_else(|_| "absent".into())
            );
            if case == "schema-differential" {
                assert_eq!(
                    std::fs::read_to_string(directory.path().join("schema.count")).unwrap(),
                    "787"
                );
            }
            assert_eq!(
                std::fs::read_to_string(directory.path().join("probe.result"))
                    .expect("the selected private helper must actually execute"),
                if expected { "present" } else { "missing" }
            );
            assert_eq!(std::fs::read_to_string(&file).unwrap(), input);
            assert_eq!(
                std::fs::read_to_string(&default).unwrap(),
                if default_valid {
                    input
                } else {
                    "malformed-owned-store"
                }
            );
        }
    }
    #[test]
    fn explicit_config_preserves_disabled_providers_without_probing_or_writing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.toml");
        let input =
            "[openai]\nenabled = false\n[context]\nenabled=true\n[notifications]\nenabled=true\n";
        std::fs::write(&path, input).unwrap();
        let config = load_config_with(
            Some(&path),
            Some(std::ffi::OsStr::new("invalid-relative-private-path")),
            |_, _| panic!("explicit configuration must not probe accounts"),
        )
        .unwrap();
        assert!(!config.openai.enabled);
        assert!(!config.context.enabled);
        assert!(!config.notifications.enabled);
        assert_eq!(std::fs::read_to_string(path).unwrap(), input);
    }
    #[test]
    fn invalid_automatic_codex_home_is_an_error_before_any_credential_probe() {
        let root = tempfile::tempdir().unwrap();
        let invalid = vec![
            std::ffi::OsString::from("relative-private-path"),
            root.path().join("../private-parent").into_os_string(),
            root.path().join("./private-current").into_os_string(),
            root.path().join("private\ncontrol").into_os_string(),
            root.path().join("x".repeat(4096)).into_os_string(),
        ];
        #[cfg(unix)]
        let invalid = {
            use std::os::unix::ffi::OsStringExt;
            let mut values = invalid;
            values.push(std::ffi::OsString::from_vec(vec![b'/', 255]));
            values
        };
        for value in invalid {
            let error = load_config_with(None, Some(&value), |_, _| {
                panic!("invalid override must not probe or choose another account")
            })
            .err()
            .unwrap();
            assert_eq!(error, "Account usage Codex home is invalid");
        }
        for value in ["", "   "] {
            let config = load_config_with(None, Some(std::ffi::OsStr::new(value)), |_, config| {
                assert!(config.openai.codex_auth_path.is_none());
                false
            })
            .unwrap();
            assert!(!config.openai.enabled);
        }
    }
    #[test]
    fn explicit_codex_paths_and_named_accounts_override_automatic_home_without_writes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.toml");
        let default = directory.path().join("selected-auth.json");
        let named = directory.path().join("work-auth.json");
        let input = format!("[openai]\nenabled=true\ncodex_auth_path={}\n[[openai.accounts]]\nlabel='work'\ncodex_auth_path={}\n",toml::Value::String(default.to_str().unwrap().into()),toml::Value::String(named.to_str().unwrap().into()));
        std::fs::write(&path, &input).unwrap();
        let config = load_config_with(
            Some(&path),
            Some(std::ffi::OsStr::new("ignored-private-invalid-home")),
            |_, _| panic!("explicit configuration must not probe accounts"),
        )
        .unwrap();
        assert!(config.openai.resolve_auth_path(None).unwrap() == default);
        assert!(config.openai.resolve_auth_path(Some("work")).unwrap() == named);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), input);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn insecure_inline_credentials_are_refused_without_changing_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.toml");
        std::fs::write(&path, "[zai]\napi_key='fixture-only'\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_config_with(Some(&path), None, |_, _| false).is_err());
        assert_eq!(std::fs::metadata(path).unwrap().mode() & 0o777, 0o644);
    }
    #[test]
    fn malformed_and_oversize_configuration_errors_do_not_return_input() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.toml");
        std::fs::write(&path, "SUPER-PRIVATE-BROKEN-CONFIG=").unwrap();
        let error = load_config_with(Some(&path), None, |_, _| false)
            .err()
            .unwrap();
        assert!(!error.contains("SUPER-PRIVATE"));
        std::fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(load_config_with(Some(&path), None, |_, _| false).is_err());
    }
    #[tokio::test]
    async fn expired_collection_retains_entries_without_starting_authentication() {
        let config =
            load_config_with(None, None, |vendor, _| vendor == core::VendorId::Openai).unwrap();
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
