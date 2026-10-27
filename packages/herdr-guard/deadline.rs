// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Absolute guarded receive bound; ordinary attachment keeps upstream policy.
use std::io::{self, Read};
use std::time::{Duration, Instant};

struct DeadlineRead<'a, R, F> {
    reader: &'a mut R,
    deadline: Instant,
    timeout: F,
}
fn expired() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "guard_startup_expired")
}
impl<R: Read, F: Fn(&R, Option<Duration>) -> io::Result<()>> Read for DeadlineRead<'_, R, F> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(expired)?;
        (self.timeout)(self.reader, Some(remaining))?;
        let read = self.reader.read(bytes)?;
        if Instant::now() >= self.deadline {
            return Err(expired());
        }
        Ok(read)
    }
}
fn read_bounded<
    R: Read,
    M: for<'de> serde::Deserialize<'de>,
    F: Fn(&R, Option<Duration>) -> io::Result<()>,
>(
    reader: &mut R,
    deadline: Instant,
    limit: usize,
    timeout: F,
) -> Result<M, crate::protocol::FramingError> {
    let result = crate::protocol::read_message(
        &mut DeadlineRead {
            reader,
            deadline,
            timeout: &timeout,
        },
        limit,
    );
    let reset = timeout(reader, None);
    match result {
        Err(error) => Err(error),
        Ok(value) => {
            reset?;
            if Instant::now() >= deadline {
                return Err(crate::protocol::FramingError::Io(expired()));
            }
            Ok(value)
        }
    }
}
pub(crate) fn read<M: for<'de> serde::Deserialize<'de>>(
    stream: &mut crate::ipc::LocalStream,
    deadline: Instant,
    limit: usize,
) -> Result<M, crate::protocol::FramingError> {
    use interprocess::local_socket::traits::Stream as _;
    // Unsupported is fatal here, including named-pipe transports. It must not
    // fall through to upstream's ordinary best-effort timeout policy.
    read_bounded(stream, deadline, limit, |stream, timeout| {
        stream.set_recv_timeout(timeout)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_timeout_fails_before_consuming_startup_bytes() {
        let mut source = io::Cursor::new(vec![0; 16]);
        let result: Result<u8, _> = read_bounded(
            &mut source,
            Instant::now() + Duration::from_secs(1),
            32,
            |_, _| {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "owned unsupported transport",
                ))
            },
        );
        assert!(
            matches!(result, Err(crate::protocol::FramingError::Io(error)) if error.kind() == io::ErrorKind::Unsupported)
        );
        assert_eq!(source.position(), 0);
    }
    #[cfg(unix)]
    #[test]
    fn held_open_and_drip_fed_frames_obey_one_absolute_deadline() {
        use std::io::Write;
        use std::os::unix::net::UnixStream;
        for drip in [false, true] {
            let (mut reader, mut writer) = UnixStream::pair().unwrap();
            let mut frame = Vec::new();
            crate::protocol::write_message(&mut frame, &"owned slow frame".to_string()).unwrap();
            let worker = std::thread::spawn(move || {
                if drip {
                    for byte in frame {
                        if writer.write_all(&[byte]).is_err() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(15));
                    }
                } else {
                    std::thread::sleep(Duration::from_millis(120));
                }
            });
            let started = Instant::now();
            let result: Result<String, _> = read_bounded(
                &mut reader,
                started + Duration::from_millis(60),
                128,
                |reader, timeout| reader.set_read_timeout(timeout),
            );
            let elapsed = started.elapsed();
            drop(reader);
            worker.join().unwrap();
            assert!(
                matches!(result, Err(crate::protocol::FramingError::Io(error)) if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock))
            );
            assert!(
                elapsed < Duration::from_secs(1),
                "receive bound exceeded cleanup allowance"
            );
        }
    }
}
