//! Explicit companion installation and positive-Unix-only executable resolution.
use crate::{
    app_lock::{AccessLease, Guarded, GuardedError},
    ssh::{self, AppState, Result, Session, SshError},
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tauri::{ipc::Channel, State};
mod install;
mod release;
mod resolve;
mod transfer;
fn error(kind: &'static str, message: &'static str) -> SshError {
    SshError::new(kind, message)
}
pub(crate) async fn command(
    session: &Session,
    command: String,
    lease: &AccessLease,
) -> Result<String> {
    match resolve::detect(session, lease).await? {
        Some(unix) => unix.command(&command),
        None => Ok(command),
    }
}
pub(crate) async fn exec(
    session: &Session,
    original: String,
    lease: &AccessLease,
) -> Result<String> {
    ssh::exec_for_access(session, command(session, original, lease).await?, lease).await
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Detecting,
    CheckingRelease,
    Downloading,
    Uploading,
    Verifying,
    Installing,
    CheckingInstalled,
    CleaningUp,
}
#[derive(Clone, Serialize)]
pub struct Progress {
    stage: Stage,
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
}
#[tauri::command]
pub async fn install_companion(
    state: State<'_, AppState>,
    session_id: String,
    progress: Channel<Progress>,
    access: AccessLease,
) -> std::result::Result<Guarded<Installed>, GuardedError<SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            install::run(session, &access, progress).await
        })
        .await
}

#[cfg(all(test, unix))]
pub(crate) async fn owned_install(
    session: Arc<Session>,
    lease: &AccessLease,
    binary: &std::path::Path,
) -> Result<Installed> {
    let bytes = std::fs::read(binary)?;
    install::run_with(
        session,
        lease,
        Channel::new(|_| Err(std::io::Error::other("owned retired observer").into())),
        release::Publisher::owned(bytes, env!("CARGO_PKG_VERSION").into()),
    )
    .await
}
