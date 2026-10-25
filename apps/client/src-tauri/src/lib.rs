mod apple_speech;
mod approvals;
mod devices;
mod et;
mod forward_agent;
mod herdr;
mod identities;
mod links;
mod mosh;
mod multiplexer;
mod notifications;
mod previews;
mod repository;
mod routing;
mod sftp_stream;
mod share;
mod ssh;
mod sync;
mod vault;
mod voice;
mod zellij;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_lazysh_apple_speech::init())
        .plugin(
            tauri_plugin_opener::Builder::default()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_lazysh_vault::init())
        .manage(previews::PreviewState::default())
        .manage(share::ShareState::default())
        .manage(sync::SyncState::default())
        .setup(|app| {
            use tauri::Manager;
            let state = ssh::AppState::new(app.path().app_config_dir()?)?;
            app.manage(state);
            app.manage(voice::VoiceState::new(
                app.path().app_data_dir()?.join("voice-models"),
            )?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            apple_speech::apple_speech_capability,
            apple_speech::apple_speech_install,
            apple_speech::apple_speech_remove,
            apple_speech::apple_speech_transcribe,
            apple_speech::apple_speech_cancel,
            share::share_status,
            share::share_configure,
            share::share_forget,
            share::share_list,
            share::share_delete,
            share::share_upload_begin,
            share::share_upload_chunk,
            share::share_upload_finish,
            share::share_upload_cancel,
            mosh::transport_capabilities,
            ssh::connect_mosh,
            et::connect_et,
            links::open_web_url,
            devices::list_devices,
            devices::device_frame,
            devices::device_action,
            sync::sync_status,
            sync::sync_configure,
            sync::sync_recovery_key,
            sync::sync_forget,
            sync::sync_push,
            sync::sync_preview,
            sync::sync_apply,
            approvals::agent_approvals,
            approvals::resolve_agent_approval,
            notifications::notify_agent_attention,
            notifications::notification_test,
            voice::voice_models,
            voice::voice_import_begin,
            voice::voice_import_chunk,
            voice::voice_import_finish,
            voice::voice_remove_model,
            voice::voice_transcribe,
            voice::voice_cancel,
            identities::generate_identity,
            identities::inspect_identity,
            vault::has_credentials,
            vault::credential_protection,
            vault::cancel_credential_auth,
            vault::export_saved_identity,
            vault::forget_credentials,
            repository::repository_status,
            repository::repository_history,
            repository::repository_tree,
            repository::repository_blob,
            repository::repository_image,
            repository::repository_diff,
            multiplexer::multiplexer_tree,
            herdr::herdr_tree,
            herdr::herdr_action,
            zellij::zellij_action,
            multiplexer::multiplexer_sessions,
            multiplexer::tmux_action,
            ssh::attach_multiplexer,
            previews::start_preview,
            previews::stop_preview,
            previews::list_previews,
            previews::discover_preview_ports,
            ssh::list_hosts,
            ssh::save_host,
            ssh::delete_host,
            ssh::trust_host_key,
            ssh::connect,
            ssh::write_stdin,
            ssh::ack_output,
            ssh::resize,
            ssh::disconnect,
            ssh::list_directory,
            ssh::read_file,
            ssh::upload_file,
            ssh::get_diff,
            ssh::list_multiplexer_sessions,
            ssh::attach_tmux,
            ssh::agent_snapshot,
            ssh::agent_transcript,
            ssh::agent_usage,
            ssh::agent_transcripts
        ])
        .run(tauri::generate_context!())
        .expect("failed to start lazysh");
}
