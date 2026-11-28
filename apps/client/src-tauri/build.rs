/// The build-time kill switch of the native terminal engine (`vite.config.ts` reads the same variable): `off` leaves the real core
/// out of the app (`native_terminal_disabled`); otherwise the `native-terminal` feature builds it (`native_terminal_core`).
fn native_terminal_cfg() {
    println!("cargo:rerun-if-env-changed=LAZYSH_NATIVE_TERMINAL");
    println!("cargo:rustc-check-cfg=cfg(native_terminal_core, native_terminal_disabled)");
    match std::env::var("LAZYSH_NATIVE_TERMINAL")
        .unwrap_or_default()
        .as_str()
    {
        "off" => println!("cargo:rustc-cfg=native_terminal_disabled"),
        "" | "on" => {
            if std::env::var_os("CARGO_FEATURE_NATIVE_TERMINAL").is_some() {
                println!("cargo:rustc-cfg=native_terminal_core");
            }
        }
        other => panic!("LAZYSH_NATIVE_TERMINAL must be \"on\" or \"off\", not \"{other}\""),
    }
}

fn main() {
    native_terminal_cfg();
    // Parakeet runs on Linux and Windows x86_64 and, when the Google Android build opts in, on Android arm64/x86_64.
    println!("cargo:rustc-check-cfg=cfg(parakeet_local)");
    let (os, arch) = (
        std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default(),
        std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default(),
    );
    let desktop = matches!(os.as_str(), "linux" | "windows") && arch == "x86_64";
    let android = os == "android"
        && matches!(arch.as_str(), "aarch64" | "x86_64")
        && std::env::var_os("CARGO_FEATURE_PARAKEET_ANDROID").is_some();
    // The lightweight development build (no `local-voice`) compiles no Parakeet runtime.
    if std::env::var_os("CARGO_FEATURE_LOCAL_VOICE").is_some() && (desktop || android) {
        println!("cargo:rustc-cfg=parakeet_local");
    }
    if os == "android"
        && arch == "aarch64"
        && std::env::var_os("CARGO_FEATURE_PARAKEET_ANDROID").is_some()
    {
        println!("cargo:rustc-link-arg=-Wl,--wrap=cpuinfo_initialize");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")
        && (std::env::var_os("CARGO_FEATURE_PARAKEET_ACCEPTANCE").is_some()
            || std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64"))
    {
        // ORT embeds protobuf; Mosh links the system protobuf-lite DSO.
        // Do not let the private static copy preempt that DSO's globals.
        println!("cargo:rustc-link-arg=-Wl,--exclude-libs,libonnxruntime.a");
    }
    let app = tauri_build::AppManifest::new().commands(&[
        "clipboard_read",
        "clipboard_cancel",
        "clipboard_is_android",
        "board_keep_awake_status",
        "board_keep_awake_acquire",
        "board_keep_awake_release",
        "app_lock_status",
        "ui_locale_status",
        "ui_locale_set",
        "app_lock_configure",
        "app_lock_ready",
        "theme_link_status",
        "theme_link_read",
        "theme_link_ack",
        "theme_qr_decode",
        "local_capability",
        "desktop_launch_read",
        "desktop_launch_ack",
        "desktop_launch_prepare_host",
        "desktop_launch_cancel",
        "local_connect",
        "local_write",
        "local_resize",
        "local_ack",
        "terminal_core_open",
        "terminal_core_input",
        "terminal_core_text",
        "terminal_core_ansi_snapshot",
        "terminal_core_release",
        "terminal_core_snapshot",
        "terminal_core_scroll",
        "terminal_core_resize",
        "terminal_core_set_active",
        "terminal_core_theme",
        "terminal_core_scrollback",
        "terminal_core_selection_text",
        "terminal_core_search",
        "terminal_core_word_at",
        "terminal_core_link_at",
        "native_terminal_font_import",
        "native_terminal_font_forget",
        "terminal_core_line_at",
        "terminal_core_buffer_range",
        "terminal_core_copy_screen",
        "terminal_core_select",
        "terminal_core_close",
        "terminal_core_available",
        "native_terminal_probe",
        "local_disconnect",
        "app_icon_status",
        "set_app_icon",
        "terminal_private_keyboard",
        "soft_keyboard",
        "screen_reader_active",
        "apple_status_capability",
        "apple_status_configure",
        "apple_status_publish",
        "push_registration_status",
        "push_registration_register",
        "push_registration_enroll",
        "push_registration_disable",
        "push_registration_display",
        "apple_speech_capability",
        "apple_speech_install",
        "apple_speech_remove",
        "apple_speech_transcribe",
        "apple_speech_cancel",
        "share_status",
        "share_thumbnail",
        "share_thumbnail_cancel",
        "share_configure",
        "share_forget",
        "share_list",
        "share_delete",
        "share_upload_begin",
        "share_upload_chunk",
        "share_upload_finish",
        "share_upload_cancel",
        "transport_capabilities",
        "connect_mosh",
        "connect_et",
        "open_web_url",
        "inspect_auth_url",
        "open_auth_url",
        "start_auth_tunnel",
        "stop_auth_tunnel",
        "list_auth_tunnels",
        "list_devices",
        "device_frame",
        "device_action",
        "ios_device_probe",
        "android_device_probe",
        "android_ui_tree",
        "android_ui_action",
        "android_device_action",
        "ios_device_action",
        "device_stream_start",
        "device_stream_next",
        "device_stream_stop",
        "host_browser_start",
        "host_browser_next",
        "host_browser_ack",
        "host_browser_pause",
        "host_browser_resume",
        "host_browser_stop",
        "sync_status",
        "sync_configure",
        "sync_recovery_key",
        "sync_forget",
        "sync_push",
        "sync_preview",
        "sync_apply",
        "agent_approvals",
        "resolve_agent_approval",
        "opencode_service_list",
        "opencode_service_reply",
        "opencode_service_abort",
        "notify_agent_attention",
        "remote_notifications_status",
        "remote_notifications_configure",
        "remote_notifications_pause",
        "remote_notifications_resume",
        "remote_notifications_forget",
        "notification_test",
        "edge_gesture_exclusion",
        "edge_gesture_insets",
        "android_default_back",
        "native_terminal_surface_place",
        "native_terminal_surface_look",
        "native_terminal_surface_cell",
        "native_terminal_surface_remove",
        "native_terminal_surface_state",
        "native_terminal_surface_input",
        "native_terminal_surface_focus",
        "open_notification_settings",
        "request_notification_permission",
        "voice_models",
        "voice_model_catalog",
        "voice_download_model",
        "voice_download_cancel",
        "voice_import_begin",
        "voice_import_chunk",
        "voice_import_finish",
        "voice_remove_model",
        "voice_transcribe",
        "voice_cancel",
        "voice_parakeet_status",
        "voice_parakeet_install",
        "voice_parakeet_remove",
        "voice_parakeet_transcribe",
        "voice_parakeet_cancel",
        "voice_cloud_status",
        "voice_cloud_enroll",
        "voice_cloud_refresh",
        "voice_cloud_forget",
        "voice_cloud_begin",
        "voice_cloud_transcribe",
        "voice_cloud_cancel",
        "generate_identity",
        "inspect_identity",
        "has_credentials",
        "credential_protection",
        "cancel_credential_auth",
        "export_saved_identity",
        "forget_credentials",
        "repository_status",
        "repository_history",
        "repository_tree",
        "repository_blob",
        "repository_image",
        "file_media",
        "media_playback",
        "repository_diff",
        "multiplexer_tree",
        "multiplexer_history",
        "tmux_jump_snapshot",
        "tmux_jump",
        "tmux_chat",
        "herdr_backend_select",
        "herdr_chat",
        "herdr_agent_input",
        "herdr_agent_screen",
        "zellij_agent_input",
        "zellij_agent_screen",
        "herdr_tree",
        "agent_herdr_conversation",
        "agent_watch_start",
        "agent_watch_stop",
        "herdr_action",
        "herdr_workspace_plan",
        "herdr_workspace_create",
        "multiplexer_launch_plan",
        "multiplexer_launch",
        "herdr_agent_kinds",
        "herdr_repository",
        "zellij_action",
        "zellij_tabs",
        "zellij_panes",
        "zellij_jump_tabs",
        "multiplexer_sessions",
        "attach_multiplexer",
        "tmux_action",
        "start_preview",
        "stop_preview",
        "list_previews",
        "discover_preview_ports",
        "check_auth_listener",
        "list_hosts",
        "save_host",
        "delete_host",
        "trust_host_key",
        "connect",
        "restore_file_transfer",
        "restore_host_tools",
        "adopt_session",
        "write_stdin",
        "ack_output",
        "resize",
        "disconnect",
        "probe_connections",
        "list_directory",
        "host_home",
        "host_file_stat",
        "host_file_download",
        "host_file_cancel",
        "host_file_deliver",
        "read_file",
        "upload_reserve",
        "upload_cancel",
        "upload_file",
        "host_clipboard_copy",
        "get_diff",
        "list_multiplexer_sessions",
        "attach_tmux",
        "agent_snapshot",
        "agent_reported_history",
        "agent_relay_resolve",
        "install_companion",
        "install_companion_from_device",
        "check_companion_update",
        "install_managed_herdr",
        "remove_managed_herdr",
        "companion_version",
        "companion_hooks",
        "companion_hook_discovery",
        "get_companion_settings",
        "update_companion_settings",
        "get_host_browser_settings",
        "update_host_browser_settings",
        "get_notification_policy",
        "update_notification_policy",
        "get_host_features",
        "update_host_features",
        "host_browser_clear_data",
        "agent_transcript",
        "agent_usage",
        "account_usage",
        "usage_collector_status",
        "agent_transcripts",
        "agent_history",
    ]);
    let mut attributes = tauri_build::Attributes::new().app_manifest(app);
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri's resource compiler links its manifest only into the app binary.
        // The lib unit-test executable also imports Common Controls v6 APIs.
        // Use the same manifest for every MSVC link target, without duplicate
        // RT_MANIFEST resources: https://github.com/tauri-apps/tauri/issues/13419.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("missing Cargo manifest directory"),
        )
        .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("failed to build lazysh permissions");
}
