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

/// The application directory the built server uses under every XDG root; it mirrors
/// `config::io::app_dir_name`, and the server's own socket proves the two agree.
fn app_dir_name() -> &'static str {
    if cfg!(feature = "lazysh-managed") {
        "lazysh-herdr"
    } else if cfg!(debug_assertions) {
        "herdr-dev"
    } else {
        "herdr"
    }
}

/// The executable every case runs: the one Cargo built, or the exact file named by
/// `LAZYSH_TEST_HERDR_MANAGED` (an absolute path), so a retained or downloaded release asset is
/// accepted instead of a rebuild. Build the tests with the features that asset was built with.
fn executable_under_test() -> PathBuf {
    std::env::var_os("LAZYSH_TEST_HERDR_MANAGED").map_or_else(
        || PathBuf::from(env!("CARGO_BIN_EXE_herdr")),
        |path| {
            let path = PathBuf::from(path);
            assert!(
                path.is_absolute() && path.is_file(),
                "explicit managed executable"
            );
            path
        },
    )
}

/// A fixture for the unchanged stock Herdr named by `LAZYSH_TEST_HERDR_STOCK` (an absolute
/// path). Its application directory is `herdr-dev` for a debug build and `herdr` for a release
/// one; `LAZYSH_TEST_HERDR_STOCK_NAMESPACE` names it when the stock build and this test differ.
fn stock_fixture() -> Fixture {
    let executable = PathBuf::from(
        std::env::var_os("LAZYSH_TEST_HERDR_STOCK").expect("explicit unchanged stock binary"),
    );
    assert!(executable.is_absolute() && executable.is_file());
    let namespace = std::env::var("LAZYSH_TEST_HERDR_STOCK_NAMESPACE").unwrap_or_else(|_| {
        (if cfg!(debug_assertions) {
            "herdr-dev"
        } else {
            "herdr"
        })
        .to_owned()
    });
    Fixture::with(executable, &namespace, None)
}

struct Fixture {
    base: PathBuf,
    /// HOME and the XDG roots; the base itself unless this fixture is a second server on
    /// another fixture's host.
    roots: PathBuf,
    executable: PathBuf,
    /// The application directory this executable uses below the config and state roots.
    namespace: String,
    /// Read configuration from `<config root>/<namespace>/config.toml` instead of
    /// `HERDR_CONFIG_PATH`, as a user's server does.
    own_config: bool,
    children: Vec<Child>,
}
impl Fixture {
    fn new() -> Self {
        Self::with(executable_under_test(), app_dir_name(), None)
    }

    fn with(executable: PathBuf, namespace: &str, roots: Option<&PathBuf>) -> Self {
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
            roots: roots.unwrap_or(&base).clone(),
            base,
            executable,
            namespace: namespace.to_owned(),
            own_config: false,
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
        let client = self
            .roots
            .join("state")
            .join(&self.namespace)
            .join("client");
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
            // A provider profile that pane children must keep seeing.
            ("CODEX_HOME", "codex-home"),
        ]
        .into_iter()
        .map(|(name, child)| (name, self.roots.join(child)))
        .collect()
    }

    fn command(&self, session: &str) -> Command {
        let mut command = Command::new(&self.executable);
        command
            .env_clear()
            .envs(self.environment())
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
        if !self.own_config {
            command.env("HERDR_CONFIG_PATH", self.base.join("config.toml"));
        }
        command
    }

    fn data(&self, session: &str) -> PathBuf {
        self.roots
            .join("config")
            .join(&self.namespace)
            .join("sessions")
            .join(session)
    }

    fn start(&mut self, session: &str) {
        for (_, path) in self.environment() {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir(self.base.join(session)).unwrap();
        fs::create_dir_all(self.data(session)).unwrap();
        if self.own_config {
            let config = self.roots.join("config").join(&self.namespace);
            fs::copy(self.base.join("config.toml"), config.join("config.toml")).unwrap();
        }
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

    /// A new workspace `label` of `session` whose pane runs `script`, returned once the script
    /// has created the file `ready` in the session directory.
    fn workload(&self, session: &str, label: &str, script: &str, ready: &str) -> Value {
        let created = self.api(
            session,
            "workspace.create",
            json!({"label":label,"cwd":self.base.join(session),"focus":false}),
        );
        assert!(created.get("error").is_none());
        let snapshot = self.api(session, "session.snapshot", json!({}));
        let tree = &snapshot["result"]["snapshot"];
        let workspace = tree["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["label"] == label)
            .unwrap()["workspace_id"]
            .clone();
        let pane = tree["panes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["workspace_id"] == workspace)
            .unwrap()
            .clone();
        let sent = self.api(
            session,
            "pane.send_input",
            json!({"pane_id":pane["pane_id"],"text":script,"keys":["Enter"]}),
        );
        assert!(sent.get("error").is_none());
        crate::support::wait_for_file(&self.base.join(session).join(ready), BOUND);
        pane
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

fn preparation_error_class(result: &Value) -> &'static str {
    match result["error"]["code"].as_str() {
        Some("guard_stale") => "guard_stale",
        Some("guard_busy") => "guard_busy",
        Some("guard_invalid") => "guard_invalid",
        Some("guard_unavailable") => "guard_unavailable",
        Some("timeout") => "timeout",
        _ => "other",
    }
}

#[test]
fn preparation_diagnostic_reports_only_known_error_classes() {
    assert_eq!(
        preparation_error_class(&json!({"error":{"code":"guard_stale"}})),
        "guard_stale"
    );
    assert_eq!(
        preparation_error_class(&json!({"error":{"code":"private-ticket","message":"private"}})),
        "other"
    );
}

fn prepare(fixture: &Fixture, session: &str, owner: &Value, number: u64, source: &str) -> Value {
    let result = fixture.api(session, "lazysh.guard.prepare", json!({"boot":owner["boot"],"ownership":owner["ownership"],"preparation":number,"source":source}));
    assert!(
        result.get("error").is_none(),
        "owned preparation failed: {}",
        preparation_error_class(&result)
    );
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

/// Paths below each of the fixture's HOME and XDG roots, each shown with its root's directory
/// name first, without following symlinks.
#[cfg(feature = "lazysh-managed")]
fn host_paths(fixture: &Fixture) -> std::collections::BTreeSet<PathBuf> {
    use std::collections::BTreeSet;
    use std::path::Path;
    fn walk(directory: &Path, shown: &Path, paths: &mut BTreeSet<PathBuf>) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let shown = shown.join(entry.file_name());
            paths.insert(shown.clone());
            if entry.file_type().unwrap().is_dir() {
                walk(&entry.path(), &shown, paths);
            }
        }
    }
    let mut paths = BTreeSet::new();
    for (_, root) in fixture.environment() {
        walk(&root, Path::new(root.file_name().unwrap()), &mut paths);
    }
    paths
}

/// A stock Herdr on the same host shares HOME and the XDG roots, so every socket, config,
/// state and log file of the managed build must sit under its own application directory.
#[cfg(feature = "lazysh-managed")]
#[test]
fn managed_build_keeps_sockets_config_and_state_in_its_own_namespace() {
    let mut fixture = Fixture::new();
    fixture.start("managed");
    let peer = Peer::attach(&fixture, "managed", &"77".repeat(32));
    drop(peer);
    let config = fixture.base.join("config");
    let namespaces: Vec<_> = fs::read_dir(&config)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        namespaces,
        ["lazysh-herdr"],
        "server wrote outside its namespace"
    );
    assert!(config
        .join("lazysh-herdr/sessions/managed/herdr.sock")
        .exists());
    let stock: Vec<_> = host_paths(&fixture)
        .into_iter()
        .filter(|path| {
            let name = path.file_name().unwrap().to_string_lossy();
            matches!(&*name, "herdr" | "herdr-dev") || name.starts_with(".herdr")
        })
        .collect();
    assert!(stock.is_empty(), "stock Herdr names created: {stock:?}");
}

/// What a managed server beside a running stock server must leave exactly as it was.
#[cfg(feature = "lazysh-managed")]
#[derive(Debug, PartialEq)]
struct Stock {
    pid: u32,
    sockets: Vec<(u64, u64)>,
    config: String,
    bytes: Vec<u8>,
}
#[cfg(feature = "lazysh-managed")]
impl Stock {
    fn capture(fixture: &mut Fixture, session: &str) -> Self {
        use std::os::unix::fs::MetadataExt;
        assert!(
            fixture.children[0].try_wait().unwrap().is_none(),
            "stock server exited"
        );
        let namespace = fixture.roots.join("config").join(&fixture.namespace);
        Self {
            pid: fixture.children[0].id(),
            sockets: ["herdr.sock", "herdr-client.sock"]
                .map(|name| {
                    let meta = fs::symlink_metadata(fixture.data(session).join(name)).unwrap();
                    (meta.dev(), meta.ino())
                })
                .to_vec(),
            config: fs::read_to_string(namespace.join("config.toml")).unwrap(),
            bytes: fixture.bytes(session),
        }
    }
}

/// Release acceptance of the managed derivative (#1761): the executable under test and an
/// unchanged stock Herdr serve one session name on one host, sharing HOME and every XDG root.
/// Neither may touch the other, and the managed server's pane children keep the provider
/// profile variables. Cargo builds the executable unless `LAZYSH_TEST_HERDR_MANAGED` names a
/// retained or downloaded release asset.
#[cfg(feature = "lazysh-managed")]
#[test]
#[ignore = "requires explicit unchanged stock Herdr"]
fn managed_and_stock_servers_of_one_session_name_coexist_without_touching_each_other() {
    let mut stock = stock_fixture();
    stock.own_config = true;
    stock.start("shared");
    let (before, host) = (Stock::capture(&mut stock, "shared"), host_paths(&stock));
    let mut managed = Fixture::with(executable_under_test(), "lazysh-herdr", Some(&stock.roots));
    managed.own_config = true;
    managed.start("shared");
    let send = |fixture: &Fixture, text: &str| {
        let snapshot = fixture.api("shared", "session.snapshot", json!({}));
        let pane = &snapshot["result"]["snapshot"]["focused_pane_id"];
        let sent = fixture.api(
            "shared",
            "pane.send_input",
            json!({"pane_id":pane,"text":text}),
        );
        assert!(sent.get("error").is_none());
    };
    send(&managed, "managed-input");
    wait_bytes(&managed, "shared", b"managed-input");
    // Pane children of the managed server keep HOME, every XDG root and the provider profile.
    managed.workload(
        "shared",
        "Environment",
        r#"printf '%s\n' "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$CODEX_HOME" > env-seen; : > env-ready"#,
        "env-ready",
    );
    let environment: Vec<_> = managed
        .environment()
        .into_iter()
        .map(|(_, path)| path.display().to_string())
        .collect();
    let seen = fs::read_to_string(managed.base.join("shared/env-seen")).unwrap();
    assert_eq!(seen.lines().collect::<Vec<_>>(), environment);
    // Old capability absence stays the fallback: only the managed executable advertises guarded attachment.
    let (absent, present) = (capabilities(&stock), capabilities(&managed));
    assert!(!absent.status.success() && absent.stdout.is_empty());
    assert!(present.status.success() && !present.stdout.is_empty());
    // The stock server's process, sockets, configuration and workload are exactly as they were,
    // and everything the managed server added to the shared roots sits in its own directory.
    assert_eq!(Stock::capture(&mut stock, "shared"), before);
    let after = host_paths(&managed);
    assert_eq!(
        host.difference(&after).count(),
        0,
        "stock paths disappeared"
    );
    let outside: Vec<_> = after
        .difference(&host)
        .filter(|path| path.iter().nth(1) != Some("lazysh-herdr".as_ref()))
        .collect();
    assert!(
        outside.is_empty(),
        "managed server wrote outside its namespace: {outside:?}"
    );
    assert!(managed.data("shared").join("herdr.sock").exists());
    // Both servers answer, and each receives only its own input.
    send(&stock, "stock-input");
    wait_bytes(&stock, "shared", b"stock-input");
    assert_eq!(managed.bytes("shared"), b"managed-input");
}

#[test]
fn owned_observation_and_history_keep_input_binding_and_reject_foreign_targets() {
    let mut fixture = Fixture::new();
    fixture.start("history");
    fixture.start("foreign");
    let created = fixture.api(
        "history",
        "workspace.create",
        json!({"label":"History","cwd":fixture.base.join("history"),"focus":true}),
    );
    assert!(created.get("error").is_none());
    let snapshot = fixture.api("history", "session.snapshot", json!({}));
    let pane = snapshot["result"]["snapshot"]["focused_pane_id"]
        .as_str()
        .unwrap();
    let setup = "i=0; while [ $i -lt 160 ]; do printf 'history-%03d\\n' \"$i\"; i=$((i+1)); done; stty raw -echo; : > history-ready; exec cat > history-bytes";
    assert!(fixture
        .api(
            "history",
            "pane.send_input",
            json!({"pane_id":pane,"text":setup,"keys":["Enter"]})
        )
        .get("error")
        .is_none());
    crate::support::wait_for_file(&fixture.base.join("history/history-ready"), BOUND);
    let mut owner = Peer::attach(&fixture, "history", &"55".repeat(32));
    let foreign = Peer::attach(&fixture, "foreign", &"66".repeat(32));
    let binding = owner.prepare(&fixture, "history");
    let credentials =
        json!({"boot":owner.ownership["boot"],"ownership":owner.ownership["ownership"]});
    let observed = fixture.api("history", "lazysh.guard.observe", credentials.clone());
    assert!(observed.get("error").is_none());
    let target = observed["result"]["guard"]["target"].clone();
    assert_eq!(target["pane"], pane);
    let x = target["viewport"]["x"].as_u64().unwrap();
    let y = target["viewport"]["y"].as_u64().unwrap();
    let scroll = |owner: &Value, target: &Value, x, y, lines| {
        fixture.api("history", "lazysh.guard.scroll_history", json!({"boot":owner["boot"],"ownership":owner["ownership"],"target":target,"x":x,"y":y,"lines":lines}))
    };
    let offset = || {
        fixture.api("history", "pane.get", json!({"pane_id":pane}))["result"]["pane"]["scroll"]
            ["offset_from_bottom"]
            .as_u64()
            .unwrap()
    };
    let visible = || {
        fixture.api("history", "pane.read", json!({"pane_id":pane,"source":"visible","lines":1000,"format":"text","strip_ansi":true}))["result"]["read"]["text"]
            .as_str().expect("visible history text").to_owned()
    };
    assert_eq!(offset(), 0);
    assert!(visible().contains("history-159"));
    let mut wrong = target.clone();
    wrong["terminal"] = json!("wrong-terminal");
    assert!(scroll(&owner.ownership, &wrong, x, y, -4)
        .get("error")
        .is_some());
    let forged = json!({"boot":owner.ownership["boot"],"ownership":"00".repeat(32)});
    assert!(fixture
        .api("history", "lazysh.guard.observe", forged.clone())
        .get("error")
        .is_some());
    assert!(fixture
        .api("history", "lazysh.guard.observe", foreign.ownership.clone())
        .get("error")
        .is_some());
    assert!(scroll(&forged, &target, x, y, -4).get("error").is_some());
    assert!(scroll(&foreign.ownership, &target, x, y, -4)
        .get("error")
        .is_some());
    assert!(scroll(
        &owner.ownership,
        &target,
        x + target["viewport"]["width"].as_u64().unwrap(),
        y,
        -4
    )
    .get("error")
    .is_some());
    assert_eq!(offset(), 0);
    assert!(owner
        .endpoint_request("integration.list", json!({}))
        .get("error")
        .is_none());
    owner.painted = false;
    assert!(scroll(&owner.ownership, &target, x, y, -4)
        .get("error")
        .is_none());
    owner.wait_view(None);
    assert_eq!(offset(), 4);
    assert!(
        !visible().contains("history-159"),
        "guarded scroll must change visible history"
    );
    assert_eq!(offset(), 4, "visible read did not change scroll offset");
    assert!(scroll(&owner.ownership, &target, x, y, -13)
        .get("error")
        .is_none());
    assert_eq!(offset(), 17);
    assert!(!visible().contains("history-159"));
    assert_eq!(offset(), 17, "visible read did not change scroll offset");
    assert!(scroll(&owner.ownership, &target, x, y, 17)
        .get("error")
        .is_none());
    assert_eq!(offset(), 0);
    assert!(
        visible().contains("history-159"),
        "return to bottom must restore the newest row"
    );
    assert!(fs::read(fixture.base.join("history/history-bytes"))
        .unwrap()
        .is_empty());
    let pending = fixture.request(
        "history",
        "lazysh.guard.input",
        input(&binding, 1, Some("still-bound")),
    );
    let challenge = owner.next_control("lazysh.guard.challenge.v1");
    owner.commit(&challenge);
    assert!(Fixture::answer(pending).get("error").is_none());
    let deadline = Instant::now() + BOUND;
    while fs::read(fixture.base.join("history/history-bytes")).unwrap() != b"still-bound\r" {
        assert!(Instant::now() < deadline, "owned input deadline");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(fixture.bytes("history").is_empty());
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
        Self::attach_mode(fixture, session, true)
    }
    fn attach_mode(fixture: &Fixture, session: &str, guarded: bool) -> Self {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(&fixture.executable);
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
        command.args(["--session", session]);
        if guarded {
            command.arg("--guarded-attach");
        }
        let arguments = command.get_argv().clone();
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let display = Arc::new(Mutex::new(Display::default()));
        let shared = display.clone();
        let handle = thread::spawn(move || {
            let mut initial = Vec::new();
            let mut registered = !guarded;
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
#[ignore = "requires explicit unchanged stock Herdr and current lazysh companion"]
async fn stock_public_focus_moves_both_clients_for_shell_and_agent_without_input_or_fallback() {
    let mut fixture = stock_fixture();
    let companion = PathBuf::from(
        std::env::var_os("LAZYSH_TEST_AGENT_BIN").expect("explicit current companion binary"),
    );
    assert!(fixture.executable.is_absolute() && companion.is_absolute());
    fs::create_dir(fixture.base.join("bin")).unwrap();
    std::os::unix::fs::symlink(&fixture.executable, fixture.base.join("bin/herdr")).unwrap();
    fixture.start("shared");
    let mut targets = Vec::new();
    for (index, marker) in ["SHARED_SOURCE_SCREEN", "SHARED_TARGET_SCREEN"]
        .iter()
        .enumerate()
    {
        let script=format!("printf '\\033[2J\\033[H{marker}\\n'; stty raw -echo; : > ready-{index}; exec cat > bytes-{index}");
        let pane = fixture.workload(
            "shared",
            &format!("Space-{index}"),
            &script,
            &format!("ready-{index}"),
        );
        targets.push(pane);
    }
    let first = TerminalClient::attach_mode(&fixture, "shared", false);
    let second = TerminalClient::attach_mode(&fixture, "shared", false);
    let ordinary = |args: &[&str]| {
        let mut command = fixture.command("shared");
        command.args(args);
        async move {
            let output = bounded_public_command(command).await;
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    };
    ordinary(&[
        "workspace",
        "focus",
        targets[0]["workspace_id"].as_str().unwrap(),
    ])
    .await;
    for client in [&first, &second] {
        client.wait_screen("SHARED_SOURCE_SCREEN", true);
        client.wait_screen("SHARED_TARGET_SCREEN", false);
    }
    ordinary(&["tab", "focus", targets[1]["tab_id"].as_str().unwrap()]).await;
    for client in [&first, &second] {
        client.wait_screen("SHARED_TARGET_SCREEN", true);
        client.wait_screen("SHARED_SOURCE_SCREEN", false);
    }
    let focus = |pane: &str| {
        let mut command = Command::new(&companion);
        command
            .env_clear()
            .envs(fixture.environment())
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", fixture.base.join("bin").display()),
            )
            .env("HERDR_CONFIG_PATH", fixture.base.join("config.toml"))
            .args(["herdr-focus-pane", "--session", "shared", "--pane", pane]);
        bounded_public_command(command)
    };
    assert!(focus(targets[0]["pane_id"].as_str().unwrap())
        .await
        .status
        .success());
    for client in [&first, &second] {
        client.wait_screen("SHARED_SOURCE_SCREEN", true);
        client.wait_screen("SHARED_TARGET_SCREEN", false);
    }
    ordinary(&[
        "pane",
        "report-agent",
        targets[1]["pane_id"].as_str().unwrap(),
        "--source",
        "lazysh-owned",
        "--agent",
        "codex",
        "--state",
        "unknown",
    ])
    .await;
    assert!(focus(targets[1]["pane_id"].as_str().unwrap())
        .await
        .status
        .success());
    for client in [&first, &second] {
        client.wait_screen("SHARED_TARGET_SCREEN", true);
        client.wait_screen("SHARED_SOURCE_SCREEN", false);
    }
    assert!(!focus("wZZ:pZZ").await.status.success());
    for client in [&first, &second] {
        client.wait_screen("SHARED_TARGET_SCREEN", true);
        client.wait_screen("SHARED_SOURCE_SCREEN", false);
    }
    for index in 0..2 {
        assert!(
            fs::read(fixture.base.join("shared").join(format!("bytes-{index}")))
                .unwrap()
                .is_empty()
        );
    }
    assert!(fixture.bytes("shared").is_empty());
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

/// What the fixture's executable answers to the host probe for guarded attachment. It opens no
/// configuration, so a stock Herdr answers as an unknown option.
fn capabilities(fixture: &Fixture) -> std::process::Output {
    Command::new(&fixture.executable)
        .env_clear()
        .envs(fixture.environment())
        .current_dir(&fixture.base)
        .arg("--guarded-attach-capabilities")
        .output()
        .unwrap()
}

#[test]
fn guarded_capability_and_invalid_descriptor_do_not_emit_terminal_or_ticket_bytes() {
    use std::os::unix::process::CommandExt;
    let fixture = Fixture::new();
    let output = capabilities(&fixture);
    assert!(output.status.success() && output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"schemaVersion":1,"startupFd":true})
    );
    assert!(
        !fixture.base.join("config").exists(),
        "advertisement opened configuration"
    );
    for alias_stdout in [false, true] {
        let mut command = Command::new(&fixture.executable);
        command
            .env_clear()
            .envs(fixture.environment())
            .current_dir(&fixture.base)
            .args(["--guarded-attach", "--startup-fd", "3"]);
        unsafe {
            command.pre_exec(move || {
                if alias_stdout {
                    if libc::dup2(1, 3) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                } else {
                    libc::close(3);
                }
                Ok(())
            });
        }
        let output = command.output().unwrap();
        assert!(!output.status.success() && output.stdout.is_empty());
        assert!(!output
            .stderr
            .windows(PREFIX.len())
            .any(|bytes| bytes == PREFIX));
        assert!(!fixture.base.join("config").exists());
    }
}

#[test]
fn real_guarded_ticket_uses_only_fd3_closes_it_and_claims_original_pty() {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::process::CommandExt;
    let mut fixture = Fixture::new();
    fixture.start("descriptor");
    let (mut master_fd, mut slave_fd) = (-1, -1);
    let size = libc::winsize {
        ws_row: 24,
        ws_col: 80,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null(),
                &size,
            )
        },
        0
    );
    let mut master = unsafe { fs::File::from_raw_fd(master_fd) };
    let slave = unsafe { fs::File::from_raw_fd(slave_fd) };
    let mut descriptors = [-1; 2];
    assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
    let mut reader = unsafe { fs::File::from_raw_fd(descriptors[0]) };
    let writer = unsafe { fs::File::from_raw_fd(descriptors[1]) };
    // Keep the pre-exec source clear of the stdio/FD3 remapping range.
    let inherited = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    assert!(inherited >= 10);
    let inherited = unsafe { fs::File::from_raw_fd(inherited) };
    drop(writer);
    let source_fd = inherited.as_raw_fd();
    for fd in [reader.as_raw_fd(), master.as_raw_fd(), slave.as_raw_fd()] {
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
    }
    let mut command = fixture.command("descriptor");
    command
        .args(["--guarded-attach", "--startup-fd", "3"])
        .stdin(slave.try_clone().unwrap())
        .stdout(slave.try_clone().unwrap())
        .stderr(slave.try_clone().unwrap());
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0
                || libc::ioctl(0, libc::TIOCSCTTY, 0) < 0
                || libc::dup2(source_fd, 3) < 0
            {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(source_fd);
            Ok(())
        });
    }
    let child = command.spawn().unwrap();
    fixture.children.push(child);
    drop(inherited);
    drop(slave);
    for fd in [reader.as_raw_fd(), master.as_raw_fd()] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert!(
            flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == 0
        );
    }
    let deadline = Instant::now() + BOUND;
    let mut frame = Vec::new();
    let mut eof = false;
    while Instant::now() < deadline {
        let mut bytes = [0; 1024];
        match reader.read(&mut bytes) {
            Ok(0) => {
                eof = true;
                break;
            }
            Ok(count) => {
                frame.extend_from_slice(&bytes[..count]);
                assert!(frame.len() <= 1024);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5))
            }
            Err(_) => panic!("owned private descriptor read failed"),
        }
    }
    assert!(eof, "ticket descriptor remained open");
    assert!(
        fixture
            .children
            .last_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none(),
        "owned client exited before TUI"
    );
    assert!(frame.starts_with(PREFIX) && frame.last() == Some(&0x1f));
    let begin = PREFIX.len() + 9;
    let size = usize::from_str_radix(
        std::str::from_utf8(&frame[PREFIX.len()..begin - 1]).unwrap(),
        16,
    )
    .unwrap();
    assert!(size <= 512 && frame.len() == begin + size + 1 && frame[begin - 1] == b':');
    let registration: Value = serde_json::from_slice(&frame[begin..begin + size]).unwrap();
    let owner = claim(&fixture, "descriptor", &registration);
    let binding = prepare(&fixture, "descriptor", &owner, 1, SOURCE);
    let queued = fixture.api(
        "descriptor",
        "lazysh.guard.input",
        input(&binding, 1, Some("owned FD channel")),
    );
    assert!(
        queued.get("error").is_none(),
        "FD claimant could not queue original target"
    );
    wait_bytes(&fixture, "descriptor", b"owned FD channel\r");
    let replay = fixture.api(
        "descriptor",
        "lazysh.guard.claim",
        json!({"boot":registration["boot"],"ticket":registration["ticket"]}),
    );
    assert!(replay.get("error").is_some(), "FD ticket replayed");
    let mut display = Vec::new();
    while Instant::now() < deadline {
        let mut bytes = [0; 4096];
        match master.read(&mut bytes) {
            Ok(0) => break,
            Ok(count) => {
                display.extend_from_slice(&bytes[..count]);
                assert!(display.len() <= 512 * 1024);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if !display.is_empty() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
    assert!(
        !display.is_empty(),
        "owned TUI never rendered after FD closure"
    );
    assert!(
        !display.windows(PREFIX.len()).any(|bytes| bytes == PREFIX),
        "ticket leaked to PTY"
    );
    for field in ["boot", "ticket"] {
        let secret = registration[field].as_str().unwrap().as_bytes();
        assert!(!display.windows(secret.len()).any(|bytes| bytes == secret));
    }
}

async fn bounded_public_command(command: Command) -> std::process::Output {
    tokio::time::timeout(
        BOUND,
        tokio::process::Command::from(command)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("owned public focus deadline")
    .expect("owned public focus process")
}
