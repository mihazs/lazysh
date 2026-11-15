//! The default install: the host downloads and installs the companion and this device only sends the
//! pin it verified from the release metadata (version, size, SHA-256). Nothing here fetches the asset.
use super::*;
const BOOTSTRAP: &str = include_str!("bootstrap.sh");
/// The script's own limits (180 s download, 20 s per self-test step) plus slack, then the whole operation.
const EXEC_SECONDS: u64 = 300;
pub(super) const OPERATION_SECONDS: u64 = 330;
const OUTPUT_LIMIT: usize = 65_536;
/// The script's progress and result lines. Readers ignore unknown fields so a newer script still parses.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    schema_version: u8,
    event: String,
    stage: Option<String>,
    bytes: Option<u64>,
    total: Option<u64>,
    outcome: Option<String>,
    exit_code: Option<u32>,
    action: Option<String>,
    error: Option<Reported>,
    current: Option<Versioned>,
    previous: Option<Versioned>,
}
#[derive(Deserialize)]
struct Reported {
    kind: Option<String>,
    detail: Option<String>,
}
#[derive(Deserialize)]
struct Versioned {
    version: Option<String>,
    managed: Option<bool>,
}
impl Line {
    fn current(&self) -> Option<&str> {
        self.current
            .as_ref()?
            .version
            .as_deref()
            .filter(|v| release::version(v).is_some())
    }
    fn previous(&self) -> Option<&str> {
        self.previous
            .as_ref()?
            .version
            .as_deref()
            .filter(|v| release::version(v).is_some())
    }
}
fn parse(line: &str) -> Option<Line> {
    serde_json::from_str::<Line>(line.trim())
        .ok()
        .filter(|line| line.schema_version == 1)
}
/// A mutating operation is settled only by one unambiguous, complete result stream.
fn strict_result(stdout: &[u8]) -> Option<Line> {
    if !stdout.ends_with(b"\n") {
        return None;
    }
    let mut result = None;
    for text in std::str::from_utf8(stdout).ok()?.lines() {
        let line = parse(text)?;
        match line.event.as_str() {
            "stage" if result.is_none() => (),
            "result" if result.is_none() => result = Some(line),
            _ => return None,
        }
    }
    result
}
/// Complete stdout lines, however the transport chunks them; a line past the cap is cut and then fails to parse.
#[derive(Default)]
struct Lines(Vec<u8>);
impl Lines {
    fn feed(&mut self, chunk: &[u8], mut each: impl FnMut(&str)) {
        for byte in chunk {
            if *byte == b'\n' {
                if let Ok(line) = std::str::from_utf8(&self.0) {
                    each(line);
                }
                self.0.clear();
            } else if self.0.len() < 4096 {
                self.0.push(*byte);
            }
        }
    }
}
fn stage_of(name: &str) -> Option<Stage> {
    Some(match name {
        "downloading" => Stage::Downloading,
        "verifying" => Stage::Verifying,
        "selfTesting" => Stage::SelfTesting,
        "replacing" => Stage::Installing,
        "checkingInstalled" => Stage::CheckingInstalled,
        _ => return None,
    })
}
/// The closed set of reasons a host can report; anything else is dropped rather than shown.
fn detail_of(detail: &str) -> Option<&'static str> {
    const DETAILS: [&str; 15] = [
        "dns",
        "connect",
        "timeout",
        "tls",
        "http",
        "rateLimited",
        "interrupted",
        "digestMismatch",
        "sizeMismatch",
        "pinMismatch",
        "redirectRefused",
        "insecureUrl",
        "commitMismatch",
        "noDownloader",
        "noDigestTool",
    ];
    DETAILS.into_iter().find(|known| *known == detail)
}
/// Only a matching final report from a documented refusal settles the outcome.
fn definite_failure(code: u32, line: Option<&Line>, action: &str, target: &str) -> bool {
    let kind = match code {
        20 => "networkUnavailable",
        21 => "releaseUnavailable",
        22 => "verificationFailed",
        23 => "downgradeRefused",
        24 => "selfTestFailed",
        25 => "rolledBack",
        26 => "busy",
        27 => "unsafeInstallLocation",
        28 => "noPreviousVersion",
        30 => "hostToolMissing",
        _ => return false,
    };
    line.is_some_and(|line| {
        line.exit_code == Some(code)
            && line.action.as_deref() == Some(action)
            && line.outcome.as_deref() == Some("failed")
            && line.error.as_ref().and_then(|error| error.kind.as_deref()) == Some(kind)
            && line.current() != Some(target)
    })
}
/// The update contract's exit codes as the failures the panel knows; the text is fixed, never the host's.
fn failure(code: u32) -> SshError {
    let (kind, message) = match code {
        20 => (
            "companion_host_network",
            "The host could not download the companion from the release",
        ),
        21 => (
            "companion_release_unavailable",
            "No compatible verified companion installer is published",
        ),
        22 => (
            "companion_verification_failed",
            "The file the host downloaded did not match the release and was discarded",
        ),
        23 => (
            "companion_newer_installed",
            "A newer companion already exists; installation will not downgrade it",
        ),
        24 => (
            "companion_self_test_failed",
            "The downloaded companion failed its self test; the installed one was not changed",
        ),
        25 => (
            "companion_rolled_back",
            "The new companion failed after installation and the previous one was restored",
        ),
        26 => (
            "companion_host_busy",
            "Another companion update is running on this host",
        ),
        27 => (
            "companion_unsafe_location",
            "The managed companion location on this host is not safe to use",
        ),
        28 => (
            "companion_no_previous",
            "The host has no previous companion to restore",
        ),
        30 => (
            "companion_host_tool_missing",
            "The host has no curl or GNU wget, or no SHA-256 tool",
        ),
        _ => return invalid(),
    };
    error(kind, message)
}
/// `sh -c <script> lazysh-bootstrap VERSION SHA256 BYTES TARGET DIR`: the script is this repository's file,
/// every argument is checked here and again by the script, and none comes from the host.
pub(super) fn bootstrap_command(
    unix: &resolve::Unix,
    selection: &release::Selection,
) -> Result<String> {
    let directory = unix.managed_dir();
    if release::version(&selection.version).is_none()
        || !lazysh_common::valid_sha256(&selection.digest)
        || selection.bytes == 0
        || selection.bytes > release::MAX_BINARY
        || !resolve::path(&directory)
    {
        return Err(invalid());
    }
    Ok(format!(
        "sh -c {} lazysh-bootstrap {} {} {} {} {}",
        ssh::quote(BOOTSTRAP),
        ssh::quote(&selection.version),
        ssh::quote(&selection.digest),
        selection.bytes,
        ssh::quote(&unix.target()),
        ssh::quote(&directory)
    ))
}
/// `lazysh-agent update --json --yes --version V --expect-sha256 H --expect-bytes N` through the managed-executable
/// resolver: the host re-resolves the release itself and refuses (exit 22) anything that differs from the pin.
fn update_command(unix: &resolve::Unix, selection: &release::Selection) -> Result<String> {
    if release::version(&selection.version).is_none()
        || !lazysh_common::valid_sha256(&selection.digest)
        || selection.bytes == 0
        || selection.bytes > release::MAX_BINARY
    {
        return Err(invalid());
    }
    unix.command(&format!(
        "lazysh-agent update --json --yes --version {} --expect-sha256 {} --expect-bytes {}",
        selection.version, selection.digest, selection.bytes
    ))
}
/// A complete recognizable command list is required before treating the updater as absent.
fn legacy_help(text: &str) -> bool {
    if !text
        .lines()
        .any(|line| line.trim() == "Usage: lazysh-agent <COMMAND>")
    {
        return false;
    }
    let mut lines = text.lines().skip_while(|line| line.trim() != "Commands:");
    if lines.next().is_none() {
        return false;
    }
    let mut names = Vec::new();
    let mut complete = false;
    for line in lines.by_ref() {
        if line.trim().is_empty() {
            complete = true;
            break;
        }
        if !line.starts_with("  ") {
            return false;
        }
        let Some(name) = line.split_whitespace().next() else {
            return false;
        };
        if !name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
            || names.contains(&name)
        {
            return false;
        }
        names.push(name);
        if names.len() > 128 {
            return false;
        }
    }
    let options = lines.collect::<Vec<_>>();
    complete
        && options.first().map(|line| line.trim()) == Some("Options:")
        && options
            .iter()
            .any(|line| line.trim_start().starts_with("-h, --help"))
        && options
            .iter()
            .any(|line| line.trim_start().starts_with("-V, --version"))
        && ["ingest", "snapshot", "help"]
            .iter()
            .all(|name| names.contains(name))
        && !names.contains(&"update")
        && !names.contains(&"auto-update")
}
/// The result of **Check for updates**: only versions and a closed state, nothing from the host's own text.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    schema_version: u8,
    via: &'static str,
    installed: Option<String>,
    previous: Option<String>,
    latest: String,
    state: &'static str,
}
/// What the host's `update --status --json` reported; absent when the companion has no `update` command.
pub(super) struct Capability {
    /// The managed companion's version, when the host reports one.
    pub managed: Option<String>,
    pub previous: Option<String>,
}
impl Operation {
    /// Classify only a valid status, a complete legacy help response, or a positively absent executable.
    pub(super) async fn probe(&self, unix: &resolve::Unix) -> Result<Option<Capability>> {
        let output = self
            .probe_command(unix.command("lazysh-agent update --status --json")?)
            .await?;
        if output.status == Some(0) {
            let line = strict_result(&output.stdout)
                .filter(|line| {
                    line.exit_code == Some(0)
                        && line.action.as_deref() == Some("status")
                        && line.outcome.as_deref() == Some("status")
                        && line.current().is_some()
                        && line
                            .current
                            .as_ref()
                            .and_then(|current| current.managed)
                            .is_some()
                })
                .ok_or_else(invalid)?;
            return Ok(Some(Capability {
                managed: line
                    .current
                    .as_ref()
                    .filter(|current| current.managed == Some(true))
                    .and(line.current())
                    .map(str::to_owned),
                previous: line.previous().map(str::to_owned),
            }));
        }
        if output.status == Some(73) {
            return Err(failure(27));
        }
        if output.status == Some(2) {
            let version = self
                .probe_command(unix.command("lazysh-agent --version")?)
                .await?;
            let valid_version = version.status == Some(0)
                && std::str::from_utf8(&version.stdout)
                    .ok()
                    .and_then(|text| text.trim().strip_prefix("lazysh-agent "))
                    .and_then(release::version)
                    .is_some();
            if !valid_version {
                return Err(invalid());
            }
            let help = self
                .probe_command(unix.command("lazysh-agent --help")?)
                .await?;
            if help.status == Some(0)
                && std::str::from_utf8(&help.stdout)
                    .ok()
                    .is_some_and(legacy_help)
            {
                return Ok(None);
            }
        }
        if output.status == Some(127) {
            let script = format!("p={}; if [ ! -e \"$p\" ] && [ ! -L \"$p\" ] && ! command -v lazysh-agent >/dev/null 2>&1; then printf 'lazysh-companion-absent-v1\\n'; else exit 1; fi", ssh::quote(&unix.managed()));
            let absent = self
                .probe_command(format!("sh -c {}", ssh::quote(&script)))
                .await?;
            if absent.status == Some(0) && absent.stdout == b"lazysh-companion-absent-v1\n" {
                return Ok(None);
            }
        }
        Err(invalid())
    }
    async fn probe_command(&self, command: String) -> Result<ssh::ExecOutput> {
        ssh::exec_status(
            &self.session,
            command,
            &self.lease,
            Duration::from_secs(15),
            16_384,
            Some(self.flight.clone()),
            &mut |_| {},
        )
        .await
    }
    fn host_stage(&self, phase: &mut Option<Stage>, stage: Stage, counted: Option<(u64, u64)>) {
        *phase = Some(stage);
        if self.lease.check().is_ok() && !*self.session.cancel.borrow() {
            let mut progress = Progress::new(stage);
            if let Some((bytes, total)) = counted {
                progress.bytes = Some(bytes);
                progress.total = Some(total);
            }
            let _ = self.progress.send(progress);
        }
    }
    async fn installed_version(&self, unix: &resolve::Unix) -> Result<String> {
        match self.command(unix.command("lazysh-agent --version")?).await {
            Ok(version) => Ok(version),
            Err(error) if error.kind() == "remote_command_failed" => Ok(String::new()),
            Err(error) => Err(error),
        }
    }
    /// Runs `script` on the host and streams its progress. `committing` is what the host may now have installed:
    /// once dispatched the answer can be lost. `Ok(None)` is an uncertain commit (exit 29); only a
    /// documented failure accompanied by a matching result settles a definite refusal.
    async fn dispatch(
        &self,
        work: &mut Work,
        script: String,
        total: Option<u64>,
        committing: (String, String),
        action: &str,
    ) -> Result<Option<Line>> {
        work.possible_commit = Some(committing);
        let mut lines = Lines::default();
        let phase = &mut work.phase;
        let output = ssh::exec_status(
            &self.session,
            script,
            &self.lease,
            Duration::from_secs(EXEC_SECONDS),
            OUTPUT_LIMIT,
            Some(self.flight.clone()),
            &mut |chunk| {
                lines.feed(chunk, |text| {
                    let Some(line) = parse(text).filter(|line| line.event == "stage") else {
                        return;
                    };
                    let Some(stage) = line.stage.as_deref().and_then(stage_of) else {
                        return;
                    };
                    let counted = line
                        .bytes
                        .zip(line.total)
                        .filter(|(bytes, declared)| Some(*declared) == total && bytes <= declared);
                    self.host_stage(phase, stage, counted);
                });
            },
        )
        .await?;
        let code = output.status.ok_or_else(|| {
            error(
                "remote_command_failed",
                "The host ended the update without an exit status",
            )
        })?;
        let reported = strict_result(&output.stdout);
        match code {
            0 => {}
            29 => return Ok(None),
            code => {
                if !definite_failure(
                    code,
                    reported.as_ref(),
                    action,
                    &work.possible_commit.as_ref().unwrap().0,
                ) {
                    return Err(invalid());
                }
                work.possible_commit = None;
                work.detail = reported
                    .and_then(|line| line.error)
                    .and_then(|reported| reported.detail)
                    .and_then(|detail| detail_of(&detail));
                return Err(failure(code));
            }
        }
        // A success that does not say what it did may still have changed the host: that stays uncertain.
        match reported {
            Some(line) if line.exit_code == Some(0) => Ok(Some(line)),
            _ => Err(invalid()),
        }
    }
    /// The app does not trust the host's JSON alone: it asks for the version again through the resolver.
    async fn confirm(&self, work: &mut Work, unix: &resolve::Unix, expected: &str) -> Result<()> {
        work.checking_installed = true;
        self.work_stage(&mut work.phase, Stage::CheckingInstalled);
        let version = self
            .command(unix.managed_command("lazysh-agent --version")?)
            .await?;
        if version.trim() != format!("lazysh-agent {expected}") {
            return Err(invalid());
        }
        Ok(())
    }
    pub(super) async fn perform_host(
        &self,
        work: &mut Work,
        publisher: &release::Publisher,
    ) -> Result<Installed> {
        let (unix, selection) = self.resolve(work, publisher, Subject::Companion).await?;
        reject_newer(&self.installed_version(&unix).await?, &selection.version)?;
        self.work_stage(&mut work.phase, Stage::Verifying);
        publisher.recheck(&selection).await?;
        let destination = unix.managed();
        // A companion with `update` re-resolves the release itself against the pin; older ones get the script.
        let script = match self.probe(&unix).await? {
            // Already the pinned version in the managed location: nothing to fetch, and the host is not asked to.
            Some(capability)
                if capability.managed.as_deref() == Some(selection.version.as_str()) =>
            {
                self.confirm(work, &unix, &selection.version).await?;
                return Ok(result("reused", &selection.version, &destination, None));
            }
            Some(_) => update_command(&unix, &selection)?,
            None => bootstrap_command(&unix, &selection)?,
        };
        let committing = (selection.version.clone(), destination.clone());
        let Some(line) = self
            .dispatch(work, script, Some(selection.bytes), committing, "update")
            .await?
        else {
            return Ok(result(
                "uncertain",
                &selection.version,
                &destination,
                Some("committedDurabilityUnknown"),
            ));
        };
        let reused = match line.outcome.as_deref() {
            Some("updated") => false,
            Some("upToDate") => true,
            _ => return Err(invalid()),
        };
        if reused {
            work.possible_commit = None;
        }
        self.confirm(work, &unix, &selection.version).await?;
        Ok(result(
            if reused { "reused" } else { "installed" },
            &selection.version,
            &destination,
            None,
        ))
    }
    /// What is installed, whether it can update itself, and how it compares with the latest release.
    pub(super) async fn check(&self, publisher: &release::Publisher) -> Result<Checked> {
        let mut work = Work::default();
        let (unix, latest) = self.resolve(&mut work, publisher, Subject::Companion).await?;
        let installed = self.installed_version(&unix).await?;
        let capability = self.probe(&unix).await?;
        let current = installed
            .trim()
            .strip_prefix("lazysh-agent ")
            .filter(|version| release::version(version).is_some())
            .map(str::to_owned);
        let state = match current.as_deref().and_then(release::version) {
            None => "notInstalled",
            Some(have) if Some(have) > release::version(&latest.version) => "newer",
            Some(have) if Some(have) == release::version(&latest.version) => "upToDate",
            Some(_) => "available",
        };
        Ok(Checked {
            schema_version: 1,
            via: if capability.is_some() {
                "update"
            } else {
                "bootstrap"
            },
            installed: current,
            previous: capability.and_then(|capability| capability.previous),
            latest: latest.version,
            state,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mutating_result_stream_must_be_complete_and_unambiguous() {
        let good = b"{\"schemaVersion\":1,\"event\":\"result\"}\n";
        assert!(strict_result(good).is_some());
        assert!(strict_result(&[good.as_slice(), good.as_slice()].concat()).is_none());
        assert!(strict_result(
            &[
                good.as_slice(),
                b"{\"schemaVersion\":1,\"event\":\"stage\"}\n"
            ]
            .concat()
        )
        .is_none());
        assert!(strict_result(&[good.as_slice(), b"{broken\n"].concat()).is_none());
        assert!(strict_result(b"\xff").is_none());
    }
    #[test]
    fn only_matching_documented_failures_are_definite() {
        let line = parse(r#"{"schemaVersion":1,"event":"result","action":"update","outcome":"failed","exitCode":22,"error":{"kind":"verificationFailed"}}"#).unwrap();
        assert!(definite_failure(22, Some(&line), "update", "1.2.3"));
        assert!(!definite_failure(22, None, "update", "1.2.3"));
        assert!(!definite_failure(23, Some(&line), "update", "1.2.3"));
        assert!(!definite_failure(22, Some(&line), "rollback", "1.2.3"));
        assert!(!definite_failure(137, Some(&line), "update", "1.2.3"));
        let contradictory = parse(r#"{"schemaVersion":1,"event":"result","action":"update","outcome":"updated","exitCode":22}"#).unwrap();
        assert!(!definite_failure(
            22,
            Some(&contradictory),
            "update",
            "1.2.3"
        ));
    }
    fn unix(data: &str) -> resolve::Unix {
        resolve::Unix {
            os: if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            },
            arch: if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            },
            uid: 1000,
            home: "/home/owned".into(),
            data: data.into(),
        }
    }
    async fn selection(version: &str) -> release::Selection {
        release::Publisher::owned(vec![7; 32], version.into())
            .select("linux-agent-x64")
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn the_command_carries_only_a_validated_pin_and_the_managed_directory() {
        let selection = selection("1.54.1").await;
        let host = unix("/home/owned/.local/share/");
        let command = bootstrap_command(&host, &selection).unwrap();
        assert!(command.starts_with("sh -c '"));
        assert!(command.ends_with(&format!(
            " lazysh-bootstrap '1.54.1' '{}' 32 '{}' '/home/owned/.local/share/lazysh/companion'",
            selection.digest,
            host.target()
        )));
        let mut pin = selection.clone();
        for version in ["1.54", "01.2.3", "1.2.3-rc", "1.2.3;id"] {
            pin.version = version.into();
            assert!(bootstrap_command(&host, &pin).is_err(), "{version}");
        }
        pin.version = "1.54.1".into();
        for digest in ["", "ABCD", &"g".repeat(64), &"a".repeat(65)] {
            pin.digest = digest.into();
            assert!(bootstrap_command(&host, &pin).is_err(), "{digest}");
        }
        pin.digest = selection.digest.clone();
        for bytes in [0, release::MAX_BINARY + 1] {
            pin.bytes = bytes;
            assert!(bootstrap_command(&host, &pin).is_err(), "{bytes}");
        }
        assert!(bootstrap_command(&unix("/data/../escape"), &selection).is_err());
    }
    #[test]
    fn progress_lines_are_parsed_whole_and_foreign_or_oversized_lines_are_ignored() {
        let mut seen = Vec::new();
        let mut lines = Lines::default();
        let stream = b"banner from a shell profile\n{\"schemaVersion\":1,\"event\":\"stage\",\"stage\":\"downloading\",\"bytes\":5,\"total\":9,\"later\":true}\n{\"schemaVersion\":2,\"event\":\"stage\",\"stage\":\"verifying\"}\n";
        for chunk in stream.chunks(7) {
            lines.feed(chunk, |line| seen.push(parse(line).map(|l| l.stage)));
        }
        assert_eq!(seen, vec![None, Some(Some("downloading".into())), None]);
        lines.feed(&vec![b'x'; 10_000], |_| unreachable!());
        let mut after = 0;
        lines.feed(b"\n", |line| {
            after += 1;
            assert_eq!(line.len(), 4096);
            assert!(parse(line).is_none());
        });
        assert_eq!(after, 1);
        assert!(stage_of("downloading").is_some() && stage_of("resolving").is_none());
        assert!(matches!(stage_of("replacing"), Some(Stage::Installing)));
        assert!(detail_of("tls").is_some() && detail_of("anything else").is_none());
    }
    #[test]
    fn every_documented_exit_has_a_fixed_failure_and_the_rest_are_invalid() {
        for (code, kind) in [
            (20, "companion_host_network"),
            (21, "companion_release_unavailable"),
            (22, "companion_verification_failed"),
            (23, "companion_newer_installed"),
            (24, "companion_self_test_failed"),
            (25, "companion_rolled_back"),
            (26, "companion_host_busy"),
            (27, "companion_unsafe_location"),
            (30, "companion_host_tool_missing"),
            (1, "companion_installer_invalid"),
            (2, "companion_installer_invalid"),
            (255, "companion_installer_invalid"),
        ] {
            assert_eq!(failure(code).kind(), kind, "exit {code}");
        }
        let result = strict_result(
            b"{\"schemaVersion\":1,\"event\":\"result\",\"exitCode\":22,\"outcome\":\"failed\",\"error\":{\"kind\":\"verificationFailed\",\"detail\":\"digestMismatch\"}}\n",
        )
        .unwrap();
        assert_eq!(result.exit_code, Some(22));
        assert_eq!(
            result.error.unwrap().detail.as_deref(),
            Some("digestMismatch")
        );
        assert!(strict_result(
            b"{\"schemaVersion\":1,\"event\":\"stage\",\"stage\":\"verifying\"}\n"
        )
        .is_none());
    }
    #[test]
    fn legacy_classification_requires_complete_help_without_update_commands() {
        let help = "Usage: lazysh-agent <COMMAND>\n\nCommands:\n  ingest  report\n  snapshot  state\n  help  help\n\nOptions:\n  -h, --help  help\n  -V, --version  version\n";
        assert!(legacy_help(help));
        assert!(!legacy_help(
            &help.replace("  help  help", "  update  update\n  help  help")
        ));
        assert!(!legacy_help(
            &help.replace("  help  help", "  auto-update  policy\n  help  help")
        ));
        assert!(!legacy_help(help.split("Options:").next().unwrap()));
        assert!(!legacy_help(
            &help.replace("  -V, --version  version\n", "")
        ));
    }
    #[tokio::test]
    async fn only_a_status_result_with_exit_zero_selects_the_update_command() {
        let access = ssh::test_support::unlocked_access();
        let lease = ssh::test_support::ready_lease(&access);
        let fixture = ssh::guard_admission_fixture(lease.clone()).await;
        let operation = Operation::start(
            Route::Host,
            fixture.session.clone(),
            &lease,
            Channel::new(|_| Ok(())),
            5,
        )
        .unwrap();
        let host = unix("/home/owned/.local/share");
        let status = |code: u32, action: &str, previous: &str| {
            format!("{{\"schemaVersion\":1,\"event\":\"result\",\"action\":\"{action}\",\"outcome\":\"status\",\"exitCode\":{code},\"current\":{{\"version\":\"1.55.0\",\"managed\":true}},\"previous\":{previous},\"later\":true}}\n")
        };
        let kept = r#"{"version":"1.54.1"}"#;
        for (stdout, exit, expected) in [
            (status(0, "status", kept), 0, Some("1.54.1")),
            (status(0, "status", "null"), 0, None),
        ] {
            fixture.script_exec(&stdout, exit);
            assert_eq!(
                operation
                    .probe(&host)
                    .await
                    .unwrap()
                    .unwrap()
                    .previous
                    .as_deref(),
                expected
            );
        }
        for (stdout, exit) in [
            (String::new(), 2),
            (String::new(), 127),
            (String::new(), 126),
            ("welcome\n".into(), 0),
            (status(0, "check", kept), 0),
            (status(1, "status", kept), 0),
            (status(0, "status", kept), 1),
        ] {
            fixture.script_exec(&stdout, exit);
            assert!(
                operation.probe(&host).await.is_err(),
                "{stdout:?} exit {exit}"
            );
        }
    }
    /// Runs the embedded script exactly as the login shell would receive it, with `curl` replaced by a copy
    /// from the owned directory, so the quoting of the script and the output contract are the real ones.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn the_embedded_script_installs_updates_and_refuses_through_the_exact_command() {
        use std::{fs, os::unix::fs::PermissionsExt, process::Command};
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let bin = base.join("bin");
        fs::create_dir(&bin).unwrap();
        let curl = bin.join("curl");
        fs::write(&curl, "#!/bin/sh\nfor a; do case $a in -o) next=1;; *) [ -z \"${next-}\" ] || { cp \"$ASSET\" \"$a\"; next=; };; esac; done\n").unwrap();
        fs::set_permissions(&curl, fs::Permissions::from_mode(0o700)).unwrap();
        let asset = base.join("asset");
        fs::write(&asset, "#!/bin/sh\ncase \"$1\" in --version) echo 'lazysh-agent 9.9.9';; ingest) mkdir -p \"$LAZYSH_STATE_DIR\"; cat > \"$LAZYSH_STATE_DIR/e\";; snapshot) cat \"$LAZYSH_STATE_DIR/e\";; esac\n").unwrap();
        let publisher = release::Publisher::owned(fs::read(&asset).unwrap(), "9.9.9".into());
        let selection = publisher.select("linux-agent-x64").await.unwrap();
        let host = {
            let mut host = unix(base.join("data").to_str().unwrap());
            host.uid = std::os::unix::fs::MetadataExt::uid(&fs::metadata(&base).unwrap());
            host
        };
        let run = |selection: &release::Selection| {
            let output = Command::new("/bin/sh")
                .args(["-c", &bootstrap_command(&host, selection).unwrap()])
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env("ASSET", &asset)
                .output()
                .unwrap();
            let stdout = String::from_utf8(output.stdout).unwrap();
            let stages = stdout
                .lines()
                .filter_map(parse)
                .filter(|l| l.event == "stage")
                .filter_map(|l| l.stage)
                .collect::<Vec<_>>();
            (
                output.status.code().unwrap(),
                strict_result(stdout.as_bytes()),
                stages,
                stdout,
            )
        };
        let managed = base.join("data/lazysh/companion/lazysh-agent");
        let (code, result, stages, stdout) = run(&selection);
        assert_eq!(code, 0, "{stdout}");
        assert_eq!(result.unwrap().outcome.as_deref(), Some("updated"));
        for stage in [
            "downloading",
            "verifying",
            "selfTesting",
            "replacing",
            "checkingInstalled",
        ] {
            assert!(
                stages.iter().any(|seen| seen == stage),
                "{stage} in {stages:?}"
            );
        }
        assert_eq!(fs::read(&managed).unwrap(), fs::read(&asset).unwrap());
        assert_eq!(
            fs::metadata(&managed).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(
            !stdout.contains("github.com") && !stdout.contains(base.to_str().unwrap()),
            "no URL or path is echoed: {stdout}"
        );
        let (code, result, ..) = run(&selection);
        assert_eq!(
            (code, result.unwrap().outcome.as_deref().map(str::to_owned)),
            (0, Some("upToDate".into()))
        );
        let mut tampered = selection.clone();
        tampered.digest = "0".repeat(64);
        fs::write(&managed, "#!/bin/sh\necho 'lazysh-agent 1.0.0'\n").unwrap();
        fs::set_permissions(&managed, fs::Permissions::from_mode(0o700)).unwrap();
        let (code, result, ..) = run(&tampered);
        assert_eq!(code, 22);
        assert_eq!(
            result.unwrap().error.unwrap().detail.as_deref(),
            Some("digestMismatch")
        );
        assert!(
            fs::read_to_string(&managed).unwrap().contains("1.0.0"),
            "a refused download changes nothing"
        );
        assert!(
            fs::read_dir(base.join("data/lazysh/companion"))
                .unwrap()
                .all(|e| !e.unwrap().file_name().to_string_lossy().starts_with('.')),
            "no residue"
        );
    }
}
