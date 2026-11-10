//! Enumerate a retained directory without resolving its pathname.
use std::{
    ffi::{CStr, OsString},
    fs::File,
    io,
    os::unix::ffi::OsStringExt,
};

pub(super) struct Entry {
    pub name: OsString,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
}

pub(super) struct Listing(*mut libc::DIR);
impl Listing {
    pub fn new(directory: &File) -> io::Result<Self> {
        crate::directory_listing::listing_stream(directory).map(Self)
    }
}
impl Drop for Listing {
    fn drop(&mut self) {
        // SAFETY: Listing owns this stream exactly once.
        unsafe {
            libc::closedir(self.0);
        }
    }
}
impl Iterator for Listing {
    type Item = io::Result<Entry>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0;
            }
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0;
            }
            // SAFETY: this stream is live and accessed only through &mut self.
            let item = unsafe { libc::readdir(self.0) };
            if item.is_null() {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(0) {
                    None
                } else {
                    Some(Err(error))
                };
            }
            // SAFETY: readdir supplies a NUL-terminated name until the next call.
            let name = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: stream and name remain live; stat is initialized on success.
            let result = unsafe {
                libc::fstatat(
                    libc::dirfd(self.0),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if result < 0 {
                return Some(Err(io::Error::last_os_error()));
            }
            let mode = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
            return Some(Ok(Entry {
                name: OsString::from_vec(name.to_bytes().to_vec()),
                is_dir: mode == libc::S_IFDIR,
                is_file: mode == libc::S_IFREG,
                is_symlink: mode == libc::S_IFLNK,
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_directory_listings_are_independent_after_rename() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("first"), "data").unwrap();
        std::os::unix::fs::symlink("first", root.join("link")).unwrap();
        let directory = File::open(&root).unwrap();
        let mut first = Listing::new(&directory).unwrap();
        std::fs::rename(&root, temp.path().join("moved")).unwrap();
        let second = Listing::new(&directory).unwrap();
        let one = first.next().unwrap().unwrap();
        let entries = second.collect::<io::Result<Vec<_>>>().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .any(|entry| entry.name == "first" && entry.is_file));
        assert!(entries
            .iter()
            .any(|entry| entry.name == "link" && entry.is_symlink));
        assert_ne!(one.name, first.next().unwrap().unwrap().name);
        assert!(first.next().is_none());
    }
}
