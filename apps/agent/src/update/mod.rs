//! `lazysh-agent update`: find out whether a newer verified companion release exists.
//!
//! Output contract and exit codes: docs/architecture/adr-0003-host-side-companion-update.md.
use clap::{Args as ClapArgs, ValueEnum};
use lazysh_companion_release::{version, Config, Publisher, Which};
use report::{Failure, Fault, Latest, Output, Report};
use serde_json::{json, Value};
use std::{process::ExitCode, time::Duration};

mod current;
mod report;
mod state;

#[derive(Clone, Copy, ValueEnum)]
enum Channel {
    /// The release GitHub marks latest.
    Stable,
    /// The highest version that is not a draft.
    Prerelease,
}
#[derive(ClapArgs)]
#[command(group(clap::ArgGroup::new("mode").required(true).args(["check", "status"])))]
pub struct Args {
    /// Resolve the latest release and report; changes nothing. Exits 10 when an update is available.
    #[arg(long)]
    check: bool,
    /// Report the installed companion and the last recorded operations, offline.
    #[arg(long)]
    status: bool,
    /// An exact release `X.Y.Z` instead of the latest.
    #[arg(long, value_parser = parse_version, conflicts_with = "status")]
    version: Option<String>,
    /// Defaults to stable.
    #[arg(long, value_enum, conflicts_with = "status")]
    channel: Option<Channel>,
    /// Newline-delimited JSON progress events and a final result object.
    #[arg(long)]
    json: bool,
}
fn parse_version(value: &str) -> Result<String, String> {
    version(value)
        .map(|_| value.to_owned())
        .ok_or_else(|| "expected X.Y.Z".to_owned())
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

async fn check(args: &Args, output: &Output) -> Result<(Report, bool), Fault> {
    let target = current::target().ok_or(Failure::UnsafeInstallLocation)?;
    output.stage("resolving");
    let publisher = publisher(Config {
        user_agent: format!("lazysh-agent/{}", env!("CARGO_PKG_VERSION")),
        env_proxy: true,
        timeout: Duration::from_secs(60),
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
    let installed = current::detect()?;
    let wanted = version(&selection.version);
    let have = installed.version.as_deref().and_then(version);
    if args.version.is_some() && wanted < have {
        return Err(Failure::DowngradeRefused.into());
    }
    let available = have.is_none() || wanted > have;
    let report = Report {
        action: "check",
        outcome: if available { "available" } else { "upToDate" },
        current: Some(installed),
        latest: Some(Latest {
            version: selection.version,
            channel,
            target: selection.target,
            tag: selection.tag,
            commit: selection.sha,
            asset: selection.asset_name,
            bytes: selection.bytes,
            sha256: selection.digest,
        }),
        ..Report::default()
    };
    Ok((report, available))
}

fn status() -> Result<Report, Fault> {
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
    Ok(Report {
        action: "status",
        outcome: "status",
        current: Some(installed),
        previous: previous.map(|p| json!({"version":p.version,"sha256":p.sha256})),
        history: Some((
            state.last_check.unwrap_or(Value::Null),
            state.last_operation.unwrap_or(Value::Null),
        )),
        ..Report::default()
    })
}

pub fn run(args: Args) -> ExitCode {
    let output = Output::new(args.json);
    let action = if args.status { "status" } else { "check" };
    let outcome = if args.status {
        status().map(|report| (report, false))
    } else {
        match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime.block_on(check(&args, &output)),
            Err(_) => Err(Failure::Internal.into()),
        }
    };
    match outcome {
        Ok((report, available)) => output.finish(report, available),
        Err(fault) => output.finish(Report::failed(action, fault), false),
    }
}
