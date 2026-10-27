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
        Observed {
            start: u64,
            state: char,
            parent: i32,
        },
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
        let Some(parent) = fields
            .get(1)
            .and_then(|s| s.parse::<i32>().ok())
            .filter(|p| *p >= 0)
        else {
            return Sample::Invalid;
        };
        Sample::Observed {
            start,
            state,
            parent,
        }
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
            Sample::Observed { start, state, .. } => match original {
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
    struct Client {
        pid: i32,
        control: bool,
        written: u64,
        discarded: u64,
        original: Sample,
    }
    struct Clients(Result<Vec<Client>, &'static str>);
    struct Observer(Option<std::process::Child>);
    impl Drop for Observer {
        fn drop(&mut self) {
            if let Some(mut child) = self.0.take() {
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill();
                    // Cancellation must not leave an owned child running or
                    // block the original failure while the OS completes reaping.
                    let _ = std::thread::Builder::new()
                        .name("tmux-observer-reap".into())
                        .spawn(move || {
                            let _ = child.wait();
                        });
                }
            }
        }
    }

    fn client_rows(bytes: &[u8], server: i32, observer: i32) -> Result<Vec<Client>, &'static str> {
        if bytes.len() > 8192 {
            return Err("Overflow");
        }
        let mut lines = std::str::from_utf8(bytes).map_err(|_| "Invalid")?.lines();
        if lines.next().and_then(|s| s.parse::<i32>().ok()) != Some(server) {
            return Err("WrongServer");
        }
        let mut seen = std::collections::HashSet::new();
        let mut clients = Vec::new();
        for line in lines {
            if line.is_empty() {
                continue;
            }
            let fields = line.split(':').collect::<Vec<_>>();
            if fields.len() != 4 {
                return Err("Invalid");
            }
            let pid = fields[0]
                .parse::<i32>()
                .ok()
                .filter(|p| *p > 0)
                .ok_or("Invalid")?;
            let control = match fields[1] {
                "0" => false,
                "1" => true,
                _ => return Err("Invalid"),
            };
            let written = fields[2].parse::<u64>().map_err(|_| "Invalid")?;
            let discarded = fields[3].parse::<u64>().map_err(|_| "Invalid")?;
            if !seen.insert(pid) {
                return Err("Invalid");
            }
            if pid != observer {
                if clients.len() == 16 {
                    return Err("Overflow");
                }
                clients.push(Client {
                    pid,
                    control,
                    written,
                    discarded,
                    original: read(pid),
                });
            }
        }
        Ok(clients)
    }
    impl Clients {
        fn failure(&self, server: &(i32, Sample, Sample)) -> String {
            let clients = match &self.0 {
                Ok(rows) => format!(
                    "{:?}",
                    rows.iter()
                        .enumerate()
                        .map(|(index, row)| (
                            index,
                            row.control,
                            row.written,
                            row.discarded,
                            phase(row.original, read(row.pid))
                        ))
                        .collect::<Vec<_>>()
                ),
                Err(kind) => (*kind).into(),
            };
            // These counters are cumulative, not pending control-buffer sizes.
            format!(
                "clients(index,control,written,discarded,state)={clients}; children={}",
                children(server)
            )
        }
    }
    fn child_rows(bytes: &[u8]) -> Result<Vec<i32>, &'static str> {
        if bytes.len() > 4096 {
            return Err("Overflow");
        }
        let text = std::str::from_utf8(bytes).map_err(|_| "Invalid")?;
        let mut pids = Vec::new();
        for field in text.split_ascii_whitespace() {
            if pids.len() == 16 {
                return Err("Overflow");
            }
            let pid = field
                .parse::<i32>()
                .ok()
                .filter(|p| *p > 0)
                .ok_or("Invalid")?;
            if pids.contains(&pid) {
                return Err("Invalid");
            }
            pids.push(pid);
        }
        Ok(pids)
    }
    fn children(server: &(i32, Sample, Sample)) -> String {
        let (pid, original, _) = *server;
        let same = || matches!((original, read(pid)), (Sample::Observed { start: a, .. }, Sample::Observed { start: b, .. }) if a == b);
        if !same() {
            return "ServerIdentityUnavailable".into();
        }
        let snapshot = || -> Result<Vec<String>, &'static str> {
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(format!("/proc/{pid}/task/{pid}/children"))
                .map_err(|_| "Unavailable")?;
            let metadata = file.metadata().map_err(|_| "Unavailable")?;
            if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
                return Err("Unowned");
            }
            let mut bytes = Vec::new();
            file.take(4097)
                .read_to_end(&mut bytes)
                .map_err(|_| "Unavailable")?;
            let mut rows = Vec::new();
            for child in child_rows(&bytes)? {
                let first = read(child);
                rows.push(match first {
                    Sample::Observed { parent, .. } if parent == pid => {
                        let second = read(child);
                        match second {
                            Sample::Observed { parent, .. } if parent != pid => {
                                "ParentChanged".into()
                            }
                            _ => phase(first, second),
                        }
                    }
                    Sample::Observed { .. } => "ParentMismatch".into(),
                    _ => phase(first, first),
                });
            }
            if !same() {
                return Err("ServerIdentityChanged");
            }
            Ok(rows)
        };
        match snapshot() {
            Ok(rows) => format!("{rows:?}"),
            Err(kind) => kind.into(),
        }
    }
    pub(super) struct Processes(Vec<(i32, Sample, Sample)>, Option<Clients>);
    impl Processes {
        pub(super) async fn clients(&mut self, mut command: std::process::Command) {
            use std::os::fd::AsRawFd;
            let (server, original, _) = self.0[0];
            let same = || matches!((original, read(server)), (Sample::Observed { start: a, .. }, Sample::Observed { start: b, .. }) if a == b);
            command.args(["display-message", "-p", "#{pid}\n#{L:#{client_pid}:#{client_control_mode}:#{client_written}:#{client_discarded}\n}"])
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
            if !same() {
                self.1 = Some(Clients(Err("ServerIdentityUnavailable")));
                return;
            }
            let result = match command.spawn() {
                Err(_) => Err("SpawnFailed"),
                Ok(child) => {
                    let mut owned = Observer(Some(child));
                    let child = owned.0.as_mut().unwrap();
                    let observer = child.id() as i32;
                    let mut stdout = child.stdout.take().unwrap();
                    let mut bytes = Vec::new();
                    let result =
                        tokio::time::timeout(std::time::Duration::from_millis(250), async {
                            let fd = stdout.as_raw_fd();
                            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
                            if flags == -1
                                || unsafe {
                                    libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK)
                                } == -1
                            {
                                return Err("PipeUnavailable");
                            }
                            let mut eof = false;
                            loop {
                                let mut buffer = [0; 1024];
                                if !eof {
                                    match stdout.read(&mut buffer) {
                                        Ok(0) => eof = true,
                                        Ok(n) => {
                                            bytes.extend_from_slice(&buffer[..n]);
                                            if bytes.len() > 8192 {
                                                return Err("Overflow");
                                            }
                                        }
                                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                                        }
                                        Err(_) => return Err("PipeFailed"),
                                    }
                                }
                                if let Some(status) = child.try_wait().map_err(|_| "WaitFailed")? {
                                    if !status.success() {
                                        return Err("CommandFailed");
                                    }
                                    if eof {
                                        if !same() {
                                            return Err("ServerIdentityChanged");
                                        }
                                        return client_rows(&bytes, server, observer);
                                    }
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                            }
                        })
                        .await;
                    let result = result.unwrap_or(Err("Deadline"));
                    if result.is_err() {
                        let _ = child.kill();
                        let reaped =
                            tokio::time::timeout(std::time::Duration::from_millis(100), async {
                                loop {
                                    if child.try_wait().ok().flatten().is_some() {
                                        return;
                                    }
                                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                                }
                            })
                            .await
                            .is_ok();
                        if !reaped {
                            self.1 = Some(Clients(Err("CleanupPending")));
                            return;
                        }
                    }
                    result
                }
            };
            self.1 = Some(Clients(result));
        }
        pub(super) fn capture(pids: &[i32]) -> Self {
            Self(
                pids.iter()
                    .take(4)
                    .map(|&pid| {
                        let original = read(pid);
                        (pid, original, original)
                    })
                    .collect(),
                None,
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
                    Sample::Observed { start, state, .. },
                ) if expected == start => Some(state),
                _ => None,
            }
        }
        pub(super) fn failure(&self) -> String {
            // Only ordinal, finite state, identity comparison and I/O kind leave
            // this module. Never format comm, raw stat bytes, paths or errors.
            format!(
                "{:?}; remaining={}",
                self.0
                    .iter()
                    .enumerate()
                    .map(|(index, (pid, original, before))| (
                        index,
                        phase(*original, *before),
                        phase(*original, read(*pid))
                    ))
                    .collect::<Vec<_>>(),
                self.1
                    .as_ref()
                    .map(|clients| clients.failure(&self.0[0]))
                    .unwrap_or_else(|| "NotObserved".into())
            )
        }
    }
    #[test]
    fn remaining_client_rows_are_bounded_numeric_and_exclude_the_observer() {
        let rows = client_rows(b"123\n999:0:0:0\n456:1:27:3\n", 123, 999).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].pid,
                rows[0].control,
                rows[0].written,
                rows[0].discarded
            ),
            (456, true, 27, 3)
        );
        for bytes in [
            b"124\n".as_slice(),
            b"123\n456:2:0:0\n",
            b"123\n456:1:payload:0\n",
            b"123\n456:1:0:0\n456:1:0:0\n",
            b"123\n0:0:0:0\n",
            &[255],
        ] {
            assert!(client_rows(bytes, 123, 999).is_err());
        }
        assert!(client_rows(&vec![b'x'; 8193], 123, 999).is_err());
        let overflow = format!(
            "123\n{}",
            (1..=17).map(|p| format!("{p}:1:0:0\n")).collect::<String>()
        );
        assert!(client_rows(overflow.as_bytes(), 123, 999).is_err());
        let receipt =
            Clients(Err("Invalid")).failure(&(i32::MAX, Sample::Missing, Sample::Missing));
        assert_eq!(receipt, "clients(index,control,written,discarded,state)=Invalid; children=ServerIdentityUnavailable");
    }
    #[tokio::test]
    async fn observer_deadline_overflow_and_error_reap_owned_children_without_raw_output() {
        for (program, expected) in [
            ("exec sleep 10", "Deadline"),
            ("exec yes 1", "Overflow"),
            ("printf private-payload >&2; exit 7", "CommandFailed"),
        ] {
            let mut observations = Processes::capture(&[std::process::id() as i32]);
            let mut command = std::process::Command::new("/bin/sh");
            command.args(["-c", program]);
            observations.clients(command).await;
            // These outcomes are returned only after try_wait confirms reaping;
            // exceptional deferred reaping is a distinct CleanupPending result.
            let receipt = observations.1.unwrap();
            assert!(matches!(receipt.0, Err(kind) if kind == expected));
        }
    }
    #[tokio::test]
    async fn cancelling_an_observer_kills_and_reaps_its_owned_child() {
        let child = std::process::Command::new("/bin/sleep")
            .arg("10")
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let mut wait = Box::pin(async move {
            let _owned = Observer(Some(child));
            std::future::pending::<()>().await;
        });
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(
                std::future::Future::poll(wait.as_mut(), cx).is_pending()
            ))
            .await
        );
        drop(wait);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        })
        .await
        .expect("cancelled observer must be killed and reaped");
    }
    #[test]
    fn remaining_child_list_rejects_truncated_duplicate_and_invalid_ids() {
        assert_eq!(child_rows(b"12 34\n").unwrap(), vec![12, 34]);
        assert!(child_rows(b"").unwrap().is_empty());
        for bytes in [
            b"12 12".as_slice(),
            b"-1",
            b"0",
            b"2147483648",
            b"secret",
            &[255],
        ] {
            assert!(child_rows(bytes).is_err());
        }
        assert!(child_rows(&vec![b'1'; 4097]).is_err());
        let overflow = (1..=17)
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(child_rows(overflow.as_bytes()).is_err());
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
    pub(super) async fn clients(&mut self, command: std::process::Command) {
        #[cfg(target_os = "linux")]
        self.inner.clients(command).await;
        #[cfg(not(target_os = "linux"))]
        let _ = command;
    }
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
