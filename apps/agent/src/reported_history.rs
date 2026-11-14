//! Opt-in hook-reported source hints, never live-process or input authority.
use super::*;
use rusqlite::Transaction;

const RETENTION_MILLIS: i64 = 7 * 86400 * 1000;

// Additive table in the existing private database; the frozen v1 sessions table
// must remain writable by older positional writers and legacy-schema fixtures.
pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS claude_reported_history (
    session_id TEXT PRIMARY KEY, path TEXT, pane_id TEXT,
    updated_at INTEGER NOT NULL, ambiguous INTEGER NOT NULL CHECK(ambiguous IN (0,1)));
CREATE TABLE IF NOT EXISTS reported_history_references (
    session_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, path TEXT NOT NULL);";

#[derive(Debug)]
pub struct ReportedSource {
    session_id: String,
    path: Option<String>,
    pane_id: Option<String>,
}

impl ReportedSource {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_session_id(&self.session_id)?;
        if self.path.as_deref().is_some_and(|path| !valid_path(path)) {
            return Err(Error::InvalidEvent);
        }
        if self.pane_id.as_ref().is_some_and(|pane| {
            pane.is_empty() || pane.len() > 256 || pane.chars().any(char::is_control)
        }) {
            return Err(Error::InvalidEvent);
        }
        Ok(())
    }
}

fn valid_path(path: &str) -> bool {
    path.len() <= 4096 && Path::new(path).is_absolute() && !path.chars().any(char::is_control)
}

pub fn validate_session_id(id: &str) -> Result<()> {
    text(id, 256)?;
    if id.len() > 1024 || id.chars().any(char::is_control) {
        return Err(Error::InvalidEvent);
    }
    Ok(())
}

/// Claude and Codex both report `session_id` with `transcript_path` in their common hook input.
pub fn read_hook(
    input: impl Read,
    agent: Agent,
    pane: Option<&str>,
) -> Result<(Option<Event>, Option<ReportedSource>)> {
    if !matches!(agent, Agent::Claude | Agent::Codex) {
        return Err(Error::InvalidArgument);
    }
    let payload = read_bounded_json(input, MAX_INPUT)?;
    let event = normalize(&payload, agent, pane)?;
    let top_level = matches!(payload.get("agent_id"), None | Some(Value::Null))
        || payload["agent_id"].as_str() == Some("");
    let source = if top_level
        && matches!(
            payload["hook_event_name"].as_str(),
            Some("SessionStart" | "UserPromptSubmit")
        ) {
        payload["session_id"]
            .as_str()
            .filter(|id| validate_session_id(id).is_ok())
            .map(|id| ReportedSource {
                session_id: id.into(),
                // Invalid metadata must never suppress an otherwise valid lifecycle
                // event, or leave an older conflicting path looking authoritative.
                path: payload["transcript_path"]
                    .as_str()
                    .filter(|path| valid_path(path))
                    .map(str::to_owned),
                pane_id: pane
                    .filter(|pane| {
                        !pane.is_empty() && pane.len() <= 256 && !pane.chars().any(char::is_control)
                    })
                    .map(str::to_owned),
            })
    } else {
        None
    };
    Ok((event, source))
}

pub(crate) fn retain(connection: &Connection, now: DateTime<Utc>) -> Result<()> {
    connection.execute(
        "DELETE FROM claude_reported_history WHERE updated_at < ?1",
        [now.timestamp_millis().saturating_sub(RETENTION_MILLIS)],
    )?;
    connection.execute("DELETE FROM claude_reported_history WHERE rowid NOT IN (SELECT rowid FROM claude_reported_history ORDER BY updated_at DESC,rowid DESC LIMIT 100)", [])?;
    connection.execute("DELETE FROM reported_history_references WHERE session_id NOT IN (SELECT session_id FROM claude_reported_history)", [])?;
    Ok(())
}

pub(crate) fn insert(
    transaction: &Transaction<'_>,
    source: &ReportedSource,
    now: DateTime<Utc>,
) -> Result<()> {
    retain(transaction, now)?;
    // A conflict stays ambiguous for its retained lifetime, even if another
    // event repeats the original path. Never choose a guessed latest source.
    transaction.execute("INSERT INTO claude_reported_history(session_id,path,pane_id,updated_at,ambiguous) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(session_id) DO UPDATE SET path=CASE WHEN ambiguous=0 AND path=excluded.path THEN path ELSE NULL END,pane_id=CASE WHEN ambiguous=0 AND path=excluded.path THEN excluded.pane_id ELSE NULL END,ambiguous=CASE WHEN ambiguous=1 OR path IS NOT excluded.path THEN 1 ELSE 0 END,updated_at=excluded.updated_at", params![source.session_id, source.path, source.pane_id, now.timestamp_millis(), source.path.is_none()])?;
    retain(transaction, now)
}

impl Store {
    /// The reported conversation as an opaque reference instead of its host path. A report keeps its
    /// reference until its path changes, so repeated lookups return the same one.
    pub fn reported_history_reference(&mut self, id: &str, now: DateTime<Utc>) -> Result<Value> {
        let mut response = self.reported_history(id, now)?;
        let Some(path) = response["path"].as_str().map(str::to_owned) else {
            return Ok(response);
        };
        self.connection.execute("INSERT INTO reported_history_references(session_id,token,path) VALUES (?1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET token=excluded.token,path=excluded.path WHERE path<>excluded.path", params![id, uuid::Uuid::new_v4().to_string(), path])?;
        let token: String = self.connection.query_row(
            "SELECT token FROM reported_history_references WHERE session_id=?1",
            [id],
            |row| row.get(0),
        )?;
        let fields = response.as_object_mut().ok_or(Error::InvalidEvent)?;
        fields.remove("path");
        fields.insert("reference".into(), json!(token));
        Ok(response)
    }

    /// The transcript a reference names. It refuses, without touching any file, a reference this store
    /// never issued, one whose report changed, expired or became ambiguous, and one of another agent.
    pub fn reported_reference_path(
        &mut self,
        token: &str,
        agent: transcript::TranscriptAgent,
        now: DateTime<Utc>,
    ) -> Result<PathBuf> {
        let label = match agent {
            transcript::TranscriptAgent::Claude => "Claude Code",
            transcript::TranscriptAgent::Codex => "Codex",
            _ => return Err(Error::InvalidArgument),
        };
        retain(&self.connection, now)?;
        // The agent session must be unique, as the client requires before it binds one.
        let path: Option<String> = self.connection.query_row("SELECT r.path FROM reported_history_references r JOIN claude_reported_history h ON h.session_id=r.session_id AND h.path=r.path AND h.ambiguous=0 WHERE r.token=?1 AND (SELECT count(*) FROM sessions s WHERE s.session_id=r.session_id)=1 AND EXISTS (SELECT 1 FROM sessions s WHERE s.session_id=r.session_id AND s.agent=?2)", params![token, label], |row| row.get(0)).optional()?;
        let path = path.ok_or(Error::InvalidArgument)?;
        if !valid_path(&path) {
            return Err(Error::InvalidEvent);
        }
        Ok(PathBuf::from(path))
    }

    pub fn reported_history(&mut self, id: &str, now: DateTime<Utc>) -> Result<Value> {
        validate_session_id(id)?;
        retain(&self.connection, now)?;
        let row: Option<(Option<String>, Option<String>, i64, bool)> = self.connection.query_row(
            "SELECT path,pane_id,updated_at,ambiguous FROM claude_reported_history WHERE session_id=?1",
            [id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional()?;
        let mut response = json!({"schemaVersion":1,"sessionId":id,"status":"missing"});
        if let Some((path, pane, updated_at, ambiguous)) = row {
            if ambiguous {
                response["status"] = json!("ambiguous");
            } else {
                let source = ReportedSource {
                    session_id: id.into(),
                    path: Some(path.ok_or(Error::InvalidEvent)?),
                    pane_id: pane,
                };
                source.validate()?;
                response["status"] = json!("available");
                response["path"] = json!(source.path.unwrap());
                response["paneId"] = json!(source.pane_id);
                response["reportedAt"] = json!(DateTime::from_timestamp_millis(updated_at)
                    .ok_or(Error::InvalidEvent)?
                    .to_rfc3339_opts(SecondsFormat::Millis, true));
            }
        }
        Ok(response)
    }
}

pub fn claude_config() -> Value {
    let mut config = super::claude_config();
    let hooks = config["hooks"].as_object_mut().unwrap();
    hooks.insert("SessionStart".into(), json!([{"hooks":[{"type":"command","command":"lazysh-agent ingest --agent claude","timeout":5}]}]));
    flag_reported_history(config, "claude")
}

/// The Codex fragment with each ingest command opted in to reported history.
pub fn codex_config() -> Value {
    flag_reported_history(super::hooks::codex_config(), "codex")
}

fn flag_reported_history(mut config: Value, agent: &str) -> Value {
    for rows in config["hooks"].as_object_mut().unwrap().values_mut() {
        rows[0]["hooks"][0]["command"] = json!(format!(
            "lazysh-agent ingest --agent {agent} --reported-history"
        ));
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(id: &str, path: Value) -> Value {
        json!({"hook_event_name":"UserPromptSubmit","session_id":id,"transcript_path":path,"cwd":"/owned","prompt":"never stored"})
    }
    fn ingest(store: &mut Store, payload: &Value, at: DateTime<Utc>) {
        let (event, source) = read_hook(
            serde_json::to_vec(payload).unwrap().as_slice(),
            Agent::Claude,
            Some("%7"),
        )
        .unwrap();
        store
            .ingest_with_reported_history(event.as_ref(), source.as_ref(), at)
            .unwrap();
    }

    #[test]
    fn exact_reported_source_is_opt_in_and_does_not_widen_status_or_relay_data() {
        let directory = tempfile::tempdir().unwrap();
        let now = Utc::now();
        let mut store = Store::open(directory.path()).unwrap();
        let path = directory.path().join("history' 世界$(literal).jsonl ");
        let payload = hook("opaque' id", json!(path));
        let legacy = normalize(&payload, Agent::Claude, Some("%7"))
            .unwrap()
            .unwrap();
        store.ingest(&legacy, now).unwrap();
        assert_eq!(
            store.reported_history("opaque' id", now).unwrap()["status"],
            "missing"
        );
        ingest(&mut store, &payload, now);
        let source = store.reported_history("opaque' id", now).unwrap();
        assert_eq!(source["path"], path.to_str().unwrap());
        assert_eq!(source["paneId"], "%7");
        assert_eq!(source["sessionId"], "opaque' id");
        assert_eq!(source["status"], "available");
        let snapshot = serde_json::to_value(store.snapshot(100, now).unwrap()).unwrap();
        let event = &snapshot["sessions"][0];
        assert_eq!(event["eventCount"], 2);
        assert_eq!(event["summary"], "Working on your prompt");
        let text = snapshot.to_string();
        assert!(
            !text.contains("transcript")
                && !text.contains("literal")
                && !text.contains("never stored")
        );
        let queued: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM relay_outbox", [], |row| row.get(0))
            .unwrap();
        assert_eq!(queued, 0);
    }

    #[test]
    fn a_reference_lives_and_dies_with_the_report_it_was_issued_for() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let now = Utc::now();
        let claude = transcript::TranscriptAgent::Claude;
        ingest(
            &mut store,
            &hook("owned", json!(directory.path().join("a.jsonl"))),
            now,
        );
        let issued = store.reported_history_reference("owned", now).unwrap();
        assert!(issued.get("path").is_none());
        let token = issued["reference"].as_str().unwrap().to_owned();
        assert_eq!(
            store.reported_history_reference("owned", now).unwrap(),
            issued
        );
        assert_eq!(
            store.reported_reference_path(&token, claude, now).unwrap(),
            directory.path().join("a.jsonl")
        );
        // Another agent, an unknown token and an unreported session get nothing.
        for (token, agent) in [
            (token.as_str(), transcript::TranscriptAgent::Codex),
            (token.as_str(), transcript::TranscriptAgent::Opencode),
            ("not-issued", claude),
        ] {
            assert!(store.reported_reference_path(token, agent, now).is_err());
        }
        let missing = store.reported_history_reference("other", now).unwrap();
        assert_eq!(missing["status"], "missing");
        assert!(missing.get("reference").is_none());
        // The report ages out, and so does its reference; a new report gets a new reference.
        let later = now + chrono::Duration::days(8);
        assert!(store
            .reported_reference_path(&token, claude, later)
            .is_err());
        ingest(
            &mut store,
            &hook("owned", json!(directory.path().join("b.jsonl"))),
            later,
        );
        let renewed = store.reported_history_reference("owned", later).unwrap();
        assert_ne!(renewed["reference"], json!(token));
        assert!(store
            .reported_reference_path(&token, claude, later)
            .is_err());
        let count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM reported_history_references",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn malformed_or_unsupported_metadata_never_discards_valid_lifecycle_events() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let now = Utc::now();
        let invalid = [
            Value::Null,
            json!("relative.jsonl"),
            json!("/owned/\ncontrol"),
            json!(format!("/{}", "x".repeat(4096))),
            json!({"not":"a path"}),
        ];
        for (index, path) in invalid.into_iter().enumerate() {
            let id = format!("session-{index}");
            ingest(&mut store, &hook(&id, path), now);
            let result = store.reported_history(&id, now).unwrap();
            assert_eq!(result["status"], "ambiguous");
            assert!(result.get("path").is_none());
        }
        let mut subordinate = hook(
            "subordinate",
            json!(directory.path().join("subagent.jsonl")),
        );
        subordinate["agent_id"] = json!("child");
        ingest(&mut store, &subordinate, now);
        assert_eq!(
            store.reported_history("subordinate", now).unwrap()["status"],
            "missing"
        );
        assert_eq!(store.snapshot(100, now).unwrap().sessions.len(), 6);
        let leaked: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM claude_reported_history WHERE path IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leaked, 0);
    }

    #[test]
    fn conflicting_paths_stay_unavailable_until_retention_expires() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let now = Utc::now();
        let first = hook("same", json!(directory.path().join("first.jsonl")));
        let second = hook("same", json!(directory.path().join("second.jsonl")));
        ingest(&mut store, &first, now);
        ingest(&mut store, &first, now);
        assert_eq!(
            store.reported_history("same", now).unwrap()["status"],
            "available"
        );
        ingest(&mut store, &second, now);
        ingest(&mut store, &first, now);
        let result = store.reported_history("same", now).unwrap();
        assert_eq!(
            result,
            json!({"schemaVersion":1,"sessionId":"same","status":"ambiguous"})
        );
        let later = now + chrono::Duration::days(8);
        ingest(&mut store, &second, later);
        assert_eq!(
            store.reported_history("same", later).unwrap()["path"],
            second["transcript_path"]
        );
    }

    #[test]
    fn association_count_age_and_no_event_session_start_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let now = Utc::now();
        for index in 0..101 {
            let mut payload = hook(
                &format!("s-{index}"),
                json!(directory.path().join(format!("{index}.jsonl"))),
            );
            payload["hook_event_name"] = json!("SessionStart");
            ingest(
                &mut store,
                &payload,
                now + chrono::Duration::milliseconds(index),
            );
        }
        assert!(store.snapshot(100, now).unwrap().sessions.is_empty());
        assert_eq!(
            store.reported_history("s-0", now).unwrap()["status"],
            "missing"
        );
        assert_eq!(
            store.reported_history("s-100", now).unwrap()["status"],
            "available"
        );
        assert_eq!(
            store
                .reported_history("s-100", now + chrono::Duration::days(8))
                .unwrap()["status"],
            "missing"
        );
    }

    #[test]
    fn new_store_and_legacy_positional_writers_coexist_in_both_directions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite3");
        let store = Store::open(directory.path()).unwrap();
        store
            .connection
            .execute_batch("DROP TABLE claude_reported_history;")
            .unwrap();
        drop(store);
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(storage_schema::V1_SESSIONS).unwrap();
        let now = Utc::now();
        let write = |connection: &Connection, id: &str| {
            connection.execute("INSERT INTO sessions VALUES ('Claude Code',?1,'/owned','working','legacy',NULL,?2,1)",params![id,now.timestamp_millis() as f64/1000.0]).unwrap();
        };
        write(&legacy, "before-new");
        drop(legacy);
        let mut newer = Store::open(directory.path()).unwrap();
        assert_eq!(
            newer.snapshot(100, now).unwrap().sessions[0]
                .event
                .session_id,
            "before-new"
        );
        drop(newer);
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(storage_schema::V1_SESSIONS).unwrap();
        write(&legacy, "after-new");
        drop(legacy);
        assert_eq!(
            Store::open(directory.path())
                .unwrap()
                .snapshot(100, now)
                .unwrap()
                .sessions
                .len(),
            2
        );
    }
}
