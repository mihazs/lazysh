//! Owned real SSH/tmux paste oracles; no production helper or provider process.
use super::*;
use serde_json::json;

async fn ready(servers: &NamedServers<'_>, marker: &str) {
    timeout(BOUND, async {
        while !servers
            .direct("chat-a", &["capture-pane", "-p", "-t", "%0"])
            .contains(marker)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned mode output consumed by tmux");
}

#[tokio::test]
#[ignore = "requires owned OpenSSH and tmux 3.4+; exact multiline paste acceptance"]
async fn real_tmux_multiline_modes_hooks_errors_and_lost_ack() {
    for case in [
        "basic",
        "plain",
        "bracketed",
        "tab",
        "maximum",
        "changed",
        "before",
        "after",
        "exited",
        "error",
        "lease",
        "lost",
    ] {
        eprintln!("owned multiline case: {case}");
        timeout(Duration::from_secs(30), probe(case))
            .await
            .expect("bounded multiline fixture");
    }
}

async fn probe(case: &str) {
    let f = Fixture::new().await;
    let servers = NamedServers {
        fixture: &f,
        names: vec!["chat-a".into()],
    };
    let selected = f.dir.path().join("paste-selected");
    let other = f.dir.path().join("paste-other");
    let enabled = !matches!(case, "basic" | "plain" | "changed");
    let mode = if enabled { "h" } else { "l" };
    let workload = format!(
        "stty raw -echo; printf '\\033[?2004{mode}MODE_READY'; exec cat > {}",
        quote(selected.to_str().unwrap())
    );
    assert_eq!(
        servers.direct(
            "chat-a",
            &[
                "new-session",
                "-d",
                "-s",
                "recorded",
                "-P",
                "-F",
                "#{pane_id}",
                &workload
            ]
        ),
        "%0"
    );
    let other_window = servers.direct(
        "chat-a",
        &[
            "new-window",
            "-d",
            "-t",
            "$0",
            "-P",
            "-F",
            "#{window_id}",
            &format!(
                "stty raw -echo; exec cat > {}",
                quote(other.to_str().unwrap())
            ),
        ],
    );
    ready(&servers, "MODE_READY").await;
    chat_fixture_bytes(&selected, b"").await;
    chat_fixture_bytes(&other, b"").await;
    servers.direct(
        "chat-a",
        &["set-buffer", "-b", "untouched", "owned sentinel"],
    );
    let (state, app, access, lease) = chat_fixture_app(f.dir.path().join("paste-config"));
    let parent = f.neutral(&state, &lease).await;
    let child = chat_fixture_attach(&app, &lease, &parent.session_id, "recorded").await;
    let source = json!({"agent":"claude","path":"/owned/multiline.jsonl","view":"conversation","inlineImages":false});
    let bound = chat_fixture_bind(&app, &lease, &child, &source).await;
    let text = match case {
        "basic" => "a\nb".to_owned(),
        "tab" => "-\tleading tab input".to_owned(),
        "maximum" => format!("{}\n", "界".repeat(1365)),
        _ => "- é\n\t'\";$()#{pane_id}\\ 世界\nlast  ".to_owned(),
    };
    let input = json!({"kind":"input","receipt":bound["receipt"],"source":source,"operation":1,"input":{"kind":"send","text":text}});
    let native = state.session(&child).await.unwrap();
    let binding = native.tmux.lock().unwrap().clone().unwrap();
    let version = std::process::Command::new(&f.tmux)
        .arg("-V")
        .output()
        .unwrap();
    assert!(version.status.success() && version.stdout.starts_with(b"tmux 3."));
    eprintln!(
        "owned tmux version: {}",
        String::from_utf8_lossy(&version.stdout).trim()
    );
    let movement = format!("select-window -t $0:{other_window}");
    let delete_owned = format!(
        "run-shell {}",
        quote(&format!(
            "{} -L chat-a delete-buffer -b '#{{hook_flag_b}}'",
            quote(&f.tmux)
        ))
    );
    let hook = match case {
        "before" => Some(("after-set-buffer", movement.as_str())),
        "after" => Some(("after-paste-buffer", movement.as_str())),
        "exited" => Some(("after-set-buffer", "kill-pane -t %0")),
        "error" => Some(("after-set-buffer", delete_owned.as_str())),
        "lost" => Some(("after-paste-buffer", "wait-for lazysh-paste-held")),
        _ => None,
    };
    if let Some((name, command)) = hook {
        servers.direct("chat-a", &["set-hook", "-g", name, command]);
    }
    let mut expected = Vec::new();
    if enabled || case == "changed" {
        expected.extend_from_slice(b"\x1b[200~");
    }
    expected.extend_from_slice(text.as_bytes());
    if enabled || case == "changed" {
        expected.extend_from_slice(b"\x1b[201~");
    }
    if case == "lease" {
        let (release, pending) = binding
            .fixture_held_input(&lease, native.cancel.subscribe(), input)
            .await;
        access.lock().unwrap();
        let _ = release.send(());
        assert!(pending.await.unwrap().is_err());
        timeout(BOUND, binding.retired()).await.unwrap();
        assert!(tokio::fs::read(&selected).await.unwrap().is_empty());
    } else if case == "lost" {
        let pending = binding.fixture_call(lease.clone(), native.cancel.subscribe(), input.clone());
        chat_fixture_bytes(&selected, &expected).await;
        pending.abort();
        let _ = pending.await;
        timeout(BOUND, binding.retired()).await.unwrap();
        servers.direct("chat-a", &["wait-for", "-S", "lazysh-paste-held"]);
        assert!(binding
            .fixture_call(lease.clone(), native.cancel.subscribe(), input)
            .await
            .unwrap()
            .is_err());
        let actual = tokio::fs::read(&selected).await.unwrap();
        assert!(actual == expected || actual == [expected.as_slice(), b"\r"].concat());
    } else {
        let result = if case == "changed" {
            let (release, pending) = binding
                .fixture_held_input(&lease, native.cancel.subscribe(), input.clone())
                .await;
            let tty = servers.direct(
                "chat-a",
                &["display-message", "-p", "-t", "%0", "#{pane_tty}"],
            );
            servers.direct(
                "chat-a",
                &[
                    "run-shell",
                    &format!("printf '\\033[?2004hMODE_CHANGED' > {}", quote(&tty)),
                ],
            );
            ready(&servers, "MODE_CHANGED").await;
            release.send(()).unwrap();
            pending
                .await
                .unwrap()
                .map(|reply| serde_json::to_value(reply).unwrap())
                .map_err(|error| format!("{error:?}"))
        } else {
            chat_fixture_call(&app, &lease, &child, input.clone()).await
        };
        match case {
            "before" | "exited" => {
                assert!(result.unwrap_err().contains("tmux_chat_stale"));
                assert!(tokio::fs::read(&selected).await.unwrap().is_empty());
            }
            "after" | "error" => {
                assert!(result.is_err());
                timeout(BOUND, binding.retired()).await.unwrap();
                chat_fixture_bytes(&selected, if case == "after" { &expected } else { b"" }).await;
                assert!(chat_fixture_call(&app, &lease, &child, input)
                    .await
                    .is_err());
            }
            _ => {
                assert_eq!(
                    result.unwrap(),
                    json!({"kind":"delivered","nextOperation":2})
                );
                expected.push(b'\r');
                chat_fixture_bytes(&selected, &expected).await;
                assert!(chat_fixture_call(&app, &lease, &child, input)
                    .await
                    .is_err());
                assert_eq!(tokio::fs::read(&selected).await.unwrap(), expected);
            }
        }
    }
    assert!(tokio::fs::read(&other).await.unwrap().is_empty());
    assert_eq!(
        servers.direct("chat-a", &["list-buffers", "-F", "#{buffer_name}"]),
        "untouched"
    );
    assert_eq!(
        servers.direct("chat-a", &["show-buffer", "-b", "untouched"]),
        "owned sentinel"
    );
    disconnect(app.state(), child).await.unwrap();
    disconnect(app.state(), parent.session_id).await.unwrap();
    assert!(state.sessions.lock().await.is_empty());
}
