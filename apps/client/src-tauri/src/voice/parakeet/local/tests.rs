use super::*;
use crate::app_lock::AccessState;
use std::os::unix::fs::PermissionsExt;
fn fixture() -> (tempfile::TempDir, Arc<Manager>, AccessState) {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let manager = Manager::new(
        directory.path().join("parakeet"),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let authority = AccessState::default();
    authority.initialize(true, false, "fixture".into()).unwrap();
    (directory, manager, authority)
}
fn lease(authority: &AccessState) -> AccessLease {
    authority
        .lease(authority.status().unwrap().nonce.as_deref())
        .unwrap()
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_awaiter_cannot_release_blocking_workers_resources_or_capacity() {
    let (directory, manager, authority) = fixture();
    let access = lease(&authority);
    let request = id();
    let mut work = manager.reserve(&access, &request, "transcribing").unwrap();
    let partial = manager.cache.root.join(format!("{request}.part"));
    fs::write(&partial, b"owned temporary model fixture").unwrap();
    work.partial = Some(partial.clone());
    let destroyed = Arc::new(AtomicBool::new(false));
    struct Resource(Arc<AtomicBool>);
    impl Drop for Resource {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let resource = Resource(destroyed.clone());
    let (release, blocked) = std::sync::mpsc::channel();
    let (started, running) = tokio::sync::oneshot::channel();
    let (done, finished) = tokio::sync::oneshot::channel();
    let worker = tokio::task::spawn_blocking(move || {
        let _audio = vec![0f32; 1600];
        started.send(()).unwrap();
        blocked.recv().unwrap();
        let result = work.check();
        drop(work);
        drop(resource);
        done.send(()).unwrap();
        result
    });
    let awaiter = tokio::spawn(async move { access.run(async { worker.await.unwrap() }).await });
    running.await.unwrap();
    authority
        .configure_after_proof(authority.generation().unwrap(), true)
        .unwrap();
    assert!(
        awaiter.await.unwrap().is_err(),
        "stale output must be discarded without waiting for native CPU work"
    );
    assert!(manager.status().busy);
    assert_eq!(manager.status().stage, "finishing");
    assert!(partial.exists());
    assert!(!destroyed.load(Ordering::Acquire));
    assert!(
        Manager::new(
            directory.path().join("parakeet"),
            Arc::new(AtomicBool::new(false))
        )
        .is_err(),
        "the native worker retains process cache ownership"
    );
    assert!(manager
        .reserve(&lease(&authority), &id(), "preparing")
        .is_err());
    assert!(manager.remove(&lease(&authority), &id()).await.is_err());
    release.send(()).unwrap();
    finished.await.unwrap();
    assert!(!manager.status().busy);
    assert!(!partial.exists());
    assert!(destroyed.load(Ordering::Acquire));
    let replacement_id = id();
    let replacement = manager
        .reserve(&lease(&authority), &replacement_id, "preparing")
        .unwrap();
    manager.cancel(&request).unwrap();
    assert!(
        replacement.check().is_ok(),
        "old UUID cancellation must not target its replacement"
    );
    drop(replacement);
}

#[test]
fn cancel_before_begin_and_stale_creation_lease_fail_closed() {
    let (_directory, manager, authority) = fixture();
    let old = lease(&authority);
    let request = id();
    manager.cancel(&request).unwrap();
    assert!(manager.reserve(&old, &request, "downloading").is_err());
    authority
        .configure_after_proof(authority.generation().unwrap(), true)
        .unwrap();
    assert!(manager.reserve(&old, &id(), "preparing").is_err());
    assert!(!manager.status().busy);
    drop(
        manager
            .reserve(&lease(&authority), &id(), "preparing")
            .unwrap(),
    );
}
#[test]
fn cancellation_and_model_commit_have_one_ordering_boundary() {
    let (_directory, manager, authority) = fixture();
    let request = id();
    let work = manager
        .reserve(&lease(&authority), &request, "preparing")
        .unwrap();
    let (entered, inside) = std::sync::mpsc::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let commit = std::thread::spawn(move || {
        work.commit(|| {
            entered.send(()).unwrap();
            blocked.recv().unwrap();
            Ok(())
        })
    });
    inside.recv().unwrap();
    let (done, result) = std::sync::mpsc::channel();
    let cancelling = manager.clone();
    let cancel = std::thread::spawn(move || {
        done.send(cancelling.cancel(&request).unwrap().cancelled)
            .unwrap()
    });
    assert!(matches!(
        result.recv_timeout(Duration::from_millis(25)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
    ));
    release.send(()).unwrap();
    commit.join().unwrap().unwrap();
    assert!(
        !result.recv_timeout(Duration::from_secs(1)).unwrap(),
        "already committed installation cannot report cancelled"
    );
    cancel.join().unwrap();
    let request = id();
    let work = manager
        .reserve(&lease(&authority), &request, "preparing")
        .unwrap();
    manager.cancel(&request).unwrap();
    let mut mutated = false;
    assert!(work
        .commit(|| {
            mutated = true;
            Ok(())
        })
        .is_err());
    assert!(!mutated);
}

#[test]
fn one_cache_owner_and_exact_owned_partial_cleanup() {
    let (directory, manager, _authority) = fixture();
    assert!(Manager::new(
        directory.path().join("parakeet"),
        Arc::new(AtomicBool::new(false))
    )
    .is_err());
    let part = manager.cache.root.join(format!("{}.part", id()));
    let unrelated = manager.cache.root.join("unrelated.part");
    fs::write(&part, b"interrupted owned download").unwrap();
    fs::set_permissions(&part, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&unrelated, b"not our UUID").unwrap();
    drop(manager);
    let recovered = Manager::new(
        directory.path().join("parakeet"),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert!(!part.exists());
    assert!(unrelated.exists());
    assert!(!recovered.status().installed);
}

#[test]
fn cache_rejects_links_and_publication_never_overwrites() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let target = directory.path().join("target");
    fs::create_dir(&target).unwrap();
    symlink(&target, directory.path().join("parakeet")).unwrap();
    assert!(Manager::new(
        directory.path().join("parakeet"),
        Arc::new(AtomicBool::new(false))
    )
    .is_err());
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    let source = directory.path().join("source");
    let destination = directory.path().join("installed");
    fs::write(&source, b"new").unwrap();
    fs::write(&destination, b"original").unwrap();
    assert!(publish(&source, &destination).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"original");
    fs::remove_file(&destination).unwrap();
    publish(&source, &destination).unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(destination).unwrap(), b"new");
}

#[test]
fn publisher_redirects_are_fixed_https_and_audio_rejected_before_reserving() {
    for url in [
        "https://github.com/k2-fsa/model",
        "https://release-assets.githubusercontent.com/file",
        "https://objects.githubusercontent.com/file",
    ] {
        assert!(publisher_url(&Url::parse(url).unwrap()));
    }
    for url in [
        "http://github.com/file",
        "https://github.com.attacker.test/file",
        "https://user:secret@github.com/file",
        "https://127.0.0.1/file",
        "https://github.com:444/file",
    ] {
        assert!(!publisher_url(&Url::parse(url).unwrap()));
    }
}

#[tokio::test]
async fn invalid_audio_does_not_load_or_reserve_a_model() {
    let (_directory, manager, authority) = fixture();
    for samples in [vec![], vec![0.; MAX_SAMPLES + 1], vec![f32::NAN; 1600]] {
        assert!(manager
            .transcribe(&lease(&authority), &id(), samples)
            .await
            .is_err());
        assert!(!manager.status().busy);
    }
}

async fn server(
    body: Vec<u8>,
    stall: bool,
) -> (
    String,
    tokio::sync::oneshot::Receiver<()>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/archive", listener.local_addr().unwrap());
    let (ready, headers) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            socket.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
            assert!(request.len() < 4096);
        }
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        ready.send(()).unwrap();
        if stall {
            std::future::pending::<()>().await;
        }
        for part in body.chunks(3) {
            socket
                .write_all(format!("{:x}\r\n", part.len()).as_bytes())
                .await
                .unwrap();
            socket.write_all(part).await.unwrap();
            socket.write_all(b"\r\n").await.unwrap();
            tokio::task::yield_now().await;
        }
        let _ = socket.write_all(b"0\r\n\r\n").await;
    });
    (url, headers, task)
}
fn partial(manager: &Arc<Manager>, work: &mut Work) -> (PathBuf, File) {
    let path = manager.cache.root.join(format!("{}.part", work.id));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    work.partial = Some(path.clone());
    (path, file)
}
#[tokio::test]
async fn actual_streamed_transfer_bounds_hash_and_partial_cleanup() {
    let body = b"synthetic pinned model download bytes".to_vec();
    for (sent, expected, digest, success) in [
        (
            body.clone(),
            body.len() as u64,
            format!("{:x}", Sha256::digest(&body)),
            true,
        ),
        (body.clone(), body.len() as u64, "0".repeat(64), false),
        (
            body.clone(),
            body.len() as u64 - 1,
            format!("{:x}", Sha256::digest(&body)),
            false,
        ),
        (
            body[..body.len() - 1].to_vec(),
            body.len() as u64,
            format!("{:x}", Sha256::digest(&body)),
            false,
        ),
    ] {
        let (_directory, manager, authority) = fixture();
        let mut work = manager
            .reserve(&lease(&authority), &id(), "downloading")
            .unwrap();
        let (path, mut file) = partial(&manager, &mut work);
        let (url, headers, task) = server(sent, false).await;
        let mut progress = Vec::new();
        let result = transfer(
            &mut work,
            &mut file,
            Client::builder().no_proxy().build().unwrap(),
            &url,
            expected,
            &digest,
            |status| progress.push(status.received),
        )
        .await;
        headers.await.unwrap();
        task.await.unwrap();
        assert_eq!(result.is_ok(), success);
        assert!(!manager.cache.archive().exists());
        assert!(file.metadata().unwrap().len() <= expected);
        if success {
            assert_eq!(fs::read(&path).unwrap(), body);
            assert_eq!(progress.last(), Some(&expected));
        }
        drop(file);
        drop(work);
        assert!(!path.exists());
        assert!(!manager.status().busy);
    }
}
#[tokio::test]
async fn cancelling_body_wait_cleans_exact_partial_and_never_publishes() {
    let (_directory, manager, authority) = fixture();
    let request = id();
    let mut work = manager
        .reserve(&lease(&authority), &request, "downloading")
        .unwrap();
    let (path, mut file) = partial(&manager, &mut work);
    let (url, headers, server) = server(Vec::new(), true).await;
    let task = tokio::spawn(async move {
        let result = transfer(
            &mut work,
            &mut file,
            Client::builder().no_proxy().build().unwrap(),
            &url,
            10,
            &"0".repeat(64),
            |_| {},
        )
        .await;
        drop(file);
        drop(work);
        result
    });
    headers.await.unwrap();
    assert!(manager.cancel(&request).unwrap().finishing);
    assert!(tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    server.abort();
    assert!(!path.exists());
    assert!(!manager.cache.archive().exists());
    assert!(!manager.status().busy);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicitly supplied pinned public Parakeet archive; no automatic download"]
async fn real_manager_installs_once_reuses_warm_model_twice_and_removes_owned_files() {
    let archive = PathBuf::from(
        std::env::var_os("LAZYSH_PARAKEET_TEST_ARCHIVE").expect("set LAZYSH_PARAKEET_TEST_ARCHIVE"),
    );
    let (_directory, manager, authority) = fixture();
    let mut work = manager
        .reserve(&lease(&authority), &id(), "preparing")
        .unwrap();
    work.keep_engine = false;
    let (path, mut file) = partial(&manager, &mut work);
    let bytes = std::io::copy(&mut File::open(archive).unwrap(), &mut file).unwrap();
    assert_eq!(bytes, ARCHIVE_BYTES);
    tokio::task::spawn_blocking(move || install_worker(work, file, path))
        .await
        .unwrap()
        .unwrap();
    assert!(manager.status().installed && manager.status().ready);
    let workspace = fs::read_dir(&manager.cache.root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("lazysh-parakeet-")
        })
        .unwrap();
    let wav = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/parakeet-runtime/tests/fixtures/librispeech/1272-128104-0000.wav"
    ));
    assert_eq!(
        format!("{:x}", Sha256::digest(wav)),
        "799f78ed4beb4de7ceae3a809262d4ce242394342ccd1d58cef7d49dbc2def46"
    );
    let mut reader = hound::WavReader::new(std::io::Cursor::new(wav)).unwrap();
    assert_eq!(reader.spec().sample_rate, 16000);
    assert_eq!(reader.spec().channels, 1);
    let samples: Vec<f32> = reader
        .samples::<i16>()
        .map(|sample| f32::from(sample.unwrap()) / 32768.)
        .collect();
    let reference =
        "MISTER QUILTER IS THE APOSTLE OF THE MIDDLE CLASSES AND WE ARE GLAD TO WELCOME HIS GOSPEL";
    let mut first = None;
    for _ in 0..2 {
        let text = manager
            .transcribe(&lease(&authority), &id(), samples.clone())
            .await
            .unwrap()
            .text;
        let normalized = text
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|word| !word.is_empty())
            .map(str::to_ascii_uppercase)
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(normalized, reference);
        if let Some(first) = &first {
            assert_eq!(first, &text);
        } else {
            first = Some(text);
        }
        assert!(workspace.exists());
        assert!(manager.status().ready);
        assert!(!manager.status().busy);
        assert_eq!(
            fs::read_dir(&manager.cache.root)
                .unwrap()
                .filter(|entry| entry.as_ref().unwrap().path().is_dir())
                .count(),
            1
        );
    }
    manager.remove(&lease(&authority), &id()).await.unwrap();
    assert!(!workspace.exists());
    assert!(!manager.status().installed);
    assert!(!manager.status().ready);
    assert_eq!(
        fs::read_dir(&manager.cache.root).unwrap().count(),
        1,
        "only stable cache lock remains"
    );
}
