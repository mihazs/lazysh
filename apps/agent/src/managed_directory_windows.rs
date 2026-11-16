//! Retained, reparse-free directories for explicit companion installations on Windows (NTFS only).
//!
//! A directory is held by a handle that denies rename and deletion, so while it is held neither it nor any
//! ancestor can be moved or replaced by a link. Children are opened by name below that path with
//! `FILE_FLAG_OPEN_REPARSE_POINT`, so a symbolic link or junction is seen as itself and never followed.
use crate::{Error, Result};
use lazysh_common::{
    storage_namespace,
    windows_acl::{self, Need},
};
use std::{
    ffi::{c_void, OsString},
    fs::File,
    io,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{
        LocalFree, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS,
        ERROR_SHARING_VIOLATION, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    },
    Security::{
        Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SetSecurityInfo,
            SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        GetSecurityDescriptorControl, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        SE_DACL_PROTECTED, UNPROTECTED_DACL_SECURITY_INFORMATION,
    },
    Storage::FileSystem::{
        CreateFileW, FileBasicInfo, FileRenameInfoEx, GetFileInformationByHandle,
        GetFileInformationByHandleEx, GetFinalPathNameByHandleW, GetLongPathNameW,
        GetVolumeInformationByHandleW, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        CREATE_NEW, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS, OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
    },
};

/// How a child is opened. Plain constants, so callers read the same on every platform.
pub(crate) mod open {
    /// An existing file, for reading.
    pub const READ: u32 = 0;
    /// Only the metadata of the entry itself, never its contents and never through a link.
    pub const ENTRY: u32 = 1;
    /// A new file that only the current user, the system and the administrators can access.
    pub const CREATE_NEW: u32 = 2;
    /// The lock file: created private when absent.
    pub const LOCK: u32 = 3;
}

pub(crate) struct Directory {
    pub(crate) file: File,
    pub(crate) path: PathBuf,
    private: bool,
    root_leaf: bool,
}
/// What the handle reports about an object: enough to tell it from a replacement.
pub(crate) struct Info {
    pub(crate) volume: u64,
    pub(crate) index: u64,
    pub(crate) links: u64,
    pub(crate) bytes: u64,
    pub(crate) attributes: u32,
    /// 100 ns ticks since 1601 for the last write and for the last change of data, attributes or ACL.
    pub(crate) written: i64,
    pub(crate) changed: i64,
}
fn denied(kind: &'static str) -> Error {
    Error::Installation(kind)
}
/// The extended-length form, so a path over `MAX_PATH` opens and no `.` or trailing-dot spelling is rewritten.
fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return Err(io::ErrorKind::InvalidInput.into());
    };
    let text = match prefix.kind() {
        Prefix::Disk(_) => {
            let mut text = OsString::from(r"\\?\");
            text.push(path);
            text
        }
        Prefix::VerbatimDisk(_) => path.as_os_str().to_owned(),
        _ => return Err(io::ErrorKind::InvalidInput.into()),
    };
    let wide: Vec<u16> = text.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(wide.into_iter().chain(Some(0)).collect())
}
fn text(wide: &[u16]) -> io::Result<PathBuf> {
    let text = OsString::from_wide(wide);
    let text = text.to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    // A network path is never a local namespace.
    if text.starts_with(r"UNC\") {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(PathBuf::from(text))
}
/// One component of a name below a retained directory: no stream, device, wildcard or Win32 alias.
fn unsafe_component(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return true;
    };
    const DEVICES: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or_default().trim_end();
    name.is_empty()
        || name.ends_with(['.', ' '])
        || name.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
        || name.chars().any(char::is_control)
        || DEVICES
            .iter()
            .any(|device| stem.eq_ignore_ascii_case(device))
}
fn name(value: &str) -> io::Result<()> {
    if unsafe_component(std::ffi::OsStr::new(value)) || value == "." || value == ".." {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}
/// A DACL that grants the current user, the system and the administrators full control and nobody else.
struct Private(PSECURITY_DESCRIPTOR);
impl Private {
    fn new() -> io::Result<Self> {
        let sddl = format!(
            "D:P(A;;FA;;;{})(A;;FA;;;SY)(A;;FA;;;BA)",
            windows_acl::current_user()?
        );
        let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = ptr::null_mut();
        // SAFETY: a NUL-terminated string and an out-pointer; the returned descriptor is freed by `Drop`.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }
}
impl Drop for Private {
    fn drop(&mut self) {
        // SAFETY: allocated by the conversion above.
        unsafe { LocalFree(self.0) };
    }
}
fn create(
    path: &Path,
    access: u32,
    share: u32,
    disposition: u32,
    flags: u32,
    private: Option<&Private>,
) -> io::Result<File> {
    let path = wide(path)?;
    let attributes = private.map(|private| SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: private.0,
        bInheritHandle: 0,
    });
    // SAFETY: a NUL-terminated extended-length path; the attributes outlive the call.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            share,
            attributes
                .as_ref()
                .map_or(ptr::null(), |attributes| attributes as *const _),
            disposition,
            flags | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful CreateFileW returns a newly owned handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}
pub(crate) fn info(file: &File) -> io::Result<Info> {
    let handle = file.as_raw_handle() as HANDLE;
    // SAFETY: zero is a valid bit pattern for these plain structs and the handle is open.
    let (mut by_handle, mut basic) = unsafe {
        (
            std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>(),
            std::mem::zeroed::<FILE_BASIC_INFO>(),
        )
    };
    // SAFETY: out-structs of the exact size and an open handle.
    if unsafe { GetFileInformationByHandle(handle, &mut by_handle) } == 0
        || unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Info {
        volume: u64::from(by_handle.dwVolumeSerialNumber),
        index: u64::from(by_handle.nFileIndexHigh) << 32 | u64::from(by_handle.nFileIndexLow),
        links: u64::from(by_handle.nNumberOfLinks),
        bytes: u64::from(by_handle.nFileSizeHigh) << 32 | u64::from(by_handle.nFileSizeLow),
        attributes: by_handle.dwFileAttributes,
        written: basic.LastWriteTime,
        changed: basic.ChangeTime,
    })
}
impl Info {
    pub(crate) fn is_reparse_point(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    pub(crate) fn is_read_only(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_READONLY != 0
    }
}
/// Runs a Win32 call that fills a UTF-16 buffer and returns the length it needs, until the buffer is big enough.
fn fill(mut call: impl FnMut(*mut u16, u32) -> u32) -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 512];
    loop {
        let length = call(buffer.as_mut_ptr(), buffer.len() as u32) as usize;
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length < buffer.len() {
            return text(&buffer[..length]);
        }
        buffer.resize(length + 1, 0);
    }
}
/// Where the open handle actually lives, with the extended-length prefix removed.
fn final_path(file: &File) -> io::Result<PathBuf> {
    let handle = file.as_raw_handle() as HANDLE;
    // SAFETY: `fill` passes the length of the buffer it owns.
    fill(|buffer, size| unsafe { GetFinalPathNameByHandleW(handle, buffer, size, 0) })
}
/// The path with its short (8.3) names expanded, the spelling `final_path` reports.
fn long_path(path: &Path) -> io::Result<PathBuf> {
    let source = wide(path)?;
    // SAFETY: NUL-terminated input; `fill` passes the length of the buffer it owns.
    fill(|buffer, size| unsafe { GetLongPathNameW(source.as_ptr(), buffer, size) })
}
fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
}
/// The only volume format whose file identity, ACLs and rename semantics the tests exercise.
fn require_ntfs(file: &File) -> Result<()> {
    let mut name = [0u16; 32];
    // SAFETY: the name buffer length is passed with the buffer; the other outputs are not requested.
    let ok = unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle() as HANDLE,
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    };
    let length = name
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(name.len());
    if ok == 0 || String::from_utf16_lossy(&name[..length]) != "NTFS" {
        return Err(denied("HooksAclUnsupported"));
    }
    Ok(())
}
/// Admits the object behind `file` by owner SID and DACL, for the current user.
pub(crate) fn admit(file: &File, need: Need) -> Result<()> {
    // A refusal carries no OS error code; an ACL that cannot be read does, and is refused as unsupported.
    windows_acl::admit_path(&final_path(file)?, need).map_err(|error| {
        if error.kind() == io::ErrorKind::PermissionDenied && error.raw_os_error().is_none() {
            denied("HooksUnhandledAcl")
        } else {
            denied("HooksAclUnsupported")
        }
    })
}
impl Directory {
    pub(crate) fn profile(path: &Path) -> Result<Self> {
        Self::walk(path, false, false)
    }
    /// A read-only executable parent: the physical absolute namespace, never a link.
    pub(crate) fn executable_parent(path: &Path) -> Result<Self> {
        Self::walk(path, false, true)
    }
    fn walk(path: &Path, private_leaf: bool, root_leaf: bool) -> Result<Self> {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(denied("InstallUnsafeNamespace"));
        }
        if path
            .components()
            .any(|part| matches!(part, Component::Normal(part) if unsafe_component(part)))
        {
            return Err(denied("InstallUnsafeNamespace"));
        }
        // Refuses a symbolic link, junction or other reparse point in every component.
        let path = storage_namespace::resolve(path).map_err(|error| match error.kind() {
            io::ErrorKind::InvalidInput | io::ErrorKind::PermissionDenied => {
                denied("InstallUnsafeNamespace")
            }
            _ => Error::Io(error),
        })?;
        let file = open_directory(&path)?;
        // The handle may live elsewhere only if a component was swapped for a link after the walk.
        let actual = final_path(&file)?;
        if !same_path(&actual, &long_path(&path)?) {
            return Err(denied("InstallChangedNamespace"));
        }
        Self::from_file(file, actual, private_leaf, root_leaf)
    }
    fn from_file(file: File, path: PathBuf, private: bool, root_leaf: bool) -> Result<Self> {
        let info = info(&file)?;
        if info.attributes & FILE_ATTRIBUTE_DIRECTORY == 0 || info.is_reparse_point() {
            return Err(denied("InstallUnsafeNamespace"));
        }
        require_ntfs(&file)?;
        admit(
            &file,
            if private {
                Need::Private
            } else {
                Need::NoForeignChange
            },
        )
        .map_err(|_| denied("InstallUnsafeNamespace"))?;
        Ok(Self {
            file,
            path,
            private,
            root_leaf,
        })
    }
    pub(crate) fn identity(&self) -> Result<[u64; 2]> {
        let info = info(&self.file)?;
        Ok([info.volume, info.index])
    }
    pub(crate) fn check(&self) -> Result<()> {
        let current = Self::walk(&self.path, self.private, self.root_leaf)?;
        (current.identity()? == self.identity()?)
            .then_some(())
            .ok_or_else(|| denied("InstallChangedNamespace"))
    }
    pub(crate) fn child(&self, basename: &str, private_leaf: bool) -> Result<Self> {
        name(basename)?;
        let path = self.path.join(basename);
        let file = open_directory(&path)?;
        if !same_path(&final_path(&file)?, &path) {
            return Err(denied("InstallChangedNamespace"));
        }
        Self::from_file(file, path, private_leaf, false)
    }
    pub(crate) fn open_file(&self, basename: &str, mode: u32) -> io::Result<File> {
        name(basename)?;
        let path = self.path.join(basename);
        let private = Private::new;
        match mode {
            open::READ => create(
                &path,
                GENERIC_READ | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                OPEN_EXISTING,
                0,
                None,
            ),
            open::ENTRY => create(
                &path,
                FILE_READ_ATTRIBUTES | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                OPEN_EXISTING,
                0,
                None,
            ),
            // The stage's name may be renamed or removed while this handle is open: that is how it is published
            // and how an abandoned one is cleaned up.
            open::CREATE_NEW => create(
                &path,
                GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                CREATE_NEW,
                0,
                Some(&private()?),
            ),
            _ => create(
                &path,
                GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                OPEN_ALWAYS,
                0,
                Some(&private()?),
            ),
        }
    }
    pub(crate) fn mkdir(&self, basename: &str) -> io::Result<()> {
        name(basename)?;
        std::fs::create_dir(self.path.join(basename))
    }
    /// Renames within this directory. An exclusive rename never replaces an existing name; a replacing one
    /// keeps the target's name while the open staged file takes its place.
    pub(crate) fn rename(
        &self,
        source: &str,
        destination: &str,
        exclusive: bool,
    ) -> io::Result<()> {
        name(source)?;
        name(destination)?;
        let file = create(
            &self.path.join(source),
            DELETE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            0,
            None,
        )?;
        let target = wide(&self.path.join(destination))?;
        let header = std::mem::size_of::<FILE_RENAME_INFO>();
        // u64 elements keep the buffer aligned for the structure it starts with.
        let mut buffer = vec![0u64; (header + target.len() * 2).div_ceil(8)];
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // SAFETY: the buffer holds the header and the whole name; the name is copied after the struct's own
        // one-unit placeholder, whose size is part of `header`.
        unsafe {
            // FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS, so a replaced file that a
            // scanner still holds open does not fail the rename.
            (*info).Anonymous.Flags = if exclusive { 0 } else { 0x1 | 0x2 };
            (*info).FileNameLength = ((target.len() - 1) * 2) as u32;
            ptr::copy_nonoverlapping(
                target.as_ptr(),
                ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
                target.len(),
            );
        }
        let mut attempts = 0;
        loop {
            // SAFETY: an open handle with DELETE access and a buffer of the stated length.
            let renamed = unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle() as HANDLE,
                    FileRenameInfoEx,
                    info.cast::<c_void>(),
                    (header + target.len() * 2) as u32,
                )
            };
            if renamed != 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            let code = error.raw_os_error().unwrap_or_default() as u32;
            if matches!(code, ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS) {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            // A virus scanner or indexer may hold the target open for a moment.
            if !exclusive
                && matches!(code, ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION)
                && attempts < 5
            {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
            return Err(error);
        }
    }
    pub(crate) fn remove(&self, basename: &str, directory: bool) -> io::Result<()> {
        name(basename)?;
        let path = self.path.join(basename);
        if directory {
            std::fs::remove_dir(path)
        } else {
            std::fs::remove_file(path)
        }
    }
    /// Windows offers no durability barrier on a directory handle; the journal orders the rename.
    pub(crate) fn sync(&self) -> io::Result<()> {
        Ok(())
    }
}
fn open_directory(path: &Path) -> Result<File> {
    // Denying delete and rename pins the path for as long as the handle lives.
    let file = create(
        path,
        GENERIC_READ | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        None,
    )?;
    Ok(file)
}
/// Gives `target` the DACL of `source`, with its protection, so a replaced file keeps the access it had.
pub(crate) fn copy_dacl(source: &File, target: &File) -> io::Result<()> {
    let mut dacl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: an open handle and out-pointers; `descriptor` owns the memory `dacl` points into.
    let status = unsafe {
        GetSecurityInfo(
            source.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let (mut control, mut revision) = (0u16, 0u32);
    // SAFETY: the descriptor was just returned and the out-values are plain integers.
    let result =
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            let protection = if control & SE_DACL_PROTECTED != 0 {
                PROTECTED_DACL_SECURITY_INFORMATION
            } else {
                UNPROTECTED_DACL_SECURITY_INFORMATION
            };
            // SAFETY: an open handle with WRITE_DAC and a DACL that `descriptor` keeps alive.
            let status = unsafe {
                SetSecurityInfo(
                    target.as_raw_handle() as HANDLE,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | protection,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    dacl,
                    ptr::null_mut(),
                )
            };
            if status == 0 {
                Ok(())
            } else {
                Err(io::Error::from_raw_os_error(status as i32))
            }
        };
    // SAFETY: allocated by GetSecurityInfo.
    unsafe { LocalFree(descriptor) };
    result
}
