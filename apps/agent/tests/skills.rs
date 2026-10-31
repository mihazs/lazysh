#[cfg(any(target_os = "linux", target_os = "macos"))]
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};
#[path = "support/binary.rs"]
mod binary;
#[path = "support/json_output.rs"]
mod json_output;
use json_output::decode as json;
fn command() -> Command {
    let mut command = Command::new(binary::path());
    command.env_clear();
    if let Some(system) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system);
    }
    command
}
struct Fixture {
    temp: tempfile::TempDir,
    profile: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().canonicalize().unwrap().join("profile");
        fs::create_dir(&profile).unwrap();
        fs::write(
            profile.join("settings.json"),
            b"preserve agent configuration",
        )
        .unwrap();
        Self { temp, profile }
    }
    fn run(&self, action: &str, hash: Option<&str>) -> Output {
        let mut command = command();
        command
            .args([
                "skills",
                action,
                "--agent",
                "claude",
                "--skill",
                "host-setup",
                "--profile-root",
            ])
            .arg(&self.profile);
        if let Some(hash) = hash {
            command.args(["--expected-plan", hash]);
        }
        command.env(
            "LAZYSH_STATE_DIR",
            self.temp.path().join("must-not-create-state"),
        );
        command.output().unwrap()
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn skill(&self) -> PathBuf {
        self.profile.join("skills/lazysh-host-setup/SKILL.md")
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn status(&self) -> Value {
        json(self.run("status", None))
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn install(&self) -> Value {
        let status = self.status();
        json(self.run("install", status["installPlanSha256"].as_str()))
    }
    fn preserved(&self) {
        assert_eq!(
            fs::read(self.profile.join("settings.json")).unwrap(),
            b"preserve agent configuration"
        );
        assert!(!self.temp.path().join("must-not-create-state").exists());
    }
}
#[test]
fn packaged_previews_are_exact_and_need_no_agent_profile_or_runtime() {
    for name in ["host-setup", "agent-reporting"] {
        let output = command()
            .args(["skills", "preview", "--skill", name])
            .output()
            .unwrap();
        let value = json(output);
        let content = value["content"].as_str().unwrap();
        assert!(content.starts_with("---\nname: lazysh-"));
        assert_eq!(
            value["sha256"],
            format!("{:x}", Sha256::digest(content.as_bytes()))
        );
        assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
    }
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn isolated_cli_install_upgrade_reuse_remove_and_plans_preserve_other_configuration() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fs::set_permissions(&fixture.profile, fs::Permissions::from_mode(0o755)).unwrap();
    let missing = fixture.status();
    assert_eq!(missing["plan"]["existing"]["state"], "missing");
    assert_eq!(
        fs::read_dir(&fixture.profile).unwrap().count(),
        1,
        "status writes nothing"
    );
    assert_ne!(missing["installPlanSha256"], missing["removePlanSha256"]);
    assert!(!fixture
        .run("install", missing["removePlanSha256"].as_str())
        .status
        .success());
    assert_eq!(
        json(fixture.run("install", missing["installPlanSha256"].as_str()))["status"],
        "installed"
    );
    assert_eq!(
        fs::metadata(&fixture.profile).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(
        fs::metadata(fixture.skill()).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!fixture
        .run("install", missing["installPlanSha256"].as_str())
        .status
        .success());
    assert_eq!(fixture.install()["status"], "reused");
    let current = fs::read_to_string(fixture.skill()).unwrap();
    let (body, receipt) = current
        .rsplit_once("\n<!-- lazysh-managed-product-skill ")
        .unwrap();
    let old_body = format!("{body}\nEarlier packaged guidance.\n");
    let mut receipt: Value = serde_json::from_str(receipt.strip_suffix(" -->\n").unwrap()).unwrap();
    receipt["version"] = Value::String("0.1.0".into());
    receipt["sha256"] = Value::String(format!("{:x}", Sha256::digest(old_body.as_bytes())));
    fs::write(
        fixture.skill(),
        format!("{old_body}\n<!-- lazysh-managed-product-skill {receipt} -->\n"),
    )
    .unwrap();
    assert_eq!(fixture.status()["plan"]["existing"]["version"], "0.1.0");
    assert_eq!(fixture.install()["status"], "installed");
    assert_eq!(fs::read_to_string(fixture.skill()).unwrap(), current);
    fs::create_dir(fixture.profile.join("skills/unrelated")).unwrap();
    let status = fixture.status();
    assert_eq!(
        json(fixture.run("remove", status["removePlanSha256"].as_str()))["status"],
        "removed"
    );
    assert!(!fixture.skill().parent().unwrap().exists());
    assert!(fixture.profile.join("skills/unrelated").is_dir());
    let absent = fixture.status();
    assert_eq!(
        json(fixture.run("remove", absent["removePlanSha256"].as_str()))["status"],
        "absent"
    );
    fixture.preserved();
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn foreign_modified_extra_linked_and_unsafe_skills_never_get_adopted_or_removed() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for case in [
        "foreign",
        "empty",
        "modified",
        "extra",
        "file-link",
        "directory-link",
        "hard-link",
        "public",
        "fifo",
        "oversize",
    ] {
        let fixture = Fixture::new();
        fixture.install();
        let file = fixture.skill();
        let folder = file.parent().unwrap();
        match case {
            "foreign" => fs::write(&file, b"personal skill without receipt").unwrap(),
            "empty" => fs::remove_file(&file).unwrap(),
            "modified" => {
                let body = fs::read_to_string(&file).unwrap();
                fs::write(
                    &file,
                    body.replacen("# lazysh host setup", "# edited by the user", 1),
                )
                .unwrap();
            }
            "extra" => fs::write(folder.join("personal-notes"), b"keep these").unwrap(),
            "file-link" => {
                fs::rename(&file, fixture.temp.path().join("original")).unwrap();
                symlink(fixture.temp.path().join("original"), &file).unwrap();
            }
            "directory-link" => {
                fs::rename(folder, fixture.temp.path().join("original-folder")).unwrap();
                symlink(fixture.temp.path().join("original-folder"), folder).unwrap();
            }
            "hard-link" => fs::hard_link(&file, fixture.temp.path().join("linked")).unwrap(),
            "public" => fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap(),
            "oversize" => fs::write(&file, vec![b'x'; 16385]).unwrap(),
            "fifo" => {
                fs::remove_file(&file).unwrap();
                let name = std::ffi::CString::new(file.as_os_str().as_encoded_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            }
            _ => unreachable!(),
        }
        let before = fs::symlink_metadata(&file)
            .ok()
            .map(|m| (m.len(), m.permissions().mode()));
        for action in ["status", "install", "remove"] {
            let output = fixture.run(
                action,
                if action == "status" {
                    None
                } else {
                    Some("0000000000000000000000000000000000000000000000000000000000000000")
                },
            );
            assert!(!output.status.success(), "{case}/{action}");
        }
        assert_eq!(
            fs::symlink_metadata(&file)
                .ok()
                .map(|m| (m.len(), m.permissions().mode())),
            before,
            "{case}"
        );
        if case == "extra" {
            assert_eq!(
                fs::read(folder.join("personal-notes")).unwrap(),
                b"keep these"
            );
        }
        fixture.preserved();
    }
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn profiles_must_exist_and_symlink_or_wrong_owner_profiles_are_not_followed() {
    use std::os::unix::fs::{symlink, MetadataExt};
    let fixture = Fixture::new();
    let original = fixture.temp.path().join("original-profile");
    fs::rename(&fixture.profile, &original).unwrap();
    assert!(!fixture.run("status", None).status.success());
    assert!(!fixture.profile.exists());
    symlink(&original, &fixture.profile).unwrap();
    assert!(!fixture.run("status", None).status.success());
    assert_eq!(fs::read_dir(&original).unwrap().count(), 1);
    if fs::metadata("/").unwrap().uid() != unsafe { libc::geteuid() } {
        let output = command()
            .args([
                "skills",
                "status",
                "--agent",
                "codex",
                "--skill",
                "agent-reporting",
                "--profile-root",
                "/",
            ])
            .output()
            .unwrap();
        assert!(!output.status.success());
    }
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[test]
fn unsupported_profile_mutations_report_capability_without_creating_anything() {
    let fixture = Fixture::new();
    assert_eq!(json(fixture.run("status", None))["supported"], false);
    for action in ["install", "remove"] {
        let output = fixture.run(
            action,
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        );
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("SkillInstallationUnsupported"));
    }
    assert_eq!(fs::read_dir(&fixture.profile).unwrap().count(), 1);
    fixture.preserved();
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn agent_profile_overrides_and_action_plans_never_cross_into_another_profile() {
    let fixture = Fixture::new();
    let codex = fixture.temp.path().join("codex profile with spaces");
    fs::create_dir(&codex).unwrap();
    let run = |agent: &str, action: &str, expected: Option<&str>| {
        let mut process = command();
        process
            .env("CODEX_HOME", &codex)
            .env("CLAUDE_CONFIG_DIR", &fixture.profile)
            .args([
                "skills",
                action,
                "--agent",
                agent,
                "--skill",
                "agent-reporting",
            ]);
        if let Some(expected) = expected {
            process.args(["--expected-plan", expected]);
        }
        process.output().unwrap()
    };
    let status = json(run("codex", "status", None));
    assert_eq!(
        status["destination"],
        codex
            .join("skills/lazysh-agent-reporting/SKILL.md")
            .to_str()
            .unwrap()
    );
    assert!(
        !run("claude", "install", status["installPlanSha256"].as_str())
            .status
            .success()
    );
    assert!(!fixture.profile.join(".lazysh-product-skills.lock").exists());
    assert_eq!(
        json(run(
            "codex",
            "install",
            status["installPlanSha256"].as_str()
        ))["status"],
        "installed"
    );
    assert!(!fixture.profile.join("skills").exists());
    let current = json(run("codex", "status", None));
    assert_eq!(
        json(run("codex", "remove", current["removePlanSha256"].as_str()))["status"],
        "removed"
    );
    fixture.preserved();
}
