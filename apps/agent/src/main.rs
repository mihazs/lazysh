use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
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
#[derive(Clone, Copy, clap::ValueEnum)]
enum KimiDialect {
    #[value(name = "legacy-1.52")]
    Legacy,
    #[value(name = "kimi-code-2.4")]
    KimiCode24,
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
    /// Whether this companion updates itself when a newer lazysh app connects.
    AutoUpdate {
        #[command(subcommand)]
        command: lazysh_agent::auto_update::Command,
    },
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
    /// Show or change whether this host may read account quotas, without creating state when absent.
    UsageCollection {
        #[command(subcommand)]
        command: UsageCollectionCommand,
    },
    /// Record account quota samples on a timer while no app is open (off until you enable it).
    UsageCollector {
        #[command(subcommand)]
        command: lazysh_agent::usage_collector::Command,
    },
    /// Open a URL on the attached device, or with the next real opener (what the managed
    /// `xdg-open` and `lazysh-open` wrappers run).
    BrowserOpen {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<std::ffi::OsString>,
    },
    /// Stream browser-open requests of host programs to the app; ends when stdin closes.
    BrowserWatch {
        /// Frame version; an older companion answers an unknown option with exit status 2.
        #[arg(long, value_parser = clap::value_parser!(u8).range(1..=1))]
        protocol: u8,
        #[arg(long, hide = true, default_value_t = 15, value_parser = clap::value_parser!(u64).range(1..=60))]
        heartbeat_seconds: u64,
    },
    /// Install, inspect or remove the host browser shim (off until you install it).
    BrowserShim(lazysh_agent::browser::ShimArgs),
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
    /// Type into one named stock Herdr pane through a retained, pinned server epoch; JSON lines on stdin and stdout.
    HerdrPaneInput {
        #[arg(long)]
        session: String,
    },
    /// Stream the agent-status changes of one Herdr server until stdin closes.
    HerdrEvents {
        #[arg(long)]
        session: String,
        /// Frame vocabulary version; only 1 exists.
        #[arg(long, default_value_t=1, value_parser=clap::value_parser!(u8).range(1..=1))]
        protocol: u8,
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
    /// Review a repository: its changed files and the diff of one file. Read-only.
    Review(lazysh_agent::review::Arguments),
    /// Inspect and explicitly control host Android devices or iOS Simulators.
    Devices {
        #[command(subcommand)]
        command: lazysh_agent::devices::DeviceCommand,
    },
    /// Wait for a decision for this exact originating Claude Code, Codex or Copilot permission hook.
    ApprovalRequest {
        #[arg(long, value_enum)]
        agent: lazysh_agent::approvals::ApprovalAgent,
        #[arg(long, default_value_t=300, value_parser=clap::value_parser!(u16).range(1..=600))]
        timeout_seconds: u16,
    },
    /// Developer prototype: start a throwaway Chrome-family browser with a random loopback debug port
    /// and stop it when stdin closes. Needs the host browser setting on (`settings host-browser update`)
    /// and LAZYSH_DEV_HOST_BROWSER=1; see docs/host-browser.md.
    #[command(hide = true, args_conflicts_with_subcommands = true)]
    HostBrowser {
        #[command(subcommand)]
        command: Option<HostBrowserCommand>,
        /// Remove the kept profile (Clear browser data) instead of starting a browser. Works while the
        /// setting is off, so that a user who switched the feature off can still remove what it kept.
        #[arg(long, conflicts_with_all = ["binary", "allow_origin", "url", "headed", "no_sandbox", "keep_profile"])]
        clear_data: bool,
        /// Keep the browser profile (cookies, sessions) after the session, until --clear-data.
        #[arg(long)]
        keep_profile: bool,
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
    /// Answer OpenCode permission requests and question forms, and stop a turn, through its loopback background service.
    OpencodeService {
        #[command(subcommand)]
        command: lazysh_agent::opencode_service::Command,
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
    /// Print an opt-in configuration fragment; never changes the agent's settings.
    ApprovalConfig {
        #[arg(long, value_enum, default_value = "claude")]
        agent: lazysh_agent::approvals::ApprovalAgent,
    },
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
    GeminiConfig {
        #[arg(long)]
        reported_history: bool,
    },
    /// Print a Grok Build hooks fragment for `~/.grok/hooks/`; never changes settings.
    GrokConfig {
        #[arg(long)]
        reported_history: bool,
    },
    /// Print a standalone Droid hooks.json fragment; never changes settings.
    DroidConfig,
    /// Print Kimi TOML hooks; never changes settings. The default is legacy Kimi CLI 1.52; `--dialect kimi-code-2.4`
    /// reports only approval requests, because Kimi Code 2.4 turn, tool and `Stop` events cannot name the root agent.
    KimiConfig {
        #[arg(long, value_enum, default_value_t = KimiDialect::Legacy)]
        dialect: KimiDialect,
    },
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
        /// Allow bounded indexing of larger Codex conversation history.
        #[arg(long)]
        allow_large_history: bool,
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
        /// Allow bounded indexing of larger Codex conversation history.
        #[arg(long)]
        allow_large_history: bool,
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
    /// Stream upserts of one Claude Code, Codex or OpenCode conversation until stdin closes.
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
        /// OpenCode: the session to read from the database `--path` names.
        #[arg(long, conflicts_with = "session_id")]
        database_session: Option<String>,
        #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u8).range(1..=100))]
        limit: u8,
        #[arg(long, default_value_t=250, value_parser=clap::value_parser!(u64).range(50..=5000))]
        interval_ms: u64,
        /// Frame vocabulary version; only 1 exists.
        #[arg(long, default_value_t=1, value_parser=clap::value_parser!(u8).range(1..=1))]
        protocol: u8,
        /// Carry the bounded PNG/JPEG previews of the images a user attached; only with `--path`.
        #[arg(long, conflicts_with = "session_id")]
        inline_images: bool,
        /// Allow bounded indexing of larger Codex conversation history.
        #[arg(long)]
        allow_large_history: bool,
    },
}
#[derive(Subcommand)]
enum SettingsCommand {
    Show,
    /// The host browser switch, off by default. It has its own file and revision: `settings show` and
    /// `settings update` keep their schema so that a released client keeps reading and writing them.
    HostBrowser {
        #[command(subcommand)]
        command: HostBrowserSettingsCommand,
    },
    /// What may queue a relay notification; kept apart from `settings.json` for older companions.
    Notifications {
        #[command(subcommand)]
        command: NotificationsCommand,
    },
    /// Switches an older companion sharing the state directory must not see in `settings.json`.
    Features {
        #[command(subcommand)]
        command: FeaturesCommand,
    },
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
#[derive(Subcommand)]
enum HostBrowserCommand {
    /// The relay one SSH exec channel talks to: starts a private, headless Chrome or Chromium and streams its
    /// page as frames (docs/host-browser.md, "Relay wire format"). Needs the host browser setting on.
    Serve {
        #[arg(long)]
        binary: Option<std::path::PathBuf>,
        /// Pass --no-sandbox, for containers and CI runners that cannot create a sandbox.
        #[arg(long)]
        no_sandbox: bool,
        /// Keep the browser profile (cookies, sessions) after the session, until `host-browser --clear-data`.
        #[arg(long)]
        keep_profile: bool,
        /// End the session, and the browser with it, when the view has been hidden this many seconds.
        #[arg(long, default_value_t = 600, value_parser = clap::value_parser!(u64).range(1..=86_400))]
        idle_release: u64,
    },
}
#[derive(Subcommand)]
enum HostBrowserSettingsCommand {
    Show,
    Update {
        #[arg(long)]
        expected_revision: u64,
        #[arg(long, action=clap::ArgAction::Set, required=true)]
        host_browser_enabled: bool,
    },
}
#[derive(Subcommand)]
enum UsageCollectionCommand {
    Show,
    Update {
        #[arg(long)]
        expected_revision: u64,
        #[arg(long, action=clap::ArgAction::Set, required=true)]
        account_quota_enabled: bool,
    },
}
#[derive(Subcommand)]
enum NotificationsCommand {
    Show,
    Update {
        #[arg(long)]
        expected_revision: u64,
        #[arg(long, action=clap::ArgAction::Set, required=true)]
        nested_agent_suppression_enabled: bool,
        #[arg(long, action=clap::ArgAction::Set, required=true)]
        suppress_while_desktop_unlocked: bool,
    },
}
#[derive(Subcommand)]
enum FeaturesCommand {
    Show,
    Update {
        #[arg(long)]
        expected_revision: u64,
        #[arg(long, action=clap::ArgAction::Set, required=true)]
        simulator_streaming_enabled: bool,
        #[arg(long, action=clap::ArgAction::Set, required=true)]
        port_scan_enabled: bool,
    },
}
fn json(value: impl serde::Serialize) -> lazysh_agent::Result<serde_json::Value> {
    serde_json::to_value(value).map_err(|_| Error::InvalidEvent)
}
fn execute(cli: Cli) -> lazysh_agent::Result<()> {
    // Hooks run inside agent turns and must not trigger the unrelated auto-updater.
    let update = (!matches!(
        cli.command,
        Command::Ingest { .. } | Command::ApprovalRequest { .. } | Command::AutoUpdate { .. }
    ))
    .then(lazysh_agent::auto_update::trigger)
    .flatten();
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
    if matches!(&cli.command, Command::Devices { command } if command.is_stream()) {
        lazysh_agent::host_features::read(&lazysh_agent::state_directory()?)?
            .check_simulator_streaming()?;
    }
    let mut wake_sender = false;
    let configure_sender = matches!(
        &cli.command,
        Command::Relay {
            command: lazysh_agent::relay::RelayCommand::Configure { enable: true, .. }
        }
    );
    let output = match cli.command {
        Command::BrowserOpen { .. } => None,
        Command::BrowserWatch {
            heartbeat_seconds, ..
        } => {
            lazysh_agent::browser::watch(heartbeat_seconds)?;
            None
        }
        Command::BrowserShim(arguments) => {
            let report = lazysh_agent::browser::shim(arguments.command)?;
            let mut stdout = io::stdout().lock();
            if arguments.json {
                serde_json::to_writer(&mut stdout, &report).map_err(|_| Error::InvalidEvent)?;
                writeln!(stdout)?;
            } else {
                write!(stdout, "{}", lazysh_agent::browser::render(&report))?;
            }
            // The report is already out; a partial install must still fail.
            if report["complete"] == false {
                return Err(Error::Browser("BrowserShimIncomplete"));
            }
            None
        }
        Command::HerdrFocusPane { session, pane } => {
            Some(lazysh_agent::herdr::focus_pane(&session, &pane)?)
        }
        Command::HerdrPaneInput { session } => {
            lazysh_agent::herdr_pane_input::run_stdio(&session)?;
            None
        }
        Command::HerdrEvents { session, .. } => {
            lazysh_agent::herdr_events::run_stdio(&session)?;
            None
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
        Command::AutoUpdate { command } => Some(lazysh_agent::auto_update::execute(command)?),
        Command::Installation { command } => Some(lazysh_agent::installation::run(command)?),
        Command::Skills { command } => Some(lazysh_agent::skills::run(command)?),
        Command::Hooks { command } => Some(lazysh_agent::hook_setup::run(command)?),
        Command::Relay { command } => Some(lazysh_agent::relay::run(
            command,
            &lazysh_agent::state_directory()?,
        )?),
        Command::Settings { command } => {
            let directory = lazysh_agent::state_directory()?;
            Some(match command {
                SettingsCommand::HostBrowser { command } => {
                    use lazysh_agent::host_browser::settings;
                    match command {
                        HostBrowserSettingsCommand::Show => json(settings::read(&directory)?)?,
                        HostBrowserSettingsCommand::Update {
                            expected_revision,
                            host_browser_enabled,
                        } => json(settings::update(
                            &directory,
                            expected_revision,
                            host_browser_enabled,
                        )?)?,
                    }
                }
                SettingsCommand::Notifications { command } => {
                    use lazysh_agent::notification_policy as policy;
                    match command {
                        NotificationsCommand::Show => json(policy::read(&directory)?)?,
                        NotificationsCommand::Update {
                            expected_revision,
                            nested_agent_suppression_enabled,
                            suppress_while_desktop_unlocked,
                        } => json(policy::update(
                            &directory,
                            expected_revision,
                            nested_agent_suppression_enabled,
                            suppress_while_desktop_unlocked,
                        )?)?,
                    }
                }
                SettingsCommand::Show => json(lazysh_agent::settings::read(&directory)?)?,
                SettingsCommand::Update {
                    expected_revision,
                    transcript_discovery_enabled,
                    recorded_usage_enabled,
                    device_tools_enabled,
                } => json(lazysh_agent::settings::update(
                    &directory,
                    expected_revision,
                    transcript_discovery_enabled,
                    recorded_usage_enabled,
                    device_tools_enabled,
                )?)?,
                SettingsCommand::Features {
                    command: FeaturesCommand::Show,
                } => json(lazysh_agent::host_features::read(&directory)?)?,
                SettingsCommand::Features {
                    command:
                        FeaturesCommand::Update {
                            expected_revision,
                            simulator_streaming_enabled,
                            port_scan_enabled,
                        },
                } => json(lazysh_agent::host_features::update(
                    &directory,
                    expected_revision,
                    simulator_streaming_enabled,
                    port_scan_enabled,
                )?)?,
            })
        }
        Command::UsageCollector { .. } => unreachable!("handled before execute"),
        Command::UsageCollection { command } => {
            let directory = lazysh_agent::state_directory()?;
            let policy = match command {
                UsageCollectionCommand::Show => lazysh_agent::usage_collection::read(&directory)?,
                UsageCollectionCommand::Update {
                    expected_revision,
                    account_quota_enabled,
                } => lazysh_agent::usage_collection::update(
                    &directory,
                    Some(expected_revision),
                    |policy| {
                        policy.account_quota_enabled = account_quota_enabled;
                    },
                )?,
            };
            Some(serde_json::to_value(policy).map_err(|_| Error::InvalidEvent)?)
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
            command:
                Some(HostBrowserCommand::Serve {
                    binary,
                    no_sandbox,
                    keep_profile,
                    idle_release,
                }),
            ..
        } => {
            lazysh_agent::host_browser::relay::serve(&lazysh_agent::host_browser::relay::Serve {
                state: &lazysh_agent::state_directory()?,
                binary: binary.as_deref(),
                no_sandbox,
                keep_profile,
                idle_release: std::time::Duration::from_secs(idle_release),
            })?;
            None
        }
        Command::HostBrowser {
            clear_data: true, ..
        } => {
            let cleared =
                lazysh_agent::host_browser::profile::clear(&lazysh_agent::state_directory()?)?;
            Some(serde_json::json!({"schemaVersion": 1, "cleared": cleared}))
        }
        Command::HostBrowser {
            command: None,
            clear_data: false,
            keep_profile,
            binary,
            allow_origin,
            url,
            headed,
            no_sandbox,
        } => {
            lazysh_agent::host_browser::run(&lazysh_agent::host_browser::Launch {
                state: &lazysh_agent::state_directory()?,
                keep_profile,
                binary: binary.as_deref(),
                allow_origins: &allow_origin,
                url: url.as_deref(),
                headed,
                no_sandbox,
            })?;
            None
        }
        Command::Listeners(options) => lazysh_agent::listeners::run(&options)?,
        Command::OpencodeService { command } => Some(lazysh_agent::opencode_service::run(command)?),
        Command::Review(arguments) => {
            lazysh_agent::review::run(arguments, &mut io::stdout().lock())?;
            None
        }
        Command::ApprovalConfig { agent } => Some(lazysh_agent::approvals::config(agent)),
        Command::ApprovalRequest {
            agent,
            timeout_seconds,
        } => lazysh_agent::approvals::request(
            &lazysh_agent::state_directory()?,
            io::stdin().lock(),
            agent,
            lazysh_agent::approval_pane_identity().as_deref(),
            timeout_seconds,
            &lazysh_agent::notification_policy::System,
        )?,
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
        Command::GeminiConfig { reported_history } => Some(if reported_history {
            lazysh_agent::reported_history::gemini_config()
        } else {
            lazysh_agent::hooks::gemini_config()
        }),
        Command::GrokConfig { reported_history } => Some(if reported_history {
            lazysh_agent::reported_history::grok_config()
        } else {
            lazysh_agent::hooks::grok_config()
        }),
        Command::DroidConfig => Some(lazysh_agent::hooks::droid_config()),
        Command::KimiConfig { dialect } => Some(match dialect {
            KimiDialect::Legacy => lazysh_agent::hooks::kimi_config(),
            KimiDialect::KimiCode24 => lazysh_agent::hooks::kimi_code_config(),
        }),
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
            allow_large_history,
            limit,
            window,
        } => Some(
            serde_json::to_value(
                lazysh_agent::transcript::read_herdr_conversation_window_large(
                    agent,
                    &session_id,
                    limit,
                    &window.window(),
                    allow_large_history,
                )?,
            )
            .map_err(|_| Error::InvalidEvent)?,
        ),
        Command::Transcript {
            agent,
            path,
            checkpoint,
            checkpointed,
            inline_images,
            allow_large_history,
            session_id,
            offset,
            limit,
            view,
            window,
        } => {
            let window = window.window();
            if allow_large_history
                && (!matches!(agent, lazysh_agent::transcript::TranscriptAgent::Codex)
                    || !matches!(view, lazysh_agent::transcript::TranscriptView::Conversation))
            {
                return Err(Error::InvalidArgument);
            }
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
                            lazysh_agent::transcript::conversation_window_large(
                                &path,
                                agent,
                                limit,
                                inline_images,
                                &window,
                                allow_large_history,
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
            database_session,
            limit,
            interval_ms,
            protocol: _,
            inline_images,
            allow_large_history,
        } => {
            lazysh_agent::transcript::watch::run_stdio(lazysh_agent::transcript::watch::Options {
                agent,
                path,
                session_id,
                database_session,
                limit,
                interval: std::time::Duration::from_millis(interval_ms),
                inline_images,
                allow_large_history,
            })?;
            None
        }
        Command::Ingest {
            agent,
            reported_history,
        } => {
            // A Herdr pane is named exactly, as an approval's pane is; a terminal lazysh launched names itself only when no multiplexer does.
            let pane = lazysh_agent::approval_pane_identity().or_else(lazysh_agent::pane_identity);
            // The environment's server belongs to the environment's pane, not to a pane a generic payload names itself.
            let named = |event: &mut lazysh_agent::Event| {
                if let Some(server) = lazysh_agent::pane_server().filter(|_| event.pane_id == pane)
                {
                    event.pane_server = Some(server);
                }
            };
            if !reported_history && matches!(agent, Agent::KimiCode) {
                if let Some(mut observation) =
                    lazysh_agent::kimi_code::read(io::stdin().lock(), pane.as_deref())?
                {
                    if let lazysh_agent::kimi_code::Observation::Requested { event, .. } =
                        &mut observation
                    {
                        named(event);
                    }
                    let (mut store, admission) = open_admitting(agent)?;
                    store.record_kimi_code(&observation, chrono::Utc::now(), admission)?;
                    wake_sender = true;
                }
            } else {
                let (event, source) = if reported_history {
                    lazysh_agent::reported_history::read_hook(
                        io::stdin().lock(),
                        agent,
                        pane.as_deref(),
                    )?
                } else {
                    (
                        lazysh_agent::read_event(io::stdin().lock(), agent, pane.as_deref())?,
                        None,
                    )
                };
                let event = event.map(|mut event| {
                    named(&mut event);
                    event
                });
                if event.is_some() || source.is_some() {
                    let (mut store, admission) = open_admitting(agent)?;
                    store.ingest_with_reported_history(
                        event.as_ref(),
                        source.as_ref(),
                        chrono::Utc::now(),
                        admission,
                    )?;
                    wake_sender = true;
                }
            }
            None
        }
        Command::Snapshot { limit } => {
            let directory = lazysh_agent::state_directory()?;
            let mut store = Store::open(&directory)?;
            // Claude Code sends no hook when a permission dialog is rejected (#1795).
            let admission = store.admission(
                &directory,
                Agent::Claude,
                &lazysh_agent::notification_policy::System,
            )?;
            store.settle_rejected_dialogs(chrono::Utc::now(), admission)?;
            let mut snapshot = store.snapshot(limit, chrono::Utc::now())?;
            snapshot.live_agents = Some(lazysh_agent::live_agents::discover());
            snapshot.update = update;
            wake_sender = true;
            Some(serde_json::to_value(snapshot).map_err(|_| Error::InvalidEvent)?)
        }
    };
    if wake_sender || configure_sender {
        if let Ok(directory) = lazysh_agent::state_directory() {
            let _ = lazysh_agent::relay::ensure_sender(&directory, configure_sender);
        }
    }
    if let Some(output) = output {
        let mut stdout = io::stdout().lock();
        serde_json::to_writer(&mut stdout, &output)
            .map_err(|_| Error::Io(io::Error::other("Output unavailable")))?;
        writeln!(stdout)?;
    }
    Ok(())
}
/// Opens the companion state and decides whether this report may queue a relay notification.
fn open_admitting(
    agent: Agent,
) -> lazysh_agent::Result<(Store, lazysh_agent::notification_policy::Admission)> {
    let directory = lazysh_agent::state_directory()?;
    let store = Store::open(&directory)?;
    let admission = store.admission(
        &directory,
        agent,
        &lazysh_agent::notification_policy::System,
    )?;
    Ok((store, admission))
}
fn main() -> std::process::ExitCode {
    if let Some(code) = lazysh_account_usage::worker_main() {
        return code;
    }
    // The managed wrappers are links to this binary named like the opener they stand in for.
    if let Some(code) = lazysh_agent::browser::invoked_as_launcher() {
        return code;
    }
    let command = lazysh_agent::review::localize(
        Cli::command(),
        lazysh_agent::review::locale_from_environment().as_deref(),
    );
    let cli = Cli::from_arg_matches_mut(&mut command.get_matches()).unwrap_or_else(|e| e.exit());
    if let Command::Update(args) = cli.command {
        return lazysh_agent::update::run(args);
    }
    if let Command::UsageCollector { command } = cli.command {
        return lazysh_agent::usage_collector::run(command);
    }
    if let Command::BrowserOpen { args } = &cli.command {
        return lazysh_agent::browser::open("browser-open", args);
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
