// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Owned native process/PTY acceptance. No user server, account, network provider
//! or process inventory is used. Only explicitly spawned child PIDs are stopped.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

const BOUND: Duration = Duration::from_secs(5);
const SOURCE: &str = "abababababababababababababababababababababababababababababababab";
const PREFIX: &[u8] = b"\x1eLAZYSH-GUARD-1:";

struct Fixture {
    base: PathBuf,
    children: Vec<Child>,
}
impl Fixture {
    fn new() -> Self {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).unwrap();
        let base = PathBuf::from("/tmp").join(format!(
            "lhg283-{}-{:x}",
            std::process::id(),
            u64::from_le_bytes(random)
        ));
        fs::create_dir(&base).unwrap();
        fs::write(base.join("config.toml"), "onboarding = false\n[terminal]\ndefault_shell = '/bin/sh'\nshell_mode = 'non_login'\n[update]\nversion_check = false\nmanifest_check = false\n").unwrap();
        Self {
            base,
            children: Vec::new(),
        }
    }

    fn enabled_catalog_with_owned_ssh(&self) -> std::net::TcpListener {
        let endpoint = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        endpoint.set_nonblocking(true).unwrap();
        let target = format!(
            "ssh://owned-fixture@127.0.0.1:{}",
            endpoint.local_addr().unwrap().port()
        );
        let client = self.base.join("state/herdr-dev/client");
        fs::create_dir_all(&client).unwrap();
        fs::write(client.join("endpoints.json"), serde_json::to_vec(&json!({"version":1,"ssh":[{"id":"ab".repeat(16),"label":"Owned forbidden catalog","target":target,"session":"unused","enabled":true}]})).unwrap()).unwrap();
        let bin = self.base.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let executable = PathBuf::from(std::env::var_os("HERDR_GUARD_SSH_FIXTURE").expect(
            "build the current-source guarded_ssh_fixture example and pass its explicit path",
        ));
        assert!(executable.is_absolute() && executable.is_file());
        std::os::unix::fs::symlink(&executable, bin.join("ssh")).unwrap();
        let marker = self.base.join("ssh-attempted");
        let mut child = Command::new(executable)
            .env_clear()
            .env("HERDR_GUARD_SSH_MARKER", &marker)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + BOUND;
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owned native SSH fixture deadline");
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(status.code(), Some(88));
        assert_eq!(fs::read(&marker).unwrap(), b"attempted");
        fs::remove_file(marker).unwrap();
        endpoint
    }

    fn environment(&self) -> Vec<(&'static str, PathBuf)> {
        [
            ("HOME", "home"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_RUNTIME_DIR", "runtime"),
        ]
        .into_iter()
        .map(|(name, child)| (name, self.base.join(child)))
        .collect()
    }

    fn command(&self, session: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_herdr"));
        command
            .env_clear()
            .envs(self.environment())
            .env("HERDR_CONFIG_PATH", self.base.join("config.toml"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.base.join("bin").display()),
            )
            .env("SHELL", "/bin/sh")
            .env("TERM", "xterm-256color")
            .env("LANG", "C.UTF-8")
            .env("HERDR_DISABLE_SOUND", "1")
            .env("HERDR_GUARD_SSH_MARKER", self.base.join("ssh-attempted"))
            .args(["--session", session])
            .current_dir(self.base.join(session));
        command
    }

    fn data(&self, session: &str) -> PathBuf {
        self.base
            .join("config")
            .join(if cfg!(debug_assertions) {
                "herdr-dev"
            } else {
                "herdr"
            })
            .join("sessions")
            .join(session)
    }

    fn start(&mut self, session: &str) {
        for (_, path) in self.environment() {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir(self.base.join(session)).unwrap();
        fs::create_dir_all(self.data(session)).unwrap();
        let mut saved: Value = serde_json::from_slice(include_bytes!(
            "../herdr-upstream/tests/fixtures/session/current-herdr-session.json"
        ))
        .unwrap();
        for workspace in saved["workspaces"].as_array_mut().unwrap() {
            workspace["identity_cwd"] = json!(self.base.join(session));
            for tab in workspace["tabs"].as_array_mut().unwrap() {
                for pane in tab["panes"].as_object_mut().unwrap().values_mut() {
                    pane["cwd"] = json!(self.base.join(session));
                }
            }
        }
        fs::write(
            self.data(session).join("session.json"),
            serde_json::to_vec(&saved).unwrap(),
        )
        .unwrap();
        assert!(
            self.data(session)
                .join("herdr-client.sock")
                .as_os_str()
                .as_encoded_bytes()
                .len()
                < 100,
            "owned Unix socket path budget"
        );
        let error_log = fs::File::create(self.base.join(format!("{session}.log"))).unwrap();
        let child = self
            .command(session)
            .arg("server")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(error_log)
            .spawn()
            .unwrap();
        self.children.push(child);
        crate::support::wait_for_socket(&self.data(session).join("herdr.sock"), BOUND);
        let snapshot = self.api(session, "session.snapshot", json!({}));
        let pane = snapshot["result"]["snapshot"]["focused_pane_id"]
            .as_str()
            .unwrap();
        let result = self.api(session, "pane.send_input", json!({"pane_id":pane,"text":"stty raw -echo; : > guard-ready; exec cat > guard-bytes","keys":["Enter"]}));
        assert!(result.get("error").is_none(), "owned workload setup failed");
        crate::support::wait_for_file(&self.base.join(session).join("guard-ready"), BOUND);
    }

    fn request(&self, session: &str, method: &str, params: Value) -> UnixStream {
        let mut stream = UnixStream::connect(self.data(session).join("herdr.sock")).unwrap();
        stream.set_read_timeout(Some(BOUND)).unwrap();
        stream.set_write_timeout(Some(BOUND)).unwrap();
        serde_json::to_writer(
            &mut stream,
            &json!({"id":"guard-test","method":method,"params":params}),
        )
        .unwrap();
        stream.write_all(b"\n").unwrap();
        stream
    }

    fn answer(stream: UnixStream) -> Value {
        let mut line = String::new();
        BufReader::new(stream)
            .take(32769)
            .read_line(&mut line)
            .unwrap();
        assert!(line.len() <= 32768, "owned response exceeded bound");
        serde_json::from_str(&line).unwrap()
    }

    fn api(&self, session: &str, method: &str, params: Value) -> Value {
        Self::answer(self.request(session, method, params))
    }

    async fn guarded_cli(&self, session: &str, method: &str, params: Value) -> Value {
        use tokio::io::AsyncReadExt as _;
        use tokio::io::AsyncWriteExt as _;
        let body = serde_json::to_vec(&json!({"id":"guard-test","method":method,"params":params}))
            .unwrap();
        assert!(body.len() <= 32768);
        let mut command = tokio::process::Command::from(self.command(session));
        command
            .args(["api", "guarded"])
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in ["boot", "ticket", "ownership", "receipt"] {
            if let Some(secret) = params[key].as_str() {
                assert!(!command.as_std().get_args().any(|arg| arg
                    .as_encoded_bytes()
                    .windows(secret.len())
                    .any(|bytes| bytes == secret.as_bytes())));
            }
        }
        let mut child = command.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (status, output, errors) = tokio::time::timeout(BOUND, async {
            stdin.write_all(&body).await?;
            drop(stdin);
            let output = async move {
                let mut bytes = Vec::new();
                stdout.take(32769).read_to_end(&mut bytes).await?;
                Ok::<_, std::io::Error>(bytes)
            };
            let errors = async move {
                let mut bytes = Vec::new();
                stderr.take(32769).read_to_end(&mut bytes).await?;
                Ok::<_, std::io::Error>(bytes)
            };
            tokio::try_join!(child.wait(), output, errors)
        })
        .await
        .expect("owned stdin CLI deadline")
        .unwrap();
        assert!(
            output.len() <= 32768 && errors.len() <= 32768,
            "owned stdin CLI output bound"
        );
        serde_json::from_slice(if status.success() { &output } else { &errors })
            .expect("owned stdin CLI structured response")
    }

    fn bytes(&self, session: &str) -> Vec<u8> {
        fs::read(self.base.join(session).join("guard-bytes")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let count = self.children.len();
        let mut reaped = 0;
        for child in &mut self.children {
            let _ = child.kill();
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if let Ok(Some(status)) = child.try_wait() {
                    eprintln!("owned server exit: {status}");
                    reaped += 1;
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
        eprintln!("owned server cleanup: {reaped}/{count} reaped");
        if thread::panicking() || reaped != count {
            eprintln!("retained owned diagnostics: {}", self.base.display());
        } else {
            let _ = fs::remove_dir_all(&self.base);
        }
        if !thread::panicking() {
            assert_eq!(reaped, count, "owned server cleanup deadline");
        }
    }
}

struct Peer {
    stream: UnixStream,
    registration: Value,
    projection: Value,
    ownership: Value,
    preparation: u64,
    painted: bool,
}
impl Peer {
    fn attach(fixture: &Fixture, session: &str, nonce: &str) -> Self {
        let stream = UnixStream::connect(fixture.data(session).join("herdr-client.sock")).unwrap();
        stream.set_read_timeout(Some(BOUND)).unwrap();
        stream.set_write_timeout(Some(BOUND)).unwrap();
        let mut peer = Self {
            stream,
            registration: Value::Null,
            projection: Value::Null,
            ownership: Value::Null,
            preparation: 0,
            painted: false,
        };
        peer.control(
            "endpoint.hello.v1",
            json!({
                "generation":1,"cell_width_px":8,"cell_height_px":16,
                "surface_size":{"cols":80,"rows":24},"pixel_mouse":false,"direct_graphics":false,
                "endpoint_keybindings":false,"mouse_capture":false,"guard_nonce":nonce,
                "snapshot_codecs":["shell.snapshot.v1"],"surface_codecs":["shell.surface.v1"],
                "input_codecs":["shell.input.semantic.v1"],"blob_codecs":["shell.blob.v1"]
            }),
        );
        let welcome = peer.next_control("endpoint.welcome.v1");
        assert!(welcome["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "lazysh.guarded-input.v1"));
        peer.registration = peer.next_control("lazysh.guard.registered.v1");
        assert!(peer.registration["nonce"] == nonce);
        peer.projection = peer.next_control("shell.snapshot.v1");
        peer.wait_view(None);
        peer.ownership = claim(fixture, session, &peer.registration);
        peer
    }

    fn control(&mut self, kind: &str, value: Value) {
        let mut body = vec![20]; // Existing EndpointControl variant, protocol generation 1.
        body.extend(
            bincode::serde::encode_to_vec((kind, value.to_string()), bincode::config::standard())
                .unwrap(),
        );
        self.stream
            .write_all(&(body.len() as u32).to_le_bytes())
            .unwrap();
        self.stream.write_all(&body).unwrap();
    }

    fn receive(&mut self) -> PeerEvent {
        let (variant, body) = crate::support::read_server_message(&mut self.stream).unwrap();
        match variant {
            20 => {
                let ((kind, data), used): ((String, String), usize) =
                    bincode::serde::decode_from_slice(&body, bincode::config::standard()).unwrap();
                assert_eq!(used, body.len());
                let value: Value = serde_json::from_str(&data).unwrap();
                if kind == "shell.snapshot.v1" {
                    self.projection = value.clone();
                    self.painted = false;
                }
                PeerEvent::Control(kind, value)
            }
            13 => {
                self.painted = true;
                PeerEvent::Other
            }
            18 => {
                let ((_, id, last, data), used): ((String, String, bool, Vec<u8>), usize) =
                    bincode::serde::decode_from_slice(&body, bincode::config::standard()).unwrap();
                assert_eq!(used, body.len());
                PeerEvent::Response(id, last, data)
            }
            _ => PeerEvent::Other,
        }
    }

    fn next_control(&mut self, expected: &str) -> Value {
        let deadline = Instant::now() + BOUND;
        while Instant::now() < deadline {
            if let PeerEvent::Control(kind, value) = self.receive() {
                if kind == expected {
                    return value;
                }
            }
        }
        panic!("owned expected control deadline");
    }

    fn wait_view(&mut self, workspace: Option<&str>) {
        let deadline = Instant::now() + BOUND;
        while Instant::now() < deadline {
            if self.painted
                && workspace.is_none_or(|expected| {
                    self.projection["focused_workspace_id"].as_str() == Some(expected)
                })
            {
                return;
            }
            self.receive();
        }
        panic!("owned coherent view deadline");
    }

    fn prepare(&mut self, fixture: &Fixture, session: &str) -> Value {
        self.preparation += 1;
        prepare(fixture, session, &self.ownership, self.preparation, SOURCE)
    }
}

enum PeerEvent {
    Control(String, Value),
    Response(String, bool, Vec<u8>),
    Other,
}

fn claim(fixture: &Fixture, session: &str, registration: &Value) -> Value {
    let response = fixture.api(
        session,
        "lazysh.guard.claim",
        json!({"boot":registration["boot"],"ticket":registration["ticket"]}),
    );
    assert!(response.get("error").is_none(), "owned claim failed");
    response["result"]["owner"].clone()
}

fn prepare(fixture: &Fixture, session: &str, owner: &Value, number: u64, source: &str) -> Value {
    let result = fixture.api(session, "lazysh.guard.prepare", json!({"boot":owner["boot"],"ownership":owner["ownership"],"preparation":number,"source":source}));
    assert!(result.get("error").is_none(), "owned preparation failed");
    let guard = result["result"]["guard"].clone();
    assert!(guard["source"] == source && guard["preparation"] == number);
    guard
}

fn input(binding: &Value, operation: u64, text: Option<&str>) -> Value {
    json!({"boot":binding["boot"],"receipt":binding["receipt"],"source":binding["source"],"operation":operation,
        "input":text.map_or_else(|| json!({"kind":"request_stop"}), |text| json!({"kind":"send","text":text}))})
}

impl Peer {
    fn endpoint_request(&mut self, method: &str, params: Value) -> Value {
        // Variant 15 is pinned by protocol::wire's actual tag compatibility test.
        let mut body = vec![15];
        body.extend(
            bincode::serde::encode_to_vec(
                (
                    self.projection["boot_id"].as_str().unwrap(),
                    json!({"id":"guard-barrier","method":method,"params":params}).to_string(),
                ),
                bincode::config::standard(),
            )
            .unwrap(),
        );
        self.stream
            .write_all(&(body.len() as u32).to_le_bytes())
            .unwrap();
        self.stream.write_all(&body).unwrap();
        let deadline = Instant::now() + BOUND;
        let mut response = Vec::new();
        while Instant::now() < deadline {
            if let PeerEvent::Response(id, last, data) = self.receive() {
                assert_eq!(id, "guard-barrier");
                response.extend(data);
                assert!(response.len() <= 32768, "owned barrier response bound");
                if last {
                    return serde_json::from_slice(&response).unwrap();
                }
            }
        }
        panic!("owned endpoint barrier deadline");
    }

    fn commit(&mut self, challenge: &Value) {
        self.control(
            "lazysh.guard.commit.v1",
            json!({"boot":challenge["boot"],"challenge":challenge["nonce"],"accepted":true}),
        );
    }
}

fn wait_bytes(fixture: &Fixture, session: &str, expected: &[u8]) {
    let deadline = Instant::now() + BOUND;
    while Instant::now() < deadline {
        let bytes = fixture.bytes(session);
        assert!(
            bytes.len() <= expected.len(),
            "unexpected extra owned pane bytes"
        );
        if bytes == expected {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("owned pane byte deadline");
}

#[test]
fn original_client_ticket_server_boot_and_final_target_guard_real_queue() {
    let mut fixture = Fixture::new();
    fixture.start("left");
    fixture.start("right");
    let mut original = Peer::attach(&fixture, "left", &"11".repeat(32));
    let mut competing = Peer::attach(&fixture, "left", &"22".repeat(32));
    let mut other_server = Peer::attach(&fixture, "right", &"33".repeat(32));
    assert!(
        original.projection["focused_pane_id"] == other_server.projection["focused_pane_id"],
        "fixture must overlap public pane IDs"
    );
    let initial_workspace = original.projection["focused_workspace_id"].clone();
    let binding = original.prepare(&fixture, "left");
    let cross_server = fixture.api(
        "right",
        "lazysh.guard.input",
        input(&binding, 1, Some("wrong-server")),
    );
    assert!(cross_server.get("error").is_some());
    let pending = fixture.request(
        "left",
        "lazysh.guard.input",
        input(&binding, 1, Some("literal\ntext\t🙂")),
    );
    let challenge = original.next_control("lazysh.guard.challenge.v1");
    let busy = fixture.api("left", "lazysh.guard.prepare", json!({"boot":original.ownership["boot"],"ownership":original.ownership["ownership"],"preparation":7,"source":SOURCE}));
    assert!(
        busy.get("error").is_some(),
        "pending input admitted preparation"
    );
    competing.commit(&challenge);
    let barrier = competing.endpoint_request("integration.list", json!({}));
    assert!(barrier.get("error").is_none());
    assert!(fixture.bytes("left").is_empty() && fixture.bytes("right").is_empty());
    original.commit(&challenge);
    assert!(Fixture::answer(pending).get("error").is_none());
    wait_bytes(&fixture, "left", "literal\ntext\t🙂\r".as_bytes());
    assert!(fixture.bytes("right").is_empty());

    let pending = fixture.request("left", "lazysh.guard.input", input(&binding, 2, None));
    let challenge = original.next_control("lazysh.guard.challenge.v1");
    original.commit(&challenge);
    assert!(Fixture::answer(pending).get("error").is_none());
    wait_bytes(&fixture, "left", "literal\ntext\t🙂\r\u{1b}".as_bytes());

    // Hold the original challenge, then move that very client before commit.
    let pending = fixture.request(
        "left",
        "lazysh.guard.input",
        input(&binding, 3, Some("must-not-arrive")),
    );
    let challenge = original.next_control("lazysh.guard.challenge.v1");
    let next_workspace = original.projection["workspaces"][1]["workspace_id"].clone();
    let moved =
        original.endpoint_request("workspace.focus", json!({"workspace_id":next_workspace}));
    assert!(moved.get("error").is_none());
    original.commit(&challenge);
    assert!(Fixture::answer(pending).get("error").is_some());
    let replay = fixture.api(
        "left",
        "lazysh.guard.input",
        input(&binding, 4, Some("no-rebind")),
    );
    assert!(replay.get("error").is_some());
    wait_bytes(&fixture, "left", "literal\ntext\t🙂\r\u{1b}".as_bytes());
    assert!(fixture.bytes("right").is_empty());
    let moved_back =
        original.endpoint_request("workspace.focus", json!({"workspace_id":initial_workspace}));
    assert!(moved_back.get("error").is_none());
    original.wait_view(None);
    let replacement = prepare(&fixture, "left", &original.ownership, 9, SOURCE);
    let pending = fixture.request(
        "left",
        "lazysh.guard.input",
        input(&replacement, 1, Some("reprepared")),
    );
    let current_challenge = original.next_control("lazysh.guard.challenge.v1");
    // Old callbacks cannot consume the newer binding or its pending input.
    original.commit(&challenge);
    let released = fixture.api(
        "left",
        "lazysh.guard.release",
        json!({"boot":binding["boot"],"receipt":binding["receipt"]}),
    );
    assert!(released.get("error").is_none());
    let cancelled = fixture.api("left", "lazysh.guard.cancel_preparation", json!({"boot":original.ownership["boot"],"ownership":original.ownership["ownership"],"preparation":1}));
    assert!(cancelled.get("error").is_none());
    original.commit(&current_challenge);
    assert!(Fixture::answer(pending).get("error").is_none());
    wait_bytes(
        &fixture,
        "left",
        "literal\ntext\t🙂\r\u{1b}reprepared\r".as_bytes(),
    );
    let revoked = fixture.api(
        "left",
        "lazysh.guard.revoke",
        json!({"boot":original.ownership["boot"],"ownership":original.ownership["ownership"]}),
    );
    assert!(revoked.get("error").is_none());
    assert!(fixture
        .api(
            "left",
            "lazysh.guard.input",
            input(&replacement, 2, Some("after-revoke"))
        )
        .get("error")
        .is_some());
    assert!(other_server
        .endpoint_request("integration.list", json!({}))
        .get("error")
        .is_none());
}

#[derive(Default)]
struct Display {
    registration: Option<Value>,
    bytes: Vec<u8>,
    failed: bool,
}
struct TerminalClient {
    _master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    display: Arc<Mutex<Display>>,
    reader: Option<thread::JoinHandle<()>>,
    arguments: Vec<std::ffi::OsString>,
}
impl TerminalClient {
    fn attach(fixture: &Fixture, session: &str) -> Self {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_herdr"));
        command.env_clear();
        for (key, value) in fixture.environment() {
            command.env(key, value);
        }
        command.env("HERDR_CONFIG_PATH", fixture.base.join("config.toml"));
        command.env("HERDR_GUARD_SSH_MARKER", fixture.base.join("ssh-attempted"));
        command.env(
            "PATH",
            format!("{}:/usr/bin:/bin", fixture.base.join("bin").display()),
        );
        for (key, value) in [
            ("SHELL", "/bin/sh"),
            ("TERM", "xterm-256color"),
            ("LANG", "C.UTF-8"),
            ("HERDR_DISABLE_SOUND", "1"),
        ] {
            command.env(key, value);
        }
        command.cwd(fixture.base.join(session));
        command.args(["--session", session, "--guarded-attach"]);
        let arguments = command.get_argv().clone();
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let display = Arc::new(Mutex::new(Display::default()));
        let shared = display.clone();
        let handle = thread::spawn(move || {
            let mut initial = Vec::new();
            let mut registered = false;
            let mut chunk = [0_u8; 4096];
            while let Ok(count) = reader.read(&mut chunk) {
                if count == 0 {
                    break;
                }
                let mut state = shared.lock().unwrap();
                if state.failed {
                    continue;
                }
                if registered {
                    if state.bytes.len() + count <= 512 * 1024 {
                        state.bytes.extend_from_slice(&chunk[..count]);
                    } else {
                        state.failed = true;
                    }
                    continue;
                }
                initial.extend_from_slice(&chunk[..count]);
                let matched = initial.len().min(PREFIX.len());
                if initial[..matched] != PREFIX[..matched] {
                    state.failed = true;
                    continue;
                }
                if initial.len() < PREFIX.len() + 9 {
                    continue;
                }
                let header = std::str::from_utf8(&initial[PREFIX.len()..PREFIX.len() + 8]).ok();
                let size = header
                    .filter(|value| {
                        value
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
                    .and_then(|value| usize::from_str_radix(value, 16).ok());
                let Some(size) = size.filter(|size| *size <= 512) else {
                    state.failed = true;
                    continue;
                };
                let begin = PREFIX.len() + 9;
                let end = begin + size;
                if initial.len() <= end {
                    continue;
                }
                if initial[PREFIX.len() + 8] != b':' || initial[end] != 0x1f {
                    state.failed = true;
                    continue;
                }
                match serde_json::from_slice(&initial[begin..end]) {
                    Ok(value) => {
                        state.registration = Some(value);
                        state.bytes.extend_from_slice(&initial[end + 1..]);
                        initial.clear();
                        registered = true;
                    }
                    Err(_) => state.failed = true,
                }
            }
        });
        Self {
            _master: pair.master,
            child,
            writer,
            display,
            reader: Some(handle),
            arguments,
        }
    }

    fn registration(&self) -> Value {
        let deadline = Instant::now() + BOUND;
        while Instant::now() < deadline {
            let state = self.display.lock().unwrap();
            assert!(!state.failed, "private startup framing failed");
            if let Some(value) = &state.registration {
                return value.clone();
            }
            drop(state);
            thread::sleep(Duration::from_millis(10));
        }
        panic!("private startup deadline");
    }

    fn wait_screen(&self, marker: &str, present: bool) {
        let deadline = Instant::now() + BOUND;
        while Instant::now() < deadline {
            let bytes = {
                let state = self.display.lock().unwrap();
                assert!(!state.failed, "owned display capture exceeded bound");
                state.bytes.clone()
            };
            if crate::terminal_screen::text(&bytes, 80, 24).contains(marker) == present {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("owned terminal display stage deadline");
    }
}
impl Drop for TerminalClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && self.child.try_wait().ok().flatten().is_none() {
            thread::sleep(Duration::from_millis(10));
        }
        if self
            .reader
            .as_ref()
            .is_some_and(|reader| reader.is_finished())
        {
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
        }
    }
}

#[tokio::test]
async fn actual_session_terminal_client_private_join_and_copy_barrier() {
    let mut fixture = Fixture::new();
    fixture.start("terminal");
    let catalog_endpoint = fixture.enabled_catalog_with_owned_ssh();
    let mut client = TerminalClient::attach(&fixture, "terminal");
    let registration = client.registration();
    let claimed = fixture
        .guarded_cli(
            "terminal",
            "lazysh.guard.claim",
            json!({"boot":registration["boot"],"ticket":registration["ticket"]}),
        )
        .await;
    assert!(
        claimed.get("error").is_none(),
        "actual stdin CLI claim failed"
    );
    let owner = claimed["result"]["owner"].clone();
    // This ordinary observer supplies a render-loop barrier, not authority.
    let _observer = Peer::attach(&fixture, "terminal", &"44".repeat(32));
    let prepared = fixture.guarded_cli("terminal", "lazysh.guard.prepare", json!({"boot":owner["boot"],"ownership":owner["ownership"],"preparation":1,"source":SOURCE})).await;
    assert!(
        prepared.get("error").is_none(),
        "actual stdin CLI preparation failed"
    );
    let binding = prepared["result"]["guard"].clone();
    assert!(binding["preparation"] == 1 && binding["source"] == SOURCE);
    let result = fixture
        .guarded_cli(
            "terminal",
            "lazysh.guard.input",
            input(&binding, 1, Some("real-client")),
        )
        .await;
    assert!(
        result.get("error").is_none(),
        "actual client did not commit eligible input"
    );
    wait_bytes(&fixture, "terminal", b"real-client\r");
    client.writer.write_all(b"\x02[").unwrap();
    client.writer.flush().unwrap();
    client.wait_screen("COPY", true);
    let rejected = fixture
        .guarded_cli(
            "terminal",
            "lazysh.guard.input",
            input(&binding, 2, Some("must-not-reach-copy")),
        )
        .await;
    assert!(
        rejected.get("error").is_some(),
        "copy mode admitted Chat input"
    );
    let replay = fixture.api("terminal", "lazysh.guard.input", input(&binding, 3, None));
    assert!(
        replay.get("error").is_some(),
        "copy rejection did not retire binding"
    );
    wait_bytes(&fixture, "terminal", b"real-client\r");

    client.writer.write_all(b"q").unwrap();
    client.writer.flush().unwrap();
    client.wait_screen("COPY", false);
    let source = "cd".repeat(32);
    // Explicit action 9 tolerates lost/unadmitted numbers, never replaying them.
    let prepared = fixture.guarded_cli("terminal", "lazysh.guard.prepare", json!({"boot":owner["boot"],"ownership":owner["ownership"],"preparation":9,"source":source})).await;
    assert!(
        prepared.get("error").is_none(),
        "same original client could not explicitly reprepare"
    );
    let current = prepared["result"]["guard"].clone();
    assert!(current["preparation"] == 9 && current["source"] == source);
    assert!(fixture
        .api(
            "terminal",
            "lazysh.guard.release",
            json!({"boot":binding["boot"],"receipt":binding["receipt"]})
        )
        .get("error")
        .is_none());
    assert!(fixture
        .api(
            "terminal",
            "lazysh.guard.cancel_preparation",
            json!({"boot":owner["boot"],"ownership":owner["ownership"],"preparation":1})
        )
        .get("error")
        .is_none());
    let old_prepare = fixture.guarded_cli("terminal", "lazysh.guard.prepare", json!({"boot":owner["boot"],"ownership":owner["ownership"],"preparation":1,"source":SOURCE})).await;
    assert!(
        old_prepare.get("error").is_some(),
        "old preparation replaced current binding"
    );
    let sent = fixture
        .guarded_cli(
            "terminal",
            "lazysh.guard.input",
            input(&current, 1, Some("explicit-rebind")),
        )
        .await;
    assert!(
        sent.get("error").is_none(),
        "stale cleanup retired a newer binding"
    );
    wait_bytes(&fixture, "terminal", b"real-client\rexplicit-rebind\r");
    assert!(
        client.child.try_wait().unwrap().is_none(),
        "reprepare replaced original terminal client"
    );

    let revoked = fixture
        .guarded_cli(
            "terminal",
            "lazysh.guard.revoke",
            json!({"boot":owner["boot"],"ownership":owner["ownership"]}),
        )
        .await;
    assert!(revoked.get("error").is_none());
    assert!(fixture
        .api("terminal", "lazysh.guard.input", input(&current, 2, None))
        .get("error")
        .is_some());
    let renewed = fixture.guarded_cli("terminal", "lazysh.guard.prepare", json!({"boot":owner["boot"],"ownership":owner["ownership"],"preparation":10,"source":source})).await;
    assert!(
        renewed.get("error").is_some(),
        "revoked ownership was renewed"
    );
    let reclaimed = fixture
        .guarded_cli(
            "terminal",
            "lazysh.guard.claim",
            json!({"boot":registration["boot"],"ticket":registration["ticket"]}),
        )
        .await;
    assert!(
        reclaimed.get("error").is_some(),
        "spent startup ticket reclaimed authority"
    );
    assert!(
        client.child.try_wait().unwrap().is_none(),
        "revocation broke ordinary attachment"
    );
    wait_bytes(&fixture, "terminal", b"real-client\rexplicit-rebind\r");

    match catalog_endpoint.accept() {
        Ok((connection, _)) => {
            drop(connection);
            panic!("owned loopback endpoint accepted a connection");
        }
        Err(error) => assert_eq!(
            error.kind(),
            std::io::ErrorKind::WouldBlock,
            "owned loopback listener error: kind={:?}, os={:?}",
            error.kind(),
            error.raw_os_error()
        ),
    }
    assert!(
        !fixture.base.join("ssh-attempted").exists(),
        "guarded attachment opened a saved endpoint"
    );
    let display = client.display.lock().unwrap();
    for secret in [
        &registration["boot"],
        &registration["ticket"],
        &owner["ownership"],
        &binding["receipt"],
        &current["receipt"],
    ] {
        let secret = secret.as_str().unwrap().as_bytes();
        assert!(!display
            .bytes
            .windows(secret.len())
            .any(|bytes| bytes == secret));
        assert!(!client.arguments.iter().any(|arg| arg
            .as_encoded_bytes()
            .windows(secret.len())
            .any(|bytes| bytes == secret)));
        for name in ["herdr.log", "herdr-client.log", "herdr-server.log"] {
            if let Ok(file) = fs::File::open(fixture.data("terminal").join(name)) {
                let mut bytes = Vec::new();
                file.take(1024 * 1024 + 1).read_to_end(&mut bytes).unwrap();
                assert!(bytes.len() <= 1024 * 1024, "owned log bound");
                assert!(!bytes.windows(secret.len()).any(|bytes| bytes == secret));
                for payload in [b"real-client".as_slice(), b"explicit-rebind".as_slice()] {
                    assert!(!bytes.windows(payload.len()).any(|bytes| bytes == payload));
                }
            }
        }
    }
}
