//! The scheduled check: what `auto-update run` does when no app asked for it. Whatever starts it (the
//! OS timer, or the companion itself the next time the app reads a snapshot) it is one process that
//! asks `update --check` whether a newer verified release exists on the channel, records the answer in
//! `update-state.json` as `lastCheck`, and under policy `install` hands a newer release to the same
//! guarded install a newer app starts. Nothing here talks to the network itself.
//!
//! The check is rate limited by what it records, so a runner that dies halfway, a state directory
//! that cannot be written and a host that is offline all end the same way: the next check waits.
use super::{app, instant, AutoUpdate, Policy};
use crate::{private_json, update::state, Result};
use chrono::{DateTime, Duration, Utc};
use lazysh_companion_release::version;
use serde_json::{json, Value};
use std::time::Duration as Wait;

/// `update --check` makes a handful of small requests, each bounded; this bounds all of them.
const CHECK_DEADLINE: Wait = Wait::from_secs(90);
/// A clock set back would otherwise postpone every check until it caught up.
const CLOCK_SLACK_MINUTES: i64 = 5;
/// While a newer release waits for a window or for an agent turn to end, look again this often
/// instead of waiting out the whole interval.
const PENDING_RECHECK_MINUTES: i64 = 30;

fn last_check(directory: &std::path::Path) -> Value {
    state::State::read(directory)
        .last_check
        .unwrap_or(Value::Null)
}

/// When the next check may use the network. A failed check waits `notBefore` (an hour, doubling to
/// a day); a good one waits the interval, or an hour while an update is waiting to be installed.
fn due_at(last: &Value, settings: &AutoUpdate, now: DateTime<Utc>) -> DateTime<Utc> {
    let Some(at) = instant(&last["at"]) else {
        return now;
    };
    if at > now + Duration::minutes(CLOCK_SLACK_MINUTES) {
        return now;
    }
    if last["error"].is_object() {
        return instant(&last["notBefore"]).unwrap_or(at + app::backoff(1));
    }
    let interval = Duration::hours(i64::from(settings.interval_hours));
    let waiting = settings.policy == Policy::Install && last["available"] == true;
    at + if waiting {
        interval.min(Duration::minutes(PENDING_RECHECK_MINUTES))
    } else {
        interval
    }
}

/// `nextCheckAt` of `auto-update status`: `null` when nothing is scheduled.
pub(super) fn next(
    directory: &std::path::Path,
    settings: &AutoUpdate,
    now: DateTime<Utc>,
) -> Option<String> {
    (settings.policy != Policy::Off)
        .then(|| app::stamp(due_at(&last_check(directory), settings, now)))
}

/// Called by `snapshot`, the read the app already makes: when a check is due, start one detached
/// `auto-update run` and go on. Never blocks and never fails the snapshot. Only the managed copy does
/// this (a development build or a copy on `PATH` is not what updates), and a hook never calls it.
pub fn opportunistic() {
    if !crate::update::running_managed() {
        return;
    }
    let Ok(directory) = crate::state_directory() else {
        return;
    };
    let Ok(settings) = super::read(&directory) else {
        return;
    };
    let now = Utc::now();
    if settings.policy == Policy::Off || due_at(&last_check(&directory), &settings, now) > now {
        return;
    }
    // A free lock only says nothing runs now; the runner takes the lock itself and decides again.
    if matches!(private_json::lock(&directory, app::LOCK), Ok(Some(_))) {
        let _ = app::spawn_detached(&["auto-update", "run"]);
    }
}

fn answer(state: &str, reason: Option<&str>, latest: Option<&str>) -> Value {
    let mut answer = json!({"schemaVersion": 1, "state": state});
    if let Some(reason) = reason {
        answer["reason"] = reason.into();
    }
    if let Some(latest) = latest {
        answer["latest"] = latest.into();
    }
    answer
}

/// `last` with this attempt noted as failed: what was known about the latest release stays.
fn failed_check(last: &Value, now: DateTime<Utc>, kind: &str) -> Value {
    let earlier = if last["error"].is_object() {
        last["failures"].as_u64().unwrap_or(0).min(64) as u32
    } else {
        0
    };
    let failures = earlier + 1;
    json!({"at": app::stamp(now), "latest": last["latest"], "available": last["available"] == true,
        "error": {"kind": kind}, "failures": failures,
        "notBefore": app::stamp(now + app::backoff(failures))})
}

/// `auto-update run` with no app asking: one check, and under policy `install` the install it leads to.
pub(super) fn run() -> Result<Value> {
    let directory = crate::state_directory()?;
    let Ok(settings) = super::read(&directory) else {
        return Ok(answer("skipped", Some("policyUnreadable"), None));
    };
    if settings.policy == Policy::Off {
        return Ok(answer("skipped", Some("policyOff"), None));
    }
    let Some(_held) = private_json::lock(&directory, app::LOCK)? else {
        return Ok(answer("skipped", Some("running"), None));
    };
    let now = Utc::now();
    let last = last_check(&directory);
    if due_at(&last, &settings, now) > now {
        return Ok(answer("skipped", Some("notDue"), None));
    }
    // Written before the network is used: if this process dies, or the answer cannot be written
    // below, the next check still waits. A state directory that cannot be written ends the run here.
    state::record_check(&directory, failed_check(&last, now, "interrupted"))?;
    let (code, result) =
        app::check_child(settings.channel, CHECK_DEADLINE).unwrap_or((-1, Value::Null));
    let latest = result["latest"]["version"]
        .as_str()
        .filter(|latest| version(latest).is_some());
    let (Some(latest), 0 | 10) = (latest, code) else {
        // A host that cannot reach the release server is not an error for a timer: it is recorded,
        // and the next check waits.
        let kind = app::kind(code);
        state::record_check(&directory, failed_check(&last, now, kind))?;
        let state = if code == 20 { "skipped" } else { "failed" };
        return Ok(answer(state, Some(kind), None));
    };
    let available = code == 10;
    state::record_check(
        &directory,
        json!({"at": app::stamp(now), "latest": latest, "available": available, "error": null}),
    )?;
    let answer = |state, reason| answer(state, reason, Some(latest));
    if !available || settings.policy != Policy::Install {
        return Ok(answer("checked", None));
    }
    // An installed version that cannot be read is a development build: never replaced behind its back.
    let installed = result["current"]["version"].as_str().and_then(version);
    if !installed.is_some_and(|installed| version(latest) > Some(installed)) {
        return Ok(answer("checked", Some("notNewer")));
    }
    if !settings.window_open() {
        return Ok(answer("skipped", Some("outsideWindow")));
    }
    if app::rolled_back_from(&directory, latest) {
        return Ok(answer("skipped", Some("rolledBack")));
    }
    let record = app::install_held(&directory, latest, settings.channel)?;
    Ok(match record.state() {
        app::State::Done => answer("updated", None),
        app::State::Failed => answer("failed", record.reason()),
        _ => answer("skipped", record.reason()),
    })
}
