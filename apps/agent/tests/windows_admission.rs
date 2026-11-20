#![cfg(windows)]
//! The managed Windows namespace as the real prepared `lazysh-agent.exe` admits it: a junction, a directory
//! others can change, an executable another account owns and one that is no regular file are each refused with the
//! fixed class, by `installation inspect`, `installation install` and `update`, before anything changes; a
//! namespace the current user alone controls is admitted.
//!
//! The executable resolves the local application data folder through the shell, which expands `USERPROFILE`, so a
//! stand-in profile in a temporary folder holds the namespace and nothing of the real profile is read or written.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};
#[path = "support/binary.rs"]
mod binary;
#[path = "support/windows_acl.rs"]
mod windows_acl;

const NAME: &str = "lazysh-agent.exe";
const EVERYONE: &str = "*S-1-1-0";
const USERS: &str = "*S-1-5-32-545";

/// `AppData\Local\lazysh\companion` of a stand-in profile.
struct Namespace {
    profile: tempfile::TempDir,
    lazysh: PathBuf,
    companion: PathBuf,
}
impl Namespace {
    fn new() -> Self {
        let profile = tempfile::tempdir().unwrap();
        let lazysh = windows_acl::profile(profile.path()).join("lazysh");
        Self {
            companion: lazysh.join("companion"),
            lazysh,
            profile,
        }
    }
    fn executable(&self) -> PathBuf {
        self.companion.join(NAME)
    }
    /// What the namespace holds, to see that a refusal changed nothing.
    fn listing(&self) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(&self.companion)
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
    /// A directory made the way a profile would give it, holding a copy of the prepared executable.
    fn admitted(&self, with_executable: bool) {
        fs::create_dir_all(&self.companion).unwrap();
        if with_executable {
            fs::copy(binary::path(), self.executable()).unwrap();
        }
    }
    fn clear(&self) {
        let Ok(metadata) = fs::symlink_metadata(&self.companion) else {
            return;
        };
        if lazysh_common::storage_namespace::is_link(&metadata) {
            fs::remove_dir(&self.companion).unwrap();
        } else {
            fs::remove_dir_all(&self.companion).unwrap();
        }
    }
    /// The prepared executable with an empty environment, the stand-in profile and a state folder of its own.
    fn agent(&self, args: &[&str]) -> Output {
        let mut command = Command::new(binary::path());
        command
            .env_clear()
            .env("USERPROFILE", self.profile.path())
            .env("LAZYSH_STATE_DIR", self.profile.path().join("state"))
            .args(args);
        if let Some(system) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system);
        }
        command.output().unwrap()
    }
    fn installation(&self, args: &[&str]) -> Output {
        let mut all = vec!["installation"];
        all.extend(args);
        self.agent(&all)
    }
    /// `installation inspect`, which must succeed.
    fn inspected(&self) -> Value {
        let output = self.installation(&["inspect"]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn update(&self) -> (i32, Value) {
        let output = self.agent(&["update", "--rollback", "--yes", "--json"]);
        let result = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .last()
            .map(|line| serde_json::from_str(line).unwrap());
        (output.status.code().unwrap(), result.unwrap_or(Value::Null))
    }
}

fn sha256(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}
fn refused(output: &Output, class: &str) {
    assert!(!output.status.success(), "{class}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(class), "{class}: {stderr}");
    assert!(!stderr.contains("windowsInstallerUnsupported"), "{stderr}");
}

/// How to make each unsafe namespace, and the class `installation` answers it with.
type Build = fn(&Namespace);
const UNSAFE: [(&str, Build, &str); 4] = [
    ("junction", junction, "InstallUnsafeNamespace"),
    (
        "directory writable by Everyone",
        writable_by_everyone,
        "InstallUnsafeNamespace",
    ),
    (
        "executable owned by another account",
        owned_by_another_account,
        "InstallUnsafeFile",
    ),
    (
        "executable that is no regular file",
        not_a_regular_file,
        "InstallUnsafeFile",
    ),
];
fn junction(namespace: &Namespace) {
    let target = namespace.profile.path().join("elsewhere");
    fs::create_dir(&target).unwrap();
    fs::create_dir_all(&namespace.lazysh).unwrap();
    let made = Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&namespace.companion)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stdout)
    );
}
fn writable_by_everyone(namespace: &Namespace) {
    namespace.admitted(true);
    windows_acl::icacls(
        &namespace.companion,
        &["/grant", &format!("{EVERYONE}:(OI)(CI)M")],
    );
}
fn owned_by_another_account(namespace: &Namespace) {
    namespace.admitted(true);
    windows_acl::icacls(&namespace.executable(), &["/setowner", USERS]);
}
fn not_a_regular_file(namespace: &Namespace) {
    fs::create_dir_all(namespace.executable()).unwrap();
}

#[test]
fn an_unsafe_namespace_is_refused_before_anything_changes_and_an_admitted_one_passes() {
    let namespace = Namespace::new();
    let plan = "0".repeat(64);

    for (name, build, class) in UNSAFE {
        namespace.clear();
        build(&namespace);
        let before = namespace.listing();
        let executable = fs::read(namespace.executable()).ok();

        refused(&namespace.installation(&["inspect"]), class);
        refused(
            &namespace.installation(&["install", "--expected-plan", &plan]),
            class,
        );
        let (code, result) = namespace.update();
        assert_eq!(code, 27, "{name}: {result}");
        assert_eq!(result["error"]["kind"], "unsafeInstallLocation", "{name}");

        assert_eq!(
            namespace.listing(),
            before,
            "{name}: a refusal changed the namespace"
        );
        assert_eq!(fs::read(namespace.executable()).ok(), executable, "{name}");
    }

    // The same directory and executable, left to the current user, are admitted and reported.
    namespace.clear();
    namespace.admitted(true);
    let inspected = namespace.inspected();
    assert_eq!(inspected["supported"], false);
    assert_eq!(inspected["reason"], "windowsInstallerUnsupported");
    // The same file, whatever the spelling (case, short names) of the folder.
    assert_eq!(
        fs::canonicalize(inspected["destination"].as_str().unwrap()).unwrap(),
        fs::canonicalize(namespace.executable()).unwrap()
    );
    assert_eq!(
        inspected["existing"],
        serde_json::json!({
            "state": "present",
            "sha256": sha256(&namespace.executable()),
            "bytes": fs::metadata(namespace.executable()).unwrap().len(),
        })
    );
    let output = namespace.installation(&["install", "--expected-plan", &plan]);
    assert!(String::from_utf8_lossy(&output.stderr).contains("windowsInstallerUnsupported"));
    let (code, result) = namespace.update();
    assert_eq!(code, 28, "{result}");
    assert_eq!(result["error"]["kind"], "noPreviousVersion");

    // A directory with nothing in it yet, and no directory at all, are admitted as absent.
    fs::remove_file(namespace.executable()).unwrap();
    let inspected = namespace.inspected();
    assert_eq!(
        inspected["existing"],
        serde_json::json!({"state": "missing"})
    );
    namespace.clear();
    let inspected = namespace.inspected();
    assert_eq!(
        inspected["existing"],
        serde_json::json!({"state": "missing"})
    );
    assert!(
        !namespace.companion.exists(),
        "inspect created the namespace"
    );
}
