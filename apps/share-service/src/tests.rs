use super::*;
use axum::http::Request as HttpRequest;
use reqwest::Client;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower::ServiceExt;

const TOKEN: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
struct Fixture {
    directory: tempfile::TempDir,
    service: Service,
    base: String,
    client: Client,
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}
impl Fixture {
    async fn new(max_storage: u64, max_files: u32) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut config = Config::new(
            directory.path().join("private"),
            "https://shares.example",
            TOKEN,
        )
        .unwrap();
        config.max_storage = max_storage;
        config.max_files = max_files;
        let service = Service::open(config).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = oneshot::channel();
        let run = service.clone();
        let task = tokio::spawn(serve(listener, run, async {
            let _ = stopped.await;
        }));
        Self {
            directory,
            service,
            base,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            stop,
            task,
        }
    }
    async fn upload(
        &self,
        name: &str,
        mime: &str,
        bytes: impl Into<reqwest::Body>,
    ) -> reqwest::Response {
        self.client
            .post(format!("{}/v1/shares", self.base))
            .bearer_auth(TOKEN)
            .query(&[("filename", name), ("ttlSeconds", "3600")])
            .header("content-type", mime)
            .body(bytes)
            .send()
            .await
            .unwrap()
    }
    async fn history(&self) -> serde_json::Value {
        self.client
            .get(format!("{}/v1/shares", self.base))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn wait_for_request_capacity_to_fill(&self) {
        timeout(Duration::from_secs(2), async {
            while self.service.requests.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    async fn assert_history_overloaded(&self) {
        let response = self
            .service
            .router()
            .oneshot(
                HttpRequest::builder()
                    .uri("/v1/shares")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
    async fn stop(self) -> tempfile::TempDir {
        let _ = self.stop.send(());
        self.task.await.unwrap().unwrap();
        drop(self.service);
        self.directory
    }
}

#[tokio::test]
async fn authenticated_upload_history_download_and_delete_work_over_real_http() {
    let fixture = Fixture::new(1024 * 1024, 10).await;
    let unauthorized = fixture
        .client
        .post(format!("{}/v1/shares?filename=secret.txt", fixture.base))
        .header("content-type", "text/plain")
        .body("secret")
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(unauthorized.headers()["www-authenticate"], "Bearer");
    assert!(!unauthorized.text().await.unwrap().contains(TOKEN));
    let created = fixture
        .upload("review🌲.html", "text/html", "<script>secret()</script>")
        .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created: serde_json::Value = created.json().await.unwrap();
    let share: Share = serde_json::from_value(created["share"].clone()).unwrap();
    assert_eq!(created["schemaVersion"], 1);
    assert!(valid_id(&share.id));
    assert_eq!(share.url, format!("https://shares.example/s/{}", share.id));
    let downloaded = fixture
        .client
        .get(format!("{}/s/{}", fixture.base, share.id))
        .send()
        .await
        .unwrap();
    assert_eq!(downloaded.status(), StatusCode::OK);
    assert_eq!(
        downloaded.headers()["content-type"],
        "application/octet-stream"
    );
    assert_eq!(downloaded.headers()["x-content-type-options"], "nosniff");
    assert_eq!(downloaded.headers()["cache-control"], "no-store");
    assert!(downloaded.headers()["content-disposition"]
        .to_str()
        .unwrap()
        .starts_with("attachment;"));
    assert_eq!(
        downloaded.text().await.unwrap(),
        "<script>secret()</script>"
    );
    let history = fixture.history().await;
    assert_eq!(history["shares"][0]["id"], share.id);
    assert!(!history.to_string().contains(TOKEN));
    assert_eq!(
        fixture
            .client
            .delete(format!("{}/v1/shares/{}", fixture.base, share.id))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        fixture
            .client
            .delete(format!("{}/v1/shares/{}", fixture.base, share.id))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        fixture
            .client
            .get(format!("{}/s/{}", fixture.base, share.id))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    fixture.stop().await.close().unwrap();
}

#[tokio::test]
async fn malformed_metadata_mime_and_oversized_bodies_never_create_shares() {
    let fixture = Fixture::new(1024 * 1024, 10).await;
    for (name, mime, body, expected) in [
        ("../secret", "text/plain", "abc", StatusCode::BAD_REQUEST),
        (
            "image.png",
            "image/png",
            "not png",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "file",
            "invalid-mime",
            "abc",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
    ] {
        assert_eq!(fixture.upload(name, mime, body).await.status(), expected);
    }
    let invalid_ttl = fixture
        .client
        .post(format!(
            "{}/v1/shares?filename=file&ttlSeconds=59",
            fixture.base
        ))
        .bearer_auth(TOKEN)
        .header("content-type", "text/plain")
        .body("abc")
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_ttl.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        fixture
            .upload("large", "application/octet-stream", vec![0; MAX_UPLOAD + 1])
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let history = fixture.history().await;
    assert_eq!(history["shares"], serde_json::json!([]));
    fixture.stop().await.close().unwrap();
}

#[tokio::test]
async fn quota_and_cursor_paging_survive_same_second_uploads_and_deletion() {
    let fixture = Fixture::new(9, 3).await;
    for name in ["one", "two", "three"] {
        assert_eq!(
            fixture.upload(name, "text/plain", "abc").await.status(),
            StatusCode::CREATED
        );
    }
    assert_eq!(
        fixture.upload("overflow", "text/plain", "x").await.status(),
        StatusCode::INSUFFICIENT_STORAGE
    );
    let first: serde_json::Value = fixture
        .client
        .get(format!("{}/v1/shares?limit=2", fixture.base))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["shares"].as_array().unwrap().len(), 2);
    let cursor = first["nextCursor"].as_str().unwrap();
    let id = first["shares"][1]["id"].as_str().unwrap();
    assert_eq!(
        fixture
            .client
            .delete(format!("{}/v1/shares/{id}", fixture.base))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let second: serde_json::Value = fixture
        .client
        .get(format!("{}/v1/shares", fixture.base))
        .bearer_auth(TOKEN)
        .query(&[("cursor", cursor), ("limit", "2")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(second["shares"].as_array().unwrap().len(), 1);
    assert!(second["nextCursor"].is_null());
    assert_ne!(first["shares"][0]["id"], second["shares"][0]["id"]);
    assert_eq!(
        fixture.upload("new", "text/plain", "abc").await.status(),
        StatusCode::CREATED
    );
    fixture.stop().await.close().unwrap();
}

#[tokio::test]
async fn expiry_is_enforced_before_cleanup_and_restart_removes_only_orphan_blobs() {
    let fixture = Fixture::new(1024 * 1024, 10).await;
    let share = fixture
        .service
        .store
        .lock()
        .unwrap()
        .create(
            "old".into(),
            "text/plain".into(),
            b"old",
            60,
            now() - 61,
            "https://shares.example",
        )
        .unwrap();
    let objects = fixture.directory.path().join("private/objects");
    assert!(objects.join(format!("blob-{}", share.id)).exists());
    assert_eq!(
        fixture
            .client
            .get(format!("{}/s/{}", fixture.base, share.id))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    fixture.service.cleanup().await;
    assert!(!objects.join(format!("blob-{}", share.id)).exists());
    let directory = fixture.stop().await;
    let orphan = objects.join(format!("blob-{}", random_secret()));
    std::fs::write(&orphan, "partial upload").unwrap();
    std::fs::write(objects.join("unrelated.txt"), "keep").unwrap();
    let service = Service::open(
        Config::new(
            directory.path().join("private"),
            "https://shares.example",
            TOKEN,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(!orphan.exists());
    assert!(objects.join("unrelated.txt").exists());
    assert!(Service::open(
        Config::new(
            directory.path().join("private"),
            "https://shares.example",
            TOKEN
        )
        .unwrap()
    )
    .is_err());
    drop(service);
    directory.close().unwrap();
}

#[tokio::test]
async fn download_permits_live_until_the_body_is_consumed_or_dropped() {
    let fixture = Fixture::new(1024 * 1024, 10).await;
    let created: serde_json::Value = fixture
        .upload("file", "text/plain", "abc")
        .await
        .json()
        .await
        .unwrap();
    let uri = format!("/s/{}", created["share"]["id"].as_str().unwrap());
    let mut responses = Vec::new();
    for _ in 0..4 {
        let response = fixture
            .service
            .router()
            .oneshot(
                HttpRequest::builder()
                    .uri(&uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        responses.push(response);
    }
    let request = || {
        HttpRequest::builder()
            .uri(&uri)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        fixture
            .service
            .router()
            .oneshot(request())
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    drop(responses.pop());
    let response = fixture.service.router().oneshot(request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);
    drop(responses);
    fixture.stop().await.close().unwrap();
}

#[tokio::test]
async fn slow_authenticated_uploads_have_a_bounded_concurrency_limit() {
    let fixture = Fixture::new(1024 * 1024, 10).await;
    let mut uploads = Vec::new();
    for _ in 0..4 {
        let router = fixture.service.router();
        uploads.push(tokio::spawn(async move {
            let stream = futures_util::stream::pending::<std::io::Result<Bytes>>();
            router
                .oneshot(
                    HttpRequest::builder()
                        .method("POST")
                        .uri("/v1/shares?filename=pending")
                        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                        .header(header::CONTENT_TYPE, "text/plain")
                        .body(Body::from_stream(stream))
                        .unwrap(),
                )
                .await
                .unwrap()
        }));
    }
    fixture.wait_for_request_capacity_to_fill().await;
    fixture.assert_history_overloaded().await;
    for task in uploads {
        task.abort();
        let _ = task.await;
    }
    fixture.stop().await.close().unwrap();
}

#[tokio::test]
async fn cancelled_http_requests_retain_quota_until_their_disk_operations_finish() {
    let fixture = Fixture::new(1024 * 1024, 10).await;
    let store = fixture.service.store.clone();
    let (locked, acquired) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let blocker = tokio::task::spawn_blocking(move || {
        let _guard = store.lock().unwrap();
        let _ = locked.send(());
        let _ = released.recv();
    });
    acquired.await.unwrap();
    let mut uploads = Vec::new();
    for _ in 0..4 {
        let router = fixture.service.router();
        uploads.push(tokio::spawn(async move {
            router
                .oneshot(
                    HttpRequest::builder()
                        .method("POST")
                        .uri("/v1/shares?filename=file")
                        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                        .header(header::CONTENT_TYPE, "text/plain")
                        .body(Body::from("x"))
                        .unwrap(),
                )
                .await
                .unwrap()
        }));
    }
    fixture.wait_for_request_capacity_to_fill().await;
    for upload in uploads {
        upload.abort();
        let _ = upload.await;
    }
    fixture.assert_history_overloaded().await;
    release.send(()).unwrap();
    blocker.await.unwrap();
    timeout(Duration::from_secs(5), async {
        while fixture.service.requests.available_permits() != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    fixture.stop().await.close().unwrap();
}

#[test]
fn rejects_unsafe_enrollment_and_private_storage_symlinks() {
    let directory = tempfile::tempdir().unwrap();
    for origin in [
        "http://shares.example",
        "https://user@shares.example",
        "https://@shares.example",
        "https:///shares.example",
        "https://shares.example/path",
        "https://shares.example/?token=secret",
        "https://shares.example/#secret",
    ] {
        assert!(
            Config::new(directory.path().into(), origin, TOKEN).is_err(),
            "accepted {origin}"
        );
    }
    assert!(Config::new(directory.path().into(), "https://shares.example", "weak").is_err());
    #[cfg(unix)]
    {
        let target = directory.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(target, &link).unwrap();
        assert!(
            Service::open(Config::new(link, "https://shares.example", TOKEN).unwrap()).is_err()
        );
    }
}
