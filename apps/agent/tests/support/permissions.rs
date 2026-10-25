pub fn assert_state_modes(directory: &std::path::Path, directory_mode: u32, database_mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    for (path, mode) in [
        (directory.to_owned(), directory_mode),
        (directory.join("events.sqlite3"), database_mode),
    ] {
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
}
