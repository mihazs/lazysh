#![cfg(any(target_os = "linux", target_os = "macos"))]
#[cfg(unix)]
#[path = "../src/hook_setup/commit.rs"]
mod commit;
#[cfg(unix)]
#[path = "../src/hook_setup/files.rs"]
mod files;
#[path = "../src/hook_setup/json.rs"]
mod json;
#[path = "../src/hook_setup/kimi_toml.rs"]
mod kimi_toml;
#[cfg(unix)]
#[path = "../src/managed_directory.rs"]
mod managed_directory;
#[path = "../src/hook_setup/record.rs"]
mod record;
#[path = "../src/hook_setup/render.rs"]
mod render;
#[path = "../src/hook_setup/state.rs"]
mod state;
use json::{rewrite, Entry, Fault};
use lazysh_agent::{claude_config, hooks, kimi_code, reported_history, Error, Result};
const WHOLE_FILE_AGENTS: [record::Agent; 5] = [
    record::Agent::Opencode,
    record::Agent::Cline,
    record::Agent::Copilot,
    record::Agent::Amp,
    record::Agent::Grok,
];
use serde_json::{json, Value};
#[path = "support/binary.rs"]
mod binary;
#[path = "support/json_output.rs"]
mod json_output;
#[path = "support/plugin_cases.rs"]
mod plugin_cases;
#[path = "support/process.rs"]
mod process;

fn interrupt(callback: impl FnMut(commit::Boundary) -> Result<()> + 'static) {
    commit::INTERRUPT.with(|slot| *slot.borrow_mut() = Some(Box::new(callback)));
}
fn clear_interrupt() {
    commit::INTERRUPT.with(|slot| *slot.borrow_mut() = None);
}
fn owned(command: &str) -> Entry {
    Entry {
        event: "Stop".into(),
        group: json!({"hooks":[{"type":"command","command":command,"timeout":3}]}),
    }
}
#[cfg(unix)]
fn snapshot(program: &std::path::Path, state: &std::path::Path) -> Value {
    let output = std::process::Command::new(program)
        .args(["snapshot", "--limit", "1"])
        .env_clear()
        .env("PATH", "")
        .env("LAZYSH_STATE_DIR", state)
        .output()
        .unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn scoped_install_update_remove_preserves_foreign_bytes_and_formatting() {
    let foreign = r#"{ "hooks" : { "Stop" : [ {"matcher":"foreign", "hooks":[{"command":"keep \"},[\""}]} ] }, "env": {"PRIVATE":"unchanged"}, "\u0078":1e+02 }"#;
    let first = owned("'/owned/a path' ingest --agent codex");
    let second = owned("'/owned/a different path' ingest --agent codex");
    let installed = rewrite(foreign, &[], std::slice::from_ref(&first)).unwrap();
    assert!(installed.contains(r#"{"matcher":"foreign", "hooks":[{"command":"keep \"},[\""}]}"#));
    assert!(installed.ends_with(r#" }, "env": {"PRIVATE":"unchanged"}, "\u0078":1e+02 }"#));
    let updated = rewrite(&installed, &[first], std::slice::from_ref(&second)).unwrap();
    assert!(updated.contains("a different path"));
    assert_eq!(
        rewrite(
            &updated,
            std::slice::from_ref(&second),
            std::slice::from_ref(&second)
        )
        .unwrap(),
        updated
    );
    let removed = rewrite(&updated, &[second], &[]).unwrap();
    assert_eq!(removed, foreign);
}
#[test]
fn fresh_hook_objects_and_empty_arrays_remain_valid_and_unowned_values_stay_intact() {
    for input in [
        "{\r\n  \"model\": \"keep\"\r\n}\r\n",
        "{\"hooks\":{}}",
        "{\"hooks\":{\"Stop\":[]}}",
    ] {
        let hook = owned("'/absolute/companion' ingest --agent claude");
        let updated = rewrite(input, &[], std::slice::from_ref(&hook)).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&updated).unwrap()["hooks"]["Stop"][0],
            hook.group
        );
        let removed = rewrite(&updated, &[hook], &[]).unwrap();
        assert!(
            serde_json::from_str::<Value>(&removed).unwrap()["hooks"]["Stop"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(input.contains("keep"), removed.contains("keep"));
    }
}
#[test]
fn malformed_json_duplicate_keys_and_modified_or_foreign_hooks_are_never_rewritten() {
    let hook = owned("fixed");
    for input in [
        "{ // retain comment\n}",
        "{\"hooks\":{},}",
        "{\"hooks\":{},\"h\\u006foks\":{}}",
        "{\"foreign\":{\"x\":1,\"x\":2}}",
        "[]",
        "{\"hooks\":null}",
    ] {
        assert_eq!(
            rewrite(input, &[], std::slice::from_ref(&hook)),
            Err(Fault::Invalid)
        );
    }
    let installed = rewrite("{}", &[], std::slice::from_ref(&hook)).unwrap();
    assert_eq!(
        rewrite(&installed, &[], std::slice::from_ref(&hook)),
        Err(Fault::Conflict)
    );
    let edited = installed.replace("fixed", "user edit");
    assert_eq!(rewrite(&edited, &[hook], &[]), Err(Fault::Stale));
}

#[test]
fn output_size_is_bounded_before_any_prepared_metadata_can_be_written() {
    let input = serde_json::to_string(&json!({"foreign":"x".repeat(json::MAXIMUM-20)})).unwrap();
    assert!(input.len() <= json::MAXIMUM);
    assert_eq!(
        rewrite(&input, &[], &[owned("large new addition")]),
        Err(Fault::Invalid)
    );
}

#[test]
fn owned_record_checksums_and_templates_bind_the_selected_binary_without_provider_contents() {
    use record::{Agent, Binary, FileState, Identity, Owned, Record};
    let binary = Binary {
        path: "/owned/it's a companion".into(),
        sha256: "ab".repeat(32),
        identity: Identity {
            device: 1,
            inode: 2,
            owner: 1000,
            mode: 0o100700,
            links: 1,
            bytes: 100,
            modified: [1, 0],
            changed: [1, 0],
        },
    };
    for agent in [
        Agent::Claude,
        Agent::Codex,
        Agent::Droid,
        Agent::Gemini,
        Agent::Cursor,
        Agent::Opencode,
        Agent::Cline,
        Agent::Copilot,
        Agent::Grok,
    ] {
        let entries = render::entries(agent, &binary.path).unwrap();
        let plugin = agent
            .is_whole_file()
            .then(|| render::owned_file(agent, &binary.path).unwrap());
        let owned = Owned {
            template_version: 1,
            package_version: env!("CARGO_PKG_VERSION").into(),
            binary: binary.clone(),
            entries,
            plugin_sha256: plugin.as_ref().map(|body| record::hash(body.as_bytes())),
        };
        let provider_after_sha256 = plugin
            .as_ref()
            .map(|body| record::hash(body.as_bytes()))
            .unwrap_or_else(|| {
                record::hash(
                    render::configuration(agent, "{}\n", &[], &owned.entries)
                        .unwrap()
                        .as_bytes(),
                )
            });
        let record = Record {
            schema_version: 1,
            product: "lazysh".into(),
            agent,
            profile: "/owned/profile".into(),
            profile_identity: [1, 3],
            previous: None,
            next: Some(owned),
            provider_before: FileState::Missing,
            provider_after_sha256: Some(provider_after_sha256),
        };
        let bytes = record.encode().unwrap();
        assert_eq!(Record::decode(&bytes).unwrap(), record);
        let edited = String::from_utf8(bytes)
            .unwrap()
            .replace("it's a companion", "someone else's binary");
        assert_eq!(
            Record::decode(edited.as_bytes()),
            Err("HooksModifiedRecord")
        );
        if let Some(plugin) = plugin {
            assert!(plugin.contains(match agent {
                Agent::Opencode => r#"Bun.spawn(["/owned/it's a companion", 'ingest'"#,
                Agent::Cline => r#"childProcess.execFile("/owned/it's a companion", ['ingest'"#,
                Agent::Copilot => r#""exec": "/owned/it's a companion""#,
                Agent::Grok => {
                    r#""command": "'/owned/it'\\''s a companion' ingest --agent grok --reported-history""#
                }
                _ => unreachable!(),
            }));
            assert!(!plugin.contains("['lazysh-agent'"));
        } else {
            for entry in record.next.unwrap().entries {
                let command = if agent == Agent::Cursor {
                    &entry.group["command"]
                } else {
                    &entry.group["hooks"][0]["command"]
                };
                assert_eq!(
                    command,
                    &json!(format!(
                        "'/owned/it'\\''s a companion' ingest --agent {}",
                        agent.name()
                    ))
                );
            }
        }
    }
}

/// Runs a rendered shell hook with an empty `PATH` and asserts it delivered silently.
#[cfg(unix)]
fn run_shell_hook(command: &str, state: &std::path::Path, payload: &Value) {
    let output = process::run(
        std::process::Command::new("/bin/sh")
            .args(["-c", command])
            .env_clear()
            .env("PATH", "")
            .env("LAZYSH_STATE_DIR", state),
        &serde_json::to_vec(payload).unwrap(),
    );
    assert!(
        output.status.success(),
        "status={:?} stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty() && output.stderr.is_empty());
}

/// A provider file the companion must not create: inspection refuses and status reports why, writing nothing.
#[cfg(unix)]
fn assert_missing_provider_is_unsupported(fixture: &ProfileFixture, reason: &'static str) {
    std::fs::remove_file(fixture.provider()).unwrap();
    assert!(matches!(
        files::inspect(fixture.target.clone(), &fixture.companion),
        Err(Error::Installation(refused)) if refused == reason
    ));
    let status = fixture.cli("status", None);
    assert_eq!(status["supported"], false);
    assert_eq!(status["reason"], reason);
    assert!(!fixture.provider().exists());
}

#[cfg(unix)]
#[test]
fn generated_shell_handlers_execute_the_quoted_absolute_companion_with_an_empty_path() {
    use std::fs;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("companion with ' and $ spaces");
    fs::copy(binary::path(), &path).unwrap();
    for agent in [
        record::Agent::Claude,
        record::Agent::Codex,
        record::Agent::Droid,
        record::Agent::Gemini,
        record::Agent::Cursor,
    ] {
        let (event, payload) = match agent {
            record::Agent::Gemini => (
                "BeforeAgent",
                json!({"hook_event_name":"BeforeAgent","session_id":"owned-hook","cwd":"/owned/project","response":"must not be retained"}),
            ),
            record::Agent::Cursor => (
                "beforeSubmitPrompt",
                json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"owned-hook","workspace_roots":["/owned/project"],"response":"must not be retained"}),
            ),
            _ => (
                "UserPromptSubmit",
                json!({"hook_event_name":"UserPromptSubmit","session_id":"owned-hook","cwd":"/owned/project","response":"must not be retained"}),
            ),
        };
        let state = directory.path().join(agent.name());
        let hook = render::entries(agent, &path)
            .unwrap()
            .into_iter()
            .find(|entry| entry.event == event)
            .unwrap();
        let pointer = if agent == record::Agent::Cursor {
            "/command"
        } else {
            "/hooks/0/command"
        };
        let command = hook.group.pointer(pointer).unwrap().as_str().unwrap();
        run_shell_hook(command, &state, &payload);
        let report = snapshot(&path, &state);
        assert_eq!(report["sessions"][0]["sessionId"], "owned-hook");
        assert_eq!(report["sessions"][0]["state"], "working");
        assert!(!report.to_string().contains("must not be retained"));
    }
}

#[cfg(unix)]
#[test]
fn rendered_plugins_execute_their_absolute_companion_with_an_empty_path() {
    use std::{fs, process::Command};
    let runtime = Command::new("bun")
        .args(["-p", "process.execPath"])
        .output()
        .expect("plugin acceptance requires Bun");
    assert!(runtime.status.success());
    let runtime = std::path::PathBuf::from(String::from_utf8(runtime.stdout).unwrap().trim());
    assert!(runtime.is_absolute());
    for (agent, script, expected_agent, expected_session) in plugin_cases::cases() {
        let directory = tempfile::tempdir().unwrap();
        let companion = directory.path().join("Plugin's companion $ with spaces");
        fs::copy(binary::path(), &companion).unwrap();
        let plugin = directory.path().join("lazysh.js");
        fs::write(&plugin, render::owned_file(agent, &companion).unwrap()).unwrap();
        let state = directory.path().join("state");
        plugin_cases::load(&runtime, script, &plugin, &state, true);
        plugin_cases::assert_working(
            &snapshot(&companion, &state),
            expected_agent,
            &expected_session,
        );
    }
}

fn initial_record(agent: record::Agent) -> record::Record {
    let mut record =
        record::Record::decode(include_bytes!("fixtures/hooks-v1-record.json")).unwrap();
    record.agent = agent;
    let owned = record.next.as_mut().unwrap();
    owned.entries = render::entries(agent, &owned.binary.path).unwrap();
    record.provider_after_sha256 = Some(if agent.is_whole_file() {
        let digest = record::hash(
            render::owned_file(agent, &owned.binary.path)
                .unwrap()
                .as_bytes(),
        );
        owned.plugin_sha256 = Some(digest.clone());
        digest
    } else {
        record::hash(
            render::configuration(agent, "{}\n", &[], &owned.entries)
                .unwrap()
                .as_bytes(),
        )
    });
    record
}
fn present(text: &str, inode: u64) -> record::FileState {
    let record = record::Record::decode(include_bytes!("fixtures/hooks-v1-record.json")).unwrap();
    let mut identity = record.next.unwrap().binary.identity;
    identity.inode = inode;
    identity.mode = 0o100644;
    identity.bytes = text.len() as u64;
    record::FileState::Present {
        identity,
        sha256: record::hash(text.as_bytes()),
    }
}
#[test]
fn persisted_v1_record_is_independent_of_current_config_printer_event_counts() {
    let record = record::Record::decode(include_bytes!("fixtures/hooks-v1-record.json")).unwrap();
    let owned = record.next.as_ref().unwrap();
    assert_eq!(owned.entries.len(), 1);
    assert_eq!(owned.entries[0].event, "Stop");
    assert!(
        render::entries(record.agent, &owned.binary.path)
            .unwrap()
            .len()
            > owned.entries.len()
    );
    assert_eq!(
        state::classify(&record, &record::FileState::Missing, None).unwrap(),
        state::Observation::Prepared
    );
}
#[test]
fn json_crash_states_require_exact_preimage_or_complete_owned_groups_and_keep_foreign_edits() {
    use record::FileState;
    use state::{classify, Observation};
    let record = initial_record(record::Agent::Codex);
    assert_eq!(
        classify(&record, &FileState::Missing, None).unwrap(),
        Observation::Prepared
    );
    let entries = &record.next.as_ref().unwrap().entries;
    let applied = rewrite("{}\n", &[], entries).unwrap();
    assert_eq!(
        classify(&record, &present(&applied, 7), Some(&applied)).unwrap(),
        Observation::Configured
    );
    let mut changed: Value = serde_json::from_str(&applied).unwrap();
    changed["model"] = "foreign user edit".into();
    let changed = serde_json::to_string(&changed).unwrap();
    assert_eq!(
        classify(&record, &present(&changed, 8), Some(&changed)).unwrap(),
        Observation::Configured
    );
    let partial = rewrite(&applied, &entries[..1], &[]).unwrap();
    assert_eq!(
        classify(&record, &present(&partial, 9), Some(&partial)).unwrap(),
        Observation::Conflict
    );
    let edited = applied.replace("ingest --agent codex", "user edit");
    assert_eq!(
        classify(&record, &present(&edited, 10), Some(&edited)).unwrap(),
        Observation::Conflict
    );
    let mut contradictory = record.clone();
    contradictory.provider_after_sha256 = Some("ee".repeat(32));
    assert_eq!(
        classify(&contradictory, &FileState::Missing, None),
        Err("HooksInvalidRecord")
    );
}
#[test]
fn update_and_removal_never_infer_success_from_partial_or_edited_owned_entries() {
    use state::{classify, Observation};
    let mut record = initial_record(record::Agent::Claude);
    let old = record.next.take().unwrap();
    let before = rewrite("{\"model\":\"foreign\"}\n", &[], &old.entries).unwrap();
    let mut next = old.clone();
    next.binary.path = "/owned/new companion".into();
    next.entries = render::entries(record.agent, &next.binary.path).unwrap();
    let after = rewrite(&before, &old.entries, &next.entries).unwrap();
    record.provider_before = present(&before, 7);
    record.provider_after_sha256 = Some(record::hash(after.as_bytes()));
    record.previous = Some(old.clone());
    record.next = Some(next.clone());
    assert_eq!(
        classify(&record, &record.provider_before, Some(&before)).unwrap(),
        Observation::Prepared
    );
    assert_eq!(
        classify(&record, &present(&after, 8), Some(&after)).unwrap(),
        Observation::Configured
    );
    let duplicate = rewrite(&after, &[], &old.entries).unwrap();
    assert_eq!(
        classify(&record, &present(&duplicate, 9), Some(&duplicate)).unwrap(),
        Observation::Conflict
    );
    let removed = rewrite(&after, &next.entries, &[]).unwrap();
    record.previous = Some(next);
    record.next = None;
    record.provider_before = present(&after, 8);
    record.provider_after_sha256 = Some(record::hash(removed.as_bytes()));
    assert_eq!(
        classify(&record, &record.provider_before, Some(&after)).unwrap(),
        Observation::Prepared
    );
    assert_eq!(
        classify(&record, &present(&removed, 10), Some(&removed)).unwrap(),
        Observation::Removed
    );
    let ambiguous = removed.replace("foreign", "later user edit");
    assert_eq!(
        classify(&record, &present(&ambiguous, 11), Some(&ambiguous)).unwrap(),
        Observation::Conflict
    );
    let edited = after.replace("ingest --agent claude", "modified owned command");
    assert_eq!(
        classify(&record, &present(&edited, 12), Some(&edited)).unwrap(),
        Observation::Conflict
    );
}
#[test]
fn plugin_transitions_use_exact_owned_content_and_reject_contradictory_or_foreign_records() {
    for agent in WHOLE_FILE_AGENTS {
        use state::{classify, Observation};
        let mut record = initial_record(agent);
        let owned = record.next.as_ref().unwrap();
        let plugin = render::owned_file(agent, &owned.binary.path).unwrap();
        assert_eq!(
            classify(&record, &record::FileState::Missing, None).unwrap(),
            Observation::Prepared
        );
        assert_eq!(
            classify(&record, &present(&plugin, 7), Some(&plugin)).unwrap(),
            Observation::Configured
        );
        let foreign = "export const OtherPlugin = () => ({});";
        assert_eq!(
            classify(&record, &present(foreign, 8), Some(foreign)).unwrap(),
            Observation::Conflict
        );
        record.previous = record.next.take();
        record.provider_before = present(&plugin, 7);
        record.provider_after_sha256 = None;
        assert_eq!(
            classify(&record, &record.provider_before, Some(&plugin)).unwrap(),
            Observation::Prepared
        );
        assert_eq!(
            classify(&record, &record::FileState::Missing, None).unwrap(),
            Observation::Removed
        );
        let edited = format!("{plugin}\n// user modification");
        assert_eq!(
            classify(&record, &present(&edited, 9), Some(&edited)).unwrap(),
            Observation::Conflict
        );
        record.provider_before = record::FileState::Missing;
        assert_eq!(
            classify(&record, &record::FileState::Missing, None),
            Err("HooksInvalidRecord")
        );
    }
}

#[cfg(unix)]
struct ProfileFixture {
    _root: tempfile::TempDir,
    target: files::Target,
    companion: std::path::PathBuf,
}
#[cfg(unix)]
impl ProfileFixture {
    fn new(agent: record::Agent) -> Self {
        use std::{fs, os::unix::fs::PermissionsExt};
        // The companion namespace must be physical: macOS keeps its temp dir behind the
        // /var symlink, which admission refuses to follow.
        let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let profile = root.path().join("selected profile");
        fs::create_dir(&profile).unwrap();
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o755)).unwrap();
        if agent == record::Agent::Droid {
            fs::write(profile.join("hooks.json"), "{}\n").unwrap();
        }
        if agent == record::Agent::KimiCode {
            fs::write(
                profile.join("config.toml"),
                "default_model = \"synthetic\"\n",
            )
            .unwrap();
            fs::set_permissions(
                profile.join("config.toml"),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        let companion = root.path().join("private companion's $ path");
        fs::copy(binary::path(), &companion).unwrap();
        if fs::metadata(&companion).unwrap().len() > 64 * 1024 * 1024 {
            assert!(std::process::Command::new("strip")
                .arg(&companion)
                .status()
                .unwrap()
                .success());
        }
        assert!(fs::metadata(&companion).unwrap().len() <= 64 * 1024 * 1024);
        fs::set_permissions(&companion, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            _root: root,
            target: files::Target { agent, profile },
            companion,
        }
    }
    fn inspect(&self) -> files::Inspection {
        files::inspect(self.target.clone(), &self.companion).unwrap()
    }
    fn plan(&self, action: files::Action) -> String {
        self.inspect().plan(action).unwrap().digest().unwrap()
    }
    fn apply(&self, action: files::Action, expected: &str) -> Result<commit::Outcome> {
        commit::apply(self.target.clone(), &self.companion, action, expected)
    }
    fn apply_current(&self, action: files::Action) -> commit::Outcome {
        self.apply(action, &self.plan(action)).unwrap()
    }
    fn provider(&self) -> std::path::PathBuf {
        let parent = self.target.agent.asset_directory().map_or_else(
            || self.target.profile.clone(),
            |name| self.target.profile.join(name),
        );
        parent.join(self.target.agent.provider_name())
    }
    fn manifest(&self) -> std::path::PathBuf {
        self.target
            .profile
            .join(format!(".lazysh-hooks-{}.json", self.target.agent.name()))
    }
    fn prepare_without_provider(&self, expected: &str) {
        interrupt(|point| {
            if point == commit::Boundary::AfterRecord {
                Err(Error::Installation("HooksInterrupted"))
            } else {
                Ok(())
            }
        });
        assert_eq!(
            self.apply(files::Action::Install, expected).unwrap().status,
            "uncertain"
        );
        clear_interrupt();
    }
}
#[cfg(unix)]
impl Drop for ProfileFixture {
    fn drop(&mut self) {
        clear_interrupt();
    }
}

#[cfg(unix)]
#[test]
fn actual_filesystem_installs_reuses_and_removes_owned_entries_without_changing_foreign_values_or_modes(
) {
    use files::Action;
    use std::{fs, os::unix::fs::PermissionsExt};
    let foreign = r#"{ "env" : {"PRIVATE_TOKEN":"foreign-private-value"}, "hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep existing"}]}]} }"#;
    for agent in [record::Agent::Claude, record::Agent::Codex] {
        let fixture = ProfileFixture::new(agent);
        assert!(
            managed_directory::Directory::open(&fixture.target.profile).is_err(),
            "ordinary provider profiles need not be private installation directories"
        );
        fs::write(fixture.provider(), foreign).unwrap();
        fs::set_permissions(fixture.provider(), fs::Permissions::from_mode(0o644)).unwrap();
        let root_mode = fs::metadata(&fixture.target.profile)
            .unwrap()
            .permissions()
            .mode();
        let plan = fixture.plan(Action::Install);
        assert_eq!(
            fs::read_dir(&fixture.target.profile).unwrap().count(),
            1,
            "inspection must not write"
        );
        let outcome = fixture.apply(Action::Install, &plan).unwrap();
        assert_eq!(outcome.status, "configured");
        assert!(outcome.metadata_committed && outcome.provider_committed);
        assert_eq!(
            fs::metadata(fixture.provider())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        assert_eq!(
            fs::metadata(&fixture.target.profile)
                .unwrap()
                .permissions()
                .mode(),
            root_mode
        );
        assert!(!fs::read_to_string(fixture.manifest())
            .unwrap()
            .contains("foreign-private-value"));
        let installed = fs::read_to_string(fixture.provider()).unwrap();
        assert!(installed.contains(r#"{ "env" : {"PRIVATE_TOKEN":"foreign-private-value"}"#));
        let provider_identity = fixture.inspect().provider.state;
        let receipt = fs::read(fixture.manifest()).unwrap();
        let reuse = fixture.apply_current(Action::Install);
        assert_eq!(reuse.status, "reused");
        assert!(!reuse.metadata_committed && !reuse.provider_committed);
        assert_eq!(fixture.inspect().provider.state, provider_identity);
        assert_eq!(fs::read(fixture.manifest()).unwrap(), receipt);
        let removed = fixture.apply_current(Action::Remove);
        assert_eq!(removed.status, "removed");
        let clean = fs::read_to_string(fixture.provider()).unwrap();
        assert!(clean.contains(r#"{"type":"command","command":"keep existing"}"#));
        assert!(!clean.contains("ingest --agent"));
        assert!(
            fixture.apply(Action::Install, &plan).is_err(),
            "intervening operations must retire old plans"
        );
    }
}

#[cfg(unix)]
#[test]
fn owned_plugin_absent_install_remove_aba_cannot_replay_the_initial_inspection() {
    for agent in WHOLE_FILE_AGENTS {
        use files::Action;
        use std::fs;
        let fixture = ProfileFixture::new(agent);
        let settings = fixture.target.profile.join("settings.json");
        fs::write(
            &settings,
            "{\"disabledPlugins\":[\"lazysh-root-lifecycle\"]}\n",
        )
        .unwrap();
        let original = fixture.plan(Action::Install);
        assert!(!fixture
            .target
            .profile
            .join(agent.asset_directory().unwrap())
            .exists());
        assert_eq!(
            fixture.apply(Action::Install, &original).unwrap().status,
            "configured"
        );
        fs::write(
            fixture.provider().parent().unwrap().join("foreign.js"),
            "preserve other plugin",
        )
        .unwrap();
        assert_eq!(fixture.apply_current(Action::Remove).status, "removed");
        assert!(!fixture.provider().exists());
        assert_eq!(
            fs::read_to_string(&settings).unwrap(),
            "{\"disabledPlugins\":[\"lazysh-root-lifecycle\"]}\n"
        );
        fs::write(fixture.provider(), "foreign plugin").unwrap();
        assert_eq!(
            fixture.inspect().observation,
            Some(state::Observation::Conflict)
        );
        assert!(fixture.apply(Action::Install, &original).is_err());
        assert_eq!(
            fs::read_to_string(fixture.provider()).unwrap(),
            "foreign plugin"
        );
        assert_eq!(
            fs::read_to_string(fixture.provider().parent().unwrap().join("foreign.js")).unwrap(),
            "preserve other plugin"
        );
        assert!(fixture.apply(Action::Install, &original).is_err());
        assert!(
            fixture.manifest().exists(),
            "retain the ownership tombstone"
        );
    }
}

#[cfg(unix)]
#[test]
fn fixed_commit_boundary_interruptions_leave_observable_state_and_require_a_fresh_explicit_plan() {
    use commit::Boundary;
    use files::Action;
    for point in [
        Boundary::BeforeRecord,
        Boundary::AfterRecord,
        Boundary::BeforeProvider,
        Boundary::AfterProvider,
    ] {
        let fixture = ProfileFixture::new(record::Agent::Codex);
        let plan = fixture.plan(Action::Install);
        interrupt(move |current| {
            if current == point {
                Err(Error::Installation("HooksInterrupted"))
            } else {
                Ok(())
            }
        });
        let outcome = fixture.apply(Action::Install, &plan);
        clear_interrupt();
        if point == Boundary::BeforeRecord {
            assert!(outcome.is_err());
            assert!(!fixture.manifest().exists());
            assert!(!fixture.provider().exists());
        } else {
            let outcome = outcome.unwrap();
            assert_eq!(outcome.status, "uncertain");
            let observed = fixture.inspect().observation.unwrap();
            if point == Boundary::AfterProvider {
                assert!(outcome.provider_committed);
                assert_eq!(observed, state::Observation::Configured);
            } else {
                assert!(!outcome.provider_committed);
                assert!(!fixture.provider().exists());
                assert_eq!(observed, state::Observation::Prepared);
            }
            assert!(fixture.apply(Action::Install, &plan).is_err());
        }
        let resumed = fixture.apply_current(Action::Install);
        assert!(matches!(resumed.status, "configured" | "reused"));
        assert_eq!(
            fixture.inspect().observation,
            Some(state::Observation::Configured)
        );
    }
}

#[cfg(unix)]
#[test]
fn canceling_a_prepared_first_install_retains_a_nonreplayable_metadata_tombstone() {
    for agent in WHOLE_FILE_AGENTS {
        use files::Action;
        let fixture = ProfileFixture::new(agent);
        let original = fixture.plan(Action::Install);
        fixture.prepare_without_provider(&original);
        let canceled = fixture.apply_current(Action::Remove);
        assert_eq!(canceled.status, "removed");
        assert!(!canceled.provider_committed);
        assert!(!fixture.provider().exists());
        assert_eq!(
            fixture.inspect().observation,
            Some(state::Observation::Removed)
        );
        assert!(fixture.apply(Action::Install, &original).is_err());
    }
}

#[test]
fn provider_changes_at_both_commit_cutoffs_are_preserved_and_never_replayed() {
    use files::Action;
    use std::fs;
    for point in [
        commit::Boundary::BeforeRecord,
        commit::Boundary::BeforeProvider,
    ] {
        let fixture = ProfileFixture::new(record::Agent::Claude);
        fs::write(fixture.provider(), "{\"model\":\"original\"}").unwrap();
        let original = fixture.plan(Action::Install);
        let path = fixture.provider();
        interrupt(move |current| {
            if current == point {
                fs::write(&path, "{\"model\":\"foreign concurrent edit\"}")?;
            }
            Ok(())
        });
        let result = fixture.apply(Action::Install, &original);
        clear_interrupt();
        assert_eq!(
            fs::read_to_string(fixture.provider()).unwrap(),
            "{\"model\":\"foreign concurrent edit\"}"
        );
        if point == commit::Boundary::BeforeRecord {
            assert!(result.is_err());
            assert!(!fixture.manifest().exists());
        } else {
            let result = result.unwrap();
            assert_eq!(result.status, "uncertain");
            assert!(!result.provider_committed);
            assert_eq!(
                fixture.inspect().observation,
                Some(state::Observation::Conflict)
            );
            assert!(fixture.inspect().plan(Action::Install).is_err());
        }
    }
}

#[test]
fn source_and_profile_replacements_before_provider_commit_cannot_change_the_replacement_namespace()
{
    use files::Action;
    use std::fs;
    for replace_profile in [false, true] {
        let fixture = ProfileFixture::new(record::Agent::Codex);
        fs::write(fixture.provider(), "{\"model\":\"original\"}").unwrap();
        let plan = fixture.plan(Action::Install);
        let profile = fixture.target.profile.clone();
        let original_profile = fixture._root.path().join("original profile");
        let companion = fixture.companion.clone();
        interrupt(move |point| {
            if point == commit::Boundary::BeforeProvider {
                if replace_profile {
                    fs::rename(&profile, &original_profile)?;
                    fs::create_dir(&profile)?;
                    fs::write(profile.join("sentinel"), "foreign replacement stays")?;
                } else {
                    fs::write(&companion, "changed executable")?;
                }
            }
            Ok(())
        });
        let result = fixture.apply(Action::Install, &plan).unwrap();
        clear_interrupt();
        assert_eq!(result.status, "uncertain");
        assert!(!result.provider_committed);
        if replace_profile {
            assert_eq!(
                fs::read_to_string(fixture.target.profile.join("sentinel")).unwrap(),
                "foreign replacement stays"
            );
            assert!(!fixture.provider().exists());
            assert_eq!(
                fs::read_to_string(fixture._root.path().join("original profile/hooks.json"))
                    .unwrap(),
                "{\"model\":\"original\"}"
            );
        } else {
            assert_eq!(
                fs::read_to_string(fixture.provider()).unwrap(),
                "{\"model\":\"original\"}"
            );
        }
    }
}

#[test]
fn canceled_plugin_setup_with_a_missing_plugins_directory_never_reads_a_same_named_root_file() {
    for agent in WHOLE_FILE_AGENTS {
        use files::Action;
        use std::fs;
        let fixture = ProfileFixture::new(agent);
        fixture.prepare_without_provider(&fixture.plan(Action::Install));
        fs::remove_dir(
            fixture
                .target
                .profile
                .join(agent.asset_directory().unwrap()),
        )
        .unwrap();
        let unrelated = fixture.target.profile.join(agent.provider_name());
        fs::write(&unrelated, "foreign root file").unwrap();
        let result = fixture.apply_current(Action::Remove);
        assert_eq!(result.status, "removed");
        assert!(!result.provider_committed);
        assert!(!fixture
            .target
            .profile
            .join(agent.asset_directory().unwrap())
            .exists());
        assert_eq!(fs::read_to_string(unrelated).unwrap(), "foreign root file");
    }
}

#[test]
fn unsafe_provider_files_locks_and_oversized_binaries_are_refused_without_mutating_user_files() {
    use files::Action;
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
    };
    let fixture = ProfileFixture::new(record::Agent::Claude);
    let victim = fixture._root.path().join("victim");
    fs::write(&victim, "untouched victim").unwrap();
    symlink(&victim, fixture.provider()).unwrap();
    assert!(files::inspect(fixture.target.clone(), &fixture.companion).is_err());
    fs::remove_file(fixture.provider()).unwrap();
    fs::hard_link(&victim, fixture.provider()).unwrap();
    assert!(files::inspect(fixture.target.clone(), &fixture.companion).is_err());
    fs::remove_file(fixture.provider()).unwrap();
    fs::write(fixture.provider(), "{}").unwrap();
    fs::set_permissions(fixture.provider(), fs::Permissions::from_mode(0o444)).unwrap();
    assert!(fixture
        .apply(Action::Install, &fixture.plan(Action::Install))
        .is_err());
    assert_eq!(
        fs::metadata(fixture.provider())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o444
    );
    fs::set_permissions(fixture.provider(), fs::Permissions::from_mode(0o644)).unwrap();
    fs::remove_file(fixture.target.profile.join(".lazysh-hooks.lock")).unwrap();
    symlink(&victim, fixture.target.profile.join(".lazysh-hooks.lock")).unwrap();
    assert!(fixture
        .apply(Action::Install, &fixture.plan(Action::Install))
        .is_err());
    assert_eq!(fs::read_to_string(&victim).unwrap(), "untouched victim");
    fs::OpenOptions::new()
        .write(true)
        .open(&fixture.companion)
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    assert!(files::inspect(fixture.target.clone(), &fixture.companion).is_err());
    assert!(!fixture.manifest().exists());
    assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), "{}");
}

#[test]
#[ignore = "requires LAZYSH_TEST_PROFILE_GID selecting an available non-primary supplementary group"]
fn actual_different_provider_group_is_plan_bound_and_preserved_through_install_and_remove() {
    use files::Action;
    use std::{
        fs,
        os::unix::{
            fs::{MetadataExt, PermissionsExt},
            io::AsRawFd,
        },
    };
    let group: u32 = std::env::var("LAZYSH_TEST_PROFILE_GID")
        .expect("explicit fixture group required")
        .parse()
        .unwrap();
    let length = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    assert!(length >= 0);
    let mut memberships = vec![0; length as usize];
    assert_eq!(
        unsafe { libc::getgroups(length, memberships.as_mut_ptr()) },
        length
    );
    assert!(memberships.contains(&group));
    assert_ne!(group, unsafe { libc::getegid() });
    let fixture = ProfileFixture::new(record::Agent::Codex);
    fs::write(
        fixture.provider(),
        "{\"env\":{\"PRIVATE\":\"foreign private value\"}}",
    )
    .unwrap();
    let file = fs::OpenOptions::new()
        .write(true)
        .open(fixture.provider())
        .unwrap();
    assert_eq!(unsafe { libc::fchown(file.as_raw_fd(), !0, group) }, 0);
    fs::set_permissions(fixture.provider(), fs::Permissions::from_mode(0o640)).unwrap();
    let mut plan = fixture.inspect().plan(Action::Install).unwrap();
    assert_eq!(plan.provider_group, Some(group));
    let approved = plan.digest().unwrap();
    plan.provider_group = Some(unsafe { libc::getegid() });
    assert_ne!(
        plan.digest().unwrap(),
        approved,
        "group is part of the inspected plan"
    );
    assert_eq!(
        fixture.apply(Action::Install, &approved).unwrap().status,
        "configured"
    );
    for action in [Action::Install, Action::Remove] {
        let mode = fs::metadata(fixture.provider()).unwrap();
        assert_eq!(mode.gid(), group);
        assert_eq!(mode.mode() & 0o7777, 0o640);
        assert_eq!(mode.uid(), unsafe { libc::geteuid() });
        let result = fixture.apply(action, &fixture.plan(action)).unwrap();
        assert!(matches!(result.status, "reused" | "removed"));
    }
    assert_eq!(fs::metadata(fixture.provider()).unwrap().gid(), group);
    assert!(fs::read_to_string(fixture.provider())
        .unwrap()
        .contains("foreign private value"));
}

/// Adds one ACL the installer cannot preserve: an access ACL on a file, or an entry
/// that new children of a directory would inherit when `default` is set.
fn set_fixture_acl(path: &std::path::Path, default: bool) {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        // Linux UAPI POSIX_ACL_XATTR_VERSION=2 and five little-endian entries.
        // A named group read entry remains masked on a 0600 inherited stage.
        let mut acl = 2_u32.to_le_bytes().to_vec();
        for (tag, permissions, id) in [
            (1_u16, 7_u16, u32::MAX),
            (4, 0, u32::MAX),
            (8, 4, 3),
            (16, 4, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            acl.extend(tag.to_le_bytes());
            acl.extend(permissions.to_le_bytes());
            acl.extend(id.to_le_bytes());
        }
        let name = if default {
            c"system.posix_acl_default"
        } else {
            c"system.posix_acl_access"
        };
        let file = std::fs::File::open(path).unwrap();
        // SAFETY: this is an owned fixture descriptor and a complete Linux ACL value.
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    acl.as_ptr().cast(),
                    acl.len(),
                    0,
                )
            },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
    }
    #[cfg(target_os = "macos")]
    {
        let entry = if default {
            "everyone allow read,file_inherit"
        } else {
            "everyone allow read"
        };
        let status = std::process::Command::new("/bin/chmod")
            .args(["+a", entry])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success(), "chmod +a {entry} failed");
    }
}

#[cfg(unix)]
#[test]
fn actual_acls_and_special_modes_refuse_mutation_and_late_acl_keeps_provider_intact() {
    use std::{fs, os::unix::fs::PermissionsExt};
    for default in [false, true] {
        let fixture = ProfileFixture::new(record::Agent::Claude);
        fs::write(fixture.provider(), "{\"foreign\":\"private\"}").unwrap();
        let path = if default {
            &fixture.target.profile
        } else {
            &fixture.provider()
        };
        set_fixture_acl(path, default);
        let error = match files::inspect(fixture.target.clone(), &fixture.companion) {
            Err(error) => error,
            Ok(_) => panic!("ACL was accepted"),
        };
        assert!(matches!(error, Error::Installation("HooksUnhandledAcl")));
        assert_eq!(
            fs::read_to_string(fixture.provider()).unwrap(),
            "{\"foreign\":\"private\"}"
        );
        assert!(!fixture.manifest().exists());
        assert!(!fixture.target.profile.join(".lazysh-hooks.lock").exists());
    }
    let fixture = ProfileFixture::new(record::Agent::Claude);
    fs::write(fixture.provider(), "{}").unwrap();
    for mode in [0o4644, 0o2644, 0o1644] {
        fs::set_permissions(fixture.provider(), fs::Permissions::from_mode(mode)).unwrap();
        assert!(matches!(
            files::inspect(fixture.target.clone(), &fixture.companion),
            Err(Error::Installation("HooksUnsafeFile"))
        ));
        assert_eq!(
            fs::metadata(fixture.provider())
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            mode
        );
    }
    fs::set_permissions(fixture.provider(), fs::Permissions::from_mode(0o644)).unwrap();
    let plan = fixture.plan(files::Action::Install);
    let profile = fixture.target.profile.clone();
    interrupt(move |point| {
        if point == commit::Boundary::BeforeRecord {
            set_fixture_acl(&profile, true);
        }
        Ok(())
    });
    assert!(matches!(
        fixture.apply(files::Action::Install, &plan),
        Err(Error::Installation("HooksUnhandledAcl"))
    ));
    clear_interrupt();
    assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), "{}");
    assert!(!fixture.manifest().exists());
}

#[cfg(unix)]
impl ProfileFixture {
    /// The companion store this fixture's hooks and status run against, absent until a hook reports.
    fn state(&self) -> std::path::PathBuf {
        self._root.path().join("state")
    }
    fn cli(&self, action: &str, plan: Option<&str>) -> Value {
        self.cli_in(&self.state(), action, plan)
    }
    fn cli_in(&self, state: &std::path::Path, action: &str, plan: Option<&str>) -> Value {
        let mut command = std::process::Command::new(&self.companion);
        command
            .env_clear()
            .env("PATH", "")
            .env("LAZYSH_STATE_DIR", state)
            .args(["hooks", action, "--agent", self.target.agent.name()]);
        if action != "preview" {
            command.arg("--profile-root").arg(&self.target.profile);
        }
        if let Some(plan) = plan {
            command.args(["--expected-plan", plan]);
        }
        json_output::decode(command.output().unwrap())
    }
}
#[cfg(target_os = "linux")]
impl ProfileFixture {
    /// A hand-saved copy of the owned file is foreign: install refuses it, leaves it as it was, and the way is then cleared.
    fn assert_manual_copy_is_foreign(&self, manual: &str) {
        std::fs::write(self.provider(), manual).unwrap();
        assert!(matches!(
            self.inspect().plan(files::Action::Install),
            Err(Error::Installation("HooksForeignPlugin"))
        ));
        assert_eq!(std::fs::read_to_string(self.provider()).unwrap(), manual);
        std::fs::remove_file(self.provider()).unwrap();
    }
    /// Installs the inspected plan and returns the `hooks/lazysh.json` it wrote.
    fn install_hook_file(&self) -> Value {
        let plan = self.plan(files::Action::Install);
        assert_eq!(
            self.apply(files::Action::Install, &plan).unwrap().status,
            "configured"
        );
        assert_eq!(
            self.provider(),
            self.target.profile.join("hooks/lazysh.json")
        );
        serde_json::from_slice(&std::fs::read(self.provider()).unwrap()).unwrap()
    }
    /// Installing again is a no-op and removal deletes only the owned file: foreign files stay byte for byte.
    fn assert_reuse_then_remove_keeps(&self, preserved: &[(std::path::PathBuf, &str)]) {
        assert_eq!(self.apply_current(files::Action::Install).status, "reused");
        assert_eq!(self.apply_current(files::Action::Remove).status, "removed");
        assert!(!self.provider().exists());
        for (path, bytes) in preserved {
            assert_eq!(std::fs::read_to_string(path).unwrap(), *bytes);
        }
    }
    /// An owned file edited in place is a conflict that setup refuses to overwrite.
    fn assert_edit_conflicts(&self, edited: impl AsRef<[u8]>) {
        std::fs::write(self.provider(), edited).unwrap();
        let inspect = self.inspect();
        assert_eq!(inspect.observation, Some(state::Observation::Conflict));
        assert!(inspect.plan(files::Action::Install).is_err());
    }
}
/// Runs a hook command the way an agent does: nothing on `PATH`, the event on stdin, private state,
/// and the terminal pane the agent runs in, if any.
fn run_hook(
    child: &mut std::process::Command,
    state: &std::path::Path,
    pane: Option<&str>,
    payload: &Value,
) {
    child
        .env_clear()
        .env("PATH", "")
        .env("LAZYSH_STATE_DIR", state);
    if let Some(pane) = pane {
        child.env("TMUX_PANE", pane);
    }
    assert!(process::run(child, &serde_json::to_vec(payload).unwrap())
        .status
        .success());
}
/// Profile directories that discovery must report invalid instead of guessing another one.
fn invalid_profile_overrides() -> [&'static std::ffi::OsStr; 6] {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    [
        OsStr::new(" "),
        OsStr::new("relative"),
        OsStr::new("~/chosen"),
        OsStr::new("/owned/../profile"),
        OsStr::new("/owned/\nprofile"),
        OsStr::from_bytes(b"/owned/\xff"),
    ]
}

#[cfg(unix)]
#[test]
fn actual_managed_hook_cli_previews_and_lifecycle_use_only_the_selected_profile() {
    for agent in [
        record::Agent::Claude,
        record::Agent::Codex,
        record::Agent::Droid,
        record::Agent::Gemini,
        record::Agent::Cursor,
        record::Agent::Opencode,
        record::Agent::Cline,
        record::Agent::Copilot,
        record::Agent::Amp,
        record::Agent::KimiCode,
        record::Agent::Grok,
    ] {
        let fixture = ProfileFixture::new(agent);
        let preview = fixture.cli("preview", None);
        assert_eq!(preview["reporting"], "notChecked");
        if agent == record::Agent::Droid {
            assert!(preview["asset"].get("hooks").is_none());
            assert_eq!(
                preview["asset"]["UserPromptSubmit"][0]["hooks"][0]["timeout"],
                5
            );
        }
        assert!(!fixture.manifest().exists());
        let status = fixture.cli("status", None);
        let configured = fixture.cli("install", status["installPlan"].as_str());
        assert_eq!(configured["outcome"]["status"], "configured");
        let status = fixture.cli("status", None);
        assert_eq!(status["state"], "configured");
        assert_eq!(status["trust"], "notChecked");
        let reused = fixture.cli("install", status["installPlan"].as_str());
        assert_eq!(reused["outcome"]["status"], "reused");
        let removed = fixture.cli("remove", status["removePlan"].as_str());
        assert_eq!(removed["outcome"]["status"], "removed");
        assert_eq!(fixture.cli("status", None)["state"], "removed");
    }
}

/// A profile whose directory was copied, restored or remounted keeps its settings and ownership record
/// but not its device and inode; the foreign hooks stay untouched and setup stays usable.
#[cfg(unix)]
#[test]
fn a_recreated_profile_directory_keeps_status_and_removal_working_and_the_foreign_hooks_intact() {
    use std::{fs, os::unix::fs::PermissionsExt};
    let foreign = r#"{ "model":"opus", "hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/other-tool guard"}]}],"Stop":[{"hooks":[{"type":"command","command":"notify-send done"}]}]} }"#;
    let fixture = ProfileFixture::new(record::Agent::Claude);
    fs::write(fixture.provider(), foreign).unwrap();
    fs::set_permissions(fixture.provider(), fs::Permissions::from_mode(0o600)).unwrap();
    let status = fixture.cli("status", None);
    assert_eq!(
        fixture.cli("install", status["installPlan"].as_str())["outcome"]["status"],
        "configured"
    );
    let installed = fs::read_to_string(fixture.provider()).unwrap();
    let profile = &fixture.target.profile;
    let old = profile.with_extension("old");
    fs::rename(profile, &old).unwrap();
    fs::create_dir(profile).unwrap();
    fs::set_permissions(profile, fs::Permissions::from_mode(0o755)).unwrap();
    for name in ["settings.json", ".lazysh-hooks-claude.json"] {
        fs::rename(old.join(name), profile.join(name)).unwrap();
    }
    let status = fixture.cli("status", None);
    assert_eq!(status["supported"], true);
    assert_eq!(status["state"], "configured");
    assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), installed);
    for (action, plan, outcome) in [
        ("install", "installPlan", "reused"),
        ("remove", "removePlan", "removed"),
    ] {
        assert_eq!(
            fixture.cli(action, status[plan].as_str())["outcome"]["status"],
            outcome
        );
    }
    let cleaned = fs::read_to_string(fixture.provider()).unwrap();
    assert!(!cleaned.contains("ingest --agent"));
    let (cleaned, foreign): (Value, Value) = (
        serde_json::from_str(&cleaned).unwrap(),
        serde_json::from_str(foreign).unwrap(),
    );
    for event in ["PreToolUse", "Stop"] {
        assert_eq!(cleaned["hooks"][event], foreign["hooks"][event]);
    }
    assert_eq!(cleaned["model"], foreign["model"]);
}

/// An ownership record written for another profile folder is not trusted: status says so and changes nothing,
/// and install or remove refuse without touching the settings.
#[cfg(unix)]
#[test]
fn an_ownership_record_of_another_profile_folder_is_reported_by_status_and_never_applied() {
    use std::fs;
    let mut fixture = ProfileFixture::new(record::Agent::Claude);
    fs::write(fixture.provider(), r#"{"theme":"dark"}"#).unwrap();
    let status = fixture.cli("status", None);
    fixture.cli("install", status["installPlan"].as_str());
    let installed = fs::read(fixture.provider()).unwrap();
    let moved = fixture.target.profile.with_extension("moved");
    fs::rename(&fixture.target.profile, &moved).unwrap();
    fixture.target.profile = moved;
    let status = fixture.cli("status", None);
    assert_eq!(status["supported"], false);
    assert_eq!(status["reason"], "HooksForeignRecord");
    let plan = "0".repeat(64);
    for action in ["install", "remove"] {
        let output = std::process::Command::new(&fixture.companion)
            .env_clear()
            .env("PATH", "")
            .env("LAZYSH_STATE_DIR", fixture.state())
            .args(["hooks", action, "--agent", "claude", "--profile-root"])
            .arg(&fixture.target.profile)
            .args(["--expected-plan", &plan])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("HooksForeignRecord"));
    }
    assert_eq!(fs::read(fixture.provider()).unwrap(), installed);
}

/// The store's file names and the bytes of every file it can have: database, write-ahead log and shared-memory index.
#[cfg(target_os = "linux")]
fn store_fingerprint(state: &std::path::Path) -> (Vec<String>, Vec<Vec<u8>>) {
    let mut names: Vec<String> = std::fs::read_dir(state)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    let bytes = ["events.sqlite3", "events.sqlite3-wal", "events.sqlite3-shm"]
        .map(|name| std::fs::read(state.join(name)).unwrap_or_default());
    (names, bytes.into())
}

#[cfg(target_os = "linux")]
#[test]
fn hook_status_tells_configured_but_silent_from_a_received_local_event_and_never_writes_the_store()
{
    let prompt = json!({"hook_event_name":"UserPromptSubmit","session_id":"ready","cwd":"/work"});
    let cases = [
        (record::Agent::Claude, prompt.clone()),
        (record::Agent::Codex, prompt.clone()),
        (record::Agent::Droid, prompt.clone()),
        (record::Agent::Copilot, prompt),
        (
            record::Agent::Gemini,
            json!({"hook_event_name":"BeforeAgent","session_id":"ready","cwd":"/work"}),
        ),
        (
            record::Agent::Cursor,
            json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"ready","cwd":"/work"}),
        ),
        (
            record::Agent::Opencode,
            json!({"type":"session.status","properties":{"sessionID":"ready","status":{"type":"busy"}},"directory":"/work"}),
        ),
        (
            record::Agent::Cline,
            json!({"schemaVersion":1,"agentId":"a","conversationId":"ready","runId":"r","status":"start","directory":"/work"}),
        ),
        (
            record::Agent::Amp,
            json!({"schemaVersion":1,"threadId":"ready","state":"running","directory":"/work"}),
        ),
    ];
    let bystanders = [
        ProfileFixture::new(record::Agent::Claude),
        ProfileFixture::new(record::Agent::Codex),
    ];
    for (agent, payload) in cases {
        let fixture = ProfileFixture::new(agent);
        let state = fixture.state();
        let status = fixture.cli("status", None);
        assert_eq!(status["readiness"]["localEvent"], json!({"state":"none"}));
        assert!(!state.exists(), "status created the store for {agent:?}");
        // Configured but silent: the hook files exist and no event has arrived.
        fixture.cli("install", status["installPlan"].as_str());
        let silent = fixture.cli("status", None);
        assert_eq!(silent["state"], "configured");
        assert_eq!(silent["readiness"]["localEvent"], json!({"state":"none"}));
        assert!(!state.exists());
        // The companion binary the hook runs records one lifecycle event.
        let mut ingest = std::process::Command::new(&fixture.companion);
        ingest
            .args(["ingest", "--agent", agent.name()])
            .env_clear()
            .env("PATH", "")
            .env("LAZYSH_STATE_DIR", &state);
        assert!(
            process::run(&mut ingest, &serde_json::to_vec(&payload).unwrap())
                .status
                .success()
        );
        let reported = snapshot(&fixture.companion, &state)["sessions"][0]["updatedAt"].clone();
        let before = store_fingerprint(&state);
        let received = fixture.cli("status", None);
        assert_eq!(received["state"], "configured");
        assert_eq!(
            received["readiness"]["localEvent"],
            json!({"state":"received","lastEventAt":reported})
        );
        assert_eq!(store_fingerprint(&state), before, "status wrote the store");
        // What this host cannot observe is never guessed, and the old fields stay as they were.
        for key in [
            "providerReloaded",
            "projectTrusted",
            "paneBound",
            "remoteDelivery",
        ] {
            assert_eq!(received["readiness"][key], "notChecked");
        }
        assert_eq!(received["readiness"]["schemaVersion"], 1);
        assert_eq!(received["reporting"], "notChecked");
        assert_eq!(received["trust"], "notChecked");
        // The event is the agent's own: another agent on the same store has reported nothing.
        let other = &bystanders[usize::from(agent == record::Agent::Claude)];
        assert_eq!(
            other.cli_in(&state, "status", None)["readiness"]["localEvent"],
            json!({"state":"none"})
        );
    }
}

/// Regression (#1766, #1944): SQLite's read-only mode created a missing write-ahead index and deleted the log of an empty
/// database, so a status read changed the store it only meant to read.
#[cfg(target_os = "linux")]
#[test]
fn hook_status_never_creates_changes_or_deletes_a_file_of_the_store() {
    use std::fs;
    let unchecked = json!({"state":"notChecked"});
    let fixture = ProfileFixture::new(record::Agent::Claude);
    let state = fixture.state();
    // An empty database beside a log: SQLite deletes such a log when it opens the database.
    fs::create_dir(&state).unwrap();
    fs::write(state.join("events.sqlite3"), b"").unwrap();
    fs::write(state.join("events.sqlite3-wal"), b"sentinel").unwrap();
    let before = store_fingerprint(&state);
    assert_eq!(
        fixture.cli("status", None)["readiness"]["localEvent"],
        unchecked
    );
    assert_eq!(
        store_fingerprint(&state),
        before,
        "status changed the store"
    );
    // A real store whose write-ahead index is gone: it is neither rebuilt nor repaired, and the state is not guessed.
    fs::remove_file(state.join("events.sqlite3")).unwrap();
    fs::remove_file(state.join("events.sqlite3-wal")).unwrap();
    let mut ingest = std::process::Command::new(&fixture.companion);
    ingest
        .args(["ingest", "--agent", record::Agent::Claude.name()])
        .env_clear()
        .env("PATH", "")
        .env("LAZYSH_STATE_DIR", &state);
    let prompt = json!({"hook_event_name":"UserPromptSubmit","session_id":"ready","cwd":"/work"});
    assert!(
        process::run(&mut ingest, &serde_json::to_vec(&prompt).unwrap())
            .status
            .success()
    );
    let index = state.join("events.sqlite3-shm");
    if index.exists() {
        fs::remove_file(&index).unwrap();
    }
    let before = store_fingerprint(&state);
    assert_eq!(
        fixture.cli("status", None)["readiness"]["localEvent"],
        unchecked
    );
    assert!(!index.exists(), "status created the write-ahead index");
    assert_eq!(
        store_fingerprint(&state),
        before,
        "status changed the store"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn hook_status_leaves_the_local_event_unchecked_when_the_store_cannot_be_read_safely() {
    use std::{fs, os::unix::fs::symlink};
    let unchecked = json!({"state":"notChecked"});
    let fixture = ProfileFixture::new(record::Agent::Claude);
    let state = fixture.state();
    fs::create_dir(&state).unwrap();
    let database = state.join("events.sqlite3");
    fs::write(&database, "not a database").unwrap();
    assert_eq!(
        fixture.cli("status", None)["readiness"]["localEvent"],
        unchecked
    );
    assert_eq!(fs::read(&database).unwrap(), b"not a database");
    // A linked database is never followed, so whatever it points at is never read or changed.
    fs::remove_file(&database).unwrap();
    let elsewhere = state.join("elsewhere");
    fs::write(&elsewhere, "").unwrap();
    symlink(&elsewhere, &database).unwrap();
    assert_eq!(
        fixture.cli("status", None)["readiness"]["localEvent"],
        unchecked
    );
    assert_eq!(fs::read(&elsewhere).unwrap(), b"");
}

#[cfg(unix)]
#[test]
fn executable_namespaces_admit_owned_and_root_parents_but_refuse_mutable_and_linked_routes() {
    use std::{
        fs,
        os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    };
    let system = std::path::Path::new("/usr/bin/true");
    assert_eq!(
        fs::symlink_metadata(system.parent().unwrap())
            .unwrap()
            .uid(),
        0
    );
    assert!(
        files::binary(system).is_ok(),
        "read-only root-owned executable namespace must remain supported"
    );
    if unsafe { libc::geteuid() } != 0 {
        assert!(
            managed_directory::Directory::profile(system.parent().unwrap()).is_err(),
            "executable admission must not relax mutable profile ownership"
        );
    }
    let mut fixture = ProfileFixture::new(record::Agent::Claude);
    let outer = fixture._root.path().join("source tools");
    let parent = outer.join("bin");
    fs::create_dir_all(&parent).unwrap();
    let source = parent.join("owned companion");
    fs::rename(&fixture.companion, &source).unwrap();
    fixture.companion = source;
    let original = files::binary(&fixture.companion).unwrap();
    assert_eq!(original.identity.links, 1);
    for (directory, mode) in [
        (&outer, 0o777),
        (&outer, 0o775),
        (&parent, 0o1777),
        (&parent, 0o1775),
    ] {
        fs::set_permissions(&outer, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(mode)).unwrap();
        assert!(
            files::binary(&fixture.companion).is_err(),
            "mutable source ancestor {mode:o} was accepted"
        );
    }
    fs::set_permissions(&outer, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
    let alias = fixture._root.path().join("source alias");
    symlink(&outer, &alias).unwrap();
    assert!(files::binary(&alias.join("bin/owned companion")).is_err());
    assert_eq!(files::binary(&fixture.companion).unwrap(), original);
    let retained = managed_directory::Directory::executable_parent(&parent).unwrap();
    fs::rename(&parent, outer.join("old-bin")).unwrap();
    fs::create_dir(&parent).unwrap();
    assert!(
        retained.check().is_err(),
        "retained source parent must match the current pathname"
    );
    assert!(!fixture.manifest().exists());
}

#[cfg(unix)]
#[test]
fn source_namespace_changes_at_each_commit_cutoff_never_publish_provider_hooks() {
    use std::{fs, os::unix::fs::PermissionsExt};
    for cutoff in [
        commit::Boundary::BeforeRecord,
        commit::Boundary::BeforeProvider,
    ] {
        let mut fixture = ProfileFixture::new(record::Agent::Claude);
        let parent = fixture._root.path().join("isolated source");
        fs::create_dir(&parent).unwrap();
        let source = parent.join("lazysh-agent");
        fs::rename(&fixture.companion, &source).unwrap();
        fixture.companion = source;
        fs::write(fixture.provider(), "{\"foreign\":true}").unwrap();
        let plan = fixture.plan(files::Action::Install);
        interrupt(move |point| {
            if point == cutoff {
                fs::set_permissions(&parent, fs::Permissions::from_mode(0o777))?;
            }
            Ok(())
        });
        let result = fixture.apply(files::Action::Install, &plan);
        clear_interrupt();
        if cutoff == commit::Boundary::BeforeRecord {
            assert!(result.is_err());
            assert!(!fixture.manifest().exists());
        } else {
            let outcome = result.unwrap();
            assert_eq!(outcome.status, "uncertain");
            assert!(outcome.metadata_committed);
            assert!(!outcome.provider_committed);
        }
        assert_eq!(
            fs::read_to_string(fixture.provider()).unwrap(),
            "{\"foreign\":true}"
        );
    }
}

#[test]
fn gemini_and_cursor_configuration_preserves_disable_policy_and_exact_native_envelopes() {
    let binary = std::path::Path::new("/owned/companion's $ path");
    let gemini_policy = r#"{ "enabled":false, "disabled":["foreign-command"] }"#;
    let cursor_policy = r#"{ "command":"foreign", "failClosed":true }"#;
    for (agent, original, preserved) in [
        (
            record::Agent::Gemini,
            format!(r#"{{"hooksConfig":{gemini_policy},"custom":{{ "keep":1e+02 }}}}"#),
            gemini_policy,
        ),
        (
            record::Agent::Cursor,
            format!(
                r#"{{"version":1,"hooks":{{"beforeShellExecution":[{cursor_policy}]}},"custom":{{ "keep":1e+02 }}}}"#
            ),
            cursor_policy,
        ),
    ] {
        let entries = render::entries(agent, binary).unwrap();
        let installed = render::configuration(agent, &original, &[], &entries).unwrap();
        assert!(installed.contains(preserved));
        assert!(installed.contains(r#"{ "keep":1e+02 }"#));
        let config: Value = serde_json::from_str(&installed).unwrap();
        if agent == record::Agent::Gemini {
            assert_eq!(config["hooksConfig"]["enabled"], false);
            assert_eq!(
                config["hooks"]["BeforeAgent"][0]["hooks"][0]["timeout"],
                5000
            );
        } else {
            assert_eq!(config["version"], 1);
            assert_eq!(config["hooks"]["beforeSubmitPrompt"][0]["timeout"], 5);
            assert!(config["hooks"]["beforeSubmitPrompt"][0]
                .get("failClosed")
                .is_none());
            for excluded in [
                "beforeMCPExecution",
                "beforeReadFile",
                "beforeTabFileRead",
                "subagentStart",
                "preToolUse",
            ] {
                assert!(config["hooks"].get(excluded).is_none());
            }
            assert_eq!(
                config["hooks"]["beforeShellExecution"],
                serde_json::from_str::<Value>(&format!("[{cursor_policy}]")).unwrap()
            );
        }
        let removed = render::configuration(agent, &installed, &entries, &[]).unwrap();
        assert!(removed.contains(preserved));
        assert!(json::counts(&removed, &entries, false)
            .unwrap()
            .iter()
            .all(|count| *count == 0));
    }
    let cursor = render::entries(record::Agent::Cursor, binary).unwrap();
    let initialized =
        render::configuration(record::Agent::Cursor, "{\"custom\":true}", &[], &cursor).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&initialized).unwrap()["version"],
        1
    );
    let removed = render::configuration(record::Agent::Cursor, &initialized, &cursor, &[]).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&removed).unwrap()["version"],
        1
    );
    for version in [
        json!(0),
        json!(2),
        json!("1"),
        Value::Null,
        json!(1.0),
        json!(-1),
    ] {
        let incompatible = json!({"version":version,"custom":"foreign"}).to_string();
        assert!(render::configuration(record::Agent::Cursor, &incompatible, &[], &cursor).is_err());
    }
}

#[cfg(unix)]
#[test]
fn cursor_schema_preparation_recovers_explicitly_and_edited_version_never_gets_adopted() {
    use std::fs;
    let fixture = ProfileFixture::new(record::Agent::Cursor);
    fs::write(fixture.provider(), "{\"custom\": { \"keep\":1e+02 }}").unwrap();
    let first = fixture.plan(files::Action::Install);
    fixture.prepare_without_provider(&first);
    assert_eq!(
        fixture.inspect().observation,
        Some(state::Observation::Prepared)
    );
    assert_eq!(
        fs::read_to_string(fixture.provider()).unwrap(),
        "{\"custom\": { \"keep\":1e+02 }}"
    );
    assert!(fixture.apply(files::Action::Install, &first).is_err());
    let fresh = fixture.plan(files::Action::Install);
    assert_eq!(
        fixture
            .apply(files::Action::Install, &fresh)
            .unwrap()
            .status,
        "configured"
    );
    let bytes = fs::read_to_string(fixture.provider()).unwrap();
    assert!(bytes.contains("{ \"keep\":1e+02 }"));
    let expected = fixture.plan(files::Action::Remove);
    let mut edited: Value = serde_json::from_str(&bytes).unwrap();
    edited["version"] = json!(2);
    let edited = edited.to_string();
    fs::write(fixture.provider(), &edited).unwrap();
    assert_eq!(
        fixture.inspect().observation,
        Some(state::Observation::Conflict)
    );
    assert!(fixture.apply(files::Action::Remove, &expected).is_err());
    assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), edited);
    let unowned = ProfileFixture::new(record::Agent::Cursor);
    fs::write(unowned.provider(), "{\"version\":2,\"foreign\":true}").unwrap();
    assert!(unowned.inspect().plan(files::Action::Install).is_err());
    assert!(!unowned.manifest().exists());
    assert!(!unowned.target.profile.join(".lazysh-hooks.lock").exists());
}

#[cfg(unix)]
#[test]
fn droid_standalone_hooks_preserve_fallback_profiles_and_refuse_shadowing_or_replacement() {
    use std::{fs, os::unix::fs::symlink};
    let fixture = ProfileFixture::new(record::Agent::Droid);
    let foreign = r#"{ "Stop" : [ {"matcher":"foreign", "hooks":[{"command":"keep", "timeout":1e+02}]} ], "UnknownFutureEvent":[] }"#;
    fs::remove_file(fixture.provider()).unwrap();
    let settings = fixture.target.profile.join("settings.json");
    let legacy_dir = fixture.target.profile.join("hooks");
    fs::create_dir(&legacy_dir).unwrap();
    let legacy = legacy_dir.join("hooks.json");
    let fallback = r#"{ "disableAllHooks":true, "allowManagedHooksOnly":true, "hooks":{"PreToolUse":[{"hooks":[{"command":"foreign permission policy"}]}]} }"#;
    let legacy_hooks = r#"{ "PreToolUse":[{"matcher":"Execute","hooks":[{"command":"foreign permission policy"}]}] }"#;
    for (path, contents) in [(&settings, fallback), (&legacy, legacy_hooks)] {
        fs::write(path, contents).unwrap();
    }
    let absent = fixture.cli("status", None);
    assert_eq!(absent["reason"], "HooksDroidStandaloneRequired");
    assert_eq!(absent["supported"], false);
    assert!(!fixture.provider().exists() && !fixture.manifest().exists());
    fs::write(fixture.provider(), foreign).unwrap();
    let plan = fixture.plan(files::Action::Install);
    let configured = fixture.apply(files::Action::Install, &plan).unwrap();
    assert_eq!(configured.status, "configured");
    let installed = fs::read_to_string(fixture.provider()).unwrap();
    assert!(installed
        .contains(r#"{"matcher":"foreign", "hooks":[{"command":"keep", "timeout":1e+02}]}"#));
    let native: Value = serde_json::from_str(&installed).unwrap();
    assert!(native.get("hooks").is_none());
    assert_eq!(native["UserPromptSubmit"][0]["hooks"][0]["timeout"], 5);
    assert_eq!(
        fixture.inspect().observation,
        Some(state::Observation::Configured)
    );
    assert_eq!(
        fixture
            .apply(
                files::Action::Install,
                &fixture.plan(files::Action::Install)
            )
            .unwrap()
            .status,
        "reused"
    );
    assert_eq!(
        fixture
            .apply(files::Action::Remove, &fixture.plan(files::Action::Remove))
            .unwrap()
            .status,
        "removed"
    );
    assert_eq!(
        fixture.inspect().observation,
        Some(state::Observation::Removed)
    );
    for (path, contents) in [(&settings, fallback), (&legacy, legacy_hooks)] {
        assert_eq!(fs::read_to_string(path).unwrap(), contents);
    }
    assert!(fs::read_to_string(fixture.provider())
        .unwrap()
        .contains("1e+02"));
    for malformed in [
        "[]",
        r#"{"hooks":{"Stop":[]}}"#,
        r#"{"Stop":1}"#,
        r#"{"Stop":[],"Stop":[]}"#,
    ] {
        fs::write(fixture.provider(), malformed).unwrap();
        assert!(files::inspect(fixture.target.clone(), &fixture.companion)
            .and_then(|value| value.plan(files::Action::Install))
            .is_err());
        assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), malformed);
        assert!(render::configuration(
            record::Agent::Droid,
            malformed,
            &[],
            &render::entries(record::Agent::Droid, &fixture.companion).unwrap()
        )
        .is_err());
    }
    assert_missing_provider_is_unsupported(&fixture, "HooksDroidStandaloneRequired");
    symlink(&settings, fixture.provider()).unwrap();
    assert!(files::inspect(fixture.target.clone(), &fixture.companion).is_err());
    assert_eq!(fs::read_to_string(&settings).unwrap(), fallback);
    let fixture = ProfileFixture::new(record::Agent::Droid);
    let plan = fixture.plan(files::Action::Install);
    fs::rename(
        fixture.provider(),
        fixture.target.profile.join("old hooks.json"),
    )
    .unwrap();
    fs::write(fixture.provider(), "{}").unwrap();
    assert!(fixture.apply(files::Action::Install, &plan).is_err());
    assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), "{}");
}

fn discover_metadata(
    home: &std::path::Path,
    path: &std::ffi::OsStr,
    overrides: &[(&str, &std::ffi::OsStr)],
) -> Value {
    discover_metadata_version(home, path, overrides, None)
}
fn discover_metadata_version(
    home: &std::path::Path,
    path: &std::ffi::OsStr,
    overrides: &[(&str, &std::ffi::OsStr)],
    version: Option<u8>,
) -> Value {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    command
        .env_clear()
        .env("HOME", home)
        .env("PATH", path)
        .args(["hooks", "discover"]);
    if let Some(version) = version {
        command.args(["--schema-version", &version.to_string()]);
    }
    for (name, value) in overrides {
        command.env(name, value);
    }
    json_output::decode(command.output().unwrap())
}
fn metadata_executable(path: &std::path::Path, marker: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        format!(
            "#!/bin/sh\nprintf private-executed > '{}'\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}
fn metadata_fixture(agent: &str) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    let marker = root.path().join("must-not-execute");
    metadata_executable(&bin.join(agent), &marker);
    (root, bin, marker)
}
fn discovered<'a>(result: &'a Value, agent: &str) -> &'a Value {
    result["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["agent"] == agent)
        .unwrap()
}
#[test]
fn discovery_reports_independent_executable_profile_and_setup_evidence_without_execution() {
    use std::{ffi::OsStr, fs};
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    let bin = home.join("bin with ' quote");
    let marker = home.join("must-not-execute");
    for name in [
        "codex",
        "droid",
        "gemini",
        "cursor-agent",
        "opencode",
        "cline",
        "kimi",
        "copilot",
        "amp",
        "grok",
        "aider",
    ] {
        metadata_executable(&bin.join(name), &marker);
    }
    for name in [
        ".claude",
        ".factory",
        ".grok",
        ".cursor",
        ".config/opencode",
        ".cline",
        "extra",
        "gemini-home/.gemini",
    ] {
        fs::create_dir_all(home.join(name)).unwrap();
    }
    fs::write(home.join(".claude/settings.json"), "private-profile-secret").unwrap();
    let gemini = home.join("gemini-home");
    let extra = home.join("extra");
    let result = discover_metadata(
        home,
        bin.as_os_str(),
        &[
            ("GEMINI_CLI_HOME", gemini.as_os_str()),
            ("OPENCODE_CONFIG_DIR", extra.as_os_str()),
        ],
    );
    assert_eq!(result["schemaVersion"], 1);
    assert_eq!(result["supported"], true);
    assert_eq!(result["managedSetupSupported"], true);
    assert_eq!(result["agents"].as_array().unwrap().len(), 11);
    for version in [1, 2, 3] {
        // Clients that predate Grok setup reject a row they do not know.
        let older = discover_metadata_version(home, bin.as_os_str(), &[], Some(version));
        assert!(older["agents"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["agent"] != "grok"));
    }
    assert_eq!(result["truncated"], false);
    assert!(discovered(&result, "claude")["executable"].is_null());
    assert_eq!(
        discovered(&result, "claude")["profiles"][0]["state"],
        "directory"
    );
    assert_eq!(
        discovered(&result, "codex")["profiles"][0]["state"],
        "missing"
    );
    assert!(!home.join(".codex").exists());
    assert_eq!(
        discovered(&result, "gemini")["profiles"][0]["path"],
        gemini.join(".gemini").to_str().unwrap()
    );
    assert_eq!(
        discovered(&result, "opencode")["profiles"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(discovered(&result, "cline")["setup"], "managed");
    assert_eq!(
        discovered(&result, "cline")["profiles"][0]["path"],
        home.join(".cline").to_str().unwrap()
    );
    for (agent, setup) in [
        ("kimi", "manual"),
        ("copilot", "manual"),
        ("amp", "manual"),
        ("aider", "healthOnly"),
    ] {
        assert_eq!(discovered(&result, agent)["setup"], setup);
        if agent != "kimi" {
            assert_eq!(discovered(&result, agent)["profiles"], json!([]));
        }
    }
    assert!(!marker.exists());
    assert!(!result.to_string().contains("private"));
    let empty = discover_metadata(
        home,
        OsStr::new(""),
        &[("CLAUDE_CONFIG_DIR", OsStr::new("relative"))],
    );
    let diagnostic = discovered(&empty, "claude");
    assert!(diagnostic["executable"].is_null());
    assert_eq!(
        diagnostic["profiles"][0],
        json!({"path":null,"source":"CLAUDE_CONFIG_DIR","state":"invalid"})
    );
}
#[test]
fn discovery_invalid_nonempty_overrides_never_fall_back_and_empty_overrides_do() {
    use std::{ffi::OsStr, fs, os::unix::ffi::OsStrExt};
    let (root, bin, _) = metadata_fixture("codex");
    let home = root.path();
    fs::create_dir(home.join(".codex")).unwrap();
    for invalid in [
        OsStr::new("relative"),
        OsStr::new("~/other"),
        OsStr::new("/safe/../other"),
        OsStr::new("/safe/./other"),
        OsStr::new("/private\nsecret"),
        OsStr::from_bytes(b"/invalid\xff"),
    ] {
        let result = discover_metadata(home, bin.as_os_str(), &[("CODEX_HOME", invalid)]);
        let profile = &discovered(&result, "codex")["profiles"][0];
        assert_eq!(
            profile,
            &json!({"path":null,"source":"CODEX_HOME","state":"invalid"})
        );
        assert!(!result.to_string().contains("secret"));
    }
    for empty in ["", " \t "] {
        let result = discover_metadata(home, bin.as_os_str(), &[("CODEX_HOME", OsStr::new(empty))]);
        assert_eq!(
            discovered(&result, "codex")["profiles"][0]["state"],
            "directory"
        );
        assert_eq!(
            discovered(&result, "codex")["profiles"][0]["source"],
            "HOME"
        );
    }
    let absent = home.join("chosen-missing");
    let result = discover_metadata(home, bin.as_os_str(), &[("CODEX_HOME", absent.as_os_str())]);
    assert_eq!(
        discovered(&result, "codex")["profiles"][0]["state"],
        "missing"
    );
    assert!(!absent.exists());
}
#[test]
fn discovery_kimi_current_and_legacy_profiles_preserve_literal_overrides_without_execution() {
    use std::{ffi::OsStr, fs, os::unix::ffi::OsStrExt};
    let (root, bin, marker) = metadata_fixture("kimi");
    let home = root.path();
    let selected = home.join("chosen ");
    fs::create_dir(&selected).unwrap();
    for (index, variable, suffix) in [
        (0, "KIMI_CODE_HOME", ".kimi-code"),
        (1, "KIMI_SHARE_DIR", ".kimi"),
    ] {
        let default = home.join(suffix);
        let result = discover_metadata(home, bin.as_os_str(), &[]);
        assert_eq!(result["schemaVersion"], 1);
        assert_eq!(discovered(&result, "kimi")["setup"], "manual");
        assert_eq!(
            discovered(&result, "kimi")["profiles"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let fallback = json!({"path":default,"source":"HOME","state":"missing"});
        assert_eq!(discovered(&result, "kimi")["profiles"][index], fallback);
        assert!(!default.exists());
        fs::create_dir(&default).unwrap();
        fs::write(default.join("config.toml"), "not TOML: PRIVATE-KIMI-CONFIG").unwrap();
        let fallback = json!({"path":default,"source":"HOME","state":"directory"});
        let result = discover_metadata(home, bin.as_os_str(), &[(variable, OsStr::new(""))]);
        assert_eq!(discovered(&result, "kimi")["profiles"][index], fallback);
        let result = discover_metadata(home, bin.as_os_str(), &[(variable, selected.as_os_str())]);
        assert_eq!(
            discovered(&result, "kimi")["profiles"][index],
            json!({"path":selected,"source":variable,"state":"directory"})
        );
        let absent = home.join(format!("missing-{index}"));
        let result = discover_metadata(home, bin.as_os_str(), &[(variable, absent.as_os_str())]);
        assert_eq!(
            discovered(&result, "kimi")["profiles"][index],
            json!({"path":absent,"source":variable,"state":"missing"})
        );
        assert!(!absent.exists());
        for invalid in [
            OsStr::new(" "),
            OsStr::new("relative"),
            OsStr::new("~/chosen"),
            OsStr::new("/owned/../other"),
            OsStr::new("/owned/\nother"),
            OsStr::from_bytes(b"/owned/\xff"),
        ] {
            let result = discover_metadata(home, bin.as_os_str(), &[(variable, invalid)]);
            assert_eq!(
                discovered(&result, "kimi")["profiles"][index],
                json!({"path":null,"source":variable,"state":"invalid"})
            );
        }
        assert_eq!(
            fs::read_to_string(default.join("config.toml")).unwrap(),
            "not TOML: PRIVATE-KIMI-CONFIG"
        );
    }
    for invalid_home in [
        OsStr::new(""),
        OsStr::new("relative"),
        OsStr::from_bytes(b"/invalid\xff"),
    ] {
        let result = discover_metadata(home, bin.as_os_str(), &[("HOME", invalid_home)]);
        let profiles = discovered(&result, "kimi")["profiles"].as_array().unwrap();
        assert_eq!(
            profiles.len(),
            1,
            "identical unavailable dialect roots must not break v1 discovery"
        );
        assert_eq!(profiles[0]["path"], Value::Null);
        assert_eq!(profiles[0]["source"], "HOME");
    }
    let result = discover_metadata(home, bin.as_os_str(), &[]);
    assert!(!result.to_string().contains("PRIVATE-KIMI-CONFIG"));
    assert!(!marker.exists());
    assert_eq!(fs::read_dir(home.join(".kimi-code")).unwrap().count(), 1);
    assert_eq!(fs::read_dir(home.join(".kimi")).unwrap().count(), 1);
}

#[test]
fn discovery_cline_override_matches_javascript_trim_and_never_selects_a_distinct_whitespace_directory(
) {
    use std::{ffi::OsStr, fs};
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    let selected = home.join("selected");
    fs::create_dir(&selected).unwrap();
    fs::create_dir(home.join("selected ")).unwrap();
    fs::create_dir(home.join(".cline")).unwrap();
    let marker = home.join("must-not-execute");
    let bin = home.join("bin");
    metadata_executable(&bin.join("cline"), &marker);
    let active = json!({"path":selected,"source":"CLINE_DIR","state":"directory"});
    let fallback = json!({"path":home.join(".cline"),"source":"HOME","state":"directory"});
    let invalid = json!({"path":null,"source":"CLINE_DIR","state":"invalid"});
    for (value, expected) in [
        (format!(" {} ", selected.display()), active.clone()),
        (format!("{} ", selected.display()), active.clone()),
        (format!("\u{feff}{}\u{feff}", selected.display()), active),
        (" ".into(), fallback.clone()),
        ("\u{feff}".into(), fallback),
        ("\u{0085}".into(), invalid.clone()),
        (format!("{}\u{0085}", selected.display()), invalid),
    ] {
        let result = discover_metadata(home, bin.as_os_str(), &[("CLINE_DIR", OsStr::new(&value))]);
        assert_eq!(discovered(&result, "cline")["profiles"][0], expected);
    }
    assert!(!marker.exists());
}
#[test]
fn discovery_honors_config_directory_layers_aliases_and_profile_link_boundaries() {
    use std::{
        ffi::OsStr,
        fs,
        os::unix::fs::{symlink, PermissionsExt},
    };
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    let bin = home.join("bin");
    let marker = home.join("marker");
    for name in ["opencode", "cursor-agent", "claude", "codex", "cline"] {
        metadata_executable(&bin.join(name), &marker);
    }
    let config = home.join("config");
    fs::create_dir_all(config.join("opencode")).unwrap();
    fs::create_dir(config.join("cursor")).unwrap();
    let ignored = home.join("config-file.json");
    fs::write(&ignored, "private-file-content").unwrap();
    let result = discover_metadata(
        home,
        bin.as_os_str(),
        &[
            ("XDG_CONFIG_HOME", config.as_os_str()),
            ("OPENCODE_CONFIG", ignored.as_os_str()),
            ("CLINE_DIR", config.as_os_str()),
        ],
    );
    assert_eq!(
        discovered(&result, "opencode")["profiles"][0]["path"],
        config.join("opencode").to_str().unwrap()
    );
    assert_eq!(
        discovered(&result, "cline")["profiles"][0],
        json!({"path":config,"source":"CLINE_DIR","state":"directory"})
    );
    let cursor_profile = json!({"path": home.join(".cursor"), "source":"HOME", "state":"missing"});
    assert_eq!(
        &discovered(&result, "cursor")["profiles"][0],
        &cursor_profile
    );
    symlink(&config, home.join(".claude")).unwrap();
    let broken = home.join("broken");
    symlink(home.join("absent"), &broken).unwrap();
    let result = discover_metadata(
        home,
        bin.as_os_str(),
        &[
            ("CURSOR_CONFIG_DIR", broken.as_os_str()),
            ("CODEX_HOME", broken.as_os_str()),
            ("OPENCODE_CONFIG_DIR", OsStr::new("relative")),
        ],
    );
    assert_eq!(
        &discovered(&result, "cursor")["profiles"][0],
        &cursor_profile
    );
    assert_eq!(
        discovered(&result, "claude")["profiles"][0]["state"],
        "invalid"
    );
    assert_eq!(
        discovered(&result, "codex")["profiles"][0]["state"],
        "invalid"
    );
    assert_eq!(
        discovered(&result, "opencode")["profiles"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        discovered(&result, "opencode")["profiles"][0]["state"],
        "invalid"
    );
    fs::rename(bin.join("claude"), bin.join("target")).unwrap();
    symlink(bin.join("target"), bin.join("claude")).unwrap();
    fs::set_permissions(bin.join("opencode"), fs::Permissions::from_mode(0o600)).unwrap();
    let result = discover_metadata(home, bin.as_os_str(), &[]);
    assert_eq!(
        discovered(&result, "claude")["executable"]["source"],
        "path"
    );
    assert!(!result["agents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["agent"] == "opencode"));
    assert!(!marker.exists());
}
#[test]
fn discovery_bounds_path_scans_and_codex_standalone_entries_without_recursive_search() {
    use std::{ffi::OsStr, fs};
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    let bin = home.join("bin");
    let marker = home.join("marker");
    metadata_executable(&bin.join("claude"), &marker);
    let path = format!(
        "{}:{}:{}",
        bin.display(),
        bin.display(),
        vec!["relative"; 70].join(":")
    );
    let byte_limited = format!(
        "{}:{}",
        bin.display(),
        vec!["/x".repeat(1500); 12].join(":")
    );
    for path in [path, byte_limited] {
        let result = discover_metadata(home, OsStr::new(&path), &[]);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["agents"].as_array().unwrap().len(), 1);
    }
    let release = home.join(".codex/packages/standalone/releases/one/bin/codex");
    metadata_executable(&release, &marker);
    let result = discover_metadata(home, OsStr::new(""), &[]);
    assert_eq!(
        discovered(&result, "codex")["executable"],
        json!({"path":release,"source":"codexStandalone"})
    );
    let releases = home.join(".codex/packages/standalone/releases");
    for index in 0..20 {
        fs::create_dir(releases.join(format!("version-{index}"))).unwrap();
    }
    let result = discover_metadata(home, OsStr::new(""), &[]);
    assert_eq!(result["truncated"], true);
    let long = format!("/{}", "x".repeat(4097));
    let result = discover_metadata(
        home,
        bin.as_os_str(),
        &[("CLAUDE_CONFIG_DIR", OsStr::new(&long))],
    );
    assert_eq!(result["truncated"], true);
    assert_eq!(
        discovered(&result, "claude")["profiles"][0]["state"],
        "invalid"
    );
    assert!(!marker.exists());
}

#[test]
fn discovery_distinguishes_unavailable_profile_metadata_and_never_searches_cwd() {
    use std::{ffi::OsStr, fs, os::unix::fs::PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    let bin = home.join("bin");
    metadata_executable(&bin.join("claude"), &home.join("marker"));
    let locked = home.join("locked");
    let profile = locked.join("profile");
    fs::create_dir_all(&profile).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o0)).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env_clear()
        .env("HOME", home)
        .env("PATH", "")
        .env("CLAUDE_CONFIG_DIR", &profile)
        .args(["hooks", "discover"])
        .output();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    let result = json_output::decode(output.unwrap());
    assert_eq!(
        discovered(&result, "claude")["profiles"][0]["state"],
        "unavailable"
    );
    let result = discover_metadata(home, bin.as_os_str(), &[("HOME", OsStr::new(""))]);
    assert_eq!(
        discovered(&result, "claude")["profiles"][0],
        json!({"path":null,"source":"HOME","state":"unavailable"})
    );
    let relative = discover_metadata(home, OsStr::new(":.:bin"), &[]);
    assert_eq!(relative["agents"], json!([]));
    fs::create_dir(bin.join("gemini")).unwrap();
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    let result = json_output::decode(
        command
            .env_clear()
            .env("HOME", home)
            .env("PATH", &bin)
            .args(["hooks", "discover"])
            .current_dir(&bin)
            .output()
            .unwrap(),
    );
    assert_eq!(result["agents"].as_array().unwrap().len(), 1);
}

// Darwin's PATH_MAX is 1024 bytes, so no path can make a result large enough to reach the cap.
#[cfg(target_os = "linux")]
#[test]
fn discovery_caps_serialized_result_bytes_and_marks_partial_metadata() {
    use std::fs;
    let outer = tempfile::tempdir().unwrap();
    let mut home = outer.path().to_path_buf();
    while home.as_os_str().len() < 3700 {
        home.push("x".repeat(200));
    }
    fs::create_dir_all(&home).unwrap();
    let bin = home.join("bin");
    let marker = outer.path().join("never-executed");
    for name in [
        "claude",
        "codex",
        "droid",
        "gemini",
        "cursor-agent",
        "opencode",
        "cline",
        "kimi",
        "copilot",
        "amp",
        "aider",
    ] {
        metadata_executable(&bin.join(name), &marker);
    }
    for suffix in [
        ".claude",
        ".codex",
        ".factory",
        ".gemini",
        ".cursor",
        ".config/opencode",
        ".cline",
        "extra",
    ] {
        fs::create_dir_all(home.join(suffix)).unwrap();
    }
    let extra = home.join("extra");
    let result = discover_metadata(
        &home,
        bin.as_os_str(),
        &[("OPENCODE_CONFIG_DIR", extra.as_os_str())],
    );
    assert_eq!(result["truncated"], true);
    assert!(result["agents"].as_array().unwrap().len() < 11);
    assert!(serde_json::to_vec(&result).unwrap().len() <= 65536);
    assert!(!marker.exists());
}

#[test]
fn discovery_cursor_aliases_preserve_path_order_and_return_one_unexecuted_row() {
    let home = tempfile::tempdir().unwrap();
    let first = home.path().join("first");
    let second = home.path().join("second");
    let marker = home.path().join("must-not-run-cursor");
    let path = std::env::join_paths([&first, &second]).unwrap();
    for executable in [
        second.join("agent"),
        first.join("cursor-agent"),
        first.join("agent"),
    ] {
        metadata_executable(&executable, &marker);
        let result = discover_metadata(home.path(), &path, &[]);
        assert_eq!(result["agents"].as_array().unwrap().len(), 1);
        assert_eq!(
            discovered(&result, "cursor")["executable"],
            json!({"path":executable,"source":"path"})
        );
        assert_eq!(
            discovered(&result, "cursor")["profiles"][0]["path"],
            home.path().join(".cursor").to_str().unwrap()
        );
    }
    assert!(!marker.exists());
}

#[test]
fn discovery_keeps_invalid_explicit_override_visible_without_an_executable_or_fallback() {
    use std::{ffi::OsStr, fs};
    let home = tempfile::tempdir().unwrap();
    let marker = home.path().join("never-execute");
    let default = home.path().join(".codex");
    fs::create_dir(&default).unwrap();
    metadata_executable(&home.path().join("bin/codex"), &marker);
    let result = discover_metadata(
        home.path(),
        OsStr::new(""),
        &[("CODEX_HOME", OsStr::new("relative"))],
    );
    assert_eq!(
        result["agents"],
        json!([{"agent":"codex","setup":"managed","executable":null,
        "profiles":[{"path":null,"source":"CODEX_HOME","state":"invalid"}]}])
    );
    assert_eq!(result["truncated"], false);
    assert!(!marker.exists());
    assert!(default.is_dir());
}

#[test]
fn discovery_v2_copilot_is_opt_in_and_preserves_literal_profile_overrides() {
    use std::{ffi::OsStr, fs};
    let (root, bin, marker) = metadata_fixture("copilot");
    let home = root.path();
    let default = home.join(".copilot");
    fs::create_dir(&default).unwrap();
    fs::write(default.join("settings.json"), "PRIVATE_NOT_JSON").unwrap();
    fs::create_dir(home.join("chosen")).unwrap();
    let legacy = discover_metadata(home, bin.as_os_str(), &[]);
    assert_eq!(discovered(&legacy, "copilot")["setup"], "manual");
    assert_eq!(discovered(&legacy, "copilot")["profiles"], json!([]));
    let current = |overrides: &[(&str, &OsStr)]| {
        discover_metadata_version(home, bin.as_os_str(), overrides, Some(2))
    };
    let result = current(&[]);
    assert_eq!(result["schemaVersion"], 2);
    assert_eq!(discovered(&result, "copilot")["setup"], "managed");
    let fallback = current(&[("COPILOT_HOME", OsStr::new(""))]);
    assert_eq!(
        discovered(&fallback, "copilot")["profiles"][0],
        json!({"path":default,"source":"HOME","state":"directory"})
    );
    assert_eq!(
        discover_metadata_version(home, bin.as_os_str(), &[], Some(1)),
        legacy
    );
    for suffix in ["chosen ", "chosen\u{00a0}", "chosen\u{feff}"] {
        let literal = home.join(suffix);
        fs::create_dir(&literal).unwrap();
        assert_eq!(
            discover_metadata(
                home,
                bin.as_os_str(),
                &[("COPILOT_HOME", literal.as_os_str())]
            ),
            legacy
        );
        let result = current(&[("COPILOT_HOME", literal.as_os_str())]);
        assert_eq!(
            discovered(&result, "copilot")["profiles"][0],
            json!({"path":literal,"source":"COPILOT_HOME","state":"directory"})
        );
    }
    for invalid in invalid_profile_overrides() {
        let result = current(&[("COPILOT_HOME", invalid)]);
        assert_eq!(
            discovered(&result, "copilot")["profiles"][0],
            json!({"path":null,"source":"COPILOT_HOME","state":"invalid"})
        );
    }
    assert_eq!(
        fs::read_to_string(default.join("settings.json")).unwrap(),
        "PRIVATE_NOT_JSON"
    );
    assert!(!marker.exists());
    assert!(!result.to_string().contains("PRIVATE"));
}

#[cfg(unix)]
#[test]
fn copilot_owned_file_uses_absolute_exec_without_touching_settings_or_foreign_hooks() {
    use std::fs;
    let fixture = ProfileFixture::new(record::Agent::Copilot);
    let hooks = fixture.target.profile.join("hooks");
    fs::create_dir(&hooks).unwrap();
    let preserved = [
        (
            fixture.target.profile.join("config.json"),
            "// JSONC remains opaque\n{}",
        ),
        (
            fixture.target.profile.join("settings.json"),
            r#"{"disableAllHooks":true}"#,
        ),
        (
            fixture.target.profile.join("providers.json"),
            "PRIVATE_OWNED_PROVIDER",
        ),
        (
            hooks.join("foreign.json"),
            r#"{"version":1,"disableAllHooks":true,"hooks":{}}"#,
        ),
    ];
    for (path, bytes) in &preserved {
        fs::write(path, bytes).unwrap();
    }
    let manual = render::owned_file(record::Agent::Copilot, &fixture.companion).unwrap();
    fixture.assert_manual_copy_is_foreign(&manual);
    let asset = fixture.install_hook_file();
    assert_eq!(asset["version"], 1);
    assert_eq!(asset["hooks"].as_object().unwrap().len(), 6);
    assert!(asset["hooks"].get("PreToolUse").is_none());
    let command = &asset["hooks"]["UserPromptSubmit"][0];
    assert_eq!(command["exec"], fixture.companion.to_str().unwrap());
    assert_eq!(command["args"], json!(["ingest", "--agent", "copilot"]));
    assert_eq!(command["timeoutSec"], 5);
    let state = fixture._root.path().join("state");
    let payload = json!({"hook_event_name":"UserPromptSubmit","session_id":"owned-copilot-render","cwd":"/owned/copilot"});
    let mut child = std::process::Command::new(command["exec"].as_str().unwrap());
    child.args(["ingest", "--agent", "copilot"]);
    run_hook(&mut child, &state, None, &payload);
    assert_eq!(
        snapshot(&fixture.companion, &state)["sessions"][0]["state"],
        "working"
    );
    fixture.assert_reuse_then_remove_keeps(&preserved);
    fixture.assert_edit_conflicts(serde_json::to_vec(&asset).unwrap());
}

#[test]
fn discovery_v3_amp_preserves_raw_xdg_and_never_promotes_old_schemas() {
    use std::{ffi::OsStr, fs, os::unix::ffi::OsStrExt};
    let (root, bin, marker) = metadata_fixture("amp");
    let home = root.path();
    let default = home.join(".config/amp");
    fs::create_dir_all(&default).unwrap();
    fs::write(default.join("settings.json"), "PRIVATE_DO_NOT_READ").unwrap();
    for version in [1, 2] {
        let legacy = discover_metadata_version(home, bin.as_os_str(), &[], Some(version));
        assert_eq!(discovered(&legacy, "amp")["setup"], "manual");
        assert_eq!(discovered(&legacy, "amp")["profiles"], json!([]));
    }
    let inspect = |raw: Option<&OsStr>| {
        let overrides = raw
            .map(|value| vec![("XDG_CONFIG_HOME", value)])
            .unwrap_or_default();
        discover_metadata_version(home, bin.as_os_str(), &overrides, Some(3))
    };
    let result = inspect(None);
    assert_eq!(result["schemaVersion"], 3);
    let amp = discovered(&result, "amp");
    assert_eq!(amp["setup"], "managed");
    assert_eq!(
        amp["profiles"][0],
        json!({"path":default,"source":"HOME","state":"directory"})
    );
    assert_eq!(inspect(Some(OsStr::new(""))), result);
    for suffix in ["literal", "literal "] {
        let base = home.join(suffix);
        fs::create_dir_all(base.join("amp")).unwrap();
        let selected = inspect(Some(base.as_os_str()));
        assert_eq!(
            discovered(&selected, "amp")["profiles"][0],
            json!({"path":base.join("amp"),"source":"XDG_CONFIG_HOME","state":"directory"})
        );
    }
    for raw in [
        OsStr::new(" "),
        OsStr::new("relative"),
        OsStr::new("~/config"),
        OsStr::new("/owned/../config"),
        OsStr::new("/owned/\nconfig"),
        OsStr::from_bytes(b"/owned/\xff"),
    ] {
        let invalid = inspect(Some(raw));
        assert_eq!(
            discovered(&invalid, "amp")["profiles"][0],
            json!({"path":null,"source":"XDG_CONFIG_HOME","state":"invalid"})
        );
    }
    assert!(!result.to_string().contains("PRIVATE"));
    assert_eq!(
        fs::read_to_string(default.join("settings.json")).unwrap(),
        "PRIVATE_DO_NOT_READ"
    );
    assert!(!marker.exists());
}

#[cfg(unix)]
#[test]
fn amp_foreign_shadow_blocks_install_but_never_blocks_exact_owned_removal() {
    use files::Action;
    use std::{fs, os::unix::fs::symlink};
    for kind in ["typescript", "directory", "symlink"] {
        let fixture = ProfileFixture::new(record::Agent::Amp);
        assert_eq!(fixture.apply_current(Action::Install).status, "configured");
        let remove_before = fixture
            .inspect()
            .plan(Action::Remove)
            .unwrap()
            .digest()
            .unwrap();
        let plugins = fixture.provider().parent().unwrap().to_owned();
        let shadow = plugins.join(if kind == "typescript" {
            "lazysh.ts"
        } else {
            "lazysh"
        });
        match kind {
            "typescript" => fs::write(&shadow, "foreign source unchanged").unwrap(),
            "directory" => fs::create_dir(&shadow).unwrap(),
            _ => symlink("missing-foreign-target", &shadow).unwrap(),
        }
        let identity = files::identity(&fs::symlink_metadata(&shadow).unwrap());
        assert!(matches!(
            fixture.inspect().plan(Action::Install),
            Err(Error::Installation("HooksAmpShadow"))
        ));
        assert!(matches!(
            fixture.apply(Action::Remove, &remove_before),
            Err(Error::Installation("HooksStalePlan"))
        ));
        let status = fixture.cli("status", None);
        assert_eq!(status["state"], "configured");
        assert_eq!(status["reason"], "HooksAmpShadow");
        assert!(status["installPlan"].is_null());
        let plan = status["removePlan"].as_str().unwrap();
        assert_eq!(
            fixture.apply(Action::Remove, plan).unwrap().status,
            "removed"
        );
        assert!(!fixture.provider().exists());
        assert_eq!(
            files::identity(&fs::symlink_metadata(&shadow).unwrap()),
            identity
        );
        if kind == "typescript" {
            assert_eq!(
                fs::read_to_string(shadow).unwrap(),
                "foreign source unchanged"
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn amp_shadow_changes_at_each_write_boundary_stale_the_plan_and_keep_recovery_removable() {
    use files::Action;
    use std::fs;
    for point in [
        commit::Boundary::BeforeRecord,
        commit::Boundary::BeforeProvider,
    ] {
        for change in [
            "install-add",
            "remove-add",
            "remove-delete",
            "remove-replace",
            "remove-aba",
        ] {
            let fixture = ProfileFixture::new(record::Agent::Amp);
            let action = if change == "install-add" {
                fs::create_dir(fixture.provider().parent().unwrap()).unwrap();
                Action::Install
            } else {
                fixture.apply_current(Action::Install);
                Action::Remove
            };
            let shadow = fixture.provider().parent().unwrap().join("lazysh.ts");
            let initial_shadow = !change.ends_with("add");
            if initial_shadow {
                fs::write(&shadow, "foreign unchanged").unwrap();
            }
            let retained = initial_shadow.then(|| fs::File::open(&shadow).unwrap());
            let original = fs::read(fixture.provider()).ok();
            let expected = fixture.plan(action);
            let changed_path = shadow.clone();
            interrupt(move |boundary| {
                if boundary == point {
                    let _keep_inode_alive = &retained;
                    if initial_shadow {
                        fs::remove_file(&changed_path)?;
                    }
                    if change != "remove-delete" {
                        fs::write(
                            &changed_path,
                            if change == "remove-replace" {
                                "foreign replacement"
                            } else {
                                "foreign unchanged"
                            },
                        )?;
                    }
                }
                Ok(())
            });
            let outcome = fixture.apply(action, &expected);
            clear_interrupt();
            if point == commit::Boundary::BeforeRecord {
                assert!(matches!(
                    outcome,
                    Err(Error::Installation("HooksStalePlan"))
                ));
            } else {
                let result = outcome.unwrap();
                assert_eq!(result.status, "uncertain");
                assert_eq!(result.reason, Some("HooksStalePlan"));
                assert!(!result.provider_committed);
            }
            assert_eq!(fs::read(fixture.provider()).ok(), original);
            assert_eq!(shadow.exists(), change != "remove-delete");
            let removal = fixture.apply_current(Action::Remove);
            assert!(matches!(removal.status, "removed" | "absent"));
            assert_eq!(shadow.exists(), change != "remove-delete");
            if shadow.exists() {
                assert_eq!(
                    fs::read_to_string(shadow).unwrap(),
                    if change == "remove-replace" {
                        "foreign replacement"
                    } else {
                        "foreign unchanged"
                    }
                );
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn amp_shadow_snapshot_is_ephemeral_and_does_not_rewrite_old_agent_plan_or_record_shapes() {
    for agent in WHOLE_FILE_AGENTS {
        let fixture = ProfileFixture::new(agent);
        let plan = fixture.inspect().plan(files::Action::Install).unwrap();
        let value = serde_json::to_value(&plan).unwrap();
        assert_eq!(
            value.get("ampShadows").is_some(),
            agent == record::Agent::Amp
        );
        let encoded = plan.transition.unwrap().encode().unwrap();
        let record = record::Record::decode(&encoded).unwrap();
        assert_eq!(record.encode().unwrap(), encoded);
        assert!(!String::from_utf8(encoded).unwrap().contains("ampShadows"));
    }
}

#[cfg(unix)]
fn kimi_hooks(text: &str) -> Vec<(String, String, i64)> {
    let document = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .parse::<toml_edit::DocumentMut>()
        .expect("the managed config stays valid TOML");
    document
        .get("hooks")
        .and_then(toml_edit::Item::as_array_of_tables)
        .map(|tables| {
            tables
                .iter()
                .map(|table| {
                    (
                        table["event"].as_str().unwrap().into(),
                        table["command"].as_str().unwrap().into(),
                        table
                            .get("timeout")
                            .and_then(toml_edit::Item::as_integer)
                            .unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}
#[cfg(unix)]
fn kimi_write(fixture: &ProfileFixture, text: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(fixture.provider(), text).unwrap();
    std::fs::set_permissions(fixture.provider(), std::fs::Permissions::from_mode(0o600)).unwrap();
}

#[cfg(unix)]
#[test]
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
fn kimi_code_install_appends_only_the_owned_suffix_and_remove_restores_every_foreign_byte() {
    use files::Action;
    use std::{fs, os::unix::fs::PermissionsExt};
    let foreign_hook = "[[hooks]]\r\nevent = \"Stop\"\r\ncommand = \"echo foreign\"\r\n";
    for original in [
        // CRLF line endings, a secret and a foreign hook.
        format!("# keep\r\napi_key = \"sk-PRIVATE\"\r\n\r\n{foreign_hook}"),
        // No trailing newline, and a table header as the last line.
        "x = 1\n[providers.local]\nname = \"a\"".to_string(),
        String::new(),
    ] {
        let fixture = ProfileFixture::new(record::Agent::KimiCode);
        kimi_write(&fixture, &original);
        let entries = render::entries(record::Agent::KimiCode, &fixture.companion).unwrap();
        let suffix = kimi_toml::suffix(&entries).unwrap();
        assert_eq!(fixture.apply_current(Action::Install).status, "configured");
        let installed = fs::read_to_string(fixture.provider()).unwrap();
        assert_eq!(installed, format!("{original}{suffix}"));
        assert_eq!(
            fs::metadata(fixture.provider())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let foreign = kimi_hooks(&original);
        let hooks = kimi_hooks(&installed);
        assert_eq!(hooks[..foreign.len()], foreign[..]);
        let ours = &hooks[foreign.len()..];
        assert_eq!(
            ours.iter()
                .map(|(event, ..)| event.as_str())
                .collect::<Vec<_>>(),
            kimi_code::EVENTS
        );
        assert!(ours.iter().all(|(_, command, timeout)| *timeout == 5
            && command.ends_with("' ingest --agent kimi-code")));
        let manifest = fs::read_to_string(fixture.manifest()).unwrap();
        assert!(!manifest.contains("sk-PRIVATE"));
        assert_eq!(fixture.apply_current(Action::Install).status, "reused");
        assert_eq!(fixture.apply_current(Action::Remove).status, "removed");
        assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), original);
    }
}

#[cfg(unix)]
#[test]
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
fn kimi_code_conflicts_when_the_owned_suffix_is_not_the_exact_end_of_the_file() {
    use files::Action;
    use state::Observation;
    use std::fs;
    let fixture = ProfileFixture::new(record::Agent::KimiCode);
    kimi_write(&fixture, "# keep\nkey = \"secret\"\n");
    fixture.apply_current(Action::Install);
    let installed = fs::read_to_string(fixture.provider()).unwrap();
    assert_eq!(fixture.inspect().observation, Some(Observation::Configured));
    // A foreign edit before the suffix is kept, and removal only truncates the suffix.
    kimi_write(&fixture, &installed.replacen("# keep", "# edited", 1));
    assert_eq!(fixture.apply_current(Action::Remove).status, "removed");
    assert_eq!(
        fs::read_to_string(fixture.provider()).unwrap(),
        "# edited\nkey = \"secret\"\n"
    );
    fixture.apply_current(Action::Install);
    let installed = fs::read_to_string(fixture.provider()).unwrap();
    let suffix =
        kimi_toml::suffix(&render::entries(record::Agent::KimiCode, &fixture.companion).unwrap())
            .unwrap();
    for tampered in [
        format!("{installed}[extra]\nforeign = true\n"),
        format!("{installed}\n"),
        installed.replacen("timeout = 5", "timeout = 6", 1),
        installed.replacen("PermissionResult", "Stop", 1),
        // The same owned block moved to the front of the file.
        format!("{suffix}{}", installed.strip_suffix(&suffix).unwrap()),
    ] {
        kimi_write(&fixture, &tampered);
        assert_eq!(
            fixture.inspect().observation,
            Some(Observation::Conflict),
            "{tampered:?}"
        );
        assert!(matches!(
            fixture.inspect().plan(Action::Remove),
            Err(Error::Installation("HooksConflict"))
        ));
        assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), tampered);
    }
}

#[cfg(unix)]
#[test]
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
fn kimi_code_interrupted_install_is_prepared_or_configured_and_a_fresh_plan_completes() {
    use files::Action;
    use state::Observation;
    use std::fs;
    let fixture = ProfileFixture::new(record::Agent::KimiCode);
    let original = fs::read_to_string(fixture.provider()).unwrap();
    fixture.prepare_without_provider(&fixture.plan(Action::Install));
    assert_eq!(fixture.inspect().observation, Some(Observation::Prepared));
    assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), original);
    assert_eq!(fixture.apply_current(Action::Install).status, "configured");
    assert_eq!(fixture.inspect().observation, Some(Observation::Configured));
    // The provider write landed but the final check was cut short: the file is exactly the configured one.
    assert_eq!(fixture.apply_current(Action::Remove).status, "removed");
    interrupt(|point| {
        if point == commit::Boundary::AfterProvider {
            Err(Error::Installation("HooksInterrupted"))
        } else {
            Ok(())
        }
    });
    let plan = fixture.plan(Action::Install);
    assert_eq!(
        fixture.apply(Action::Install, &plan).unwrap().status,
        "uncertain"
    );
    clear_interrupt();
    assert_eq!(fixture.inspect().observation, Some(Observation::Configured));
    assert_eq!(fixture.apply_current(Action::Remove).status, "removed");
    assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn kimi_code_refuses_a_missing_config_and_a_config_the_suffix_cannot_extend() {
    use files::Action;
    use std::fs;
    let fixture = ProfileFixture::new(record::Agent::KimiCode);
    let entries = render::entries(record::Agent::KimiCode, &fixture.companion).unwrap();
    let twin = &entries[0].group;
    let twin = format!(
        "[[hooks]]\nevent = {}\ncommand = {}\ntimeout = 5\n",
        twin["event"], twin["command"]
    );
    for original in [
        "\u{feff}telemetry = false\n",
        "hooks = []\n",
        "[hooks]\nevent = \"Stop\"\n",
        "key = [unterminated\n",
        "key = \"unterminated\n",
        &twin,
    ] {
        kimi_write(&fixture, original);
        assert!(
            matches!(
                fixture.inspect().plan(Action::Install),
                Err(Error::Installation("HooksConflict"))
            ),
            "{original:?}"
        );
        assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), original);
        assert!(!fixture.manifest().exists());
    }
    // A BOM introduced after a reviewed valid plan is still refused before creating a manifest.
    kimi_write(&fixture, "telemetry = false\n");
    let valid_plan = fixture.plan(Action::Install);
    let bom = "\u{feff}telemetry = false\n";
    kimi_write(&fixture, bom);
    assert!(matches!(
        fixture.apply(Action::Install, &valid_plan),
        Err(Error::Installation("HooksConflict"))
    ));
    assert_eq!(fs::read_to_string(fixture.provider()).unwrap(), bom);
    assert!(!fixture.manifest().exists());
    assert_missing_provider_is_unsupported(&fixture, "HooksKimiConfigRequired");
    assert!(!fixture.manifest().exists());
}

#[cfg(target_os = "linux")]
#[test]
fn kimi_code_installed_hook_runs_the_quoted_companion_and_matches_the_printed_fragment() {
    use std::fs;
    let fixture = ProfileFixture::new(record::Agent::KimiCode);
    let configured = fixture.cli(
        "install",
        fixture.cli("status", None)["installPlan"].as_str(),
    );
    assert_eq!(configured["outcome"]["status"], "configured");
    let hooks = kimi_hooks(&fs::read_to_string(fixture.provider()).unwrap());
    let printed = kimi_hooks(hooks::kimi_code_config()["content"].as_str().unwrap());
    assert_eq!(
        hooks.iter().map(|(e, _, t)| (e, t)).collect::<Vec<_>>(),
        printed.iter().map(|(e, _, t)| (e, t)).collect::<Vec<_>>()
    );
    let (_, command, _) = hooks
        .iter()
        .find(|(e, ..)| e == "PermissionRequest")
        .unwrap();
    let payload = json!({"hook_event_name":"PermissionRequest","session_id":"owned-session","agent_id":"main","cwd":"/owned/project","id":"approval_a","turn_id":0,"tool_call_id":"call_1","tool_name":"Bash","tool_input":{"command":"PRIVATE-COMMAND"}});
    let state = fixture._root.path().join("state");
    run_shell_hook(command, &state, &payload);
    let report = snapshot(&fixture.companion, &state);
    assert_eq!(report["sessions"][0]["state"], "needs_attention");
    assert!(!report.to_string().contains("PRIVATE-COMMAND"));
}

#[test]
fn discovery_v4_promotes_only_the_current_kimi_code_profile_and_keeps_older_schemas_unchanged() {
    use std::fs;
    let (root, bin, _marker) = metadata_fixture("kimi");
    let home = root.path();
    fs::create_dir(home.join(".kimi-code")).unwrap();
    fs::create_dir(home.join(".kimi")).unwrap();
    for (version, setup) in [
        (None, "manual"),
        (Some(2), "manual"),
        (Some(3), "manual"),
        (Some(4), "managed"),
    ] {
        let result = discover_metadata_version(home, bin.as_os_str(), &[], version);
        assert_eq!(result["schemaVersion"], version.unwrap_or(1));
        let kimi = discovered(&result, "kimi");
        assert_eq!(kimi["setup"], setup, "{version:?}");
        // The current Kimi Code profile is always listed first; the legacy one is never selectable as current.
        assert_eq!(kimi["profiles"][0]["path"], json!(home.join(".kimi-code")));
        assert_eq!(kimi["profiles"][1]["path"], json!(home.join(".kimi")));
    }
    // A newer schema keeps the providers every earlier schema made managed.
    let discovery = |agent: &str| {
        let (root, bin, _marker) = metadata_fixture(agent);
        fs::create_dir_all(root.path().join(".copilot")).unwrap();
        fs::create_dir_all(root.path().join(".config/amp")).unwrap();
        let result = discover_metadata_version(root.path(), bin.as_os_str(), &[], Some(4));
        discovered(&result, agent)["setup"].clone()
    };
    assert_eq!(discovery("copilot"), "managed");
    assert_eq!(discovery("amp"), "managed");
}

/// Issue #2812: an older companion's hook for the same events ran beside the managed one, so every event was
/// ingested twice. Installing retires lazysh's own groups for another path and nothing else.
#[test]
fn installing_retires_only_lazysh_own_legacy_groups_and_keeps_every_other_group_byte_for_byte() {
    let group = |command: &str| {
        format!(r#"{{"hooks":[{{"type":"command","command":"{command}","timeout":3}}]}}"#)
    };
    let (bare, old, new) = (
        group("lazysh-agent ingest --agent claude"),
        group("'/home/u/.local/bin/lazysh-agent' ingest --agent claude"),
        owned("'/new/companion' ingest --agent claude"),
    );
    let foreign = [
        group("/opt/tool/lazysh-agent ingest --agent claude --extra"),
        r#"{"matcher":"Bash","hooks":[{"type":"command","command":"lazysh-agent ingest --agent claude","timeout":3}]}"#.to_owned(),
        group("lazysh-agent-other ingest --agent claude"),
        group("notify-send done"),
    ];
    let both = |texts: &[&str]| format!("[{}]", texts.join(" , "));
    let input = format!(
        r#"{{"hooks":{{"Stop":{},"Other":{}}}}}"#,
        both(&[
            &bare,
            &foreign[0],
            &old,
            &old,
            &foreign[1],
            &foreign[2],
            &bare,
            &foreign[3]
        ]),
        both(&[&old, &bare]),
    );
    let report = json::legacy(&input, std::slice::from_ref(&new), false).unwrap();
    assert_eq!(report.len(), 4);
    let installed = rewrite(&input, &[], std::slice::from_ref(&new)).unwrap();
    let hooks = serde_json::from_str::<Value>(&installed).unwrap()["hooks"].clone();
    let stop: Vec<Value> = foreign
        .iter()
        .map(|text| serde_json::from_str(text).unwrap())
        .chain([new.group.clone()])
        .collect();
    assert_eq!(hooks["Stop"], Value::Array(stop));
    // An event the install does not own is never touched, whatever it holds.
    assert!(installed.contains(&format!(r#""Other":{}"#, both(&[&old, &bare]))));
    for text in &foreign {
        assert!(installed.contains(text.as_str()), "{text}");
    }
    assert!(json::legacy(&installed, std::slice::from_ref(&new), false)
        .unwrap()
        .is_empty());
    // Only legacy groups: the array holds just the managed one.
    let alone = format!(r#"{{"hooks":{{"Stop":{}}}}}"#, both(&[&bare, &old]));
    let alone = rewrite(&alone, &[], std::slice::from_ref(&new)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&alone).unwrap()["hooks"]["Stop"],
        json!([new.group])
    );
    let removed = rewrite(&installed, std::slice::from_ref(&new), &[]).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&removed).unwrap()["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
}

#[cfg(unix)]
#[test]
fn status_names_a_legacy_duplicate_and_install_replaces_it_whether_or_not_setup_was_installed_before(
) {
    use std::{fs, os::unix::fs::PermissionsExt};
    let fixture = ProfileFixture::new(record::Agent::Claude);
    let legacy = |event: &str, command: &str| {
        format!(
            r#""{event}":[{{"hooks":[{{"type":"command","command":"{command}","timeout":5}}]}}]"#
        )
    };
    let foreign = r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/other-tool guard"}]}]}}"#;
    let settings =
        |extra: &str| foreign.replacen(r#"{"hooks":{"#, &format!(r#"{{"hooks":{{{extra},"#), 1);
    let write = |text: &str| {
        fs::write(fixture.provider(), text).unwrap();
        fs::set_permissions(fixture.provider(), fs::Permissions::from_mode(0o600)).unwrap();
    };
    write(&settings(&format!(
        "{},{}",
        legacy("Stop", "lazysh-agent ingest --agent claude"),
        legacy(
            "UserPromptSubmit",
            "'/old/bin/lazysh-agent' ingest --agent claude"
        )
    )));
    let status = fixture.cli("status", None);
    let duplicates = status["legacyDuplicates"].as_array().unwrap();
    assert_eq!(duplicates.len(), 2);
    assert!(duplicates
        .iter()
        .any(|d| d["event"] == "Stop" && d["command"] == "lazysh-agent ingest --agent claude"));
    let configured = fixture.cli("install", status["installPlan"].as_str());
    assert_eq!(configured["outcome"]["status"], "configured");
    let status = fixture.cli("status", None);
    assert_eq!(status["legacyDuplicates"], json!([]));
    assert_eq!(status["state"], "configured");
    let text = fs::read_to_string(fixture.provider()).unwrap();
    assert_eq!(text.matches("ingest --agent claude").count(), 8);
    assert!(!text.contains("/old/bin") && !text.contains("\"lazysh-agent ingest"));
    assert!(text.contains(r#"{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/other-tool guard"}]}"#));
    // A legacy hook added after setup is reported, and installing again is not a no-op.
    let configured: Value = serde_json::from_str(&text).unwrap();
    let mut added = configured.clone();
    added["hooks"]["Stop"].as_array_mut().unwrap().insert(
        0,
        json!({"hooks":[{"type":"command","command":"lazysh-agent ingest --agent claude","timeout":5}]}),
    );
    write(&serde_json::to_string(&added).unwrap());
    let status = fixture.cli("status", None);
    assert_eq!(status["legacyDuplicates"].as_array().unwrap().len(), 1);
    let again = fixture.cli("install", status["installPlan"].as_str());
    assert_eq!(again["outcome"]["status"], "configured");
    assert_eq!(
        serde_json::from_str::<Value>(&fs::read_to_string(fixture.provider()).unwrap()).unwrap(),
        configured
    );
    let removed = fixture.cli("remove", fixture.cli("status", None)["removePlan"].as_str());
    assert_eq!(removed["outcome"]["status"], "removed");
}

#[test]
fn discovery_v5_grok_is_opt_in_keeps_older_mappings_and_preserves_a_literal_grok_home() {
    use std::{ffi::OsStr, fs};
    let (root, bin, marker) = metadata_fixture("grok");
    let home = root.path();
    for name in ["copilot", "amp"] {
        metadata_executable(&bin.join(name), &marker);
    }
    let default = home.join(".grok");
    fs::create_dir(&default).unwrap();
    fs::write(default.join("config.toml"), "PRIVATE_DO_NOT_READ").unwrap();
    let current = |overrides: &[(&str, &OsStr)]| {
        discover_metadata_version(home, bin.as_os_str(), overrides, Some(5))
    };
    let result = current(&[]);
    assert_eq!(result["schemaVersion"], 5);
    let grok = discovered(&result, "grok");
    assert_eq!(grok["setup"], "managed");
    assert_eq!(
        grok["executable"],
        json!({"path":bin.join("grok"),"source":"path"})
    );
    assert_eq!(
        grok["profiles"][0],
        json!({"path":default,"source":"HOME","state":"directory"})
    );
    // The newest schema keeps what versions 2 to 4 enabled.
    for agent in ["copilot", "amp"] {
        assert_eq!(discovered(&result, agent)["setup"], "managed");
    }
    assert_eq!(
        discovered(&current(&[("GROK_HOME", OsStr::new(""))]), "grok")["profiles"][0],
        grok["profiles"][0]
    );
    for suffix in ["chosen", "chosen "] {
        let literal = home.join(suffix);
        fs::create_dir(&literal).unwrap();
        let selected = current(&[("GROK_HOME", literal.as_os_str())]);
        assert_eq!(
            discovered(&selected, "grok")["profiles"][0],
            json!({"path":literal,"source":"GROK_HOME","state":"directory"})
        );
    }
    for invalid in invalid_profile_overrides() {
        assert_eq!(
            discovered(&current(&[("GROK_HOME", invalid)]), "grok")["profiles"][0],
            json!({"path":null,"source":"GROK_HOME","state":"invalid"})
        );
    }
    assert!(!result.to_string().contains("PRIVATE"));
    assert!(!marker.exists());
}

#[test]
fn grok_file_refuses_a_binary_path_that_grok_would_expand_and_keeps_a_literal_dollar() {
    use std::path::Path;
    for expanded in [
        "/owned/$HOME/lazysh-agent",
        "/owned/${HOME}/lazysh-agent",
        "/owned/$$/lazysh-agent",
        "/owned/a$_b",
        "/owned/it's $1",
    ] {
        assert_eq!(
            render::owned_file(record::Agent::Grok, Path::new(expanded)),
            Err("HooksInvalidBinary"),
            "{expanded}"
        );
    }
    for literal in [
        "/owned/a $ path",
        "/owned/trailing$",
        "/owned/it's a $-sign",
    ] {
        let file = render::owned_file(record::Agent::Grok, Path::new(literal)).unwrap();
        let file: Value = serde_json::from_str(&file).unwrap();
        let command = file["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(command.starts_with(&format!("'{}' ingest", literal.replace('\'', "'\\''"))));
    }
}

#[cfg(target_os = "linux")]
#[test]
fn grok_owned_file_binds_the_pane_and_session_log_when_run_the_way_grok_runs_hooks() {
    use files::Action;
    use std::fs;
    let fixture = ProfileFixture::new(record::Agent::Grok);
    let hooks = fixture.target.profile.join("hooks");
    fs::create_dir(&hooks).unwrap();
    let preserved = [
        (
            fixture.target.profile.join("config.toml"),
            "[folder_trust]\nenabled = false\n",
        ),
        (
            fixture.target.profile.join("disabled-hooks"),
            "global:foreign\n",
        ),
        (
            hooks.join("foreign.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep"}]}]}}"#,
        ),
    ];
    for (path, bytes) in &preserved {
        fs::write(path, bytes).unwrap();
    }
    // A fragment saved by hand under the same name is foreign: it is never overwritten.
    let manual = serde_json::to_string_pretty(&reported_history::grok_config()).unwrap();
    fixture.assert_manual_copy_is_foreign(&manual);
    let asset = fixture.install_hook_file();
    let events = asset["hooks"].as_object().unwrap();
    assert_eq!(
        events.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "Notification",
            "PostToolUse",
            "PostToolUseFailure",
            "SessionEnd",
            "SessionStart",
            "Stop",
            "StopCancelled",
            "StopFailure",
            "UserPromptSubmit"
        ],
        "PreToolUse is the one event that can deny a tool call and is never installed"
    );
    let expected = format!(
        "'{}' ingest --agent grok --reported-history",
        fixture.companion.to_str().unwrap().replace('\'', "'\\''")
    );
    for groups in events.values() {
        assert_eq!(
            groups[0]["hooks"][0],
            json!({"type":"command","command":expected,"timeout":5})
        );
    }
    // Run a command from the file as Grok does, through `sh -c`, with nothing on PATH.
    let state = fixture._root.path().join("state");
    let log = fixture
        ._root
        .path()
        .join("sessions/work-project/s1/updates.jsonl");
    let payload = json!({"hook_event_name":"UserPromptSubmit","hookEventName":"user_prompt_submit","session_id":"owned-grok","cwd":"/owned/grok","transcript_path":log});
    let mut child = std::process::Command::new("/bin/sh");
    child.args([
        "-c",
        events["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap(),
    ]);
    run_hook(&mut child, &state, Some("%7"), &payload);
    let row = &snapshot(&fixture.companion, &state)["sessions"][0];
    assert_eq!(
        (&row["agent"], &row["state"], &row["paneId"]),
        (&json!("Grok Build"), &json!("working"), &json!("%7"))
    );
    let bound = process::run(
        std::process::Command::new(&fixture.companion)
            .args(["reported-history", "--session-id=owned-grok"])
            .env_clear()
            .env("PATH", "")
            .env("LAZYSH_STATE_DIR", &state),
        b"",
    );
    let bound: Value = serde_json::from_slice(&bound.stdout).unwrap();
    assert_eq!(
        (&bound["status"], &bound["path"], &bound["paneId"]),
        (&json!("available"), &json!(log), &json!("%7"))
    );

    fixture.assert_reuse_then_remove_keeps(&preserved);
    fixture.apply_current(Action::Install);
    fixture.assert_edit_conflicts(manual);
}
