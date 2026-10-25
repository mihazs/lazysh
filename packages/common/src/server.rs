use std::{future::Future, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Semaphore, task::JoinSet};

/// Runs the relays' bounded HTTP/1 connections; callers enforce their listener policy.
pub async fn serve(
    listener: TcpListener,
    router: axum::Router,
    shutdown: impl Future<Output = ()> + Send,
    max_buffer: usize,
    max_headers: usize,
) -> std::io::Result<()> {
    let connections = Arc::new(Semaphore::new(16));
    let mut tasks = JoinSet::new();
    tokio::pin!(shutdown);
    let result = loop {
        tokio::select! {
            _ = &mut shutdown => break Ok(()),
            accepted = listener.accept() => {
                let (stream, _) = match accepted { Ok(connection) => connection, Err(error) => break Err(error) };
                let Ok(permit) = connections.clone().try_acquire_owned() else { drop(stream); continue; };
                let router = router.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let mut builder = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new()).http1_only();
                    builder.http1().header_read_timeout(Duration::from_secs(5)).timer(hyper_util::rt::TokioTimer::new()).max_buf_size(max_buffer).max_headers(max_headers);
                    let _ = tokio::time::timeout(Duration::from_secs(60), builder.serve_connection(hyper_util::rt::TokioIo::new(stream), hyper_util::service::TowerToHyperService::new(router))).await;
                });
            },
            _ = tasks.join_next(), if !tasks.is_empty() => {},
        }
    };
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    result
}

pub async fn shutdown_signal() {
    #[cfg(unix)]
    if let Ok(mut terminate) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        return;
    }
    let _ = tokio::signal::ctrl_c().await;
}

pub fn require_loopback(listener: &TcpListener, error: std::io::Error) -> std::io::Result<()> {
    if listener.local_addr()?.ip().is_loopback() {
        Ok(())
    } else {
        Err(error)
    }
}

/// Keeps both relay entrypoints on the same listener and shutdown contract.
#[macro_export]
macro_rules! relay_entrypoint {
    ($service_type:ty, $listener:ident, $service:ident, $shutdown:ident, $error:expr, $body:block) => {
        pub async fn serve(
            $listener: tokio::net::TcpListener,
            $service: $service_type,
            $shutdown: impl std::future::Future<Output = ()> + Send,
        ) -> std::io::Result<()> {
            $crate::server::require_loopback(&$listener, $error)?;
            $body
        }
    };
}
