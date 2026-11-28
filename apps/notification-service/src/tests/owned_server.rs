//! What the real-server cases (Gotify, ntfy) share: an owned, pinned official binary, an owned
//! TLS loopback identity and a readiness wait.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};

/// A private (0700) temporary directory.
pub(super) fn private_directory() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}

/// The immutable owned binary that `variable` names: absolute, a single read-only regular
/// file owned by the same user as `directory`, and exactly the pinned SHA-256.
pub(super) fn pinned_binary(variable: &str, sha256: &str, directory: &Path) -> PathBuf {
    let binary = PathBuf::from(std::env::var_os(variable).expect("owned server binary"));
    assert!(binary.is_absolute());
    let metadata = fs::symlink_metadata(&binary).unwrap();
    assert!(metadata.is_file() && metadata.nlink() == 1 && metadata.mode() & 0o222 == 0);
    assert_eq!(metadata.uid(), fs::metadata(directory).unwrap().uid());
    assert_eq!(
        format!("{:x}", Sha256::digest(fs::read(&binary).unwrap())),
        sha256
    );
    binary
}

/// An owned self-signed identity for `localhost` on a free loopback port.
pub(super) struct Tls {
    pub certificate: PathBuf,
    pub key: PathBuf,
    pub port: u16,
    pub origin: String,
    /// Verifies the owned certificate, ignores proxies and never follows a redirect.
    pub client: reqwest::Client,
}
pub(super) async fn tls(directory: &Path) -> Tls {
    let identity = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let certificate = directory.join("server.pem");
    let key = directory.join("server-key.pem");
    client::write_private(&certificate, identity.cert.pem().as_bytes()).unwrap();
    client::write_private(&key, identity.signing_key.serialize_pem().as_bytes()).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .add_root_certificate(
            reqwest::Certificate::from_pem(identity.cert.pem().as_bytes()).unwrap(),
        )
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    Tls {
        certificate,
        key,
        port,
        origin: format!("https://localhost:{port}"),
        client,
    }
}

/// Waits until `url` answers 2xx while `server` is still running, then checks that the system
/// trust store, unlike the owned client, refuses the owned certificate.
pub(super) async fn ready(server: &mut tokio::process::Child, client: &reqwest::Client, url: &str) {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            assert!(
                server.try_wait().unwrap().is_none(),
                "owned server exited before readiness"
            );
            if client
                .get(url)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("owned server readiness deadline");
    assert!(http_client().unwrap().get(url).send().await.is_err());
}

/// Starts the owned server with no terminal attached and kills it when the case ends.
pub(super) fn spawn(command: &mut tokio::process::Command) -> tokio::process::Child {
    let detached = std::process::Stdio::null;
    command.stdin(detached());
    command.stdout(detached());
    command.stderr(detached());
    command.kill_on_drop(true);
    command.spawn().unwrap()
}
