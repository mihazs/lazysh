//! Owned-file/native-command acceptance. No provider, account or WebView access.
use super::*;
use russh::keys::ssh_key::encoding::base64::{Base64, Encoding};
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;

const PNG: &[u8] = include_bytes!("../../../../e2e/fixtures/recorded-images/regions.png");
const JPEG: &[u8] =
    include_bytes!("../../../../e2e/fixtures/recorded-images/regions-orientation6.jpg");

pub(super) fn companion_path(directory: &Path) -> String {
    let binary = PathBuf::from(std::env::var_os("LAZYSH_TEST_AGENT_BIN").expect(
        "Build lazysh-agent from this checkout and provide its private target binary explicitly",
    ));
    assert!(binary.is_absolute() && binary.is_file());
    let bin = directory.join("bin");
    fs::create_dir(&bin).unwrap();
    std::os::unix::fs::symlink(fs::canonicalize(binary).unwrap(), bin.join("lazysh-agent"))
        .unwrap();
    assert!(!bin.to_str().unwrap().chars().any(char::is_whitespace));
    format!(
        "SetEnv PATH={}:/usr/bin:/bin HOME={} ZDOTDIR={} BASH_ENV=/dev/null ENV=/dev/null\n",
        bin.display(),
        directory.display(),
        directory.display()
    )
}

fn encoded(bytes: &[u8]) -> String {
    let mut buffer = vec![0; bytes.len().div_ceil(3) * 4];
    Base64::encode(bytes, &mut buffer).unwrap().to_owned()
}

fn record(agent: &str, index: usize, bytes: &[u8], mime: &str) -> Value {
    let data = encoded(bytes);
    match agent {
        "grok-acp" => {
            json!({"timestamp":1,"method":"session/update","params":{"sessionId":"owned-images","update":{"sessionUpdate":"user_message_chunk","content":{"type":"image","mimeType":mime,"data":data}}}})
        }
        "claude" => {
            json!({"type":"user","uuid":format!("owned-{index}"),"parentUuid":index.checked_sub(1).map(|i|format!("owned-{i}")),"message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":mime,"data":data}}]}})
        }
        "codex" => {
            json!({"type":"response_item","payload":{"type":"message","id":format!("owned-{index}"),"role":"user","content":[{"type":"input_image","image_url":format!("data:{mime};base64,{data}")}]}})
        }
        _ => unreachable!(),
    }
}

async fn read(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    id: &str,
    (agent, view): (&str, Option<&str>),
    path: &Path,
    offset: u64,
    images: Option<bool>,
) -> Value {
    timeout(
        Duration::from_secs(8),
        agent_transcript(
            lease.clone(),
            app.state(),
            id.into(),
            agent.into(),
            path.to_str().unwrap().into(),
            offset,
            view.map(str::to_owned),
            None,
            None,
            images,
            None,
        ),
    )
    .await
    .unwrap()
    .unwrap()
    .into_inner()
    .unwrap()
}

pub(super) async fn verify(
    app: &tauri::App<tauri::test::MockRuntime>,
    initial: &str,
    directory: &Path,
) {
    let authority = unlocked_access();
    let lease = ready_lease(&authority);
    let parent = app.state::<AppState>().session(initial).await.unwrap();
    let (channel, data) = open_terminal_for(&parent.handle, &lease, 80, 24, None)
        .await
        .unwrap();
    let connected = spawn_terminal(
        &app.state(),
        lease.clone(),
        parent.handle.clone(),
        channel,
        data,
        Channel::new(|_| Ok(())),
    )
    .await
    .unwrap();
    let id = connected.session_id;
    let session = app.state::<AppState>().session(&id).await.unwrap();
    assert!(Arc::ptr_eq(&session.handle, &parent.handle));
    assert_eq!(session.creation.generation(), lease.generation());
    disconnect(app.state(), initial.into()).await.unwrap();
    for agent in ["grok-acp", "claude", "codex"] {
        let path = directory.join(format!("{agent} images' 世界$(literal).jsonl"));
        let records = (0..60)
            .map(|index| {
                let (bytes, mime) = if index == 0 {
                    (PNG, "image/png")
                } else {
                    (JPEG, "image/jpeg")
                };
                serde_json::to_string(&record(agent, index, bytes, mime)).unwrap() + "\n"
            })
            .collect::<String>();
        fs::write(&path, &records).unwrap();
        let legacy = read(app, &lease, &id, (agent, None), &path, 0, None).await;
        assert!(legacy["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["blocks"][0].get("imagePreview").is_none()));
        let mut offset = 0;
        let mut count = 0;
        let mut ids = std::collections::HashSet::new();
        loop {
            let mut page = read(app, &lease, &id, (agent, None), &path, offset, Some(true)).await;
            assert_eq!(page["schemaVersion"], 1);
            assert_eq!(page["view"], "record_stream");
            assert_eq!(page["agent"], agent);
            let size = serde_json::to_vec(&page).unwrap().len();
            assert!(size < 512 * 1024);
            if offset == 0 {
                assert!(
                    size > 32 * 1024,
                    "response must span ordinary SSH data frames"
                );
            }
            for row in page["messages"].as_array_mut().unwrap() {
                assert!(ids.insert(row["id"].as_str().unwrap().to_owned()));
                let (bytes, mime) = if count == 0 {
                    (PNG, "image/png")
                } else {
                    (JPEG, "image/jpeg")
                };
                verify_preview(&mut row["blocks"][0], bytes, mime);
                count += 1;
            }
            if offset == 0 {
                assert_eq!(
                    page, legacy,
                    "image removal must recover the default-off page exactly"
                );
            }
            let next = page["nextOffset"].as_u64().unwrap();
            assert!(next > offset);
            offset = next;
            if !page["hasMore"].as_bool().unwrap() {
                break;
            }
        }
        assert_eq!(count, 60);
        assert_eq!(offset, records.len() as u64);
        assert_eq!(fs::read(&path).unwrap(), records.as_bytes());
    }
    verify_conversation(app, &lease, &id, directory).await;
    verify_reported_history(app, &lease, &id, directory).await;
    assert!(app.state::<AppState>().session(&id).await.is_ok());
    disconnect(app.state(), id.clone()).await.unwrap();
    assert!(app.state::<AppState>().session(&id).await.is_err());
    assert!(app.state::<AppState>().sessions.lock().await.is_empty());
}

fn verify_preview(block: &mut Value, bytes: &[u8], mime: &str) {
    let preview = block
        .as_object_mut()
        .unwrap()
        .remove("imagePreview")
        .unwrap();
    assert_eq!(preview["mimeType"], mime);
    assert_eq!(preview["data"], encoded(bytes));
    assert_eq!(
        (preview["width"].as_u64(), preview["height"].as_u64()),
        (Some(32), Some(16))
    );
    let mut decoded = vec![0; preview["data"].as_str().unwrap().len()];
    assert_eq!(
        Base64::decode(preview["data"].as_str().unwrap(), &mut decoded).unwrap(),
        bytes
    );
}

async fn verify_conversation(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    id: &str,
    directory: &Path,
) {
    let abandoned: &[u8] =
        include_bytes!("../../../../e2e/fixtures/recorded-images/regions-progressive.jpg");
    let mut records = [
        record("claude", 0, PNG, "image/png"),
        record("claude", 1, abandoned, "image/jpeg"),
        record("claude", 2, JPEG, "image/jpeg"),
    ];
    // Latest eligible leaf selects this explicit fork; IDs remain opaque.
    records[2]["parentUuid"] = json!("owned-0");
    for (row, text) in records
        .iter_mut()
        .zip(["Root text", "Abandoned text", "Selected text"])
    {
        row["message"]["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"text","text":text}));
    }
    let source = records
        .iter()
        .map(|row| serde_json::to_string(row).unwrap() + "\n")
        .collect::<String>();
    let path = directory.join("Claude branch' 世界$(literal).jsonl");
    fs::write(&path, &source).unwrap();
    let legacy = read(
        app,
        lease,
        id,
        ("claude", Some("conversation")),
        &path,
        0,
        None,
    )
    .await;
    let mut page = read(
        app,
        lease,
        id,
        ("claude", Some("conversation")),
        &path,
        0,
        Some(true),
    )
    .await;
    assert_eq!(page["schemaVersion"], 1);
    assert_eq!(page["agent"], "claude");
    assert_eq!(page["view"], "active_branch");
    assert_eq!(page["branchId"], "owned-2");
    assert_eq!(page["hasMore"], false);
    assert_eq!(page["truncated"], false);
    assert_eq!(page["nextOffset"], source.len() as u64);
    let serialized = serde_json::to_string(&page).unwrap();
    assert!(!serialized.contains("owned-1") && !serialized.contains("Abandoned text"));
    assert!(!serialized.contains(&encoded(abandoned)));
    let messages = page["messages"].as_array_mut().unwrap();
    assert_eq!(messages.len(), 2);
    for (row, (expected_id, text, bytes, mime)) in messages.iter_mut().zip([
        ("owned-0", "Root text", PNG, "image/png"),
        ("owned-2", "Selected text", JPEG, "image/jpeg"),
    ]) {
        assert_eq!(row["id"], expected_id);
        assert_eq!(row["role"], "user");
        assert_eq!(row["blocks"].as_array().unwrap().len(), 2);
        assert_eq!(row["blocks"][1]["text"], text);
        verify_preview(&mut row["blocks"][0], bytes, mime);
    }
    assert_eq!(
        page, legacy,
        "selected branch default-off equivalence must be exact"
    );
    assert_eq!(fs::read(&path).unwrap(), source.as_bytes());
    lease.check().unwrap();
    assert_eq!(app.state::<AppState>().sessions.lock().await.len(), 1);
}

#[tokio::test]
async fn invalid_image_options_reject_before_session_lookup() {
    let (_directory, state) = fixture_state();
    let app = tauri::test::mock_app();
    app.manage(state);
    for (agent, view, checkpointed) in [
        ("pi", None, false),
        ("codex", Some("conversation"), false),
        ("claude", None, true),
    ] {
        let error = agent_transcript(
            access_lease(),
            app.state(),
            "absent-session".into(),
            agent.into(),
            "/owned/no-read.jsonl".into(),
            0,
            view.map(str::to_owned),
            None,
            Some(checkpointed),
            Some(true),
            None,
        )
        .await
        .err()
        .unwrap()
        .into_inner()
        .unwrap();
        assert_eq!(error.kind, "invalid_input");
    }
}

#[tokio::test]
async fn held_transcript_open_cannot_dispatch_after_original_lease_revocation() {
    cancelled_agent_read(false).await;
}

#[tokio::test]
async fn held_reported_history_open_cannot_dispatch_after_original_lease_revocation() {
    cancelled_agent_read(true).await;
}

async fn cancelled_agent_read(reported: bool) {
    let authority = unlocked_access();
    let lease = ready_lease(&authority);
    let (state, _directory, _host, server, task, session) = auxiliary_fixture(lease.clone()).await;
    state
        .sessions
        .lock()
        .await
        .insert("owned-source".into(), session.clone());
    let app = tauri::test::mock_app();
    app.manage(state);
    server.hold_opens.store(true, Ordering::SeqCst);
    let original = lease.clone();
    let pending = tokio::spawn(async move {
        if reported {
            return agent_reported_history(
                original,
                app.state(),
                "owned-source".into(),
                "opaque-claude".into(),
            )
            .await;
        }
        agent_transcript(
            original,
            app.state(),
            "owned-source".into(),
            "codex".into(),
            "/owned/images.jsonl".into(),
            0,
            None,
            None,
            None,
            Some(true),
            None,
        )
        .await
    });
    timeout(Duration::from_secs(3), server.open_started.notified())
        .await
        .unwrap();
    let channel = server.opening_channel.lock().unwrap().unwrap();
    revoke_pending(&authority, pending).await;
    release_held_opens(&server).await;
    assert!(observe_channel_close(&server, channel).await);
    assert!(server.commands.lock().unwrap().is_empty());
    timeout(Duration::from_secs(3), async {
        while session.handle.open_slots.available_permits() != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let probe = session.handle.channel_open_session().await.unwrap();
    probe.close().await.unwrap();
    task.abort();
}

async fn reported_source(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    session: &str,
    agent_session: &str,
) -> Value {
    agent_reported_history(
        lease.clone(),
        app.state(),
        session.into(),
        agent_session.into(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap()
}

async fn verify_reported_history(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    id: &str,
    directory: &Path,
) {
    let opaque = "Claude' --opaque 世界";
    let path = directory.join("unwritten history' 世界$(literal).jsonl ");
    let mut payload = json!({"hook_event_name":"UserPromptSubmit","session_id":opaque,"transcript_path":path,"cwd":directory,"prompt":"never store prompt bytes"});
    let session = app.state::<AppState>().session(id).await.unwrap();
    for opted in [false, true] {
        let command = format!(
            "printf %s {} | lazysh-agent ingest --agent claude{}",
            quote(&payload.to_string()),
            if opted { " --reported-history" } else { "" }
        );
        assert!(exec(&session, lease, command).await.unwrap().is_empty());
        let value = reported_source(app, lease, id, opaque).await;
        assert_eq!(value["sessionId"], opaque);
        assert_eq!(value["schemaVersion"], 1);
        if opted {
            assert_eq!(value["status"], "available");
            assert_eq!(value["path"], path.to_str().unwrap());
            assert!(value["reportedAt"].as_str().is_some());
        } else {
            assert_eq!(
                value,
                json!({"schemaVersion":1,"status":"missing","sessionId":opaque})
            );
        }
        assert!(
            !path.exists(),
            "metadata capture/lookup must not open or create transcript files"
        );
    }
    let snapshot = agent_snapshot(lease.clone(), app.state(), id.into())
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    assert!(
        !snapshot.to_string().contains("unwritten")
            && !snapshot.to_string().contains("never store prompt")
    );
    payload["transcript_path"] = json!(directory.join("conflicting.jsonl"));
    exec(
        &session,
        lease,
        format!(
            "printf %s {} | lazysh-agent ingest --agent claude --reported-history",
            quote(&payload.to_string())
        ),
    )
    .await
    .unwrap();
    let value = reported_source(app, lease, id, opaque).await;
    assert_eq!(
        value,
        json!({"schemaVersion":1,"sessionId":opaque,"status":"ambiguous"})
    );
}

#[tokio::test]
async fn reported_history_id_validation_precedes_session_lookup_and_quotes_literal_ids() {
    assert_eq!(
        reported_history_command("opaque' --id 世界").unwrap(),
        r"lazysh-agent reported-history --session-id='opaque'\'' --id 世界'"
    );
    let (_directory, state) = fixture_state();
    let app = tauri::test::mock_app();
    app.manage(state);
    for id in [
        String::new(),
        "\n".into(),
        "x".repeat(1025),
        "世".repeat(257),
    ] {
        let error =
            agent_reported_history(access_lease(), app.state(), "missing-session".into(), id)
                .await
                .err()
                .unwrap()
                .into_inner()
                .unwrap();
        assert_eq!(error.kind, "invalid_input");
    }
}
