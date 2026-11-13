//! `auto-update.json`: whether and how this companion updates itself. Absent means the defaults
//! (policy `install`, the stable channel, a check every 24 hours, any time of day) and creates
//! nothing. A file this companion does not fully understand is refused, never guessed at.
//!
//! A field is written only when it differs from its default, so a file that only turns the policy
//! off still reads for a companion older than this field (the schema refuses names it does not know).
use crate::update::{state, Channel};
use crate::{private_json, Error, Result};
use chrono::{DateTime, Local, Timelike, Utc};
use clap::{Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, str::FromStr};

mod app;
mod check;
mod timer;
pub use app::{trigger, State, Update, ENV as APP_VERSION_ENV};
pub use check::opportunistic;

const NAME: &str = "auto-update.json";
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const DEFAULT_INTERVAL_HOURS: u32 = 24;
const MAX_INTERVAL_HOURS: u32 = 720;

/// `off` never touches the network, `notify` never changes the executable, and `install` also lets a
/// newer lazysh app that connects update this companion to the app's own version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Off,
    Notify,
    Install,
}

/// The part of the day an install is allowed in, as local time of the host: `HH:MM-HH:MM`. An end
/// earlier than the start runs over midnight (`22:00-06:00`); equal ends would be all day or never.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    start: u16,
    end: u16,
}
impl Window {
    pub fn parse(text: &str) -> Option<Self> {
        let two_digits = |part: &str| {
            (part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_digit()))
                .then(|| part.parse::<u16>().ok())
                .flatten()
        };
        let minutes = |time: &str| {
            let (hour, minute) = time.split_once(':')?;
            let (hour, minute) = (two_digits(hour)?, two_digits(minute)?);
            (hour < 24 && minute < 60).then_some(hour * 60 + minute)
        };
        let (start, end) = text.split_once('-')?;
        let (start, end) = (minutes(start)?, minutes(end)?);
        (start != end).then_some(Self { start, end })
    }
    pub fn contains(self, minute_of_day: u16) -> bool {
        if self.start < self.end {
            (self.start..self.end).contains(&minute_of_day)
        } else {
            minute_of_day >= self.start || minute_of_day < self.end
        }
    }
    /// Is the host's own clock inside the window.
    fn is_open(self) -> bool {
        let now = Local::now();
        self.contains((now.hour() * 60 + now.minute()) as u16)
    }
}
impl std::fmt::Display for Window {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (start, end) = (self.start, self.end);
        write!(
            formatter,
            "{:02}:{:02}-{:02}:{:02}",
            start / 60,
            start % 60,
            end / 60,
            end % 60
        )
    }
}
impl Serialize for Window {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}
impl<'de> Deserialize<'de> for Window {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).ok_or_else(|| serde::de::Error::custom("expected HH:MM-HH:MM"))
    }
}
/// What `--window` names: a window, or `none` for no window at all.
#[derive(Clone, Copy)]
pub struct WindowChoice(Option<Window>);
impl FromStr for WindowChoice {
    type Err = String;
    fn from_str(text: &str) -> std::result::Result<Self, String> {
        if text == "none" {
            return Ok(Self(None));
        }
        Window::parse(text)
            .map(|window| Self(Some(window)))
            .ok_or_else(|| "expected HH:MM-HH:MM in the host's local time, or none".to_owned())
    }
}

fn default_interval() -> u32 {
    DEFAULT_INTERVAL_HOURS
}
fn is_default_interval(hours: &u32) -> bool {
    *hours == DEFAULT_INTERVAL_HOURS
}
fn is_stable(channel: &Channel) -> bool {
    *channel == Channel::Stable
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoUpdate {
    pub schema_version: u8,
    pub revision: u64,
    pub policy: Policy,
    #[serde(default, skip_serializing_if = "is_stable")]
    pub channel: Channel,
    #[serde(
        default = "default_interval",
        skip_serializing_if = "is_default_interval"
    )]
    pub interval_hours: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<Window>,
}
impl Default for AutoUpdate {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            policy: Policy::Install,
            channel: Channel::Stable,
            interval_hours: DEFAULT_INTERVAL_HOURS,
            window: None,
        }
    }
}
impl AutoUpdate {
    /// An install may start now: there is no window, or the host's clock is inside it.
    pub(crate) fn window_open(&self) -> bool {
        self.window.is_none_or(Window::is_open)
    }
    /// What readers (the app, `update --status`) are told: every setting, defaults included.
    pub fn view(&self) -> Value {
        json!({"schemaVersion": 1, "revision": self.revision, "policy": self.policy,
            "channel": self.channel, "intervalHours": self.interval_hours,
            "window": self.window.map(|window| window.to_string())})
    }
}

fn interval_in_range(hours: u32) -> bool {
    (1..=MAX_INTERVAL_HOURS).contains(&hours)
}

pub fn read(directory: &Path) -> Result<AutoUpdate> {
    let Some(bytes) = private_json::read(directory, NAME)? else {
        return Ok(AutoUpdate::default());
    };
    let found: AutoUpdate = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidArgument)?;
    if found.schema_version != 1
        || found.revision > MAX_REVISION
        || !interval_in_range(found.interval_hours)
    {
        return Err(Error::InvalidArgument);
    }
    Ok(found)
}

/// What `set` changes. The policy is always named; a setting left `None` keeps its value.
pub struct Change {
    pub policy: Policy,
    pub channel: Option<Channel>,
    pub interval_hours: Option<u32>,
    /// `Some(None)` removes the window.
    pub window: Option<Option<Window>>,
}

pub fn set(directory: &Path, expected_revision: u64, change: Change) -> Result<AutoUpdate> {
    if expected_revision >= MAX_REVISION || !change.interval_hours.is_none_or(interval_in_range) {
        return Err(Error::InvalidArgument);
    }
    let _held = private_json::lock(directory, "auto-update.lock")?
        .ok_or(Error::Settings("SettingsBusy"))?;
    let current = read(directory)?;
    if current.revision != expected_revision {
        return Err(Error::Settings("SettingsConflict"));
    }
    let next = AutoUpdate {
        revision: current.revision + 1,
        policy: change.policy,
        channel: change.channel.unwrap_or(current.channel),
        interval_hours: change.interval_hours.unwrap_or(current.interval_hours),
        window: change.window.unwrap_or(current.window),
        ..current
    };
    let bytes = serde_json::to_vec(&next).map_err(|_| Error::InvalidArgument)?;
    private_json::write(directory, NAME, &bytes)?;
    Ok(next)
}

/// The settings as `update --status` shows them, or `null` when the file cannot be read.
pub fn summary(directory: &Path) -> Value {
    read(directory).map_or(Value::Null, |settings| settings.view())
}

/// A stamp like `2026-11-13T10:00:00Z`, read back.
pub(crate) fn instant(text: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text.as_str()?)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

#[derive(Subcommand)]
pub enum Command {
    /// Show the settings, the last check and the last update an app started; creates no state.
    Status,
    /// Change the settings. `install` is the default for a companion with no file.
    Set {
        #[arg(long)]
        expected_revision: u64,
        #[arg(long, value_enum)]
        policy: Policy,
        /// Which releases a check looks at. Default stable.
        #[arg(long, value_enum)]
        channel: Option<Channel>,
        /// How often a check may use the network, 1 to 720. Default 24.
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..=MAX_INTERVAL_HOURS as i64))]
        interval_hours: Option<u32>,
        /// The part of the day an install may start in (the host's local time), or `none`.
        #[arg(long)]
        window: Option<WindowChoice>,
    },
    /// Install the operating system timer that wakes the companion hourly (a systemd user timer, a
    /// launchd agent or a Scheduled Task of this user; never `sudo`). Refuses while the policy is `off`.
    Enable,
    /// Remove that timer. Only what carries the lazysh marker is removed.
    Disable,
    /// One scheduled check, as the timer and the companion itself run it: records what it found
    /// and, under policy `install`, installs a newer release. Offline is not an error.
    Run {
        /// What a newer app starts: one update to the app's own version.
        #[arg(long, hide = true)]
        app_version: Option<String>,
    },
}
pub fn execute(command: Command) -> Result<Value> {
    let directory = crate::state_directory()?;
    let status = matches!(command, Command::Status);
    let settings = match command {
        Command::Run { app_version } => {
            return match app_version {
                Some(app_version) => app::run(&app_version),
                None => check::run(),
            }
        }
        Command::Enable => return timer::enable(&read(&directory)?),
        Command::Disable => return timer::disable(),
        Command::Status => read(&directory)?,
        Command::Set {
            expected_revision,
            policy,
            channel,
            interval_hours,
            window,
        } => set(
            &directory,
            expected_revision,
            Change {
                policy,
                channel,
                interval_hours,
                window: window.map(|choice| choice.0),
            },
        )?,
    };
    let mut output = settings.view();
    output["appUpdate"] = app::recorded(&directory);
    output["lastCheck"] = state::State::read(&directory)
        .last_check
        .unwrap_or(Value::Null);
    output["nextCheckAt"] = check::next(&directory, &settings, Utc::now()).into();
    if status {
        output["timer"] = timer::status();
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(policy: Policy) -> Change {
        Change {
            policy,
            channel: None,
            interval_hours: None,
            window: None,
        }
    }

    #[test]
    fn a_host_with_no_file_installs_and_reading_creates_nothing() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        assert_eq!(read(&state).unwrap(), AutoUpdate::default());
        assert_eq!(read(&state).unwrap().policy, Policy::Install);
        assert!(!state.exists());
    }
    #[test]
    fn setting_needs_the_current_revision_and_bumps_it() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        assert_eq!(set(&state, 0, change(Policy::Off)).unwrap().revision, 1);
        assert!(matches!(
            set(&state, 0, change(Policy::Notify)),
            Err(Error::Settings("SettingsConflict"))
        ));
        assert_eq!(read(&state).unwrap().policy, Policy::Off);
    }
    #[test]
    fn a_setting_that_is_left_out_keeps_its_value_and_defaults_are_not_written() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let window = Window::parse("22:00-06:00").unwrap();
        set(
            &state,
            0,
            Change {
                channel: Some(Channel::Prerelease),
                interval_hours: Some(6),
                window: Some(Some(window)),
                ..change(Policy::Notify)
            },
        )
        .unwrap();
        let kept = set(&state, 1, change(Policy::Install)).unwrap();
        assert_eq!(
            (kept.channel, kept.interval_hours, kept.window),
            (Channel::Prerelease, 6, Some(window))
        );
        let cleared = set(
            &state,
            2,
            Change {
                channel: Some(Channel::Stable),
                interval_hours: Some(24),
                window: Some(None),
                ..change(Policy::Off)
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(state.join(NAME)).unwrap().trim(),
            r#"{"schemaVersion":1,"revision":3,"policy":"off"}"#
        );
        assert_eq!(read(&state).unwrap(), cleared);
    }
    #[test]
    fn a_file_with_a_field_this_companion_does_not_know_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        set(&state, 0, change(Policy::Off)).unwrap();
        std::fs::write(
            state.join(NAME),
            br#"{"schemaVersion":1,"revision":1,"policy":"off","metered":false}"#,
        )
        .unwrap();
        assert!(read(&state).is_err());
    }
    #[test]
    fn an_interval_or_window_out_of_range_is_refused_when_read_and_when_set() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        for hours in [0, 721] {
            let change = Change {
                interval_hours: Some(hours),
                ..change(Policy::Off)
            };
            assert!(set(&state, 0, change).is_err(), "{hours}");
        }
        set(&state, 0, change(Policy::Off)).unwrap();
        for contents in [
            r#"{"schemaVersion":1,"revision":1,"policy":"off","intervalHours":0}"#,
            r#"{"schemaVersion":1,"revision":1,"policy":"off","intervalHours":721}"#,
            r#"{"schemaVersion":1,"revision":1,"policy":"off","window":"25:00-06:00"}"#,
            r#"{"schemaVersion":1,"revision":1,"policy":"off","window":"06:00-06:00"}"#,
        ] {
            std::fs::write(state.join(NAME), contents).unwrap();
            assert!(read(&state).is_err(), "{contents}");
        }
    }
    #[test]
    fn a_window_may_run_over_midnight_and_only_accepts_two_digit_clock_times() {
        let day = Window::parse("09:00-17:30").unwrap();
        assert!(day.contains(9 * 60) && day.contains(17 * 60 + 29));
        assert!(!day.contains(8 * 60 + 59) && !day.contains(17 * 60 + 30));
        let night = Window::parse("22:00-06:00").unwrap();
        assert!(night.contains(23 * 60) && night.contains(0) && night.contains(5 * 60 + 59));
        assert!(!night.contains(6 * 60) && !night.contains(21 * 60 + 59));
        for text in [
            "",
            "9:00-17:00",
            "09:00",
            "09:00-09:00",
            "24:00-01:00",
            "09:60-10:00",
            "+9:00-10:00",
            "09:00-10:00-11:00",
            "09:00 - 10:00",
        ] {
            assert_eq!(Window::parse(text), None, "{text:?}");
        }
        assert_eq!(night.to_string(), "22:00-06:00");
    }
}
