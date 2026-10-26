use super::admitted_acquire;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};
#[test]
fn revocation_while_waiting_for_serialization_never_reaches_platform_acquire() {
    let serialized = Mutex::new(());
    let held = serialized.lock().unwrap();
    let authorized = AtomicBool::new(true);
    let calls = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let pending = scope.spawn(|| {
            let _guard = serialized.lock().unwrap();
            admitted_acquire(
                || {
                    if authorized.load(Ordering::SeqCst) {
                        Ok(())
                    } else {
                        Err("revoked".into())
                    }
                },
                || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                || Ok(()),
                || Ok(()),
            )
        });
        authorized.store(false, Ordering::SeqCst);
        drop(held);
        assert_eq!(pending.join().unwrap().unwrap_err(), "revoked");
    });
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
#[test]
fn failed_post_admission_guard_releases_the_exact_platform_acquisition() {
    let active = AtomicBool::new(false);
    let released = AtomicUsize::new(0);
    let result = admitted_acquire(
        || Ok(()),
        || {
            active.store(true, Ordering::SeqCst);
            Ok(())
        },
        || Err("original lease revoked".into()),
        || {
            active.store(false, Ordering::SeqCst);
            released.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err(), "original lease revoked");
    assert!(!active.load(Ordering::SeqCst));
    assert_eq!(released.load(Ordering::SeqCst), 1);
}
