//! A storage contention case is a timed acceptance of one write burst against
//! one otherwise idle store. Durable flushes on one volume slow each other (on
//! NTFS, FlushFileBuffers also commits the shared volume log), so every
//! companion run elsewhere stretches each commit of a burst and exhausts its
//! unchanged wait budget. A burst therefore excludes all other bursts and
//! companion runs; ordinary runs only share the gate. The gate spans every test
//! process of this user: an in-process lock orders this binary's threads, and a
//! lock file in the shared temporary directory orders other processes, such as
//! another checkout's suite or a second copy of this binary.
//!
//! The gate orders this suite's own I/O, but a hosted runner also slows every
//! flush for seconds at a time. A probe of sixteen durable commits took 0.3 s on
//! a quiet Windows runner and 5.4 s in the failed release runs of issue #2114,
//! and sixteen commits at about 190 ms cannot fit any three-second budget. A
//! burst therefore waits for the volume to be quiet instead of racing the
//! slowdown, and fails explicitly if it never is. The budget under test is
//! unchanged.
use std::{
    fs::{File, OpenOptions},
    io,
    sync::{PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard},
    time::{Duration, Instant},
};

/// Sixteen writers share one three-second budget; a burst keeps a threefold margin.
const MAX_COMMIT: Duration = Duration::from_millis(3000 / 16 / 3);
const QUIET_WITHIN: Duration = Duration::from_secs(120);

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
    let burst = gate(
        VOLUME.write().unwrap_or_else(PoisonError::into_inner),
        File::lock,
    );
    await_quiet_volume();
    burst
}

/// Median time of eight single-row durable (WAL, FULL) commits on the temporary volume.
fn commit_latency() -> Duration {
    let directory = tempfile::tempdir().expect("create the volume probe directory");
    let probe = rusqlite::Connection::open(directory.path().join("probe.sqlite3"))
        .expect("open the volume probe");
    probe
        .query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))
        .expect("switch the volume probe to WAL");
    probe
        .pragma_update(None, "synchronous", "FULL")
        .expect("synchronize the volume probe");
    probe
        .execute_batch("CREATE TABLE probe(n)")
        .expect("create the volume probe table");
    let mut commits: Vec<Duration> = (0..8)
        .map(|n| {
            let started = Instant::now();
            probe
                .execute("INSERT INTO probe VALUES (?1)", [n])
                .expect("commit to the volume probe");
            started.elapsed()
        })
        .collect();
    commits.sort();
    commits[commits.len() / 2]
}

fn wait_for_quiet(
    mut commit: impl FnMut() -> Duration,
    pause: Duration,
    within: Duration,
) -> Result<Duration, Duration> {
    let deadline = Instant::now() + within;
    loop {
        let latest = commit();
        if latest <= MAX_COMMIT {
            return Ok(latest);
        }
        if Instant::now() >= deadline {
            return Err(latest);
        }
        std::thread::sleep(pause);
    }
}

/// Return once a durable commit on the temporary volume is fast enough for a sixteen-writer
/// burst, or fail explicitly when it stays slower for two minutes. Call while holding the burst gate.
pub fn await_quiet_volume() {
    if let Err(slow) = wait_for_quiet(commit_latency, Duration::from_millis(250), QUIET_WITHIN) {
        panic!(
            "the temporary volume stayed too slow for a sixteen-writer burst: a durable commit took {slow:?}, at most {MAX_COMMIT:?} fits the unchanged three-second budget"
        );
    }
}

/// Hold for one ordinary companion run or in-process durable write.
pub fn shared_run() -> Gate<RwLockReadGuard<'static, ()>> {
    gate(
        VOLUME.read().unwrap_or_else(PoisonError::into_inner),
        File::lock_shared,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_waits_for_a_quiet_volume_and_fails_explicitly_when_there_is_none() {
        let slow = MAX_COMMIT * 4;
        let mut samples = [slow, slow, MAX_COMMIT].into_iter();
        let waited = wait_for_quiet(
            || samples.next().unwrap(),
            Duration::from_millis(1),
            Duration::from_secs(60),
        );
        assert_eq!(waited, Ok(MAX_COMMIT));
        assert!(
            samples.next().is_none(),
            "stopped before the volume was quiet"
        );
        let never = wait_for_quiet(|| slow, Duration::from_millis(1), Duration::from_millis(20));
        assert_eq!(never, Err(slow));
    }
}
