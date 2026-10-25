use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::{AppState, Host};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_lazysh_vault::access::AccessError;

pub(crate) type CredentialGuard = Arc<tokio::sync::OwnedMutexGuard<()>>;

// Retain ownership through OS work and metadata even if the IPC caller disappears.
pub(crate) fn credential_worker<T: Send + 'static, E: From<AccessError> + Send + 'static>(
    guard: CredentialGuard,
    access: AccessLease,
    action: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> tauri::async_runtime::JoinHandle<Result<T, E>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        access.check()?;
        action()
    })
}

use tauri_plugin_lazysh_vault::{CredentialOperation, VaultExt};
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

pub(crate) async fn load_for_operation(
    app: AppHandle,
    host: Host,
    operation: CredentialOperation,
    guard: CredentialGuard,
    access: AccessLease,
) -> Result<Credentials, String> {
    operation.check()?;
    credential_worker(guard, access.clone(), move || {
        operation.check()?;
        let value = Zeroizing::new(
            app.vault()
                .get_protected_for(&key(&host.id), host.biometric_unlock, &operation)?
                .ok_or("No saved credentials for this host")?,
        );
        let credentials = decode(&host, &value)?;
        operation.check()?;
        access.check()?;
        Ok(credentials)
    })
    .await
    .map_err(|_| "Could not read saved credentials".to_string())?
}

pub(crate) async fn save_for_operation(
    app: AppHandle,
    host: Host,
    credentials: Credentials,
    operation: CredentialOperation,
    guard: CredentialGuard,
    access: AccessLease,
) -> Result<(), String> {
    operation.check()?;
    credential_worker(guard, access, move || {
        operation.check()?;
        let value = encode(&host, &credentials)?;
        app.vault()
            .set_protected_for(&key(&host.id), &value, host.biometric_unlock, &operation)
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
impl From<AccessError> for ImportFailure {
    fn from(error: AccessError) -> Self {
        Self {
            message: error.into(),
            keep_marker: true,
        }
    }
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
    operation: CredentialOperation,
    guard: CredentialGuard,
    access: AccessLease,
) -> Result<(), ImportFailure> {
    credential_worker(guard, access, move || {
        let account = key(&host.id);
        save_new_with_cleanup(
            || app.vault().exists(&account),
            || {
                operation.check()?;
                let value = encode(&host, &credentials)?;
                app.vault()
                    .set_protected_for(&account, &value, host.biometric_unlock, &operation)
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
    access: AccessLease,
) -> std::result::Result<Guarded<bool>, GuardedError<String>> {
    access
        .run(async {
            let host = state.host(&host_id).map_err(|_| "Host no longer exists")?;
            if host.fingerprint.is_none() || !host.credentials_stored {
                return Ok(false);
            }
            let worker_access = access.clone();
            tauri::async_runtime::spawn_blocking(move || {
                worker_access.check()?;
                app.vault().exists(&key(&host.id))
            })
            .await
            .map_err(|_| "Could not inspect saved credentials".to_string())?
        })
        .await
}

#[tauri::command]
pub async fn forget_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<()>, GuardedError<String>> {
    access
        .run(async {
            let _guard = state.credential_guard(&host_id).await;
            let host = state.host(&host_id).map_err(|_| "Host no longer exists")?;
            if !host.credentials_stored {
                return Ok(());
            }
            let state = state.inner().clone();
            credential_worker(_guard, access.clone(), move || {
                remove(&app, &host_id)?;
                state
                    .mark_credentials(&host_id, false)
                    .map_err(|_| "Could not update credential metadata".to_string())
            })
            .await
            .map_err(|_| "Could not delete credentials".to_string())?
        })
        .await
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
    let auth_epoch = app.vault().begin_cancellation();
    tauri::async_runtime::spawn_blocking(move || app.vault().cancel_authentication_at(auth_epoch))
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
    access: AccessLease,
) -> std::result::Result<Guarded<ExportedIdentity>, GuardedError<String>> {
    access
        .run(async {
            let operation = app.vault().operation();
            let _guard = crate::ssh::during_connect(&operation, async {
                Ok(state.credential_guard(&host_id).await)
            })
            .await
            .map_err(|_| "Credential operation cancelled")?;
            let host = state.host(&host_id).map_err(|_| "Host no longer exists")?;
            if !host.biometric_unlock || !host.credentials_stored {
                return Err(
                    "Private-key export requires saved credentials protected with biometrics"
                        .into(),
                );
            }
            let credentials =
                load_for_operation(app, host, operation.clone(), _guard.clone(), access.clone())
                    .await?;
            operation.check()?;
            Ok(ExportedIdentity {
                private_key: credentials
                    .private_key
                    .clone()
                    .ok_or("This host has no saved private key")?,
            })
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn revoked_delete_retains_host_guard_and_finishes_metadata_before_next_writer() {
        use crate::app_lock::AccessState;
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        state.sync_add_hosts(&[], vec![host()], &[]).unwrap();
        state.mark_credentials("one", true).unwrap();
        let authority = AccessState::default();
        authority.initialize(true, false, "fixture".into()).unwrap();
        let access = authority.lease(None).unwrap();
        let guard = state.credential_guard("one").await;
        let worker_state = state.clone();
        let worker_access = access.clone();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let caller = tokio::spawn(async move {
            access
                .run(async move {
                    credential_worker(guard, worker_access, move || {
                        entered.send(()).unwrap();
                        wait.recv().unwrap();
                        worker_state
                            .mark_credentials("one", false)
                            .map_err(|_| "fixture metadata failed".to_string())
                    })
                    .await
                    .unwrap()
                })
                .await
        });
        started.await.unwrap();
        authority
            .configure_after_proof(authority.generation().unwrap(), true)
            .unwrap();
        assert!(caller.await.unwrap().is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(30), state.credential_guard("one"))
                .await
                .is_err()
        );
        release.send(()).unwrap();
        let _next = tokio::time::timeout(Duration::from_secs(2), state.credential_guard("one"))
            .await
            .unwrap();
        assert!(!state.host("one").unwrap().credentials_stored);
        assert!(
            !AppState::new(dir.path().into())
                .unwrap()
                .host("one")
                .unwrap()
                .credentials_stored
        );
        state.mark_credentials("one", true).unwrap();
        assert!(state.host("one").unwrap().credentials_stored);
    }

    #[tokio::test]
    async fn queued_credential_worker_rejects_revoked_lease_before_dispatch() {
        use crate::app_lock::AccessState;
        let authority = AccessState::default();
        authority.initialize(true, false, "fixture".into()).unwrap();
        let access = authority.lease(None).unwrap();
        authority
            .configure_after_proof(authority.generation().unwrap(), true)
            .unwrap();
        let mutex = Arc::new(tokio::sync::Mutex::new(()));
        let guard = Arc::new(mutex.clone().lock_owned().await);
        let result = credential_worker(guard, access, || -> Result<(), String> {
            panic!("revoked mutation must not touch the OS store")
        })
        .await
        .unwrap();
        assert!(result.is_err());
        assert!(mutex.try_lock().is_ok());
    }

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
            transport: None,
            mosh: None,
            et: None,
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
        let mut preferences_changed = host.clone();
        preferences_changed.transport = Some(crate::ssh::Transport::Auto);
        preferences_changed.mosh = Some(crate::mosh::Options::default());
        preferences_changed.et = Some(crate::et::Options::default());
        assert_eq!(
            decode(&preferences_changed, &encoded)
                .unwrap()
                .password
                .as_deref(),
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
