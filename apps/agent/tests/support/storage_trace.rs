//! Opt-in observation of the concurrent hook fixture, never production stores.
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Output},
};

#[path = "../../src/storage_failure_record.rs"]
#[allow(dead_code)]
mod failure_record;

const FILE_LIMIT: usize = 64;
const EXCERPT_LIMIT: usize = 128 * 1024;

pub(super) struct StorageTrace {
    spool: tempfile::TempDir,
    results: PathBuf,
    tool: PathBuf,
}

impl StorageTrace {
    pub(super) fn from_env() -> Option<Self> {
        let root = std::env::var_os("LAZYSH_TEST_STORAGE_TRACE_DIR")?;
        #[cfg(not(target_os = "linux"))]
        {
            let _ = root;
            panic!("storage syscall tracing requires Linux");
        }
        #[cfg(target_os = "linux")]
        Some(
            Self::new(Path::new(&root), Path::new("strace"))
                .expect("explicit storage tracing requested but strace/results unavailable"),
        )
    }

    fn new(root: &Path, tool: &Path) -> io::Result<Self> {
        let version = Command::new(tool).arg("--version").output()?;
        if !version.status.success() {
            return Err(io::Error::other("storage trace tool preflight failed"));
        }
        fs::create_dir_all(root)?;
        validate_metadata(&fs::symlink_metadata(root)?, true)?;
        Ok(Self {
            spool: tempfile::tempdir()?,
            results: tempfile::Builder::new()
                .prefix("concurrent-hooks-")
                .tempdir_in(root)?
                .keep(),
            tool: tool.to_owned(),
        })
    }

    pub(super) fn command(&self, worker: usize, program: &Path) -> Command {
        let mut command = Command::new(&self.tool);
        command
            .args([
                "-ff",
                "-ttt",
                "-T",
                "-yy",
                "-e",
                "trace=fcntl,fsync,fdatasync",
                "-o",
            ])
            .arg(self.spool.path().join(format!("writer-{worker}")))
            .arg("--")
            .arg(program)
            .env("LAZYSH_STORAGE_DIAGNOSTICS", "1");
        command
    }

    pub(super) fn export(&self, outputs: &[Output]) -> io::Result<()> {
        if outputs.len() > 16 {
            return Err(io::Error::other("unexpected storage trace worker count"));
        }
        let mut entries = fs::read_dir(self.spool.path())?
            .take(FILE_LIMIT + 1)
            .collect::<io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        let mut manifest = format!("fixture=concurrent_hooks_preserve_every_event observer=strace workers={}\nexport_file_limit={FILE_LIMIT} export_bytes_per_file={EXCERPT_LIMIT} raw_spool_byte_limit=none\n", outputs.len());
        for (worker, output) in outputs.iter().enumerate() {
            manifest.push_str(&format!(
                "worker={worker} status={} stdout_bytes={} stderr_bytes={}\n",
                output.status,
                output.stdout.len(),
                output.stderr.len()
            ));
            // Only a bounded, typed finite record may enter the same-worker manifest.
            // Never export the surrounding raw stderr, even if it resembles a diagnostic.
            if let Some(record) = failure_projection(&output.stderr) {
                manifest.push_str(&format!("worker={worker} {}", record.line()));
            }
        }
        for entry in entries.iter().take(FILE_LIMIT) {
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| io::Error::other("invalid trace filename"))?;
            if !valid_filename(name) {
                return Err(io::Error::other("unexpected file in owned trace spool"));
            }
            let original = copy_excerpt(&entry.path(), &self.results.join(name))?;
            manifest.push_str(&format!("trace={name} original_bytes={original}\n"));
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.results.join("manifest.txt"))?;
        file.write_all(manifest.as_bytes())?;
        if entries.is_empty() || entries.len() > FILE_LIMIT {
            return Err(io::Error::other(
                "missing/excess storage trace files; bounded manifest retained",
            ));
        }
        Ok(())
    }
}

fn failure_projection(stderr: &[u8]) -> Option<failure_record::Failure> {
    // CLI errors are small. Refuse unexpected bulk output rather than scanning it.
    if stderr.len() > 4096 {
        return None;
    }
    let mut records = std::str::from_utf8(stderr)
        .ok()?
        .lines()
        .filter_map(failure_record::Failure::parse);
    let first = records.next()?;
    if records.next().is_some() {
        return None;
    }
    Some(first)
}

const WORKER_PREFIX: &str = "lazysh-initialization-worker ";
#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum WorkerStage {
    Open,
    Ingest,
    Complete,
    Unknown,
}
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
enum WorkerOrigin {
    Initialization,
    TransientLock,
    ConcurrentHooks,
}
#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
enum WorkerResult {
    Success,
    StorageError,
    IoError,
    OtherError,
}
#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitializationWorker {
    origin: WorkerOrigin,
    round: u8,
    worker: u8,
    started_after_us: u64,
    open_elapsed_us: Option<u64>,
    total_elapsed_us: u64,
    actual_hold_us: Option<u64>,
    stage: WorkerStage,
    result: WorkerResult,
    sqlite_code: Option<i32>,
    exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sql_phase: Option<failure_record::Phase>,
}
#[derive(Debug, PartialEq, Eq)]
enum InitializationRecord {
    Phase(failure_record::Failure),
    Worker(InitializationWorker),
    FailedTest(&'static str),
}
impl InitializationRecord {
    fn line(&self) -> String {
        match self {
            Self::Phase(record) => record.line(),
            Self::FailedTest(name) => format!(
                "lazysh-initialization-failed-test {}\n",
                serde_json::json!({"name": name})
            ),
            Self::Worker(record) => format!(
                "{WORKER_PREFIX}{}\n",
                serde_json::to_string(record).expect("finite worker diagnostic")
            ),
        }
    }
}
pub(super) fn assert_child_storage_error(output: &Output, code: i32) {
    let record = InitializationWorker::child(
        0,
        output,
        &(std::time::Duration::ZERO, std::time::Duration::ZERO),
    )
    .unwrap();
    assert!(record.valid());
    assert_eq!(record.result, WorkerResult::StorageError);
    assert_eq!(record.sqlite_code, Some(code));
    assert_eq!(record.stage, WorkerStage::Unknown);
    assert_eq!(record.open_elapsed_us, None);
}

// Only a complete sanitized child error and its optional same-child finite phase
// may be correlated. Never infer a worker phase from the parent's global output.
fn child_error(
    output: &Output,
) -> Option<(WorkerResult, Option<i32>, Option<failure_record::Phase>)> {
    if output.status.code() != Some(1) || !output.stdout.is_empty() || output.stderr.len() > 4096 {
        return None;
    }
    let text = std::str::from_utf8(&output.stderr)
        .ok()?
        .strip_suffix('\n')?;
    let mut lines = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    let first = lines.next()?;
    let (diagnostic, terminal) = match lines.next() {
        None => (None, first),
        Some(terminal) => (Some(failure_record::Failure::parse(first)?), terminal),
    };
    if lines.next().is_some() {
        return None;
    }
    let (result, code) = terminal_error(terminal)?;
    if let Some(record) = &diagnostic {
        let matches = match result {
            WorkerResult::StorageError => {
                record.result == failure_record::ResultClass::StorageError
            }
            WorkerResult::IoError => record.result == failure_record::ResultClass::IoError,
            _ => false,
        };
        if !matches || record.sqlite_code != code {
            return None;
        }
    }
    Some((result, code, diagnostic.map(|record| record.phase)))
}

fn terminal_error(line: &str) -> Option<(WorkerResult, Option<i32>)> {
    match line {
        "lazysh-agent: IoError: operation failed" => Some((WorkerResult::IoError, None)),
        "lazysh-agent: StorageError: operation failed" => Some((WorkerResult::StorageError, None)),
        _ => {
            let code = line
                .strip_prefix("lazysh-agent: StorageError: operation failed (sqlite_code=")?
                .strip_suffix(')')?;
            let value = code.parse::<i32>().ok()?;
            (value.to_string() == code).then_some((WorkerResult::StorageError, Some(value)))
        }
    }
}

impl InitializationWorker {
    fn child(
        worker: u8,
        output: &Output,
        (start, elapsed): &(std::time::Duration, std::time::Duration),
    ) -> Option<Self> {
        let (result, sqlite_code, sql_phase) = child_error(output).unwrap_or_else(|| {
            (
                if output.status.success() {
                    WorkerResult::Success
                } else {
                    WorkerResult::OtherError
                },
                None,
                None,
            )
        });
        Some(Self {
            origin: WorkerOrigin::ConcurrentHooks,
            round: 0,
            worker,
            started_after_us: u64::try_from(start.as_micros()).ok()?,
            open_elapsed_us: None,
            total_elapsed_us: u64::try_from(elapsed.as_micros()).ok()?,
            actual_hold_us: None,
            // Phase opt-in does not expose open/ingest durations; keep timing stage unknown.
            stage: WorkerStage::Unknown,
            result,
            sqlite_code,
            exit_code: output.status.code(),
            sql_phase,
        })
    }

    fn valid(&self) -> bool {
        if (self.sql_phase.is_some()
            && (self.origin != WorkerOrigin::ConcurrentHooks
                || !matches!(
                    self.result,
                    WorkerResult::StorageError | WorkerResult::IoError
                )))
            || self.worker >= 16
            || self.round
                >= if self.origin == WorkerOrigin::Initialization {
                    4
                } else {
                    1
                }
            || self
                .open_elapsed_us
                .is_some_and(|open| open > self.total_elapsed_us)
        {
            return false;
        }
        if self.origin == WorkerOrigin::ConcurrentHooks {
            return self.open_elapsed_us.is_none()
                && self.actual_hold_us.is_none()
                && self.stage == WorkerStage::Unknown
                && match (&self.result, self.exit_code) {
                    (WorkerResult::Success, Some(0)) => self.sqlite_code.is_none(),
                    (WorkerResult::StorageError, Some(1)) => true,
                    (WorkerResult::IoError, Some(1)) => self.sqlite_code.is_none(),
                    (WorkerResult::OtherError, code) => {
                        code != Some(0) && self.sqlite_code.is_none()
                    }
                    _ => false,
                };
        }
        self.open_elapsed_us.is_some()
            && self.exit_code.is_none()
            && self.actual_hold_us.is_some() == (self.origin == WorkerOrigin::TransientLock)
            && self.stage != WorkerStage::Unknown
            && (self.stage == WorkerStage::Complete) == (self.result == WorkerResult::Success)
            && (self.sqlite_code.is_none() || self.result == WorkerResult::StorageError)
    }

    fn observed(round: u8, worker: u8, observed: &super::ContendedWorker) -> Option<Self> {
        let stage = match observed.stage {
            "open" => WorkerStage::Open,
            "ingest" => WorkerStage::Ingest,
            "complete" => WorkerStage::Complete,
            _ => unreachable!("unexpected initialization worker stage"),
        };
        let result = match &observed.result {
            Ok(()) => WorkerResult::Success,
            Err(lazysh_agent::Error::Storage(_)) => WorkerResult::StorageError,
            Err(lazysh_agent::Error::Io(_)) => WorkerResult::IoError,
            Err(_) => WorkerResult::OtherError,
        };
        let sqlite_code = match &observed.result {
            Err(lazysh_agent::Error::Storage(rusqlite::Error::SqliteFailure(code, _))) => {
                Some(code.extended_code)
            }
            _ => None,
        };
        let micros = |duration: std::time::Duration| u64::try_from(duration.as_micros()).ok();
        Some(Self {
            origin: WorkerOrigin::Initialization,
            round,
            worker,
            started_after_us: micros(observed.started_after)?,
            open_elapsed_us: Some(micros(observed.open_elapsed)?),
            total_elapsed_us: micros(observed.total_elapsed)?,
            actual_hold_us: None,
            stage,
            result,
            sqlite_code,
            exit_code: None,
            sql_phase: None,
        })
    }
}
fn emit_workers(records: impl IntoIterator<Item = Option<InitializationWorker>>) {
    for record in records.into_iter().flatten() {
        assert!(record.valid(), "invalid owned worker observation");
        let _ = io::stderr()
            .lock()
            .write_all(InitializationRecord::Worker(record).line().as_bytes());
    }
}
pub(super) fn initialization_workers(round: u8, workers: &[super::ContendedWorker]) {
    assert!(round < 4, "initialization round exceeds fixture bound");
    assert_eq!(workers.len(), 16, "initialization worker count changed");
    // Observe only after all workers join; do not add stderr contention inside Store::open.
    emit_workers(
        workers.iter().enumerate().map(|(worker, observed)| {
            InitializationWorker::observed(round, worker as u8, observed)
        }),
    );
}
pub(super) fn transient_workers(hold: std::time::Duration, workers: &[super::ContendedWorker]) {
    assert_eq!(workers.len(), 16, "transient worker count changed");
    emit_workers(workers.iter().enumerate().map(|(worker, observed)| {
        let mut record = InitializationWorker::observed(0, worker as u8, observed)?;
        record.origin = WorkerOrigin::TransientLock;
        record.actual_hold_us = Some(u64::try_from(hold.as_micros()).ok()?);
        Some(record)
    }));
}
pub(super) fn concurrent_workers(
    outputs: &[Output],
    timings: &[(std::time::Duration, std::time::Duration)],
) {
    assert_eq!(outputs.len(), 16, "concurrent worker count changed");
    assert_eq!(outputs.len(), timings.len(), "missing owned child timing");
    emit_workers(
        outputs
            .iter()
            .zip(timings)
            .enumerate()
            .map(|(worker, (output, timing))| {
                InitializationWorker::child(worker as u8, output, timing)
            }),
    );
}

// Only reviewed source names may leave the private owner spool.
const FAILED_TESTS: &[&str] = &[
    "cursor_observers_keep_conversation_identity_and_ignore_permission_and_child_hooks",
    "amp_native_state_projection_requires_exact_version_and_bounded_identity",
    "aider_native_callback_records_only_health_without_reading_stdin_or_changing_sessions",
    "absent_settings_read_returns_defaults_without_creating_state",
    "atomic_updates_persist_exact_values_and_reject_stale_revisions",
    "chained_custom_link_route_is_rejected_without_mutating_its_target",
    "claude_discards_prompts_tool_arguments_and_unknown_fields",
    "cline_root_lifecycle_preserves_native_identity_and_prints_without_profile_changes",
    "cline_distinct_roots_sharing_a_conversation_keep_separate_stable_report_rows",
    "cli_updates_apply_all_explicit_flags_and_new_processes_observe_them",
    "concurrent_hooks_preserve_every_event",
    "concurrent_ingest_recovers_after_a_transient_database_lock",
    "config_is_print_only_and_contains_supported_hooks",
    "additional_native_agents_report_only_their_actual_lifecycle_contracts",
    "copilot_distinct_children_complete_without_retiring_the_parent",
    "unscoped_kimi_terminal_hooks_do_not_finish_or_fault_the_parent",
    "codex_hooks_preserve_main_turn_while_subagents_finish",
    "opencode_native_events_keep_exact_sessions_and_bounded_metadata",
    "native_hook_assets_are_print_only_and_never_change_profiles_or_trust",
    "configuration_is_strict_bounded_and_updates_require_all_typed_values",
    "crash_writer_child",
    "disabled_operations_fail_before_transcript_or_device_access_but_settings_remain_readable",
    "distinct_sessions_and_agents_keep_their_latest_state",
    "hook_previews_label_their_dialect_and_platform_binding_without_creating_state",
    "hook_discovery_refuses_unrecognized_schema_versions_before_reading_profiles",
    "invalid_events_fail_without_files_or_secret_echo",
    "invalid_snapshot_limits_fail_before_creating_storage",
    "killed_writer_recovers_committed_wal_and_discards_uncommitted_tail",
    "legacy_read_only_transaction_blocks_migration_explicitly_without_losing_data",
    "lifecycle_events_update_status_without_executing_actions",
    "links_public_files_and_special_files_are_refused_without_changing_targets",
    "live_sidecars_are_private_and_unsafe_sidecars_leave_targets_untouched",
    "migration_preserves_existing_rows_and_verifies_full_wal_on_every_open",
    "native_bootstrap_and_sqlite_share_one_wait_deadline",
    "near_deadline_contention_counts_every_success_and_fails_explicitly",
    "normal_automatic_checkpoints_recycle_retained_wal_after_many_commits",
    "notifications_distinguish_attention_from_information",
    "opening_another_store_preserves_an_existing_sqlite_writer_lock",
    "oversized_stdin_fails_before_opening_storage",
    "parent_traversal_after_missing_prefix_is_rejected_before_creation",
    "real_binary_inspect_install_stale_preview_and_reuse_never_touch_state",
    "refuses_state_symlinks_and_database_links_without_changing_the_target",
    "short_lived_writers_keep_private_sidecar_inodes_and_recover_commits",
    "simultaneous_clients_have_one_winner_without_lost_updates",
    "simultaneous_initialization_and_ingest_preserve_every_event",
    "snapshot_caps_rows_and_uses_private_local_storage",
    "snapshot_expires_old_rows_even_without_new_events",
    "storage_trace::bounded_excerpt_preserves_lock_start_and_commit_end",
    "storage_trace::diagnostic_projection_is_finite_single_and_never_exports_raw_stderr",
    "storage_trace::explicitly_requested_missing_tool_fails_before_creating_results",
    "storage_trace::export_retains_only_a_bounded_number_of_owned_pid_files",
    "storage_trace::failed_test_allowlist_covers_every_owned_source_test",
    "storage_trace::failure_record::tests::records_are_bounded_and_reject_unknown_or_extra_data",
    "storage_trace::initialization_failed_harness_footers_keep_only_static_names",
    "storage_trace::initialization_failed_test_names_are_closed_bounded_and_deduplicated",
    "storage_trace::initialization_projection_exports_only_bounded_closed_records",
    "storage_trace::initialization_worker_projection_keeps_timing_without_raw_causes",
    "storage_trace::initialization_worker_stage_drift_still_fails",
    "storage_trace::worker_origins_keep_independent_epochs_and_strict_bounds",
    "storage_trace::child_observations_keep_unknown_sql_phase_and_redact_output",
    "storage_trace::project_owned_initialization_diagnostics",
    "storage_trace::trace_export_rejects_symlinks_and_hard_links_without_reading_them",
    "sustained_storage_contention_is_bounded_and_reports_only_the_sqlite_code",
    "unsupported_platform_reports_capability_before_any_namespace_mutation",
    "verified_darwin_system_temp_aliases_remain_supported",
    "windows_junction_route_is_rejected_before_target_mutation",
    "writable_ancestor_is_rejected_before_any_state_chmod_or_database_open",
];

fn initialization_projection(bytes: &[u8]) -> Option<Vec<InitializationRecord>> {
    if bytes.len() > EXCERPT_LIMIT {
        return None;
    }
    let mut records = Vec::new();
    let mut phases = 0;
    let mut workers = std::collections::BTreeSet::new();
    let mut failed_tests = std::collections::BTreeSet::new();
    for line in std::str::from_utf8(bytes).ok()?.lines() {
        if line.starts_with(failure_record::PREFIX) {
            if phases == 4 * 16 {
                return None;
            }
            phases += 1;
            records.push(InitializationRecord::Phase(failure_projection(
                line.as_bytes(),
            )?));
        } else if let Some(json) = line.strip_prefix(WORKER_PREFIX) {
            if line.len() > 512 {
                return None;
            }
            let record: InitializationWorker = serde_json::from_str(json).ok()?;
            if !record.valid() {
                return None;
            }
            if !workers.insert((record.origin, record.round, record.worker)) {
                return None;
            }
            records.push(InitializationRecord::Worker(record));
        } else if line.starts_with("test result: ") {
            continue;
        } else if line.starts_with("test ") && line.contains("FAILED") {
            if line.len() > 512 {
                return None;
            }
            let name = line.strip_prefix("test ")?.strip_suffix(" ... FAILED")?;
            let name = name.strip_suffix(" - should panic").unwrap_or(name);
            let name = FAILED_TESTS
                .iter()
                .copied()
                .find(|allowed| *allowed == name)?;
            if failed_tests.insert(name) {
                records.push(InitializationRecord::FailedTest(name));
            }
        }
    }
    Some(records)
}

fn journal_mode_busy_record() -> failure_record::Failure {
    failure_record::Failure {
        phase: failure_record::Phase::JournalMode,
        result: failure_record::ResultClass::StorageError,
        sqlite_code: Some(5),
    }
}

#[test]
fn initialization_projection_exports_only_bounded_closed_records() {
    let record = journal_mode_busy_record();
    let line = record.line();
    let raw = format!("private database path and error\n{line}{line}private tail\n");
    let projected = initialization_projection(raw.as_bytes()).unwrap();
    assert_eq!(projected.len(), 2);
    for value in projected {
        assert_eq!(value.line(), line);
        assert!(!value.line().contains("private"));
    }
    assert_eq!(
        initialization_projection(b"private raw output\n"),
        Some(vec![])
    );
    for raw in [
        line.repeat(65),
        "x".repeat(EXCERPT_LIMIT + 1),
        "lazysh-storage-diagnostic {\"phase\":\"private_path\"}".into(),
        line.replace("journal_mode", "private_path"),
        line.replace("\"sqliteCode\":5", "\"sqliteCode\":5,\"extra\":\"private\""),
    ] {
        assert!(initialization_projection(raw.as_bytes()).is_none());
    }
    assert!(initialization_projection(&[255]).is_none());
}

#[test]
fn initialization_failed_test_names_are_closed_bounded_and_deduplicated() {
    let name = "concurrent_hooks_preserve_every_event";
    let failed = format!("test {name} ... FAILED\n");
    let raw = format!(
        "private assertion and /private/database\n{failed}{failed}test {name} ... ok\nprivate tail\n"
    );
    let records = initialization_projection(raw.as_bytes()).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].line(),
        format!("lazysh-initialization-failed-test {{\"name\":\"{name}\"}}\n")
    );
    let should_panic = "storage_trace::initialization_worker_stage_drift_still_fails";
    let decorated = format!("test {should_panic} - should panic ... FAILED\n");
    assert_eq!(
        initialization_projection(decorated.as_bytes()).unwrap()[0].line(),
        format!("lazysh-initialization-failed-test {{\"name\":\"{should_panic}\"}}\n")
    );
    let all = FAILED_TESTS
        .iter()
        .map(|name| format!("test {name} ... FAILED\n"))
        .collect::<String>();
    assert_eq!(
        initialization_projection(format!("{all}{all}").as_bytes())
            .unwrap()
            .len(),
        FAILED_TESTS.len()
    );
    let mixed = format!("{}{failed}", journal_mode_busy_record().line());
    assert_eq!(
        initialization_projection(mixed.as_bytes()).unwrap().len(),
        2
    );
    for raw in [
        "test private_path_or_secret ... FAILED\n".to_owned(),
        format!("test {name} ... FAILED private assertion\n"),
        format!("test {name} ... FAILED\rprivate path\n"),
        format!("test {name}... FAILED\n"),
        format!("test {} ... FAILED\n", "x".repeat(513)),
        format!("{}{failed}", "x".repeat(EXCERPT_LIMIT)),
    ] {
        assert!(initialization_projection(raw.as_bytes()).is_none());
    }
}

#[test]
fn initialization_failed_harness_footers_keep_only_static_names() {
    let first = "concurrent_hooks_preserve_every_event";
    let second = "simultaneous_clients_have_one_winner_without_lost_updates";
    let harness = |name| {
        format!(
        "running 2 tests\ntest {name} ... FAILED\nfailures:\n---- {name} stdout ----\nprivate assertion /private/database token\nfailures:\n    {name}\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.00s\n"
    )
    };
    let raw = format!("{}{}", harness(first), harness(second));
    let records = initialization_projection(raw.as_bytes()).unwrap();
    assert_eq!(records.len(), 2);
    for (record, name) in records.iter().zip([first, second]) {
        assert_eq!(
            record.line(),
            format!("lazysh-initialization-failed-test {{\"name\":\"{name}\"}}\n")
        );
    }
    assert_eq!(
        initialization_projection(raw.replace('\n', "\r\n").as_bytes()),
        Some(records)
    );
}

#[test]
fn failed_test_allowlist_covers_every_owned_source_test() {
    let sources = [
        ("", include_str!("../cli.rs")),
        ("", include_str!("../settings.rs")),
        ("", include_str!("../storage_wal.rs")),
        ("", include_str!("../installation.rs")),
        ("storage_trace::", include_str!("storage_trace.rs")),
        (
            "storage_trace::failure_record::tests::",
            include_str!("../../src/storage_failure_record.rs"),
        ),
    ];
    let mut declared = std::collections::BTreeSet::new();
    for (prefix, source) in sources {
        let mut test = false;
        for line in source.lines().map(str::trim) {
            if line == "#[test]" {
                test = true;
            } else if test {
                if let Some(name) = line
                    .strip_prefix("fn ")
                    .and_then(|line| line.split_once('('))
                {
                    assert!(declared.insert(format!("{prefix}{}", name.0)));
                    test = false;
                }
            }
        }
        assert!(!test, "source test declaration did not end in a function");
    }
    let allowed = FAILED_TESTS.iter().map(|name| (*name).to_owned()).collect();
    assert_eq!(declared, allowed);
    assert_eq!(declared.len(), FAILED_TESTS.len());
}

fn rejects_worker_fields(value: &serde_json::Value, changes: &[(&str, serde_json::Value)]) {
    for (field, invalid) in changes {
        let mut invalid_record = value.clone();
        invalid_record[*field] = invalid.clone();
        assert!(
            initialization_projection(format!("{WORKER_PREFIX}{invalid_record}\n").as_bytes())
                .is_none()
        );
    }
}

fn contended_observation() -> super::ContendedWorker {
    super::ContendedWorker {
        started_after: std::time::Duration::from_micros(17),
        open_elapsed: std::time::Duration::from_micros(3_001_000),
        total_elapsed: std::time::Duration::from_micros(3_001_009),
        stage: "open",
        result: Err(lazysh_agent::Error::Storage(
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(5),
                Some("private path payload".into()),
            ),
        )),
    }
}

#[test]
fn initialization_worker_projection_keeps_timing_without_raw_causes() {
    let observed = contended_observation();
    let record = InitializationWorker::observed(0, 0, &observed).unwrap();
    let line = InitializationRecord::Worker(record).line();
    assert!(!line.contains("private"));
    let projected =
        initialization_projection(format!("private prelude\n{line}private tail\n").as_bytes())
            .unwrap();
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].line(), line);
    let value: serde_json::Value =
        serde_json::from_str(line.strip_prefix(WORKER_PREFIX).unwrap()).unwrap();
    assert_eq!(value["startedAfterUs"], 17);
    assert_eq!(value["openElapsedUs"], 3_001_000);
    assert_eq!(value["totalElapsedUs"], 3_001_009);
    assert_eq!(value["stage"], "open");
    assert_eq!(value["result"], "StorageError");
    assert_eq!(value["sqliteCode"], 5);
    let mut complete = value.clone();
    complete["worker"] = serde_json::json!(1);
    complete["stage"] = serde_json::json!("complete");
    complete["result"] = serde_json::json!("Success");
    complete["sqliteCode"] = serde_json::Value::Null;
    let mixed = format!(
        "{}{line}{WORKER_PREFIX}{complete}\n",
        journal_mode_busy_record().line()
    );
    assert_eq!(
        initialization_projection(mixed.as_bytes()).unwrap().len(),
        3
    );
    rejects_worker_fields(
        &value,
        &[
            ("origin", serde_json::json!("private")),
            ("origin", serde_json::json!("transient_lock")),
            ("origin", serde_json::json!("concurrent_hooks")),
            ("actualHoldUs", serde_json::json!(250000)),
            ("openElapsedUs", serde_json::Value::Null),
            ("exitCode", serde_json::json!(1)),
            ("stage", serde_json::json!("unknown")),
            ("round", serde_json::json!(4)),
            ("worker", serde_json::json!(16)),
            ("startedAfterUs", serde_json::json!(-1)),
            ("openElapsedUs", serde_json::json!(3_001_010)),
            ("totalElapsedUs", serde_json::json!(1.5)),
            ("stage", serde_json::json!("private")),
            ("stage", serde_json::json!("complete")),
            ("result", serde_json::json!("Success")),
            ("result", serde_json::json!("private")),
            ("result", serde_json::json!("IoError")),
            ("extra", serde_json::json!("private")),
        ],
    );
    assert!(initialization_projection(format!("{line}{line}").as_bytes()).is_none());
    let mut rows = String::new();
    for round in 0..4 {
        for worker in 0..16 {
            rows.push_str(
                &InitializationRecord::Worker(
                    InitializationWorker::observed(round, worker, &observed).unwrap(),
                )
                .line(),
            );
        }
    }
    assert_eq!(
        initialization_projection(rows.as_bytes()).unwrap().len(),
        64
    );
    assert!(initialization_projection(format!("{rows}{line}").as_bytes()).is_none());
    let opaque = super::ContendedWorker {
        result: Err(lazysh_agent::Error::Device("private payload")),
        ..observed
    };
    let line =
        InitializationRecord::Worker(InitializationWorker::observed(0, 0, &opaque).unwrap()).line();
    assert!(!line.contains("private"));
    assert!(line.contains("OtherError"));
}

#[test]
fn worker_origins_keep_independent_epochs_and_strict_bounds() {
    let observed = contended_observation();
    let mut records = String::new();
    for origin in [
        WorkerOrigin::Initialization,
        WorkerOrigin::TransientLock,
        WorkerOrigin::ConcurrentHooks,
    ] {
        let rounds = if origin == WorkerOrigin::Initialization {
            4
        } else {
            1
        };
        for round in 0..rounds {
            for worker in 0..16 {
                let mut record = InitializationWorker::observed(round, worker, &observed).unwrap();
                record.origin = origin;
                match origin {
                    WorkerOrigin::Initialization => {}
                    WorkerOrigin::TransientLock => record.actual_hold_us = Some(250123),
                    WorkerOrigin::ConcurrentHooks => {
                        record.open_elapsed_us = None;
                        record.stage = WorkerStage::Unknown;
                        record.result = WorkerResult::OtherError;
                        record.sqlite_code = None;
                        record.exit_code = Some(1);
                    }
                }
                assert!(record.valid());
                let line = InitializationRecord::Worker(record).line();
                assert!(line.len() <= 512);
                records.push_str(&line);
            }
        }
    }
    let decoded = initialization_projection(records.as_bytes()).unwrap();
    assert_eq!(decoded.len(), 96);
    let InitializationRecord::Worker(transient) = &decoded[64] else {
        panic!("expected transient worker");
    };
    assert_eq!(transient.origin, WorkerOrigin::TransientLock);
    assert_eq!(transient.round, 0);
    assert_eq!(transient.actual_hold_us, Some(250123));
    assert_eq!(transient.open_elapsed_us, Some(3_001_000));
    assert_eq!(
        transient.total_elapsed_us - transient.open_elapsed_us.unwrap(),
        9
    );
    let duplicate = decoded[64].line();
    assert!(initialization_projection(format!("{records}{duplicate}").as_bytes()).is_none());
    let invalid_round = duplicate.replace("\"round\":0", "\"round\":1");
    assert!(initialization_projection(invalid_round.as_bytes()).is_none());
}

#[test]
fn child_observations_keep_unknown_sql_phase_and_redact_output() {
    let directory = tempfile::tempdir().unwrap();
    let mut error = super::run(directory.path(), &["ingest", "--agent", "generic"], b"{}");
    assert_eq!(error.status.code(), Some(1));
    for (text, result, code) in [
        ("IoError: operation failed", WorkerResult::IoError, None),
        (
            "StorageError: operation failed",
            WorkerResult::StorageError,
            None,
        ),
        (
            "StorageError: operation failed (sqlite_code=5)",
            WorkerResult::StorageError,
            Some(5),
        ),
        (
            "StorageError: operation failed (sqlite_code=-2147483648)",
            WorkerResult::StorageError,
            Some(i32::MIN),
        ),
        (
            "StorageError: operation failed (sqlite_code=2147483647)",
            WorkerResult::StorageError,
            Some(i32::MAX),
        ),
    ] {
        for ending in ["\n", "\r\n"] {
            error.stderr = format!("lazysh-agent: {text}{ending}").into_bytes();
            let record = InitializationWorker::child(
                7,
                &error,
                &(std::time::Duration::ZERO, std::time::Duration::ZERO),
            )
            .unwrap();
            assert_eq!(record.result, result);
            assert_eq!(record.sqlite_code, code);
            assert_eq!(record.stage, WorkerStage::Unknown);
            assert_eq!(record.open_elapsed_us, None);
            let value = serde_json::to_value(&record).unwrap();
            rejects_worker_fields(
                &value,
                &[
                    ("exitCode", serde_json::json!(0)),
                    ("stage", serde_json::json!("ingest")),
                    ("openElapsedUs", serde_json::json!(0)),
                ],
            );
            assert!(initialization_projection(
                InitializationRecord::Worker(record).line().as_bytes()
            )
            .is_some());
        }
    }
    for code in [
        "+5",
        "05",
        "-0",
        " 5",
        "5 ",
        "2147483648",
        "-2147483649",
        "",
        "private",
    ] {
        error.stderr =
            format!("lazysh-agent: StorageError: operation failed (sqlite_code={code})\n")
                .into_bytes();
        assert!(child_error(&error).is_none());
    }
    let canonical = b"lazysh-agent: StorageError: operation failed (sqlite_code=5)\n";
    for rejected in [
        [canonical.as_slice(), canonical.as_slice()].concat(),
        [canonical.as_slice(), b"private payload"].concat(),
        [
            b"lazysh-storage-diagnostic {invalid}\n",
            canonical.as_slice(),
        ]
        .concat(),
        [b"private payload\n", canonical.as_slice()].concat(),
        canonical[..canonical.len() - 1].to_vec(),
        vec![b'x'; 4097],
        vec![0xff],
    ] {
        error.stderr = rejected;
        assert!(child_error(&error).is_none());
    }
    let diagnostic = journal_mode_busy_record().line();
    for invalid in [
        diagnostic.repeat(2),
        diagnostic.replace("journal_mode", "private"),
        diagnostic.replace("StorageError", "IoError"),
        diagnostic.replace("\"sqliteCode\":5", "\"sqliteCode\":6"),
        diagnostic.replace("\"sqliteCode\":5", "\"sqliteCode\":null"),
        diagnostic.replace(
            "\"sqliteCode\":5",
            "\"sqliteCode\":5,\"private\":\"secret\"",
        ),
        format!("{diagnostic}private payload\n"),
    ] {
        error.stderr = [invalid.as_bytes(), canonical].concat();
        assert!(child_error(&error).is_none());
        let observed = InitializationWorker::child(
            7,
            &error,
            &(std::time::Duration::ZERO, std::time::Duration::ZERO),
        )
        .unwrap();
        assert_eq!(observed.sql_phase, None);
        assert_eq!(observed.result, WorkerResult::OtherError);
        assert!(!InitializationRecord::Worker(observed)
            .line()
            .contains("private"));
    }
    for phase in [
        failure_record::Phase::BootstrapLock,
        failure_record::Phase::IngestBegin,
    ] {
        let record = failure_record::Failure {
            phase,
            ..journal_mode_busy_record()
        };
        for ending in ["\n", "\r\n"] {
            error.stderr = [
                record.line().replace('\n', ending).as_bytes(),
                std::str::from_utf8(canonical)
                    .unwrap()
                    .replace('\n', ending)
                    .as_bytes(),
            ]
            .concat();
            let observed = InitializationWorker::child(
                7,
                &error,
                &(std::time::Duration::ZERO, std::time::Duration::ZERO),
            )
            .unwrap();
            assert!(observed.valid());
            assert_eq!(observed.sql_phase, Some(phase));
            assert_eq!(observed.result, WorkerResult::StorageError);
            assert_eq!(observed.sqlite_code, Some(5));
            assert_eq!(observed.stage, WorkerStage::Unknown);
            assert_eq!(observed.open_elapsed_us, None);
            let value = serde_json::to_value(&observed).unwrap();
            rejects_worker_fields(
                &value,
                &[
                    ("sqlPhase", serde_json::json!("private")),
                    ("result", serde_json::json!("Success")),
                    ("origin", serde_json::json!("initialization")),
                ],
            );
            let line = InitializationRecord::Worker(observed).line();
            assert_eq!(
                initialization_projection(line.as_bytes()).unwrap()[0].line(),
                line
            );
        }
    }
    error.stderr = canonical.to_vec();
    error.stdout = b"private output".to_vec();
    assert!(child_error(&error).is_none());

    drop(super::Store::open(directory.path()).unwrap());
    let blocker = rusqlite::Connection::open(directory.path().join("events.sqlite3")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let started = std::time::Instant::now();
    let output = super::run_traced(
        directory.path(),
        &["ingest", "--agent", "generic"],
        &serde_json::to_vec(&super::event("observed", "working")).unwrap(),
        None,
        true,
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    let observed =
        InitializationWorker::child(3, &output, &(std::time::Duration::ZERO, started.elapsed()))
            .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(observed.valid());
    assert_eq!(observed.sql_phase, Some(failure_record::Phase::IngestBegin));
    assert_eq!(observed.sqlite_code, Some(5));
    assert_eq!(observed.open_elapsed_us, None);
    let line = InitializationRecord::Worker(observed).line();
    assert!(!line.contains(directory.path().to_str().unwrap()));
    assert!(!line.contains("observed"));
    assert_eq!(
        initialization_projection(line.as_bytes()).unwrap()[0].line(),
        line
    );
    assert!(super::snapshot(directory.path(), "50")["sessions"]
        .as_array()
        .unwrap()
        .is_empty());

    for (worker, args) in [
        (0, &["--help"][..]),
        (1, &["private-unrecognized-command"][..]),
    ] {
        let started = std::time::Instant::now();
        let output = super::run(directory.path(), args, b"");
        assert_eq!(output.status.success(), worker == 0);
        let mut contradiction = output.clone();
        contradiction.stdout.clear();
        contradiction.stderr = canonical.to_vec();
        assert!(child_error(&contradiction).is_none());
        let timing = (std::time::Duration::from_micros(19), started.elapsed());
        let record = InitializationWorker::child(worker, &output, &timing).unwrap();
        assert!(record.valid());
        let line = InitializationRecord::Worker(record).line();
        assert!(!line.contains("private"));
        let decoded = initialization_projection(line.as_bytes()).unwrap();
        assert_eq!(decoded.len(), 1);
        let InitializationRecord::Worker(record) = &decoded[0] else {
            panic!("expected child observation");
        };
        assert_eq!(record.origin, WorkerOrigin::ConcurrentHooks);
        assert_eq!(record.stage, WorkerStage::Unknown);
        assert_eq!(record.open_elapsed_us, None);
        assert_eq!(record.sqlite_code, None);
        assert_eq!(record.exit_code, output.status.code());
        let value: serde_json::Value =
            serde_json::from_str(line.strip_prefix(WORKER_PREFIX).unwrap()).unwrap();
        rejects_worker_fields(
            &value,
            &[
                ("round", serde_json::json!(1)),
                ("stage", serde_json::json!("ingest")),
                ("openElapsedUs", serde_json::json!(0)),
                ("actualHoldUs", serde_json::json!(0)),
                ("sqliteCode", serde_json::json!(5)),
                ("extra", serde_json::json!("private")),
            ],
        );
        let mut contradiction = value;
        contradiction["exitCode"] = serde_json::json!(if worker == 0 { 1 } else { 0 });
        assert!(
            initialization_projection(format!("{WORKER_PREFIX}{contradiction}\n").as_bytes())
                .is_none()
        );
    }
}

#[test]
#[should_panic(expected = "unexpected initialization worker stage")]
fn initialization_worker_stage_drift_still_fails() {
    let observed = super::ContendedWorker {
        started_after: std::time::Duration::ZERO,
        open_elapsed: std::time::Duration::ZERO,
        total_elapsed: std::time::Duration::ZERO,
        stage: "unexpected",
        result: Ok(()),
    };
    let _ = InitializationWorker::observed(0, 0, &observed);
}

#[test]
#[ignore = "explicit owned CI spool projection; never exports raw test output"]
fn project_owned_initialization_diagnostics() {
    let observed = || -> io::Result<Vec<InitializationRecord>> {
        let path = std::env::var_os("LAZYSH_INITIALIZATION_DIAGNOSTICS")
            .ok_or_else(|| io::Error::other("Missing owned initialization spool"))?;
        let (file, metadata) = open_owned_file(Path::new(&path))?;
        if metadata.len() > EXCERPT_LIMIT as u64 {
            return Err(io::Error::other("Initialization spool exceeds its bound"));
        }
        let mut bytes = Vec::new();
        file.take(EXCERPT_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)?;
        initialization_projection(&bytes)
            .ok_or_else(|| io::Error::other("Invalid initialization projection"))
    };
    match observed() {
        Ok(records) => {
            eprintln!(
                "initialization-phase-records={}",
                records
                    .iter()
                    .filter(|record| matches!(record, InitializationRecord::Phase(_)))
                    .count()
            );
            eprintln!(
                "initialization-worker-records={}",
                records
                    .iter()
                    .filter(|record| matches!(record, InitializationRecord::Worker(_)))
                    .count()
            );
            eprintln!(
                "initialization-failed-tests={}",
                records
                    .iter()
                    .filter(|record| matches!(record, InitializationRecord::FailedTest(_)))
                    .count()
            );
            for record in records {
                eprint!("{}", record.line());
            }
        }
        Err(_) => panic!("Owned initialization phase projection unavailable"),
    }
}

#[test]
fn diagnostic_projection_is_finite_single_and_never_exports_raw_stderr() {
    let record = journal_mode_busy_record();
    let line = record.line();
    let stderr = format!("private-path-and-payload\n{line}private-diagnostic-tail\n");
    assert_eq!(failure_projection(stderr.as_bytes()), Some(record));
    assert!(failure_projection(format!("{line}{line}").as_bytes()).is_none());
    assert!(failure_projection(&vec![b'x'; 4097]).is_none());
    assert!(
        failure_projection(b"lazysh-storage-diagnostic {\"phase\":\"private_secret\"}").is_none()
    );
}

fn valid_filename(name: &str) -> bool {
    let Some((worker, pid)) = name
        .strip_prefix("writer-")
        .and_then(|name| name.split_once('.'))
    else {
        return false;
    };
    !worker.is_empty()
        && worker.len() <= 2
        && worker.bytes().all(|byte| byte.is_ascii_digit())
        && !pid.is_empty()
        && pid.len() <= 10
        && pid.bytes().all(|byte| byte.is_ascii_digit())
        && worker.parse::<usize>().is_ok_and(|worker| worker < 16)
        && pid.parse::<u32>().is_ok_and(|pid| pid > 0)
}

fn validate_metadata(metadata: &fs::Metadata, directory: bool) -> io::Result<()> {
    if metadata.file_type().is_symlink()
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
    {
        return Err(io::Error::other(
            "trace path is not an owned regular file/directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid takes no pointers and observes this fixture's user.
        if metadata.uid() != unsafe { libc::geteuid() } || (!directory && metadata.nlink() != 1) {
            return Err(io::Error::other("trace file ownership/link count mismatch"));
        }
    }
    Ok(())
}

fn open_owned_file(source: &Path) -> io::Result<(fs::File, fs::Metadata)> {
    validate_metadata(&fs::symlink_metadata(source)?, false)?;
    #[cfg(unix)]
    let options = lazysh_common::fs::read_options_with_flags(false, libc::O_CLOEXEC);
    #[cfg(not(unix))]
    let options = lazysh_common::fs::read_options(false);
    let source = options.open(source)?;
    let metadata = source.metadata()?;
    validate_metadata(&metadata, false)?;
    Ok((source, metadata))
}

fn copy_excerpt(source: &Path, destination: &Path) -> io::Result<u64> {
    let (mut source, metadata) = open_owned_file(source)?;
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    if metadata.len() <= EXCERPT_LIMIT as u64 {
        io::copy(&mut source.take(EXCERPT_LIMIT as u64), &mut destination)?;
    } else {
        let marker = b"\n... middle omitted by bounded export ...\n";
        let head = EXCERPT_LIMIT / 2;
        let tail = EXCERPT_LIMIT - head - marker.len();
        io::copy(
            &mut Read::by_ref(&mut source).take(head as u64),
            &mut destination,
        )?;
        destination.write_all(marker)?;
        source.seek(SeekFrom::End(-(tail as i64)))?;
        io::copy(&mut source.take(tail as u64), &mut destination)?;
    }
    Ok(metadata.len())
}

#[test]
fn bounded_excerpt_preserves_lock_start_and_commit_end() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let destination = dir.path().join("excerpt");
    let mut bytes = b"BEGIN_LOCK\n".to_vec();
    bytes.extend(vec![b'x'; EXCERPT_LIMIT * 3]);
    bytes.extend_from_slice(b"\nCOMMIT_UNLOCK");
    fs::write(&source, &bytes).unwrap();
    assert_eq!(
        copy_excerpt(&source, &destination).unwrap(),
        bytes.len() as u64
    );
    let excerpt = fs::read(destination).unwrap();
    assert_eq!(excerpt.len(), EXCERPT_LIMIT);
    assert!(excerpt.starts_with(b"BEGIN_LOCK\n"));
    assert!(excerpt.ends_with(b"\nCOMMIT_UNLOCK"));
    assert_eq!(fs::read(source).unwrap(), bytes);
}

#[test]
fn explicitly_requested_missing_tool_fails_before_creating_results() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("results");
    assert!(StorageTrace::new(&root, &dir.path().join("absent-strace")).is_err());
    assert!(!root.exists());
}

#[test]
fn export_retains_only_a_bounded_number_of_owned_pid_files() {
    let results = tempfile::tempdir().unwrap();
    let trace = StorageTrace {
        spool: tempfile::tempdir().unwrap(),
        results: results.path().to_owned(),
        tool: PathBuf::from("unused"),
    };
    for pid in 1..=FILE_LIMIT + 1 {
        fs::write(
            trace.spool.path().join(format!("writer-0.{pid}")),
            b"fcntl fixture\n",
        )
        .unwrap();
    }
    assert!(
        trace.export(&[]).is_err(),
        "excess files must be reported, not silently ignored"
    );
    let files = fs::read_dir(results.path())
        .unwrap()
        .collect::<io::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(files.len(), FILE_LIMIT + 1); // excerpts plus bounded manifest
    assert!(files
        .iter()
        .all(|file| file.metadata().unwrap().len() <= EXCERPT_LIMIT as u64));
    assert_eq!(
        fs::read_dir(trace.spool.path()).unwrap().count(),
        FILE_LIMIT + 1
    );
}

#[cfg(unix)]
#[test]
fn trace_export_rejects_symlinks_and_hard_links_without_reading_them() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("untouched");
    fs::write(&target, b"fixture sentinel").unwrap();
    let link = dir.path().join("linked");
    symlink(&target, &link).unwrap();
    assert!(copy_excerpt(&link, &dir.path().join("symlink-excerpt")).is_err());
    fs::remove_file(&link).unwrap();
    fs::hard_link(&target, &link).unwrap();
    assert!(copy_excerpt(&link, &dir.path().join("hardlink-excerpt")).is_err());
    assert_eq!(fs::read(target).unwrap(), b"fixture sentinel");
}
