//! Explicit companion installation (Linux and macOS hosts) and executable resolution on positively identified Unix and Windows hosts.
use crate::{
    app_lock::{AccessLease, Guarded, GuardedError},
    ssh::{self, AppState, Result, Session, SshError},
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tauri::{ipc::Channel, State};
pub mod hooks;
pub(crate) mod install;
#[cfg(desktop)]
pub(crate) mod local;
mod powershell;
mod release;
mod resolve;
mod transfer;
/// A connection's host probe result (see `resolve::detect`), shared by every companion command on it.
#[derive(Default)]
pub(crate) struct HostProbe(tokio::sync::OnceCell<Option<resolve::Host>>);
impl HostProbe {
    /// Runs `probe` unless this connection already has an answer. Concurrent first callers share one probe.
    async fn resolve<F, Fut>(&self, probe: F) -> Result<Option<resolve::Host>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<resolve::Probed>>,
    {
        let answer = self
            .0
            .get_or_try_init(|| async {
                match probe().await {
                    Ok(resolve::Probed::Known(host)) => Ok(host),
                    Ok(resolve::Probed::Unknown) => Err(None),
                    Err(error) => Err(Some(error)),
                }
            })
            .await;
        match answer {
            Ok(host) => Ok(host.clone()),
            Err(None) => Ok(None),
            Err(Some(error)) => Err(error),
        }
    }
}
pub(crate) async fn positive_unix(session: &Session, lease: &AccessLease) -> Result<bool> {
    Ok(resolve::detect(session, lease)
        .await?
        .and_then(resolve::Host::unix)
        .is_some())
}
fn error(kind: &'static str, message: &'static str) -> SshError {
    SshError::new(kind, message)
}
pub(crate) async fn command(
    session: &Session,
    command: String,
    lease: &AccessLease,
) -> Result<String> {
    match resolve::detect(session, lease).await? {
        Some(host) => host.command(&command),
        None => Ok(command),
    }
}
// Only a positively identified Unix or Windows host classifies absent/older companions.
pub(crate) const USAGE_COMPANION_REQUIRED: &str = "lazysh-account-usage-companion-required-v1";
pub(crate) async fn account_usage_command(
    session: &Session,
    lease: &AccessLease,
) -> Result<String> {
    required_command(
        session,
        "lazysh-agent account-usage --watch-channel".into(),
        USAGE_COMPANION_REQUIRED,
        lease,
    )
    .await
}
pub(crate) async fn required_command(
    session: &Session,
    original: String,
    marker: &str,
    lease: &AccessLease,
) -> Result<String> {
    required_command_with_diagnostics(session, original, marker, lease, false).await
}

pub(crate) async fn required_command_with_diagnostics(
    session: &Session,
    original: String,
    marker: &str,
    lease: &AccessLease,
    diagnostics: bool,
) -> Result<String> {
    match resolve::detect(session, lease).await? {
        Some(host) => host.required(&original, marker, diagnostics),
        None => Ok(original),
    }
}
/// A command line made only of bare safe words and `ssh::quote`d text, the form every companion
/// builder writes, as the words it stands for. Anything a shell would interpret is refused.
fn words(line: &str) -> Result<Vec<String>> {
    let (mut words, mut word, mut started, mut quoted) = (Vec::new(), String::new(), false, false);
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '\'') => quoted = false,
            (true, c) => word.push(c),
            (false, '\'') => (quoted, started) = (true, true),
            // `quote` writes a literal single quote as `'\''`.
            (false, '\\') if chars.as_str().starts_with('\'') => {
                chars.next();
                word.push('\'');
                started = true;
            }
            (false, ' ') if started => {
                words.push(std::mem::take(&mut word));
                started = false;
            }
            (false, ' ') => {}
            (false, c) if c.is_ascii_alphanumeric() || "-_./:,+@=".contains(c) => {
                word.push(c);
                started = true;
            }
            _ => return Err(error("companion_command", "Invalid companion command")),
        }
    }
    if quoted {
        return Err(error("companion_command", "Invalid companion command"));
    }
    if started {
        words.push(word);
    }
    Ok(words)
}

pub(crate) async fn exec(
    session: &Session,
    original: String,
    lease: &AccessLease,
) -> Result<String> {
    ssh::exec_for_access(session, command(session, original, lease).await?, lease).await
}
/// What the app knows of the host's companion before it asks to change it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    schema_version: u8,
    /// `X.Y.Z` of `lazysh-agent --version`; none when there is no companion or it did not answer.
    version: Option<String>,
    /// A positively identified Unix shell: the only kind of host the app sends its version to and
    /// can install a companion on.
    unix: bool,
}
fn parse_version(text: &str) -> Option<String> {
    let version = text.trim().strip_prefix("lazysh-agent ")?;
    release::version(version).map(|_| version.to_owned())
}
#[tauri::command]
pub async fn companion_version(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Version>, GuardedError<SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            // A Windows host is identified too, but the app neither sends its version there nor installs.
            let Some(unix) = resolve::detect(&session, &access)
                .await?
                .and_then(resolve::Host::unix)
            else {
                return Ok(Version {
                    schema_version: 1,
                    version: None,
                    unix: false,
                });
            };
            // A host without a companion, or one that does not answer, simply has no version.
            let answer =
                ssh::exec_for_access(&session, unix.command("lazysh-agent --version")?, &access)
                    .await
                    .ok();
            Ok(Version {
                schema_version: 1,
                version: answer.as_deref().and_then(parse_version),
                unix: true,
            })
        })
        .await
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Detecting,
    CheckingRelease,
    Downloading,
    Uploading,
    Verifying,
    SelfTesting,
    Installing,
    CheckingInstalled,
    CleaningUp,
}
/// A stage change; `bytes` and `total` only accompany `downloading`, which the host reports.
#[derive(Clone, Serialize)]
pub struct Progress {
    stage: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}
impl Progress {
    fn new(stage: Stage) -> Self {
        Self {
            stage,
            bytes: None,
            total: None,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    schema_version: u8,
    status: &'static str,
    version: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    cleanup: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cleanup_failure: Option<transfer::CleanupFailure>,
}
/// What a removal did: it deleted the managed Herdr binary, or found none. Nothing else is ever deleted.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    schema_version: u8,
    status: &'static str,
    path: String,
}
#[derive(Debug, Serialize)]
pub struct InstallFailure {
    #[serde(flatten)]
    error: SshError,
    phase: Option<Stage>,
    /// Why the host failed, from a closed list; never remote text.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'static str>,
}
impl From<SshError> for InstallFailure {
    fn from(error: SshError) -> Self {
        Self {
            error,
            phase: None,
            detail: None,
        }
    }
}
/// Installs or updates the companion with the host doing the download: the phone sends only a pin.
#[tauri::command]
pub async fn install_companion(
    state: State<'_, AppState>,
    session_id: String,
    progress: Channel<Progress>,
    access: AccessLease,
) -> std::result::Result<Guarded<Installed>, GuardedError<InstallFailure>> {
    install_from(state, session_id, progress, access, install::Route::Host).await
}
/// The labelled offline fallback for hosts that cannot reach GitHub: this device downloads the
/// companion and uploads it over SFTP. Nothing else calls the device download.
#[tauri::command]
pub async fn install_companion_from_device(
    access: AccessLease,
    progress: Channel<Progress>,
    session_id: String,
    state: State<'_, AppState>,
) -> std::result::Result<Guarded<Installed>, GuardedError<InstallFailure>> {
    install_from(state, session_id, progress, access, install::Route::Device).await
}
/// Compares the installed companion with the latest verified release. Reads only; the phone fetches metadata.
#[tauri::command]
pub async fn check_companion_update(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<install::Checked>, GuardedError<SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            install::check(session, &access, &release::Publisher::new()?).await
        })
        .await
}
/// Installs the managed Herdr: the verified release file for this host is uploaded over this connection and published
/// by one rename. The system Herdr, its configuration, its servers and the saved default are never touched.
#[tauri::command]
pub async fn install_managed_herdr(
    session_id: String,
    access: AccessLease,
    state: State<'_, AppState>,
    progress: Channel<Progress>,
) -> std::result::Result<Guarded<Installed>, GuardedError<InstallFailure>> {
    install_from(state, session_id, progress, access, install::Route::Herdr).await
}
/// Removes the managed Herdr binary only: never a server, a session, a configuration or the system Herdr.
#[tauri::command]
pub async fn remove_managed_herdr(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Removed>, GuardedError<SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            install::remove_herdr(session, &access).await
        })
        .await
}
async fn install_from(
    state: State<'_, AppState>,
    session_id: String,
    progress: Channel<Progress>,
    access: AccessLease,
    route: install::Route,
) -> std::result::Result<Guarded<Installed>, GuardedError<InstallFailure>> {
    access
        .run(async {
            let session = state
                .session(&session_id)
                .await
                .map_err(InstallFailure::from)?;
            install::run(session, &access, progress, route).await
        })
        .await
}

/// An owned release fixture: `binary` published as `version`. The metadata is the fixture's; everything
/// the route then does to the host is real. It counts what the client was asked to fetch.
#[cfg(all(test, unix))]
pub(crate) struct Owned(release::Publisher);
#[cfg(all(test, unix))]
impl Owned {
    pub(crate) fn new(binary: &std::path::Path, version: &str) -> Self {
        Self(release::Publisher::owned(
            std::fs::read(binary).unwrap(),
            version.into(),
        ))
    }
    /// How often the client asked for release metadata.
    pub(crate) fn selects(&self) -> usize {
        self.0.calls.selects()
    }
    /// How often the client downloaded the companion itself: only the offline fallback may.
    pub(crate) fn downloads(&self) -> usize {
        self.0.calls.downloads()
    }
    pub(crate) async fn install(
        &self,
        session: Arc<Session>,
        lease: &AccessLease,
        route: install::Route,
    ) -> std::result::Result<Installed, InstallFailure> {
        install::run_with(
            session,
            lease,
            Channel::new(|_| Err(std::io::Error::other("owned retired observer").into())),
            &self.0,
            route,
        )
        .await
    }
}
#[cfg(all(test, unix))]
impl Owned {
    /// **Check for updates** against this fixture's release.
    pub(crate) async fn check(
        &self,
        session: Arc<Session>,
        lease: &AccessLease,
    ) -> Result<install::Checked> {
        install::check(session, lease, &self.0).await
    }
}
#[cfg(all(test, unix))]
impl InstallFailure {
    pub(crate) fn kind(&self) -> &str {
        self.error.kind()
    }
    pub(crate) fn detail(&self) -> Option<&'static str> {
        self.detail
    }
}
#[cfg(test)]
mod probe_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn linux() -> resolve::Host {
        resolve::Host::Unix(resolve::Unix {
            os: "linux",
            arch: "x64",
            uid: 1000,
            home: "/home/owner".into(),
            data: "/home/owner/.local/share".into(),
        })
    }
    async fn known(asked: &AtomicUsize, host: Option<resolve::Host>) -> Result<resolve::Probed> {
        asked.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        Ok(resolve::Probed::Known(host))
    }
    #[tokio::test]
    async fn a_connection_is_probed_once_even_when_commands_start_together() {
        let (probe, asked) = (HostProbe::default(), AtomicUsize::new(0));
        let (a, b, c) = tokio::join!(
            probe.resolve(|| known(&asked, Some(linux()))),
            probe.resolve(|| known(&asked, Some(linux()))),
            probe.resolve(|| known(&asked, Some(linux())))
        );
        for answer in [a, b, c] {
            assert_eq!(answer.unwrap(), Some(linux()));
        }
        assert_eq!(
            probe.resolve(|| known(&asked, None)).await.unwrap(),
            Some(linux())
        );
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn a_host_that_is_not_positive_unix_is_remembered_too() {
        let (probe, asked) = (HostProbe::default(), AtomicUsize::new(0));
        assert!(probe
            .resolve(|| known(&asked, None))
            .await
            .unwrap()
            .is_none());
        assert!(probe
            .resolve(|| known(&asked, Some(linux())))
            .await
            .unwrap()
            .is_none());
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn a_probe_that_did_not_answer_or_failed_is_asked_again() {
        let (probe, asked) = (HostProbe::default(), AtomicUsize::new(0));
        let unanswered = probe
            .resolve(|| async { Ok(resolve::Probed::Unknown) })
            .await;
        assert!(unanswered.unwrap().is_none());
        let failed = probe
            .resolve(|| async {
                Err::<resolve::Probed, _>(error("disconnected", "Session closed"))
            })
            .await;
        assert_eq!(failed.unwrap_err().kind(), "disconnected");
        assert!(probe
            .resolve(|| known(&asked, Some(linux())))
            .await
            .unwrap()
            .is_some());
        assert!(probe
            .resolve(|| known(&asked, None))
            .await
            .unwrap()
            .is_some());
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }
}

#[cfg(test)]
mod version_tests {
    use super::parse_version;
    #[test]
    fn only_a_strict_companion_version_line_is_a_version() {
        assert_eq!(
            parse_version("lazysh-agent 1.28.0\n").as_deref(),
            Some("1.28.0")
        );
        for text in [
            "",
            "lazysh-agent",
            "lazysh-agent 1.28",
            "lazysh-agent 01.28.0",
            "lazysh-agent 1.28.0-dev",
            "other 1.28.0",
            "lazysh-agent 1.28.0 extra",
        ] {
            assert_eq!(parse_version(text), None, "{text:?}");
        }
    }
}
