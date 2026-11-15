//! The real Windows `sshd.exe` under each default shell, reached by the app's own SSH client.
//! Needs Windows with the OpenSSH Server capability and administrator rights (it sets `DefaultShell`).
use super::*;
use std::{path::Path, process::Command};

const SSH: &str = r"HKLM\SOFTWARE\OpenSSH";
const USER: &str = r"HKCU\Environment";
/// Two cases write the same machine-wide registry values, so they never overlap in a process.
static MACHINE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn reg(arguments: &[&str]) -> std::process::Output {
    Command::new("reg.exe").args(arguments).output().unwrap()
}

/// The value `name` under `key` as `reg query` reports it: its type and its data.
fn registered(key: &str, name: &str) -> Option<(String, String)> {
    let query = reg(&["query", key, "/v", name]);
    let text = String::from_utf8_lossy(&query.stdout);
    let line = text
        .lines()
        .find_map(|line| line.trim().strip_prefix(name))?;
    let (kind, data) = line.trim_start().split_once(char::is_whitespace)?;
    query
        .status
        .success()
        .then(|| (kind.into(), data.trim().into()))
}

/// A registry value for as long as this lives; dropping it, also while unwinding, puts back the value it replaced or removes its own.
struct Registry {
    key: String,
    name: String,
    previous: Option<(String, String)>,
}
impl Registry {
    fn set(key: &str, name: &str, kind: &str, data: &str) -> Self {
        let previous = registered(key, name);
        let added = reg(&["add", key, "/v", name, "/t", kind, "/d", data, "/f"]);
        assert!(
            added.status.success(),
            "{name} under {key} was not set (HKLM needs administrator rights): {}",
            String::from_utf8_lossy(&added.stderr)
        );
        Self {
            key: key.into(),
            name: name.into(),
            previous,
        }
    }
    /// `directory` first on the user's `PATH`, in the type the user's value already has.
    fn path_with(directory: &Path) -> Self {
        let (kind, old) =
            registered(USER, "Path").unwrap_or(("REG_EXPAND_SZ".into(), String::new()));
        let path = [directory.display().to_string(), old]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(";");
        Self::set(USER, "Path", &kind, &path)
    }
}
impl Drop for Registry {
    fn drop(&mut self) {
        let (key, name) = (&self.key, &self.name);
        let restored = match &self.previous {
            Some((kind, data)) => reg(&["add", key, "/v", name, "/t", kind, "/d", data, "/f"]),
            None => reg(&["delete", key, "/v", name, "/f"]),
        };
        let message = format!(
            "{name} under {key} was not restored: {}",
            String::from_utf8_lossy(&restored.stderr)
        );
        // Panicking while another panic unwinds would abort the run and hide the first failure.
        if !restored.status.success() {
            if std::thread::panicking() {
                eprintln!("{message}");
            } else {
                panic!("{message}");
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Shell {
    Cmd,
    PowerShell,
}
impl Shell {
    fn name(self) -> &'static str {
        match self {
            Shell::Cmd => "cmd.exe",
            Shell::PowerShell => "Windows PowerShell",
        }
    }
    fn program(self) -> PathBuf {
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        match self {
            Shell::Cmd => system.join("cmd.exe"),
            Shell::PowerShell => system.join(r"WindowsPowerShell\v1.0\powershell.exe"),
        }
    }
    /// What `echo %OS% $PSVersionTable.PSVersion.Major` prints, words only: `cmd.exe` expands `%OS%`, PowerShell the variable
    /// (and prints one word to a line).
    fn echo(self) -> &'static str {
        match self {
            Shell::Cmd => "Windows_NT $PSVersionTable.PSVersion.Major",
            Shell::PowerShell => "%OS% 5",
        }
    }
    /// The status the shell reports when the companion exits 2: `powershell.exe -Command` turns any failure into 1.
    fn failure(self) -> u32 {
        match self {
            Shell::Cmd => 2,
            Shell::PowerShell => 1,
        }
    }
}

struct Observed {
    status: Option<u32>,
    stdout: String,
    stderr: String,
}
async fn observe(
    session: &Session,
    lease: &AccessLease,
    shell: Shell,
    command: String,
) -> Observed {
    let output = exec_status(
        session,
        command.clone(),
        lease,
        Duration::from_secs(60),
        FILE_LIMIT as usize,
        None,
        &mut |_| {},
    )
    .await
    .unwrap_or_else(|error| panic!("{}: `{command}` did not run: {error:?}", shell.name()));
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim().to_owned();
    Observed {
        status: output.status,
        stdout: text(&output.stdout),
        stderr: text(&output.stderr),
    }
}

async fn verify(shell: Shell) {
    let name = shell.name();
    let _machine = MACHINE.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let (bin, state_dir) = (directory.path().join("bin"), directory.path().join("state"));
    fs::create_dir_all(&bin).unwrap();
    fs::create_dir_all(&state_dir).unwrap();
    fs::copy(
        std::env::var_os("LAZYSH_TEST_AGENT_BIN")
            .expect("build lazysh-agent from this checkout and pass it as LAZYSH_TEST_AGENT_BIN"),
        bin.join("lazysh-agent.exe"),
    )
    .unwrap();
    let touched = || {
        [
            (SSH, "DefaultShell"),
            (USER, "Path"),
            (USER, "LAZYSH_STATE_DIR"),
        ]
        .map(|(key, name)| registered(key, name))
    };
    let before = touched();
    let program = shell.program().display().to_string();
    let default_shell = Registry::set(SSH, "DefaultShell", "REG_SZ", &program);
    assert_eq!(
        registered(SSH, "DefaultShell"),
        Some(("REG_SZ".into(), program)),
        "{name}: the registry does not hold the default shell this case runs under"
    );
    // The host's own environment, which is where sshd takes a session's from: the companion on the user's PATH, and a state
    // directory that is not the user's.
    let environment = (
        Registry::path_with(&bin),
        Registry::set(
            USER,
            "LAZYSH_STATE_DIR",
            "REG_SZ",
            &state_dir.display().to_string(),
        ),
    );
    let (host_key, user_key) = (ed25519_key(), ed25519_key());
    let authorized = directory.path().join("authorized_keys");
    // sshd splits `AuthorizedKeysFile` on blanks.
    assert!(!authorized.to_str().unwrap().contains(char::is_whitespace));
    fs::write(&authorized, user_key.public_key().to_openssh().unwrap()).unwrap();
    let port = owned_sshd::free_port();
    let settings = format!("AuthorizedKeysFile {}\n", owned_sshd::slashes(&authorized));
    let sshd =
        owned_sshd::OwnedSshd::start(directory.path(), port, &host_key, &settings, &[]).await;
    let app_state = AppState::new(directory.path().join("config")).unwrap();
    let host: Host = serde_json::from_value(serde_json::json!({
        "id": "windows-openssh",
        "name": "Windows OpenSSH fixture",
        "hostname": "127.0.0.1",
        "port": port,
        "username": std::env::var("USERNAME").unwrap(),
        "fingerprint": host_key.public_key().fingerprint(HashAlg::Sha256).to_string(),
    }))
    .unwrap();
    app_state.config().unwrap().hosts.push(host.clone());
    let lease = access_lease();
    let handle = authenticate(
        &app_state,
        &host,
        None,
        Some(user_key.to_openssh(Default::default()).unwrap().to_string()),
        None,
    )
    .await
    .unwrap_or_else(|error| panic!("{name}: {error:?}\n{}", sshd.log()));
    let (input, _input) = mpsc::channel(1);
    let (cancel, _cancel) = watch::channel(false);
    let session = Session::new(Arc::new(handle), input, cancel, lease.clone(), check_size);
    let run = |command: &str| observe(&session, &lease, shell, command.into());

    // The shell sshd really started: a runner that ignores DefaultShell prints the other shell's answer and fails here.
    let echoed = run("echo %OS% $PSVersionTable.PSVersion.Major").await;
    assert_eq!(
        echoed.stdout.split_whitespace().collect::<Vec<_>>().join(" "),
        shell.echo(),
        "{name}: sshd ran the command under another shell than DefaultShell names ({:?}, stderr {:?})\n{}",
        echoed.status,
        echoed.stderr,
        sshd.log()
    );

    // The probe has to find a Windows host behind this shell: the adapter then sends one encoded PowerShell line.
    let version = format!("lazysh-agent {}", env!("CARGO_PKG_VERSION"));
    let line = crate::companion::command(&session, "lazysh-agent --version".into(), &lease)
        .await
        .unwrap();
    assert!(
        line.starts_with("powershell.exe "),
        "{name}: the host was not identified as Windows: {line}"
    );
    let output = crate::companion::exec(&session, "lazysh-agent --version".into(), &lease)
        .await
        .unwrap_or_else(|error| {
            panic!("{name}: lazysh-agent --version: {error:?}\n{}", sshd.log())
        });
    assert_eq!(output.trim(), version, "{name}");

    // A quoted argument with spaces, quotes and shell syntax arrives as written: the companion echoes it back.
    let hostile =
        "C:\\Users\\own er\\it's %PATH% $x & ^ | < > ; ( ) {} \u{2019}q\u{2019} 世界.json";
    let echo = format!(
        "lazysh-agent reported-history --session-id={}",
        quote(hostile)
    );
    let json: serde_json::Value = serde_json::from_str(
        &crate::companion::exec(&session, echo, &lease)
            .await
            .unwrap_or_else(|error| panic!("{name}: quoted argument: {error:?}\n{}", sshd.log())),
    )
    .unwrap();
    assert_eq!(json["sessionId"], hostile, "{name}");

    // Exit status, stdout and stderr of a companion that fails are the shell's, not guessed.
    let unknown =
        crate::companion::command(&session, "lazysh-agent no-such-command".into(), &lease)
            .await
            .unwrap();
    let failed = run(&unknown).await;
    assert_eq!(
        (
            failed.status,
            failed.stdout.as_str(),
            failed.stderr.is_empty()
        ),
        (Some(shell.failure()), "", false),
        "{name}: {}",
        failed.stderr
    );

    // Everything the case started or changed is gone.
    drop(session);
    drop(sshd);
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err(),
        "{name}: the owned sshd still accepts connections"
    );
    drop((default_shell, environment));
    assert_eq!(touched(), before, "{name}: the registry was not restored");
}

#[tokio::test]
#[ignore = "requires Windows with the OpenSSH Server capability, administrator rights and the companion this build produced in LAZYSH_TEST_AGENT_BIN"]
async fn windows_openssh_under_cmd_exe_identifies_the_host_and_runs_the_companion() {
    Box::pin(verify(Shell::Cmd)).await;
}

#[tokio::test]
#[ignore = "requires Windows with the OpenSSH Server capability, administrator rights and the companion this build produced in LAZYSH_TEST_AGENT_BIN"]
async fn windows_openssh_under_windows_powershell_identifies_the_host_and_runs_the_companion() {
    Box::pin(verify(Shell::PowerShell)).await;
}

#[test]
#[ignore = "writes the Windows registry; run explicitly"]
fn registry_values_return_to_the_machines_own_or_to_their_absence_on_every_exit_path() {
    let key = format!(r"HKCU\Software\lazysh-test-registry-{}", std::process::id());
    let value = |data: &str| Some(("REG_SZ".to_string(), data.to_string()));
    assert_eq!(registered(&key, "Value"), None);
    // Absent before: the value is gone afterwards, also when the case panics while it holds it.
    let unwound = std::panic::catch_unwind(|| {
        let _held = Registry::set(&key, "Value", "REG_SZ", r"C:\Windows\System32\cmd.exe");
        assert_eq!(
            registered(&key, "Value"),
            value(r"C:\Windows\System32\cmd.exe")
        );
        panic!("a failing assertion");
    });
    assert!(unwound.is_err());
    assert_eq!(registered(&key, "Value"), None);
    // Present before: the value is the one it was, in the type it had, not the one the case set.
    let own = r"%SystemRoot%\own er\shell.exe";
    assert!(reg(&[
        "add",
        &key,
        "/v",
        "Value",
        "/t",
        "REG_EXPAND_SZ",
        "/d",
        own,
        "/f"
    ])
    .status
    .success());
    drop(Registry::set(
        &key,
        "Value",
        "REG_SZ",
        r"C:\Windows\System32\cmd.exe",
    ));
    assert_eq!(
        registered(&key, "Value"),
        Some(("REG_EXPAND_SZ".to_string(), own.to_string()))
    );
    assert!(reg(&["delete", &key, "/f"]).status.success());
}
