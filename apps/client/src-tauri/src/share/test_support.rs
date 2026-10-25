use std::{net::SocketAddr, sync::Arc};
use tokio::{net::TcpListener, sync::oneshot};
use tokio_rustls::{
    rustls::{
        pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
        ServerConfig,
    },
    TlsAcceptor,
};

pub(crate) struct TlsFront {
    pub listener: TcpListener,
    pub address: SocketAddr,
    pub origin: String,
    pub root: reqwest::Certificate,
    pub acceptor: TlsAcceptor,
}
pub(crate) async fn tls_front() -> TlsFront {
    let front = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = front.local_addr().unwrap();
    let origin = format!("https://localhost:{}", address.port());
    let certificate = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let root = reqwest::Certificate::from_der(certificate.cert.der().as_ref()).unwrap();
    let config = ServerConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![certificate.cert.der().clone()],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            certificate.signing_key.serialize_der(),
        )),
    )
    .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    TlsFront {
        listener: front,
        address,
        origin,
        root,
        acceptor,
    }
}

pub(crate) fn tls_proxy(
    front: TcpListener,
    acceptor: TlsAcceptor,
    destination: SocketAddr,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = front.accept() => {
                    let Ok((socket, _)) = accepted else { return };
                    let acceptor = acceptor.clone();
                    connections.spawn(async move {
                        if let Ok(mut incoming) = acceptor.accept(socket).await {
                            if let Ok(mut outgoing) = tokio::net::TcpStream::connect(destination).await {
                                let _ = tokio::io::copy_bidirectional(&mut incoming, &mut outgoing).await;
                            }
                        }
                    });
                },
                _ = connections.join_next(), if !connections.is_empty() => {},
            }
        }
    })
}

// Return only after aborting the async waiter while its admitted OS write is blocked.
pub(crate) async fn abort_write<F, Fut>(start: F) -> std::sync::mpsc::Sender<()>
where
    F: FnOnce(Box<dyn FnOnce() -> Result<(), String> + Send>) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
{
    let (entered, started) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let task = tokio::spawn(start(Box::new(move || {
        entered.send(()).unwrap();
        wait.recv().unwrap();
        Ok(())
    })));
    started.await.unwrap();
    task.abort();
    let _ = task.await;
    release
}
