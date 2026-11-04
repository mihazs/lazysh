//! Failure-only receipts for captured fixture identities and bounded owned ancestry.
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
    enum Field {
        Stat,
        Wchan,
    }
    fn owned_file(pid: i32, field: Field) -> io::Result<Option<std::fs::File>> {
        let name = match field {
            Field::Stat => "stat",
            Field::Wchan => "wchan",
        };
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(format!("/proc/{pid}/{name}"))?;
        let metadata = file.metadata()?;
        Ok((metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() }).then_some(file))
    }
    fn read(pid: i32) -> Sample {
        let sample = || -> io::Result<Sample> {
            let Some(file) = owned_file(pid, Field::Stat)? else {
                return Ok(Sample::Unowned);
            };
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
    #[derive(Clone, Copy, PartialEq, Eq)]
    struct ClientIdentity {
        pid: i32,
        start: u64,
    }
    impl ClientIdentity {
        fn of(client: &Client) -> Option<Self> {
            match client.original {
                Sample::Observed { start, .. } => Some(Self {
                    pid: client.pid,
                    start,
                }),
                _ => None,
            }
        }
    }
    #[derive(Default)]
    struct Lifetimes([Option<ClientIdentity>; 2]);
    impl Lifetimes {
        fn remember(&mut self, ordinal: usize, clients: &Clients) {
            let Some(slots) = self.0.get_mut(ordinal..) else {
                return;
            };
            slots.fill(None);
            let Ok(rows) = &clients.0 else {
                return;
            };
            let previous = match ordinal {
                0 => None,
                1 if self.0[0].is_some() => self.0[0],
                _ => return,
            };
            let mut candidates = rows
                .iter()
                .filter(|row| row.control)
                .map(ClientIdentity::of);
            let mut selected = None;
            for candidate in &mut candidates {
                let Some(candidate) = candidate else {
                    return;
                };
                if Some(candidate) == previous {
                    continue;
                }
                if selected.replace(candidate).is_some() {
                    return;
                }
            }
            self.0[ordinal] = selected;
        }
        fn ordinal(&self, client: &Client, current: Sample) -> Option<usize> {
            if !client.control {
                return None;
            }
            let identity = ClientIdentity::of(client)?;
            if !matches!(current, Sample::Observed { start, .. } if start == identity.start) {
                return None;
            }
            self.0.iter().position(|entry| *entry == Some(identity))
        }
    }
    struct Clients(Result<Vec<Client>, &'static str>);
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FdKind {
        Pipe,
        Socket,
        Tty,
        Other,
        Unavailable,
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Ancestry {
        Reached,
        Reparented,
        Bounded,
        Unavailable,
    }
    #[derive(Debug, PartialEq, Eq)]
    struct Peer {
        ancestry: Ancestry,
        stdio: [FdKind; 3],
    }
    impl Peer {
        fn unavailable() -> Self {
            Self {
                ancestry: Ancestry::Unavailable,
                stdio: [FdKind::Unavailable; 3],
            }
        }
    }
    fn relation(sample: Sample) -> Option<(u64, i32)> {
        match sample {
            Sample::Observed {
                start,
                state,
                parent,
            } if !matches!(state, 'Z' | 'X' | 'x') => Some((start, parent)),
            _ => None,
        }
    }
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    enum WaitKind {
        PipeRead,
        PipeWrite,
        EventWait,
        Other,
        #[default]
        Unavailable,
    }
    fn parse_wait(bytes: &[u8]) -> WaitKind {
        if bytes.is_empty() || bytes.len() > 128 {
            return WaitKind::Unavailable;
        }
        match bytes.strip_suffix(b"\n").unwrap_or(bytes) {
            b"0" => WaitKind::Unavailable,
            b"pipe_read" => WaitKind::PipeRead,
            b"pipe_write" => WaitKind::PipeWrite,
            b"do_epoll_wait" | b"ep_poll" | b"poll_schedule_timeout.constprop.0" => {
                WaitKind::EventWait
            }
            _ => WaitKind::Other,
        }
    }
    fn read_wait(pid: i32) -> WaitKind {
        let read = || -> io::Result<WaitKind> {
            let Some(file) = owned_file(pid, Field::Wchan)? else {
                return Ok(WaitKind::Unavailable);
            };
            let mut bytes = Vec::new();
            file.take(129).read_to_end(&mut bytes)?;
            Ok(parse_wait(&bytes))
        };
        read().unwrap_or(WaitKind::Unavailable)
    }
    // Observe only an already-attributed identity. Never publish the kernel symbol,
    // and reject a changed parent, UID, lifetime or dead process around the read.
    fn wait_probe(
        identity: ClientIdentity,
        mut sample: impl FnMut(i32) -> Sample,
        read: impl FnOnce(i32) -> WaitKind,
    ) -> WaitKind {
        if identity.pid <= 1 {
            return WaitKind::Unavailable;
        }
        let before = relation(sample(identity.pid));
        if !before.is_some_and(|(start, _)| start == identity.start) {
            return WaitKind::Unavailable;
        }
        let wait = read(identity.pid);
        if relation(sample(identity.pid)) != before {
            return WaitKind::Unavailable;
        }
        wait
    }
    #[derive(Clone, Copy, Debug, Default)]
    struct Waits {
        server: WaitKind,
        fresh_control: WaitKind,
    }
    fn fd_kind(bytes: &[u8]) -> FdKind {
        let number = |value: &[u8]| !value.is_empty() && value.iter().all(u8::is_ascii_digit);
        if bytes.is_empty() || bytes.len() > 4096 {
            return FdKind::Unavailable;
        }
        for (prefix, kind) in [
            (b"pipe:[".as_slice(), FdKind::Pipe),
            (b"socket:[".as_slice(), FdKind::Socket),
        ] {
            if bytes
                .strip_prefix(prefix)
                .and_then(|tail| tail.strip_suffix(b"]"))
                .is_some_and(number)
            {
                return kind;
            }
        }
        if bytes == b"/dev/tty" || bytes.strip_prefix(b"/dev/pts/").is_some_and(number) {
            FdKind::Tty
        } else {
            FdKind::Other
        }
    }
    fn read_fd(pid: i32, fd: i32) -> FdKind {
        // readlink observes only a fixed descriptor's link, never its target/data.
        if pid <= 1 || !(0..=2).contains(&fd) {
            return FdKind::Unavailable;
        }
        let path = std::ffi::CString::new(format!("/proc/{pid}/fd/{fd}")).unwrap();
        let mut bytes = [0u8; 4097];
        let length =
            unsafe { libc::readlink(path.as_ptr(), bytes.as_mut_ptr().cast(), bytes.len()) };
        if length < 0 {
            FdKind::Unavailable
        } else {
            fd_kind(&bytes[..length as usize])
        }
    }
    fn peer_probe(
        client: ClientIdentity,
        anchor: ClientIdentity,
        mut sample: impl FnMut(i32) -> Sample,
        mut descriptor: impl FnMut(i32, i32) -> FdKind,
    ) -> Peer {
        if client.pid <= 1 || anchor.pid <= 1 || client.pid == anchor.pid {
            return Peer::unavailable();
        }
        let valid = |identity: ClientIdentity, value| {
            relation(value).is_some_and(|(start, _)| start == identity.start)
        };
        let anchor_before = sample(anchor.pid);
        let first = sample(client.pid);
        if !valid(anchor, anchor_before) || !valid(client, first) {
            return Peer::unavailable();
        }
        let mut chain = vec![(client.pid, first)];
        let mut ancestry = Ancestry::Bounded;
        for _ in 0..8 {
            let &(pid, before) = chain.last().unwrap();
            if pid == anchor.pid {
                if !valid(anchor, before) {
                    return Peer::unavailable();
                }
                ancestry = Ancestry::Reached;
                break;
            }
            let Some((_, parent)) = relation(before) else {
                return Peer::unavailable();
            };
            if parent == 1 {
                ancestry = Ancestry::Reparented;
                break;
            }
            if parent <= 1 || chain.iter().any(|&(seen, _)| seen == parent) {
                return Peer::unavailable();
            }
            let next = sample(parent);
            if relation(next).is_none() {
                return Peer::unavailable();
            }
            chain.push((parent, next));
            if parent == anchor.pid {
                if !valid(anchor, next) {
                    return Peer::unavailable();
                }
                ancestry = Ancestry::Reached;
                break;
            }
        }
        if ancestry == Ancestry::Bounded
            && relation(chain.last().unwrap().1)
                .is_some_and(|(_, parent)| chain.iter().any(|&(pid, _)| parent == pid))
        {
            return Peer::unavailable();
        }
        let stdio = std::array::from_fn(|fd| descriptor(client.pid, fd as i32));
        // UID admission is repeated by every real sample. Fence every observed
        // parent edge as well as the original client and explicitly owned anchor.
        if chain
            .iter()
            .rev()
            .any(|&(pid, before)| relation(sample(pid)) != relation(before))
            || !valid(anchor, sample(anchor.pid))
        {
            return Peer::unavailable();
        }
        Peer { ancestry, stdio }
    }
    fn fresh_client(clients: &Clients, lifetimes: &Lifetimes) -> Option<ClientIdentity> {
        let identity = lifetimes.0[1]?;
        let mut selected = clients
            .0
            .as_ref()
            .ok()?
            .iter()
            .filter(|row| row.control && ClientIdentity::of(row) == Some(identity));
        selected.next()?;
        selected.next().is_none().then_some(identity)
    }
    #[test]
    fn fresh_peer_requires_one_previously_attributed_control_identity() {
        let fresh = ClientIdentity {
            pid: 30,
            start: 300,
        };
        let lifetimes = Lifetimes([
            Some(ClientIdentity {
                pid: 10,
                start: 100,
            }),
            Some(fresh),
        ]);
        let row = |start, control| Client {
            pid: 30,
            control,
            written: 0,
            discarded: 0,
            original: Sample::Observed {
                start,
                state: 'S',
                parent: 20,
            },
        };
        assert!(fresh_client(&Clients(Ok(vec![row(300, true)])), &lifetimes) == Some(fresh));
        for rows in [
            vec![],
            vec![row(301, true)],
            vec![row(300, false)],
            vec![row(300, true), row(300, true)],
        ] {
            assert!(fresh_client(&Clients(Ok(rows)), &lifetimes).is_none());
        }
        assert!(fresh_client(&Clients(Err("Unavailable")), &lifetimes).is_none());
        assert!(fresh_client(&Clients(Ok(vec![row(300, true)])), &Lifetimes::default()).is_none());
    }
    #[test]
    fn peer_probe_fences_owned_parent_edges_and_never_reads_pid_one() {
        let mut seen = Vec::new();
        let result = peer_probe(
            ClientIdentity {
                pid: 30,
                start: 300,
            },
            ClientIdentity {
                pid: 10,
                start: 100,
            },
            |pid| {
                seen.push(pid);
                let (start, parent) = match pid {
                    30 => (300, 20),
                    20 => (200, 10),
                    10 => (100, 1),
                    _ => panic!("Unexpected process read"),
                };
                Sample::Observed {
                    start,
                    state: 'S',
                    parent,
                }
            },
            |pid, fd| {
                assert_eq!(pid, 30);
                [FdKind::Pipe, FdKind::Socket, FdKind::Other][fd as usize]
            },
        );
        assert_eq!(
            result,
            Peer {
                ancestry: Ancestry::Reached,
                stdio: [FdKind::Pipe, FdKind::Socket, FdKind::Other]
            }
        );
        assert!(!seen.contains(&1));
        let receipt = format!("{result:?}");
        for private in ["30", "20", "10", "/proc", "private"] {
            assert!(!receipt.contains(private));
        }
    }
    #[test]
    fn peer_probe_suppresses_all_fd_results_on_reuse_reparenting_or_uid_change() {
        for mutation in 0..5 {
            let after = std::cell::Cell::new(false);
            let result = peer_probe(
                ClientIdentity {
                    pid: 30,
                    start: 300,
                },
                ClientIdentity {
                    pid: 10,
                    start: 100,
                },
                |pid| {
                    if after.get() && ((mutation == 2 && pid == 10) || (mutation == 4 && pid == 30))
                    {
                        return Sample::Unowned;
                    }
                    let (mut start, mut parent) = match pid {
                        30 => (300, 20),
                        20 => (200, 10),
                        10 => (100, 1),
                        _ => panic!("Unexpected process read"),
                    };
                    if after.get() && ((mutation == 0 && pid == 30) || (mutation == 3 && pid == 10))
                    {
                        start += 1;
                    }
                    if after.get() && mutation == 1 && pid == 20 {
                        parent = 1;
                    }
                    Sample::Observed {
                        start,
                        state: 'S',
                        parent,
                    }
                },
                |_, _| {
                    after.set(true);
                    FdKind::Pipe
                },
            );
            assert_eq!(result, Peer::unavailable());
        }
    }
    #[test]
    fn peer_probe_rejects_unowned_missing_dead_looping_and_unsafe_identities() {
        for invalid in [
            Sample::Unowned,
            Sample::Missing,
            Sample::Invalid,
            Sample::Unavailable(io::ErrorKind::PermissionDenied),
            Sample::Observed {
                start: 200,
                state: 'Z',
                parent: 10,
            },
            Sample::Observed {
                start: 200,
                state: 'S',
                parent: 30,
            },
        ] {
            let result = peer_probe(
                ClientIdentity {
                    pid: 30,
                    start: 300,
                },
                ClientIdentity {
                    pid: 10,
                    start: 100,
                },
                |pid| match pid {
                    30 => Sample::Observed {
                        start: 300,
                        state: 'S',
                        parent: 20,
                    },
                    10 => Sample::Observed {
                        start: 100,
                        state: 'S',
                        parent: 1,
                    },
                    20 => invalid,
                    _ => panic!("Unexpected process read"),
                },
                |_, _| panic!("Unavailable ancestry must not read descriptors"),
            );
            assert_eq!(result, Peer::unavailable());
        }
        for (client, anchor) in [(1, 10), (30, 1), (30, 30)] {
            assert_eq!(
                peer_probe(
                    ClientIdentity {
                        pid: client,
                        start: 1
                    },
                    ClientIdentity {
                        pid: anchor,
                        start: 1
                    },
                    |_| panic!("Unsafe identity must not be sampled"),
                    |_, _| panic!("Unsafe identity must not read descriptors")
                ),
                Peer::unavailable()
            );
        }
    }
    #[test]
    fn peer_probe_bounds_parent_edges_and_reports_stable_reparenting_without_pid_one() {
        for reparented in [true, false] {
            let mut seen = Vec::new();
            let result = peer_probe(
                ClientIdentity {
                    pid: 30,
                    start: 300,
                },
                ClientIdentity {
                    pid: 100,
                    start: 1000,
                },
                |pid| {
                    assert_ne!(pid, 1);
                    seen.push(pid);
                    assert!(
                        pid == 100 || (22..=30).contains(&pid),
                        "Parent traversal exceeded eight edges"
                    );
                    Sample::Observed {
                        start: pid as u64 * 10,
                        state: 'S',
                        parent: if reparented || pid == 100 { 1 } else { pid - 1 },
                    }
                },
                |_, _| FdKind::Unavailable,
            );
            assert_eq!(
                result.ancestry,
                if reparented {
                    Ancestry::Reparented
                } else {
                    Ancestry::Bounded
                }
            );
            assert!(!seen.contains(&21));
        }
    }
    #[test]
    fn descriptor_classes_are_closed_and_never_return_paths_or_link_contents() {
        for (value, expected) in [
            (b"pipe:[123]".as_slice(), FdKind::Pipe),
            (b"socket:[456]", FdKind::Socket),
            (b"/dev/pts/7", FdKind::Tty),
            (b"/dev/tty", FdKind::Tty),
            (b"/private/secret", FdKind::Other),
            (b"pipe:[private]", FdKind::Other),
            (b"/dev/pts/private", FdKind::Other),
            (&[255], FdKind::Other),
        ] {
            assert_eq!(fd_kind(value), expected);
        }
        assert_eq!(fd_kind(&[]), FdKind::Unavailable);
        assert_eq!(fd_kind(&[b'x'; 4097]), FdKind::Unavailable);
    }
    #[test]
    fn real_owned_child_reports_anchor_and_descriptor_kinds_without_process_data() {
        let (input, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let input: std::os::fd::OwnedFd = input.into();
        let mut child = Observer(Some(
            std::process::Command::new("/bin/sleep")
                .arg("10")
                .stdin(std::process::Stdio::from(input))
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        ));
        let anchor = std::process::id() as i32;
        let client = child.0.as_ref().unwrap().id() as i32;
        let result = peer_probe(
            ClientIdentity {
                pid: client,
                start: relation(read(client))
                    .expect("Owned client metadata required")
                    .0,
            },
            ClientIdentity {
                pid: anchor,
                start: relation(read(anchor))
                    .expect("Owned anchor metadata required")
                    .0,
            },
            read,
            read_fd,
        );
        assert_eq!(
            result,
            Peer {
                ancestry: Ancestry::Reached,
                stdio: [FdKind::Socket, FdKind::Pipe, FdKind::Other]
            }
        );
        let receipt = format!("{result:?}");
        assert!(!receipt.contains(&client.to_string()) && !receipt.contains(&anchor.to_string()));
        child.0.as_mut().unwrap().kill().unwrap();
        child.0.take().unwrap().wait().unwrap();
    }
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
        fn failure(&self, server: &(i32, Sample, Sample), lifetimes: &Lifetimes) -> String {
            let clients = match &self.0 {
                Ok(rows) => format!(
                    "{:?}",
                    rows.iter()
                        .enumerate()
                        .map(|(index, row)| {
                            let current = read(row.pid);
                            (
                                index,
                                row.control,
                                row.written,
                                row.discarded,
                                phase(row.original, current),
                                lifetimes.ordinal(row, current),
                            )
                        })
                        .collect::<Vec<_>>()
                ),
                Err(kind) => (*kind).into(),
            };
            // These counters are cumulative, not pending control-buffer sizes.
            format!(
                "clients(index,control,written,discarded,state,lifetime)={clients}; children={}",
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
    pub(super) struct Processes(
        Vec<(i32, Sample, Sample)>,
        Option<Clients>,
        Lifetimes,
        Option<ClientIdentity>,
        Waits,
    );
    impl Processes {
        pub(super) async fn remember_clients(
            &mut self,
            ordinal: usize,
            command: std::process::Command,
        ) {
            self.clients(command).await;
            if let Some(clients) = self.1.take() {
                self.2.remember(ordinal, &clients);
            }
        }
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
                Lifetimes::default(),
                None,
                Waits::default(),
            )
        }
        pub(super) fn remember_ssh_anchor(&mut self, pid: i32) {
            // The caller retains this unreaped Child, so its PID cannot be reused.
            self.3 = if pid > 1 {
                relation(read(pid)).map(|(start, _)| ClientIdentity { pid, start })
            } else {
                None
            };
        }
        pub(super) fn fresh_peer(&self) -> String {
            let peer = self
                .3
                .zip(
                    self.1
                        .as_ref()
                        .and_then(|clients| fresh_client(clients, &self.2)),
                )
                .map(|(anchor, client)| peer_probe(client, anchor, read, read_fd))
                .unwrap_or_else(Peer::unavailable);
            format!("{peer:?}")
        }
        pub(super) fn before_stop(&mut self) {
            self.4 = self.waits();
            for (pid, _, before) in &mut self.0 {
                *before = read(*pid);
            }
        }
        fn waits(&self) -> Waits {
            let server = self
                .0
                .first()
                .and_then(|(pid, original, _)| match original {
                    Sample::Observed { start, .. } => Some(ClientIdentity {
                        pid: *pid,
                        start: *start,
                    }),
                    _ => None,
                });
            let fresh = self
                .1
                .as_ref()
                .and_then(|clients| fresh_client(clients, &self.2));
            let observe = |identity| wait_probe(identity, read, read_wait);
            Waits {
                server: server.map(observe).unwrap_or_default(),
                fresh_control: fresh.map(observe).unwrap_or_default(),
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
            let after = self.waits();
            format!(
                "{:?}; remaining={}; waits(before,after):server={:?},fresh_control={:?}",
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
                    .map(|clients| clients.failure(&self.0[0], &self.2))
                    .unwrap_or_else(|| "NotObserved".into()),
                (self.4.server, after.server),
                (self.4.fresh_control, after.fresh_control)
            )
        }
    }
    #[test]
    fn wait_categories_never_publish_symbols_or_oversized_input() {
        for (input, expected) in [
            (b"pipe_read".as_slice(), WaitKind::PipeRead),
            (b"pipe_write\n", WaitKind::PipeWrite),
            (b"do_epoll_wait", WaitKind::EventWait),
            (b"ep_poll", WaitKind::EventWait),
            (b"poll_schedule_timeout.constprop.0", WaitKind::EventWait),
            (b"0", WaitKind::Unavailable),
            (b"", WaitKind::Unavailable),
            (b"private-symbol/path/12345", WaitKind::Other),
            (&[b'x'; 129], WaitKind::Unavailable),
        ] {
            let result = parse_wait(input);
            assert_eq!(result, expected);
            assert!(!format!("{result:?}").contains("private"));
        }
    }
    #[test]
    fn wait_probe_requires_a_stable_live_owned_identity_around_the_read() {
        let identity = ClientIdentity {
            pid: 100,
            start: 20,
        };
        let observed = |start, parent, state| Sample::Observed {
            start,
            parent,
            state,
        };
        let valid = observed(20, 30, 'S');
        for changed in [
            Sample::Missing,
            Sample::Unowned,
            Sample::Invalid,
            Sample::Unavailable(io::ErrorKind::PermissionDenied),
            observed(21, 30, 'S'),
            observed(20, 31, 'S'),
            observed(20, 30, 'Z'),
        ] {
            let mut snapshots = [valid, changed].into_iter();
            assert_eq!(
                wait_probe(
                    identity,
                    |_| snapshots.next().unwrap(),
                    |_| WaitKind::PipeRead
                ),
                WaitKind::Unavailable
            );
        }
        for rejected in [
            Sample::Missing,
            Sample::Unowned,
            observed(21, 30, 'S'),
            observed(20, 30, 'Z'),
        ] {
            assert_eq!(
                wait_probe(identity, |_| rejected, |_| panic!("unadmitted wait read")),
                WaitKind::Unavailable
            );
        }
        assert_eq!(
            wait_probe(identity, |_| valid, |_| WaitKind::PipeRead),
            WaitKind::PipeRead
        );
        assert_eq!(
            wait_probe(identity, |_| valid, |_| WaitKind::Unavailable),
            WaitKind::Unavailable
        );
        assert_eq!(
            wait_probe(
                ClientIdentity { pid: 1, ..identity },
                |_| panic!("PID one must not be read"),
                |_| panic!("PID one must not be opened")
            ),
            WaitKind::Unavailable
        );
    }
    #[test]
    fn lifetime_ordinals_require_unique_verified_control_identities() {
        let row = |pid, start, control| Client {
            pid,
            control,
            written: 0,
            discarded: 0,
            original: Sample::Observed {
                start,
                state: 'S',
                parent: 1,
            },
        };
        let mut lifetimes = Lifetimes::default();
        lifetimes.remember(
            0,
            &Clients(Ok(vec![row(100, 20, true), row(200, 30, false)])),
        );
        lifetimes.remember(
            1,
            &Clients(Ok(vec![row(100, 20, true), row(300, 40, true)])),
        );
        let observed = |start| Sample::Observed {
            start,
            state: 'S',
            parent: 1,
        };
        for (pid, start, expected) in [(100, 20, Some(0)), (300, 40, Some(1)), (400, 50, None)] {
            assert_eq!(
                lifetimes.ordinal(&row(pid, start, true), observed(start)),
                expected
            );
        }
        assert_eq!(lifetimes.ordinal(&row(100, 21, true), observed(21)), None);
        assert_eq!(lifetimes.ordinal(&row(100, 20, true), observed(21)), None);
        assert_eq!(lifetimes.ordinal(&row(100, 20, false), observed(20)), None);
        assert_eq!(
            lifetimes.ordinal(&row(100, 20, true), Sample::Missing),
            None
        );
        let private = Client {
            original: Sample::Unowned,
            ..row(100, 20, true)
        };
        assert_eq!(lifetimes.ordinal(&private, observed(20)), None);
        let receipt = Clients(Ok(vec![private]))
            .failure(&(i32::MAX, Sample::Missing, Sample::Missing), &lifetimes);
        assert!(receipt.contains("None"));
        assert!(!receipt.contains("100"));
    }

    #[test]
    fn lifetime_ambiguity_and_failed_samples_never_guess_or_keep_old_labels() {
        let row = |pid, sample| Client {
            pid,
            control: true,
            written: 0,
            discarded: 0,
            original: sample,
        };
        let observed = Sample::Observed {
            start: 20,
            state: 'S',
            parent: 1,
        };
        let unique = || Clients(Ok(vec![row(100, observed)]));
        let mut lifetimes = Lifetimes::default();
        lifetimes.remember(1, &unique());
        assert!(lifetimes.0.iter().all(Option::is_none));
        for sample in [
            Clients(Err("Deadline")),
            Clients(Ok(vec![])),
            Clients(Ok(vec![row(100, observed), row(200, observed)])),
            Clients(Ok(vec![row(100, observed), row(200, Sample::Unowned)])),
        ] {
            lifetimes.remember(0, &unique());
            lifetimes.remember(0, &sample);
            assert!(lifetimes.0[0].is_none());
        }
        lifetimes.remember(0, &unique());
        lifetimes.remember(1, &unique());
        assert!(lifetimes.0[1].is_none());
        lifetimes.remember(2, &unique());
        assert!(lifetimes.0[1].is_none());
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
        let receipt = Clients(Err("Invalid")).failure(
            &(i32::MAX, Sample::Missing, Sample::Missing),
            &Lifetimes::default(),
        );
        assert_eq!(receipt, "clients(index,control,written,discarded,state,lifetime)=Invalid; children=ServerIdentityUnavailable");
    }
    #[tokio::test]
    async fn lifetime_snapshots_correlate_real_owned_processes_without_pid_output() {
        let server = std::process::id() as i32;
        let mut child = Observer(Some(
            std::process::Command::new("/bin/sleep")
                .arg("10")
                .spawn()
                .unwrap(),
        ));
        let fresh = child.0.as_ref().unwrap().id() as i32;
        let command = |include_fresh| {
            let mut command = std::process::Command::new("/bin/sh");
            let mut rows = format!("{server}\n{server}:1:0:0\n");
            if include_fresh {
                rows.push_str(&format!("{fresh}:1:0:0\n"));
            }
            command
                .args(["-c", "printf '%s' \"$1\"", "owned-observer"])
                .arg(rows);
            command
        };
        let mut observations = Processes::capture(&[server]);
        observations.remember_clients(0, command(false)).await;
        observations.remember_clients(1, command(true)).await;
        observations.clients(command(true)).await;
        let receipt = observations.failure();
        assert!(receipt.contains("Some(0)"));
        assert!(receipt.contains("Some(1)"));
        assert!(!receipt.contains(&server.to_string()));
        assert!(!receipt.contains(&fresh.to_string()));
        child.0.as_mut().unwrap().kill().unwrap();
        child.0.take().unwrap().wait().unwrap();
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
    pub(super) fn remember_ssh_anchor(&mut self, pid: i32) {
        #[cfg(target_os = "linux")]
        self.inner.remember_ssh_anchor(pid);
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
    }
    pub(super) fn fresh_peer(&self) -> String {
        #[cfg(target_os = "linux")]
        return self.inner.fresh_peer();
        #[cfg(not(target_os = "linux"))]
        "Unsupported".into()
    }
    pub(super) async fn remember_clients(
        &mut self,
        ordinal: usize,
        command: std::process::Command,
    ) {
        #[cfg(target_os = "linux")]
        self.inner.remember_clients(ordinal, command).await;
        #[cfg(not(target_os = "linux"))]
        let _ = (ordinal, command);
    }
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
