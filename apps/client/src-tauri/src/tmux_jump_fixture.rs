//! Fixture-only Jump To investigation. No product API, helper installation or IPC.
use super::*;
use std::{
    io::Read,
    os::unix::fs::PermissionsExt,
    process::{Child, Command, Stdio},
};
use tauri::Manager;

const BOUND: Duration = Duration::from_secs(3);
type Probe<T> = std::result::Result<T, String>;

fn fixture_key() -> russh::keys::PrivateKey {
    russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap()
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Fixture {
    dir: tempfile::TempDir,
    daemon: Process,
    handle: Arc<SshHandle>,
    host: Host,
    tmux: String,
    environment: Vec<(&'static str, String)>,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_herdr(None).await
    }
    async fn with_herdr(herdr: Option<&std::path::Path>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let tmux = std::env::var("LAZYSH_TEST_TMUX").unwrap_or_else(|_| "tmux".into());
        let tmux_path = std::path::Path::new(&tmux)
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| format!("{}:/usr/bin:/bin", path.display()))
            .unwrap_or_else(|| "/usr/bin:/bin".into());
        let mut environment = vec![
            ("HOME", dir.path().display().to_string()),
            ("ZDOTDIR", dir.path().display().to_string()),
            ("TMUX_TMPDIR", dir.path().display().to_string()),
            ("PATH", tmux_path),
        ];
        if let Some(binary) = herdr {
            assert!(
                binary.is_absolute(),
                "Herdr fixture binary must be absolute"
            );
            environment
                .last_mut()
                .unwrap()
                .1
                .insert_str(0, &format!("{}:", binary.parent().unwrap().display()));
            for (key, child) in [
                ("XDG_CONFIG_HOME", "config-home"),
                ("XDG_CACHE_HOME", "cache-home"),
                ("XDG_STATE_HOME", "state-home"),
                ("XDG_RUNTIME_DIR", "runtime"),
            ] {
                let path = dir.path().join(child);
                fs::create_dir(&path).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
                environment.push((key, path.display().to_string()));
            }
        }
        assert!(
            environment.iter().all(|(_, value)| !value
                .chars()
                .any(|c| c.is_whitespace() || c == '"' || c == '\\')),
            "owned sshd fixture paths must be plain configuration tokens"
        );
        let settings = environment
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(" ");
        let state = AppState::new(dir.path().join("config")).unwrap();
        let host_key = fixture_key();
        let user_key = fixture_key();
        let host_file = dir.path().join("host_key");
        fs::write(
            &host_file,
            host_key.to_openssh(Default::default()).unwrap().as_bytes(),
        )
        .unwrap();
        fs::set_permissions(&host_file, fs::Permissions::from_mode(0o600)).unwrap();
        let authorized = dir.path().join("authorized_keys");
        fs::write(&authorized, user_key.public_key().to_openssh().unwrap()).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = dir.path().join("sshd_config");
        // Use isolated HOME/ZDOTDIR; identity comes from the owned exec frame,
        // never a user prompt, process-list timing or guessed newest client.
        fs::write(&config, format!("ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nAuthorizedKeysFile {}\nPidFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nLogLevel ERROR\nSetEnv {settings}\n", host_file.display(), authorized.display(), dir.path().join("sshd.pid").display())).unwrap();
        let sshd = Command::new("sh")
            .args(["-c", "command -v sshd"])
            .output()
            .unwrap();
        assert!(sshd.status.success());
        let sshd = String::from_utf8(sshd.stdout).unwrap();
        assert!(sshd.trim().starts_with('/'));
        let mut daemon = Process(
            Command::new(sshd.trim())
                .args(["-D", "-e", "-f"])
                .arg(config)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        timeout(BOUND, async {
            loop {
                if let Some(status) = daemon.0.try_wait().unwrap() {
                    let mut stderr = String::new();
                    daemon
                        .0
                        .stderr
                        .take()
                        .unwrap()
                        .take(8192)
                        .read_to_string(&mut stderr)
                        .unwrap();
                    panic!("owned sshd exited {status}: {stderr}");
                }
                if tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .is_ok()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let host = Host {
            transport: None,
            mosh: None,
            et: None,
            id: "tmux-probe".into(),
            name: "Owned tmux fixture".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: std::env::var("USER").unwrap(),
            fingerprint: Some(
                host_key
                    .public_key()
                    .fingerprint(HashAlg::Sha256)
                    .to_string(),
            ),
            jump_host_id: None,
            credentials_stored: false,
            biometric_unlock: false,
            forward_agent: false,
        };
        let handle = Arc::new(
            authenticate(
                &state,
                &host,
                None,
                Some(user_key.to_openssh(Default::default()).unwrap().to_string()),
                None,
            )
            .await
            .unwrap(),
        );
        Self {
            dir,
            daemon,
            handle,
            host,
            tmux,
            environment,
        }
    }
    fn prepare_launch(
        &self,
        state: &AppState,
        lease: &AccessLease,
        mux: &str,
    ) -> (
        crate::desktop_launch::LaunchState,
        String,
        crate::desktop_launch::PreparedHost,
    ) {
        let intent = crate::desktop_launch::parse(
            ["lazysh", "--host", &self.host.id, "--mux", mux].map(std::ffi::OsString::from),
            || panic!("remote fixture must not inspect cwd"),
        )
        .unwrap();
        let launch = crate::desktop_launch::LaunchState::new(intent);
        let receipt = launch.read(lease).unwrap().host_receipt.unwrap();
        let prepared = launch.prepare_host(state, &receipt, lease).unwrap();
        (launch, receipt, prepared)
    }
    fn socket(&self) -> PathBuf {
        self.dir.path().join("tmux.sock")
    }
    fn prefix(&self) -> String {
        format!(
            "{} -u -f /dev/null -S {}",
            quote(&self.tmux),
            quote(self.socket().to_str().unwrap())
        )
    }
    fn local(&self, args: &[&str]) -> String {
        let output = Command::new(&self.tmux)
            .arg("-u")
            .arg("-f")
            .arg("/dev/null")
            .arg("-S")
            .arg(self.socket())
            .args(args)
            .env_remove("TMUX")
            .env("HOME", self.dir.path())
            .env("ZDOTDIR", self.dir.path())
            .env("SHELL", "/bin/sh")
            .env_remove("ENV")
            .env_remove("BASH_ENV")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "owned tmux: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
    async fn display(&self, session: &str) -> Display {
        let marker = format!("LAZYSH_ATTACH_{}", uuid::Uuid::new_v4().simple());
        let command = format!(
            "printf '{}\\t%s\\t%s\\n' \"$$\" \"$(tty)\"; exec {} attach-session -t {}",
            marker,
            self.prefix(),
            quote(session)
        );
        let (mut channel, mut bytes) = open_terminal(&self.handle, 80, 24, Some(command))
            .await
            .unwrap();
        let identity = timeout(BOUND, async {
            loop {
                assert!(bytes.len() < 8192, "attach frame exceeded bound");
                if let Some(end) = bytes.iter().position(|b| *b == b'\n') {
                    let line = std::str::from_utf8(&bytes[..end])
                        .unwrap()
                        .trim_end_matches('\r');
                    let fields = line.split('\t').collect::<Vec<_>>();
                    assert_eq!(fields.len(), 3);
                    assert_eq!(fields[0], marker);
                    let pid = fields[1].parse::<u32>().unwrap();
                    assert!(pid > 0);
                    let tty = fields[2].to_owned();
                    assert!(
                        tty.starts_with("/dev/")
                            && tty.len() < 128
                            && tty
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"/_-".contains(&b))
                    );
                    return Identity {
                        pid,
                        tty,
                        live: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                    };
                }
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => bytes.extend_from_slice(&data),
                    message => panic!("attach ended before owned frame: {message:?}"),
                }
            }
        })
        .await
        .unwrap();
        Display { channel, identity }
    }
    async fn control(&self, session: &str) -> Control {
        let mut channel = self.handle.channel_open_session().await.unwrap();
        channel
            .exec(
                true,
                format!(
                    "{} -C attach-session -f no-output,ignore-size -t {}",
                    self.prefix(),
                    quote(session)
                ),
            )
            .await
            .unwrap();
        let initial = request_ok(&mut channel).await.unwrap();
        let mut control = Control {
            channel,
            bytes: initial,
            dead: false,
            jumps_sent: 0,
        };
        control.block().await.expect("initial control attachment");
        control
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Command::new(&self.tmux)
            .arg("-S")
            .arg(self.socket())
            .arg("kill-server")
            .output();
        let _ = self.daemon.0.kill();
    }
}
#[derive(Clone, Debug)]
struct Identity {
    pid: u32,
    tty: String,
    live: Arc<std::sync::atomic::AtomicBool>,
}
struct Display {
    channel: OwnedChannel,
    identity: Identity,
}
impl Display {
    async fn close(&mut self) {
        self.identity
            .live
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = self.channel.eof().await;
        let _ = self.channel.close().await;
    }
}
struct Control {
    channel: russh::Channel<client::Msg>,
    bytes: Vec<u8>,
    dead: bool,
    jumps_sent: usize,
}
impl Control {
    async fn line(&mut self) -> Probe<String> {
        if self.dead {
            return Err("control closed".into());
        }
        loop {
            if let Some(end) = self.bytes.iter().position(|b| *b == b'\n') {
                let line = self.bytes.drain(..=end).collect::<Vec<_>>();
                return String::from_utf8(line[..line.len() - 1].to_vec())
                    .map_err(|_| "invalid control UTF8".into());
            }
            if self.bytes.len() > 64 * 1024 {
                self.dead = true;
                return Err("control frame exceeded bound".into());
            }
            match timeout(BOUND, self.channel.wait()).await {
                Ok(Some(ChannelMsg::Data { data })) => self.bytes.extend_from_slice(&data),
                Ok(Some(ChannelMsg::Eof | ChannelMsg::Close)) | Ok(None) => {
                    self.dead = true;
                    return Err("control closed".into());
                }
                Err(_) => {
                    self.dead = true;
                    return Err("control timeout".into());
                }
                _ => {}
            }
        }
    }
    async fn block(&mut self) -> Probe<Vec<String>> {
        let begin = loop {
            let line = self.line().await?;
            if let Some(rest) = line.strip_prefix("%begin ") {
                break rest.to_owned();
            }
            if line.starts_with("%exit") {
                self.dead = true;
                return Err("control exited".into());
            }
        };
        let mut lines = Vec::new();
        let mut size = 0;
        loop {
            let line = self.line().await?;
            if line == format!("%end {begin}") {
                return Ok(lines);
            }
            if line == format!("%error {begin}") {
                return Err(format!("tmux error: {}", lines.join(" | ")));
            }
            size += line.len();
            if size > 64 * 1024 {
                self.dead = true;
                return Err("control response exceeded bound".into());
            }
            lines.push(line);
        }
    }
    async fn request(&mut self, command: String) -> Probe<Vec<String>> {
        if self.dead {
            return Err("control closed".into());
        }
        self.channel
            .data(format!("{command}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        self.block().await
    }
    async fn find_position(&mut self, client: &Identity) -> Probe<Option<(String, String)>> {
        let rows = self
            .request(
                "list-clients -F '#{client_pid}|#{client_tty}|#{session_id}|#{window_id}'".into(),
            )
            .await?;
        let pid = client.pid.to_string();
        let mut found = None;
        for line in rows {
            let f = line.split('|').collect::<Vec<_>>();
            if f.len() != 4 {
                return Err("malformed client inventory".into());
            }
            if f[0] == pid && f[1] == client.tty {
                if found.is_some() {
                    return Err("ambiguous display identity".into());
                }
                found = Some((f[2].to_owned(), f[3].to_owned()));
            }
        }
        Ok(found)
    }
    async fn position(&mut self, client: &Identity) -> Probe<(String, String)> {
        self.find_position(client)
            .await?
            .ok_or("display identity absent".into())
    }
    async fn wait_display(&mut self, client: &Identity, present: bool) -> Probe<()> {
        // Readiness is exact PID+TTY registration, not an age/name heuristic.
        // This performs no mutation and has one absolute three-second bound.
        timeout(BOUND, async {
            loop {
                let found = self.find_position(client).await?.is_some();
                if self.dead {
                    return Err("control closed during registration".into());
                }
                if found == present {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| "exact display registration timed out".to_owned())?
    }
    async fn jump(&mut self, client: &Identity, session: &str, window: &str) -> Probe<()> {
        if !client.live.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("local display ownership revoked".into());
        }
        assert!(session.starts_with('$') && session[1..].bytes().all(|b| b.is_ascii_digit()));
        assert!(window.starts_with('@') && window[1..].bytes().all(|b| b.is_ascii_digit()));
        let marker = format!("LAZYSH_JUMP_{}", uuid::Uuid::new_v4().simple());
        let tuple = format!(
            "#{{&&:#{{==:#{{client_pid}},{}}},#{{==:#{{client_tty}},{}}}}}",
            client.pid, client.tty
        );
        let attached = format!("#{{&&:#{{!=:#{{client_session}},}},{tuple}}}");
        let normal = format!("#{{&&:#{{==:#{{client_control_mode}},0}},{attached}}}");
        let guard = format!("#{{L:#{{?{normal},1,}}}}");
        // -F is a synchronous format test: no shell job/yield between validation
        // and the inserted switch. All data here is validated PID/TTY/$ID/@ID.
        let command=format!("if-shell -F {} {{ switch-client -E -c {} -t {}; display-message -p {} }} {{ display-message -p {} }}",quote(&guard),quote(&client.tty),quote(&format!("{session}:{window}")),quote(&format!("{marker}:ok")),quote(&format!("{marker}:gone")));
        if self.dead {
            return Err("control closed".into());
        }
        self.jumps_sent += 1;
        self.channel
            .data(format!("{command}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        for _ in 0..8 {
            let rows = self.block().await?;
            if rows.iter().any(|v| v == &format!("{marker}:ok")) {
                return Ok(());
            }
            if rows.iter().any(|v| v == &format!("{marker}:gone")) {
                return Err("display identity absent".into());
            }
        }
        Err("navigation completion absent".into())
    }
    async fn close(&mut self) {
        let _ = self.channel.close().await;
        self.dead = true;
    }
    async fn ended(&mut self) {
        let result = self.block().await;
        assert!(result.is_err());
        assert!(self.dead);
    }
}

async fn jump_probe() {
    let f = Fixture::new().await;
    let alpha = f.local(&[
        "new-session",
        "-d",
        "-s",
        "alpha",
        "-P",
        "-F",
        "#{session_id}:#{window_id}",
    ]);
    let beta = f.local(&[
        "new-session",
        "-d",
        "-s",
        "beta",
        "-P",
        "-F",
        "#{session_id}:#{window_id}",
    ]);
    let (a, aw) = alpha.split_once(':').unwrap();
    let (b, bw) = beta.split_once(':').unwrap();
    let mut display = f.display(a).await;
    let mut control = f.control(a).await;
    control.wait_display(&display.identity, true).await.unwrap();
    assert_eq!(
        control.position(&display.identity).await.unwrap(),
        (a.into(), aw.into())
    );
    let process = Command::new("ps")
        .args(["-p", &display.identity.pid.to_string(), "-o", "comm="])
        .output()
        .unwrap();
    assert!(process.status.success());
    assert!(
        String::from_utf8_lossy(&process.stdout).contains("tmux"),
        "exec must preserve shell PID as the real tmux client"
    );
    control.jump(&display.identity, b, bw).await.unwrap();
    assert_eq!(
        control.position(&display.identity).await.unwrap(),
        (b.into(), bw.into())
    );

    // A name replacement must never retarget a snapshot's numeric identity.
    f.local(&["rename-session", "-t", b, "renamed-beta"]);
    let replacement = f.local(&[
        "new-session",
        "-d",
        "-s",
        "beta",
        "-P",
        "-F",
        "#{session_id}:#{window_id}",
    ]);
    assert_ne!(replacement, beta);
    control.jump(&display.identity, b, bw).await.unwrap();
    assert_eq!(control.position(&display.identity).await.unwrap().0, b);

    // Delete/recreate the same window index: reject the old @ID explicitly.
    let old = f.local(&[
        "new-window",
        "-d",
        "-t",
        b,
        "-n",
        "replace",
        "-P",
        "-F",
        "#{window_id}",
    ]);
    let index = f.local(&["display-message", "-p", "-t", &old, "#{window_index}"]);
    f.local(&["kill-window", "-t", &old]);
    let fresh = f.local(&[
        "new-window",
        "-d",
        "-t",
        &format!("{b}:{index}"),
        "-n",
        "replace",
        "-P",
        "-F",
        "#{window_id}",
    ]);
    assert_ne!(old, fresh);
    assert!(control.jump(&display.identity, b, &old).await.is_err());
    assert_eq!(control.position(&display.identity).await.unwrap().1, bw);

    let stale = f.local(&[
        "new-session",
        "-d",
        "-s",
        "gone",
        "-P",
        "-F",
        "#{session_id}",
    ]);
    f.local(&["kill-session", "-t", &stale]);
    let fresh_session = f.local(&[
        "new-session",
        "-d",
        "-s",
        "gone",
        "-P",
        "-F",
        "#{session_id}:#{window_id}",
    ]);
    assert!(!fresh_session.starts_with(&format!("{stale}:")));
    assert!(control
        .jump(
            &display.identity,
            &stale,
            fresh_session.split_once(':').unwrap().1
        )
        .await
        .is_err());
    assert_eq!(control.position(&display.identity).await.unwrap().0, b);

    // A detached display's binding must not operate on a new SSH display.
    let old_identity = display.identity.clone();
    old_identity
        .live
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let sent = control.jumps_sent;
    assert!(control.jump(&old_identity, a, aw).await.is_err());
    assert_eq!(
        control.jumps_sent, sent,
        "local cancellation must reject BEFORE wire dispatch"
    );
    assert!(
        control.position(&old_identity).await.is_ok(),
        "local cancellation is independent of remote client exit"
    );
    display.close().await;
    control.wait_display(&old_identity, false).await.unwrap();
    let mut next = f.display(a).await;
    control.wait_display(&next.identity, true).await.unwrap();
    assert_ne!(old_identity.pid, next.identity.pid);
    assert!(control.jump(&old_identity, b, bw).await.is_err());
    let stale_remote = Identity {
        pid: old_identity.pid,
        tty: next.identity.tty.clone(),
        live: Arc::new(std::sync::atomic::AtomicBool::new(true)),
    };
    assert!(
        control.jump(&stale_remote, b, bw).await.is_err(),
        "server-side guard must reject old PID even with replacement client's exact TTY"
    );
    assert_eq!(control.position(&next.identity).await.unwrap().0, a);
    control.jump(&next.identity, b, bw).await.unwrap();
    assert_eq!(control.position(&next.identity).await.unwrap().0, b);

    control.close().await;
    let closed_sent = control.jumps_sent;
    assert!(control.jump(&next.identity, a, aw).await.is_err());
    assert_eq!(
        control.jumps_sent, closed_sent,
        "retired control cannot dispatch"
    );
    assert_eq!(
        f.local(&["display-message", "-p", "-t", b, "#{window_id}"]),
        bw
    );
    let mut pinned = f.control(a).await;
    assert!(pinned.position(&next.identity).await.is_ok());
    f.local(&["kill-server"]);
    pinned.ended().await;
    let reused = f.local(&[
        "new-session",
        "-d",
        "-s",
        "alpha",
        "-P",
        "-F",
        "#{session_id}:#{window_id}",
    ]);
    assert_eq!(
        reused, alpha,
        "server restart should reuse numeric IDs in this fixture"
    );
    assert!(
        next.identity.live.load(std::sync::atomic::Ordering::SeqCst),
        "exercise server revocation independently of local display cancellation"
    );
    let retired_sent = pinned.jumps_sent;
    assert!(pinned.jump(&next.identity, a, aw).await.is_err());
    assert_eq!(
        pinned.jumps_sent, retired_sent,
        "dead retained peer must never reopen against replacement IDs"
    );
    assert_eq!(f.local(&["list-clients", "-F", "#{client_pid}"]), "");
    next.close().await;
    eprintln!("tmux prototype: exec PID+TTY verified; exact session/window selection; name/index replacement rejected; detached display guard rejected; control closure and restart/ID reuse fail closed");
}

#[tokio::test]
#[ignore = "requires owned local OpenSSH sshd and tmux 3.4+; fixture-only prototype"]
async fn real_tmux_jump_identity_guard_and_replacement() {
    timeout(Duration::from_secs(30), jump_probe())
        .await
        .expect("bounded owned SSH/tmux experiment");
}

#[tokio::test]
#[ignore = "requires owned local OpenSSH sshd and tmux 3.4+; product actor acceptance"]
async fn real_tmux_jump_product_actor_labels_and_leases() {
    timeout(Duration::from_secs(30), product_actor_probe())
        .await
        .expect("bounded product actor fixture");
}
async fn product_actor_probe() {
    let f = Fixture::new().await;
    let a = f.local(&[
        "new-session",
        "-d",
        "-s",
        "alpha",
        "-P",
        "-F",
        "#{session_id}",
    ]);
    let hostile = "a|b #{session_name} \\ ; ' $ %end 1 2 3 界";
    let b = f.local(&[
        "new-session",
        "-d",
        "-s",
        &hostile.replace("#", "##"),
        "-P",
        "-F",
        "#{session_id}:#{window_id}",
    ]);
    let (bid, bwid) = b.split_once(':').unwrap();
    let long_name = "a".repeat(201);
    let long_id = f.local(&[
        "new-session",
        "-d",
        "-s",
        &long_name,
        "-P",
        "-F",
        "#{session_id}",
    ]);
    assert_eq!(
        f.local(&[
            "display-message",
            "-p",
            "-t",
            &a,
            "#{m/r:[[:cntrl:]],work\tbuild}"
        ]),
        "1"
    );
    assert_eq!(
        f.local(&[
            "display-message",
            "-p",
            "-t",
            &a,
            "#{s/#{l:[[:cntrl:]]}/?/:#{l:work\tbuild}}"
        ]),
        "work?build"
    );
    let expected_name = f.local(&["display-message", "-p", "-t", bid, "#{session_name}"]);
    assert!(expected_name.contains("a|b #{session_name}"));
    let window_name = "next|\\tab; '#{pane_id}'";
    f.local(&["rename-window", "-t", bwid, &window_name.replace("#", "##")]);
    let expected_window = f.local(&["display-message", "-p", "-t", bwid, "#{window_name}"]);
    let marker = format!("LAZYSH_ATTACH_{}", uuid::Uuid::new_v4().simple());
    let command = crate::tmux_jump::attach_with_prefix("alpha", &marker, &f.prefix());
    let command = format!("printf 'owned startup banner\\r\\n'; {command}");
    let (mut channel, mut initial) = open_terminal(&f.handle, 80, 24, Some(command))
        .await
        .unwrap();
    let identity = crate::tmux_jump::handshake(&mut channel, &mut initial, &marker)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&initial).contains("owned startup banner"));
    assert!(!String::from_utf8_lossy(&initial).contains(&marker));
    let access = AccessState::default();
    access.initialize(true, true, String::new()).unwrap();
    access.authorize(access.generation().unwrap()).unwrap();
    let lease = crate::ssh::test_support::ready_lease(&access);
    let control = crate::tmux_jump::prepare_command(
        &f.handle,
        identity.clone(),
        format!(
            "{} -C attach-session -f no-output,ignore-size -t {}",
            f.prefix(),
            quote(&a)
        ),
        &lease,
    )
    .await
    .unwrap();
    let (cancel, mut cancellation) = watch::channel(false);
    let (binding, queued) = crate::tmux_jump::start_with_revoked_queue_fixture(
        control,
        cancellation.clone(),
        lease.clone(),
    );
    assert!(queued.await.is_err());
    access.authorize(access.generation().unwrap()).unwrap();
    let lease = crate::ssh::test_support::ready_lease(&access);
    let snapshot = binding.call(&lease, &mut cancellation, None).await.unwrap();
    let json = serde_json::to_value(snapshot).unwrap();
    let target = json["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == bid)
        .unwrap();
    assert_eq!(target["name"], expected_name);
    assert_eq!(target["restoreName"], expected_name);
    let oversized = json["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == long_id)
        .unwrap();
    assert_eq!(oversized["name"], long_name);
    assert!(oversized["restoreName"].is_null());
    assert_eq!(target["windows"][0]["name"], expected_window);
    let selected = f.local(&[
        "new-window",
        "-t",
        &a,
        "-n",
        "window-notification",
        "-P",
        "-F",
        "#{window_id}",
    ]);
    let notified =
        serde_json::to_value(binding.call(&lease, &mut cancellation, None).await.unwrap()).unwrap();
    assert_eq!(notified["current"]["windowId"], selected);
    let generation = json["generation"].as_str().unwrap().to_owned();
    // The completed snapshot leaves no outstanding I/O. An idle actor may
    // survive locking; the separate partial-response case below must retire.
    access.lock().unwrap();
    assert!(binding
        .call(
            &lease,
            &mut cancellation,
            Some((generation.clone(), bid.into(), bwid.into()))
        )
        .await
        .is_err());
    access.authorize(access.generation().unwrap()).unwrap();
    let fresh = crate::ssh::test_support::ready_lease(&access);
    let moved = binding
        .call(
            &fresh,
            &mut cancellation,
            Some((generation, bid.into(), bwid.into())),
        )
        .await
        .unwrap();
    let moved = serde_json::to_value(moved).unwrap();
    assert_eq!(moved["current"]["sessionId"], bid);
    assert_eq!(moved["current"]["windowId"], bwid);
    cancel.send_replace(true);
    assert!(binding.call(&fresh, &mut cancellation, None).await.is_err());
    timeout(BOUND, binding.retired()).await.unwrap();

    let retained = crate::tmux_jump::prepare_command(
        &f.handle,
        identity.clone(),
        format!(
            "{} -C attach-session -f no-output,ignore-size -t {}",
            f.prefix(),
            quote(&a)
        ),
        &fresh,
    )
    .await
    .unwrap();
    let (_epoch_cancel, mut epoch_cancel) = watch::channel(false);
    let retained = crate::tmux_jump::start(retained, epoch_cancel.clone());
    let prior = serde_json::to_value(
        retained
            .call(&fresh, &mut epoch_cancel, None)
            .await
            .unwrap(),
    )
    .unwrap();
    f.local(&["kill-server"]);
    timeout(BOUND, retained.retired()).await.unwrap();
    let reused = f.local(&[
        "new-session",
        "-d",
        "-s",
        "alpha",
        "-P",
        "-F",
        "#{session_id}",
    ]);
    assert_eq!(
        reused, a,
        "fixture must reuse session identity on server replacement"
    );
    assert!(retained
        .call(
            &fresh,
            &mut epoch_cancel,
            Some((
                prior["generation"].as_str().unwrap().into(),
                reused,
                "@0".into()
            ))
        )
        .await
        .is_err());
    assert_eq!(f.local(&["list-clients", "-F", "#{client_pid}"]), "");

    // A partial command response must never be reused after a lease is
    // revoked. The owned remote fixture marks that it sent the prefix;
    // there is no arbitrary sleep or mutation retry to arrange the race.
    let phase = f.dir.path().join("partial-control-ready");
    let command=format!("IFS= read -r request; printf '%s\\n' '%begin 1 2 3'; printf partial; printf ready > {}; IFS= read -r next",quote(phase.to_str().unwrap()));
    let mut stub = f.handle.channel_open_session().await.unwrap();
    stub.exec(true, command).await.unwrap();
    request_ok(&mut stub).await.unwrap();
    let (_stub_cancel, mut stub_cancellation) = watch::channel(false);
    let partial = crate::tmux_jump::start(
        crate::tmux_jump::fixture_control(stub, identity),
        stub_cancellation.clone(),
    );
    let caller = partial.clone();
    let old = fresh.clone();
    let pending =
        tokio::spawn(async move { caller.call(&old, &mut stub_cancellation, None).await });
    timeout(BOUND, async {
        while !phase.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    access.lock().unwrap();
    assert!(pending.await.unwrap().is_err());
    timeout(BOUND, partial.retired()).await.unwrap();
    access.authorize(access.generation().unwrap()).unwrap();
    let fresh = crate::ssh::test_support::ready_lease(&access);
    let (_live, mut live) = watch::channel(false);
    assert!(partial.call(&fresh, &mut live, None).await.is_err());
    let _ = channel.eof().await;
    let _ = channel.close().await;
}

#[tokio::test]
#[ignore = "requires owned local OpenSSH sshd; native negative control-stream acceptance"]
async fn real_tmux_jump_malformed_stream_and_absolute_deadline() {
    timeout(Duration::from_secs(30), malformed_stream_probe())
        .await
        .expect("bounded malformed-stream fixture");
}
async fn malformed_stream_probe() {
    let f = Fixture::new().await;
    let lease = AccessState::disabled().lease(None).unwrap();
    let cases=[
        "IFS= read -r request; printf '%s\\n' '%begin 1 2 3' '$0|bad|@0|0|x' '%end 1 2 4'",
        "IFS= read -r request; printf '%s\\n' '%begin 1 2 3' '%begin 1 3 3' '%end 1 2 3'",
        "IFS= read -r request; printf '%s\\n' '%begin 1 2 3'; printf '%65537s\\n' x; printf '%s\\n' '%end 1 2 3'",
        // Individual messages arrive well inside the deadline; they must
        // not refresh it and allow an endless unsolicited response stream.
        "IFS= read -r request; i=0; while [ \"$i\" -lt 50 ]; do printf '%s\\n' '%sessions-changed'; sleep 0.1; i=$((i+1)); done",
    ];
    for command in cases {
        let mut channel = f.handle.channel_open_session().await.unwrap();
        channel.exec(true, command).await.unwrap();
        request_ok(&mut channel).await.unwrap();
        let (_cancel, mut cancellation) = watch::channel(false);
        let identity = crate::tmux_jump::Identity {
            pid: 1,
            tty: "/dev/fixture".into(),
        };
        let binding = crate::tmux_jump::start(
            crate::tmux_jump::fixture_control(channel, identity),
            cancellation.clone(),
        );
        assert!(timeout(
            Duration::from_secs(4),
            binding.call(&lease, &mut cancellation, None)
        )
        .await
        .expect("absolute three-second actor deadline")
        .is_err());
        timeout(BOUND, binding.retired()).await.unwrap();
        assert!(
            binding.call(&lease, &mut cancellation, None).await.is_err(),
            "malformed/partial stream must never be reused"
        );
    }
}

/// Direct argv cleanup intentionally does not reuse the production selector.
struct NamedServers<'a> {
    fixture: &'a Fixture,
    names: Vec<String>,
}
impl NamedServers<'_> {
    fn direct(&self, name: &str, args: &[&str]) -> String {
        lazysh_common::test_support::successful_output(
            Command::new(&self.fixture.tmux)
                .args(["-f", "/dev/null", "-L", name])
                .args(args)
                .env("TMUX_TMPDIR", self.fixture.dir.path())
                .env_remove("TMUX")
                .env("HOME", self.fixture.dir.path())
                .env("SHELL", "/bin/sh"),
        )
        .trim_end_matches('\n')
        .to_owned()
    }
}
impl Drop for NamedServers<'_> {
    fn drop(&mut self) {
        for name in &self.names {
            let _ = Command::new(&self.fixture.tmux)
                .args(["-L", name, "kill-server"])
                .env("TMUX_TMPDIR", self.fixture.dir.path())
                .env_remove("TMUX")
                .output();
        }
    }
}
#[tokio::test]
#[ignore = "requires owned local OpenSSH sshd and tmux; two named-server context acceptance"]
async fn real_tmux_jump_named_servers_keep_colliding_ids_and_jump_bound() {
    use crate::{
        multiplexer::{self, TmuxAction},
        tmux_server::TmuxServer,
    };
    use tauri::Manager;
    let f = Fixture::new().await;
    // If quoting regresses, substitution changes the socket label without writing outside the fixture.
    let hostile = "世界 '$(printf NO);";
    let servers = NamedServers {
        fixture: &f,
        names: vec!["default".into(), hostile.into(), "other".into()],
    };
    for name in &servers.names {
        assert_eq!(
            servers.direct(
                name,
                &[
                    "new-session",
                    "-d",
                    "-s",
                    "same",
                    "-P",
                    "-F",
                    "#{session_id}:#{window_id}:#{pane_id}",
                    "sleep 120"
                ]
            ),
            "$0:@0:%0"
        );
    }
    let state = AppState::new(f.dir.path().join("named-config")).unwrap();
    let app = tauri::test::mock_app();
    app.manage(state.clone());
    let authority = AccessState::disabled();
    let lease = authority.lease(None).unwrap();
    state.config().unwrap().hosts.push(f.host.clone());
    let (launch, receipt, prepared) = f.prepare_launch(&state, &lease, &format!("tmux:{hostile}"));
    let attempt = launch.begin_host(&receipt, &lease, &f.host.id).unwrap();
    attempt.check_host(&f.host).unwrap();
    let Some(crate::desktop_launch::MuxTarget::Tmux { server }) = prepared.mux else {
        panic!("expected requested named tmux picker");
    };
    assert_eq!(server, hostile);
    let (channel, initial) =
        open_terminal_for(&f.handle, &lease, 80, 24, Some("exec sleep 120".into()))
            .await
            .unwrap();
    let parent = spawn_terminal(
        &state,
        lease.clone(),
        f.handle.clone(),
        channel,
        initial,
        Channel::new(|_| Ok(())),
    )
    .await
    .unwrap();
    attempt.finish();
    assert!(launch.begin_host(&receipt, &lease, &f.host.id).is_err());
    let neutral = state.session(&parent.session_id).await.unwrap();
    let inherited = format!("{}/tmux-{}/other,1,0", f.dir.path().display(), unsafe {
        libc::geteuid()
    });
    let isolated_default = exec_for_access(
        &neutral,
        format!(
            "TMUX={} {} display-message -p -t '$0' '#{{socket_path}}'",
            quote(&inherited),
            TmuxServer::Default.prefix()
        ),
        &lease,
    )
    .await
    .unwrap();
    assert!(
        isolated_default.trim_end().ends_with("/default"),
        "{isolated_default}"
    );
    let child = attach_tmux(
        lease.clone(),
        app.state(),
        parent.session_id.clone(),
        Some(server),
        "same".into(),
        80,
        24,
        Channel::new(|_| Ok(())),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    let native = state.session(&child.session_id).await.unwrap();
    assert_eq!(
        TmuxServer::for_session(&native, None).unwrap(),
        TmuxServer::parse(Some(hostile)).unwrap()
    );
    assert!(TmuxServer::for_session(&native, Some("other")).is_err());
    for (name, expected) in [
        (hostile, "selected"),
        ("other", "same"),
        ("default", "same"),
    ] {
        if name == hostile {
            multiplexer::tmux_action(
                app.state(),
                child.session_id.clone(),
                TmuxAction::RenameSession {
                    target: "$0".into(),
                    name: "selected".into(),
                },
                None,
                lease.clone(),
            )
            .await
            .unwrap();
            multiplexer::tmux_action(
                app.state(),
                child.session_id.clone(),
                TmuxAction::SplitPane {
                    target: "%0".into(),
                    horizontal: true,
                    directory: f.dir.path().to_str().unwrap().into(),
                },
                Some(hostile.into()),
                lease.clone(),
            )
            .await
            .unwrap();
        }
        assert_eq!(
            servers.direct(
                name,
                &["display-message", "-p", "-t", "$0", "#{session_name}"]
            ),
            expected
        );
        assert_eq!(
            servers
                .direct(name, &["list-panes", "-a", "-F", "#{pane_id}"])
                .lines()
                .count(),
            if name == hostile { 2 } else { 1 }
        );
    }
    let tree =
        multiplexer::multiplexer_tree(app.state(), child.session_id.clone(), None, lease.clone())
            .await
            .unwrap_or_else(|error| panic!("tree: {:?}", error.into_inner().unwrap()))
            .into_inner()
            .unwrap();
    assert_eq!(
        serde_json::to_value(tree).unwrap()["sessions"][0]["name"],
        "selected"
    );
    assert!(multiplexer::tmux_action(
        app.state(),
        child.session_id.clone(),
        TmuxAction::SelectPane {
            target: "%0".into()
        },
        Some("default".into()),
        lease.clone()
    )
    .await
    .is_err());
    let snapshot =
        crate::tmux_jump::tmux_jump_snapshot(lease.clone(), app.state(), child.session_id.clone())
            .await
            .unwrap()
            .into_inner()
            .unwrap();
    let snapshot = serde_json::to_value(snapshot).unwrap();
    assert_eq!(snapshot["sessions"][0]["name"], "selected");
    multiplexer::tmux_action(
        app.state(),
        child.session_id.clone(),
        TmuxAction::CreateWindow {
            target: "$0".into(),
            name: "added".into(),
            directory: f.dir.path().to_str().unwrap().into(),
        },
        None,
        lease.clone(),
    )
    .await
    .unwrap();
    multiplexer::tmux_action(
        app.state(),
        child.session_id.clone(),
        TmuxAction::CreateSession {
            name: "destination".into(),
            directory: f.dir.path().to_str().unwrap().into(),
        },
        None,
        lease.clone(),
    )
    .await
    .unwrap();
    let navigation = serde_json::to_value(
        crate::tmux_jump::tmux_jump_snapshot(lease.clone(), app.state(), child.session_id.clone())
            .await
            .unwrap()
            .into_inner()
            .unwrap(),
    )
    .unwrap();
    let destination = navigation["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "destination")
        .unwrap();
    let jumped = crate::tmux_jump::tmux_jump(
        lease.clone(),
        app.state(),
        child.session_id.clone(),
        navigation["generation"].as_str().unwrap().into(),
        destination["id"].as_str().unwrap().into(),
        destination["windows"][0]["id"].as_str().unwrap().into(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    assert_eq!(
        serde_json::to_value(jumped).unwrap()["current"]["sessionId"],
        destination["id"]
    );
    assert_eq!(
        servers
            .direct("other", &["list-windows", "-a", "-F", "#{window_id}"])
            .lines()
            .count(),
        1
    );
    assert_eq!(
        servers
            .direct("default", &["list-windows", "-a", "-F", "#{window_id}"])
            .lines()
            .count(),
        1
    );
    // Reattachment from the neutral parent models restoration to the exact server/name.
    let restored = attach_tmux(
        lease.clone(),
        app.state(),
        parent.session_id.clone(),
        Some(hostile.into()),
        "selected".into(),
        80,
        24,
        Channel::new(|_| Ok(())),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    let binding = serde_json::to_value(
        crate::tmux_jump::tmux_jump_snapshot(
            lease.clone(),
            app.state(),
            restored.session_id.clone(),
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap(),
    )
    .unwrap();
    assert!(binding["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["name"] == "selected"));
    // Old retained control must never follow a replacement server with reused IDs.
    let server_pid: i32 = servers
        .direct(hostile, &["display-message", "-p", "#{pid}"])
        .parse()
        .unwrap();
    servers.direct(hostile, &["kill-server"]);
    timeout(BOUND, async {
        loop {
            if unsafe { libc::kill(server_pid, 0) } == -1 {
                assert_eq!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(libc::ESRCH)
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the owned old tmux server did not exit before replacement");
    servers.direct(
        hostile,
        &["new-session", "-d", "-s", "replacement", "sleep 120"],
    );
    assert!(crate::tmux_jump::tmux_jump_snapshot(
        lease.clone(),
        app.state(),
        child.session_id.clone()
    )
    .await
    .is_err());
    for id in [child.session_id, restored.session_id, parent.session_id] {
        disconnect(app.state(), id).await.unwrap();
    }
    assert_eq!(
        servers.direct(
            "other",
            &["display-message", "-p", "-t", "$0", "#{session_name}"]
        ),
        "same"
    );
    assert_eq!(
        servers.direct(
            "default",
            &["display-message", "-p", "-t", "$0", "#{session_name}"]
        ),
        "same"
    );
}

struct HerdrServers<'a> {
    fixture: &'a Fixture,
    binary: &'a std::path::Path,
    processes: Vec<(&'static str, Process)>,
}
impl HerdrServers<'_> {
    fn command(&self, name: &str) -> Command {
        let mut command = Command::new(self.binary);
        command
            .env_clear()
            .envs(
                self.fixture
                    .environment
                    .iter()
                    .map(|(key, value)| (*key, value)),
            )
            .env("SHELL", "/bin/sh")
            .env("TERM", "xterm-256color")
            .env("LANG", "C.UTF-8")
            .args(["--session", name]);
        command
    }
    async fn read_output(file: fs::File) -> Vec<u8> {
        let mut file = tokio::fs::File::from_std(file);
        tokio::io::AsyncSeekExt::rewind(&mut file).await.unwrap();
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .unwrap();
        assert!(
            bytes.len() <= 1024 * 1024,
            "owned Herdr output exceeded fixture read bound"
        );
        bytes
    }
    async fn output(&self, name: &str, args: &[&str]) -> std::process::Output {
        let stdout = tempfile::tempfile().unwrap();
        let stderr = tempfile::tempfile().unwrap();
        let mut command = self.command(name);
        let mut child = Process(
            command
                .args(args)
                .stdout(stdout.try_clone().unwrap())
                .stderr(stderr.try_clone().unwrap())
                .spawn()
                .unwrap(),
        );
        let status = timeout(BOUND, async {
            loop {
                if let Some(status) = child.0.try_wait().unwrap() {
                    break status;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        std::process::Output {
            status,
            stdout: Self::read_output(stdout).await,
            stderr: Self::read_output(stderr).await,
        }
    }
    async fn json(&self, name: &str, args: &[&str]) -> serde_json::Value {
        let output = self.output(name, args).await;
        assert!(
            output.status.success(),
            "owned Herdr command failed: {}",
            String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(512)])
        );
        assert!(
            output.stdout.len() <= 1024 * 1024,
            "owned Herdr response exceeded fixture bound"
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    async fn start(&mut self, name: &'static str) {
        let mut command = self.command(name);
        self.processes.push((
            name,
            Process(
                command
                    .arg("server")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            ),
        ));
        timeout(BOUND, async {
            loop {
                assert!(
                    self.processes
                        .last_mut()
                        .unwrap()
                        .1
                         .0
                        .try_wait()
                        .unwrap()
                        .is_none(),
                    "owned Herdr server exited before readiness"
                );
                if self
                    .output(name, &["api", "snapshot"])
                    .await
                    .status
                    .success()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
impl HerdrServers<'_> {
    fn assert_running(&mut self) {
        assert!(
            self.processes
                .iter_mut()
                .all(|(_, process)| process.0.try_wait().unwrap().is_none()),
            "an original owned Herdr server exited"
        );
    }
    async fn stop(&mut self) {
        for name in self
            .processes
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>()
        {
            assert!(self
                .output(name, &["server", "stop"])
                .await
                .status
                .success());
        }
        for (_, process) in &mut self.processes {
            let status = timeout(BOUND, async {
                loop {
                    if let Some(status) = process.0.try_wait().unwrap() {
                        break status;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert!(status.success(), "owned Herdr server did not stop cleanly");
        }
    }
}
impl Drop for HerdrServers<'_> {
    fn drop(&mut self) {
        let live = self
            .processes
            .iter_mut()
            .filter_map(|(name, process)| {
                process
                    .0
                    .try_wait()
                    .ok()
                    .flatten()
                    .is_none()
                    .then_some(*name)
            })
            .collect::<Vec<_>>();
        for name in live {
            let mut command = self.command(name);
            if let Ok(child) = command
                .args(["server", "stop"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                let mut stop = Process(child);
                let until = std::time::Instant::now() + BOUND;
                while stop.0.try_wait().ok().flatten().is_none()
                    && std::time::Instant::now() < until
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}
async fn herdr_terminal_output(
    app: &tauri::App<tauri::test::MockRuntime>,
    id: &str,
    events: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    marker: &[u8],
) -> Vec<u8> {
    timeout(BOUND, async {
        let mut bytes = Vec::new();
        loop {
            let event = events
                .recv()
                .await
                .expect("owned terminal event channel closed");
            assert_ne!(
                event["type"], "closed",
                "owned terminal closed before marker"
            );
            if let Some(data) = event["data"].as_array() {
                bytes.extend(data.iter().map(|value| value.as_u64().unwrap() as u8));
                let session = app.state::<AppState>().session(id).await.unwrap();
                acknowledge(&session, data.len() as u32).unwrap();
            }
            assert!(
                bytes.len() <= 128 * 1024,
                "owned terminal marker exceeded fixture bound"
            );
            if bytes.windows(marker.len()).any(|value| value == marker) {
                break bytes;
            }
        }
    })
    .await
    .expect("owned terminal did not expose expected marker")
}
async fn herdr_source_probe(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    source: &Connected,
    events: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    marker: &str,
) {
    write_stdin(
        lease.clone(),
        app.state(),
        source.session_id.clone(),
        format!("{marker}\n"),
        None,
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    let bytes = herdr_terminal_output(app, &source.session_id, events, marker.as_bytes()).await;
    assert!(
        !bytes
            .windows(b"herdr --session".len())
            .any(|value| value == b"herdr --session"),
        "attachment command reached source foreground"
    );
}
async fn herdr_child(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    source: &Connected,
    selected: &str,
    kind: crate::multiplexer::MultiplexerKind,
) -> (Connected, mpsc::UnboundedReceiver<serde_json::Value>) {
    let (events, receiver) = super::test_support::json_events();
    let child = attach_multiplexer(
        lease.clone(),
        app.state(),
        source.session_id.clone(),
        None,
        kind,
        selected.into(),
        80,
        24,
        events,
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    assert_ne!(source.session_id, child.session_id);
    let state = app.state::<AppState>();
    let parent = state.session(&source.session_id).await.unwrap();
    let native = state.session(&child.session_id).await.unwrap();
    assert!(Arc::ptr_eq(&parent.handle, &native.handle));
    assert_eq!(native.creation.generation(), lease.generation());
    (child, receiver)
}
async fn herdr_retired(state: &AppState, id: &str, session: &Session, including_notice: bool) {
    timeout(BOUND, async {
        loop {
            let active = state.sessions.lock().await.contains_key(id);
            let retiring = including_notice && state.retiring.lock().await.contains_key(id);
            if !active && !retiring && *session.finished.borrow() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned native terminal did not retire");
}
async fn herdr_counter(path: &std::path::Path) -> Option<u64> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut data = [0u8; 32];
    let length = file.read(&mut data).await.ok()?;
    std::str::from_utf8(&data[..length])
        .ok()?
        .trim()
        .parse()
        .ok()
}
async fn herdr_advanced(path: &std::path::Path, prior: u64) -> u64 {
    timeout(BOUND, async {
        loop {
            if let Some(value) = herdr_counter(path).await.filter(|value| *value > prior) {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned durable pane workload did not advance")
}

#[tokio::test]
#[ignore = "requires owned local OpenSSH sshd and absolute LAZYSH_TEST_HERDR pointing to Herdr 0.9.3"]
async fn real_herdr_ssh_child_pty_preserves_source_and_durable_session() {
    use super::test_support::{ready_lease, unlocked_access};
    use crate::herdr::{herdr_action, herdr_tree, HerdrAction};
    use crate::multiplexer::{multiplexer_sessions, MultiplexerKind};
    let binary = PathBuf::from(
        std::env::var("LAZYSH_TEST_HERDR").expect("set an absolute pinned Herdr 0.9.3 binary path"),
    );
    let mut f = Fixture::with_herdr(Some(&binary)).await;
    let mut servers = HerdrServers {
        fixture: &f,
        binary: &binary,
        processes: Vec::new(),
    };
    let version = servers.output("aaa-first", &["--version"]).await;
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        "herdr 0.9.3"
    );
    for (name, label) in [("aaa-first", "OTHER_A"), ("zzz-selected", "OTHER_Z")] {
        servers.start(name).await;
        servers
            .json(
                name,
                &[
                    "workspace",
                    "create",
                    "--no-focus",
                    "--label",
                    label,
                    "--cwd",
                    f.dir.path().to_str().unwrap(),
                ],
            )
            .await;
    }
    let state = AppState::new(f.dir.path().join("herdr-hosts")).unwrap();
    state.config().unwrap().hosts.push(f.host.clone());
    let app = tauri::test::mock_app();
    app.manage(state.clone());
    app.manage(crate::local::LocalState::default());
    let authority = unlocked_access();
    let lease = ready_lease(&authority);
    let (launch, receipt, prepared) = f.prepare_launch(&state, &lease, "herdr");
    let kind = match prepared.mux {
        Some(crate::desktop_launch::MuxTarget::Herdr) => MultiplexerKind::Herdr,
        _ => panic!("request lost Herdr kind"),
    };
    let attempt = launch.begin_host(&receipt, &lease, &f.host.id).unwrap();
    let (bound, guard) = locked_connect_host(&state, &f.host.id, Some(&attempt), 80, 24)
        .await
        .unwrap();
    assert_eq!(bound.credential_binding(), f.host.credential_binding());
    let (events, mut source_events) = super::test_support::json_events();
    let (channel, initial) = open_terminal_for(&f.handle, &lease, 80, 24, Some("exec cat".into()))
        .await
        .unwrap();
    let source = spawn_terminal(
        &state,
        lease.clone(),
        f.handle.clone(),
        channel,
        initial,
        events,
    )
    .await
    .unwrap();
    attempt.finish();
    drop(guard);
    adopt_session(
        lease.clone(),
        app.state(),
        app.state(),
        source.session_id.clone(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    herdr_source_probe(&app, &lease, &source, &mut source_events, "SOURCE_BEFORE").await;
    let rows = serde_json::to_value(
        multiplexer_sessions(app.state(), source.session_id.clone(), kind, lease.clone())
            .await
            .unwrap()
            .into_inner()
            .unwrap(),
    )
    .unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows
        .iter()
        .all(|row| matches!(row["name"].as_str(), Some("aaa-first" | "zzz-selected"))));
    let selected = rows[1]["name"].as_str().unwrap().to_owned();
    assert_ne!(selected, rows[0]["name"].as_str().unwrap());
    let tree = herdr_tree(
        app.state(),
        source.session_id.clone(),
        selected.clone(),
        lease.clone(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    assert_eq!(tree.workspaces.len(), 1);
    assert_eq!(tree.panes.len(), 1);
    let workspace = tree.workspaces[0].workspace_id.clone();
    let pane = tree.panes[0].pane_id.clone();
    for action in [
        HerdrAction::RenameWorkspace {
            target: workspace.clone(),
            label: "PICKED".into(),
        },
        HerdrAction::FocusWorkspace {
            target: workspace.clone(),
        },
    ] {
        herdr_action(
            app.state(),
            source.session_id.clone(),
            selected.clone(),
            action,
            lease.clone(),
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    }
    let heartbeat = f.dir.path().join("durable-counter");
    let pidfile = f.dir.path().join("durable-pid");
    let script = format!(
        "echo $$ > {}; n=0; while :; do n=$((n+1)); echo $n > {}; sleep 0.05; done",
        quote(pidfile.to_str().unwrap()),
        quote(heartbeat.to_str().unwrap())
    );
    let workload = format!("sh -c {}", quote(&script));
    let parent = state.session(&source.session_id).await.unwrap();
    exec_for_access(
        &parent,
        format!(
            "herdr --session {} pane run {} {}",
            quote(&selected),
            quote(&pane),
            quote(&workload)
        ),
        &lease,
    )
    .await
    .unwrap();
    herdr_advanced(&heartbeat, 0).await;
    let workload_pid = herdr_counter(&pidfile).await.unwrap();
    let process_pid = i32::try_from(workload_pid).unwrap();
    assert!(process_pid > 1);
    eprintln!("owned Herdr stages: requested_host_kind=true explicit_nonfirst_selection=true workload_started=true");
    let (child, mut child_events) = herdr_child(&app, &lease, &source, &selected, kind).await;
    herdr_terminal_output(&app, &child.session_id, &mut child_events, b"PICKED").await;
    adopt_session(
        lease.clone(),
        app.state(),
        app.state(),
        child.session_id.clone(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    herdr_source_probe(
        &app,
        &lease,
        &source,
        &mut source_events,
        "SOURCE_DURING_CHILD",
    )
    .await;
    let native = state.session(&child.session_id).await.unwrap();
    disconnect_inner(&state, child.session_id.clone())
        .await
        .unwrap();
    herdr_retired(&state, &child.session_id, &native, true).await;
    let detached = herdr_counter(&heartbeat).await.unwrap();
    herdr_advanced(&heartbeat, detached).await;
    assert_eq!(herdr_counter(&pidfile).await, Some(workload_pid));
    servers.assert_running();
    let after = herdr_tree(
        app.state(),
        source.session_id.clone(),
        selected.clone(),
        lease.clone(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    assert_eq!(after.panes[0].pane_id, pane);
    assert_eq!(after.workspaces[0].workspace_id, workspace);
    herdr_source_probe(
        &app,
        &lease,
        &source,
        &mut source_events,
        "SOURCE_AFTER_DETACH",
    )
    .await;
    eprintln!("owned Herdr stages: separate_child_display=true source_independent=true durable_after_detach=true");
    let (pending, mut pending_events) = herdr_child(&app, &lease, &source, &selected, kind).await;
    herdr_terminal_output(&app, &pending.session_id, &mut pending_events, b"PICKED").await;
    let pending_native = state.session(&pending.session_id).await.unwrap();
    assert!(!*pending_native.finished.borrow());
    assert!(!*pending_native.cancel.borrow());
    authority.lock().unwrap();
    herdr_retired(&state, &pending.session_id, &pending_native, false).await;
    assert!(*pending_native.cancel.borrow());
    assert!(!pending_native
        .adopted
        .load(std::sync::atomic::Ordering::SeqCst));
    assert!(
        state
            .retiring
            .lock()
            .await
            .contains_key(&pending.session_id),
        "known cancelled tab notification waits for normal unlock"
    );
    // Data already queued before lock is valid; Closed must wait for unlock.
    while let Ok(event) = pending_events.try_recv() {
        assert_ne!(event["type"], "closed", "locked child published Closed");
    }
    assert!(
        state.session(&source.session_id).await.is_ok(),
        "adopted source must retain its existing lock policy"
    );
    let revoked = herdr_counter(&heartbeat).await.unwrap();
    herdr_advanced(&heartbeat, revoked).await;
    assert_eq!(herdr_counter(&pidfile).await, Some(workload_pid));
    servers.assert_running();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    assert!(attach_multiplexer(
        lease.clone(),
        app.state(),
        source.session_id.clone(),
        None,
        kind,
        selected.clone(),
        80,
        24,
        super::test_support::counting_events(&calls)
    )
    .await
    .is_err());
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    authority
        .authorize(authority.generation().unwrap())
        .unwrap();
    let fresh = ready_lease(&authority);
    let closed = timeout(BOUND, async {
        loop {
            let event = pending_events.recv().await.unwrap();
            if event["type"] == "closed" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(closed["message"], "Session cancelled before adoption");
    herdr_retired(&state, &pending.session_id, &pending_native, true).await;
    assert!(launch.begin_host(&receipt, &fresh, &f.host.id).is_err());
    herdr_source_probe(
        &app,
        &fresh,
        &source,
        &mut source_events,
        "SOURCE_AFTER_UNLOCK",
    )
    .await;
    disconnect_inner(&state, source.session_id.clone())
        .await
        .unwrap();
    herdr_retired(&state, &source.session_id, &parent, true).await;
    assert!(state.sessions.lock().await.is_empty());
    assert!(state.retiring.lock().await.is_empty());
    eprintln!("owned Herdr stages: original_lease_revoked=true pending_child_retired=true durable_after_revoke=true no_launch_replay=true");
    servers.stop().await;
    timeout(BOUND, async {
        while unsafe { libc::kill(process_pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned Herdr workload survived fixture teardown");
    drop(servers);
    f.handle
        .disconnect(
            russh::Disconnect::ByApplication,
            "owned fixture complete",
            "en",
        )
        .await
        .unwrap();
    f.daemon.0.kill().unwrap();
    f.daemon.0.wait().unwrap();
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", f.host.port))
        .await
        .is_err());
    eprintln!("owned Herdr stages: servers_reaped=true workload_stopped=true listener_closed=true");
}
