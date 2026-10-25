use super::*;
use axum::{body::Body, http::Response, routing::get, Router};
use futures_util::{stream, StreamExt};
use std::{convert::Infallible, sync::Arc};
use tokio::{net::TcpListener, sync::Notify, task::JoinHandle};

const REQUEST: &str = "b11c6ca6-e4f7-4f63-859c-d08e66df2239";
struct Fixture {
    url: String,
    release: Arc<Notify>,
    server: JoinHandle<()>,
}
impl Fixture {
    async fn new(bytes: Vec<u8>, content_length: Option<u64>, wait_halfway: bool) -> Self {
        let release = Arc::new(Notify::new());
        let gate = release.clone();
        let router = Router::new().route(
            "/model",
            get(move || {
                let data = bytes.clone();
                let gate = gate.clone();
                async move {
                    let pieces = vec![
                        data[..1].to_vec(),
                        data[1..3].to_vec(),
                        data[3..512].to_vec(),
                        data[512..].to_vec(),
                    ];
                    let body = Body::from_stream(
                        stream::iter(pieces.into_iter().enumerate()).then(move |(index, piece)| {
                            let gate = gate.clone();
                            async move {
                                if index == 3 && wait_halfway {
                                    gate.notified().await;
                                }
                                if index < 3 {
                                    tokio::time::sleep(Duration::from_millis(5)).await;
                                }
                                Ok::<_, Infallible>(piece)
                            }
                        }),
                    );
                    let mut response = Response::builder();
                    if let Some(length) = content_length {
                        response = response.header("content-length", length);
                    }
                    response.body(body).unwrap()
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            url: format!("http://{address}/model"),
            release,
            server,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.release.notify_waiters();
        self.server.abort();
    }
}
fn bytes() -> Vec<u8> {
    let mut bytes = vec![0; 1024];
    bytes[..4].copy_from_slice(b"lmgg");
    for (index, value) in [51864i32, 1500, 512, 8, 6, 448, 512, 8, 6, 80, 1]
        .iter()
        .enumerate()
    {
        bytes[4 + index * 4..8 + index * 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}
fn model(hash: &str) -> CatalogModel<'_> {
    CatalogModel {
        id: "fixture",
        file: "fixture.bin",
        label: "Fixture",
        bytes: 1024,
        sha256: hash,
        revision: REVISION,
    }
}
fn fixture_client() -> Client {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}
fn clean(state: &VoiceState) {
    assert!(state.import.lock().unwrap().is_none());
    assert!(state.downloads.0.lock().unwrap().active.is_none());
    assert!(std::fs::read_dir(&state.dir).unwrap().all(|entry| entry
        .unwrap()
        .path()
        .extension()
        .is_none_or(|ext| ext != "part")));
}
#[test]
fn publisher_policy_and_catalog_are_fixed_and_bounded() {
    assert_eq!(MODELS.len(), 4);
    for entry in MODELS {
        assert!((1024..=MAX_MODEL).contains(&entry.bytes));
        assert_eq!(entry.sha256.len(), 64);
        assert_eq!(entry.revision, REVISION);
        assert!(publisher_url(
            &format!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/{REVISION}/{}",
                entry.file
            )
            .parse()
            .unwrap()
        ));
    }
    assert!(publisher_url(
        &"https://us.aws.cdn.hf.co/model".parse().unwrap()
    ));
    for url in [
        "http://huggingface.co/model",
        "https://huggingface.co.evil.example/model",
        "https://user@huggingface.co/model",
        "https://huggingface.co:444/model",
        "https://127.0.0.1/model",
    ] {
        assert!(!publisher_url(&url.parse().unwrap()), "{url}");
    }
}
#[tokio::test]
async fn streams_fragmented_ggml_through_import_and_verifies_before_exclusive_publication() {
    let data = bytes();
    let hash = format!("{:x}", Sha256::digest(&data));
    let fixture = Fixture::new(data.clone(), None, true).await;
    let dir = tempfile::tempdir().unwrap();
    let state = VoiceState::new(dir.path().to_owned()).unwrap();
    let mut progress = Vec::new();
    download(
        &state,
        &model(&hash),
        REQUEST,
        fixture_client(),
        &fixture.url,
        |event| {
            if event.received >= 512 {
                fixture.release.notify_one();
            }
            progress.push((event.received, event.stage));
            Ok(())
        },
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(state.dir.join("fixture.bin")).unwrap(), data);
    assert!(progress
        .iter()
        .any(|&(received, _)| received > 0 && received < 1024));
    assert_eq!(progress.last(), Some(&(1024, "installed")));
    assert!(!cancel(&state, REQUEST).unwrap());
    assert!(download(
        &state,
        &model(&hash),
        REQUEST,
        fixture_client(),
        &fixture.url,
        |_| Ok(())
    )
    .await
    .is_err());
    clean(&state);
}
#[tokio::test]
async fn cancelling_a_partial_stream_or_a_queued_request_never_publishes() {
    let data = bytes();
    let hash = format!("{:x}", Sha256::digest(&data));
    let fixture = Fixture::new(data, None, true).await;
    let dir = tempfile::tempdir().unwrap();
    let state = VoiceState::new(dir.path().to_owned()).unwrap();
    let result = download(
        &state,
        &model(&hash),
        REQUEST,
        fixture_client(),
        &fixture.url,
        |event| {
            if event.received >= 512 {
                assert!(cancel(&state, REQUEST).unwrap());
            }
            Ok(())
        },
    )
    .await;
    assert!(result.unwrap_err().contains("cancelled"));
    assert!(!state.dir.join("fixture.bin").exists());
    clean(&state);
    let queued = "b11c6ca6-e4f7-4f63-859c-d08e66df2240";
    assert!(cancel(&state, queued).unwrap());
    assert!(download(
        &state,
        &model(&hash),
        queued,
        fixture_client(),
        &fixture.url,
        |_| Ok(())
    )
    .await
    .unwrap_err()
    .contains("cancelled"));
    clean(&state);
}
#[tokio::test]
async fn hash_mismatch_and_oversized_or_truncated_responses_remove_partial_files() {
    let data = bytes();
    let hash = format!("{:x}", Sha256::digest(&data));
    for (index, (data, length, digest, reason)) in [
        (data.clone(), None, "0".repeat(64), "SHA-256"),
        (
            [data.clone(), vec![0; 512]].concat(),
            None,
            hash.clone(),
            "exceeds",
        ),
        (
            data.clone(),
            Some(MAX_MODEL + 1),
            hash.clone(),
            "size differs",
        ),
        (data[..512].to_vec(), None, hash.clone(), "incomplete"),
    ]
    .into_iter()
    .enumerate()
    {
        let fixture = Fixture::new(data, length, length.is_some()).await;
        let dir = tempfile::tempdir().unwrap();
        let state = VoiceState::new(dir.path().to_owned()).unwrap();
        let error = download(
            &state,
            &model(&digest),
            &format!("b11c6ca6-e4f7-4f63-859c-d08e66df22{index:02}"),
            fixture_client(),
            &fixture.url,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(error.contains(reason), "{error}");
        assert!(!state.dir.join("fixture.bin").exists());
        clean(&state);
    }
}
#[tokio::test]
async fn cancellation_collisions_and_quota_changes_before_commit_never_overwrite() {
    let data = bytes();
    let hash = format!("{:x}", Sha256::digest(&data));
    for scenario in 0..3 {
        let fixture = Fixture::new(data.clone(), None, false).await;
        let dir = tempfile::tempdir().unwrap();
        let state = VoiceState::new(dir.path().to_owned()).unwrap();
        let result = download(
            &state,
            &model(&hash),
            REQUEST,
            fixture_client(),
            &fixture.url,
            |event| {
                if event.stage == "verifying" {
                    if scenario == 1 {
                        std::fs::write(state.dir.join("fixture.bin"), b"existing model").unwrap();
                    } else if scenario == 2 {
                        for name in ["one.bin", "two.bin", "three.bin"] {
                            std::fs::write(state.dir.join(name), bytes()).unwrap();
                        }
                    } else {
                        assert!(cancel(&state, REQUEST).unwrap());
                    }
                }
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        if scenario == 1 {
            assert_eq!(
                std::fs::read(state.dir.join("fixture.bin")).unwrap(),
                b"existing model"
            );
        } else {
            assert!(!state.dir.join("fixture.bin").exists());
        }
        clean(&state);
    }
}
#[tokio::test]
async fn cancellation_interrupts_waiting_for_http_headers() {
    let started = Arc::new(Notify::new());
    let handler_started = started.clone();
    let router = Router::new().route(
        "/model",
        get(move || {
            let started = handler_started.clone();
            async move {
                started.notify_one();
                std::future::pending::<Response<Body>>().await
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/model", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let state = VoiceState::new(dir.path().to_owned()).unwrap();
    let digest = format!("{:x}", Sha256::digest(bytes()));
    let expected = model(&digest);
    let request = download(&state, &expected, REQUEST, fixture_client(), &url, |_| {
        Ok(())
    });
    let cancellation = async {
        started.notified().await;
        assert!(cancel(&state, REQUEST).unwrap());
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(request, cancellation)
    })
    .await
    .unwrap();
    server.abort();
    assert!(result.unwrap_err().contains("cancelled"));
    clean(&state);
}
#[tokio::test]
async fn model_count_and_one_download_reservation_are_enforced_before_network() {
    let dir = tempfile::tempdir().unwrap();
    let state = VoiceState::new(dir.path().to_owned()).unwrap();
    let held = Download::reserve(&state, REQUEST).unwrap();
    assert!(Download::reserve(&state, "b11c6ca6-e4f7-4f63-859c-d08e66df2240").is_err());
    drop(held);
    for name in ["one.bin", "two.bin", "three.bin"] {
        std::fs::write(state.dir.join(name), bytes()).unwrap();
    }
    let error = download(
        &state,
        &model(&"0".repeat(64)),
        "b11c6ca6-e4f7-4f63-859c-d08e66df2241",
        fixture_client(),
        "http://127.0.0.1:1/model",
        |_| Ok(()),
    )
    .await
    .unwrap_err();
    assert!(error.contains("maximum three"));
    clean(&state);
}
