//! Which lifecycle events may queue a relay notification on this host. Both switches default to off,
//! which is the behavior before they existed. They live in their own `notification-policy.json`, with
//! their own revision: an older companion sharing the state directory reads `settings.json` with
//! `deny_unknown_fields` and would refuse a new field there.
use crate::{
    desktop_lock::{self, Desktop},
    nested_agent, private_json, Agent, Error, Result, Store,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationPolicy {
    pub schema_version: u8,
    pub revision: u64,
    pub nested_agent_suppression_enabled: bool,
    pub suppress_while_desktop_unlocked: bool,
}
impl Default for NotificationPolicy {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            nested_agent_suppression_enabled: false,
            suppress_while_desktop_unlocked: false,
        }
    }
}

/// Absent policy returns the defaults without creating any file.
pub fn read(directory: &Path) -> Result<NotificationPolicy> {
    let Some(bytes) = private_json::read(directory, "notification-policy.json")? else {
        return Ok(NotificationPolicy::default());
    };
    let policy: NotificationPolicy =
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidArgument)?;
    if policy.schema_version != 1 || policy.revision > MAX_REVISION {
        return Err(Error::InvalidArgument);
    }
    Ok(policy)
}

pub fn update(
    directory: &Path,
    expected_revision: u64,
    nested_agent_suppression_enabled: bool,
    suppress_while_desktop_unlocked: bool,
) -> Result<NotificationPolicy> {
    if expected_revision >= MAX_REVISION {
        return Err(Error::InvalidArgument);
    }
    let _lock = private_json::lock(directory, "notification-policy.lock")?
        .ok_or(Error::Settings("NotificationPolicyBusy"))?;
    let current = read(directory)?;
    if current.revision != expected_revision {
        return Err(Error::Settings("NotificationPolicyConflict"));
    }
    let policy = NotificationPolicy {
        revision: current.revision + 1,
        nested_agent_suppression_enabled,
        suppress_while_desktop_unlocked,
        ..current
    };
    private_json::write(
        directory,
        "notification-policy.json",
        &serde_json::to_vec(&policy).map_err(|_| Error::InvalidArgument)?,
    )?;
    Ok(policy)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    NestedAgent,
    DesktopUnlocked,
}
/// What an event may do to the relay outbox. The event itself is always recorded locally.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Queue,
    Skip(Reason),
}

/// What this host can observe. Tests supply their own.
pub trait Environment {
    fn nested(&self, owner: Agent) -> bool;
    fn desktop(&self) -> Desktop;
}
pub struct System;
impl Environment for System {
    fn nested(&self, owner: Agent) -> bool {
        nested_agent::system(owner)
    }
    fn desktop(&self) -> Desktop {
        desktop_lock::system()
    }
}

/// An unreadable policy file counts as no policy: lifecycle events must not fail over a preference.
/// `settings notifications show` is where a malformed file is reported. An unknown or locked desktop
/// and an undetected nesting never suppress.
pub fn admission(directory: &Path, owner: Agent, environment: &dyn Environment) -> Admission {
    let policy = read(directory).unwrap_or_default();
    if policy.nested_agent_suppression_enabled && environment.nested(owner) {
        Admission::Skip(Reason::NestedAgent)
    } else if policy.suppress_while_desktop_unlocked && environment.desktop() == Desktop::Unlocked {
        Admission::Skip(Reason::DesktopUnlocked)
    } else {
        Admission::Queue
    }
}

impl Store {
    /// Skips the process and session probes when no relay would take the event anyway.
    pub fn admission(
        &self,
        directory: &Path,
        owner: Agent,
        environment: &dyn Environment,
    ) -> Result<Admission> {
        Ok(if self.relay_enabled()? {
            admission(directory, owner, environment)
        } else {
            Admission::Queue
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Host(bool, Desktop);
    impl Environment for Host {
        fn nested(&self, _: Agent) -> bool {
            self.0
        }
        fn desktop(&self) -> Desktop {
            self.1
        }
    }
    fn decide(nested: bool, unlocked: bool, host: Host) -> Admission {
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        update(&state, 0, nested, unlocked).unwrap();
        admission(&state, Agent::Codex, &host)
    }

    #[test]
    fn nested_suppression_follows_its_switch() {
        let nested = Host(true, Desktop::Unknown);
        assert_eq!(
            decide(true, false, nested),
            Admission::Skip(Reason::NestedAgent)
        );
        assert_eq!(
            decide(false, false, Host(true, Desktop::Unknown)),
            Admission::Queue
        );
        assert_eq!(
            decide(true, false, Host(false, Desktop::Unknown)),
            Admission::Queue
        );
    }

    #[test]
    fn only_a_known_unlocked_desktop_suppresses_and_only_with_the_switch_on() {
        for (desktop, expected) in [
            (Desktop::Unlocked, Admission::Skip(Reason::DesktopUnlocked)),
            (Desktop::Locked, Admission::Queue),
            (Desktop::Unknown, Admission::Queue),
        ] {
            assert_eq!(decide(false, true, Host(false, desktop)), expected);
            assert_eq!(decide(false, false, Host(false, desktop)), Admission::Queue);
        }
    }

    #[test]
    fn no_file_or_an_unreadable_one_leaves_notifications_as_they_were() {
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        let host = Host(true, Desktop::Unlocked);
        assert_eq!(admission(&state, Agent::Codex, &host), Admission::Queue);
        update(&state, 0, true, true).unwrap();
        assert_eq!(
            admission(&state, Agent::Codex, &host),
            Admission::Skip(Reason::NestedAgent)
        );
        // Written through the same private file API so only the content is wrong.
        private_json::write(&state, "notification-policy.json", b"{\"schemaVersion\":2}").unwrap();
        assert!(read(&state).is_err());
        assert_eq!(admission(&state, Agent::Codex, &host), Admission::Queue);
    }
}
