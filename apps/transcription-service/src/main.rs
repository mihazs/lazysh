use clap::{Parser, Subcommand};
use lazysh_transcription::{Config, Service};
use std::{net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(
    name = "lazysh-transcription",
    about = "Optional private quota-limited transcription relay"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Keygen,
    Serve {
        #[arg(long)]
        admin_token_file: PathBuf,
        #[arg(
            long,
            required_unless_present = "whisper_cpp_port",
            conflicts_with = "whisper_cpp_port"
        )]
        provider_key_file: Option<PathBuf>,
        #[arg(long)]
        whisper_cpp_port: Option<std::num::NonZeroU16>,
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        device_seconds_per_day: u64,
        #[arg(long)]
        global_seconds_per_day: u64,
        #[arg(long, default_value = "127.0.0.1:7348")]
        listen: SocketAddr,
    },
}
async fn run() -> Result<(), String> {
    match Cli::parse().command {
        Command::Keygen => {
            println!("{}", lazysh_transcription::secret());
            Ok(())
        }
        Command::Serve {
            admin_token_file,
            provider_key_file,
            whisper_cpp_port,
            data_dir,
            device_seconds_per_day,
            global_seconds_per_day,
            listen,
        } => {
            if !listen.ip().is_loopback() {
                return Err("Require a loopback listen address behind an HTTPS proxy".into());
            }
            let admin = lazysh_transcription::read_secret(&admin_token_file)?;
            let config = if let Some(port) = whisper_cpp_port {
                Config::whisper_cpp(
                    data_dir,
                    admin.trim(),
                    port,
                    device_seconds_per_day,
                    global_seconds_per_day,
                )?
            } else {
                let path = provider_key_file
                    .ok_or("Require a provider key or explicit whisper.cpp port")?;
                let key = lazysh_transcription::read_secret(&path)?;
                Config::new(
                    data_dir,
                    admin.trim(),
                    key.trim(),
                    device_seconds_per_day,
                    global_seconds_per_day,
                )?
            };
            let service = Service::open(config)?;
            let listener = tokio::net::TcpListener::bind(listen)
                .await
                .map_err(|_| "Cannot bind transcription listener")?;
            println!(
                "LISTENING {}",
                listener
                    .local_addr()
                    .map_err(|_| "Cannot inspect listener")?
            );
            lazysh_transcription::serve(listener, service, lazysh_common::server::shutdown_signal())
                .await
                .map_err(|_| "Transcription listener failed".into())
        }
    }
}
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("lazysh-transcription: {error}");
        std::process::exit(1);
    }
}
