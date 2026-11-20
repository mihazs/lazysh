use crate::app_lock::{AccessLease, Guarded, GuardedError};
type Protected<T> = std::result::Result<Guarded<T>, GuardedError<crate::ssh::SshError>>;
use crate::host::Host;
use crate::local::LocalState;
use crate::ssh::{quote, AppState, Result, SshError};
use tauri::State;
pub mod stream;
pub use stream::DeviceStreams;

fn platform(value: &str) -> Result<()> {
    if matches!(value, "android" | "ios") {
        Ok(())
    } else {
        Err(SshError::new(
            "invalid_input",
            "Unsupported device platform",
        ))
    }
}
fn identifier(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        Err(SshError::new("invalid_input", "Invalid device identifier"))
    } else {
        Ok(())
    }
}
fn companion_command(id: &str, socket: &str, action: &str) -> Result<String> {
    identifier(id)?;
    if !socket.starts_with('/')
        || socket.len() > 1024
        || socket.contains(':')
        || socket.chars().any(char::is_control)
    {
        return Err(SshError::new(
            "invalid_input",
            "Select a local Unix companion socket",
        ));
    }
    Ok(format!(
        "lazysh-agent devices ios --id={} --socket={} {action}",
        quote(id),
        quote(socket)
    ))
}
fn android_command(id: &str, action: &str) -> Result<String> {
    identifier(id)?;
    Ok(format!(
        "lazysh-agent devices android --id={} {action}",
        quote(id)
    ))
}
fn display_size(width: u32, height: u32, message: &'static str) -> Result<()> {
    if (1..=8192).contains(&width) && (1..=8192).contains(&height) {
        Ok(())
    } else {
        Err(SshError::new("invalid_input", message))
    }
}
/// The `tap`/`swipe` subcommand and flags for a point inside the display the coordinates were mapped from.
fn gesture_arguments(
    action: &DeviceAction,
    width: u32,
    height: u32,
) -> Option<(&'static str, String)> {
    let (subcommand, flags) = match *action {
        DeviceAction::Tap { x, y } if x < width && y < height => {
            ("tap", format!("--x {x} --y {y}"))
        }
        DeviceAction::Swipe {
            x,
            y,
            to_x,
            to_y,
            duration_ms,
        } if x < width
            && y < height
            && to_x < width
            && to_y < height
            && (1..=10000).contains(&duration_ms) =>
        {
            (
                "swipe",
                format!("--x {x} --y {y} --to-x {to_x} --to-y {to_y} --duration-ms {duration_ms}"),
            )
        }
        _ => return None,
    };
    Some((
        subcommand,
        format!("{flags} --width {width} --height {height}"),
    ))
}
fn android_gesture_command(
    id: &str,
    width: u32,
    height: u32,
    action: &DeviceAction,
) -> Result<String> {
    display_size(width, height, "Invalid Android display size")?;
    let (subcommand, arguments) = gesture_arguments(action, width, height)
        .ok_or_else(|| SshError::new("invalid_input", "Unsupported Android video action"))?;
    android_command(id, &format!("{subcommand} {arguments}"))
}
/// Runs a companion command line on the session's host: over SSH, or on this device.
async fn companion_json(
    state: &AppState,
    local: &LocalState,
    access: &AccessLease,
    session_id: &str,
    command: Result<String>,
) -> Result<serde_json::Value> {
    let command = command?;
    let host = Host::resolve(state, local, session_id, access).await?;
    access.check()?;
    Ok(serde_json::from_str(
        &host.companion(access, command).await?,
    )?)
}
/// `companion_json` under the access lease, for the commands that only build a command line.
async fn run_companion(
    access: &AccessLease,
    state: &AppState,
    local: &LocalState,
    session_id: &str,
    command: Result<String>,
) -> Protected<serde_json::Value> {
    access
        .run(companion_json(state, local, access, session_id, command))
        .await
}
/// An Android companion subcommand that takes the device and nothing else.
async fn android_read(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    id: String,
    action: &str,
) -> Protected<serde_json::Value> {
    let command = android_command(&id, action);
    run_companion(&access, &state, &local, &session_id, command).await
}
#[tauri::command]
pub async fn android_device_probe(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    id: String,
) -> Protected<serde_json::Value> {
    android_read(access, state, local, session_id, id, "probe").await
}
#[tauri::command]
pub async fn android_ui_tree(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    id: String,
) -> Protected<serde_json::Value> {
    android_read(access, state, local, session_id, id, "ui tree").await
}
/// The identity of a node as `android_ui_tree` listed it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiNode {
    resource_id: String,
    text: String,
    content_description: String,
    occurrence: u32,
}
fn ui_action_command(id: &str, node: &UiNode, kind: &str) -> Result<String> {
    // The host shortens texts to 256 characters; nothing longer is a node it listed.
    let field = |value: &str| {
        if value.chars().count() > 256 || value.contains('\0') {
            Err(SshError::new("invalid_input", "Invalid accessibility node"))
        } else {
            Ok(quote(value))
        }
    };
    if !matches!(kind, "click" | "long-click") || node.occurrence > 5000 {
        return Err(SshError::new(
            "invalid_input",
            "Invalid accessibility action",
        ));
    }
    android_command(
        id,
        &format!(
            "ui act --kind {kind} --resource-id={} --text={} --content-desc={} --occurrence {}",
            field(&node.resource_id)?,
            field(&node.text)?,
            field(&node.content_description)?,
            node.occurrence
        ),
    )
}
/// Tap or long-press the one node with this identity; the host re-reads the screen first.
#[tauri::command]
pub async fn android_ui_action(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    id: String,
    node: UiNode,
    kind: String,
) -> Protected<serde_json::Value> {
    run_companion(
        &access,
        &state,
        &local,
        &session_id,
        ui_action_command(&id, &node, &kind),
    )
    .await
}
#[tauri::command]
pub async fn ios_device_probe(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    id: String,
    socket: String,
) -> Protected<serde_json::Value> {
    run_companion(
        &access,
        &state,
        &local,
        &session_id,
        companion_command(&id, &socket, "probe"),
    )
    .await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Native-injected lease plus the existing typed IPC fields.
pub async fn ios_device_action(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    id: String,
    socket: String,
    width: u32,
    height: u32,
    action: DeviceAction,
) -> Protected<serde_json::Value> {
    access
        .run(async {
            let (subcommand, arguments) = match &action {
                DeviceAction::Key { key }
                    if matches!(key.as_str(), "home" | "power" | "volume-up" | "volume-down") =>
                {
                    ("button", format!("--key {key}"))
                }
                _ => gesture_arguments(&action, width, height).ok_or_else(|| {
                    SshError::new("invalid_input", "Unsupported iOS companion action")
                })?,
            };
            display_size(width, height, "Invalid iOS point dimensions")?;
            companion_json(
                &state,
                &local,
                &access,
                &session_id,
                companion_command(&id, &socket, &format!("{subcommand} {arguments}")),
            )
            .await
        })
        .await
}
/// Touch an Android device while its video is shown. The host refuses the gesture when the display
/// no longer has the `width` x `height` the pointer was mapped from (rotation or resize).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Native-injected lease plus the typed IPC fields.
pub async fn android_device_action(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    id: String,
    width: u32,
    height: u32,
    action: DeviceAction,
) -> Protected<serde_json::Value> {
    run_companion(
        &access,
        &state,
        &local,
        &session_id,
        android_gesture_command(&id, width, height, &action),
    )
    .await
}
#[tauri::command]
pub async fn list_devices(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    device_platform: String,
) -> Protected<serde_json::Value> {
    access
        .run(async {
            platform(&device_platform)?;
            companion_json(
                &state,
                &local,
                &access,
                &session_id,
                Ok(format!(
                    "lazysh-agent devices list --platform {device_platform}"
                )),
            )
            .await
        })
        .await
}
#[tauri::command]
pub async fn device_frame(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    device_platform: String,
    id: String,
) -> Protected<serde_json::Value> {
    access
        .run(async {
            platform(&device_platform)?;
            identifier(&id)?;
            companion_json(
                &state,
                &local,
                &access,
                &session_id,
                Ok(format!(
                    "lazysh-agent devices screenshot --platform {device_platform} --id={}",
                    quote(&id)
                )),
            )
            .await
        })
        .await
}
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum DeviceAction {
    Tap {
        x: u32,
        y: u32,
    },
    Swipe {
        x: u32,
        y: u32,
        to_x: u32,
        to_y: u32,
        duration_ms: u32,
    },
    Key {
        key: String,
    },
    Boot,
    Shutdown,
    Reboot,
}
fn action_command(device_platform: &str, id: &str, action: DeviceAction) -> Result<String> {
    platform(device_platform)?;
    identifier(id)?;
    let action = match action {
        DeviceAction::Tap { x, y } if x <= 32768 && y <= 32768 => format!("tap --x {x} --y {y}"),
        DeviceAction::Swipe {
            x,
            y,
            to_x,
            to_y,
            duration_ms,
        } if x <= 32768
            && y <= 32768
            && to_x <= 32768
            && to_y <= 32768
            && (1..=10000).contains(&duration_ms) =>
        {
            format!("swipe --x {x} --y {y} --to-x {to_x} --to-y {to_y} --duration-ms {duration_ms}")
        }
        DeviceAction::Key { key }
            if matches!(
                key.as_str(),
                "back" | "home" | "enter" | "menu" | "power" | "volume-up" | "volume-down"
            ) =>
        {
            format!("key --key {key}")
        }
        DeviceAction::Boot => "boot".into(),
        DeviceAction::Shutdown => "shutdown".into(),
        DeviceAction::Reboot => "reboot".into(),
        _ => return Err(SshError::new("invalid_input", "Invalid device action")),
    };
    Ok(format!(
        "lazysh-agent devices {action} --platform {device_platform} --id={}",
        quote(id)
    ))
}
#[tauri::command]
pub async fn device_action(
    access: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    device_platform: String,
    id: String,
    action: DeviceAction,
) -> Protected<serde_json::Value> {
    run_companion(
        &access,
        &state,
        &local,
        &session_id,
        action_command(&device_platform, &id, action),
    )
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_bound_coordinates_and_keep_device_identifiers_literal() {
        assert!(
            action_command("android", "id'$(cmd)", DeviceAction::Tap { x: 1, y: 2 })
                .unwrap()
                .ends_with("--id='id'\\''$(cmd)'")
        );
        assert!(action_command("android", "id", DeviceAction::Tap { x: u32::MAX, y: 2 }).is_err());
        assert!(action_command(
            "android",
            "id",
            DeviceAction::Key {
                key: "back;cmd".into()
            }
        )
        .is_err());
        assert!(action_command("ios;cmd", "id", DeviceAction::Boot).is_err());
    }
    #[test]
    fn accessibility_actions_carry_the_listed_identity_as_literal_arguments() {
        let node = UiNode {
            resource_id: "app:id/ok".into(),
            text: "It's $(cmd)\n--x".into(),
            content_description: String::new(),
            occurrence: 2,
        };
        assert_eq!(
            ui_action_command("emulator-5554", &node, "long-click").unwrap(),
            "lazysh-agent devices android --id='emulator-5554' ui act --kind long-click --resource-id='app:id/ok' --text='It'\\''s $(cmd)\n--x' --content-desc='' --occurrence 2"
        );
        assert!(ui_action_command("emulator-5554", &node, "click; reboot").is_err());
        let long = UiNode {
            text: "x".repeat(257),
            ..node
        };
        assert!(ui_action_command("emulator-5554", &long, "click").is_err());
    }
    #[test]
    fn android_video_gestures_carry_the_mapped_display_size_and_stay_inside_it() {
        let tap = DeviceAction::Tap { x: 540, y: 960 };
        assert_eq!(
            android_gesture_command("emulator-5554", 1080, 1920, &tap).unwrap(),
            "lazysh-agent devices android --id='emulator-5554' tap --x 540 --y 960 --width 1080 --height 1920"
        );
        let swipe = DeviceAction::Swipe {
            x: 1,
            y: 2,
            to_x: 3,
            to_y: 4,
            duration_ms: 250,
        };
        assert!(
            android_gesture_command("id'$(cmd)", 1080, 1920, &swipe)
                .unwrap()
                .contains("--id='id'\\''$(cmd)' swipe --x 1 --y 2 --to-x 3 --to-y 4 --duration-ms 250 --width 1080")
        );
        for rejected in [
            (DeviceAction::Tap { x: 1080, y: 0 }, 1080, 1920),
            (DeviceAction::Tap { x: 0, y: 1920 }, 1080, 1920),
            (DeviceAction::Tap { x: 0, y: 0 }, 0, 1920),
            (DeviceAction::Tap { x: 0, y: 0 }, 1080, 8193),
            (DeviceAction::Key { key: "home".into() }, 1080, 1920),
            (DeviceAction::Boot, 1080, 1920),
        ] {
            assert!(
                android_gesture_command("emulator-5554", rejected.1, rejected.2, &rejected.0)
                    .is_err()
            );
        }
    }
}
