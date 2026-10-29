use super::*;
use tokio::sync::{watch, OwnedSemaphorePermit};
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
    session: Arc<Session>,
    lease: AccessLease,
    progress: Channel<Progress>,
    flight: Arc<Flight>,
    stop: watch::Sender<bool>,
    deadline: tokio::time::Instant,
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
}
impl Operation {
    fn stage(&self, stage: Stage) {
        if self.lease.check().is_ok() && !*self.session.cancel.borrow() {
            let _ = self.progress.send(Progress { stage });
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
    async fn perform(&self, work: &mut Work, publisher: &release::Publisher) -> Result<Installed> {
        self.stage(Stage::Detecting);
        let unix = resolve::detect(&self.session, &self.lease)
            .await?
            .ok_or_else(|| {
                error(
                    "companion_install_unsupported",
                    "Installation requires a positively identified Linux or macOS SSH shell",
                )
            })?;
        self.stage(Stage::CheckingRelease);
        let selection = publisher.select(&unix.target()).await?;
        self.stage(Stage::Downloading);
        let bytes = publisher.download(&selection).await?;
        let raw = ssh::installer_sftp(
            &self.session,
            &self.lease,
            self.stop.subscribe(),
            self.flight.clone(),
        )
        .await?;
        work.staging = Some(transfer::Staging::new(raw, &unix, &selection));
        let staging = work.staging.as_mut().unwrap();
        self.stage(Stage::Uploading);
        staging.upload(&unix.home, &bytes).await?;
        self.stage(Stage::Verifying);
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
        self.stage(Stage::Installing);
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
        self.stage(Stage::CheckingInstalled);
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
    }
}
pub(super) async fn run(
    session: Arc<Session>,
    lease: &AccessLease,
    progress: Channel<Progress>,
) -> Result<Installed> {
    run_with(session, lease, progress, release::Publisher::new()?).await
}
pub(super) async fn run_with(
    session: Arc<Session>,
    lease: &AccessLease,
    progress: Channel<Progress>,
    publisher: release::Publisher,
) -> Result<Installed> {
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
    let op = Operation {
        session,
        lease: lease.clone(),
        progress,
        flight: Arc::new(Flight { _permit: permit }),
        stop,
        deadline: tokio::time::Instant::now() + Duration::from_secs(240),
    };
    let mut work = Work::default();
    let outcome = op.active(op.perform(&mut work, &publisher)).await;
    op.stage(Stage::CleaningUp);
    let cleaned = if let Some(staging) = &mut work.staging {
        if op.lease.check().is_ok() && !*op.session.cancel.borrow() {
            tokio::time::timeout(Duration::from_secs(5), staging.cleanup())
                .await
                .unwrap_or(false)
        } else {
            false
        }
    } else {
        true
    };
    op.lease.check()?;
    match outcome {
        Ok(mut installed) => {
            installed.cleanup = if cleaned { "complete" } else { "residue" };
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
                installed.cleanup = if cleaned { "complete" } else { "residue" };
                Ok(installed)
            }
            None => Err(error),
        },
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
    async fn original_lease_retires_probe_and_holds_install_permit_for_late_confirmation() {
        for (retained, disconnected) in [(true, false), (false, false), (false, true)] {
            let access = ssh::test_support::unlocked_access();
            let lease = ssh::test_support::ready_lease(&access);
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
