use clap::{Parser, Subcommand};
use lazysh_agent::{Agent, Error, Store};
use std::io::{self, Write};

#[derive(Parser)]
#[command(
    version,
    about = "Bounded local agent status snapshots. No server or approval injection."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Inspect reported token counters in one bounded transcript window.
    Usage {
        #[arg(long, value_enum)]
        agent: lazysh_agent::transcript::TranscriptAgent,
        #[arg(long)]
        path: std::path::PathBuf,
        #[arg(long)]
        session_id: Option<String>,
        #[arg(long, default_value_t = 0)]
        offset: u64,
    },
    /// Inspect and explicitly control host Android devices or iOS Simulators.
    Devices {
        #[command(subcommand)]
        command: lazysh_agent::devices::DeviceCommand,
    },
    /// Wait for a decision for this exact originating Claude permission hook.
    ApprovalRequest {
        #[arg(long, value_enum)]
        agent: lazysh_agent::approvals::ApprovalAgent,
        #[arg(long, default_value_t=300, value_parser=clap::value_parser!(u16).range(1..=600))]
        timeout_seconds: u16,
    },
    /// Print live, bounded permission requests.
    ApprovalList {
        #[arg(long, default_value_t=20, value_parser=clap::value_parser!(u8).range(1..=20))]
        limit: u8,
    },
    /// Resolve an exact immutable request once.
    ApprovalResolve {
        #[arg(long)]
        id: String,
        #[arg(long)]
        expected_hash: String,
        #[arg(long)]
        session_id: String,
        #[arg(long)]
        pane_id: Option<String>,
        #[arg(long, value_enum)]
        decision: lazysh_agent::approvals::Decision,
    },
    /// Print an opt-in configuration fragment; never changes Claude settings.
    ApprovalConfig,
    /// Read one lifecycle event from stdin.
    Ingest {
        #[arg(long, value_enum)]
        agent: Agent,
    },
    /// Print a bounded JSON status snapshot.
    Snapshot {
        #[arg(long,default_value_t=50,value_parser=clap::value_parser!(u8).range(1..=100))]
        limit: u8,
    },
    /// Print a configuration fragment; never changes agent settings.
    ClaudeConfig,
    /// List transcript metadata from the agent's local session directory.
    Discover {
        #[arg(long, value_enum)]
        agent: lazysh_agent::transcript::TranscriptAgent,
        #[arg(long)]
        root: Option<std::path::PathBuf>,
        #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u8).range(1..=100))]
        limit: u8,
    },
    /// Read a bounded page of transcript records without starting an agent.
    Transcript {
        #[arg(long, value_enum)]
        agent: lazysh_agent::transcript::TranscriptAgent,
        #[arg(long)]
        path: std::path::PathBuf,
        #[arg(long)]
        session_id: Option<String>,
        #[arg(long, default_value_t = 0)]
        offset: u64,
        #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u8).range(1..=100))]
        limit: u8,
        #[arg(long, value_enum, default_value_t = lazysh_agent::transcript::TranscriptView::Records)]
        view: lazysh_agent::transcript::TranscriptView,
    },
}
fn execute(cli: Cli) -> lazysh_agent::Result<()> {
    let output = match cli.command {
        Command::Usage {
            agent,
            path,
            session_id,
            offset,
        } => Some(
            serde_json::to_value(lazysh_agent::usage::read(
                &path,
                agent,
                session_id.as_deref(),
                offset,
            )?)
            .map_err(|_| Error::InvalidEvent)?,
        ),
        Command::Devices { command } => Some(lazysh_agent::devices::run(command)?),
        Command::ApprovalConfig => Some(lazysh_agent::approvals::config()),
        Command::ApprovalRequest {
            agent,
            timeout_seconds,
        } => Some(lazysh_agent::approvals::request(
            &lazysh_agent::state_directory()?,
            io::stdin().lock(),
            agent,
            std::env::var("TMUX_PANE").ok().as_deref(),
            timeout_seconds,
        )?),
        Command::ApprovalList { limit } => Some(lazysh_agent::approvals::list(
            &lazysh_agent::state_directory()?,
            limit,
        )?),
        Command::ApprovalResolve {
            id,
            expected_hash,
            session_id,
            pane_id,
            decision,
        } => Some(lazysh_agent::approvals::resolve(
            &lazysh_agent::state_directory()?,
            &id,
            &expected_hash,
            &session_id,
            pane_id.as_deref(),
            decision,
        )?),
        Command::ClaudeConfig => Some(lazysh_agent::claude_config()),
        Command::Discover { agent, root, limit } => Some(
            serde_json::to_value(lazysh_agent::transcript::discover(
                agent,
                root.as_deref(),
                limit,
            )?)
            .map_err(|_| Error::InvalidEvent)?,
        ),
        Command::Transcript {
            agent,
            path,
            session_id,
            offset,
            limit,
            view,
        } => Some(
            serde_json::to_value(match view {
                lazysh_agent::transcript::TranscriptView::Records => match agent {
                    lazysh_agent::transcript::TranscriptAgent::Hermes
                    | lazysh_agent::transcript::TranscriptAgent::Opencode => {
                        lazysh_agent::transcript::read_database_page(
                            &path,
                            agent,
                            session_id.as_deref().ok_or(Error::InvalidArgument)?,
                            offset,
                            limit,
                        )?
                    }
                    _ => lazysh_agent::transcript::read_page(&path, agent, offset, limit)?,
                },
                lazysh_agent::transcript::TranscriptView::Conversation => {
                    if offset != 0 {
                        return Err(Error::InvalidArgument);
                    }
                    lazysh_agent::transcript::conversation(&path, agent, limit)?
                }
            })
            .map_err(|_| Error::InvalidEvent)?,
        ),
        Command::Ingest { agent } => {
            let pane = std::env::var("TMUX_PANE").ok();
            if let Some(event) =
                lazysh_agent::read_event(io::stdin().lock(), agent, pane.as_deref())?
            {
                Store::open(&lazysh_agent::state_directory()?)?
                    .ingest(&event, chrono::Utc::now())?;
            }
            None
        }
        Command::Snapshot { limit } => Some(
            serde_json::to_value(
                Store::open(&lazysh_agent::state_directory()?)?
                    .snapshot(limit, chrono::Utc::now())?,
            )
            .map_err(|_| Error::InvalidEvent)?,
        ),
    };
    if let Some(output) = output {
        let mut stdout = io::stdout().lock();
        serde_json::to_writer(&mut stdout, &output)
            .map_err(|_| Error::Io(io::Error::other("Output unavailable")))?;
        writeln!(stdout)?;
    }
    Ok(())
}
fn main() -> std::process::ExitCode {
    match execute(Cli::parse()) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("lazysh-agent: {}: operation failed", error.class());
            std::process::ExitCode::FAILURE
        }
    }
}
