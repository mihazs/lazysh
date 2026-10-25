//! Fixture-only Jump To investigation. No product API, helper installation or IPC.
use super::*;
use std::{
    io::Read,
    os::unix::fs::PermissionsExt,
    process::{Child, Command, Stdio},
};

const BOUND: Duration = Duration::from_secs(3);
type Probe<T> = std::result::Result<T, String>;

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
    tmux: String,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let host_key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let user_key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
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
        fs::write(&config, format!("ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nAuthorizedKeysFile {}\nPidFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nLogLevel ERROR\nSetEnv HOME={} ZDOTDIR={}\n", host_file.display(), authorized.display(), dir.path().join("sshd.pid").display(),dir.path().display(),dir.path().display())).unwrap();
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
        let state = AppState::new(dir.path().join("config")).unwrap();
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
        let tmux = std::env::var("LAZYSH_TEST_TMUX").unwrap_or_else(|_| "tmux".into());
        Self {
            dir,
            daemon,
            handle,
            tmux,
        }
    }
    fn socket(&self) -> PathBuf {
        self.dir.path().join("tmux.sock")
    }
    fn prefix(&self) -> String {
        format!(
            "{} -f /dev/null -S {}",
            quote(&self.tmux),
            quote(self.socket().to_str().unwrap())
        )
    }
    fn local(&self, args: &[&str]) -> String {
        let output = Command::new(&self.tmux)
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
    channel: russh::Channel<client::Msg>,
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
