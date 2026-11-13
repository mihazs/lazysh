//! The app-driven trigger: a lazysh app that is newer than this companion sends its version in
//! `LAZYSH_APP_VERSION`; with policy `install` this companion then starts one detached
//! `auto-update run`, which hands the real work to `lazysh-agent update --yes --version <app version>`.
//! The target is exactly the app's version, so a downgrade, a prerelease and a version the app does
//! not carry are all unreachable; the release metadata chain, the digest pin, the size cap, the
//! replace and the rollback are `update`'s, not reimplemented here.
//!
//! Everything here is decided offline from this process's version, the policy file and the record of
//! the last run. Nothing here touches the network; the detached runner does.
use super::Policy;
use crate::{private_json, Error, Result, SessionState, Store};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use lazysh_companion_release::version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration as Wait, Instant},
};

/// What an app sends on every exec it makes: the app's own version, `X.Y.Z`.
pub const ENV: &str = "LAZYSH_APP_VERSION";
const RECORD: &str = "app-update.json";
const LOCK: &str = "app-update.lock";
/// An update downloads under 12 MB; nothing legitimate runs longer than this.
const DEADLINE: Wait = Wait::from_secs(600);
/// A reported `done` stays visible this long, so the app that triggered it can see it finish.
const DONE_VISIBLE: Duration = Duration::minutes(10);
/// A session reported `working` this recently is an agent turn in progress.
const ACTIVE_TURN: Duration = Duration::minutes(10);
const DEFER: Duration = Duration::minutes(2);
const BUSY_RETRY: Duration = Duration::seconds(60);
const INTERRUPTED_RETRY: Duration = Duration::minutes(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// This request started the update.
    Started,
    /// An update started earlier is still running.
    Running,
    Done,
    Failed,
    Skipped,
}

/// The `update` field of a reply to an app that is newer than this companion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Update {
    pub state: State,
    pub from: String,
    pub to: String,
    /// A fixed word saying why nothing is happening or what failed; never remote text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// What the last runner left in `app-update.json`. Readers ignore unknown fields.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u8,
    from: String,
    to: String,
    state: State,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    finished_at: Option<String>,
    /// Consecutive failures to reach `to`; drives the backoff.
    #[serde(default)]
    failures: u32,
    /// A failure that retrying cannot fix: not tried again until the app carries a newer version.
    #[serde(default)]
    blocked: bool,
    #[serde(default)]
    not_before: Option<String>,
}
fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}
fn time(text: &Option<String>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text.as_deref()?)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}
impl Record {
    fn new(from: &str, to: &str, state: State) -> Self {
        Self {
            schema_version: 1,
            from: from.into(),
            to: to.into(),
            state,
            reason: None,
            pid: None,
            started_at: None,
            finished_at: None,
            failures: 0,
            blocked: false,
            not_before: None,
        }
    }
    fn update(&self, state: State) -> Update {
        Update {
            state,
            from: self.from.clone(),
            to: self.to.clone(),
            reason: self.reason.clone(),
        }
    }
}
fn read_record(directory: &Path) -> Option<Record> {
    let record: Record =
        serde_json::from_slice(&private_json::read(directory, RECORD).ok()??).ok()?;
    (record.schema_version == 1 && version(&record.from).is_some() && version(&record.to).is_some())
        .then_some(record)
}

/// Retry delay after the `failures`-th consecutive failure: one hour, doubling, at most a day.
fn backoff(failures: u32) -> Duration {
    Duration::seconds((3600_i64 << failures.saturating_sub(1).min(5)).min(86_400))
}

/// Called by every command an app runs. `None` unless an app newer than this companion is talking
/// to it (or one just finished updating it).
pub fn trigger() -> Option<Update> {
    let app = std::env::var(ENV).ok()?;
    decide(
        &app,
        env!("CARGO_PKG_VERSION"),
        &crate::state_directory().ok()?,
        Utc::now(),
        spawn_runner,
    )
}

fn decide(
    app: &str,
    current: &str,
    directory: &Path,
    now: DateTime<Utc>,
    spawn: impl FnOnce(&str) -> io::Result<()>,
) -> Option<Update> {
    let report = |state, reason: Option<&str>| {
        Some(Update {
            state,
            from: current.into(),
            to: app.into(),
            reason: reason.map(Into::into),
        })
    };
    let (Some(wanted), Some(installed)) = (version(app), version(current)) else {
        // Nothing is echoed back from an app string that is not a stable release version.
        return Some(Update {
            state: State::Skipped,
            from: current.into(),
            to: current.into(),
            reason: Some("invalidAppVersion".into()),
        });
    };
    let record = read_record(directory);
    if wanted <= installed {
        // An update this app triggered has finished: say so for a while.
        return record
            .filter(|record| {
                record.state == State::Done
                    && record.to == current
                    && time(&record.finished_at).is_some_and(|at| now - at < DONE_VISIBLE)
            })
            .map(|record| record.update(State::Done));
    }
    match super::read(directory).map(|settings| settings.policy) {
        Ok(Policy::Install) => {}
        Ok(Policy::Notify) => return report(State::Skipped, Some("policyNotify")),
        Ok(Policy::Off) => return report(State::Skipped, Some("policyOff")),
        Err(_) => return report(State::Skipped, Some("policyUnreadable")),
    }
    if rolled_back_from(directory, app) {
        return report(State::Skipped, Some("rolledBack"));
    }
    let record = record.filter(|record| record.to == app);
    if let Some(record) = &record {
        if record.blocked || time(&record.not_before).is_some_and(|at| now < at) {
            return Some(record.update(record.state));
        }
    }
    match private_json::lock(directory, LOCK) {
        // Free: this is only a probe. The runner takes the lock itself, and `update` decides again.
        Ok(Some(_probe)) => {}
        Ok(None) => return report(State::Running, None),
        Err(_) => return report(State::Failed, Some("internal")),
    }
    // The runner records `running` while it holds the lock, so a free lock means it died. That is
    // retried, but not on every request.
    if let Some(record) = record.filter(|record| record.state == State::Running) {
        if time(&record.started_at).is_some_and(|at| now - at < INTERRUPTED_RETRY) {
            return report(State::Failed, Some("interrupted"));
        }
    }
    match spawn(app) {
        Ok(()) => report(State::Started, None),
        Err(_) => report(State::Failed, Some("internal")),
    }
}

/// `auto-update run` in its own process group with no inherited descriptors, so that it neither
/// keeps an SSH exec channel open nor dies with it.
fn spawn_runner(app: &str) -> io::Result<()> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(["auto-update", "run", "--app-version", app])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0000_0008 | 0x0000_0200);
    command.spawn().map(drop)
}

/// The user rolled back from this very version: it is not installed again behind their back.
fn rolled_back_from(directory: &Path, app: &str) -> bool {
    let recorded = private_json::read(directory, "update-state.json")
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    recorded.is_some_and(|state| {
        state["lastOperation"]["action"] == "rollback" && state["lastOperation"]["from"] == app
    })
}

fn active_turn(directory: &Path, now: DateTime<Utc>) -> bool {
    // Opening the store would create it; with none there is no session.
    if !directory.join("events.sqlite3").exists() {
        return false;
    }
    let Ok(sessions) = Store::open(directory).and_then(|mut store| store.snapshot(100, now)) else {
        return false;
    };
    sessions.sessions.iter().any(|session| {
        session.event.state == SessionState::Working
            && DateTime::parse_from_rfc3339(&session.updated_at)
                .is_ok_and(|at| now - at.with_timezone(&Utc) < ACTIVE_TURN)
    })
}

/// Run `update` for `app` to the end: its exit status, or `None` when it could not run or overran.
fn update_child(app: &str) -> Option<i32> {
    let mut child = Command::new(std::env::current_exe().ok()?)
        .args(["update", "--yes", "--version", app])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + DEADLINE;
    loop {
        if let Some(status) = child.try_wait().ok()? {
            return status.code();
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Wait::from_millis(50));
    }
}

/// The fixed `error.kind` word for an `update` exit status (docs/reference/companion-update.md).
fn kind(code: i32) -> &'static str {
    match code {
        20 => "networkUnavailable",
        21 => "releaseUnavailable",
        22 => "verificationFailed",
        23 => "downgradeRefused",
        24 => "selfTestFailed",
        25 => "rolledBack",
        27 => "unsafeInstallLocation",
        29 => "uncertain",
        _ => "internal",
    }
}

/// Fold an `update` outcome into what the next requests are told and when to try again.
fn settle(mut record: Record, code: Option<i32>, now: DateTime<Utc>) -> Record {
    record.pid = None;
    record.finished_at = Some(stamp(now));
    match code {
        Some(0) => {
            record.state = State::Done;
            record.failures = 0;
            record.reason = None;
            record
        }
        // Another update or install holds the managed copy's lock: not a failure, soon again.
        Some(26) => {
            record.state = State::Skipped;
            record.reason = Some("busy".into());
            record.not_before = Some(stamp(now + BUSY_RETRY));
            record
        }
        // No route to the release host: nothing to tell the user, try again later.
        Some(20) => {
            let mut record = failed(record, kind(20), false, now);
            record.state = State::Skipped;
            record
        }
        // A mismatch, a refused downgrade, a failed self-test or restore, an unsafe location or an
        // unconfirmed result: the same release would fail the same way.
        Some(code @ (22..=25 | 27 | 29)) => failed(record, kind(code), true, now),
        Some(code) => failed(record, kind(code), false, now),
        None => failed(record, kind(1), false, now),
    }
}
fn failed(mut record: Record, kind: &str, blocked: bool, now: DateTime<Utc>) -> Record {
    record.state = State::Failed;
    record.reason = Some(kind.into());
    record.failures += 1;
    record.blocked = blocked;
    record.not_before = Some(stamp(now + backoff(record.failures)));
    record
}

fn save(directory: &Path, record: &Record) -> Result<()> {
    private_json::write(
        directory,
        RECORD,
        &serde_json::to_vec(record).map_err(|_| Error::InvalidArgument)?,
    )
}

/// `auto-update run --app-version X`: the detached runner. One runs at a time (an advisory lock that
/// dies with the process, so a crashed runner never wedges later ones).
pub fn run(app: &str) -> Result<Value> {
    version(app).ok_or(Error::InvalidArgument)?;
    let directory = crate::state_directory()?;
    let Some(_held) = private_json::lock(&directory, LOCK)? else {
        return Ok(json!({"state": "running", "to": app}));
    };
    let now = Utc::now();
    let from = env!("CARGO_PKG_VERSION");
    let earlier = read_record(&directory).filter(|record| record.to == app);
    let mut record = Record::new(from, app, State::Running);
    record.failures = earlier.as_ref().map_or(0, |record| record.failures);
    record.pid = Some(std::process::id());
    record.started_at = Some(stamp(now));
    save(&directory, &record)?;
    let record = if active_turn(&directory, now) {
        // Not in the middle of an agent turn; look again shortly.
        record.state = State::Skipped;
        record.reason = Some("activeTurn".into());
        record.pid = None;
        record.finished_at = Some(stamp(now));
        record.not_before = Some(stamp(now + DEFER));
        record
    } else {
        settle(record, update_child(app), Utc::now())
    };
    save(&directory, &record)?;
    serde_json::to_value(&record).map_err(|_| Error::InvalidArgument)
}

/// The recorded last run, for `auto-update status`.
pub fn recorded(directory: &Path) -> Value {
    read_record(directory)
        .and_then(|record| serde_json::to_value(record).ok())
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_back_off_from_an_hour_to_a_day() {
        let hours = |failures| backoff(failures).num_hours();
        assert_eq!(
            [hours(1), hours(2), hours(3), hours(4), hours(5), hours(40)],
            [1, 2, 4, 8, 16, 24]
        );
    }
}
