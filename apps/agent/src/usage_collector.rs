//! Scheduled background usage collection ([ADR 0005](../../../docs/architecture/adr-0005-background-usage-collection.md)).
//! A one-shot command that an OS timer wakes every five minutes: it records one bounded sample of the account
//! quota report when the user's interval has elapsed, and does nothing at all while the collector is off.
mod samples;
mod timer;

use crate::{private_json, usage_collection, Error, Result};
use chrono::{DateTime, Duration, Utc};
use clap::Subcommand;
use lazysh_account_usage::Response;
use samples::{timestamp, LastRun, Sample, Store};
use serde_json::{json, Value};
use std::{path::Path, process::ExitCode};
use timer::Backend;

const LOCK: &str = "usage-collector.lock";
/// Held for the whole of an `enable` or `disable`, so the two never interleave their timer and policy writes.
const LIFECYCLE_LOCK: &str = "usage-collector-lifecycle.lock";
const LIFECYCLE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
/// The timer ticks every five minutes and a run starts a moment after its tick, so a minute of slack keeps a
/// five-minute interval from becoming ten.
const SLACK: Duration = Duration::minutes(1);

#[derive(Subcommand)]
pub enum Command {
    /// Install the timer and start recording account quota samples.
    Enable {
        /// Minutes between samples; a sample is recorded at the first five-minute tick after it.
        #[arg(long, value_parser = clap::value_parser!(u32).range(5..=1440))]
        interval_minutes: Option<u32>,
    },
    /// Stop recording and remove the timer; recorded samples stay until the file is deleted.
    Disable,
    /// Provision the default timer when enabled and absent.
    Ensure,
    /// Show the collector, its timer, the last run and the age of the samples.
    Status {
        /// Also list this many of the newest samples.
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u16).range(0..=200))]
        limit: u16,
    },
    /// Record one sample when one is due. This is what the timer runs.
    Run,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The collector is off: nothing was read and nothing was written.
    Off,
    /// Another run or a policy change holds the lock; nothing was written.
    Busy,
    NotDue,
    Recorded,
    /// Not read: the host forbids account quota reads.
    Skipped,
    /// Read, but the provider report was not available (offline, timed out): no sample.
    Unavailable,
}

/// One timer tick with an injected clock and quota reader. Nothing is read or written while the collector
/// is off, and a policy change that lands while the read runs wins: the result is then dropped.
pub fn run_once(
    directory: &Path,
    now: DateTime<Utc>,
    read: impl FnOnce() -> Result<Response>,
) -> Result<Outcome> {
    let policy = usage_collection::read(directory)?;
    if !policy.collector_enabled {
        return Ok(Outcome::Off);
    }
    let Some(_run) = private_json::lock(directory, LOCK)? else {
        return Ok(Outcome::Busy);
    };
    let mut store = Store::read(directory)?;
    if !due(&store, policy.collector_interval_minutes, now) {
        return Ok(Outcome::NotDue);
    }
    let (outcome, reason, sample) = if policy.account_quota_enabled {
        let response = read()?;
        match Sample::from_response(&response, now) {
            Some(sample) => (Outcome::Recorded, None, Some(sample)),
            None => (Outcome::Unavailable, Some(response.state), None),
        }
    } else {
        (Outcome::Skipped, Some("accountQuotaDisabled".into()), None)
    };
    let Some(_policy) = usage_collection::lock(directory)? else {
        return Ok(Outcome::Busy);
    };
    if !usage_collection::read(directory)?.collector_enabled {
        return Ok(Outcome::Off);
    }
    store.last_run = Some(LastRun {
        at: timestamp(now),
        outcome: outcome.name().into(),
        reason,
    });
    store.samples.extend(sample);
    store.prune(now);
    store.write(directory)?;
    Ok(outcome)
}

fn due(store: &Store, interval_minutes: u32, now: DateTime<Utc>) -> bool {
    let last = store
        .last_run
        .as_ref()
        .and_then(|run| DateTime::parse_from_rfc3339(&run.at).ok());
    last.is_none_or(|last| {
        let elapsed = now.signed_duration_since(last);
        // A clock that moved back is not "not due yet" forever.
        elapsed < Duration::zero() || elapsed >= Duration::minutes(interval_minutes.into()) - SLACK
    })
}

impl Outcome {
    fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Busy => "busy",
            Self::NotDue => "notDue",
            Self::Recorded => "recorded",
            Self::Skipped => "skipped",
            Self::Unavailable => "unavailable",
        }
    }
}

enum Failure {
    Timer(timer::Failure),
    Agent(Error),
}
impl From<timer::Failure> for Failure {
    fn from(failure: timer::Failure) -> Self {
        Self::Timer(failure)
    }
}
impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Agent(error)
    }
}

/// Exit 41: this account cannot hold a timer, nothing was changed. 42: the system or an existing file
/// refused it, and what was written is put back. Both match ADR 0003's timer codes.
pub fn run(command: Command) -> ExitCode {
    match execute(command) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(Failure::Timer(timer::Failure::Unsupported)) => {
            eprintln!("lazysh-agent: TimerUnsupported: this account has no user service manager");
            ExitCode::from(41)
        }
        Err(Failure::Timer(timer::Failure::Refused(reason))) => {
            eprintln!("lazysh-agent: TimerFailed: {reason}");
            ExitCode::from(42)
        }
        Err(Failure::Agent(error)) => {
            eprintln!("lazysh-agent: {}: operation failed", error.class());
            ExitCode::FAILURE
        }
    }
}

/// Waits for the lifecycle lock: a change that is already running finishes first, and this one then sees its result.
fn lifecycle(directory: &Path) -> std::result::Result<private_json::Lock, timer::Failure> {
    let busy = timer::Failure::Refused("Another change to the collector is still running");
    let started = std::time::Instant::now();
    loop {
        match private_json::lock(directory, LIFECYCLE_LOCK) {
            Ok(Some(lock)) => return Ok(lock),
            Ok(None) if started.elapsed() < LIFECYCLE_WAIT => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Ok(None) => return Err(busy),
            Err(_) => {
                return Err(timer::Failure::Refused(
                    "The collector state is unavailable",
                ))
            }
        }
    }
}

fn execute(command: Command) -> std::result::Result<Value, Failure> {
    let directory = crate::state_directory()?;
    let now = Utc::now();
    match command {
        Command::Run => {
            let outcome = run_once(&directory, now, || crate::account_usage::run(false))?;
            Ok(json!({"schemaVersion": 1, "outcome": outcome.name()}))
        }
        Command::Ensure => {
            let policy = usage_collection::read(&directory)?;
            if policy.collector_enabled && policy.account_quota_enabled {
                let (backend, exe) = (Backend::host(), timer::executable()?);
                if timer::state(backend, &exe) == timer::State::Absent {
                    let _held = lifecycle(&directory)?;
                    let policy = usage_collection::read(&directory)?;
                    if policy.collector_enabled
                        && policy.account_quota_enabled
                        && timer::state(backend, &exe) == timer::State::Absent
                    {
                        timer::install(backend, &exe, &mut || Ok(()))?;
                    }
                }
            }
            Ok(status(&directory, now, 0)?)
        }
        Command::Enable { interval_minutes } => {
            let (backend, exe) = (Backend::host(), timer::executable()?);
            let (mut held, mut was_enabled) = (None, false);
            timer::install(backend, &exe, &mut || {
                held = Some(lifecycle(&directory)?);
                was_enabled = usage_collection::read(&directory)
                    .map_err(|_| timer::Failure::Refused("The collector policy is unreadable"))?
                    .collector_enabled;
                Ok(())
            })?;
            let enabled = usage_collection::update(&directory, None, |policy| {
                policy.collector_enabled = true;
                policy.collector_interval_minutes =
                    interval_minutes.unwrap_or(policy.collector_interval_minutes);
            });
            if let Err(error) = enabled {
                // A collector that was already on keeps its timer; only a first enable is taken back out.
                if !was_enabled {
                    let _ = timer::remove(backend);
                }
                return Err(error.into());
            }
            drop(held);
            Ok(status(&directory, now, 0)?)
        }
        Command::Disable => {
            let _held = lifecycle(&directory)?;
            if usage_collection::read(&directory)?.collector_enabled {
                usage_collection::update(&directory, None, |policy| {
                    policy.collector_enabled = false;
                })?;
            }
            timer::remove(Backend::host())?;
            Ok(status(&directory, now, 0)?)
        }
        Command::Status { limit } => Ok(status(&directory, now, limit.into())?),
    }
}

/// Read only: nothing is created, and an unreadable sample file is reported, not repaired.
fn status(directory: &Path, now: DateTime<Utc>, limit: usize) -> Result<Value> {
    let policy = usage_collection::read(directory)?;
    let backend = Backend::host();
    let state = timer::executable().map_or(timer::State::Drift, |exe| timer::state(backend, &exe));
    let store = Store::read(directory);
    let readable = if store.is_ok() { "ok" } else { "invalid" };
    let store = store.unwrap_or_default();
    let times: Vec<&str> = store
        .samples
        .iter()
        .map(|s| s.recorded_at.as_str())
        .collect();
    Ok(json!({
        "schemaVersion": 1,
        "observedAt": timestamp(now),
        "policyRevision": policy.revision,
        "accountQuotaEnabled": policy.account_quota_enabled,
        "collector": {
            "enabled": policy.collector_enabled,
            "intervalMinutes": policy.collector_interval_minutes,
            "timer": {"state": state, "linger": timer::linger(backend)},
        },
        "lastRun": store.last_run,
        "samples": {
            "state": readable,
            "count": store.samples.len(),
            "oldest": times.first(),
            "newest": times.last(),
            "bytes": serde_json::to_vec(&store).map_or(0, |bytes| bytes.len()),
        },
        "recent": store.samples.iter().rev().take(limit).collect::<Vec<_>>(),
    }))
}
