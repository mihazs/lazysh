//! Managed hook setup on a real Windows volume: real ACLs, junctions, links, hard links, streams and the
//! commit boundary. Only the hosted Windows jobs run it.
#![cfg(windows)]
#[path = "../src/hook_setup/commit.rs"]
mod commit;
#[path = "../src/hook_setup/files.rs"]
mod files;
#[path = "../src/hook_setup/json.rs"]
mod json;
#[path = "../src/managed_directory_windows.rs"]
mod managed_directory;
#[path = "../src/hook_setup/record.rs"]
mod record;
#[path = "../src/hook_setup/render.rs"]
mod render;
#[path = "../src/hook_setup/state.rs"]
mod state;
use files::Action;
use lazysh_agent::{claude_config, hooks, Error, Result};
use lazysh_common::windows_acl::{self, Need};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
#[path = "support/binary.rs"]
mod binary;
#[path = "support/json_output.rs"]
mod json_output;
#[path = "support/plugin_cases.rs"]
mod plugin_cases;

/// The providers whose hook is a JavaScript plugin that spawns the executable as an argument vector.
const PLUGIN_AGENTS: [record::Agent; 3] = [
    record::Agent::Opencode,
    record::Agent::Cline,
    record::Agent::Amp,
];
/// Spaces, a quote, a dollar sign and characters outside the ANSI code page.
const COMPANION: &str = "Companion's $ path é ✓.exe";

fn icacls(path: &Path, args: &[&str]) -> String {
    let output = Command::new("icacls")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    // The listing starts with the path, which differs between the files being compared.
    let listing = String::from_utf8_lossy(&output.stdout).replace(&path.display().to_string(), "");
    let failure = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "icacls {args:?}: {listing}{failure}"
    );
    listing
}
/// Leaves only the current user and the system with access, inheritable, whatever the volume grants.
fn restrict(directory: &Path) {
    let user = format!("*{}:(OI)(CI)F", windows_acl::current_user().unwrap());
    icacls(
        directory,
        &[
            "/inheritance:r",
            "/grant:r",
            &user,
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
        ],
    );
}
fn junction(link: &Path, target: &Path) {
    let made = Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stdout)
    );
}

struct Fixture {
    root: tempfile::TempDir,
    target: files::Target,
    companion: PathBuf,
}
impl Fixture {
    fn new(agent: record::Agent) -> Self {
        let root = tempfile::tempdir().unwrap();
        restrict(root.path());
        let profile = root.path().join("selected profile é");
        fs::create_dir(&profile).unwrap();
        let companion = root.path().join(COMPANION);
        fs::write(&companion, b"MZ stand-in for the companion executable").unwrap();
        Self {
            root,
            target: files::Target { agent, profile },
            companion,
        }
    }
    fn plan_for(&self, source: &Path, action: Action) -> String {
        files::inspect(self.target.clone(), source)
            .unwrap()
            .plan(action)
            .unwrap()
            .digest()
            .unwrap()
    }
    fn apply_for(&self, source: &Path, action: Action) -> commit::Outcome {
        let plan = self.plan_for(source, action);
        commit::apply(self.target.clone(), source, action, &plan).unwrap()
    }
    fn apply_current(&self, action: Action) -> commit::Outcome {
        self.apply_for(&self.companion, action)
    }
    fn inspect_error(&self) -> &'static str {
        match files::inspect(self.target.clone(), &self.companion) {
            Err(Error::Installation(class)) => class,
            Err(other) => panic!("not a fixed class: {other:?}"),
            Ok(_) => panic!("the unsafe profile was admitted"),
        }
    }
    fn provider(&self) -> PathBuf {
        let agent = self.target.agent;
        let plugins = agent.asset_directory().expect("a plugin provider");
        self.target
            .profile
            .join(plugins)
            .join(agent.provider_name())
    }
    fn manifest(&self) -> PathBuf {
        self.target
            .profile
            .join(format!(".lazysh-hooks-{}.json", self.target.agent.name()))
    }
}

#[test]
fn plugin_hooks_install_reuse_update_and_remove_and_keep_the_replaced_files_acl() {
    for agent in PLUGIN_AGENTS {
        let fixture = Fixture::new(agent);
        let installed = fixture.apply_current(Action::Install);
        assert_eq!(installed.status, "configured");
        assert!(installed.metadata_committed && installed.provider_committed);
        let provider = fixture.provider();
        assert_eq!(
            fs::read_to_string(&provider).unwrap(),
            render::owned_file(agent, &fixture.companion).unwrap()
        );
        // The record is private, and the plugin is not wider than the profile it sits in.
        windows_acl::admit_path(&fixture.manifest(), Need::Private).unwrap();
        windows_acl::admit_path(&provider, Need::NoForeignChange).unwrap();
        assert_eq!(fixture.apply_current(Action::Install).status, "reused");

        // An update replaces the file by name, and the replacement keeps what the old one granted.
        icacls(&provider, &["/grant", "*S-1-1-0:R"]);
        let before = icacls(&provider, &[]);
        assert!(before.contains("Everyone:(R)"), "{before}");
        let second = fixture.root.path().join("second companion.exe");
        fs::copy(&fixture.companion, &second).unwrap();
        let updated = fixture.apply_for(&second, Action::Install);
        assert_eq!(updated.status, "configured");
        assert_eq!(
            fs::read_to_string(&provider).unwrap(),
            render::owned_file(agent, &second).unwrap()
        );
        assert_eq!(icacls(&provider, &[]), before);

        let removed = fixture.apply_for(&second, Action::Remove);
        assert_eq!(removed.status, "removed");
        assert!(!provider.exists());
    }
}

#[test]
fn a_junction_or_symbolic_link_in_the_profile_path_is_refused_before_anything_is_written() {
    let mut fixture = Fixture::new(record::Agent::Opencode);
    let real = fixture.root.path().join("real profile");
    fs::create_dir(&real).unwrap();
    let through_junction = fixture.root.path().join("by junction");
    junction(&through_junction, &real);
    let through_symlink = fixture.root.path().join("by symlink");
    std::os::windows::fs::symlink_dir(&real, &through_symlink)
        .expect("symbolic links need an elevated runner or Developer Mode");
    for linked in [through_junction, through_symlink] {
        fixture.target.profile = linked.clone();
        assert_eq!(fixture.inspect_error(), "InstallUnsafeNamespace");
        // A link above the profile is a link in its path too.
        fixture.target.profile = linked.join("below");
        assert_eq!(fixture.inspect_error(), "InstallUnsafeNamespace");
    }
    assert_eq!(fs::read_dir(&real).unwrap().count(), 0);
}

#[test]
fn an_alternate_data_stream_or_device_name_in_the_profile_path_is_refused() {
    let mut fixture = Fixture::new(record::Agent::Opencode);
    for name in [
        "selected profile é:stream",
        "selected profile é::$DATA",
        "NUL.txt",
        "trailing.",
    ] {
        fixture.target.profile = fixture.root.path().join(name);
        assert_eq!(fixture.inspect_error(), "InstallUnsafeNamespace", "{name}");
    }
    assert!(!fixture.manifest().exists());
}

#[test]
fn a_foreign_owner_a_foreign_grant_a_link_or_a_hard_link_refuses_the_provider_file_unchanged() {
    let fixture = Fixture::new(record::Agent::Opencode);
    fixture.apply_current(Action::Install);
    let provider = fixture.provider();
    let original = fs::read(&provider).unwrap();
    let unchanged = || {
        assert_eq!(fs::read(&provider).unwrap(), original);
        assert!(fixture.manifest().exists());
    };

    // Everyone may change it.
    icacls(&provider, &["/grant", "*S-1-1-0:M"]);
    assert_eq!(fixture.inspect_error(), "HooksUnhandledAcl");
    icacls(&provider, &["/remove:g", "*S-1-1-0"]);
    assert!(files::inspect(fixture.target.clone(), &fixture.companion).is_ok());
    unchanged();

    // Another account owns it.
    icacls(&provider, &["/setowner", "*S-1-5-32-545"]);
    assert_eq!(fixture.inspect_error(), "HooksUnhandledAcl");
    unchanged();
    icacls(
        &provider,
        &[
            "/setowner",
            &format!("*{}", windows_acl::current_user().unwrap()),
        ],
    );

    // A second name for the same data.
    let alias = fixture.root.path().join("alias");
    fs::hard_link(&provider, &alias).unwrap();
    assert_eq!(fixture.inspect_error(), "HooksUnsafeFile");
    fs::remove_file(&alias).unwrap();
    assert!(files::inspect(fixture.target.clone(), &fixture.companion).is_ok());

    // The provider name is a link to something else.
    let elsewhere = fixture.root.path().join("elsewhere.js");
    fs::rename(&provider, &elsewhere).unwrap();
    std::os::windows::fs::symlink_file(&elsewhere, &provider)
        .expect("symbolic links need an elevated runner or Developer Mode");
    assert_eq!(fixture.inspect_error(), "HooksUnsafeFile");
    assert_eq!(fs::read(&elsewhere).unwrap(), original);
}

#[test]
fn a_foreign_grant_on_the_profile_directory_or_the_executable_is_refused() {
    let fixture = Fixture::new(record::Agent::Opencode);
    for (path, class) in [
        (fixture.target.profile.clone(), "InstallUnsafeNamespace"),
        (fixture.companion.clone(), "HooksUnsafeBinary"),
    ] {
        icacls(&path, &["/grant", "*S-1-1-0:M"]);
        assert_eq!(fixture.inspect_error(), class);
        icacls(&path, &["/remove:g", "*S-1-1-0"]);
        assert!(files::inspect(fixture.target.clone(), &fixture.companion).is_ok());
    }
}

#[test]
fn a_provider_created_between_inspection_and_commit_is_preserved_and_never_replaced() {
    let fixture = Fixture::new(record::Agent::Opencode);
    let plan = fixture.plan_for(&fixture.companion, Action::Install);
    let provider = fixture.provider();
    let created = provider.clone();
    commit::INTERRUPT.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |point| {
            if point == commit::Boundary::BeforeProvider {
                fs::write(&created, "foreign plugin written during the commit")?;
            }
            Ok(())
        }))
    });
    let outcome = commit::apply(
        fixture.target.clone(),
        &fixture.companion,
        Action::Install,
        &plan,
    );
    commit::INTERRUPT.with(|slot| *slot.borrow_mut() = None);
    assert_eq!(outcome.unwrap().status, "uncertain");
    assert_eq!(
        fs::read_to_string(&provider).unwrap(),
        "foreign plugin written during the commit"
    );
}

#[test]
fn a_retained_profile_cannot_be_moved_or_replaced_and_a_stage_never_replaces_a_name() {
    let fixture = Fixture::new(record::Agent::Opencode);
    let retained = managed_directory::Directory::profile(&fixture.target.profile).unwrap();
    let moved = fixture.root.path().join("moved");
    assert!(
        fs::rename(&fixture.target.profile, &moved).is_err(),
        "a held profile must not be renamed away"
    );
    retained.check().unwrap();
    retained
        .open_file("first", managed_directory::open::CREATE_NEW)
        .unwrap();
    retained
        .open_file("second", managed_directory::open::CREATE_NEW)
        .unwrap();
    let error = retained.rename("first", "second", true).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
    assert!(fixture.target.profile.join("first").exists());
    retained.rename("first", "second", false).unwrap();
    assert!(!fixture.target.profile.join("first").exists());
    drop(retained);
    fs::rename(&fixture.target.profile, &moved).unwrap();
}

#[test]
fn a_stage_name_and_other_names_that_alias_a_stream_or_a_directory_are_refused() {
    let fixture = Fixture::new(record::Agent::Opencode);
    let retained = managed_directory::Directory::profile(&fixture.target.profile).unwrap();
    for name in [
        "x:stream",
        "..",
        ".",
        "a\\b",
        "CON",
        "lazysh.js:$DATA",
        "dot.",
    ] {
        assert!(
            retained
                .open_file(name, managed_directory::open::CREATE_NEW)
                .is_err(),
            "{name}"
        );
    }
}

fn companion_copy(directory: &Path) -> PathBuf {
    let companion = directory.join(COMPANION);
    fs::copy(binary::path(), &companion).unwrap();
    companion
}
fn cli(
    companion: &Path,
    action: &str,
    agent: &str,
    profile: Option<&Path>,
    plan: Option<&str>,
) -> Value {
    let mut command = Command::new(companion);
    command.args(["hooks", action, "--agent", agent]);
    if let Some(profile) = profile {
        command.arg("--profile-root").arg(profile);
    }
    if let Some(plan) = plan {
        command.args(["--expected-plan", plan]);
    }
    json_output::decode(command.output().unwrap())
}

#[test]
fn the_real_companion_previews_and_manages_the_plugin_providers_and_keeps_the_others_print_only() {
    let root = tempfile::tempdir().unwrap();
    restrict(root.path());
    let companion = companion_copy(root.path());
    assert!(
        fs::metadata(&companion).unwrap().len() <= 64 * 1024 * 1024,
        "the companion is over the 64 MiB bound hook setup binds"
    );
    for agent in ["claude", "codex", "droid", "gemini", "cursor", "copilot"] {
        let preview = cli(&companion, "preview", agent, None, None);
        assert_eq!(preview["binaryBinding"], "unboundTemplate", "{agent}");
        assert_eq!(preview["managedSetupSupported"], false, "{agent}");
        let status = cli(&companion, "status", agent, Some(root.path()), None);
        assert_eq!(status["supported"], false, "{agent}");
        assert_eq!(status["reason"], "HooksAclUnsupported", "{agent}");
        let refused = Command::new(&companion)
            .args(["hooks", "install", "--agent", agent, "--profile-root"])
            .arg(root.path())
            .args(["--expected-plan", &"0".repeat(64)])
            .output()
            .unwrap();
        assert!(!refused.status.success(), "{agent}");
    }
    for agent in ["opencode", "cline", "amp"] {
        let profile = root.path().join(format!("{agent} profile é"));
        fs::create_dir(&profile).unwrap();
        let preview = cli(&companion, "preview", agent, None, None);
        assert_eq!(preview["binaryBinding"], "currentExecutable", "{agent}");
        let binary = preview["binary"].as_str().unwrap();
        assert!(
            preview["asset"]
                .as_str()
                .unwrap()
                .contains(&serde_json::to_string(binary).unwrap()),
            "{agent}"
        );
        let status = cli(&companion, "status", agent, Some(&profile), None);
        assert_eq!(status["supported"], true, "{agent}");
        let configured = cli(
            &companion,
            "install",
            agent,
            Some(&profile),
            status["installPlan"].as_str(),
        );
        assert_eq!(configured["outcome"]["status"], "configured", "{agent}");
        let status = cli(&companion, "status", agent, Some(&profile), None);
        assert_eq!(status["state"], "configured", "{agent}");
        let reused = cli(
            &companion,
            "install",
            agent,
            Some(&profile),
            status["installPlan"].as_str(),
        );
        assert_eq!(reused["outcome"]["status"], "reused", "{agent}");
        let removed = cli(
            &companion,
            "remove",
            agent,
            Some(&profile),
            status["removePlan"].as_str(),
        );
        assert_eq!(removed["outcome"]["status"], "removed", "{agent}");
    }
}

#[test]
fn rendered_plugins_run_their_quoted_companion_through_the_bun_launcher() {
    let runtime = Command::new("bun")
        .args(["-p", "process.execPath"])
        .output()
        .expect("plugin acceptance requires Bun");
    assert!(runtime.status.success());
    let runtime = PathBuf::from(String::from_utf8(runtime.stdout).unwrap().trim());
    for (agent, script, expected_agent, expected_session) in plugin_cases::cases() {
        let directory = tempfile::tempdir().unwrap();
        restrict(directory.path());
        let companion = companion_copy(directory.path());
        let plugin = directory.path().join("lazysh.js");
        fs::write(&plugin, render::owned_file(agent, &companion).unwrap()).unwrap();
        let state = directory.path().join("state é");
        plugin_cases::load(&runtime, script, &plugin, &state, false);
        let report = json_output::decode(
            Command::new(&companion)
                .args(["snapshot", "--limit", "1"])
                .env("LAZYSH_STATE_DIR", &state)
                .output()
                .unwrap(),
        );
        plugin_cases::assert_working(&report, expected_agent, &expected_session);
    }
}
