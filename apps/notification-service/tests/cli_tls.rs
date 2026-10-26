#![cfg(unix)]
mod support;
use lazysh_notifications::{client, Config, Service};
use std::{process::Stdio, time::Duration};
use tokio::process::Command;
const ADMIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DESTINATION: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
fn cli(ca: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-notifications"));
    command
        .arg("--relay-ca-file")
        .arg(ca)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}
async fn output(command: &mut Command) -> std::process::Output {
    tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .unwrap()
        .unwrap()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_cli_lost_tls_source_create_ack_recovers_same_envelope_and_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(
        Config::new(
            directory.path().into(),
            ADMIN,
            "https://example.invalid/events",
            DESTINATION,
        )
        .unwrap(),
    )
    .unwrap();
    let (router, committed) = support::hold_first_provision(service.router());
    let tls = support::Server::new(router).await;
    let ca = directory.path().join("relay-ca.pem");
    client::write_private(&ca, tls.pem.as_bytes()).unwrap();
    let admin = directory.path().join("admin");
    client::write_private(&admin, ADMIN.as_bytes()).unwrap();
    let envelope = directory.path().join("source envelope");
    let mut command = cli(&ca);
    command
        .args([
            "source-create",
            "--origin",
            &tls.origin,
            "--alias",
            "public-worker",
            "--admin-file",
        ])
        .arg(&admin)
        .arg("--output")
        .arg(&envelope);
    let mut child = command.spawn().unwrap();
    tokio::time::timeout(Duration::from_secs(5), committed.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    child.kill().await.unwrap();
    let killed = child.wait_with_output().await.unwrap();
    assert!(!killed.status.success());
    let saved = std::fs::read(&envelope).unwrap();
    let capability = client::read_capability(&envelope).unwrap();
    for _ in 0..2 {
        let mut resume = cli(&ca);
        resume
            .args(["source-resume", "--origin", &tls.origin, "--admin-file"])
            .arg(&admin)
            .arg("--capability-file")
            .arg(&envelope);
        let resumed = output(&mut resume).await;
        assert!(
            resumed.status.success(),
            "{}",
            String::from_utf8_lossy(&resumed.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&resumed.stdout).unwrap()["sourceId"],
            capability.source_id.to_string()
        );
        assert_eq!(std::fs::read(&envelope).unwrap(), saved);
        for bytes in [&resumed.stdout, &resumed.stderr] {
            assert!(!String::from_utf8_lossy(bytes).contains(&capability.secret));
            assert!(!String::from_utf8_lossy(bytes).contains(ADMIN));
        }
    }
    let mut enable = cli(&ca);
    enable
        .args([
            "destination",
            "--origin",
            &tls.origin,
            "--enable",
            "--admin-file",
        ])
        .arg(&admin);
    assert!(output(&mut enable).await.status.success());
    let event = uuid::Uuid::new_v4().to_string();
    let mut receipt = None;
    for _ in 0..2 {
        let mut publish = cli(&ca);
        publish
            .args(["publish", "--capability-file"])
            .arg(&envelope)
            .args(["--event-id", &event, "--state", "needs-attention"]);
        let sent = output(&mut publish).await;
        assert!(
            sent.status.success(),
            "{}",
            String::from_utf8_lossy(&sent.stderr)
        );
        let body: serde_json::Value = serde_json::from_slice(&sent.stdout).unwrap();
        assert_eq!(body["state"], "queued");
        let id = body["receiptId"].as_str().unwrap().to_owned();
        if let Some(ref expected) = receipt {
            assert_eq!(&id, expected);
        } else {
            receipt = Some(id);
        }
    }
    let mut get = cli(&ca);
    get.args(["receipt", "--capability-file"])
        .arg(&envelope)
        .args(["--receipt-id", receipt.as_ref().unwrap()]);
    assert!(output(&mut get).await.status.success());
    let mut wrong_host = cli(&ca);
    wrong_host
        .args([
            "status",
            "--origin",
            &tls.origin.replace("localhost", "127.0.0.1"),
            "--admin-file",
        ])
        .arg(&admin);
    let rejected = output(&mut wrong_host).await;
    assert!(!rejected.status.success());
    for bytes in [&rejected.stdout, &rejected.stderr] {
        assert!(!String::from_utf8_lossy(bytes).contains(ADMIN));
        assert!(!String::from_utf8_lossy(bytes).contains(&capability.secret));
    }
    let mut no_ca = Command::new(env!("CARGO_BIN_EXE_lazysh-notifications"));
    no_ca
        .kill_on_drop(true)
        .args(["status", "--origin", &tls.origin, "--admin-file"])
        .arg(&admin);
    assert!(!output(&mut no_ca).await.status.success());
}
