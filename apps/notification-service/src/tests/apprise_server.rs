use super::apprise_delivery::{settle, support_client, PROXY};
use super::*;

const KEY: &str = "lazysh-owned-key";
const FAILING_KEY: &str = "lazysh-owned-failing-key";

/// Plain loopback receiver for the Apprise `json://` service: Apprise posts here.
struct JsonReceiver {
    port: u16,
    received: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    task: JoinHandle<()>,
}
impl JsonReceiver {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let received = Arc::new(Mutex::new(Vec::new()));
        let capture = received.clone();
        let router =
            Router::new().fallback(move |uri: axum::http::Uri, body: axum::body::Bytes| {
                let capture = capture.clone();
                async move {
                    capture.lock().unwrap().push((
                        uri.path().to_owned(),
                        serde_json::from_slice(&body).unwrap(),
                    ));
                    StatusCode::OK
                }
            });
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Self {
            port,
            received,
            task,
        }
    }
}
impl Drop for JsonReceiver {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Owned TLS reverse proxy: it checks the relay's Bearer token, as the docs advise,
/// and forwards only the stateful notify route to the loopback Apprise API.
async fn proxy(api: String) -> support::Server {
    let upstream = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let router = Router::new().route(
        "/apprise/notify/{key}",
        post(
            move |Path(key): Path<String>, headers: HeaderMap, body: axum::body::Bytes| {
                let (api, upstream) = (api.clone(), upstream.clone());
                async move {
                    if headers
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        != Some(&format!("Bearer {PROXY}"))
                    {
                        return StatusCode::UNAUTHORIZED;
                    }
                    let response = upstream
                        .post(format!("{api}/notify/{key}"))
                        .header(header::CONTENT_TYPE, "application/json")
                        .header(header::ACCEPT, "application/json")
                        .body(body)
                        .send()
                        .await
                        .unwrap();
                    StatusCode::from_u16(response.status().as_u16()).unwrap()
                }
            },
        ),
    );
    support::Server::new(router).await
}

async fn relay(
    directory: &std::path::Path,
    proxy: &support::Server,
    key: &str,
    token: &str,
) -> (Service, Uuid) {
    let config = Config::apprise(
        directory.into(),
        ADMIN,
        &format!("{}/apprise/notify/{key}", proxy.origin),
        Some(token),
        &["lazysh".into()],
    )
    .unwrap();
    let service = Service::open_with(config, support_client(&proxy.pem), false).unwrap();
    let id = source(&service, SOURCE, "owned-terminal").await;
    enable(&service).await;
    (service, id)
}

#[tokio::test]
#[ignore = "requires the pinned official Apprise API container at LAZYSH_APPRISE_API"]
async fn real_apprise_api_stateful_key_delivers_mapped_events_through_an_owned_tls_proxy() {
    let api = std::env::var("LAZYSH_APPRISE_API").expect("owned Apprise API origin");
    assert!(
        api.starts_with("http://127.0.0.1:"),
        "loopback Apprise API only"
    );
    let plain = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(90), async {
        while !plain
            .get(format!("{api}/status"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .expect("owned Apprise API readiness deadline");
    let receiver = JsonReceiver::new().await;
    let port = receiver.port;
    for (key, body) in [
        (
            KEY,
            serde_json::json!({
                "config": format!(
                    "lazysh=json://127.0.0.1:{port}/tagged\nother=json://127.0.0.1:{port}/other"
                ),
                "format": "text",
            }),
        ),
        // A closed loopback port makes Apprise report a failed downstream service.
        (
            FAILING_KEY,
            serde_json::json!({"config": "lazysh=json://127.0.0.1:9/closed", "format": "text"}),
        ),
    ] {
        plain
            .post(format!("{api}/add/{key}"))
            .header(header::ACCEPT, "application/json")
            .json(&body)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    let proxy = proxy(api.clone()).await;
    let directory = tempfile::tempdir().unwrap();

    let (service, id) = relay(&directory.path().join("delivered"), &proxy, KEY, PROXY).await;
    let receipts = finite_state_receipts(&service).await;
    let (done, worker) = start(service.clone()).await;
    settle(
        &service,
        id,
        &receipts.iter().map(|r| (r, "accepted")).collect::<Vec<_>>(),
    )
    .await;
    stop(done, worker).await;
    let received = receiver.received.lock().unwrap().clone();
    assert_eq!(received.len(), 3, "{received:?}");
    for (message, kind) in [
        ("An agent is working.", "info"),
        ("An agent needs your attention.", "warning"),
        ("An agent finished.", "success"),
    ] {
        let matches: Vec<_> = received
            .iter()
            .filter(|(_, body)| body["message"] == message)
            .collect();
        assert_eq!(matches.len(), 1, "{message}");
        let (path, body) = matches[0];
        assert_eq!(path, "/tagged");
        assert_eq!(body["title"], "lazysh · owned-terminal");
        assert_eq!(body["type"], kind);
        for secret in [ADMIN, SOURCE, PROXY, KEY] {
            assert!(!body.to_string().contains(secret));
        }
    }

    // A failed downstream service is a finite partial result, attempted once.
    let (partial, partial_id) = relay(
        &directory.path().join("partial"),
        &proxy,
        FAILING_KEY,
        PROXY,
    )
    .await;
    let failed = enqueue(&partial, SOURCE, &event()).await;
    // The proxy rejects a wrong token before Apprise sees it: a permanent rejection.
    let (rejected, rejected_id) = relay(
        &directory.path().join("rejected"),
        &proxy,
        KEY,
        "owned-wrong-proxy-token",
    )
    .await;
    let refused = enqueue(&rejected, SOURCE, &event()).await;
    for (service, id, receipt, expected) in [
        (&partial, partial_id, &failed, "partial"),
        (&rejected, rejected_id, &refused, "rejected"),
    ] {
        let (done, worker) = start(service.clone()).await;
        settle(service, id, &[(receipt, expected)]).await;
        stop(done, worker).await;
        let attempts = service
            .db({
                let receipt = receipt.receipt_id.clone();
                move |s| {
                    Ok(s.connection.query_row(
                        "SELECT attempts FROM events WHERE receipt=?1",
                        [receipt],
                        |r| r.get::<_, i64>(0),
                    )?)
                }
            })
            .await
            .unwrap();
        assert_eq!(attempts, 1, "{expected}");
    }
    assert_eq!(receiver.received.lock().unwrap().len(), 3);
}
