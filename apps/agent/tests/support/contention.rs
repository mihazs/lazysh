//! A storage contention case is a timed acceptance of one write burst against
//! one otherwise idle store. Durable flushes on one volume slow each other (on
//! NTFS, FlushFileBuffers also commits the shared volume log), so every
//! companion run elsewhere in the same test process stretches each commit of a
//! burst and exhausts its unchanged wait budget. A burst therefore excludes all
//! other bursts and companion runs; ordinary runs only share the gate.
use std::sync::{PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

static VOLUME: RwLock<()> = RwLock::new(());

/// Hold for a whole burst. Never call a companion run while holding it.
pub fn exclusive_burst() -> RwLockWriteGuard<'static, ()> {
    // A failed case must not hide the remaining cases behind a poisoned gate.
    VOLUME.write().unwrap_or_else(PoisonError::into_inner)
}

/// Hold for one ordinary companion run.
pub fn shared_run() -> RwLockReadGuard<'static, ()> {
    VOLUME.read().unwrap_or_else(PoisonError::into_inner)
}
