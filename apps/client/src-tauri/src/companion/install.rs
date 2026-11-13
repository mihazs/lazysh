use super::*;
use tokio::sync::{watch, OwnedSemaphorePermit};
mod host;
pub(crate) use host::Checked;
/// Who downloads the companion: the host (the default) or, as the labelled offline fallback, this device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Host,
    Device,
    Rollback,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    version: String,
    sha256: String,
    bytes: u64,
}
#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
enum Existing {
    Missing,
    Present { sha256: String, bytes: u64 },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    schema_version: u8,
    supported: bool,
    source: Identity,
    destination: String,
    existing: Existing,
    plan_sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Outcome {
    schema_version: u8,
    status: String,
    committed: bool,
    plan: Plan,
}
struct Flight {
    _permit: OwnedSemaphorePermit,
}
struct Operation {
    route: Route,
    session: Arc<Session>,
    lease: AccessLease,
    progress: Channel<Progress>,
    flight: Arc<Flight>,
    stop: watch::Sender<bool>,
    deadline: tokio::time::Instant,
}
impl Route {
    fn seconds(self) -> u64 {
        match self {
            Route::Host | Route::Rollback => host::OPERATION_SECONDS,
            Route::Device => 240,
        }
    }
}
impl Operation {
    /// One operation per session at a time: a second one is refused while the first, or its late
    /// peer confirmation, still owns the session's permit.
    fn start(
        route: Route,
        session: Arc<Session>,
        lease: &AccessLease,
        progress: Channel<Progress>,
        seconds: u64,
    ) -> Result<Self> {
        let permit = session
            .companion_install
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                error(
                    "companion_install_busy",
                    "Companion installation is already running for this session",
                )
            })?;
        let (stop, _) = watch::channel(false);
        Ok(Self {
            route,
            session,
            lease: lease.clone(),
            progress,
            flight: Arc::new(Flight { _permit: permit }),
            stop,
            deadline: tokio::time::Instant::now() + Duration::from_secs(seconds),
        })
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}
#[derive(Default)]
struct Work {
    staging: Option<transfer::Staging>,
    possible_commit: Option<(String, String)>,
    checking_installed: bool,
    phase: Option<Stage>,
    detail: Option<&'static str>,
}
impl Operation {
    fn work_stage(&self, phase: &mut Option<Stage>, stage: Stage) {
        *phase = Some(stage);
        self.stage(stage);
    }
    fn stage(&self, stage: Stage) {
        if self.lease.check().is_ok() && !*self.session.cancel.borrow() {
            let _ = self.progress.send(Progress::new(stage));
        }
    }
    async fn active<T>(&self, future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        self.lease.check()?;
        let mut disconnected = self.session.cancel.subscribe();
        if *disconnected.borrow() {
            return Err(error("disconnected", "Session closed"));
        }
        tokio::select! {biased;
            _=self.lease.cancelled()=>Err(error("app_locked","App access changed")),
            _=disconnected.changed()=>Err(error("disconnected","Session closed")),
            result=tokio::time::timeout_at(self.deadline,future)=>result.map_err(|_|error("companion_install_timeout","Companion installation timed out"))?,
        }
    }
    async fn command(&self, command: String) -> Result<String> {
        ssh::exec_bounded(
            &self.session,
            command,
            &self.lease,
            Duration::from_secs(15),
            16_384,
            Some(self.flight.clone()),
        )
        .await
    }
    /// The positively identified Unix host both routes install on; anything else is unsupported.
    async fn detect(&self, work: &mut Work) -> Result<resolve::Unix> {
        self.work_stage(&mut work.phase, Stage::Detecting);
        resolve::detect(&self.session, &self.lease)
            .await?
            .ok_or_else(|| {
                error(
                    "companion_install_unsupported",
                    "Installation requires a positively identified Linux or macOS SSH shell",
                )
            })
    }
    /// The host and the verified release for it: the metadata is all either route asks the publisher for first.
    async fn resolve(
        &self,
        work: &mut Work,
        publisher: &release::Publisher,
    ) -> Result<(resolve::Unix, release::Selection)> {
        let unix = self.detect(work).await?;
        self.work_stage(&mut work.phase, Stage::CheckingRelease);
        let selection = publisher.select(&unix.target()).await?;
        Ok((unix, selection))
    }
    async fn perform(&self, work: &mut Work, publisher: &release::Publisher) -> Result<Installed> {
        match self.route {
            Route::Host => self.perform_host(work, publisher).await,
            Route::Device => self.perform_device(work, publisher).await,
            Route::Rollback => self.perform_rollback(work).await,
        }
    }
    async fn perform_device(
        &self,
        work: &mut Work,
        publisher: &release::Publisher,
    ) -> Result<Installed> {
        let (unix, selection) = self.resolve(work, publisher).await?;
        self.work_stage(&mut work.phase, Stage::Downloading);
        let bytes = publisher.download(&selection).await?;
        self.work_stage(&mut work.phase, Stage::Uploading);
        let raw = ssh::installer_sftp(
            &self.session,
            &self.lease,
            self.stop.subscribe(),
            self.flight.clone(),
        )
        .await?;
        work.staging = Some(transfer::Staging::new(raw, &unix, &selection));
        let staging = work.staging.as_mut().unwrap();
        staging.upload(&unix.home, &bytes).await?;
        self.work_stage(&mut work.phase, Stage::Verifying);
        staging.verify(&staging.path, 0o600).await?;
        staging.executable().await?;
        let plan: Plan = serde_json::from_str(
            &self
                .command(format!(
                    "{} installation inspect",
                    ssh::quote(&staging.path)
                ))
                .await?,
        )
        .map_err(|_| invalid())?;
        validate_plan(&plan, &selection, &unix.managed())?;
        let existing=match &plan.existing {
            Existing::Present {..}=>self.command(format!("{} --version",ssh::quote(&plan.destination))).await?,
            Existing::Missing=>match self.command("if command -v lazysh-agent >/dev/null 2>&1; then lazysh-agent --version; else printf 'lazysh-missing\\n'; fi".into()).await {
                Ok(v)=>v,Err(e) if e.kind()=="remote_command_failed"=>String::new(),Err(e)=>return Err(e),
            },
        };
        reject_newer(&existing, &selection.version)?;
        publisher.recheck(&selection).await?;
        self.work_stage(&mut work.phase, Stage::Installing);
        // Dispatch may reach the peer even if request acknowledgement/reply is lost.
        work.possible_commit = Some((selection.version.clone(), plan.destination.clone()));
        let output = self
            .command(format!(
                "{} installation install --expected-plan {}",
                ssh::quote(&staging.path),
                plan.plan_sha256
            ))
            .await?;
        let outcome: Outcome = serde_json::from_str(&output).map_err(|_| invalid())?;
        validate_plan(&outcome.plan, &selection, &plan.destination)?;
        if outcome.schema_version != 1
            || !matches!(
                (outcome.status.as_str(), outcome.committed),
                ("installed", true) | ("reused", false) | ("committedDurabilityUnknown", true)
            )
        {
            return Err(invalid());
        }
        if !matches!(&outcome.plan.existing,Existing::Present {sha256,bytes} if sha256==&selection.digest && *bytes==selection.bytes)
        {
            return Err(invalid());
        }
        if outcome.status == "committedDurabilityUnknown" {
            return Ok(result(
                "uncertain",
                &selection.version,
                &plan.destination,
                Some("committedDurabilityUnknown"),
            ));
        }
        work.checking_installed = true;
        self.work_stage(&mut work.phase, Stage::CheckingInstalled);
        staging.verify(&plan.destination, 0o700).await?;
        let version = self
            .command(format!("{} --version", ssh::quote(&plan.destination)))
            .await?;
        if version.trim() != format!("lazysh-agent {}", selection.version) {
            return Err(invalid());
        }
        Ok(result(
            if outcome.status == "reused" {
                "reused"
            } else {
                "installed"
            },
            &selection.version,
            &plan.destination,
            None,
        ))
    }
}
fn invalid() -> SshError {
    error(
        "companion_installer_invalid",
        "Companion installer capability or installed identity is invalid",
    )
}
fn validate_plan(plan: &Plan, selection: &release::Selection, destination: &str) -> Result<()> {
    if plan.schema_version != 1
        || !plan.supported
        || !lazysh_common::valid_sha256(&plan.plan_sha256)
        || !resolve::path(&plan.destination)
        || plan.destination != destination
        || plan.source.version != selection.version
        || plan.source.sha256 != selection.digest
        || plan.source.bytes != selection.bytes
    {
        return Err(invalid());
    }
    if let Existing::Present { sha256, bytes } = &plan.existing {
        if !lazysh_common::valid_sha256(sha256) || *bytes == 0 || *bytes > release::MAX_BINARY {
            return Err(invalid());
        }
    }
    Ok(())
}
fn reject_newer(existing: &str, selected: &str) -> Result<()> {
    if let Some(current) = existing
        .trim()
        .strip_prefix("lazysh-agent ")
        .and_then(release::version)
    {
        if Some(current) > release::version(selected) {
            return Err(error(
                "companion_newer_installed",
                "A newer companion already exists; installation will not downgrade it",
            ));
        }
    }
    Ok(())
}
fn result(
    status: &'static str,
    version: &str,
    path: &str,
    reason: Option<&'static str>,
) -> Installed {
    Installed {
        schema_version: 1,
        status,
        version: version.into(),
        path: path.into(),
        reason,
        cleanup: "complete",
        cleanup_failure: None,
    }
}
pub(super) async fn run(
    session: Arc<Session>,
    lease: &AccessLease,
    progress: Channel<Progress>,
    route: Route,
) -> std::result::Result<Installed, InstallFailure> {
    run_with(session, lease, progress, &release::Publisher::new()?, route).await
}
pub(super) async fn run_with(
    session: Arc<Session>,
    lease: &AccessLease,
    progress: Channel<Progress>,
    publisher: &release::Publisher,
    route: Route,
) -> std::result::Result<Installed, InstallFailure> {
    let op = Operation::start(route, session, lease, progress, route.seconds())?;
    let mut work = Work::default();
    let outcome = op
        .active(op.perform(&mut work, publisher))
        .await
        .map_err(|error| InstallFailure {
            error,
            phase: work.phase,
            detail: work.detail,
        });
    // Only the device route stages files on the host; the host route cleans up in its own script.
    if work.staging.is_some() {
        op.stage(Stage::CleaningUp);
    }
    let cleanup = if let Some(staging) = &mut work.staging {
        if op.lease.check().is_ok() && !*op.session.cancel.borrow() {
            match tokio::time::timeout(Duration::from_secs(5), staging.cleanup()).await {
                Ok(result) => result,
                Err(_) => Err(staging.cleanup_timeout()),
            }
        } else {
            Err(transfer::CleanupFailure {
                stage: transfer::CleanupStage::Admission,
                reason: transfer::CleanupReason::Disconnected,
            })
        }
    } else {
        Ok(())
    };
    let cleanup_failure = cleanup.err();
    op.lease.check().map_err(SshError::from)?;
    match outcome {
        Ok(mut installed) => {
            installed.cleanup = if cleanup_failure.is_none() {
                "complete"
            } else {
                "residue"
            };
            installed.cleanup_failure = cleanup_failure;
            Ok(installed)
        }
        Err(error) => match work.possible_commit {
            Some((version, path)) => {
                let mut installed = result(
                    "uncertain",
                    &version,
                    &path,
                    Some(if work.checking_installed {
                        "verificationUnavailable"
                    } else {
                        "commitResponseLost"
                    }),
                );
                installed.cleanup = if cleanup_failure.is_none() {
                    "complete"
                } else {
                    "residue"
                };
                installed.cleanup_failure = cleanup_failure;
                Ok(installed)
            }
            None => Err(error),
        },
    }
}
/// Reads, without changing anything, what is installed on the host and how it compares with the latest release.
pub(super) async fn check(
    session: Arc<Session>,
    lease: &AccessLease,
    publisher: &release::Publisher,
) -> Result<host::Checked> {
    let op = Operation::start(Route::Host, session, lease, Channel::new(|_| Ok(())), 60)?;
    op.active(op.check(publisher)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn probe_access() -> (crate::app_lock::AccessState, AccessLease) {
        let access = ssh::test_support::unlocked_access();
        let lease = ssh::test_support::ready_lease(&access);
        (access, lease)
    }
    #[test]
    fn downgrade_guard_only_rejects_parseably_newer_companions() {
        assert!(reject_newer("lazysh-agent 2.0.0", "1.99.0").is_err());
        for value in [
            "unknown tool",
            "lazysh-agent 1.0.0",
            "lazysh-agent 1.99.0",
            "lazysh-agent 1.99.0-dev",
        ] {
            assert!(reject_newer(value, "1.99.0").is_ok());
        }
    }

    #[tokio::test]
    async fn failed_perform_phase_survives_cleanup_and_a_retired_progress_observer() {
        let (_access, lease) = probe_access();
        let fixture = ssh::guard_admission_fixture(lease.clone()).await;
        fixture.hold();
        let session = fixture.session.clone();
        let pending = tokio::spawn(async move {
            run_with(
                session,
                &lease,
                Channel::new(|_| Err(std::io::Error::other("retired observer").into())),
                &release::Publisher::owned(vec![1], "1.0.0".into()),
                Route::Host,
            )
            .await
        });
        fixture.opened().await;
        fixture.session.cancel.send_replace(true);
        let failure = pending.await.unwrap().unwrap_err();
        let serialized = serde_json::to_value(&failure).unwrap();
        assert_eq!(serialized["phase"], "detecting");
        assert_eq!(serialized["kind"], "disconnected");
        assert_eq!(serialized["message"], "Session closed");
        let preflight = serde_json::to_value(InstallFailure::from(error(
            "companion_install_busy",
            "Already running",
        )))
        .unwrap();
        assert!(preflight["phase"].is_null());
        assert_eq!(preflight["kind"], "companion_install_busy");
        fixture.release().await;
        fixture.closed().await;
    }

    #[tokio::test]
    async fn original_lease_retires_probe_and_holds_install_permit_for_late_confirmation() {
        for (retained, disconnected) in [(true, false), (false, false), (false, true)] {
            let (access, lease) = probe_access();
            let fixture = ssh::guard_admission_fixture(lease.clone()).await;
            fixture.hold();
            let owner = retained.then(|| {
                Arc::new(
                    fixture
                        .session
                        .companion_install
                        .clone()
                        .try_acquire_owned()
                        .unwrap(),
                )
            });
            let session = fixture.session.clone();
            let pending = tokio::spawn(async move {
                match owner {
                    Some(owner) => ssh::exec_bounded(
                        &session,
                        "owned install test".into(),
                        &lease,
                        Duration::from_secs(5),
                        1024,
                        Some(owner),
                    )
                    .await
                    .map(|_| None),
                    None => resolve::detect(&session, &lease).await,
                }
            });
            fixture.opened().await;
            if disconnected {
                fixture.session.cancel.send_replace(true);
            } else {
                access.lock().unwrap();
            }
            assert_eq!(
                pending.await.unwrap().unwrap_err().kind(),
                if disconnected {
                    "disconnected"
                } else {
                    "app_locked"
                }
            );
            if retained {
                assert!(
                    fixture
                        .session
                        .companion_install
                        .clone()
                        .try_acquire_owned()
                        .is_err(),
                    "late peer confirmation still owns the permit"
                );
            }
            fixture.release().await;
            fixture.closed().await;
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if fixture
                        .session
                        .companion_install
                        .clone()
                        .try_acquire_owned()
                        .is_ok()
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }
}
