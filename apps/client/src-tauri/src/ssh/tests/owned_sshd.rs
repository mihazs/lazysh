//! One owned, unprivileged OpenSSH sshd on loopback; it is killed and reaped on drop.
use super::*;
use std::path::Path;

/// Kills and reaps an owned child process even when an assertion unwinds.
pub(super) struct Process(pub(super) std::process::Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(super) fn free_port() -> u16 {
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    socket.local_addr().unwrap().port()
}

pub(super) struct OwnedSshd {
    _process: Process,
    pub(super) port: u16,
    pub(super) log: PathBuf,
}
impl OwnedSshd {
    /// `settings` come first because sshd keeps the first value of each keyword.
    pub(super) async fn start(
        directory: &Path,
        port: u16,
        host_key: &russh::keys::PrivateKey,
        settings: &str,
        environment: &[(&str, &std::ffi::OsStr)],
    ) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let key_path = directory.join("host_key");
        fs::write(
            &key_path,
            host_key.to_openssh(Default::default()).unwrap().as_bytes(),
        )
        .unwrap();
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600)).unwrap();
        let config = directory.join("sshd_config");
        let base = format!("{settings}ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nPidFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nPermitRootLogin yes\n", key_path.display(), directory.join("sshd.pid").display());
        let sshd = std::process::Command::new("sh")
            .args(["-c", "command -v sshd"])
            .output()
            .unwrap();
        let sshd = PathBuf::from(String::from_utf8(sshd.stdout).unwrap().trim());
        // OpenSSH 9.8+ penalises loopback clients that leave before authenticating
        // (readiness probes, refused host keys); older releases reject the keyword.
        fs::write(&config, format!("PerSourcePenalties no\n{base}")).unwrap();
        let penalties = std::process::Command::new(&sshd)
            .args(["-t", "-f"])
            .arg(&config)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        if !penalties.success() {
            fs::write(&config, base).unwrap();
        }
        let log = directory.join("sshd.log");
        let mut process = Process(spawn_quiet(
            std::process::Command::new(&sshd)
                .args(["-D", "-f"])
                .arg(&config)
                .arg("-E")
                .arg(&log)
                .envs(environment.iter().copied()),
        ));
        wait_for_listener(&mut process.0, ([127, 0, 0, 1], port).into(), || {
            fs::read_to_string(&log).unwrap_or_default()
        })
        .await;
        Self {
            _process: process,
            port,
            log,
        }
    }
    pub(super) fn log(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }
    /// Stops sshd like a vanished server: every connection process it started dies
    /// without a disconnect message, and the listener stops accepting.
    #[cfg(target_os = "linux")]
    pub(super) fn kill_tree(self) {
        let root = self._process.0.id();
        let mut owned = vec![root];
        let mut index = 0;
        while index < owned.len() {
            let parent = owned[index];
            owned.extend(linux_children(parent));
            index += 1;
        }
        for pid in owned.iter().skip(1).rev() {
            // SAFETY: each pid was a live descendant of the owned listener just above.
            unsafe { libc::kill(*pid as i32, libc::SIGKILL) };
        }
        drop(self);
    }
}

/// Direct children from procfs; a process that already exited is simply absent.
#[cfg(target_os = "linux")]
fn linux_children(parent: u32) -> Vec<u32> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| {
            fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| {
                    // The command name may contain spaces; the parent follows its closing paren.
                    let rest = &stat[stat.rfind(')')? + 2..];
                    rest.split(' ').nth(1)?.parse::<u32>().ok()
                })
                == Some(parent)
        })
        .collect()
}

/// Collects a terminal's output until `expected` appears, acknowledging every chunk;
/// a Closed event or a 15-second deadline fails with the output seen so far.
pub(super) async fn terminal_output_until(
    state: &AppState,
    id: &str,
    rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    expected: &str,
) -> String {
    let session = state.session(id).await.unwrap();
    let mut output = Vec::new();
    timeout(Duration::from_secs(15), async {
        while !String::from_utf8_lossy(&output).contains(expected) {
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
    String::from_utf8_lossy(&output).into_owned()
}

/// Runs one command in a product-opened PTY channel, which carries the agent request
/// when the handle forwards its selected identity, and returns its status and output.
pub(super) async fn terminal_command(
    handle: &Arc<SshHandle>,
    command: String,
) -> (Option<u32>, String) {
    let (mut channel, mut output) = open_terminal(handle, 80, 24, Some(command)).await.unwrap();
    let mut status = None;
    timeout(Duration::from_secs(10), async {
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    output.extend_from_slice(&data)
                }
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
        }
    })
    .await
    .expect("remote PTY command deadline");
    (status, String::from_utf8_lossy(&output).into_owned())
}
