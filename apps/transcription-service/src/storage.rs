use crate::{digest, secret, ApiError, Config, Device, Quota};
use axum::http::StatusCode;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::Path,
};
use zeroize::Zeroizing;

fn supported_host() -> Result<(), String> {
    if cfg!(unix) {
        Ok(())
    } else {
        Err(
            "Transcription relay requires a Unix host with verified private-file permissions"
                .into(),
        )
    }
}

fn private(metadata: &fs::Metadata, directory: bool) -> Result<(), String> {
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err("Require a private regular file or directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || (!directory && metadata.nlink() != 1)
        {
            return Err("Require private owner-only storage without hard links".into());
        }
    }
    Ok(())
}
fn file(path: &Path, create: bool) -> Result<File, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("Symlinks are not supported".into());
            }
            private(&metadata, false)?;
        }
        Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Cannot open private file".into()),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(create).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| "Cannot open private file")?;
    private(
        &file.metadata().map_err(|_| "Cannot inspect private file")?,
        false,
    )?;
    Ok(file)
}
pub fn read_secret(path: &Path) -> Result<Zeroizing<String>, String> {
    supported_host()?;
    let mut value = Zeroizing::new(String::new());
    file(path, false)?
        .take(1025)
        .read_to_string(&mut value)
        .map_err(|_| "Cannot read secret file")?;
    if value.len() > 1024 {
        return Err("Secret file is too large".into());
    }
    Ok(value)
}
pub(crate) struct Store {
    connection: Connection,
    _lock: File,
}
fn nonnegative(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
impl Store {
    pub fn open(config: &Config) -> Result<Self, String> {
        supported_host()?;
        let directory = &config.directory;
        if let Ok(metadata) = fs::symlink_metadata(directory) {
            if metadata.file_type().is_symlink() {
                return Err("Symlinks are not supported".into());
            }
            private(&metadata, true)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let absolute = if directory.is_absolute() {
                directory.clone()
            } else {
                std::env::current_dir()
                    .map_err(|_| "Cannot inspect storage directory")?
                    .join(directory)
            };
            for parent in absolute.ancestors().skip(1) {
                if let Ok(metadata) = fs::metadata(parent) {
                    if !metadata.is_dir()
                        || ![0, unsafe { libc::geteuid() }].contains(&metadata.uid())
                        || (metadata.mode() & 0o022 != 0 && metadata.mode() & libc::S_ISVTX == 0)
                    {
                        return Err("Unsafe storage directory ancestor".into());
                    }
                }
            }
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(directory)
            .map_err(|_| "Cannot create private storage")?;
        private(
            &fs::symlink_metadata(directory).map_err(|_| "Cannot inspect private storage")?,
            true,
        )?;
        let lock = file(&directory.join(".lock"), true)?;
        lock.try_lock()
            .map_err(|_| "Another service owns this directory")?;
        let path = directory.join("quota.sqlite3");
        drop(file(&path, true)?);
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| "Cannot open quota storage")?;
        connection
            .busy_timeout(std::time::Duration::from_secs(1))
            .map_err(|_| "Cannot configure quota storage")?;
        connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash BLOB UNIQUE NOT NULL, label TEXT NOT NULL, day INTEGER NOT NULL, used INTEGER NOT NULL CHECK(used>=0));
            CREATE TABLE IF NOT EXISTS total (singleton INTEGER PRIMARY KEY CHECK(singleton=1), day INTEGER NOT NULL, used INTEGER NOT NULL CHECK(used>=0));")
            .map_err(|_| "Cannot initialize quota storage")?;
        Ok(Self {
            connection,
            _lock: lock,
        })
    }
    pub fn enroll(&mut self, label: &str) -> Result<(Device, String), ApiError> {
        let count: u32 = self
            .connection
            .query_row("SELECT count(*) FROM devices", [], |row| row.get(0))?;
        if count >= 128 {
            return Err(ApiError(StatusCode::CONFLICT, "device_limit"));
        }
        let id = secret();
        let token = secret();
        self.connection.execute(
            "INSERT INTO devices VALUES(?1,?2,?3,0,0)",
            params![id, digest(&token).to_vec(), label],
        )?;
        Ok((
            Device {
                id,
                label: label.into(),
            },
            token,
        ))
    }
    pub fn devices(&self) -> Result<Vec<Device>, ApiError> {
        let mut query = self
            .connection
            .prepare("SELECT id,label FROM devices ORDER BY id LIMIT 129")?;
        let rows = query.query_map([], |row| {
            Ok(Device {
                id: row.get(0)?,
                label: row.get(1)?,
            })
        })?;
        let devices = rows.collect::<Result<Vec<_>, _>>()?;
        if devices.len() > 128 {
            return Err(ApiError::storage());
        }
        Ok(devices)
    }
    pub fn authenticate(&self, token: &str) -> Result<Option<String>, ApiError> {
        Ok(self
            .connection
            .query_row(
                "SELECT id FROM devices WHERE token_hash=?",
                [digest(token).to_vec()],
                |row| row.get(0),
            )
            .optional()?)
    }
    pub fn revoke(&mut self, id: &str) -> Result<(), ApiError> {
        self.connection
            .execute("DELETE FROM devices WHERE id=?", [id])?;
        Ok(())
    }
    pub fn quota(
        &mut self,
        id: &str,
        day: u64,
        debit: u64,
        device_limit: u64,
        global_limit: u64,
    ) -> Result<Quota, ApiError> {
        if day > (i64::MAX as u64 / 86400) - 1 {
            return Err(ApiError::storage());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((saved_day, saved_used)) = transaction
            .query_row("SELECT day,used FROM devices WHERE id=?", [id], |row| {
                Ok((nonnegative(row, 0)?, nonnegative(row, 1)?))
            })
            .optional()?
        else {
            return Err(ApiError::unauthorized());
        };
        let (global_day, global_used) = transaction
            .query_row("SELECT day,used FROM total WHERE singleton=1", [], |row| {
                Ok((nonnegative(row, 0)?, nonnegative(row, 1)?))
            })
            .optional()?
            .unwrap_or((0, 0));
        if day < saved_day || day < global_day {
            return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "clock_rollback"));
        }
        let used = if day == saved_day { saved_used } else { 0 };
        let global = if day == global_day { global_used } else { 0 };
        if debit > device_limit.saturating_sub(used) || debit > global_limit.saturating_sub(global)
        {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "quota_exceeded"));
        }
        if debit > 0 {
            transaction.execute(
                "UPDATE devices SET day=?1,used=?2 WHERE id=?3",
                params![day as i64, (used + debit) as i64, id],
            )?;
            transaction.execute("INSERT INTO total VALUES(1,?1,?2) ON CONFLICT(singleton) DO UPDATE SET day=excluded.day,used=excluded.used",params![day as i64,(global+debit) as i64])?;
        }
        transaction.commit()?;
        Ok(Quota {
            window_start: day * 86400,
            window_end: (day + 1) * 86400,
            device_limit_samples: device_limit,
            device_used_samples: used + debit,
            device_remaining_samples: device_limit.saturating_sub(used + debit),
            global_limit_samples: global_limit,
            global_used_samples: global + debit,
            global_remaining_samples: global_limit.saturating_sub(global + debit),
        })
    }
}
