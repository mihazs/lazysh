use crate::app_lock::{AccessLease, Guarded, GuardedError};
type Protected<T> = std::result::Result<Guarded<T>, GuardedError<crate::ssh::SshError>>;
use crate::companion::exec as exec_for_access;
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
async fn remote_json(
    state: &AppState,
    access: &AccessLease,
    session_id: &str,
    command: Result<String>,
) -> Result<serde_json::Value> {
    let command = command?;
    let session = state.session(session_id).await?;
    access.check()?;
    Ok(serde_json::from_str(
        &exec_for_access(&session, command, access).await?,
    )?)
}

#[tauri::command]
pub async fn android_device_probe(
    access: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    id: String,
) -> Protected<serde_json::Value> {
    access
        .run(remote_json(
            &state,
            &access,
            &session_id,
            android_command(&id, "probe"),
        ))
        .await
}
#[tauri::command]
pub async fn ios_device_probe(
    access: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    id: String,
    socket: String,
) -> Protected<serde_json::Value> {
    access
        .run(remote_json(
            &state,
            &access,
            &session_id,
            companion_command(&id, &socket, "probe"),
        ))
        .await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Native-injected lease plus the existing typed IPC fields.
pub async fn ios_device_action(
    access: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    id: String,
    socket: String,
    width: u32,
    height: u32,
    action: DeviceAction,
) -> Protected<serde_json::Value> {
    access.run(async {
    let (subcommand,arguments)=match action {
        DeviceAction::Tap{x,y} if x<width && y<height => ("tap",format!("--x {x} --y {y} --width {width} --height {height}")),
        DeviceAction::Swipe{x,y,to_x,to_y,duration_ms} if x<width && y<height && to_x<width && to_y<height && (1..=10000).contains(&duration_ms)=>("swipe",format!("--x {x} --y {y} --to-x {to_x} --to-y {to_y} --duration-ms {duration_ms} --width {width} --height {height}")),
        DeviceAction::Key{key} if matches!(key.as_str(),"home"|"power"|"volume-up"|"volume-down")=>("button",format!("--key {key}")),
        _=>return Err(SshError::new("invalid_input","Unsupported iOS companion action")),
    };
    if !(1..=8192).contains(&width) || !(1..=8192).contains(&height) {
        return Err(SshError::new(
            "invalid_input",
            "Invalid iOS point dimensions",
        ));
    }
    let command = companion_command(&id, &socket, &format!("{subcommand} {arguments}"))?;
    let session = state.session(&session_id).await?;
            access.check()?;
    Ok(serde_json::from_str(&exec_for_access(&session, command, &access).await?)?)

    }).await
}
#[tauri::command]
pub async fn list_devices(
    access: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    device_platform: String,
) -> Protected<serde_json::Value> {
    access
        .run(async {
            platform(&device_platform)?;
            let session = state.session(&session_id).await?;
            access.check()?;
            Ok(serde_json::from_str(
                &exec_for_access(
                    &session,
                    format!("lazysh-agent devices list --platform {device_platform}"),
                    &access,
                )
                .await?,
            )?)
        })
        .await
}
#[tauri::command]
pub async fn device_frame(
    access: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    device_platform: String,
    id: String,
) -> Protected<serde_json::Value> {
    access
        .run(async {
            platform(&device_platform)?;
            identifier(&id)?;
            let session = state.session(&session_id).await?;
            access.check()?;
            Ok(serde_json::from_str(
                &exec_for_access(
                    &session,
                    format!(
                        "lazysh-agent devices screenshot --platform {device_platform} --id={}",
                        quote(&id)
                    ),
                    &access,
                )
                .await?,
            )?)
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
    session_id: String,
    device_platform: String,
    id: String,
    action: DeviceAction,
) -> Protected<serde_json::Value> {
    access
        .run(remote_json(
            &state,
            &access,
            &session_id,
            action_command(&device_platform, &id, action),
        ))
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
}
