//! The per-user watcher socket: where it lives, who may use it, and one bounded exchange.
use crate::{Error, Result};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::{self, DirBuilder},
    io::{self, BufRead, BufReader, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{DirBuilderExt, MetadataExt},
            net::UnixStream,
        },
    },
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};

pub(crate) const NAME: &str = "browser.sock";
/// A launcher answers like a real opener: quickly, whatever the watcher does.
const ANSWER: Duration = Duration::from_millis(100);

#[derive(Deserialize)]
pub(crate) struct Reply {
    pub(crate) ok: bool,
    #[serde(default)]
    pub(crate) watcher: bool,
    #[serde(default)]
    pub(crate) reason: String,
}

pub(crate) fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

/// `$XDG_RUNTIME_DIR/lazysh` (a tmpfs the system owns), else `/tmp/lazysh-UID`.
/// Never a path under the home directory: a network home would carry the socket to other hosts.
pub(crate) fn directory() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        Some(runtime) if runtime.is_absolute() => runtime.join("lazysh"),
        _ => PathBuf::from(format!("/tmp/lazysh-{}", euid())),
    }
}

/// A real directory (never a link) owned by this user with no group or other access.
fn check(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && metadata.uid() == euid() && metadata.mode() & 0o077 == 0 {
        Ok(())
    } else {
        Err(io::ErrorKind::PermissionDenied.into())
    }
}

pub(crate) fn create() -> Result<PathBuf> {
    let path = directory();
    match DirBuilder::new().mode(0o700).create(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    check(&path).map_err(|_| Error::Browser("BrowserUnsafeSocketDirectory"))?;
    Ok(path)
}

pub(crate) fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let fd = stream.as_raw_fd();
    #[cfg(target_os = "linux")]
    {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: the buffer is a ucred of the length passed alongside it.
        let status = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        };
        if status != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(credentials.uid)
    }
    #[cfg(target_os = "macos")]
    {
        let (mut uid, mut gid) = (0, 0);
        // SAFETY: both out-pointers are valid for the call.
        if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid)
    }
}

fn exchange(line: &str) -> io::Result<Reply> {
    let directory = directory();
    check(&directory)?;
    let mut stream = UnixStream::connect(directory.join(NAME))?;
    if peer_uid(&stream)? != euid() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    stream.write_all(line.as_bytes())?;
    let mut reply = String::new();
    BufReader::new((&stream).take(1024)).read_line(&mut reply)?;
    serde_json::from_str(&reply).map_err(io::Error::other)
}

/// One request to the attached watcher, `None` when nobody answers within 100 ms.
pub(crate) fn request(message: &Value) -> Option<Reply> {
    let line = format!("{message}\n");
    let (done, reply) = mpsc::channel();
    // connect has no timeout, and a watcher with a full backlog must not stall a launcher.
    std::thread::Builder::new()
        .spawn(move || {
            let _ = done.send(exchange(&line));
        })
        .ok()?;
    reply.recv_timeout(ANSWER).ok()?.ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_uid_comes_from_the_kernel_not_the_peer() {
        let (a, b) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a).unwrap(), euid());
        assert_eq!(peer_uid(&b).unwrap(), euid());
    }
}
