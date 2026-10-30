//! A remote quota read belongs to its command channel, including helper processes.
use crate::{Error, Result};
use lazysh_account_usage::Response;
use tokio::{io::AsyncReadExt, sync::watch};
pub fn run(watch_channel: bool) -> Result<Response> {
    let (cancel, mut cancelled) = watch::channel(false);
    ctrlc::set_handler(move || {
        cancel.send_replace(true);
    })
    .map_err(|_| {
        Error::Io(std::io::Error::other(
            "Account usage cancellation unavailable",
        ))
    })?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(Error::Io)?;
    let response = runtime.block_on(async {
        tokio::select! {
            biased;
            _=cancelled.changed()=>Response::unavailable("disconnected"),
            _=channel_closed(watch_channel)=>Response::unavailable("disconnected"),
            response=lazysh_account_usage::read()=>response,
        }
    });
    // stdin uses a blocking reader; command completion must not wait for another input byte.
    runtime.shutdown_background();
    Ok(response)
}
async fn channel_closed(enabled: bool) {
    if !enabled {
        std::future::pending::<()>().await;
    }
    let mut input = tokio::io::stdin();
    let mut bytes = [0; 64];
    loop {
        match input.read(&mut bytes).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}
