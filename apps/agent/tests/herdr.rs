//! Owned socket and executable fixtures only; never a user Herdr server.
#![cfg(unix)]
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
};
#[path = "support/binary.rs"]
mod binary;

#[tokio::test]
async fn exact_public_pane_focus_is_bounded_and_never_retries_uncertain_dispatch() {
    for case in [
        "exact",
        "wrong",
        "error",
        "oversized",
        "eof",
        "timeout",
        "cancel",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("owned.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let sessions =
            json!({"sessions":[{"name":"owned","running":true,"socket_path":socket}]}).to_string();
        let herdr = directory.path().join("herdr");
        fs::write(
            &herdr,
            format!(
                "#!/bin/sh\n[ \"$*\" = 'session list --json' ] || exit 91\nprintf '%s' '{}'\n",
                sessions
            ),
        )
        .unwrap();
        fs::set_permissions(&herdr, fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = Command::new(binary::path());
        child
            .env_clear()
            .env("HOME", directory.path())
            .env("PATH", directory.path())
            .args(["herdr-focus-pane", "--session", "owned", "--pane", "w2E:pF"])
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = child.spawn().unwrap();
        let pid = child.id().unwrap();
        let output = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(6), child.wait_with_output())
                .await
                .unwrap()
                .unwrap()
        });
        let (stream, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut stream = BufReader::new(stream);
        let mut request = String::new();
        tokio::time::timeout(Duration::from_secs(1), stream.read_line(&mut request))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request).unwrap(),
            json!({"id":"lazysh:focus-pane","method":"pane.focus","params":{"pane_id":"w2E:pF"}})
        );
        let body = match case {
            "exact" => Some(json!({"id":"lazysh:focus-pane","result":{"type":"pane_info","pane":{"pane_id":"w2E:pF"}}}).to_string()),
            "wrong" => Some(json!({"id":"lazysh:focus-pane","result":{"type":"pane_info","pane":{"pane_id":"w2E:pG"}}}).to_string()),
            "error" => Some(json!({"id":"lazysh:focus-pane","error":{"message":"fixture-private-not-for-output"}}).to_string()),
            "oversized" => Some("x".repeat(1024 * 1024 + 1)),
            "eof" | "timeout" | "cancel" => None,
            _ => unreachable!(),
        };
        if let Some(body) = body {
            // A bounded rejection may close while the oversized body is still being written.
            let _ = stream
                .get_mut()
                .write_all(format!("{body}\n").as_bytes())
                .await;
        }
        if case == "eof" {
            drop(stream);
        }
        if case == "cancel" {
            let status = tokio::time::timeout(
                Duration::from_secs(1),
                Command::new("/bin/kill")
                    .args(["-INT", &pid.to_string()])
                    .status(),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(status.success());
        }
        let output = output.await.unwrap();
        if case == "cancel" {
            assert!(String::from_utf8_lossy(&output.stderr).contains("HerdrFocusCancelled"));
        }
        assert_eq!(output.status.success(), case == "exact", "{case}");
        if case == "exact" {
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                json!({"schemaVersion":1,"status":"focused","paneId":"w2E:pF"})
            );
        }
        assert!(!String::from_utf8_lossy(&output.stderr).contains("fixture-private"));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "{case}: retried a dispatched focus"
        );
    }
}
