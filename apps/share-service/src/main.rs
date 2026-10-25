use clap::{Parser, Subcommand};
use lazysh_share::{Config, Service};
use std::{io::Read, net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(
    name = "lazysh-share",
    about = "Optional private expiring file sharing service"
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
        token_file: PathBuf,
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        public_origin: String,
        #[arg(long, default_value = "127.0.0.1:7347")]
        listen: SocketAddr,
    },
}
async fn run() -> Result<(), String> {
    match Cli::parse().command {
        Command::Keygen => {
            println!("{}", lazysh_share::random_secret());
            Ok(())
        }
        Command::Serve {
            token_file,
            data_dir,
            public_origin,
            listen,
        } => {
            if !listen.ip().is_loopback() {
                return Err(
                    "Listen address must be loopback; configure a separate HTTPS proxy".into(),
                );
            }
            let metadata = std::fs::symlink_metadata(&token_file)
                .map_err(|_| "Cannot read management token file")?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("Management token must be a regular private file".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err("Management token file must have mode 0600 or stricter".into());
                }
            }
            let mut token = String::new();
            std::fs::File::open(token_file)
                .map_err(|_| "Cannot read management token file")?
                .take(129)
                .read_to_string(&mut token)
                .map_err(|_| "Cannot read management token file")?;
            let config = Config::new(data_dir, &public_origin, token.trim())?;
            let service = Service::open(config)?;
            let listener = tokio::net::TcpListener::bind(listen)
                .await
                .map_err(|_| "Cannot bind share service listener")?;
            println!(
                "LISTENING {}",
                listener
                    .local_addr()
                    .map_err(|_| "Cannot read listener address")?
            );
            lazysh_share::serve(listener, service, lazysh_common::server::shutdown_signal())
                .await
                .map_err(|_| "Share service stopped after a listener error".into())
        }
    }
}
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("lazysh-share: {error}");
        std::process::exit(1);
    }
}
