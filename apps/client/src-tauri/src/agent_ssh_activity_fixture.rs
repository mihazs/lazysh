//! Owned integration: real Herdr/Codex hooks -> published companion -> Tauri SSH snapshot.
use super::*;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

const AGENT_SHA: &str = "ce2e9191ee9d4d559a19f49cecc561978a1377e45f15af6aa7aaf8d15da8ac3d";
const HOOKS_SHA: &str = "5526299fb948db511eb174f746aa6cc8c1f23d7d0f0b862453c345f5ca6a0626";
const CONFIG_SHA: &str = "c2d0c8b25a40c025888f0e80fafb0b175793d599cddd139f8de77195702ddac8";
fn hash(path: &std::path::Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}

#[tokio::test]
#[ignore = "requires a reviewed isolated namespace with pinned owned Herdr, Codex and published companion"]
async fn real_herdr_codex_hooks_reach_native_agent_snapshot_over_owned_ssh() {
    use tauri::Manager;
    let work = std::path::Path::new("/work");
    assert_eq!(
        std::env::var("LAZYSH_OWNED_ACTIVITY_FIXTURE").as_deref(),
        Ok("1")
    );
    let interfaces = Command::new("/usr/bin/python3")
        .args([
            "-c",
            "import socket; print(','.join(name for _, name in socket.if_nameindex()))",
        ])
        .output()
        .unwrap();
    assert!(interfaces.status.success());
    assert_eq!(
        interfaces.stdout, b"lo\n",
        "fixture must have only loopback"
    );
    let hooks = work.join("hook-home/codex/hooks.json");
    let config = work.join("hook-home/codex/config.toml");
    let agent = work.join("lazysh-agent");
    assert_eq!(hash(&agent), AGENT_SHA);
    assert_eq!(hash(&hooks), HOOKS_SHA);
    assert_eq!(hash(&config), CONFIG_SHA);
    assert!(!work.join("activity/events.sqlite3").exists());
    let binary = work.join("bin/herdr");
    let mut fixture = Fixture::with_activity_environment(Some(&binary), false, true).await;
    owned_herdr_shell_config(&fixture);
    let managed = fixture.dir.path().join("data-home/lazysh/companion");
    fs::create_dir_all(&managed).unwrap();
    fs::set_permissions(managed.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&managed, fs::Permissions::from_mode(0o700)).unwrap();
    fs::copy(&agent, managed.join("lazysh-agent")).unwrap();
    fs::set_permissions(
        managed.join("lazysh-agent"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert_eq!(hash(&managed.join("lazysh-agent")), AGENT_SHA);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let original = fs::read_to_string(&config).unwrap();
    let mut replacements = 0;
    let updated = original
        .lines()
        .map(|line| {
            if line.starts_with("base_url = \"http://127.0.0.1:") {
                replacements += 1;
                format!("base_url = \"http://127.0.0.1:{port}/v1\"")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    assert_eq!(replacements, 1);
    fs::write(&config, updated).unwrap();
    let (requested_tx, requested_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut input = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0 && input.len() + count <= 1024 * 1024);
            input.extend_from_slice(&buffer[..count]);
            if input.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                break;
            }
        }
        assert!(input.starts_with(b"POST /v1/responses "));
        let header_end = input
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap()
            + 4;
        let header = std::str::from_utf8(&input[..header_end]).unwrap();
        let length: usize = header
            .lines()
            .find_map(|line| {
                line.split_once(':').and_then(|(name, value)| {
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
            })
            .unwrap();
        assert!(length > 0 && length <= 1024 * 1024 - header_end);
        while input.len() < header_end + length {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0 && input.len() + count <= 1024 * 1024);
            input.extend_from_slice(&buffer[..count]);
        }
        let request: serde_json::Value =
            serde_json::from_slice(&input[header_end..header_end + length]).unwrap();
        assert_eq!(request["model"], "owned");
        requested_tx.send(()).unwrap();
        release_rx.await.unwrap();
        let events = [
            serde_json::json!({"type":"response.created","response":{"id":"owned-response"}}),
            serde_json::json!({"type":"response.output_item.done","item":{"type":"message","role":"assistant","id":"owned-message","content":[{"type":"output_text","text":"Owned fixture answer."}]}}),
            serde_json::json!({"type":"response.completed","response":{"id":"owned-response","usage":{"input_tokens":12,"input_tokens_details":null,"output_tokens":5,"output_tokens_details":null,"total_tokens":17}}}),
        ];
        let body = events
            .iter()
            .map(|value| {
                format!(
                    "event: {}\ndata: {}\n\n",
                    value["type"].as_str().unwrap(),
                    value
                )
            })
            .collect::<String>();
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        socket.write_all(body.as_bytes()).await.unwrap();
    });
    let mut servers = HerdrServers {
        fixture: &fixture,
        binary: &binary,
        processes: Vec::new(),
    };
    servers.start("owned-activity").await;
    let (app, state) = herdr_native_app(&fixture);
    let (_authority, lease) = unlocked_authority();
    let source = fixture.neutral(&state, &lease).await;
    let snapshot = || async {
        super::super::agent_snapshot(lease.clone(), app.state(), source.session_id.clone())
            .await
            .unwrap()
            .into_inner()
            .unwrap()
    };
    assert!(snapshot().await["sessions"].as_array().unwrap().is_empty());
    servers
        .json(
            "owned-activity",
            &[
                "workspace",
                "create",
                "--focus",
                "--label",
                "OWNED_ACTIVITY",
                "--cwd",
                "/work/cwd",
            ],
        )
        .await;
    let tree = servers.json("owned-activity", &["api", "snapshot"]).await;
    let pane = tree["result"]["snapshot"]["focused_pane_id"]
        .as_str()
        .unwrap();
    let launched = servers.output("owned-activity", &["pane", "run", pane, "exec /work/bin/codex exec --skip-git-repo-check --json -s read-only 'Owned trusted hook prompt; reply without tools.' > /work/turn.jsonl 2> /work/turn.stderr"]).await;
    assert!(launched.status.success() && launched.stdout.is_empty() && launched.stderr.is_empty());
    timeout(Duration::from_secs(30), requested_rx)
        .await
        .unwrap()
        .unwrap();
    let working = timeout(Duration::from_secs(10), async {
        loop {
            let rows = snapshot().await;
            let live = servers.json("owned-activity", &["api", "snapshot"]).await;
            let active = live["result"]["snapshot"]["agents"]
                .as_array()
                .is_some_and(|agents| {
                    agents
                        .iter()
                        .any(|row| row["agent"] == "codex" && row["pane_id"] == pane)
                });
            if active {
                if let Some(row) = rows["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["agent"] == "Codex" && row["state"] == "working")
                {
                    break row.clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(working["eventCount"], 1);
    release_tx.send(()).unwrap();
    let done = timeout(Duration::from_secs(10), async {
        loop {
            let rows = snapshot().await;
            if let Some(row) = rows["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["sessionId"] == working["sessionId"] && row["state"] == "done")
            {
                break row.clone();
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(done["eventCount"].as_u64().unwrap() > 1);
    server.await.unwrap();
    assert_eq!(hash(&hooks), HOOKS_SHA);
    assert_eq!(hash(&agent), AGENT_SHA);
    disconnect_inner(&state, source.session_id).await.unwrap();
    servers.stop().await;
    drop(servers);
    fixture.stop_listener().await;
}
