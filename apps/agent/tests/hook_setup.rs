#![cfg(any(target_os = "linux", target_os = "macos"))]
#[cfg(unix)]
#[path = "../src/hook_setup/commit.rs"]
mod commit;
#[cfg(unix)]
#[path = "../src/hook_setup/files.rs"]
mod files;
#[path = "../src/hook_setup/json.rs"]
mod json;
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
use lazysh_agent::{claude_config, hooks, Error, Result};
use serde_json::{json, Value};
#[path = "support/binary.rs"]
mod binary;
#[path = "support/json_output.rs"]
mod json_output;
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
    ] {
        let entries = render::entries(agent, &binary.path).unwrap();
        let plugin = (agent == Agent::Opencode).then(|| render::plugin(&binary.path).unwrap());
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
            assert!(plugin.contains(r#"Bun.spawn(["/owned/it's a companion", 'ingest'"#));
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

#[cfg(unix)]
#[test]
fn generated_shell_handlers_execute_the_quoted_absolute_companion_with_an_empty_path() {
    use std::{fs, process::Command};
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
                json!({"hook_event_name":"BeforeAgent","session_id":"owned-hook","cwd":"/owned/project","prompt":"must not be retained"}),
            ),
            record::Agent::Cursor => (
                "beforeSubmitPrompt",
                json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"owned-hook","workspace_roots":["/owned/project"],"prompt":"must not be retained"}),
            ),
            _ => (
                "UserPromptSubmit",
                json!({"hook_event_name":"UserPromptSubmit","session_id":"owned-hook","cwd":"/owned/project","prompt":"must not be retained"}),
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
        let output = process::run(
            Command::new("/bin/sh")
                .args(["-c", command])
                .env_clear()
                .env("PATH", "")
                .env("LAZYSH_STATE_DIR", &state),
            &serde_json::to_vec(&payload).unwrap(),
        );
        assert!(
            output.status.success(),
            "status={:?} stderr={}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty() && output.stderr.is_empty());
        let report = snapshot(&path, &state);
        assert_eq!(report["sessions"][0]["sessionId"], "owned-hook");
        assert_eq!(report["sessions"][0]["state"], "working");
        assert!(!report.to_string().contains("must not be retained"));
    }
}

#[cfg(unix)]
#[test]
fn rendered_opencode_plugin_executes_its_absolute_companion_with_an_empty_path() {
    use std::{fs, process::Command};
    let runtime = Command::new("bun")
        .args(["-p", "process.execPath"])
        .output()
        .expect("OpenCode plugin acceptance requires Bun");
    assert!(runtime.status.success());
    let runtime = std::path::PathBuf::from(String::from_utf8(runtime.stdout).unwrap().trim());
    assert!(runtime.is_absolute());
    let directory = tempfile::tempdir().unwrap();
    let companion = directory.path().join("OpenCode's companion $ with spaces");
    fs::copy(binary::path(), &companion).unwrap();
    let plugin = directory.path().join("lazysh.js");
    fs::write(&plugin, render::plugin(&companion).unwrap()).unwrap();
    let state = directory.path().join("state");
    let output=Command::new(runtime).args(["-e",r#"
        const { LazyshPlugin } = await import(process.env.LAZYSH_OWNED_PLUGIN);
        const hooks = await LazyshPlugin({ directory: '/owned/opencode-project' });
        await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'owned-plugin', status: { type: 'busy' } } } });
    "#]).env_clear().env("PATH","").env("LAZYSH_OWNED_PLUGIN",plugin).env("LAZYSH_STATE_DIR",&state).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let report = snapshot(&companion, &state);
    assert_eq!(report["sessions"][0]["sessionId"], "owned-plugin");
    assert_eq!(report["sessions"][0]["agent"], "OpenCode");
    assert_eq!(report["sessions"][0]["state"], "working");
}

fn initial_record(agent: record::Agent) -> record::Record {
    let mut record =
        record::Record::decode(include_bytes!("fixtures/hooks-v1-record.json")).unwrap();
    record.agent = agent;
    let owned = record.next.as_mut().unwrap();
    owned.entries = render::entries(agent, &owned.binary.path).unwrap();
    record.provider_after_sha256 = Some(if agent == record::Agent::Opencode {
        let digest = record::hash(render::plugin(&owned.binary.path).unwrap().as_bytes());
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
    use state::{classify, Observation};
    let mut record = initial_record(record::Agent::Opencode);
    let owned = record.next.as_ref().unwrap();
    let plugin = render::plugin(&owned.binary.path).unwrap();
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
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("selected profile");
        fs::create_dir(&profile).unwrap();
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o755)).unwrap();
        if agent == record::Agent::Droid {
            fs::write(profile.join("hooks.json"), "{}\n").unwrap();
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
    fn provider(&self) -> std::path::PathBuf {
        self.target.profile.join(match self.target.agent {
            record::Agent::Claude | record::Agent::Gemini => "settings.json",
            record::Agent::Codex | record::Agent::Droid | record::Agent::Cursor => "hooks.json",
            record::Agent::Opencode => "plugins/lazysh.js",
        })
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
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
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
        let reuse = fixture
            .apply(Action::Install, &fixture.plan(Action::Install))
            .unwrap();
        assert_eq!(reuse.status, "reused");
        assert!(!reuse.metadata_committed && !reuse.provider_committed);
        assert_eq!(fixture.inspect().provider.state, provider_identity);
        assert_eq!(fs::read(fixture.manifest()).unwrap(), receipt);
        let removed = fixture
            .apply(Action::Remove, &fixture.plan(Action::Remove))
            .unwrap();
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
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
fn owned_plugin_absent_install_remove_aba_cannot_replay_the_initial_inspection() {
    use files::Action;
    use std::fs;
    let fixture = ProfileFixture::new(record::Agent::Opencode);
    let original = fixture.plan(Action::Install);
    assert!(!fixture.target.profile.join("plugins").exists());
    assert_eq!(
        fixture.apply(Action::Install, &original).unwrap().status,
        "configured"
    );
    fs::write(
        fixture.target.profile.join("plugins/foreign.js"),
        "preserve other plugin",
    )
    .unwrap();
    assert_eq!(
        fixture
            .apply(Action::Remove, &fixture.plan(Action::Remove))
            .unwrap()
            .status,
        "removed"
    );
    assert!(!fixture.provider().exists());
    assert_eq!(
        fs::read_to_string(fixture.target.profile.join("plugins/foreign.js")).unwrap(),
        "preserve other plugin"
    );
    assert!(fixture.apply(Action::Install, &original).is_err());
    assert!(
        fixture.manifest().exists(),
        "retain the ownership tombstone"
    );
}

#[cfg(unix)]
#[test]
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
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
        let resumed = fixture
            .apply(Action::Install, &fixture.plan(Action::Install))
            .unwrap();
        assert!(matches!(resumed.status, "configured" | "reused"));
        assert_eq!(
            fixture.inspect().observation,
            Some(state::Observation::Configured)
        );
    }
}

#[cfg(unix)]
#[test]
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
fn canceling_a_prepared_first_install_retains_a_nonreplayable_metadata_tombstone() {
    use files::Action;
    let fixture = ProfileFixture::new(record::Agent::Opencode);
    let original = fixture.plan(Action::Install);
    fixture.prepare_without_provider(&original);
    let canceled = fixture
        .apply(Action::Remove, &fixture.plan(Action::Remove))
        .unwrap();
    assert_eq!(canceled.status, "removed");
    assert!(!canceled.provider_committed);
    assert!(!fixture.provider().exists());
    assert_eq!(
        fixture.inspect().observation,
        Some(state::Observation::Removed)
    );
    assert!(fixture.apply(Action::Install, &original).is_err());
}

#[test]
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
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
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
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
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
fn canceled_plugin_setup_with_a_missing_plugins_directory_never_reads_a_same_named_root_file() {
    use files::Action;
    use std::fs;
    let fixture = ProfileFixture::new(record::Agent::Opencode);
    fixture.prepare_without_provider(&fixture.plan(Action::Install));
    fs::remove_dir(fixture.target.profile.join("plugins")).unwrap();
    let unrelated = fixture.target.profile.join("lazysh.js");
    fs::write(&unrelated, "foreign root file").unwrap();
    let result = fixture
        .apply(Action::Remove, &fixture.plan(Action::Remove))
        .unwrap();
    assert_eq!(result.status, "removed");
    assert!(!result.provider_committed);
    assert!(!fixture.target.profile.join("plugins").exists());
    assert_eq!(fs::read_to_string(unrelated).unwrap(), "foreign root file");
}

#[test]
#[cfg_attr(
    target_os = "macos",
    ignore = "managed writes require native ACL qualification; unsupported before mutation"
)]
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

#[cfg(target_os = "linux")]
fn set_fixture_acl(file: &std::fs::File, default: bool) {
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

#[cfg(target_os = "linux")]
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
        set_fixture_acl(&fs::File::open(path).unwrap(), default);
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
            set_fixture_acl(&fs::File::open(&profile)?, true);
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

#[cfg(target_os = "linux")]
impl ProfileFixture {
    fn cli(&self, action: &str, plan: Option<&str>) -> Value {
        let mut command = std::process::Command::new(&self.companion);
        command.env_clear().env("PATH", "").args([
            "hooks",
            action,
            "--agent",
            self.target.agent.name(),
        ]);
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
#[test]
fn actual_managed_hook_cli_previews_and_lifecycle_use_only_the_selected_profile() {
    for agent in [
        record::Agent::Claude,
        record::Agent::Codex,
        record::Agent::Droid,
        record::Agent::Gemini,
        record::Agent::Cursor,
        record::Agent::Opencode,
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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
    fs::remove_file(fixture.provider()).unwrap();
    assert!(matches!(
        files::inspect(fixture.target.clone(), &fixture.companion),
        Err(Error::Installation("HooksDroidStandaloneRequired"))
    ));
    let status = fixture.cli("status", None);
    assert_eq!(status["supported"], false);
    assert_eq!(status["reason"], "HooksDroidStandaloneRequired");
    assert!(!fixture.provider().exists());
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
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    command
        .env_clear()
        .env("HOME", home)
        .env("PATH", path)
        .args(["hooks", "discover"]);
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
        "aider",
    ] {
        metadata_executable(&bin.join(name), &marker);
    }
    for name in [
        ".claude",
        ".factory",
        ".cursor",
        ".config/opencode",
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
    assert_eq!(result["managedSetupSupported"], cfg!(target_os = "linux"));
    assert_eq!(result["agents"].as_array().unwrap().len(), 11);
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
    for (agent, setup) in [
        ("cline", "manual"),
        ("kimi", "manual"),
        ("copilot", "manual"),
        ("amp", "manual"),
        ("aider", "healthOnly"),
    ] {
        assert_eq!(discovered(&result, agent)["setup"], setup);
        assert_eq!(discovered(&result, agent)["profiles"], json!([]));
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
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    let bin = home.join("bin");
    metadata_executable(&bin.join("codex"), &home.join("marker"));
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
    for name in ["opencode", "cursor-agent", "claude", "codex"] {
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
        ],
    );
    assert_eq!(
        discovered(&result, "opencode")["profiles"][0]["path"],
        config.join("opencode").to_str().unwrap()
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
