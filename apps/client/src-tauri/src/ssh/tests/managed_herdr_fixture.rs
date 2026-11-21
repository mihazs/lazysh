//! Owned local SSH acceptance of the managed Herdr install and removal: a real host shell, real SFTP and the real host
//! script. The publisher fixture is cfg(test), never a production URL. The executable is a tiny static ELF, so only
//! Linux runs it; the host script's macOS branch is simulated by `tests/herdr-managed-install.test.ts`.
use super::*;
use std::{os::unix::fs::PermissionsExt, path::Path};
use tauri::Manager;

/// A static executable for the given CPU that exits with `code` whatever it is given, so `--version` is a real self
/// test. It is not a Herdr: the install pins and checks bytes, it does not interpret them.
fn elf(code: u8, arm: bool) -> Vec<u8> {
    let program: Vec<u8> = if arm {
        vec![
            code << 5,
            0x00,
            0x80,
            0xd2,
            0xa8,
            0x0b,
            0x80,
            0xd2,
            0x01,
            0x00,
            0x00,
            0xd4,
        ]
    } else {
        vec![0xbf, code, 0, 0, 0, 0xb8, 0x3c, 0, 0, 0, 0x0f, 0x05]
    };
    let size = 120 + program.len();
    let mut file = vec![0u8; size];
    file[..7].copy_from_slice(&[0x7f, b'E', b'L', b'F', 2, 1, 1]);
    let put = |file: &mut Vec<u8>, at: usize, value: u64, width: usize| {
        file[at..at + width].copy_from_slice(&value.to_le_bytes()[..width])
    };
    put(&mut file, 16, 2, 2);
    put(&mut file, 18, if arm { 0xb7 } else { 0x3e }, 2);
    put(&mut file, 20, 1, 4);
    put(&mut file, 24, 0x400078, 8);
    put(&mut file, 32, 64, 8);
    put(&mut file, 52, 64, 2);
    put(&mut file, 54, 56, 2);
    put(&mut file, 56, 1, 2);
    put(&mut file, 64, 1, 4);
    put(&mut file, 68, 5, 4);
    put(&mut file, 80, 0x400000, 8);
    put(&mut file, 88, 0x400000, 8);
    put(&mut file, 96, size as u64, 8);
    put(&mut file, 104, size as u64, 8);
    put(&mut file, 112, 0x1000, 8);
    file[120..].copy_from_slice(&program);
    file
}
/// What a host that already runs Herdr keeps and no managed action may change.
struct Stock {
    files: Vec<(std::path::PathBuf, Vec<u8>)>,
    server: owned_sshd::Process,
}
impl Stock {
    fn seed(directory: &Path) -> Self {
        let mut files = Vec::new();
        for (path, text) in [
            ("bin/herdr", "#!/bin/sh\nprintf 'stock herdr\\n'\n"),
            (".config/herdr/config.toml", "default = \"stock\"\n"),
            (
                ".local/state/herdr/session.json",
                "{\"sessions\":[\"stock\"]}",
            ),
            (
                ".local/state/lazysh-herdr/session.json",
                "{\"sessions\":[\"managed\"]}",
            ),
            (
                "data/lazysh/companion/lazysh-agent",
                "companion that must stay",
            ),
        ] {
            let path = directory.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            files.push((path, text.as_bytes().to_vec()));
        }
        let server = owned_sshd::Process(
            std::process::Command::new("sleep")
                .arg("600")
                .spawn()
                .unwrap(),
        );
        Self { files, server }
    }
    /// Every kept file is byte for byte what it was and the stock server is the same running process.
    fn assert_untouched(&mut self) {
        for (path, bytes) in &self.files {
            assert_eq!(&fs::read(path).unwrap(), bytes, "{}", path.display());
        }
        assert!(self.server.0.try_wait().unwrap().is_none());
    }
}
/// Staging directories an install left in the host's home.
fn leftovers(directory: &Path) -> Vec<String> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".lazysh-install-"))
        .collect()
}
/// Installs `file` once the previous operation has settled and returns the failure kind it was refused with.
async fn refusal(
    session: &Arc<Session>,
    lease: &AccessLease,
    directory: &Path,
    file: Vec<u8>,
) -> String {
    super::companion_fixture::settled(session).await;
    let path = directory.join("refused");
    fs::write(&path, file).unwrap();
    crate::companion::Owned::new(&path, env!("CARGO_PKG_VERSION"))
        .install(
            session.clone(),
            lease,
            crate::companion::install::Route::Herdr,
        )
        .await
        .unwrap_err()
        .kind()
        .to_owned()
}
pub(super) async fn verify(app: &tauri::App<tauri::test::MockRuntime>, id: &str, directory: &Path) {
    use crate::companion::{install, Owned};
    let session = app.state::<AppState>().session(id).await.unwrap();
    let lease = access_lease();
    let version = env!("CARGO_PKG_VERSION");
    let arm = cfg!(target_arch = "aarch64");
    let managed = directory.join("data/lazysh/herdr");
    let binary = managed.join("lazysh-herdr");
    let mut stock = Stock::seed(directory);
    let candidate = directory.join("candidate");
    fs::write(&candidate, elf(0, arm)).unwrap();
    let owned = Owned::new(&candidate, version);

    // A host with nothing installed: the verified file is uploaded, checked on the host and published by one rename.
    super::companion_fixture::settled(&session).await;
    let first = serde_json::to_value(
        owned
            .install(session.clone(), &lease, install::Route::Herdr)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        (first["status"].as_str(), first["cleanup"].as_str()),
        (Some("installed"), Some("complete"))
    );
    assert_eq!(first["path"], binary.to_str().unwrap());
    assert_eq!(fs::read(&binary).unwrap(), fs::read(&candidate).unwrap());
    assert_eq!(
        fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&managed).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(leftovers(directory).is_empty(), "staging is cleaned up");
    assert!(
        fs::read_dir(&managed)
            .unwrap()
            .all(|entry| entry.unwrap().file_name() == "lazysh-herdr"),
        "nothing but the managed binary is left in its directory"
    );
    assert_eq!(
        owned.downloads(),
        1,
        "this device downloads and uploads; the host never does"
    );
    stock.assert_untouched();

    // The same file again changes nothing.
    super::companion_fixture::settled(&session).await;
    let written = fs::metadata(&binary).unwrap().modified().unwrap();
    let second = serde_json::to_value(
        owned
            .install(session.clone(), &lease, install::Route::Herdr)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(second["status"], "reused");
    assert_eq!(fs::metadata(&binary).unwrap().modified().unwrap(), written);
    stock.assert_untouched();

    // One install or removal at a time on a connection.
    super::companion_fixture::settled(&session).await;
    let busy = session
        .bindings
        .companion_install
        .clone()
        .try_acquire_owned()
        .unwrap();
    let refused = owned
        .install(session.clone(), &lease, install::Route::Herdr)
        .await
        .unwrap_err();
    assert_eq!(refused.kind(), "companion_install_busy");
    assert_eq!(
        install::remove_herdr(session.clone(), &lease)
            .await
            .unwrap_err()
            .kind(),
        "companion_install_busy"
    );
    drop(busy);

    // An executable for another CPU is refused on the host and nothing is published or left behind.
    super::companion_fixture::settled(&session).await;
    fs::remove_file(&binary).unwrap();
    let kind = refusal(&session, &lease, directory, elf(0, !arm)).await;
    assert_eq!(kind, "herdr_architecture_mismatch");
    assert!(!binary.exists());
    assert!(leftovers(directory).is_empty());
    // An executable that does not run on this host is never published either.
    assert_eq!(
        refusal(&session, &lease, directory, elf(1, arm)).await,
        "herdr_self_test_failed"
    );
    assert!(!binary.exists());
    assert!(fs::read_dir(&managed).unwrap().next().is_none());
    stock.assert_untouched();

    // A destination that is a link to the stock executable is refused, and the stock executable is never written.
    super::companion_fixture::settled(&session).await;
    std::os::unix::fs::symlink(directory.join("bin/herdr"), &binary).unwrap();
    assert_eq!(
        refusal(&session, &lease, directory, elf(0, arm)).await,
        "herdr_unsafe_location"
    );
    super::companion_fixture::settled(&session).await;
    assert_eq!(
        install::remove_herdr(session.clone(), &lease)
            .await
            .unwrap_err()
            .kind(),
        "herdr_unsafe_location"
    );
    assert!(fs::symlink_metadata(&binary)
        .unwrap()
        .file_type()
        .is_symlink());
    fs::remove_file(&binary).unwrap();
    stock.assert_untouched();

    // Removal deletes only the managed binary, then finds nothing to delete.
    super::companion_fixture::settled(&session).await;
    fs::write(&candidate, elf(0, arm)).unwrap();
    Owned::new(&candidate, version)
        .install(session.clone(), &lease, install::Route::Herdr)
        .await
        .unwrap();
    fs::write(managed.join("kept"), b"not the managed binary").unwrap();
    super::companion_fixture::settled(&session).await;
    let removed = serde_json::to_value(
        install::remove_herdr(session.clone(), &lease)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(removed["status"], "removed");
    assert_eq!(removed["path"], binary.to_str().unwrap());
    assert!(!binary.exists());
    assert_eq!(
        fs::read(managed.join("kept")).unwrap(),
        b"not the managed binary"
    );
    super::companion_fixture::settled(&session).await;
    let again = serde_json::to_value(
        install::remove_herdr(session.clone(), &lease)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(again["status"], "absent");
    stock.assert_untouched();
    assert!(leftovers(directory).is_empty());
}
