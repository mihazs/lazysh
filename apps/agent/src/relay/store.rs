use super::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

const SCHEMA:&str="
CREATE TABLE IF NOT EXISTS relay_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 revision INTEGER NOT NULL CHECK(revision>=1 AND revision<=9007199254740991),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config TEXT,
 capacity_failures INTEGER NOT NULL CHECK(capacity_failures>=0));
CREATE TABLE IF NOT EXISTS relay_outbox (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, config TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('working','needs_attention','done')),
 created INTEGER NOT NULL, expires INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','sending','recorded','blocked','failed_unknown','expired','expired_unknown','cancelled','cancelled_unknown')),
 attempts INTEGER NOT NULL CHECK(attempts>=0 AND attempts<=3),
 next_attempt INTEGER NOT NULL, may_sent INTEGER NOT NULL CHECK(may_sent IN (0,1)), receipt TEXT);
CREATE INDEX IF NOT EXISTS relay_due ON relay_outbox(state,next_attempt);
";
pub(crate) fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    Ok(())
}
pub(super) fn policy(connection: &Connection) -> Result<Policy> {
    let row = connection
        .query_row(
            "SELECT revision,enabled,config,capacity_failures FROM relay_policy WHERE singleton=1",
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((revision, enabled, config, capacity_failures)) = row else {
        return Ok(Policy {
            revision: 0,
            enabled: false,
            config: None,
            capacity_failures: 0,
        });
    };
    if revision <= 0 || revision > MAX_REVISION as i64 || (enabled && config.is_none()) {
        return Err(invalid());
    }
    if capacity_failures < 0 {
        return Err(invalid());
    }
    if let Some(ref config) = config {
        Configuration::decode(config)?;
    }
    Ok(Policy {
        revision,
        enabled,
        config,
        capacity_failures,
    })
}
pub(super) fn status(connection: &Connection) -> Result<RelayStatus> {
    let policy = policy(connection)?;
    let config = policy
        .config
        .as_deref()
        .map(Configuration::decode)
        .transpose()?;
    let (pending,recorded,unknown,blocked):(i64,i64,i64,i64)=connection.query_row("SELECT coalesce(sum(state IN ('queued','sending')),0),coalesce(sum(state='recorded'),0),coalesce(sum(state IN ('failed_unknown','expired_unknown','cancelled_unknown')),0),coalesce(sum(state='blocked'),0) FROM relay_outbox",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    Ok(RelayStatus {
        schema_version: 1,
        supported: cfg!(unix),
        revision: policy.revision as u64,
        configured: config.is_some(),
        enabled: policy.enabled,
        account_id: config.as_ref().map(|c| c.account_id.clone()),
        source_id: config.as_ref().map(|c| c.source_id.clone()),
        remote_generation: config.as_ref().map(|c| c.remote_generation),
        pending: pending as u64,
        retained_recorded: recorded as u64,
        retained_blocked: blocked as u64,
        retained_unknown: unknown as u64,
        capacity_failures: policy.capacity_failures as u64,
    })
}
pub(super) fn change(
    connection: &mut Connection,
    expected: u64,
    config: Option<Configuration>,
    enabled: bool,
) -> Result<RelayStatus> {
    if expected >= MAX_REVISION {
        return Err(invalid());
    }
    let encoded = config.as_ref().map(Configuration::encode).transpose()?;
    if enabled && encoded.is_none() {
        return Err(invalid());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = policy(&transaction)?;
    if current.revision != expected as i64 {
        return Err(Error::Relay("RelayConfigurationConflict"));
    }
    let revision = (expected + 1) as i64;
    // A revision is the local generation. Old rows keep their original configuration.
    transaction.execute("UPDATE relay_outbox SET state=CASE WHEN may_sent=1 THEN 'cancelled_unknown' ELSE 'cancelled' END WHERE state IN ('queued','sending')",[])?;
    transaction.execute("INSERT INTO relay_policy VALUES(1,?1,?2,?3,?4) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,config=excluded.config",params![revision,enabled,encoded.or(current.config),current.capacity_failures])?;
    trim_terminal(&transaction)?;
    transaction.commit()?;
    status(connection)
}
fn trim_terminal(connection: &Connection) -> Result<()> {
    connection.execute("DELETE FROM relay_outbox WHERE state NOT IN ('queued','sending') AND rowid NOT IN (SELECT rowid FROM relay_outbox WHERE state NOT IN ('queued','sending') ORDER BY rowid DESC LIMIT ?1)",[TERMINAL_LIMIT])?;
    Ok(())
}
pub(crate) fn admit_transition(
    transaction: &Transaction<'_>,
    kind: Kind,
    changed: bool,
    now: i64,
) -> Result<()> {
    if !changed {
        return Ok(());
    }
    let policy = policy(transaction)?;
    if !policy.enabled {
        return Ok(());
    }
    let config = policy.config.ok_or_else(invalid)?;
    let pending: i64 = transaction.query_row(
        "SELECT count(*) FROM relay_outbox WHERE state IN ('queued','sending')",
        [],
        |r| r.get(0),
    )?;
    if pending >= PENDING_LIMIT {
        // Only this known capacity condition is nonfatal. SQL/disk errors roll back ingestion.
        transaction.execute(
            "UPDATE relay_policy SET capacity_failures=capacity_failures+1 WHERE singleton=1",
            [],
        )?;
        return Ok(());
    }
    trim_terminal(transaction)?;
    transaction.execute(
        "INSERT INTO relay_outbox VALUES(?1,?2,?3,?4,?5,?6,'queued',0,0,0,NULL)",
        params![
            uuid::Uuid::new_v4().to_string(),
            policy.revision,
            config,
            kind.as_str(),
            now,
            now + TTL_SECONDS
        ],
    )?;
    Ok(())
}
pub(super) fn claim(connection: &mut Connection, revision: i64, now: i64) -> Result<Option<Job>> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = policy(&transaction)?;
    if !current.enabled || current.revision != revision {
        transaction.commit()?;
        return Ok(None);
    }
    recover(&transaction, revision, now)?;
    let row:Option<(String,String,String,i64)>=transaction.query_row("SELECT id,config,kind,attempts FROM relay_outbox WHERE revision=?1 AND state='queued' AND next_attempt<=?2 AND attempts<?3 ORDER BY rowid LIMIT 1",params![revision,now,RETRY_LIMIT],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((id, config, kind, attempts)) = row else {
        trim_terminal(&transaction)?;
        transaction.commit()?;
        return Ok(None);
    };
    if current.config.as_deref() != Some(config.as_str()) {
        return Err(invalid());
    }
    let config = Configuration::decode(&config)?;
    let kind = match kind.as_str() {
        "working" => Kind::Working,
        "needs_attention" => Kind::NeedsAttention,
        "done" => Kind::Done,
        _ => return Err(invalid()),
    };
    transaction.execute(
        "UPDATE relay_outbox SET state='sending',attempts=attempts+1,may_sent=1 WHERE id=?1",
        [&id],
    )?;
    trim_terminal(&transaction)?;
    transaction.commit()?;
    Ok(Some(Job {
        id,
        revision,
        config,
        kind,
        attempts: attempts + 1,
    }))
}
fn recover(transaction: &Connection, revision: i64, now: i64) -> Result<()> {
    transaction.execute("UPDATE relay_outbox SET state='failed_unknown' WHERE state IN ('queued','sending') AND attempts>=?1",[RETRY_LIMIT])?;
    transaction.execute("UPDATE relay_outbox SET state=CASE WHEN may_sent=1 THEN 'expired_unknown' ELSE 'expired' END WHERE state IN ('queued','sending') AND expires<=?1",[now])?;
    // A lost process may have admitted a POST. Its stable UUID is retained for reconciliation.
    transaction.execute(
        "UPDATE relay_outbox SET state='queued' WHERE state='sending' AND revision=?1",
        [revision],
    )?;
    Ok(())
}

pub(super) fn has_blocked(connection: &Connection, revision: i64) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM relay_outbox WHERE revision=?1 AND state='blocked')",
        [revision],
        |r| r.get(0),
    )?)
}
pub(super) struct Schedule {
    pub maintenance: bool,
    pub next_attempt: Option<i64>,
}
pub(super) fn schedule(connection: &Connection, revision: i64, now: i64) -> Result<Schedule> {
    let (maintenance,next_attempt)=connection.query_row(
        "SELECT coalesce(max(state='sending' OR attempts>=3 OR expires<=?2),0),min(CASE WHEN state='queued' AND attempts<3 AND expires>?2 THEN next_attempt END) FROM relay_outbox WHERE revision=?1 AND state IN ('queued','sending')",
        params![revision,now],|r|Ok((r.get(0)?,r.get(1)?)))?;
    Ok(Schedule {
        maintenance,
        next_attempt,
    })
}
pub(super) fn maintain(connection: &mut Connection, revision: i64, now: i64) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = policy(&transaction)?;
    if current.enabled && current.revision == revision {
        recover(&transaction, revision, now)?;
        trim_terminal(&transaction)?;
    }
    transaction.commit()?;
    Ok(())
}

pub(super) enum Completion<'a> {
    Recorded(&'a str),
    Retry,
    Blocked,
}
pub(super) fn finish(
    connection: &mut Connection,
    job: &Job,
    outcome: Completion<'_>,
    now: i64,
) -> Result<bool> {
    let (state, receipt) = match outcome {
        Completion::Recorded(id) => ("recorded", Some(id)),
        Completion::Retry if job.attempts < RETRY_LIMIT => ("queued", None),
        Completion::Retry => ("failed_unknown", None),
        Completion::Blocked => ("blocked", None),
    };
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed=transaction.execute("UPDATE relay_outbox SET state=?1,next_attempt=?2,receipt=?3 WHERE id=?4 AND revision=?5 AND attempts=?6 AND state='sending'",params![state,now+2,receipt,job.id,job.revision,job.attempts])?;
    trim_terminal(&transaction)?;
    transaction.commit()?;
    Ok(changed == 1)
}
