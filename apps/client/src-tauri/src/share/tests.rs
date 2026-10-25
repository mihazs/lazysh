use super::*;
use std::sync::atomic::AtomicUsize;
use tokio::{
    io::copy_bidirectional,
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinSet,
};
use tokio_rustls::{
    rustls::{
        pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
        ServerConfig,
    },
    TlsAcceptor,
};

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
#[tokio::test]
async fn dropped_configuration_caller_cannot_release_an_admitted_blocking_write() {
    let state = ShareState::default();
    let guard = changing(&state).unwrap();
    let (entered, started) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let task = tokio::spawn(configuration_write(guard, move || {
        entered.send(()).unwrap();
        wait.recv().unwrap();
        Ok(())
    }));
    started.await.unwrap();
    task.abort();
    let _ = task.await;
    assert!(
        changing(&state).is_err(),
        "the original OS write still owns configuration admission"
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.changing.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(changing(&state).is_ok());
}
#[tokio::test]
async fn lock_invalidates_enrollment_reads_and_cancels_uploads_and_thumbnail() {
    let state = ShareState::default();
    let mut slots = state.uploads.lock().await;
    let pending = insert(
        &mut slots,
        enrollment(),
        "pending.txt".into(),
        "text/plain".into(),
        4,
        60,
    )
    .unwrap();
    let running = insert(
        &mut slots,
        enrollment(),
        "running.txt".into(),
        "text/plain".into(),
        4,
        60,
    )
    .unwrap();
    let pending_signal = slots[&pending].cancel.subscribe();
    let running_signal = slots[&running].cancel.subscribe();
    slots.get_mut(&running).unwrap().pending.take();
    drop(slots);
    let (cancel, thumbnail_signal) = watch::channel(false);
    *state.thumbnail.lock().await = Some(ThumbnailWork {
        request_id: "preview".into(),
        cancel,
    });
    let generation = state.generation.load(Ordering::Acquire);
    state.cancel_for_lock().await;
    assert!(state.generation.load(Ordering::Acquire) != generation);
    assert!(*pending_signal.borrow());
    assert!(*running_signal.borrow());
    assert!(*thumbnail_signal.borrow());
    let slots = state.uploads.lock().await;
    assert!(!slots.contains_key(&pending));
    assert!(
        slots.contains_key(&running),
        "owned in-flight cleanup retains its slot until completion"
    );
}
struct Fixture {
    directory: tempfile::TempDir,
    origin: String,
    backend: Option<tokio::task::JoinHandle<()>>,
    tls: tokio::task::JoinHandle<()>,
    stop: Option<oneshot::Sender<()>>,
    client: Client,
}
impl Fixture {
    async fn new(router: Option<axum::Router>) -> Self {
        let directory = tempfile::tempdir().unwrap();
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_address = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel();
        let backend = if let Some(router) = router {
            tokio::spawn(async move {
                axum::serve(listener, router)
                    .with_graceful_shutdown(async {
                        let _ = stopped.await;
                    })
                    .await
                    .unwrap();
            })
        } else {
            let config =
                lazysh_share::Config::new(directory.path().join("state"), &origin, TOKEN).unwrap();
            let service = lazysh_share::Service::open(config).unwrap();
            tokio::spawn(async move {
                lazysh_share::serve(listener, service, async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
            })
        };
        let tls = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = front.accept() => { let Ok((socket, _)) = accepted else { return }; let acceptor = acceptor.clone(); connections.spawn(async move { if let Ok(mut incoming) = acceptor.accept(socket).await { if let Ok(mut outgoing) = TcpStream::connect(backend_address).await { let _ = copy_bidirectional(&mut incoming, &mut outgoing).await; } } }); },
                    _ = connections.join_next(), if !connections.is_empty() => {},
                }
            }
        });
        let client = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve("localhost", address)
            .add_root_certificate(root)
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        Self {
            directory,
            origin,
            backend: Some(backend),
            tls,
            stop: Some(stop),
            client,
        }
    }
    fn enrollment(&self) -> Enrollment {
        Enrollment {
            version: 1,
            origin: self.origin.clone(),
            token: TOKEN.into(),
        }
    }
    async fn stop(mut self) {
        self.tls.abort();
        let _ = self.tls.await;
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(backend) = self.backend.take() {
            backend.await.unwrap();
        }
        drop(self.client);
        self.directory.close().unwrap();
    }
}
fn enrollment() -> Enrollment {
    Enrollment {
        version: 1,
        origin: "https://shares.example".into(),
        token: TOKEN.into(),
    }
}

#[test]
fn rejects_unsafe_configuration_and_unexpected_download_urls() {
    for value in [
        "http://example.com",
        "https://user:pass@example.com",
        "https://@example.com",
        "https:///example.com",
        "https://example.com/path",
        "https://example.com/?token=x",
        "https://example.com/#fragment",
        "https://exa\nmple.com",
    ] {
        assert!(origin(value).is_err(), "accepted {value}");
    }
    assert!(decode(&format!(
        r#"{{"version":1,"origin":"https://shares.example/path","token":"{TOKEN}"}}"#
    ))
    .is_err());
    let share = |url: &str| SharedFile {
        id: "a".repeat(64),
        name: "file".into(),
        mime: "text/plain".into(),
        size: 1,
        created_at: 1000,
        expires_at: 4600,
        url: url.into(),
    };
    for url in [
        "https://evil.example/s/aaa",
        "file:///etc/passwd",
        "https://shares.example/s/aaa?token=x",
    ] {
        assert!(share(url).validate("https://shares.example").is_err());
    }
    assert!(
        share(&format!("https://shares.example/s/{}", "a".repeat(64)))
            .validate("https://shares.example")
            .is_ok()
    );
}

#[test]
fn blank_management_tokens_reuse_only_the_exact_existing_service() {
    assert_eq!(
        &*configured_token(
            "https://shares.example",
            Zeroizing::new(String::new()),
            Some(enrollment())
        )
        .unwrap(),
        TOKEN
    );
    assert!(configured_token(
        "https://different.example",
        Zeroizing::new(String::new()),
        Some(enrollment())
    )
    .is_err());
    assert!(configured_token(
        "https://shares.example",
        Zeroizing::new(String::new()),
        None
    )
    .is_err());
    assert!(configured_token(
        "https://shares.example",
        Zeroizing::new("invalid".into()),
        None
    )
    .is_err());
}

#[tokio::test]
async fn chunk_order_size_quota_expiry_and_incomplete_finish_are_enforced() {
    let state = ShareState::default();
    let mut uploads = state.uploads.lock().await;
    let id = insert(
        &mut uploads,
        enrollment(),
        "file".into(),
        "text/plain".into(),
        3,
        3600,
    )
    .unwrap();
    assert!(chunk(&mut uploads, &id, 1, b"a").is_err());
    assert!(chunk(&mut uploads, &id, 0, &vec![0; 256 * 1024 + 1]).is_err());
    chunk(&mut uploads, &id, 0, b"a").unwrap();
    assert!(chunk(&mut uploads, &id, 0, b"a").is_err());
    let second = insert(
        &mut uploads,
        enrollment(),
        "second".into(),
        "text/plain".into(),
        0,
        3600,
    )
    .unwrap();
    assert!(insert(
        &mut uploads,
        enrollment(),
        "third".into(),
        "text/plain".into(),
        0,
        3600
    )
    .is_err());
    uploads.get_mut(&second).unwrap().touched = Instant::now() - IDLE - Duration::from_secs(1);
    prune(&mut uploads);
    assert!(!uploads.contains_key(&second));
    drop(uploads);
    assert!(finish(&state, id.clone(), client().unwrap())
        .await
        .err()
        .unwrap()
        .contains("incomplete"));
    assert!(state.uploads.lock().await.contains_key(&id));
    cancel_all(&state).await;
    assert!(state.uploads.lock().await.is_empty());
}

#[tokio::test]
async fn actual_https_upload_history_and_delete_work_without_exposing_management_token() {
    let fixture = Fixture::new(None).await;
    let state = ShareState::default();
    let id = insert(
        &mut *state.uploads.lock().await,
        fixture.enrollment(),
        "hello🌲.txt".into(),
        "text/plain".into(),
        5,
        3600,
    )
    .unwrap();
    chunk(&mut *state.uploads.lock().await, &id, 0, b"hello").unwrap();
    let result = finish(&state, id, fixture.client.clone()).await.unwrap();
    assert_eq!(result.share.name, "hello🌲.txt");
    assert_eq!(result.share.size, 5);
    assert!(!serde_json::to_string(&result).unwrap().contains(TOKEN));
    assert!(state.uploads.lock().await.is_empty());
    let history = list(fixture.client.clone(), &fixture.enrollment(), 50, None)
        .await
        .unwrap();
    assert_eq!(history.shares.len(), 1);
    delete(
        fixture.client.clone(),
        &fixture.enrollment(),
        &result.share.id,
    )
    .await
    .unwrap();
    assert!(
        list(fixture.client.clone(), &fixture.enrollment(), 50, None)
            .await
            .unwrap()
            .shares
            .is_empty()
    );
    fixture.stop().await;
}

#[tokio::test]
async fn redirects_are_not_followed_and_error_bodies_are_not_exposed() {
    let calls = Arc::new(AtomicUsize::new(0));
    let called = calls.clone();
    let router = axum::Router::new()
        .route(
            "/v1/shares",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::TEMPORARY_REDIRECT,
                    [("location", "/leak")],
                    "secret server response",
                )
            }),
        )
        .route(
            "/leak",
            axum::routing::post(move || {
                called.fetch_add(1, Ordering::SeqCst);
                async { "leaked" }
            }),
        );
    let fixture = Fixture::new(Some(router)).await;
    let pending = Pending {
        enrollment: fixture.enrollment(),
        name: "file".into(),
        mime: "text/plain".into(),
        ttl: 3600,
        data: Zeroizing::new(b"sensitive file".to_vec()),
    };
    let error = send(fixture.client.clone(), pending).await.err().unwrap();
    assert!(!error.contains("secret"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    fixture.stop().await;
}

#[tokio::test]
async fn oversized_responses_and_inflight_cancellation_release_native_upload_slots() {
    let router = axum::Router::new().route(
        "/v1/shares",
        axum::routing::get(|| async { vec![b'x'; MAX_RESPONSE + 1] }).post(|| async {
            tokio::time::sleep(Duration::from_secs(3)).await;
            "delayed"
        }),
    );
    let fixture = Fixture::new(Some(router)).await;
    assert!(
        list(fixture.client.clone(), &fixture.enrollment(), 50, None)
            .await
            .err()
            .unwrap()
            .contains("256 KiB")
    );
    let state = Arc::new(ShareState::default());
    let id = insert(
        &mut *state.uploads.lock().await,
        fixture.enrollment(),
        "file".into(),
        "text/plain".into(),
        1,
        3600,
    )
    .unwrap();
    chunk(&mut *state.uploads.lock().await, &id, 0, b"x").unwrap();
    let sending = {
        let state = state.clone();
        let id = id.clone();
        let client = fixture.client.clone();
        tokio::spawn(async move { finish(&state, id, client).await })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if state
                .uploads
                .lock()
                .await
                .get(&id)
                .is_some_and(|upload| upload.pending.is_none())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    cancel_all(&state).await;
    assert!(sending.await.unwrap().err().unwrap().contains("cancelled"));
    tokio::time::timeout(Duration::from_secs(2), async {
        while !state.uploads.lock().await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    fixture.stop().await;
}

#[test]
fn raster_previews_have_bounded_dimensions_and_are_reencoded_as_small_static_png() {
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(320, 160, Rgb([20, 80, 140])));
    for format in [
        ImageFormat::Png,
        ImageFormat::Jpeg,
        ImageFormat::Gif,
        ImageFormat::WebP,
    ] {
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, format).unwrap();
        let preview = thumbnail(encoded.get_ref()).unwrap();
        assert_eq!(preview.mime, "image/png");
        assert_eq!((preview.width, preview.height), (256, 128));
        assert!(preview.data.len() <= THUMBNAIL_OUTPUT_LIMIT);
        assert_eq!(
            image::guess_format(&preview.data).unwrap(),
            ImageFormat::Png
        );
    }
    for data in [
        b"<svg onload='bad()'/>".as_slice(),
        b"<html><script>bad()</script></html>",
        b"%PDF-1.7",
    ] {
        assert!(thumbnail(data).is_err());
    }
    assert!(thumbnail(&vec![0; THUMBNAIL_INPUT_LIMIT + 1]).is_err());
    for (width, height) in [(0, 1), (8193, 1), (4096, 2049)] {
        assert!(thumbnail_dimensions(width, height).is_err());
    }
    assert!(thumbnail_dimensions(8192, 1024).is_ok());
}

#[test]
fn webp_preflight_rejects_extended_chunks_and_nested_allocation_headers_before_decode() {
    fn riff(tag: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
        bytes.extend_from_slice(tag);
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(payload);
        if !payload.len().is_multiple_of(2) {
            bytes.push(0);
        }
        let length = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&length.to_le_bytes());
        bytes
    }
    let large_vp8 = [0x10, 0, 0, 0x9d, 1, 0x2a, 0xff, 0x3f, 0xff, 0x3f];
    let mut extended = riff(b"VP8X", &[0; 10]);
    extended.extend_from_slice(b"VP8 ");
    extended.extend_from_slice(&10u32.to_le_bytes());
    extended.extend_from_slice(&large_vp8);
    let length = (extended.len() - 8) as u32;
    extended[4..8].copy_from_slice(&length.to_le_bytes());
    assert!(thumbnail(&extended)
        .err()
        .unwrap()
        .contains("Only simple WebP"));
    let mut metadata = riff(b"VP8L", &[0x2f, 0, 0, 0, 0]);
    metadata.extend_from_slice(b"EXIF");
    metadata.extend_from_slice(&u32::MAX.to_le_bytes());
    let length = (metadata.len() - 8) as u32;
    metadata[4..8].copy_from_slice(&length.to_le_bytes());
    assert!(thumbnail(&metadata)
        .err()
        .unwrap()
        .contains("Only simple WebP"));
    let mut declared_huge = riff(b"VP8L", &[0x2f, 0, 0, 0, 0]);
    declared_huge[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(thumbnail(&declared_huge)
        .err()
        .unwrap()
        .contains("Only simple WebP"));
    assert!(thumbnail(&riff(b"VP8 ", &large_vp8))
        .err()
        .unwrap()
        .contains("8 megapixels"));
    let huge_lossless = (0x3fff_u32 | (0x3fff << 14)).to_le_bytes();
    let mut payload = vec![0x2f];
    payload.extend_from_slice(&huge_lossless);
    assert!(thumbnail(&riff(b"VP8L", &payload))
        .err()
        .unwrap()
        .contains("8 megapixels"));
}

#[test]
fn gif_preflight_bounds_the_first_frame_independently_of_its_logical_canvas() {
    let gif = |width: u16, height: u16| {
        let mut bytes = b"GIF89a\x01\0\x01\0\0\0\0\x2c\0\0\0\0".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.push(0);
        bytes
    };
    assert!(thumbnail(&gif(4096, 4096))
        .err()
        .unwrap()
        .contains("8 megapixels"));
    assert!(thumbnail(&gif(2, 1)).err().unwrap().contains("canvas"));
}

#[tokio::test]
async fn thumbnail_downloads_are_bounded_https_gets_without_management_credentials() {
    use axum::{http::HeaderMap, routing::get};
    use image::{DynamicImage, ImageFormat};
    let mut encoded = std::io::Cursor::new(Vec::new());
    DynamicImage::new_rgba8(1, 1)
        .write_to(&mut encoded, ImageFormat::Png)
        .unwrap();
    let bytes = encoded.into_inner();
    let returned = bytes.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let router = axum::Router::new().route(
        "/s/{id}",
        get(move |headers: HeaderMap| {
            assert!(!headers.contains_key(reqwest::header::AUTHORIZATION));
            count.fetch_add(1, Ordering::SeqCst);
            let bytes = returned.clone();
            async move { bytes }
        }),
    );
    let fixture = Fixture::new(Some(router)).await;
    assert!(
        thumbnail_bytes(fixture.client.clone(), &fixture.enrollment(), "../admin")
            .await
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let downloaded = thumbnail_bytes(
        fixture.client.clone(),
        &fixture.enrollment(),
        &"a".repeat(64),
    )
    .await
    .unwrap();
    assert_eq!(downloaded, bytes);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(thumbnail(&downloaded).unwrap().width, 1);
    fixture.stop().await;
}
