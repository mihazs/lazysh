use super::*;
use russh_sftp::protocol::{FileAttributes, Handle, OpenFlags, Status, StatusCode};
use std::{
    pin::Pin,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    task::{Context, Poll, Waker},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::{sync::Notify, time::timeout};

#[derive(Clone, Default)]
struct Peer {
    entered: Arc<Notify>,
    release: Arc<Notify>,
    writes: Arc<AtomicUsize>,
    flags: Arc<Mutex<Vec<OpenFlags>>>,
    removals: Arc<AtomicUsize>,
    block: Option<Arc<Gate>>,
    canonical: Option<String>,
    full_canonical: Option<String>,
    unsupported_realpath: bool,
    root_sensitive: bool,
    resolve_blocked: bool,
    paths: Arc<Mutex<Vec<String>>>,
    resolutions: Arc<Mutex<Vec<String>>>,
}
fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
struct Fixture {
    uploads: Uploads,
    lease: AccessLease,
    _disconnect: watch::Sender<bool>,
    id: String,
    work: Work,
}
fn fixture(size: usize) -> Fixture {
    let (uploads, _authority, lease, disconnect) = super::tests::fixture();
    let id = uploads
        .reserve(
            "same-session".into(),
            disconnect.subscribe(),
            lease.clone(),
            size,
        )
        .unwrap()
        .upload_id;
    let work = uploads.claim(&id, "same-session", &lease, size).unwrap();
    Fixture {
        uploads,
        lease,
        _disconnect: disconnect,
        id,
        work,
    }
}
async fn retired(uploads: &Uploads) {
    timeout(Duration::from_secs(2), async {
        while !uploads.0.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("capacity must retire with the upstream transport tasks");
}
impl russh_sftp::server::Handler for Peer {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(
        &mut self,
        id: u32,
        path: String,
    ) -> std::result::Result<russh_sftp::protocol::Name, StatusCode> {
        if self.unsupported_realpath {
            return Err(StatusCode::OpUnsupported);
        }
        let root = if self.root_sensitive {
            match path.as_str() {
                "C:" | "/C:" => Some("/C:/different-current-directory"),
                "C:/" | "/C:/" => Some("/C:/"),
                "/" => Some("/single-root"),
                "//" => Some("//"),
                _ => None,
            }
        } else {
            None
        };
        let full = path.contains('\\');
        self.resolutions.lock().unwrap().push(path);
        if self.resolve_blocked {
            self.entered.notify_one();
            self.release.notified().await;
        }
        Ok(russh_sftp::protocol::Name {
            id,
            files: vec![russh_sftp::protocol::File::dummy(
                root.map(str::to_owned)
                    .or_else(|| {
                        if full {
                            self.full_canonical.clone()
                        } else {
                            self.canonical.clone()
                        }
                    })
                    .unwrap_or_else(|| "/fixture".into()),
            )],
        })
    }
    async fn open(
        &mut self,
        id: u32,
        name: String,
        flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> std::result::Result<Handle, StatusCode> {
        self.paths.lock().unwrap().push(name);
        if let Some(gate) = &self.block {
            gate.blocked.store(true, Ordering::SeqCst);
        }
        self.flags.lock().unwrap().push(flags);
        Ok(Handle {
            id,
            handle: "owned".into(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        _offset: u64,
        data: Vec<u8>,
    ) -> std::result::Result<Status, StatusCode> {
        assert_eq!(handle, "owned");
        assert!(!data.is_empty());
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.release.notified().await;
        Ok(ok(id))
    }
    async fn close(&mut self, id: u32, _handle: String) -> std::result::Result<Status, StatusCode> {
        Ok(ok(id))
    }
    async fn remove(&mut self, _id: u32, _name: String) -> std::result::Result<Status, StatusCode> {
        self.removals.fetch_add(1, Ordering::SeqCst);
        Err(StatusCode::PermissionDenied)
    }
}

#[tokio::test]
async fn cancellation_of_real_stalled_resolution_and_write_closes_the_owned_stream_without_remove()
{
    for resolve_blocked in [false, true] {
        let Fixture {
            uploads,
            lease,
            id,
            work,
            _disconnect,
        } = fixture(65536);
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let writes = Arc::new(AtomicUsize::new(0));
        let removals = Arc::new(AtomicUsize::new(0));
        let flags = Arc::new(Mutex::new(Vec::new()));
        let (client, server) = tokio::io::duplex(262144);
        let peer = Peer {
            entered: entered.clone(),
            release: release.clone(),
            writes: writes.clone(),
            flags: flags.clone(),
            removals: removals.clone(),
            resolve_blocked,
            ..Peer::default()
        };
        let peer_task = tokio::spawn(russh_sftp::server::run(server, peer));
        let client = russh_sftp::client::SftpSession::new(
            crate::sftp_stream::SftpStream::with_cancellation(
                client,
                work.cancellation(),
                work.cancellation(),
                work.retention(),
            ),
        )
        .await
        .unwrap();
        let sending = tokio::spawn(async move {
            work.run(ssh::transfer_sftp(
                client,
                "new attachment.txt".into(),
                vec![7; 65536],
            ))
            .await
        });
        timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        assert_eq!(
            uploads.cancel(&id, "same-session", &lease).unwrap().outcome,
            "cancellation_requested"
        );
        let result = timeout(Duration::from_secs(2), sending)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(result).unwrap()["kind"],
            "upload_cancelled"
        );
        retired(&uploads).await;
        release.notify_one();
        timeout(Duration::from_secs(2), peer_task)
            .await
            .expect("cancel must close the owned SFTP stream after the delayed peer reply")
            .unwrap();
        assert_eq!(writes.load(Ordering::SeqCst), usize::from(!resolve_blocked));
        assert_eq!(removals.load(Ordering::SeqCst), 0);
        assert_eq!(
            flags
                .lock()
                .unwrap()
                .iter()
                .map(OpenFlags::bits)
                .collect::<Vec<_>>(),
            if resolve_blocked {
                vec![]
            } else {
                vec![(OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).bits()]
            }
        );
    }
}

#[derive(Default)]
struct Gate {
    blocked: AtomicBool,
    entered: Notify,
    dropped: Notify,
    writer: Mutex<Option<Waker>>,
}
struct GatedStream {
    inner: tokio::io::DuplexStream,
    gate: Arc<Gate>,
}
impl Drop for GatedStream {
    fn drop(&mut self) {
        self.gate.dropped.notify_one();
    }
}
impl AsyncRead for GatedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, out)
    }
}
impl AsyncWrite for GatedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.gate.blocked.load(Ordering::SeqCst) {
            *self.gate.writer.lock().unwrap() = Some(cx.waker().clone());
            self.gate.entered.notify_one();
            return Poll::Pending;
        }
        Pin::new(&mut self.inner).poll_write(cx, data)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
#[tokio::test]
async fn cancellation_retires_blocked_init_or_write_without_peer_drain() {
    for during_init in [true, false] {
        let Fixture {
            uploads,
            lease,
            id,
            work,
            _disconnect,
        } = fixture(65536);
        let gate = Arc::new(Gate::default());
        gate.blocked.store(during_init, Ordering::SeqCst);
        let peer = Peer {
            block: Some(gate.clone()),
            ..Peer::default()
        };
        let release = peer.release.clone();
        let (client, server) = tokio::io::duplex(64);
        let peer_task = tokio::spawn(russh_sftp::server::run(server, peer));
        let stream = GatedStream {
            inner: client,
            gate: gate.clone(),
        };
        let stream = crate::sftp_stream::SftpStream::with_cancellation(
            stream,
            work.cancellation(),
            work.cancellation(),
            work.retention(),
        );
        let sending = tokio::spawn(async move {
            work.run(async {
                let client = russh_sftp::client::SftpSession::new(stream).await?;
                ssh::transfer_sftp(client, "new attachment.txt".into(), vec![7; 65536]).await
            })
            .await
        });
        timeout(Duration::from_secs(2), gate.entered.notified())
            .await
            .expect("the actual transport writer must be blocked before cancellation");
        uploads.cancel(&id, "same-session", &lease).unwrap();
        assert!(timeout(Duration::from_secs(2), sending)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        let transport_retired = timeout(Duration::from_secs(2), gate.dropped.notified())
            .await
            .is_ok();
        // Always retire the RED fixture's peer before reporting the assertion.
        gate.blocked.store(false, Ordering::SeqCst);
        if let Some(writer) = gate.writer.lock().unwrap().take() {
            writer.wake();
        }
        release.notify_one();
        let _ = timeout(Duration::from_secs(2), peer_task).await;
        assert!(
            transport_retired,
            "cancel must drop the owned transport without waiting for the peer to read"
        );
        retired(&uploads).await;
    }
}

#[tokio::test]
async fn split_transport_retains_capacity_until_both_io_halves_drop() {
    let Fixture {
        uploads,
        lease,
        work,
        _disconnect: disconnect,
        ..
    } = fixture(1);
    let other = uploads
        .reserve(
            "same-session".into(),
            disconnect.subscribe(),
            lease.clone(),
            0,
        )
        .unwrap()
        .upload_id;
    let (client, _peer) = tokio::io::duplex(1);
    let stream = crate::sftp_stream::SftpStream::with_cancellation(
        client,
        work.cancellation(),
        work.cancellation(),
        work.retention(),
    );
    let (reader, writer) = tokio::io::split(stream);
    drop(work);
    assert_eq!(uploads.0.lock().unwrap().len(), 2);
    assert!(uploads
        .reserve(
            "same-session".into(),
            disconnect.subscribe(),
            lease.clone(),
            1
        )
        .is_err());
    drop(reader);
    assert_eq!(uploads.0.lock().unwrap().len(), 2);
    drop(writer);
    assert_eq!(uploads.0.lock().unwrap().len(), 1);
    uploads.cancel(&other, "same-session", &lease).unwrap();
    assert!(uploads.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn canonical_server_paths_are_used_verbatim_and_invalid_responses_never_open() {
    for (canonical, expected) in [
        ("/home/user", Some("/home/user/new attachment.txt")),
        ("/C:/Users/name", Some("/C:/Users/name/new attachment.txt")),
        ("C:/Users/name/", Some("C:/Users/name/new attachment.txt")),
        ("//server/share", Some("//server/share/new attachment.txt")),
        ("/", Some("/new attachment.txt")),
        ("relative", None),
        ("/bad\npath", None),
        ("/bad/../path", None),
        ("C:relative", None),
        ("", None),
    ] {
        let peer = Peer {
            canonical: Some(canonical.into()),
            ..Peer::default()
        };
        check_canonical(peer, "./new attachment.txt", expected).await;
    }
    let peer = Peer {
        canonical: Some("/C:/Users/name".into()),
        full_canonical: Some("/C:/Users/name/new attachment.txt".into()),
        ..Peer::default()
    };
    let resolutions = peer.resolutions.clone();
    check_canonical(
        peer,
        r"C:\Users\name\new attachment.txt",
        Some("/C:/Users/name/new attachment.txt"),
    )
    .await;
    assert_eq!(
        *resolutions.lock().unwrap(),
        vec![r"C:\Users\name\new attachment.txt", "/C:/Users/name"]
    );
    check_canonical(
        Peer {
            unsupported_realpath: true,
            ..Peer::default()
        },
        "./new attachment.txt",
        None,
    )
    .await;
    let peer = Peer {
        canonical: Some(format!("/{}", "x".repeat(4090))),
        ..Peer::default()
    };
    check_canonical(peer, "./new attachment.txt", None).await;
}
async fn check_canonical(peer: Peer, input: &str, expected: Option<&str>) {
    let paths = peer.paths.clone();
    let (client, server) = tokio::io::duplex(262144);
    let task = tokio::spawn(russh_sftp::server::run(server, peer));
    let client = russh_sftp::client::SftpSession::new(client).await.unwrap();
    let result = ssh::transfer_sftp(client, input.into(), vec![]).await;
    match expected {
        Some(path) => {
            assert_eq!(result.unwrap().path, path);
            assert_eq!(*paths.lock().unwrap(), vec![path]);
        }
        None => {
            assert!(result.is_err());
            assert!(paths.lock().unwrap().is_empty());
        }
    }
    timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn canonical_root_requests_do_not_become_drive_relative_or_single_slash() {
    for input in [
        "C:/new attachment.txt",
        "/C:/new attachment.txt",
        "//new attachment.txt",
    ] {
        let expected = if input.starts_with("//") {
            "//new attachment.txt"
        } else {
            "/C:/new attachment.txt"
        };
        let peer = Peer {
            root_sensitive: true,
            ..Peer::default()
        };
        let resolutions = peer.resolutions.clone();
        check_canonical(peer, input, Some(expected)).await;
        assert_eq!(
            *resolutions.lock().unwrap(),
            vec![&input[..input.rfind('/').unwrap() + 1]]
        );
    }
}
