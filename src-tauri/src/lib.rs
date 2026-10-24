mod sftp_stream;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            let state = ssh::AppState::new(app.path().app_config_dir()?)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            ssh::agent_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("failed to start lazysh");
}
