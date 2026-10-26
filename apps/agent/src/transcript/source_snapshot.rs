use super::{Error, Result};
use std::{
    fs::{File, Metadata},
    io,
    time::SystemTime,
};

pub(crate) struct SourceSnapshot {
    metadata: Metadata,
    // Keep the original object alive while consumed readers and pathname checks finish.
    _source: File,
}

impl SourceSnapshot {
    pub(crate) fn capture(file: &File) -> Result<Self> {
        Ok(Self {
            metadata: file.metadata()?,
            _source: file.try_clone()?,
        })
    }
    pub(crate) fn len(&self) -> u64 {
        self.metadata.len()
    }
    pub(crate) fn modified(&self) -> io::Result<SystemTime> {
        self.metadata.modified()
    }
    pub(crate) fn same_file(&self, selected: &File) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let after = selected.metadata()?;
            if self.metadata.dev() != after.dev() || self.metadata.ino() != after.ino() {
                return Err(Error::InvalidEvent);
            }
            Ok(())
        }
        #[cfg(windows)]
        {
            if identity(&self._source)? != identity(selected)? {
                return Err(Error::InvalidEvent);
            }
            Ok(())
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = selected;
            Err(Error::Device("TranscriptIdentityUnsupported"))
        }
    }
}

#[cfg(windows)]
fn identity(file: &File) -> io::Result<(u64, [u8; 16])> {
    use std::{
        mem::{size_of, MaybeUninit},
        os::windows::io::AsRawHandle,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };
    let mut info = MaybeUninit::<FILE_ID_INFO>::uninit();
    // The live File owns the handle; the API writes exactly this FILE_ID_INFO on success.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok((info.VolumeSerialNumber, info.FileId.Identifier))
}

#[cfg(all(test, any(unix, windows)))]
mod tests {
    use super::*;

    #[test]
    fn retained_source_rejects_same_content_size_and_mtime_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected.jsonl");
        std::fs::write(&path, b"same content\n").unwrap();
        let file = super::super::open_transcript(&path).unwrap();
        let before = SourceSnapshot::capture(&file).unwrap();
        let modified = before.modified().unwrap();
        drop(file);
        std::fs::rename(&path, directory.path().join("retained.jsonl")).unwrap();
        std::fs::write(&path, b"same content\n").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let replacement = super::super::open_transcript(&path).unwrap();
        assert_eq!(replacement.metadata().unwrap().len(), before.len());
        assert_eq!(
            replacement.metadata().unwrap().modified().unwrap(),
            modified
        );
        assert!(before.same_file(&replacement).is_err());
        assert!(before.same_file(&before._source).is_ok());
    }
}
