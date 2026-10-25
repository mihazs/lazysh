#![cfg(target_os = "linux")]
use lazysh_et_transport::{Client, Event, SessionSecret};
use std::os::unix::ffi::OsStrExt;
use std::{
    io::{BufRead, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    time::timeout,
};

struct Fixture {
    server: Child,
    directory: tempfile::TempDir,
    endpoint: SocketAddr,
    terminal: PathBuf,
    fifo: PathBuf,
}
impl Fixture {
    async fn new() -> Self {
        let server = std::env::var_os("ET_SERVER_BIN")
            .expect("Set ET_SERVER_BIN to the official ET 7.0.0 etserver");
        let terminal = PathBuf::from(
            std::env::var_os("ET_TERMINAL_BIN")
                .expect("Set ET_TERMINAL_BIN to the official ET 7.0.0 etterminal"),
        );
        let directory = tempfile::tempdir().unwrap();
        let fifo = directory.path().join("et-test.fifo");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = listener.local_addr().unwrap();
        drop(listener);
        let server = Command::new(server)
            .arg("--port")
            .arg(endpoint.port().to_string())
            .args(["--bindip", "127.0.0.1", "--serverfifo"])
            .arg(&fifo)
            .arg("--logdir")
            .arg(directory.path())
            .arg("--logtostdout")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SHELL", "/bin/sh")
            .env("HOME", directory.path())
            .env("LANG", "C.UTF-8")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut fixture = Self {
            server,
            directory,
            endpoint,
            terminal,
            fifo,
        };
        timeout(Duration::from_secs(5), async {
            loop {
                assert!(
                    fixture.server.try_wait().unwrap().is_none(),
                    "official test server exited"
                );
                if TcpStream::connect(endpoint).await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        fixture
    }
    async fn bootstrap(&self) -> Vec<u8> {
        let mut child = Command::new(&self.terminal)
            .arg("--serverfifo")
            .arg(&self.fifo)
            .arg("--logdir")
            .arg(self.directory.path())
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SHELL", "/bin/sh")
            .env("HOME", self.directory.path())
            .env("LANG", "C.UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"XXXdefghijklmnop/01234567890123456789012345678901_xterm-256color\n")
            .unwrap();
        let result = tokio::task::spawn_blocking(move || {
            let stdout = child.stdout.take().unwrap();
            let mut output = Vec::new();
            for line in std::io::BufReader::new(stdout).split(b'\n') {
                let line = line.unwrap();
                if output.len() + line.len() > 65536 {
                    panic!("ET bootstrap output exceeds limit");
                }
                output.extend(&line);
                output.push(b'\n');
                if line.windows(10).any(|value| value == b"IDPASSKEY:") {
                    break;
                }
            }
            let _ = child.wait();
            SessionSecret::from_bootstrap(&output).unwrap();
            output
        });
        timeout(Duration::from_secs(5), result)
            .await
            .unwrap()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
        // Only helpers with this fixture's exact private FIFO argument are ours.
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
                    continue;
                };
                let Ok(command) = std::fs::read(entry.path().join("cmdline")) else {
                    continue;
                };
                let args = command.split(|value| *value == 0).collect::<Vec<_>>();
                if args.first().is_some_and(|arg| {
                    Path::new(std::ffi::OsStr::from_bytes(arg)).file_name()
                        == self.terminal.file_name()
                }) && args
                    .iter()
                    .any(|arg| *arg == self.fifo.as_os_str().as_encoded_bytes())
                {
                    let _ = Command::new("kill")
                        .args(["-TERM", &pid.to_string()])
                        .status();
                }
            }
        }
    }
}

async fn until(client: &mut Client, text: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    timeout(Duration::from_secs(5), async {
        loop {
            match client.next_event().await {
                Some(Event::Output(bytes)) => {
                    output.extend(bytes);
                    assert!(output.len() <= 1024 * 1024);
                    if output.windows(text.len()).any(|value| value == text) {
                        return;
                    }
                }
                Some(Event::Failed(error)) => panic!("ET failed: {error}"),
                Some(_) => {}
                None => panic!("ET closed"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "Expected {:?}, received {:?}",
            String::from_utf8_lossy(text),
            String::from_utf8_lossy(&output)
        )
    });
    output
}

#[tokio::test]
#[ignore = "requires official ET_SERVER_BIN and ET_TERMINAL_BIN; run explicitly for interoperability"]
async fn official_server_utf8_resize_and_recovery_preserve_order() {
    let fixture = Fixture::new().await;
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = proxy.local_addr().unwrap();
    let (interrupt, _) = watch::channel(0usize);
    let stop = Arc::new(interrupt);
    let listener_stop = stop.clone();
    let remote = fixture.endpoint;
    let cut_next = Arc::new(AtomicBool::new(false));
    let proxy_cut = cut_next.clone();
    let proxy_task = tokio::spawn(async move {
        loop {
            let (mut local, _) = proxy.accept().await.unwrap();
            let mut remote = TcpStream::connect(remote).await.unwrap();
            let mut cancel = listener_stop.subscribe();
            let cut = proxy_cut.clone();
            tokio::spawn(async move {
                let (mut local_read, mut local_write) = local.split();
                let (mut remote_read, mut remote_write) = remote.split();
                let downstream = async {
                    let mut buffer = [0; 16384];
                    loop {
                        let count = remote_read.read(&mut buffer).await?;
                        if count == 0 {
                            return Ok::<_, std::io::Error>(());
                        }
                        if cut.swap(false, Ordering::SeqCst) {
                            local_write.write_all(&buffer[..count.min(3)]).await?;
                            return Ok(());
                        }
                        local_write.write_all(&buffer[..count]).await?;
                    }
                };
                tokio::select! { _ = cancel.changed() => {}, _ = tokio::io::copy(&mut local_read, &mut remote_write) => {}, _ = downstream => {} }
            });
        }
    });
    let mut client = Client::connect(
        endpoint,
        SessionSecret::from_bootstrap(&fixture.bootstrap().await).unwrap(),
        80,
        24,
    )
    .await
    .unwrap();
    let control = client.control();
    control
        .send("printf '\\n__ET_UTF8__世界\\n'\n".as_bytes().to_vec())
        .await
        .unwrap();
    let output = until(&mut client, "\r\n__ET_UTF8__世界\r\n".as_bytes()).await;
    assert!(output.len() < 1024 * 1024);
    control.resize(110, 35).await.unwrap();
    control
        .send(b"printf '\\n'; stty size\n".to_vec())
        .await
        .unwrap();
    until(&mut client, b"\r\n35 110\r\n").await;
    stop.send_replace(1);
    timeout(Duration::from_secs(5), async {
        loop {
            if matches!(client.next_event().await, Some(Event::Disconnected)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    control
        .send(b"printf '\\n__FIRST__\\n'\n".to_vec())
        .await
        .unwrap();
    control
        .send(b"printf '\\n__SECOND__\\n'\n".to_vec())
        .await
        .unwrap();
    control.reconnect(endpoint).await.unwrap();
    let output = until(&mut client, b"\r\n__SECOND__\r\n").await;
    let text = String::from_utf8_lossy(&output);
    assert_eq!(text.matches("\r\n__FIRST__\r\n").count(), 1);
    assert_eq!(text.matches("\r\n__SECOND__\r\n").count(), 1);
    assert!(text.find("\r\n__FIRST__\r\n") < text.find("\r\n__SECOND__\r\n"));
    cut_next.store(true, Ordering::SeqCst);
    control
        .send(b"printf '\\n__MIDFRAME__\\n'\n".to_vec())
        .await
        .unwrap();
    timeout(Duration::from_secs(5), async {
        loop {
            if matches!(client.next_event().await, Some(Event::Disconnected)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    control.reconnect(endpoint).await.unwrap();
    let output = until(&mut client, b"\r\n__MIDFRAME__\r\n").await;
    assert_eq!(
        String::from_utf8_lossy(&output)
            .matches("\r\n__MIDFRAME__\r\n")
            .count(),
        1
    );
    control.send(b"exit\n".to_vec()).await.unwrap();
    client.close().await;
    proxy_task.abort();
}

#[tokio::test]
#[ignore = "requires official ET_SERVER_BIN and ET_TERMINAL_BIN; run explicitly for interoperability"]
async fn official_server_wrong_secret_fails_and_stalled_consumer_can_cancel() {
    let fixture = Fixture::new().await;
    let mut output = fixture.bootstrap().await;
    let start = output
        .windows(10)
        .position(|bytes| bytes == b"IDPASSKEY:")
        .unwrap()
        + 10
        + 17;
    output[start] = if output[start] == b'A' { b'B' } else { b'A' };
    assert!(Client::connect(
        fixture.endpoint,
        SessionSecret::from_bootstrap(&output).unwrap(),
        80,
        24
    )
    .await
    .is_err());
    drop(fixture);
    let fixture = Fixture::new().await;
    let client = Client::connect(
        fixture.endpoint,
        SessionSecret::from_bootstrap(&fixture.bootstrap().await).unwrap(),
        80,
        24,
    )
    .await
    .unwrap();
    client
        .control()
        .send(b"head -c 1048576 /dev/zero\n".to_vec())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    timeout(Duration::from_secs(2), client.close())
        .await
        .unwrap();
}
