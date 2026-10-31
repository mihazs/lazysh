//! Account-quota reads stay on the session machine and obey native access lifetime.
use crate::{
    app_lock::AccessLease,
    local::LocalState,
    ssh::{self, AppState},
};
use lazysh_account_usage::{Response, OUTPUT_LIMIT};
use std::{sync::Arc, time::Duration};
use tauri::State;
use tokio::sync::Semaphore;
const LIMIT: usize = OUTPUT_LIMIT;
const DEADLINE: Duration = Duration::from_secs(25);
pub struct UsageState {
    reading: Arc<Semaphore>,
}
impl Default for UsageState {
    fn default() -> Self {
        Self {
            reading: Arc::new(Semaphore::new(1)),
        }
    }
}
#[tauri::command]
pub async fn account_usage(
    lease: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    usage: State<'_, UsageState>,
    session_id: String,
) -> ssh::AccessResult<Response> {
    lease
        .run(async {
            let permit = match usage.reading.clone().try_acquire_owned() {
                Ok(p) => p,
                Err(_) => return Ok(Response::unavailable("busy")),
            };
            if session_id.starts_with("local:") {
                let cancel = match crate::local::usage_session(&local, &session_id, &lease) {
                    Ok(c) => c,
                    Err(_) => return Ok(Response::unavailable("disconnected")),
                };
                #[cfg(desktop)]
                return tokio::select! {
                    result=lazysh_account_usage::read()=>Ok(result),
                    _=lease.cancelled()=>Ok(Response::unavailable("disconnected")),
                    _=wait_cancelled(cancel)=>Ok(Response::unavailable("disconnected")),
                };
                #[cfg(not(desktop))]
                {
                    let _ = cancel;
                    return Ok(Response::unavailable("unavailable"));
                }
            }
            let session = match state.session(&session_id).await {
                Ok(s) => s,
                Err(_) => return Ok(Response::unavailable("disconnected")),
            };
            let result = async {
                let command = crate::companion::account_usage_command(&session, &lease).await?;
                ssh::exec_bounded(&session, command, &lease, DEADLINE, LIMIT, None).await
            }
            .await;
            drop(permit);
            Ok(match result {
                Ok(output) if output.trim() == crate::companion::USAGE_COMPANION_REQUIRED => {
                    Response::unavailable("companion_required")
                }
                Ok(output) => lazysh_account_usage::from_wire(output.as_bytes()),
                Err(error) => Response::unavailable(match error.kind() {
                    "disconnected" | "ssh_host_tools_closed" => "disconnected",
                    "timeout" => "timeout",
                    "output_too_large" => "invalid_report",
                    _ => "unavailable",
                }),
            })
        })
        .await
}
#[cfg(desktop)]
async fn wait_cancelled(mut cancel: tokio::sync::watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let _ = cancel.changed().await;
}
