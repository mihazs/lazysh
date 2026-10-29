//! Owned Linux PTY receiver for native interoperability tests, never a provider.
#[cfg(target_os = "linux")]
mod receiver {
    use std::{
        fs::{self, File},
        io::{self, Read, Write},
        os::fd::AsRawFd,
        path::Path,
    };
    const LIMIT: usize = 16 * 1024;

    struct RawMode {
        fd: i32,
        original: libc::termios,
    }
    impl RawMode {
        fn new(fd: i32) -> io::Result<Self> {
            let mut original = std::mem::MaybeUninit::uninit();
            if unsafe { libc::tcgetattr(fd, original.as_mut_ptr()) } != 0 {
                return Err(io::Error::last_os_error());
            }
            let original = unsafe { original.assume_init() };
            let mut raw = original;
            unsafe {
                libc::cfmakeraw(&mut raw);
            }
            if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { fd, original })
        }
    }
    impl Drop for RawMode {
        fn drop(&mut self) {
            unsafe {
                libc::tcsetattr(self.fd, libc::TCSANOW, &self.original);
            }
        }
    }

    fn output(directory: &Path, name: &str) -> io::Result<File> {
        let path = lazysh_common::storage_namespace::resolve(directory)?;
        if !lazysh_common::fs::owner_only(&fs::symlink_metadata(&path)?, true) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private fixture directory required",
            ));
        }
        lazysh_common::fs::private_create_new().open(path.join(name))
    }
    fn copy_bounded(
        input: &mut impl Read,
        output: &mut impl Write,
        limit: usize,
    ) -> io::Result<()> {
        let mut total = 0;
        let mut bytes = [0; 512];
        loop {
            let count = input.read(&mut bytes)?;
            if count == 0 {
                return Ok(());
            }
            total += count;
            if total > limit {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "receiver byte bound exceeded",
                ));
            }
            output.write_all(&bytes[..count])?;
        }
    }
    pub(super) fn run(directory: &Path) -> io::Result<()> {
        let mut bytes = output(directory, "received-bytes")?;
        let mut input = io::stdin().lock();
        let _mode = RawMode::new(input.as_raw_fd())?;
        let mut pid = output(directory, "receiver-pid")?;
        writeln!(pid, "{}", std::process::id())?;
        copy_bounded(&mut input, &mut bytes, LIMIT)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            io::Cursor,
            os::fd::FromRawFd,
            time::{Duration, Instant},
        };

        #[test]
        fn raw_owned_pty_preserves_lf_tab_cr_escape_and_utf8_without_echo() {
            let (mut master, mut slave) = (-1, -1);
            assert_eq!(
                unsafe {
                    libc::openpty(
                        &mut master,
                        &mut slave,
                        std::ptr::null_mut(),
                        std::ptr::null(),
                        std::ptr::null(),
                    )
                },
                0
            );
            let mut master = unsafe { File::from_raw_fd(master) };
            let mut slave = unsafe { File::from_raw_fd(slave) };
            let mode = RawMode::new(slave.as_raw_fd()).unwrap();
            let flags = unsafe { libc::fcntl(slave.as_raw_fd(), libc::F_GETFL) };
            assert!(flags >= 0);
            assert_eq!(
                unsafe { libc::fcntl(slave.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) },
                0
            );
            let expected = "世界\n\t\r\u{1b}".as_bytes();
            master.write_all(expected).unwrap();
            let deadline = Instant::now() + Duration::from_secs(1);
            let mut received = Vec::new();
            while received.len() < expected.len() {
                assert!(Instant::now() < deadline, "owned PTY input deadline");
                let mut descriptor = libc::pollfd {
                    fd: slave.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let left = deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis()
                    .min(1000) as i32;
                assert!(unsafe { libc::poll(&mut descriptor, 1, left.max(1)) } > 0);
                let mut bytes = [0; 512];
                match slave.read(&mut bytes) {
                    Ok(count) => {
                        assert!(count > 0);
                        received.extend_from_slice(&bytes[..count]);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                    Err(error) => panic!("owned PTY read failed: {}", error.kind()),
                }
            }
            assert_eq!(received, expected);
            let mut echo = libc::pollfd {
                fd: master.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            assert_eq!(
                unsafe { libc::poll(&mut echo, 1, 0) },
                0,
                "raw input unexpectedly echoed"
            );
            drop(mode);
        }

        #[test]
        fn fixed_private_outputs_never_overwrite_and_copy_is_bounded() {
            let temporary = tempfile::tempdir().unwrap();
            let directory = temporary.path().join("private");
            lazysh_common::fs::private_directory(&directory).unwrap();
            let file = output(&directory, "received-bytes").unwrap();
            assert!(lazysh_common::fs::owner_only(
                &file.metadata().unwrap(),
                false
            ));
            assert_eq!(
                output(&directory, "received-bytes").unwrap_err().kind(),
                io::ErrorKind::AlreadyExists
            );
            let mut result = Vec::new();
            copy_bounded(&mut Cursor::new(b"abc"), &mut result, 3).unwrap();
            assert_eq!(result, b"abc");
            assert!(copy_bounded(&mut Cursor::new(b"abcd"), &mut Vec::new(), 3).is_err());
        }
    }
}
fn main() {
    #[cfg(target_os = "linux")]
    {
        let mut args = std::env::args_os().skip(1);
        let directory = args.next();
        let success = match directory {
            Some(directory) if args.next().is_none() => {
                receiver::run(std::path::Path::new(&directory)).is_ok()
            }
            _ => false,
        };
        if success {
            return;
        }
    }
    eprintln!("Owned terminal receiver failed");
    std::process::exit(1);
}
