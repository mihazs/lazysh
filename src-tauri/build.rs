fn main() {
    let app = tauri_build::AppManifest::new().commands(&[
        "list_hosts",
        "save_host",
        "delete_host",
        "trust_host_key",
        "connect",
        "write_stdin",
        "ack_output",
        "resize",
        "disconnect",
        "list_directory",
        "read_file",
        "upload_file",
        "get_diff",
        "list_multiplexer_sessions",
        "attach_tmux",
        "agent_snapshot",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app))
        .expect("failed to build lazysh permissions");
}
