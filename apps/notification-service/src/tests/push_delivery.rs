use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use web_push_native::p256::{self, elliptic_curve::sec1::ToEncodedPoint};
const ENROLLMENT: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DEVICE: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

struct Fixture {
    _directory: tempfile::TempDir,
    sink: support::Server,
    service: Service,
    received: tokio::sync::mpsc::Receiver<(String, Vec<u8>)>,
    key: p256::SecretKey,
    worker: Option<JoinHandle<Result<(), ApiError>>>,
}
impl Fixture {
    async fn new() -> Self {
        let (sender, received) = tokio::sync::mpsc::channel(16);
        let router = Router::new()
            .route(
                "/up/{slot}",
                post(
                    move |uri: axum::http::Uri, headers: HeaderMap, body: axum::body::Bytes| {
                        let sender = sender.clone();
                        async move {
                            assert_eq!(headers["Content-Encoding"], "aes128gcm");
                            assert_eq!(headers["TTL"], "300");
                            assert!(headers["Authorization"]
                                .to_str()
                                .unwrap()
                                .starts_with("vapid t="));
                            assert!(body.len() <= push::MAX_WIRE_BYTES);
                            let redirect = uri.path() == "/up/redirect";
                            sender.send((uri.to_string(), body.to_vec())).await.unwrap();
                            if redirect {
                                (
                                    StatusCode::TEMPORARY_REDIRECT,
                                    [(header::LOCATION, "/up/unexpected")],
                                )
                                    .into_response()
                            } else {
                                StatusCode::CREATED.into_response()
                            }
                        }
                    },
                ),
            )
            .layer(DefaultBodyLimit::max(push::MAX_WIRE_BYTES));
        let sink = support::Server::new(router).await;
        let config = push::PushConfig::generate(
            sink.origin.clone(),
            vec!["127.0.0.1".parse().unwrap()],
            "mailto:test@example.invalid".into(),
        )
        .unwrap()
        .with_test_root(reqwest::Certificate::from_pem(sink.pem.as_bytes()).unwrap());
        let directory = tempfile::tempdir().unwrap();
        let service =
            Service::open(Config::web_push(directory.path().join("state"), ADMIN, config).unwrap())
                .unwrap();
        Self {
            _directory: directory,
            sink,
            service,
            received,
            key: p256::SecretKey::from_slice(&[7; 32]).unwrap(),
            worker: None,
        }
    }
    async fn post(
        &self,
        path: &str,
        token: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        call(&self.service, "POST", path, token, body).await
    }
    fn subscription(&self, slot: &str, request: Uuid) -> serde_json::Value {
        serde_json::json!({"requestId":request,"endpoint":format!("{}/up/{slot}?cap=A%2fB",self.sink.origin),"p256dh":URL_SAFE_NO_PAD.encode(self.key.public_key().to_encoded_point(false).as_bytes()),"auth":URL_SAFE_NO_PAD.encode([9;16])})
    }
    async fn bootstrap(&self) -> serde_json::Value {
        assert_eq!(
            self.post(
                "/v1/admin/push/enrollment",
                ADMIN,
                serde_json::json!({"capability":ENROLLMENT})
            )
            .await
            .0,
            StatusCode::OK
        );
        let (code, body) = self
            .post(
                "/v1/push/bootstrap",
                ENROLLMENT,
                serde_json::json!({"requestId":Uuid::new_v4(),"credential":DEVICE}),
            )
            .await;
        assert_eq!(code, StatusCode::OK);
        body
    }
    async fn message(&mut self) -> (String, serde_json::Value) {
        let (path, wire) = tokio::time::timeout(Duration::from_secs(3), self.received.recv())
            .await
            .unwrap()
            .unwrap();
        let plaintext =
            web_push_native::decrypt(wire, &self.key, &web_push_native::Auth::from([9; 16]))
                .unwrap();
        (path, serde_json::from_slice(&plaintext).unwrap())
    }
    async fn confirm(&self, challenge: &serde_json::Value) {
        assert_eq!(self.post("/v1/push/confirm",DEVICE,serde_json::json!({"challengeId":challenge["challengeId"],"nonce":challenge["nonce"]})).await.0,StatusCode::OK);
    }
    async fn activate(&mut self) {
        self.bootstrap().await;
        let (code, response) = self
            .post(
                "/v1/push/subscription",
                DEVICE,
                self.subscription("first", Uuid::new_v4()),
            )
            .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(response["pushServiceAccepted"], true);
        let (_, challenge) = self.message().await;
        self.confirm(&challenge).await;
        enable(&self.service).await;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
    }
}

#[tokio::test]
async fn encrypted_challenge_gates_delivery_and_opaque_endpoint_is_preserved() {
    let mut fixture = Fixture::new().await;
    let bootstrap = fixture.bootstrap().await;
    assert_eq!(bootstrap["confirmed"], false);
    assert_eq!(
        fixture
            .post(
                "/v1/admin/destination/enable",
                ADMIN,
                serde_json::Value::Null
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let request = Uuid::new_v4();
    let subscription = fixture.subscription("first", request);
    let (status, response) = fixture
        .post("/v1/push/subscription", DEVICE, subscription.clone())
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(response.get("nonce").is_none());
    assert!(response.get("endpoint").is_none());
    let (path, challenge) = fixture.message().await;
    assert_eq!(path, "/up/first?cap=A%2fB");
    assert_eq!(challenge["kind"], "challenge");
    assert_eq!(challenge["deviceId"], bootstrap["deviceId"]);
    assert_eq!(challenge["generation"], bootstrap["generation"]);
    assert_eq!(
        fixture
            .post("/v1/push/subscription", DEVICE, subscription)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        fixture.message().await.1,
        challenge,
        "idempotent admission must reuse the encrypted challenge"
    );
    let wrong = serde_json::json!({"challengeId":challenge["challengeId"],"nonce":TARGET});
    assert_eq!(
        fixture.post("/v1/push/confirm", DEVICE, wrong).await.0,
        StatusCode::CONFLICT
    );
    fixture.confirm(&challenge).await;
    let source = source(&fixture.service, SOURCE, "owned-test").await;
    enable(&fixture.service).await;
    let (stop, receiver) = watch::channel(false);
    let service = fixture.service.clone();
    fixture.worker = Some(tokio::spawn(async move { service.worker(receiver).await }));
    let receipt = enqueue(&fixture.service, SOURCE, &event()).await;
    let (path, payload) = fixture.message().await;
    assert_eq!(path, "/up/first?cap=A%2fB");
    assert_eq!(payload["receiptId"], receipt.receipt_id);
    assert_eq!(payload["kind"], "needs_attention");
    assert_eq!(payload["alias"], "owned-test");
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let id = receipt.receipt_id.clone();
            if fixture
                .service
                .db(move |store| store.receipt(source, &id))
                .await
                .unwrap()
                .state
                == "accepted"
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    stop.send_replace(true);
    fixture.worker.take().unwrap().await.unwrap().unwrap();
    let (_, status) = call(
        &fixture.service,
        "GET",
        "/v1/admin/status",
        ADMIN,
        serde_json::Value::Null,
    )
    .await;
    for secret in ["endpoint", "publicVapidKey", "auth", "credential", "nonce"] {
        assert!(status.get(secret).is_none());
    }
}

#[tokio::test]
async fn rotation_cannot_redirect_already_admitted_event_and_revocation_stops_future_claims() {
    let mut fixture = Fixture::new().await;
    fixture.activate().await;
    source(&fixture.service, SOURCE, "rotation").await;
    enqueue(&fixture.service, SOURCE, &event()).await;
    let job = fixture
        .service
        .db(|store| Ok(store.claim()?.unwrap()))
        .await
        .unwrap();
    let original = job.push.as_ref().unwrap().endpoint.clone();
    fixture
        .service
        .db(move |store| store.finish(&job, false))
        .await
        .unwrap();
    assert_eq!(
        fixture
            .post(
                "/v1/push/subscription",
                DEVICE,
                fixture.subscription("rotated", Uuid::new_v4())
            )
            .await
            .0,
        StatusCode::OK
    );
    let (_, challenge) = fixture.message().await;
    fixture.confirm(&challenge).await;
    let retry = fixture
        .service
        .db(|store| {
            store.connection.execute("UPDATE events SET next=0", [])?;
            Ok(store.claim()?.unwrap())
        })
        .await
        .unwrap();
    assert_eq!(retry.push.as_ref().unwrap().endpoint, original);
    fixture
        .service
        .db(move |store| store.finish(&retry, true))
        .await
        .unwrap();
    enqueue(&fixture.service, SOURCE, &event()).await;
    let next = fixture
        .service
        .db(|store| Ok(store.claim()?.unwrap()))
        .await
        .unwrap();
    assert!(next
        .push
        .as_ref()
        .unwrap()
        .endpoint
        .contains("/up/rotated?"));
    assert_eq!(
        fixture
            .post("/v1/push/revoke", DEVICE, serde_json::Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        fixture
            .post("/v1/push/revoke", DEVICE, serde_json::Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert!(fixture
        .service
        .db(|store| store.claim())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        fixture
            .post(
                "/v1/push/subscription",
                DEVICE,
                fixture.subscription("forbidden", Uuid::new_v4())
            )
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn expired_or_reused_capabilities_and_changed_keys_cannot_enroll() {
    let mut fixture = Fixture::new().await;
    fixture.activate().await;
    let mut changed = fixture.subscription("first", Uuid::new_v4());
    changed["auth"] = serde_json::json!(URL_SAFE_NO_PAD.encode([8; 16]));
    assert_eq!(
        fixture
            .post("/v1/push/subscription", DEVICE, changed)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fixture
            .post(
                "/v1/admin/push/reset",
                ADMIN,
                serde_json::json!({"capability":ENROLLMENT})
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let fresh = crate::secret();
    assert_eq!(
        fixture
            .post(
                "/v1/admin/push/reset",
                ADMIN,
                serde_json::json!({"capability":fresh.as_str()})
            )
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        fixture
            .post("/v1/push/revoke", DEVICE, serde_json::Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let bootstrap = serde_json::json!({"requestId":Uuid::new_v4(),"credential":DEVICE});
    assert_eq!(
        fixture
            .post("/v1/push/bootstrap", &fresh, bootstrap.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    fixture
        .service
        .db(|store| {
            store
                .connection
                .execute("UPDATE push_device SET enrollment_expires=0", [])?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        fixture
            .post("/v1/push/bootstrap", &fresh, bootstrap)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn malformed_metadata_and_unapproved_origins_return_only_finite_errors() {
    let fixture = Fixture::new().await;
    fixture.bootstrap().await;
    let mut wrong = fixture.subscription("first", Uuid::new_v4());
    wrong["endpoint"] =
        serde_json::json!("https://unapproved.invalid/private-endpoint?secret=never-echo");
    let (status, error) = fixture.post("/v1/push/subscription", DEVICE, wrong).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        error,
        serde_json::json!({"error":"invalid_push_subscription"})
    );
    let (status, error) = fixture
        .post(
            "/v1/push/bootstrap",
            ENROLLMENT,
            serde_json::json!({"credential":"never-echo","requestId":"never-echo"}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error, serde_json::json!({"error":"invalid_push_request"}));
    assert!(fixture
        .service
        .db(|store| Ok(store.connection.query_row(
            "SELECT candidate IS NULL FROM push_device",
            [],
            |r| r.get::<_, bool>(0)
        )?))
        .await
        .unwrap());
}

#[tokio::test]
async fn private_sink_proves_tls_pin_redirect_and_persisted_origin_fail_closed() {
    let mut fixture = Fixture::new().await;
    fixture.bootstrap().await;
    let (_, reply) = fixture
        .post(
            "/v1/push/subscription",
            DEVICE,
            fixture.subscription("redirect", Uuid::new_v4()),
        )
        .await;
    assert_eq!(reply["pushServiceAccepted"], false);
    assert_eq!(fixture.message().await.0, "/up/redirect?cap=A%2fB");
    assert!(
        fixture.received.try_recv().is_err(),
        "redirect must not post to the next endpoint"
    );
    let config = push::PushConfig::generate(
        fixture.sink.origin.clone(),
        vec!["127.0.0.1".parse().unwrap()],
        "mailto:test@example.invalid".into(),
    )
    .unwrap();
    let input = fixture.subscription("first", Uuid::new_v4());
    let subscription = config
        .subscription(
            input["endpoint"].as_str().unwrap().into(),
            input["p256dh"].as_str().unwrap().into(),
            input["auth"].as_str().unwrap().into(),
        )
        .unwrap();
    let mut wire = config
        .encrypt(&subscription, b"owned-tls-probe", 300)
        .unwrap();
    assert!(
        config
            .request(&wire, &config.client().unwrap())
            .unwrap()
            .send()
            .await
            .is_err(),
        "system trust must reject the owned untrusted certificate"
    );
    let wrong_pin = push::PushConfig::generate(
        fixture.sink.origin.clone(),
        vec!["127.0.0.2".parse().unwrap()],
        "mailto:test@example.invalid".into(),
    )
    .unwrap()
    .with_test_root(reqwest::Certificate::from_pem(fixture.sink.pem.as_bytes()).unwrap());
    assert!(
        wrong_pin
            .request(&wire, &wrong_pin.client().unwrap())
            .unwrap()
            .send()
            .await
            .is_err(),
        "explicit pins must not fall back to localhost DNS"
    );
    wire.endpoint = "https://unapproved.invalid/secret".into();
    assert!(
        config.request(&wire, &config.client().unwrap()).is_err(),
        "persisted wire must be checked before networking"
    );
    assert!(fixture.received.try_recv().is_err());
}
