//! Connection parity (#985) against real OpenSSH: password and encrypted-key login,
//! first-use pinning and rotated-key refusal, one-hop bastion routing, opt-in
//! selected-identity agent forwarding, and Auto falling back when Mosh and ET are
//! absent. Every sshd is owned, unprivileged and bound to loopback. nss_wrapper gives
//! it a private account (password hash, HOME and /bin/sh), and its PATH holds only the
//! listed tools, so nothing reads the developer's account, ~/.ssh, agent or known_hosts.
use super::owned_sshd::{free_port, terminal_command, OwnedSshd};
use super::*;
use std::path::Path;
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;
type Events = mpsc::UnboundedReceiver<serde_json::Value>;
const USER: &str = "lazysh-parity";
const PASSWORD: &str = "lazysh parity: correct horse";
/// Kinds after which App.tsx `selectTransport` tries the next Auto transport.
const AUTO_FALLBACK: &[&str] = &[
    "mosh_bootstrap",
    "mosh_locale",
    "mosh_udp_unreachable",
    "mosh_closed",
    "mosh_unsupported",
    "mosh_unsupported_route",
    "mosh_unsupported_forwarding",
    "et_bootstrap",
    "et_unreachable",
    "et_closed",
    "et_unsupported_handshake",
    "et_unsupported_route",
    "et_agent_forwarding",
];

fn nss_wrapper() -> PathBuf {
    std::env::var_os("LAZYSH_TEST_NSS_WRAPPER")
        .map(PathBuf::from)
        .or_else(|| {
            [
                "/usr/lib/x86_64-linux-gnu",
                "/usr/lib/aarch64-linux-gnu",
                "/usr/lib64",
                "/usr/lib",
            ]
            .into_iter()
            .flat_map(|dir| {
                ["libnss_wrapper.so", "libnss_wrapper.so.0"].map(|name| Path::new(dir).join(name))
            })
            .find(|path| path.is_file())
        })
        .filter(|path| path.is_absolute() && path.is_file())
        .expect(
            "Install nss_wrapper (Debian/Ubuntu: libnss-wrapper) or set LAZYSH_TEST_NSS_WRAPPER",
        )
}

fn tool(name: &str) -> PathBuf {
    let found = std::process::Command::new("sh")
        .args(["-c", &format!("command -v {name}")])
        .output()
        .unwrap();
    assert!(
        found.status.success(),
        "{name} is required on the test host"
    );
    fs::canonicalize(String::from_utf8(found.stdout).unwrap().trim()).unwrap()
}

/// Runs a local tool with a private HOME and a closed stdin, returning its stdout.
fn local(command: &mut std::process::Command, home: &Path, input: Option<&str>) -> String {
    use std::io::Write;
    let mut child = command
        .env("HOME", home)
        .env_remove("SSH_AUTH_SOCK")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    if let Some(input) = input {
        stdin.write_all(input.as_bytes()).unwrap();
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn fingerprint(key: &russh::keys::PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// One owned remote. Field order drops sshd before its directory.
struct Remote {
    sshd: OwnedSshd,
    host_key: russh::keys::PrivateKey,
    user_key: russh::keys::PrivateKey,
    home: PathBuf,
    authorized: PathBuf,
    _directory: tempfile::TempDir,
}
impl Remote {
    async fn start(name: &str, port: u16) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let home = root.join("home");
        let bin = root.join("bin");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&bin).unwrap();
        // Mosh and ET are deliberately absent; Auto must observe that on this remote.
        for name in ["locale", "ssh-add"] {
            std::os::unix::fs::symlink(tool(name), bin.join(name)).unwrap();
        }
        let user_key = ed25519_key();
        let authorized = root.join("authorized_keys");
        fs::write(
            &authorized,
            user_key.public_key().to_openssh().unwrap() + "\n",
        )
        .unwrap();
        let hash = local(
            std::process::Command::new(tool("openssl")).args(["passwd", "-6", "-stdin"]),
            root,
            Some(PASSWORD),
        );
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        let accounts = [
            (
                "passwd",
                format!("{USER}:x:{uid}:{gid}::{}:/bin/sh\n", home.display()),
            ),
            ("group", format!("{USER}:x:{gid}:\n")),
            (
                "shadow",
                format!("{USER}:{}:19000:0:99999:7:::\n", hash.trim()),
            ),
        ];
        for (file, line) in &accounts {
            fs::write(root.join(file), line).unwrap();
        }
        let settings = format!("AuthorizedKeysFile {}\nPasswordAuthentication yes\nPubkeyAuthentication yes\nAllowAgentForwarding yes\nAllowTcpForwarding yes\nPermitUserRC no\nLogLevel DEBUG1\nSetEnv PATH={} LAZYSH_PARITY_REMOTE={name} BASH_ENV=/dev/null ENV=/dev/null\n", authorized.display(), bin.display());
        let wrapper = nss_wrapper();
        let (passwd, group, shadow) =
            (root.join("passwd"), root.join("group"), root.join("shadow"));
        let host_key = ed25519_key();
        let sshd = OwnedSshd::start(
            root,
            port,
            &host_key,
            &settings,
            &[
                ("LD_PRELOAD", wrapper.as_os_str()),
                ("NSS_WRAPPER_PASSWD", passwd.as_os_str()),
                ("NSS_WRAPPER_GROUP", group.as_os_str()),
                ("NSS_WRAPPER_SHADOW", shadow.as_os_str()),
            ],
        )
        .await;
        Self {
            sshd,
            host_key,
            user_key,
            home,
            authorized,
            _directory: directory,
        }
    }
    fn host(&self, id: &str, pinned: bool) -> Host {
        Host {
            default_multiplexer: None,
            transport: None,
            mosh: None,
            et: None,
            id: id.into(),
            name: id.into(),
            hostname: "127.0.0.1".into(),
            port: self.sshd.port,
            username: USER.into(),
            fingerprint: pinned.then(|| fingerprint(self.host_key.public_key())),
            jump_host_id: None,
            credentials_stored: false,
            biometric_unlock: false,
            forward_agent: false,
            client_environment: false,
        }
    }
    fn key(&self) -> Credentials {
        Credentials::key(&self.user_key.to_openssh(Default::default()).unwrap(), None)
    }
}

#[derive(Default)]
struct Credentials {
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
}
impl Credentials {
    fn password(password: &str) -> Self {
        Self {
            password: Some(password.into()),
            ..Self::default()
        }
    }
    fn key(private_key: &str, passphrase: Option<&str>) -> Self {
        Self {
            private_key: Some(private_key.into()),
            passphrase: passphrase.map(str::to_owned),
            ..Self::default()
        }
    }
}

fn app(config: &Path, hosts: &[Host]) -> App {
    fs::create_dir_all(config).unwrap();
    fs::write(
        config.join("hosts.json"),
        serde_json::to_vec(hosts).unwrap(),
    )
    .unwrap();
    let app = tauri::test::mock_app();
    app.manage(AppState::new(config.into()).unwrap());
    app
}

/// The product's direct login: host-key verification, authentication and a PTY shell.
async fn login(app: &App, host_id: &str, credentials: Credentials) -> Result<(String, Events)> {
    let (events, rx) = json_events();
    let Credentials {
        password,
        private_key,
        passphrase,
    } = credentials;
    let connected = start_session(
        &app.state(),
        host_id.into(),
        password,
        private_key,
        passphrase,
        80,
        24,
        events,
    )
    .await?;
    Ok((connected.session_id, rx))
}

fn error_json(error: SshError) -> serde_json::Value {
    serde_json::to_value(error).unwrap()
}

async fn remote(app: &App, id: &str, command: &str) -> String {
    let session = app.state::<AppState>().session(id).await.unwrap();
    exec(&session, &access_lease(), command.into())
        .await
        .unwrap()
}

/// Types into the interactive shell and waits for the remote's expanded marker.
async fn shell_marker(app: &App, id: &str, rx: &mut Events, label: &str, remote: &str) {
    write_stdin(
        access_lease(),
        app.state(),
        id.into(),
        format!("printf 'PARITY_%s_%s\\n' {label} \"$LAZYSH_PARITY_REMOTE\"\r"),
        None,
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    let session = app.state::<AppState>().session(id).await.unwrap();
    let expected = format!("PARITY_{label}_{remote}");
    let mut output = Vec::new();
    timeout(Duration::from_secs(10), async {
        while !String::from_utf8_lossy(&output).contains(&expected) {
            let event = rx.recv().await.unwrap();
            assert_ne!(event["type"], "closed", "{event}");
            if let Some(data) = event["data"].as_array() {
                output.extend(data.iter().map(|value| value.as_u64().unwrap() as u8));
                acknowledge(&session, data.len() as u32).unwrap();
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{expected} missing: {}", String::from_utf8_lossy(&output)));
}

async fn mosh_error(app: &App, id: &str) -> SshError {
    connect_mosh(
        access_lease(),
        app.state(),
        id.into(),
        Default::default(),
        None,
        80,
        24,
        Channel::new(|_| Ok(())),
    )
    .await
    .err()
    .unwrap()
    .into_inner()
    .unwrap()
}

async fn et_error(app: &App, id: &str) -> SshError {
    crate::et::connect_et(
        access_lease(),
        app.state(),
        id.into(),
        Default::default(),
        80,
        24,
        Channel::new(|_| Ok(())),
    )
    .await
    .err()
    .unwrap()
    .into_inner()
    .unwrap()
}

/// Every case is bounded; a wedged handshake fails instead of hanging CI.
async fn bounded(case: impl std::future::Future<Output = ()>) {
    timeout(Duration::from_secs(120), case)
        .await
        .expect("OpenSSH parity case deadline");
}

#[tokio::test]
#[ignore = "requires OpenSSH sshd and nss_wrapper; run with test:openssh-connections"]
async fn openssh_parity_password_login_and_rejection() {
    bounded(async {
        let server = Remote::start("password", free_port()).await;
        let config = tempfile::tempdir().unwrap();
        let app = app(config.path(), &[server.host("password", true)]);
        let (id, mut rx) = login(&app, "password", Credentials::password(PASSWORD))
            .await
            .unwrap();
        shell_marker(&app, &id, &mut rx, "SHELL", "password").await;
        assert_eq!(
            remote(&app, &id, "printf %s \"$HOME\"").await,
            server.home.to_str().unwrap()
        );
        let error = login(&app, "password", Credentials::password("wrong password"))
            .await
            .err()
            .unwrap();
        assert_eq!(error.kind(), "authentication_failed");
        let log = server.sshd.log();
        assert!(
            log.contains(&format!("Accepted password for {USER}")),
            "{log}"
        );
        assert!(
            log.contains(&format!("Failed password for {USER}")),
            "{log}"
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires OpenSSH sshd, ssh-keygen and nss_wrapper; run with test:openssh-connections"]
async fn openssh_parity_encrypted_private_keys() {
    bounded(async {
        let server = Remote::start("encrypted", free_port()).await;
        let config = tempfile::tempdir().unwrap();
        let app = app(config.path(), &[server.host("encrypted", true)]);
        let keys = tempfile::tempdir().unwrap();
        // ssh-keygen writes the bcrypt-KDF OpenSSH format users actually import.
        for (algorithm, bits) in [("ed25519", None), ("rsa", Some("3072"))] {
            let passphrase = format!("{algorithm} parity passphrase");
            let path = keys.path().join(algorithm);
            let mut keygen = std::process::Command::new(tool("ssh-keygen"));
            keygen.args([
                "-q",
                "-t",
                algorithm,
                "-N",
                &passphrase,
                "-C",
                "parity",
                "-f",
            ]);
            keygen.arg(&path);
            if let Some(bits) = bits {
                keygen.args(["-b", bits]);
            }
            local(&mut keygen, keys.path(), None);
            let public = fs::read_to_string(path.with_extension("pub")).unwrap();
            let mut authorized = fs::read_to_string(&server.authorized).unwrap();
            authorized.push_str(&public);
            fs::write(&server.authorized, authorized).unwrap();
            let private = fs::read_to_string(&path).unwrap();
            for (supplied, expected) in [
                (None, "identity_passphrase_required"),
                (Some("wrong passphrase"), "identity_invalid"),
            ] {
                let error = login(&app, "encrypted", Credentials::key(&private, supplied))
                    .await
                    .err()
                    .unwrap();
                assert_eq!(error.kind(), expected, "{algorithm}");
            }
            let (id, _rx) = login(
                &app,
                "encrypted",
                Credentials::key(&private, Some(&passphrase)),
            )
            .await
            .unwrap();
            assert_eq!(
                remote(&app, &id, "printf %s \"$LAZYSH_PARITY_REMOTE\"").await,
                "encrypted"
            );
            let selected = fingerprint(&russh::keys::PublicKey::from_openssh(&public).unwrap());
            let log = server.sshd.log();
            assert!(
                log.lines().any(
                    |line| line.contains(&format!("Accepted publickey for {USER}"))
                        && line.contains(&selected)
                ),
                "{algorithm} {selected}: {log}"
            );
        }
    })
    .await;
}

#[tokio::test]
#[ignore = "requires OpenSSH sshd and nss_wrapper; run with test:openssh-connections"]
async fn openssh_parity_first_use_pin_then_rotated_key_refused() {
    bounded(async {
        let port = free_port();
        let first = Remote::start("first", port).await;
        let config = tempfile::tempdir().unwrap();
        let app = app(config.path(), &[first.host("pinned", false)]);
        let original = fingerprint(first.host_key.public_key());
        let unknown = error_json(
            login(&app, "pinned", Credentials::password(PASSWORD))
                .await
                .err()
                .unwrap(),
        );
        assert_eq!(unknown["kind"], "unknown_host_key");
        assert_eq!(unknown["fingerprint"], original);
        assert!(app
            .state::<AppState>()
            .host("pinned")
            .unwrap()
            .fingerprint
            .is_none());
        trust_host_key_inner(&app.state(), "pinned".into(), original.clone(), None).unwrap();
        let reloaded = AppState::new(config.path().into()).unwrap();
        assert_eq!(
            reloaded.host("pinned").unwrap().fingerprint,
            Some(original.clone())
        );
        let (id, _rx) = login(&app, "pinned", Credentials::password(PASSWORD))
            .await
            .unwrap();
        assert_eq!(
            remote(&app, &id, "printf %s \"$LAZYSH_PARITY_REMOTE\"").await,
            "first"
        );
        disconnect(app.state(), id).await.unwrap();
        // The same probe sees credentials when they are sent, so its absence below counts.
        assert!(first.sshd.log().contains("userauth-request"));
        drop(first);

        let second = Remote::start("second", port).await;
        let rotated = fingerprint(second.host_key.public_key());
        assert_ne!(rotated, original);
        let changed = error_json(
            login(&app, "pinned", Credentials::password(PASSWORD))
                .await
                .err()
                .unwrap(),
        );
        assert_eq!(changed["kind"], "host_key_changed");
        assert_eq!(changed["fingerprint"], rotated);
        assert_eq!(changed["hostId"], "pinned");
        let log = second.sshd.log();
        assert!(log.contains("remote software version russh"), "{log}");
        assert!(!log.contains("userauth-request"), "{log}");
        assert!(!log.contains("password for"), "{log}");
        let error = trust_host_key_inner(&app.state(), "pinned".into(), rotated, None)
            .err()
            .unwrap();
        assert_eq!(error.kind(), "invalid_trust");
        let reloaded = AppState::new(config.path().into()).unwrap();
        assert_eq!(reloaded.host("pinned").unwrap().fingerprint, Some(original));
    })
    .await;
}

#[tokio::test]
#[ignore = "requires OpenSSH sshd and nss_wrapper; run with test:openssh-connections"]
async fn openssh_parity_bastion_routes_shell_to_target() {
    bounded(async {
        let bastion = Remote::start("bastion", free_port()).await;
        let target = Remote::start("target", free_port()).await;
        let jump = bastion.host("bastion", true);
        let routed = Host {
            jump_host_id: Some("bastion".into()),
            ..target.host("target", true)
        };
        let hosts = [jump.clone(), routed.clone()];
        crate::routing::validate(&routed, &hosts).unwrap();
        let config = tempfile::tempdir().unwrap();
        let app = app(config.path(), &hosts);
        let state = app.state::<AppState>();
        // The bastion uses a password and the target its own key, as separate credentials.
        let jump_handle = authenticate(&state, &jump, Some(PASSWORD.into()), None, None)
            .await
            .unwrap();
        let tunnel = crate::routing::through_bastion(
            &state,
            &routed,
            Arc::new(jump_handle),
            &access_lease(),
        )
        .await
        .unwrap();
        let Credentials { private_key, .. } = target.key();
        let handle = Arc::new(
            authenticate_handle(tunnel, &routed, None, private_key, None)
                .await
                .unwrap(),
        );
        let (channel, initial) = open_terminal(&handle, 80, 24, None).await.unwrap();
        let (events, mut rx) = json_events();
        let id = spawn_terminal(&state, access_lease(), handle, channel, initial, events)
            .await
            .unwrap()
            .session_id;
        shell_marker(&app, &id, &mut rx, "SHELL", "target").await;
        assert_eq!(
            remote(&app, &id, "printf %s \"$HOME\"").await,
            target.home.to_str().unwrap()
        );
        let bastion_log = bastion.sshd.log();
        assert!(
            bastion_log.contains(&format!("target 127.0.0.1 port {}", target.sshd.port)),
            "{bastion_log}"
        );
        assert!(bastion_log.contains(&format!("Accepted password for {USER}")));
        assert!(!bastion_log.contains("Accepted publickey"));
        let target_log = target.sshd.log();
        assert!(target_log.contains(&format!("Accepted publickey for {USER}")));
        assert!(!target_log.contains("password for"), "{target_log}");
        // A routed session is SSH-only, so Auto skips Mosh and ET.
        assert_eq!(mosh_error(&app, &id).await.kind(), "mosh_unsupported_route");
        assert_eq!(et_error(&app, &id).await.kind(), "et_unsupported_route");
        shell_marker(&app, &id, &mut rx, "AFTER", "target").await;
    })
    .await;
}

#[tokio::test]
#[ignore = "requires OpenSSH sshd, ssh-add and nss_wrapper; run with test:openssh-connections"]
async fn openssh_parity_agent_forwarding_is_opt_in_single_identity() {
    bounded(async {
        let server = Remote::start("agent", free_port()).await;
        let forwarding = Host {
            forward_agent: true,
            ..server.host("forwarding", true)
        };
        let plain = server.host("plain", true);
        let config = tempfile::tempdir().unwrap();
        let app = app(config.path(), &[plain.clone(), forwarding.clone()]);
        let state = app.state::<AppState>();
        let probe = "printf 'SOCK=%s\\n' \"${SSH_AUTH_SOCK-unset}\"; ssh-add -l";
        let Credentials { private_key, .. } = server.key();
        let selected = fingerprint(server.user_key.public_key());
        for (host, enabled) in [(&plain, false), (&forwarding, true), (&plain, false)] {
            let handle = Arc::new(
                authenticate(&state, host, None, private_key.clone(), None)
                    .await
                    .unwrap(),
            );
            let (status, output) = terminal_command(&handle, probe.into()).await;
            if enabled {
                assert_eq!(status, Some(0), "{output}");
                assert!(!output.contains("SOCK=unset"), "{output}");
                let identities: Vec<_> = output
                    .lines()
                    .filter(|line| line.contains("SHA256:"))
                    .collect();
                assert_eq!(identities.len(), 1, "{output}");
                assert!(identities[0].contains(&selected), "{output}");
            } else {
                // ssh-add exits 2 when no agent is reachable.
                assert_eq!(status, Some(2), "{output}");
                assert!(output.contains("SOCK=unset"), "{output}");
            }
            handle
                .disconnect(russh::Disconnect::ByApplication, "probe complete", "en")
                .await
                .unwrap();
        }
        let error = login(&app, "forwarding", Credentials::password(PASSWORD))
            .await
            .err()
            .unwrap();
        assert_eq!(error.kind(), "forwarding_requires_key");
        let (id, _rx) = login(&app, "forwarding", server.key()).await.unwrap();
        // Forwarding keeps the selected identity on SSH, so Auto skips Mosh and ET.
        assert_eq!(
            mosh_error(&app, &id).await.kind(),
            "mosh_unsupported_forwarding"
        );
        assert_eq!(et_error(&app, &id).await.kind(), "et_agent_forwarding");
    })
    .await;
}

#[tokio::test]
#[ignore = "requires OpenSSH sshd and nss_wrapper; run with test:openssh-connections"]
async fn openssh_parity_auto_falls_back_to_ssh_without_mosh_or_et() {
    bounded(async {
        let server = Remote::start("auto", free_port()).await;
        let host = Host {
            transport: Some(Transport::Auto),
            ..server.host("auto", true)
        };
        let config = tempfile::tempdir().unwrap();
        let app = app(config.path(), std::slice::from_ref(&host));
        let (id, mut rx) = login(&app, "auto", server.key()).await.unwrap();
        let absent = "for tool in mosh-server etterminal; do \
            command -v \"$tool\" || printf '%s-absent ' \"$tool\"; done";
        assert_eq!(
            remote(&app, &id, absent).await,
            "mosh-server-absent etterminal-absent "
        );
        // Auto tries Mosh, then ET, over the verified SSH session, then keeps SSH.
        let started = tokio::time::Instant::now();
        let mosh = mosh_error(&app, &id).await;
        assert_eq!(mosh.kind(), "mosh_bootstrap", "{}", mosh.message);
        let et = et_error(&app, &id).await;
        assert_eq!(et.kind(), "et_bootstrap", "{}", et.message);
        assert!(AUTO_FALLBACK.contains(&mosh.kind()) && AUTO_FALLBACK.contains(&et.kind()));
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );
        let sessions = app
            .state::<AppState>()
            .sessions
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            sessions.as_slice(),
            std::slice::from_ref(&id),
            "only SSH remains"
        );
        shell_marker(&app, &id, &mut rx, "SSH", "auto").await;
        assert_eq!(
            app.state::<AppState>().host("auto").unwrap().fingerprint,
            host.fingerprint
        );
    })
    .await;
}
