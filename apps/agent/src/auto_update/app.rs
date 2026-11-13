//! The app-driven trigger: a lazysh app that is newer than this companion sends its version in
//! `LAZYSH_APP_VERSION`; with policy `install` this companion then starts one detached
//! `auto-update run`, which hands the real work to `lazysh-agent update --yes --version <app version>`.
//! The target is exactly the app's version, so a downgrade, a prerelease and a version the app does
//! not carry are all unreachable; the release metadata chain, the digest pin, the size cap, the
//! replace and the rollback are `update`'s, not reimplemented here.
//!
//! Everything here is decided offline from this process's version, the policy file and the record of
//! the last run. Nothing here touches the network; the detached runner does.
use super::{instant, Policy};
use crate::{private_json, update::Channel, Error, Result, Store};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use lazysh_companion_release::version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{self, Read},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration as Wait, Instant},
};

/// What an app sends on every exec it makes: the app's own version, `X.Y.Z`.
pub const ENV: &str = "LAZYSH_APP_VERSION";
const RECORD: &str = "app-update.json";
/// Held by whoever is running an update or a scheduled check: one at a time on a host.
pub(super) const LOCK: &str = "app-update.lock";
/// An update downloads under 12 MB; nothing legitimate runs longer than this.
const DEADLINE: Wait = Wait::from_secs(600);
/// A reported `done` stays visible this long, so the app that triggered it can see it finish.
const DONE_VISIBLE: Duration = Duration::minutes(10);
/// A session reported `working` this recently is an agent turn in progress.
const ACTIVE_TURN: Duration = Duration::seconds(crate::ACTIVE_TURN_SECONDS);
const DEFER: Duration = Duration::minutes(2);
const BUSY_RETRY: Duration = Duration::seconds(60);

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
pub(super) struct Record {
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
pub(super) fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}
fn time(text: &Option<String>) -> Option<DateTime<Utc>> {
    instant(&Value::from(text.clone()))
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
    pub(super) fn state(&self) -> State {
        self.state
    }
    pub(super) fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
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
pub(super) fn backoff(failures: u32) -> Duration {
    Duration::seconds((3600_i64 << failures.saturating_sub(1).min(5)).min(86_400))
}

/// A recorded refusal or recent completion also applies to runners spawned before it was written.
fn postponed(record: &Record, now: DateTime<Utc>) -> bool {
    record.blocked
        || time(&record.not_before).is_some_and(|at| now < at)
        || (record.state == State::Done
            && time(&record.finished_at).is_some_and(|at| now - at < DONE_VISIBLE))
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
    match super::read(directory) {
        Ok(settings) if settings.policy == Policy::Install => {
            if !settings.window_open() {
                return report(State::Skipped, Some("outsideWindow"));
            }
        }
        Ok(settings) if settings.policy == Policy::Notify => {
            return report(State::Skipped, Some("policyNotify"))
        }
        Ok(_) => return report(State::Skipped, Some("policyOff")),
        Err(_) => return report(State::Skipped, Some("policyUnreadable")),
    }
    if rolled_back_from(directory, app) {
        return report(State::Skipped, Some("rolledBack"));
    }
    if legacy_guarded(directory, app, now) {
        return report(State::Skipped, Some("legacyGuard"));
    }
    let record = record.filter(|record| record.to == app);
    if let Some(record) = &record {
        if postponed(record, now) {
            return Some(record.update(record.state));
        }
    }
    match private_json::lock(directory, LOCK) {
        // Free: this is only a probe. The runner takes the lock itself, and `update` decides again.
        Ok(Some(_probe)) => {}
        Ok(None) => return report(State::Running, None),
        Err(_) => return report(State::Failed, Some("internal")),
    }
    // A free lock with a running record means the prior outcome is unknown.
    if record.is_some_and(|record| record.state == State::Running) {
        return report(State::Failed, Some("interrupted"));
    }
    match spawn(app) {
        Ok(()) => report(State::Started, None),
        Err(_) => report(State::Failed, Some("internal")),
    }
}

/// `auto-update run` in its own process group with no inherited descriptors, so that it neither
/// keeps an SSH exec channel open nor dies with it.
fn spawn_runner(app: &str) -> io::Result<()> {
    spawn_detached(&["auto-update", "run", "--app-version", app])
}
pub(super) fn spawn_detached(args: &[&str]) -> io::Result<()> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(args)
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
pub(super) fn rolled_back_from(directory: &Path, app: &str) -> bool {
    let recorded = private_json::read(directory, "update-state.json")
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    recorded.is_some_and(|state| {
        state["lastOperation"]["action"] == "rollback" && state["lastOperation"]["from"] == app
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyRecord {
    schema_version: u8,
    version: String,
    state: LegacyState,
    failures: u8,
    not_before: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum LegacyState {
    Running,
    Failed,
    Blocked,
    Done,
}

/// A legacy updater's uncertain or backoff record must survive migration to this runner.
fn legacy_guarded(directory: &Path, app: &str, now: DateTime<Utc>) -> bool {
    let name = format!("legacy-update-{app}.json");
    let bytes = match private_json::read(directory, &name) {
        Ok(None) => return false,
        Ok(Some(bytes)) => bytes,
        Err(_) => return true,
    };
    let Ok(record) = serde_json::from_slice::<LegacyRecord>(&bytes) else {
        return true;
    };
    if record.schema_version != 1
        || record.version != app
        || record.failures > 100
        || record.not_before > 253_402_300_799
    {
        return true;
    }
    matches!(record.state, LegacyState::Running | LegacyState::Blocked)
        || (record.not_before as i64) > now.timestamp()
}

fn active_turn(directory: &Path, now: DateTime<Utc>) -> bool {
    // A genuinely absent store means no reported session. Any other metadata, open or query error
    // leaves the state unknown and therefore defers the update.
    let Ok(directory) = crate::storage_namespace::resolve(directory) else {
        return true;
    };
    match std::fs::symlink_metadata(directory.join("events.sqlite3")) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(_) => true,
        Ok(_) => Store::open(&directory)
            .and_then(|store| store.has_working_since(now - ACTIVE_TURN))
            .unwrap_or(true),
    }
}

/// Admit the updater under the same lock as policy writes. A successful policy change before
/// this spawn takes precedence; a change after spawn does not cancel an already admitted update.
fn admit_update(
    directory: &Path,
    spawn: impl FnOnce() -> io::Result<Child>,
) -> Result<Option<Child>> {
    let Some(_policy_lock) = private_json::lock(directory, "auto-update.lock")? else {
        return Ok(None);
    };
    if !matches!(super::read(directory), Ok(settings) if settings.policy == Policy::Install) {
        return Ok(None);
    }
    Ok(Some(spawn()?))
}

/// CREATE_NO_WINDOW: the runner has no console, and a child that needs one must not open a window.
fn no_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(command, 0x0800_0000);
    command
}

fn spawn_update(target: &str, channel: Channel) -> io::Result<Child> {
    no_window(
        Command::new(std::env::current_exe()?)
            .args([
                "update",
                "--yes",
                "--version",
                target,
                "--channel",
                channel.name(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .spawn()
}

fn admit_and_settle(
    directory: &Path,
    record: Record,
    spawn: impl FnOnce() -> io::Result<Child>,
) -> Record {
    match admit_update(directory, spawn) {
        Ok(Some(child)) => settle(record, update_child(child), Utc::now()),
        Ok(None) => {
            let mut record = record;
            record.state = State::Skipped;
            record.reason = Some("policyChanged".into());
            record.pid = None;
            record.finished_at = Some(stamp(Utc::now()));
            record
        }
        // A spawn error proves no child started, unlike an unknown child exit.
        Err(_) => {
            let now = Utc::now();
            let mut record = record;
            record.pid = None;
            record.finished_at = Some(stamp(now));
            failed(record, "internal", false, now)
        }
    }
}

/// Wait for a child's exit status, or stop it after `limit`.
fn wait_exit(child: &mut Child, limit: Wait) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait().ok()? {
            return Some(status);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Wait::from_millis(50));
    }
}

/// Wait for an admitted updater's exit status, or stop it after the deadline.
fn update_child(mut child: Child) -> Option<i32> {
    wait_exit(&mut child, DEADLINE)?.code()
}

/// `update --check --json` of `channel`: the status it exits with and the result it printed, or
/// `None` when it could not run or overran `limit`.
pub(super) fn check_child(channel: Channel, limit: Wait) -> Option<(i32, Value)> {
    let mut child = no_window(
        Command::new(std::env::current_exe().ok()?)
            .args(["update", "--check", "--json", "--channel", channel.name()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )
    .spawn()
    .ok()?;
    let code = wait_exit(&mut child, limit)?.code()?;
    let mut output = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let _ = stdout.take(64 * 1024).read_to_end(&mut output);
    }
    let result = String::from_utf8_lossy(&output)
        .lines()
        .last()
        .and_then(|line| serde_json::from_str(line).ok())
        .unwrap_or(Value::Null);
    Some((code, result))
}

/// The fixed `error.kind` word for an `update` exit status (docs/reference/companion-update.md).
pub(super) fn kind(code: i32) -> &'static str {
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
        Some(21) => failed(record, kind(21), false, now),
        // An abnormal exit, signal or timed-out child may have replaced the binary.
        Some(_) | None => failed(record, "uncertain", true, now),
    }
}
fn failed(mut record: Record, kind: &str, blocked: bool, now: DateTime<Utc>) -> Record {
    record.state = State::Failed;
    record.reason = Some(kind.into());
    record.failures = record.failures.saturating_add(1);
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
    let wanted = version(app).ok_or(Error::InvalidArgument)?;
    let installed = version(env!("CARGO_PKG_VERSION")).ok_or(Error::InvalidArgument)?;
    if wanted <= installed {
        return Err(Error::InvalidArgument);
    }
    let directory = crate::state_directory()?;
    let Some(_held) = private_json::lock(&directory, LOCK)? else {
        return Ok(json!({"state": "running", "to": app}));
    };
    let record = install_held(&directory, app, Channel::Stable)?;
    serde_json::to_value(&record).map_err(|_| Error::InvalidArgument)
}

/// Install release `target` of `channel` over this companion, with the runner lock held, and record
/// the outcome in `app-update.json`: the guards the app-driven and the scheduled paths share.
/// `update --yes --version` then resolves, verifies, replaces atomically and rolls back.
pub(super) fn install_held(directory: &Path, target: &str, channel: Channel) -> Result<Record> {
    let now = Utc::now();
    let from = env!("CARGO_PKG_VERSION");
    let app = target;
    // This check is authoritative only after taking the shared app-update lock.
    if legacy_guarded(directory, app, now) {
        let mut record = Record::new(from, app, State::Skipped);
        record.reason = Some("legacyGuard".into());
        return Ok(record);
    }
    let earlier = read_record(directory).filter(|record| record.to == app);
    // Several commands may have spawned runners before the first one acquired this lock. A
    // delayed runner must honor the result that runner committed before considering another try.
    if let Some(mut record) = earlier
        .clone()
        .filter(|record| record.state == State::Running)
    {
        record.pid = None;
        record.finished_at = Some(stamp(now));
        let record = failed(record, "uncertain", true, now);
        save(directory, &record)?;
        return Ok(record);
    }
    if let Some(record) = earlier.as_ref().filter(|record| postponed(record, now)) {
        return Ok(record.clone());
    }
    let mut record = Record::new(from, app, State::Running);
    record.failures = earlier.as_ref().map_or(0, |record| record.failures);
    record.pid = Some(std::process::id());
    record.started_at = Some(stamp(now));
    save(directory, &record)?;
    let record = if active_turn(directory, now) {
        // Not in the middle of an agent turn; look again shortly.
        record.state = State::Skipped;
        record.reason = Some("activeTurn".into());
        record.pid = None;
        record.finished_at = Some(stamp(now));
        record.not_before = Some(stamp(now + DEFER));
        record
    } else if rolled_back_from(directory, app) {
        record.state = State::Skipped;
        record.reason = Some("rolledBack".into());
        record.pid = None;
        record.finished_at = Some(stamp(Utc::now()));
        record
    } else {
        admit_and_settle(directory, record, || spawn_update(app, channel))
    };
    save(directory, &record)?;
    Ok(record)
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
    fn legacy_retry_state_is_validated_and_fences_only_the_matching_target() {
        let home = tempfile::tempdir().unwrap();
        let state_path = home.path().join("state");
        let state = state_path.as_path();
        let now = Utc::now();
        let name = "legacy-update-2.0.0.json";
        let record = |state_name: &str, until: i64| {
            json!({
                "schemaVersion": 1, "version": "2.0.0", "state": state_name,
                "failures": 1, "notBefore": until
            })
        };
        assert!(!legacy_guarded(state, "2.0.0", now));
        let _lock = private_json::lock(state, "test.lock").unwrap().unwrap();
        for state_name in ["running", "blocked"] {
            private_json::write(
                state,
                name,
                &serde_json::to_vec(&record(state_name, 0)).unwrap(),
            )
            .unwrap();
            assert!(legacy_guarded(state, "2.0.0", now));
            assert!(!legacy_guarded(state, "3.0.0", now));
        }
        for state_name in ["failed", "done"] {
            private_json::write(
                state,
                name,
                &serde_json::to_vec(&record(state_name, now.timestamp() + 60)).unwrap(),
            )
            .unwrap();
            assert!(legacy_guarded(state, "2.0.0", now));
            private_json::write(
                state,
                name,
                &serde_json::to_vec(&record(state_name, now.timestamp() - 1)).unwrap(),
            )
            .unwrap();
            assert!(!legacy_guarded(state, "2.0.0", now));
        }
        private_json::write(state, name, b"{broken").unwrap();
        assert!(legacy_guarded(state, "2.0.0", now));
        for bytes in [
            br#"{"schemaVersion":1,"version":"2.0.0","state":"done","failures":101,"notBefore":0}"#.as_slice(),
            br#"{"schemaVersion":1,"version":"2.0.0","state":"done","failures":0,"notBefore":0,"extra":true}"#.as_slice(),
        ] {
            private_json::write(state, name, bytes).unwrap();
            assert!(legacy_guarded(state, "2.0.0", now));
        }
        private_json::write(state, name, &serde_json::to_vec(&json!({
            "schemaVersion": 1, "version": "other", "state": "done", "failures": 0, "notBefore": 0
        })).unwrap()).unwrap();
        assert!(legacy_guarded(state, "2.0.0", now));
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            let path = state.join(name);
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(legacy_guarded(state, "2.0.0", now));
            std::fs::remove_file(&path).unwrap();
            symlink(state.join("absent"), &path).unwrap();
            assert!(legacy_guarded(state, "2.0.0", now));
        }
    }

    #[cfg(unix)]
    #[test]
    fn policy_change_and_updater_spawn_have_a_single_admission_order() {
        use std::sync::mpsc;

        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let worker_state = state.clone();
        let worker = std::thread::spawn(move || {
            admit_update(&worker_state, || {
                entered_tx.send(()).unwrap();
                resume_rx.recv().unwrap();
                // `true` is /bin/true on Linux and /usr/bin/true on macOS.
                Command::new("true").spawn()
            })
            .unwrap()
            .unwrap()
        });
        entered_rx.recv().unwrap();
        assert!(matches!(
            super::super::set(&state, 0, super::super::tests::change(Policy::Off)),
            Err(Error::Settings("SettingsBusy"))
        ));
        resume_tx.send(()).unwrap();
        assert!(worker.join().unwrap().wait().unwrap().success());
        assert_eq!(
            super::super::set(&state, 0, super::super::tests::change(Policy::Off))
                .unwrap()
                .policy,
            Policy::Off
        );
        assert!(admit_update(&state, || panic!("off must not spawn"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn updater_spawn_failure_settles_the_running_record() {
        let home = tempfile::tempdir().unwrap();
        let mut record = Record::new("1.0.0", "2.0.0", State::Running);
        record.pid = Some(123);
        let record = admit_and_settle(home.path(), record, || {
            Err(io::Error::other("spawn failed"))
        });
        assert_eq!(record.state, State::Failed);
        assert!(record.finished_at.is_some());
        assert_eq!(record.pid, None);
        assert_eq!(record.failures, 1);
        assert!(!record.blocked, "no child was spawned");
    }

    #[test]
    fn unknown_child_outcomes_block_automatic_retries() {
        let now = Utc::now();
        for code in [None, Some(1), Some(137)] {
            let record = settle(Record::new("1.0.0", "2.0.0", State::Running), code, now);
            assert!(record.blocked, "{code:?}");
            assert_eq!(record.reason.as_deref(), Some("uncertain"));
        }
        assert!(!settle(Record::new("1.0.0", "2.0.0", State::Running), Some(21), now).blocked);
        let mut saturated = Record::new("1.0.0", "2.0.0", State::Running);
        saturated.failures = u32::MAX;
        assert_eq!(settle(saturated, None, now).failures, u32::MAX);
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_or_dangling_namespace_is_never_treated_as_an_empty_store() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().unwrap();
        let dangling = home.path().join("linked-state");
        symlink(home.path().join("absent"), &dangling).unwrap();
        assert!(active_turn(&dangling, Utc::now()));
        assert!(!active_turn(&home.path().join("absent"), Utc::now()));
    }

    #[test]
    fn retries_back_off_from_an_hour_to_a_day() {
        let hours = |failures| backoff(failures).num_hours();
        assert_eq!(
            [hours(1), hours(2), hours(3), hours(4), hours(5), hours(40)],
            [1, 2, 4, 8, 16, 24]
        );
    }
}
