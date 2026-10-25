use crate::ssh::{exec, quote, AppState, Result, SshError};
use tauri::State;

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
#[tauri::command]
pub async fn list_devices(
    state: State<'_, AppState>,
    session_id: String,
    device_platform: String,
) -> Result<serde_json::Value> {
    platform(&device_platform)?;
    let session = state.session(&session_id).await?;
    Ok(serde_json::from_str(
        &exec(
            &session,
            format!("lazysh-agent devices list --platform {device_platform}"),
        )
        .await?,
    )?)
}
#[tauri::command]
pub async fn device_frame(
    state: State<'_, AppState>,
    session_id: String,
    device_platform: String,
    id: String,
) -> Result<serde_json::Value> {
    platform(&device_platform)?;
    identifier(&id)?;
    let session = state.session(&session_id).await?;
    Ok(serde_json::from_str(
        &exec(
            &session,
            format!(
                "lazysh-agent devices screenshot --platform {device_platform} --id={}",
                quote(&id)
            ),
        )
        .await?,
    )?)
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
    state: State<'_, AppState>,
    session_id: String,
    device_platform: String,
    id: String,
    action: DeviceAction,
) -> Result<serde_json::Value> {
    let command = action_command(&device_platform, &id, action)?;
    let session = state.session(&session_id).await?;
    Ok(serde_json::from_str(&exec(&session, command).await?)?)
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
