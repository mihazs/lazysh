use super::*;
use russh_sftp::protocol::{Attrs, Data, Handle, Name, Status};
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct Observed {
    directory: Option<String>,
    file: Option<String>,
    body: Vec<u8>,
    mode: u32,
    removes: usize,
    reordered: bool,
    reads_closed: usize,
    fstats: usize,
    named_stats: usize,
}
#[derive(Clone)]
struct Peer {
    state: Arc<Mutex<Observed>>,
    fault: Arc<Mutex<&'static str>>,
}
fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
fn metadata(directory: bool, size: u64, mode: u32) -> FileAttributes {
    FileAttributes {
        uid: Some(1000),
        gid: Some(1000),
        permissions: Some(mode | if directory { 0o040000 } else { 0o100000 }),
        size: Some(size),
        mtime: Some(1),
        ..FileAttributes::empty()
    }
}
impl russh_sftp::server::Handler for Peer {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> std::result::Result<Name, StatusCode> {
        Ok(Name {
            id,
            files: vec![russh_sftp::protocol::File::dummy(path)],
        })
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> std::result::Result<Status, StatusCode> {
        assert_eq!(attrs.permissions, Some(0o700));
        if *self.fault.lock().unwrap() == "collision" {
            return Err(StatusCode::Failure);
        }
        self.state.lock().unwrap().directory = Some(path);
        Ok(ok(id))
    }
    async fn lstat(&mut self, id: u32, path: String) -> std::result::Result<Attrs, StatusCode> {
        let mut state = self.state.lock().unwrap();
        let fault = *self.fault.lock().unwrap();
        if fault == "request" {
            return Err(StatusCode::ConnectionLost);
        }
        if fault == "missing" && state.file.as_deref() == Some(&path) {
            return Err(StatusCode::NoSuchFile);
        }
        let mut attrs = if path == "/owned" {
            metadata(true, 0, 0o755)
        } else if state.directory.as_deref() == Some(&path) {
            metadata(true, 0, 0o700)
        } else if state.file.as_deref() == Some(&path) {
            metadata(false, state.body.len() as u64, state.mode)
        } else {
            return Err(StatusCode::NoSuchFile);
        };
        if fault == "missing-uid" && path != "/owned" {
            attrs.uid = None;
        }
        if fault == "link" && path != "/owned" {
            attrs.permissions = Some(0o120700);
        }
        if state.file.as_deref() == Some(&path) {
            state.named_stats += 1;
            if fault == "named-changed" && state.named_stats == 2 {
                attrs.mtime = Some(2);
            }
        }
        Ok(Attrs { id, attrs })
    }
    async fn fstat(&mut self, id: u32, _handle: String) -> std::result::Result<Attrs, StatusCode> {
        let mut state = self.state.lock().unwrap();
        state.fstats += 1;
        let mut attrs = metadata(false, state.body.len() as u64, state.mode);
        if *self.fault.lock().unwrap() == "changed" && state.fstats == 2 {
            attrs.mtime = Some(2);
        }
        Ok(Attrs { id, attrs })
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        attrs: FileAttributes,
    ) -> std::result::Result<Handle, StatusCode> {
        let mut state = self.state.lock().unwrap();
        if flags.contains(OpenFlags::WRITE) {
            assert_eq!(
                flags.bits(),
                (OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).bits()
            );
            assert_eq!(attrs.permissions, Some(0o600));
            if state.file.is_some() {
                return Err(StatusCode::Failure);
            }
            state.file = Some(path);
            state.mode = 0o600;
        }
        Ok(Handle {
            id,
            handle: if flags.contains(OpenFlags::WRITE) {
                "owned-write"
            } else {
                "owned-read"
            }
            .into(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        _handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> std::result::Result<Status, StatusCode> {
        let mut state = self.state.lock().unwrap();
        assert_eq!(offset as usize, state.body.len());
        state.body.extend_from_slice(&data);
        if *self.fault.lock().unwrap() == "partial" {
            state.body.pop();
            return Err(StatusCode::Failure);
        }
        Ok(ok(id))
    }
    async fn read(
        &mut self,
        id: u32,
        _handle: String,
        offset: u64,
        length: u32,
    ) -> std::result::Result<Data, StatusCode> {
        let fault = *self.fault.lock().unwrap();
        if fault == "slow" {
            tokio::time::sleep(Duration::from_secs(6)).await;
        }
        let state = self.state.lock().unwrap();
        let mut bytes = std::borrow::Cow::Borrowed(state.body.as_slice());
        match fault {
            "corrupt" => bytes.to_mut()[0] ^= 1,
            "short" => {
                bytes.to_mut().pop();
            }
            "extra" => bytes.to_mut().push(1),
            _ => {}
        }
        if offset as usize >= bytes.len() {
            return Err(StatusCode::Eof);
        }
        if fault == "empty" {
            return Ok(Data {
                id,
                data: Vec::new(),
            });
        }
        let length = if fault == "legal-short" {
            length.min(17_003)
        } else {
            length
        };
        let mut data =
            bytes[offset as usize..bytes.len().min(offset as usize + length as usize)].to_vec();
        if fault == "oversized" {
            data.resize(length as usize + 1, 0);
        }
        Ok(Data { id, data })
    }
    async fn close(&mut self, id: u32, handle: String) -> std::result::Result<Status, StatusCode> {
        if *self.fault.lock().unwrap() == "close" {
            return Err(StatusCode::Failure);
        }
        if handle == "owned-read" {
            self.state.lock().unwrap().reads_closed += 1;
        }
        Ok(ok(id))
    }
    async fn setstat(
        &mut self,
        id: u32,
        _path: String,
        attrs: FileAttributes,
    ) -> std::result::Result<Status, StatusCode> {
        self.state.lock().unwrap().mode = attrs.permissions.unwrap();
        Ok(ok(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> std::result::Result<Status, StatusCode> {
        if *self.fault.lock().unwrap() == "remove" {
            return Err(StatusCode::PermissionDenied);
        }
        let mut state = self.state.lock().unwrap();
        assert_eq!(Some(path), state.file);
        state.file = None;
        state.removes += 1;
        Ok(ok(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> std::result::Result<Status, StatusCode> {
        if *self.fault.lock().unwrap() == "rmdir" {
            return Err(StatusCode::PermissionDenied);
        }
        let mut state = self.state.lock().unwrap();
        assert_eq!(Some(path), state.directory);
        if state.file.is_some() {
            return Err(StatusCode::Failure);
        }
        state.directory = None;
        Ok(ok(id))
    }
}
const EXECUTABLE: &[u8] = b"owned verified executable";
async fn fixture(fault: &'static str) -> (Staging, Peer, tokio::task::JoinHandle<()>) {
    fixture_data(fault, EXECUTABLE, false).await
}
async fn delayed_frames(
    mut read: tokio::io::ReadHalf<tokio::io::DuplexStream>,
    mut write: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    reverse: bool,
    observed: Arc<Mutex<Observed>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut pending = Vec::new();
    let mut chunk = [0u8; 65536];
    loop {
        if pending.is_empty() {
            let n = read.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&chunk[..n]);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(25);
        while pending.len() < 8 * 262148 {
            let capacity = (8 * 262148 - pending.len()).min(chunk.len());
            tokio::select! { biased;
                _ = tokio::time::sleep_until(deadline) => break,
                n = read.read(&mut chunk[..capacity]) => {
                    let n = n.unwrap();
                    if n == 0 { assert!(pending.is_empty()); return; }
                    pending.extend_from_slice(&chunk[..n]);
                }
            }
        }
        let mut frames = Vec::new();
        let mut end = 0;
        while pending.len() - end >= 4 {
            let length = u32::from_be_bytes(pending[end..end + 4].try_into().unwrap()) as usize;
            assert!((1..=262144).contains(&length));
            if pending.len() - end < length + 4 {
                break;
            }
            frames.push(end..end + length + 4);
            end += length + 4;
        }
        if reverse {
            if frames.len() > 1 {
                observed.lock().unwrap().reordered = true;
            }
            frames.reverse();
        }
        for frame in frames {
            write.write_all(&pending[frame]).await.unwrap();
        }
        pending.drain(..end);
    }
    write.shutdown().await.unwrap();
}
async fn fixture_data(
    fault: &'static str,
    data: &[u8],
    delayed: bool,
) -> (Staging, Peer, tokio::task::JoinHandle<()>) {
    let peer = Peer {
        state: Arc::new(Mutex::new(Observed::default())),
        fault: Arc::new(Mutex::new(fault)),
    };
    let (client, server) = tokio::io::duplex(262_144);
    let server_peer = peer.clone();
    let (client, task) = if delayed {
        let (front, proxy_front) = tokio::io::duplex(1048576);
        let (proxy_read, proxy_write) = tokio::io::split(proxy_front);
        let (server_read, server_write) = tokio::io::split(client);
        let observed = peer.state.clone();
        let task = tokio::spawn(async move {
            tokio::join!(
                russh_sftp::server::run(server, server_peer),
                delayed_frames(proxy_read, server_write, false, observed.clone()),
                delayed_frames(server_read, proxy_write, true, observed)
            );
        });
        (front, task)
    } else {
        (
            client,
            tokio::spawn(russh_sftp::server::run(server, server_peer)),
        )
    };
    let raw = RawSftpSession::new(crate::sftp_stream::SftpStream::new(client));
    raw.set_timeout(2);
    raw.init().await.unwrap();
    let selection = release::Publisher::owned(data.to_vec(), "0.24.0".into())
        .select("linux-agent-x64")
        .await
        .unwrap();
    let unix = resolve::Unix {
        os: "linux",
        arch: "x64",
        uid: 1000,
        home: "/owned".into(),
        data: "/owned/data".into(),
    };
    (Staging::new(raw, &unix, &selection), peer, task)
}

#[tokio::test(start_paused = true)]
async fn cleanup_verifies_a_release_sized_file_within_five_seconds_over_moderate_rtt() {
    let data: Vec<u8> = (0..10_760_624).map(|n| (n % 251) as u8).collect();
    let (mut staged, peer, task) = ready(&data, true).await;
    let result = bounded_cleanup(&mut staged).await;
    assert_eq!(result, Ok(()));
    assert_eq!(peer.state.lock().unwrap().removes, 1);
    assert!(peer.state.lock().unwrap().directory.is_none());
    assert!(
        peer.state.lock().unwrap().reordered,
        "actual response frames arrived out of order"
    );
    drop(staged);
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn pipelined_ranges_preserve_partial_eof_metadata_close_and_no_delete_guards() {
    for fault in [
        "legal-short",
        "short",
        "extra",
        "corrupt",
        "empty",
        "oversized",
        "changed",
        "named-changed",
        "close",
        "slow",
    ] {
        let data: Vec<u8> = (0..131_099).map(|n| (n % 251) as u8).collect();
        let (mut staged, peer, task) = ready(&data, true).await;
        {
            let mut state = peer.state.lock().unwrap();
            state.fstats = 0;
            state.named_stats = 0;
            state.reads_closed = 0;
        }
        *peer.fault.lock().unwrap() = fault;
        let result = bounded_cleanup(&mut staged).await;
        assert_eq!(result.is_ok(), fault == "legal-short", "{fault}");
        let state = peer.state.lock().unwrap();
        assert_eq!(
            state.removes,
            usize::from(fault == "legal-short"),
            "{fault}"
        );
        if fault != "close" && fault != "slow" {
            assert_eq!(
                state.reads_closed, 1,
                "verification handle closed on {fault}"
            );
        }
        if fault != "legal-short" {
            assert!(state.directory.is_some(), "{fault}");
        }
        drop(state);
        drop(staged);
        task.abort();
    }
}
#[tokio::test]
async fn exclusive_private_staging_verifies_bytes_and_never_removes_unknown_routes() {
    for fault in [
        "none",
        "collision",
        "missing-uid",
        "link",
        "partial",
        "corrupt",
        "short",
        "extra",
    ] {
        let (mut staged, peer, task) = fixture(fault).await;
        let result = async {
            staged.upload("/owned", EXECUTABLE).await?;
            staged.verify(&staged.path, 0o600).await?;
            staged.executable().await
        }
        .await;
        assert_eq!(result.is_ok(), fault == "none", "{fault}");
        let cleaned = staged.cleanup().await;
        assert_eq!(cleaned.is_ok(), fault == "none", "{fault}");
        assert_eq!(
            peer.state.lock().unwrap().removes,
            usize::from(fault == "none")
        );
        drop(staged);
        task.abort();
    }
}

#[tokio::test(start_paused = true)]
async fn cleanup_failures_identify_the_exact_owned_stage_without_changing_deletion() {
    use CleanupReason as R;
    use CleanupStage as S;
    for (fault, stage, reason, removed) in [
        ("corrupt", S::VerifyFile, R::Hash, 0),
        ("missing", S::VerifyFile, R::Missing, 0),
        ("request", S::Directory, R::Request, 0),
        ("link", S::Directory, R::Identity, 0),
        ("remove", S::RemoveFile, R::Request, 0),
        ("rmdir", S::RemoveDirectory, R::Request, 1),
        ("slow", S::VerifyFile, R::Timeout, 0),
    ] {
        let (mut staged, peer, task) = ready(EXECUTABLE, false).await;
        *peer.fault.lock().unwrap() = fault;
        let result = bounded_cleanup(&mut staged).await;
        assert_eq!(result, Err(CleanupFailure { stage, reason }), "{fault}");
        let state = peer.state.lock().unwrap();
        assert_eq!(state.removes, removed, "{fault}");
        assert!(state.directory.is_some(), "no recursive removal on {fault}");
        drop(state);
        drop(staged);
        task.abort();
    }
}

async fn ready(data: &[u8], delayed: bool) -> (Staging, Peer, tokio::task::JoinHandle<()>) {
    let (mut staged, peer, task) = fixture_data("none", data, delayed).await;
    staged.raw.set_timeout(15);
    staged.upload("/owned", data).await.unwrap();
    staged.executable().await.unwrap();
    (staged, peer, task)
}
async fn bounded_cleanup(staged: &mut Staging) -> std::result::Result<(), CleanupFailure> {
    match tokio::time::timeout(Duration::from_secs(5), staged.cleanup()).await {
        Ok(result) => result,
        Err(_) => Err(staged.cleanup_timeout()),
    }
}
