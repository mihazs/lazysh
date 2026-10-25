#![cfg(any(target_os = "linux", target_os = "macos"))]
mod common;
use std::{
    ffi::CStr,
    net::UdpSocket,
    process::{Command, Stdio},
    thread,
};

fn command_output(mut command: Command, timeout: std::time::Duration) -> std::process::Output {
    use std::os::unix::process::CommandExt;
    use std::{
        io::Read,
        time::{Duration, Instant},
    };
    fn capture(mut input: impl Read) -> Vec<u8> {
        let mut output = Vec::new();
        let mut buffer = [0; 8192];
        loop {
            let count = input.read(&mut buffer).unwrap();
            if count == 0 {
                return output;
            }
            let retained = count.min((16 * 1024 * 1024_usize).saturating_sub(output.len()));
            output.extend_from_slice(&buffer[..retained]);
        }
    }
    // Keep Cargo/compiler or adb children inside this fixture's process group.
    command.process_group(0);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("native fixture command");
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || capture(stdout));
    let err = thread::spawn(move || capture(stderr));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            // SAFETY: this child created its own process group above. Its PID is
            // still owned and unreaped, so the group cannot refer to another job.
            unsafe {
                libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
            }
            break child.wait().unwrap();
        }
        thread::sleep(Duration::from_millis(10));
    };
    let output = std::process::Output {
        status,
        stdout: out.join().unwrap(),
        stderr: err.join().unwrap(),
    };
    assert!(!timed_out, "native fixture command exceeded its deadline");
    assert!(
        output.status.success(),
        "native fixture failed. stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout[output.stdout.len().saturating_sub(16_384)..]),
        String::from_utf8_lossy(&output.stderr[output.stderr.len().saturating_sub(16_384)..])
    );
    output
}

fn adb(arguments: &[&str]) -> std::process::Output {
    let mut command =
        Command::new(std::env::var_os("LAZYSH_ANDROID_ADB").unwrap_or_else(|| "adb".into()));
    command.args(arguments);
    command_output(command, std::time::Duration::from_secs(45))
}

fn android_artifacts() -> (String, String, Option<String>) {
    if let (Ok(binary), Ok(runtime)) = (
        std::env::var("LAZYSH_ANDROID_TEST_BINARY"),
        std::env::var("LAZYSH_ANDROID_CXX_RUNTIME"),
    ) {
        return (
            binary,
            runtime,
            std::env::var("LAZYSH_ANDROID_UNIT_BINARY").ok(),
        );
    }
    let ndk = std::path::PathBuf::from(
        std::env::var_os("ANDROID_NDK_HOME")
            .or_else(|| std::env::var_os("NDK_HOME"))
            .expect("Android NDK path"),
    );
    let host = if cfg!(target_os = "macos") {
        "darwin-x86_64"
    } else {
        "linux-x86_64"
    };
    let toolchain = ndk.join("toolchains/llvm/prebuilt").join(host);
    let tools = toolchain.join("bin");
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let mut command = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    command
        .current_dir(workspace)
        .args([
            "test",
            "-p",
            "lazysh-mosh-transport",
            "--target",
            "x86_64-linux-android",
            "--lib",
            "--test",
            "android_peer",
            "--no-run",
            "--locked",
            "--message-format=json",
        ])
        // A separate target directory prevents nested Cargo from waiting on the
        // outer Cargo test's build lock. Source/dependencies still use Cargo caches.
        .arg("--target-dir")
        .arg(workspace.join("target/android-mosh-tests"))
        .env("CARGO_BUILD_JOBS", "4")
        .env("ANDROID_NDK_HOME", &ndk)
        .env("ANDROID_API_LEVEL", "24")
        .env(
            "CC_x86_64_linux_android",
            tools.join("x86_64-linux-android24-clang"),
        )
        .env(
            "CXX_x86_64_linux_android",
            tools.join("x86_64-linux-android24-clang++"),
        )
        .env("AR_x86_64_linux_android", tools.join("llvm-ar"))
        .env(
            "CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER",
            tools.join("x86_64-linux-android24-clang"),
        );
    let output = command_output(command, std::time::Duration::from_secs(600));
    let mut binary = None;
    let mut units = None;
    for value in String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
    {
        if value["reason"] != "compiler-artifact" {
            continue;
        }
        if value["target"]["name"] == "android_peer" {
            binary = value["executable"].as_str().map(str::to_owned);
        } else if value["target"]["name"] == "lazysh_mosh_transport"
            && value["executable"].is_string()
        {
            units = value["executable"].as_str().map(str::to_owned);
        }
    }
    let binary = binary.expect("Cargo did not report the Android integration executable");
    let units = units.expect("Cargo did not report the Android unit test executable");
    let runtime = toolchain.join("sysroot/usr/lib/x86_64-linux-android/libc++_shared.so");
    (binary, runtime.to_str().unwrap().to_owned(), Some(units))
}

struct DeviceDirectory(String);
impl Drop for DeviceDirectory {
    fn drop(&mut self) {
        // Only this test-created directory is removed. Reuse bounded adb timeout.
        let _ = std::panic::catch_unwind(|| adb(&["shell", "rm", "-rf", "--", &self.0]));
    }
}

#[test]
#[ignore = "requires Android NDK and installed x86_64-linux-android Rust target"]
fn android_fixture_cross_compilation() {
    use std::io::Read;
    let (binary, runtime, units) = android_artifacts();
    let mut header = [0; 20];
    std::fs::File::open(binary)
        .unwrap()
        .read_exact(&mut header)
        .unwrap();
    assert_eq!(&header[..4], b"\x7fELF");
    assert_eq!(header[4], 2, "expected a 64-bit Android executable");
    assert_eq!(&header[18..20], &[62, 0], "expected x86_64 machine code");
    assert!(std::path::Path::new(&runtime).is_file());
    if let Some(units) = units {
        assert!(std::path::Path::new(&units).is_file());
    }
}

#[test]
#[ignore = "requires running x86_64 Android emulator and cross-compiled android_peer Cargo test binary"]
fn android_emulator_official_server_interoperability() {
    let (binary, runtime, units) = android_artifacts();
    assert!(std::path::Path::new(&binary).is_file());
    assert!(std::path::Path::new(&runtime).is_file());
    let version = Command::new("mosh-server")
        .arg("--version")
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&version.stdout).contains("mosh 1.4.0"));
    let directory = DeviceDirectory(format!(
        "/data/local/tmp/lazysh-mosh-{}",
        std::process::id()
    ));
    adb(&["shell", "mkdir", "-m", "700", &directory.0]);
    let device_binary = format!("{}/android-peer", directory.0);
    let device_runtime = format!("{}/libc++_shared.so", directory.0);
    adb(&["push", &binary, &device_binary]);
    adb(&["push", &runtime, &device_runtime]);
    adb(&["shell", "chmod", "700", &device_binary]);
    if let Some(units) = units {
        let device_units = format!("{}/native-units", directory.0);
        adb(&["push", &units, &device_units]);
        adb(&["shell", "chmod", "700", &device_units]);
        let result = adb(&[
            "shell",
            "env",
            &format!("LD_LIBRARY_PATH={}", directory.0),
            &device_units,
            "--nocapture",
        ]);
        let text = String::from_utf8(result.stdout).unwrap();
        assert!(
            text.contains("test result: ok.") && !text.contains("running 0 tests"),
            "Android unit tests did not execute: {text}"
        );
        println!("{text}");
    }
    // Launch only after staging the executable, so the bounded servers cannot
    // expire while a large debug test binary is copied to the emulator.
    let first = Server::start();
    let second = Server::start();
    assert!(first
        .key
        .bytes()
        .chain(second.key.bytes())
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/'));
    let output = adb(&[
        "shell",
        "env",
        &format!("LD_LIBRARY_PATH={}", directory.0),
        &format!("LAZYSH_MOSH_TEST_ONE_KEY={}", first.key),
        &format!("LAZYSH_MOSH_TEST_ONE_PORT={}", first.port),
        &format!("LAZYSH_MOSH_TEST_TWO_KEY={}", second.key),
        &format!("LAZYSH_MOSH_TEST_TWO_PORT={}", second.port),
        &device_binary,
        "--ignored",
        "--exact",
        "android_official_server_peer",
        "--nocapture",
    ]);
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(
        text.contains("1 passed"),
        "Android interoperability test did not execute: {text}"
    );
}

struct Server {
    pid: libc::pid_t,
    port: u16,
    key: String,
}
impl Server {
    fn start() -> Self {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let output = Command::new("mosh-server")
            .args(["new", "-i", "127.0.0.1", "-p", &port.to_string(), "-c", "256", "--", "sh", "-c", "printf 'READY\n'; while IFS= read -r line; do case \"$line\" in size) set -- $(stty size); printf 'SIZE_ROWS_%s_COLS_%s\n' \"$1\" \"$2\";; quit) exit;; *) printf 'RECEIVED_%s_END\n' \"$line\";; esac; done"])
            .env("LANG", "C.UTF-8").env("LC_ALL", "C.UTF-8").env("TERM", "xterm-256color")
            .env("MOSH_SERVER_NETWORK_TMOUT", "20")
            .stdin(Stdio::null()).output().expect("requires official mosh-server on PATH");
        assert!(output.status.success(), "mosh-server fixture did not start");
        let text = String::from_utf8(output.stdout).unwrap();
        let words: Vec<_> = text
            .lines()
            .find(|line| line.starts_with("MOSH CONNECT "))
            .expect("missing bootstrap response")
            .split_whitespace()
            .collect();
        assert_eq!(words.len(), 4);
        assert_eq!(words[2].parse::<u16>().unwrap(), port);
        let errors = String::from_utf8(output.stderr).unwrap();
        let pid = errors
            .split("[mosh-server detached, pid = ")
            .nth(1)
            .and_then(|tail| tail.split(']').next())
            .and_then(|text| text.parse::<libc::pid_t>().ok())
            .expect("missing fixture process identity");
        assert!(pid > 1);
        Self {
            pid,
            port,
            key: words[3].to_owned(),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        // SAFETY: this PID comes only from the mosh-server fixture launched by this test, with a bounded 20-second lifetime.
        unsafe {
            libc::kill(self.pid, libc::SIGTERM);
        }
    }
}
fn session(label: &str) {
    let server = Server::start();
    common::session(
        &server.key,
        format!("127.0.0.1:{}", server.port).parse().unwrap(),
        label,
    );
}
#[test]
#[ignore = "requires official mosh-server; run cargo test --test official_server -- --ignored"]
fn official_server_utf8_input_resize_shutdown_and_parallel_isolation() {
    let version = Command::new("mosh-server")
        .arg("--version")
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&version.stdout).contains("mosh 1.4.0"),
        "fixture must be official Mosh 1.4.0"
    );
    // SAFETY: these operations read the current process's locale, signal disposition, and stdin flags without changing them.
    let (locale, signal, stdin) = unsafe {
        let locale = CStr::from_ptr(libc::setlocale(libc::LC_CTYPE, std::ptr::null())).to_owned();
        let mut action: libc::sigaction = std::mem::zeroed();
        assert_eq!(
            libc::sigaction(libc::SIGWINCH, std::ptr::null(), &mut action),
            0
        );
        (
            locale,
            (action.sa_sigaction, action.sa_flags),
            libc::fcntl(libc::STDIN_FILENO, libc::F_GETFL),
        )
    };
    let first = thread::spawn(|| session("ONE"));
    let second = thread::spawn(|| session("TWO"));
    first.join().unwrap();
    second.join().unwrap();
    // SAFETY: identical read-only inspection after both clients have shut down.
    unsafe {
        assert_eq!(
            locale.as_c_str(),
            CStr::from_ptr(libc::setlocale(libc::LC_CTYPE, std::ptr::null()))
        );
        let mut action: libc::sigaction = std::mem::zeroed();
        assert_eq!(
            libc::sigaction(libc::SIGWINCH, std::ptr::null(), &mut action),
            0
        );
        assert_eq!(signal, (action.sa_sigaction, action.sa_flags));
        assert_eq!(stdin, libc::fcntl(libc::STDIN_FILENO, libc::F_GETFL));
    }
}
