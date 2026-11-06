use super::*;
use std::collections::{HashMap, VecDeque};

const KEY_URL: &str = "https://apprise.example/notify/lazysh-key";
pub(super) const PROXY: &str = "owned-apprise-proxy-token";

fn apprise(
    directory: &std::path::Path,
    endpoint: &str,
    token: Option<&str>,
    tags: &[&str],
) -> Result<Config, String> {
    let tags: Vec<String> = tags.iter().map(|tag| tag.to_string()).collect();
    Config::apprise(directory.into(), ADMIN, endpoint, token, &tags)
}

/// One captured `POST` exactly as the in-process Apprise API stub received it.
struct Seen {
    path: String,
    headers: HeaderMap,
    body: serde_json::Value,
}
/// In-process Apprise API stub that answers each receipt's attempts from a script.
struct Stub {
    server: support::Server,
    client: reqwest::Client,
    seen: Arc<Mutex<Vec<Seen>>>,
    script: Arc<Mutex<HashMap<String, VecDeque<u16>>>>,
}
impl Stub {
    async fn new() -> Self {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let script: Arc<Mutex<HashMap<String, VecDeque<u16>>>> = Arc::default();
        let (capture, answers) = (seen.clone(), script.clone());
        let router = Router::new().fallback(
            move |method: axum::http::Method,
                  uri: axum::http::Uri,
                  headers: HeaderMap,
                  body: axum::body::Bytes| {
                let (capture, answers) = (capture.clone(), answers.clone());
                async move {
                    assert_eq!(method, axum::http::Method::POST);
                    let key = headers["Idempotency-Key"].to_str().unwrap().to_owned();
                    let code = answers
                        .lock()
                        .unwrap()
                        .get_mut(&key)
                        .and_then(VecDeque::pop_front)
                        .unwrap_or(200);
                    capture.lock().unwrap().push(Seen {
                        path: uri.path().into(),
                        headers,
                        body: serde_json::from_slice(&body).unwrap(),
                    });
                    StatusCode::from_u16(code).unwrap()
                }
            },
        );
        let server = support::Server::new(router).await;
        let client = support_client(&server.pem);
        Self {
            server,
            client,
            seen,
            script,
        }
    }
    fn endpoint(&self) -> String {
        format!("{}/apprise/notify/lazysh-key", self.server.origin)
    }
    fn answer(&self, receipt: &Receipt, codes: &[u16]) {
        self.script
            .lock()
            .unwrap()
            .insert(receipt.receipt_id.clone(), codes.iter().copied().collect());
    }
    fn attempts(&self, receipt: &Receipt) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.headers["Idempotency-Key"] == receipt.receipt_id.as_str())
            .count()
    }
}
/// A relay whose destination is this stub, with one enabled public source.
async fn stub_relay(
    stub: &Stub,
    token: Option<&str>,
    tags: &[&str],
) -> (tempfile::TempDir, Service, Uuid) {
    let directory = tempfile::tempdir().unwrap();
    let config = apprise(directory.path(), &stub.endpoint(), token, tags).unwrap();
    let service = Service::open_with(config, stub.client.clone(), false).unwrap();
    let id = source(&service, SOURCE, "public-terminal").await;
    enable(&service).await;
    (directory, service, id)
}
pub(super) fn support_client(pem: &str) -> reqwest::Client {
    client_with_root(Some(
        reqwest::Certificate::from_pem(pem.as_bytes()).unwrap(),
    ))
    .unwrap()
}
/// Waits for finite receipt states while skipping the persisted two-second retry delay.
pub(super) async fn settle(service: &Service, source: Uuid, expected: &[(&Receipt, &str)]) {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let ids: Vec<(String, String)> = expected
                .iter()
                .map(|(receipt, state)| (receipt.receipt_id.clone(), state.to_string()))
                .collect();
            let done = service
                .db(move |s| {
                    s.connection
                        .execute("UPDATE events SET next=0 WHERE state='queued'", [])?;
                    let mut done = true;
                    for (id, state) in &ids {
                        done &= s.receipt(source, id)?.state == *state;
                    }
                    Ok(done)
                })
                .await
                .unwrap();
            if done {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn apprise_config_rejects_unsafe_endpoint_key_tags_or_proxy_token_without_echoing_them() {
    let directory = tempfile::tempdir().unwrap();
    let make = |endpoint: &str, token: Option<&str>, tags: &[&str]| {
        apprise(directory.path(), endpoint, token, tags)
    };
    assert!(make(KEY_URL, Some(PROXY), &[]).is_ok());
    assert!(make(KEY_URL, None, &[]).is_ok());
    assert!(make(
        "https://apprise.example/prefix/notify/Key_-09",
        Some(PROXY),
        &["a"; 8]
    )
    .is_ok());
    let key = "k".repeat(128);
    assert!(make(&format!("https://apprise.example/notify/{key}"), None, &[]).is_ok());
    for endpoint in [
        "http://apprise.example/notify/privatekey",
        "https://user:privatekey@apprise.example/notify/privatekey",
        "https://apprise.example/notify/privatekey?tag=private",
        "https://apprise.example/notify/privatekey#private",
        "https://apprise.example/notify/privatekey/",
        "https://apprise.example/notify/",
        "https://apprise.example/notify",
        "https://apprise.example/add/privatekey",
        "https://apprise.example/privatekey",
        "https://apprise.example/notify/private%20key",
        "https://apprise.example/notify/private.key",
        "https://apprise.example/notify/privaté",
        &format!("https://apprise.example/notify/private{}", "k".repeat(122)),
    ] {
        let error = make(endpoint, Some(PROXY), &[]).err().unwrap();
        assert!(!error.contains("private"), "{endpoint}: {error}");
    }
    for token in ["", "bad token", "private\r\nheader", "privaté", ADMIN] {
        let error = make(KEY_URL, Some(token), &[]).err().unwrap();
        assert!(!error.contains("private"));
    }
    let long = "t".repeat(65);
    for tags in [
        &["private tag"][..],
        &["private,tag"],
        &[""],
        &[long.as_str()],
        &["a"; 9],
    ] {
        let error = make(KEY_URL, Some(PROXY), tags).err().unwrap();
        assert!(!error.contains("private"));
    }
    let authenticated = make(KEY_URL, Some(PROXY), &[]).unwrap();
    assert!(authenticated.reserved(&digest(PROXY)));
    // An unauthenticated destination reserves no empty-token hash.
    assert!(!make(KEY_URL, None, &[]).unwrap().reserved(&digest("")));
}

#[test]
fn apprise_target_identity_covers_format_token_and_tag_set_but_not_tag_order() {
    let directory = tempfile::tempdir().unwrap();
    let identity = |token, tags: &[&str]| {
        apprise(directory.path(), KEY_URL, token, tags)
            .unwrap()
            .target_hash
    };
    let webhook = Config::new(directory.path().into(), ADMIN, KEY_URL, TARGET).unwrap();
    let gotify = Config::with_format(
        directory.path().into(),
        ADMIN,
        "https://apprise.example/message",
        TARGET,
        DestinationFormat::Gotify,
    )
    .unwrap();
    let apprise_target = identity(Some(TARGET), &[]);
    assert_ne!(apprise_target, webhook.target_hash);
    assert_ne!(apprise_target, gotify.target_hash);
    // The webhook and Gotify identities keep their original derivations.
    let hex = |value: &str| {
        digest(value)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    assert_eq!(
        webhook.target_hash,
        digest(&format!("{KEY_URL}\0{}", hex(TARGET)))
    );
    assert_eq!(
        gotify.target_hash,
        digest(&format!(
            "gotify\0https://apprise.example/message\0{}",
            hex(TARGET)
        ))
    );
    assert_eq!(
        apprise_target,
        digest(&format!("apprise\0{KEY_URL}\0{}", hex(TARGET)))
    );
    assert_eq!(
        identity(Some(PROXY), &["phone", "desk", "phone"]),
        digest(&format!("apprise\0{KEY_URL}\0{}\0desk,phone", hex(PROXY)))
    );
    assert_eq!(
        identity(Some(PROXY), &["desk", "phone"]),
        identity(Some(PROXY), &["phone", "desk"])
    );
    assert_ne!(identity(Some(PROXY), &["desk"]), identity(Some(PROXY), &[]));
    assert_ne!(identity(None, &[]), identity(Some(PROXY), &[]));
}

#[tokio::test]
async fn switching_to_apprise_or_changing_its_tags_requires_reconfiguration() {
    let directory = tempfile::tempdir().unwrap();
    drop(
        Service::open(Config::new(directory.path().into(), ADMIN, KEY_URL, TARGET).unwrap())
            .unwrap(),
    );
    let tagged = |tags: &[&str]| apprise(directory.path(), KEY_URL, Some(TARGET), tags).unwrap();
    assert!(Service::open(tagged(&[])).is_err());
    Service::reconfigure(tagged(&[])).unwrap();
    let current = Service::open(tagged(&[])).unwrap();
    let generation = current.db(|s| s.status()).await.unwrap().generation;
    drop(current);
    assert!(Service::open(tagged(&["phone"])).is_err());
    Service::reconfigure(tagged(&["phone"])).unwrap();
    let status = Service::open(tagged(&["phone"]))
        .unwrap()
        .db(|s| s.status())
        .await
        .unwrap();
    assert_eq!(status.generation, generation + 1);
    assert!(!status.enabled);
}

#[tokio::test]
async fn apprise_stub_receives_mapped_payload_with_proxy_bearer_tags_and_one_delivery_per_event() {
    let stub = Stub::new().await;
    let (_directory, service, id) =
        stub_relay(&stub, Some(PROXY), &["phone", "desk", "phone"]).await;
    let receipts = finite_state_receipts(&service).await;
    let repeated = Event {
        event_id: Uuid::parse_str(&receipts[2].event_id).unwrap(),
        kind: Kind::Done,
    };
    assert_eq!(
        enqueue(&service, SOURCE, &repeated).await.receipt_id,
        receipts[2].receipt_id
    );
    let (done, task) = start(service.clone()).await;
    settle(
        &service,
        id,
        &receipts
            .iter()
            .map(|receipt| (receipt, "accepted"))
            .collect::<Vec<_>>(),
    )
    .await;
    stop(done, task).await;
    let seen = stub.seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    for (receipt, (body, kind)) in receipts.iter().zip([
        ("An agent is working.", "info"),
        ("An agent needs your attention.", "warning"),
        ("An agent finished.", "success"),
    ]) {
        let request = seen
            .iter()
            .find(|seen| seen.headers["Idempotency-Key"] == receipt.receipt_id.as_str())
            .unwrap();
        assert_eq!(request.path, "/apprise/notify/lazysh-key");
        assert_eq!(
            request.headers["Authorization"],
            format!("Bearer {PROXY}").as_str()
        );
        assert_eq!(request.headers["Content-Type"], "application/json");
        assert_eq!(
            request.body,
            serde_json::json!({
                "title": "lazysh · public-terminal",
                "body": body,
                "type": kind,
                "format": "text",
                "tag": "desk,phone",
            })
        );
        for secret in [
            ADMIN,
            SOURCE,
            PROXY,
            "lazysh-key",
            &receipt.receipt_id,
            &receipt.event_id,
        ] {
            assert!(!request.body.to_string().contains(secret));
        }
    }
}

#[tokio::test]
async fn apprise_partial_permanent_and_retryable_answers_end_in_bounded_finite_receipts() {
    let stub = Stub::new().await;
    let (_directory, service, id) = stub_relay(&stub, None, &[]).await;
    let mut receipts = Vec::new();
    for codes in [
        &[424][..],
        &[404],
        &[401],
        &[204],
        &[429, 500, 200],
        &[408, 503, 502],
    ] {
        let receipt = enqueue(&service, SOURCE, &event()).await;
        stub.answer(&receipt, codes);
        receipts.push(receipt);
    }
    let expected = [
        ("partial", 1),
        ("rejected", 1),
        ("rejected", 1),
        ("rejected", 1),
        ("accepted", 3),
        ("failed_unknown", 3),
    ];
    let (done, task) = start(service.clone()).await;
    settle(
        &service,
        id,
        &receipts
            .iter()
            .zip(expected)
            .map(|(receipt, (state, _))| (receipt, state))
            .collect::<Vec<_>>(),
    )
    .await;
    // Terminal answers never trigger another attempt, even after the retry delay.
    tokio::time::sleep(Duration::from_millis(300)).await;
    stop(done, task).await;
    for (receipt, (state, attempts)) in receipts.iter().zip(expected) {
        assert_eq!(stub.attempts(receipt), attempts, "{state}");
        let saved = service
            .db({
                let receipt = receipt.receipt_id.clone();
                move |s| s.receipt(id, &receipt)
            })
            .await
            .unwrap();
        assert_eq!(saved.state, state);
        assert!(saved.may_have_reached_destination);
    }
    for seen in stub.seen.lock().unwrap().iter() {
        assert!(!seen.headers.contains_key("Authorization"));
        assert!(seen.body.get("tag").is_none());
    }
}
