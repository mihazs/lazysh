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
    for agent in [Agent::Claude, Agent::Codex, Agent::Opencode] {
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
                record::hash(rewrite("{}\n", &[], &owned.entries).unwrap().as_bytes())
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
                assert_eq!(
                    entry.group["hooks"][0]["command"],
                    format!(
                        "'/owned/it'\\''s a companion' ingest --agent {}",
                        agent.name()
                    )
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
    for agent in [record::Agent::Claude, record::Agent::Codex] {
        let state = directory.path().join(agent.name());
        let hook = render::entries(agent, &path)
            .unwrap()
            .into_iter()
            .find(|entry| entry.event == "UserPromptSubmit")
            .unwrap();
        let command = hook.group["hooks"][0]["command"].as_str().unwrap();
        let payload = json!({"hook_event_name":"UserPromptSubmit","session_id":"owned-hook","cwd":"/owned/project","prompt":"must not be retained"});
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
        record::hash(rewrite("{}\n", &[], &owned.entries).unwrap().as_bytes())
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
            record::Agent::Claude => "settings.json",
            record::Agent::Codex => "hooks.json",
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
        record::Agent::Opencode,
    ] {
        let fixture = ProfileFixture::new(agent);
        let preview = fixture.cli("preview", None);
        assert_eq!(preview["reporting"], "notChecked");
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
