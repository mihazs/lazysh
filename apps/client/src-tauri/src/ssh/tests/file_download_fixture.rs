//! Owned OpenSSH acceptance for Files downloads: stat, streaming, confirmations and cancellation
//! run over the real SFTP subsystem against files on the fixture host.
use super::*;
use crate::{
    file_transfer::{download, Options, Request, Transfers, LARGE},
    host::{Host, Kind},
};
use std::path::Path;
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;

pub(super) async fn verify(app: &App, id: &str, dir: &Path) {
    let lease = access_lease();
    let host = Host::resolve(&app.state(), &app.state(), id, &lease)
        .await
        .unwrap();
    let transfers = Transfers::new(dir.join("staging"), None);
    let source = dir.join("download 世界.bin");
    let bytes: Vec<u8> = (0..3_000_000u32).map(|n| (n % 247) as u8).collect();
    fs::write(&source, &bytes).unwrap();
    let path = |file: &Path| file.to_string_lossy().into_owned();
    let run = |file: &Path, follow_link: bool, allow_large: bool| {
        let (transfers, host, lease) = (&transfers, &host, &lease);
        let file = path(file);
        async move {
            let id = uuid::Uuid::new_v4().to_string();
            let seen = std::sync::Mutex::new(Vec::new());
            let request = Request {
                session_id: "ssh",
                id: &id,
                path: file,
                options: Options {
                    follow_link,
                    allow_large,
                },
            };
            let result = download(transfers, host, lease, request, |progress| {
                seen.lock()
                    .unwrap()
                    .push(serde_json::to_value(progress).unwrap());
            })
            .await;
            (id, result, seen.into_inner().unwrap())
        }
    };

    let stat = host.stat_file(&lease, path(&source)).await.unwrap();
    assert_eq!(
        (stat.kind, stat.size, stat.link),
        (Kind::File, bytes.len() as u64, None)
    );
    assert_eq!(
        host.stat_file(&lease, path(dir)).await.unwrap().kind,
        Kind::Directory
    );
    assert!(host
        .stat_file(&lease, path(&dir.join("absent")))
        .await
        .is_err());

    let (staged_id, staged, seen) = run(&source, false, false).await;
    assert_eq!(
        serde_json::to_value(staged.unwrap()).unwrap()["size"],
        bytes.len()
    );
    assert_eq!(
        fs::read(
            dir.join("staging")
                .join(&staged_id)
                .join("download 世界.bin")
        )
        .unwrap(),
        bytes
    );
    assert_eq!(seen.last().unwrap()["bytes"], bytes.len());
    assert_eq!(seen.last().unwrap()["total"], bytes.len());

    let (refused, directory, _) = run(dir, false, false).await;
    assert_eq!(directory.unwrap_err().kind(), "not_regular_file");
    assert!(!dir.join("staging").join(refused).exists());

    let link = dir.join("link to download");
    std::os::unix::fs::symlink(&source, &link).unwrap();
    let stat = host.stat_file(&lease, path(&link)).await.unwrap();
    assert_eq!((stat.kind, stat.size), (Kind::File, bytes.len() as u64));
    assert_eq!(
        stat.link.as_deref().map(Path::new),
        Some(fs::canonicalize(&source).unwrap().as_path())
    );
    assert_eq!(
        run(&link, false, false).await.1.unwrap_err().kind(),
        "symlink_unconfirmed"
    );
    let (linked_id, linked, _) = run(&link, true, false).await;
    linked.unwrap();
    assert_eq!(
        fs::read(dir.join("staging").join(linked_id).join("link to download")).unwrap(),
        bytes
    );

    let big = dir.join("big.bin");
    fs::File::create(&big).unwrap().set_len(LARGE + 1).unwrap();
    let (large_id, large, _) = run(&big, false, false).await;
    assert_eq!(large.unwrap_err().kind(), "file_large");
    assert!(!dir.join("staging").join(large_id).exists());

    // Cancelling once data flows stops the SFTP read and removes the partial copy.
    let cancel_id = uuid::Uuid::new_v4().to_string();
    let request = Request {
        session_id: "ssh",
        id: &cancel_id,
        path: path(&source),
        options: Options {
            follow_link: false,
            allow_large: false,
        },
    };
    let cancelled = download(&transfers, &host, &lease, request, |progress| {
        if serde_json::to_value(progress).unwrap()["bytes"].as_u64() > Some(0) {
            transfers.cancel(&cancel_id, "ssh", &lease);
        }
    })
    .await;
    assert_eq!(cancelled.unwrap_err().kind(), "transfer_cancelled");
    assert!(!dir.join("staging").join(cancel_id).exists());
}
