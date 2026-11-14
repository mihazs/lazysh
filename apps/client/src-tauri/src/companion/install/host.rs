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
    error: Option<Reported>,
}
#[derive(Deserialize)]
struct Reported {
    detail: Option<String>,
}
fn parse(line: &str) -> Option<Line> {
    serde_json::from_str::<Line>(line.trim())
        .ok()
        .filter(|line| line.schema_version == 1)
}
fn last_result(stdout: &[u8]) -> Option<Line> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(parse)
        .rfind(|line| line.event == "result")
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
impl Operation {
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
    pub(super) async fn perform_host(
        &self,
        work: &mut Work,
        publisher: &release::Publisher,
    ) -> Result<Installed> {
        let (unix, selection) = self.resolve(work, publisher).await?;
        reject_newer(&self.installed_version(&unix).await?, &selection.version)?;
        self.work_stage(&mut work.phase, Stage::Verifying);
        publisher.recheck(&selection).await?;
        let script = bootstrap_command(&unix, &selection)?;
        let destination = unix.managed();
        // Dispatch may reach the host even if its answer is lost; the exit status below settles it.
        work.possible_commit = Some((selection.version.clone(), destination.clone()));
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
                        .filter(|(bytes, total)| *total == selection.bytes && bytes <= total);
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
        let reported = last_result(&output.stdout);
        if code != 0 {
            // Every non-zero exit but 29 is a definite answer: nothing was committed.
            work.possible_commit = None;
            if code == 29 {
                return Ok(result(
                    "uncertain",
                    &selection.version,
                    &destination,
                    Some("committedDurabilityUnknown"),
                ));
            }
            work.detail = reported
                .and_then(|line| line.error)
                .and_then(|reported| reported.detail)
                .and_then(|detail| detail_of(&detail));
            return Err(failure(code));
        }
        // A success that does not say what it did may still have installed: that stays uncertain.
        let reused = match reported {
            Some(line) if line.exit_code == Some(0) => match line.outcome.as_deref() {
                Some("updated") => false,
                Some("upToDate") => true,
                _ => return Err(invalid()),
            },
            _ => return Err(invalid()),
        };
        if reused {
            work.possible_commit = None;
        } else {
            work.checking_installed = true;
        }
        self.work_stage(&mut work.phase, Stage::CheckingInstalled);
        let version = self
            .command(unix.command("lazysh-agent --version")?)
            .await?;
        if version.trim() != format!("lazysh-agent {}", selection.version) {
            return Err(invalid());
        }
        Ok(result(
            if reused { "reused" } else { "installed" },
            &selection.version,
            &destination,
            None,
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
        let result = last_result(
            b"{\"schemaVersion\":1,\"event\":\"result\",\"exitCode\":22,\"outcome\":\"failed\",\"error\":{\"kind\":\"verificationFailed\",\"detail\":\"digestMismatch\"}}\n",
        )
        .unwrap();
        assert_eq!(result.exit_code, Some(22));
        assert_eq!(
            result.error.unwrap().detail.as_deref(),
            Some("digestMismatch")
        );
        assert!(last_result(
            b"{\"schemaVersion\":1,\"event\":\"stage\",\"stage\":\"verifying\"}\n"
        )
        .is_none());
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
                last_result(stdout.as_bytes()),
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
