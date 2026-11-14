//! A Cline credential store is read only when it is a plain disk file, and a stalled read never
//! holds the caller: this runs through the public availability check the collectors call.
#![cfg(feature = "collector")]
use ai_usagebar_core::{has_local_credentials, Config, VendorId};
use std::{path::Path, sync::mpsc, time::Duration};

const STORE: &str = r#"{"version":1,"providers":{"cline":{"updatedAt":"2026-11-04T00:00:00.000Z","tokenSource":"oauth","settings":{"provider":"cline","auth":{"accessToken":"owned-cline-fixture","accountId":"owned-account","expiresAt":1}}}}}"#;

/// The Cline availability answer for an explicit store path; a hang fails the test, not the job.
fn available(path: &Path) -> bool {
    let mut config = Config::default();
    config.cline.api_key_env.clear();
    config.cline.auth_paths = Some(vec![path.to_path_buf()]);
    let (answer, received) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = answer.send(has_local_credentials(VendorId::Cline, &config));
    });
    received
        .recv_timeout(Duration::from_secs(30))
        .expect("reading the store stalled the availability check")
}

#[test]
fn only_a_plain_store_within_the_size_bound_is_read() {
    let directory = tempfile::tempdir().unwrap();
    let store = directory.path().join("providers.json");
    std::fs::write(&store, STORE).unwrap();
    assert!(available(&store), "a plain store is read");

    let oversized = directory.path().join("oversized.json");
    std::fs::write(&oversized, vec![b' '; 1024 * 1024 + 1]).unwrap();
    assert!(!available(&oversized));
    assert!(!available(directory.path()));
    assert!(!available(&directory.path().join("missing.json")));
}

#[cfg(windows)]
#[tokio::test]
async fn a_pipe_in_place_of_the_store_is_refused_without_waiting_for_data() {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = format!(r"\\.\pipe\lazysh-cline-store-{}", std::process::id());
    // The server never connects or writes. Several instances, so the existence check and the open
    // each reach one; a reader that took data from it would wait forever.
    let _instances: Vec<_> = (0..4)
        .map(|index| {
            ServerOptions::new()
                .first_pipe_instance(index == 0)
                .create(&name)
                .unwrap()
        })
        .collect();
    assert!(!available(Path::new(&name)));
}
