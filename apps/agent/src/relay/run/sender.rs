use super::*;
use tokio::{sync::watch, time::Instant};

const POLICY_INTERVAL: Duration = Duration::from_secs(1);
const FAILURE_COOLDOWN: Duration = Duration::from_secs(2);

pub(super) fn signal() -> Result<watch::Receiver<bool>> {
    let (cancel, cancelled) = watch::channel(false);
    ctrlc::set_handler(move || {
        cancel.send_replace(true);
    })
    .map_err(|_| Error::Relay("RelayCancellationUnavailable"))?;
    Ok(cancelled)
}
pub(super) fn capture(config: &Configuration) -> Result<CapturedPublisher> {
    let expected: PublisherBinding =
        serde_json::from_str(&config.binding).map_err(|_| invalid())?;
    let captured = CapturedPublisher::load(&config.capability_file, config.ca_file.as_deref())
        .map_err(network_error)?;
    if captured.binding() != &expected {
        return Err(Error::Relay("RelayBindingMismatch"));
    }
    Ok(captured)
}
pub(super) struct DispatchResult {
    pub recorded: bool,
    pub retry_pending: bool,
    pub permanent: Option<BoundError>,
    pub failure: Option<BoundError>,
    pub stopped: Option<&'static str>,
}
enum Outcome {
    Response(std::result::Result<lazysh_notification_client::BoundReceipt, BoundError>),
    Stopped(&'static str),
}
/// Own the same request future through every policy tick; finalize under the outer drain lock.
pub(super) async fn dispatch(
    store: &mut Store,
    job: &Job,
    publisher: &CapturedPublisher,
    cancelled: &mut watch::Receiver<bool>,
    deadline: Option<Instant>,
    monitor_policy: bool,
) -> Result<DispatchResult> {
    let binding: PublisherBinding =
        serde_json::from_str(&job.config.binding).map_err(|_| invalid())?;
    let event = Event {
        event_id: uuid::Uuid::parse_str(&job.id).map_err(|_| invalid())?,
        kind: job.kind,
    };
    let outcome = {
        let request = publisher.publish_bound(event, &binding, job.config.remote_generation);
        tokio::pin!(request);
        let deadline = async {
            if let Some(deadline) = deadline {
                tokio::time::sleep_until(deadline).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::pin!(deadline);
        let mut ticks = tokio::time::interval_at(Instant::now() + POLICY_INTERVAL, POLICY_INTERVAL);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        if *cancelled.borrow() {
            Outcome::Stopped("cancelled")
        } else {
            loop {
                tokio::select! {biased;
                    _=cancelled.changed()=>break Outcome::Stopped("cancelled"),
                    _=&mut deadline=>break Outcome::Stopped("deadline"),
                    _=ticks.tick(),if monitor_policy=>{
                        if !current(store,job.revision)? {break Outcome::Stopped("configuration_changed");}
                    },
                    result=&mut request=>break Outcome::Response(result),
                }
            }
        }
    };
    let now = chrono::Utc::now().timestamp();
    let mut result = DispatchResult {
        recorded: false,
        retry_pending: false,
        permanent: None,
        failure: None,
        stopped: None,
    };
    let changed = match outcome {
        Outcome::Response(Ok(receipt)) => {
            let changed = store::finish(
                &mut store.connection,
                job,
                store::Completion::Recorded(&receipt.receipt.receipt_id),
                now,
            )?;
            result.recorded = changed;
            changed
        }
        Outcome::Response(Err(error)) => {
            result.failure = Some(error);
            let changed = store::finish(
                &mut store.connection,
                job,
                if error.retryable() {
                    store::Completion::Retry
                } else {
                    store::Completion::Blocked
                },
                now,
            )?;
            if changed {
                result.retry_pending = error.retryable() && job.attempts < RETRY_LIMIT;
                if !error.retryable() {
                    result.permanent = Some(error);
                }
            }
            changed
        }
        Outcome::Stopped(reason) => {
            result.stopped = Some(reason);
            let changed = store::finish(&mut store.connection, job, store::Completion::Retry, now)?;
            result.retry_pending = changed && job.attempts < RETRY_LIMIT;
            changed
        }
    };
    if !changed {
        result.stopped = Some("configuration_changed");
    }
    Ok(result)
}
fn current(store: &Store, revision: i64) -> Result<bool> {
    let policy = store::policy(&store.connection)?;
    Ok(policy.enabled && policy.revision == revision)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkerReport {
    schema_version: u8,
    revision: u64,
    attempted: u64,
    relay_recorded: u64,
    blocked: u64,
    stopped: &'static str,
}
fn add(counter: &mut u64) -> Result<()> {
    *counter = counter
        .checked_add(1)
        .ok_or(Error::Relay("RelayCounterExhausted"))?;
    Ok(())
}
pub(super) fn worker(directory: &Path, expected_revision: u64) -> Result<WorkerReport> {
    supported()?;
    if expected_revision > MAX_REVISION {
        return Err(invalid());
    }
    let mut store = Store::open(directory)?;
    let policy = store::policy(&store.connection)?;
    if policy.revision != expected_revision as i64 {
        return Err(Error::Relay("RelayConfigurationConflict"));
    }
    let report = WorkerReport {
        schema_version: 1,
        revision: expected_revision,
        attempted: 0,
        relay_recorded: 0,
        blocked: 0,
        stopped: "disabled",
    };
    if !policy.enabled {
        return Ok(report);
    }
    // Installing before the lock makes observed ownership cancellation-ready even during startup.
    let mut cancelled = signal()?;
    let _drain = drain_lock(directory)?;
    if !current(&store, policy.revision)? {
        return Ok(WorkerReport {
            stopped: "configuration_changed",
            ..report
        });
    }
    if store::has_blocked(&store.connection, policy.revision)? {
        return Err(Error::Relay("RelayOperatorActionRequired"));
    }
    let config = Configuration::decode(policy.config.as_deref().ok_or_else(invalid)?)?;
    let runtime = runtime()?;
    let result = runtime.block_on(send_loop(
        &mut store,
        policy.revision,
        &config,
        &mut cancelled,
        report,
    ));
    runtime.shutdown_timeout(Duration::from_secs(1));
    result
}
async fn send_loop(
    store: &mut Store,
    revision: i64,
    config: &Configuration,
    cancelled: &mut watch::Receiver<bool>,
    mut report: WorkerReport,
) -> Result<WorkerReport> {
    // A restart always waits, without guessing which historical next_attempt was a failure.
    let mut cooldown = Instant::now() + FAILURE_COOLDOWN;
    loop {
        if *cancelled.borrow() {
            report.stopped = "cancelled";
            break;
        }
        if !current(store, revision)? {
            report.stopped = "configuration_changed";
            break;
        }
        let now = chrono::Utc::now().timestamp();
        let mut schedule = store::schedule(&store.connection, revision, now)?;
        if schedule.maintenance {
            store::maintain(&mut store.connection, revision, now)?;
            schedule = store::schedule(&store.connection, revision, now)?;
        }
        if Instant::now() >= cooldown && schedule.next_attempt.is_some_and(|due| due <= now) {
            // No idle secret/TLS work. This exact capture authorizes and sends the next claim.
            let publisher = capture(config)?;
            if *cancelled.borrow() {
                report.stopped = "cancelled";
                break;
            }
            let Some(job) = store::claim(
                &mut store.connection,
                revision,
                chrono::Utc::now().timestamp(),
            )?
            else {
                continue;
            };
            add(&mut report.attempted)?;
            let result = dispatch(store, &job, &publisher, cancelled, None, true).await?;
            if result.recorded {
                add(&mut report.relay_recorded)?;
            }
            if result.permanent.is_some() {
                add(&mut report.blocked)?;
            }
            if let Some(reason) = result.stopped {
                report.stopped = reason;
                break;
            }
            if let Some(error) = result.permanent {
                return Err(network_error(error));
            }
            if result.failure.is_some() {
                cooldown = Instant::now() + FAILURE_COOLDOWN;
            }
            continue;
        }
        tokio::select! {biased;
            _=cancelled.changed()=>{report.stopped="cancelled";break;},
            _=tokio::time::sleep(POLICY_INTERVAL)=>{},
        }
    }
    Ok(report)
}
