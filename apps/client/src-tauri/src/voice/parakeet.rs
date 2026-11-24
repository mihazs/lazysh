//! One local model (Linux or Windows x86_64 and the Android Google build) and one owned synchronous worker. Cancellation stops delivery, not native CPU work.
use super::{Protected, Result, VoiceState};
use crate::app_lock::AccessLease;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
use tauri::{ipc::Channel, State};

// ONNX Runtime probes CPU topology in a loader constructor. Google's ARM translation
// can crash on that probe, so let ORT use its existing unavailable-CPU-info path there.
#[cfg(all(
    target_os = "android",
    target_arch = "aarch64",
    feature = "parakeet-android"
))]
#[no_mangle]
pub extern "C" fn __wrap_cpuinfo_initialize() -> bool {
    extern "C" {
        fn __real_cpuinfo_initialize() -> bool;
    }
    fn property_is(name: &std::ffi::CStr, expected: &[u8]) -> bool {
        let mut value = [0; libc::PROP_VALUE_MAX as usize];
        // The Android API bounds its write by PROP_VALUE_MAX and returns the value length.
        let len = unsafe { libc::__system_property_get(name.as_ptr(), value.as_mut_ptr()) };
        len > 0 && unsafe { std::ffi::CStr::from_ptr(value.as_ptr()) }.to_bytes() == expected
    }
    if property_is(c"ro.dalvik.vm.native.bridge", b"libndk_translation.so")
        && property_is(c"ro.dalvik.vm.isa.arm64", b"x86_64")
    {
        return false;
    }
    // Preserve normal CPU capability detection for physical ARM64.
    unsafe { __real_cpuinfo_initialize() }
}

pub const ARCHIVE_BYTES: u64 = 487_211_443;
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
    #[cfg(parakeet_local)]
    manager: Result<Arc<local::Manager>>,
}
impl ParakeetState {
    pub(super) fn new(root: PathBuf, busy: Arc<AtomicBool>) -> Self {
        #[cfg(parakeet_local)]
        {
            Self {
                manager: local::Manager::new(root, busy),
            }
        }
        #[cfg(not(parakeet_local))]
        {
            let _ = (root, busy);
            Self {}
        }
    }
    #[cfg(parakeet_local)]
    fn manager(&self) -> Result<&Arc<local::Manager>> {
        self.manager.as_ref().map_err(Clone::clone)
    }
    fn status(&self) -> Status {
        #[cfg(parakeet_local)]
        {
            match &self.manager {
                Ok(manager) => manager.status(),
                Err(reason) => Status::unavailable(reason.clone()),
            }
        }
        #[cfg(not(parakeet_local))]
        {
            Status::unavailable(
                "Parakeet is available only on Linux and Windows x86_64 and in the Google build of the Android app."
                    .into(),
            )
        }
    }
    pub(super) fn cancel_for_lock(&self) {
        #[cfg(parakeet_local)]
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
    #[cfg(parakeet_local)]
    {
        state
            .parakeet
            .manager
            .as_ref()
            .map_err(Clone::clone)?
            .cancel(&request_id)
    }
    #[cfg(not(parakeet_local))]
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
            #[cfg(parakeet_local)]
            {
                state
                    .parakeet
                    .manager()?
                    .install(&access, &request_id, events)
                    .await
            }
            #[cfg(not(parakeet_local))]
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
            #[cfg(parakeet_local)]
            {
                state.parakeet.manager()?.remove(&access, &request_id).await
            }
            #[cfg(not(parakeet_local))]
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
            #[cfg(parakeet_local)]
            {
                state
                    .parakeet
                    .manager()?
                    .transcribe(&access, &request_id, samples)
                    .await
            }
            #[cfg(not(parakeet_local))]
            {
                let _ = (state, request_id, samples);
                Err("Parakeet is unavailable on this platform".into())
            }
        })
        .await
}

#[cfg(parakeet_local)]
mod local;
