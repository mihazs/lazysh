//! Explicit, purpose-scoped reauthentication of a live Mosh session's SSH controls.
use super::*;

pub(crate) struct Control {
    original: Option<Host>,
    current: StdMutex<Arc<SshHandle>>,
    commands: StdMutex<Arc<SshHandle>>,
    restoring: Arc<Semaphore>,
    automatic_error: StdMutex<Option<SshError>>,
    credential_revision: std::sync::atomic::AtomicU64,
    files_recovery: bool,
}
fn unavailable() -> SshError {
    SshError::new(
        "ssh_control_unavailable",
        "Host-tools recovery requires a direct connection without jump hosts or agent forwarding",
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
pub(super) fn silent_recovery_host(original: &Host, current: &Host) -> Result<()> {
    same_host(original, current)?;
    if original.jump_host_id.is_some() || original.forward_agent {
        return Err(unavailable());
    }
    if !current.credentials_stored || current.biometric_unlock {
        return Err(SshError::new(
            "credentials_required",
            "Automatic host-tools recovery needs saved credentials that do not require a biometric prompt",
        ));
    }
    Ok(())
}
impl Control {
    pub(super) fn note_credentials_changed(&self, host_id: &str) {
        if self
            .original
            .as_ref()
            .is_some_and(|host| host.id == host_id)
        {
            self.credential_revision
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    pub(super) fn new(handle: Arc<SshHandle>) -> Self {
        Self {
            original: handle.origin.clone(),
            current: StdMutex::new(handle.clone()),
            commands: StdMutex::new(handle),
            restoring: Arc::new(Semaphore::new(1)),
            automatic_error: StdMutex::new(None),
            credential_revision: std::sync::atomic::AtomicU64::new(0),
            files_recovery: true,
        }
    }
    pub(super) fn commands_only(handle: Arc<SshHandle>) -> Self {
        let mut control = Self::new(handle);
        control.files_recovery = false;
        control
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
    fn report_automatic(&self, error: Option<SshError>) -> bool {
        if let Ok(mut slot) = self.automatic_error.lock() {
            if slot.as_ref().map(|e| (e.kind(), e.message()))
                == error.as_ref().map(|e| (e.kind(), e.message()))
            {
                return false;
            }
            *slot = error;
            return true;
        }
        false
    }
    pub(super) fn command_unavailable(&self) -> SshError {
        let detail = self
            .automatic_error
            .lock()
            .ok()
            .and_then(|error| error.clone());
        let kind = match detail.as_ref().map(SshError::kind) {
            Some("credentials_required" | "authentication_failed") => "ssh_host_tools_credentials",
            Some("ssh_control_host_changed" | "host_key_changed" | "unknown_host_key") => {
                "ssh_host_tools_host_changed"
            }
            Some("ssh_control_unavailable") => "ssh_host_tools_unsupported",
            Some("missing_host") => "ssh_host_tools_host_missing",
            None | Some("ssh_error" | "timeout" | "disconnected" | "cancelled") => {
                "ssh_host_tools_closed"
            }
            _ => "ssh_host_tools_unavailable",
        };
        SshError::new(
            kind,
            detail.map_or_else(
                || "The host-tools SSH connection is closed; automatic recovery is pending".into(),
                |error| error.message,
            ),
        )
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
        if matches!(purpose, Purpose::Files) && !self.files_recovery {
            return Err(unavailable());
        }
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
            if matches!(purpose, Purpose::Commands) {
                self.report_automatic(None);
            }
            Ok(())
        })?
    }
}
#[derive(Clone, Copy)]
pub(super) enum Purpose {
    Files,
    Commands,
}

async fn session_replaced(state: &AppState, id: &str, session: &Arc<Session>) {
    loop {
        if !state
            .sessions
            .lock()
            .await
            .get(id)
            .is_some_and(|active| Arc::ptr_eq(active, session))
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// One session owns one watcher. A failed command is never passed to this loop or replayed.
async fn automatic_watch<F, Fut>(
    state: AppState,
    id: String,
    session: Arc<Session>,
    mut attempt: F,
    mut notify: impl FnMut(bool),
) where
    F: FnMut(AccessLease) -> Fut,
    Fut: std::future::Future<Output = Result<Restored>>,
{
    use std::sync::atomic::Ordering;
    let Some(control) = session.file_control.as_ref() else {
        return;
    };
    let mut cancel = session.cancel.subscribe();
    let mut access = session.access.subscribe();
    let mut credentials = state.credential_changes.subscribe();
    let mut delay = Duration::from_secs(1);
    let mut blocked: Option<(Host, u64, u64)> = None;
    loop {
        if *cancel.borrow()
            || !state
                .sessions
                .lock()
                .await
                .get(&id)
                .is_some_and(|active| Arc::ptr_eq(active, &session))
        {
            return;
        }
        if session.adopted.load(Ordering::SeqCst) && !session.access.is_locked() {
            if let Ok(handle) = control.command_handle() {
                if !handle.is_closed() {
                    control.report_automatic(None);
                    blocked = None;
                    delay = Duration::from_secs(1);
                } else if let Some(original) = control.original.as_ref() {
                    if let Ok(host) = state.host(&original.id) {
                        let generation = session.access.generation().unwrap_or_default();
                        let revision = control.credential_revision.load(Ordering::SeqCst);
                        let unchanged =
                            blocked
                                .as_ref()
                                .is_some_and(|(previous, epoch, saved_revision)| {
                                    *epoch == generation
                                        && *saved_revision == revision
                                        && previous.id == host.id
                                        && previous.credential_binding()
                                            == host.credential_binding()
                                        && previous.credentials_stored == host.credentials_stored
                                });
                        if !unchanged {
                            match silent_recovery_host(original, &host) {
                                Err(error) => {
                                    if control.report_automatic(Some(error)) {
                                        notify(false);
                                    }
                                    blocked = Some((host, generation, revision));
                                    delay = Duration::from_secs(30);
                                }
                                Ok(()) => {
                                    let lease = session.access.status().ok().and_then(|status| {
                                        session.access.lease(status.nonce.as_deref()).ok()
                                    });
                                    if let Some(lease) = lease {
                                        let result = tokio::select! {
                                            _ = cancel.changed() => return,
                                            _ = lease.cancelled() => continue,
                                            _ = session_replaced(&state, &id, &session) => return,
                                            result = attempt(lease.clone()) => result,
                                        };
                                        match result {
                                            Ok(_) => {
                                                notify(true);
                                                blocked = None;
                                                delay = Duration::from_secs(1);
                                            }
                                            Err(error)
                                                if matches!(
                                                    error.kind(),
                                                    "ssh_control_busy" | "ssh_control_ready"
                                                ) => {}
                                            Err(error)
                                                if matches!(
                                                    error.kind(),
                                                    "ssh_error"
                                                        | "timeout"
                                                        | "disconnected"
                                                        | "cancelled"
                                                ) =>
                                            {
                                                if control.report_automatic(Some(SshError::new(
                                                    "ssh_error",
                                                    "Host tools are reconnecting",
                                                ))) {
                                                    notify(false);
                                                }
                                                delay = (delay * 2).min(Duration::from_secs(30));
                                            }
                                            Err(error) => {
                                                if control.report_automatic(Some(SshError::new(error.kind(), "Automatic host-tools recovery cannot authenticate or verify the saved host"))) { notify(false); }
                                                blocked = Some((host, generation, revision));
                                                delay = Duration::from_secs(30);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        if control.report_automatic(Some(SshError::new(
                            "missing_host",
                            "The saved host is no longer available",
                        ))) {
                            notify(false);
                        }
                        delay = Duration::from_secs(30);
                    }
                } else {
                    if control.report_automatic(Some(unavailable())) {
                        notify(false);
                    }
                    delay = Duration::from_secs(30);
                }
            }
        }
        tokio::select! {
            _ = cancel.changed() => return,
            _ = access.changed() => {},
            change = credentials.recv() => {
                // A lagged receiver still wakes and compares the retained per-session revision.
                if change.is_ok() || matches!(change, Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) {
                    delay = Duration::from_secs(1);
                }
            },
            _ = tokio::time::sleep(delay) => {},
        }
    }
}
pub(crate) fn start_automatic(
    app: tauri::AppHandle,
    state: AppState,
    id: String,
    session: Arc<Session>,
    events: Channel<SshEvent>,
) {
    let attempt_state = state.clone();
    let attempt_id = id.clone();
    let attempt_session = session.clone();
    tauri::async_runtime::spawn(automatic_watch(
        state,
        id,
        session,
        move |lease| {
            let app = app.clone();
            let state = attempt_state.clone();
            let id = attempt_id.clone();
            let session = attempt_session.clone();
            async move {
                let operation = app.vault().operation();
                let auth_app = app.clone();
                let auth_state = state.clone();
                let auth_lease = lease.clone();
                let auth_operation = operation.clone();
                restore_for(
                    Purpose::Commands,
                    &state,
                    &id,
                    &session,
                    &lease,
                    &operation,
                    move |original, permit| async move {
                        authenticated_connection(
                            auth_app,
                            &auth_state,
                            original.id.clone(),
                            crate::vault::Credentials {
                                password: None,
                                private_key: None,
                                passphrase: None,
                            },
                            true,
                            None,
                            &auth_operation,
                            &auth_lease,
                            None,
                            Some(&original),
                            Some(permit),
                            true,
                        )
                        .await
                    },
                )
                .await
            }
        },
        move |ready| {
            let _ = events.send(if ready {
                SshEvent::HostToolsRestored
            } else {
                SshEvent::HostToolsStatus
            });
        },
    ));
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
                                    false,
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
    async fn automatic_fixture() -> Fixture {
        let fixture = fixture().await;
        fixture.state.config().unwrap().hosts[0].credentials_stored = true;
        fixture
            .session
            .adopted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        fixture
    }
    fn watch<F, Fut>(fixture: &Fixture, attempt: F) -> tokio::task::JoinHandle<()>
    where
        F: FnMut(AccessLease) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Restored>> + Send + 'static,
    {
        tokio::spawn(automatic_watch(
            fixture.state.clone(),
            "owned-mosh".into(),
            fixture.session.clone(),
            attempt,
            |_| {},
        ))
    }
    #[tokio::test]
    async fn silent_recovery_requires_the_same_verified_host_and_noninteractive_credentials() {
        let f = fixture().await;
        let mut saved = f.host.clone();
        saved.credentials_stored = true;
        assert!(silent_recovery_host(&f.host, &saved).is_ok());
        assert_eq!(
            silent_recovery_host(&f.host, &f.host).unwrap_err().kind(),
            "credentials_required"
        );
        for (_, changed) in crate::ssh::test_support::changed_host_bindings(&f.host) {
            assert!(silent_recovery_host(&f.host, &changed).is_err());
        }
        let mut biometric = saved.clone();
        biometric.biometric_unlock = true;
        assert_eq!(
            silent_recovery_host(&biometric, &biometric)
                .unwrap_err()
                .kind(),
            "credentials_required"
        );
        for unsupported in ["jump", "forward"] {
            let mut host = saved.clone();
            if unsupported == "jump" {
                host.jump_host_id = Some("bastion".into());
            } else {
                host.forward_agent = true;
            }
            assert_eq!(
                silent_recovery_host(&host, &host).unwrap_err().kind(),
                "ssh_control_unavailable"
            );
        }
    }
    #[tokio::test]
    async fn unavailable_control_reports_safe_recovery_reasons() {
        let f = fixture().await;
        let control = f.session.file_control.as_ref().unwrap();
        for (cause, expected) in [
            ("authentication_failed", "ssh_host_tools_credentials"),
            ("host_key_changed", "ssh_host_tools_host_changed"),
            ("ssh_control_unavailable", "ssh_host_tools_unsupported"),
            ("missing_host", "ssh_host_tools_host_missing"),
            ("storage", "ssh_host_tools_unavailable"),
            ("timeout", "ssh_host_tools_closed"),
        ] {
            control.report_automatic(Some(SshError::new(cause, "private diagnostic")));
            assert_eq!(control.command_unavailable().kind(), expected);
        }
    }
    #[tokio::test]
    async fn commands_only_control_does_not_enable_file_transfer_recovery() {
        let f = fixture().await;
        let control = Control::commands_only(f.session.handle.clone());
        assert_eq!(
            control.begin(Purpose::Files).err().unwrap().kind(),
            "ssh_control_unavailable"
        );
        assert!(control.begin(Purpose::Commands).is_ok());
    }
    #[tokio::test]
    async fn automatic_recovery_retries_transient_failure_once_and_keeps_the_file_control() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let f = automatic_fixture().await;
        let fresh = f.peer.reconnect().await;
        let session = f.session.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let attempts = calls.clone();
        let worker = watch(&f, move |_| {
            let session = session.clone();
            let fresh = fresh.clone();
            let count = attempts.fetch_add(1, Ordering::SeqCst);
            async move {
                if count == 0 {
                    return Err(SshError::new("timeout", "owned transient"));
                }
                *session
                    .file_control
                    .as_ref()
                    .unwrap()
                    .commands
                    .lock()
                    .unwrap() = fresh;
                Ok(Restored {
                    schema_version: 1,
                    status: "restored",
                })
            }
        });
        timeout(Duration::from_secs(8), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let control = f.session.file_control.as_ref().unwrap();
        assert!(!control.command_handle().unwrap().is_closed());
        assert!(Arc::ptr_eq(&control.current().unwrap(), &f.session.handle));
        assert!(!*f.session.cancel.borrow());
        f.session.cancel.send_replace(true);
        timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn automatic_recovery_publishes_a_probed_connection_for_the_owned_session() {
        let f = automatic_fixture().await;
        f.peer.respond_to_commands(b"lazysh-host-tools");
        let fresh = f.peer.reconnect().await;
        let operation = tauri_plugin_lazysh_vault::CredentialOperations::default().begin();
        let state = f.state.clone();
        let session = f.session.clone();
        let notified = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = notified.clone();
        let worker = tokio::spawn(automatic_watch(
            f.state.clone(),
            "owned-mosh".into(),
            f.session.clone(),
            move |lease| {
                let state = state.clone();
                let session = session.clone();
                let fresh = fresh.clone();
                let operation = operation.clone();
                async move {
                    let auth_state = state.clone();
                    restore_for(
                        Purpose::Commands,
                        &state,
                        "owned-mosh",
                        &session,
                        &lease,
                        &operation,
                        move |host, _| async move {
                            Ok(AuthenticatedConnection {
                                _guard: auth_state.credential_guard(&host.id).await,
                                host,
                                credentials: crate::vault::Credentials {
                                    password: None,
                                    private_key: None,
                                    passphrase: None,
                                },
                                handle: fresh,
                            })
                        },
                    )
                    .await
                }
            },
            move |ready| {
                if ready {
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            },
        ));
        timeout(Duration::from_secs(3), async {
            while notified.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(notified.load(std::sync::atomic::Ordering::SeqCst), 1);
        let control = f.session.file_control.as_ref().unwrap();
        assert!(Arc::ptr_eq(&control.current().unwrap(), &f.session.handle));
        assert!(Arc::ptr_eq(
            &f.state.session("owned-mosh").await.unwrap(),
            &f.session
        ));
        f.session.cancel.send_replace(true);
        timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
    }
    #[tokio::test]
    async fn automatic_recovery_does_not_repeat_rejected_credentials() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let f = automatic_fixture().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let attempts = calls.clone();
        let notices = Arc::new(AtomicUsize::new(0));
        let count = notices.clone();
        let worker = tokio::spawn(automatic_watch(
            f.state.clone(),
            "owned-mosh".into(),
            f.session.clone(),
            move |_| {
                attempts.fetch_add(1, Ordering::SeqCst);
                async { Err(SshError::new("authentication_failed", "owned rejection")) }
            },
            move |ready| {
                if !ready {
                    count.fetch_add(1, Ordering::SeqCst);
                }
            },
        ));
        timeout(Duration::from_secs(2), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(notices.load(Ordering::SeqCst), 1);
        for _ in 0..65 {
            let _ = f.state.credential_changes.send("another-host".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        f.state.note_credentials_changed(&f.host.id).await;
        for _ in 0..65 {
            let _ = f.state.credential_changes.send("another-host".into());
        }
        timeout(Duration::from_secs(2), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let unavailable = f
            .session
            .file_control
            .as_ref()
            .unwrap()
            .command_unavailable();
        assert_eq!(unavailable.kind(), "ssh_host_tools_credentials");
        assert!(unavailable.message().contains("cannot authenticate"));
        f.session.cancel.send_replace(true);
        timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
    }
    #[tokio::test]
    async fn automatic_recovery_cancels_on_lock_or_session_removal() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        for remove in [false, true] {
            let f = automatic_fixture().await;
            let started = Arc::new(tokio::sync::Notify::new());
            let dropped = Arc::new(AtomicBool::new(false));
            let signal = started.clone();
            let marker = dropped.clone();
            let worker = watch(&f, move |_| {
                let guard = Dropped(marker.clone());
                let signal = signal.clone();
                async move {
                    let _guard = guard;
                    signal.notify_one();
                    std::future::pending::<Result<Restored>>().await
                }
            });
            timeout(Duration::from_secs(2), started.notified())
                .await
                .unwrap();
            if remove {
                f.state.sessions.lock().await.remove("owned-mosh");
            } else {
                f.access.lock().unwrap();
            }
            timeout(Duration::from_secs(2), async {
                while !dropped.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            f.session.cancel.send_replace(true);
            timeout(Duration::from_secs(2), worker)
                .await
                .unwrap()
                .unwrap();
        }
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
            let mut control = Control::new(f.session.handle.clone());
            control.original = None;
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
