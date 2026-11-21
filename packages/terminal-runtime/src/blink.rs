//! The host's blink timer and frame pacing (#1326, #1324): both pure functions of a monotonic clock.
//!
//! # Cursor blink, one timer for every session
//!
//! A renderer is never asked to animate: the phase is host state ([`crate::Overlay::cursor_phase_on`]),
//! and a phase change redraws one row of a renderer whose cursor blinks. What needs care is the
//! timer. [`BlinkClock`] derives the phase from the time alone, so every session is in the same
//! phase and one timer serves all of them: [`BlinkClock::next_wake`] is the earliest instant any
//! renderer needs, and `None` while none shows a blinking cursor, so a steady cursor, a hidden or
//! suspended surface and an idle terminal arm no timer and wake nothing.
//!
//! Time is a [`Duration`] on a monotonic clock of the host's choosing, so the logic runs under
//! test without sleeping.
//!
//! # Frame pacing
//!
//! [`FramePacer`] decides when the host draws: never while nothing changed, and at most once per
//! display refresh while something did, so a burst of output between two refreshes costs one frame.
//! A host driven by a display callback (Choreographer, a display link) is paced by the platform and
//! only asks `needs_draw`; one with a timer uses the pacer, and a refresh-rate change (a window
//! moved to another display, a battery mode) is `set_refresh_hz`.

use crate::render::TerminalRenderer;
use std::time::Duration;

/// How long the cursor stays in each phase (a 1.06 s period, like most terminals).
pub const BLINK_HALF_PERIOD: Duration = Duration::from_millis(530);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlinkClock {
    half_period: Duration,
    /// When the cursor last turned on, e.g. at a key press: typing shows the cursor.
    origin: Duration,
}

impl BlinkClock {
    /// A clock whose first phase (on) starts at `now`. A zero half period is raised to a millisecond.
    pub fn new(half_period: Duration, now: Duration) -> Self {
        Self {
            half_period: half_period.max(Duration::from_millis(1)),
            origin: now,
        }
    }

    /// The cursor turns on at `now`, and the next change is one half period later.
    pub fn restart(&mut self, now: Duration) {
        self.origin = now;
    }

    fn phases(&self, now: Duration) -> u128 {
        now.saturating_sub(self.origin).as_nanos() / self.half_period.as_nanos()
    }

    pub fn phase_on(&self, now: Duration) -> bool {
        self.phases(now).is_multiple_of(2)
    }

    /// The first instant after `now` at which the phase changes.
    pub fn next_toggle(&self, now: Duration) -> Duration {
        let next = self.phases(now) + 1;
        self.origin + Duration::from_nanos((self.half_period.as_nanos() * next) as u64)
    }

    /// When the host's single timer must fire next for these renderers: `None` when none of them
    /// shows a blinking cursor.
    pub fn next_wake<'a, R: TerminalRenderer + 'a>(
        &self,
        now: Duration,
        renderers: impl IntoIterator<Item = &'a R>,
    ) -> Option<Duration> {
        renderers
            .into_iter()
            .any(|r| r.wants_blink_timer())
            .then(|| self.next_toggle(now))
    }
}

/// Coalesces draws to at most one per display refresh and none while idle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FramePacer {
    period: Duration,
    last: Option<Duration>,
}

impl FramePacer {
    /// A pacer for a display of `refresh_hz` (clamped to 1 through 1000).
    pub fn new(refresh_hz: u32) -> Self {
        Self {
            period: Self::period_of(refresh_hz),
            last: None,
        }
    }

    fn period_of(refresh_hz: u32) -> Duration {
        Duration::from_nanos(1_000_000_000 / u64::from(refresh_hz.clamp(1, 1000)))
    }

    /// The display's refresh rate changed; the next frame is paced by the new period.
    pub fn set_refresh_hz(&mut self, refresh_hz: u32) {
        self.period = Self::period_of(refresh_hz);
    }

    pub fn period(&self) -> Duration {
        self.period
    }

    /// When the host should draw next: `None` while nothing needs drawing (arm no timer), else the
    /// earliest instant at or after `now` that is a full period after the previous frame.
    pub fn next_frame(&self, now: Duration, needs_draw: bool) -> Option<Duration> {
        needs_draw.then(|| self.last.map_or(now, |last| (last + self.period).max(now)))
    }

    /// A frame was drawn at `at`.
    pub fn drew(&mut self, at: Duration) {
        self.last = Some(at);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    #[test]
    fn the_phase_alternates_every_half_period_starting_on() {
        let clock = BlinkClock::new(MS(500), MS(1_000));
        let on: Vec<_> = [1_000, 1_499, 1_500, 1_999, 2_000, 2_500]
            .into_iter()
            .map(|t| clock.phase_on(MS(t)))
            .collect();
        assert_eq!(on, [true, true, false, false, true, false]);
    }

    #[test]
    fn the_next_toggle_is_strictly_later_and_on_the_grid() {
        let clock = BlinkClock::new(MS(500), MS(1_000));
        assert_eq!(clock.next_toggle(MS(1_000)), MS(1_500));
        assert_eq!(clock.next_toggle(MS(1_499)), MS(1_500));
        assert_eq!(clock.next_toggle(MS(1_500)), MS(2_000));
        assert_eq!(clock.next_toggle(MS(3_700)), MS(4_000));
    }

    #[test]
    fn typing_restarts_the_phase_and_a_time_before_the_origin_is_the_first_phase() {
        let mut clock = BlinkClock::new(MS(500), MS(0));
        assert!(!clock.phase_on(MS(600)));
        clock.restart(MS(600));
        assert!(clock.phase_on(MS(600)) && clock.phase_on(MS(1_099)));
        assert_eq!(clock.next_toggle(MS(600)), MS(1_100));
        assert!(
            clock.phase_on(MS(100)),
            "before the origin counts as just started"
        );
    }

    #[test]
    fn a_zero_period_does_not_divide_by_zero() {
        let clock = BlinkClock::new(Duration::ZERO, Duration::ZERO);
        assert_eq!(clock.next_toggle(Duration::ZERO), MS(1));
    }

    #[test]
    fn a_burst_within_one_refresh_costs_one_frame_and_idle_costs_none() {
        let mut pacer = FramePacer::new(60);
        let period = pacer.period();
        assert_eq!(
            pacer.next_frame(MS(0), false),
            None,
            "nothing to draw, no timer"
        );
        assert_eq!(
            pacer.next_frame(MS(5), true),
            Some(MS(5)),
            "the first frame is immediate"
        );
        pacer.drew(MS(5));
        // Output keeps arriving; every request lands on the same frame boundary.
        let due: std::collections::BTreeSet<_> = (6..20)
            .filter_map(|t| pacer.next_frame(MS(t), true))
            .collect();
        assert_eq!(
            due,
            [MS(5) + period].into(),
            "one frame for the whole burst"
        );
        assert_eq!(
            pacer.next_frame(MS(100), true),
            Some(MS(100)),
            "a late request is not delayed"
        );
        pacer.drew(MS(100));
        assert_eq!(pacer.next_frame(MS(101), false), None);
    }

    #[test]
    fn a_refresh_rate_change_changes_the_next_interval() {
        let mut pacer = FramePacer::new(60);
        pacer.drew(MS(0));
        let at60 = pacer.next_frame(MS(1), true).unwrap();
        pacer.set_refresh_hz(120);
        let at120 = pacer.next_frame(MS(1), true).unwrap();
        assert!(at120 < at60 && at120 == Duration::from_nanos(1_000_000_000 / 120));
        pacer.set_refresh_hz(0);
        assert_eq!(
            pacer.period(),
            Duration::from_secs(1),
            "an absurd rate is clamped"
        );
        pacer.set_refresh_hz(u32::MAX);
        assert_eq!(pacer.period(), Duration::from_millis(1));
    }
}
