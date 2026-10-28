use serde::{Deserialize, Serialize};
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationStatus {
    pub provider: String,
    pub supported: bool,
    pub configured: bool,
    pub enabled: bool,
    pub token_present: bool,
    pub busy: bool,
    #[serde(default)]
    pub display_supported: bool,
    #[serde(default)]
    pub display_enabled: bool,
    pub reason: String,
}

struct Push<R: Runtime> {
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(desktop)]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

struct ControlSequence(std::sync::atomic::AtomicU64);

#[cfg(mobile)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Control {
    operation_epoch: u64,
}

#[cfg(mobile)]
#[derive(Serialize)]
struct DisplayControl {
    permit: String,
}

#[cfg(desktop)]
fn unsupported() -> RegistrationStatus {
    RegistrationStatus {
        provider: "none".into(),
        supported: false,
        configured: false,
        enabled: false,
        token_present: false,
        busy: false,
        display_supported: false,
        display_enabled: false,
        reason: "Remote push registration requires a configured Android or iOS build. Local inbox notifications remain available.".into(),
    }
}

fn call<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    epoch: u64,
) -> Result<RegistrationStatus, String> {
    #[cfg(mobile)]
    {
        app.state::<Push<R>>()
            .handle
            .run_mobile_plugin(
                command,
                Control {
                    operation_epoch: epoch,
                },
            )
            .map_err(|_| {
                "Cannot complete native push registration; check configuration and retry".into()
            })
    }
    #[cfg(desktop)]
    {
        let _ = (app.state::<Push<R>>(), epoch);
        if command == "status" {
            Ok(unsupported())
        } else {
            Err(unsupported().reason)
        }
    }
}

pub mod commands {
    use super::*;
    async fn change<R: Runtime>(
        app: AppHandle<R>,
        command: &'static str,
        interrupted: &'static str,
    ) -> Result<RegistrationStatus, String> {
        let epoch = app
            .state::<ControlSequence>()
            .0
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        tauri::async_runtime::spawn_blocking(move || call(&app, command, epoch))
            .await
            .map_err(|_| interrupted.to_owned())?
    }
    #[tauri::command]
    pub fn push_registration_status<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<RegistrationStatus, String> {
        call(&app, "status", 0)
    }

    #[tauri::command]
    pub async fn push_registration_register<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<RegistrationStatus, String> {
        change(app, "register", "Native push registration interrupted").await
    }

    #[tauri::command]
    pub async fn push_registration_enroll<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<RegistrationStatus, String> {
        if !cfg!(all(target_os = "android", feature = "fdroid")) {
            return Err("Private relay enrollment requires the F-Droid Android build".into());
        }
        change(app, "enroll", "Native private enrollment interrupted").await
    }

    #[tauri::command]
    pub async fn push_registration_disable<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<RegistrationStatus, String> {
        change(app, "disable", "Native push revocation interrupted").await
    }

    #[tauri::command]
    pub async fn push_registration_display<R: Runtime>(
        app: AppHandle<R>,
        permit: String,
    ) -> Result<RegistrationStatus, String> {
        if !cfg!(all(target_os = "android", feature = "fdroid")) {
            return Err("Remote notification display requires the F-Droid Android build".into());
        }
        #[cfg(mobile)]
        return tauri::async_runtime::spawn_blocking(move || {
            app.state::<Push<R>>()
                .handle
                .run_mobile_plugin("display", DisplayControl { permit })
                .map_err(|_| "Cannot complete native notification consent".to_owned())
        })
        .await
        .map_err(|_| "Native notification consent interrupted".to_owned())?;
        #[cfg(desktop)]
        {
            let _ = (app, permit);
            unreachable!("F-Droid Android only")
        }
    }
}
pub use commands::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_lazysh_push);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("lazysh-push")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let push = Push {
                handle: api.register_android_plugin(
                    if cfg!(feature = "fdroid") {
                        "app.lazysh.unifiedpush"
                    } else {
                        "app.lazysh.push"
                    },
                    "PushPlugin",
                )?,
            };
            #[cfg(target_os = "ios")]
            let push = Push {
                handle: api.register_ios_plugin(init_plugin_lazysh_push)?,
            };
            #[cfg(desktop)]
            let push = {
                let _ = api;
                Push::<R> {
                    _runtime: std::marker::PhantomData,
                }
            };
            app.manage(push);
            app.manage(ControlSequence(std::sync::atomic::AtomicU64::new(0)));
            Ok(())
        })
        .build()
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn unsupported_platform_does_not_claim_native_registration() {
        let app = tauri::test::mock_builder()
            .plugin(init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let status = call(app.handle(), "status", 0).unwrap();
        assert_eq!(status.provider, "none");
        assert!(
            !status.supported
                && !status.configured
                && !status.enabled
                && !status.token_present
                && !status.busy
        );
        assert!(call(app.handle(), "register", 1).is_err());
        assert!(call(app.handle(), "disable", 2).is_err());
        assert!(
            tauri::async_runtime::block_on(push_registration_enroll(app.handle().clone())).is_err()
        );
        assert!(tauri::async_runtime::block_on(push_registration_display(
            app.handle().clone(),
            String::new()
        ))
        .is_err());
        assert_eq!(call(app.handle(), "status", 0).unwrap().provider, "none");
    }

    #[test]
    fn concurrent_controls_receive_unique_ordered_epochs() {
        let sequence = std::sync::Arc::new(ControlSequence(std::sync::atomic::AtomicU64::new(0)));
        let workers: Vec<_> = (0..32)
            .map(|_| {
                let sequence = sequence.clone();
                std::thread::spawn(move || {
                    sequence.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
                })
            })
            .collect();
        let mut tickets: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        tickets.sort_unstable();
        assert_eq!(tickets, (1..=32).collect::<Vec<_>>());
    }
}
