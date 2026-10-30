//! Native foreground authority. Transport lifetimes outlive individual command leases.
use serde::Serialize;
use std::{
    fmt,
    future::Future,
    sync::{Arc, Mutex},
};
use tauri::ipc::{InvokeResponseBody, IpcResponse};
use tokio::sync::watch;

pub const HEADER: &str = "X-Lazysh-Access";
#[derive(Debug, Clone)]
pub struct AccessError;
impl fmt::Display for AccessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("App access is locked or this operation belongs to an earlier unlock")
    }
}
impl std::error::Error for AccessError {}
impl From<AccessError> for String {
    fn from(value: AccessError) -> Self {
        value.to_string()
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessStatus {
    pub initialized: bool,
    pub supported: bool,
    pub reason: String,
    pub enabled: bool,
    pub locked: bool,
    pub generation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}
struct Inner {
    initialized: bool,
    supported: bool,
    reason: String,
    enabled: bool,
    locked: bool,
    foreground: bool,
    background_epoch: u64,
    generation: u64,
    nonce: Option<String>,
    ui_ready: bool,
    require_nonce: bool,
    replacing: bool,
}
impl Inner {
    fn transport_output_ready(&self) -> bool {
        self.initialized
            && !self.replacing
            && self.ui_ready
            && self.foreground
            && (!self.enabled || !self.locked)
    }
    fn accepts_proof(&self, expected: u64) -> bool {
        self.initialized
            && !self.replacing
            && self.supported
            && self.foreground
            && self.generation == expected
    }
}
#[derive(Clone)]
pub struct AccessState {
    inner: Arc<Mutex<Inner>>,
    changed: watch::Sender<u64>,
}
impl Default for AccessState {
    fn default() -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            inner: Arc::new(Mutex::new(Inner {
                initialized: false,
                supported: false,
                reason: "Native resume protection is initializing".into(),
                enabled: false,
                locked: true,
                foreground: true,
                background_epoch: 0,
                generation: 0,
                nonce: None,
                ui_ready: false,
                require_nonce: false,
                replacing: false,
            })),
            changed,
        }
    }
}
fn new_nonce() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
impl AccessState {
    pub fn disabled() -> Self {
        let value = Self::default();
        value
            .initialize(
                false,
                false,
                "Resume protection is unavailable on this platform".into(),
            )
            .expect("new authority");
        value
    }
    fn advance(&self, inner: &mut Inner) {
        inner.generation = inner.generation.wrapping_add(1);
        inner.nonce = None;
        self.changed.send_replace(inner.generation);
    }
    pub fn initialize(
        &self,
        supported: bool,
        enabled: bool,
        reason: String,
    ) -> Result<(), AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        if i.initialized {
            return Err(AccessError);
        }
        i.initialized = true;
        i.supported = supported;
        i.reason = reason;
        i.enabled = enabled;
        i.require_nonce |= enabled;
        i.locked = enabled;
        i.ui_ready = !enabled && !i.require_nonce && !i.replacing;
        self.advance(&mut i);
        if !enabled && i.require_nonce {
            i.nonce = Some(new_nonce());
        }
        Ok(())
    }
    pub fn status(&self) -> Result<AccessStatus, AccessError> {
        let i = self.inner.lock().map_err(|_| AccessError)?;
        Ok(AccessStatus {
            initialized: i.initialized && !i.replacing,
            supported: i.supported,
            reason: i.reason.clone(),
            enabled: i.enabled,
            locked: i.locked || !i.initialized || i.replacing,
            generation: i.generation.to_string(),
            nonce: if i.initialized && !i.replacing && !i.locked && (!i.enabled || i.foreground) {
                i.nonce.clone()
            } else {
                None
            },
        })
    }
    pub fn policy_enabled(&self) -> Option<bool> {
        self.inner
            .lock()
            .ok()
            .and_then(|i| i.initialized.then_some(i.enabled))
    }
    pub fn is_locked(&self) -> bool {
        self.inner
            .lock()
            .map(|i| {
                !i.initialized
                    || i.replacing
                    || !i.ui_ready
                    || (i.enabled && (i.locked || !i.foreground))
            })
            .unwrap_or(true)
    }
    pub fn generation(&self) -> Result<u64, AccessError> {
        Ok(self.inner.lock().map_err(|_| AccessError)?.generation)
    }
    pub fn background(&self) -> Result<(), AccessError> {
        self.background_with(|_| {}).map(|_| ())
    }
    /// Install the cancellation barrier atomically before foreground authorization is revoked.
    pub fn background_with(&self, barrier: impl FnOnce(bool)) -> Result<bool, AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        let protected = i.enabled;
        barrier(protected);
        if i.foreground {
            i.background_epoch = i.background_epoch.wrapping_add(1);
        }
        i.foreground = false;
        if protected {
            self.lock_inner(&mut i);
        } else {
            self.changed.send_replace(i.generation);
        }
        Ok(protected)
    }
    pub fn foreground(&self) -> Result<(), AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        i.foreground = true;
        self.changed.send_replace(i.generation);
        Ok(())
    }
    pub fn lock(&self) -> Result<(), AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        if i.enabled {
            self.lock_inner(&mut i);
        }
        Ok(())
    }
    fn lock_inner(&self, i: &mut Inner) {
        i.locked = true;
        i.ui_ready = false;
        self.advance(i);
    }
    /// Only call after the dedicated protected read succeeds for this captured generation.
    pub fn authorize(&self, expected: u64) -> Result<(), AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        if !i.accepts_proof(expected) || !i.enabled {
            return Err(AccessError);
        }
        self.advance(&mut i);
        i.locked = false;
        i.ui_ready = false;
        i.require_nonce = true;
        i.nonce = Some(new_nonce());
        Ok(())
    }
    pub fn prepare_enable(&self, expected: u64) -> Result<u64, AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        if !i.accepts_proof(expected) || i.locked || i.enabled {
            return Err(AccessError);
        }
        self.advance(&mut i);
        i.enabled = true;
        i.require_nonce = true;
        i.locked = true;
        i.ui_ready = false;
        Ok(i.generation)
    }
    /// Reconcile a completed native policy mutation or failed enrollment with OS item presence.
    pub fn reconcile_policy(&self, enabled: bool) -> Result<(), AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        if !i.initialized {
            return Err(AccessError);
        }
        self.advance(&mut i);
        i.enabled = enabled;
        i.require_nonce |= enabled;
        i.locked = enabled;
        i.ui_ready = false;
        if !enabled && i.require_nonce {
            i.nonce = Some(new_nonce());
        }
        Ok(())
    }
    pub fn configure_after_proof(&self, expected: u64, enabled: bool) -> Result<(), AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        if !i.accepts_proof(expected) {
            return Err(AccessError);
        }
        self.advance(&mut i);
        i.enabled = enabled;
        i.require_nonce |= enabled;
        i.locked = false;
        i.ui_ready = false;
        i.nonce = (enabled || i.require_nonce).then(new_nonce);
        Ok(())
    }
    pub fn ready(&self, expected: u64) -> Result<(), AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        if !i.initialized
            || i.replacing
            || i.generation != expected
            || (i.enabled && (i.locked || !i.foreground))
        {
            return Err(AccessError);
        }
        i.ui_ready = true;
        self.changed.send_replace(i.generation);
        Ok(())
    }
    pub fn replace_renderer(&self) -> Result<(), AccessError> {
        self.replace_renderer_with(|| {})
    }
    pub fn replace_renderer_with(&self, barrier: impl FnOnce()) -> Result<(), AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        barrier();
        self.advance(&mut i);
        i.replacing = true;
        i.require_nonce = true;
        i.locked = i.enabled;
        i.ui_ready = false;
        i.foreground = false;
        Ok(())
    }
    pub fn finish_renderer_replacement(&self) -> Result<bool, AccessError> {
        self.finish_renderer_replacement_if(|| true)
    }
    pub fn finish_renderer_replacement_if(
        &self,
        completed: impl FnOnce() -> bool,
    ) -> Result<bool, AccessError> {
        let mut i = self.inner.lock().map_err(|_| AccessError)?;
        if !i.replacing || !completed() {
            return Ok(false);
        }
        self.advance(&mut i);
        i.replacing = false;
        i.locked = i.enabled;
        i.ui_ready = false;
        i.nonce = (!i.enabled).then(new_nonce);
        self.changed.send_replace(i.generation);
        Ok(true)
    }
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }
    pub fn background_epoch(&self) -> Result<u64, AccessError> {
        Ok(self.inner.lock().map_err(|_| AccessError)?.background_epoch)
    }
    pub async fn wait_transport_output(&self) -> Result<(), AccessError> {
        let mut changes = self.subscribe();
        loop {
            if self.with_transport_output(|| ()).is_ok() {
                return Ok(());
            }
            changes.changed().await.map_err(|_| AccessError)?;
        }
    }
    pub fn with_transport_output<T>(&self, action: impl FnOnce() -> T) -> Result<T, AccessError> {
        let inner = self.inner.lock().map_err(|_| AccessError)?;
        if !inner.transport_output_ready() {
            return Err(AccessError);
        }
        Ok(action())
    }
    pub async fn wait_unlocked(&self) -> Result<(), AccessError> {
        let mut changes = self.subscribe();
        loop {
            if !self.is_locked() {
                return Ok(());
            }
            changes.changed().await.map_err(|_| AccessError)?;
        }
    }
    pub fn with_unlocked<T>(&self, action: impl FnOnce() -> T) -> Result<T, AccessError> {
        let i = self.inner.lock().map_err(|_| AccessError)?;
        if !i.initialized
            || i.replacing
            || !i.ui_ready
            || (i.enabled && (i.locked || !i.foreground))
        {
            return Err(AccessError);
        }
        Ok(action())
    }
    pub fn lease(&self, nonce: Option<&str>) -> Result<AccessLease, AccessError> {
        let i = self.inner.lock().map_err(|_| AccessError)?;
        let nonce = nonce.filter(|value| !value.is_empty());
        let matching = if i.enabled || i.require_nonce {
            nonce.is_some() && nonce == i.nonce.as_deref()
        } else {
            nonce.is_none()
        };
        if !i.initialized || i.replacing || (i.enabled && (i.locked || !i.foreground)) || !matching
        {
            return Err(AccessError);
        }
        Ok(AccessLease {
            state: self.clone(),
            generation: i.generation,
            nonce: i.nonce.clone(),
        })
    }
}
#[derive(Clone)]
pub struct AccessLease {
    state: AccessState,
    generation: u64,
    nonce: Option<String>,
}
impl AccessLease {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn state(&self) -> AccessState {
        self.state.clone()
    }
    fn valid(&self, i: &Inner) -> bool {
        i.initialized
            && !i.replacing
            && i.generation == self.generation
            && self.nonce == i.nonce
            && (!i.enabled || (!i.locked && i.foreground))
    }
    pub fn check(&self) -> Result<(), AccessError> {
        let i = self.state.inner.lock().map_err(|_| AccessError)?;
        if self.valid(&i) {
            Ok(())
        } else {
            Err(AccessError)
        }
    }
    pub fn with_transport_output<T>(
        &self,
        adopted: &std::sync::atomic::AtomicBool,
        action: impl FnOnce() -> T,
    ) -> Result<T, AccessError> {
        let inner = self.state.inner.lock().map_err(|_| AccessError)?;
        if !inner.transport_output_ready()
            || (!adopted.load(std::sync::atomic::Ordering::SeqCst) && !self.valid(&inner))
        {
            return Err(AccessError);
        }
        Ok(action())
    }
    pub fn with_current<T>(&self, action: impl FnOnce() -> T) -> Result<T, AccessError> {
        let i = self.state.inner.lock().map_err(|_| AccessError)?;
        if !self.valid(&i) {
            return Err(AccessError);
        }
        Ok(action())
    }
    pub async fn cancelled(&self) {
        let mut changes = self.state.subscribe();
        while self.check().is_ok() {
            if changes.changed().await.is_err() {
                break;
            }
        }
    }
    pub fn guard<T>(&self, value: T) -> Result<Guarded<T>, AccessError> {
        self.check()?;
        Ok(Guarded {
            value,
            lease: self.clone(),
        })
    }
    pub fn error<E>(&self, error: E) -> GuardedError<E> {
        GuardedError {
            error: Some(Box::new(error)),
            lease: Some(self.clone()),
        }
    }
    pub fn run_sync<T, E>(
        &self,
        action: impl FnOnce() -> Result<T, E>,
    ) -> Result<Guarded<T>, GuardedError<E>> {
        self.check().map_err(GuardedError::from)?;
        match action() {
            Ok(value) => self.guard(value).map_err(GuardedError::from),
            Err(error) => Err(self.error(error)),
        }
    }
    pub async fn run<T, E>(
        &self,
        future: impl Future<Output = Result<T, E>>,
    ) -> Result<Guarded<T>, GuardedError<E>> {
        self.check().map_err(GuardedError::from)?;
        let result = tokio::select! {biased;_=self.cancelled()=>return Err(GuardedError::from(AccessError)),result=future=>result};
        match result {
            Ok(value) => self.guard(value).map_err(GuardedError::from),
            Err(error) => Err(self.error(error)),
        }
    }
}
pub struct GuardedError<E> {
    error: Option<Box<E>>,
    lease: Option<AccessLease>,
}
impl<E> GuardedError<E> {
    pub fn into_inner(self) -> Result<E, AccessError> {
        if let (Some(lease), Some(error)) = (self.lease, self.error) {
            lease.check()?;
            Ok(*error)
        } else {
            Err(AccessError)
        }
    }
}
impl<E> From<AccessError> for GuardedError<E> {
    fn from(_: AccessError) -> Self {
        Self {
            error: None,
            lease: None,
        }
    }
}
impl<E> fmt::Display for GuardedError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Protected operation failed or app access changed")
    }
}
impl<E> fmt::Debug for GuardedError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl<E: Serialize> Serialize for GuardedError<E> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let (Some(lease), Some(error)) = (&self.lease, &self.error) {
            if let Ok(inner) = lease.state.inner.lock() {
                if lease.valid(&inner) {
                    return error.serialize(serializer);
                }
            }
        }
        serializer
            .serialize_str("App access is locked or this operation belongs to an earlier unlock")
    }
}
pub struct Guarded<T> {
    value: T,
    lease: AccessLease,
}
impl<T> fmt::Debug for Guarded<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Protected response")
    }
}
impl<T> Guarded<T> {
    pub fn into_inner(self) -> Result<T, AccessError> {
        self.lease.check()?;
        Ok(self.value)
    }
}
impl<T: IpcResponse> IpcResponse for Guarded<T> {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        self.lease
            .with_current(|| self.value.body())
            .map_err(|error| {
                tauri::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    error,
                ))
            })?
    }
}
impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for AccessLease {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        use tauri::Manager;
        let vault = command
            .message
            .webview_ref()
            .try_state::<crate::Vault<R>>()
            .ok_or_else(|| tauri::ipc::InvokeError::from(AccessError.to_string()))?;
        let nonce = command
            .message
            .headers()
            .get(HEADER)
            .and_then(|value| value.to_str().ok());
        vault
            .access()
            .lease(nonce)
            .map_err(|error| tauri::ipc::InvokeError::from(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_nonce_and_leases_never_freshen_across_unlock() {
        let s = AccessState::default();
        s.initialize(true, true, "test".into()).unwrap();
        let g = s.generation().unwrap();
        s.authorize(g).unwrap();
        let n = s.status().unwrap().nonce.unwrap();
        let l = s.lease(Some(&n)).unwrap();
        let response = l.guard("secret").unwrap();
        let error = l.error("synthetic private stderr");
        assert!(serde_json::to_string(&error)
            .unwrap()
            .contains("synthetic private stderr"));
        s.background().unwrap();
        assert!(l.check().is_err());
        assert!(response.body().is_err());
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("synthetic private stderr"));
        assert!(!format!("{error} {error:?}").contains("synthetic private stderr"));
        s.foreground().unwrap();
        s.authorize(s.generation().unwrap()).unwrap();
        assert!(s.lease(Some(&n)).is_err());
        assert!(s.lease(None).is_err());
        assert!(l.check().is_err());
    }
    #[tokio::test]
    async fn outputs_wait_for_ui_ack_and_resume_without_consuming_indices() {
        let s = AccessState::default();
        s.initialize(true, true, "test".into()).unwrap();
        s.authorize(s.generation().unwrap()).unwrap();
        assert!(s.is_locked());
        assert!(s.with_unlocked(|| ()).is_err());
        let gen = s.generation().unwrap();
        s.ready(gen).unwrap();
        assert!(s.wait_unlocked().await.is_ok());
        assert_eq!(s.with_unlocked(|| 7).unwrap(), 7);
        s.background().unwrap();
        assert!(s.ready(gen).is_err());
    }
    #[tokio::test]
    async fn background_output_pauses_without_replacing_disabled_lock_authority() {
        let state = AccessState::disabled();
        let lease = state.lease(None).unwrap();
        let generation = state.generation().unwrap();
        let background = state.background_epoch().unwrap();
        state.background().unwrap();
        assert!(!state.is_locked());
        assert_eq!(state.generation().unwrap(), generation);
        assert!(lease.check().is_ok());
        assert_eq!(state.with_unlocked(|| 7).unwrap(), 7);
        assert!(state.with_transport_output(|| 7).is_err());
        let adopted = std::sync::atomic::AtomicBool::new(true);
        assert!(lease.with_transport_output(&adopted, || 7).is_err());
        assert_ne!(state.background_epoch().unwrap(), background);
        let waiting = state.clone();
        let output = tokio::spawn(async move { waiting.wait_transport_output().await });
        tokio::task::yield_now().await;
        assert!(!output.is_finished());
        state.foreground().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), output)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(state.with_transport_output(|| 7).unwrap(), 7);
        assert!(lease.check().is_ok());
    }
    #[tokio::test]
    async fn cancellation_interrupts_an_outstanding_read() {
        let s = AccessState::disabled();
        let lease = s.lease(None).unwrap();
        let scope = s.clone();
        let work =
            tokio::spawn(async move { lease.run::<(), String>(std::future::pending()).await });
        scope.initialize(false, false, "again".into()).unwrap_err();
        scope.inner.lock().unwrap().enabled = true;
        scope.background().unwrap();
        assert!(work.await.unwrap().is_err());
    }
    #[test]
    fn staged_enable_blocks_old_access_and_failure_uses_actual_proof_presence() {
        let state = AccessState::default();
        state.initialize(true, false, "synthetic".into()).unwrap();
        let old = state.lease(None).unwrap();
        let expected = state.generation().unwrap();
        let staged = state.prepare_enable(expected).unwrap();
        assert!(old.check().is_err());
        assert!(state.is_locked());
        assert_eq!(state.policy_enabled(), Some(true));
        state.reconcile_policy(false).unwrap();
        assert_eq!(state.policy_enabled(), Some(false));
        assert!(state.is_locked());
        state.ready(state.generation().unwrap()).unwrap();
        assert!(!state.is_locked());
        assert!(state.configure_after_proof(staged, true).is_err());
        let expected = state.generation().unwrap();
        state.prepare_enable(expected).unwrap();
        state.reconcile_policy(true).unwrap();
        assert!(state.is_locked());
        assert!(state.status().unwrap().nonce.is_none());
    }
    #[test]
    fn disabled_renderer_replacement_revokes_empty_headers_until_fresh_ui_ready() {
        let state = AccessState::disabled();
        let old = state.lease(None).unwrap();
        state.replace_renderer().unwrap();
        let generation = state.generation().unwrap();
        assert!(old.check().is_err());
        assert!(state.lease(None).is_err());
        assert!(state.ready(generation).is_err());
        assert!(!state.status().unwrap().initialized);
        assert!(state.with_unlocked(|| ()).is_err());
        assert!(!state.finish_renderer_replacement_if(|| false).unwrap());
        assert!(!state.status().unwrap().initialized);
        assert!(state.finish_renderer_replacement().unwrap());
        assert!(state.generation().unwrap() > generation);
        assert!(state.ready(generation).is_err());
        assert!(!state.finish_renderer_replacement().unwrap());
        assert!(state.lease(None).is_err());
        let nonce = state.status().unwrap().nonce.unwrap();
        assert!(state.lease(Some(&nonce)).is_ok());
        assert!(old.check().is_err());
        assert!(state.with_unlocked(|| ()).is_err());
        state.ready(state.generation().unwrap()).unwrap();
        assert!(state.with_unlocked(|| ()).is_ok());
    }
    #[test]
    fn disabling_policy_does_not_revive_old_empty_or_authenticated_headers() {
        let state = AccessState::default();
        state.initialize(true, false, "synthetic".into()).unwrap();
        let empty = state.lease(None).unwrap();
        let staged = state.prepare_enable(state.generation().unwrap()).unwrap();
        state.configure_after_proof(staged, true).unwrap();
        let nonce = state.status().unwrap().nonce.unwrap();
        state
            .configure_after_proof(state.generation().unwrap(), false)
            .unwrap();
        assert!(empty.check().is_err());
        assert!(state.lease(None).is_err());
        assert!(state.lease(Some(&nonce)).is_err());
        let fresh = state.status().unwrap().nonce.unwrap();
        assert!(state.lease(Some(&fresh)).is_ok());
    }
    #[test]
    fn unsupported_has_no_enable_or_unlock_fallback() {
        let s = AccessState::disabled();
        assert!(s.authorize(s.generation().unwrap()).is_err());
        assert!(s
            .configure_after_proof(s.generation().unwrap(), true)
            .is_err());
        assert!(s.lease(None).is_ok());
    }
}
