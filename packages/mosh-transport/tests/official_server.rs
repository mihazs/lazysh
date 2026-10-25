#![cfg(any(target_os = "linux", target_os = "macos"))]
mod common;
use std::{
    ffi::CStr,
    net::UdpSocket,
    process::{Command, Stdio},
    thread,
};

fn bounded_output(
    mut command: Command,
    timeout: std::time::Duration,
    on_timeout: impl FnOnce(u32) -> String,
) -> std::io::Result<(std::process::Output, bool, String)> {
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
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || capture(stdout));
    let err = thread::spawn(move || capture(stderr));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let mut diagnostics = String::new();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            // Observe this still-owned process before reaping it. Diagnostics
            // have a separate fixed budget; they never retry the timed-out job.
            diagnostics = on_timeout(child.id());
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
    Ok((output, timed_out, diagnostics))
}

fn redact_tail(mut text: String, keys: &[String]) -> String {
    for key in keys.iter().filter(|key| !key.is_empty()) {
        text = text.replace(key, "<redacted>");
    }
    let mut start = text.len().saturating_sub(16_384);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text.split_off(start)
}

// ps supplies executable names, never argv or environment. Retain only the
// owned leader and its direct native child in the leader's process group.
fn owned_processes(
    inventory: &str,
    leader: u32,
    executable: &std::path::Path,
) -> Vec<(u32, String)> {
    inventory
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let parent = fields.next()?.parse::<u32>().ok()?;
            let group = fields.next()?.parse::<u32>().ok()?;
            let name = fields.collect::<Vec<_>>().join(" ");
            let owned = group == leader
                && (pid == leader
                    || (parent == leader
                        && std::path::Path::new(&name).file_name() == executable.file_name()));
            owned.then_some((
                pid,
                format!("pid={pid} ppid={parent} pgid={group} executable={name}"),
            ))
        })
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn simulator_timeout_diagnostics(leader: u32, executable: &std::path::Path) -> String {
    use std::time::{Duration, Instant};
    // Inventory <=1s, then at most two 1-second samples, each with a <=2s
    // command budget. A single absolute 5s limit bounds the entire observation.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut inventory = Command::new("/bin/ps");
    inventory.args(["-axo", "pid=,ppid=,pgid=,comm="]);
    let Ok((inventory, timed_out, _)) =
        bounded_output(inventory, Duration::from_secs(1), |_| String::new())
    else {
        return "simulator diagnostics: owned-process inventory unavailable".into();
    };
    if timed_out || !inventory.status.success() {
        return "simulator diagnostics: owned-process inventory unavailable".into();
    }
    let processes = owned_processes(
        &String::from_utf8_lossy(&inventory.stdout),
        leader,
        executable,
    );
    let mut diagnostics = String::from("simulator diagnostics (argv/environment omitted):\n");
    for (pid, description) in processes.into_iter().take(2) {
        // Recheck group membership immediately before sampling. The leader is
        // our unreaped child; never attach to another group or a shared daemon.
        if unsafe { libc::getpgid(pid as libc::pid_t) } != leader as libc::pid_t {
            continue;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        diagnostics.push_str(&format!("{description}\n"));
        let mut sample = Command::new("/usr/bin/sample");
        sample.args([&pid.to_string(), "1", "10", "-file", "/dev/stdout"]);
        let Ok((sample, timed_out, _)) =
            bounded_output(sample, remaining.min(Duration::from_secs(2)), |_| {
                String::new()
            })
        else {
            diagnostics.push_str("sample tool unavailable\n");
            continue;
        };
        diagnostics.push_str(&format!(
            "sample deadline_exceeded={timed_out} status={}\n{}\n{}\n",
            sample.status,
            String::from_utf8_lossy(&sample.stdout),
            String::from_utf8_lossy(&sample.stderr)
        ));
    }
    diagnostics
}

fn command_output(command: Command, timeout: std::time::Duration) -> std::process::Output {
    // Inspect only program/argv, never Command's Debug representation: its
    // environment contains the private, ephemeral Mosh fixture keys.
    let mut keys: Vec<String> = command
        .get_envs()
        .filter(|(name, _)| name.to_string_lossy().ends_with("_KEY"))
        .filter_map(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
        .collect();
    let arguments: Vec<_> = command
        .get_args()
        .map(|argument| {
            let argument = argument.to_string_lossy();
            match argument.split_once('=') {
                Some((name, value)) if name.ends_with("_KEY") => {
                    keys.push(value.to_owned());
                    format!("{name}=<redacted>")
                }
                _ => argument.into_owned(),
            }
        })
        .collect();
    let description = format!(
        "{} {}",
        command.get_program().to_string_lossy(),
        arguments.join(" ")
    );
    #[cfg(target_os = "macos")]
    let native_executable = (arguments.first().map(String::as_str) == Some("simctl")
        && arguments.get(1).map(String::as_str) == Some("spawn"))
    .then(|| {
        command.get_args().find_map(|argument| {
            let path = std::path::Path::new(argument);
            let name = path.file_name()?.to_str()?;
            (name.starts_with("lazysh_mosh_transport-") || name.starts_with("ios_peer-"))
                .then(|| path.to_owned())
        })
    })
    .flatten();
    let (output, timed_out, diagnostics) = bounded_output(command, timeout, |_pid| {
        #[cfg(target_os = "macos")]
        if let Some(executable) = native_executable {
            return simulator_timeout_diagnostics(_pid, &executable);
        }
        String::new()
    })
    .expect("native fixture command");
    let stdout = redact_tail(String::from_utf8_lossy(&output.stdout).into_owned(), &keys);
    let stderr = redact_tail(String::from_utf8_lossy(&output.stderr).into_owned(), &keys);
    let diagnostics = redact_tail(diagnostics, &keys);
    assert!(
        !timed_out,
        "native fixture command exceeded its deadline ({timeout:?}): {description}. stdout: {stdout}\nstderr: {stderr}\n{diagnostics}",
    );
    assert!(
        output.status.success(),
        "native fixture failed ({description}). stdout: {stdout}\nstderr: {stderr}"
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
        std::env::var_os("NDK_HOME")
            .or_else(|| std::env::var_os("ANDROID_NDK_HOME"))
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
        .env("NDK_HOME", &ndk)
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
    let (binary, units) = cargo_test_artifacts(output, "android_peer");
    let runtime = toolchain.join("sysroot/usr/lib/x86_64-linux-android/libc++_shared.so");
    (binary, runtime.to_str().unwrap().to_owned(), Some(units))
}

fn cargo_test_artifacts(output: std::process::Output, peer_name: &str) -> (String, String) {
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
        if value["target"]["name"] == peer_name {
            binary = value["executable"].as_str().map(str::to_owned);
        } else if value["target"]["name"] == "lazysh_mosh_transport"
            && value["executable"].is_string()
        {
            units = value["executable"].as_str().map(str::to_owned);
        }
    }
    let binary = binary.expect("Cargo did not report the mobile integration executable");
    let units = units.expect("Cargo did not report the mobile unit test executable");
    (binary, units)
}

fn ios_artifacts() -> (String, String) {
    if !cfg!(target_os = "macos") {
        panic!("iOS tests require macOS with full Xcode");
    }
    let target = if cfg!(target_arch = "aarch64") {
        "aarch64-apple-ios-sim"
    } else {
        "x86_64-apple-ios"
    };
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
            target,
            "--lib",
            "--test",
            "ios_peer",
            "--no-run",
            "--locked",
            "--message-format=json",
        ])
        .arg("--target-dir")
        .arg(workspace.join("target/ios-mosh-tests"))
        .env("CARGO_BUILD_JOBS", "4")
        .env("IPHONEOS_DEPLOYMENT_TARGET", "16.0")
        // Rust selects the target SDK through xcrun; never inherit a host or
        // device SDKROOT when building for the simulator.
        .env_remove("SDKROOT");
    cargo_test_artifacts(
        command_output(command, std::time::Duration::from_secs(600)),
        "ios_peer",
    )
}

#[test]
#[ignore = "requires Xcode, a booted iOS Simulator, and official mosh-server"]
fn ios_simulator_official_server_interoperability() {
    let simulator =
        std::env::var("APPLE_STATUS_SIMULATOR_ID").expect("isolated iOS test simulator ID");
    assert!(
        simulator.len() == 36
            && simulator
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    );
    println!("iOS Mosh stage: compiling simulator Cargo test executables");
    let (peer, units) = ios_artifacts();
    println!("iOS Mosh stage: waiting for simulator boot readiness");
    let mut boot = Command::new("xcrun");
    boot.args(["simctl", "bootstatus", &simulator, "-b"]);
    command_output(boot, std::time::Duration::from_secs(180));
    // These are command-line Cargo executables, not installed applications.
    // Match Swift's simulator test runner by spawning directly instead of
    // routing their lifetime through the booted simulator's launchd service.
    // Probe the executable itself so a pre-main/dyld launch stall is reported
    // separately from a test body that fails to finish. Never retry a stall.
    println!("iOS Mosh stage: discovering native library tests through standalone launch");
    let mut discovery = Command::new("xcrun");
    discovery.args([
        "simctl",
        "spawn",
        "--standalone",
        &simulator,
        &units,
        "--list",
    ]);
    let discovered = command_output(discovery, std::time::Duration::from_secs(45));
    let discovered = String::from_utf8(discovered.stdout).unwrap();
    for required in [
        "scoped_ipv6_addresses_preserve_the_interface_for_the_numeric_resolver",
        "malformed_or_huge_remote_state_returns_errors_without_aborting",
        "unauthenticated_oversize_datagram_is_dropped_before_valid_traffic",
        "authenticated_fragment_bounds_and_invalid_tags_do_not_abort",
        "hostile_reference_and_state_flood_preserve_a_bounded_recoverable_client",
        "invalid_key_endpoint_dimensions_and_backlog_are_rejected",
    ] {
        assert!(
            discovered
                .lines()
                .any(|line| line.ends_with(&format!("::{required}: test"))),
            "iOS native executable did not discover {required}: {discovered}"
        );
    }
    println!("{discovered}");
    println!("iOS Mosh stage: running native library unit suite");
    let mut unit_command = Command::new("xcrun");
    unit_command.args([
        "simctl",
        "spawn",
        "--standalone",
        &simulator,
        &units,
        "--nocapture",
    ]);
    let output = command_output(unit_command, std::time::Duration::from_secs(45));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(
        text.contains("test result: ok.") && !text.contains("running 0 tests"),
        "iOS unit tests did not execute: {text}"
    );
    println!("{text}");
    println!("iOS Mosh stage: starting official host server fixtures");
    let version = Command::new("mosh-server")
        .arg("--version")
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&version.stdout).contains("mosh 1.4.0"));
    let first = Server::start();
    let second = Server::start();
    println!("iOS Mosh stage: running two-client simulator protocol suite");
    let mut protocol = Command::new("xcrun");
    protocol
        .args([
            "simctl",
            "spawn",
            "--standalone",
            &simulator,
            &peer,
            "--ignored",
            "--exact",
            "ios_official_server_peer",
            "--nocapture",
        ])
        .env("SIMCTL_CHILD_LAZYSH_MOSH_TEST_ONE_KEY", &first.key)
        .env(
            "SIMCTL_CHILD_LAZYSH_MOSH_TEST_ONE_PORT",
            first.port.to_string(),
        )
        .env("SIMCTL_CHILD_LAZYSH_MOSH_TEST_TWO_KEY", &second.key)
        .env(
            "SIMCTL_CHILD_LAZYSH_MOSH_TEST_TWO_PORT",
            second.port.to_string(),
        );
    let result = command_output(protocol, std::time::Duration::from_secs(45));
    let text = String::from_utf8(result.stdout).unwrap();
    assert!(
        text.contains("1 passed"),
        "iOS interoperability test did not execute: {text}"
    );
    println!("{text}");
}

#[test]
fn timed_out_fixture_reports_captured_diagnostics() {
    let started = std::time::Instant::now();
    let failure = std::panic::catch_unwind(|| {
        let mut child = Command::new("sh");
        child.args([
            "-c",
            "printf 'native-fixture-ready\\n%s\\n' \"$SIMCTL_CHILD_LAZYSH_MOSH_TEST_ONE_KEY\"; sleep 5",
            "fixture-helper",
            "LAZYSH_MOSH_TEST_ONE_KEY=private-argv-value",
        ]);
        child.env("PRIVATE_FIXTURE_ENV", "private-environment-value");
        child.env("SIMCTL_CHILD_LAZYSH_MOSH_TEST_ONE_KEY", "private-fixture-env-key");
        command_output(child, std::time::Duration::from_millis(100))
    })
    .expect_err("fixture must enforce the deadline");
    let message = failure
        .downcast_ref::<String>()
        .expect("diagnostic panic text");
    assert!(message.contains("exceeded its deadline"));
    assert!(message.contains("native-fixture-ready"));
    assert!(message.contains("LAZYSH_MOSH_TEST_ONE_KEY=<redacted>"));
    assert!(!message.contains("private-argv-value"));
    assert!(!message.contains("private-environment-value"));
    assert!(!message.contains("private-fixture-env-key"));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "owned child group must be stopped and reaped"
    );
}

#[test]
fn timeout_observer_sees_owned_process_before_its_group_is_reaped() {
    let mut child = Command::new("sh");
    child.args(["-c", "exec sleep 5"]);
    let mut observed = None;
    let (_, timed_out, diagnostics) =
        bounded_output(child, std::time::Duration::from_millis(50), |pid| {
            // SAFETY: this PID is our live, unreaped child, never a shared process.
            assert_eq!(
                unsafe { libc::getpgid(pid as libc::pid_t) },
                pid as libc::pid_t
            );
            observed = Some(pid);
            "owned process observed".into()
        })
        .unwrap();
    assert!(timed_out);
    assert_eq!(diagnostics, "owned process observed");
    let pid = observed.expect("deadline must observe the child before terminating it");
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[test]
fn diagnostic_inventory_excludes_unowned_groups_and_unrelated_children() {
    let inventory = "100 1 100 /usr/bin/simctl\n101 100 100 /tmp/ios_peer-one\n\
                     102 100 777 /tmp/ios_peer-one\n103 100 100 /usr/bin/unrelated\n\
                     104 999 100 /tmp/ios_peer-one\n105 1 105 private-unowned-process\n";
    let processes = owned_processes(inventory, 100, std::path::Path::new("/tmp/ios_peer-one"));
    assert_eq!(processes.len(), 2);
    assert_eq!(processes[0].0, 100);
    assert_eq!(processes[1].0, 101);
    assert!(processes.iter().all(|(_, line)| !line.contains("unowned")));
}

#[test]
fn diagnostic_redaction_precedes_bounded_unicode_tail() {
    let secret = "private-fixture-key".to_owned();
    let message = format!("{secret}{}{}", "🌐".repeat(8192), secret);
    let redacted = redact_tail(message, std::slice::from_ref(&secret));
    assert!(redacted.len() <= 16_384);
    assert!(!redacted.contains(&secret));
    assert!(redacted.ends_with("<redacted>"));
}

#[test]
fn simulator_diagnostics_never_sample_an_unowned_process_group() {
    let observed =
        simulator_timeout_diagnostics(u32::MAX, std::path::Path::new("ios_peer-fixture"));
    assert!(!observed.contains("pid="));
    assert!(!observed.contains("sample deadline_exceeded="));
}

#[test]
fn simulator_diagnostics_observe_the_live_fixture_and_keep_its_deadline() {
    let started = std::time::Instant::now();
    let mut child = Command::new("sleep");
    child.arg("10");
    let (_, timed_out, diagnostics) =
        bounded_output(child, std::time::Duration::from_millis(50), |pid| {
            simulator_timeout_diagnostics(pid, std::path::Path::new("ios_peer-no-child"))
        })
        .unwrap();
    assert!(timed_out);
    assert!(diagnostics.contains("executable="), "{diagnostics}");
    assert_eq!(diagnostics.matches("executable=").count(), 1);
    assert!(started.elapsed() < std::time::Duration::from_secs(6));
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
