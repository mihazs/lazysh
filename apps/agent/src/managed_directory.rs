//! Retained, no-follow directories for explicit companion installations.
use crate::{Error, Result};
use lazysh_common::{fs as private, storage_namespace};
use std::{
    ffi::{CString, OsStr},
    fs::File,
    io,
    os::unix::{
        ffi::OsStrExt,
        fs::MetadataExt,
        io::{AsRawFd, FromRawFd},
    },
    path::{Component, Path, PathBuf},
};

pub(crate) struct Directory {
    pub(crate) file: File,
    pub(crate) path: PathBuf,
    private: bool,
}
fn denied(kind: &'static str) -> Error {
    Error::Installation(kind)
}
fn name(value: &OsStr) -> io::Result<CString> {
    if Path::new(value).components().count() != 1
        || !matches!(
            Path::new(value).components().next(),
            Some(Component::Normal(_))
        )
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    CString::new(value.as_bytes()).map_err(io::Error::other)
}
impl Directory {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        Self::walk(path, true)
    }
    pub(crate) fn profile(path: &Path) -> Result<Self> {
        Self::walk(path, false)
    }
    fn walk(path: &Path, private_leaf: bool) -> Result<Self> {
        let path = storage_namespace::resolve(path)?;
        let mut current = File::open("/")?;
        let parts = path.components().collect::<Vec<_>>();
        for (index, part) in parts.iter().enumerate() {
            let Component::Normal(part) = part else {
                continue;
            };
            let part = name(part)?;
            // SAFETY: each component is opened relative to an owned descriptor; links never resolve.
            let fd = unsafe {
                libc::openat(
                    current.as_raw_fd(),
                    part.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error().into());
            }
            // SAFETY: successful openat transfers a new descriptor.
            current = unsafe { File::from_raw_fd(fd) };
            let metadata = current.metadata()?;
            let uid = unsafe { libc::geteuid() };
            let leaf = index + 1 == parts.len();
            let sticky_root = metadata.uid() == 0 && metadata.mode() & 0o1000 != 0;
            if (leaf && metadata.uid() != uid)
                || (!leaf && metadata.uid() != uid && metadata.uid() != 0)
                || (metadata.mode() & 0o022 != 0 && (leaf || !sticky_root))
            {
                return Err(denied("InstallUnsafeNamespace"));
            }
        }
        Self::from_file(current, path, private_leaf)
    }
    fn from_file(file: File, path: PathBuf, private_leaf: bool) -> Result<Self> {
        let metadata = file.metadata()?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o022 != 0
            || (private_leaf && !private::owner_only(&metadata, true))
        {
            return Err(denied("InstallUnsafeNamespace"));
        }
        Ok(Self {
            file,
            path,
            private: private_leaf,
        })
    }
    pub(crate) fn identity(&self) -> Result<[u64; 2]> {
        let metadata = self.file.metadata()?;
        Ok([metadata.dev(), metadata.ino()])
    }
    pub(crate) fn check(&self) -> Result<()> {
        let current = Self::walk(&self.path, self.private)?;
        if current.identity()? != self.identity()? {
            return Err(denied("InstallChangedNamespace"));
        }
        Ok(())
    }
    pub(crate) fn child(&self, basename: &str, private_leaf: bool) -> Result<Self> {
        let file = self.open_file(basename, libc::O_RDONLY | libc::O_DIRECTORY)?;
        Self::from_file(file, self.path.join(basename), private_leaf)
    }
    pub(crate) fn open_file(&self, basename: &str, flags: i32) -> io::Result<File> {
        let basename = name(OsStr::new(basename))?;
        // SAFETY: retained descriptor and a checked single component; never follows a link or FIFO.
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                basename.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful openat returns a newly owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub(crate) fn mkdir(&self, basename: &str) -> io::Result<()> {
        let basename = name(OsStr::new(basename))?;
        // SAFETY: a checked child of the retained directory.
        if unsafe { libc::mkdirat(self.file.as_raw_fd(), basename.as_ptr(), 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub(crate) fn rename(
        &self,
        source: &str,
        destination: &str,
        exclusive: bool,
    ) -> io::Result<()> {
        let source = name(OsStr::new(source))?;
        let destination = name(OsStr::new(destination))?;
        let fd = self.file.as_raw_fd();
        // SAFETY: both checked names are within the retained directory.
        let result = unsafe {
            if !exclusive {
                libc::renameat(fd, source.as_ptr(), fd, destination.as_ptr())
            } else {
                #[cfg(target_os = "linux")]
                {
                    libc::syscall(
                        libc::SYS_renameat2,
                        fd,
                        source.as_ptr(),
                        fd,
                        destination.as_ptr(),
                        libc::RENAME_NOREPLACE,
                    ) as i32
                }
                #[cfg(target_os = "macos")]
                {
                    libc::renameatx_np(
                        fd,
                        source.as_ptr(),
                        fd,
                        destination.as_ptr(),
                        libc::RENAME_EXCL,
                    )
                }
            }
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub(crate) fn remove(&self, basename: &str, directory: bool) -> io::Result<()> {
        let basename = name(OsStr::new(basename))?;
        // SAFETY: unlink never follows the checked child name.
        if unsafe {
            libc::unlinkat(
                self.file.as_raw_fd(),
                basename.as_ptr(),
                if directory { libc::AT_REMOVEDIR } else { 0 },
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
