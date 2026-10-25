use crate::{Config, Share, MAX_TTL, MAX_UPLOAD};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub(crate) enum Error {
    Io(io::Error),
    Sql(rusqlite::Error),
    Full,
    NotFound,
    Invalid,
}
lazysh_common::impl_from_error!(Error, Io, io::Error);
lazysh_common::impl_from_error!(Error, Sql, rusqlite::Error);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::Sql(e) => write!(f, "{e}"),
            Self::Full => f.write_str("share storage is full"),
            Self::NotFound => f.write_str("share not found"),
            Self::Invalid => f.write_str("invalid share storage"),
        }
    }
}
impl std::error::Error for Error {}
pub(crate) type Result<T> = std::result::Result<T, Error>;

fn validate_metadata(metadata: &fs::Metadata, directory: bool) -> Result<()> {
    if metadata.file_type().is_symlink()
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err(Error::Invalid);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(Error::Invalid);
        }
    }
    Ok(())
}
fn private_directory(path: &Path) -> Result<()> {
    lazysh_common::fs::private_directory(path)?;
    let metadata = fs::symlink_metadata(path)?;
    validate_metadata(&metadata, true)?;
    Ok(())
}
fn private_file(path: &Path, create: bool) -> Result<File> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        validate_metadata(&metadata, false)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(create);
    if create {
        options.create(true).truncate(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    Ok(options.open(path)?)
}

pub(crate) struct Store {
    connection: Connection,
    directory: PathBuf,
    _lock: File,
    max_storage: u64,
    max_files: u32,
}
impl Store {
    pub(crate) fn open(config: &Config) -> Result<Self> {
        private_directory(&config.directory)?;
        let lock = private_file(&config.directory.join(".lock"), true)?;
        lock.try_lock().map_err(|_| Error::Invalid)?;
        let directory = config.directory.join("objects");
        private_directory(&directory)?;
        let database = config.directory.join("shares.sqlite3");
        drop(private_file(&database, true)?);
        let connection = Connection::open(&database)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(&format!("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=64), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0 AND size<={MAX_UPLOAD}), created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<={MAX_TTL})); CREATE INDEX IF NOT EXISTS shares_expiry ON shares(expires_at);"))?;
        let mut store = Self {
            connection,
            directory,
            _lock: lock,
            max_storage: config.max_storage,
            max_files: config.max_files,
        };
        store.cleanup(crate::now())?;
        let mut entries = 0;
        for entry in fs::read_dir(&store.directory)? {
            entries += 1;
            if entries > config.max_files as usize + 64 {
                return Err(Error::Invalid);
            }
            let entry = entry?;
            let name = entry.file_name();
            let Some(id) = name.to_str().and_then(|name| name.strip_prefix("blob-")) else {
                continue;
            };
            if !crate::valid_id(id) {
                continue;
            }
            if !store
                .connection
                .query_row("SELECT 1 FROM shares WHERE id=?", [id], |_| Ok(()))
                .optional()?
                .is_some()
            {
                if !entry.file_type()?.is_file() {
                    return Err(Error::Invalid);
                }
                fs::remove_file(entry.path())?;
            }
        }
        Ok(store)
    }
    fn blob_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("blob-{id}"))
    }
    pub(crate) fn create(
        &mut self,
        name: String,
        mime: String,
        bytes: &[u8],
        ttl: u64,
        now: u64,
        origin: &str,
    ) -> Result<Share> {
        let expires = now
            .checked_add(ttl)
            .filter(|time| *time <= i64::MAX as u64)
            .ok_or(Error::Invalid)?;
        if bytes.len() > MAX_UPLOAD || !(60..=MAX_TTL).contains(&ttl) || !crate::valid_name(&name) {
            return Err(Error::Invalid);
        }
        self.cleanup(now)?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (count, size): (u32, i64) = transaction.query_row(
            "SELECT count(*),coalesce(sum(size),0) FROM shares",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if size < 0
            || count >= self.max_files
            || (size as u64).saturating_add(bytes.len() as u64) > self.max_storage
        {
            return Err(Error::Full);
        }
        let id = crate::random_secret();
        let path = self.directory.join(format!("blob-{id}"));
        let mut options = lazysh_common::fs::private_create_new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut created = false;
        let result = (|| -> Result<Share> {
            let mut file = options.open(&path)?;
            created = true;
            file.write_all(bytes)?;
            file.sync_all()?;
            let share = Share {
                id,
                name,
                mime,
                size: bytes.len() as u64,
                created_at: now,
                expires_at: expires,
                url: String::new(),
            };
            transaction.execute(
                "INSERT INTO shares(id,name,mime,size,created_at,expires_at) VALUES(?,?,?,?,?,?)",
                params![
                    share.id,
                    share.name,
                    share.mime,
                    share.size as i64,
                    share.created_at as i64,
                    share.expires_at as i64
                ],
            )?;
            transaction.commit()?;
            Ok(share.with_origin(origin))
        })();
        if result.is_err() && created {
            let _ = fs::remove_file(path);
        }
        result
    }
    pub(crate) fn history(
        &self,
        cursor: Option<(u64, String)>,
        limit: usize,
        now: u64,
        origin: &str,
    ) -> Result<Vec<Share>> {
        let (before_time, before_id) = cursor.unwrap_or((i64::MAX as u64, "z".to_owned()));
        let mut statement = self.connection.prepare("SELECT id,name,mime,size,created_at,expires_at FROM shares WHERE expires_at>? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?")?;
        let rows = statement.query_map(
            params![
                now.min(i64::MAX as u64) as i64,
                before_time as i64,
                before_time as i64,
                before_id,
                limit as u32
            ],
            share_from_row,
        )?;
        rows.map(|row| {
            row.map(|share| share.with_origin(origin))
                .map_err(Error::from)
        })
        .collect()
    }
    pub(crate) fn download(&self, id: &str, now: u64) -> Result<(Share, File)> {
        let share = self.connection.query_row("SELECT id,name,mime,size,created_at,expires_at FROM shares WHERE id=? AND expires_at>?", params![id, now.min(i64::MAX as u64) as i64], share_from_row).optional()?.ok_or(Error::NotFound)?;
        let file = private_file(&self.blob_path(id), false)?;
        if file.metadata()?.len() != share.size {
            return Err(Error::Invalid);
        }
        Ok((share, file))
    }
    pub(crate) fn delete(&mut self, id: &str) -> Result<()> {
        if !crate::valid_id(id) {
            return Err(Error::Invalid);
        }
        if !self
            .connection
            .query_row("SELECT 1 FROM shares WHERE id=?", [id], |_| Ok(()))
            .optional()?
            .is_some()
        {
            return Err(Error::NotFound);
        }
        match fs::remove_file(self.blob_path(id)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.connection
            .execute("DELETE FROM shares WHERE id=?", [id])?;
        Ok(())
    }
    pub(crate) fn cleanup(&mut self, now: u64) -> Result<()> {
        let ids = {
            let mut statement = self
                .connection
                .prepare("SELECT id FROM shares WHERE expires_at<=?")?;
            let rows = statement.query_map([now.min(i64::MAX as u64) as i64], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        for id in ids {
            self.delete(&id)?;
        }
        Ok(())
    }
}
fn unsigned(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

fn share_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Share> {
    Ok(Share {
        id: row.get(0)?,
        name: row.get(1)?,
        mime: row.get(2)?,
        size: unsigned(row, 3)?,
        created_at: unsigned(row, 4)?,
        expires_at: unsigned(row, 5)?,
        url: String::new(),
    })
}
