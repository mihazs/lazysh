use crate::Error;
use bzip2::read::BzDecoder;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};
use tempfile::{NamedTempFile, TempDir};

pub const MODEL_ID: &str = "parakeet-tdt-0.6b-v3-int8";
pub const ARCHIVE_BYTES: u64 = 487_170_055;
pub const ARCHIVE_SHA256: &str = "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf";
pub const ARCHIVE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2";
const PREFIX: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const FILES: [(&str, u64, Option<&str>); 4] = [
    (
        "encoder.int8.onnx",
        652_184_281,
        Some("acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
    ),
    (
        "decoder.int8.onnx",
        11_845_275,
        Some("179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
    ),
    (
        "joiner.int8.onnx",
        6_355_277,
        Some("3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
    ),
    // The vocabulary is authenticated by the fixed compressed-archive digest; no caller-supplied digest is accepted.
    ("tokens.txt", 93_939, None),
];
struct Catalog<'a> {
    bytes: u64,
    sha256: &'a str,
    files: &'a [(&'a str, u64, Option<&'a str>); 4],
}

/// Private extracted files remain owned for the recognizer lifetime. No arbitrary-directory constructor exists.
pub struct VerifiedBundle {
    directory: TempDir,
}
impl VerifiedBundle {
    /// Verify the one supported catalog archive while streaming to private storage, then extract fixed files.
    /// This performs no network request. Reserve roughly 1.1 GiB of temporary disk space for preparation.
    pub fn read_in(reader: impl Read, private_parent: &Path) -> Result<Self, Error> {
        prepare(
            reader,
            private_parent,
            &Catalog {
                bytes: ARCHIVE_BYTES,
                sha256: ARCHIVE_SHA256,
                files: &FILES,
            },
        )
    }
    pub(crate) fn files(&self) -> [PathBuf; 4] {
        FILES.map(|(name, _, _)| self.directory.path().join(name))
    }
}
fn prepare(
    mut reader: impl Read,
    parent: &Path,
    catalog: &Catalog<'_>,
) -> Result<VerifiedBundle, Error> {
    // Use only this canonical name after validation; never reopen the caller's potentially changing alias.
    let parent = crate::storage::trusted_parent(parent)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix("lazysh-parakeet-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let directory = builder.tempdir_in(&parent).map_err(|_| Error::Storage)?;
    crate::storage::created_directory(directory.path())?;
    let mut snapshot = NamedTempFile::new_in(directory.path()).map_err(|_| Error::Storage)?;
    crate::storage::created_file(snapshot.as_file())?;
    let mut digest = Sha256::new();
    let mut count = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let remaining = catalog.bytes.saturating_add(1).saturating_sub(count);
        if remaining == 0 {
            break;
        }
        let capacity = buffer.len().min(remaining as usize);
        let n = reader
            .read(&mut buffer[..capacity])
            .map_err(|_| Error::InvalidBundle)?;
        if n == 0 {
            break;
        }
        snapshot
            .write_all(&buffer[..n])
            .map_err(|_| Error::Storage)?;
        digest.update(&buffer[..n]);
        count += n as u64;
    }
    if count != catalog.bytes || format!("{:x}", digest.finalize()) != catalog.sha256 {
        return Err(Error::InvalidBundle);
    }
    snapshot
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|_| Error::Storage)?;
    let decoder = BzDecoder::new(snapshot.as_file_mut());
    let mut archive = tar::Archive::new(decoder);
    let mut seen = [false; 4];
    let mut unpacked = 0_u64;
    let mut entries = 0;
    let maximum = catalog.files.iter().map(|(_, bytes, _)| bytes).sum::<u64>() + 16 * 1024 * 1024;
    for entry in archive.entries().map_err(|_| Error::InvalidBundle)? {
        let mut entry = entry.map_err(|_| Error::InvalidBundle)?;
        entries += 1;
        if entries > 128 {
            return Err(Error::InvalidBundle);
        }
        let path = entry.path().map_err(|_| Error::InvalidBundle)?;
        if path.as_os_str().len() > 512
            || path
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
        {
            return Err(Error::InvalidBundle);
        }
        let text = path
            .to_str()
            .ok_or(Error::InvalidBundle)?
            .trim_end_matches('/')
            .to_owned();
        if text != PREFIX && !text.starts_with(&format!("{PREFIX}/")) {
            return Err(Error::InvalidBundle);
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(Error::InvalidBundle);
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .ok_or(Error::InvalidBundle)?;
        if unpacked > maximum {
            return Err(Error::InvalidBundle);
        }
        let Some(index) = catalog
            .files
            .iter()
            .position(|(name, _, _)| text == format!("{PREFIX}/{name}"))
        else {
            continue;
        };
        let (name, bytes, expected_hash) = catalog.files[index];
        if !kind.is_file() || seen[index] || entry.size() != bytes {
            return Err(Error::InvalidBundle);
        }
        let options = lazysh_common::fs::private_create_new();
        let mut file = options
            .open(directory.path().join(name))
            .map_err(|_| Error::Storage)?;
        crate::storage::created_file(&file)?;
        let mut digest = Sha256::new();
        let mut copied = 0_u64;
        loop {
            let n = entry.read(&mut buffer).map_err(|_| Error::InvalidBundle)?;
            if n == 0 {
                break;
            }
            copied += n as u64;
            if copied > bytes {
                return Err(Error::InvalidBundle);
            }
            file.write_all(&buffer[..n]).map_err(|_| Error::Storage)?;
            digest.update(&buffer[..n]);
        }
        if copied != bytes
            || expected_hash.is_some_and(|hash| format!("{:x}", digest.finalize()) != hash)
        {
            return Err(Error::InvalidBundle);
        }
        seen[index] = true;
    }
    let mut decoder = archive.into_inner();
    let trailing = std::io::copy(
        &mut Read::by_ref(&mut decoder).take(1024 * 1024 + 1),
        &mut std::io::sink(),
    )
    .map_err(|_| Error::InvalidBundle)?;
    if trailing > 1024 * 1024 || decoder.total_in() != catalog.bytes || !seen.into_iter().all(|v| v)
    {
        return Err(Error::InvalidBundle);
    }
    drop(decoder);
    drop(snapshot);
    Ok(VerifiedBundle { directory })
}

#[cfg(all(test, unix, not(target_os = "ios")))]
mod tests;

#[cfg(all(test, any(windows, target_os = "ios")))]
mod unsupported_acl_tests {
    use super::*;
    #[test]
    fn model_storage_is_disabled_until_native_acl_validation_exists() {
        struct NoRead;
        impl Read for NoRead {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                panic!("unsupported storage must fail before accepting model bytes")
            }
        }
        assert!(matches!(
            VerifiedBundle::read_in(NoRead, &std::env::temp_dir()),
            Err(Error::Storage)
        ));
    }
}
