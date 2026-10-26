use crate::{digest, ApiError, Config, Event, Receipt, Source, Status};
use lazysh_common::{
    private_state::{self, SidecarKind},
    service_secrets, storage_filesystem, storage_namespace,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::{
    fs::File,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub(crate) const CAPACITY: i64 = 1000;
const RETAINED: i64 = 10000;
pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}
pub(crate) struct Store {
    pub connection: Connection,
    _lock: File,
}
pub(crate) struct Job {
    pub receipt: Receipt,
    pub generation: i64,
    pub attempts: i64,
}
impl Store {
    pub fn open(config: &Config, replace_target: bool) -> Result<Self, String> {
        if !cfg!(unix) {
            return Err("Notification relay requires verified Unix private storage".into());
        }
        let directory =
            storage_namespace::resolve(&config.directory).map_err(|_| "Unsafe relay namespace")?;
        storage_filesystem::require_local(&directory)
            .map_err(|_| "Relay requires local storage")?;
        storage_namespace::create(&directory).map_err(|_| "Cannot create private relay storage")?;
        service_secrets::private(
            &std::fs::symlink_metadata(&directory).map_err(|_| "Cannot inspect relay storage")?,
            true,
        )?;
        let lock = service_secrets::file(&directory.join(".lock"), true)?;
        lock.try_lock()
            .map_err(|_| "Relay directory already owned")?;
        let path = directory.join("outbox.sqlite3");
        private_state::validate_database(&path).map_err(|_| "Unsafe relay database")?;
        for (suffix, kind) in [
            ("journal", SidecarKind::Journal),
            ("wal", SidecarKind::Wal),
            ("shm", SidecarKind::Shm),
        ] {
            private_state::validate_sidecar(
                &directory.join(format!("outbox.sqlite3-{suffix}")),
                kind,
            )
            .map_err(|_| "Unsafe relay sidecar")?;
        }
        drop(service_secrets::file(&path, true)?);
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| "Cannot open relay database")?;
        connection
            .busy_timeout(std::time::Duration::from_secs(1))
            .map_err(|_| "Cannot configure relay database")?;
        connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS account (id TEXT NOT NULL, admin BLOB NOT NULL, target BLOB NOT NULL, generation INTEGER NOT NULL, enabled INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, alias TEXT UNIQUE NOT NULL, token BLOB UNIQUE NOT NULL, active INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS events (receipt TEXT PRIMARY KEY, source TEXT NOT NULL, event TEXT NOT NULL, kind TEXT NOT NULL, alias TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, next INTEGER NOT NULL, expires INTEGER NOT NULL, may_sent INTEGER NOT NULL, UNIQUE(source,event));").map_err(|_| "Cannot initialize relay schema")?;
        let mut store = Self {
            connection,
            _lock: lock,
        };
        store
            .initialize(config, replace_target)
            .map_err(|_| "Relay identity mismatch or storage failure")?;
        Ok(store)
    }
    fn initialize(&mut self, config: &Config, replace_target: bool) -> Result<(), ApiError> {
        let transaction = self.connection.transaction()?;
        let saved: Option<(Vec<u8>, Vec<u8>)> = transaction
            .query_row("SELECT admin,target FROM account", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        if let Some((admin, target)) = saved {
            if admin != config.admin_hash {
                return Err(ApiError::conflict());
            }
            if target != config.target_hash && !replace_target {
                return Err(ApiError::conflict());
            }
            if replace_target {
                transaction.execute(
                    "UPDATE account SET target=?1,generation=generation+1,enabled=0",
                    [config.target_hash.to_vec()],
                )?;
                transaction.execute("UPDATE events SET state=CASE WHEN may_sent=1 THEN 'cancelled_unknown' ELSE 'cancelled' END WHERE state IN ('queued','sending')",[])?;
            }
        } else {
            transaction.execute(
                "INSERT INTO account VALUES(?1,?2,?3,0,0)",
                params![
                    Uuid::new_v4().to_string(),
                    config.admin_hash.to_vec(),
                    config.target_hash.to_vec()
                ],
            )?;
        }
        // An interrupted POST is retryable only with the same persisted target and key.
        transaction.execute("UPDATE events SET state='failed_unknown' WHERE state IN ('queued','sending') AND attempts>=3", [])?;
        transaction.execute("UPDATE events SET state='queued' WHERE state='sending'", [])?;
        transaction.commit()?;
        Ok(())
    }
    pub fn status(&self) -> Result<Status, ApiError> {
        Ok(self
            .connection
            .query_row("SELECT id,enabled,generation FROM account", [], |r| {
                Ok(Status {
                    account_id: r.get(0)?,
                    enabled: r.get(1)?,
                    generation: r.get(2)?,
                })
            })?)
    }
    pub fn source(&mut self, source: &Source) -> Result<(), ApiError> {
        if source.account_id != self.status()?.account_id {
            return Err(ApiError::conflict());
        }
        if let Some((alias, hash, active)) = self
            .connection
            .query_row(
                "SELECT alias,token,active FROM sources WHERE id=?1",
                [source.id.to_string()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Vec<u8>>(1)?,
                        r.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()?
        {
            return if alias == source.alias && hash == source.token_hash && active {
                Ok(())
            } else {
                Err(ApiError::conflict())
            };
        }
        if self
            .connection
            .query_row("SELECT count(*) FROM sources", [], |r| r.get::<_, i64>(0))?
            >= 128
        {
            return Err(ApiError::capacity());
        }
        self.connection
            .execute(
                "INSERT INTO sources VALUES(?1,?2,?3,1)",
                params![source.id.to_string(), source.alias, source.token_hash],
            )
            .map_err(|_| ApiError::conflict())?;
        Ok(())
    }
    pub fn authenticate(&self, token: &str) -> Result<Uuid, ApiError> {
        let id: Option<String> = self
            .connection
            .query_row(
                "SELECT id FROM sources WHERE token=?1 AND active=1",
                [digest(token).to_vec()],
                |r| r.get(0),
            )
            .optional()?;
        id.and_then(|s| Uuid::parse_str(&s).ok())
            .ok_or_else(ApiError::unauthorized)
    }
    pub fn policy(&mut self, enabled: bool) -> Result<Status, ApiError> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "UPDATE account SET enabled=?1,generation=generation+1",
            [enabled],
        )?;
        transaction.execute("UPDATE events SET state=CASE WHEN may_sent=1 THEN 'cancelled_unknown' ELSE 'cancelled' END WHERE state IN ('queued','sending')",[])?;
        transaction.commit()?;
        self.status()
    }
    pub fn revoke(&mut self, id: Uuid) -> Result<(), ApiError> {
        let transaction = self.connection.transaction()?;
        transaction.execute("UPDATE sources SET active=0 WHERE id=?1", [id.to_string()])?;
        transaction.execute("UPDATE events SET state=CASE WHEN may_sent=1 THEN 'cancelled_unknown' ELSE 'cancelled' END WHERE source=?1 AND state IN ('queued','sending')",[id.to_string()])?;
        transaction.commit()?;
        Ok(())
    }
    pub fn ingest(&mut self, source: Uuid, event: Event) -> Result<Receipt, ApiError> {
        let transaction = self.connection.transaction()?;
        let active: Option<String> = transaction
            .query_row(
                "SELECT alias FROM sources WHERE id=?1 AND active=1",
                [source.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        let alias = active.ok_or_else(ApiError::unauthorized)?;
        let existing: Option<(String, String)> = transaction
            .query_row(
                "SELECT receipt,kind FROM events WHERE source=?1 AND event=?2",
                params![source.to_string(), event.event_id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((id, kind)) = existing {
            if kind != event.kind.as_str() {
                return Err(ApiError::conflict());
            }
            drop(transaction);
            return self.receipt(source, &id);
        }
        let (enabled, generation): (bool, i64) =
            transaction.query_row("SELECT enabled,generation FROM account", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        if !enabled {
            return Err(ApiError::disabled());
        }
        let (queued,total):(i64,i64)=transaction.query_row("SELECT sum(CASE WHEN state IN ('queued','sending') THEN 1 ELSE 0 END),count(*) FROM events",[],|r|Ok((r.get::<_,Option<i64>>(0)?.unwrap_or(0),r.get(1)?)))?;
        if queued >= CAPACITY || total >= RETAINED {
            return Err(ApiError::capacity());
        }
        let id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO events VALUES(?1,?2,?3,?4,?5,?6,'queued',0,0,?7,0)",
            params![
                id,
                source.to_string(),
                event.event_id.to_string(),
                event.kind.as_str(),
                alias,
                generation,
                now() + 86400
            ],
        )?;
        transaction.commit()?;
        self.receipt(source, &id)
    }
    pub fn receipt(&self, source: Uuid, id: &str) -> Result<Receipt, ApiError> {
        self.connection.query_row("SELECT receipt,event,kind,alias,state,may_sent FROM events WHERE source=?1 AND receipt=?2",params![source.to_string(),id],|r|Ok(Receipt{receipt_id:r.get(0)?,event_id:r.get(1)?,kind:r.get(2)?,alias:r.get(3)?,state:r.get(4)?,may_have_reached_destination:r.get(5)?})).optional()?.ok_or_else(ApiError::not_found)
    }
    pub fn claim(&mut self) -> Result<Option<Job>, ApiError> {
        let transaction = self.connection.transaction()?;
        transaction.execute("UPDATE events SET state=CASE WHEN may_sent=1 THEN 'expired_unknown' ELSE 'expired' END WHERE state='queued' AND expires<=?1",[now()])?;
        let row:Option<(String,String,i64,i64)>=transaction.query_row("SELECT e.source,e.receipt,e.generation,e.attempts FROM events e JOIN sources s ON s.id=e.source JOIN account a ON a.enabled=1 AND a.generation=e.generation WHERE e.state='queued' AND e.attempts<3 AND e.next<=?1 AND s.active=1 ORDER BY e.rowid LIMIT 1",[now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((source, id, generation, attempts)) = row else {
            transaction.commit()?;
            return Ok(None);
        };
        // This commit is network admission. A later revoke cannot retract a POST.
        transaction.execute(
            "UPDATE events SET state='sending',attempts=attempts+1,may_sent=1 WHERE receipt=?1",
            [&id],
        )?;
        transaction.commit()?;
        Ok(Some(Job {
            receipt: self.receipt(
                Uuid::parse_str(&source).map_err(|_| ApiError::storage())?,
                &id,
            )?,
            generation,
            attempts: attempts + 1,
        }))
    }
    pub fn finish(&mut self, job: &Job, accepted: bool) -> Result<(), ApiError> {
        let state = if accepted {
            "accepted"
        } else if job.attempts >= 3 {
            "failed_unknown"
        } else {
            "queued"
        };
        self.connection.execute("UPDATE events SET state=?1,next=?2 WHERE receipt=?3 AND generation=?4 AND state='sending'",params![state,now()+2,job.receipt.receipt_id,job.generation])?;
        Ok(())
    }
}

pub fn validate_output_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let resolved =
        storage_namespace::resolve(parent).map_err(|_| "Unsafe capability output namespace")?;
    service_secrets::private(
        &std::fs::metadata(resolved).map_err(|_| "Cannot inspect capability output directory")?,
        true,
    )
}
