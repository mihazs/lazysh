use tauri_plugin_lazysh_vault::{
    ui_locale::{UiLocaleChoice, UiLocaleStatus},
    VaultExt,
};

#[tauri::command]
pub async fn ui_locale_status(app: tauri::AppHandle) -> Result<UiLocaleStatus, String> {
    app.vault().ui_locale_status().await
}

#[tauri::command]
pub async fn ui_locale_set(
    app: tauri::AppHandle,
    choice: UiLocaleChoice,
    expected_revision: String,
) -> Result<UiLocaleStatus, String> {
    app.vault().ui_locale_set(choice, expected_revision).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn locked_locale_commands_do_not_expose_authentication_or_protected_reads() {
        for name in ["ui_locale_status", "ui_locale_set"] {
            assert!(crate::app_lock::allowed_while_locked(name));
        }
        for name in ["ui_locale_unlock", "credential_export", "write_input"] {
            assert!(!crate::app_lock::allowed_while_locked(name));
        }
    }
}
