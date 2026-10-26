//! Biometric Keychain items use a separate service and never fall back to ordinary items.
use crate::ProtectionCapability;
use core_foundation::{
    base::{CFType, TCFType},
    boolean::CFBoolean,
    data::CFData,
    dictionary::CFDictionary,
    string::{CFString, CFStringRef},
};
use objc2::rc::Retained;
use objc2_foundation::NSString;
use objc2_local_authentication::{LAContext, LAPolicy};
use security_framework::{
    access_control::{ProtectionMode, SecAccessControl},
    passwords::AccessControlOptions,
};
use security_framework_sys::{
    base::{errSecDuplicateItem, errSecItemNotFound, errSecSuccess},
    item::*,
    keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate},
};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

// Public Security.framework symbol omitted from security-framework-sys 2.17.
unsafe extern "C" {
    static kSecUseAuthenticationUIFail: CFStringRef;
}
type Result<T> = std::result::Result<T, String>;
const INTERACTION_NOT_ALLOWED: i32 = -25308;

#[derive(Default)]
pub struct MacVault {
    active: Mutex<Option<(usize, u64)>>,
    epoch: AtomicU64,
}
struct ContextGuard<'a> {
    vault: &'a MacVault,
    context: Retained<LAContext>,
    epoch: u64,
}
impl Drop for ContextGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.vault.active.lock() {
            *active = None;
        }
        // The context is retained until after the active pointer is removed under the lock.
        unsafe {
            self.context.invalidate();
        }
    }
}
fn constant(value: CFStringRef) -> CFString {
    // All callers pass immutable, process-lifetime Security.framework CFString constants.
    unsafe { CFString::wrap_under_get_rule(value) }
}
fn query(service: &str, key: &str) -> Vec<(CFString, CFType)> {
    item_query(service, key, true)
}
fn item_query(service: &str, key: &str, protected: bool) -> Vec<(CFString, CFType)> {
    unsafe {
        let mut fields = vec![
            (
                constant(kSecClass),
                constant(kSecClassGenericPassword).into_CFType(),
            ),
            (
                constant(kSecAttrService),
                CFString::new(&if protected {
                    format!("{service}.biometric")
                } else {
                    service.into()
                })
                .into_CFType(),
            ),
            (constant(kSecAttrAccount), CFString::new(key).into_CFType()),
            (
                constant(kSecAttrSynchronizable),
                CFBoolean::from(false).into_CFType(),
            ),
        ];
        if protected {
            fields.push((
                constant(kSecUseDataProtectionKeychain),
                CFBoolean::from(true).into_CFType(),
            ));
        }
        fields
    }
}
fn legacy_exists(service: &str, key: &str) -> Result<bool> {
    metadata_exists(item_query(service, key, false))
}
fn legacy_delete(service: &str, key: &str) -> Result<()> {
    let dictionary = CFDictionary::from_CFType_pairs(&item_query(service, key, false));
    let status = unsafe { SecItemDelete(dictionary.as_concrete_TypeRef()) };
    if status == errSecSuccess || status == errSecItemNotFound {
        Ok(())
    } else {
        Err("Cannot delete ordinary Keychain credentials".into())
    }
}
fn marker(key: &str) -> String {
    format!("{key}.biometric-policy")
}
fn protected_exists(service: &str, key: &str) -> Result<bool> {
    metadata_exists(query(service, key))
}
fn metadata_exists(mut fields: Vec<(CFString, CFType)>) -> Result<bool> {
    unsafe {
        fields.push((
            constant(kSecReturnAttributes),
            CFBoolean::from(true).into_CFType(),
        ));
        fields.push((
            constant(kSecUseAuthenticationUI),
            constant(kSecUseAuthenticationUIFail).into_CFType(),
        ));
    }
    let dictionary = CFDictionary::from_CFType_pairs(&fields);
    // Metadata only, with authentication UI explicitly prohibited.
    let status =
        unsafe { SecItemCopyMatching(dictionary.as_concrete_TypeRef(), std::ptr::null_mut()) };
    match status {
        value if value == errSecSuccess || value == INTERACTION_NOT_ALLOWED => Ok(true),
        value if value == errSecItemNotFound => Ok(false),
        _ => Err(
            "Protected Keychain is unavailable; check application signing and device lock".into(),
        ),
    }
}
impl MacVault {
    pub fn capability(&self, service: &str) -> Result<ProtectionCapability> {
        let context = unsafe { LAContext::new() };
        let enrolled = unsafe {
            context
                .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
                .is_ok()
        };
        unsafe {
            context.invalidate();
        }
        let available = enrolled && protected_exists(service, "capability-probe").is_ok();
        Ok(ProtectionCapability {
            available,
            reason: if available {
                "Touch ID protects each credential read"
            } else {
                "Touch ID must be enrolled and this signed app must have protected Keychain access"
            }
            .into(),
        })
    }
    fn context(&self, epoch: u64) -> Result<ContextGuard<'_>> {
        let context = unsafe { LAContext::new() };
        unsafe {
            context.setTouchIDAuthenticationAllowableReuseDuration(0.0);
            context.setLocalizedReason(&NSString::from_str(&crate::macos_ui_locale::text(
                "auth.unlock",
            )));
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Credential authentication lock failed")?;
        if active.is_some() || epoch < self.epoch.load(Ordering::Acquire) {
            return Err("Credential authentication cancelled or another request is active".into());
        }
        *active = Some((Retained::as_ptr(&context) as usize, epoch));
        Ok(ContextGuard {
            vault: self,
            context,
            epoch,
        })
    }
    fn authenticated_query(
        &self,
        service: &str,
        key: &str,
        context: &ContextGuard<'_>,
    ) -> Vec<(CFString, CFType)> {
        let mut fields = query(service, key);
        // Keychain accepts an LAContext Objective-C object as this CF dictionary value; retain it independently.
        let object =
            unsafe { CFType::wrap_under_get_rule(Retained::as_ptr(&context.context).cast()) };
        fields.push((constant(unsafe { kSecUseAuthenticationContext }), object));
        fields
    }
    fn check_context(&self, context: &ContextGuard<'_>) -> Result<()> {
        if context.epoch < self.epoch.load(Ordering::Acquire) {
            Err("Credential authentication cancelled".into())
        } else {
            Ok(())
        }
    }
    pub fn cancel(&self, epoch: u64) -> Result<()> {
        let context = {
            let active = self
                .active
                .lock()
                .map_err(|_| "Credential authentication lock failed")?;
            self.epoch.fetch_max(epoch, Ordering::AcqRel);
            // The owner cannot release its retained context while this lock is held.
            active
                .filter(|(_, token)| *token < self.epoch.load(Ordering::Acquire))
                .and_then(|(address, _)| unsafe { Retained::retain(address as *mut LAContext) })
        };
        if let Some(context) = context {
            unsafe {
                context.invalidate();
            }
        }
        Ok(())
    }
    pub fn exists(&self, service: &str, key: &str) -> Result<bool> {
        if legacy_exists(service, &marker(key))? {
            Ok(true)
        } else {
            legacy_exists(service, key)
        }
    }
    fn copy_data(&self, service: &str, key: &str, context: &ContextGuard<'_>) -> Result<CFType> {
        let mut fields = self.authenticated_query(service, key, context);
        fields.push((
            constant(unsafe { kSecReturnData }),
            CFBoolean::from(true).into_CFType(),
        ));
        let dictionary = CFDictionary::from_CFType_pairs(&fields);
        let mut result = std::ptr::null();
        let status = unsafe { SecItemCopyMatching(dictionary.as_concrete_TypeRef(), &mut result) };
        let result = if result.is_null() {
            None
        } else {
            Some(unsafe { CFType::wrap_under_create_rule(result) })
        };
        if status != errSecSuccess {
            return Err("Credential authentication cancelled, locked or unavailable; enrollment changes require re-entry".into());
        }
        result.ok_or("Keychain returned no credential data".into())
    }
    pub fn get(
        &self,
        service: &str,
        key: &str,
        biometric: bool,
        auth_epoch: u64,
    ) -> Result<Option<String>> {
        if auth_epoch < self.epoch.load(Ordering::Acquire) {
            return Err("Credential authentication cancelled".into());
        }
        if !biometric && !legacy_exists(service, &marker(key))? {
            return crate::read_ordinary(service, key, "Cannot read ordinary Keychain credentials");
        }
        if !protected_exists(service, key)? {
            return Err(
                "Protected credentials require re-entry after enrollment or policy changes".into(),
            );
        }
        let context = self.context(auth_epoch)?;
        let result = self.copy_data(service, key, &context)?;
        let data = result
            .downcast::<CFData>()
            .ok_or("Keychain returned invalid credential data")?;
        let _delivery = self
            .active
            .lock()
            .map_err(|_| "Credential authentication lock failed")?;
        self.check_context(&context)?;
        String::from_utf8(data.bytes().to_vec())
            .map(Some)
            .map_err(|_| "Keychain returned invalid credential encoding".to_string())
    }
    pub fn set(
        &self,
        service: &str,
        key: &str,
        value: &str,
        biometric: bool,
        auth_epoch: u64,
    ) -> Result<()> {
        if auth_epoch < self.epoch.load(Ordering::Acquire) {
            return Err("Credential authentication cancelled".into());
        }
        if !biometric {
            if legacy_exists(service, &marker(key))? {
                return Err("Forget protected credentials before disabling biometrics".into());
            }
            return keyring::Entry::new(service, key)
                .map_err(|_| "OS credential store unavailable")?
                .set_password(value)
                .map_err(|_| "Cannot save ordinary Keychain credentials".into());
        }
        if !self.capability(service)?.available {
            return Err("Touch ID or protected Keychain is unavailable".into());
        }
        if legacy_exists(service, key)? {
            return Err("Forget ordinary credentials before enabling biometric protection".into());
        }
        // Keep a nonsecret routing marker before publishing any protected data, including interrupted saves.
        keyring::Entry::new(service, &marker(key))
            .map_err(|_| "OS credential store unavailable")?
            .set_password("biometric-v1")
            .map_err(|_| "Cannot record biometric credential policy")?;
        let context = self.context(auth_epoch)?;
        if protected_exists(service, key)? {
            drop(self.copy_data(service, key, &context)?);
        }
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            AccessControlOptions::BIOMETRY_CURRENT_SET.bits(),
        )
        .map_err(|_| "Cannot create biometric Keychain access control")?;
        let mut lookup = self.authenticated_query(service, key, &context);
        unsafe {
            context.context.setInteractionNotAllowed(true);
        }
        lookup.push((
            constant(unsafe { kSecUseAuthenticationUI }),
            constant(unsafe { kSecUseAuthenticationUIFail }).into_CFType(),
        ));
        let data = CFData::from_buffer(value.as_bytes());
        let mut insert = lookup.clone();
        insert.push((
            constant(unsafe { kSecAttrAccessControl }),
            access.into_CFType(),
        ));
        insert.push((
            constant(unsafe { kSecValueData }),
            data.clone().into_CFType(),
        ));
        let insert = CFDictionary::from_CFType_pairs(&insert);
        // The authenticated, UI-free commit and success result serialize with native cancellation.
        let _commit = self
            .active
            .lock()
            .map_err(|_| "Credential authentication lock failed")?;
        self.check_context(&context)?;
        let mut status = unsafe { SecItemAdd(insert.as_concrete_TypeRef(), std::ptr::null_mut()) };
        if status == errSecDuplicateItem {
            let lookup = CFDictionary::from_CFType_pairs(&lookup);
            let update = CFDictionary::from_CFType_pairs(&[(
                constant(unsafe { kSecValueData }),
                data.into_CFType(),
            )]);
            status = unsafe {
                SecItemUpdate(lookup.as_concrete_TypeRef(), update.as_concrete_TypeRef())
            };
        }
        if status != errSecSuccess {
            return Err("Cannot save protected Keychain credentials".into());
        }
        Ok(())
    }
    pub fn delete(&self, service: &str, key: &str) -> Result<()> {
        if !legacy_exists(service, &marker(key))? {
            return legacy_delete(service, key);
        }
        let dictionary = CFDictionary::from_CFType_pairs(&query(service, key));
        let status = unsafe { SecItemDelete(dictionary.as_concrete_TypeRef()) };
        if status != errSecSuccess && status != errSecItemNotFound {
            return Err("Cannot delete protected Keychain credentials".into());
        }
        legacy_delete(service, key)?;
        legacy_delete(service, &marker(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_queries_use_an_isolated_local_data_protection_keychain() {
        let fields = query("app.lazysh.fixture.credentials", "host;literal");
        let field = |name| {
            fields
                .iter()
                .find(|(key, _)| *key == constant(name))
                .unwrap()
                .1
                .clone()
        };
        assert_eq!(
            field(unsafe { kSecAttrService })
                .downcast::<CFString>()
                .unwrap()
                .to_string(),
            "app.lazysh.fixture.credentials.biometric"
        );
        assert_eq!(
            field(unsafe { kSecAttrAccount })
                .downcast::<CFString>()
                .unwrap()
                .to_string(),
            "host;literal"
        );
        assert_eq!(
            field(unsafe { kSecUseDataProtectionKeychain })
                .downcast::<CFBoolean>()
                .unwrap(),
            CFBoolean::from(true)
        );
        assert_eq!(
            field(unsafe { kSecAttrSynchronizable })
                .downcast::<CFBoolean>()
                .unwrap(),
            CFBoolean::from(false)
        );
        assert!(!fields
            .iter()
            .any(|(key, _)| *key == constant(unsafe { kSecReturnData })));
    }

    #[test]
    fn cancellation_invalidates_a_fresh_context_without_authenticating_or_accessing_credentials() {
        let vault = MacVault::default();
        let context = vault.context(0).unwrap();
        assert_eq!(
            unsafe {
                context
                    .context
                    .touchIDAuthenticationAllowableReuseDuration()
            },
            0.0
        );
        assert!(vault.context(0).is_err());
        vault.check_context(&context).unwrap();
        vault.cancel(1).unwrap();
        assert!(vault.check_context(&context).is_err());
        drop(context);
        assert!(vault.context(0).is_err());
        let next = vault.context(1).unwrap();
        vault.cancel(1).unwrap();
        vault.check_context(&next).unwrap();
    }

    #[test]
    fn cancellation_acknowledgement_waits_for_an_already_started_commit_section() {
        let vault = std::sync::Arc::new(MacVault::default());
        let context = vault.context(0).unwrap();
        let commit = vault.active.lock().unwrap();
        let (started, waiting) = std::sync::mpsc::channel();
        let (ack, acknowledged) = std::sync::mpsc::channel();
        let worker_vault = vault.clone();
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            worker_vault.cancel(1).unwrap();
            ack.send(()).unwrap();
        });
        waiting.recv().unwrap();
        vault.check_context(&context).unwrap();
        assert!(acknowledged.try_recv().is_err());
        drop(commit);
        acknowledged.recv().unwrap();
        worker.join().unwrap();
        assert!(vault.check_context(&context).is_err());
    }
}
