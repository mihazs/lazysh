//! An event the busy store refused is kept on disk and replayed, oldest first, by the next ingest.
//!
//! The hook still fails with the unchanged storage error, because the provider's hook deadline leaves no room
//! to wait longer; what changes is that the event is no longer lost. Only plain events are kept: a reported
//! history source and a Kimi observation still fail as before.
use crate::{notification_policy, storage_namespace, Agent, Error, Event, Result, Store, Title};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const DIRECTORY: &str = "pending-ingest";
/// Past this the oldest state is no better than the next report, so an event is replayed only while it is fresh.
const MAX_AGE_SECONDS: i64 = crate::ACTIVE_TURN_SECONDS;
const MAX_PENDING: usize = 256;
const MAX_FILE: u64 = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    reported_at_micros: i64,
    event: Event,
    /// A title serializes as plain text, so the replay needs to know whether the agent named the session itself.
    #[serde(default)]
    vendor_title: bool,
}

fn busy(error: &Error) -> bool {
    matches!(
        error,
        Error::Storage(rusqlite::Error::SqliteFailure(code, _))
            if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

fn directory(state: &Path) -> io::Result<PathBuf> {
    Ok(storage_namespace::resolve(state)?.join(DIRECTORY))
}

fn names(directory: &Path) -> io::Result<Vec<String>> {
    let mut names = match fs::read_dir(directory) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name.ends_with(".json"))
            .collect::<Vec<_>>(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    names.sort();
    Ok(names)
}

/// Keep `event` for the next ingest. The file is complete before it gets its name, so a replay never sees half of one.
fn defer(state: &Path, event: &Event, at: DateTime<Utc>) -> io::Result<()> {
    let directory = directory(state)?;
    storage_namespace::create(&directory)?;
    if names(&directory)?.len() >= MAX_PENDING {
        return Err(io::Error::other("Too many pending events"));
    }
    let bytes = serde_json::to_vec(&Pending {
        reported_at_micros: at.timestamp_micros(),
        event: event.clone(),
        vendor_title: event.title.as_ref().is_some_and(Title::is_vendor),
    })
    .map_err(io::Error::other)?;
    let unique = format!("{:020}-{}", at.timestamp_micros(), std::process::id());
    let staged = directory.join(format!(".{unique}.tmp"));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&staged)?;
    // shortcut: the directory entry is not synced, so a power loss can drop the newest event; upgrade if that matters.
    let written = file.write_all(&bytes).and_then(|()| file.sync_all());
    drop(file);
    written
        .and_then(|()| fs::rename(&staged, directory.join(format!("{unique}.json"))))
        .inspect_err(|_| {
            let _ = fs::remove_file(&staged);
        })
}

fn load(path: &Path) -> Option<Pending> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !lazysh_common::fs::owner_only(&metadata, false) || metadata.len() > MAX_FILE {
        return None;
    }
    let mut bytes = Vec::new();
    lazysh_common::fs::read_options(false)
        .open(path)
        .ok()?
        .take(MAX_FILE)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Record every kept event that is still fresh, oldest first, and forget the stale or unreadable ones.
/// Stops at the first event the store refuses, which stays kept.
fn drain(
    state: &Path,
    store: &mut Store,
    admission: notification_policy::Admission,
    now: DateTime<Utc>,
) -> Result<()> {
    let directory = directory(state)?;
    for name in names(&directory)? {
        let path = directory.join(name);
        let fresh = load(&path)
            .filter(|pending| pending.event.validate().is_ok())
            .and_then(|pending| {
                let at = DateTime::from_timestamp_micros(pending.reported_at_micros)?;
                (now.signed_duration_since(at).num_seconds() <= MAX_AGE_SECONDS).then_some((
                    Event {
                        title: pending
                            .event
                            .title
                            .map(|title| title.with_source(pending.vendor_title)),
                        ..pending.event
                    },
                    at,
                ))
            });
        if let Some((event, at)) = fresh {
            store.ingest_with_reported_history(Some(&event), None, at, admission)?;
        }
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Record `event` after the events an earlier busy store refused. When the store is still busy the event is kept
/// instead, and the storage error is returned as before.
pub fn ingest(state: &Path, agent: Agent, event: &Event, now: DateTime<Utc>) -> Result<()> {
    let outcome = Store::open(state).and_then(|mut store| {
        let admission = store.admission(state, agent, &notification_policy::System)?;
        match drain(state, &mut store, admission, now) {
            Err(error) if busy(&error) => return Err(error),
            // A kept event that cannot be replayed must not stop the current one.
            _ => {}
        }
        store.ingest_with_reported_history(Some(event), None, now, admission)
    });
    if outcome.as_ref().is_err_and(busy) {
        let _ = defer(state, event, now);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionState;

    fn event(state: SessionState) -> Event {
        Event {
            session_id: "spool".into(),
            agent: "Test".into(),
            project: "/fixture".into(),
            state,
            summary: "Synthetic".into(),
            pane_id: None,
            pane_server: None,
            waiting: None,
            title: None,
        }
    }
    fn ingest_done(state: &Path) {
        ingest(
            state,
            Agent::Generic,
            &event(SessionState::Done),
            Utc::now(),
        )
        .unwrap();
    }
    fn recorded(state: &Path) -> (SessionState, u64) {
        let snapshot = Store::open(state)
            .unwrap()
            .snapshot(10, Utc::now())
            .unwrap();
        let session = snapshot.sessions.first().expect("one session");
        (session.event.state, session.event_count)
    }
    fn title_of(state: &Path) -> Option<String> {
        let snapshot = Store::open(state)
            .unwrap()
            .snapshot(10, Utc::now())
            .unwrap();
        snapshot.sessions[0]
            .event
            .title
            .as_ref()
            .map(|title| title.as_str().to_owned())
    }
    fn pending(state: &Path) -> usize {
        names(&directory(state).unwrap()).unwrap().len()
    }

    #[test]
    fn a_kept_event_is_replayed_before_the_next_one_and_the_spool_empties() {
        let state = tempfile::tempdir().unwrap();
        let at = Utc::now() - chrono::Duration::seconds(30);
        defer(state.path(), &event(SessionState::Working), at).unwrap();
        defer(
            state.path(),
            &event(SessionState::NeedsAttention),
            at + chrono::Duration::seconds(1),
        )
        .unwrap();
        assert_eq!(pending(state.path()), 2);
        ingest_done(state.path());
        assert_eq!(recorded(state.path()), (SessionState::Done, 3));
        assert_eq!(pending(state.path()), 0);
    }

    #[test]
    fn a_kept_title_is_replayed_with_the_source_that_chose_it() {
        let titled = |title: Title| Event {
            title: Some(title),
            ..event(SessionState::Working)
        };
        let state = tempfile::tempdir().unwrap();
        let at = Utc::now() - chrono::Duration::seconds(30);
        Store::open(state.path())
            .unwrap()
            .ingest(&titled(Title::prompt("First prompt").unwrap()), at)
            .unwrap();
        defer(
            state.path(),
            &titled(Title::prompt("Second prompt").unwrap()),
            at + chrono::Duration::seconds(1),
        )
        .unwrap();
        ingest_done(state.path());
        assert_eq!(
            title_of(state.path()).as_deref(),
            Some("First prompt"),
            "a kept prompt title still never replaces one"
        );
        defer(
            state.path(),
            &titled(Title::vendor("Chosen by the agent").unwrap()),
            at + chrono::Duration::seconds(2),
        )
        .unwrap();
        defer(
            state.path(),
            &titled(Title::prompt("Third prompt").unwrap()),
            at + chrono::Duration::seconds(3),
        )
        .unwrap();
        ingest_done(state.path());
        assert_eq!(
            title_of(state.path()).as_deref(),
            Some("Chosen by the agent")
        );
    }

    #[test]
    fn stale_and_unreadable_files_are_forgotten_without_stopping_the_current_event() {
        let state = tempfile::tempdir().unwrap();
        defer(
            state.path(),
            &event(SessionState::Working),
            Utc::now() - chrono::Duration::seconds(MAX_AGE_SECONDS + 5),
        )
        .unwrap();
        let spool = directory(state.path()).unwrap();
        fs::write(spool.join("00000000000000000001-1.json"), b"not json").unwrap();
        ingest_done(state.path());
        assert_eq!(recorded(state.path()), (SessionState::Done, 1));
        assert_eq!(pending(state.path()), 0);
    }

    #[test]
    fn the_spool_is_bounded_and_refuses_one_event_past_its_limit() {
        let state = tempfile::tempdir().unwrap();
        let start = Utc::now();
        for offset in 0..MAX_PENDING as i64 {
            defer(
                state.path(),
                &event(SessionState::Working),
                start + chrono::Duration::microseconds(offset),
            )
            .unwrap();
        }
        assert_eq!(pending(state.path()), MAX_PENDING);
        assert!(defer(state.path(), &event(SessionState::Working), start).is_err());
        assert_eq!(pending(state.path()), MAX_PENDING);
    }
}
