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
}
fn execute(cli: Cli) -> lazysh_agent::Result<()> {
    let output = match cli.command {
        Command::ClaudeConfig => Some(lazysh_agent::claude_config()),
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
            eprintln!(
                "lazysh-agent: {}: invalid event or unavailable local state",
                error.class()
            );
            std::process::ExitCode::FAILURE
        }
    }
}
