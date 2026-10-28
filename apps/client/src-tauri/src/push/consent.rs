//! One private native dialog permit; it never enters an IPC response.
use crate::app_lock::AccessLease;
use std::sync::Mutex;

struct Authority(Mutex<Option<(String, AccessLease)>>);
static AUTHORITY: Authority = Authority(Mutex::new(None));

pub(super) struct Permit<'a> {
    authority: &'a Authority,
    pub(super) token: String,
}
impl Authority {
    fn register(&self, access: AccessLease) -> Result<Permit<'_>, String> {
        access
            .check()
            .map_err(|_| "Notification consent access expired")?;
        let token = uuid::Uuid::new_v4().to_string();
        *self
            .0
            .lock()
            .map_err(|_| "Notification consent unavailable")? = Some((token.clone(), access));
        Ok(Permit {
            authority: self,
            token,
        })
    }
    #[cfg(any(test, all(target_os = "android", feature = "fdroid")))]
    fn commit(&self, token: &str, action: impl FnOnce() -> bool) -> bool {
        let Ok(mut pending) = self.0.lock() else {
            return false;
        };
        if !pending
            .as_ref()
            .is_some_and(|(expected, _)| expected == token)
        {
            return false;
        }
        let Some((_, access)) = pending.take() else {
            return false;
        };
        // Ordering: permit -> access -> native registration -> enrollment -> display.
        // No queued plugin/UI dispatch is awaited inside the access monitor. OS
        // Keystore/commit latency is not a wall-clock guarantee.
        let accepted = access.with_current(action).unwrap_or(false);
        drop(pending);
        accepted
    }
}
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.authority.0.lock() {
            if pending
                .as_ref()
                .is_some_and(|(token, _)| token == &self.token)
            {
                *pending = None;
            }
        }
    }
}
pub(super) fn register(access: AccessLease) -> Result<Permit<'static>, String> {
    AUTHORITY.register(access)
}

#[cfg(all(target_os = "android", feature = "fdroid"))]
#[no_mangle]
pub extern "system" fn Java_app_lazysh_unifiedpush_NativeDisplayAuthority_commit(
    mut env: tauri::wry::prelude::JNIEnv<'_>,
    _object: tauri::wry::prelude::JObject<'_>,
    token: tauri::wry::prelude::JString<'_>,
    action: tauri::wry::prelude::JObject<'_>,
) -> tauri::wry::prelude::jboolean {
    let result = (|| {
        if !env
            .is_instance_of(&action, "app/lazysh/unifiedpush/DisplayConsentCommit")
            .ok()?
        {
            return None;
        }
        if env
            .call_method(&token, "length", "()I", &[])
            .ok()?
            .i()
            .ok()?
            != 36
        {
            return None;
        }
        let token: String = env.get_string(&token).ok()?.into();
        if token.len() != 36 {
            return None;
        }
        Some(AUTHORITY.commit(&token, || {
            env.call_method(&action, "run", "()V", &[]).is_ok()
        }))
    })()
    .unwrap_or(false);
    // A native storage/permission exception is a finite failure, never an uncleared
    // Java exception escaping this JNI boundary or a retry of a consumed permit.
    let _ = env.exception_clear();
    u8::from(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_lock::AccessState;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn access() -> (AccessState, AccessLease) {
        let state = AccessState::default();
        state
            .initialize(true, false, "Owned consent authority".into())
            .unwrap();
        let lease = state.lease(None).unwrap();
        (state, lease)
    }
    #[test]
    fn held_dialog_cannot_commit_after_same_activity_policy_advance_and_reunlock() {
        let registry = Authority(Mutex::new(None));
        let (state, original) = access();
        let permit = registry.register(original.clone()).unwrap();
        state
            .configure_after_proof(original.generation(), true)
            .unwrap();
        state
            .configure_after_proof(state.generation().unwrap(), false)
            .unwrap();
        let calls = AtomicUsize::new(0);
        assert!(!registry.commit(&permit.token, || {
            calls.fetch_add(1, Ordering::SeqCst);
            true
        }));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn cancellation_and_supersession_retire_only_the_exact_original_permit() {
        let registry = Authority(Mutex::new(None));
        let (_, access) = access();
        let old = registry.register(access.clone()).unwrap();
        let current = registry.register(access.clone()).unwrap();
        assert!(!registry.commit(&old.token, || panic!("Superseded consent must not execute")));
        drop(old);
        assert!(registry.commit(&current.token, || true));
        assert!(!registry.commit(&current.token, || panic!(
            "Consumed consent must not execute"
        )));
        let cancelled = registry.register(access).unwrap();
        let token = cancelled.token.clone();
        drop(cancelled);
        assert!(!registry.commit(&token, || panic!("Cancelled consent must not execute")));
    }
    #[test]
    fn concurrent_confirmation_consumes_once_even_when_native_commit_fails() {
        let registry = Authority(Mutex::new(None));
        let (_, access) = access();
        let permit = registry.register(access).unwrap();
        let calls = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        registry.commit(&permit.token, || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            false
                        })
                    })
                })
                .collect();
            for worker in workers {
                assert!(!worker.join().unwrap());
            }
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
