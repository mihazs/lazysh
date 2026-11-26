//! Whether platform accessibility is active (#1329, #1335). The native terminal draws on a GPU surface with no text a reader can reach, so
//! the client's registry refuses it for a new session while this says yes, whether or not the user also turned on the in-app
//! Screen reader announcements. The Kotlin plugin (`ScreenReaderPlugin.kt`) asks Android's accessibility manager: touch
//! exploration, which TalkBack and its kin turn on, or an enabled service that speaks or brailles the screen. Linux
//! asks AT-SPI whether desktop accessibility is enabled. Windows checks the legacy screen-reader flag and Narrator's running state.
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

/// Android's accessibility state, read from the application's one plugin handle; absent elsewhere.
#[cfg(target_os = "android")]
struct Readers(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct Status {
    active: bool,
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    crate::edge_gestures::command_only_plugin("lazysh-screen-reader")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(Readers(api.register_android_plugin(
                "app.lazysh.client",
                "ScreenReaderPlugin",
            )?));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(all(target_os = "linux", native_terminal_core))]
fn linux_accessibility_active() -> Result<bool, String> {
    use gtk::gio;
    use gtk::glib::variant::ToVariant;

    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .map_err(|_| "The Linux accessibility bus is unavailable".to_string())?;
    let reply = bus.call_sync(
        Some("org.a11y.Bus"),
        "/org/a11y/bus",
        "org.freedesktop.DBus.Properties",
        "Get",
        Some(&("org.a11y.Status", "IsEnabled").to_variant()),
        None,
        gio::DBusCallFlags::NONE,
        600,
        gio::Cancellable::NONE,
    );
    match reply {
        Ok(value) => value
            .get::<(gtk::glib::Variant,)>()
            .and_then(|(value,)| value.get::<bool>())
            .ok_or_else(|| "Invalid Linux accessibility status".to_string()),
        Err(_) => Err("The Linux accessibility status is unavailable".into()),
    }
}

#[cfg(all(target_os = "windows", native_terminal_core))]
fn windows_accessibility_active() -> Result<bool, String> {
    use windows_sys::{
        w,
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
            System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD},
            UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETSCREENREADER},
        },
    };

    let mut screen_reader: windows_sys::core::BOOL = 0;
    // SAFETY: The legacy query writes one BOOL to the supplied stack slot.
    unsafe {
        if SystemParametersInfoW(
            SPI_GETSCREENREADER,
            0,
            (&mut screen_reader as *mut windows_sys::core::BOOL).cast(),
            0,
        ) == 0
        {
            return Err("The Windows accessibility status is unavailable".into());
        }
    }
    if screen_reader != 0 {
        return Ok(true);
    }

    // Narrator does not set SPI_GETSCREENREADER. A UI Automation listener can be any application.
    let mut running = 0u32;
    let mut bytes = size_of::<u32>() as u32;
    // SAFETY: RegGetValueW reads the current user's DWORD into a bounded stack slot.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Narrator\NoRoam"),
            w!("RunningState"),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut running as *mut u32).cast(),
            &mut bytes,
        )
    };
    match status {
        ERROR_SUCCESS => Ok(running != 0),
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(false),
        _ => Err("The Windows Narrator status is unavailable".into()),
    }
}

/// Whether a screen reader is on. Like the probe it reads the device and nothing of the user's, so a locked app may ask: the
/// engine Auto resolves to is announced at launch, before the app is unlocked.
#[tauri::command]
pub async fn screen_reader_active(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<Readers>()
            .0
            .run_mobile_plugin_async::<Status>("status", serde_json::json!({}))
            .await
            .map(|status| status.active)
            .map_err(|_| "The Android accessibility state is unavailable".to_string())
    }
    #[cfg(all(any(target_os = "linux", target_os = "windows"), native_terminal_core))]
    {
        let _ = app;
        #[cfg(target_os = "linux")]
        let status = linux_accessibility_active;
        #[cfg(target_os = "windows")]
        let status = windows_accessibility_active;
        tauri::async_runtime::spawn_blocking(status)
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(any(
        target_os = "android",
        all(any(target_os = "linux", target_os = "windows"), native_terminal_core)
    )))]
    {
        let _ = app;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_locked_app_can_ask_whether_a_screen_reader_is_on() {
        assert!(crate::app_lock::allowed_while_locked(
            "screen_reader_active"
        ));
    }
}

#[cfg(all(test, target_os = "windows", native_terminal_core))]
mod windows_tests {
    use super::windows_accessibility_active;
    use std::{
        process::{Command, Stdio},
        thread::sleep,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::UI::{
        Accessibility::UiaClientsAreListening,
        WindowsAndMessaging::{SystemParametersInfoW, SPI_GETSCREENREADER},
    };

    #[test]
    #[ignore = "requires an isolated interactive Windows runner"]
    fn the_windows_reader_probe_tracks_an_owned_uia_subscription() {
        assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
        assert_eq!(
            std::env::var("RUNNER_ENVIRONMENT").as_deref(),
            Ok("github-hosted")
        );
        let mut legacy_reader: windows_sys::core::BOOL = 0;
        // SAFETY: The legacy query writes one BOOL to the stack.
        let (uia_listener, legacy_status) = unsafe {
            (
                UiaClientsAreListening() != 0,
                SystemParametersInfoW(
                    SPI_GETSCREENREADER,
                    0,
                    (&mut legacy_reader as *mut windows_sys::core::BOOL).cast(),
                    0,
                ) != 0,
            )
        };
        assert_eq!(
            windows_accessibility_active(),
            Ok(false),
            "runner baseline is occupied (UIA listener={uia_listener}, legacy query succeeded={legacy_status}, legacy flag={legacy_reader})"
        );

        let mut reader = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-MTA",
                "-Command",
                r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes -TypeDefinition @'
using System.Windows.Automation;
public static class OwnedAutomationSubscriber {
    public static readonly AutomationFocusChangedEventHandler Handler = delegate { };
}
'@
$handler = [OwnedAutomationSubscriber]::Handler
[System.Windows.Automation.Automation]::AddFocusChangedEventHandler($handler)
try { $null = [Console]::ReadLine() }
finally { [System.Windows.Automation.Automation]::RemoveFocusChangedEventHandler($handler) }
"#,
            ])
            .stdin(Stdio::piped())
            .spawn()
            .expect("start an owned UI Automation client");
        let wait_until = |expected| {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(10) {
                if windows_accessibility_active() == Ok(expected) {
                    return true;
                }
                sleep(Duration::from_millis(50));
            }
            false
        };
        let detected = wait_until(true);
        drop(reader.stdin.take());
        let shutdown = Instant::now();
        let status = loop {
            if let Some(status) = reader.try_wait().unwrap() {
                break status;
            }
            if shutdown.elapsed() >= Duration::from_secs(5) {
                reader.kill().unwrap();
                break reader.wait().unwrap();
            }
            sleep(Duration::from_millis(50));
        };
        assert!(
            status.success(),
            "the UI Automation client exited with {status}"
        );
        assert!(
            detected,
            "the subscription never triggered the Windows probe"
        );
        assert!(
            wait_until(false),
            "the Windows probe retained the closed subscriber"
        );
    }
}
