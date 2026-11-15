#![cfg(any(unix, windows))]
//! `lazysh-agent update` replacing a companion that is running, with real executables on every
//! platform: the installed image is held open by a live process while it is updated and rolled back.
//! The binary under test is built with the `update-test-endpoint` seam.
use std::{
    fs,
    process::{Child, Command, Stdio},
};
#[path = "support/update_fixture.rs"]
#[allow(dead_code)]
mod fixture;
#[path = "support/update_stub.rs"]
mod stub;
use fixture::{release_of, Fixture, NAME, PREVIOUS};

const OLD: &str = "0.1.0";
const NEW: &str = "99.0.0";

/// Runs `hold` from `path`: a live process whose image is that file.
fn running(path: &std::path::Path) -> Child {
    Command::new(path)
        .arg("hold")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}
fn alive(child: &mut Child) -> bool {
    child.try_wait().unwrap().is_none()
}
/// A host with the old stub installed and the new one published.
fn host() -> (tempfile::TempDir, Fixture, Vec<u8>, Vec<u8>) {
    let scratch = tempfile::tempdir().unwrap();
    let (old, new) = (
        stub::build(scratch.path(), OLD, false),
        stub::build(scratch.path(), NEW, false),
    );
    let fixture = Fixture::new(&[release_of(NEW, &new)]);
    fixture.managed_binary(&old);
    (scratch, fixture, old, new)
}
fn dir_names(fixture: &Fixture) -> Vec<String> {
    fixture::listing(&fixture.managed())
}

#[test]
fn a_running_companion_is_replaced_kept_and_rolled_back_without_stopping_it() {
    let (_scratch, fixture, old, new) = host();
    let mut first = running(&fixture.managed().join(NAME));

    let run = fixture.run(&["--yes", "--json"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.result()["current"]["version"], NEW);
    assert_eq!(run.result()["previous"]["version"], OLD);
    assert_eq!(
        (fixture.installed(), fixture.previous()),
        (new.clone(), Some(old.clone()))
    );
    assert!(alive(&mut first), "the replaced image must keep running");
    assert_eq!(dir_names(&fixture), ["installation.lock", NAME, PREVIOUS]);

    // The new companion runs while it is itself rolled back; the older one takes its place again.
    let mut second = running(&fixture.managed().join(NAME));
    let back = rollback(&fixture, &mut first);
    assert_eq!(back.result()["current"]["version"], OLD);
    assert_eq!(
        (fixture.installed(), fixture.previous()),
        (old.clone(), Some(new.clone()))
    );
    assert!(alive(&mut second));

    rollback(&fixture, &mut second);
    assert_eq!((fixture.installed(), fixture.previous()), (new, Some(old)));
    for child in [&mut first, &mut second] {
        let _ = child.kill();
        child.wait().unwrap();
    }
}

/// `--rollback`. A kept copy that is the image of a process that is still running cannot be deleted on
/// Windows: the command then exits 27 before it changes anything, and succeeds once that process ends.
fn rollback(fixture: &Fixture, keeping_previous_busy: &mut Child) -> fixture::Run {
    let before = (fixture.installed(), fixture.previous());
    let mut run = fixture.run(&["--rollback", "--yes", "--json"]);
    if run.code == 27 {
        assert_eq!((fixture.installed(), fixture.previous()), before);
        keeping_previous_busy.kill().unwrap();
        keeping_previous_busy.wait().unwrap();
        run = fixture.run(&["--rollback", "--yes", "--json"]);
    }
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    run
}

#[test]
fn a_companion_that_fails_once_installed_is_rolled_back_while_the_old_one_runs() {
    let scratch = tempfile::tempdir().unwrap();
    let (old, flaky) = (
        stub::build(scratch.path(), OLD, false),
        stub::build(scratch.path(), NEW, true),
    );
    let fixture = Fixture::new(&[release_of(NEW, &flaky)]);
    fixture.managed_binary(&old);
    let mut running_old = running(&fixture.managed().join(NAME));
    let run = fixture.run(&["--yes", "--json"]);
    assert_eq!(run.code, 25, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.result()["error"]["kind"], "rolledBack");
    assert_eq!((fixture.installed(), fixture.previous()), (old, None));
    assert_eq!(dir_names(&fixture), ["installation.lock", NAME]);
    assert!(alive(&mut running_old));
    running_old.kill().unwrap();
    running_old.wait().unwrap();
}

#[test]
fn a_second_update_while_one_holds_the_lock_is_busy_and_a_dry_run_changes_nothing() {
    let (_scratch, fixture, old, new) = host();
    let dry = fixture.run(&["--dry-run", "--json"]);
    assert_eq!(dry.code, 0, "{}{}", dry.stdout, dry.stderr);
    assert_eq!(dry.result()["outcome"], "dryRunOk");
    assert_eq!(
        (fixture.installed(), fixture.previous()),
        (old.clone(), None)
    );
    assert!(dir_names(&fixture)
        .iter()
        .all(|name| name == NAME || name == "installation.lock"));

    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(fixture.managed().join("installation.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    let busy = fixture.run(&["--yes", "--json"]);
    assert_eq!(busy.code, 26, "{}{}", busy.stdout, busy.stderr);
    assert_eq!(fixture.installed(), old);
    drop(lock);
    assert_eq!(fixture.run(&["--yes"]).code, 0);
    assert_eq!(fixture.installed(), new);
}
