// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Private machine startup framing. A consumer must parse only the first frame,
//! before exposing any bytes. Searching rendered output would permit spoofing.

use serde::{Deserialize, Serialize};
use std::io::{self, Write};

#[cfg(test)]
use super::protocol::decode;
use super::protocol::Secret;

const PREFIX: &[u8] = b"\x1eLAZYSH-GUARD-1:";
const MAX_STARTUP: usize = 512;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AttachTicket {
    pub(crate) boot: Secret,
    pub(crate) ticket: Secret,
}

impl AttachTicket {
    pub(crate) fn write_private_frame(&self, writer: &mut impl Write) -> io::Result<()> {
        let body = serde_json::to_vec(self).map_err(|_| io::Error::other("guard_unavailable"))?;
        if body.len() > MAX_STARTUP {
            return Err(io::Error::other("guard_unavailable"));
        }
        // ASCII length and JSON, without CR/LF: PTY output newline conversion
        // cannot corrupt the prefix. This is output, never terminal input.
        writer.write_all(PREFIX)?;
        write!(writer, "{:08x}:", body.len())?;
        writer.write_all(&body)?;
        writer.write_all(b"\x1f")?;
        writer.flush()
    }
}

/// Returns the consumed prefix only after one whole canonical startup frame.
/// None means bounded incomplete input; malformed/oversize data is fatal.
#[cfg(test)]
pub(crate) fn read_private_frame(
    bytes: &[u8],
) -> Result<Option<(AttachTicket, usize)>, &'static str> {
    let matched = bytes.len().min(PREFIX.len());
    if bytes[..matched] != PREFIX[..matched] {
        return Err("guard_unavailable");
    }
    if bytes.len() < PREFIX.len() + 9 {
        return Ok(None);
    }
    let header = &bytes[PREFIX.len()..PREFIX.len() + 8];
    if !header
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        || bytes[PREFIX.len() + 8] != b':'
    {
        return Err("guard_unavailable");
    }
    let size = usize::from_str_radix(
        std::str::from_utf8(header).map_err(|_| "guard_unavailable")?,
        16,
    )
    .map_err(|_| "guard_unavailable")?;
    if size > MAX_STARTUP {
        return Err("guard_unavailable");
    }
    let start = PREFIX.len() + 9;
    let end = start + size;
    if bytes.len() <= end {
        return Ok(None);
    }
    if bytes[end] != 0x1f {
        return Err("guard_unavailable");
    }
    let ticket = decode(&bytes[start..end]).map_err(|_| "guard_unavailable")?;
    Ok(Some((ticket, end + 1)))
}

/// Read-only local CLI advertisement; no server, configuration or terminal access.
pub(crate) fn capabilities(args: &[String], writer: &mut impl Write) -> io::Result<bool> {
    if !args
        .iter()
        .skip(1)
        .any(|arg| arg == "--guarded-attach-capabilities")
    {
        return Ok(false);
    }
    if args.len() != 2 {
        return Err(invalid());
    }
    let supported = if cfg!(unix) { "true" } else { "false" };
    writeln!(writer, "{{\"schemaVersion\":1,\"startupFd\":{supported}}}")?;
    Ok(true)
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "guard_invalid")
}

pub(crate) enum TicketOutput {
    Stdout,
    #[cfg(unix)]
    Pipe(std::fs::File),
}
impl TicketOutput {
    pub(crate) fn write(self, ticket: AttachTicket) -> io::Result<()> {
        match self {
            Self::Stdout => ticket.write_private_frame(&mut io::stdout().lock()),
            #[cfg(unix)]
            Self::Pipe(pipe) => {
                let mut frame = Vec::new();
                ticket.write_private_frame(&mut frame)?;
                // The imported descriptor is closed before logging or TUI initialization.
                write_pipe(
                    &pipe,
                    &frame,
                    std::time::Instant::now() + std::time::Duration::from_secs(2),
                )
            }
        }
    }
}

#[cfg(unix)]
fn validate_pipe(file: &std::fs::File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0
        || flags & libc::O_ACCMODE != libc::O_WRONLY
        || unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0
    {
        return Err(invalid());
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFIFO || unsafe { libc::isatty(fd) } != 0 {
        return Err(invalid());
    }
    for standard in 0..=2 {
        let mut other = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(standard, other.as_mut_ptr()) } == 0 {
            let other = unsafe { other.assume_init() };
            if (other.st_dev, other.st_ino) == (stat.st_dev, stat.st_ino) {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn write_pipe(file: &std::fs::File, frame: &[u8], deadline: std::time::Instant) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    let capacity = unsafe { libc::fpathconf(fd, libc::_PC_PIPE_BUF) };
    if capacity <= 0 || frame.len() > capacity as usize {
        return Err(invalid());
    }
    struct Flags {
        fd: i32,
        original: i32,
    }
    impl Drop for Flags {
        fn drop(&mut self) {
            unsafe {
                libc::fcntl(self.fd, libc::F_SETFL, self.original);
            }
        }
    }
    let original = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if original < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, original | libc::O_NONBLOCK) } < 0 {
        return Err(invalid());
    }
    // O_NONBLOCK is shared with inherited aliases. Restore it before closing;
    // the owned Mosh route redirects stdio first and never otherwise writes FD3.
    let flags = Flags { fd, original };
    let result = loop {
        let Some(left) = deadline
            .checked_duration_since(std::time::Instant::now())
            .filter(|left| !left.is_zero())
        else {
            break Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "guard_startup_expired",
            ));
        };
        let written = unsafe { libc::write(fd, frame.as_ptr().cast(), frame.len()) };
        if written == frame.len() as isize {
            break Ok(());
        }
        if written >= 0 {
            break Err(invalid());
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if error.kind() != io::ErrorKind::WouldBlock {
            break Err(io::Error::other("guard_unavailable"));
        }
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        let wait = left.as_millis().saturating_add(1).min(i32::MAX as u128) as i32;
        let status = unsafe { libc::poll(&mut poll, 1, wait) };
        if status < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            break Err(io::Error::other("guard_unavailable"));
        }
    };
    let restored = unsafe { libc::fcntl(fd, libc::F_SETFL, flags.original) } >= 0;
    drop(flags);
    if restored {
        result
    } else {
        Err(io::Error::other("guard_unavailable"))
    }
}

pub(crate) fn extract_flag(
    mut args: Vec<String>,
) -> io::Result<(Vec<String>, Option<TicketOutput>)> {
    let guarded = args.iter().skip(1).any(|arg| arg == "--guarded-attach");
    let descriptor = args
        .iter()
        .skip(1)
        .any(|arg| arg.starts_with("--startup-fd"));
    if !guarded && !descriptor {
        return Ok((args, None));
    }
    let output = match args
        .iter()
        .skip(1)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--guarded-attach"] => TicketOutput::Stdout,
        ["--guarded-attach", "--startup-fd", "3"] => {
            #[cfg(unix)]
            {
                use std::os::fd::FromRawFd;
                if unsafe { libc::fcntl(3, libc::F_GETFD) } < 0 {
                    return Err(invalid());
                }
                let file = unsafe { std::fs::File::from_raw_fd(3) };
                validate_pipe(&file)?;
                // Descriptor-local CLOEXEC cannot alter another inherited alias.
                let flags = unsafe { libc::fcntl(3, libc::F_GETFD) };
                if flags < 0
                    || unsafe { libc::fcntl(3, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
                {
                    return Err(invalid());
                }
                TicketOutput::Pipe(file)
            }
            #[cfg(not(unix))]
            {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    };
    args.truncate(1);
    Ok((args, Some(output)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_frame_is_incremental_and_never_searches_pane_output() {
        let ticket = AttachTicket {
            boot: Secret::generate().unwrap(),
            ticket: Secret::generate().unwrap(),
        };
        let mut bytes = Vec::new();
        ticket.write_private_frame(&mut bytes).unwrap();
        for split in 0..bytes.len() {
            assert!(read_private_frame(&bytes[..split]).unwrap().is_none());
        }
        let original_len = bytes.len();
        bytes.extend_from_slice(b"untrusted rendered pane output");
        let (read, used) = read_private_frame(&bytes).unwrap().unwrap();
        assert_eq!(used, original_len);
        assert!(read.boot == ticket.boot && read.ticket == ticket.ticket);
        let mut spoofed = b"pane output".to_vec();
        spoofed.extend_from_slice(&bytes);
        assert_eq!(
            read_private_frame(&spoofed).err(),
            Some("guard_unavailable")
        );
        assert_eq!(format!("{:?}", ticket.ticket), "Secret([redacted])");
    }
    #[test]
    fn explicit_selectors_and_read_only_advertisement_are_closed() {
        let args = |values: &[&str]| values.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut bytes = Vec::new();
        assert!(capabilities(
            &args(&["herdr", "--guarded-attach-capabilities"]),
            &mut bytes
        )
        .unwrap());
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"schemaVersion":1,"startupFd":cfg!(unix)})
        );
        assert!(capabilities(
            &args(&["herdr", "--guarded-attach-capabilities", "server"]),
            &mut Vec::new()
        )
        .is_err());
        assert!(matches!(
            extract_flag(args(&["herdr", "--guarded-attach"]))
                .unwrap()
                .1,
            Some(TicketOutput::Stdout)
        ));
        assert!(extract_flag(args(&["herdr", "--help"]))
            .unwrap()
            .1
            .is_none());
        for values in [
            vec!["--startup-fd", "3"],
            vec!["--guarded-attach", "--startup-fd", "1"],
            vec!["--guarded-attach", "--startup-fd", "4"],
            vec!["--guarded-attach", "--startup-fd"],
            vec!["--guarded-attach", "--startup-fd=3"],
            vec!["--guarded-attach", "--startup-fd", "03"],
            vec!["--guarded-attach", "--guarded-attach"],
            vec!["--startup-fd", "3", "--guarded-attach"],
        ] {
            let mut raw = vec!["herdr"];
            raw.extend(values);
            assert!(extract_flag(args(&raw)).is_err());
        }
    }

    #[cfg(unix)]
    fn pipe() -> (std::fs::File, std::fs::File) {
        use std::os::fd::FromRawFd;
        let mut descriptors = [-1; 2];
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        unsafe {
            (
                std::fs::File::from_raw_fd(descriptors[0]),
                std::fs::File::from_raw_fd(descriptors[1]),
            )
        }
    }

    #[cfg(unix)]
    #[test]
    fn pipe_frame_is_unchanged_and_shared_flags_restore_on_success_and_broken_reader() {
        use std::io::Read;
        use std::os::fd::AsRawFd;
        let ticket = AttachTicket {
            boot: Secret::generate().unwrap(),
            ticket: Secret::generate().unwrap(),
        };
        let mut canonical = Vec::new();
        ticket.write_private_frame(&mut canonical).unwrap();
        for (broken, nonblocking) in [(false, false), (false, true), (true, false)] {
            let (reader, writer) = pipe();
            assert!(validate_pipe(&reader).is_err());
            validate_pipe(&writer).unwrap();
            let alias = writer.try_clone().unwrap();
            let mut flags = unsafe { libc::fcntl(alias.as_raw_fd(), libc::F_GETFL) };
            if nonblocking {
                flags |= libc::O_NONBLOCK;
                assert_eq!(
                    unsafe { libc::fcntl(alias.as_raw_fd(), libc::F_SETFL, flags) },
                    0
                );
            }
            let mut reader = Some(reader);
            if broken {
                drop(reader.take());
            }
            let result = write_pipe(
                &writer,
                &canonical,
                std::time::Instant::now() + std::time::Duration::from_secs(1),
            );
            assert_eq!(result.is_ok(), !broken);
            assert_eq!(
                unsafe { libc::fcntl(alias.as_raw_fd(), libc::F_GETFL) },
                flags
            );
            drop(writer);
            drop(alias);
            if let Some(mut reader) = reader {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes).unwrap();
                assert!(bytes == canonical);
                assert_eq!(read_private_frame(&bytes).unwrap().unwrap().1, bytes.len());
            }
        }
        assert!(validate_pipe(&std::fs::File::open("/dev/null").unwrap()).is_err());
        let (stream, _) = std::os::unix::net::UnixStream::pair().unwrap();
        let file: std::fs::File = std::os::fd::OwnedFd::from(stream).into();
        assert!(validate_pipe(&file).is_err());
        use std::os::unix::fs::OpenOptionsExt;
        let mut nonce = [0; 8];
        getrandom::fill(&mut nonce).unwrap();
        let path = std::env::temp_dir().join(format!(
            "owned-guard-fd-{}-{:x}",
            std::process::id(),
            u64::from_le_bytes(nonce)
        ));
        let regular = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        let rejected = validate_pipe(&regular).is_err();
        assert_eq!(regular.metadata().unwrap().len(), 0);
        drop(regular);
        std::fs::remove_file(path).unwrap();
        assert!(rejected, "writable regular file admitted as ticket pipe");
    }

    #[cfg(unix)]
    #[test]
    fn full_pipe_times_out_without_ticket_bytes_and_restores_shared_flags() {
        use std::io::Read;
        use std::os::fd::AsRawFd;
        let (mut reader, writer) = pipe();
        let fd = writer.as_raw_fd();
        let alias = writer.try_clone().unwrap();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) },
            0
        );
        let filler = [b'X'; 4096];
        let mut filled = 0;
        loop {
            let written = unsafe { libc::write(fd, filler.as_ptr().cast(), filler.len()) };
            if written < 0 {
                assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock);
                break;
            }
            filled += written as usize;
            assert!(filled <= 1024 * 1024);
        }
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFL, flags) }, 0);
        let started = std::time::Instant::now();
        let result = write_pipe(
            &writer,
            b"owned-private-frame",
            started + std::time::Duration::from_millis(60),
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(
            unsafe { libc::fcntl(alias.as_raw_fd(), libc::F_GETFL) },
            flags
        );
        drop(writer);
        drop(alias);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes.len(), filled);
        assert!(bytes.iter().all(|byte| *byte == b'X'));
    }
}
