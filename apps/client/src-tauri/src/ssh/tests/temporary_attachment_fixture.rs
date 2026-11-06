//! Owned OpenSSH acceptance: attachments default to private, uniquely named /tmp files.
use super::*;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;

async fn upload(
    app: &App,
    id: &str,
    name: &str,
    data: Vec<u8>,
    temporary: Option<bool>,
) -> std::result::Result<String, SshError> {
    let reserved = crate::attachment_upload::upload_reserve(
        access_lease(),
        app.state(),
        id.into(),
        data.len(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    match crate::attachment_upload::upload_file(
        access_lease(),
        app.state(),
        id.into(),
        reserved.upload_id,
        name.into(),
        data,
        temporary,
    )
    .await
    {
        Ok(uploaded) => Ok(uploaded.into_inner().unwrap().path),
        Err(error) => Err(error.into_inner().unwrap()),
    }
}

/// Removes the owned files this check wrote to the shared temporary directory.
struct Owned(Vec<PathBuf>);
impl Drop for Owned {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

pub(super) async fn verify(app: &App, id: &str, directory: &Path) {
    let name = "Screenshot 世界's.png";
    let image = vec![0x5a; 462_702];
    let mut owned = Owned(Vec::new());
    let shared = fs::canonicalize("/tmp").unwrap();
    let account = fs::metadata(directory).unwrap().uid();
    for _ in 0..2 {
        let path = PathBuf::from(
            upload(app, id, name, image.clone(), Some(true))
                .await
                .unwrap(),
        );
        owned.0.push(path.clone());
        assert_eq!(path.parent(), Some(shared.as_path()));
        let file = path.file_name().unwrap().to_str().unwrap();
        assert!(file.starts_with("lazysh-") && file.ends_with(&format!("-{name}")));
        let metadata = fs::symlink_metadata(&path).unwrap();
        assert!(metadata.is_file());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(metadata.uid(), account);
        assert_eq!(fs::read(&path).unwrap(), image);
    }
    assert_ne!(owned.0[0], owned.0[1], "repeated uploads must not collide");

    // A temporary upload names one file; a folder is refused before any write.
    let refused = upload(app, id, "../escape.png", b"no".to_vec(), Some(true))
        .await
        .unwrap_err();
    assert_eq!(refused.kind(), "invalid_path");
    assert!(!shared.join("escape.png").exists());

    // An explicit destination keeps its exact remote path.
    let explicit = upload(app, id, "./explicit.txt", b"explicit".to_vec(), None)
        .await
        .unwrap();
    assert_eq!(
        PathBuf::from(explicit),
        fs::canonicalize(directory).unwrap().join("explicit.txt")
    );
}
