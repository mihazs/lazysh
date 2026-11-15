//! The real Windows `sshd.exe` under each default shell, reached by the app's own SSH client.
//! Needs Windows with the OpenSSH Server capability and administrator rights (it sets `DefaultShell`).
use super::*;
use std::{path::Path, process::Command};

const KEY: &str = r"HKLM\SOFTWARE\OpenSSH";
/// Two cases write one machine-wide registry value, so they never overlap in a process.
static MACHINE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn reg(arguments: &[&str]) -> std::process::Output {
    Command::new("reg.exe").args(arguments).output().unwrap()
}

/// `DefaultShell` under `key` as `reg query` reports it: its type and its data.
fn registered(key: &str) -> Option<(String, String)> {
    let query = reg(&["query", key, "/v", "DefaultShell"]);
    let text = String::from_utf8_lossy(&query.stdout);
    let line = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("DefaultShell"))?;
    let (kind, data) = line.trim_start().split_once(char::is_whitespace)?;
    query
        .status
        .success()
        .then(|| (kind.into(), data.trim().into()))
}

/// `DefaultShell` for as long as this lives; dropping it, also while unwinding, puts back the value it replaced or removes its own.
struct DefaultShell {
    key: String,
    previous: Option<(String, String)>,
}
impl DefaultShell {
    fn set(key: &str, program: &Path) -> Self {
        let previous = registered(key);
        let added = reg(&[
            "add",
            key,
            "/v",
            "DefaultShell",
            "/t",
            "REG_SZ",
            "/d",
            &program.display().to_string(),
            "/f",
        ]);
        assert!(
            added.status.success(),
            "DefaultShell was not set (writing HKLM needs administrator rights): {}",
            String::from_utf8_lossy(&added.stderr)
        );
        Self {
            key: key.into(),
            previous,
        }
    }
}
impl Drop for DefaultShell {
    fn drop(&mut self) {
        let restored = match &self.previous {
            Some((kind, data)) => reg(&[
                "add",
                &self.key,
                "/v",
                "DefaultShell",
                "/t",
                kind,
                "/d",
                data,
                "/f",
            ]),
            None => reg(&["delete", &self.key, "/v", "DefaultShell", "/f"]),
        };
        let message = format!(
            "DefaultShell under {} was not restored: {}",
            self.key,
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
    /// What `echo %OS% $PSVersionTable.PSVersion.Major` prints: only `cmd.exe` expands `%OS%`, only PowerShell the variable.
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
    let before = registered(KEY);
    let default_shell = DefaultShell::set(KEY, &shell.program());
    assert_eq!(
        registered(KEY),
        Some(("REG_SZ".into(), shell.program().display().to_string())),
        "{name}: the registry does not hold the default shell this case runs under"
    );
    let (host_key, user_key) = (ed25519_key(), ed25519_key());
    let authorized = directory.path().join("authorized_keys");
    fs::write(&authorized, user_key.public_key().to_openssh().unwrap()).unwrap();
    let port = owned_sshd::free_port();
    // A host with nothing but Windows and the companion on its PATH: the runner's own PATH (Git's `sh.exe`, for one) is not the host's.
    // sshd splits `SetEnv` on blanks, and the Windows build does not apply a quoted value, so the directories have none.
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
    let path = [
        bin.clone(),
        system.join("System32"),
        system.clone(),
        system.join(r"System32\WindowsPowerShell\v1.0"),
    ]
    .map(|directory| directory.display().to_string())
    .join(";");
    let state = state_dir.display().to_string();
    assert!(
        !path.contains(char::is_whitespace) && !state.contains(char::is_whitespace),
        "{name}: SetEnv splits on blanks, so the fixture directories must have none: {path} {state}"
    );
    let settings = format!(
        "AuthorizedKeysFile {}\nSetEnv PATH={path} LAZYSH_STATE_DIR={state}\n",
        owned_sshd::slashes(&authorized)
    );
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
        echoed.stdout,
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
    drop(default_shell);
    assert_eq!(
        registered(KEY),
        before,
        "{name}: DefaultShell was not restored"
    );
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
fn default_shell_returns_the_machines_own_value_or_its_absence_on_every_exit_path() {
    let key = format!(
        r"HKCU\Software\lazysh-test-default-shell-{}",
        std::process::id()
    );
    let program = Path::new(r"C:\Windows\System32\cmd.exe");
    let value = |data: &str| ("REG_SZ".to_string(), data.to_string());
    assert_eq!(registered(&key), None);
    // Absent before: the value is gone afterwards, also when the case panics while it holds it.
    let unwound = std::panic::catch_unwind(|| {
        let _held = DefaultShell::set(&key, program);
        assert_eq!(
            registered(&key),
            Some(value(&program.display().to_string()))
        );
        panic!("a failing assertion");
    });
    assert!(unwound.is_err());
    assert_eq!(registered(&key), None);
    // Present before: the value is the one it was, not the one the case set.
    let machine = reg(&[
        "add",
        &key,
        "/v",
        "DefaultShell",
        "/t",
        "REG_SZ",
        "/d",
        r"C:\own er\shell.exe",
        "/f",
    ]);
    assert!(machine.status.success());
    drop(DefaultShell::set(&key, program));
    assert_eq!(registered(&key), Some(value(r"C:\own er\shell.exe")));
    assert!(reg(&["delete", &key, "/f"]).status.success());
}
