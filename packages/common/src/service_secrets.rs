//! Bounded zeroized secret reads for Unix relay services.
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};
use zeroize::Zeroizing;

pub fn private(metadata: &fs::Metadata, directory: bool) -> Result<(), String> {
    if !cfg!(unix) {
        return Err("Private file owner checks require a Unix host".into());
    }
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err("Require a private regular file or directory".into());
    }
    if !crate::fs::owner_only(metadata, directory) {
        return Err("Require private owner-only storage without hard links".into());
    }
    Ok(())
}
pub fn file(path: &Path, create: bool) -> Result<File, String> {
    if !cfg!(unix) {
        return Err("Private file owner checks require a Unix host".into());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("Symlinks are not supported".into());
            }
            private(&metadata, false)?;
        }
        Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Cannot open private file".into()),
    }
    let mut options = crate::fs::read_options(create);
    options.create(create);
    let file = options.open(path).map_err(|_| "Cannot open private file")?;
    private(
        &file.metadata().map_err(|_| "Cannot inspect private file")?,
        false,
    )?;
    Ok(file)
}
pub fn read_secret(path: &Path) -> Result<Zeroizing<String>, String> {
    let mut value = Zeroizing::new(String::new());
    file(path, false)?
        .take(1025)
        .read_to_string(&mut value)
        .map_err(|_| "Cannot read secret file")?;
    if value.len() > 1024 {
        return Err("Secret file is too large".into());
    }
    Ok(value)
}

#[cfg(all(test, not(unix)))]
mod tests {
    #[test]
    fn public_storage_helpers_reject_unverified_host_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("secret");
        std::fs::write(&path, "owned fixture").unwrap();
        for (path, is_directory) in [(directory.path(), true), (path.as_path(), false)] {
            assert_eq!(
                super::private(&std::fs::metadata(path).unwrap(), is_directory),
                Err("Private file owner checks require a Unix host".into())
            );
        }
        assert!(super::file(&path, false).is_err());
        assert!(super::read_secret(&path).is_err());
    }
}
