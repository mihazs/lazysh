#![cfg(unix)]
//! Release acceptance: the exact shipped executable has no local release-server seam.
//! A build that honored `LAZYSH_UPDATE_TEST_ENDPOINT` would ask for the local name; the shipped one must
//! still ask for GitHub's API host. No real network is used: a recording proxy refuses the tunnel.
use lazysh_companion_release::fake::Server;
use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
    process::Command,
    time::{Duration, Instant},
};
#[path = "support/binary.rs"]
mod binary;

#[test]
fn the_shipped_executable_ignores_the_test_endpoint() {
    if std::env::var_os("LAZYSH_TEST_COMPANION_BINARY").is_none() {
        eprintln!(
            "skipped: release acceptance needs LAZYSH_TEST_COMPANION_BINARY (the shipped bytes)"
        );
        return;
    }
    let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
    proxy.set_nonblocking(true).unwrap();
    let port = proxy.local_addr().unwrap().port();
    // Records the tunnel request and hangs up, which is all this test needs from a proxy.
    let recorder = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match proxy.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    let mut line = String::new();
                    BufReader::new(stream).read_line(&mut line).unwrap();
                    return line;
                }
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) => panic!("no request reached the proxy: {error}"),
            }
        }
    });
    let local = Server::start(vec![]);
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("ca.pem"), &local.ca_pem).unwrap();
    let output = Command::new(binary::path())
        .args(["update", "--check", "--json"])
        .env_clear()
        .env("HOME", root.path())
        .env("XDG_DATA_HOME", root.path().join("data"))
        .env("LAZYSH_STATE_DIR", root.path().join("state"))
        .env("HTTPS_PROXY", format!("http://127.0.0.1:{port}"))
        .env("LAZYSH_UPDATE_TEST_ENDPOINT", &local.api)
        .env("LAZYSH_UPDATE_TEST_CA", root.path().join("ca.pem"))
        .output()
        .unwrap();
    let tunnel = recorder.join().unwrap();
    assert_eq!(tunnel.trim_end(), "CONNECT api.github.com:443 HTTP/1.1");
    assert_eq!(
        output.status.code(),
        Some(20),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        local.requests().is_empty(),
        "the local release server received a request"
    );
}
