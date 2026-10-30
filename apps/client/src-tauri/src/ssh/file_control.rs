//! Explicit, purpose-scoped reauthentication of a live Mosh session's SSH controls.
use super::*;

pub(crate) struct Control {
    original: Option<Host>,
    current: StdMutex<Arc<SshHandle>>,
    commands: StdMutex<Arc<SshHandle>>,
    restoring: Arc<Semaphore>,
}
fn unavailable() -> SshError {
    SshError::new(
        "ssh_control_unavailable",
        "SSH control recovery requires the original verified direct Mosh connection",
    )
}
pub(super) fn same_host(original: &Host, current: &Host) -> Result<()> {
    if original.fingerprint.is_none()
        || original.id != current.id
        || original.credential_binding() != current.credential_binding()
    {
        return Err(SshError::new("ssh_control_host_changed", "The saved host identity or authentication policy changed. Keep the existing terminal and open a new verified connection instead."));
    }
    Ok(())
}
impl Control {
    pub(super) fn new(handle: Arc<SshHandle>) -> Self {
        Self {
            original: handle.origin.clone(),
            current: StdMutex::new(handle.clone()),
            commands: StdMutex::new(handle),
            restoring: Arc::new(Semaphore::new(1)),
        }
    }
    pub(super) fn current(&self) -> Result<Arc<SshHandle>> {
        self.current
            .lock()
            .map(|value| value.clone())
            .map_err(|_| unavailable())
    }
    pub(super) fn command_handle(&self) -> Result<Arc<SshHandle>> {
        self.commands
            .lock()
            .map(|handle| handle.clone())
            .map_err(|_| unavailable())
    }
    pub(super) fn for_shutdown(&self) -> Vec<Arc<SshHandle>> {
        [&self.current, &self.commands]
            .into_iter()
            .map(|slot| {
                slot.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone()
            })
            .collect()
    }
    fn begin(
        &self,
        purpose: Purpose,
    ) -> Result<(tokio::sync::OwnedSemaphorePermit, Arc<SshHandle>, Host)> {
        let permit = self.restoring.clone().try_acquire_owned().map_err(|_| {
            SshError::new(
                "ssh_control_busy",
                "SSH control recovery is already running",
            )
        })?;
        let original = self.original.clone().ok_or_else(unavailable)?;
        if original.jump_host_id.is_some() || original.forward_agent {
            return Err(unavailable());
        }
        let current = match purpose {
            Purpose::Files => self.current()?,
            Purpose::Commands => self.command_handle()?,
        };
        if !current.is_closed() {
            return Err(SshError::new(
                "ssh_control_ready",
                "The selected SSH connection is already available",
            ));
        }
        Ok((permit, current, original))
    }
    #[allow(clippy::too_many_arguments)]
    fn commit_for(
        &self,
        purpose: Purpose,
        expected: &Arc<SshHandle>,
        fresh: Arc<SshHandle>,
        session: &Arc<Session>,
        active: Option<&Arc<Session>>,
        configured: Option<&Host>,
        lease: &AccessLease,
    ) -> Result<()> {
        lease.with_current(|| {
            if *session.cancel.borrow()
                || !active.is_some_and(|current| Arc::ptr_eq(current, session))
            {
                return Err(SshError::new("disconnected", "Session is disconnected"));
            }
            let original = self.original.as_ref().ok_or_else(unavailable)?;
            same_host(original, configured.ok_or_else(unavailable)?)?;
            let slot = match purpose {
                Purpose::Files => &self.current,
                Purpose::Commands => &self.commands,
            };
            let mut current = slot.lock().map_err(|_| unavailable())?;
            if !Arc::ptr_eq(&current, expected) || !current.is_closed() || fresh.is_closed() {
                return Err(unavailable());
            }
            same_host(
                self.original.as_ref().ok_or_else(unavailable)?,
                fresh.origin.as_ref().ok_or_else(unavailable)?,
            )?;
            *current = fresh;
            Ok(())
        })?
    }
}
#[derive(Clone, Copy)]
pub(super) enum Purpose {
    Files,
    Commands,
}
struct Fresh {
    handle: Option<Arc<SshHandle>>,
    retained: Arc<tokio::sync::OwnedSemaphorePermit>,
}
impl Drop for Fresh {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let retained = self.retained.clone();
            tauri::async_runtime::spawn(async move {
                let _retained = retained;
                close_failed_connect(&handle).await;
            });
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    schema_version: u8,
    pub(super) status: &'static str,
}

macro_rules! recovery_command {
    ($name:ident, $purpose:expr) => {
        #[tauri::command]
        #[allow(clippy::too_many_arguments)]
        pub async fn $name(
            lease: AccessLease,
            app: tauri::AppHandle,
            state: State<'_, AppState>,
            session_id: String,
            password: Option<String>,
            private_key: Option<String>,
            passphrase: Option<String>,
            use_saved_credentials: Option<bool>,
        ) -> AccessResult<Restored> {
            lease
                .run(async {
                    let session = state.session(&session_id).await?;
                    let operation = app.vault().operation();
                    restore_for(
                        $purpose,
                        &state,
                        &session_id,
                        &session,
                        &lease,
                        &operation,
                        |original, permit| {
                            let app = app.clone();
                            let state = &*state;
                            let operation = &operation;
                            let lease = &lease;
                            async move {
                                authenticated_connection(
                                    app.clone(),
                                    state,
                                    original.id.clone(),
                                    crate::vault::Credentials {
                                        password,
                                        private_key,
                                        passphrase,
                                    },
                                    use_saved_credentials.unwrap_or(false),
                                    None,
                                    operation,
                                    lease,
                                    None,
                                    Some(&original),
                                    Some(permit),
                                )
                                .await
                            }
                        },
                    )
                    .await
                })
                .await
        }
    };
}
recovery_command!(restore_file_transfer, Purpose::Files);
recovery_command!(restore_host_tools, Purpose::Commands);
pub(super) async fn restore_for<F, Fut>(
    purpose: Purpose,
    state: &AppState,
    id: &str,
    session: &Arc<Session>,
    lease: &AccessLease,
    operation: &CredentialOperation,
    authenticate: F,
) -> Result<Restored>
where
    F: FnOnce(Host, Arc<tokio::sync::OwnedSemaphorePermit>) -> Fut,
    Fut: std::future::Future<Output = Result<AuthenticatedConnection>>,
{
    lease.check()?;
    if *session.cancel.borrow() {
        return Err(SshError::new("disconnected", "Session is disconnected"));
    }
    let control = session.file_control.as_ref().ok_or_else(unavailable)?;
    let (permit, expected, original) = control.begin(purpose)?;
    let permit = Arc::new(permit);
    same_host(&original, &state.host(&original.id)?)?;
    let mut cancelled = session.cancel.subscribe();
    let work = async {
        let auth = authenticate(original, permit.clone()).await?;
        let mut fresh = Fresh {
            handle: Some(auth.handle.clone()),
            retained: permit.clone(),
        };
        match purpose {
            Purpose::Files => timeout(OP_TIMEOUT, async {
                let sftp = SftpSession::new(crate::sftp_stream::SftpStream::new(
                    sftp_channel_for(&auth.handle, lease).await?,
                ))
                .await?;
                timeout(Duration::from_secs(2), sftp.close())
                    .await
                    .map_err(|_| {
                        SshError::new("timeout", "Closing the recovery SFTP probe timed out")
                    })??;
                Ok::<_, SshError>(())
            })
            .await
            .map_err(|_| {
                SshError::new("timeout", "Checking the restored SFTP connection timed out")
            })??,
            Purpose::Commands => {
                let value = exec_inner_with_handle(
                    &auth.handle,
                    "printf lazysh-host-tools".into(),
                    lease,
                    OP_TIMEOUT,
                    64,
                    Some(permit.clone()),
                )
                .await?;
                if value != "lazysh-host-tools" {
                    return Err(SshError::new(
                        "invalid_output",
                        "Invalid host-tools probe response",
                    ));
                }
            }
        };
        let active = state.sessions.lock().await;
        let config = state.config()?;
        operation.check().map_err(|_| connection_cancelled())?;
        control.commit_for(
            purpose,
            &expected,
            auth.handle,
            session,
            active.get(id),
            config.hosts.iter().find(|host| {
                Some(host.id.as_str())
                    == control
                        .original
                        .as_ref()
                        .map(|original| original.id.as_str())
            }),
            lease,
        )?;
        fresh.handle.take();
        Ok(Restored {
            schema_version: 1,
            status: "restored",
        })
    };
    tokio::select! { biased;
        _ = lease.cancelled() => Err(SshError::new("app_locked", "App access changed")),
        _ = operation.cancelled() => Err(connection_cancelled()),
        _ = cancelled.changed() => Err(SshError::new("disconnected", "Session is disconnected")),
        result = work => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::test_support::{ready_lease, unlocked_access};
    struct Fixture {
        peer: crate::ssh::tests::GuardAdmissionFixture,
        state: AppState,
        _directory: tempfile::TempDir,
        session: Arc<Session>,
        host: Host,
        access: AccessState,
        lease: AccessLease,
    }
    impl Fixture {
        async fn pending_connection(
            &self,
        ) -> (PendingConnection, Arc<client::Handle<HostVerifier>>) {
            let raw = verified_connection(&self.state, &self.host).await.unwrap();
            let observer = raw.handle.clone();
            let permit = Arc::new(
                self.session
                    .file_control
                    .as_ref()
                    .unwrap()
                    .restoring
                    .clone()
                    .try_acquire_owned()
                    .unwrap(),
            );
            (
                PendingConnection {
                    handle: Some(raw),
                    retained: Some(permit),
                },
                observer,
            )
        }
        async fn authenticated(&self, handle: Arc<SshHandle>) -> AuthenticatedConnection {
            AuthenticatedConnection {
                host: self.host.clone(),
                _guard: self.state.credential_guard(&self.host.id).await,
                credentials: crate::vault::Credentials {
                    password: None,
                    private_key: None,
                    passphrase: None,
                },
                handle,
            }
        }
    }
    async fn fixture() -> Fixture {
        let access = unlocked_access();
        let lease = ready_lease(&access);
        let peer = crate::ssh::guard_admission_fixture(lease.clone()).await;
        let host = peer.session.handle.origin.clone().unwrap();
        peer.session
            .handle
            .disconnect(
                russh::Disconnect::ByApplication,
                "owned control closure",
                "",
            )
            .await
            .unwrap();
        wait_closed(&peer.session.handle).await;
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().join("config")).unwrap();
        state.config().unwrap().hosts.push(host.clone());
        let (input, _) = mpsc::channel(1);
        let (cancel, _) = watch::channel(false);
        let mut session = Session::new(
            peer.session.handle.clone(),
            input,
            cancel,
            lease.clone(),
            check_size,
        );
        session.file_control = Some(Control::new(peer.session.handle.clone()));
        let session = Arc::new(session);
        state
            .sessions
            .lock()
            .await
            .insert("owned-mosh".into(), session.clone());
        Fixture {
            peer,
            state,
            _directory: directory,
            session,
            host,
            access,
            lease,
        }
    }
    async fn wait_closed(handle: &SshHandle) {
        timeout(Duration::from_secs(3), async {
            while !handle.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn changed_identity_and_policy_are_rejected_before_authentication() {
        for purpose in [Purpose::Files, Purpose::Commands] {
            let f = fixture().await;
            let operations = tauri_plugin_lazysh_vault::CredentialOperations::default();
            let operation = operations.begin();
            for (field, changed) in crate::ssh::test_support::changed_host_bindings(&f.host) {
                f.state.config().unwrap().hosts[0] = changed;
                let error = restore_for(
                    purpose,
                    &f.state,
                    "owned-mosh",
                    &f.session,
                    &f.lease,
                    &operation,
                    |_, _| async { panic!("changed host must not reach authentication") },
                )
                .await
                .unwrap_err();
                assert_eq!(
                    error.kind(),
                    if field == "id" {
                        "missing_host"
                    } else {
                        "ssh_control_host_changed"
                    },
                    "{field}"
                );
            }
            f.state.config().unwrap().hosts[0] = f.host.clone();
            let control = Control {
                original: None,
                current: StdMutex::new(f.session.handle.clone()),
                commands: StdMutex::new(f.session.handle.clone()),
                restoring: Arc::new(Semaphore::new(1)),
            };
            assert_eq!(
                control.begin(purpose).err().unwrap().kind(),
                "ssh_control_unavailable"
            );
        }
    }
    #[tokio::test]
    async fn cancellation_and_lost_caller_close_fresh_transport_and_retire_singleflight() {
        for (purpose, mode) in [Purpose::Files, Purpose::Commands]
            .into_iter()
            .flat_map(|purpose| {
                ["lock", "disconnect", "credential-cancel", "drop"]
                    .into_iter()
                    .map(move |mode| (purpose, mode))
            })
        {
            let f = fixture().await;
            let fresh = f.peer.reconnect().await;
            f.peer.hold();
            let auth = f.authenticated(fresh.clone()).await;
            let operations = tauri_plugin_lazysh_vault::CredentialOperations::default();
            let operation = operations.begin();
            let mut pending = Box::pin(restore_for(
                purpose,
                &f.state,
                "owned-mosh",
                &f.session,
                &f.lease,
                &operation,
                |_, _| std::future::ready(Ok(auth)),
            ));
            tokio::select! { _=f.peer.opened()=>{}, result=&mut pending=>panic!("probe ended before held opening: {result:?}") }
            let duplicate = restore_for(
                match purpose {
                    Purpose::Files => Purpose::Commands,
                    Purpose::Commands => Purpose::Files,
                },
                &f.state,
                "owned-mosh",
                &f.session,
                &f.lease,
                &operation,
                |_, _| async { panic!("duplicate restore cannot authenticate") },
            )
            .await
            .unwrap_err();
            assert_eq!(duplicate.kind(), "ssh_control_busy");
            if mode == "drop" {
                drop(pending);
            } else {
                if mode == "lock" {
                    f.access.lock().unwrap();
                } else if mode == "credential-cancel" {
                    operations.cancel();
                } else {
                    f.session.cancel.send_replace(true);
                }
                let error = pending.await.unwrap_err();
                assert_eq!(
                    error.kind(),
                    if mode == "lock" {
                        "app_locked"
                    } else if mode == "credential-cancel" {
                        "cancelled"
                    } else {
                        "disconnected"
                    }
                );
            }
            wait_closed(&fresh).await;
            f.peer.release().await;
            let control = f.session.file_control.as_ref().unwrap();
            assert!(Arc::ptr_eq(&control.current().unwrap(), &f.session.handle));
            assert!(Arc::ptr_eq(
                &control.command_handle().unwrap(),
                &f.session.handle
            ));
            timeout(Duration::from_secs(3), async {
                loop {
                    if control.restoring.clone().try_acquire_owned().is_ok() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }
    #[tokio::test]
    async fn rejected_sftp_probe_never_publishes_and_closes_fresh_control() {
        let f = fixture().await;
        let fresh = f.peer.reconnect().await;
        let auth = f.authenticated(fresh.clone()).await;
        let operations = tauri_plugin_lazysh_vault::CredentialOperations::default();
        let operation = operations.begin();
        assert!(restore_for(
            Purpose::Files,
            &f.state,
            "owned-mosh",
            &f.session,
            &f.lease,
            &operation,
            |_, _| std::future::ready(Ok(auth))
        )
        .await
        .is_err());
        wait_closed(&fresh).await;
        assert!(Arc::ptr_eq(
            &f.session.file_control.as_ref().unwrap().current().unwrap(),
            &f.session.handle
        ));
    }
    #[tokio::test]
    async fn stale_pointer_removed_session_and_renderer_retirement_preserve_control_ownership() {
        for purpose in [Purpose::Files, Purpose::Commands] {
            let f = fixture().await;
            let fresh = f.peer.reconnect().await;
            let control = f.session.file_control.as_ref().unwrap();
            let active = f.state.sessions.lock().await;
            assert!(control
                .commit_for(
                    purpose,
                    &fresh,
                    fresh.clone(),
                    &f.session,
                    active.get("owned-mosh"),
                    Some(&f.host),
                    &f.lease
                )
                .is_err());
            drop(active);
            f.state.sessions.lock().await.remove("owned-mosh");
            let active = f.state.sessions.lock().await;
            assert_eq!(
                control
                    .commit_for(
                        purpose,
                        &f.session.handle,
                        fresh.clone(),
                        &f.session,
                        active.get("owned-mosh"),
                        Some(&f.host),
                        &f.lease
                    )
                    .unwrap_err()
                    .kind(),
                "disconnected"
            );
            drop(active);
            f.state
                .sessions
                .lock()
                .await
                .insert("owned-mosh".into(), f.session.clone());
            let active = f.state.sessions.lock().await;
            control
                .commit_for(
                    purpose,
                    &f.session.handle,
                    fresh.clone(),
                    &f.session,
                    active.get("owned-mosh"),
                    Some(&f.host),
                    &f.lease,
                )
                .unwrap();
            drop(active);
            f.session.finished.send_replace(true);
            f.state.cancel_for_renderer_rebind().await;
            wait_closed(&fresh).await;
            assert!(*f.session.cancel.borrow());
        }
    }
    #[tokio::test]
    async fn cancellation_during_explicit_cleanup_retains_handle_and_singleflight() {
        use std::{future::Future, task::Context};
        let f = fixture().await;
        let (mut pending, observed) = f.pending_connection().await;
        // This current-thread runtime cannot drain russh's bounded sender until
        // we yield. Fill it with harmless keepalives, never disconnect messages.
        let mut context = Context::from_waker(std::task::Waker::noop());
        let mut blocked = false;
        for _ in 0..64 {
            let mut fill = Box::pin(observed.send_keepalive(false));
            match fill.as_mut().poll(&mut context) {
                std::task::Poll::Ready(Ok(())) => {}
                std::task::Poll::Pending => {
                    blocked = true;
                    break;
                }
                other => panic!("owned sender failed before saturation: {other:?}"),
            }
        }
        assert!(blocked, "owned bounded transport sender must be saturated");
        let mut closing = Box::pin(pending.close());
        assert!(closing.as_mut().poll(&mut context).is_pending());
        drop(closing);
        assert!(f
            .session
            .file_control
            .as_ref()
            .unwrap()
            .restoring
            .clone()
            .try_acquire_owned()
            .is_err());
        drop(pending);
        timeout(Duration::from_secs(3), async {
            while !observed.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn pending_auth_handle_drop_disconnects_even_when_an_observer_retains_transport() {
        let f = fixture().await;
        let (pending, observed) = f.pending_connection().await;
        drop(pending);
        timeout(Duration::from_secs(3), async {
            while !observed.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
