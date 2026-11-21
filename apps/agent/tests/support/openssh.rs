//! One private OpenSSH server on loopback for the current user: its own host key, one throwaway
//! client key, no password. It is stopped by PID, and its files removed, when the value drops.
use std::{
    fs,
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

pub struct Sshd {
    child: Child,
    port: u16,
    directory: tempfile::TempDir,
}
fn tool(name: &str) -> Option<PathBuf> {
    let found = Command::new("sh")
        .args(["-c", &format!("command -v {name}")])
        .output()
        .ok()?;
    let path = PathBuf::from(String::from_utf8(found.stdout).ok()?.trim());
    path.is_absolute().then_some(path)
}
fn keygen(keygen: &Path, file: &Path) -> bool {
    Command::new(keygen)
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(file)
        .status()
        .is_ok_and(|status| status.success())
}
impl Sshd {
    /// `None` when OpenSSH is not installed here.
    pub fn start() -> Option<Self> {
        let (sshd, keygen_tool) = (tool("sshd")?, tool("ssh-keygen")?);
        tool("ssh")?;
        let directory = tempfile::tempdir().ok()?;
        let at = |name: &str| directory.path().join(name);
        if !keygen(&keygen_tool, &at("host_key")) || !keygen(&keygen_tool, &at("client_key")) {
            return None;
        }
        fs::copy(at("client_key.pub"), at("authorized_keys")).ok()?;
        fs::set_permissions(at("authorized_keys"), fs::Permissions::from_mode(0o600)).ok()?;
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .ok()?
            .local_addr()
            .ok()?
            .port();
        let config = format!(
            "ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nPidFile {}\nAuthorizedKeysFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\n",
            at("host_key").display(),
            at("sshd.pid").display(),
            at("authorized_keys").display()
        );
        fs::write(at("sshd_config"), config).ok()?;
        let child = Command::new(sshd)
            .args(["-D", "-f"])
            .arg(at("sshd_config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut sshd = Self {
            child,
            port,
            directory,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            if Instant::now() > deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(50));
        }
        sshd.child.try_wait().ok()?.is_none().then_some(sshd)
    }
    /// Run `command` on the server as the client's login, the way an SSH exec request does.
    pub fn exec(&self, command: &str) -> Output {
        Command::new("ssh")
            .args(["-F", "none", "-q", "-p", &self.port.to_string(), "-i"])
            .arg(self.directory.path().join("client_key"))
            .args(["-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes"])
            .args([
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
            ])
            .arg("127.0.0.1")
            .arg(command)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }
}
impl Drop for Sshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
