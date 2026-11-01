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
    fn dpad_read(bytes: &[u8], nonce: &str) -> Option<([usize; 4], bool)> {
        let mut counts = [0; 4];
        let mut offset = 0;
        for (index, arrow) in [b"\x1b[A", b"\x1b[D", b"\x1b[B", b"\x1b[C"]
            .iter()
            .enumerate()
        {
            while bytes[offset..].starts_with(*arrow) {
                counts[index] += 1;
                if counts[index] > 32 {
                    return None;
                }
                offset += arrow.len();
            }
            let remaining = &bytes[offset..];
            if remaining.is_empty()
                || (remaining.len() < arrow.len() && arrow.starts_with(remaining))
            {
                return Some((counts, false));
            }
            if counts[index] < if index == 0 { 3 } else { 2 } {
                return None;
            }
        }
        let marker = format!("owned-dpad-{nonce}");
        let remaining = &bytes[offset..];
        if !marker.as_bytes().starts_with(remaining) {
            return None;
        }
        Some((counts, remaining == marker.as_bytes()))
    }

    fn copy_bounded(
        input: &mut impl Read,
        output: &mut impl Write,
        limit: usize,
        nonce: Option<&str>,
        dpad: bool,
        terminal: &mut impl Write,
    ) -> io::Result<()> {
        let mut total = 0;
        let expected = nonce.map(|nonce| format!("there\x7f\x7ftheowned-current-{nonce}"));
        let mut observed = Vec::new();
        let mut acknowledged = false;
        let mut announced = [0; 4];
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
            // D-pad state follows each complete written arrow, including when
            // the TTY groups several arrows into one read. Legacy/IME chunks stay unchanged.
            for part in bytes[..count].chunks(if dpad { 1 } else { count }) {
                output.write_all(part)?;
                if let (Some(nonce), Some(expected)) = (nonce, expected.as_ref()) {
                    observed.extend_from_slice(part);
                    let mut delivered = observed == expected.as_bytes();
                    if dpad {
                        delivered = false;
                        if let Some((counts, complete)) = dpad_read(&observed, nonce) {
                            if counts != announced {
                                output.flush()?;
                                writeln!(
                                    terminal,
                                    "D_{nonce}_{}_{}_{}_{}\r",
                                    counts[0], counts[1], counts[2], counts[3]
                                )?;
                                terminal.flush()?;
                                announced = counts;
                            }
                            delivered = complete;
                        }
                    }
                    if !acknowledged && delivered {
                        output.flush()?;
                        let tag = if dpad { "DPAD" } else { "IME" };
                        writeln!(terminal, "{tag}_{nonce}_DELIVERED\r")?;
                        terminal.flush()?;
                        acknowledged = true;
                    }
                }
            }
        }
    }
    fn ready(output: &mut impl Write, nonce: Option<&str>, dpad: bool) -> io::Result<()> {
        if let Some(nonce) = nonce {
            let tag = if dpad { "DPAD" } else { "IME" };
            writeln!(output, "{tag}_{nonce}_READY\r")?;
            output.flush()?;
        }
        Ok(())
    }
    pub(super) fn arguments(
        mut args: impl Iterator<Item = OsString>,
    ) -> Option<(PathBuf, Option<String>, bool)> {
        let directory = PathBuf::from(args.next()?);
        let mut dpad = false;
        let nonce = match args.next() {
            None => None,
            Some(flag) if flag == "--ime-transactions" || flag == "--dpad-pan" => {
                dpad = flag == "--dpad-pan";
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
        Some((directory, nonce, dpad))
    }
    pub(super) fn run(directory: &Path, nonce: Option<&str>, dpad: bool) -> io::Result<()> {
        let mut bytes = output(directory, "received-bytes")?;
        let mut input = io::stdin().lock();
        let _mode = RawMode::new(input.as_raw_fd())?;
        let mut pid = output(directory, "receiver-pid")?;
        writeln!(pid, "{}", std::process::id())?;
        let mut terminal = io::stdout().lock();
        ready(&mut terminal, nonce, dpad)?;
        copy_bounded(&mut input, &mut bytes, LIMIT, nonce, dpad, &mut terminal)
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
            ready(&mut bytes, None, false).unwrap();
            assert!(bytes.is_empty());
            ready(&mut bytes, Some("0123456789abcdef0123456789abcdef"), false).unwrap();
            assert_eq!(bytes, b"IME_0123456789abcdef0123456789abcdef_READY\r\n");
        }

        #[test]
        fn closed_ime_arguments_reject_invalid_flags_and_nonces_before_outputs() {
            let parse = |values: &[&str]| arguments(values.iter().map(OsString::from));
            assert_eq!(parse(&["private"]).unwrap().1, None);
            assert_eq!(
                parse(&["private", "--dpad-pan", "0123456789abcdef0123456789abcdef"])
                    .unwrap()
                    .2,
                true
            );
            assert!(parse(&["private", "--dpad-pan", "invalid"]).is_none());
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
                false,
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
                    false,
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
                false,
                &mut terminal,
            )
            .unwrap();
            assert_eq!(terminal, ack);
            assert_eq!(stored, [expected.as_slice(), b"extra"].concat());
        }

        #[test]
        fn dpad_order_counts_and_marker_are_closed_and_incremental() {
            let nonce = "0123456789abcdef0123456789abcdef";
            let arrows = [
                b"\x1b[A".repeat(3),
                b"\x1b[D".repeat(2),
                b"\x1b[B".repeat(2),
                b"\x1b[C".repeat(2),
            ]
            .concat();
            assert_eq!(dpad_read(b"\x1b[A", nonce), Some(([1, 0, 0, 0], false)));
            assert_eq!(dpad_read(&arrows, nonce), Some(([3, 2, 2, 2], false)));
            let exact = [arrows.as_slice(), format!("owned-dpad-{nonce}").as_bytes()].concat();
            assert_eq!(dpad_read(&exact, nonce), Some(([3, 2, 2, 2], true)));
            for end in 0..exact.len() {
                assert!(dpad_read(&exact[..end], nonce).is_some());
            }
            for invalid in [
                b"\x1b[D".to_vec(),
                b"\x1b[A".repeat(33),
                b"\x1b[A\x1b[D".to_vec(),
                [arrows.as_slice(), b"\x1b[A"].concat(),
                [exact.as_slice(), b"extra"].concat(),
                b"owned-dpad-wrong".to_vec(),
            ] {
                assert!(dpad_read(&invalid, nonce).is_none());
            }
            let mut stored = Vec::new();
            let mut terminal = Vec::new();
            copy_bounded(
                &mut Cursor::new(&exact),
                &mut stored,
                LIMIT,
                Some(nonce),
                true,
                &mut terminal,
            )
            .unwrap();
            assert_eq!(stored, exact);
            let actual = String::from_utf8(terminal.clone()).unwrap();
            let states: Vec<_> = actual.lines().collect();
            let expected_states: Vec<_> = [
                "1_0_0_0", "2_0_0_0", "3_0_0_0", "3_1_0_0", "3_2_0_0", "3_2_1_0", "3_2_2_0",
                "3_2_2_1", "3_2_2_2",
            ]
            .iter()
            .map(|counts| format!("D_{nonce}_{counts}"))
            .chain(std::iter::once(format!("DPAD_{nonce}_DELIVERED")))
            .collect();
            assert_eq!(states, expected_states);
            stored.clear();
            terminal.clear();
            copy_bounded(
                &mut Cursor::new([exact.as_slice(), b"extra"].concat()),
                &mut stored,
                LIMIT,
                Some(nonce),
                true,
                &mut terminal,
            )
            .unwrap();
            assert_eq!(stored, [exact.as_slice(), b"extra"].concat());
            assert!(
                dpad_read(&stored, nonce).is_none(),
                "an earlier ACK cannot hide later extra input"
            );
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
                false,
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
                false,
                &mut Vec::new(),
            )
            .unwrap();
            assert_eq!(result, b"abc");
            assert!(copy_bounded(
                &mut Cursor::new(b"abcd"),
                &mut Vec::new(),
                3,
                None,
                false,
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
            Some((directory, nonce, dpad)) => {
                receiver::run(&directory, nonce.as_deref(), dpad).is_ok()
            }
            None => false,
        };
        if success {
            return;
        }
    }
    eprintln!("Owned terminal receiver failed");
    std::process::exit(1);
}
