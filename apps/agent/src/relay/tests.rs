use super::*;
use crate::{Event, SessionState};
use chrono::Utc;

fn config(directory: &std::path::Path) -> Configuration {
    let account_id = uuid::Uuid::new_v4().to_string();
    let source_id = uuid::Uuid::new_v4().to_string();
    Configuration{schema_version:1,capability_file:directory.join("missing-capability"),ca_file:None,binding:serde_json::json!({"schemaVersion":1,"origin":"https://relay.invalid","accountId":account_id,"sourceId":source_id,"capabilityHash":"a".repeat(64),"caHash":null}).to_string(),account_id,source_id,remote_generation:7}
}
fn event(state: SessionState) -> Event {
    Event {
        session_id: "private-session-id".into(),
        agent: "private-agent".into(),
        project: "ssh://private-host/secret-project".into(),
        state,
        summary: "private-prompt-tool-transcript".into(),
        pane_id: Some("private-pane".into()),
        pane_server: None,
        title: None,
        waiting: None,
    }
}
fn enabled() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    store::change(
        &mut store.connection,
        0,
        Some(config(directory.path())),
        true,
    )
    .unwrap();
    (directory, store)
}
fn working() -> (tempfile::TempDir, Store, i64) {
    let (directory, mut store) = enabled();
    let now = Utc::now().timestamp();
    store
        .ingest(&event(SessionState::Working), Utc::now())
        .unwrap();
    (directory, store, now)
}
#[test]
fn default_off_and_configuration_never_backfill_prior_state() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    assert!(!store.relay_status().unwrap().enabled);
    store
        .ingest(&event(SessionState::Working), Utc::now())
        .unwrap();
    assert_eq!(store.relay_status().unwrap().pending, 0);
    store::change(
        &mut store.connection,
        0,
        Some(config(directory.path())),
        true,
    )
    .unwrap();
    store
        .ingest(&event(SessionState::Working), Utc::now())
        .unwrap();
    assert_eq!(store.relay_status().unwrap().pending, 0);
    store
        .ingest(&event(SessionState::NeedsAttention), Utc::now())
        .unwrap();
    assert_eq!(store.relay_status().unwrap().pending, 1);
    assert!(!directory.path().join("relay-publisher.lock").exists());
}
#[test]
fn only_original_normalized_transitions_admit_ids_and_exclude_private_event_fields() {
    let (_directory, mut store) = enabled();
    for state in [
        SessionState::Working,
        SessionState::Working,
        SessionState::NeedsAttention,
        SessionState::NeedsAttention,
        SessionState::Done,
    ] {
        store.ingest(&event(state), Utc::now()).unwrap();
    }
    assert_eq!(store.relay_status().unwrap().pending, 3);
    let mut query = store
        .connection
        .prepare("SELECT id,kind,config FROM relay_outbox ORDER BY rowid")
        .unwrap();
    let rows = query
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(),
        ["working", "needs_attention", "done"]
    );
    for (id, _, text) in rows {
        uuid::Uuid::parse_str(&id).unwrap();
        for marker in [
            "private-session",
            "private-agent",
            "private-host",
            "secret-project",
            "private-prompt",
            "private-pane",
        ] {
            assert!(!text.contains(marker));
        }
    }
}
#[test]
fn unexpected_outbox_failure_rolls_back_the_local_event_and_does_not_count_capacity() {
    let (_directory, mut store) = enabled();
    store.connection.execute_batch("CREATE TRIGGER reject_outbox BEFORE INSERT ON relay_outbox BEGIN SELECT RAISE(ABORT,'owned fixture'); END;").unwrap();
    assert!(store
        .ingest(&event(SessionState::Working), Utc::now())
        .is_err());
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(store.relay_status().unwrap().pending, 0);
    assert_eq!(store.relay_status().unwrap().capacity_failures, 0);
}
#[test]
fn capacity_rejection_is_durable_but_sql_failure_is_not_hidden_as_capacity() {
    let (_directory, mut store) = enabled();
    let now = Utc::now().timestamp();
    let transaction = store.connection.transaction().unwrap();
    for _ in 0..PENDING_LIMIT {
        store::admit_transition(
            &transaction,
            Kind::Working,
            &event(SessionState::Working),
            true,
            now,
        )
        .unwrap();
    }
    transaction.commit().unwrap();
    store
        .ingest(&event(SessionState::NeedsAttention), Utc::now())
        .unwrap();
    assert_eq!(store.relay_status().unwrap().pending, PENDING_LIMIT as u64);
    assert_eq!(store.relay_status().unwrap().capacity_failures, 1);
    store
        .ingest(&event(SessionState::NeedsAttention), Utc::now())
        .unwrap();
    assert_eq!(store.relay_status().unwrap().capacity_failures, 1);
    store.connection.execute_batch("CREATE TRIGGER reject_counter BEFORE UPDATE ON relay_policy BEGIN SELECT RAISE(ABORT,'owned fixture'); END;").unwrap();
    assert!(store
        .ingest(&event(SessionState::Done), Utc::now())
        .is_err());
    let (state, count): (String, i64) = store
        .connection
        .query_row("SELECT state,event_count FROM sessions", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(state, "needs_attention");
    assert_eq!(count, 2);
    assert_eq!(store.relay_status().unwrap().capacity_failures, 1);
}
#[test]
fn generation_change_preserves_original_jobs_and_fences_late_completion() {
    let (directory, mut store, now) = working();
    let old = store::claim(&mut store.connection, 1, now)
        .unwrap()
        .unwrap();
    let old_config = old.config.encode().unwrap();
    store::change(
        &mut store.connection,
        1,
        Some(config(directory.path())),
        true,
    )
    .unwrap();
    store::finish(
        &mut store.connection,
        &old,
        store::Completion::Recorded("opaque-receipt"),
        now,
    )
    .unwrap();
    let (state, unchanged): (String, String) = store
        .connection
        .query_row(
            "SELECT state,config FROM relay_outbox WHERE id=?1",
            [&old.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "cancelled_unknown");
    assert_eq!(unchanged, old_config);
    assert!(store::claim(&mut store.connection, 1, now)
        .unwrap()
        .is_none());
    store
        .ingest(&event(SessionState::NeedsAttention), Utc::now())
        .unwrap();
    let fresh = store::claim(&mut store.connection, 2, now)
        .unwrap()
        .unwrap();
    assert_ne!(fresh.config.encode().unwrap(), old_config);
}
#[test]
fn interrupted_third_attempt_stays_exhausted_after_store_reopens() {
    let (directory, mut store, now) = working();
    let mut id = String::new();
    for attempt in 1..=3 {
        let job = store::claim(&mut store.connection, 1, now + attempt * 2)
            .unwrap()
            .unwrap();
        assert_eq!(job.attempts, attempt);
        if attempt == 1 {
            id = job.id.clone();
        } else {
            assert_eq!(job.id, id);
        }
        if attempt < 3 {
            store::finish(
                &mut store.connection,
                &job,
                store::Completion::Retry,
                now + attempt * 2,
            )
            .unwrap();
        }
    }
    drop(store);
    let mut store = Store::open(directory.path()).unwrap();
    assert!(store::claim(&mut store.connection, 1, now + 10)
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .connection
            .query_row("SELECT state FROM relay_outbox WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "failed_unknown"
    );
}

#[test]
fn successful_claim_trims_expired_rows_before_committing_the_fresh_job() {
    let (_directory, mut store) = enabled();
    let now = Utc::now().timestamp();
    let transaction = store.connection.transaction().unwrap();
    for _ in 0..102 {
        store::admit_transition(
            &transaction,
            Kind::Working,
            &event(SessionState::Working),
            true,
            now,
        )
        .unwrap();
    }
    transaction
        .execute(
            "UPDATE relay_outbox SET expires=?1 WHERE rowid<=101",
            [now - 1],
        )
        .unwrap();
    transaction.commit().unwrap();
    let fresh = store::claim(&mut store.connection, 1, now)
        .unwrap()
        .unwrap();
    let terminal: i64 = store
        .connection
        .query_row(
            "SELECT count(*) FROM relay_outbox WHERE state NOT IN ('queued','sending')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(terminal, TERMINAL_LIMIT);
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT state FROM relay_outbox WHERE id=?1",
                [fresh.id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "sending"
    );
}

#[test]
fn stale_attempt_cannot_finalize_a_newer_claim_under_the_same_revision() {
    let (_directory, mut store, now) = working();
    let old = store::claim(&mut store.connection, 1, now)
        .unwrap()
        .unwrap();
    store::finish(&mut store.connection, &old, store::Completion::Retry, now).unwrap();
    let fresh = store::claim(&mut store.connection, 1, now + 2)
        .unwrap()
        .unwrap();
    assert_eq!(fresh.attempts, 2);
    assert!(!store::finish(
        &mut store.connection,
        &old,
        store::Completion::Recorded("stale"),
        now + 2
    )
    .unwrap());
    assert!(store::finish(
        &mut store.connection,
        &fresh,
        store::Completion::Recorded("fresh"),
        now + 2
    )
    .unwrap());
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT receipt FROM relay_outbox WHERE id=?1",
                [fresh.id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "fresh"
    );
}

#[test]
fn concurrent_same_state_ingest_admits_one_transition_in_the_local_transaction() {
    let (directory, store) = enabled();
    drop(store);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let directory = directory.path().to_path_buf();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut store = Store::open(&directory).unwrap();
                barrier.wait();
                let started = std::time::Instant::now();
                store
                    .ingest(&event(SessionState::Working), Utc::now())
                    .unwrap_or_else(|error| {
                        panic!("ingest elapsed {:?}: {error:?}", started.elapsed())
                    });
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let store = Store::open(directory.path()).unwrap();
    assert_eq!(store.relay_status().unwrap().pending, 1);
    assert_eq!(
        store
            .connection
            .query_row("SELECT event_count FROM sessions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

fn maintain_due(store: &mut Store, now: i64) {
    assert!(
        store::schedule(&store.connection, 1, now)
            .unwrap()
            .maintenance
    );
    store::maintain(&mut store.connection, 1, now).unwrap();
}

#[test]
fn read_only_schedule_and_maintenance_recover_and_expire_without_loading_credentials() {
    let (_directory, mut store, now) = working();
    let job = store::claim(&mut store.connection, 1, now)
        .unwrap()
        .unwrap();
    maintain_due(&mut store, now);
    let schedule = store::schedule(&store.connection, 1, now).unwrap();
    assert!(!schedule.maintenance);
    assert_eq!(schedule.next_attempt, Some(0));
    let (id, attempts): (String, i64) = store
        .connection
        .query_row("SELECT id,attempts FROM relay_outbox", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(id, job.id);
    assert_eq!(attempts, 1);
    store
        .connection
        .execute("UPDATE relay_outbox SET expires=?1", [now - 1])
        .unwrap();
    store::maintain(&mut store.connection, 1, now).unwrap();
    assert_eq!(store.relay_status().unwrap().retained_unknown, 1);
    let changed = store.connection.total_changes();
    for _ in 0..100 {
        let idle = store::schedule(&store.connection, 1, now).unwrap();
        assert!(!idle.maintenance);
        assert!(idle.next_attempt.is_none());
        assert!(store.connection.is_autocommit());
    }
    assert_eq!(store.connection.total_changes(), changed);
}

#[test]
fn schedule_maintenance_terminalizes_exhausted_recovery_without_claiming_again() {
    let (_directory, mut store, now) = working();
    store
        .connection
        .execute(
            "UPDATE relay_outbox SET state='sending',attempts=3,may_sent=1",
            [],
        )
        .unwrap();
    maintain_due(&mut store, now);
    let idle = store::schedule(&store.connection, 1, now).unwrap();
    assert!(!idle.maintenance);
    assert!(idle.next_attempt.is_none());
    let (state, attempts): (String, i64) = store
        .connection
        .query_row("SELECT state,attempts FROM relay_outbox", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(state, "failed_unknown");
    assert_eq!(attempts, 3);
}

mod notification_policy {
    use super::*;
    use crate::{
        desktop_lock::Desktop,
        notification_policy::{update, Admission, Environment},
        Agent,
    };

    /// A host with a stated process tree (`nested`) and desktop.
    struct Host(bool, Desktop);
    impl Environment for Host {
        fn nested(&self, _: Agent) -> bool {
            self.0
        }
        fn desktop(&self) -> Desktop {
            self.1
        }
    }
    /// One transition into needs-attention as the `ingest` command admits it on `host`; returns the queue length.
    fn attention(
        directory: &std::path::Path,
        store: &mut Store,
        sequence: &[SessionState],
        host: &Host,
    ) -> u64 {
        for state in sequence {
            let admission = store.admission(directory, Agent::Codex, host).unwrap();
            store
                .ingest_with_reported_history(Some(&event(*state)), None, Utc::now(), admission)
                .unwrap();
        }
        store.relay_status().unwrap().pending
    }
    const ASK: [SessionState; 1] = [SessionState::NeedsAttention];

    #[test]
    fn a_nested_agent_is_stored_but_queues_nothing_while_the_switch_is_on() {
        let (directory, mut store) = enabled();
        update(directory.path(), 0, true, false).unwrap();
        let nested = Host(true, Desktop::Unknown);
        assert_eq!(attention(directory.path(), &mut store, &ASK, &nested), 0);
        let snapshot = store.snapshot(10, Utc::now()).unwrap();
        assert_eq!(
            snapshot.sessions[0].event.state,
            SessionState::NeedsAttention
        );
        // The same agent outside a nesting still notifies, so suppression is per event, not per session.
        assert_eq!(
            attention(
                directory.path(),
                &mut store,
                &[SessionState::Done],
                &Host(false, Desktop::Unknown)
            ),
            1
        );
    }

    #[test]
    fn the_same_nested_agent_queues_when_the_switch_is_off() {
        let (directory, mut store) = enabled();
        update(directory.path(), 0, false, false).unwrap();
        let nested = Host(true, Desktop::Unlocked);
        assert_eq!(attention(directory.path(), &mut store, &ASK, &nested), 1);
    }

    #[test]
    fn an_unlocked_desktop_suppresses_but_a_locked_or_unknown_one_notifies() {
        for (desktop, queued) in [
            (Desktop::Unlocked, 0),
            (Desktop::Locked, 1),
            (Desktop::Unknown, 1),
        ] {
            let (directory, mut store) = enabled();
            update(directory.path(), 0, false, true).unwrap();
            let host = Host(false, desktop);
            assert_eq!(
                attention(directory.path(), &mut store, &ASK, &host),
                queued,
                "{desktop:?}"
            );
        }
    }

    #[test]
    fn without_a_relay_the_policy_is_not_even_consulted() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        update(directory.path(), 0, true, true).unwrap();
        let host = Host(true, Desktop::Unlocked);
        assert_eq!(
            store
                .admission(directory.path(), Agent::Codex, &host)
                .unwrap(),
            Admission::Queue
        );
    }
}

#[test]
fn event_owner_is_transactional_source_bound_and_survives_restart() {
    let (directory, mut store) = enabled();
    let configured = config(directory.path());
    // The bound account and source come from the stored policy, not a caller's guess.
    let bound = store::policy(&store.connection).unwrap().config.unwrap();
    let bound = Configuration::decode(&bound).unwrap();
    let now = Utc::now();
    let mut report = event(SessionState::NeedsAttention);
    report.pane_server = Some("tmux:work".into());
    store.ingest(&report, now).unwrap();
    let id: String = store
        .connection
        .query_row("SELECT id FROM relay_outbox", [], |r| r.get(0))
        .unwrap();
    let expected = RelayEventOwner {
        agent: report.agent.clone(),
        session_id: report.session_id.clone(),
        pane_id: report.pane_id.clone(),
        pane_server: report.pane_server.clone(),
    };
    assert_eq!(
        store
            .relay_event_owner(&id, &bound.account_id, &bound.source_id, now.timestamp())
            .unwrap(),
        Some(expected)
    );
    assert_eq!(
        store
            .relay_event_owner(
                &id,
                &configured.account_id,
                &configured.source_id,
                now.timestamp()
            )
            .unwrap(),
        None
    );
    for (account, source) in [
        (&configured.account_id, &bound.source_id),
        (&bound.account_id, &configured.source_id),
    ] {
        assert!(store
            .relay_event_owner(&id, account, source, now.timestamp())
            .unwrap()
            .is_none());
    }
    assert!(store
        .relay_event_owner(
            "not-a-uuid",
            &bound.account_id,
            &bound.source_id,
            now.timestamp()
        )
        .is_err());
    drop(store);
    let resolved = run::run(
        run::RelayCommand::Resolve {
            event_id: id.clone(),
            account_id: bound.account_id.clone(),
            source_id: bound.source_id.clone(),
        },
        directory.path(),
    )
    .unwrap();
    assert_eq!(resolved["sessionId"], report.session_id);
    assert_eq!(resolved["paneId"], report.pane_id.as_deref().unwrap());
    assert!(resolved.get("project").is_none());
    assert!(resolved.get("summary").is_none());
    let mut store = Store::open(directory.path()).unwrap();
    assert!(store
        .relay_event_owner(&id, &bound.account_id, &bound.source_id, now.timestamp())
        .unwrap()
        .is_some());
    assert!(store
        .relay_event_owner(
            &id,
            &bound.account_id,
            &bound.source_id,
            now.timestamp() + TTL_SECONDS
        )
        .unwrap()
        .is_none());
    for (pane, present) in [("other-pane", false), ("private-pane", true)] {
        report.pane_id = Some(pane.into());
        store.ingest(&report, now).unwrap();
        assert_eq!(
            store
                .relay_event_owner(&id, &bound.account_id, &bound.source_id, now.timestamp())
                .unwrap()
                .is_some(),
            present
        );
    }
    store.relay_disable(1).unwrap();
    assert!(store
        .relay_event_owner(&id, &bound.account_id, &bound.source_id, now.timestamp())
        .unwrap()
        .is_none());
}

#[test]
fn event_owner_failure_rolls_back_both_session_and_outbox() {
    let (_directory, mut store) = enabled();
    store.connection.execute_batch("CREATE TRIGGER reject_owner BEFORE INSERT ON relay_event_owner BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(store
        .ingest(&event(SessionState::Working), Utc::now())
        .is_err());
    for table in ["sessions", "relay_outbox", "relay_event_owner"] {
        let count: i64 = store
            .connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
}

#[test]
fn older_database_adds_owner_table_without_inventing_owners_for_old_events() {
    let (directory, mut store) = enabled();
    let bound =
        Configuration::decode(&store::policy(&store.connection).unwrap().config.unwrap()).unwrap();
    let now = Utc::now();
    store.ingest(&event(SessionState::Working), now).unwrap();
    let id: String = store
        .connection
        .query_row("SELECT id FROM relay_outbox", [], |row| row.get(0))
        .unwrap();
    store
        .connection
        .execute_batch("DROP TABLE relay_event_owner")
        .unwrap();
    drop(store);
    let store = Store::open(directory.path()).unwrap();
    assert!(store
        .relay_event_owner(&id, &bound.account_id, &bound.source_id, now.timestamp())
        .unwrap()
        .is_none());
}
