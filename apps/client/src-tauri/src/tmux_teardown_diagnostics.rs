//! Failure-only receipts for the four PIDs already captured by the owned fixture.
use std::{io, os::unix::process::ExitStatusExt, process::ExitStatus};

pub(super) enum Stop {
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
    },
    Failed(io::ErrorKind),
}
impl std::fmt::Debug for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exited { code, signal } => f
                .debug_struct("Exited")
                .field("code", code)
                .field("signal", signal)
                .finish(),
            Self::Failed(kind) => f.debug_tuple("Failed").field(kind).finish(),
        }
    }
}
impl From<io::Result<ExitStatus>> for Stop {
    fn from(result: io::Result<ExitStatus>) -> Self {
        match result {
            Ok(status) => Self::Exited {
                code: status.code(),
                signal: status.signal(),
            },
            Err(error) => Self::Failed(error.kind()),
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::{
        fs::OpenOptions,
        io::{self, Read},
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };

    #[derive(Clone, Copy)]
    enum Sample {
        Observed { start: u64, state: char },
        Missing,
        Unowned,
        Invalid,
        Unavailable(io::ErrorKind),
    }

    fn parse(bytes: &[u8], pid: i32) -> Sample {
        let Some(text) = std::str::from_utf8(bytes)
            .ok()
            .filter(|_| bytes.len() <= 4096)
        else {
            return Sample::Invalid;
        };
        let Some((number, tail)) = text.split_once(" (") else {
            return Sample::Invalid;
        };
        let Some((_, fields)) = tail.rsplit_once(") ") else {
            return Sample::Invalid;
        };
        if number.parse::<i32>().ok() != Some(pid) {
            return Sample::Invalid;
        }
        let fields = fields.split_ascii_whitespace().collect::<Vec<_>>();
        let Some(state) = fields
            .first()
            .filter(|s| s.len() == 1)
            .and_then(|s| s.chars().next())
            .filter(|s| "RSDZTtWXxKPI".contains(*s))
        else {
            return Sample::Invalid;
        };
        let Some(start) = fields.get(19).and_then(|s| s.parse::<u64>().ok()) else {
            return Sample::Invalid;
        };
        Sample::Observed { start, state }
    }
    fn read(pid: i32) -> Sample {
        let sample = || -> io::Result<Sample> {
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(format!("/proc/{pid}/stat"))?;
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
                return Ok(Sample::Unowned);
            }
            let mut bytes = Vec::new();
            file.take(4097).read_to_end(&mut bytes)?;
            Ok(parse(&bytes, pid))
        };
        match sample() {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Sample::Missing,
            Err(error) => Sample::Unavailable(error.kind()),
        }
    }
    fn phase(original: Sample, current: Sample) -> String {
        match current {
            Sample::Observed { start, state } => match original {
                Sample::Observed {
                    start: expected, ..
                } if start == expected => format!("Same({state})"),
                Sample::Observed { .. } => format!("Reused({state})"),
                _ => format!("Unverified({state})"),
            },
            Sample::Missing => "Missing".into(),
            Sample::Unowned => "Unowned".into(),
            Sample::Invalid => "Invalid".into(),
            Sample::Unavailable(kind) => format!("Unavailable({kind:?})"),
        }
    }
    pub(super) struct Processes(Vec<(i32, Sample, Sample)>);
    impl Processes {
        pub(super) fn capture(pids: &[i32]) -> Self {
            Self(
                pids.iter()
                    .take(4)
                    .map(|&pid| {
                        let original = read(pid);
                        (pid, original, original)
                    })
                    .collect(),
            )
        }
        pub(super) fn before_stop(&mut self) {
            for (pid, _, before) in &mut self.0 {
                *before = read(*pid);
            }
        }
        pub(super) fn same_state(&self, index: usize) -> Option<char> {
            let (pid, original, _) = self.0.get(index)?;
            match (*original, read(*pid)) {
                (
                    Sample::Observed {
                        start: expected, ..
                    },
                    Sample::Observed { start, state },
                ) if expected == start => Some(state),
                _ => None,
            }
        }
        pub(super) fn failure(&self) -> String {
            // Only ordinal, finite state, identity comparison and I/O kind leave
            // this module. Never format comm, raw stat bytes, paths or errors.
            format!(
                "{:?}",
                self.0
                    .iter()
                    .enumerate()
                    .map(|(index, (pid, original, before))| (
                        index,
                        phase(*original, *before),
                        phase(*original, read(*pid))
                    ))
                    .collect::<Vec<_>>()
            )
        }
    }
    #[test]
    fn process_receipts_distinguish_zombie_reuse_and_missing_without_comm_leaks() {
        let stat = |state: &str, start: &str| {
            format!(
                "123 (private ) path\nsecret) {state} {} {start}",
                vec!["0"; 18].join(" ")
            )
        };
        let original = parse(stat("S", "42").as_bytes(), 123);
        assert_eq!(
            phase(original, parse(stat("Z", "42").as_bytes(), 123)),
            "Same(Z)"
        );
        assert_eq!(
            phase(original, parse(stat("R", "43").as_bytes(), 123)),
            "Reused(R)"
        );
        assert_eq!(phase(original, Sample::Missing), "Missing");
        assert_eq!(phase(Sample::Unowned, original), "Unverified(S)");
        for bytes in [
            stat("?", "42").into_bytes(),
            stat("S", "bad").into_bytes(),
            vec![b'x'; 4097],
            vec![255],
        ] {
            assert_eq!(phase(original, parse(&bytes, 123)), "Invalid");
        }
        assert_eq!(
            phase(original, parse(stat("S", "42").as_bytes(), 124)),
            "Invalid"
        );
        assert_eq!(
            phase(
                original,
                Sample::Unavailable(io::ErrorKind::PermissionDenied)
            ),
            "Unavailable(PermissionDenied)"
        );
        let own = read(std::process::id() as i32);
        if let Sample::Observed { state, .. } = own {
            // The test worker may run while the thread-group leader sleeps.
            assert_eq!(phase(own, own), format!("Same({state})"));
        } else {
            eprintln!(
                "Owned current-process metadata unavailable: {}",
                phase(own, own)
            );
        }
    }
}

pub(super) struct Processes {
    #[cfg(target_os = "linux")]
    inner: linux::Processes,
}
impl Processes {
    pub(super) fn capture(pids: &[i32]) -> Self {
        #[cfg(not(target_os = "linux"))]
        let _ = pids;
        Self {
            #[cfg(target_os = "linux")]
            inner: linux::Processes::capture(pids),
        }
    }
    pub(super) fn before_stop(&mut self) {
        #[cfg(target_os = "linux")]
        self.inner.before_stop();
    }
    #[cfg(target_os = "linux")]
    pub(super) fn same_state(&self, index: usize) -> Option<char> {
        self.inner.same_state(index)
    }
    pub(super) fn failure(&self) -> String {
        #[cfg(target_os = "linux")]
        return self.inner.failure();
        #[cfg(not(target_os = "linux"))]
        "process metadata unsupported on this host".into()
    }
}

#[test]
fn cleanup_errors_never_format_paths_or_raw_os_errors() {
    let error = io::Error::new(io::ErrorKind::PermissionDenied, "private path and payload");
    assert_eq!(
        format!("{:?}", Stop::from(Err(error))),
        "Failed(PermissionDenied)"
    );
}
