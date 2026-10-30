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
}
#[derive(Clone)]
struct Peer {
    state: Arc<Mutex<Observed>>,
    fault: &'static str,
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
        if self.fault == "collision" {
            return Err(StatusCode::Failure);
        }
        self.state.lock().unwrap().directory = Some(path);
        Ok(ok(id))
    }
    async fn lstat(&mut self, id: u32, path: String) -> std::result::Result<Attrs, StatusCode> {
        let state = self.state.lock().unwrap();
        let mut attrs = if path == "/owned" {
            metadata(true, 0, 0o755)
        } else if state.directory.as_deref() == Some(&path) {
            metadata(true, 0, 0o700)
        } else if state.file.as_deref() == Some(&path) {
            metadata(false, state.body.len() as u64, state.mode)
        } else {
            return Err(StatusCode::NoSuchFile);
        };
        if self.fault == "missing-uid" && path != "/owned" {
            attrs.uid = None;
        }
        if self.fault == "link" && path != "/owned" {
            attrs.permissions = Some(0o120700);
        }
        Ok(Attrs { id, attrs })
    }
    async fn fstat(&mut self, id: u32, _handle: String) -> std::result::Result<Attrs, StatusCode> {
        let state = self.state.lock().unwrap();
        Ok(Attrs {
            id,
            attrs: metadata(false, state.body.len() as u64, state.mode),
        })
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
            handle: "owned-file".into(),
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
        if self.fault == "partial" {
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
        let state = self.state.lock().unwrap();
        let mut bytes = state.body.clone();
        match self.fault {
            "corrupt" => bytes[0] ^= 1,
            "short" => {
                bytes.pop();
            }
            "extra" => bytes.push(1),
            _ => {}
        }
        if offset as usize >= bytes.len() {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: bytes[offset as usize..bytes.len().min(offset as usize + length as usize)]
                .to_vec(),
        })
    }
    async fn close(&mut self, id: u32, _handle: String) -> std::result::Result<Status, StatusCode> {
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
        let mut state = self.state.lock().unwrap();
        assert_eq!(Some(path), state.file);
        state.file = None;
        state.removes += 1;
        Ok(ok(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> std::result::Result<Status, StatusCode> {
        let mut state = self.state.lock().unwrap();
        assert_eq!(Some(path), state.directory);
        if state.file.is_some() {
            return Err(StatusCode::Failure);
        }
        state.directory = None;
        Ok(ok(id))
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
        let observed = Arc::new(Mutex::new(Observed::default()));
        let (client, server) = tokio::io::duplex(262_144);
        let peer = Peer {
            state: observed.clone(),
            fault,
        };
        let task = tokio::spawn(russh_sftp::server::run(server, peer));
        let raw = RawSftpSession::new(crate::sftp_stream::SftpStream::new(client));
        raw.set_timeout(2);
        raw.init().await.unwrap();
        let data = b"owned verified executable";
        let publisher = release::Publisher::owned(data.to_vec(), "0.24.0".into());
        let selection = publisher.select("linux-agent-x64").await.unwrap();
        let unix = resolve::Unix {
            os: "linux",
            arch: "x64",
            uid: 1000,
            home: "/owned".into(),
            data: "/owned/data".into(),
        };
        let mut staged = Staging::new(raw, &unix, &selection);
        let result = async {
            staged.upload(&unix.home, data).await?;
            staged.verify(&staged.path, 0o600).await?;
            staged.executable().await
        }
        .await;
        assert_eq!(result.is_ok(), fault == "none", "{fault}");
        let cleaned = staged.cleanup().await;
        assert_eq!(cleaned, fault == "none", "{fault}");
        assert_eq!(
            observed.lock().unwrap().removes,
            usize::from(fault == "none")
        );
        drop(staged);
        task.abort();
    }
}
