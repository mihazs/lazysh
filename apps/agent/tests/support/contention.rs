//! A storage contention case is a timed acceptance of one write burst against
//! one otherwise idle store. Durable flushes on one volume slow each other (on
//! NTFS, FlushFileBuffers also commits the shared volume log), so every
//! companion run elsewhere stretches each commit of a burst and exhausts its
//! unchanged wait budget. A burst therefore excludes all other bursts and
//! companion runs; ordinary runs only share the gate. The gate spans every test
//! process of this user: an in-process lock orders this binary's threads, and a
//! lock file in the shared temporary directory orders other processes, such as
//! another checkout's suite or a second copy of this binary.
use std::{
    fs::{File, OpenOptions},
    io,
    sync::{PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard},
};

static VOLUME: RwLock<()> = RwLock::new(());

/// Holds both locks until dropped.
pub struct Gate<Local> {
    volume: File,
    _local: Local,
}

impl<Local> Drop for Gate<Local> {
    fn drop(&mut self) {
        // Windows may release a closed handle's lock late; release it now.
        let _ = self.volume.unlock();
    }
}

fn gate<Local>(local: Local, lock: fn(&File) -> io::Result<()>) -> Gate<Local> {
    // This process's lock comes first, so its own threads never wait on the
    // file for each other and a burst never waits on its own process.
    let volume = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(std::env::temp_dir().join("lazysh-agent-test-volume.lock"))
        .and_then(|volume| lock(&volume).map(|()| volume))
        .expect("hold the cross-process storage contention gate");
    Gate {
        volume,
        _local: local,
    }
}

/// Hold for a whole burst. Never call a companion run while holding it.
pub fn exclusive_burst() -> Gate<RwLockWriteGuard<'static, ()>> {
    // A failed case must not hide the remaining cases behind a poisoned gate.
    gate(
        VOLUME.write().unwrap_or_else(PoisonError::into_inner),
        File::lock,
    )
}

/// Hold for one ordinary companion run or in-process durable write.
pub fn shared_run() -> Gate<RwLockReadGuard<'static, ()>> {
    gate(
        VOLUME.read().unwrap_or_else(PoisonError::into_inner),
        File::lock_shared,
    )
}
