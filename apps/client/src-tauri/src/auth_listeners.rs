//! Does the host listen where a sign-in hint says it will (ADR 0004, detection tier 1; #1510)?
//!
//! `check_auth_listener` asks the host for the listeners on one port, once. The app calls it while a
//! hint is young and turns the answer into a state; nothing here forwards or opens anything. The
//! host companion's `lazysh-agent listeners` answers with the owner and the age of the listening
//! process. A host whose companion predates it (exit status 2, or no companion at all) is asked the
//! way Previews asks, with `ss` or `lsof`, which reports no age.
use crate::{
    app_lock::{AccessLease, Guarded, GuardedError},
    previews,
    ssh::{self, AppState, SshError},
};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

type Protected<T> = std::result::Result<Guarded<T>, GuardedError<SshError>>;

/// Printed by the `required_command` wrapper when the host has no `listeners` subcommand.
pub(crate) const COMPANION_REQUIRED: &str = "lazysh-listeners-companion-required-v1";
/// A listener whose process started up to this long before the hint is the sign-in's own...
const STARTED_BEFORE: i64 = 120;
/// ...or one that appears up to this long after it.
const STARTED_AFTER: i64 = 30;
/// A bound on what is read from the companion: one port holds a handful of sockets.
const MAX_SNAPSHOT: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    /// `companion` (the host's `lazysh-agent listeners`) or `fallback` (`ss` or `lsof`: no age).
    pub source: &'static str,
    /// `loopback` or `wildcard`.
    pub bind: &'static str,
    pub owned_by_session_user: bool,
    /// How long the owning process had run when it was read, on the host's clock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    /// Nothing listens on the port yet.
    Absent,
    /// A listener whose process started within 120 s before the hint or 30 s after it.
    Confirmed,
    /// A listener whose age the host cannot tell (a companion without `listeners`, or Windows). The
    /// app confirms it only if it saw the port empty first.
    Unproven,
    /// A listener exists but its process is older or newer than that: not the sign-in's own server,
    /// or a long-lived program that opened a port. Offered only with an explicit allow.
    Stale,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub state: Presence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listener: Option<Listener>,
}

/// `hint_age` is how long ago the hint was seen, on the device; `listener.age_seconds` how long the
/// process had run, on the host. Both are durations, so no clock has to agree with another.
pub(crate) fn decide(listener: Option<Listener>, hint_age: u64) -> Verdict {
    let state = match &listener {
        None => Presence::Absent,
        Some(Listener {
            age_seconds: None, ..
        }) => Presence::Unproven,
        Some(Listener {
            age_seconds: Some(age),
            ..
        }) => {
            let started_after_hint = i64::try_from(hint_age).unwrap_or(i64::MAX)
                - i64::try_from(*age).unwrap_or(i64::MAX);
            if (-STARTED_BEFORE..=STARTED_AFTER).contains(&started_after_hint) {
                Presence::Confirmed
            } else {
                Presence::Stale
            }
        }
    };
    Verdict { state, listener }
}

/// The best entry for `port` in the first line of a `lazysh-agent listeners --json` answer: one the
/// session user owns first. Anything that is not the documented shape is no answer.
pub(crate) fn from_companion(text: &str, port: u16) -> Option<Option<Listener>> {
    let snapshot: Value = serde_json::from_str(text.lines().next()?).ok()?;
    if snapshot["schemaVersion"] != 1 || snapshot["event"] != "snapshot" {
        return None;
    }
    let mut best: Option<Listener> = None;
    for entry in snapshot["listeners"].as_array()? {
        if entry["port"].as_u64() != Some(u64::from(port)) {
            continue;
        }
        let listener = Listener {
            source: "companion",
            bind: if entry["bind"] == "loopback" {
                "loopback"
            } else {
                "wildcard"
            },
            owned_by_session_user: entry["ownedBySessionUser"] == true,
            age_seconds: entry["ageSeconds"].as_u64(),
            comm: entry["comm"]
                .as_str()
                .filter(|name| name.len() <= 256)
                .map(Into::into),
            pid: entry["pid"]
                .as_u64()
                .and_then(|pid| u32::try_from(pid).ok()),
        };
        if best
            .as_ref()
            .is_none_or(|current| !current.owned_by_session_user && listener.owned_by_session_user)
        {
            best = Some(listener);
        }
    }
    Some(best)
}

/// `ss -p` and `lsof` show a process only for the user's own sockets, so a named process is ours.
pub(crate) fn from_fallback(listeners: Vec<previews::Listener>, port: u16) -> Option<Listener> {
    listeners
        .into_iter()
        .filter(|listener| listener.port == port)
        .map(|listener| Listener {
            source: "fallback",
            bind: if listener.address.starts_with("127.") || listener.address.contains("::1") {
                "loopback"
            } else {
                "wildcard"
            },
            owned_by_session_user: listener.process.is_some(),
            age_seconds: None,
            comm: listener.process,
            pid: listener.pid,
        })
        .max_by_key(|listener| listener.owned_by_session_user)
}

/// Asks the host about `port`. `seen_seconds_ago` is the age of the hint on the device.
#[tauri::command]
pub async fn check_auth_listener(
    access: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    port: u16,
    seen_seconds_ago: u64,
) -> Protected<Verdict> {
    access
        .run(async {
            if port < 1024 {
                return Err(SshError::new(
                    "invalid_port",
                    "Enter a port from 1024 to 65535",
                ));
            }
            let session = state.session(&session_id).await?;
            access.check()?;
            let command = crate::companion::required_command(
                &session,
                format!("lazysh-agent listeners --json --port {port}"),
                COMPANION_REQUIRED,
                &access,
            )
            .await?;
            let answer = match ssh::exec_bounded(
                &session,
                command,
                &access,
                ssh::OP_TIMEOUT,
                MAX_SNAPSHOT,
                None,
            )
            .await
            {
                Ok(text) if text.trim() == COMPANION_REQUIRED => None,
                Ok(text) => from_companion(&text, port),
                // A companion that fails (older, broken, or no `lsof` for it) is not a reason to
                // give up: `ss` may still answer. Anything else (timeout, lock, closed) is an error.
                Err(error) if error.kind() == "remote_command_failed" => None,
                Err(error) => return Err(error),
            };
            let listener = match answer {
                Some(listener) => listener,
                None => from_fallback(previews::host_listeners(&session, &access).await?, port),
            };
            Ok(decide(listener, seen_seconds_ago))
        })
        .await
}

#[cfg(test)]
mod tests;
