use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
#[cfg(any(target_os = "windows", test))]
mod chunked;

#[cfg(target_os = "windows")]
struct WindowsStore<'a>(&'a str);
#[cfg(target_os = "windows")]
impl chunked::Store for WindowsStore<'_> {
    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match keyring::Entry::new(self.0, key)
            .map_err(|_| "OS credential store unavailable")?
            .get_secret()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Cannot read OS credential store".into()),
        }
    }
    fn write(&self, key: &str, value: &[u8]) -> Result<(), String> {
        keyring::Entry::new(self.0, key)
            .map_err(|_| "OS credential store unavailable")?
            .set_secret(value)
            .map_err(|_| "Cannot save to OS credential store".into())
    }
    fn remove(&self, key: &str) -> Result<(), String> {
        match keyring::Entry::new(self.0, key)
            .map_err(|_| "OS credential store unavailable")?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Cannot delete from OS credential store".into()),
        }
    }
}

#[cfg(mobile)]
#[derive(Serialize)]
struct Item {
    key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    biometric: bool,
}

#[derive(Serialize, Deserialize)]
pub struct ProtectionCapability {
    pub available: bool,
    pub reason: String,
}
#[cfg(mobile)]
#[derive(Deserialize)]
struct Presence {
    exists: bool,
}

#[cfg(mobile)]
fn mobile_error(error: tauri::plugin::mobile::PluginInvokeError) -> String {
    match error {
        tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) => response
            .message
            .unwrap_or_else(|| "Credential operation cancelled or unavailable".into()),
        _ => "Device credential service unavailable".into(),
    }
}

#[cfg(mobile)]
#[derive(Deserialize)]
struct Value {
    value: Option<String>,
}

pub struct Vault<R: Runtime> {
    #[cfg(desktop)]
    service: String,
    #[cfg(desktop)]
    _runtime: std::marker::PhantomData<fn() -> R>,
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
}

fn validate(key: &str, value: Option<&str>) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 1024
        || key.contains('\0')
        || value.is_some_and(|v| v.len() > 128 * 1024)
    {
        return Err("Invalid vault item size".into());
    }
    Ok(())
}

impl<R: Runtime> Vault<R> {
    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        self.get_protected(key, false)
    }
    pub fn get_protected(&self, key: &str, biometric: bool) -> Result<Option<String>, String> {
        validate(key, None)?;
        #[cfg(desktop)]
        if biometric {
            return Err("Biometric credential protection is unavailable on this platform".into());
        }
        #[cfg(target_os = "windows")]
        {
            chunked::get(&WindowsStore(&self.service), key)
        }
        #[cfg(all(desktop, not(target_os = "windows")))]
        {
            match keyring::Entry::new(&self.service, key)
                .map_err(|_| "OS credential store unavailable")?
                .get_password()
            {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(
                    "Cannot read OS credential store. Unlock your keychain and try again.".into(),
                ),
            }
        }
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<Value>(
                    "read",
                    Item {
                        key: key.into(),
                        value: None,
                        biometric,
                    },
                )
                .map(|result| result.value)
                .map_err(mobile_error)
        }
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.set_protected(key, value, false)
    }
    pub fn set_protected(&self, key: &str, value: &str, biometric: bool) -> Result<(), String> {
        validate(key, Some(value))?;
        #[cfg(desktop)]
        if biometric {
            return Err("Biometric credential protection is unavailable on this platform".into());
        }
        #[cfg(target_os = "windows")]
        {
            chunked::set(&WindowsStore(&self.service), key, value)
        }
        #[cfg(all(desktop, not(target_os = "windows")))]
        {
            keyring::Entry::new(&self.service, key)
                .map_err(|_| "OS credential store unavailable")?
                .set_password(value)
                .map_err(|_| "Cannot save to OS credential store".into())
        }
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<()>(
                    "write",
                    Item {
                        key: key.into(),
                        value: Some(value.into()),
                        biometric,
                    },
                )
                .map_err(mobile_error)
        }
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        validate(key, None)?;
        #[cfg(target_os = "windows")]
        {
            chunked::delete(&WindowsStore(&self.service), key)
        }
        #[cfg(all(desktop, not(target_os = "windows")))]
        {
            match keyring::Entry::new(&self.service, key)
                .map_err(|_| "OS credential store unavailable")?
                .delete_credential()
            {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("Cannot delete from OS credential store".into()),
            }
        }
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<()>(
                    "remove",
                    Item {
                        key: key.into(),
                        value: None,
                        biometric: false,
                    },
                )
                .map_err(|_| "Cannot delete from device credential store".into())
        }
    }

    pub fn protection_capability(&self) -> Result<ProtectionCapability, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin("capability", ())
                .map_err(mobile_error)
        }
        #[cfg(desktop)]
        {
            Ok(ProtectionCapability {
                available: false,
                reason: "Biometric credential protection is unavailable on this platform".into(),
            })
        }
    }
    pub fn cancel_authentication(&self) -> Result<(), String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin("cancel", ())
                .map_err(mobile_error)
        }
        #[cfg(desktop)]
        {
            Ok(())
        }
    }
    pub fn exists(&self, key: &str) -> Result<bool, String> {
        validate(key, None)?;
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin::<Presence>(
                    "exists",
                    Item {
                        key: key.into(),
                        value: None,
                        biometric: false,
                    },
                )
                .map(|value| value.exists)
                .map_err(mobile_error)
        }
        #[cfg(desktop)]
        {
            match keyring::Entry::new(&self.service, key)
                .map_err(|_| "OS credential store unavailable")?
                .get_attributes()
            {
                Ok(_) => Ok(true),
                Err(keyring::Error::NoEntry) => Ok(false),
                Err(_) => Err("Cannot inspect OS credential store".into()),
            }
        }
    }
}

pub trait VaultExt<R: Runtime>: Manager<R> {
    fn vault(&self) -> &Vault<R> {
        self.state::<Vault<R>>().inner()
    }
}
impl<R: Runtime, T: Manager<R>> VaultExt<R> for T {}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_lazysh_vault);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lazysh-vault")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let vault = Vault {
                handle: api.register_android_plugin("app.lazysh.vault", "VaultPlugin")?,
            };
            #[cfg(target_os = "ios")]
            let vault = Vault {
                handle: api.register_ios_plugin(init_plugin_lazysh_vault)?,
            };
            #[cfg(desktop)]
            let vault = {
                let _ = api;
                Vault::<R> {
                    service: format!("{}.credentials", app.config().identifier),
                    _runtime: std::marker::PhantomData,
                }
            };
            app.manage(vault);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_reject_items_before_os_access() {
        assert!(validate("", None).is_err());
        assert!(validate("a\0b", None).is_err());
        assert!(validate("host", Some(&"x".repeat(128 * 1024 + 1))).is_err());
        assert!(validate("host", Some("password")).is_ok());
    }

    #[cfg(desktop)]
    #[test]
    fn unsupported_platforms_never_downgrade_biometric_requests_to_ordinary_storage() {
        let vault = Vault::<tauri::test::MockRuntime> {
            service: "app.lazysh.biometric-policy-test".into(),
            _runtime: std::marker::PhantomData,
        };
        assert!(!vault.protection_capability().unwrap().available);
        assert!(vault
            .get_protected("host", true)
            .unwrap_err()
            .contains("unavailable"));
        assert!(vault
            .set_protected("host", "not-written-to-vault", true)
            .unwrap_err()
            .contains("unavailable"));
    }

    #[cfg(desktop)]
    #[test]
    #[ignore = "requires an available unlocked native OS credential store"]
    fn os_vault_roundtrip() {
        struct Cleanup(keyring::Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let account = format!("{}-{:?}", std::process::id(), std::time::SystemTime::now());
        let item =
            Cleanup(keyring::Entry::new("app.lazysh.client.integration-test", &account).unwrap());
        item.0
            .set_password("temporary lazysh integration fixture")
            .unwrap();
        assert_eq!(
            item.0.get_password().unwrap(),
            "temporary lazysh integration fixture"
        );
        item.0.set_password("updated fixture").unwrap();
        assert_eq!(item.0.get_password().unwrap(), "updated fixture");
        item.0.delete_credential().unwrap();
        assert!(matches!(
            item.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }
}
