use clap::{Parser, Subcommand, ValueEnum};
use lazysh_notifications::{client, Config, Event, Kind, Service};
use std::{net::SocketAddr, path::PathBuf};
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
#[derive(Subcommand)]
enum Command {
    Keygen {
        #[arg(long)]
        output: PathBuf,
    },
    Serve {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        admin_file: PathBuf,
        #[arg(long)]
        destination_file: PathBuf,
        #[arg(long)]
        destination_token_file: PathBuf,
        #[arg(long, default_value = "127.0.0.1:7350")]
        listen: SocketAddr,
    },
    ConfigureDestination {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        admin_file: PathBuf,
        #[arg(long)]
        destination_file: PathBuf,
        #[arg(long)]
        destination_token_file: PathBuf,
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
fn config(dir: PathBuf, admin: PathBuf, url: PathBuf, key: PathBuf) -> Result<Config, String> {
    let admin = client::read_token(&admin)?;
    let url = lazysh_common::service_secrets::read_secret(&url)?;
    let key = client::read_token(&key)?;
    Config::new(dir, admin.trim(), url.trim(), key.trim())
}
fn print(value: impl serde::Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(&value).map_err(|_| "Cannot encode public result")?
    );
    Ok(())
}
async fn run() -> Result<(), String> {
    let Cli {
        command,
        relay_ca_file,
    } = Cli::parse();
    if relay_ca_file.is_some()
        && matches!(
            &command,
            Command::Serve { .. } | Command::ConfigureDestination { .. } | Command::Keygen { .. }
        )
    {
        return Err("Relay CA applies only to source/admin HTTPS client commands".into());
    }
    let transport = client::transport(relay_ca_file.as_deref())?;
    match command {
        Command::Keygen { output } => {
            client::keygen(&output)?;
            print(serde_json::json!({"created":true}))
        }
        Command::Serve {
            data_dir,
            admin_file,
            destination_file,
            destination_token_file,
            listen,
        } => {
            if !listen.ip().is_loopback() {
                return Err("Require loopback behind an authenticated HTTPS proxy".into());
            }
            let service = Service::open(config(
                data_dir,
                admin_file,
                destination_file,
                destination_token_file,
            )?)?;
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
        Command::ConfigureDestination {
            data_dir,
            admin_file,
            destination_file,
            destination_token_file,
        } => {
            Service::reconfigure(config(
                data_dir,
                admin_file,
                destination_file,
                destination_token_file,
            )?)?;
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
