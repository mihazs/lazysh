//! Real process contract; release candidates supply the exact prepared executable.
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};
#[path = "support/binary.rs"]
mod binary;
struct Fixture {
    root: tempfile::TempDir,
    binary: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("state")).unwrap();
        for name in ["events.sqlite3", "settings.json"] {
            fs::write(
                root.path().join("state").join(name),
                format!("untouched {name}"),
            )
            .unwrap();
        }
        Self {
            root,
            binary: binary::path(),
        }
    }
    fn command(&self, binary: &Path, args: &[&str]) -> Output {
        let mut command = Command::new(binary);
        command
            .env_clear()
            .args(["installation"])
            .args(args)
            .env("HOME", self.root.path())
            .env("USERPROFILE", self.root.path())
            .env("XDG_DATA_HOME", self.root.path().join("data"))
            .env("LAZYSH_STATE_DIR", self.root.path().join("state"));
        if let Some(system) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system);
        }
        command.output().unwrap()
    }
    fn run(&self, args: &[&str]) -> Output {
        self.command(&self.binary, args)
    }
    fn assert_state(&self) {
        for name in ["events.sqlite3", "settings.json"] {
            assert_eq!(
                fs::read(self.root.path().join("state").join(name)).unwrap(),
                format!("untouched {name}").as_bytes()
            );
        }
    }
}
fn json(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn real_binary_inspect_install_stale_preview_and_reuse_never_touch_state() {
    let fixture = Fixture::new();
    let first = fixture.run(&["inspect"]);
    // Unstripped debug builds can exceed the publication cap. Do not relax it for tests.
    if fs::metadata(&fixture.binary).unwrap().len() > 64 * 1024 * 1024 {
        assert!(!first.status.success());
        assert!(String::from_utf8_lossy(&first.stderr).contains("InstallUnsafeFile"));
        fixture.assert_state();
        return;
    }
    let preview = json(first);
    assert_eq!(preview["schemaVersion"], 1);
    assert_eq!(preview["supported"], true);
    assert_eq!(preview["source"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(
        preview["source"]["bytes"],
        fs::metadata(&fixture.binary).unwrap().len()
    );
    let destination = PathBuf::from(preview["destination"].as_str().unwrap());
    assert!(destination.starts_with(fixture.root.path().canonicalize().unwrap()));
    assert!(!destination.exists());
    assert_eq!(
        fs::read_dir(fixture.root.path()).unwrap().count(),
        1,
        "inspect must not create the managed namespace"
    );
    let expected = preview["planSha256"].as_str().unwrap();
    let another = Fixture::new();
    let changed_home = another.run(&["install", "--expected-plan", expected]);
    assert!(!changed_home.status.success());
    assert!(String::from_utf8_lossy(&changed_home.stderr).contains("InstallStalePlan"));
    another.assert_state();
    let rejected = fixture.run(&["install", "--expected-plan", &"0".repeat(64)]);
    assert!(!rejected.status.success());
    assert!(!destination.parent().unwrap().exists());
    let installed = json(fixture.run(&["install", "--expected-plan", expected]));
    assert_eq!(installed["status"], "installed");
    assert_eq!(installed["committed"], true);
    assert_eq!(
        fs::read(&destination).unwrap(),
        fs::read(&fixture.binary).unwrap()
    );
    let stale = fixture.run(&["install", "--expected-plan", expected]);
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("InstallStalePlan"));
    let current = json(fixture.command(&destination, &["inspect"]));
    let reused = json(fixture.command(
        &destination,
        &[
            "install",
            "--expected-plan",
            current["planSha256"].as_str().unwrap(),
        ],
    ));
    assert_eq!(reused["status"], "reused");
    assert_eq!(reused["committed"], false);
    fixture.assert_state();
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[test]
fn unsupported_platform_reports_capability_before_any_namespace_mutation() {
    let fixture = Fixture::new();
    assert_eq!(
        json(fixture.run(&["inspect"])),
        serde_json::json!({"schemaVersion":1,"supported":false,"reason":"windowsInstallerUnsupported"})
    );
    let output = fixture.run(&["install", "--expected-plan", &"0".repeat(64)]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("windowsInstallerUnsupported"));
    assert_eq!(fs::read_dir(fixture.root.path()).unwrap().count(), 1);
    fixture.assert_state();
}
