//! `lazysh-agent herdr-events` against an owned fake socket, and against an owned real Herdr server
//! (ignored: it needs `herdr` on PATH). Never a user Herdr server.
#![cfg(unix)]
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixListener,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
#[path = "support/binary.rs"]
mod binary;
#[path = "support/fake_herdr.rs"]
mod fake_herdr;

/// The child's frames, read on a thread so a test can wait for one with a deadline.
struct Frames {
    child: Child,
    frames: Receiver<Value>,
    stderr: Arc<Mutex<String>>,
}
impl Frames {
    fn start(mut command: Command) -> Self {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = Arc::new(Mutex::new(String::new()));
        let (log, mut pipe) = (stderr.clone(), child.stderr.take().unwrap());
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = pipe.read_to_string(&mut text);
            *log.lock().unwrap() = text;
        });
        let (sender, frames) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = sender.send(serde_json::from_str(&line).expect("one JSON frame per line"));
            }
        });
        Self {
            child,
            frames,
            stderr,
        }
    }
    /// The next non-heartbeat frame, or a panic naming what was missing.
    fn next(&self, within: Duration) -> Value {
        let deadline = Instant::now() + within;
        loop {
            let frame = self
                .frames
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| {
                    panic!(
                        "no frame within the bound; stderr: {}",
                        self.stderr.lock().unwrap()
                    )
                });
            if frame["type"] != "heartbeat" {
                return frame;
            }
        }
    }
    /// The next frame that reports a status.
    fn next_status(&self, within: Duration) -> Value {
        let deadline = Instant::now() + within;
        loop {
            let frame = self.next(deadline.saturating_duration_since(Instant::now()));
            if frame["type"] == "status" {
                return frame;
            }
        }
    }
    /// Closing stdin is how the app ends the stream.
    fn finish(mut self) -> std::process::ExitStatus {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "the stream did not end when stdin closed"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Frames {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `program` with nothing inherited but the home that holds its config, so it cannot reach a user's Herdr.
fn isolated(program: impl AsRef<std::ffi::OsStr>, home: &Path, path: &std::ffi::OsStr) -> Command {
    let mut command = Command::new(program);
    command
        .env_clear()
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home)
        .env("HERDR_CONFIG_PATH", home.join("config.toml"))
        .env("PATH", path)
        .env("SHELL", "/bin/sh")
        .current_dir(home);
    command
}
fn companion(home: &Path, path: &std::ffi::OsStr, session: &str) -> Command {
    let mut command = isolated(binary::path(), home, path);
    command.args(["herdr-events", "--session", session]);
    command
}

#[test]
fn the_binary_streams_a_blocked_agent_from_the_owned_socket_and_ends_with_stdin() {
    let (directory, socket) = fake_herdr::owned("owned");
    let listener = UnixListener::bind(&socket).unwrap();
    let pane = json!({"pane_id":"w1:p1","workspace_id":"w1","agent_status":"working","cwd":"/work/project","title":"fixture-private-command"});
    let snapshot = json!({"id":"lazysh:snapshot","result":{"type":"session_snapshot","snapshot":{
        "panes":[pane],"agents":[{"pane_id":"w1:p1","agent":"claude"}]}}});
    let server = std::thread::spawn(move || {
        // Every connection has its own thread: the subscription stays open beside the snapshots.
        let mut handlers = Vec::new();
        for connection in listener.incoming().take(3) {
            let (mut stream, snapshot) = (connection.unwrap(), snapshot.clone());
            handlers.push(std::thread::spawn(move || {
                let request = fake_herdr::request(&stream);
                if request["method"] == "session.snapshot" {
                    return writeln!(stream, "{snapshot}").unwrap();
                }
                assert_eq!(request["method"], "events.subscribe");
                writeln!(
                    stream,
                    "{}",
                    json!({"id":"lazysh:events","result":{"type":"subscription_started"}})
                )
                .unwrap();
                let event = json!({"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","workspace_id":"w1",
                    "agent_status":"blocked","agent":"claude","title":"fixture-private-command"}});
                writeln!(stream, "{event}").unwrap();
                // Hold the subscription open until the companion goes away.
                let _ = BufReader::new(stream).read_line(&mut String::new());
            }));
        }
        for handler in handlers {
            handler.join().unwrap();
        }
    });
    let frames = Frames::start(companion(
        directory.path(),
        directory.path().as_os_str(),
        "owned",
    ));
    assert_eq!(
        frames.next(Duration::from_secs(5)),
        json!({"type":"hello","protocol":1,"session":"owned"})
    );
    assert_eq!(
        frames.next(Duration::from_secs(5)),
        json!({"type":"status","paneId":"w1:p1","workspaceId":"w1","status":"blocked","agent":"claude","cwd":"/work/project"})
    );
    let status = frames.finish();
    assert!(status.success());
    server.join().unwrap();
}

#[test]
fn an_unknown_session_fails_with_a_class_and_no_frame() {
    let directory = tempfile::tempdir().unwrap();
    fake_herdr::install(
        directory.path(),
        "other",
        &directory.path().join("other.sock"),
    );
    let output = companion(directory.path(), directory.path().as_os_str(), "owned")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr).trim(),
        "lazysh-agent: HerdrFocusInvalid: operation failed"
    );
}

/// An isolated headless server: its own HOME, config and socket.
struct Server {
    home: tempfile::TempDir,
    path: std::ffi::OsString,
    child: Child,
}
impl Server {
    fn command(&self) -> Command {
        isolated("herdr", self.home.path(), &self.path)
    }
    fn herdr(&self, args: &[&str]) -> Vec<u8> {
        let output = self.command().args(args).output().unwrap();
        assert!(
            output.status.success(),
            "herdr {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }
    fn start() -> Self {
        let home = tempfile::tempdir().unwrap();
        // Pin the built-in rules; never fetch a newer catalog.
        fs::write(
            home.path().join("config.toml"),
            "[update]\nversion_check = false\nmanifest_check = false\n",
        )
        .unwrap();
        let path = std::env::var_os("PATH").unwrap_or_default();
        let child = isolated("herdr", home.path(), &path)
            .arg("server")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let server = Self { home, path, child };
        let ready = (0..200).any(|_| {
            let ready = server
                .command()
                .args(["api", "snapshot"])
                .output()
                .unwrap()
                .status
                .success();
            if !ready {
                std::thread::sleep(Duration::from_millis(25));
            }
            ready
        });
        assert!(ready, "the isolated Herdr server did not become ready");
        server
    }
    fn report(&self, pane: &str, state: &str) {
        self.herdr(&[
            "pane",
            "report-agent",
            pane,
            "--source",
            "lazysh-test",
            "--agent",
            "codex",
            "--state",
            state,
        ]);
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.command().args(["server", "stop"]).output();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "requires herdr on PATH; runs an isolated headless server"]
fn real_herdr_reports_a_stub_agent_turning_blocked_and_done_within_a_bound() {
    let server = Server::start();
    // The second workspace is not shown, so an agent that stops there is `done`, not `idle`.
    for label in ["shown", "background"] {
        server.herdr(&[
            "workspace",
            "create",
            "--label",
            label,
            "--cwd",
            server.home.path().to_str().unwrap(),
        ]);
    }
    let hidden =
        lazysh_common::test_support::unfocused_herdr_pane(&server.herdr(&["api", "snapshot"]));
    let pane = hidden["pane_id"].as_str().unwrap();
    server.report(pane, "working");
    let frames = Frames::start(companion(server.home.path(), &server.path, "default"));
    assert_eq!(
        frames.next(Duration::from_secs(10)),
        json!({"type":"hello","protocol":1,"session":"default"})
    );
    let expected = |status: &str| json!({"type":"status","paneId":pane,"workspaceId":hidden["workspace_id"],"status":status,"agent":"codex","cwd":hidden["cwd"]});
    server.report(pane, "blocked");
    assert_eq!(
        frames.next_status(Duration::from_secs(10)),
        expected("blocked")
    );
    server.report(pane, "idle");
    assert_eq!(
        frames.next_status(Duration::from_secs(10)),
        expected("done")
    );
    assert!(frames.finish().success());
}
