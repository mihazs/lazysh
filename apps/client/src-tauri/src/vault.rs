use crate::ssh::{AppState, Host};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_lazysh_vault::VaultExt;
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Credentials {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        self.password.zeroize();
        self.private_key.zeroize();
        self.passphrase.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    version: u8,
    hostname: String,
    port: u16,
    username: String,
    fingerprint: String,
    #[serde(default)]
    jump_host_id: Option<String>,
    #[serde(default)]
    forward_agent: bool,
    #[serde(default)]
    biometric_unlock: bool,
    credentials: Credentials,
}

fn key(host_id: &str) -> String {
    format!(
        "host-{}",
        host_id
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn encode(host: &Host, credentials: &Credentials) -> Result<Zeroizing<String>, String> {
    let fingerprint = host
        .fingerprint
        .clone()
        .ok_or("Verify this host before saving credentials")?;
    if credentials
        .password
        .as_ref()
        .is_some_and(|s| s.len() > 65536)
        || credentials
            .private_key
            .as_ref()
            .is_some_and(|s| s.len() > 65536)
        || credentials
            .passphrase
            .as_ref()
            .is_some_and(|s| s.len() > 1024)
    {
        return Err("Credentials exceed the size limit".into());
    }
    serde_json::to_string(&Stored {
        version: 1,
        hostname: host.hostname.clone(),
        port: host.port,
        username: host.username.clone(),
        fingerprint,
        jump_host_id: host.jump_host_id.clone(),
        forward_agent: host.forward_agent,
        biometric_unlock: host.biometric_unlock,
        credentials: credentials.clone(),
    })
    .map(Zeroizing::new)
    .map_err(|_| "Could not encode credentials".into())
}

fn decode(host: &Host, value: &str) -> Result<Credentials, String> {
    let stored: Stored = serde_json::from_str(value).map_err(|_| "Invalid saved credentials")?;
    if stored.version != 1
        || stored.hostname != host.hostname
        || stored.port != host.port
        || stored.username != host.username
        || host.fingerprint.as_deref() != Some(&stored.fingerprint)
        || host.jump_host_id != stored.jump_host_id
        || host.forward_agent != stored.forward_agent
        || host.biometric_unlock != stored.biometric_unlock
    {
        return Err(
            "Host identity changed. Forget the old credentials and enter them again.".into(),
        );
    }
    Ok(stored.credentials)
}

pub(crate) async fn load(app: AppHandle, host: Host) -> Result<Credentials, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = Zeroizing::new(
            app.vault()
                .get_protected(&key(&host.id), host.biometric_unlock)?
                .ok_or("No saved credentials for this host")?,
        );
        decode(&host, &value)
    })
    .await
    .map_err(|_| "Could not read saved credentials".to_string())?
}

pub(crate) async fn save(
    app: AppHandle,
    host: Host,
    credentials: Credentials,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = encode(&host, &credentials)?;
        app.vault()
            .set_protected(&key(&host.id), &value, host.biometric_unlock)
    })
    .await
    .map_err(|_| "Could not save credentials".to_string())?
}

pub(crate) fn remove(app: &AppHandle, host_id: &str) -> Result<(), String> {
    app.vault().delete(&key(host_id))
}
#[derive(Debug)]
pub(crate) struct ImportFailure {
    pub message: String,
    pub keep_marker: bool,
}
fn save_new_with_cleanup(
    exists: impl FnOnce() -> Result<bool, String>,
    create: impl FnOnce() -> Result<(), String>,
    cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<(), ImportFailure> {
    match exists() {
        Ok(false) => {}
        Ok(true) => {
            return Err(ImportFailure {
                message: "Saved credentials already exist. Sync never overwrites them.".into(),
                keep_marker: true,
            })
        }
        Err(message) => {
            return Err(ImportFailure {
                message,
                keep_marker: true,
            })
        }
    }
    if let Err(message) = create() {
        return match cleanup() {
            Ok(()) => Err(ImportFailure { message, keep_marker: false }),
            Err(_) => Err(ImportFailure { message: format!("{message}. Credential cleanup is incomplete; forget the saved credentials before retrying."), keep_marker: true }),
        };
    }
    Ok(())
}
pub(crate) async fn save_new(
    app: AppHandle,
    host: Host,
    credentials: Credentials,
) -> Result<(), ImportFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = key(&host.id);
        save_new_with_cleanup(
            || app.vault().exists(&account),
            || {
                let value = encode(&host, &credentials)?;
                app.vault()
                    .set_protected(&account, &value, host.biometric_unlock)
            },
            || app.vault().delete(&account),
        )
    })
    .await
    .map_err(|_| ImportFailure {
        message: "Could not import credentials; credential cleanup may still be needed".into(),
        keep_marker: true,
    })?
}

#[tauri::command]
pub async fn has_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
) -> Result<bool, String> {
    let host = state.host(&host_id).map_err(|_| "Host no longer exists")?;
    if host.fingerprint.is_none() || !host.credentials_stored {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || app.vault().exists(&key(&host.id)))
        .await
        .map_err(|_| "Could not inspect saved credentials".to_string())?
}

#[tauri::command]
pub async fn forget_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
) -> Result<(), String> {
    let _guard = state.credential_guard(&host_id).await;
    let host = state.host(&host_id).map_err(|_| "Host no longer exists")?;
    if !host.credentials_stored {
        return Ok(());
    }
    let key_host = host_id.clone();
    tauri::async_runtime::spawn_blocking(move || remove(&app, &key_host))
        .await
        .map_err(|_| "Could not delete credentials".to_string())??;
    state
        .mark_credentials(&host_id, false)
        .map_err(|_| "Could not update credential metadata".into())
}

#[tauri::command]
pub async fn credential_protection(
    app: AppHandle,
) -> Result<tauri_plugin_lazysh_vault::ProtectionCapability, String> {
    tauri::async_runtime::spawn_blocking(move || app.vault().protection_capability())
        .await
        .map_err(|_| "Cannot inspect credential protection".to_string())?
}

#[tauri::command]
pub async fn cancel_credential_auth(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.vault().cancel_authentication())
        .await
        .map_err(|_| "Cannot cancel credential authentication".to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedIdentity {
    private_key: String,
}

#[tauri::command]
pub async fn export_saved_identity(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
) -> Result<ExportedIdentity, String> {
    let _guard = state.credential_guard(&host_id).await;
    let host = state.host(&host_id).map_err(|_| "Host no longer exists")?;
    if !host.biometric_unlock || !host.credentials_stored {
        return Err(
            "Private-key export requires saved credentials protected with biometrics".into(),
        );
    }
    let credentials = load(app, host).await?;
    Ok(ExportedIdentity {
        private_key: credentials
            .private_key
            .clone()
            .ok_or("This host has no saved private key")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_new_import_retains_recovery_marker_until_partial_write_cleanup_succeeds() {
        use std::cell::Cell;
        for cleanup_fails in [true, false] {
            let partial_chunks = Cell::new(false);
            let failure = save_new_with_cleanup(
                || Ok(false),
                || {
                    partial_chunks.set(true);
                    Err("partial write".into())
                },
                || {
                    if cleanup_fails {
                        Err("locked store".into())
                    } else {
                        partial_chunks.set(false);
                        Ok(())
                    }
                },
            )
            .unwrap_err();
            assert_eq!(failure.keep_marker, partial_chunks.get());
            assert_eq!(failure.keep_marker, cleanup_fails);
        }
    }
    #[test]
    fn new_import_never_deletes_existing_or_unknown_vault_items() {
        for presence in [Ok(true), Err("presence probe failed".into())] {
            let failure = save_new_with_cleanup(
                || presence,
                || panic!("must not overwrite existing or unknown data"),
                || panic!("must not delete a pre-existing item"),
            )
            .unwrap_err();
            assert!(failure.keep_marker);
        }
        save_new_with_cleanup(
            || Ok(false),
            || Ok(()),
            || panic!("a successful import must remain stored"),
        )
        .unwrap();
    }
    fn host() -> Host {
        Host {
            id: "one".into(),
            name: "Test".into(),
            hostname: "host".into(),
            port: 22,
            username: "me".into(),
            fingerprint: Some("SHA256:pin".into()),
            jump_host_id: None,
            forward_agent: false,
            credentials_stored: false,
            biometric_unlock: false,
        }
    }
    #[test]
    fn stored_credentials_bind_to_verified_host_identity() {
        let host = host();
        let credentials = Credentials {
            password: Some("secret".into()),
            private_key: None,
            passphrase: None,
        };
        let encoded = encode(&host, &credentials).unwrap();
        assert_eq!(
            decode(&host, &encoded).unwrap().password.as_deref(),
            Some("secret")
        );
        for changed in [
            Host {
                biometric_unlock: true,
                ..host.clone()
            },
            Host {
                hostname: "other".into(),
                ..host.clone()
            },
            Host {
                username: "root".into(),
                ..host.clone()
            },
            Host {
                port: 23,
                ..host.clone()
            },
            Host {
                fingerprint: None,
                ..host.clone()
            },
            Host {
                fingerprint: Some("SHA256:other".into()),
                ..host.clone()
            },
        ] {
            assert!(decode(&changed, &encoded).is_err());
        }
        assert!(encode(
            &Host {
                fingerprint: None,
                ..host
            },
            &credentials
        )
        .is_err());
        assert_ne!(key("a_iv"), key("a"));
    }
}
