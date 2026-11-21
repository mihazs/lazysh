//! Run one blocking credential-store read on its own thread so a stalled filesystem cannot stall
//! the caller.
//!
//! Windows has no non-blocking open: a file on an unreachable share, a cloud placeholder that is
//! still downloading or a driver that never answers keeps `open` and `read` inside the kernel.
//! The caller waits at most the deadline. The reader thread owns its handle and buffer, so
//! nothing is freed under a pending request; the caller asks Windows to cancel that thread's
//! pending synchronous I/O and walks away. Readers alive at once are capped, so a driver that
//! never answers costs a bounded number of threads and handles and later reads fail fast.
//!
//! Shortcut: cancellation is best effort (a driver may ignore it, and a request that lands
//! between two calls finds nothing pending). The cap, not the cancellation, bounds the resources.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread::{Builder, JoinHandle};
use std::time::Duration;

/// A credential store is a small local JSON file; a read this slow is stalled, not slow.
pub const DEADLINE: Duration = Duration::from_secs(3);

/// Readers alive at once for the credential stores, running or stranded.
pub static STORE_READERS: Gate = Gate::new(4);

/// Caps the readers alive at once.
pub struct Gate {
    live: AtomicUsize,
    max: usize,
}

impl Gate {
    pub const fn new(max: usize) -> Self {
        Self {
            live: AtomicUsize::new(0),
            max,
        }
    }

    fn enter(&'static self) -> Option<Slot> {
        if self.live.fetch_add(1, Ordering::AcqRel) < self.max {
            return Some(Slot(self));
        }
        self.live.fetch_sub(1, Ordering::AcqRel);
        None
    }
}

/// Held by the reader thread, so a stranded reader keeps counting until it really ends.
struct Slot(&'static Gate);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.live.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Run `work` on a reader thread. `None` when it found nothing, panicked, outlived `deadline` or
/// the gate is full.
pub fn run<T: Send + 'static>(
    gate: &'static Gate,
    deadline: Duration,
    work: impl FnOnce() -> Option<T> + Send + 'static,
) -> Option<T> {
    let slot = gate.enter()?;
    let (done, result) = mpsc::sync_channel(1);
    let reader = Builder::new()
        .name("cline-store-reader".into())
        .spawn(move || {
            let _slot = slot;
            let _ = done.send(work());
        })
        .ok()?;
    match result.recv_timeout(deadline) {
        Ok(found) => {
            let _ = reader.join();
            found
        }
        Err(_) => {
            cancel_pending_io(&reader);
            None
        }
    }
}

fn cancel_pending_io(reader: &JoinHandle<()>) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        // SAFETY: the thread handle stays valid while `reader` lives and the call only reads it.
        let _ =
            unsafe { windows_sys::Win32::System::IO::CancelSynchronousIo(reader.as_raw_handle()) };
    }
    #[cfg(not(windows))]
    let _ = reader;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    /// Wait for a reader that was left behind to give its slot back.
    fn wait_until_idle(gate: &Gate) {
        let start = Instant::now();
        while gate.live.load(Ordering::Acquire) != 0 {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "the reader never released its slot"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_read_that_finishes_in_time_returns_its_value_and_its_slot() {
        static GATE: Gate = Gate::new(1);
        assert_eq!(run(&GATE, DEADLINE, || Some("store")), Some("store"));
        assert_eq!(GATE.live.load(Ordering::Acquire), 0);
        assert_eq!(run(&GATE, DEADLINE, || None::<&str>), None);
        assert_eq!(GATE.live.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_stalled_read_returns_at_the_deadline_and_frees_its_slot_when_it_ends() {
        static GATE: Gate = Gate::new(1);
        let (release, held) = mpsc::channel::<()>();
        let start = Instant::now();
        let found = run(&GATE, Duration::from_millis(50), move || {
            let _ = held.recv();
            Some("late")
        });
        assert_eq!(found, None);
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "the caller must not wait for the stalled reader"
        );
        assert_eq!(
            GATE.live.load(Ordering::Acquire),
            1,
            "a stranded reader keeps its slot"
        );
        release.send(()).unwrap();
        wait_until_idle(&GATE);
    }

    #[test]
    fn a_full_gate_refuses_new_reads_without_running_them() {
        static GATE: Gate = Gate::new(1);
        let (release, held) = mpsc::channel::<()>();
        assert_eq!(
            run(&GATE, Duration::from_millis(20), move || {
                let _ = held.recv();
                Some(())
            }),
            None
        );
        let ran = std::sync::Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        let refused = run(&GATE, DEADLINE, move || {
            flag.store(true, Ordering::Release);
            Some(())
        });
        assert_eq!(refused, None);
        assert!(!ran.load(Ordering::Acquire));
        release.send(()).unwrap();
        wait_until_idle(&GATE);
        assert_eq!(run(&GATE, DEADLINE, || Some(())), Some(()));
    }

    #[test]
    fn a_panicking_read_is_a_miss_and_frees_its_slot() {
        static GATE: Gate = Gate::new(1);
        assert_eq!(
            run(&GATE, DEADLINE, || -> Option<()> { panic!("owned") }),
            None
        );
        wait_until_idle(&GATE);
    }
}
