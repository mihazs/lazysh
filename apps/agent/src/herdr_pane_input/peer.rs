//! The kernel facts a pinned server epoch rests on: which process is at the other end of a connected Unix socket,
//! held as a pidfd taken from that very connection (`SO_PEERPIDFD`, Linux 6.5), never reopened from a number.
use std::{
    ffi::c_int,
    io,
    mem::size_of,
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
};
use tokio::net::UnixStream;

pub(super) struct Peer {
    pub(super) pid: i32,
    pub(super) pidfd: OwnedFd,
}

fn sockopt<T>(fd: RawFd, option: c_int) -> io::Result<T> {
    // SAFETY: `T` is a plain integer or `ucred`, for which all-zero bytes are valid.
    let mut value: T = unsafe { std::mem::zeroed() };
    let mut length = size_of::<T>() as libc::socklen_t;
    // SAFETY: `value` is writable for `length` bytes and outlives the call.
    let status = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            option,
            std::ptr::from_mut(&mut value).cast(),
            &mut length,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize != size_of::<T>() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(value)
}

/// The pid behind a pidfd as the kernel reports it in this PID namespace.
fn pidfd_pid(pidfd: &OwnedFd) -> Option<i32> {
    std::fs::read_to_string(format!("/proc/self/fdinfo/{}", pidfd.as_raw_fd()))
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("Pid:"))?
        .trim()
        .parse()
        .ok()
}

/// The process on the other end of `stream`, when it belongs to the same user. A kernel without `SO_PEERPIDFD`, an
/// unconnected socket or any disagreement between the pidfd and the connection credentials is an error: there is
/// no fallback to a pid number that could be reused.
pub(super) fn of(stream: &UnixStream) -> Result<Peer, &'static str> {
    let fd = stream.as_raw_fd();
    let pidfd: c_int = sockopt(fd, libc::SO_PEERPIDFD).map_err(|error| {
        if error.raw_os_error() == Some(libc::ENOPROTOOPT) {
            "peer_pidfd_unsupported"
        } else {
            "peer_unavailable"
        }
    })?;
    // SAFETY: the kernel just returned this descriptor and nothing else owns it.
    let pidfd = unsafe { OwnedFd::from_raw_fd(pidfd) };
    let credentials: libc::ucred =
        sockopt(fd, libc::SO_PEERCRED).map_err(|_| "peer_unavailable")?;
    // SAFETY: `geteuid` has no preconditions.
    if credentials.uid != unsafe { libc::geteuid() } {
        return Err("peer_foreign");
    }
    if pidfd_pid(&pidfd) != Some(credentials.pid) {
        return Err("peer_unavailable");
    }
    Ok(Peer {
        pid: credentials.pid,
        pidfd,
    })
}

/// A pidfd turns readable when its process exits; an error is treated as exited because liveness is then unproven.
pub(super) fn exited(pidfd: &OwnedFd) -> bool {
    let mut poll = libc::pollfd {
        fd: pidfd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one valid `pollfd` and a zero timeout.
    unsafe { libc::poll(&mut poll, 1, 0) != 0 }
}

/// The process start time in clock ticks, which tells two processes with one pid number apart.
pub(super) fn start_ticks(pid: i32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name may hold spaces and parentheses; the fields after its last `)` are fixed.
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn names_the_process_at_the_other_end_of_the_connection_by_pidfd() {
        let (stream, _other) = UnixStream::pair().unwrap();
        let peer = of(&stream).unwrap();
        assert_eq!(peer.pid, std::process::id() as i32);
        assert!(!exited(&peer.pidfd));
        assert!(start_ticks(peer.pid).is_some_and(|ticks| ticks > 0));
    }
    #[test]
    fn an_exited_process_turns_its_pidfd_readable() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        // SAFETY: `pidfd_open` takes a pid and flags and returns a new descriptor or -1.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, child.id() as c_int, 0) };
        assert!(fd >= 0, "pidfd_open: {}", io::Error::last_os_error());
        // SAFETY: the syscall returned a fresh descriptor that only this value owns.
        let pidfd = unsafe { OwnedFd::from_raw_fd(fd as c_int) };
        assert!(!exited(&pidfd));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(exited(&pidfd));
        assert_eq!(start_ticks(child.id() as i32), None);
    }
}
