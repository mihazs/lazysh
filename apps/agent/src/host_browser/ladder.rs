//! The quality ladder: how much the relay asks of the browser for a given link and device
//! (docs/host-browser.md, "Performance").
//!
//! Four rungs, each a JPEG quality, a frame size and a frame divisor. The relay sees every frame the browser
//! produces (it acknowledges the browser at once) and every frame the device acknowledges after decoding it, and
//! at most two frames are unacknowledged, so the acknowledgement rate is the window over the acknowledgement time:
//! it already holds the link's goodput and round trip and the phone's decode time. A rung **fits** while the
//! device acknowledges most of what the page produces, or at least [`USEFUL_FPS`] frames a second.
//!
//! The controller is pure: the caller passes the time in, so the tests below run it on a virtual clock.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// How long a rung is observed before it is judged: a problem is answered within a second.
const WINDOW: Duration = Duration::from_millis(800);
/// A window with fewer produced frames than this is an idle page, which costs nothing and proves nothing.
const MIN_FRAMES: u32 = 4;
/// The rate at which a stream is useful to look at; a page that produces less is only held to what it produces.
const USEFUL_FPS: f32 = 15.0;
/// The share of the wanted rate the device must acknowledge for a rung to fit.
const FIT: f32 = 0.8;
/// A rung that kept fitting this long is left for the next one up; if that one does not fit, it is left again
/// within a window.
// shortcut: a link that cannot hold the next rung retries it every ten seconds, at the cost of one bad window;
// upgrade with a back-off if measurements on real networks show the retry is noticeable.
const STABLE: Duration = Duration::from_secs(10);
/// Full frame rate after input, then back to the ladder.
const BOOST: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Rung {
    High,
    Balanced,
    Low,
    Minimal,
}
impl Rung {
    const ALL: [Self; 4] = [Self::High, Self::Balanced, Self::Low, Self::Minimal];

    fn index(self) -> usize {
        Self::ALL.iter().position(|rung| *rung == self).unwrap_or(0)
    }
    fn higher(self) -> Option<Self> {
        self.index().checked_sub(1).map(|index| Self::ALL[index])
    }
    fn lower(self) -> Option<Self> {
        Self::ALL.get(self.index() + 1).copied()
    }

    /// The measured examples of the specification: q60 full size every frame, q40 every third frame, q35 at
    /// 75 percent size every sixth frame, and one rung between the first two.
    pub fn screencast(self) -> Screencast {
        let (quality, percent, every_nth) = match self {
            Self::High => (60, 100, 1),
            Self::Balanced => (50, 100, 2),
            Self::Low => (40, 100, 3),
            Self::Minimal => (35, 75, 6),
        };
        Screencast {
            quality,
            percent,
            every_nth,
        }
    }
}

/// What a client asks of the ladder: adapt, or hold one rung (Data saver holds [`Rung::Minimal`]).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Auto,
    High,
    Balanced,
    Low,
    Minimal,
}
impl Choice {
    fn rung(self) -> Option<Rung> {
        match self {
            Self::Auto => None,
            Self::High => Some(Rung::High),
            Self::Balanced => Some(Rung::Balanced),
            Self::Low => Some(Rung::Low),
            Self::Minimal => Some(Rung::Minimal),
        }
    }
}

/// The parameters of one `Page.startScreencast`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Screencast {
    pub quality: u8,
    /// The frame's size as a percentage of the page's size in device pixels.
    pub percent: u32,
    pub every_nth: u32,
}

pub struct Ladder {
    rung: Rung,
    pinned: Option<Rung>,
    /// What the browser was last told, so a change is applied once.
    applied: Screencast,
    /// The frames the browser produced and the device acknowledged since `window`.
    window: Instant,
    produced: u32,
    delivered: u32,
    /// When the rung last changed or the link last failed to keep up.
    settled: Instant,
    boost_until: Option<Instant>,
}
impl Ladder {
    pub fn new(now: Instant) -> Self {
        Self {
            rung: Rung::High,
            pinned: None,
            applied: Rung::High.screencast(),
            window: now,
            produced: 0,
            delivered: 0,
            settled: now,
            boost_until: None,
        }
    }

    /// The rung the device sees (a pinned one, else the adaptive one) and whether it is pinned.
    pub fn rung(&self) -> (Rung, bool) {
        (self.pinned.unwrap_or(self.rung), self.pinned.is_some())
    }

    fn wanted(&self, now: Instant) -> Screencast {
        let screencast = self.rung().0.screencast();
        // A pinned rung is the user's choice to save data: input does not raise the rate.
        if self.pinned.is_none() && self.boost_until.is_some_and(|until| now < until) {
            return Screencast {
                every_nth: 1,
                ..screencast
            };
        }
        screencast
    }

    fn restart(&mut self, now: Instant) {
        (self.window, self.produced, self.delivered) = (now, 0, 0);
    }

    /// The parameters to start the screencast with (at the start and when the view is shown again).
    pub fn apply(&mut self, now: Instant) -> Screencast {
        self.applied = self.wanted(now);
        // A restarted or resumed screencast has not yet demonstrated a fitting link.
        self.settled = now;
        self.restart(now);
        self.applied
    }

    /// The browser produced a frame.
    pub fn produced(&mut self) {
        self.produced += 1;
    }
    /// The device acknowledged a frame it decoded.
    pub fn delivered(&mut self) {
        self.delivered += 1;
    }
    /// Accepted input: full frame rate for [`BOOST`].
    pub fn input(&mut self, now: Instant) {
        self.boost_until = Some(now + BOOST);
    }
    pub fn choose(&mut self, choice: Choice, now: Instant) {
        if self.pinned == choice.rung() {
            return;
        }
        self.pinned = choice.rung();
        if let Some(rung) = self.pinned {
            self.rung = rung;
        } else {
            // Adapting again starts from the top and is judged within a window.
            self.rung = Rung::High;
        }
        self.settled = now;
        self.restart(now);
    }

    /// Judge the window when it is over and return the parameters to switch the screencast to, if they changed.
    pub fn tick(&mut self, now: Instant) -> Option<Screencast> {
        let boosted = self.boost_until.is_some_and(|until| now < until);
        if boosted || self.pinned.is_some() {
            // Full rate is not the ladder's rate, and a pinned rung is not judged.
            self.settled = now;
            self.restart(now);
        } else if now.duration_since(self.window) >= WINDOW {
            self.judge(now);
        }
        let wanted = self.wanted(now);
        (wanted != self.applied).then(|| self.apply(now))
    }

    fn judge(&mut self, now: Instant) {
        let seconds = now.duration_since(self.window).as_secs_f32();
        if self.produced < MIN_FRAMES {
            // Silence cannot demonstrate link recovery or count towards a measured fitting interval.
            self.settled = now;
            self.restart(now);
            return;
        }
        let wanted = (self.produced as f32 / seconds).min(USEFUL_FPS);
        let fits = self.delivered as f32 / seconds >= FIT * wanted;
        self.restart(now);
        if !fits {
            self.settled = now;
            self.rung = self.rung.lower().unwrap_or(self.rung);
        } else if now.duration_since(self.settled) >= STABLE {
            if let Some(higher) = self.rung.higher() {
                self.settled = now;
                self.rung = higher;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    /// A virtual clock in steps of 100 ms around a ladder.
    struct Sim {
        ladder: Ladder,
        start: Instant,
        ticks: u32,
    }
    impl Sim {
        fn new() -> Self {
            let start = Instant::now();
            Self {
                ladder: Ladder::new(start),
                start,
                ticks: 0,
            }
        }
        fn now(&self) -> Instant {
            self.start + Duration::from_millis(u64::from(self.ticks) * 100)
        }
        /// `seconds` of a page that produces `produced` frames a second while the device acknowledges
        /// `delivered` a second. Returns what the ladder asked for and when, since the start.
        fn run(
            &mut self,
            seconds: u32,
            produced: u32,
            delivered: u32,
        ) -> Vec<(Duration, Screencast)> {
            let mut changes = Vec::new();
            for tick in 0..seconds * 10 {
                let share = |rate: u32| rate * (tick % 10 + 1) / 10 - rate * (tick % 10) / 10;
                (0..share(produced)).for_each(|_| self.ladder.produced());
                (0..share(delivered)).for_each(|_| self.ladder.delivered());
                self.ticks += 1;
                if let Some(screencast) = self.ladder.tick(self.now()) {
                    changes.push((self.now() - self.start, screencast));
                }
            }
            changes
        }
        fn rung(&self) -> (Rung, bool) {
            self.ladder.rung()
        }
    }

    #[test]
    fn a_link_that_cannot_keep_up_steps_down_within_a_second_and_stops_at_the_lowest_rung() {
        let mut sim = Sim::new();
        // 60 frames a second produced, 3 acknowledged: the 1.5 Mbit/s link with 150 ms of round trip.
        let changes = sim.run(6, 60, 3);
        let divisors: Vec<_> = changes.iter().map(|(_, s)| s.every_nth).collect();
        assert_eq!(divisors, [2, 3, 6]);
        assert!(
            changes[0].0 <= SECOND,
            "the first step took {:?}",
            changes[0].0
        );
        assert!(changes[2].0 <= 5 * SECOND, "{changes:?}");
        assert_eq!(sim.rung(), (Rung::Minimal, false));
    }

    #[test]
    fn a_link_that_keeps_up_stays_where_it_is() {
        let mut sim = Sim::new();
        // 30 of 60 acknowledged is more than the 15 a second that is useful.
        assert!(sim.run(9, 60, 30).is_empty());
        assert_eq!(sim.rung(), (Rung::High, false));
    }

    #[test]
    fn a_slow_page_is_held_to_what_it_produces_and_an_idle_page_is_not_judged() {
        let mut sim = Sim::new();
        assert!(
            sim.run(3, 10, 10).is_empty(),
            "a page that is fully delivered"
        );
        assert!(sim.run(3, 0, 0).is_empty(), "a page that produces nothing");
        assert!(
            !sim.run(2, 10, 2).is_empty(),
            "a page that is mostly not delivered"
        );
        let degraded = sim.rung();
        assert!(
            sim.run(20, 0, 0).is_empty(),
            "idle windows do not prove recovery"
        );
        assert_eq!(sim.rung(), degraded);
        assert!(
            sim.run(9, 60, 30).is_empty(),
            "idle time cannot count towards recovery"
        );
        assert_eq!(
            sim.run(2, 60, 30).len(),
            1,
            "measured recovery still promotes"
        );
    }

    #[test]
    fn a_rung_is_left_for_the_next_one_up_after_ten_stable_seconds_and_a_failed_probe_comes_back() {
        let mut sim = Sim::new();
        sim.run(3, 60, 3);
        assert_eq!(sim.rung().0, Rung::Minimal);
        // The link recovered at 3 s; the last step down was at 2.4 s.
        assert!(
            sim.run(9, 60, 30).is_empty(),
            "stepped up before ten stable seconds"
        );
        let changes = sim.run(2, 60, 30);
        assert_eq!(changes.len(), 1, "{changes:?}");
        assert_eq!(changes[0].1, Rung::Low.screencast());
        // The probe fails: the rung before it is back within two windows.
        let changes = sim.run(2, 60, 3);
        assert_eq!(changes.len(), 1, "{changes:?}");
        assert_eq!(changes[0].1, Rung::Minimal.screencast());
    }

    #[test]
    fn input_gives_every_frame_for_two_seconds_without_being_judged_and_then_returns_to_the_rung() {
        let mut sim = Sim::new();
        sim.run(3, 60, 3);
        let touched = sim.now();
        sim.ladder.input(touched);
        let changes = sim.run(4, 60, 3);
        // The full rate, which this link cannot carry, did not step the ladder down, and the rung it returns
        // to is the one it left.
        let divisors: Vec<_> = changes.iter().map(|(_, s)| s.every_nth).collect();
        assert_eq!(divisors, [1, 6]);
        assert_eq!(changes[0].1.quality, Rung::Minimal.screencast().quality);
        assert_eq!(changes[1].0, 3 * SECOND + BOOST);
        assert_eq!(sim.rung(), (Rung::Minimal, false));
    }

    #[test]
    fn boosted_and_resumed_time_do_not_prove_link_recovery() {
        let mut sim = Sim::new();
        sim.run(3, 60, 3);
        assert_eq!(sim.rung().0, Rung::Minimal);
        sim.run(9, 60, 30);
        sim.ladder.input(sim.now());
        sim.run(2, 60, 30);
        sim.run(1, 60, 30);
        assert_eq!(sim.rung().0, Rung::Minimal, "boost is not fitting evidence");
        sim.run(10, 60, 30);
        assert_eq!(sim.rung().0, Rung::Low);
        // Apply is also used when a paused stream resumes after a long absence.
        sim.ticks += 200;
        sim.ladder.apply(sim.now());
        sim.run(1, 60, 30);
        assert_eq!(
            sim.rung().0,
            Rung::Low,
            "paused time is not fitting evidence"
        );
    }

    #[test]
    fn data_saver_holds_the_lowest_rung_through_input_and_a_fast_link_until_auto() {
        let mut sim = Sim::new();
        sim.ladder.choose(Choice::Minimal, sim.now());
        assert_eq!(sim.ladder.tick(sim.now()), Some(Rung::Minimal.screencast()));
        sim.ladder.input(sim.now());
        assert!(sim.run(15, 60, 60).is_empty());
        assert_eq!(sim.rung(), (Rung::Minimal, true));
        // Adapting again starts at the top, and asking twice changes nothing.
        sim.ladder.choose(Choice::Auto, sim.now());
        sim.ladder.choose(Choice::Auto, sim.now());
        assert_eq!(sim.ladder.tick(sim.now()), Some(Rung::High.screencast()));
        assert_eq!(sim.rung(), (Rung::High, false));
    }

    #[test]
    fn any_rung_can_be_held() {
        for (choice, rung) in [
            (Choice::High, Rung::High),
            (Choice::Balanced, Rung::Balanced),
            (Choice::Low, Rung::Low),
            (Choice::Minimal, Rung::Minimal),
        ] {
            let mut sim = Sim::new();
            sim.ladder.choose(choice, sim.now());
            sim.ladder.tick(sim.now());
            assert_eq!(sim.rung(), (rung, true));
            assert_eq!(sim.ladder.apply(sim.now()), rung.screencast());
        }
    }
}
