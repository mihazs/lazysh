#![cfg(unix)]
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::fs::PermissionsExt,
    process::{Child, Command, Stdio},
    time::Duration,
};
const ADMIN: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
#[cfg(target_os = "linux")]
#[path = "support/real_whisper.rs"]
mod real_whisper;
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        // A fixture may already have reaped this child explicitly. Never send
        // a signal to its former PID after that identity can be reused.
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn command() -> Command {
    Command::new(env!("CARGO_BIN_EXE_lazysh-transcription"))
}
fn key(path: &std::path::Path, value: &str) {
    fs::write(path, value).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

struct Fixture(tempfile::TempDir);
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        key(&directory.path().join("admin"), ADMIN);
        key(
            &directory.path().join("provider"),
            "PRIVATE_PROVIDER_KEY_MARKER",
        );
        Self(directory)
    }
    fn serve(&self, device: &str, global: &str, listen: &str) -> Command {
        self.serve_with(device, global, listen, None)
    }
    fn serve_with(
        &self,
        device: &str,
        global: &str,
        listen: &str,
        whisper: Option<&str>,
    ) -> Command {
        let mut command = command();
        command
            .args(["serve", "--admin-token-file"])
            .arg(self.0.path().join("admin"));
        if let Some(port) = whisper {
            command.args(["--whisper-cpp-port", port]);
        } else {
            command
                .arg("--provider-key-file")
                .arg(self.0.path().join("provider"));
        }
        command
            .arg("--data-dir")
            .arg(self.0.path().join("state"))
            .args([
                "--device-seconds-per-day",
                device,
                "--global-seconds-per-day",
                global,
                "--listen",
                listen,
            ]);
        command
    }
}

#[test]
fn keygen_and_failed_configuration_are_bounded_without_secret_echo_or_state_creation() {
    let generated = command().arg("keygen").output().unwrap();
    assert!(generated.status.success());
    let text = String::from_utf8(generated.stdout).unwrap();
    assert_eq!(text.trim().len(), 64);
    assert!(text.trim().bytes().all(|byte| byte.is_ascii_hexdigit()));
    let fixture = Fixture::new();
    for (listen, seconds, public_key) in [
        ("0.0.0.0:7348", "1", false),
        ("127.0.0.1:0", "0", false),
        ("127.0.0.1:0", "1", true),
    ] {
        if public_key {
            fs::set_permissions(
                fixture.0.path().join("provider"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap();
        }
        let output = fixture.serve(seconds, "10", listen).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(!error.contains(ADMIN));
        assert!(!error.contains("PRIVATE_PROVIDER_KEY_MARKER"));
        assert!(!fixture.0.path().join("state").exists());
    }
}

#[tokio::test]
async fn compiled_service_enrolls_cancels_and_revokes_over_actual_http_without_provider_calls() {
    for whisper in [None, Some("1")] {
        check_compiled_service(whisper).await;
    }
}
async fn check_compiled_service(whisper: Option<&str>) {
    let fixture = Fixture::new();
    let (process, base) = start_relay(fixture.serve_with("30", "60", "127.0.0.1:0", whisper));
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    check_enrollment(&fixture, process, &base, &client, whisper.is_some()).await;
}
fn start_relay(mut command: Command) -> (Process, String) {
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut process = Process(child);
    let stdout = process.0.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).take(1025).read_line(&mut line);
        let _ = send.send((result, line));
    });
    let (read, line) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    read.unwrap();
    reader.join().unwrap();
    assert!(line.len() <= 1024);
    let address = line.trim().strip_prefix("LISTENING ").unwrap();
    let base = format!("http://{address}");
    (process, base)
}
async fn check_enrollment(
    fixture: &Fixture,
    process: Process,
    base: &str,
    client: &reqwest::Client,
    whisper: bool,
) {
    assert_eq!(
        client
            .get(format!("{base}/v1/devices"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let response = client
        .post(format!("{base}/v1/devices"))
        .bearer_auth(ADMIN)
        .header("content-type", "application/json")
        .body(r#"{"label":"fixture phone"}"#)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let value: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    let token = value["token"].as_str().unwrap();
    let device = value["device"]["id"].as_str().unwrap();
    let capabilities: serde_json::Value = serde_json::from_str(
        &client
            .get(format!("{base}/v1/capabilities"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        capabilities["model"],
        if whisper {
            "whisper.cpp"
        } else {
            "gpt-transcribe"
        }
    );
    let response = client
        .post(format!("{base}/v1/transcriptions"))
        .bearer_auth(token)
        .header("content-type", "application/json")
        .body(r#"{"language":"pt"}"#)
        .send()
        .await
        .unwrap();
    let job: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    let id = job["jobId"].as_str().unwrap();
    assert_eq!(
        client
            .delete(format!("{base}/v1/transcriptions/{id}"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(
        client
            .delete(format!("{base}/v1/devices/{device}"))
            .bearer_auth(ADMIN)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(
        client
            .get(format!("{base}/v1/quota"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    drop(process);
    let bytes = fs::read(fixture.0.path().join("state/quota.sqlite3")).unwrap();
    for hidden in [token, ADMIN, "PRIVATE_PROVIDER_KEY_MARKER"] {
        assert!(!bytes
            .windows(hidden.len())
            .any(|window| window == hidden.as_bytes()));
    }
}

#[test]
fn whisper_port_is_numeric_nonzero_and_exclusive_with_provider_credentials() {
    let fixture = Fixture::new();
    for port in [
        "0",
        "65536",
        "example.com",
        "127.0.0.1:8080",
        "8080/inference",
    ] {
        let output = fixture
            .serve_with("1", "2", "127.0.0.1:0", Some(port))
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!fixture.0.path().join("state").exists());
    }
    let output = fixture
        .serve("1", "2", "127.0.0.1:0")
        .args(["--whisper-cpp-port", "8080"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!fixture.0.path().join("state").exists());
}
