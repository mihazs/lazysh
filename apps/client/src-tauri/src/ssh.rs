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
impl Host {
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
    config: Arc<StdMutex<Config>>,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
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
            config: Arc::new(StdMutex::new(Config {
                path,
                hosts,
                pending: HashMap::new(),
            })),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            credential_locks: Arc::new(Mutex::new(HashMap::new())),
        })
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
    pub(crate) async fn credential_guard(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self
            .credential_locks
            .lock()
            .await
            .entry(id.to_owned())
            .or_default()
            .clone();
        lock.lock_owned().await
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
            .ok_or_else(|| SshError::new("disconnected", "Session is disconnected"))
    }
}

#[tauri::command]
pub fn list_hosts(state: State<'_, AppState>) -> Result<Vec<Host>> {
    Ok(state.config()?.hosts.clone())
}
#[tauri::command]
pub async fn save_host(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    host: Host,
) -> Result<Host> {
    let _guard = state.credential_guard(&host.id).await;
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
        let vault_host = host.id.clone();
        tauri::async_runtime::spawn_blocking(move || crate::vault::remove(&app, &vault_host))
            .await
            .map_err(|_| SshError::new("storage", "Credential deletion failed"))?
            .map_err(|message| SshError::new("storage", message))?;
        state.mark_credentials(&host.id, false)?;
    }
    save_host_inner(&state, host)
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    host_id: String,
) -> Result<()> {
    let _guard = state.credential_guard(&host_id).await;
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
        let vault_app = app.clone();
        let vault_host = host_id.clone();
        tauri::async_runtime::spawn_blocking(move || crate::vault::remove(&vault_app, &vault_host))
            .await
            .map_err(|_| SshError::new("storage", "Credential deletion failed"))?
            .map_err(|message| SshError::new("storage", message))?;
    }
    remove_host_metadata(&state, &host_id)
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
    state: State<'_, AppState>,
    host_id: String,
    fingerprint: String,
) -> Result<()> {
    trust_host_key_inner(&state, host_id, fingerprint)
}
fn trust_host_key_inner(state: &AppState, host_id: String, fingerprint: String) -> Result<()> {
    let mut config = state.config()?;
    let host = config
        .hosts
        .iter()
        .find(|h| h.id == host_id)
        .ok_or_else(|| SshError::new("missing_host", "Host no longer exists"))?;
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
    handle: client::Handle<HostVerifier>,
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
impl std::ops::DerefMut for SshHandle {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.handle
    }
}
impl Drop for SshHandle {
    fn drop(&mut self) {
        self.forward_agent.close();
    }
}
pub(crate) struct Session {
    pub(crate) handle: Arc<SshHandle>,
    input: mpsc::Sender<Input>,
    output_credits: Semaphore,
    output_inflight: StdMutex<u32>,
    pub(crate) cancel: watch::Sender<bool>,
    validate_size: fn(u32, u32) -> Result<()>,
}
pub(crate) enum Input {
    Data(String),
    Resize(u32, u32),
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
        handle,
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
    let mut selected_key = None;
    let auth = if let Some(key) = private_key.as_ref().filter(|k| !k.is_empty()) {
        let key = Arc::new(decode_secret_key(
            key,
            passphrase.as_ref().map(|s| s.as_str()),
        )?);
        if host.forward_agent {
            selected_key = Some(key.clone());
        }
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        timeout(
            OP_TIMEOUT,
            handle.authenticate_publickey(&host.username, PrivateKeyWithHashAlg::new(key, hash)),
        )
        .await
    } else if let Some(password) = password {
        timeout(
            OP_TIMEOUT,
            handle.authenticate_password(&host.username, password.as_str()),
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
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
) -> Result<Connected> {
    let operation = app.vault().operation();
    let entered = crate::vault::Credentials {
        password,
        private_key,
        passphrase,
    };
    let _guard = during_connect(&operation, async {
        Ok(state.credential_guard(&host_id).await)
    })
    .await?;
    check_size(cols, rows)?;
    let host = state.host(&host_id)?;
    let handle = during_connect(
        &operation,
        crate::routing::verified_target(app.clone(), &state, &host, jump_credentials, &operation),
    )
    .await?;
    let credentials = if use_saved_credentials.unwrap_or(false) {
        match during_connect(&operation, async {
            crate::vault::load_for_operation(app.clone(), host.clone(), operation.clone())
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
    let handle =
        Arc::new(authenticate_for_operation(handle, &host, &credentials, &operation).await?);
    let (channel, initial) =
        match during_connect(&operation, open_terminal(&handle, cols, rows, None)).await {
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
        )
        .await
        {
            if !host.credentials_stored {
                let vault_app = app.clone();
                let vault_host = host_id.clone();
                if matches!(
                    tauri::async_runtime::spawn_blocking(move || crate::vault::remove(
                        &vault_app,
                        &vault_host
                    ))
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
    let connected = spawn_terminal(&state, handle, channel, initial, events).await?;
    if operation.check().is_err() {
        let _ = disconnect(state, connected.session_id).await;
        return Err(connection_cancelled());
    }
    Ok(connected)
}
async fn request_ok(channel: &mut russh::Channel<client::Msg>) -> Result<Vec<u8>> {
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
    spawn_terminal(state, handle, channel, initial, events).await
}
const OUTPUT_WINDOW: u32 = 256 * 1024;
async fn open_terminal(
    handle: &Arc<SshHandle>,
    cols: u32,
    rows: u32,
    command: Option<String>,
) -> Result<(russh::Channel<client::Msg>, Vec<u8>)> {
    let mut channel = timeout(OP_TIMEOUT, handle.channel_open_session())
        .await
        .map_err(|_| SshError::new("timeout", "Opening terminal timed out"))??;
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
async fn send_output(session: &Session, events: &Channel<SshEvent>, data: &[u8]) -> Result<()> {
    for chunk in data.chunks(16384) {
        let permit = timeout(
            OP_TIMEOUT,
            session.output_credits.acquire_many(chunk.len() as u32),
        )
        .await
        .map_err(|_| SshError::new("consumer_stalled", "Terminal stopped consuming output"))?
        .map_err(|_| SshError::new("disconnected", "Terminal closed"))?;
        permit.forget();
        *session
            .output_inflight
            .lock()
            .map_err(|_| SshError::new("ssh_error", "Output accounting failed"))? +=
            chunk.len() as u32;
        events.send(SshEvent::Data {
            data: chunk.to_vec(),
        })?;
    }
    Ok(())
}
async fn spawn_terminal(
    state: &AppState,
    handle: Arc<SshHandle>,
    mut channel: russh::Channel<client::Msg>,
    initial: Vec<u8>,
    events: Channel<SshEvent>,
) -> Result<Connected> {
    let (input, mut rx) = mpsc::channel(32);
    let (cancel, mut cancellation) = watch::channel(false);
    let session = Arc::new(Session {
        handle,
        input,
        output_credits: Semaphore::new(OUTPUT_WINDOW as usize),
        output_inflight: StdMutex::new(0),
        cancel,
        validate_size: check_size,
    });
    let id = uuid::Uuid::new_v4().to_string();
    state
        .sessions
        .lock()
        .await
        .insert(id.clone(), session.clone());
    let sessions = state.sessions.clone();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let result:Result<()> = async {
            send_output(&session, &events, &initial).await?;
            loop {
                tokio::select! {
                    _=cancellation.changed()=>break,
                    message=channel.wait()=> match message {
                        Some(ChannelMsg::Data{data})|Some(ChannelMsg::ExtendedData{data,..}) => send_output(&session,&events,&data).await?,
                        None|Some(ChannelMsg::Close)|Some(ChannelMsg::Eof)=>break,
                        _=>{}
                    },
                    input=rx.recv()=>match input {
                        Some(Input::Data(data))=>terminal_io(&session,channel.data(data.as_bytes())).await?,
                        Some(Input::Resize(cols,rows))=>terminal_io(&session,channel.window_change(cols,rows,0,0)).await?,
                        None=>break
                    }
                }
            }
            Ok(())
        }.await;
        let _ = session.cancel.send(true);
        let _ = timeout(Duration::from_secs(2), channel.close()).await;
        sessions.lock().await.remove(&task_id);
        let _ = events.send(SshEvent::Closed {
            message: result
                .err()
                .map(|e| e.message)
                .unwrap_or_else(|| "Session closed".into()),
        });
    });
    Ok(Connected { session_id: id })
}
#[tauri::command]
pub async fn connect_mosh(
    state: State<'_, AppState>,
    session_id: String,
    options: crate::mosh::Options,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> Result<Connected> {
    let parent = state.session(&session_id).await?;
    let bootstrap = crate::mosh::bootstrap(&parent, options, cols, rows).await?;
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    {
        spawn_native_terminal(
            &state,
            parent,
            events,
            "Mosh",
            crate::mosh::check_size,
            move |input, cancel, initial, output, ready| {
                tauri::async_runtime::spawn_blocking(move || {
                    crate::mosh::run(bootstrap, cols, rows, input, cancel, initial, output, ready)
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
}

pub(crate) async fn spawn_native_terminal<Driver>(
    state: &AppState,
    parent: Arc<Session>,
    events: Channel<SshEvent>,
    name: &'static str,
    validate_size: fn(u32, u32) -> Result<()>,
    driver: Driver,
) -> Result<Connected>
where
    Driver: FnOnce(
        mpsc::Receiver<Input>,
        watch::Receiver<bool>,
        watch::Receiver<bool>,
        mpsc::Sender<Vec<u8>>,
        tokio::sync::oneshot::Sender<Result<()>>,
    ) -> tauri::async_runtime::JoinHandle<Result<()>>,
{
    let (input, input_rx) = mpsc::channel(32);
    let (cancel, cancellation) = watch::channel(false);
    let session = Arc::new(Session {
        handle: parent.handle.clone(),
        input,
        cancel,
        validate_size,
        output_credits: Semaphore::new(OUTPUT_WINDOW as usize),
        output_inflight: StdMutex::new(0),
    });
    let id = uuid::Uuid::new_v4().to_string();
    state
        .sessions
        .lock()
        .await
        .insert(id.clone(), session.clone());
    let (output, mut output_rx) = mpsc::channel(1);
    let (ready, response) = tokio::sync::oneshot::channel();
    let initial_cancel = parent.cancel.subscribe();
    let worker = driver(input_rx, cancellation, initial_cancel, output, ready);
    let sessions = state.sessions.clone();
    let task_id = id.clone();
    let active = session.clone();
    tauri::async_runtime::spawn(async move {
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
        sessions.lock().await.remove(&task_id);
        let _ = events.send(SshEvent::Closed {
            message: delivery
                .and(native)
                .err()
                .map(|error| error.message)
                .unwrap_or_else(|| "Session closed".into()),
        });
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
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<()> {
    if data.len() > 65536 {
        return Err(SshError::new(
            "input_too_large",
            "Paste at most 64 KiB at once",
        ));
    }
    state
        .session(&session_id)
        .await?
        .input
        .try_send(Input::Data(data))
        .map_err(|_| {
            SshError::new(
                "backpressure",
                "Terminal input queue is full or disconnected",
            )
        })?;
    Ok(())
}
#[tauri::command]
pub async fn resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<()> {
    check_size(cols, rows)?;
    let session = state.session(&session_id).await?;
    (session.validate_size)(cols, rows)?;
    session
        .input
        .send(Input::Resize(cols, rows))
        .await
        .map_err(|_| SshError::new("disconnected", "Session is disconnected"))?;
    Ok(())
}
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<()> {
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
pub(crate) async fn sftp(session: &Session) -> Result<SftpSession> {
    let channel = session.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    Ok(SftpSession::new(crate::sftp_stream::SftpStream::new(channel.into_stream())).await?)
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
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>> {
    check_path(&path)?;
    let session = state.session(&session_id).await?;
    let raw = timeout(OP_TIMEOUT, async {
        let channel = session.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let raw = russh_sftp::client::RawSftpSession::new(crate::sftp_stream::SftpStream::new(
            channel.into_stream(),
        ));
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
}

#[tauri::command]
pub async fn read_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String> {
    check_path(&path)?;
    let session = state.session(&session_id).await?;
    timeout(OP_TIMEOUT, async {
        let sftp = sftp(&session).await?;
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
}
#[tauri::command]
pub async fn upload_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    data: Vec<u8>,
) -> Result<()> {
    check_path(&path)?;
    if data.len() > UPLOAD_LIMIT {
        return Err(SshError::new(
            "file_too_large",
            "Upload is limited to 10 MiB",
        ));
    }
    let session = state.session(&session_id).await?;
    timeout(OP_TIMEOUT, async {
        let sftp = sftp(&session).await?;
        let mut file = sftp
            .open_with_flags(
                path.clone(),
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await?;
        let result = file.write_all(&data).await;
        if let Err(e) = result {
            let _ = file.shutdown().await;
            return Err(SshError::new(
                "upload_failed",
                format!("{e}. A partial new file may remain at {path}."),
            ));
        }
        file.shutdown().await?;
        Ok(())
    })
    .await
    .map_err(|_| {
        SshError::new(
            "timeout",
            "Upload timed out; check for a partial remote file",
        )
    })?
}
pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub(crate) async fn exec(session: &Session, command: String) -> Result<String> {
    let mut channel = timeout(OP_TIMEOUT, session.handle.channel_open_session())
        .await
        .map_err(|_| SshError::new("timeout", "Opening command channel timed out"))??;
    let result = timeout(OP_TIMEOUT, async {
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
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    staged: bool,
) -> Result<String> {
    check_path(&path)?;
    let session = state.session(&session_id).await?;
    exec(
        &session,
        format!(
            "git --no-pager -C {} diff --no-ext-diff --no-textconv {} --",
            quote(&path),
            if staged { "--cached" } else { "" }
        ),
    )
    .await
}
#[tauri::command]
pub async fn agent_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<serde_json::Value> {
    let session = state.session(&session_id).await?;
    let text = exec(&session, "lazysh-agent snapshot --limit 50".into()).await?;
    Ok(serde_json::from_str(&text)?)
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
    ) || offset > 9_007_199_254_740_991
    {
        return Err(SshError::new(
            "invalid_input",
            "Invalid transcript adapter or cursor",
        ));
    }
    Ok(())
}

fn transcript_command(agent: &str, path: &str, offset: u64) -> Result<String> {
    validate_transcript_source(agent, path, offset)?;
    Ok(format!(
        "lazysh-agent transcript --agent {agent} --path {} --offset {offset} --limit 50",
        quote(path)
    ))
}

#[tauri::command]
pub async fn agent_usage(
    state: State<'_, AppState>,
    session_id: String,
    agent: String,
    path: String,
    offset: u64,
    transcript_session_id: Option<String>,
) -> Result<serde_json::Value> {
    validate_transcript_source(&agent, &path, offset)?;
    let mut command = format!(
        "lazysh-agent usage --agent {agent} --path={} --offset {offset}",
        quote(&path)
    );
    if let Some(id) = transcript_session_id {
        if id.is_empty() || id.len() > 4096 || id.chars().any(char::is_control) {
            return Err(SshError::new(
                "invalid_input",
                "Invalid transcript session identifier",
            ));
        }
        command.push_str(&format!(" --session-id={}", quote(&id)));
    }
    let session = state.session(&session_id).await?;
    Ok(serde_json::from_str(&exec(&session, command).await?)?)
}

#[tauri::command]
pub async fn agent_transcript(
    state: State<'_, AppState>,
    session_id: String,
    agent: String,
    path: String,
    offset: u64,
    view: Option<String>,
    transcript_session_id: Option<String>,
) -> Result<serde_json::Value> {
    let mut command = transcript_command(&agent, &path, offset)?;
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
    if let Some(id) = transcript_session_id {
        if id.is_empty() || id.len() > 4096 || id.chars().any(char::is_control) {
            return Err(SshError::new(
                "invalid_input",
                "Invalid transcript session identifier",
            ));
        }
        command.push_str(&format!(" --session-id={}", quote(&id)));
    }
    let session = state.session(&session_id).await?;
    Ok(serde_json::from_str(&exec(&session, command).await?)?)
}

#[tauri::command]
pub async fn agent_transcripts(
    state: State<'_, AppState>,
    session_id: String,
    agent: String,
) -> Result<serde_json::Value> {
    if agent == "grok-acp" {
        return Err(SshError::new(
            "invalid_input",
            "Grok ACP requires an explicitly selected transcript file",
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
            format!("lazysh-agent discover --agent {agent} --limit 50"),
        )
        .await?,
    )?)
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
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<MuxSession>> {
    let session = state.session(&session_id).await?;
    let text=exec(&session,"tmux list-sessions -F '#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}'".into()).await?;
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
}
#[tauri::command]
pub async fn attach_tmux(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> Result<Connected> {
    attach_tmux_inner(&state, session_id, name, cols, rows, events).await
}
#[tauri::command]
pub async fn attach_multiplexer(
    state: State<'_, AppState>,
    session_id: String,
    kind: crate::multiplexer::MultiplexerKind,
    name: String,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> Result<Connected> {
    check_size(cols, rows)?;
    let command = crate::multiplexer::attach_command(kind, &name)?;
    let parent = state.session(&session_id).await?;
    let (channel, initial) = open_terminal(&parent.handle, cols, rows, Some(command)).await?;
    spawn_terminal(&state, parent.handle.clone(), channel, initial, events).await
}
async fn attach_tmux_inner(
    state: &AppState,
    session_id: String,
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
    let command = format!(
        "tmux attach-session -t {}",
        crate::multiplexer::tmux_arg(&format!("={name}"))
    );
    let (channel, initial) = open_terminal(&parent.handle, cols, rows, Some(command)).await?;
    spawn_terminal(state, parent.handle.clone(), channel, initial, events).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::{server, ChannelId, Pty};
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn closing_during_delayed_verification_aborts_transport_before_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().into()).unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        let host = Host {
            transport: None,
            mosh: None,
            et: None,
            id: "credential-host".into(),
            name: "Credentials".into(),
            hostname: "example.test".into(),
            port: 22,
            username: "user".into(),
            fingerprint: None,
            credentials_stored: true,
            jump_host_id: None,
            forward_agent: false,
            biometric_unlock: false,
        };
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
            let dir = tempfile::tempdir().unwrap();
            let state = AppState::new(dir.path().into()).unwrap();
            let host = Host {
                transport: None,
                mosh: None,
                et: None,
                id: "saved-identity".into(),
                name: "Saved identity".into(),
                hostname: "example.test".into(),
                port: 22,
                username: "user".into(),
                fingerprint: Some("SHA256:verified".into()),
                credentials_stored: false,
                jump_host_id: None,
                forward_agent: false,
                biometric_unlock: initially_protected,
            };
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
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
        assert_eq!(transcript_command("grok-acp", "/host/updates.jsonl", 0).unwrap(), "lazysh-agent transcript --agent grok-acp --path '/host/updates.jsonl' --offset 0 --limit 50");
        assert!(transcript_command("grok", "/host/updates.jsonl", 0).is_err());
        assert!(transcript_command("claude; touch /tmp/nope", "/a", 0).is_err());
        assert!(transcript_command("codex", "/a\0b", 0).is_err());
        assert!(transcript_command("codex", "/a", u64::MAX).is_err());
        assert_eq!(transcript_command("claude", "/a'b;$(cmd)", 17).unwrap(), "lazysh-agent transcript --agent claude --path '/a'\\''b;$(cmd)' --offset 17 --limit 50");
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
            _: ChannelId,
            _: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
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
            _: russh::Channel<server::Msg>,
            reply: server::ChannelOpenHandle,
            _: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
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
            self.commands
                .lock()
                .unwrap()
                .push(String::from_utf8(command.to_vec()).unwrap());
            session.channel_success(channel)?;
            session.data(channel, b"attached\r\n".to_vec())?;
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
    async fn assert_stalled_bootstrap_cleanup(et: bool) {
        let (host, server, task) = server(false).await;
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        let handle = Arc::new(
            authenticate(&state, &host, Some("test-password".into()), None, None)
                .await
                .unwrap(),
        );
        let (input, _) = mpsc::channel(1);
        let (cancel, _) = watch::channel(false);
        let session = Arc::new(Session {
            handle: handle.clone(),
            input,
            cancel,
            output_credits: Semaphore::new(OUTPUT_WINDOW as usize),
            output_inflight: StdMutex::new(0),
            validate_size: check_size,
        });
        let bootstrap = tokio::spawn(async move {
            if et {
                crate::et::bootstrap(&session, crate::et::Options::default(), 80, 24)
                    .await
                    .map(|_| ())
            } else {
                crate::mosh::bootstrap(&session, crate::mosh::Options::default(), 80, 24)
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        let error = authenticate(&state, &host, Some("test-password".into()), None, None)
            .await
            .err()
            .unwrap();
        assert_eq!(error.kind, "forwarding_requires_key");
        assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 0);
        task.abort();
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn mosh_rejects_agent_forwarding_before_bootstrap_commands() {
        let (mut host, server, task) = server(false).await;
        host.forward_agent = true;
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let handle = Arc::new(
            authenticate(
                &state,
                &host,
                None,
                Some(key.to_openssh(Default::default()).unwrap().to_string()),
                None,
            )
            .await
            .unwrap(),
        );
        let (input, _) = mpsc::channel(1);
        let (cancel, _) = watch::channel(false);
        let session = Session {
            handle,
            input,
            cancel,
            output_credits: Semaphore::new(OUTPUT_WINDOW as usize),
            output_inflight: StdMutex::new(0),
            validate_size: check_size,
        };
        let error = crate::mosh::bootstrap(&session, crate::mosh::Options::default(), 80, 24)
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
        use server::Server;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(10),
            auth_rejection_time_initial: Some(Duration::from_millis(10)),
            window_size: if freeze_window { 128 } else { 2097152 },
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        let handle = Arc::new(
            authenticate(&state, &host, Some("test-password".into()), None, None)
                .await
                .unwrap(),
        );
        let (input, _) = mpsc::channel(32);
        let (cancel, _) = watch::channel(false);
        let session = Arc::new(Session {
            handle,
            input,
            cancel,
            validate_size: check_size,
            output_credits: Semaphore::new(OUTPUT_WINDOW as usize),
            output_inflight: StdMutex::new(0),
        });
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
    async fn tmux_uses_a_separate_pty_and_preserves_the_parent_shell() {
        let (host, server, server_task) = server(false).await;
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        state.config().unwrap().hosts.push(host.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let _ = tx.send(json);
            }
            Ok(())
        });
        let parent = start_session(
            &state,
            host.id,
            Some("test-password".into()),
            None,
            None,
            80,
            24,
            events,
        )
        .await
        .unwrap();
        let child = attach_tmux_inner(
            &state,
            parent.session_id.clone(),
            "safe'name;touch /tmp/nope".into(),
            80,
            24,
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        assert_ne!(parent.session_id, child.session_id);
        assert_eq!(state.sessions.lock().await.len(), 2);
        assert_eq!(
            *server.commands.lock().unwrap(),
            vec!["tmux attach-session -t '=safe'\\''name;touch /tmp/nope'"]
        );
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
            .send(Input::Data("parent-alive".into()))
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        state.config().unwrap().hosts.push(host.clone());
        let app = tauri::test::mock_app();
        app.manage(state);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let _ = tx.send(json);
            }
            Ok(())
        });
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
        write_stdin(app.state(), connected.session_id.clone(), "x".repeat(65536))
            .await
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
    async fn untrusted_and_changed_keys_never_receive_credentials() {
        let (mut host, server, task) = server(false).await;
        let expected = host.fingerprint.take().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        save_host_inner(&state, host.clone()).unwrap();
        let error = authenticate(&state, &host, Some("test-password".into()), None, None)
            .await
            .err()
            .unwrap();
        assert_eq!(error.kind, "unknown_host_key");
        assert_eq!(error.fingerprint, Some(expected.clone()));
        assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 0);
        assert!(trust_host_key_inner(&state, host.id.clone(), "SHA256:forged".into()).is_err());
        trust_host_key_inner(&state, host.id.clone(), expected.clone()).unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
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
        trust_host_key_inner(&state, host.id.clone(), "observed".into()).unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
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
    async fn live_terminal_streams_utf8_resizes_and_cleans_up() {
        let (host, server, task) = server(false).await;
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        state.config().unwrap().hosts.push(host.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let _ = tx.send(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            }
            Ok(())
        });
        let result = start_session(
            &state,
            host.id,
            Some("test-password".into()),
            None,
            None,
            80,
            24,
            events,
        )
        .await
        .unwrap();
        let session = state.session(&result.session_id).await.unwrap();
        session
            .input
            .send(Input::Data("你好🌍".into()))
            .await
            .unwrap();
        session.input.send(Input::Resize(120, 40)).await.unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
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
            .invoke_handler(tauri::generate_handler![list_hosts])
            .build(tauri::generate_context!(test = true))
            .unwrap();
        app.manage(AppState::new(dir.path().into()).unwrap());
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
        let request = |url: &str| tauri::webview::InvokeRequest {
            cmd: "list_hosts".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: url.parse().unwrap(),
            body: Default::default(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        };
        let local = tauri::test::get_ipc_response(&main, request("http://127.0.0.1:1420"));
        assert!(local.is_ok(), "{local:?}");
        assert!(local
            .unwrap()
            .deserialize::<Vec<Host>>()
            .unwrap()
            .is_empty());
        assert!(tauri::test::get_ipc_response(&other, request("http://127.0.0.1:1420")).is_err());
        assert!(tauri::test::get_ipc_response(&main, request("https://example.com")).is_err());
        assert!(tauri::test::get_ipc_response(&main, request("http://127.0.0.1:41234")).is_err());
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
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let user_key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
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
        fs::write(&config,format!("ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nAuthorizedKeysFile {}\nPidFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nPermitRootLogin yes\nSubsystem sftp internal-sftp\n",key_path.display(),authorized.display(),dir.path().join("sshd.pid").display())).unwrap();
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
            let handle = Arc::new(
                authenticate(
                    &app.state(),
                    &forwarding_host,
                    None,
                    Some(user_key.to_openssh(Default::default()).unwrap().to_string()),
                    None,
                )
                .await
                .unwrap(),
            );
            let (channel, initial) = open_terminal(&handle, 80, 24, None).await.unwrap();
            let forwarding = spawn_terminal(
                &app.state(),
                handle,
                channel,
                initial,
                Channel::new(|_| Ok(())),
            )
            .await
            .unwrap();
            let error = crate::et::connect_et(
                app.state(),
                forwarding.session_id.clone(),
                Default::default(),
                80,
                24,
                Channel::new(|_| Ok(())),
            )
            .await
            .err()
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
            let (tx, mut rx) = mpsc::unbounded_channel();
            let events = Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                    let _ = tx.send(serde_json::from_str::<serde_json::Value>(&json).unwrap());
                }
                Ok(())
            });
            let connected = connect_mosh(app.state(), id.clone(), options, 80, 24, events)
                .await
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
            write_stdin(app.state(), mosh_id.clone(), String::new())
                .await
                .unwrap();
            write_stdin(
                app.state(),
                mosh_id.clone(),
                "printf 'MOSH_%s_READY\\n' '世界'\r".into(),
            )
            .await
            .unwrap();
            marker(&mut rx, &native_session, "MOSH_世界_READY").await;
            resize(app.state(), mosh_id.clone(), 120, 40).await.unwrap();
            write_stdin(
                app.state(),
                mosh_id.clone(),
                "set -- $(stty size); printf 'MOSH_SIZE_%s_%s\\n' \"$1\" \"$2\"\r".into(),
            )
            .await
            .unwrap();
            marker(&mut rx, &native_session, "MOSH_SIZE_40_120").await;
            let file = dir
                .path()
                .join("mosh-control.txt")
                .to_string_lossy()
                .into_owned();
            upload_file(
                app.state(),
                mosh_id.clone(),
                file.clone(),
                b"SSH control remains alive".to_vec(),
            )
            .await
            .unwrap();
            assert_eq!(
                read_file(app.state(), mosh_id.clone(), file).await.unwrap(),
                "SSH control remains alive"
            );
            assert!(resize(app.state(), mosh_id.clone(), 512, 256)
                .await
                .is_err());
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
        let forwarding_handle = Arc::new(
            authenticate(
                &app.state(),
                &forwarding_host,
                None,
                Some(user_key.to_openssh(Default::default()).unwrap().to_string()),
                None,
            )
            .await
            .unwrap(),
        );
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
        let upload = dir
            .path()
            .join("new file' safe.txt")
            .to_string_lossy()
            .into_owned();
        upload_file(
            app.state(),
            id.clone(),
            upload.clone(),
            "hello 世界".as_bytes().to_vec(),
        )
        .await
        .unwrap();
        assert_eq!(
            read_file(app.state(), id.clone(), upload.clone())
                .await
                .unwrap(),
            "hello 世界"
        );
        assert!(upload_file(
            app.state(),
            id.clone(),
            upload.clone(),
            b"replacement".to_vec()
        )
        .await
        .is_err());
        assert_eq!(fs::read(&upload).unwrap(), "hello 世界".as_bytes());
        let entries = list_directory(
            app.state(),
            id.clone(),
            dir.path().to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert!(entries
            .iter()
            .any(|e| e.name == "new file' safe.txt" && !e.is_dir && e.size == 12));
        let large = dir.path().join("large");
        fs::write(&large, vec![0u8; FILE_LIMIT as usize + 1]).unwrap();
        assert_eq!(
            read_file(
                app.state(),
                id.clone(),
                large.to_string_lossy().into_owned()
            )
            .await
            .unwrap_err()
            .kind,
            "file_too_large"
        );
        let binary = dir.path().join("binary");
        fs::write(&binary, [0xffu8, 0xfe]).unwrap();
        assert_eq!(
            read_file(
                app.state(),
                id.clone(),
                binary.to_string_lossy().into_owned()
            )
            .await
            .unwrap_err()
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
                app.state(),
                id.clone(),
                crowded.to_string_lossy().into_owned()
            )
            .await
            .err()
            .unwrap()
            .kind,
            "directory_too_large"
        );
        let rejected = dir.path().join("rejected-upload");
        assert_eq!(
            upload_file(
                app.state(),
                id.clone(),
                rejected.to_string_lossy().into_owned(),
                vec![0; UPLOAD_LIMIT + 1]
            )
            .await
            .err()
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
            app.state(),
            id.clone(),
            repo.to_string_lossy().into_owned(),
            false,
        )
        .await
        .unwrap();
        assert!(diff.contains("-before"));
        assert!(diff.contains("+after"));
        let staged = get_diff(
            app.state(),
            id.clone(),
            repo.to_string_lossy().into_owned(),
            true,
        )
        .await
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
            app.state(),
            app.state(),
            id.clone(),
            http_port,
            None,
            None,
        )
        .await
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
        resize(app.state(), id.clone(), 110, 35).await.unwrap();
        write_stdin(
            app.state(),
            id.clone(),
            "printf lazysh-interoperability\\n\r".into(),
        )
        .await
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
}
