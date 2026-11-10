use std::{fs::File, io, os::fd::AsRawFd};

/// Open an independently positioned stream; the caller must close it with closedir.
pub(crate) fn listing_stream(directory: &File) -> io::Result<*mut libc::DIR> {
    // SAFETY: the retained descriptor is live and the literal is NUL terminated.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fdopendir takes ownership only on success.
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(fd);
        }
        return Err(error);
    }
    Ok(stream)
}
