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
    agent: &str,
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
            None,
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
        let legacy = read(app, &lease, &id, agent, &path, 0, None).await;
        assert!(legacy["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["blocks"][0].get("imagePreview").is_none()));
        let mut offset = 0;
        let mut count = 0;
        let mut ids = std::collections::HashSet::new();
        loop {
            let mut page = read(app, &lease, &id, agent, &path, offset, Some(true)).await;
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
                let preview = row["blocks"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("imagePreview")
                    .unwrap();
                let (bytes, mime) = if count == 0 {
                    (PNG, "image/png")
                } else {
                    (JPEG, "image/jpeg")
                };
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
    assert!(app.state::<AppState>().session(&id).await.is_ok());
    disconnect(app.state(), id.clone()).await.unwrap();
    assert!(app.state::<AppState>().session(&id).await.is_err());
    assert!(app.state::<AppState>().sessions.lock().await.is_empty());
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
