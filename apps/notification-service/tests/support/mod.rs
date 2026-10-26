use std::sync::Arc;
use tokio::{
    net::TcpListener,
    sync::Semaphore,
    task::{JoinHandle, JoinSet},
};

pub struct Identity {
    pub acceptor: tokio_rustls::TlsAcceptor,
    pub pem: String,
}
pub fn identity() -> Identity {
    let generated = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let der = generated.cert.der().clone();
    let pem = generated.cert.pem();
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(generated.signing_key.serialize_der());
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![der.clone()], key.into())
    .unwrap();
    Identity {
        acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(config)),
        pem,
    }
}
pub struct Server {
    pub origin: String,
    pub pem: String,
    task: JoinHandle<()>,
}
impl Server {
    pub async fn new(router: axum::Router) -> Self {
        let identity = identity();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!(
            "https://localhost:{}",
            listener.local_addr().unwrap().port()
        );
        let task = tokio::spawn(async move {
            let slots = Arc::new(Semaphore::new(16));
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    connection=listener.accept()=>{let(tcp,_)=connection.unwrap();let Ok(permit)=slots.clone().try_acquire_owned()else{continue};let acceptor=identity.acceptor.clone();let router=router.clone();tasks.spawn(async move {
                        let _permit=permit;let Ok(stream)=acceptor.accept(tcp).await else{return};
                        let builder=hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
                        let _=builder.serve_connection(hyper_util::rt::TokioIo::new(stream),hyper_util::service::TowerToHyperService::new(router)).await;
                    });},
                    _=tasks.join_next(),if !tasks.is_empty()=>{},
                }
            }
        });
        Self {
            origin,
            pem: identity.pem,
            task,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Keeps a committed provision response pending until this owned test server is dropped.
pub fn hold_first_provision(router: axum::Router) -> (axum::Router, Arc<Semaphore>) {
    use std::sync::atomic::{AtomicBool, Ordering};
    let first = Arc::new(AtomicBool::new(true));
    let committed = Arc::new(Semaphore::new(0));
    let notify = committed.clone();
    let hold = Arc::new(Semaphore::new(0));
    let router = router.layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let first = first.clone();
            let notify = notify.clone();
            let hold = hold.clone();
            async move {
                let provision = request.uri().path() == "/v1/admin/sources";
                let response = next.run(request).await;
                if provision && first.swap(false, Ordering::SeqCst) {
                    notify.add_permits(1);
                    let _permit = hold.acquire().await.unwrap();
                }
                response
            }
        },
    ));
    (router, committed)
}
