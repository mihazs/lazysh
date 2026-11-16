//! Additive hook readiness for `hooks status`. Only a fact the companion store already holds is
//! reported; everything this host cannot observe stays `notChecked`, never guessed or inferred.
use super::AgentProfile;
use chrono::{DateTime, SecondsFormat};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, io, os::unix::fs::MetadataExt, path::Path, time::Duration};

const NOT_CHECKED: &str = "notChecked";

pub(super) fn report(agent: AgentProfile) -> Value {
    // Provider reload, provider trust and remote approval live in the provider or on the relay and are
    // not probed (reading a trust record is out of bounds); the status does not know the current pane.
    json!({
        "schemaVersion":1,
        "localEvent":local_event(agent.store_name()),
        "providerReloaded":NOT_CHECKED,
        "projectTrusted":NOT_CHECKED,
        "paneBound":NOT_CHECKED,
        "remoteDelivery":NOT_CHECKED,
    })
}

/// `received` with the latest event time, `none` when this host's store holds no event for the agent,
/// `notChecked` whenever the store cannot be read safely. History is never proof of a live agent.
fn local_event(agent: &str) -> Value {
    match latest(agent) {
        Ok(Some(time)) => json!({"state":"received","lastEventAt":time}),
        Ok(None) => json!({"state":"none"}),
        Err(_) => json!({"state":NOT_CHECKED}),
    }
}

/// Reads the existing store only: an absent store is `None`, nothing is created, repaired or pruned.
fn latest(agent: &str) -> io::Result<Option<String>> {
    let invalid = |message| io::Error::new(io::ErrorKind::InvalidData, message);
    let directory = crate::state_directory().map_err(|_| invalid("No state directory"))?;
    let path = crate::storage_namespace::resolve(&directory)?.join("events.sqlite3");
    match fs::symlink_metadata(&path) {
        Ok(metadata)
            if !metadata.is_file()
                || metadata.nlink() != 1
                || metadata.uid() != unsafe { libc::geteuid() } =>
        {
            return Err(invalid("Unsafe state file"))
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    newest(&path, agent).map_err(|_| invalid("Unreadable state"))
}

fn newest(path: &Path, agent: &str) -> rusqlite::Result<Option<String>> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    // Same as the store itself: closing must never checkpoint or remove another process's log.
    connection.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )?;
    connection.busy_timeout(Duration::from_millis(500))?;
    let seconds: Option<f64> = connection
        .query_row(
            "SELECT MAX(updated_at) FROM sessions WHERE agent=?1",
            [agent],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    seconds
        .map(|seconds| {
            DateTime::from_timestamp_micros((seconds * 1_000_000.0).round() as i64)
                .map(|time| time.to_rfc3339_opts(SecondsFormat::Micros, true))
                .ok_or(rusqlite::Error::InvalidQuery)
        })
        .transpose()
}
