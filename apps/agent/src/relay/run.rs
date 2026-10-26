use super::*;
use clap::Subcommand;
use lazysh_notification_client::{
    client::{BoundError, CapturedPublisher, PublisherBinding},
    Event,
};
use std::{
    fs::File,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Subcommand)]
pub enum RelayCommand {
    /// Show only local policy/counts; never probes a remote server.
    Status,
    /// Verify and pin a private source binding. Queueing stays off unless --enable is explicit.
    Configure {
        #[arg(long)]
        expected_revision: u64,
        #[arg(long)]
        capability_file: PathBuf,
        #[arg(long)]
        relay_ca_file: Option<PathBuf>,
        #[arg(long)]
        enable: bool,
    },
    /// Cancel local pending work; this cannot recall already-admitted remote effects.
    Disable {
        #[arg(long)]
        expected_revision: u64,
    },
    /// Send unattended in this foreground process, pinned to one explicitly selected revision.
    Run {
        #[arg(long)]
        expected_revision: u64,
    },
    /// Drain only this invocation's original local revision under a bounded dispatch deadline.
    Flush {
        #[arg(long,default_value_t=8,value_parser=clap::value_parser!(u8).range(1..=8))]
        limit: u8,
        #[arg(long,default_value_t=30,value_parser=clap::value_parser!(u8).range(1..=30))]
        deadline_seconds: u8,
    },
}
fn encode(value: impl Serialize) -> Result<serde_json::Value> {
    serde_json::to_value(value).map_err(|_| invalid())
}
pub fn run(command: RelayCommand, directory: &Path) -> Result<serde_json::Value> {
    match command {
        RelayCommand::Run { expected_revision } => encode(worker(directory, expected_revision)?),
        RelayCommand::Status => encode(Store::open(directory)?.relay_status()?),
        RelayCommand::Disable { expected_revision } => {
            encode(Store::open(directory)?.relay_disable(expected_revision)?)
        }
        RelayCommand::Configure {
            expected_revision,
            capability_file,
            relay_ca_file,
            enable,
        } => encode(configure(
            directory,
            expected_revision,
            &capability_file,
            relay_ca_file.as_deref(),
            enable,
        )?),
        RelayCommand::Flush {
            limit,
            deadline_seconds,
        } => encode(flush(directory, limit, deadline_seconds)?),
    }
}
mod sender;
use sender::{capture, dispatch, signal, worker};

fn supported() -> Result<()> {
    if cfg!(unix) {
        Ok(())
    } else {
        Err(Error::Relay("RelayUnsupportedHost"))
    }
}
fn absolute_file(path: &Path) -> Result<PathBuf> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = lazysh_common::storage_namespace::resolve(parent)?;
    lazysh_common::service_secrets::private(&std::fs::metadata(&parent)?, true)
        .map_err(|_| Error::Relay("RelayPrivateDirectoryRequired"))?;
    let filename = path.file_name().ok_or_else(invalid)?;
    Ok(parent.join(filename))
}
fn network_error(error: BoundError) -> Error {
    Error::Relay(match error {
        BoundError::Binding => "RelayBindingMismatch",
        BoundError::Unsupported => "RelayBoundProtocolUnsupported",
        BoundError::Unauthorized => "RelayUnauthorized",
        BoundError::TargetChanged => "RelayTargetChanged",
        BoundError::Conflict => "RelayIdentityConflict",
        BoundError::Disabled => "RelayDestinationDisabled",
        BoundError::Capacity => "RelayCapacity",
        BoundError::Unavailable => "RelayUnavailable",
        BoundError::InvalidResponse => "RelayInvalidResponse",
    })
}
fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(Error::Io)
}
fn configure(
    directory: &Path,
    expected: u64,
    capability_file: &Path,
    ca_file: Option<&Path>,
    enabled: bool,
) -> Result<RelayStatus> {
    supported()?;
    if expected >= MAX_REVISION {
        return Err(invalid());
    }
    let mut store = Store::open(directory)?;
    if store::policy(&store.connection)?.revision != expected as i64 {
        return Err(Error::Relay("RelayConfigurationConflict"));
    }
    let capability_file = absolute_file(capability_file)?;
    let ca_file = ca_file.map(absolute_file).transpose()?;
    let runtime = runtime()?;
    let captured = runtime.block_on(async {
        let publisher =
            CapturedPublisher::load(&capability_file, ca_file.as_deref()).map_err(network_error)?;
        let status = publisher.bound_status().await.map_err(network_error)?;
        if enabled && !status.enabled {
            return Err(Error::Relay("RelayDestinationDisabled"));
        }
        let binding = publisher.binding();
        let config = Configuration {
            schema_version: 1,
            capability_file,
            ca_file,
            binding: serde_json::to_string(binding).map_err(|_| invalid())?,
            account_id: binding.account_id.to_string(),
            source_id: binding.source_id.to_string(),
            remote_generation: status.generation,
        };
        config.validate()?;
        Ok(config)
    });
    runtime.shutdown_timeout(Duration::from_secs(1));
    store::change(&mut store.connection, expected, Some(captured?), enabled)
}
struct DrainLock(File);
impl Drop for DrainLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
fn drain_lock(directory: &Path) -> Result<DrainLock> {
    let directory = lazysh_common::storage_namespace::resolve(directory)?;
    let file = lazysh_common::service_secrets::file(&directory.join("relay-publisher.lock"), true)
        .map_err(|_| Error::Relay("RelayDrainLockUnsafe"))?;
    file.try_lock()
        .map_err(|_| Error::Relay("RelayDrainBusy"))?;
    Ok(DrainLock(file))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FlushReport {
    schema_version: u8,
    revision: u64,
    attempted: u8,
    relay_recorded: u8,
    retry_pending: u8,
    blocked: u8,
    last_failure: Option<&'static str>,
    stopped: &'static str,
}
fn flush(directory: &Path, limit: u8, deadline_seconds: u8) -> Result<FlushReport> {
    supported()?;
    if !(1..=8).contains(&limit) || !(1..=30).contains(&deadline_seconds) {
        return Err(invalid());
    }
    let mut store = Store::open(directory)?;
    let policy = store::policy(&store.connection)?;
    let mut report = FlushReport {
        schema_version: 1,
        revision: policy.revision as u64,
        attempted: 0,
        relay_recorded: 0,
        retry_pending: 0,
        blocked: 0,
        last_failure: None,
        stopped: "limit",
    };
    if !policy.enabled {
        report.stopped = "disabled";
        return Ok(report);
    }
    let _drain = drain_lock(directory)?;
    let current = store::policy(&store.connection)?;
    if current.revision != policy.revision || !current.enabled {
        report.stopped = "configuration_changed";
        return Ok(report);
    }
    let config = Configuration::decode(current.config.as_deref().ok_or_else(invalid)?)?;
    let mut cancelled = signal()?;
    let runtime = runtime()?;
    let result = runtime.block_on(async {
        let publisher = capture(&config)?;
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(u64::from(deadline_seconds));
        for _ in 0..limit {
            if *cancelled.borrow() {
                report.stopped = "cancelled";
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                report.stopped = "deadline";
                break;
            }
            let Some(job) = store::claim(
                &mut store.connection,
                policy.revision,
                chrono::Utc::now().timestamp(),
            )?
            else {
                report.stopped = if store::policy(&store.connection)?.revision != policy.revision {
                    "configuration_changed"
                } else {
                    "drained"
                };
                break;
            };
            report.attempted += 1;
            let result = dispatch(
                &mut store,
                &job,
                &publisher,
                &mut cancelled,
                Some(deadline),
                false,
            )
            .await?;
            report.relay_recorded += u8::from(result.recorded);
            report.retry_pending += u8::from(result.retry_pending);
            report.blocked += u8::from(result.permanent.is_some());
            if let Some(error) = result.failure {
                report.last_failure = Some(network_error(error).class());
            }
            if let Some(reason) = result.stopped {
                report.stopped = reason;
                break;
            }
        }
        Ok(report)
    });
    runtime.shutdown_timeout(Duration::from_secs(1));
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    #[test]
    fn separate_drain_lock_is_private_persistent_and_never_unlinked() {
        let directory = tempfile::tempdir().unwrap();
        let _store = Store::open(directory.path()).unwrap();
        let first = drain_lock(directory.path()).unwrap();
        let path = directory.path().join("relay-publisher.lock");
        let metadata = std::fs::metadata(&path).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o600);
        assert_eq!(metadata.nlink(), 1);
        assert!(drain_lock(directory.path()).is_err());
        drop(first);
        let _next = drain_lock(directory.path()).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().ino(), metadata.ino());
    }
}
