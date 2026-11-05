//! Opt-in fixture observation. The buffer is thread-local and never holds input data.
//! Marks are microseconds from just before native-lock acquisition: acquired,
//! sidecars admitted, SQLite opened, configured, WAL mode ready, schema ready,
//! and observer drop. Drop runs after the guard is released; the last mark is
//! therefore an upper bound, not an exact lock-release timestamp. Missing marks
//! indicate a phase was not reached. Measurements include observer overhead.
use std::{cell::Cell, time::Instant};

thread_local! {
    static LAST: Cell<Option<[Option<u64>; 7]>> = const { Cell::new(None) };
}

/// Take the latest observation for this thread; requires the test-only feature.
#[doc(hidden)]
pub fn take_bootstrap_observation() -> Option<[Option<u64>; 7]> {
    LAST.with(Cell::take)
}

pub(crate) struct Observation {
    start: Option<Instant>,
    marks: [Option<u64>; 7],
}

impl Observation {
    pub(crate) fn new() -> Self {
        LAST.with(|last| last.set(None));
        Self {
            start: (std::env::var_os("LAZYSH_BOOTSTRAP_OBSERVATION").as_deref()
                == Some(std::ffi::OsStr::new("1")))
            .then(Instant::now),
            marks: [None; 7],
        }
    }
    pub(crate) fn mark(&mut self, phase: usize) {
        if let Some(start) = self.start {
            self.marks[phase] =
                Some(u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX));
        }
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        if self.start.is_some() {
            self.mark(6);
            LAST.with(|last| last.set(Some(self.marks)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observations_are_thread_local_and_consumed_once() {
        // Construct enabled observers without changing the process environment.
        let child = std::thread::spawn(|| {
            let mut observed = Observation {
                start: Some(Instant::now()),
                marks: [None; 7],
            };
            observed.mark(0);
            observed.mark(1);
            drop(observed);
            let marks = take_bootstrap_observation().unwrap();
            assert!(marks[0].is_some() && marks[1].is_some() && marks[6].is_some());
            assert!(take_bootstrap_observation().is_none());
        });
        child.join().unwrap();
        assert!(take_bootstrap_observation().is_none());
    }
}
