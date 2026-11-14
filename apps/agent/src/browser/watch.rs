//! `browser-watch`: a long-lived exec channel for the app. It listens on the per-user socket
//! and prints one JSON frame per line (`hello`, `open`, `heartbeat`, `end`) until its stdin
//! closes, like the other channel commands.
use super::{listeners, socket, url};
use crate::{Error, Result};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

const OPENS_PER_MINUTE: usize = 6;
const DUPLICATE_WINDOW: Duration = Duration::from_secs(10);
const QUEUE: usize = 8;
const EXPIRY: Duration = Duration::from_secs(120);
const HANDLERS: usize = 128;
const REQUEST: u64 = 8192;
const ANCESTORS: usize = 6;
// sockaddr_un.sun_path is 104 bytes on macOS and 108 on Linux; leave room for the staging suffix.
const MAX_SOCKET_PATH: usize = 90;

enum Admission {
    New,
    Duplicate,
    Rejected(&'static str),
}
#[derive(Default)]
struct Limits {
    accepted: VecDeque<Instant>,
    recent: HashMap<String, Instant>,
}
impl Limits {
    fn admit(&mut self, url: &str, now: Instant, queued: usize) -> Admission {
        self.recent
            .retain(|_, at| now.duration_since(*at) < DUPLICATE_WINDOW);
        while self
            .accepted
            .front()
            .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60))
        {
            self.accepted.pop_front();
        }
        if self.recent.contains_key(url) {
            Admission::Duplicate
        } else if self.accepted.len() >= OPENS_PER_MINUTE {
            Admission::Rejected("rate-limited")
        } else if queued >= QUEUE {
            Admission::Rejected("queue-full")
        } else {
            self.recent.insert(url.to_owned(), now);
            self.accepted.push_back(now);
            Admission::New
        }
    }
}

struct Open {
    id: String,
    url: String,
    launcher: String,
    pid: u32,
    chain: Vec<(u32, String)>,
    queued_at: Instant,
    at: String,
}
enum Event {
    Open(Open),
    StdinClosed,
    Terminated,
}
struct Shared {
    uid: u32,
    limits: Mutex<Limits>,
    queued: AtomicUsize,
    handlers: AtomicUsize,
    events: mpsc::SyncSender<Event>,
}
#[derive(Deserialize)]
struct Request {
    v: u8,
    op: String,
    url: Option<String>,
    pid: Option<u32>,
    #[serde(rename = "as")]
    launcher: Option<String>,
}

fn rejected(reason: &str) -> Value {
    json!({"ok": false, "reason": reason})
}
fn plain_name(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
        .take(32)
        .collect()
}

/// "ppid comm" as `ps -o ppid= -o comm=` prints it; macOS has no /proc.
fn parse_ps(text: &str) -> Option<(String, u32)> {
    let (parent, name) = text.trim().split_once(char::is_whitespace)?;
    Some((
        plain_name(name.trim().rsplit('/').next()?),
        parent.parse().ok()?,
    ))
}

/// Name and parent of a process, from /proc or, where there is none, from `ps`.
fn describe(pid: u32) -> Option<(String, u32)> {
    if pid <= 1 {
        return None;
    }
    if std::path::Path::new("/proc/self/stat").exists() {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // "pid (comm) state ppid ...": comm may hold spaces and parentheses.
        let (head, tail) = stat.rsplit_once(')')?;
        let parent = tail.split_whitespace().nth(1)?.parse().ok()?;
        return Some((plain_name(head.split_once('(')?.1), parent));
    }
    let output = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    parse_ps(&String::from_utf8(output.stdout).ok()?)
}

/// Processes from the launcher's parent upward, so the app can say which command wanted a
/// browser. Names only, never arguments.
fn chain(launcher: u32) -> Vec<(u32, String)> {
    let mut ancestors = Vec::new();
    let mut current = describe(launcher).map_or(0, |(_, parent)| parent);
    while current > 1 && ancestors.len() < ANCESTORS {
        let Some((name, parent)) = describe(current) else {
            break;
        };
        ancestors.push((current, name));
        current = parent;
    }
    ancestors
}

impl Shared {
    fn answer(&self, request: Request) -> Value {
        if request.op == "probe" {
            return json!({"ok": true, "watcher": true});
        }
        let Some(url) = request
            .url
            .filter(|url| request.op == "open" && url::valid(url))
        else {
            return rejected("invalid");
        };
        let now = Instant::now();
        let admission = self
            .limits
            .lock()
            .map(|mut limits| limits.admit(&url, now, self.queued.load(Ordering::SeqCst)));
        match admission {
            Ok(Admission::New) => {}
            Ok(Admission::Duplicate) => return json!({"ok": true, "duplicate": true}),
            Ok(Admission::Rejected(reason)) => return rejected(reason),
            Err(_) => return rejected("failed"),
        }
        // The launcher is still waiting for this answer, so its ancestry can still be read.
        let pid = request.pid.filter(|pid| *pid > 1).unwrap_or(0);
        let open = Open {
            id: uuid::Uuid::new_v4().to_string(),
            url,
            launcher: plain_name(&request.launcher.unwrap_or_default()),
            pid,
            chain: chain(pid),
            queued_at: now,
            at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        };
        self.queued.fetch_add(1, Ordering::SeqCst);
        if self.events.try_send(Event::Open(open)).is_err() {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            return rejected("queue-full");
        }
        json!({"ok": true})
    }
}

fn handle(stream: UnixStream, shared: &Shared) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    if socket::peer_uid(&stream)? != shared.uid {
        return Ok(());
    }
    let mut line = Vec::new();
    BufReader::new((&stream).take(REQUEST)).read_until(b'\n', &mut line)?;
    let reply = match serde_json::from_slice::<Request>(&line) {
        Ok(request) if request.v == super::PROTOCOL => shared.answer(request),
        _ => rejected("invalid"),
    };
    writeln!(&stream, "{reply}")
}

/// Our socket file, recognised by inode so a watcher that attached later is noticed.
struct Bound {
    path: PathBuf,
    id: (u64, u64),
}
impl Bound {
    fn mine(&self) -> bool {
        fs::symlink_metadata(&self.path).is_ok_and(|m| (m.dev(), m.ino()) == self.id)
    }
}
impl Drop for Bound {
    fn drop(&mut self) {
        if self.mine() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Bind beside the final name and rename over it: the last watcher to attach wins atomically.
fn bind() -> Result<(UnixListener, Bound)> {
    let directory = socket::create()?;
    let path = directory.join(socket::NAME);
    if path.as_os_str().len() > MAX_SOCKET_PATH {
        return Err(Error::Browser("BrowserSocketPathTooLong"));
    }
    let staging = directory.join(format!("{}.{}", socket::NAME, std::process::id()));
    let _ = fs::remove_file(&staging);
    let listener = UnixListener::bind(&staging)?;
    let published = fs::set_permissions(&staging, fs::Permissions::from_mode(0o600))
        .and_then(|()| fs::rename(&staging, &path))
        .and_then(|()| fs::symlink_metadata(&path));
    match published {
        Ok(metadata) => Ok((
            listener,
            Bound {
                path,
                id: (metadata.dev(), metadata.ino()),
            },
        )),
        Err(error) => {
            let _ = fs::remove_file(&staging);
            Err(error.into())
        }
    }
}

fn emit(frame: &Value) -> io::Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{frame}")?;
    out.flush()
}

fn spawn(work: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().spawn(work);
}

pub(super) fn run(heartbeat: Duration) -> Result<()> {
    let (listener, bound) = bind()?;
    let (events, inbox) = mpsc::sync_channel(QUEUE * 2);
    let shared = Arc::new(Shared {
        uid: socket::euid(),
        limits: Mutex::default(),
        queued: AtomicUsize::new(0),
        handlers: AtomicUsize::new(0),
        events: events.clone(),
    });
    let stopped = events.clone();
    ctrlc::set_handler(move || {
        let _ = stopped.send(Event::Terminated);
    })
    .map_err(|_| Error::Browser("BrowserSignalHandler"))?;
    let closed = events;
    spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        let _ = closed.send(Event::StdinClosed);
    });
    let acceptor = shared.clone();
    spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            };
            // Beyond the cap a connection is dropped and its launcher falls back to the real opener.
            if acceptor.handlers.fetch_add(1, Ordering::SeqCst) >= HANDLERS {
                acceptor.handlers.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let shared = acceptor.clone();
            spawn(move || {
                let _ = handle(stream, &shared);
                shared.handlers.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    let hello = json!({"type": "hello", "protocol": super::PROTOCOL, "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id()});
    if emit(&hello).is_err() {
        return Ok(());
    }
    let reason = loop {
        match inbox.recv_timeout(heartbeat) {
            Ok(Event::Open(open)) => {
                shared.queued.fetch_sub(1, Ordering::SeqCst);
                if open.queued_at.elapsed() >= EXPIRY {
                    continue;
                }
                let names: Vec<&String> = open.chain.iter().map(|(_, name)| name).collect();
                let frame = json!({"type": "open", "id": open.id, "url": open.url, "launcher": open.launcher, "pid": open.pid, "chain": names, "listeners": listeners::of(&open.chain), "at": open.at});
                if emit(&frame).is_err() {
                    return Ok(());
                }
            }
            Ok(Event::StdinClosed) => break "stdin-closed",
            Ok(Event::Terminated) => break "terminated",
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !bound.mine() {
                    break "replaced";
                }
                if emit(&json!({"type": "heartbeat", "at": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)})).is_err() {
                    return Ok(());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break "failed",
        }
    };
    let _ = emit(&json!({"type": "end", "reason": reason}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared(uid: u32) -> (Arc<Shared>, mpsc::Receiver<Event>) {
        let (events, inbox) = mpsc::sync_channel(QUEUE * 2);
        let shared = Shared {
            uid,
            limits: Mutex::default(),
            queued: AtomicUsize::new(0),
            handlers: AtomicUsize::new(0),
            events,
        };
        (Arc::new(shared), inbox)
    }
    fn ask(shared: &Shared, message: &str) -> String {
        let (client, server) = UnixStream::pair().unwrap();
        (&client).write_all(message.as_bytes()).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        handle(server, shared).unwrap();
        let mut reply = String::new();
        // A refused peer is closed with its request unread, which may surface as a reset.
        let _ = BufReader::new(client).read_line(&mut reply);
        reply
    }

    #[test]
    fn a_peer_with_another_uid_gets_no_answer_and_queues_nothing() {
        let (shared, inbox) = shared(socket::euid() + 1);
        assert_eq!(
            ask(
                &shared,
                "{\"v\":1,\"op\":\"open\",\"url\":\"https://example.com/\"}\n"
            ),
            ""
        );
        assert!(inbox.try_recv().is_err());
    }

    #[test]
    fn malformed_and_foreign_requests_are_refused_and_a_valid_one_is_queued() {
        let (shared, inbox) = shared(socket::euid());
        for message in [
            "not json\n",
            "",
            "{\"v\":2,\"op\":\"open\",\"url\":\"https://example.com/\"}\n",
            "{\"v\":1,\"op\":\"open\"}\n",
            "{\"v\":1,\"op\":\"open\",\"url\":\"file:///etc/passwd\"}\n",
            "{\"v\":1,\"op\":\"shell\",\"url\":\"https://example.com/\"}\n",
        ] {
            assert!(
                ask(&shared, message).contains("\"ok\":false"),
                "{message:?}"
            );
        }
        assert!(inbox.try_recv().is_err());
        let reply = ask(
            &shared,
            "{\"v\":1,\"op\":\"open\",\"url\":\"https://example.com/\",\"x\":1}",
        );
        assert_eq!(reply.trim(), "{\"ok\":true}");
        assert!(matches!(inbox.try_recv(), Ok(Event::Open(_))));
        assert_eq!(
            ask(&shared, "{\"v\":1,\"op\":\"probe\"}").trim(),
            "{\"ok\":true,\"watcher\":true}"
        );
        assert!(inbox.try_recv().is_err());
    }

    #[test]
    fn limits_apply_in_order_and_expire() {
        let mut limits = Limits::default();
        let start = Instant::now();
        assert!(matches!(
            limits.admit("https://a/", start, 0),
            Admission::New
        ));
        assert!(matches!(
            limits.admit("https://a/", start + Duration::from_secs(9), 0),
            Admission::Duplicate
        ));
        assert!(matches!(
            limits.admit("https://a/", start + Duration::from_secs(10), 0),
            Admission::New
        ));
        for n in 0..4 {
            assert!(matches!(
                limits.admit(
                    &format!("https://b{n}/"),
                    start + Duration::from_secs(11),
                    0
                ),
                Admission::New
            ));
        }
        assert!(matches!(
            limits.admit("https://c/", start + Duration::from_secs(12), 0),
            Admission::Rejected("rate-limited")
        ));
        let later = start + Duration::from_secs(61);
        assert!(matches!(
            limits.admit("https://c/", later, QUEUE),
            Admission::Rejected("queue-full")
        ));
        assert!(matches!(
            limits.admit("https://c/", later, 0),
            Admission::New
        ));
    }

    #[test]
    fn ancestry_starts_at_the_parent_and_keeps_names_plain() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let names: Vec<String> = chain(child.id())
            .into_iter()
            .map(|(_, name)| name)
            .collect();
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(
            names.first(),
            describe(std::process::id()).map(|(name, _)| name).as_ref()
        );
        assert!(
            names.len() <= ANCESTORS && names.iter().all(|n| n.len() <= 32 && !n.contains(' '))
        );
    }

    #[test]
    fn ps_output_is_parsed_like_proc() {
        assert_eq!(
            parse_ps("  4242 /usr/bin/python3\n"),
            Some(("python3".into(), 4242))
        );
        assert_eq!(parse_ps("1 -zsh\n"), Some(("-zsh".into(), 1)));
        assert_eq!(parse_ps(""), None);
        assert_eq!(parse_ps("x python"), None);
    }
}
