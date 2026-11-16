//! The SFTP and preview-forward checks that read the same on every owned OpenSSH host, whatever its operating system.
use super::*;
use std::path::Path;
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;

/// Uploads without overwriting, reads, lists and refuses in `dir`, the directory the host's SFTP server names `remote`.
pub(super) async fn sftp(app: &App, id: &str, dir: &Path, remote: &str) {
    let at = |name: &str| format!("{remote}/{name}");
    let upload = |path: String, bytes: Vec<u8>| {
        upload_file(access_lease(), app.state(), id.into(), path, bytes)
    };
    let read = |path: String| read_file(access_lease(), app.state(), app.state(), id.into(), path);
    let list =
        |path: String| list_directory(access_lease(), app.state(), app.state(), id.into(), path);
    let new_file = at("new file' safe.txt");
    upload(new_file.clone(), "hello 世界".as_bytes().to_vec())
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    assert_eq!(
        read(new_file.clone()).await.unwrap().into_inner().unwrap(),
        "hello 世界"
    );
    assert!(upload(new_file, b"replacement".to_vec()).await.is_err());
    assert_eq!(
        fs::read(dir.join("new file' safe.txt")).unwrap(),
        "hello 世界".as_bytes()
    );
    let entries = list(remote.into()).await.unwrap().into_inner().unwrap();
    assert!(entries
        .iter()
        .any(|e| e.name == "new file' safe.txt" && !e.is_dir && e.size == 12));
    fs::write(dir.join("large"), vec![0u8; FILE_LIMIT as usize + 1]).unwrap();
    fs::write(dir.join("binary"), [0xffu8, 0xfe]).unwrap();
    for (name, kind) in [("large", "file_too_large"), ("binary", "binary_file")] {
        let error = read(at(name)).await.err().unwrap().into_inner().unwrap();
        assert_eq!(error.kind, kind);
    }
    let crowded = dir.join("crowded");
    fs::create_dir(&crowded).unwrap();
    for i in 0..10001 {
        fs::write(crowded.join(i.to_string()), b"").unwrap();
    }
    let error = list(at("crowded"))
        .await
        .err()
        .unwrap()
        .into_inner()
        .unwrap();
    assert_eq!(error.kind, "directory_too_large");
    let error = upload(at("rejected-upload"), vec![0; UPLOAD_LIMIT + 1])
        .await
        .err()
        .unwrap()
        .into_inner()
        .unwrap();
    assert_eq!(error.kind, "file_too_large");
    assert!(!dir.join("rejected-upload").exists());
}

/// A Git repository `name` in `dir` whose `file.txt` is staged as "before" and reads "after" in the work tree.
pub(super) fn git_repo(dir: &Path, name: &str) -> PathBuf {
    let repo = dir.join(name);
    fs::create_dir(&repo).unwrap();
    let git = |args: &[&std::ffi::OsStr]| {
        assert!(std::process::Command::new("git")
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    };
    git(&["init".as_ref(), repo.as_os_str()]);
    fs::write(repo.join("file.txt"), "before\n").unwrap();
    git(&[
        "-C".as_ref(),
        repo.as_os_str(),
        "add".as_ref(),
        "file.txt".as_ref(),
    ]);
    fs::write(repo.join("file.txt"), "after\n").unwrap();
    repo
}

/// Previews a listener on the host: its port is taken, so the forward falls back to an unused local one, and an HTTP
/// upgrade and a WebSocket frame cross it byte for byte. Returns the local port.
pub(super) async fn preview_forward(app: &App, id: &str) -> u16 {
    app.manage(crate::previews::PreviewState::default());
    let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_port = http.local_addr().unwrap().port();
    let request = b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
    let response = b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
    let websocket = [0x81, 0x82, 0, 1, 2, 3, b'H', b'i' ^ 1];
    let web_server = tokio::spawn(async move {
        let (mut socket, _) = http.accept().await.unwrap();
        let mut received = vec![0; request.len()];
        socket.read_exact(&mut received).await.unwrap();
        assert_eq!(received, request);
        socket.write_all(response).await.unwrap();
        let mut frame = [0; 8];
        socket.read_exact(&mut frame).await.unwrap();
        assert_eq!(frame, websocket);
        socket.write_all(&[0x81, 2, b'H', b'i']).await.unwrap();
    });
    let preview = crate::previews::start_preview(
        access_lease(),
        app.state(),
        app.state(),
        id.into(),
        http_port,
        None,
        None,
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    let preview = serde_json::to_value(preview).unwrap();
    let local_port = preview["localPort"].as_u64().unwrap() as u16;
    assert_ne!(
        local_port, http_port,
        "occupied port must fall back to an unused port"
    );
    let mut browser = tokio::net::TcpStream::connect(("127.0.0.1", local_port))
        .await
        .unwrap();
    browser.write_all(request).await.unwrap();
    let mut received = vec![0; response.len()];
    timeout(Duration::from_secs(3), browser.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received, response);
    browser.write_all(&websocket).await.unwrap();
    let mut frame = [0; 4];
    timeout(Duration::from_secs(3), browser.read_exact(&mut frame))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame, [0x81, 2, b'H', b'i']);
    web_server.await.unwrap();
    local_port
}

/// Ends the session and waits for the forwarded local port to refuse connections.
pub(super) async fn forward_ends_with_session(app: &App, id: String, local_port: u16) {
    disconnect(app.state(), id).await.unwrap();
    timeout(Duration::from_secs(2), async {
        while tokio::net::TcpStream::connect(("127.0.0.1", local_port))
            .await
            .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
