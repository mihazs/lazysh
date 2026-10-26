#[path = "ssh/upload_path.rs"]
mod upload_path;
use crate::app_lock::{AccessLease, AccessState, Guarded, GuardedError};
use russh::{
    client,
    keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg,
};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tauri::{ipc::Channel, State};
use tauri_plugin_lazysh_vault::{CredentialOperation, VaultExt};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, watch, Mutex, Semaphore},
    time::timeout,
};
use zeroize::Zeroizing;

const FILE_LIMIT: u64 = 1024 * 1024;
const UPLOAD_LIMIT: usize = 10 * 1024 * 1024;
const OP_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(all(test, unix))]
#[path = "tmux_jump_fixture.rs"]
mod tmux_jump_fixture;

#[derive(Debug, Clone, Serialize)]
pub struct SshError {
    kind: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "hostId")]
    host_id: Option<String>,
}
impl SshError {
    pub(crate) fn new(kind: &'static str, message: impl ToString) -> Self {
        Self {
            kind,
            message: message.to_string(),
            fingerprint: None,
            host_id: None,
        }
    }
    pub(crate) fn for_host(mut self, host_id: &str) -> Self {
        self.host_id = Some(host_id.into());
        self
    }
}
impl<E: std::fmt::Display> From<E> for SshError {
    fn from(e: E) -> Self {
        Self::new("ssh_error", e)
    }
}
pub(crate) type Result<T> = std::result::Result<T, SshError>;
pub(crate) type AccessResult<T> = std::result::Result<Guarded<T>, GuardedError<SshError>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Auto,
    Ssh,
    Mosh,
    Et,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Host {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<Transport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mosh: Option<crate::mosh::Options>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub et: Option<crate::et::Options>,
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(
        default,
        rename = "jumpHostId",
        skip_serializing_if = "Option::is_none"
    )]
    pub jump_host_id: Option<String>,
    #[serde(default, rename = "forwardAgent", skip_serializing_if = "is_false")]
    pub forward_agent: bool,
    #[serde(
        default,
        rename = "credentialsStored",
        skip_serializing_if = "is_false"
    )]
    pub credentials_stored: bool,
    #[serde(default, rename = "biometricUnlock", skip_serializing_if = "is_false")]
    pub biometric_unlock: bool,
}
fn is_false(value: &bool) -> bool {
    !value
}
pub(crate) type CredentialBinding<'a> = (
    &'a str,
    u16,
    &'a str,
    Option<&'a str>,
    Option<&'a str>,
    bool,
    bool,
);
impl Host {
    pub(crate) fn credential_binding(&self) -> CredentialBinding<'_> {
        (
            &self.hostname,
            self.port,
            &self.username,
            self.fingerprint.as_deref(),
            self.jump_host_id.as_deref(),
            self.forward_agent,
            self.biometric_unlock,
        )
    }
    pub(crate) fn validate(&self) -> Result<()> {
        if let Some(options) = &self.mosh {
            options.validate()?;
        }
        if let Some(options) = &self.et {
            options.validate()?;
        }
        if self.id.is_empty()
            || self.id.len() > 100
            || self.name.trim().is_empty()
            || self.name.len() > 200
            || self.hostname.trim().is_empty()
            || self.hostname.len() > 253
            || self.username.is_empty()
            || self.username.len() > 200
            || self.port == 0
            || [&self.id, &self.name, &self.hostname, &self.username]
                .iter()
                .any(|s| s.chars().any(char::is_control))
        {
            return Err(SshError::new(
                "invalid_host",
                "Enter a host name, address, valid port and username.",
            ));
        }
        Ok(())
    }
    fn identity(&self) -> (&str, u16) {
        (&self.hostname, self.port)
    }
}

struct Config {
    path: PathBuf,
    hosts: Vec<Host>,
    pending: HashMap<String, (String, u16, String)>,
}
impl Config {
    fn persist(&self, hosts: &[Host]) -> Result<()> {
        fs::create_dir_all(
            self.path
                .parent()
                .ok_or_else(|| SshError::new("storage", "Invalid config directory"))?,
        )?;
        let tmp = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(hosts)?;
        let result = (|| -> std::io::Result<()> {
            use std::io::Write;
            let mut opts = fs::OpenOptions::new();
            opts.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
            fs::rename(&tmp, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(tmp);
        }
        result?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct AppState {
    pub(crate) uploads: crate::attachment_upload::Uploads,
    config: Arc<StdMutex<Config>>,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    retiring: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    credential_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}
impl AppState {
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        let path = dir.join("hosts.json");
        let hosts = match fs::read(&path) {
            Ok(b) => serde_json::from_slice::<Vec<Host>>(&b)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        Ok(Self {
            uploads: Default::default(),
            config: Arc::new(StdMutex::new(Config {
                path,
                hosts,
                pending: HashMap::new(),
            })),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            retiring: Arc::new(Mutex::new(HashMap::new())),
            credential_locks: Arc::new(Mutex::new(HashMap::new())),
        })
    }
    pub(crate) async fn cancel_for_renderer_rebind(&self) {
        let sessions = {
            let mut active = self.sessions.lock().await;
            let mut retiring = self.retiring.lock().await;
            drain_sessions(&mut active, &mut retiring)
        };
        for session in &sessions {
            session.renderer_gone.send_replace(true);
            session.cancel.send_replace(true);
            session.output_credits.close();
            session.handle.forward_agent.close();
        }
        let mut seen = std::collections::HashSet::new();
        let mut disconnects = tokio::task::JoinSet::new();
        for session in &sessions {
            let handle = session.handle.clone();
            if seen.insert(Arc::as_ptr(&handle) as usize) {
                disconnects.spawn(async move {
                    let _ = timeout(
                        Duration::from_secs(2),
                        handle.disconnect(
                            russh::Disconnect::ByApplication,
                            "Renderer replaced",
                            "en",
                        ),
                    )
                    .await;
                });
            }
        }
        while disconnects.join_next().await.is_some() {}
        for session in sessions {
            let mut finished = session.finished.subscribe();
            let done = *finished.borrow();
            if !done {
                let _ = finished.wait_for(|done| *done).await;
            }
        }
        self.retiring
            .lock()
            .await
            .retain(|_, session| !*session.renderer_gone.borrow());
    }
    fn config(&self) -> Result<std::sync::MutexGuard<'_, Config>> {
        self.config
            .lock()
            .map_err(|_| SshError::new("storage", "Host storage lock failed"))
    }
    pub(crate) fn host(&self, id: &str) -> Result<Host> {
        self.config()?
            .hosts
            .iter()
            .find(|h| h.id == id)
            .cloned()
            .ok_or_else(|| SshError::new("missing_host", "Host no longer exists"))
    }
    pub(crate) fn launch_hosts(&self, id: &str) -> std::result::Result<Vec<Host>, String> {
        let config = self
            .config()
            .map_err(|_| crate::desktop_launch::HOST_INVALID)?;
        let find = |id: &str| {
            let mut matches = config.hosts.iter().filter(|host| host.id == id);
            let host = matches.next().ok_or(crate::desktop_launch::HOST_MISSING)?;
            if matches.next().is_some() {
                return Err(crate::desktop_launch::HOST_AMBIGUOUS);
            }
            host.validate()
                .map_err(|_| crate::desktop_launch::HOST_INVALID)?;
            Ok(host.clone())
        };
        let host = find(id)?;
        let mut result = vec![host.clone()];
        if let Some(jump_id) = &host.jump_host_id {
            let jump = find(jump_id)?;
            if jump.id == host.id || jump.jump_host_id.is_some() {
                return Err(crate::desktop_launch::HOST_INVALID.into());
            }
            result.push(jump);
        }
        Ok(result)
    }
    pub(crate) fn sync_snapshot(&self) -> Result<Vec<Host>> {
        Ok(self.config()?.hosts.clone())
    }
    pub(crate) fn sync_add_hosts(
        &self,
        expected: &[Host],
        additions: Vec<Host>,
        enroll_pins: &[Host],
    ) -> Result<()> {
        let mut config = self.config()?;
        if serde_json::to_vec(&config.hosts)? != serde_json::to_vec(expected)? {
            return Err(SshError::new(
                "sync_conflict",
                "Local hosts changed. Fetch and review a new sync preview.",
            ));
        }
        let mut hosts = config.hosts.clone();
        for imported in enroll_pins {
            imported.validate()?;
            let pin = imported.fingerprint.as_ref().ok_or_else(|| {
                SshError::new("sync_conflict", "An imported fingerprint is missing")
            })?;
            if let Some(local) = hosts.iter().find(|h| h.id == imported.id) {
                if local.hostname != imported.hostname
                    || local.port != imported.port
                    || local.username != imported.username
                    || local.jump_host_id != imported.jump_host_id
                    || local.forward_agent != imported.forward_agent
                {
                    return Err(SshError::new(
                        "sync_conflict",
                        "The imported host identity differs from the local profile",
                    ));
                }
            }
            for local in hosts
                .iter_mut()
                .filter(|h| h.identity() == imported.identity())
            {
                if local
                    .fingerprint
                    .as_ref()
                    .is_some_and(|existing| existing != pin)
                {
                    return Err(SshError::new(
                        "sync_conflict",
                        "A local verified fingerprint differs; sync will not replace it",
                    ));
                }
                local.fingerprint = Some(pin.clone());
            }
        }
        for mut host in additions {
            host.validate()?;
            host.biometric_unlock = false;
            if hosts.iter().any(|saved| saved.id == host.id) {
                return Err(SshError::new("sync_conflict", "A sync host already exists"));
            }
            if let Some(saved) = hosts
                .iter()
                .find(|saved| saved.identity() == host.identity())
            {
                if host.fingerprint.is_some() && saved.fingerprint != host.fingerprint {
                    return Err(SshError::new("sync_conflict", "A local host pin differs. Verify that host locally before importing credentials."));
                }
                host.fingerprint = saved.fingerprint.clone();
            }
            host.credentials_stored = false;
            hosts.push(host);
        }
        for host in &hosts {
            crate::routing::validate(host, &hosts)?;
        }
        config.persist(&hosts)?;
        config.hosts = hosts;
        Ok(())
    }
    pub(crate) async fn credential_guard(&self, id: &str) -> crate::vault::CredentialGuard {
        let lock = self
            .credential_locks
            .lock()
            .await
            .entry(id.to_owned())
            .or_default()
            .clone();
        Arc::new(lock.lock_owned().await)
    }
    pub(crate) fn mark_credentials(&self, id: &str, stored: bool) -> Result<()> {
        let mut config = self.config()?;
        let mut hosts = config.hosts.clone();
        let host = hosts
            .iter_mut()
            .find(|host| host.id == id)
            .ok_or_else(|| SshError::new("missing_host", "Host no longer exists"))?;
        host.credentials_stored = stored;
        config.persist(&hosts)?;
        config.hosts = hosts;
        Ok(())
    }
    pub(crate) async fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .filter(|session| !*session.cancel.borrow())
            .ok_or_else(|| SshError::new("disconnected", "Session is disconnected"))
    }
}

#[tauri::command]
pub fn list_hosts(lease: AccessLease, state: State<'_, AppState>) -> AccessResult<Vec<Host>> {
    lease.run_sync(|| Ok(state.config()?.hosts.clone()))
}
#[tauri::command]
pub async fn save_host(
    lease: AccessLease,

    app: tauri::AppHandle,
    state: State<'_, AppState>,
    host: Host,
) -> AccessResult<Host> {
    lease
        .run(async {
            let _guard = state.credential_guard(&host.id).await;
            let state = state.inner().clone();
            crate::vault::credential_worker(_guard, lease.clone(), move || {
                host.validate()?;
                {
                    let config = state.config()?;
                    crate::routing::validate(&host, &config.hosts)?;
                    validate_protection_change(&host, &config.hosts)?;
                }
                if state.host(&host.id).ok().is_some_and(|old| {
                    old.credentials_stored
                        && (old.hostname != host.hostname
                            || old.port != host.port
                            || old.username != host.username
                            || old.jump_host_id != host.jump_host_id
                            || old.forward_agent != host.forward_agent)
                }) {
                    crate::vault::remove(&app, &host.id)
                        .map_err(|message| SshError::new("storage", message))?;
                    state.mark_credentials(&host.id, false)?;
                }
                save_host_inner(&state, host)
            })
            .await
            .map_err(|_| SshError::new("storage", "Host update failed"))?
        })
        .await
}
fn validate_protection_change(host: &Host, hosts: &[Host]) -> Result<()> {
    if hosts.iter().any(|old| {
        old.id == host.id && old.credentials_stored && old.biometric_unlock != host.biometric_unlock
    }) {
        return Err(SshError::new("credential_policy_change", "Forget saved credentials before changing biometric protection. This preserves your saved identity until you explicitly remove it."));
    }
    Ok(())
}
fn save_host_inner(state: &AppState, mut host: Host) -> Result<Host> {
    host.validate()?;
    let mut config = state.config()?;
    crate::routing::validate(&host, &config.hosts)?;
    validate_protection_change(&host, &config.hosts)?;
    host.credentials_stored = config
        .hosts
        .iter()
        .find(|old| old.id == host.id)
        .is_some_and(|old| old.credentials_stored);
    // Pins are native-owned and shared by address/port, never accepted from the UI.
    host.fingerprint = config
        .hosts
        .iter()
        .find(|h| h.identity() == host.identity() && h.fingerprint.is_some())
        .and_then(|h| h.fingerprint.clone());
    let mut hosts = config.hosts.clone();
    if let Some(old) = hosts.iter_mut().find(|h| h.id == host.id) {
        *old = host.clone();
    } else {
        hosts.push(host.clone());
    }
    config.persist(&hosts)?;
    config.hosts = hosts;
    config.pending.remove(&host.id);
    Ok(host)
}
#[tauri::command]
pub async fn delete_host(
    lease: AccessLease,

    app: tauri::AppHandle,
    state: State<'_, AppState>,
    host_id: String,
) -> AccessResult<()> {
    lease
        .run(async {
            let _guard = state.credential_guard(&host_id).await;
            let state = state.inner().clone();
            crate::vault::credential_worker(_guard, lease.clone(), move || {
                if state
                    .config()?
                    .hosts
                    .iter()
                    .any(|host| host.jump_host_id.as_deref() == Some(&host_id))
                {
                    return Err(SshError::new(
                        "host_in_use",
                        "Remove routes using this bastion before deleting it",
                    ));
                }
                if state.host(&host_id)?.credentials_stored {
                    crate::vault::remove(&app, &host_id)
                        .map_err(|message| SshError::new("storage", message))?;
                }
                remove_host_metadata(&state, &host_id)
            })
            .await
            .map_err(|_| SshError::new("storage", "Host deletion failed"))?
        })
        .await
}
fn remove_host_metadata(state: &AppState, host_id: &str) -> Result<()> {
    let mut config = state.config()?;
    if config
        .hosts
        .iter()
        .any(|host| host.jump_host_id.as_deref() == Some(host_id))
    {
        return Err(SshError::new("host_in_use", "A route now uses this bastion. Remove that route and retry deleting the host; saved credentials may already have been removed."));
    }
    let hosts = config
        .hosts
        .iter()
        .filter(|h| h.id != host_id)
        .cloned()
        .collect::<Vec<_>>();
    config.persist(&hosts)?;
    config.hosts = hosts;
    config.pending.remove(host_id);
    Ok(())
}
#[tauri::command]
pub fn trust_host_key(
    lease: AccessLease,
    state: State<'_, AppState>,
    launch: State<'_, crate::desktop_launch::LaunchState>,
    launch_receipt: Option<String>,
    host_id: String,
    fingerprint: String,
) -> AccessResult<()> {
    lease.run_sync(|| {
        let expected = launch_receipt
            .as_deref()
            .map(|receipt| launch.trust_binding(receipt, &lease, &host_id))
            .transpose()?;
        trust_host_key_inner(&state, host_id, fingerprint.clone(), expected.as_ref())?;
        if let (Some(receipt), Some(expected)) = (launch_receipt.as_deref(), expected) {
            launch.accepted_trust(receipt, &lease, &expected, &fingerprint)?;
        }
        Ok(())
    })
}
fn trust_host_key_inner(
    state: &AppState,
    host_id: String,
    fingerprint: String,
    expected: Option<&Host>,
) -> Result<()> {
    let mut config = state.config()?;
    let host = config
        .hosts
        .iter()
        .find(|h| h.id == host_id)
        .ok_or_else(|| SshError::new("missing_host", "Host no longer exists"))?;
    if expected.is_some_and(|expected| {
        expected.id != host.id || expected.credential_binding() != host.credential_binding()
    }) {
        return Err(SshError::new(
            crate::desktop_launch::HOST_CHANGED,
            crate::desktop_launch::HOST_CHANGED,
        ));
    }
    let pending = config
        .pending
        .get(&host_id)
        .ok_or_else(|| SshError::new("invalid_trust", "Connect first to inspect the server key"))?;
    if pending.0 != host.hostname
        || pending.1 != host.port
        || pending.2 != fingerprint
        || host.fingerprint.is_some()
    {
        return Err(SshError::new(
            "invalid_trust",
            "The host or key changed. Reconnect and verify again.",
        ));
    }
    let identity = (host.hostname.clone(), host.port);
    let mut hosts = config.hosts.clone();
    for h in &mut hosts {
        if h.hostname == identity.0 && h.port == identity.1 {
            h.fingerprint = Some(fingerprint.clone());
        }
    }
    config.persist(&hosts)?;
    config.hosts = hosts;
    config.pending.remove(&host_id);
    Ok(())
}

pub(crate) struct HostVerifier {
    expected: Option<String>,
    observed: Arc<StdMutex<Option<String>>>,
    _jump: Option<Arc<SshHandle>>,
    forward_agent: crate::forward_agent::ForwardAgent,
}
impl client::Handler for HostVerifier {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        if let Ok(mut observed) = self.observed.lock() {
            *observed = Some(fingerprint.clone());
        }
        Ok(self.expected.as_ref() == Some(&fingerprint))
    }
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.forward_agent.accept(channel, reply).await;
        Ok(())
    }
}
pub(crate) struct SshHandle {
    handle: Arc<client::Handle<HostVerifier>>,
    open_slots: Arc<Semaphore>,
    open_owner_gone: watch::Sender<bool>,
    forward_agent: crate::forward_agent::ForwardAgent,
    pub(crate) peer_address: Option<std::net::SocketAddr>,
}
impl SshHandle {
    pub(crate) fn agent_forwarding_enabled(&self) -> bool {
        self.forward_agent.enabled()
    }
}
impl std::ops::Deref for SshHandle {
    type Target = client::Handle<HostVerifier>;
    fn deref(&self) -> &Self::Target {
        &self.handle
    }
}
impl Drop for SshHandle {
    fn drop(&mut self) {
        self.open_owner_gone.send_replace(true);
        self.forward_agent.close();
    }
}
pub(crate) struct Session {
    pub(crate) handle: Arc<SshHandle>,
    pub(crate) access: AccessState,
    creation: AccessLease,
    adopted: std::sync::atomic::AtomicBool,
    adoption: tokio::sync::Notify,
    input: mpsc::Sender<Input>,
    output_credits: Semaphore,
    output_inflight: StdMutex<u32>,
    renderer_gone: watch::Sender<bool>,
    finished: watch::Sender<bool>,
    pub(crate) cancel: watch::Sender<bool>,
    validate_size: fn(u32, u32) -> Result<()>,
    pub(crate) tmux: StdMutex<Option<crate::tmux_jump::Binding>>,
    pub(crate) tmux_server: StdMutex<Option<crate::tmux_server::TmuxServer>>,
}
impl Session {
    fn new(
        handle: Arc<SshHandle>,
        input: mpsc::Sender<Input>,
        cancel: watch::Sender<bool>,
        creation: AccessLease,
        validate_size: fn(u32, u32) -> Result<()>,
    ) -> Self {
        Self {
            handle,
            input,
            cancel,
            validate_size,
            tmux: StdMutex::new(None),
            tmux_server: StdMutex::new(None),
            output_credits: Semaphore::new(OUTPUT_WINDOW as usize),
            output_inflight: StdMutex::new(0),
            renderer_gone: watch::channel(false).0,
            finished: watch::channel(false).0,
            access: creation.state(),
            creation,
            adopted: std::sync::atomic::AtomicBool::new(false),
            adoption: tokio::sync::Notify::new(),
        }
    }
}

async fn register_terminal(state: &AppState, session: &Arc<Session>) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut active = state.sessions.lock().await;
        session
            .creation
            .with_current(|| active.insert(id.clone(), session.clone()))?;
    }
    watch_adoption(state, &id, session);
    Ok(id)
}
async fn retire_session(
    active: &Mutex<HashMap<String, Arc<Session>>>,
    retiring: &Mutex<HashMap<String, Arc<Session>>>,
    id: &str,
    session: &Arc<Session>,
) {
    let mut active = active.lock().await;
    let mut retired = retiring.lock().await;
    active.remove(id);
    if !*session.renderer_gone.borrow() {
        retired.insert(id.to_owned(), session.clone());
    }
}
pub(crate) async fn adoption_revoked(
    adopted: &std::sync::atomic::AtomicBool,
    adoption: &tokio::sync::Notify,
    cancellation: &mut watch::Receiver<bool>,
    creation: &AccessLease,
) -> bool {
    if adopted.load(std::sync::atomic::Ordering::SeqCst) || *cancellation.borrow() {
        return false;
    }
    tokio::select! {biased;
        _=adoption.notified()=>false,
        _=cancellation.changed()=>false,
        _=creation.cancelled()=>!adopted.load(std::sync::atomic::Ordering::SeqCst),
    }
}
pub(crate) fn drain_sessions<T>(
    active: &mut HashMap<String, T>,
    retiring: &mut HashMap<String, T>,
) -> Vec<T> {
    active
        .drain()
        .chain(retiring.drain())
        .map(|(_, session)| session)
        .collect()
}

fn watch_adoption(state: &AppState, id: &str, session: &Arc<Session>) {
    let session = session.clone();
    let sessions = state.sessions.clone();
    let retiring = state.retiring.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn(async move {
        let mut cancellation = session.cancel.subscribe();
        if adoption_revoked(
            &session.adopted,
            &session.adoption,
            &mut cancellation,
            &session.creation,
        )
        .await
        {
            session.cancel.send_replace(true);
            session.output_credits.close();
            retire_session(&sessions, &retiring, &id, &session).await;
        }
    });
}
fn mark_adopted(session: &Session, request: &AccessLease) -> Result<()> {
    request.check()?;
    if *session.cancel.borrow() {
        return Err(SshError::new("disconnected", "Session closed"));
    }
    session.creation.with_current(|| {
        session
            .adopted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        session.adoption.notify_one();
    })?;
    Ok(())
}
#[tauri::command]
pub async fn adopt_session(
    lease: AccessLease,
    state: State<'_, AppState>,
    local_state: State<'_, crate::local::LocalState>,
    session_id: String,
) -> AccessResult<()> {
    lease
        .run(async {
            let session = state.sessions.lock().await.get(&session_id).cloned();
            if let Some(session) = session {
                mark_adopted(&session, &lease)
            } else if crate::local::adopt(&local_state, &session_id, &lease)? {
                Ok(())
            } else {
                Err(SshError::new("disconnected", "Session is disconnected"))
            }
        })
        .await
}
struct SessionCompletion {
    finished: watch::Sender<bool>,
    armed: bool,
}
impl SessionCompletion {
    fn new(finished: watch::Sender<bool>) -> Self {
        Self {
            finished,
            armed: true,
        }
    }
    fn finish(mut self) {
        self.finished.send_replace(true);
        self.armed = false;
    }
}
impl Drop for SessionCompletion {
    fn drop(&mut self) {
        if self.armed {
            self.finished.send_replace(true);
        }
    }
}
// A cancelled native-start future must not leave its readiness worker running.
struct PendingTerminal {
    session: Arc<Session>,
    armed: bool,
}
impl Drop for PendingTerminal {
    fn drop(&mut self) {
        if self.armed {
            self.session.cancel.send_replace(true);
            self.session.output_credits.close();
        }
    }
}
pub(crate) enum Input {
    Data(crate::terminal_input::InputSequence, AccessLease),
    Resize(u32, u32, AccessLease),
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SshEvent {
    Data { data: Vec<u8> },
    Closed { message: String },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub(crate) session_id: String,
}

#[cfg(test)]
async fn authenticate(
    state: &AppState,
    host: &Host,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
) -> Result<SshHandle> {
    let credentials = crate::vault::Credentials {
        password,
        private_key,
        passphrase,
    };
    let handle = verified_connection(state, host).await?;
    authenticate_handle(
        handle,
        host,
        credentials.password.clone(),
        credentials.private_key.clone(),
        credentials.passphrase.clone(),
    )
    .await
}

pub(crate) async fn verified_connection(state: &AppState, host: &Host) -> Result<SshHandle> {
    let stream = timeout(
        OP_TIMEOUT,
        tokio::net::TcpStream::connect((host.hostname.as_str(), host.port)),
    )
    .await
    .map_err(|_| SshError::new("timeout", "SSH connection timed out"))??;
    stream.set_nodelay(true)?;
    let address = stream.peer_addr()?;
    let mut handle = verified_connection_on_stream(state, host, stream, None).await?;
    handle.peer_address = Some(address);
    Ok(handle)
}

pub(crate) async fn verified_connection_on_stream<R>(
    state: &AppState,
    host: &Host,
    stream: R,
    jump: Option<Arc<SshHandle>>,
) -> Result<SshHandle>
where
    R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let observed = Arc::new(StdMutex::new(None));
    let forward_agent = crate::forward_agent::ForwardAgent::default();
    let verifier = HostVerifier {
        expected: host.fingerprint.clone(),
        observed: observed.clone(),
        _jump: jump,
        forward_agent: forward_agent.clone(),
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        ..Default::default()
    });
    let result = timeout(OP_TIMEOUT, client::connect_stream(config, stream, verifier)).await;
    let handle = match result {
        Ok(Ok(handle)) => handle,
        other => {
            let fingerprint = observed
                .lock()
                .map_err(|_| SshError::new("ssh_error", "Key verification failed"))?
                .clone();
            if let Some(fingerprint) = fingerprint {
                if host.fingerprint.as_ref() != Some(&fingerprint) {
                    let changed = host.fingerprint.is_some();
                    if !changed {
                        let mut config = state.config()?;
                        if config.hosts.iter().any(|h| {
                            h.id == host.id
                                && h.identity() == host.identity()
                                && h.fingerprint.is_none()
                        }) {
                            config.pending.insert(
                                host.id.clone(),
                                (host.hostname.clone(), host.port, fingerprint.clone()),
                            );
                        }
                    }
                    return Err(SshError {
                        kind: if changed {
                            "host_key_changed"
                        } else {
                            "unknown_host_key"
                        },
                        message: if changed {
                            "The server key changed. Connection refused; verify the server independently before replacing this host.".into()
                        } else {
                            "Verify this SHA256 fingerprint with your server before trusting it."
                                .into()
                        },
                        fingerprint: Some(fingerprint),
                        host_id: Some(host.id.clone()),
                    });
                }
            }
            return match other {
                Ok(Err(e)) => Err(e.into()),
                Err(_) => Err(SshError::new("timeout", "SSH connection timed out")),
                _ => unreachable!(),
            };
        }
    };
    Ok(SshHandle {
        handle: Arc::new(handle),
        open_slots: Arc::new(Semaphore::new(4)),
        open_owner_gone: watch::channel(false).0,
        forward_agent,
        peer_address: None,
    })
}

#[cfg(test)]
pub(crate) async fn authenticate_handle(
    mut handle: SshHandle,
    host: &Host,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
) -> Result<SshHandle> {
    authenticate_handle_mut(&mut handle, host, password, private_key, passphrase).await?;
    Ok(handle)
}
async fn authenticate_handle_mut(
    handle: &mut SshHandle,
    host: &Host,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
) -> Result<()> {
    let password = password.map(Zeroizing::new);
    let private_key = private_key.map(Zeroizing::new);
    let passphrase = passphrase.map(Zeroizing::new);
    if host.forward_agent && private_key.as_ref().is_none_or(|key| key.is_empty()) {
        return Err(SshError::new(
            "forwarding_requires_key",
            "Agent forwarding requires the private key selected for this connection",
        ));
    }
    let transport = Arc::get_mut(&mut handle.handle).ok_or_else(|| {
        SshError::new(
            "connection_in_use",
            "Cannot authenticate a shared SSH transport",
        )
    })?;
    let mut selected_key = None;
    let auth = if let Some(key) = private_key.as_ref().filter(|k| !k.is_empty()) {
        let key = Arc::new(decode_secret_key(
            key,
            passphrase.as_ref().map(|s| s.as_str()),
        )?);
        if host.forward_agent {
            selected_key = Some(key.clone());
        }
        let hash = transport.best_supported_rsa_hash().await?.flatten();
        timeout(
            OP_TIMEOUT,
            transport.authenticate_publickey(&host.username, PrivateKeyWithHashAlg::new(key, hash)),
        )
        .await
    } else if let Some(password) = password {
        timeout(
            OP_TIMEOUT,
            transport.authenticate_password(&host.username, password.as_str()),
        )
        .await
    } else {
        return Err(SshError::new(
            "credentials_required",
            "Enter a password or an OpenSSH private key",
        ));
    };
    let auth = auth.map_err(|_| SshError::new("timeout", "SSH authentication timed out"))??;
    if !auth.success() {
        return Err(SshError::new(
            "authentication_failed",
            "Authentication rejected by the server",
        ));
    }
    if let Some(key) = selected_key {
        handle.forward_agent.enable(key);
    }
    Ok(())
}
fn connection_cancelled() -> SshError {
    SshError::new("cancelled", "Connection cancelled")
}
pub(crate) async fn during_connect<T>(
    operation: &CredentialOperation,
    future: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _ = operation.cancelled() => Err(connection_cancelled()),
        result = future => { operation.check().map_err(|_| connection_cancelled())?; result }
    }
}
pub(crate) async fn close_failed_connect(handle: &SshHandle) {
    handle.forward_agent.close();
    let _ = timeout(
        Duration::from_secs(2),
        handle.disconnect(
            russh::Disconnect::ByApplication,
            "Connection cancelled or failed",
            "en",
        ),
    )
    .await;
}
pub(crate) async fn authenticate_for_operation(
    mut handle: SshHandle,
    host: &Host,
    credentials: &crate::vault::Credentials,
    operation: &CredentialOperation,
) -> Result<SshHandle> {
    let result = during_connect(operation, async {
        authenticate_handle_mut(
            &mut handle,
            host,
            credentials.password.clone(),
            credentials.private_key.clone(),
            credentials.passphrase.clone(),
        )
        .await
    })
    .await;
    if let Err(error) = result {
        close_failed_connect(&handle).await;
        return Err(error);
    }
    Ok(handle)
}

async fn locked_connect_host(
    state: &AppState,
    host_id: &str,
    attempt: Option<&crate::desktop_launch::HostAttempt>,
    cols: u32,
    rows: u32,
) -> Result<(Host, crate::vault::CredentialGuard)> {
    let guard = state.credential_guard(host_id).await;
    check_size(cols, rows)?;
    let host = state.host(host_id)?;
    if let Some(attempt) = attempt {
        attempt.check_host(&host)?;
    }
    Ok((host, guard))
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn connect(
    lease: AccessLease,

    app: tauri::AppHandle,
    state: State<'_, AppState>,
    launch: State<'_, crate::desktop_launch::LaunchState>,
    launch_receipt: Option<String>,
    host_id: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    remember_credentials: Option<bool>,
    use_saved_credentials: Option<bool>,
    jump_credentials: Option<crate::vault::Credentials>,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> AccessResult<Connected> {
    lease
        .run(async {
            let attempt = launch_receipt
                .as_deref()
                .map(|receipt| launch.begin_host(receipt, &lease, &host_id))
                .transpose()?;
            let operation = app.vault().operation();
            let entered = crate::vault::Credentials {
                password,
                private_key,
                passphrase,
            };
            let (host, _guard) = during_connect(
                &operation,
                locked_connect_host(&state, &host_id, attempt.as_ref(), cols, rows),
            )
            .await?;
            let handle = during_connect(
                &operation,
                crate::routing::verified_target(
                    app.clone(),
                    &state,
                    &host,
                    jump_credentials,
                    &operation,
                    &lease,
                    attempt.as_ref(),
                ),
            )
            .await?;
            let credentials = if use_saved_credentials.unwrap_or(false) {
                match during_connect(&operation, async {
                    crate::vault::load_for_operation(
                        app.clone(),
                        host.clone(),
                        operation.clone(),
                        _guard.clone(),
                        lease.clone(),
                    )
                    .await
                    .map_err(|message| SshError::new("storage", message))
                })
                .await
                {
                    Ok(credentials) => credentials,
                    Err(error) => {
                        close_failed_connect(&handle).await;
                        return Err(error);
                    }
                }
            } else {
                entered
            };
            let handle = Arc::new(
                authenticate_for_operation(handle, &host, &credentials, &operation).await?,
            );
            let (channel, initial) = match during_connect(
                &operation,
                open_terminal_for(&handle, &lease, cols, rows, None),
            )
            .await
            {
                Ok(terminal) => terminal,
                Err(error) => {
                    close_failed_connect(&handle).await;
                    return Err(error);
                }
            };
            if remember_credentials.unwrap_or(false) {
                if operation.check().is_err() {
                    close_failed_connect(&handle).await;
                    return Err(connection_cancelled());
                }
                if let Err(error) = state.mark_credentials(&host_id, true) {
                    let _ = handle
                        .disconnect(
                            russh::Disconnect::ByApplication,
                            "Credential metadata failed",
                            "en",
                        )
                        .await;
                    return Err(error);
                }
                if let Err(message) = crate::vault::save_for_operation(
                    app.clone(),
                    host.clone(),
                    credentials,
                    operation.clone(),
                    _guard.clone(),
                    lease.clone(),
                )
                .await
                {
                    if !host.credentials_stored {
                        let vault_app = app.clone();
                        let vault_host = host_id.clone();
                        let cleanup_guard = _guard.clone();
                        if matches!(
                            tauri::async_runtime::spawn_blocking(move || {
                                let _guard = cleanup_guard;
                                crate::vault::remove(&vault_app, &vault_host)
                            })
                            .await,
                            Ok(Ok(()))
                        ) {
                            let _ = state.mark_credentials(&host_id, false);
                        }
                    }
                    let _ = handle
                        .disconnect(
                            russh::Disconnect::ByApplication,
                            "Credential storage failed",
                            "en",
                        )
                        .await;
                    return Err(SshError::new("storage", message));
                }
            }
            if operation.check().is_err() {
                close_failed_connect(&handle).await;
                return Err(connection_cancelled());
            }
            if let Some(attempt) = &attempt {
                if let Err(error) = attempt.check_host(&host) {
                    close_failed_connect(&handle).await;
                    return Err(error);
                }
            }
            let connected =
                spawn_terminal(&state, lease.clone(), handle, channel, initial, events).await?;
            if operation.check().is_err() {
                let _ = disconnect_inner(&state, connected.session_id).await;
                return Err(connection_cancelled());
            }
            if let Some(attempt) = attempt {
                attempt.finish();
            }
            Ok(connected)
        })
        .await
}
pub(crate) async fn request_ok(channel: &mut russh::Channel<client::Msg>) -> Result<Vec<u8>> {
    timeout(OP_TIMEOUT, async {
        let mut initial = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(initial),
                Some(ChannelMsg::Data { data }) => {
                    initial.extend_from_slice(&data);
                    if initial.len() > FILE_LIMIT as usize {
                        return Err(SshError::new(
                            "output_too_large",
                            "Initial terminal output exceeds 1 MiB",
                        ));
                    }
                }
                Some(ChannelMsg::Failure)
                | None
                | Some(ChannelMsg::Close)
                | Some(ChannelMsg::Eof) => {
                    return Err(SshError::new(
                        "terminal_rejected",
                        "Server rejected the terminal request",
                    ))
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| SshError::new("timeout", "Terminal request timed out"))?
}
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
async fn start_session(
    state: &AppState,
    host_id: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> Result<Connected> {
    check_size(cols, rows)?;
    let host = state.host(&host_id)?;
    let handle = Arc::new(authenticate(state, &host, password, private_key, passphrase).await?);
    let (channel, initial) = open_terminal(&handle, cols, rows, None).await?;
    spawn_terminal(
        state,
        AccessState::disabled().lease(None).unwrap(),
        handle,
        channel,
        initial,
        events,
    )
    .await
}
const OUTPUT_WINDOW: u32 = 256 * 1024;
/// A channel must remain close-owned even before a terminal task is registered.
/// russh's raw Channel Drop does not request remote close on retained SSH.
pub(crate) struct OwnedChannel {
    channel: Option<russh::Channel<client::Msg>>,
    closed: std::sync::atomic::AtomicBool,
}
impl From<russh::Channel<client::Msg>> for OwnedChannel {
    fn from(channel: russh::Channel<client::Msg>) -> Self {
        Self {
            channel: Some(channel),
            closed: std::sync::atomic::AtomicBool::new(false),
        }
    }
}
impl std::ops::Deref for OwnedChannel {
    type Target = russh::Channel<client::Msg>;
    fn deref(&self) -> &Self::Target {
        self.channel.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for OwnedChannel {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.channel.as_mut().unwrap()
    }
}
impl OwnedChannel {
    pub(crate) fn into_stream(mut self) -> russh::ChannelStream<client::Msg> {
        // russh transfers this confirmed channel to ChannelCloseOnDrop.
        self.channel.take().unwrap().into_stream()
    }
    pub(crate) async fn close(&self) -> std::result::Result<(), russh::Error> {
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        self.channel.as_ref().unwrap().close().await?;
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}
impl Drop for OwnedChannel {
    fn drop(&mut self) {
        if !self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            if let Some(channel) = self.channel.take() {
                tauri::async_runtime::spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(3), channel.close()).await;
                });
            }
        }
    }
}
pub(crate) enum ChannelRequest {
    Session,
    DirectTcp { host: String, port: u32 },
}
impl ChannelRequest {
    async fn open(
        self,
        transport: &client::Handle<HostVerifier>,
    ) -> std::result::Result<russh::Channel<client::Msg>, russh::Error> {
        match self {
            Self::Session => transport.channel_open_session().await,
            Self::DirectTcp { host, port } => {
                transport
                    .channel_open_direct_tcpip(host, port, "127.0.0.1", 0)
                    .await
            }
        }
    }
}
/// Retain the underlying open until confirmation, even after the caller's
/// deadline. Otherwise russh drops its receiver and ignores a late confirmation.
/// Workers own only the core transport; last SshHandle Drop stops them all.
pub(crate) async fn open_owned_channel(
    handle: &SshHandle,
    lease: &AccessLease,
    deadline: tokio::time::Instant,
) -> Result<OwnedChannel> {
    open_owned(handle, lease, deadline, ChannelRequest::Session).await
}
pub(crate) async fn open_owned(
    handle: &SshHandle,
    lease: &AccessLease,
    deadline: tokio::time::Instant,
    request: ChannelRequest,
) -> Result<OwnedChannel> {
    lease.check()?;
    if tokio::time::Instant::now() >= deadline {
        return Err(SshError::new("timeout", "Opening SSH channel timed out"));
    }
    let permit=handle.open_slots.clone().try_acquire_owned().map_err(|_|SshError::new("ssh_open_busy","SSH channel openings await peer confirmation; reconnect if the peer remains unresponsive"))?;
    let transport = handle.handle.clone();
    let mut owner_gone = handle.open_owner_gone.subscribe();
    let original = lease.clone();
    let (reply, response) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        if *owner_gone.borrow()
            || original.check().is_err()
            || reply.is_closed()
            || tokio::time::Instant::now() >= deadline
        {
            return;
        }
        let result = tokio::select! {biased;
            _=owner_gone.changed()=>return,
            result=request.open(&transport)=>result.map(OwnedChannel::from).map_err(SshError::from),
        };
        // A rejected/stale/late result drops its already-close-owned channel here.
        let _ = original.with_current(|| {
            let result = if tokio::time::Instant::now() >= deadline {
                drop(result);
                Err(SshError::new("timeout", "Opening SSH channel timed out"))
            } else {
                result
            };
            reply.send(result)
        });
    });
    let channel = tokio::select! {biased;
        _=lease.cancelled()=>Err(SshError::new("cancelled","SSH channel opening cancelled")),
        result=tokio::time::timeout_at(deadline,response)=>result.map_err(|_|SshError::new("timeout","Opening SSH channel timed out"))?.map_err(|_|SshError::new("disconnected","SSH channel opening retired"))?,
    }?;
    // timeout_at polls a ready inner future first. Even a timely confirmation
    // must not permit setup when this caller only resumes after its deadline.
    lease.check()?;
    if tokio::time::Instant::now() >= deadline {
        return Err(SshError::new("timeout", "Opening SSH channel timed out"));
    }
    Ok(channel)
}
#[cfg(test)]
async fn open_terminal(
    handle: &Arc<SshHandle>,
    cols: u32,
    rows: u32,
    command: Option<String>,
) -> Result<(OwnedChannel, Vec<u8>)> {
    open_terminal_for(
        handle,
        &AccessState::disabled().lease(None).unwrap(),
        cols,
        rows,
        command,
    )
    .await
}
async fn open_terminal_for(
    handle: &Arc<SshHandle>,
    creation: &AccessLease,
    cols: u32,
    rows: u32,
    command: Option<String>,
) -> Result<(OwnedChannel, Vec<u8>)> {
    let mut channel =
        open_owned_channel(handle, creation, tokio::time::Instant::now() + OP_TIMEOUT).await?;
    creation.check()?;
    let result = timeout(OP_TIMEOUT, async {
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        let mut initial = request_ok(&mut channel).await?;
        if handle.forward_agent.enabled() {
            channel.agent_forward(true).await?;
            initial.extend_from_slice(&request_ok(&mut channel).await?);
        }
        if let Some(command) = command {
            channel.exec(true, command).await?;
        } else {
            channel.request_shell(true).await?;
        }
        initial.extend_from_slice(&request_ok(&mut channel).await?);
        Ok::<_, SshError>(initial)
    })
    .await
    .map_err(|_| SshError::new("timeout", "Opening terminal timed out"));
    match result {
        Ok(Ok(initial)) => Ok((channel, initial)),
        other => {
            let _ = timeout(Duration::from_secs(2), channel.close()).await;
            match other {
                Ok(Err(error)) | Err(error) => Err(error),
                _ => unreachable!(),
            }
        }
    }
}
pub(crate) async fn deliver_output(
    access: &AccessState,
    credits: &Semaphore,
    inflight: &StdMutex<u32>,
    cancellation: &mut watch::Receiver<bool>,
    events: &Channel<SshEvent>,
    data: &[u8],
    owner: Option<(
        &AccessLease,
        &std::sync::atomic::AtomicBool,
        &watch::Sender<bool>,
    )>,
) -> std::result::Result<(), String> {
    let mut remaining = OP_TIMEOUT;
    let mut changes = access.subscribe();
    loop {
        if *cancellation.borrow() {
            return Err("Terminal closed".into());
        }
        tokio::select! {
            biased;
            _ = cancellation.changed() => return Err("Terminal closed".into()),
            result = access.wait_unlocked() => { result.map_err(String::from)?; }
        }
        let began = tokio::time::Instant::now();
        let permit = tokio::select! {
            biased;
            _ = cancellation.changed() => return Err("Terminal closed".into()),
            _ = changes.changed() => {
                remaining = remaining.saturating_sub(began.elapsed());
                continue;
            },
            permit = credits.acquire_many(data.len() as u32) => permit.map_err(|_| "Terminal closed")?,
            _ = tokio::time::sleep(remaining) => return Err("Terminal stopped consuming output".into()),
        };
        remaining = remaining.saturating_sub(began.elapsed());
        // Same authority mutex as lock: no Channel index is created while locked.
        let send = || -> std::result::Result<(), String> {
            if owner.is_some_and(|(_, _, gone)| *gone.borrow()) {
                return Err("Renderer replaced".into());
            }
            *inflight.lock().map_err(|_| "Output accounting failed")? += data.len() as u32;
            events
                .send(SshEvent::Data {
                    data: data.to_vec(),
                })
                .map_err(|_| "Terminal output closed")?;
            Ok(())
        };
        let sent = match owner {
            Some((creation, adopted, _)) => creation.with_transport_output(adopted, send),
            None => access.with_unlocked(send),
        };
        match sent {
            Ok(result) => {
                result?;
                permit.forget();
                return Ok(());
            }
            Err(_) => {
                drop(permit);
                if owner.is_some_and(|(creation, adopted, _)| {
                    creation.check().is_err() && !adopted.load(std::sync::atomic::Ordering::SeqCst)
                }) {
                    return Err("Session cancelled before adoption".into());
                }
            }
        }
    }
}
pub(crate) async fn close_output(
    access: &AccessState,
    owner: Option<(
        &AccessLease,
        &std::sync::atomic::AtomicBool,
        &watch::Sender<bool>,
    )>,
    events: &Channel<SshEvent>,
    message: String,
) {
    let mut retired = owner.map(|(_, _, gone)| gone.subscribe());
    loop {
        if retired.as_ref().is_some_and(|gone| *gone.borrow()) {
            return;
        }
        tokio::select! {
            biased;
            _ = async { if let Some(gone) = retired.as_mut() { let _ = gone.changed().await; } else { std::future::pending::<()>().await; } } => return,
            result = access.wait_unlocked() => if result.is_err() { return; },
        }
        let send = || {
            if owner.is_some_and(|(_, _, gone)| *gone.borrow()) {
                return Ok(());
            }
            events.send(SshEvent::Closed {
                message: message.clone(),
            })
        };
        let sent = match owner {
            Some((creation, adopted, gone)) => {
                if *gone.borrow() {
                    return;
                }
                if creation.check().is_err() && !adopted.load(std::sync::atomic::Ordering::SeqCst) {
                    // The renderer retained this id before an ACK that may have been lost.
                    // Retire the known tab after unlock without replaying an old private error.
                    access.with_unlocked(|| {
                        if *gone.borrow() {
                            return Ok(());
                        }
                        events.send(SshEvent::Closed {
                            message: "Session cancelled before adoption".into(),
                        })
                    })
                } else {
                    creation.with_transport_output(adopted, send)
                }
            }
            None => access.with_unlocked(send),
        };
        if sent.is_ok() {
            return;
        }
    }
}

async fn send_output(session: &Session, events: &Channel<SshEvent>, data: &[u8]) -> Result<()> {
    let mut cancellation = session.cancel.subscribe();
    for chunk in data.chunks(16384) {
        deliver_output(
            &session.access,
            &session.output_credits,
            &session.output_inflight,
            &mut cancellation,
            events,
            chunk,
            Some((&session.creation, &session.adopted, &session.renderer_gone)),
        )
        .await
        .map_err(|error| SshError::new("terminal_output", error))?;
    }
    Ok(())
}

async fn spawn_terminal(
    state: &AppState,
    creation: AccessLease,
    handle: Arc<SshHandle>,
    channel: impl Into<OwnedChannel>,
    initial: Vec<u8>,
    events: Channel<SshEvent>,
) -> Result<Connected> {
    let mut channel = channel.into();
    let (input, mut rx) = mpsc::channel(32);
    let (cancel, mut cancellation) = watch::channel(false);
    let session = Arc::new(Session::new(handle, input, cancel, creation, check_size));
    let id = register_terminal(state, &session).await?;
    let sessions = state.sessions.clone();
    let retiring = state.retiring.clone();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let completion = SessionCompletion::new(session.finished.clone());
        let result:Result<()> = async {
            send_output(&session, &events, &initial).await?;
            let mut pending:Option<(crate::terminal_input::InputSequence,AccessLease)>=None;
            loop {
                tokio::select! {
                    _=cancellation.changed()=>break,
                    _=async { match &pending {Some((_,lease))=>lease.cancelled().await,None=>std::future::pending().await} }=>{pending=None;},
                    _=async { match &pending {Some((data,_))=>tokio::time::sleep_until(data.ready_at()).await,None=>std::future::pending().await} }=>{
                        if let Some((data,lease))=&mut pending {
                            if lease.check().is_ok() {
                                let count=data.bytes().len();
                                tokio::select! { biased; _=lease.cancelled()=>{}, result=terminal_io(&session,channel.data(data.bytes()))=>{result?;data.advance(count);} }
                            }
                            if lease.check().is_err() || data.is_empty() {pending=None;}
                        }
                    },
                    message=channel.wait()=> match message {
                        Some(ChannelMsg::Data{data})|Some(ChannelMsg::ExtendedData{data,..}) => send_output(&session,&events,&data).await?,
                        None|Some(ChannelMsg::Close)|Some(ChannelMsg::Eof)=>break,
                        _=>{}
                    },
                    input=rx.recv(), if pending.is_none()=>match input {
                        Some(Input::Data(data, lease))=>{if !data.is_empty() && lease.check().is_ok() {pending=Some((data,lease));}},
                        Some(Input::Resize(cols,rows, lease))=>{ if lease.check().is_ok() { tokio::select! { biased; _ = lease.cancelled() => {}, result = terminal_io(&session,channel.window_change(cols,rows,0,0)) => {result?;} } } },
                        None=>break
                    }
                }
            }
            Ok(())
        }.await;
        let _ = session.cancel.send(true);
        let _ = timeout(Duration::from_secs(2), channel.close()).await;
        retire_session(&sessions, &retiring, &task_id, &session).await;
        completion.finish();
        close_output(
            &session.access,
            Some((&session.creation, &session.adopted, &session.renderer_gone)),
            &events,
            result
                .err()
                .map(|error| error.message)
                .unwrap_or_else(|| "Session closed".into()),
        )
        .await;
        retiring.lock().await.remove(&task_id);
    });
    Ok(Connected { session_id: id })
}
#[tauri::command]
pub async fn connect_mosh(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    options: crate::mosh::Options,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> AccessResult<Connected> {
    lease
        .run(async {
            let parent = state.session(&session_id).await?;
            crate::mosh::check_size(cols, rows)?;
            let bootstrap = crate::mosh::bootstrap(&parent, &lease, options).await?;
            #[cfg(any(
                target_os = "linux",
                target_os = "macos",
                target_os = "android",
                target_os = "ios"
            ))]
            {
                spawn_native_terminal(
                    &state,
                    lease.clone(),
                    parent,
                    events,
                    "Mosh",
                    crate::mosh::check_size,
                    move |access, input, cancel, initial, output, ready| {
                        tauri::async_runtime::spawn_blocking(move || {
                            crate::mosh::run(
                                bootstrap, cols, rows, access, input, cancel, initial, output,
                                ready,
                            )
                        })
                    },
                )
                .await
            }
            #[cfg(not(any(
                target_os = "linux",
                target_os = "macos",
                target_os = "android",
                target_os = "ios"
            )))]
            {
                let _ = (bootstrap, events);
                Err(SshError::new(
                    "mosh_unsupported",
                    "Mosh is not available on this platform",
                ))
            }
        })
        .await
}

pub(crate) async fn spawn_native_terminal<Driver>(
    state: &AppState,
    creation: AccessLease,
    parent: Arc<Session>,
    events: Channel<SshEvent>,
    name: &'static str,
    validate_size: fn(u32, u32) -> Result<()>,
    driver: Driver,
) -> Result<Connected>
where
    Driver: FnOnce(
        AccessState,
        mpsc::Receiver<Input>,
        watch::Receiver<bool>,
        watch::Receiver<bool>,
        mpsc::Sender<Vec<u8>>,
        tokio::sync::oneshot::Sender<Result<()>>,
    ) -> tauri::async_runtime::JoinHandle<Result<()>>,
{
    let (input, input_rx) = mpsc::channel(32);
    let (cancel, cancellation) = watch::channel(false);
    let session = Arc::new(Session::new(
        parent.handle.clone(),
        input,
        cancel,
        creation,
        validate_size,
    ));
    let mut pending = PendingTerminal {
        session: session.clone(),
        armed: true,
    };
    let id = register_terminal(state, &session).await?;
    let (output, mut output_rx) = mpsc::channel(1);
    let (ready, response) = tokio::sync::oneshot::channel();
    let initial_cancel = parent.cancel.subscribe();
    let worker = driver(
        session.access.clone(),
        input_rx,
        cancellation,
        initial_cancel,
        output,
        ready,
    );
    let sessions = state.sessions.clone();
    let retiring = state.retiring.clone();
    let task_id = id.clone();
    let active = session.clone();
    tauri::async_runtime::spawn(async move {
        let completion = SessionCompletion::new(active.finished.clone());
        let mut cancelled = active.cancel.subscribe();
        let delivery: Result<()> = async {
            loop {
                if *cancelled.borrow() {
                    break;
                }
                tokio::select! {
                    _ = cancelled.changed() => break,
                    item = output_rx.recv() => match item {
                        Some(bytes) => send_output(&active, &events, &bytes).await?,
                        None => break,
                    }
                }
            }
            Ok(())
        }
        .await;
        let _ = active.cancel.send(true);
        active.output_credits.close();
        drop(output_rx);
        let native = worker
            .await
            .map_err(|_| {
                SshError::new(
                    "terminal_worker",
                    format!("{name} worker ended unexpectedly"),
                )
            })
            .and_then(|result| result);
        retire_session(&sessions, &retiring, &task_id, &active).await;
        completion.finish();
        close_output(
            &active.access,
            Some((&active.creation, &active.adopted, &active.renderer_gone)),
            &events,
            delivery
                .and(native)
                .err()
                .map(|error| error.message)
                .unwrap_or_else(|| "Session closed".into()),
        )
        .await;
        retiring.lock().await.remove(&task_id);
    });
    let mut parent_cancel = parent.cancel.subscribe();
    let connected = if *parent_cancel.borrow() {
        Err(SshError::new(
            "cancelled",
            format!("{name} connection was cancelled"),
        ))
    } else {
        tokio::select! {
            _ = parent_cancel.changed() => Err(SshError::new("cancelled", format!("{name} connection was cancelled"))),
            result = response => match result { Ok(response) => response, Err(_) => Err(SshError::new("terminal_worker", format!("{name} worker did not complete the connection"))) },
        }
    };
    if let Err(error) = connected {
        let _ = session.cancel.send(true);
        session.output_credits.close();
        state.sessions.lock().await.remove(&id);
        return Err(error);
    }
    if *parent.cancel.borrow() {
        let _ = session.cancel.send(true);
        session.output_credits.close();
        state.sessions.lock().await.remove(&id);
        return Err(SshError::new(
            "cancelled",
            format!("{name} connection was cancelled"),
        ));
    }
    pending.armed = false;
    Ok(Connected { session_id: id })
}

async fn terminal_io<F, T>(session: &Session, future: F) -> Result<T>
where
    F: std::future::Future<Output = std::result::Result<T, russh::Error>>,
{
    let mut cancel = session.cancel.subscribe();
    if *cancel.borrow() {
        return Err(SshError::new("disconnected", "Terminal closed"));
    }
    tokio::select! {
        _=cancel.changed()=>Err(SshError::new("disconnected","Terminal closed")),
        result=timeout(OP_TIMEOUT,future)=>result.map_err(|_|SshError::new("timeout","Terminal I/O timed out"))?.map_err(Into::into)
    }
}
#[tauri::command]
pub async fn ack_output(state: State<'_, AppState>, session_id: String, bytes: u32) -> Result<()> {
    let session = state.session(&session_id).await?;
    acknowledge(&session, bytes)
}
fn acknowledge(session: &Session, bytes: u32) -> Result<()> {
    let mut outstanding = session
        .output_inflight
        .lock()
        .map_err(|_| SshError::new("ssh_error", "Output accounting failed"))?;
    if bytes == 0 || bytes > *outstanding {
        return Err(SshError::new(
            "invalid_ack",
            "Output acknowledgment exceeds pending data",
        ));
    }
    *outstanding -= bytes;
    session.output_credits.add_permits(bytes as usize);
    Ok(())
}

pub(crate) fn check_size(cols: u32, rows: u32) -> Result<()> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        return Err(SshError::new(
            "invalid_size",
            "Terminal dimensions must be between 1 and 1000",
        ));
    }
    Ok(())
}
#[tauri::command]
pub async fn write_stdin(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    data: String,
    steps: Option<Vec<String>>,
) -> AccessResult<()> {
    lease
        .run(async {
            let data = crate::terminal_input::InputSequence::parse(data, steps)
                .map_err(|message| SshError::new("input_too_large", message))?;
            state
                .session(&session_id)
                .await?
                .input
                .try_send(Input::Data(data, lease.clone()))
                .map_err(|_| {
                    SshError::new(
                        "backpressure",
                        "Terminal input queue is full or disconnected",
                    )
                })?;
            Ok(())
        })
        .await
}
#[tauri::command]
pub async fn resize(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AccessResult<()> {
    lease
        .run(async {
            check_size(cols, rows)?;
            let session = state.session(&session_id).await?;
            (session.validate_size)(cols, rows)?;
            session
                .input
                .send(Input::Resize(cols, rows, lease.clone()))
                .await
                .map_err(|_| SshError::new("disconnected", "Session is disconnected"))?;
            Ok(())
        })
        .await
}
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<()> {
    disconnect_inner(&state, session_id).await
}
async fn disconnect_inner(state: &AppState, session_id: String) -> Result<()> {
    let session = { state.sessions.lock().await.remove(&session_id) };
    if let Some(session) = session {
        let _ = session.cancel.send(true);
        session.output_credits.close();
    }
    Ok(())
}

fn check_path(path: &str) -> Result<()> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(SshError::new("invalid_path", "Enter a valid remote path"));
    }
    Ok(())
}
async fn sftp_channel(
    session: &Session,
    lease: &AccessLease,
) -> Result<russh::ChannelStream<client::Msg>> {
    let channel = open_owned_channel(
        &session.handle,
        lease,
        tokio::time::Instant::now() + OP_TIMEOUT,
    )
    .await?;
    lease.check()?;
    channel.request_subsystem(true, "sftp").await?;
    Ok(channel.into_stream())
}
pub(crate) async fn sftp(session: &Session, lease: &AccessLease) -> Result<SftpSession> {
    Ok(SftpSession::new(crate::sftp_stream::SftpStream::new(
        sftp_channel(session, lease).await?,
    ))
    .await?)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    is_dir: bool,
    size: u64,
}
#[tauri::command]
pub async fn list_directory(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AccessResult<Vec<FileEntry>> {
    lease
        .run(async {
            check_path(&path)?;
            let session = state.session(&session_id).await?;
            let raw = timeout(OP_TIMEOUT, async {
                let raw = russh_sftp::client::RawSftpSession::new(
                    crate::sftp_stream::SftpStream::new(sftp_channel(&session, &lease).await?),
                );
                raw.init().await?;
                Ok::<_, SshError>(raw)
            })
            .await
            .map_err(|_| SshError::new("timeout", "Opening SFTP timed out"))??;
            let handle = raw.opendir(path).await?.handle;
            let result = match timeout(OP_TIMEOUT, async {
                let mut entries = Vec::new();
                let mut name_bytes = 0usize;
                loop {
                    match raw.readdir(handle.clone()).await {
                        Ok(batch) => {
                            for entry in batch.files {
                                if entry.filename == "." || entry.filename == ".." {
                                    continue;
                                }
                                name_bytes += entry.filename.len();
                                if entries.len() >= 10000 || name_bytes > 2 * 1024 * 1024 {
                                    return Err(SshError::new(
                                "directory_too_large",
                                "Directory preview is limited to 10000 entries or 2 MiB of names",
                            ));
                                }
                                entries.push(FileEntry {
                                    name: entry.filename,
                                    is_dir: entry.attrs.is_dir(),
                                    size: entry.attrs.size.unwrap_or(0),
                                });
                            }
                        }
                        Err(russh_sftp::client::error::Error::Status(status))
                            if status.status_code == russh_sftp::protocol::StatusCode::Eof =>
                        {
                            break
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                entries.sort_by(|a, b| {
                    b.is_dir
                        .cmp(&a.is_dir)
                        .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
                Ok(entries)
            })
            .await
            {
                Ok(result) => result,
                Err(_) => Err(SshError::new("timeout", "Directory listing timed out")),
            };
            let _ = timeout(Duration::from_secs(2), raw.close(handle)).await;
            let _ = raw.close_session();
            result
        })
        .await
}

#[tauri::command]
pub async fn read_file(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AccessResult<String> {
    lease
        .run(async {
            check_path(&path)?;
            let session = state.session(&session_id).await?;
            timeout(OP_TIMEOUT, async {
                let sftp = sftp(&session, &lease).await?;
                let file = sftp.open(path).await?;
                let mut bytes = Vec::new();
                file.take(FILE_LIMIT + 1).read_to_end(&mut bytes).await?;
                if bytes.len() as u64 > FILE_LIMIT {
                    return Err(SshError::new(
                        "file_too_large",
                        "Text preview is limited to 1 MiB",
                    ));
                }
                String::from_utf8(bytes)
                    .map_err(|_| SshError::new("binary_file", "This file is not UTF-8 text"))
            })
            .await
            .map_err(|_| SshError::new("timeout", "Reading file timed out"))?
        })
        .await
}
#[cfg(test)]
async fn upload_file(
    lease: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    data: Vec<u8>,
) -> AccessResult<crate::attachment_upload::Uploaded> {
    let reserved = crate::attachment_upload::upload_reserve(
        lease.clone(),
        state.clone(),
        session_id.clone(),
        data.len(),
    )
    .await?
    .into_inner()
    .map_err(GuardedError::from)?;
    crate::attachment_upload::upload_file(lease, state, session_id, reserved.upload_id, path, data)
        .await
}
// Closing the raw SFTP session drops its close-owned channel even when the
// transfer future is dropped by cancellation, access revocation or timeout.
struct UploadSftp(Option<SftpSession>);
impl Drop for UploadSftp {
    fn drop(&mut self) {
        if let Some(sftp) = self.0.take() {
            tauri::async_runtime::spawn(async move {
                let _ = timeout(Duration::from_secs(2), sftp.close()).await;
            });
        }
    }
}
pub(crate) async fn transfer_file(
    session: &Session,
    lease: &AccessLease,
    path: String,
    data: Vec<u8>,
    ownership: &crate::attachment_upload::Work,
) -> Result<crate::attachment_upload::Uploaded> {
    check_path(&path)?;
    if data.len() > UPLOAD_LIMIT {
        return Err(SshError::new(
            "file_too_large",
            "Upload is limited to 10 MiB",
        ));
    }
    timeout(OP_TIMEOUT, async {
        let stream = crate::sftp_stream::SftpStream::with_cancellation(
            sftp_channel(session, lease).await?,
            ownership.cancellation(),
            ownership.cancellation(),
            ownership.retention(),
        );
        transfer_sftp(SftpSession::new(stream).await?, path, data).await
    })
    .await
    .map_err(|_| {
        SshError::new(
            "timeout",
            "Upload timed out; check for a partial remote file",
        )
    })?
}
pub(crate) async fn transfer_sftp(
    sftp: SftpSession,
    path: String,
    data: Vec<u8>,
) -> Result<crate::attachment_upload::Uploaded> {
    let sftp = UploadSftp(Some(sftp));
    let path = upload_path::destination(sftp.0.as_ref().unwrap(), path).await?;
    let mut file = sftp
        .0
        .as_ref()
        .unwrap()
        .open_with_flags(
            path.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await?;
    if let Err(error) = file.write_all(&data).await {
        let _ = file.shutdown().await;
        return Err(SshError::new(
            "upload_failed",
            format!("{error}. A partial new file may remain at {path}."),
        ));
    }
    file.shutdown().await?;
    Ok(crate::attachment_upload::Uploaded { path })
}
pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub(crate) async fn exec(
    session: &Session,
    lease: &AccessLease,
    command: String,
) -> Result<String> {
    exec_for_access(session, command, lease).await
}
pub(crate) async fn exec_for_access(
    session: &Session,
    command: String,
    lease: &AccessLease,
) -> Result<String> {
    lease.check()?;
    let mut cancellation = session.cancel.subscribe();
    if *cancellation.borrow() {
        return Err(SshError::new("disconnected", "Session closed"));
    }
    tokio::select! {
        biased;
        _ = lease.cancelled() => Err(SshError::new("app_locked", "App access changed")),
        _ = cancellation.changed() => Err(SshError::new("disconnected", "Session closed")),
        result = exec_inner(session, command, lease) => result,
    }
}
async fn exec_inner(session: &Session, command: String, lease: &AccessLease) -> Result<String> {
    let mut channel = open_owned_channel(
        &session.handle,
        lease,
        tokio::time::Instant::now() + OP_TIMEOUT,
    )
    .await?;
    let result = timeout(OP_TIMEOUT, async {
        lease.check()?;
        channel.exec(true, command).await?;
        let mut bytes = Vec::new();
        let mut error = Vec::new();
        let mut status = None;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => bytes.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => error.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
            if bytes.len() + error.len() > FILE_LIMIT as usize {
                return Err(SshError::new(
                    "output_too_large",
                    "Remote command output exceeds 1 MiB",
                ));
            }
        }
        if status != Some(0) {
            let message = String::from_utf8_lossy(&error);
            return Err(SshError::new(
                "remote_command_failed",
                if message.trim().is_empty() {
                    format!("Remote command exited with status {status:?}")
                } else {
                    message.trim().to_owned()
                },
            ));
        }
        String::from_utf8(bytes)
            .map_err(|_| SshError::new("invalid_output", "Remote command did not return UTF-8"))
    })
    .await
    .map_err(|_| SshError::new("timeout", "Remote command timed out"));
    let _ = timeout(Duration::from_secs(2), channel.close()).await;
    result?
}
#[tauri::command]
pub async fn get_diff(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    path: String,
    staged: bool,
) -> AccessResult<String> {
    lease
        .run(async {
            check_path(&path)?;
            let session = state.session(&session_id).await?;
            exec(
                &session,
                &lease,
                format!(
                    "git --no-pager -C {} diff --no-ext-diff --no-textconv {} --",
                    quote(&path),
                    if staged { "--cached" } else { "" }
                ),
            )
            .await
        })
        .await
}
#[tauri::command]
pub async fn agent_snapshot(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
) -> AccessResult<serde_json::Value> {
    lease
        .run(async {
            let session = state.session(&session_id).await?;
            let text = exec(&session, &lease, "lazysh-agent snapshot --limit 50".into()).await?;
            Ok(serde_json::from_str(&text)?)
        })
        .await
}

fn validate_transcript_source(agent: &str, path: &str, offset: u64) -> Result<()> {
    check_path(path)?;
    if !matches!(
        agent,
        "claude"
            | "codex"
            | "pi"
            | "omp"
            | "hermes"
            | "opencode"
            | "copilot"
            | "qoder-ide"
            | "kimi"
            | "jcode"
            | "droid"
            | "cursor"
            | "omo"
            | "devin-atif"
            | "amp-json"
            | "grok-acp"
            | "antigravity-jsonl"
    ) || offset > 9_007_199_254_740_991
    {
        return Err(SshError::new(
            "invalid_input",
            "Invalid transcript adapter or cursor",
        ));
    }
    Ok(())
}

fn transcript_command(
    agent: &str,
    path: &str,
    offset: u64,
    checkpoint: Option<&str>,
) -> Result<String> {
    validate_transcript_source(agent, path, offset)?;
    let mut command = format!(
        "lazysh-agent transcript --agent {agent} --path {} --offset {offset} --limit 50",
        quote(path)
    );
    if agent == "antigravity-jsonl" && offset > 0 && checkpoint.is_none() {
        return Err(SshError::new(
            "invalid_input",
            "Reopen the transcript from zero with a snapshot checkpoint",
        ));
    }
    if let Some(checkpoint) = checkpoint {
        if agent != "antigravity-jsonl"
            || checkpoint.len() > 96
            || !checkpoint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b':' || b == b'v')
        {
            return Err(SshError::new(
                "invalid_input",
                "Invalid transcript checkpoint",
            ));
        }
        command.push_str(&format!(" --checkpoint={}", quote(checkpoint)));
    }
    Ok(command)
}

async fn transcript_result(
    lease: &AccessLease,
    state: &AppState,
    session_id: &str,
    mut command: String,
    transcript_session_id: Option<String>,
) -> Result<serde_json::Value> {
    if let Some(id) = transcript_session_id {
        if id.is_empty() || id.len() > 4096 || id.chars().any(char::is_control) {
            return Err(SshError::new(
                "invalid_input",
                "Invalid transcript session identifier",
            ));
        }
        command.push_str(&format!(" --session-id={}", quote(&id)));
    }
    let session = state.session(session_id).await?;
    Ok(serde_json::from_str(
        &exec(&session, lease, command).await?,
    )?)
}

#[tauri::command]
pub async fn agent_usage(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    agent: String,
    path: String,
    offset: u64,
    transcript_session_id: Option<String>,
) -> AccessResult<serde_json::Value> {
    lease
        .run(async {
            validate_transcript_source(&agent, &path, offset)?;
            let command = format!(
                "lazysh-agent usage --agent {agent} --path={} --offset {offset}",
                quote(&path)
            );
            transcript_result(&lease, &state, &session_id, command, transcript_session_id).await
        })
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_transcript(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    agent: String,
    path: String,
    offset: u64,
    view: Option<String>,
    checkpoint: Option<String>,
    transcript_session_id: Option<String>,
) -> AccessResult<serde_json::Value> {
    lease
        .run(async {
            let mut command = transcript_command(&agent, &path, offset, checkpoint.as_deref())?;
            match view.as_deref() {
                None | Some("records") => {}
                Some("conversation") if agent == "claude" && offset == 0 => {
                    command.push_str(" --view conversation")
                }
                _ => {
                    return Err(SshError::new(
                        "invalid_input",
                        "Unsupported transcript view",
                    ))
                }
            }
            transcript_result(&lease, &state, &session_id, command, transcript_session_id).await
        })
        .await
}

#[tauri::command]
pub async fn agent_transcripts(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    agent: String,
) -> AccessResult<serde_json::Value> {
    lease
        .run(async {
            if matches!(agent.as_str(), "antigravity-jsonl") {
                return Err(SshError::new(
                    "invalid_input",
                    "This adapter requires an explicitly selected transcript file",
                ));
            }
            if !matches!(
                agent.as_str(),
                "claude"
                    | "codex"
                    | "pi"
                    | "omp"
                    | "hermes"
                    | "opencode"
                    | "copilot"
                    | "qoder-ide"
                    | "kimi"
                    | "jcode"
                    | "droid"
                    | "cursor"
                    | "omo"
                    | "devin-atif"
                    | "amp-json"
                    | "grok-acp"
            ) {
                return Err(SshError::new(
                    "invalid_input",
                    "Unsupported transcript adapter",
                ));
            }
            let session = state.session(&session_id).await?;
            Ok(serde_json::from_str(
                &exec(
                    &session,
                    &lease,
                    format!("lazysh-agent discover --agent {agent} --limit 50"),
                )
                .await?,
            )?)
        })
        .await
}
#[derive(Serialize)]
pub struct MuxSession {
    id: String,
    name: String,
    windows: u32,
    attached: bool,
}
#[tauri::command]
pub async fn list_multiplexer_sessions(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    tmux_server: Option<String>,
) -> AccessResult<Vec<MuxSession>> {
    lease.run(async {

    let session = state.session(&session_id).await?;
    let server = crate::tmux_server::TmuxServer::for_session(&session, tmux_server.as_deref())?;
    let text=exec(&session, &lease,format!("{} list-sessions -F '#{{session_id}}\t#{{session_name}}\t#{{session_windows}}\t#{{session_attached}}'", server.prefix())).await?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let f = line.split('\t').collect::<Vec<_>>();
            if f.len() != 4 {
                return None;
            }
            Some(MuxSession {
                id: f[0].into(),
                name: f[1].into(),
                windows: f[2].parse().ok()?,
                attached: f[3] != "0",
            })
        })
        .collect())
    }).await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn attach_tmux(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    tmux_server: Option<String>,
    name: String,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> AccessResult<Connected> {
    lease
        .run(async {
            attach_tmux_inner(
                &state,
                lease.clone(),
                session_id,
                tmux_server,
                name,
                cols,
                rows,
                events,
            )
            .await
        })
        .await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn attach_multiplexer(
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    tmux_server: Option<String>,
    kind: crate::multiplexer::MultiplexerKind,
    name: String,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> AccessResult<Connected> {
    lease
        .run(async {
            // Both public tmux attachment entry points must establish the same
            // native display binding; frontend routing is not the authority.
            if matches!(kind, crate::multiplexer::MultiplexerKind::Tmux) {
                return attach_tmux_inner(
                    &state,
                    lease.clone(),
                    session_id,
                    tmux_server,
                    name,
                    cols,
                    rows,
                    events,
                )
                .await;
            }
            if tmux_server.is_some() {
                return Err(SshError::new(
                    "invalid_tmux_server",
                    "tmux server context is only valid for tmux",
                ));
            }
            check_size(cols, rows)?;
            let command = crate::multiplexer::attach_command(kind, &name)?;
            let parent = state.session(&session_id).await?;
            let (channel, initial) =
                open_terminal_for(&parent.handle, &lease, cols, rows, Some(command)).await?;
            spawn_terminal(
                &state,
                lease.clone(),
                parent.handle.clone(),
                channel,
                initial,
                events,
            )
            .await
        })
        .await
}
#[allow(clippy::too_many_arguments)]
async fn attach_tmux_inner(
    state: &AppState,
    creation: AccessLease,
    session_id: String,
    tmux_server: Option<String>,
    name: String,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> Result<Connected> {
    check_size(cols, rows)?;
    if name.is_empty() || name.len() > 200 || name.chars().any(char::is_control) {
        return Err(SshError::new(
            "invalid_session",
            "Invalid tmux session name",
        ));
    }
    let parent = state.session(&session_id).await?;
    let server = crate::tmux_server::TmuxServer::parse(tmux_server.as_deref())?;
    let marker = format!("LAZYSH_ATTACH_{}", uuid::Uuid::new_v4().simple());
    let command = crate::tmux_jump::attach_command(&name, &marker, &server);
    let (mut channel, mut initial) =
        open_terminal_for(&parent.handle, &creation, cols, rows, Some(command)).await?;
    let identity = crate::tmux_jump::handshake(&mut channel, &mut initial, &marker).await;
    let control = match identity {
        Some(identity) => {
            crate::tmux_jump::prepare(&parent.handle, identity, &name, &server, &creation).await
        }
        None => None,
    };
    let connected = spawn_terminal(
        state,
        creation,
        parent.handle.clone(),
        channel,
        initial,
        events,
    )
    .await?;
    let child = state.session(&connected.session_id).await?;
    *child
        .tmux_server
        .lock()
        .map_err(|_| SshError::new("tmux_unavailable", "Cannot bind tmux server"))? = Some(server);
    if let Some(control) = control {
        *child
            .tmux
            .lock()
            .map_err(|_| SshError::new("tmux_unavailable", "Cannot bind tmux display"))? =
            Some(crate::tmux_jump::start(control, child.cancel.subscribe()));
    }
    Ok(connected)
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    fn fixture_state() -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().into()).unwrap();
        (directory, state)
    }
    fn ed25519_key() -> russh::keys::PrivateKey {
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap()
    }
    struct TerminalFixture {
        server: TestServer,
        task: tokio::task::JoinHandle<()>,
        directory: tempfile::TempDir,
        state: AppState,
        rx: mpsc::UnboundedReceiver<serde_json::Value>,
        connected: Connected,
    }
    async fn json_terminal_fixture() -> TerminalFixture {
        let (host, server, task) = server(false).await;
        let (directory, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let (events, rx) = json_events();
        let connected = password_terminal(&state, &host, events).await;
        TerminalFixture {
            server,
            task,
            directory,
            state,
            rx,
            connected,
        }
    }
    async fn password_handle(state: &AppState, host: &Host) -> Arc<SshHandle> {
        Arc::new(
            authenticate(state, host, Some("test-password".into()), None, None)
                .await
                .unwrap(),
        )
    }
    async fn password_error(state: &AppState, host: &Host) -> SshError {
        authenticate(state, host, Some("test-password".into()), None, None)
            .await
            .err()
            .unwrap()
    }
    async fn key_handle(
        state: &AppState,
        host: &Host,
        key: &russh::keys::PrivateKey,
    ) -> Arc<SshHandle> {
        Arc::new(
            authenticate(
                state,
                host,
                None,
                Some(key.to_openssh(Default::default()).unwrap().to_string()),
                None,
            )
            .await
            .unwrap(),
        )
    }
    async fn password_terminal(
        state: &AppState,
        host: &Host,
        events: Channel<SshEvent>,
    ) -> Connected {
        start_session(
            state,
            host.id.clone(),
            Some("test-password".into()),
            None,
            None,
            80,
            24,
            events,
        )
        .await
        .unwrap()
    }
    async fn finish_session(session: &Session) {
        session.cancel.send_replace(true);
        timeout(Duration::from_secs(3), async {
            while !*session.finished.borrow() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    fn metadata_host(id: &str, name: &str) -> Host {
        Host {
            transport: None,
            mosh: None,
            et: None,
            id: id.into(),
            name: name.into(),
            hostname: "example.test".into(),
            port: 22,
            username: "user".into(),
            fingerprint: None,
            credentials_stored: false,
            jump_host_id: None,
            forward_agent: false,
            biometric_unlock: false,
        }
    }
    fn access_lease() -> crate::app_lock::AccessLease {
        crate::app_lock::AccessState::disabled()
            .lease(None)
            .unwrap()
    }
    use super::*;
    use russh::{server, ChannelId, Pty};
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn closing_during_delayed_verification_aborts_transport_before_credentials() {
        let (_directory, state) = fixture_state();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (accepted, ready) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            accepted.send(()).unwrap();
            // Withhold the SSH identification, so verification cannot finish.
            let mut buffer = [0; 512];
            while stream.read(&mut buffer).await.unwrap() != 0 {}
        });
        let host = Host {
            transport: None,
            mosh: None,
            et: None,
            id: "delayed".into(),
            name: "Delayed".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: "user".into(),
            fingerprint: None,
            credentials_stored: false,
            biometric_unlock: true,
            jump_host_id: None,
            forward_agent: false,
        };
        let operations = tauri_plugin_lazysh_vault::CredentialOperations::default();
        let operation = operations.begin();
        let credential_reads = Arc::new(AtomicUsize::new(0));
        let reads = credential_reads.clone();
        let connection = tokio::spawn(async move {
            let handle = during_connect(&operation, verified_connection(&state, &host)).await?;
            reads.fetch_add(1, Ordering::SeqCst);
            close_failed_connect(&handle).await;
            Ok::<_, SshError>(())
        });
        ready.await.unwrap();
        operations.cancel();
        assert_eq!(connection.await.unwrap().unwrap_err().kind, "cancelled");
        assert_eq!(credential_reads.load(Ordering::SeqCst), 0);
        timeout(Duration::from_secs(2), peer)
            .await
            .unwrap()
            .unwrap();
        assert!(operations.begin().check().is_ok());
    }

    #[tokio::test]
    async fn credential_operations_serialize_remember_then_forget_without_blocking_other_hosts() {
        let (_dir, state) = fixture_state();
        let first = state.credential_guard("one").await;
        let other_host = timeout(Duration::from_millis(100), state.credential_guard("two"))
            .await
            .unwrap();
        drop(other_host);
        let saved = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let forgotten = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task = {
            let state = state.clone();
            let saved = saved.clone();
            let forgotten = forgotten.clone();
            tokio::spawn(async move {
                let _guard = state.credential_guard("one").await;
                assert!(saved.load(Ordering::SeqCst));
                saved.store(false, Ordering::SeqCst);
                forgotten.store(true, Ordering::SeqCst);
            })
        };
        tokio::task::yield_now().await;
        assert!(!forgotten.load(Ordering::SeqCst));
        saved.store(true, Ordering::SeqCst);
        drop(first);
        task.await.unwrap();
        assert!(!saved.load(Ordering::SeqCst));
        assert!(forgotten.load(Ordering::SeqCst));
    }

    #[test]
    fn transport_preferences_validate_and_survive_host_reload() {
        let legacy = serde_json::json!({
            "id":"transport-host", "name":"Transport", "hostname":"example.test",
            "port":22, "username":"user"
        });
        let old: Host = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(old.transport, None);
        let mut value = legacy;
        value["transport"] = serde_json::json!("auto");
        value["mosh"] =
            serde_json::json!({"serverPath":"mosh-server","portMin":60000,"portMax":61000});
        value["et"] = serde_json::json!({"serverPath":"etterminal","port":2022});
        let host: Host = serde_json::from_value(value.clone()).unwrap();
        let (dir, state) = fixture_state();
        save_host_inner(&state, host).unwrap();
        let reloaded = AppState::new(dir.path().into())
            .unwrap()
            .host("transport-host")
            .unwrap();
        assert_eq!(reloaded.transport, Some(Transport::Auto));
        let saved = serde_json::to_value(reloaded).unwrap();
        assert_eq!(saved["mosh"], value["mosh"]);
        assert_eq!(saved["et"]["port"], 2022);
        for (field, bad) in [
            ("mosh", serde_json::json!({"portMin":0})),
            ("mosh", serde_json::json!({"portMin":1,"portMax":65535})),
            ("et", serde_json::json!({"port":0})),
            ("et", serde_json::json!({"serverPath":"bad\npath"})),
        ] {
            let mut invalid = value.clone();
            invalid[field] = bad;
            let host: Host = serde_json::from_value(invalid).unwrap();
            assert!(save_host_inner(&state, host).is_err());
        }
        value["transport"] = serde_json::json!("unknown");
        assert!(serde_json::from_value::<Host>(value).is_err());
    }

    #[test]
    fn credential_cleanup_metadata_is_native_owned_and_survives_restart() {
        let (dir, state) = fixture_state();
        let mut host = metadata_host("credential-host", "Credentials");
        host.credentials_stored = true;
        let mut host = save_host_inner(&state, host).unwrap();
        assert!(!host.credentials_stored);
        state.mark_credentials(&host.id, true).unwrap();
        host.credentials_stored = false;
        let host = save_host_inner(&state, host).unwrap();
        assert!(host.credentials_stored);
        let reloaded = AppState::new(dir.path().into()).unwrap();
        assert!(reloaded.host(&host.id).unwrap().credentials_stored);
        reloaded.mark_credentials(&host.id, false).unwrap();
        assert!(
            !AppState::new(dir.path().into())
                .unwrap()
                .host(&host.id)
                .unwrap()
                .credentials_stored
        );
    }

    #[test]
    fn biometric_policy_changes_preserve_saved_identities_until_explicit_forget() {
        for initially_protected in [false, true] {
            let (dir, state) = fixture_state();
            let mut host = metadata_host("saved-identity", "Saved identity");
            host.fingerprint = Some("SHA256:verified".into());
            host.biometric_unlock = initially_protected;
            state.config().unwrap().hosts.push(host.clone());
            state.mark_credentials(&host.id, true).unwrap();
            let before = fs::read(dir.path().join("hosts.json")).unwrap();
            let mut changed = host.clone();
            changed.biometric_unlock = !initially_protected;
            changed.name = "Uncommitted edit".into();
            changed.credentials_stored = false;
            let error = save_host_inner(&state, changed.clone()).unwrap_err();
            assert_eq!(error.kind, "credential_policy_change");
            assert!(error.message.contains("Forget saved credentials"));
            assert_eq!(fs::read(dir.path().join("hosts.json")).unwrap(), before);
            let retained = AppState::new(dir.path().into())
                .unwrap()
                .host(&host.id)
                .unwrap();
            assert!(retained.credentials_stored);
            assert_eq!(retained.biometric_unlock, initially_protected);
            assert_eq!(retained.name, "Saved identity");
            state.mark_credentials(&host.id, false).unwrap();
            let saved = save_host_inner(&state, changed).unwrap();
            assert_eq!(saved.biometric_unlock, !initially_protected);
            assert!(!saved.credentials_stored);
        }
    }

    #[tokio::test]
    async fn deleting_bastion_rechecks_dependencies_added_while_vault_removal_is_pending() {
        let (_dir, state) = fixture_state();
        let jump = Host {
            transport: None,
            mosh: None,
            et: None,
            id: "jump".into(),
            name: "Jump".into(),
            hostname: "jump.test".into(),
            port: 22,
            username: "user".into(),
            fingerprint: None,
            credentials_stored: false,
            biometric_unlock: false,
            jump_host_id: None,
            forward_agent: false,
        };
        let mut target = Host {
            transport: None,
            mosh: None,
            et: None,
            id: "target".into(),
            name: "Target".into(),
            hostname: "target.test".into(),
            ..jump.clone()
        };
        save_host_inner(&state, jump).unwrap();
        save_host_inner(&state, target.clone()).unwrap();
        let (ready, pending) = tokio::sync::oneshot::channel();
        let (resume, resumed) = tokio::sync::oneshot::channel();
        let deletion = {
            let state = state.clone();
            tokio::spawn(async move {
                let _guard = state.credential_guard("jump").await;
                assert!(!state
                    .config()
                    .unwrap()
                    .hosts
                    .iter()
                    .any(|host| host.jump_host_id.as_deref() == Some("jump")));
                ready.send(()).unwrap();
                resumed.await.unwrap();
                remove_host_metadata(&state, "jump")
            })
        };
        pending.await.unwrap();
        {
            let _guard = state.credential_guard("target").await;
            target.jump_host_id = Some("jump".into());
            save_host_inner(&state, target).unwrap();
        }
        resume.send(()).unwrap();
        let error = deletion.await.unwrap().unwrap_err();
        assert_eq!(error.kind, "host_in_use");
        assert!(state.host("jump").is_ok());
        assert_eq!(
            state.host("target").unwrap().jump_host_id.as_deref(),
            Some("jump")
        );
    }

    #[test]
    fn transcript_command_rejects_adapter_injection_and_quotes_paths() {
        assert_eq!(transcript_command("grok-acp", "/host/updates.jsonl", 0, None).unwrap(), "lazysh-agent transcript --agent grok-acp --path '/host/updates.jsonl' --offset 0 --limit 50");
        assert!(transcript_command("grok", "/host/updates.jsonl", 0, None).is_err());
        let checkpoint = format!("v1:100:{}", "a".repeat(64));
        assert_eq!(transcript_command("antigravity-jsonl", "/host/transcript.jsonl", 50, Some(&checkpoint)).unwrap(),
            format!("lazysh-agent transcript --agent antigravity-jsonl --path '/host/transcript.jsonl' --offset 50 --limit 50 --checkpoint='{checkpoint}'"));
        assert!(
            transcript_command("antigravity-jsonl", "/host/transcript.jsonl", 50, None).is_err()
        );
        assert!(transcript_command(
            "antigravity-jsonl",
            "/host/transcript.jsonl",
            50,
            Some("v1:100:$(execute)")
        )
        .is_err());
        assert!(
            transcript_command("claude", "/host/transcript.jsonl", 0, Some(&checkpoint)).is_err()
        );
        assert!(transcript_command("claude; touch /tmp/nope", "/a", 0, None).is_err());
        assert!(transcript_command("codex", "/a\0b", 0, None).is_err());
        assert!(transcript_command("codex", "/a", u64::MAX, None).is_err());
        assert_eq!(transcript_command("claude", "/a'b;$(cmd)", 17, None).unwrap(), "lazysh-agent transcript --agent claude --path '/a'\\''b;$(cmd)' --offset 17 --limit 50");
    }

    #[derive(Clone)]
    struct TestServer {
        auth_attempts: Arc<AtomicUsize>,
        sizes: Arc<StdMutex<Vec<(u32, u32)>>>,
        reject_pty: bool,
        freeze_window: bool,
        commands: Arc<StdMutex<Vec<String>>>,
        input_data: Arc<StdMutex<Vec<u8>>>,
        executed: Arc<tokio::sync::Notify>,
        closed: Arc<tokio::sync::Notify>,
        tmux_metadata: Arc<std::sync::atomic::AtomicBool>,
        command_channels: Arc<StdMutex<Vec<ChannelId>>>,
        closed_channels: Arc<StdMutex<Vec<ChannelId>>>,
        hold_opens: Arc<std::sync::atomic::AtomicBool>,
        held_opens: Arc<StdMutex<Vec<(ChannelId, server::ChannelOpenHandle)>>>,
        open_started: Arc<tokio::sync::Notify>,
        opening_channel: Arc<StdMutex<Option<ChannelId>>>,
    }
    impl server::Server for TestServer {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }
    impl server::Handler for TestServer {
        type Error = russh::Error;
        async fn channel_close(
            &mut self,
            channel: ChannelId,
            _: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            self.closed_channels.lock().unwrap().push(channel);
            self.closed.notify_one();
            Ok(())
        }
        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> std::result::Result<server::Auth, Self::Error> {
            self.auth_attempts.fetch_add(1, Ordering::SeqCst);
            Ok(if user == "tester" && password == "test-password" {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            })
        }
        async fn auth_publickey(
            &mut self,
            user: &str,
            _: &russh::keys::PublicKey,
        ) -> std::result::Result<server::Auth, Self::Error> {
            self.auth_attempts.fetch_add(1, Ordering::SeqCst);
            Ok(if user == "tester" {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            })
        }
        async fn channel_open_session(
            &mut self,
            channel: russh::Channel<server::Msg>,
            reply: server::ChannelOpenHandle,
            _: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            *self.opening_channel.lock().unwrap() = Some(channel.id());
            if self.hold_opens.load(Ordering::SeqCst) {
                self.held_opens.lock().unwrap().push((channel.id(), reply));
                self.open_started.notify_one();
            } else {
                reply.accept().await;
            }
            Ok(())
        }
        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<server::Msg>,
            _: &str,
            _: u32,
            _: &str,
            _: u32,
            reply: server::ChannelOpenHandle,
            session: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            self.channel_open_session(channel, reply, session).await
        }
        async fn pty_request(
            &mut self,
            channel: ChannelId,
            _: &str,
            cols: u32,
            rows: u32,
            _: u32,
            _: u32,
            _: &[(Pty, u32)],
            session: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            self.sizes.lock().unwrap().push((cols, rows));
            if self.reject_pty {
                session.channel_failure(channel)?;
            } else {
                session.channel_success(channel)?;
            }
            Ok(())
        }
        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            session.channel_success(channel)?;
            session.data(channel, b"ready\r\n".to_vec())?;
            Ok(())
        }
        async fn data(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            self.input_data.lock().unwrap().extend_from_slice(data);
            session.data(channel, data.to_vec())?;
            Ok(())
        }
        fn adjust_window(&mut self, _: ChannelId, current: u32) -> u32 {
            if self.freeze_window {
                0
            } else {
                current
            }
        }
        async fn exec_request(
            &mut self,
            channel: ChannelId,
            command: &[u8],
            session: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            let text = String::from_utf8(command.to_vec()).unwrap();
            self.command_channels.lock().unwrap().push(channel);
            self.commands
                .lock()
                .unwrap()
                .push(String::from_utf8(command.to_vec()).unwrap());
            session.channel_success(channel)?;
            if self.tmux_metadata.load(Ordering::SeqCst) {
                if let Some(start) = text.find("LAZYSH_ATTACH_") {
                    let marker = &text[start..start + 46];
                    session.data(
                        channel,
                        format!("{marker}\t42\t/dev/pts/42\r\n").into_bytes(),
                    )?;
                }
            } else {
                session.data(channel, b"attached\r\n".to_vec())?;
            }
            self.executed.notify_one();
            Ok(())
        }
        async fn window_change_request(
            &mut self,
            _: ChannelId,
            cols: u32,
            rows: u32,
            _: u32,
            _: u32,
            _: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            self.sizes.lock().unwrap().push((cols, rows));
            Ok(())
        }
    }
    async fn server(reject_pty: bool) -> (Host, TestServer, tokio::task::JoinHandle<()>) {
        server_with_window(reject_pty, false).await
    }
    #[tokio::test]
    async fn stalled_et_bootstrap_closes_its_channel_and_preserves_ssh_control() {
        assert_stalled_bootstrap_cleanup(true).await;
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    #[tokio::test]
    async fn stalled_mosh_bootstrap_closes_its_channel_and_preserves_ssh_control() {
        assert_stalled_bootstrap_cleanup(false).await;
    }
    fn adopted_fixture_session(
        handle: Arc<SshHandle>,
        input: mpsc::Sender<Input>,
        cancel: watch::Sender<bool>,
    ) -> Session {
        let mut session = Session::new(handle, input, cancel, access_lease(), check_size);
        session.access = AccessState::disabled();
        session
            .adopted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        session.finished.send_replace(true);
        session
    }
    async fn auxiliary_fixture(
        lease: AccessLease,
    ) -> (
        AppState,
        tempfile::TempDir,
        Host,
        TestServer,
        tokio::task::JoinHandle<()>,
        Arc<Session>,
    ) {
        let (host, server, task) = server(false).await;
        let (directory, state) = fixture_state();
        let handle = password_handle(&state, &host).await;
        let (input, _) = mpsc::channel(1);
        let (cancel, _) = watch::channel(false);
        let session = Arc::new(Session::new(handle, input, cancel, lease, check_size));
        (state, directory, host, server, task, session)
    }
    async fn release_held_opens(server: &TestServer) {
        server.hold_opens.store(false, Ordering::SeqCst);
        let held = std::mem::take(&mut *server.held_opens.lock().unwrap());
        for (_, reply) in held {
            reply.accept().await;
        }
    }
    async fn observe_channel_close(server: &TestServer, channel: ChannelId) -> bool {
        timeout(Duration::from_secs(3), async {
            while !server.closed_channels.lock().unwrap().contains(&channel) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok()
    }
    async fn revoke_pending<T>(
        access: &AccessState,
        pending: tokio::task::JoinHandle<std::result::Result<T, GuardedError<SshError>>>,
    ) {
        access.lock().unwrap();
        assert!(pending.await.unwrap().is_err());
        access.authorize(access.generation().unwrap()).unwrap();
    }
    async fn assert_stalled_bootstrap_cleanup(et: bool) {
        let (_state, _dir, _host, server, task, session) = auxiliary_fixture(access_lease()).await;
        let handle = session.handle.clone();
        let bootstrap = tokio::spawn(async move {
            if et {
                crate::et::bootstrap(&session, &access_lease(), crate::et::Options::default())
                    .await
                    .map(|_| ())
            } else {
                crate::mosh::bootstrap(&session, &access_lease(), crate::mosh::Options::default())
                    .await
                    .map(|_| ())
            }
        });
        server.executed.notified().await;
        let clock_guard = tokio::spawn(async {
            loop {
                tokio::task::yield_now().await;
            }
        });
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(16)).await;
        let error = bootstrap.await.unwrap().err().unwrap();
        assert_eq!(
            error.kind,
            if et { "et_bootstrap" } else { "mosh_bootstrap" }
        );
        assert_eq!(
            error.message,
            if et {
                "ET bootstrap timed out"
            } else {
                "Mosh bootstrap timed out"
            }
        );
        tokio::time::resume();
        timeout(Duration::from_secs(2), server.closed.notified())
            .await
            .expect("timed-out bootstrap must close its SSH channel");
        // ChannelClose must not tear down the retained verified connection.
        let channel = timeout(Duration::from_secs(2), handle.channel_open_session())
            .await
            .unwrap()
            .unwrap();
        channel.close().await.unwrap();
        clock_guard.abort();
        task.abort();
    }
    #[tokio::test]
    async fn forwarding_with_password_authentication_fails_before_sending_credentials() {
        let (mut host, server, task) = server(false).await;
        host.forward_agent = true;
        let (_dir, state) = fixture_state();
        let error = password_error(&state, &host).await;
        assert_eq!(error.kind, "forwarding_requires_key");
        assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 0);
        task.abort();
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn mosh_rejects_agent_forwarding_before_bootstrap_commands() {
        let (mut host, server, task) = server(false).await;
        host.forward_agent = true;
        let (_dir, state) = fixture_state();
        let key = ed25519_key();
        let handle = key_handle(&state, &host, &key).await;
        let (input, _) = mpsc::channel(1);
        let (cancel, _) = watch::channel(false);
        let session = adopted_fixture_session(handle, input, cancel);
        let error =
            crate::mosh::bootstrap(&session, &access_lease(), crate::mosh::Options::default())
                .await
                .err()
                .unwrap();
        assert_eq!(error.kind, "mosh_unsupported_forwarding");
        assert!(server.commands.lock().unwrap().is_empty());
        task.abort();
    }
    async fn server_with_window(
        reject_pty: bool,
        freeze_window: bool,
    ) -> (Host, TestServer, tokio::task::JoinHandle<()>) {
        server_with_capacity(
            reject_pty,
            freeze_window,
            if freeze_window { 128 } else { 2097152 },
        )
        .await
    }
    async fn server_with_capacity(
        reject_pty: bool,
        freeze_window: bool,
        window_size: u32,
    ) -> (Host, TestServer, tokio::task::JoinHandle<()>) {
        use server::Server;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let key = ed25519_key();
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(10),
            auth_rejection_time_initial: Some(Duration::from_millis(10)),
            window_size,
            ..Default::default()
        });
        let host = Host {
            transport: None,
            mosh: None,
            et: None,
            id: "test-host".into(),
            name: "Test".into(),
            hostname: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            username: "tester".into(),
            fingerprint: Some(fingerprint),
            jump_host_id: None,
            credentials_stored: false,
            biometric_unlock: false,
            forward_agent: false,
        };
        let test_server = TestServer {
            auth_attempts: Arc::new(AtomicUsize::new(0)),
            sizes: Arc::new(StdMutex::new(Vec::new())),
            reject_pty,
            freeze_window,
            commands: Arc::new(StdMutex::new(Vec::new())),
            input_data: Arc::new(StdMutex::new(Vec::new())),
            executed: Arc::new(tokio::sync::Notify::new()),
            closed: Arc::new(tokio::sync::Notify::new()),
            tmux_metadata: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            command_channels: Arc::new(StdMutex::new(Vec::new())),
            closed_channels: Arc::new(StdMutex::new(Vec::new())),
            hold_opens: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            held_opens: Arc::new(StdMutex::new(Vec::new())),
            open_started: Arc::new(tokio::sync::Notify::new()),
            opening_channel: Arc::new(StdMutex::new(None)),
        };
        let mut runner = test_server.clone();
        let task = tokio::spawn(async move {
            runner.run_on_socket(config, &listener).await.unwrap();
        });
        (host, test_server, task)
    }

    #[tokio::test]
    async fn output_waits_for_consumption_and_rejects_forged_credit() {
        let (host, _, server_task) = server(false).await;
        let (_dir, state) = fixture_state();
        let handle = password_handle(&state, &host).await;
        let (input, _) = mpsc::channel(32);
        let (cancel, _) = watch::channel(false);
        let session = Arc::new(adopted_fixture_session(handle, input, cancel));
        let received = Arc::new(AtomicUsize::new(0));
        let observed = received.clone();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let v: serde_json::Value = serde_json::from_str(&json).unwrap();
                observed.fetch_add(v["data"].as_array().unwrap().len(), Ordering::SeqCst);
            }
            Ok(())
        });
        let producer = session.clone();
        let sender = tokio::spawn(async move {
            send_output(&producer, &events, &vec![0; OUTPUT_WINDOW as usize + 16384])
                .await
                .unwrap();
        });
        timeout(Duration::from_secs(3), async {
            while received.load(Ordering::SeqCst) < OUTPUT_WINDOW as usize {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!sender.is_finished());
        assert!(acknowledge(&session, OUTPUT_WINDOW + 1).is_err());
        assert_eq!(session.output_credits.available_permits(), 0);
        acknowledge(&session, 16384).unwrap();
        timeout(Duration::from_secs(3), sender)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            received.load(Ordering::SeqCst),
            OUTPUT_WINDOW as usize + 16384
        );
        server_task.abort();
    }

    #[tokio::test]
    async fn tmux_attach_cancellation_closes_display_during_handshake() {
        cancelled_tmux_attach(AttachPause::Handshake).await;
    }
    #[tokio::test]
    async fn tmux_attach_cancellation_closes_display_during_control_preparation() {
        cancelled_tmux_attach(AttachPause::Control).await;
    }
    #[tokio::test]
    async fn tmux_attach_cancellation_closes_late_open_confirmation() {
        cancelled_tmux_attach(AttachPause::Open).await;
    }
    #[derive(Clone, Copy)]
    enum AttachPause {
        Handshake,
        Control,
        Open,
    }
    async fn cancelled_tmux_attach(stage: AttachPause) {
        let (host, server, task) = server(false).await;
        let (_dir, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let parent = password_terminal(&state, &host, Channel::new(|_| Ok(()))).await;
        server
            .tmux_metadata
            .store(matches!(stage, AttachPause::Control), Ordering::SeqCst);
        server
            .hold_opens
            .store(matches!(stage, AttachPause::Open), Ordering::SeqCst);
        let access = unlocked_access();
        let creation = ready_lease(&access);
        let worker_state = state.clone();
        let parent_id = parent.session_id.clone();
        let pending = tokio::spawn(async move {
            creation
                .run(attach_tmux_inner(
                    &worker_state,
                    creation.clone(),
                    parent_id,
                    None,
                    "owned".into(),
                    80,
                    24,
                    Channel::new(|_| Ok(())),
                ))
                .await
        });
        let display = if matches!(stage, AttachPause::Open) {
            timeout(Duration::from_secs(3), server.open_started.notified())
                .await
                .unwrap();
            server.opening_channel.lock().unwrap().unwrap()
        } else {
            timeout(Duration::from_secs(3), async {
                while server.commands.lock().unwrap().len()
                    < if matches!(stage, AttachPause::Control) {
                        2
                    } else {
                        1
                    }
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("fixture must reach selected attach stage");
            server.command_channels.lock().unwrap()[0]
        };
        revoke_pending(&access, pending).await;
        release_held_opens(&server).await;
        let closed = observe_channel_close(&server, display).await;
        let only_parent = state.sessions.lock().await.len() == 1;
        let parent = state.session(&parent.session_id).await.unwrap();
        let probe = parent.handle.channel_open_session().await;
        if let Ok(channel) = &probe {
            channel.close().await.unwrap();
        }
        parent.cancel.send_replace(true);
        task.abort();
        assert!(
            closed,
            "cancelled unpublished tmux display must request remote close"
        );
        assert!(
            only_parent,
            "cancelled display must never enter the native session registry"
        );
        assert!(
            probe.is_ok(),
            "cleanup must preserve the verified parent SSH transport"
        );
    }
    #[tokio::test]
    async fn cancelled_exec_closes_late_confirmation() {
        cancelled_auxiliary_open(Auxiliary::Exec).await;
    }
    #[tokio::test]
    async fn cancelled_sftp_closes_late_confirmation() {
        cancelled_auxiliary_open(Auxiliary::Sftp).await;
    }
    #[derive(Clone, Copy)]
    enum Auxiliary {
        Exec,
        Sftp,
        Preview,
        Probe,
        Bastion,
        #[cfg(any(
            target_os = "linux",
            target_os = "macos",
            target_os = "android",
            target_os = "ios"
        ))]
        Mosh,
        Et,
        Device,
    }
    #[tokio::test]
    async fn cancelled_preview_closes_late_confirmation() {
        cancelled_auxiliary_open(Auxiliary::Preview).await;
    }
    #[tokio::test]
    async fn cancelled_probe_closes_late_confirmation() {
        cancelled_auxiliary_open(Auxiliary::Probe).await;
    }
    #[tokio::test]
    async fn cancelled_bastion_closes_late_confirmation() {
        cancelled_auxiliary_open(Auxiliary::Bastion).await;
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    #[tokio::test]
    async fn cancelled_mosh_open_closes_late_confirmation() {
        cancelled_auxiliary_open(Auxiliary::Mosh).await;
    }
    #[tokio::test]
    async fn cancelled_et_open_closes_late_confirmation() {
        cancelled_auxiliary_open(Auxiliary::Et).await;
    }
    #[tokio::test]
    async fn cancelled_device_open_closes_late_confirmation() {
        cancelled_auxiliary_open(Auxiliary::Device).await;
    }
    async fn cancelled_auxiliary_open(kind: Auxiliary) {
        let access = unlocked_access();
        let lease = ready_lease(&access);
        let (state, _dir, host, server, task, session) = auxiliary_fixture(lease.clone()).await;
        let handle = session.handle.clone();
        server.hold_opens.store(true, Ordering::SeqCst);
        let original = lease.clone();
        let pending = tokio::spawn(async move {
            original
                .run(async {
                    match kind {
                        Auxiliary::Exec => exec_for_access(&session, "fixture".into(), &original)
                            .await
                            .map(|_| ()),
                        Auxiliary::Sftp => sftp(&session, &original).await.map(|_| ()),
                        Auxiliary::Preview | Auxiliary::Probe => crate::previews::remote_stream(
                            &session.handle,
                            &original,
                            "127.0.0.1",
                            4321,
                            tokio::time::Instant::now()
                                + if matches!(kind, Auxiliary::Probe) {
                                    Duration::from_millis(1500)
                                } else {
                                    Duration::from_secs(15)
                                },
                        )
                        .await
                        .map(|_| ()),
                        Auxiliary::Bastion => crate::routing::through_bastion(
                            &state,
                            &host,
                            session.handle.clone(),
                            &original,
                        )
                        .await
                        .map(|_| ()),
                        #[cfg(any(
                            target_os = "linux",
                            target_os = "macos",
                            target_os = "android",
                            target_os = "ios"
                        ))]
                        Auxiliary::Mosh => crate::mosh::bootstrap(
                            &session,
                            &original,
                            crate::mosh::Options::default(),
                        )
                        .await
                        .map(|_| ()),
                        Auxiliary::Et => {
                            crate::et::bootstrap(&session, &original, crate::et::Options::default())
                                .await
                                .map(|_| ())
                        }
                        Auxiliary::Device => {
                            let (_stop, stopped) = watch::channel(false);
                            let (output, _) =
                                watch::channel(crate::devices::stream::Packet::default());
                            crate::devices::stream::receive(
                                original.clone(),
                                session.clone(),
                                "fixture".into(),
                                "fixture".into(),
                                "android".into(),
                                stopped,
                                output,
                            )
                            .await
                        }
                    }
                })
                .await
        });
        timeout(Duration::from_secs(3), server.open_started.notified())
            .await
            .unwrap();
        let opened = server.opening_channel.lock().unwrap().unwrap();
        revoke_pending(&access, pending).await;
        release_held_opens(&server).await;
        let closed = observe_channel_close(&server, opened).await;
        assert!(
            server.commands.lock().unwrap().is_empty(),
            "a revoked invocation must never dispatch its command after reauthorization"
        );
        let probe = handle.channel_open_session().await.unwrap();
        probe.close().await.unwrap();
        task.abort();
        assert!(
            closed,
            "abandoned auxiliary open must close late peer confirmation while preserving parent"
        );
    }
    #[tokio::test]
    async fn confirmation_after_deadline_cannot_win_a_delayed_caller_poll() {
        delayed_open_poll(true).await;
    }
    #[tokio::test]
    async fn ready_confirmation_cannot_win_a_caller_poll_after_deadline() {
        delayed_open_poll(false).await;
    }
    async fn delayed_open_poll(late_confirmation: bool) {
        use std::{future::Future, task::Poll};
        let (host, server, task) = server(false).await;
        let (_dir, state) = fixture_state();
        let handle = password_handle(&state, &host).await;
        let lease = access_lease();
        server.hold_opens.store(true, Ordering::SeqCst);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut opening = Box::pin(open_owned(
            &handle,
            &lease,
            deadline,
            ChannelRequest::DirectTcp {
                host: "127.0.0.1".into(),
                port: 4321,
            },
        ));
        std::future::poll_fn(|cx| {
            assert!(opening.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        timeout(Duration::from_secs(3), server.open_started.notified())
            .await
            .unwrap();
        let channel = server.opening_channel.lock().unwrap().unwrap();
        // Leave the caller unpolled through its deadline, then let the owned
        // worker receive confirmation. This isolates ready-inner timeout ordering.
        if late_confirmation {
            tokio::time::sleep_until(deadline).await;
        }
        release_held_opens(&server).await;
        timeout(Duration::from_secs(3), async {
            while handle.open_slots.available_permits() != 4 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if !late_confirmation {
            tokio::time::sleep_until(deadline).await;
        }
        let worker_closed = !late_confirmation || observe_channel_close(&server, channel).await;
        let result = opening.await;
        let expired = matches!(result, Err(ref error) if error.kind == "timeout");
        drop(result);
        let closed = observe_channel_close(&server, channel).await;
        task.abort();
        assert!(
            expired,
            "a ready confirmation cannot override the original absolute deadline"
        );
        assert!(
            worker_closed,
            "worker must close late confirmation before caller is polled again"
        );
        assert!(closed, "deadline rejection must close the channel");
    }
    #[tokio::test]
    async fn expired_or_revoked_opens_never_reach_the_peer() {
        let access = unlocked_access();
        let original = ready_lease(&access);
        let (_state, _dir, _host, server, task, session) =
            auxiliary_fixture(original.clone()).await;
        let handle = session.handle.clone();
        for direct in [false, true] {
            let request = if direct {
                ChannelRequest::DirectTcp {
                    host: "127.0.0.1".into(),
                    port: 4321,
                }
            } else {
                ChannelRequest::Session
            };
            let result = open_owned(&handle, &original, tokio::time::Instant::now(), request).await;
            assert!(matches!(result, Err(error) if error.kind == "timeout"));
        }
        access.lock().unwrap();
        access.authorize(access.generation().unwrap()).unwrap();
        assert!(
            open_owned_channel(&handle, &original, tokio::time::Instant::now() + OP_TIMEOUT)
                .await
                .is_err()
        );
        assert_eq!(handle.open_slots.available_permits(), 4);
        assert!(server.opening_channel.lock().unwrap().is_none());
        task.abort();
    }
    #[tokio::test]
    async fn unconfirmed_channel_capacity_is_quarantined_until_last_owner_drops() {
        let (host, server, task) = server(false).await;
        let (_dir, state) = fixture_state();
        let handle = password_handle(&state, &host).await;
        let access = unlocked_access();
        let lease = ready_lease(&access);
        server.hold_opens.store(true, Ordering::SeqCst);
        let slots = handle.open_slots.clone();
        let core = Arc::downgrade(&handle.handle);
        let mut callers = tokio::task::JoinSet::new();
        for index in 0..4 {
            let handle = handle.clone();
            let lease = lease.clone();
            let allowance = if index == 0 {
                Duration::from_secs(3)
            } else {
                OP_TIMEOUT
            };
            callers.spawn(async move {
                let request = if index % 2 == 0 {
                    ChannelRequest::Session
                } else {
                    ChannelRequest::DirectTcp {
                        host: "127.0.0.1".into(),
                        port: 4321,
                    }
                };
                open_owned(
                    &handle,
                    &lease,
                    tokio::time::Instant::now() + allowance,
                    request,
                )
                .await
            });
        }
        timeout(Duration::from_secs(3), async {
            while server.held_opens.lock().unwrap().len() != 4 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("all opens must be admitted before fixture revokes them");
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(4)).await;
        let expired = callers.join_next().await.unwrap().unwrap();
        tokio::time::resume();
        assert!(matches!(expired,Err(error) if error.kind=="timeout"));
        assert_eq!(
            slots.available_permits(),
            0,
            "caller deadline cannot discard owned pending opens"
        );
        access.lock().unwrap();
        while let Some(result) = callers.join_next().await {
            assert!(result.unwrap().is_err());
        }
        assert_eq!(
            slots.available_permits(),
            0,
            "caller cancellation cannot release pending-open capacity"
        );
        access.authorize(access.generation().unwrap()).unwrap();
        let fresh = ready_lease(&access);
        let fifth = open_owned_channel(
            &handle,
            &fresh,
            tokio::time::Instant::now() + Duration::from_secs(3),
        )
        .await;
        assert!(matches!(fifth,Err(error) if error.kind=="ssh_open_busy"));
        drop(handle);
        timeout(Duration::from_secs(3), async {
            while slots.available_permits() != 4 || core.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("last outer owner must stop pending workers and release the core transport");
        // Release fixture-owned confirmations only after proving worker/core exit.
        let held = std::mem::take(&mut *server.held_opens.lock().unwrap());
        for (_, reply) in held {
            reply.accept().await;
        }
        task.abort();
    }
    #[tokio::test]
    async fn tmux_uses_a_separate_pty_and_preserves_the_parent_shell() {
        use tauri::Manager;
        let (host, server, server_task) = server(false).await;
        let (_dir, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let (events, mut rx) = event_channel(|json| json);
        let parent = password_terminal(&state, &host, events).await;
        let app = tauri::test::mock_app();
        app.manage(state.clone());
        // Exercise the generic public entry point too: it must establish the
        // same owned metadata/binding path as attach_tmux, not a bare attach.
        let child = attach_multiplexer(
            access_lease(),
            app.state(),
            parent.session_id.clone(),
            None,
            crate::multiplexer::MultiplexerKind::Tmux,
            "safe'name;touch /tmp/nope".into(),
            80,
            24,
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
        assert_ne!(parent.session_id, child.session_id);
        assert_eq!(state.sessions.lock().await.len(), 2);
        let commands = server.commands.lock().unwrap().clone();
        assert_eq!(commands.len(), 1);
        assert!(commands[0].starts_with("exec sh -c 'printf "));
        assert!(commands[0].contains("LAZYSH_ATTACH_"));
        assert!(commands[0].contains(r"; exec tmux -u -L '\''default'\'' attach-session -t "));
        assert!(commands[0].contains("name;touch /tmp/nope"));
        assert!(server.input_data.lock().unwrap().is_empty());
        let child = state.session(&child.session_id).await.unwrap();
        child.cancel.send(true).unwrap();
        child.output_credits.close();
        timeout(Duration::from_secs(3), async {
            while state.sessions.lock().await.len() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let parent_session = state.session(&parent.session_id).await.unwrap();
        parent_session
            .input
            .send(Input::Data(
                "parent-alive".to_owned().into(),
                access_lease(),
            ))
            .await
            .unwrap();
        timeout(Duration::from_secs(3), async {
            loop {
                let json = rx.recv().await.unwrap();
                let v: serde_json::Value = serde_json::from_str(&json).unwrap();
                if v["type"] == "data" {
                    let bytes = v["data"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_u64().unwrap() as u8)
                        .collect::<Vec<_>>();
                    if bytes == b"parent-alive" {
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        parent_session.cancel.send(true).unwrap();
        parent_session.output_credits.close();
        server_task.abort();
    }

    #[tokio::test]
    async fn disconnect_interrupts_a_peer_that_stops_granting_write_window() {
        use tauri::Manager;
        let (host, _, server_task) = server_with_window(false, true).await;
        let (_dir, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let app = tauri::test::mock_app();
        app.manage(state);
        let (events, mut rx) = event_channel(|json| json);
        let connected = start_session(
            &app.state(),
            host.id.clone(),
            Some("test-password".into()),
            None,
            None,
            80,
            24,
            events,
        )
        .await
        .unwrap();
        write_stdin(
            access_lease(),
            app.state(),
            connected.session_id.clone(),
            "x".repeat(65536),
            None,
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        disconnect(app.state(), connected.session_id).await.unwrap();
        timeout(Duration::from_secs(3), async {
            loop {
                let v: serde_json::Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if v["type"] == "closed" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert!(app.state::<AppState>().sessions.lock().await.is_empty());
        server_task.abort();
    }

    #[tokio::test]
    async fn launch_changed_saved_endpoint_never_authenticates_replacement_peer() {
        let (host, original, original_task) = server(false).await;
        let (mut replacement, changed, changed_task) = server(false).await;
        replacement.id = "replacement-peer".into();
        let (_dir, state) = fixture_state();
        state
            .config()
            .unwrap()
            .hosts
            .extend([host.clone(), replacement.clone()]);
        let (_access, lease, launch, receipt) = prepared_host_offer(&state, &host.id);
        replacement.id = host.id.clone();
        save_host_inner(&state, replacement).unwrap();
        let attempt = launch.begin_host(&receipt, &lease, &host.id).unwrap();
        let result = match locked_connect_host(&state, &host.id, Some(&attempt), 80, 24).await {
            Ok((current, _guard)) => {
                authenticate(&state, &current, Some("test-password".into()), None, None)
                    .await
                    .map(drop)
            }
            Err(error) => Err(error),
        };
        original_task.abort();
        changed_task.abort();
        assert_eq!(
            result.err().map(|error| error.kind),
            Some(crate::desktop_launch::HOST_CHANGED)
        );
        assert_eq!(original.auth_attempts.load(Ordering::SeqCst), 0);
        assert_eq!(changed.auth_attempts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn launch_unknown_key_explicit_trust_retry_keeps_original_frozen_profile() {
        let (mut host, peer, task) = server(false).await;
        let fingerprint = host.fingerprint.take().unwrap();
        let (_dir, state) = fixture_state();
        save_host_inner(&state, host.clone()).unwrap();
        let (_access, lease, launch, receipt) = prepared_host_offer(&state, &host.id);
        let attempt = launch.begin_host(&receipt, &lease, &host.id).unwrap();
        let (current, guard) = locked_connect_host(&state, &host.id, Some(&attempt), 80, 24)
            .await
            .unwrap();
        let error = password_error(&state, &current).await;
        drop(guard);
        drop(attempt);
        assert_eq!(error.kind, "unknown_host_key");
        assert_eq!(peer.auth_attempts.load(Ordering::SeqCst), 0);
        let expected = launch.trust_binding(&receipt, &lease, &host.id).unwrap();
        assert!(trust_host_key_inner(
            &state,
            host.id.clone(),
            "SHA256:forged".into(),
            Some(&expected)
        )
        .is_err());
        trust_host_key_inner(
            &state,
            host.id.clone(),
            fingerprint.clone(),
            Some(&expected),
        )
        .unwrap();
        launch
            .accepted_trust(&receipt, &lease, &expected, &fingerprint)
            .unwrap();
        let retry = launch.begin_host(&receipt, &lease, &host.id).unwrap();
        let (current, guard) = locked_connect_host(&state, &host.id, Some(&retry), 80, 24)
            .await
            .unwrap();
        let handle = authenticate(&state, &current, Some("test-password".into()), None, None)
            .await
            .unwrap();
        drop(handle);
        drop(guard);
        retry.finish();
        task.abort();
        assert_eq!(peer.auth_attempts.load(Ordering::SeqCst), 1);
        assert!(launch.begin_host(&receipt, &lease, &host.id).is_err());
    }

    #[tokio::test]
    async fn launch_waiting_for_credential_guard_cannot_renew_after_reunlock() {
        let (host, peer, task) = server(false).await;
        let (_dir, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let (access, lease, launch, receipt) = prepared_host_offer(&state, &host.id);
        let attempt = launch.begin_host(&receipt, &lease, &host.id).unwrap();
        let guard = state.credential_guard(&host.id).await;
        let (result, fresh) = {
            let work = locked_connect_host(&state, &host.id, Some(&attempt), 80, 24);
            tokio::pin!(work);
            assert_pending(work.as_mut()).await;
            access.lock().unwrap();
            access.authorize(access.generation().unwrap()).unwrap();
            let fresh = ready_lease(&access);
            drop(guard);
            (work.await, fresh)
        };
        task.abort();
        assert_eq!(
            result.err().map(|error| error.kind),
            Some(crate::desktop_launch::UNAVAILABLE)
        );
        assert_eq!(peer.auth_attempts.load(Ordering::SeqCst), 0);
        drop(attempt);
        assert!(launch.read(&fresh).unwrap().host_receipt.is_none());
        assert!(launch.begin_host(&receipt, &fresh, &host.id).is_err());
    }

    #[tokio::test]
    async fn untrusted_and_changed_keys_never_receive_credentials() {
        let (mut host, server, task) = server(false).await;
        let expected = host.fingerprint.take().unwrap();
        let (dir, state) = fixture_state();
        save_host_inner(&state, host.clone()).unwrap();
        let error = password_error(&state, &host).await;
        assert_eq!(error.kind, "unknown_host_key");
        assert_eq!(error.fingerprint, Some(expected.clone()));
        assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 0);
        assert!(
            trust_host_key_inner(&state, host.id.clone(), "SHA256:forged".into(), None).is_err()
        );
        trust_host_key_inner(&state, host.id.clone(), expected.clone(), None).unwrap();
        let persisted = AppState::new(dir.path().into())
            .unwrap()
            .host(&host.id)
            .unwrap();
        assert_eq!(persisted.fingerprint, Some(expected));
        let handle = authenticate(&state, &persisted, Some("test-password".into()), None, None)
            .await
            .unwrap();
        assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 1);
        drop(handle);
        let mut changed = persisted;
        changed.fingerprint = Some("SHA256:wrong".into());
        assert_eq!(
            authenticate(&state, &changed, Some("test-password".into()), None, None)
                .await
                .err()
                .unwrap()
                .kind,
            "host_key_changed"
        );
        assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 1);
        task.abort();
    }

    #[test]
    fn ui_cannot_inject_clear_or_change_a_pin() {
        let (_dir, state) = fixture_state();
        let mut host = Host {
            transport: None,
            mosh: None,
            et: None,
            id: "one".into(),
            name: "First".into(),
            hostname: "server".into(),
            port: 22,
            username: "me".into(),
            fingerprint: Some("forged".into()),
            jump_host_id: None,
            credentials_stored: false,
            biometric_unlock: false,
            forward_agent: false,
        };
        assert_eq!(
            save_host_inner(&state, host.clone()).unwrap().fingerprint,
            None
        );
        state
            .config()
            .unwrap()
            .pending
            .insert(host.id.clone(), ("server".into(), 22, "observed".into()));
        trust_host_key_inner(&state, host.id.clone(), "observed".into(), None).unwrap();
        host.fingerprint = None;
        assert_eq!(
            save_host_inner(&state, host.clone()).unwrap().fingerprint,
            Some("observed".into())
        );
        host.id = "duplicate".into();
        host.fingerprint = Some("replacement".into());
        assert_eq!(
            save_host_inner(&state, host.clone()).unwrap().fingerprint,
            Some("observed".into())
        );
        host.hostname = "different-server".into();
        assert_eq!(save_host_inner(&state, host).unwrap().fingerprint, None);
    }

    #[tokio::test]
    async fn private_keys_authenticate_and_incorrect_passwords_fail() {
        let (host, _, task) = server(false).await;
        let (_dir, state) = fixture_state();
        let key = ed25519_key();
        let pem = key.to_openssh(Default::default()).unwrap();
        let handle = authenticate(&state, &host, None, Some(pem.to_string()), None)
            .await
            .unwrap();
        drop(handle);
        let error = authenticate(&state, &host, Some("wrong".into()), None, None)
            .await
            .err()
            .unwrap();
        assert_eq!(error.kind, "authentication_failed");
        task.abort();
    }

    #[tokio::test]
    async fn paced_ssh_sequence_retains_queue_order_and_services_output() {
        let TerminalFixture {
            server,
            task,
            directory: _dir,
            state,
            mut rx,
            connected,
        } = json_terminal_fixture().await;
        let session = state.session(&connected.session_id).await.unwrap();
        let sequence = crate::terminal_input::InputSequence::parse(
            String::new(),
            Some(vec!["A".into(), "B".into(), "C".into()]),
        )
        .unwrap();
        session
            .input
            .send(Input::Data(sequence, access_lease()))
            .await
            .unwrap();
        session
            .input
            .send(Input::Data("TAIL".to_owned().into(), access_lease()))
            .await
            .unwrap();
        timeout(Duration::from_secs(3), async {
            let mut output = Vec::new();
            while !output.ends_with(b"ABCTAIL") {
                let event = rx.recv().await.unwrap();
                assert_ne!(event["type"], "closed");
                if let Some(data) = event["data"].as_array() {
                    output.extend(data.iter().map(|v| v.as_u64().unwrap() as u8));
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(*server.input_data.lock().unwrap(), b"ABCTAIL");
        finish_session(&session).await;
        task.abort();
    }
    #[tokio::test]
    async fn revoking_a_paced_ssh_sequence_discards_unsent_steps_even_after_unlock() {
        // A one-byte frozen receive window admits A and deterministically holds B.
        let (host, server, task) = server_with_capacity(false, true, 1).await;
        let (_dir, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let access = unlocked_access();
        let lease = access
            .lease(access.status().unwrap().nonce.as_deref())
            .unwrap();
        let revoked = Arc::new(tokio::sync::Notify::new());
        let signal = revoked.clone();
        let owner = access.clone();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let event: serde_json::Value = serde_json::from_str(&json).unwrap();
                if event["data"]
                    .as_array()
                    .is_some_and(|data| data.iter().any(|v| v.as_u64() == Some(b'A' as u64)))
                {
                    owner.lock().unwrap();
                    signal.notify_one();
                }
            }
            Ok(())
        });
        let connected = password_terminal(&state, &host, events).await;
        let session = state.session(&connected.session_id).await.unwrap();
        session
            .input
            .send(Input::Data(
                crate::terminal_input::InputSequence::parse(
                    String::new(),
                    Some(vec!["A".into(), "B".into(), "C".into()]),
                )
                .unwrap(),
                lease.clone(),
            ))
            .await
            .unwrap();
        timeout(Duration::from_secs(3), revoked.notified())
            .await
            .unwrap();
        access.authorize(access.generation().unwrap()).unwrap();
        access.ready(access.generation().unwrap()).unwrap();
        assert!(lease.check().is_err());
        session
            .input
            .send(Input::Resize(99, 33, access_lease()))
            .await
            .unwrap();
        timeout(Duration::from_secs(3), async {
            while !server.sizes.lock().unwrap().contains(&(99, 33)) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(*server.input_data.lock().unwrap(), b"A");
        finish_session(&session).await;
        task.abort();
    }
    #[tokio::test]
    async fn live_terminal_streams_utf8_resizes_and_cleans_up() {
        let TerminalFixture {
            server,
            task,
            directory: _dir,
            state,
            mut rx,
            connected: result,
        } = json_terminal_fixture().await;
        let session = state.session(&result.session_id).await.unwrap();
        session
            .input
            .send(Input::Data("你好🌍".to_owned().into(), access_lease()))
            .await
            .unwrap();
        session
            .input
            .send(Input::Resize(120, 40, access_lease()))
            .await
            .unwrap();
        let mut bytes = Vec::new();
        timeout(Duration::from_secs(3), async {
            loop {
                let event = rx.recv().await.unwrap();
                if event["type"] == "data" {
                    bytes.extend(
                        event["data"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_u64().unwrap() as u8),
                    );
                    if bytes.ends_with("你好🌍".as_bytes()) {
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert!(bytes.starts_with(b"ready\r\n"));
        timeout(Duration::from_secs(3), async {
            while !server.sizes.lock().unwrap().contains(&(120, 40)) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        session.cancel.send(true).unwrap();
        session.output_credits.close();
        timeout(Duration::from_secs(3), async {
            while state.session(&result.session_id).await.is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(server.sizes.lock().unwrap()[0], (80, 24));
        task.abort();
    }

    #[tokio::test]
    async fn server_rejected_pty_does_not_create_a_session() {
        let (host, _, task) = server(true).await;
        let (_dir, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let error = start_session(
            &state,
            host.id,
            Some("test-password".into()),
            None,
            None,
            80,
            24,
            Channel::new(|_| Ok(())),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.kind, "terminal_rejected");
        assert!(state.sessions.lock().await.is_empty());
        task.abort();
    }
    #[cfg(unix)]
    #[test]
    fn shell_paths_are_single_arguments() {
        let s = quote("a'b; $(touch /tmp/nope)");
        let output = std::process::Command::new("sh")
            .args(["-c", &format!("printf %s {s}")])
            .output()
            .unwrap();
        assert_eq!(output.stdout, b"a'b; $(touch /tmp/nope)");
    }
    #[test]
    fn dimensions_reject_invalid_or_unbounded_allocations() {
        assert!(check_size(80, 24).is_ok());
        assert!(check_size(0, 24).is_err());
        assert!(check_size(80, u32::MAX).is_err());
    }
    #[test]
    fn corrupt_config_is_not_silently_overwritten() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("hosts.json"), b"bad").unwrap();
        assert!(AppState::new(d.path().into()).is_err());
        assert_eq!(fs::read(d.path().join("hosts.json")).unwrap(), b"bad");
    }

    #[test]
    fn ipc_allows_only_the_local_main_window() {
        use tauri::Manager;
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_lazysh_vault::init())
            .invoke_handler(tauri::generate_handler![
                list_hosts,
                crate::attachment_upload::upload_cancel,
                crate::attachment_upload::upload_reserve
            ])
            .build(tauri::generate_context!(test = true))
            .unwrap();
        app.manage(AppState::new(dir.path().into()).unwrap());
        app.vault()
            .access()
            .initialize(false, false, "test".into())
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let other = tauri::WebviewWindowBuilder::new(
            &app,
            "other",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let request =
            |url: &str, command: &str, body: serde_json::Value| tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: url.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            };
        let local_url = "http://127.0.0.1:1420";
        let hosts = tauri::test::get_ipc_response(
            &main,
            request(local_url, "list_hosts", serde_json::json!({})),
        )
        .unwrap();
        assert!(hosts.deserialize::<Vec<Host>>().unwrap().is_empty());
        let cancel = serde_json::json!({"sessionId":"not-connected","uploadId":"unknown-receipt"});
        let reserve = serde_json::json!({"sessionId":"not-connected","size":0});
        let response = tauri::test::get_ipc_response(
            &main,
            request(local_url, "upload_cancel", cancel.clone()),
        )
        .expect("the allowed webview must reach the real cancellation handler");
        assert_eq!(
            response.deserialize::<serde_json::Value>().unwrap()["outcome"],
            "unknown_or_settled"
        );
        let error = tauri::test::get_ipc_response(
            &main,
            request(local_url, "upload_reserve", reserve.clone()),
        )
        .unwrap_err();
        assert_eq!(
            error["kind"], "disconnected",
            "the real reserve handler must return its session error, not an ACL denial: {error}"
        );
        for (command, body) in [
            ("list_hosts", serde_json::json!({})),
            ("upload_cancel", cancel),
            ("upload_reserve", reserve),
        ] {
            assert!(tauri::test::get_ipc_response(
                &other,
                request(local_url, command, body.clone())
            )
            .is_err());
            for remote in ["https://example.com", "http://127.0.0.1:41234"] {
                assert!(tauri::test::get_ipc_response(
                    &main,
                    request(remote, command, body.clone())
                )
                .is_err());
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires local OpenSSH sshd; run explicitly for interoperability"]
    async fn openssh_sftp_and_command_interoperability() {
        openssh_interoperability(false, false).await;
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    #[ignore = "requires local OpenSSH sshd and official mosh-server; run explicitly for interoperability"]
    async fn openssh_mosh_bootstrap_and_control_interoperability() {
        openssh_interoperability(true, false).await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires OpenSSH and official ET_SERVER_BIN/ET_TERMINAL_BIN; run explicitly"]
    async fn openssh_et_bootstrap_and_control_interoperability() {
        openssh_interoperability(false, true).await;
    }

    #[cfg(unix)]
    async fn openssh_interoperability(mosh: bool, et: bool) {
        use std::os::unix::fs::PermissionsExt;
        use tauri::Manager;
        struct Process(std::process::Child);
        impl Drop for Process {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519_key();
        let user_key = ed25519_key();
        let key_path = dir.path().join("host_key");
        fs::write(
            &key_path,
            key.to_openssh(Default::default()).unwrap().as_bytes(),
        )
        .unwrap();
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600)).unwrap();
        let authorized = dir.path().join("authorized_keys");
        fs::write(&authorized, user_key.public_key().to_openssh().unwrap()).unwrap();
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let config = dir.path().join("sshd_config");
        fs::write(&config,format!("ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nAuthorizedKeysFile {}\nPidFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nPermitRootLogin yes\nSubsystem sftp internal-sftp -d {}\n",key_path.display(),authorized.display(),dir.path().join("sshd.pid").display(),dir.path().display())).unwrap();
        let sshd = std::process::Command::new("sh")
            .args(["-c", "command -v sshd"])
            .output()
            .unwrap();
        let mut process = Process(
            std::process::Command::new(String::from_utf8(sshd.stdout).unwrap().trim())
                .args(["-D", "-e", "-f"])
                .arg(&config)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        timeout(Duration::from_secs(3), async {
            loop {
                assert!(process.0.try_wait().unwrap().is_none(), "test sshd exited");
                if tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .is_ok()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let state = AppState::new(dir.path().join("config")).unwrap();
        let host = Host {
            transport: None,
            mosh: None,
            et: None,
            id: "openssh".into(),
            name: "OpenSSH fixture".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: std::env::var("USER").unwrap(),
            fingerprint: Some(key.public_key().fingerprint(HashAlg::Sha256).to_string()),
            jump_host_id: None,
            credentials_stored: false,
            biometric_unlock: false,
            forward_agent: false,
        };
        state.config().unwrap().hosts.push(host.clone());
        let app = tauri::test::mock_app();
        app.manage(state);
        let connected = start_session(
            &app.state(),
            host.id.clone(),
            None,
            Some(user_key.to_openssh(Default::default()).unwrap().to_string()),
            None,
            80,
            24,
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        let id = connected.session_id;
        #[cfg(target_os = "linux")]
        if et {
            let forwarding_host = Host {
                forward_agent: true,
                ..host.clone()
            };
            let handle = key_handle(&app.state(), &forwarding_host, &user_key).await;
            let (channel, initial) = open_terminal(&handle, 80, 24, None).await.unwrap();
            let forwarding = spawn_terminal(
                &app.state(),
                AccessState::disabled().lease(None).unwrap(),
                handle,
                channel,
                initial,
                Channel::new(|_| Ok(())),
            )
            .await
            .unwrap();
            let error = crate::et::connect_et(
                access_lease(),
                app.state(),
                forwarding.session_id.clone(),
                Default::default(),
                80,
                24,
                Channel::new(|_| Ok(())),
            )
            .await
            .err()
            .unwrap()
            .into_inner()
            .unwrap();
            assert_eq!(error.kind, "et_agent_forwarding");
            disconnect(app.state(), forwarding.session_id)
                .await
                .unwrap();
            crate::et::tests::openssh_interoperability(&app, id, dir.path()).await;
            return;
        }
        #[cfg(not(target_os = "linux"))]
        let _ = et;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if mosh {
            let version = std::process::Command::new("mosh-server")
                .arg("--version")
                .output()
                .unwrap();
            assert!(String::from_utf8_lossy(&version.stdout).contains("mosh 1.4.0"));
            let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            let udp_port = udp.local_addr().unwrap().port();
            drop(udp);
            let options =
                serde_json::from_value(serde_json::json!({"portMin":udp_port,"portMax":udp_port}))
                    .unwrap();
            let (events, mut rx) = json_events();
            let connected = connect_mosh(
                access_lease(),
                app.state(),
                id.clone(),
                options,
                80,
                24,
                events,
            )
            .await
            .unwrap()
            .into_inner()
            .unwrap();
            let mosh_id = connected.session_id;
            let native_session = app.state::<AppState>().session(&mosh_id).await.unwrap();
            assert!((native_session.validate_size)(512, 256).is_err());
            async fn marker(
                rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
                session: &Session,
                expected: &str,
            ) {
                timeout(Duration::from_secs(8), async {
                    let mut output = Vec::new();
                    loop {
                        let event = rx.recv().await.unwrap();
                        assert_ne!(event["type"], "closed", "{event}");
                        if let Some(data) = event["data"].as_array() {
                            output.extend(data.iter().map(|value| value.as_u64().unwrap() as u8));
                            assert!(output.len() <= 1024 * 1024);
                            acknowledge(session, data.len() as u32).unwrap();
                        }
                        if String::from_utf8_lossy(&output).contains(expected) {
                            break;
                        }
                    }
                })
                .await
                .unwrap();
            }
            disconnect(app.state(), id).await.unwrap();
            write_stdin(
                access_lease(),
                app.state(),
                mosh_id.clone(),
                String::new(),
                None,
            )
            .await
            .unwrap()
            .into_inner()
            .unwrap();
            write_stdin(
                access_lease(),
                app.state(),
                mosh_id.clone(),
                String::new(),
                Some(vec!["printf 'MOSH_%s_READY\\n' '世界'".into(), "\r".into()]),
            )
            .await
            .unwrap()
            .into_inner()
            .unwrap();
            marker(&mut rx, &native_session, "MOSH_世界_READY").await;
            resize(access_lease(), app.state(), mosh_id.clone(), 120, 40)
                .await
                .unwrap()
                .into_inner()
                .unwrap();
            write_stdin(
                access_lease(),
                app.state(),
                mosh_id.clone(),
                "set -- $(stty size); printf 'MOSH_SIZE_%s_%s\\n' \"$1\" \"$2\"\r".into(),
                None,
            )
            .await
            .unwrap()
            .into_inner()
            .unwrap();
            marker(&mut rx, &native_session, "MOSH_SIZE_40_120").await;
            let file = dir
                .path()
                .join("mosh-control.txt")
                .to_string_lossy()
                .into_owned();
            upload_file(
                access_lease(),
                app.state(),
                mosh_id.clone(),
                file.clone(),
                b"SSH control remains alive".to_vec(),
            )
            .await
            .unwrap()
            .into_inner()
            .unwrap();
            assert_eq!(
                read_file(access_lease(), app.state(), mosh_id.clone(), file)
                    .await
                    .unwrap()
                    .into_inner()
                    .unwrap(),
                "SSH control remains alive"
            );
            assert!(
                resize(access_lease(), app.state(), mosh_id.clone(), 512, 256)
                    .await
                    .is_err()
            );
            disconnect(app.state(), mosh_id.clone()).await.unwrap();
            timeout(Duration::from_secs(4), async {
                loop {
                    if rx.recv().await.unwrap()["type"] == "closed" {
                        break;
                    }
                }
            })
            .await
            .unwrap();
            assert!(app.state::<AppState>().session(&mosh_id).await.is_err());
            return;
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let _ = mosh;
        let session = app.state::<AppState>().session(&id).await.unwrap();
        assert_eq!(
            exec(
                &session,
                &access_lease(),
                "if [ -z \"${SSH_AUTH_SOCK-}\" ]; then printf forwarding-disabled; else exit 1; fi"
                    .into()
            )
            .await
            .unwrap(),
            "forwarding-disabled"
        );
        let forwarding_host = Host {
            forward_agent: true,
            ..host.clone()
        };
        let forwarding_handle = key_handle(&app.state(), &forwarding_host, &user_key).await;
        let (mut channel, mut forwarded_output) = open_terminal(
            &forwarding_handle,
            80,
            24,
            Some(format!(
                "ssh-add -L && ssh-add -T {}",
                quote(&authorized.to_string_lossy())
            )),
        )
        .await
        .unwrap();
        let mut forwarding_status = None;
        timeout(Duration::from_secs(5), async {
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        forwarded_output.extend_from_slice(&data)
                    }
                    ChannelMsg::ExitStatus { exit_status } => forwarding_status = Some(exit_status),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            forwarding_status,
            Some(0),
            "{}",
            String::from_utf8_lossy(&forwarded_output)
        );
        assert!(String::from_utf8_lossy(&forwarded_output)
            .contains(user_key.public_key().to_openssh().unwrap().trim()));
        forwarding_handle
            .disconnect(
                russh::Disconnect::ByApplication,
                "forwarding test complete",
                "en",
            )
            .await
            .unwrap();
        let agent_directory = dir.path().join("agent-workspace");
        fs::create_dir(&agent_directory).unwrap();
        for relative_name in ["relative image' 世界.txt", "literal\\filename.txt"] {
            let relative_upload = upload_file(
                access_lease(),
                app.state(),
                id.clone(),
                format!("./{relative_name}"),
                b"relative fixture".to_vec(),
            )
            .await
            .unwrap()
            .into_inner()
            .unwrap();
            let expected_destination = dir
                .path()
                .join(relative_name)
                .to_string_lossy()
                .into_owned();
            assert_eq!(
                fs::read(&expected_destination).unwrap(),
                b"relative fixture"
            );
            assert!(!agent_directory.join(relative_name).exists());
            let destination = serde_json::to_value(relative_upload).unwrap();
            assert_eq!(
                destination["path"], expected_destination,
                "upload result must identify the SFTP destination independently of agent CWD"
            );
            let command = format!(
                "cd {} && cat -- {}",
                quote(&agent_directory.to_string_lossy()),
                quote(destination["path"].as_str().unwrap())
            );
            assert_eq!(
                exec_for_access(
                    &app.state::<AppState>().session(&id).await.unwrap(),
                    command,
                    &access_lease()
                )
                .await
                .unwrap(),
                "relative fixture"
            );
        }
        let upload = dir
            .path()
            .join("new file' safe.txt")
            .to_string_lossy()
            .into_owned();
        upload_file(
            access_lease(),
            app.state(),
            id.clone(),
            upload.clone(),
            "hello 世界".as_bytes().to_vec(),
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
        assert_eq!(
            read_file(access_lease(), app.state(), id.clone(), upload.clone())
                .await
                .unwrap()
                .into_inner()
                .unwrap(),
            "hello 世界"
        );
        assert!(upload_file(
            access_lease(),
            app.state(),
            id.clone(),
            upload.clone(),
            b"replacement".to_vec()
        )
        .await
        .is_err());
        assert_eq!(fs::read(&upload).unwrap(), "hello 世界".as_bytes());
        let entries = list_directory(
            access_lease(),
            app.state(),
            id.clone(),
            dir.path().to_string_lossy().into_owned(),
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
        assert!(entries
            .iter()
            .any(|e| e.name == "new file' safe.txt" && !e.is_dir && e.size == 12));
        let large = dir.path().join("large");
        fs::write(&large, vec![0u8; FILE_LIMIT as usize + 1]).unwrap();
        assert_eq!(
            read_file(
                access_lease(),
                app.state(),
                id.clone(),
                large.to_string_lossy().into_owned()
            )
            .await
            .err()
            .unwrap()
            .into_inner()
            .unwrap()
            .kind,
            "file_too_large"
        );
        let binary = dir.path().join("binary");
        fs::write(&binary, [0xffu8, 0xfe]).unwrap();
        assert_eq!(
            read_file(
                access_lease(),
                app.state(),
                id.clone(),
                binary.to_string_lossy().into_owned()
            )
            .await
            .err()
            .unwrap()
            .into_inner()
            .unwrap()
            .kind,
            "binary_file"
        );
        let crowded = dir.path().join("crowded");
        fs::create_dir(&crowded).unwrap();
        for i in 0..10001 {
            fs::write(crowded.join(i.to_string()), b"").unwrap();
        }
        assert_eq!(
            list_directory(
                access_lease(),
                app.state(),
                id.clone(),
                crowded.to_string_lossy().into_owned()
            )
            .await
            .err()
            .unwrap()
            .into_inner()
            .unwrap()
            .kind,
            "directory_too_large"
        );
        let rejected = dir.path().join("rejected-upload");
        assert_eq!(
            upload_file(
                access_lease(),
                app.state(),
                id.clone(),
                rejected.to_string_lossy().into_owned(),
                vec![0; UPLOAD_LIMIT + 1]
            )
            .await
            .err()
            .unwrap()
            .into_inner()
            .unwrap()
            .kind,
            "file_too_large"
        );
        assert!(!rejected.exists());
        let repo = dir.path().join("repo '$(echo no)");
        fs::create_dir(&repo).unwrap();
        assert!(std::process::Command::new("git")
            .arg("init")
            .arg(&repo)
            .output()
            .unwrap()
            .status
            .success());
        fs::write(repo.join("file.txt"), "before\n").unwrap();
        assert!(std::process::Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "add", "file.txt"])
            .status()
            .unwrap()
            .success());
        fs::write(repo.join("file.txt"), "after\n").unwrap();
        let diff = get_diff(
            access_lease(),
            app.state(),
            id.clone(),
            repo.to_string_lossy().into_owned(),
            false,
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
        assert!(diff.contains("-before"));
        assert!(diff.contains("+after"));
        let staged = get_diff(
            access_lease(),
            app.state(),
            id.clone(),
            repo.to_string_lossy().into_owned(),
            true,
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
        assert!(staged.contains("+before"));
        app.manage(crate::previews::PreviewState::default());
        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_port = http.local_addr().unwrap().port();
        let request = b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
        let response = b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
        let websocket = [0x81, 0x82, 0, 1, 2, 3, b'H', b'i' ^ 1];
        let web_server = tokio::spawn(async move {
            let (mut socket, _) = http.accept().await.unwrap();
            let mut received = vec![0; request.len()];
            socket.read_exact(&mut received).await.unwrap();
            assert_eq!(received, request);
            socket.write_all(response).await.unwrap();
            let mut frame = [0; 8];
            socket.read_exact(&mut frame).await.unwrap();
            assert_eq!(frame, websocket);
            socket.write_all(&[0x81, 2, b'H', b'i']).await.unwrap();
        });
        let preview = crate::previews::start_preview(
            access_lease(),
            app.state(),
            app.state(),
            id.clone(),
            http_port,
            None,
            None,
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
        let preview = serde_json::to_value(preview).unwrap();
        let local_port = preview["localPort"].as_u64().unwrap() as u16;
        assert_ne!(
            local_port, http_port,
            "occupied port must fall back to an unused port"
        );
        let mut browser = tokio::net::TcpStream::connect(("127.0.0.1", local_port))
            .await
            .unwrap();
        browser.write_all(request).await.unwrap();
        let mut received = vec![0; response.len()];
        timeout(Duration::from_secs(3), browser.read_exact(&mut received))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received, response);
        browser.write_all(&websocket).await.unwrap();
        let mut frame = [0; 4];
        timeout(Duration::from_secs(3), browser.read_exact(&mut frame))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame, [0x81, 2, b'H', b'i']);
        web_server.await.unwrap();
        resize(access_lease(), app.state(), id.clone(), 110, 35)
            .await
            .unwrap()
            .into_inner()
            .unwrap();
        write_stdin(
            access_lease(),
            app.state(),
            id.clone(),
            "printf lazysh-interoperability\\n\r".into(),
            None,
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
        disconnect(app.state(), id).await.unwrap();
        timeout(Duration::from_secs(2), async {
            while tokio::net::TcpStream::connect(("127.0.0.1", local_port))
                .await
                .is_ok()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test(start_paused = true)]
    async fn locked_terminal_delivery_pauses_deadline_and_resumes_without_dropped_indices() {
        let access = unlocked_access();
        let credits = Semaphore::new(0);
        let inflight = StdMutex::new(0);
        let (cancel, mut cancellation) = watch::channel(false);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events = counting_events(&calls);
        let delivery = deliver_output(
            &access,
            &credits,
            &inflight,
            &mut cancellation,
            &events,
            b"abc",
            None,
        );
        tokio::pin!(delivery);
        assert_pending(delivery.as_mut()).await;
        access.lock().unwrap();
        assert_pending(delivery.as_mut()).await;
        tokio::time::advance(OP_TIMEOUT * 2).await;
        credits.add_permits(3);
        assert_pending(delivery.as_mut()).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(*inflight.lock().unwrap(), 0);
        access.authorize(access.generation().unwrap()).unwrap();
        // Native authentication alone does not resume delivery before UI reset ACK.
        assert_pending(delivery.as_mut()).await;
        access.ready(access.generation().unwrap()).unwrap();
        delivery.await.unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(*inflight.lock().unwrap(), 3);
        access.lock().unwrap();
        let mut cancellation = cancel.subscribe();
        let pending = deliver_output(
            &access,
            &credits,
            &inflight,
            &mut cancellation,
            &events,
            b"x",
            None,
        );
        tokio::pin!(pending);
        assert_pending(pending.as_mut()).await;
        cancel.send_replace(true);
        assert!(pending.await.is_err());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[test]
    fn ssh_errors_keep_fingerprints_only_for_the_original_unlocked_generation() {
        let access = unlocked_access();
        let nonce = access.status().unwrap().nonce.unwrap();
        let lease = access.lease(Some(&nonce)).unwrap();
        let mut source = SshError::new("host_key_required", "REMOTE_PRIVATE_STDERR");
        source.fingerprint = Some("SHA256:TEST_PRIVATE_HOST".into());
        source.host_id = Some("private-host".into());
        let error = lease.error(source);
        let current = serde_json::to_value(&error).unwrap();
        assert_eq!(current["kind"], "host_key_required");
        assert_eq!(current["fingerprint"], "SHA256:TEST_PRIVATE_HOST");
        assert_eq!(current["hostId"], "private-host");
        access.lock().unwrap();
        for step in 0..2 {
            let stale = serde_json::to_string(&error).unwrap();
            for private in ["REMOTE_PRIVATE_STDERR", "TEST_PRIVATE_HOST", "private-host"] {
                assert!(!stale.contains(private));
            }
            if step == 0 {
                access.authorize(access.generation().unwrap()).unwrap();
                access.ready(access.generation().unwrap()).unwrap();
            }
        }
    }
    #[tokio::test]
    async fn cancelled_native_start_reaps_unpublished_worker_and_preserves_parent() {
        let (host, _, server_task) = server(false).await;
        let (_directory, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let connected = start_session(
            &state,
            host.id,
            Some("test-password".into()),
            None,
            None,
            80,
            24,
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        let parent = state.session(&connected.session_id).await.unwrap();
        let (began, started) = tokio::sync::oneshot::channel();
        let (done, stopped) = tokio::sync::oneshot::channel();
        let worker_state = state.clone();
        let attempt = tokio::spawn(async move {
            spawn_native_terminal(
                &worker_state,
                access_lease(),
                parent,
                Channel::new(|_| Ok(())),
                "fixture",
                check_size,
                move |_access, input, mut cancellation, _initial, output, ready| {
                    tauri::async_runtime::spawn(async move {
                        // Keep producer ownership until cancellation. Dropping output
                        // here would correctly end the session before attempt.abort().
                        let _input = input;
                        let _output = output;
                        let _ready = ready;
                        let _ = began.send(());
                        cancellation.changed().await.unwrap();
                        assert!(*cancellation.borrow());
                        let _ = done.send(());
                        Ok(())
                    })
                },
            )
            .await
        });
        started.await.unwrap();
        assert!(
            !attempt.is_finished(),
            "native fixture ended before cancellation"
        );
        attempt.abort();
        match attempt.await {
            Err(error) => assert!(error.is_cancelled()),
            Ok(Err(error)) => panic!("native fixture returned before abort: {}", error.kind),
            Ok(Ok(_)) => panic!("native fixture unexpectedly published a connection"),
        }
        timeout(Duration::from_secs(2), stopped)
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(2), async {
            while state.sessions.lock().await.len() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(state.session(&connected.session_id).await.is_ok());
        server_task.abort();
    }
    #[tokio::test]
    async fn native_adoption_revokes_unknown_ids_after_response_serialization_but_keeps_owned_sessions(
    ) {
        use tauri::ipc::IpcResponse;
        async fn register(
            state: &AppState,
            handle: Arc<SshHandle>,
            creation: AccessLease,
        ) -> (String, Arc<Session>) {
            let (input, _) = mpsc::channel(1);
            let (cancel, _) = watch::channel(false);
            let session = Arc::new(Session::new(handle, input, cancel, creation, check_size));
            session.finished.send_replace(true);
            let id = uuid::Uuid::new_v4().to_string();
            state
                .sessions
                .lock()
                .await
                .insert(id.clone(), session.clone());
            watch_adoption(state, &id, &session);
            (id, session)
        }
        let (host, _, server_task) = server(false).await;
        let (_directory, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let handle = password_handle(&state, &host).await;
        let access = AccessState::default();
        access.initialize(true, true, "test".into()).unwrap();
        for serialized in [false, true] {
            access.authorize(access.generation().unwrap()).unwrap();
            access.ready(access.generation().unwrap()).unwrap();
            let nonce = access.status().unwrap().nonce.unwrap();
            let creation = access.lease(Some(&nonce)).unwrap();
            let (id, session) = register(&state, handle.clone(), creation.clone()).await;
            let response = creation
                .guard(Connected {
                    session_id: id.clone(),
                })
                .unwrap();
            if serialized {
                response.body().unwrap();
            } else {
                access.lock().unwrap();
                assert!(response.body().is_err());
            }
            if serialized {
                access.lock().unwrap();
            }
            assert!(mark_adopted(&session, &creation).is_err());
            timeout(Duration::from_secs(2), async {
                while state.sessions.lock().await.contains_key(&id) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(*session.cancel.borrow());
            access.authorize(access.generation().unwrap()).unwrap();
            let fresh = ready_lease(&access);
            assert!(mark_adopted(&session, &fresh).is_err());
        }
        let creation = access
            .lease(access.status().unwrap().nonce.as_deref())
            .unwrap();
        let (id, session) = register(&state, handle, creation.clone()).await;
        mark_adopted(&session, &creation).unwrap();
        creation
            .guard(Connected {
                session_id: id.clone(),
            })
            .unwrap()
            .body()
            .unwrap();
        access.lock().unwrap();
        tokio::task::yield_now().await;
        assert!(state.session(&id).await.is_ok());
        assert!(!*session.cancel.borrow());
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = count.clone();
        let events = Channel::new(move |_| {
            observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        });
        let delivery = send_output(&session, &events, b"owned");
        tokio::pin!(delivery);
        assert_pending(delivery.as_mut()).await;
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
        access.authorize(access.generation().unwrap()).unwrap();
        access.ready(access.generation().unwrap()).unwrap();
        delivery.await.unwrap();
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
        server_task.abort();
    }
    #[tokio::test]
    async fn revoked_unadopted_output_cannot_freshen_before_cleanup_watcher_runs() {
        let access = unlocked_access();
        let nonce = access.status().unwrap().nonce.unwrap();
        let creation = access.lease(Some(&nonce)).unwrap();
        let adopted = std::sync::atomic::AtomicBool::new(false);
        let renderer_gone = watch::channel(false).0;
        // Deliberately no cleanup watcher: privacy must hold independently of its scheduling.
        access.lock().unwrap();
        access.authorize(access.generation().unwrap()).unwrap();
        access.ready(access.generation().unwrap()).unwrap();
        let credits = Semaphore::new(16384);
        let inflight = StdMutex::new(0);
        let (_cancel, mut cancellation) = watch::channel(false);
        let (send, mut events_rx) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                let _ = send.send(body);
            }
            Ok(())
        });
        assert!(deliver_output(
            &access,
            &credits,
            &inflight,
            &mut cancellation,
            &events,
            b"OLD_PRIVATE_BYTES",
            Some((&creation, &adopted, &renderer_gone))
        )
        .await
        .is_err());
        assert!(events_rx.try_recv().is_err());
        assert_eq!(*inflight.lock().unwrap(), 0);
        assert_eq!(credits.available_permits(), 16384);
        close_output(
            &access,
            Some((&creation, &adopted, &renderer_gone)),
            &events,
            "OLD_PRIVATE_STDERR".into(),
        )
        .await;
        let body = events_rx.recv().await.unwrap();
        assert!(!body.contains("PRIVATE"));
        let closed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(closed["type"], "closed");
        assert_eq!(closed["message"], "Session cancelled before adoption");
    }
    #[tokio::test]
    async fn renderer_rebind_without_biometric_policy_retires_all_old_transports_and_allows_fresh_session(
    ) {
        use tauri::ipc::IpcResponse;
        let (host, _, server_task) = server(false).await;
        let (_directory, state) = fixture_state();
        state.config().unwrap().hosts.push(host.clone());
        let access = AccessState::disabled();
        let creation = access.lease(None).unwrap();
        let old_events = Arc::new(AtomicUsize::new(0));
        let observed = old_events.clone();
        let handle = password_handle(&state, &host).await;
        let (channel, initial) = open_terminal(&handle, 80, 24, None).await.unwrap();
        let parent = spawn_terminal(
            &state,
            creation.clone(),
            handle,
            channel,
            initial,
            Channel::new(move |_| {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )
        .await
        .unwrap();
        let parent_session = state.session(&parent.session_id).await.unwrap();
        mark_adopted(&parent_session, &creation).unwrap();
        let shutdowns = Arc::new(AtomicUsize::new(0));
        let stopped = shutdowns.clone();
        let observed = old_events.clone();
        let pending = spawn_native_terminal(
            &state,
            creation.clone(),
            parent_session.clone(),
            Channel::new(move |_| {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
            "fixture",
            check_size,
            move |_access, input, mut cancellation, _initial, output, ready| {
                tauri::async_runtime::spawn(async move {
                    let _input = input;
                    let _output = output;
                    let _ = ready.send(Ok(()));
                    if !*cancellation.borrow() {
                        let _ = cancellation.changed().await;
                    }
                    stopped.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            },
        )
        .await
        .unwrap();
        let pending_session = state.session(&pending.session_id).await.unwrap();
        creation.guard(pending).unwrap().body().unwrap(); // ACK can be lost in the replaced renderer.
        access.replace_renderer().unwrap();
        assert!(creation.check().is_err());
        let before = old_events.load(Ordering::SeqCst);
        timeout(Duration::from_secs(5), state.cancel_for_renderer_rebind())
            .await
            .unwrap();
        assert!(state.sessions.lock().await.is_empty());
        assert!(state.retiring.lock().await.is_empty());
        for session in [&parent_session, &pending_session] {
            assert!(*session.renderer_gone.borrow());
            assert!(*session.cancel.borrow());
            assert!(*session.finished.borrow());
        }
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        state.cancel_for_renderer_rebind().await;
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        assert_eq!(old_events.load(Ordering::SeqCst), before);
        let fresh = replacement_lease(&access);
        let handle = password_handle(&state, &host).await;
        let (channel, initial) = open_terminal(&handle, 80, 24, None).await.unwrap();
        let connected = spawn_terminal(
            &state,
            fresh.clone(),
            handle,
            channel,
            initial,
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        let live = state.session(&connected.session_id).await.unwrap();
        mark_adopted(&live, &fresh).unwrap();
        assert!(!*live.cancel.borrow());
        assert!(state.session(&connected.session_id).await.is_ok());
        assert_eq!(old_events.load(Ordering::SeqCst), before);
        disconnect_inner(&state, connected.session_id)
            .await
            .unwrap();
        server_task.abort();
    }
}
