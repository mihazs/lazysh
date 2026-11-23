//! Opens an existing SQLite store so that reading it can never create, change or delete one of its files.
//!
//! SQLite's own read-only mode still creates a missing WAL index (`-shm`), opens the log read-write and
//! deletes the log of an empty database. This module registers a VFS that wraps the default one and
//! (1) opens every file read-only without creating it, (2) refuses every delete, and the connection
//! asks for a read-only index (`readonly_shm=1`), so SQLite maps the existing `-shm` read-only and
//! reads the log through it. A file that is missing or removed concurrently makes the open fail, which
//! the caller reports as not checked.
//!
//! shortcut: the index is mapped read-only only when no connection of this same process holds it
//! writable (SQLite shares one mapping per file and process); the status command opens no writer.
use rusqlite::{ffi, Connection, OpenFlags};
use std::{
    ffi::{c_char, c_int, CStr},
    io,
    path::Path,
    ptr,
    sync::OnceLock,
};

const NAME: &CStr = c"lazysh-readonly";

/// Passes the open to the default VFS with every right to write or create removed.
unsafe extern "C" fn open(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    let base = (*vfs).pAppData.cast::<ffi::sqlite3_vfs>();
    let denied = ffi::SQLITE_OPEN_READWRITE
        | ffi::SQLITE_OPEN_CREATE
        | ffi::SQLITE_OPEN_EXCLUSIVE
        | ffi::SQLITE_OPEN_DELETEONCLOSE;
    match (*base).xOpen {
        Some(open) => open(
            base,
            name,
            file,
            (flags & !denied) | ffi::SQLITE_OPEN_READONLY,
            out_flags,
        ),
        None => ffi::SQLITE_CANTOPEN,
    }
}

unsafe extern "C" fn delete(_: *mut ffi::sqlite3_vfs, _: *const c_char, _: c_int) -> c_int {
    ffi::SQLITE_READONLY
}

fn register() -> io::Result<()> {
    static REGISTERED: OnceLock<bool> = OnceLock::new();
    let registered = *REGISTERED.get_or_init(|| unsafe {
        let base = ffi::sqlite3_vfs_find(ptr::null());
        if base.is_null() {
            return false;
        }
        let mut wrapper = Box::new(*base);
        wrapper.zName = NAME.as_ptr();
        wrapper.pAppData = base.cast();
        wrapper.pNext = ptr::null_mut();
        wrapper.xOpen = Some(open);
        wrapper.xDelete = Some(delete);
        // Registered for the life of the process, never freed.
        ffi::sqlite3_vfs_register(Box::into_raw(wrapper), 0) == ffi::SQLITE_OK
    });
    registered
        .then_some(())
        .ok_or_else(|| io::Error::other("SQLite has no default file system"))
}

fn uri(path: &Path) -> io::Result<String> {
    let path = path
        .to_str()
        .filter(|path| path.starts_with('/'))
        .ok_or_else(|| io::Error::other("Unsupported store path"))?;
    let mut uri = String::from("file:");
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                uri.push(byte as char)
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri.push_str("?readonly_shm=1");
    Ok(uri)
}

/// Opens `path` read-only through the read-only VFS. Fails instead of creating or repairing anything.
pub(super) fn open_store(path: &Path) -> rusqlite::Result<Connection> {
    let to_sqlite = |error: io::Error| rusqlite::Error::ToSqlConversionFailure(Box::new(error));
    register().map_err(to_sqlite)?;
    let connection = Connection::open_with_flags_and_vfs(
        uri(path).map_err(to_sqlite)?,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_URI,
        "lazysh-readonly",
    )?;
    // Same as the store itself: closing must never checkpoint or remove another process's log.
    connection.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )?;
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, fs};

    /// Every file of the directory with its bytes and modification time.
    fn snapshot(directory: &Path) -> BTreeMap<String, (Vec<u8>, std::time::SystemTime)> {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let path = entry.path();
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    (
                        fs::read(&path).unwrap(),
                        fs::metadata(&path).unwrap().modified().unwrap(),
                    ),
                )
            })
            .collect()
    }

    /// A store at rest as the companion leaves it: rows only in the log, the log and its index kept.
    fn store(directory: &Path) -> std::path::PathBuf {
        let path = directory.join("events.sqlite3");
        let writer = Connection::open(&path).unwrap();
        writer.pragma_update(None, "journal_mode", "wal").unwrap();
        writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        writer
            .set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
                true,
            )
            .unwrap();
        writer.execute_batch("CREATE TABLE sessions(agent TEXT, updated_at REAL); INSERT INTO sessions VALUES('Codex', 7.5);").unwrap();
        drop(writer);
        assert!(
            directory.join("events.sqlite3-wal").is_file()
                && directory.join("events.sqlite3-shm").is_file()
        );
        path
    }

    fn newest(path: &Path) -> rusqlite::Result<Option<f64>> {
        open_store(path)?.query_row("SELECT MAX(updated_at) FROM sessions", [], |row| row.get(0))
    }

    #[test]
    fn reads_the_log_of_a_store_at_rest_and_leaves_every_file_byte_and_time_identical() {
        let directory = lazysh_common::test_support::private_tempdir();
        let path = store(directory.path());
        let before = snapshot(directory.path());
        assert_eq!(newest(&path).unwrap(), Some(7.5));
        assert_eq!(snapshot(directory.path()), before);
    }

    /// Removes one sidecar of a store at rest, reads it, and returns whether the read worked; no file may change or appear.
    fn read_without_sidecar(sidecar: &str) -> bool {
        let directory = lazysh_common::test_support::private_tempdir();
        let path = store(directory.path());
        fs::remove_file(directory.path().join(sidecar)).unwrap();
        let before = snapshot(directory.path());
        let read = newest(&path).is_ok();
        assert_eq!(snapshot(directory.path()), before);
        read
    }

    #[test]
    fn a_removed_index_is_an_error_and_is_never_created_again() {
        assert!(!read_without_sidecar("events.sqlite3-shm"));
    }

    #[test]
    fn a_removed_log_is_never_created_again() {
        read_without_sidecar("events.sqlite3-wal");
    }

    #[test]
    fn the_log_of_an_empty_database_is_kept() {
        let directory = lazysh_common::test_support::private_tempdir();
        let path = directory.path().join("events.sqlite3");
        fs::write(&path, b"").unwrap();
        fs::write(directory.path().join("events.sqlite3-wal"), b"sentinel").unwrap();
        let before = snapshot(directory.path());
        assert!(newest(&path).is_err());
        assert_eq!(snapshot(directory.path()), before);
    }

    #[test]
    fn a_path_with_uri_characters_is_read_as_itself() {
        let directory = lazysh_common::test_support::private_tempdir();
        let odd = directory.path().join("a b?c#d%e");
        fs::create_dir(&odd).unwrap();
        let path = store(&odd);
        assert_eq!(newest(&path).unwrap(), Some(7.5));
    }
}
