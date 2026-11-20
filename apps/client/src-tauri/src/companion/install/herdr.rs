//! Explicit install and removal of the managed Herdr over the connected SSH session. The closed target, the fixed path
//! and the reviewed host script that verifies, plans and publishes live here. Nothing touches the system Herdr, its
//! configuration, its running servers or its sessions: the only file ever written or deleted is the managed binary.
use super::*;

const SCRIPT: &str = include_str!("managed_herdr.sh");
/// The script hashes at most 64 MiB twice and gives the self test 20 s; the rest is slack.
const EXEC_SECONDS: u64 = 90;
const OUTPUT_LIMIT: usize = 16_384;

/// The script's single JSON answer. Readers ignore unknown fields so a newer script still parses.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    schema_version: u8,
    action: String,
    outcome: String,
    plan: Option<String>,
    existing: Option<Existing>,
    error: Option<Fault>,
}
#[derive(Deserialize)]
struct Fault {
    kind: String,
}
fn invalid_reply() -> SshError {
    error(
        "herdr_installer_invalid",
        "The managed Herdr installer answered in an unexpected way",
    )
}
/// The script's closed refusals as the failures the panel knows; the text is fixed, never the host's.
fn refusal(kind: &str) -> SshError {
    let (kind, message) = match kind {
        "unsupportedHost" => (
            "herdr_unsupported_host",
            "This host's system or CPU is not one the managed Herdr was chosen for",
        ),
        "unsafeLocation" => (
            "herdr_unsafe_location",
            "The managed Herdr location on this host is not safe to use",
        ),
        "stagedMismatch" => (
            "herdr_staged_mismatch",
            "The file staged on the host is not the verified release file",
        ),
        "architectureMismatch" => (
            "herdr_architecture_mismatch",
            "The release file is not an executable for this host's CPU",
        ),
        "stalePlan" => (
            "herdr_stale_plan",
            "The host changed after the install was planned; nothing was installed",
        ),
        "hostBusy" => (
            "herdr_host_busy",
            "Another managed Herdr install or removal is running on this host",
        ),
        "selfTestFailed" => (
            "herdr_self_test_failed",
            "The managed Herdr did not run on this host and was not installed",
        ),
        "hostToolMissing" => ("herdr_host_tool_missing", "The host has no SHA-256 tool"),
        "installedMismatch" => (
            "herdr_installed_mismatch",
            "The installed managed Herdr could not be confirmed",
        ),
        _ => return invalid_reply(),
    };
    error(kind, message)
}
/// `sh -c <script> lazysh-managed-herdr ACTION ARGUMENTS`: the script is this repository's file, every argument is
/// quoted here and checked again by the script, and none comes from the host or the renderer.
fn command(arguments: &[&str]) -> String {
    let arguments = arguments
        .iter()
        .map(|argument| ssh::quote(argument))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "sh -c {} lazysh-managed-herdr {arguments}",
        ssh::quote(SCRIPT)
    )
}
/// A login shell may print a banner first, so the answer is the last line that parses as this action's reply. Only a
/// zero exit with a reply that reports no error is a success; a refusal the script names keeps its own failure.
fn parse(stdout: &[u8], action: &str, code: u32) -> Result<Reply> {
    let reply = String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Reply>(line.trim()).ok())
        .rfind(|reply| reply.schema_version == 1 && reply.action == action);
    match (code, reply) {
        (0, Some(reply)) if reply.error.is_none() => Ok(reply),
        (
            _,
            Some(Reply {
                error: Some(fault), ..
            }),
        ) => Err(refusal(&fault.kind)),
        _ => Err(invalid_reply()),
    }
}
async fn call(
    session: &Session,
    lease: &AccessLease,
    flight: Arc<Flight>,
    action: &str,
    arguments: &[&str],
) -> Result<Reply> {
    let mut all = vec![action];
    all.extend_from_slice(arguments);
    let output = ssh::exec_status(
        session,
        command(&all),
        lease,
        Duration::from_secs(EXEC_SECONDS),
        OUTPUT_LIMIT,
        Some(flight),
        &mut |_| {},
    )
    .await?;
    let code = output.status.ok_or_else(|| {
        error(
            "remote_command_failed",
            "The host ended the managed Herdr script without an exit status",
        )
    })?;
    parse(&output.stdout, action, code)
}
/// Only the refusals the script names before it changes anything are definite. A lost answer, an unreadable one or a
/// failed final check leaves the destination unknown, and the result then says so.
fn committed_unknown(error: &SshError) -> bool {
    !matches!(
        error.kind(),
        "herdr_unsupported_host"
            | "herdr_unsafe_location"
            | "herdr_staged_mismatch"
            | "herdr_architecture_mismatch"
            | "herdr_stale_plan"
            | "herdr_host_busy"
            | "herdr_self_test_failed"
            | "herdr_host_tool_missing"
    )
}
impl Operation {
    async fn script(&self, action: &str, arguments: &[&str]) -> Result<Reply> {
        call(
            &self.session,
            &self.lease,
            self.flight.clone(),
            action,
            arguments,
        )
        .await
    }
    pub(super) async fn perform_herdr(
        &self,
        work: &mut Work,
        publisher: &release::Publisher,
    ) -> Result<Installed> {
        let (unix, selection) = self.stage_upload(work, publisher, Subject::Herdr).await?;
        let (directory, target, destination) =
            (unix.herdr_dir(), unix.herdr_target(), unix.herdr());
        let (staged, bytes) = (
            work.staging.as_ref().unwrap().path.clone(),
            selection.bytes.to_string(),
        );
        let mut arguments = vec![
            directory.as_str(),
            &target,
            &selection.digest,
            &bytes,
            &staged,
        ];
        // The host re-checks the staged bytes, size and CPU and plans: nothing is changed yet.
        let planned = self.script("inspect", &arguments).await?;
        let plan = planned
            .plan
            .filter(|plan| planned.outcome == "planned" && lazysh_common::valid_sha256(plan))
            .ok_or_else(invalid_reply)?;
        publisher.recheck(&selection).await?;
        self.work_stage(&mut work.phase, Stage::Installing);
        // Dispatch may reach the host even if its answer is lost.
        work.possible_commit = Some((selection.version.clone(), destination.clone()));
        arguments.push(&plan);
        let reply = match self.script("install", &arguments).await {
            Ok(reply) => reply,
            Err(error) => {
                if !committed_unknown(&error) {
                    work.possible_commit = None;
                }
                return Err(error);
            }
        };
        let reused = match reply.outcome.as_str() {
            "installed" => false,
            "reused" => true,
            _ => return Err(invalid_reply()),
        };
        if reply.plan.as_deref() != Some(&plan)
            || !matches!(&reply.existing, Some(Existing::Present { sha256, bytes })
                if *sha256 == selection.digest && *bytes == selection.bytes)
        {
            return Err(invalid_reply());
        }
        Ok(result(
            if reused { "reused" } else { "installed" },
            &selection.version,
            &destination,
            None,
        ))
    }
}
/// Deletes the managed binary and nothing else: no server is stopped and no session or configuration is touched.
pub(crate) async fn remove(session: Arc<Session>, lease: &AccessLease) -> Result<Removed> {
    let flight = Arc::new(Flight {
        _permit: permit(&session)?,
    });
    let unix = resolve::detect(&session, lease)
        .await?
        .and_then(resolve::Host::unix)
        .ok_or_else(unsupported)?;
    let reply = call(&session, lease, flight, "remove", &[&unix.herdr_dir()]).await?;
    let status = match reply.outcome.as_str() {
        "removed" => "removed",
        "absent" => "absent",
        _ => return Err(invalid_reply()),
    };
    Ok(Removed {
        schema_version: 1,
        status,
        path: unix.herdr(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn line(outcome: &str, extra: &str) -> String {
        format!("{{\"schemaVersion\":1,\"action\":\"install\",\"outcome\":\"{outcome}\"{extra}}}\n")
    }
    #[test]
    fn only_a_zero_exit_with_this_actions_clean_reply_is_a_success() {
        let ok = line("installed", "");
        assert!(parse(ok.as_bytes(), "install", 0).is_ok());
        // A banner before the answer is ignored; an answer for another action, another schema or none is not an answer.
        let banner = format!("welcome to the host\n{ok}");
        assert_eq!(
            parse(banner.as_bytes(), "install", 0).unwrap().outcome,
            "installed"
        );
        for stdout in [
            String::new(),
            "not json\n".into(),
            ok.replace("\"install\"", "\"remove\""),
            ok.replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
        ] {
            let failure = parse(stdout.as_bytes(), "install", 0).err().unwrap();
            assert_eq!(failure.kind(), "herdr_installer_invalid", "{stdout:?}");
        }
        // A non-zero exit, or a success that carries an error, is never a success.
        assert!(parse(ok.as_bytes(), "install", 1).is_err());
        let both = line("installed", ",\"error\":{\"kind\":\"stalePlan\"}");
        assert_eq!(
            parse(both.as_bytes(), "install", 0).err().unwrap().kind(),
            "herdr_stale_plan"
        );
    }
    #[test]
    fn every_refusal_the_script_names_is_a_fixed_failure_and_anything_else_is_invalid() {
        for (kind, expected) in [
            ("unsupportedHost", "herdr_unsupported_host"),
            ("unsafeLocation", "herdr_unsafe_location"),
            ("stagedMismatch", "herdr_staged_mismatch"),
            ("architectureMismatch", "herdr_architecture_mismatch"),
            ("stalePlan", "herdr_stale_plan"),
            ("hostBusy", "herdr_host_busy"),
            ("selfTestFailed", "herdr_self_test_failed"),
            ("hostToolMissing", "herdr_host_tool_missing"),
            ("installedMismatch", "herdr_installed_mismatch"),
            ("usage", "herdr_installer_invalid"),
            ("internal", "herdr_installer_invalid"),
            ("anything the host invents", "herdr_installer_invalid"),
        ] {
            let stdout = line("failed", &format!(",\"error\":{{\"kind\":\"{kind}\"}}"));
            assert_eq!(
                parse(stdout.as_bytes(), "install", 7).err().unwrap().kind(),
                expected,
                "{kind}"
            );
        }
    }
    #[test]
    fn a_lost_or_unreadable_answer_or_failed_final_check_leaves_the_destination_unknown() {
        for definite in ["stalePlan", "unsafeLocation", "stagedMismatch", "hostBusy"] {
            assert!(!committed_unknown(&refusal(definite)), "{definite}");
        }
        for unknown in ["installedMismatch", "internal", "usage"] {
            assert!(committed_unknown(&refusal(unknown)), "{unknown}");
        }
        assert!(committed_unknown(&error("disconnected", "Session closed")));
        assert!(committed_unknown(&invalid_reply()));
    }
}
