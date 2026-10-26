use clap::{Parser, Subcommand};
use lazysh_agent::{Agent, Error, Store};
use std::io::{self, Write};

#[derive(Parser)]
#[command(
    version,
    about = "Local lifecycle state and explicit bound relay publishing. No resident server or approval injection."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Explicit opt-in relay setup and bounded drain; never installs hooks or schedules.
    Relay {
        #[command(subcommand)]
        command: lazysh_agent::relay::RelayCommand,
    },
    /// Show host companion settings without creating state when absent.
    Settings {
        #[command(subcommand)]
        command: SettingsCommand,
    },
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
        checkpoint: Option<String>,
        /// Require a source-bound consistency receipt (Grok Records only).
        #[arg(long)]
        checkpointed: bool,
        /// Admit bounded static PNG/JPEG previews (Grok Records or Claude user images).
        #[arg(long)]
        inline_images: bool,
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
#[derive(Subcommand)]
enum SettingsCommand {
    Show,
    Update {
        #[arg(long)]
        expected_revision: u64,
        #[arg(long, action=clap::ArgAction::Set, required=true)]
        transcript_discovery_enabled: bool,
        #[arg(long, action=clap::ArgAction::Set, required=true)]
        recorded_usage_enabled: bool,
        #[arg(long, action=clap::ArgAction::Set, required=true)]
        device_tools_enabled: bool,
    },
}
fn execute(cli: Cli) -> lazysh_agent::Result<()> {
    let operation = match &cli.command {
        Command::Discover { .. } => Some(lazysh_agent::settings::Operation::TranscriptDiscovery),
        Command::Usage { .. } => Some(lazysh_agent::settings::Operation::RecordedUsage),
        Command::Devices { .. } => Some(lazysh_agent::settings::Operation::DeviceTools),
        _ => None,
    };
    if let Some(operation) = operation {
        lazysh_agent::settings::read(&lazysh_agent::state_directory()?)?.check(operation)?;
    }
    let output = match cli.command {
        Command::Relay { command } => Some(lazysh_agent::relay::run(
            command,
            &lazysh_agent::state_directory()?,
        )?),
        Command::Settings { command } => {
            let directory = lazysh_agent::state_directory()?;
            let settings = match command {
                SettingsCommand::Show => lazysh_agent::settings::read(&directory)?,
                SettingsCommand::Update {
                    expected_revision,
                    transcript_discovery_enabled,
                    recorded_usage_enabled,
                    device_tools_enabled,
                } => lazysh_agent::settings::update(
                    &directory,
                    expected_revision,
                    transcript_discovery_enabled,
                    recorded_usage_enabled,
                    device_tools_enabled,
                )?,
            };
            Some(serde_json::to_value(settings).map_err(|_| Error::InvalidEvent)?)
        }
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
        Command::Devices { command } => {
            if let lazysh_agent::devices::DeviceCommand::Android {
                id,
                action: lazysh_agent::devices::android::AndroidAction::Stream,
            } = command
            {
                lazysh_agent::devices::android::stream(&id)?;
                None
            } else if let lazysh_agent::devices::DeviceCommand::Ios {
                id,
                socket,
                action: lazysh_agent::devices::idb::IosAction::Stream,
            } = command
            {
                lazysh_agent::devices::idb::stream(&id, &socket)?;
                None
            } else {
                Some(lazysh_agent::devices::run(command)?)
            }
        }
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
            checkpoint,
            checkpointed,
            inline_images,
            session_id,
            offset,
            limit,
            view,
        } => {
            if checkpointed
                && (!matches!(agent, lazysh_agent::transcript::TranscriptAgent::GrokAcp)
                    || !matches!(view, lazysh_agent::transcript::TranscriptView::Records)
                    || session_id.is_some())
            {
                return Err(Error::InvalidArgument);
            }
            if inline_images
                && (session_id.is_some()
                    || !(matches!(agent, lazysh_agent::transcript::TranscriptAgent::Claude)
                        || (matches!(agent, lazysh_agent::transcript::TranscriptAgent::GrokAcp)
                            && matches!(view, lazysh_agent::transcript::TranscriptView::Records))))
            {
                return Err(Error::InvalidArgument);
            }
            if !checkpointed
                && checkpoint.is_some()
                && !matches!(
                    agent,
                    lazysh_agent::transcript::TranscriptAgent::AntigravityJsonl
                )
            {
                return Err(Error::InvalidArgument);
            }
            Some(
                serde_json::to_value(match view {
                    lazysh_agent::transcript::TranscriptView::Records if inline_images => {
                        lazysh_agent::transcript::read_inline_images(
                            &path,
                            agent,
                            offset,
                            limit,
                            checkpointed,
                            checkpoint.as_deref(),
                        )?
                    }
                    lazysh_agent::transcript::TranscriptView::Records if checkpointed => {
                        lazysh_agent::transcript::read_checkpointed_grok(
                            &path,
                            offset,
                            limit,
                            checkpoint.as_deref(),
                        )?
                    }
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
                        _ => lazysh_agent::transcript::read_page_with_checkpoint(
                            &path,
                            agent,
                            offset,
                            limit,
                            checkpoint.as_deref(),
                        )?,
                    },
                    lazysh_agent::transcript::TranscriptView::Conversation => {
                        if offset != 0 || checkpoint.is_some() {
                            return Err(Error::InvalidArgument);
                        }
                        if inline_images {
                            lazysh_agent::transcript::claude_conversation_images(&path, limit)?
                        } else {
                            lazysh_agent::transcript::conversation(&path, agent, limit)?
                        }
                    }
                })
                .map_err(|_| Error::InvalidEvent)?,
            )
        }
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
            // SQLite messages may contain paths or user-controlled schema names.
            // Keep diagnostics numeric so contention can be distinguished from I/O
            // and malformed storage without printing any database content.
            if let Error::Storage(rusqlite::Error::SqliteFailure(code, _)) = &error {
                eprintln!(
                    "lazysh-agent: {}: operation failed (sqlite_code={})",
                    error.class(),
                    code.extended_code
                );
            } else {
                eprintln!("lazysh-agent: {}: operation failed", error.class());
            }
            std::process::ExitCode::FAILURE
        }
    }
}
