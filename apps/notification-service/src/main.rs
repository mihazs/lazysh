use clap::{Parser, Subcommand, ValueEnum};
use lazysh_notifications::{client, Config, DestinationFormat, Event, Kind, Service};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};
use uuid::Uuid;
#[derive(Parser)]
#[command(
    name = "lazysh-notifications",
    about = "Opt-in authenticated single-destination webhook relay"
)]
struct Cli {
    #[arg(long, global = true)]
    relay_ca_file: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Clone, ValueEnum)]
enum State {
    Working,
    NeedsAttention,
    Done,
}
#[derive(clap::Args)]
struct DestinationArgs {
    #[arg(long)]
    data_dir: PathBuf,
    #[arg(long)]
    admin_file: PathBuf,
    #[arg(long)]
    destination_file: PathBuf,
    /// Required for webhook and Gotify; optional reverse-proxy Bearer for Apprise.
    #[arg(long)]
    destination_token_file: Option<PathBuf>,
    #[arg(long, value_enum, default_value = "webhook")]
    destination_format: DestinationFormat,
    /// Apprise only: acknowledges sending without a reverse-proxy token.
    #[arg(long)]
    destination_unauthenticated: bool,
    /// Apprise only: selects tagged services of the stored configuration (repeatable).
    #[arg(long = "apprise-tag", value_name = "TAG")]
    apprise_tags: Vec<String>,
}
#[derive(Subcommand)]
enum Command {
    /// Creates a private VAPID key and an explicit fixed push-service origin/IP policy.
    PushConfigGenerate {
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        push_origin: String,
        #[arg(long, required = true)]
        address: Vec<IpAddr>,
        #[arg(long)]
        contact: String,
        /// Opt into device-bound expiring events; legacy remains the default.
        #[arg(long, value_enum, default_value = "legacy")]
        event_format: lazysh_notifications::push::EventFormat,
    },
    ServePush {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        admin_file: PathBuf,
        #[arg(long)]
        push_config_file: PathBuf,
        #[arg(long, default_value = "127.0.0.1:7350")]
        listen: SocketAddr,
    },
    ConfigurePush {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        admin_file: PathBuf,
        #[arg(long)]
        push_config_file: PathBuf,
    },
    /// Installs an existing private one-time capability; reset revokes the old device.
    PushEnrollment {
        #[arg(long)]
        origin: String,
        #[arg(long)]
        admin_file: PathBuf,
        #[arg(long)]
        capability_file: PathBuf,
        #[arg(long)]
        reset: bool,
    },
    Keygen {
        #[arg(long)]
        output: PathBuf,
    },
    Serve {
        #[command(flatten)]
        destination: DestinationArgs,
        #[arg(long, default_value = "127.0.0.1:7350")]
        listen: SocketAddr,
    },
    ConfigureDestination {
        #[command(flatten)]
        destination: DestinationArgs,
    },
    SourceCreate {
        #[arg(long)]
        origin: String,
        #[arg(long)]
        admin_file: PathBuf,
        #[arg(long)]
        alias: String,
        #[arg(long)]
        output: PathBuf,
    },
    SourceResume {
        #[arg(long)]
        origin: String,
        #[arg(long)]
        admin_file: PathBuf,
        #[arg(long)]
        capability_file: PathBuf,
    },
    Destination {
        #[arg(long)]
        origin: String,
        #[arg(long)]
        admin_file: PathBuf,
        #[arg(long)]
        enable: bool,
    },
    SourceRevoke {
        #[arg(long)]
        origin: String,
        #[arg(long)]
        admin_file: PathBuf,
        #[arg(long)]
        source_id: Uuid,
    },
    Status {
        #[arg(long)]
        origin: String,
        #[arg(long)]
        admin_file: PathBuf,
    },
    Publish {
        #[arg(long)]
        capability_file: PathBuf,
        #[arg(long)]
        event_id: Uuid,
        #[arg(long, value_enum)]
        state: State,
    },
    Receipt {
        #[arg(long)]
        capability_file: PathBuf,
        #[arg(long)]
        receipt_id: Uuid,
    },
}
fn config(args: DestinationArgs) -> Result<Config, String> {
    let admin = client::read_token(&args.admin_file)?;
    let url = lazysh_common::service_secrets::read_secret(&args.destination_file)?;
    let secret = |path: &PathBuf| lazysh_common::service_secrets::read_secret(path);
    if !matches!(args.destination_format, DestinationFormat::Apprise) {
        if args.destination_unauthenticated || !args.apprise_tags.is_empty() {
            return Err("Unauthenticated and tag options apply only to Apprise".into());
        }
        let path = args
            .destination_token_file
            .as_ref()
            .ok_or("Require --destination-token-file")?;
        let key = match args.destination_format {
            DestinationFormat::Webhook => client::read_token(path)?,
            _ => secret(path)?,
        };
        return Config::with_format(
            args.data_dir,
            admin.trim(),
            url.trim(),
            key.trim(),
            args.destination_format,
        );
    }
    let token = match (
        &args.destination_token_file,
        args.destination_unauthenticated,
    ) {
        (Some(path), false) => Some(secret(path)?),
        (None, true) => None,
        (Some(_), true) => {
            return Err("Choose a proxy token file or --destination-unauthenticated".into())
        }
        (None, false) => {
            return Err(
                "Apprise without a proxy token requires --destination-unauthenticated".into(),
            )
        }
    };
    Config::apprise(
        args.data_dir,
        admin.trim(),
        url.trim(),
        token.as_ref().map(|token| token.trim()),
        &args.apprise_tags,
    )
}
fn print(value: impl serde::Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(&value).map_err(|_| "Cannot encode public result")?
    );
    Ok(())
}
fn push_config(directory: PathBuf, admin: PathBuf, push: PathBuf) -> Result<Config, String> {
    let admin = client::read_token(&admin)?;
    Config::web_push(
        directory,
        admin.trim(),
        lazysh_notifications::push::PushConfig::read(&push)?,
    )
}
async fn serve(config: Config, listen: SocketAddr) -> Result<(), String> {
    if !listen.ip().is_loopback() {
        return Err("Require loopback behind an authenticated HTTPS proxy".into());
    }
    let service = Service::open(config)?;
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|_| "Cannot bind relay listener")?;
    print(
        serde_json::json!({"listening":listener.local_addr().map_err(|_|"Cannot inspect listener")?.to_string()}),
    )?;
    lazysh_notifications::serve(listener, service, lazysh_common::server::shutdown_signal())
        .await
        .map_err(|_| "Relay stopped with an error".into())
}
async fn run() -> Result<(), String> {
    let Cli {
        command,
        relay_ca_file,
    } = Cli::parse();
    if relay_ca_file.is_some()
        && matches!(
            &command,
            Command::Serve { .. }
                | Command::ConfigureDestination { .. }
                | Command::Keygen { .. }
                | Command::ServePush { .. }
                | Command::ConfigurePush { .. }
                | Command::PushConfigGenerate { .. }
        )
    {
        return Err("Relay CA applies only to source/admin HTTPS client commands".into());
    }
    let transport = client::transport(relay_ca_file.as_deref())?;
    match command {
        Command::PushConfigGenerate {
            output,
            push_origin,
            address,
            contact,
            event_format,
        } => {
            let config = lazysh_notifications::push::PushConfig::generate_with_event_format(
                push_origin,
                address,
                contact,
                event_format,
            )?;
            config.write(&output)?;
            print(serde_json::json!({"created":true,"publicVapidKey":config.public_key()}))
        }
        Command::ServePush {
            data_dir,
            admin_file,
            push_config_file,
            listen,
        } => serve(push_config(data_dir, admin_file, push_config_file)?, listen).await,
        Command::ConfigurePush {
            data_dir,
            admin_file,
            push_config_file,
        } => {
            Service::reconfigure(push_config(data_dir, admin_file, push_config_file)?)?;
            print(serde_json::json!({"configured":true,"enabled":false}))
        }
        Command::PushEnrollment {
            origin,
            admin_file,
            capability_file,
            reset,
        } => {
            let admin = client::read_token(&admin_file)?;
            let capability = client::read_token(&capability_file)?;
            let origin = lazysh_notifications::https(&origin)?;
            let endpoint = origin
                .join(if reset {
                    "/v1/admin/push/reset"
                } else {
                    "/v1/admin/push/enrollment"
                })
                .map_err(|_| "Invalid relay origin")?;
            let response = transport
                .post(endpoint)
                .bearer_auth(admin.trim())
                .json(&serde_json::json!({"capability":capability.trim()}))
                .send()
                .await
                .map_err(|_| "Enrollment request failed")?;
            if !response.status().is_success() {
                return Err("Enrollment request rejected".into());
            }
            // Do not echo an arbitrary server body into terminal output.
            print(serde_json::json!({"enrollmentReady":true,"enabled":false}))
        }
        Command::Keygen { output } => {
            client::keygen(&output)?;
            print(serde_json::json!({"created":true}))
        }
        Command::Serve {
            destination,
            listen,
        } => serve(config(destination)?, listen).await,
        Command::ConfigureDestination { destination } => {
            Service::reconfigure(config(destination)?)?;
            print(serde_json::json!({"configured":true,"enabled":false}))
        }
        Command::SourceCreate {
            origin,
            admin_file,
            alias,
            output,
        } => {
            let admin = client::read_token(&admin_file)?;
            print(
                serde_json::json!({"sourceId":client::create_source(&transport, &origin,admin.trim(),&alias,&output).await?}),
            )
        }
        Command::SourceResume {
            origin,
            admin_file,
            capability_file,
        } => {
            let admin = client::read_token(&admin_file)?;
            print(
                serde_json::json!({"sourceId":client::resume_source(&transport, &origin,admin.trim(),&capability_file).await?}),
            )
        }
        Command::Destination {
            origin,
            admin_file,
            enable,
        } => {
            let admin = client::read_token(&admin_file)?;
            print(
                client::admin_action(
                    &transport,
                    &origin,
                    admin.trim(),
                    if enable {
                        "destination/enable"
                    } else {
                        "destination/disable"
                    },
                )
                .await?,
            )
        }
        Command::SourceRevoke {
            origin,
            admin_file,
            source_id,
        } => {
            let admin = client::read_token(&admin_file)?;
            print(
                client::admin_action(
                    &transport,
                    &origin,
                    admin.trim(),
                    &format!("sources/{source_id}/revoke"),
                )
                .await?,
            )
        }
        Command::Status { origin, admin_file } => {
            let admin = client::read_token(&admin_file)?;
            print(client::admin_status(&transport, &origin, admin.trim()).await?)
        }
        Command::Publish {
            capability_file,
            event_id,
            state,
        } => print(
            client::publish(
                &transport,
                &capability_file,
                Event {
                    event_id,
                    kind: match state {
                        State::Working => Kind::Working,
                        State::NeedsAttention => Kind::NeedsAttention,
                        State::Done => Kind::Done,
                    },
                },
            )
            .await?,
        ),
        Command::Receipt {
            capability_file,
            receipt_id,
        } => print(client::receipt(&transport, &capability_file, receipt_id).await?),
    }
}
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("lazysh-notifications: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_format_defaults_to_webhook_and_requires_explicit_gotify() {
        for command in ["serve", "configure-destination"] {
            let args = [
                "lazysh-notifications",
                command,
                "--data-dir",
                "/owned/state",
                "--admin-file",
                "/owned/admin",
                "--destination-file",
                "/owned/url",
                "--destination-token-file",
                "/owned/key",
            ];
            let format = |command: Command| match command {
                Command::Serve { destination, .. }
                | Command::ConfigureDestination { destination } => destination.destination_format,
                _ => panic!("wrong command"),
            };
            assert!(matches!(
                format(Cli::try_parse_from(args).unwrap().command),
                DestinationFormat::Webhook
            ));
            assert!(matches!(
                format(
                    Cli::try_parse_from(args.into_iter().chain(["--destination-format", "gotify"]))
                        .unwrap()
                        .command
                ),
                DestinationFormat::Gotify
            ));
            assert!(Cli::try_parse_from(
                args.into_iter().chain(["--destination-format", "unknown"])
            )
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn gotify_config_reads_private_opaque_application_token_instead_of_a_relay_capability() {
        let (directory, admin, url, token) = private_files(
            b"https://gotify.example/message\n",
            b"opaque-gotify-app-token\n",
        );
        let load = |destination_format| {
            config(args(
                directory.path(),
                &admin,
                &url,
                Some(&token),
                destination_format,
            ))
        };
        assert!(load(DestinationFormat::Gotify).is_ok());
        assert!(load(DestinationFormat::Webhook).is_err());
    }

    /// Owner-only admin, destination URL and token files in a private directory.
    #[cfg(unix)]
    fn private_files(url: &[u8], token: &[u8]) -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let [admin, url_file, token_file] =
            ["admin", "url", "token"].map(|name| directory.path().join(name));
        client::write_private(
            &admin,
            b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        client::write_private(&url_file, url).unwrap();
        client::write_private(&token_file, token).unwrap();
        (directory, admin, url_file, token_file)
    }

    fn args(
        directory: &std::path::Path,
        admin: &std::path::Path,
        url: &std::path::Path,
        token: Option<&std::path::Path>,
        destination_format: DestinationFormat,
    ) -> DestinationArgs {
        DestinationArgs {
            data_dir: directory.join("state"),
            admin_file: admin.into(),
            destination_file: url.into(),
            destination_token_file: token.map(Into::into),
            destination_format,
            destination_unauthenticated: false,
            apprise_tags: vec![],
        }
    }

    #[test]
    fn apprise_flags_parse_repeatable_tags_and_an_explicit_unauthenticated_acknowledgement() {
        let parsed = Cli::try_parse_from([
            "lazysh-notifications",
            "serve",
            "--data-dir",
            "/owned/state",
            "--admin-file",
            "/owned/admin",
            "--destination-file",
            "/owned/url",
            "--destination-format",
            "apprise",
            "--destination-unauthenticated",
            "--apprise-tag",
            "phone",
            "--apprise-tag",
            "desk",
        ])
        .unwrap();
        let Command::Serve { destination, .. } = parsed.command else {
            panic!("wrong command");
        };
        assert!(matches!(
            destination.destination_format,
            DestinationFormat::Apprise
        ));
        assert!(destination.destination_unauthenticated);
        assert!(destination.destination_token_file.is_none());
        assert_eq!(destination.apprise_tags, ["phone", "desk"]);
    }

    #[cfg(unix)]
    #[test]
    fn apprise_config_requires_a_private_proxy_token_or_an_explicit_unauthenticated_choice() {
        use std::os::unix::fs::PermissionsExt;
        let (directory, admin, url, token) = private_files(
            b"https://apprise.example/notify/lazysh-key\n",
            b"opaque-proxy-token\n",
        );
        let linked = directory.path().join("linked-token");
        std::os::unix::fs::symlink(&token, &linked).unwrap();
        let load = |token: Option<&std::path::Path>, unauthenticated: bool, tags: &[&str]| {
            let mut args = args(
                directory.path(),
                &admin,
                &url,
                token,
                DestinationFormat::Apprise,
            );
            args.destination_unauthenticated = unauthenticated;
            args.apprise_tags = tags.iter().map(|tag| tag.to_string()).collect();
            config(args)
        };
        assert!(load(Some(&token), false, &["phone"]).is_ok());
        assert!(load(None, true, &[]).is_ok());
        assert!(load(None, false, &[]).is_err());
        assert!(load(Some(&token), true, &[]).is_err());
        assert!(load(Some(&linked), false, &[]).is_err());
        assert!(load(Some(&token), false, &["bad tag"]).is_err());
        std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(Some(&token), false, &[]).is_err());
        for format in [DestinationFormat::Webhook, DestinationFormat::Gotify] {
            let mut flagged = args(directory.path(), &admin, &url, None, format);
            flagged.destination_unauthenticated = true;
            assert!(config(flagged).is_err());
            let mut tagged = args(directory.path(), &admin, &url, None, format);
            tagged.apprise_tags = vec!["phone".into()];
            assert!(config(tagged).is_err());
            assert!(config(args(directory.path(), &admin, &url, None, format)).is_err());
        }
    }
}
