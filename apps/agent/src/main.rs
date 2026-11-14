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
/// Which part of a conversation to read; the newest messages when none is given.
#[derive(clap::Args, Default)]
struct WindowArgs {
    /// The messages just before the one with this id.
    #[arg(long, conflicts_with_all = ["after", "from_start"])]
    before: Option<String>,
    /// The messages just after the one with this id.
    #[arg(long, conflicts_with = "from_start")]
    after: Option<String>,
    /// The first messages of the session.
    #[arg(long)]
    from_start: bool,
}
impl WindowArgs {
    fn window(self) -> lazysh_agent::transcript::window::Window {
        use lazysh_agent::transcript::window::Window;
        match (self.before, self.after, self.from_start) {
            (Some(id), _, _) => Window::Before(id),
            (_, Some(id), _) => Window::After(id),
            (_, _, true) => Window::Start,
            _ => Window::Tail,
        }
    }
}

#[derive(Subcommand)]
enum Command {
    /// Print the exact retained third-party licenses and attribution notices.
    Licenses,
    /// Check whether a newer verified companion release exists, or show the installed one.
    Update(lazysh_agent::update::Args),
    /// Inspect or explicitly install this verified binary into its managed user namespace.
    Installation {
        #[command(subcommand)]
        command: lazysh_agent::installation::Command,
    },
    /// Preview and explicitly manage packaged product skills for an existing agent profile.
    Skills {
        #[command(subcommand)]
        command: lazysh_agent::skills::Command,
    },
    /// Inspect and explicitly manage lifecycle hooks in an existing selected profile.
    Hooks {
        #[command(subcommand)]
        command: lazysh_agent::hook_setup::Command,
    },
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
    /// Read live account quotas using the built-in collectors or compatible ai-usagebar.
    AccountUsage {
        /// Stop when this private command channel closes its input.
        #[arg(long)]
        watch_channel: bool,
    },
    /// Focus an exact stock Herdr pane; focus is shared with other clients.
    HerdrFocusPane {
        #[arg(long)]
        session: String,
        #[arg(long)]
        pane: String,
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
    /// List TCP listeners on loopback or a wildcard address, to confirm a sign-in callback.
    Listeners(lazysh_agent::listeners::Options),
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
    /// Developer prototype: start a throwaway Chrome-family browser with a random loopback debug port
    /// and stop it when stdin closes. Needs LAZYSH_DEV_HOST_BROWSER=1; see docs/host-browser.md.
    #[command(hide = true)]
    HostBrowser {
        #[arg(long)]
        binary: Option<std::path::PathBuf>,
        /// Exact origin allowed to open the debug WebSocket; repeatable, never a wildcard.
        #[arg(long)]
        allow_origin: Vec<String>,
        /// First page to open: http, https or about:blank.
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        headed: bool,
        /// Pass --no-sandbox, for containers and CI runners that cannot create a sandbox.
        #[arg(long)]
        no_sandbox: bool,
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
        /// Allow with this suggested permission update of the listed request (its `options` index).
        #[arg(long, value_parser=clap::value_parser!(u8).range(0..8))]
        option: Option<u8>,
        /// Deny with this message, which the agent reads.
        #[arg(long)]
        message: Option<String>,
    },
    /// Print an opt-in configuration fragment; never changes Claude settings.
    ApprovalConfig,
    /// Read one lifecycle event from stdin.
    Ingest {
        #[arg(long, value_enum)]
        agent: Agent,
        #[arg(long)]
        reported_history: bool,
    },
    /// Print a bounded JSON status snapshot.
    Snapshot {
        #[arg(long,default_value_t=50,value_parser=clap::value_parser!(u8).range(1..=100))]
        limit: u8,
    },
    /// Print a configuration fragment; never changes agent settings.
    ClaudeConfig {
        #[arg(long)]
        reported_history: bool,
    },
    /// Print a Codex hook fragment; never changes settings or hook trust.
    CodexConfig {
        #[arg(long)]
        reported_history: bool,
    },
    /// Print a Gemini hook fragment; never changes settings.
    GeminiConfig,
    /// Print a standalone Droid hooks.json fragment; never changes settings.
    DroidConfig,
    /// Print legacy Kimi CLI 1.52 TOML hooks; never changes settings. Kimi Code 2.4 lifecycle is unqualified.
    KimiConfig,
    /// Print a Copilot CLI hook fragment; never changes settings.
    CopilotConfig,
    /// Print Cursor observation hooks; never changes profiles or permission policy.
    CursorConfig,
    /// Print an Amp native state-observer plugin; never installs it.
    AmpPlugin,
    /// Print a root-only Cline runtime plugin; never installs or changes policy.
    ClinePlugin,
    /// Print native Aider callback arguments and their capability limits.
    AiderConfig,
    /// Record aggregate native Aider input-boundary notification health; reads no stdin.
    AiderNotification,
    /// Read aggregate Aider callback health, never agent session lifecycle state.
    AiderHookStatus,
    /// Print an OpenCode plugin asset; never installs it.
    OpencodePlugin,
    /// Read a hook-reported Claude source hint, never live input authority.
    ReportedHistory {
        #[arg(long)]
        session_id: String,
    },
    /// List transcript metadata from the agent's local session directory.
    Discover {
        #[arg(long, value_enum)]
        agent: lazysh_agent::transcript::TranscriptAgent,
        #[arg(long)]
        root: Option<std::path::PathBuf>,
        #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u8).range(1..=100))]
        limit: u8,
    },
    /// List the earlier Claude Code or Codex sessions of one folder, newest first.
    History {
        #[arg(long, value_enum)]
        agent: lazysh_agent::transcript::TranscriptAgent,
        #[arg(long)]
        folder: String,
        #[arg(long)]
        root: Option<std::path::PathBuf>,
        #[arg(long, default_value_t=30, value_parser=clap::value_parser!(u8).range(1..=100))]
        limit: u8,
    },
    /// Read one uniquely identified provider session from its managed root.
    HerdrConversation {
        #[arg(long, value_enum)]
        agent: lazysh_agent::transcript::TranscriptAgent,
        #[arg(long)]
        session_id: String,
        #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u8).range(1..=100))]
        limit: u8,
        #[command(flatten)]
        window: WindowArgs,
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
        /// Admit bounded static PNG/JPEG previews (Grok/Codex Records or Claude user images).
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
        /// Conversation view only: read before or after a message instead of the newest ones.
        #[command(flatten)]
        window: WindowArgs,
    },
    /// Stream upserts of one Claude Code or Codex conversation until stdin closes.
    TranscriptWatch {
        #[arg(long, value_enum)]
        agent: lazysh_agent::transcript::TranscriptAgent,
        /// A transcript file, as `transcript --view conversation` reads it.
        #[arg(
            long,
            conflicts_with = "session_id",
            required_unless_present = "session_id"
        )]
        path: Option<std::path::PathBuf>,
        /// A provider session id resolved inside the agent's own data root.
        #[arg(long)]
        session_id: Option<String>,
        #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u8).range(1..=100))]
        limit: u8,
        #[arg(long, default_value_t=250, value_parser=clap::value_parser!(u64).range(50..=5000))]
        interval_ms: u64,
        /// Frame vocabulary version; only 1 exists.
        #[arg(long, default_value_t=1, value_parser=clap::value_parser!(u8).range(1..=1))]
        protocol: u8,
        /// Carry the bounded PNG/JPEG previews of the images a user attached; only with `--path`.
        #[arg(long, requires = "path")]
        inline_images: bool,
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
        Command::Discover { .. } | Command::History { .. } | Command::ReportedHistory { .. } => {
            Some(lazysh_agent::settings::Operation::TranscriptDiscovery)
        }
        Command::Usage { .. } => Some(lazysh_agent::settings::Operation::RecordedUsage),
        Command::Devices { .. } => Some(lazysh_agent::settings::Operation::DeviceTools),
        _ => None,
    };
    if let Some(operation) = operation {
        lazysh_agent::settings::read(&lazysh_agent::state_directory()?)?.check(operation)?;
    }
    let output = match cli.command {
        Command::HerdrFocusPane { session, pane } => {
            Some(lazysh_agent::herdr::focus_pane(&session, &pane)?)
        }
        Command::Licenses => Some(serde_json::json!({
            "schemaVersion": 1,
            "notices": [
                {"id": "ai-usagebar", "text": include_str!("../../../packages/ai-usagebar-vendor/LICENSE")},
                {"id": "account-usage-adapter", "text": include_str!("../../../packages/account-usage/NOTICE")},
                {"id": "herdr-apache", "text": include_str!("../../../packages/account-usage/licenses/HERDR-APACHE-2.0.txt")},
            ],
        })),
        Command::Update(_) => return Err(Error::InvalidArgument),
        Command::Installation { command } => Some(lazysh_agent::installation::run(command)?),
        Command::Skills { command } => Some(lazysh_agent::skills::run(command)?),
        Command::Hooks { command } => Some(lazysh_agent::hook_setup::run(command)?),
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
        Command::AccountUsage { watch_channel } => Some(
            serde_json::to_value(lazysh_agent::account_usage::run(watch_channel)?)
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
        Command::HostBrowser {
            binary,
            allow_origin,
            url,
            headed,
            no_sandbox,
        } => {
            lazysh_agent::host_browser::run(&lazysh_agent::host_browser::Launch {
                binary: binary.as_deref(),
                allow_origins: &allow_origin,
                url: url.as_deref(),
                headed,
                no_sandbox,
            })?;
            None
        }
        Command::Listeners(options) => lazysh_agent::listeners::run(&options)?,
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
            option,
            message,
        } => Some(lazysh_agent::approvals::resolve(
            &lazysh_agent::state_directory()?,
            &id,
            &expected_hash,
            &session_id,
            pane_id.as_deref(),
            lazysh_agent::approvals::Answer {
                decision,
                option,
                message: message.as_deref(),
            },
        )?),
        Command::ClaudeConfig { reported_history } => Some(if reported_history {
            lazysh_agent::reported_history::claude_config()
        } else {
            lazysh_agent::claude_config()
        }),
        Command::CodexConfig { reported_history } => Some(if reported_history {
            lazysh_agent::reported_history::codex_config()
        } else {
            lazysh_agent::hooks::codex_config()
        }),
        Command::GeminiConfig => Some(lazysh_agent::hooks::gemini_config()),
        Command::DroidConfig => Some(lazysh_agent::hooks::droid_config()),
        Command::KimiConfig => Some(lazysh_agent::hooks::kimi_config()),
        Command::CopilotConfig => Some(lazysh_agent::hooks::copilot_config()),
        Command::CursorConfig => Some(lazysh_agent::hooks::cursor_config()),
        Command::AmpPlugin => Some(lazysh_agent::hooks::amp_plugin()),
        Command::ClinePlugin => Some(lazysh_agent::hooks::cline_plugin()),
        Command::AiderConfig => Some(lazysh_agent::hooks::aider_config()),
        Command::AiderNotification => {
            Store::open(&lazysh_agent::state_directory()?)?
                .record_aider_notification(chrono::Utc::now())?;
            None
        }
        Command::AiderHookStatus => {
            Some(Store::open(&lazysh_agent::state_directory()?)?.aider_hook_status()?)
        }
        Command::OpencodePlugin => Some(lazysh_agent::hooks::opencode_plugin()),
        Command::ReportedHistory { session_id } => Some(
            Store::open(&lazysh_agent::state_directory()?)?
                .reported_history(&session_id, chrono::Utc::now())?,
        ),
        Command::Discover { agent, root, limit } => Some(
            serde_json::to_value(lazysh_agent::transcript::discover(
                agent,
                root.as_deref(),
                limit,
            )?)
            .map_err(|_| Error::InvalidEvent)?,
        ),
        Command::History {
            agent,
            folder,
            root,
            limit,
        } => Some(lazysh_agent::transcript::history(
            agent,
            root.as_deref(),
            &folder,
            limit,
        )?),
        Command::HerdrConversation {
            agent,
            session_id,
            limit,
            window,
        } => Some(
            serde_json::to_value(lazysh_agent::transcript::read_herdr_conversation_window(
                agent,
                &session_id,
                limit,
                &window.window(),
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
            window,
        } => {
            let window = window.window();
            if window != lazysh_agent::transcript::window::Window::Tail
                && !matches!(view, lazysh_agent::transcript::TranscriptView::Conversation)
            {
                return Err(Error::InvalidArgument);
            }
            if checkpointed
                && (!matches!(agent, lazysh_agent::transcript::TranscriptAgent::GrokAcp)
                    || !matches!(view, lazysh_agent::transcript::TranscriptView::Records)
                    || session_id.is_some())
            {
                return Err(Error::InvalidArgument);
            }
            if inline_images
                && (session_id.is_some()
                    || !(matches!(
                        agent,
                        lazysh_agent::transcript::TranscriptAgent::Claude
                            | lazysh_agent::transcript::TranscriptAgent::Codex
                    ) || (matches!(
                        agent,
                        lazysh_agent::transcript::TranscriptAgent::GrokAcp
                    ) && matches!(
                        view,
                        lazysh_agent::transcript::TranscriptView::Records
                    ))))
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
                        if matches!(agent, lazysh_agent::transcript::TranscriptAgent::Opencode) {
                            lazysh_agent::transcript::opencode_conversation_window(
                                &path,
                                session_id.as_deref().ok_or(Error::InvalidArgument)?,
                                limit,
                                &window,
                            )?
                        } else {
                            lazysh_agent::transcript::conversation_window(
                                &path,
                                agent,
                                limit,
                                inline_images,
                                &window,
                            )?
                        }
                    }
                })
                .map_err(|_| Error::InvalidEvent)?,
            )
        }
        Command::TranscriptWatch {
            agent,
            path,
            session_id,
            limit,
            interval_ms,
            protocol: _,
            inline_images,
        } => {
            lazysh_agent::transcript::watch::run_stdio(lazysh_agent::transcript::watch::Options {
                agent,
                path,
                session_id,
                limit,
                interval: std::time::Duration::from_millis(interval_ms),
                inline_images,
            })?;
            None
        }
        Command::Ingest {
            agent,
            reported_history,
        } => {
            let pane = lazysh_agent::pane_identity();
            if reported_history {
                let (event, source) = lazysh_agent::reported_history::read_hook(
                    io::stdin().lock(),
                    agent,
                    pane.as_deref(),
                )?;
                if event.is_some() || source.is_some() {
                    Store::open(&lazysh_agent::state_directory()?)?.ingest_with_reported_history(
                        event.as_ref(),
                        source.as_ref(),
                        chrono::Utc::now(),
                    )?;
                }
            } else if let Some(event) =
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
    if let Some(code) = lazysh_account_usage::worker_main() {
        return code;
    }
    let cli = Cli::parse();
    if let Command::Update(args) = cli.command {
        return lazysh_agent::update::run(args);
    }
    match execute(cli) {
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
