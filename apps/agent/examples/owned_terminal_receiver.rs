//! Owned Linux PTY receiver for native interoperability tests, never a provider.
#[cfg(target_os = "linux")]
mod receiver {
    use std::{
        ffi::OsString,
        fs::{self, File},
        io::{self, Read, Write},
        os::fd::AsRawFd,
        path::{Path, PathBuf},
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
        nonce: Option<&str>,
        terminal: &mut impl Write,
    ) -> io::Result<()> {
        let mut total = 0;
        let expected = nonce.map(|nonce| format!("there\x7f\x7ftheowned-current-{nonce}"));
        let mut observed = Vec::new();
        let mut acknowledged = false;
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
            if let (Some(nonce), Some(expected)) = (nonce, expected.as_ref()) {
                observed.extend_from_slice(&bytes[..count]);
                if !acknowledged && observed == expected.as_bytes() {
                    output.flush()?;
                    writeln!(terminal, "IME_{nonce}_DELIVERED\r")?;
                    terminal.flush()?;
                    acknowledged = true;
                }
            }
        }
    }
    fn ready(output: &mut impl Write, nonce: Option<&str>) -> io::Result<()> {
        if let Some(nonce) = nonce {
            writeln!(output, "IME_{nonce}_READY\r")?;
            output.flush()?;
        }
        Ok(())
    }
    pub(super) fn arguments(
        mut args: impl Iterator<Item = OsString>,
    ) -> Option<(PathBuf, Option<String>)> {
        let directory = PathBuf::from(args.next()?);
        let nonce = match args.next() {
            None => None,
            Some(flag) if flag == "--ime-transactions" => {
                let nonce = args.next()?.into_string().ok()?;
                if nonce.len() != 32
                    || !nonce
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return None;
                }
                Some(nonce)
            }
            _ => return None,
        };
        if args.next().is_some() {
            return None;
        }
        Some((directory, nonce))
    }
    pub(super) fn run(directory: &Path, nonce: Option<&str>) -> io::Result<()> {
        let mut bytes = output(directory, "received-bytes")?;
        let mut input = io::stdin().lock();
        let _mode = RawMode::new(input.as_raw_fd())?;
        let mut pid = output(directory, "receiver-pid")?;
        writeln!(pid, "{}", std::process::id())?;
        let mut terminal = io::stdout().lock();
        ready(&mut terminal, nonce)?;
        copy_bounded(&mut input, &mut bytes, LIMIT, nonce, &mut terminal)
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
        fn optional_ready_banner_preserves_default_silence() {
            let mut bytes = Vec::new();
            ready(&mut bytes, None).unwrap();
            assert!(bytes.is_empty());
            ready(&mut bytes, Some("0123456789abcdef0123456789abcdef")).unwrap();
            assert_eq!(bytes, b"IME_0123456789abcdef0123456789abcdef_READY\r\n");
        }

        #[test]
        fn closed_ime_arguments_reject_invalid_flags_and_nonces_before_outputs() {
            let parse = |values: &[&str]| arguments(values.iter().map(OsString::from));
            assert_eq!(parse(&["private"]).unwrap().1, None);
            assert!(parse(&[
                "private",
                "--ime-transactions",
                "0123456789abcdef0123456789abcdef"
            ])
            .is_some());
            for values in [
                vec![],
                vec!["private", "--ready"],
                vec!["private", "--ime-transactions"],
                vec!["private", "--ime-transactions", "short"],
                vec![
                    "private",
                    "--ime-transactions",
                    "A123456789abcdef0123456789abcdef",
                ],
                vec![
                    "private",
                    "--ime-transactions",
                    "0123456789abcdef0123456789abcdef",
                    "extra",
                ],
            ] {
                assert!(parse(&values).is_none());
            }
        }

        #[test]
        fn delivery_ack_requires_the_exact_written_wire_and_never_normalizes_extra_bytes() {
            let nonce = "0123456789abcdef0123456789abcdef";
            let expected = format!("there\x7f\x7ftheowned-current-{nonce}").into_bytes();
            let ack = format!("IME_{nonce}_DELIVERED\r\n").into_bytes();
            let mut stored = Vec::new();
            let mut terminal = Vec::new();
            copy_bounded(
                &mut Cursor::new(&expected),
                &mut stored,
                LIMIT,
                Some(nonce),
                &mut terminal,
            )
            .unwrap();
            assert_eq!(stored, expected);
            assert_eq!(terminal, ack);
            for input in [b"thethe".to_vec(), [expected.as_slice(), b"extra"].concat()] {
                stored.clear();
                terminal.clear();
                copy_bounded(
                    &mut Cursor::new(&input),
                    &mut stored,
                    LIMIT,
                    Some(nonce),
                    &mut terminal,
                )
                .unwrap();
                assert_eq!(stored, input);
                assert!(terminal.is_empty());
            }
            stored.clear();
            terminal.clear();
            copy_bounded(
                &mut Cursor::new(&expected).chain(Cursor::new(b"extra")),
                &mut stored,
                LIMIT,
                Some(nonce),
                &mut terminal,
            )
            .unwrap();
            assert_eq!(terminal, ack);
            assert_eq!(stored, [expected.as_slice(), b"extra"].concat());
        }

        #[test]
        fn failed_receiver_flush_never_acknowledges_delivery() {
            struct Unflushed;
            impl Write for Unflushed {
                fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                    Ok(bytes.len())
                }
                fn flush(&mut self) -> io::Result<()> {
                    Err(io::Error::other("owned flush failure"))
                }
            }
            let nonce = "0123456789abcdef0123456789abcdef";
            let mut terminal = Vec::new();
            let input = format!("there\x7f\x7ftheowned-current-{nonce}");
            assert!(copy_bounded(
                &mut Cursor::new(input),
                &mut Unflushed,
                LIMIT,
                Some(nonce),
                &mut terminal
            )
            .is_err());
            assert!(terminal.is_empty());
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
            copy_bounded(
                &mut Cursor::new(b"abc"),
                &mut result,
                3,
                None,
                &mut Vec::new(),
            )
            .unwrap();
            assert_eq!(result, b"abc");
            assert!(copy_bounded(
                &mut Cursor::new(b"abcd"),
                &mut Vec::new(),
                3,
                None,
                &mut Vec::new()
            )
            .is_err());
        }
    }
}
fn main() {
    #[cfg(target_os = "linux")]
    {
        let success = match receiver::arguments(std::env::args_os().skip(1)) {
            Some((directory, nonce)) => receiver::run(&directory, nonce.as_deref()).is_ok(),
            None => false,
        };
        if success {
            return;
        }
    }
    eprintln!("Owned terminal receiver failed");
    std::process::exit(1);
}
