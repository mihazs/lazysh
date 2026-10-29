pub fn path() -> std::path::PathBuf {
    match std::env::var_os("LAZYSH_TEST_COMPANION_BINARY") {
        Some(value) => {
            let path = std::path::PathBuf::from(value);
            assert!(
                path.is_absolute(),
                "Companion acceptance needs an explicit absolute executable"
            );
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            assert!(metadata.is_file() && !metadata.file_type().is_symlink());
            path
        }
        None => env!("CARGO_BIN_EXE_lazysh-agent").into(),
    }
}
