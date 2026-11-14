#![cfg(unix)]
//! The real `lazysh-agent update` installing, dry-running and rolling back against a local fake HTTPS
//! release server. The binary under test is built with the `update-test-endpoint` seam.
use lazysh_companion_release::{
    fake::{Fault, Release},
    sha,
};
use std::{fs, os::unix::fs::symlink};
#[path = "support/update_fixture.rs"]
#[allow(dead_code)]
mod fixture;
use fixture::{companion, listing, mode, pty, release_of, Fixture, THIS};

const OLD: &str = "0.1.0";
const NEW: &str = "99.0.0";

/// A host with the old companion installed and the new release published.
fn host() -> Fixture {
    let fixture = Fixture::new(&[release_of(NEW, &companion(NEW))]);
    fixture.managed_binary(&companion(OLD));
    fixture
}
/// A companion script with `edit` applied to its text.
fn edited(version: &str, edit: impl Fn(String) -> String) -> Vec<u8> {
    edit(String::from_utf8(companion(version)).unwrap()).into_bytes()
}
fn locked(fixture: &Fixture) -> Vec<String> {
    listing(&fixture.managed())
}
/// Only the installed binary (and the lock, once a run took it): nothing staged, nothing kept.
fn assert_unchanged(fixture: &Fixture, old: &[u8]) {
    assert_eq!(fixture.installed(), old);
    assert_eq!(fixture.previous(), None);
    let names = locked(fixture);
    assert!(
        names
            .iter()
            .all(|n| n == "installation.lock" || n == "lazysh-agent"),
        "{names:?}"
    );
}

#[test]
fn update_installs_the_verified_release_keeps_the_previous_one_and_touches_nothing_else() {
    let fixture = host();
    let (old, new) = (companion(OLD), companion(NEW));
    fs::create_dir_all(fixture.state()).unwrap();
    mode(&fixture.state(), 0o700);
    for name in ["events.sqlite3", "settings.json"] {
        fs::write(fixture.state().join(name), format!("untouched {name}")).unwrap();
        mode(&fixture.state().join(name), 0o600);
    }
    // Leftovers of a killed run are swept under the lock.
    for name in [".update-killed", ".previous-killed"] {
        fs::write(fixture.managed().join(name), b"x").unwrap();
    }
    let shims = fixture.root.path().join("shims");
    fs::create_dir(&shims).unwrap();
    for tool in ["sudo", "su", "doas", "pkexec"] {
        let path = shims.join(tool);
        fs::write(
            &path,
            format!("#!/bin/sh\necho {tool} >> {}/called\n", shims.display()),
        )
        .unwrap();
        mode(&path, 0o700);
    }
    let mut command = fixture.command(&["--yes", "--json"]);
    command.env("PATH", &shims);
    let run = fixture.finish(command);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert!(run.stderr.is_empty());
    assert_eq!(
        run.stages(),
        [
            "resolving",
            "downloading",
            "verifying",
            "selfTesting",
            "replacing",
            "checkingInstalled"
        ]
    );
    let downloading = run
        .lines()
        .into_iter()
        .rfind(|l| l["stage"] == "downloading")
        .unwrap();
    assert_eq!(downloading["bytes"], downloading["total"]);
    assert_eq!(downloading["total"], new.len());
    let result = run.result();
    assert_eq!(
        (result["action"].as_str(), result["outcome"].as_str()),
        (Some("update"), Some("updated"))
    );
    assert!(result["error"].is_null());
    assert_eq!(result["current"]["version"], NEW);
    assert_eq!(result["current"]["managed"], true);
    assert_eq!(result["current"]["sha256"], sha(&new));
    assert_eq!(result["previous"]["version"], OLD);
    assert_eq!(result["previous"]["sha256"], sha(&old));
    assert_eq!(result["latest"]["version"], NEW);

    assert_eq!(fixture.installed(), new);
    assert_eq!(fixture.previous().unwrap(), old);
    assert_eq!(
        fs::metadata(fixture.managed().join("lazysh-agent"))
            .unwrap()
            .permissions()
            .mode_bits(),
        0o700
    );
    assert_eq!(
        locked(&fixture),
        ["installation.lock", "lazysh-agent", "lazysh-agent.previous"]
    );
    for name in ["events.sqlite3", "settings.json"] {
        assert_eq!(
            fs::read(fixture.state().join(name)).unwrap(),
            format!("untouched {name}").as_bytes()
        );
    }
    assert!(
        !shims.join("called").exists(),
        "no privilege escalation tool may be run"
    );
    assert_eq!(fixture.server.companion_downloads(), 1);
    assert!(fixture
        .server
        .requests()
        .iter()
        .all(|r| r.user_agent == format!("lazysh-agent/{THIS}")));

    let state = fixture.recorded().unwrap();
    assert_eq!(state["previous"]["version"], OLD);
    assert_eq!(state["previous"]["sha256"], sha(&old));
    let operation = &state["lastOperation"];
    assert_eq!(
        (operation["action"].as_str(), operation["outcome"].as_str()),
        (Some("update"), Some("updated"))
    );
    assert_eq!(
        (operation["from"].as_str(), operation["to"].as_str()),
        (Some(OLD), Some(NEW))
    );
    assert!(operation["error"].is_null());
    let text = state.to_string();
    assert!(
        !text.contains("http") && !text.contains("localhost"),
        "{text}"
    );

    // --status reads it back, and a second update has nothing to do and downloads nothing.
    let status = fixture.run(&["--status", "--json"]).result();
    assert_eq!(status["current"]["version"], NEW);
    assert_eq!(status["previous"]["version"], OLD);
    assert_eq!(status["lastOperation"]["to"], NEW);
    let again = fixture.run(&["--yes", "--json"]);
    assert_eq!(
        (again.code, again.result()["outcome"].as_str()),
        (0, Some("upToDate"))
    );
    assert_eq!(fixture.server.companion_downloads(), 1);
    assert_eq!(fixture.installed(), new);
}
trait Bits {
    fn mode_bits(&self) -> u32;
}
impl Bits for fs::Permissions {
    fn mode_bits(&self) -> u32 {
        std::os::unix::fs::PermissionsExt::mode(self) & 0o777
    }
}

#[test]
fn a_host_without_a_managed_copy_gets_one_and_has_nothing_to_roll_back_to() {
    let fixture = Fixture::new(&[release_of(NEW, &companion(NEW))]);
    let run = fixture.run(&["--yes", "--json"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    let result = run.result();
    assert_eq!(result["current"]["managed"], true);
    assert!(result["previous"].is_null());
    assert_eq!(fixture.installed(), companion(NEW));
    assert_eq!(locked(&fixture), ["installation.lock", "lazysh-agent"]);
    assert_eq!(
        fs::metadata(fixture.managed())
            .unwrap()
            .permissions()
            .mode_bits(),
        0o700
    );
    assert!(fixture.recorded().unwrap().get("previous").is_none());
    assert_eq!(fixture.run(&["--rollback", "--yes"]).code, 28);
}

#[test]
fn changing_the_installed_companion_needs_an_explicit_yes() {
    let fixture = host();
    for args in [
        &["--json"][..],
        &[],
        &["--rollback"],
        &["--rollback", "--json"],
    ] {
        let run = fixture.run(args);
        assert_eq!(run.code, 2, "{args:?}: {}{}", run.stdout, run.stderr);
        assert!(run.stdout.is_empty() && run.stderr.contains("--yes"));
    }
    for args in [
        &["--check", "--yes"][..],
        &["--status", "--yes"],
        &["--check", "--dry-run"],
        &["--dry-run", "--rollback"],
        &["--rollback", "--version", "1.2.3"],
        &["--rollback", "--channel", "stable"],
        &["--allow-downgrade"],
        &["--expect-sha256", &"a".repeat(64)],
        &["--version", "1.2.3", "--expect-sha256", &"a".repeat(64)],
        &["--version", "1.2.3", "--expect-bytes", "5"],
        &[
            "--version",
            "1.2.3",
            "--expect-sha256",
            &"A".repeat(64),
            "--expect-bytes",
            "5",
        ],
        &[
            "--version",
            "1.2.3",
            "--expect-sha256",
            &"a".repeat(64),
            "--expect-bytes",
            "0",
        ],
    ] {
        assert_eq!(fixture.run(args).code, 2, "{args:?}");
    }
    assert_eq!(
        fixture.server.requests().len(),
        0,
        "usage errors never reach the network"
    );
    assert_unchanged(&fixture, &companion(OLD));
}

#[test]
fn a_terminal_answer_decides_and_declining_changes_nothing() {
    for (answer, installs) in [("n\n", false), ("y\n", true)] {
        let fixture = host();
        let (mut input, slave) = pty();
        let mut command = fixture.command(&[]);
        command.stdin(std::process::Stdio::from(slave));
        let child = command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut input, answer.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        drop(input);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(&format!("Install companion {NEW} over {OLD}?")),
            "{stderr}"
        );
        if installs {
            assert_eq!(output.status.code(), Some(0), "{stderr}");
            assert_eq!(fixture.installed(), companion(NEW));
        } else {
            assert_eq!(output.status.code(), Some(2));
            assert_eq!(fixture.server.companion_downloads(), 0);
            assert_unchanged(&fixture, &companion(OLD));
        }
    }
}

#[test]
fn a_bad_download_is_refused_before_it_runs_and_leaves_the_old_companion_and_no_residue() {
    let marker = tempfile::tempdir().unwrap().keep().join("executed");
    let genuine = companion(NEW);
    let mut evil = edited(NEW, |text| {
        text.replacen(
            "#!/bin/sh\n",
            &format!("#!/bin/sh\ntouch {}\n", marker.display()),
            1,
        )
    });
    // Same length as the receipt, so only the digest can tell them apart.
    evil.resize(genuine.len().max(evil.len()), b'#');
    let mut release = genuine.clone();
    release.resize(evil.len(), b'#');
    let table: [(Fault, i32, &str, &str); 6] = [
        (
            Fault::TamperedAsset,
            22,
            "verificationFailed",
            "digestMismatch",
        ),
        (
            Fault::Substitute(evil),
            22,
            "verificationFailed",
            "digestMismatch",
        ),
        (Fault::ShortAsset, 22, "verificationFailed", "sizeMismatch"),
        (Fault::LongAsset, 22, "verificationFailed", "sizeMismatch"),
        (
            Fault::LyingLength(7),
            22,
            "verificationFailed",
            "sizeMismatch",
        ),
        (
            Fault::DropAsset(10),
            20,
            "networkUnavailable",
            "interrupted",
        ),
    ];
    for (fault, code, kind, detail) in table {
        let fixture = Fixture::new(&[release_of(NEW, &release)]);
        fixture.managed_binary(&companion(OLD));
        fixture.server.fault(Some(fault.clone()));
        let run = fixture.run(&["--yes", "--json"]);
        assert_eq!(run.code, code, "{fault:?}: {}{}", run.stdout, run.stderr);
        let result = run.result();
        assert_eq!(result["outcome"], "failed", "{fault:?}");
        assert_eq!(
            (
                result["error"]["kind"].as_str(),
                result["error"]["detail"].as_str()
            ),
            (Some(kind), Some(detail)),
            "{fault:?}"
        );
        assert!(
            !run.stages()
                .iter()
                .any(|s| s == "selfTesting" || s == "replacing"),
            "{fault:?}"
        );
        assert_unchanged(&fixture, &companion(OLD));
        assert!(
            !marker.exists(),
            "{fault:?}: bytes that failed verification were executed"
        );
        let operation = &fixture.recorded().unwrap()["lastOperation"];
        assert_eq!(
            (
                operation["outcome"].as_str(),
                operation["error"]["kind"].as_str()
            ),
            (Some("failed"), Some(kind)),
            "{fault:?}"
        );
    }
}

#[test]
fn the_release_must_publish_this_platform_and_the_callers_pin_must_match() {
    let new = companion(NEW);
    let other = Release::new(NEW)
        .binary("windows-agent-x64", &new)
        .binary("macos-agent-arm64", &new);
    let wrong_platform =
        Fixture::new(
            &[if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                Release::new(NEW).binary("linux-agent-x64", &new)
            } else {
                other
            }],
        );
    wrong_platform.managed_binary(&companion(OLD));
    let run = wrong_platform.run(&["--yes", "--json"]);
    assert_eq!(run.code, 21, "{}{}", run.stdout, run.stderr);
    assert_eq!(wrong_platform.server.companion_downloads(), 0);

    let fixture = host();
    let (digest, bytes) = (sha(&new), new.len().to_string());
    let wrong = "b".repeat(64);
    for (sha256, count) in [(wrong.as_str(), bytes.as_str()), (digest.as_str(), "9999")] {
        let run = fixture.run(&[
            "--yes",
            "--json",
            "--version",
            NEW,
            "--expect-sha256",
            sha256,
            "--expect-bytes",
            count,
        ]);
        assert_eq!(run.code, 22, "{}{}", run.stdout, run.stderr);
        assert_eq!(run.result()["error"]["detail"], "pinMismatch");
    }
    assert_eq!(
        fixture.server.companion_downloads(),
        0,
        "a pin mismatch is refused before any download"
    );
    assert_unchanged(&fixture, &companion(OLD));
    let run = fixture.run(&[
        "--yes",
        "--json",
        "--version",
        NEW,
        "--expect-sha256",
        &digest,
        "--expect-bytes",
        &bytes,
    ]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(fixture.installed(), new);
}

#[test]
fn a_broken_new_companion_never_replaces_the_working_one() {
    let cases: [(&str, Vec<u8>); 4] = [
        (
            "hook protocol",
            edited(NEW, |t| {
                t.replace(
                    "ingest) mkdir -p \"$LAZYSH_STATE_DIR\" && cat > \"$LAZYSH_STATE_DIR/event\"",
                    "ingest) exit 1",
                )
            }),
        ),
        ("wrong version", companion("98.0.0")),
        ("silent", b"#!/bin/sh\nexit 0\n".to_vec()),
        ("not an executable", b"\x7fELF-not-really".to_vec()),
    ];
    for (name, bytes) in cases {
        let fixture = Fixture::new(&[release_of(NEW, &bytes)]);
        fixture.managed_binary(&companion(OLD));
        let run = fixture.run(&["--yes", "--json"]);
        assert_eq!(run.code, 24, "{name}: {}{}", run.stdout, run.stderr);
        assert_eq!(run.result()["error"]["kind"], "selfTestFailed", "{name}");
        assert!(!run.stages().iter().any(|s| s == "replacing"), "{name}");
        assert_unchanged(&fixture, &companion(OLD));
        let dry = fixture.run(&["--dry-run", "--json"]);
        assert_eq!(dry.code, 24, "{name}");
        assert_unchanged(&fixture, &companion(OLD));
    }
}

#[test]
fn a_companion_that_fails_after_the_replace_is_rolled_back_to_the_working_one() {
    // The first --version (the self-test) is right; the second (the installed path) is not.
    let flaky = |marker: &std::path::Path| {
        edited(NEW, |t| {
            t.replace(
                &format!("--version) echo \"lazysh-agent {NEW}\""),
                &format!("--version) if [ -e {m} ]; then echo \"lazysh-agent 0.0.1\"; else : > {m}; echo \"lazysh-agent {NEW}\"; fi", m = marker.display()),
            )
        })
    };
    let scratch = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(&[release_of(NEW, &flaky(&scratch.path().join("first")))]);
    fixture.managed_binary(&companion(OLD));
    let run = fixture.run(&["--yes", "--json"]);
    assert_eq!(run.code, 25, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.result()["error"]["kind"], "rolledBack");
    assert_unchanged(&fixture, &companion(OLD));
    assert_eq!(
        fixture.recorded().unwrap()["lastOperation"]["error"]["kind"],
        "rolledBack"
    );

    // Without an older copy to restore, the failed one is removed rather than left installed.
    let fresh = Fixture::new(&[release_of(NEW, &flaky(&scratch.path().join("second")))]);
    let run = fresh.run(&["--yes", "--json"]);
    assert_eq!(run.code, 25, "{}{}", run.stdout, run.stderr);
    assert_eq!(locked(&fresh), ["installation.lock"]);
}

#[test]
fn a_lower_version_needs_an_explicit_downgrade() {
    let fixture = Fixture::new(&[release_of("1.0.0", &companion("1.0.0"))]);
    fixture.managed_binary(&companion("5.0.0"));
    // The latest release being older is not an update, and says so without changing anything.
    let latest = fixture.run(&["--yes", "--json"]);
    assert_eq!(
        (latest.code, latest.result()["outcome"].as_str()),
        (0, Some("upToDate"))
    );
    let named = fixture.run(&["--yes", "--json", "--version", "1.0.0"]);
    assert_eq!(named.code, 23, "{}{}", named.stdout, named.stderr);
    assert_eq!(named.result()["error"]["kind"], "downgradeRefused");
    assert_unchanged(&fixture, &companion("5.0.0"));
    let allowed = fixture.run(&["--yes", "--json", "--version", "1.0.0", "--allow-downgrade"]);
    assert_eq!(allowed.code, 0, "{}{}", allowed.stdout, allowed.stderr);
    assert_eq!(allowed.result()["current"]["version"], "1.0.0");
    assert_eq!(allowed.result()["previous"]["version"], "5.0.0");
    assert_eq!(fixture.previous().unwrap(), companion("5.0.0"));
}

#[test]
fn a_dry_run_downloads_and_self_tests_but_leaves_no_trace() {
    // A host with no managed namespace at all gets nothing created.
    let bare = Fixture::new(&[release_of(NEW, &companion(NEW))]);
    let run = bare.run(&["--dry-run", "--json"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(
        run.stages(),
        ["resolving", "downloading", "verifying", "selfTesting"]
    );
    assert_eq!(run.result()["outcome"], "dryRunOk");
    assert_eq!(run.result()["action"], "dryRun");
    assert_eq!(bare.server.companion_downloads(), 1);
    bare.assert_untouched();

    // A host that was updated before (so its lock exists) is byte for byte the same afterwards.
    let fixture = host();
    assert_eq!(fixture.run(&["--yes"]).code, 0);
    fixture.server.publish(vec![
        release_of(NEW, &companion(NEW)),
        release_of("100.0.0", &companion("100.0.0")),
    ]);
    let snapshot = |fixture: &Fixture| {
        let mut files = listing(&fixture.managed())
            .into_iter()
            .map(|n| (fs::read(fixture.managed().join(&n)).unwrap(), n))
            .collect::<Vec<_>>();
        files.push((
            fs::read(fixture.state().join("update-state.json")).unwrap(),
            "state".into(),
        ));
        files
    };
    let before = snapshot(&fixture);
    let run = fixture.run(&["--dry-run", "--json"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.result()["latest"]["version"], "100.0.0");
    assert_eq!(snapshot(&fixture), before);
    assert_eq!(fixture.server.companion_downloads(), 2);
}

#[test]
fn rollback_restores_the_previous_companion_twice_over_without_the_network() {
    let fixture = host();
    let (old, new) = (companion(OLD), companion(NEW));
    assert_eq!(fixture.run(&["--yes"]).code, 0);
    let requests = fixture.server.requests().len();

    let first = fixture.run(&["--rollback", "--yes", "--json"]);
    assert_eq!(first.code, 0, "{}{}", first.stdout, first.stderr);
    assert_eq!(
        first.stages(),
        ["selfTesting", "replacing", "checkingInstalled"]
    );
    let result = first.result();
    assert_eq!(
        (result["action"].as_str(), result["outcome"].as_str()),
        (Some("rollback"), Some("rolledBack"))
    );
    assert_eq!(result["current"]["version"], OLD);
    assert_eq!(result["previous"]["version"], NEW);
    assert!(result["latest"].is_null());
    assert_eq!(
        (fixture.installed(), fixture.previous().unwrap()),
        (old.clone(), new.clone())
    );
    assert_eq!(fixture.recorded().unwrap()["previous"]["version"], NEW);

    let second = fixture.run(&["--rollback", "--yes", "--json"]);
    assert_eq!(second.code, 0, "{}{}", second.stdout, second.stderr);
    assert_eq!(
        (fixture.installed(), fixture.previous().unwrap()),
        (new, old)
    );
    assert_eq!(
        fixture.run(&["--status", "--json"]).result()["previous"]["version"],
        OLD
    );
    assert_eq!(
        locked(&fixture),
        ["installation.lock", "lazysh-agent", "lazysh-agent.previous"]
    );
    assert_eq!(
        fixture.server.requests().len(),
        requests,
        "rollback never touches the network"
    );
}

#[test]
fn rollback_refuses_a_missing_unrecorded_swapped_or_broken_previous_copy() {
    // Nothing to restore: no namespace, no previous file, a previous file nobody recorded.
    let bare = Fixture::new(&[]);
    assert_eq!(bare.run(&["--rollback", "--yes"]).code, 28);
    bare.assert_untouched();
    let only_current = Fixture::new(&[]);
    only_current.managed_binary(&companion(OLD));
    assert_eq!(
        only_current
            .run(&["--rollback", "--yes", "--json"])
            .result()["error"]["kind"],
        "noPreviousVersion"
    );

    let fixture = host();
    assert_eq!(fixture.run(&["--yes"]).code, 0);
    let recorded = fs::read(fixture.state().join("update-state.json")).unwrap();
    fs::remove_file(fixture.state().join("update-state.json")).unwrap();
    assert_eq!(fixture.run(&["--rollback", "--yes"]).code, 28);
    fs::write(fixture.state().join("update-state.json"), &recorded).unwrap();
    mode(&fixture.state().join("update-state.json"), 0o600);

    // A previous file that is no longer the one that was kept is never installed.
    let kept = fixture.managed().join("lazysh-agent.previous");
    fs::write(&kept, companion("0.0.9")).unwrap();
    let run = fixture.run(&["--rollback", "--yes", "--json"]);
    assert_eq!(run.code, 22, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.result()["error"]["detail"], "digestMismatch");
    assert_eq!(fixture.installed(), companion(NEW));
    assert_eq!(
        locked(&fixture),
        ["installation.lock", "lazysh-agent", "lazysh-agent.previous"]
    );

    // A previous copy that fails the self-test is not installed either.
    let weak = b"#!/bin/sh\necho lazysh-agent 0.1.0\n".to_vec();
    let fixture = Fixture::new(&[release_of(NEW, &companion(NEW))]);
    fixture.managed_binary(&weak);
    assert_eq!(fixture.run(&["--yes"]).code, 0);
    let run = fixture.run(&["--rollback", "--yes", "--json"]);
    assert_eq!(run.code, 24, "{}{}", run.stdout, run.stderr);
    assert_eq!(fixture.installed(), companion(NEW));
}

#[test]
fn a_second_run_while_the_lock_is_held_is_busy_and_changes_nothing() {
    let fixture = host();
    let lock = fs::File::create(fixture.managed().join("installation.lock")).unwrap();
    mode(&fixture.managed().join("installation.lock"), 0o600);
    lock.try_lock().unwrap();
    for args in [
        &["--yes", "--json"][..],
        &["--dry-run", "--json"],
        &["--rollback", "--yes", "--json"],
    ] {
        let run = fixture.run(args);
        assert_eq!(run.code, 26, "{args:?}: {}{}", run.stdout, run.stderr);
        assert_eq!(run.result()["error"]["kind"], "busy", "{args:?}");
    }
    assert_unchanged(&fixture, &companion(OLD));
    assert_eq!(fixture.server.companion_downloads(), 0);
    drop(lock);
    assert_eq!(fixture.run(&["--yes"]).code, 0);
}

#[test]
fn an_unsafe_managed_namespace_is_refused_untouched() {
    let old = companion(OLD);
    // A namespace other users can write to, a binary others can run as their own, a symlinked namespace.
    for case in ["open directory", "open binary", "symlinked directory"] {
        let fixture = host();
        let managed = fixture.managed();
        match case {
            "open directory" => mode(&managed, 0o770),
            "open binary" => mode(&managed.join("lazysh-agent"), 0o755),
            _ => {
                let real = fixture.root.path().join("elsewhere");
                fs::rename(&managed, &real).unwrap();
                symlink(&real, &managed).unwrap();
            }
        }
        // Nothing is downloaded or changed; a binary-only case has no previous copy to roll back to.
        for (args, expected) in [
            (&["--yes", "--json"][..], 27),
            (
                &["--rollback", "--yes", "--json"],
                if case == "open binary" { 28 } else { 27 },
            ),
        ] {
            let run = fixture.run(args);
            assert_eq!(
                run.code, expected,
                "{case} {args:?}: {}{}",
                run.stdout, run.stderr
            );
        }
        assert_eq!(fixture.server.companion_downloads(), 0, "{case}");
        let real = if case == "symlinked directory" {
            fixture.root.path().join("elsewhere")
        } else {
            managed.clone()
        };
        assert_eq!(fs::read(real.join("lazysh-agent")).unwrap(), old, "{case}");
        assert!(
            fs::read_dir(&real).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with('.')),
            "{case}"
        );
    }
}

#[test]
fn credentials_in_the_proxy_never_reach_the_output_or_the_recorded_state() {
    let fixture = host();
    let mut command = fixture.command(&["--yes", "--json"]);
    command.env("HTTPS_PROXY", "http://proxyuser:proxysecret@127.0.0.1:1");
    let run = fixture.finish(command);
    assert_eq!(run.code, 20, "{}{}", run.stdout, run.stderr);
    for secret in [
        "proxysecret",
        "proxyuser",
        "127.0.0.1",
        "https://",
        "http://",
    ] {
        assert!(
            !run.stdout.contains(secret) && !run.stderr.contains(secret),
            "{secret}"
        );
    }
    assert_unchanged(&fixture, &companion(OLD));
    assert!(
        fixture.recorded().is_none(),
        "a run that never reached the install records nothing"
    );
}

/// The real agent, stripped to a publishable size, as the installed and as the downloaded companion.
/// Updating from the managed copy replaces the very file that is running; it must pass the
/// self-test with its own `ingest` and `snapshot`, and then be what `lazysh-agent` runs.
#[test]
fn the_real_agent_updates_itself_and_its_downloaded_twin_passes_the_self_test() {
    let scratch = tempfile::tempdir().unwrap();
    let copy = scratch.path().join("lazysh-agent");
    fs::copy(env!("CARGO_BIN_EXE_lazysh-agent"), &copy).unwrap();
    let stripped = std::process::Command::new("strip")
        .arg(&copy)
        .status()
        .is_ok_and(|s| s.success());
    let bytes = fs::read(&copy).unwrap();
    // Stripping invalidates the ad hoc signature macOS requires to run an arm64 binary.
    if !stripped || cfg!(target_os = "macos") || bytes.len() as u64 > 64 * 1024 * 1024 {
        eprintln!("skipped: needs a stripped Linux build under the 64 MiB publication cap");
        return;
    }
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-agent-x64",
        ("linux", "aarch64") => "linux-agent-arm64",
        ("macos", "x86_64") => "macos-agent-x64",
        _ => "macos-agent-arm64",
    };
    // 1. The downloaded companion is the real agent: the old one is a script.
    let fixture = Fixture::new(&[Release::new(THIS).binary(target, &bytes)]);
    fixture.managed_binary(&companion(OLD));
    let run = fixture.run(&["--yes", "--json"]);
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.result()["current"]["version"], THIS);
    assert_eq!(fixture.installed(), bytes);
    assert_eq!(fixture.previous().unwrap(), companion(OLD));
    let version = std::process::Command::new(fixture.managed().join("lazysh-agent"))
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        format!("lazysh-agent {THIS}")
    );

    // 2. The installed companion is the real agent, running the update that replaces it.
    let fixture = Fixture::new(&[release_of(NEW, &companion(NEW))]);
    fixture.managed_binary(&bytes);
    let managed = fixture.managed().join("lazysh-agent");
    let run = fixture.finish(fixture.command_of(&managed, &["--yes", "--json"]));
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    assert_eq!(run.result()["previous"]["version"], THIS);
    assert_eq!(fixture.installed(), companion(NEW));
    assert_eq!(fixture.previous().unwrap(), bytes);
    // The kept copy is the real agent; run from it, rollback replaces the very file it is running as.
    let kept = fixture.managed().join("lazysh-agent.previous");
    let back = fixture.finish(fixture.command_of(&kept, &["--rollback", "--yes", "--json"]));
    assert_eq!(back.code, 0, "{}{}", back.stdout, back.stderr);
    assert_eq!(back.result()["current"]["version"], THIS);
    assert_eq!(fixture.installed(), bytes);
    assert_eq!(fixture.previous().unwrap(), companion(NEW));
}
