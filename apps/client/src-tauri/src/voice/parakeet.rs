//! One Linux model and one owned synchronous worker. Cancellation stops delivery, not native CPU work.
use super::{Protected, Result, VoiceState};
use crate::app_lock::AccessLease;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
use tauri::{ipc::Channel, State};

pub const ARCHIVE_BYTES: u64 = 487_170_055;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    available: bool,
    reason: String,
    installed: bool,
    ready: bool,
    busy: bool,
    stage: String,
    request_id: Option<String>,
    received: u64,
    total: u64,
}
impl Status {
    fn unavailable(reason: String) -> Self {
        Self {
            available: false,
            reason,
            installed: false,
            ready: false,
            busy: false,
            stage: "idle".into(),
            request_id: None,
            received: 0,
            total: ARCHIVE_BYTES,
        }
    }
}
#[derive(Serialize)]
pub struct Transcript {
    #[serde(rename = "requestId")]
    request_id: String,
    text: String,
}
#[derive(Serialize)]
pub struct Cancelled {
    cancelled: bool,
    finishing: bool,
}
pub struct ParakeetState {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    manager: Result<Arc<local::Manager>>,
}
impl ParakeetState {
    pub(super) fn new(root: PathBuf, busy: Arc<AtomicBool>) -> Self {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            Self {
                manager: local::Manager::new(root, busy),
            }
        }
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        {
            let _ = (root, busy);
            Self {}
        }
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    fn manager(&self) -> Result<&Arc<local::Manager>> {
        self.manager.as_ref().map_err(Clone::clone)
    }
    fn status(&self) -> Status {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            match &self.manager {
                Ok(manager) => manager.status(),
                Err(reason) => Status::unavailable(reason.clone()),
            }
        }
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        {
            Status::unavailable("Parakeet is currently available only on Linux x86_64.".into())
        }
    }
    pub(super) fn cancel_for_lock(&self) {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        if let Ok(manager) = &self.manager {
            manager.cancel_active();
        }
    }
}
#[tauri::command]
pub fn voice_parakeet_status(
    access: AccessLease,
    state: State<'_, VoiceState>,
) -> Protected<Status> {
    access.run_sync(|| Ok(state.parakeet.status()))
}
#[tauri::command]
pub fn voice_parakeet_cancel(
    state: State<'_, VoiceState>,
    request_id: String,
) -> Result<Cancelled> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        state
            .parakeet
            .manager
            .as_ref()
            .map_err(Clone::clone)?
            .cancel(&request_id)
    }
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    {
        let _ = (state, request_id);
        Ok(Cancelled {
            cancelled: false,
            finishing: false,
        })
    }
}
#[tauri::command]
pub async fn voice_parakeet_install(
    access: AccessLease,
    state: State<'_, VoiceState>,
    request_id: String,
    events: Channel<Status>,
) -> Protected<()> {
    access
        .run(async {
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            {
                state
                    .parakeet
                    .manager()?
                    .install(&access, &request_id, events)
                    .await
            }
            #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
            {
                let _ = (state, request_id, events);
                Err("Parakeet is unavailable on this platform".into())
            }
        })
        .await
}
#[tauri::command]
pub async fn voice_parakeet_remove(
    access: AccessLease,
    state: State<'_, VoiceState>,
    request_id: String,
) -> Protected<()> {
    access
        .run(async {
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            {
                state.parakeet.manager()?.remove(&access, &request_id).await
            }
            #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
            {
                let _ = (state, request_id);
                Err("Parakeet is unavailable on this platform".into())
            }
        })
        .await
}
#[tauri::command]
pub async fn voice_parakeet_transcribe(
    access: AccessLease,
    state: State<'_, VoiceState>,
    request_id: String,
    samples: Vec<f32>,
) -> Protected<Transcript> {
    access
        .run(async {
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            {
                state
                    .parakeet
                    .manager()?
                    .transcribe(&access, &request_id, samples)
                    .await
            }
            #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
            {
                let _ = (state, request_id, samples);
                Err("Parakeet is unavailable on this platform".into())
            }
        })
        .await
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod local;
