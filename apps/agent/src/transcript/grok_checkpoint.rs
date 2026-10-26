//! Opt-in raw Records consistency, independent of conversation reconstruction.
use super::{Error, Result, TranscriptPage};
use lazysh_common::record_checkpoint::RecordCheckpoint;
use std::path::Path;

pub fn read_page(
    path: &Path,
    offset: u64,
    limit: u8,
    checkpoint: Option<&str>,
) -> Result<TranscriptPage> {
    read_page_options(path, offset, limit, checkpoint, false)
}

pub(super) fn read_page_images(
    path: &Path,
    offset: u64,
    limit: u8,
    checkpoint: Option<&str>,
) -> Result<TranscriptPage> {
    read_page_options(path, offset, limit, checkpoint, true)
}

fn read_page_options(
    path: &Path,
    offset: u64,
    limit: u8,
    checkpoint: Option<&str>,
    inline_images: bool,
) -> Result<TranscriptPage> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    let receipt = checkpoint
        .map(|token| RecordCheckpoint::parse(token).ok_or(Error::InvalidArgument))
        .transpose()?;
    if receipt
        .as_ref()
        .map_or(offset != 0, |receipt| receipt.next_offset != offset)
    {
        return Err(Error::InvalidArgument);
    }
    #[cfg(unix)]
    return capture(path, offset, limit, receipt.as_ref(), inline_images, |_| {});
    #[cfg(not(unix))]
    {
        let _ = (path, receipt, inline_images);
        Err(Error::Device("TranscriptIdentityUnsupported"))
    }
}

#[cfg(unix)]
fn identity(path: &Path, metadata: &std::fs::Metadata) -> String {
    use sha2::{Digest, Sha256};
    use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
    let path = path.as_os_str().as_bytes();
    let mut hash = Sha256::new();
    hash.update(b"lazysh-grok-record-source-g1\0");
    hash.update((path.len() as u64).to_be_bytes());
    hash.update(path);
    hash.update(metadata.dev().to_be_bytes());
    hash.update(metadata.ino().to_be_bytes());
    format!("{:x}", hash.finalize())
}

#[cfg(unix)]
#[derive(Clone, Copy)]
enum CapturePoint {
    Opened,
    Read,
}

#[cfg(unix)]
fn capture(
    path: &Path,
    offset: u64,
    limit: u8,
    receipt: Option<&RecordCheckpoint>,
    inline_images: bool,
    mut observe: impl FnMut(CapturePoint),
) -> Result<TranscriptPage> {
    use sha2::{Digest, Sha256};
    let changed = || Error::Device("TranscriptChanged");
    let busy = || Error::Device("TranscriptBusy");
    let mut file = super::open_transcript(path)?;
    let before = file.metadata()?;
    let source = identity(path, &before);
    observe(CapturePoint::Opened);
    // Check the pathname against the opened handle before reading, not only
    // against a later pathname lookup: an early rename must not be adopted.
    let selected = super::open_transcript(path)
        .map_err(|_| changed())?
        .metadata()?;
    if identity(path, &selected) != source
        || selected.len() < before.len()
        || receipt.is_some_and(|old| old.source != source || old.observed_length > before.len())
    {
        return Err(changed());
    }
    if selected.len() != before.len() || selected.modified()? != before.modified()? {
        return Err(busy());
    }
    let bytes = super::snapshot::read_bytes(&mut file, before.len())?;
    observe(CapturePoint::Read);
    let handle_after = file.metadata()?;
    let selected_after = super::open_transcript(path)
        .map_err(|_| changed())?
        .metadata()?;
    if identity(path, &selected_after) != source {
        return Err(changed());
    }
    if [handle_after.len(), selected_after.len()]
        .iter()
        .any(|len| *len < before.len())
    {
        return Err(changed());
    }
    if bytes.len() as u64 != before.len()
        || handle_after.len() != before.len()
        || selected_after.len() != before.len()
        || handle_after.modified()? != before.modified()?
        || selected_after.modified()? != before.modified()?
    {
        return Err(busy());
    }
    if let Some(old) = receipt {
        if format!(
            "{:x}",
            Sha256::digest(&bytes[..old.observed_length as usize])
        ) != old.prefix
        {
            return Err(changed());
        }
    }
    if offset > bytes.len() as u64 || (offset > 0 && bytes[offset as usize - 1] != b'\n') {
        return Err(Error::InvalidArgument);
    }
    let mut page = super::read_records(
        &mut std::io::Cursor::new(&bytes[offset as usize..]),
        super::TranscriptAgent::GrokAcp,
        offset,
        bytes.len() as u64,
        limit,
        inline_images,
    )?;
    page.checkpoint = Some(
        RecordCheckpoint {
            source,
            next_offset: page.next_offset,
            observed_length: bytes.len() as u64,
            prefix: format!("{:x}", Sha256::digest(&bytes)),
        }
        .to_string(),
    );
    Ok(page)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, io::Write};

    #[test]
    fn capture_observes_rename_and_truncate_at_both_path_checks_and_append_is_busy() {
        for stage in [CapturePoint::Opened, CapturePoint::Read] {
            for mutation in ["rename", "truncate", "append"] {
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().join("selected");
                fs::write(&path, b"{}\n").unwrap();
                let initial = read_page(&path, 0, 1, None).unwrap();
                let receipt =
                    RecordCheckpoint::parse(initial.checkpoint.as_ref().unwrap()).unwrap();
                let result = capture(
                    &path,
                    initial.next_offset,
                    1,
                    Some(&receipt),
                    false,
                    |point| {
                        if std::mem::discriminant(&point) != std::mem::discriminant(&stage) {
                            return;
                        }
                        match mutation {
                            "rename" => {
                                fs::rename(&path, dir.path().join("original")).unwrap();
                                fs::write(&path, b"{}\n").unwrap();
                            }
                            "truncate" => fs::write(&path, b"").unwrap(),
                            _ => fs::OpenOptions::new()
                                .append(true)
                                .open(&path)
                                .unwrap()
                                .write_all(b"{}\n")
                                .unwrap(),
                        }
                    },
                );
                assert_eq!(
                    result.unwrap_err().class(),
                    if mutation == "append" {
                        "TranscriptBusy"
                    } else {
                        "TranscriptChanged"
                    },
                    "{mutation}"
                );
            }
        }
    }
}
