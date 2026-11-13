//! `lazysh-agent update`: check for, install, dry-run and roll back the managed companion.
//!
//! Output contract and exit codes: docs/reference/companion-update.md.
// Installing exists where there is a managed directory to install into; elsewhere only `--check` and
// `--status` exist, and the rest of this module is not reached.
#![cfg_attr(not(any(unix, windows)), allow(dead_code))]
use clap::{Args as ClapArgs, ValueEnum};
use lazysh_companion_release::{version, Config, Publisher, Selection, Which, MAX_BINARY};
use report::{Failure, Fault, Latest, Output, Report};
use serde_json::{json, Value};
use std::{io::IsTerminal, process::ExitCode, time::Duration};

mod current;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod install;
mod process;
mod report;
mod selftest;
mod staging;
mod state;
// Descriptor-relative operations on Linux and macOS; plain paths on Windows. Under test the path
// version also runs on Unix, where its logic can be exercised without a Windows host.
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod store;
#[cfg(any(windows, test))]
#[path = "store_windows.rs"]
#[cfg_attr(not(windows), allow(dead_code))]
mod store_path;
#[cfg(windows)]
use store_path as store;

#[derive(Clone, Copy, ValueEnum)]
enum Channel {
    /// The release GitHub marks latest.
    Stable,
    /// The highest version that is not a draft.
    Prerelease,
}
#[derive(ClapArgs)]
#[command(group(clap::ArgGroup::new("mode").multiple(false).args(["check", "dry_run", "rollback", "status"])))]
pub struct Args {
    /// Resolve the latest release and report; changes nothing. Exits 10 when an update is available.
    #[arg(long)]
    check: bool,
    /// Download, verify and self-test the release in private staging, then delete everything.
    #[arg(long)]
    dry_run: bool,
    /// Reinstall the kept previous companion through the same verified replace.
    #[arg(long)]
    rollback: bool,
    /// Report the installed companion and the last recorded operations, offline.
    #[arg(long)]
    status: bool,
    /// An exact release `X.Y.Z` instead of the latest.
    #[arg(long, value_parser = parse_version, conflicts_with_all = ["rollback", "status"])]
    version: Option<String>,
    /// Allow `--version` to name a release older than the installed one.
    #[arg(long, requires = "version")]
    allow_downgrade: bool,
    /// Defaults to stable.
    #[arg(long, value_enum, conflicts_with_all = ["rollback", "status"])]
    channel: Option<Channel>,
    /// The caller's SHA-256 of the release asset; the release must match it exactly.
    #[arg(long, value_parser = parse_sha256, requires_all = ["expect_bytes", "version"])]
    expect_sha256: Option<String>,
    /// The caller's byte count of the release asset; the release must match it exactly.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=MAX_BINARY), requires = "expect_sha256")]
    expect_bytes: Option<u64>,
    /// Do not ask for confirmation. Required without a terminal and with `--json`.
    #[arg(long, conflicts_with_all = ["check", "status"])]
    yes: bool,
    /// Newline-delimited JSON progress events and a final result object.
    #[arg(long)]
    json: bool,
}
fn parse_version(value: &str) -> Result<String, String> {
    version(value)
        .map(|_| value.to_owned())
        .ok_or_else(|| "expected X.Y.Z".to_owned())
}
fn parse_sha256(value: &str) -> Result<String, String> {
    lazysh_common::valid_sha256(value)
        .then(|| value.to_owned())
        .ok_or_else(|| "expected 64 lowercase hex digits".to_owned())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Check,
    DryRun,
    Rollback,
    Status,
    Install,
}
impl Mode {
    fn action(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::DryRun => "dryRun",
            Self::Rollback => "rollback",
            Self::Status => "status",
            Self::Install => "update",
        }
    }
}
impl Args {
    fn mode(&self) -> Mode {
        match (self.check, self.dry_run, self.rollback, self.status) {
            (true, ..) => Mode::Check,
            (_, true, ..) => Mode::DryRun,
            (_, _, true, _) => Mode::Rollback,
            (.., true) => Mode::Status,
            _ => Mode::Install,
        }
    }
}

#[cfg(feature = "update-test-endpoint")]
fn publisher(config: Config) -> lazysh_companion_release::Result<Publisher> {
    use lazysh_companion_release::Endpoint;
    // Tests only: the endpoint override is compiled out of every shipped build.
    match (
        std::env::var("LAZYSH_UPDATE_TEST_ENDPOINT"),
        std::env::var_os("LAZYSH_UPDATE_TEST_CA"),
    ) {
        (Ok(api), Some(ca)) => Publisher::with_endpoint(
            config,
            Endpoint {
                api,
                ca_pem: std::fs::read(ca)
                    .map_err(|_| lazysh_companion_release::Error::unavailable())?,
            },
        ),
        _ => Publisher::new(config),
    }
}
#[cfg(not(feature = "update-test-endpoint"))]
fn publisher(config: Config) -> lazysh_companion_release::Result<Publisher> {
    Publisher::new(config)
}

/// The release the arguments ask for, verified, and which channel it came from.
struct Resolved {
    publisher: Publisher,
    selection: Selection,
    channel: &'static str,
}
async fn resolve(args: &Args, mode: Mode, output: &Output) -> Result<Resolved, Fault> {
    let target = current::target().ok_or(Failure::UnsafeInstallLocation)?;
    output.stage("resolving");
    // A download is bounded by the whole-request limit too, so it gets room an 11 MB body needs.
    let download = matches!(mode, Mode::Install | Mode::DryRun);
    let publisher = publisher(Config {
        user_agent: format!("lazysh-agent/{}", env!("CARGO_PKG_VERSION")),
        env_proxy: true,
        timeout: Duration::from_secs(if download { 600 } else { 60 }),
        idle_timeout: Some(Duration::from_secs(30)),
    })?;
    let (channel, prerelease) = match args.channel {
        Some(Channel::Prerelease) => ("prerelease", true),
        _ => ("stable", false),
    };
    let which = match (&args.version, prerelease) {
        (Some(version), _) => Which::Tag {
            version,
            prerelease,
        },
        (None, true) => Which::Highest,
        (None, false) => Which::Stable,
    };
    let selection = publisher.select(target, which).await?;
    // The caller's pin is a second opinion: the host's own resolution must agree with it.
    if args
        .expect_sha256
        .as_ref()
        .is_some_and(|pin| *pin != selection.digest)
        || args.expect_bytes.is_some_and(|pin| pin != selection.bytes)
    {
        return Err(Fault::detail(Failure::VerificationFailed, "pinMismatch"));
    }
    Ok(Resolved {
        publisher,
        selection,
        channel,
    })
}
impl Resolved {
    fn latest(&self) -> Latest {
        let selection = &self.selection;
        Latest {
            version: selection.version.clone(),
            channel: self.channel,
            target: selection.target.clone(),
            tag: selection.tag.clone(),
            commit: selection.sha.clone(),
            asset: selection.asset_name.clone(),
            bytes: selection.bytes,
            sha256: selection.digest.clone(),
        }
    }
}

/// How the resolved release compares with what is installed.
#[derive(PartialEq, Eq)]
enum Standing {
    /// A different version could be installed (newer, or older with `--allow-downgrade`).
    Differs,
    Same,
}
fn compare(args: &Args, installed: Option<&str>, wanted: &str) -> Result<Standing, Fault> {
    let (wanted, have) = (version(wanted), installed.and_then(version));
    Ok(match (wanted, have) {
        // A development build that cannot name its version is replaced by any release.
        (_, None) => Standing::Differs,
        (wanted, have) if wanted > have => Standing::Differs,
        (wanted, have) if wanted == have => Standing::Same,
        // The installed one is newer: the latest release is not an update, a named one is a downgrade.
        _ if args.allow_downgrade => Standing::Differs,
        _ if args.version.is_some() => return Err(Failure::DowngradeRefused.into()),
        _ => Standing::Same,
    })
}

async fn check(args: &Args, output: &Output, report: &mut Report) -> Result<bool, Fault> {
    let resolved = resolve(args, Mode::Check, output).await?;
    let installed = current::detect()?;
    report.latest = Some(resolved.latest());
    let standing = compare(
        args,
        installed.version.as_deref(),
        &resolved.selection.version,
    );
    report.current = Some(installed);
    let available = standing? == Standing::Differs;
    report.outcome = if available { "available" } else { "upToDate" };
    Ok(available)
}

fn status(report: &mut Report) -> Result<(), Fault> {
    let installed = current::detect()?;
    let state = state::State::read(&crate::state_directory()?);
    // A previous version is only real while its file is still there.
    let previous = state.previous.filter(|_| {
        std::fs::symlink_metadata(
            current::managed_directory()
                .unwrap_or_default()
                .join(format!("{}.previous", current::NAME)),
        )
        .is_ok_and(|metadata| metadata.is_file())
    });
    report.outcome = "status";
    report.current = Some(installed);
    report.previous = previous.map(|p| json!({"version":p.version,"sha256":p.sha256}));
    report.history = Some((
        state.last_check.unwrap_or(Value::Null),
        state.last_operation.unwrap_or(Value::Null),
    ));
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod install {
    use super::*;
    pub async fn run(_: &Args, _: Mode, _: &Output, _: &mut Report) -> Result<(), Fault> {
        Err(Failure::UnsafeInstallLocation.into())
    }
}

/// A mutation needs an explicit yes: `--yes`, or an answer at a terminal. Nothing is asked without one.
fn usage_error(args: &Args, mode: Mode) -> Option<&'static str> {
    let mutation = matches!(mode, Mode::Install | Mode::Rollback);
    (mutation && !args.yes && (args.json || !std::io::stdin().is_terminal())).then_some(
        "--yes is required to change the installed companion without a terminal or with --json",
    )
}
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn confirmed(question: &str) -> bool {
    use std::io::{BufRead, Write};
    let _ = write!(std::io::stderr(), "{question} [y/N] ");
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer).is_ok()
        && matches!(answer.trim(), "y" | "Y" | "yes")
}

pub fn run(args: Args) -> ExitCode {
    let output = Output::new(args.json);
    let mode = args.mode();
    if let Some(message) = usage_error(&args, mode) {
        // The same status clap gives for a bad flag, and an older companion for an unknown subcommand.
        let _ = std::io::Write::write_all(
            &mut std::io::stderr(),
            format!("lazysh-agent: update: {message}\n").as_bytes(),
        );
        return ExitCode::from(2);
    }
    let mut report = Report::new(mode.action());
    let mut available = false;
    let outcome = match mode {
        Mode::Status => status(&mut report),
        _ => match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime.block_on(async {
                if mode == Mode::Check {
                    available = check(&args, &output, &mut report).await?;
                    Ok(())
                } else {
                    install::run(&args, mode, &output, &mut report).await
                }
            }),
            Err(_) => Err(Failure::Internal.into()),
        },
    };
    if let Err(fault) = outcome {
        report.fail(fault);
    }
    output.finish(report, available)
}
