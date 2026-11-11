//! Owned OpenSSH acceptance of the live conversation stream: the real companion's `transcript-watch`
//! over one real SSH exec channel, the client's own start and stop commands, and an older companion.
//! No agent CLI or provider runs; the transcript is synthetic.
use super::*;
use crate::transcript_watch::{
    agent_watch_start, agent_watch_stop, TranscriptWatches, WatchEvent, WatchTarget,
};
use serde_json::{json, Value};
use std::{io::Write, path::Path, sync::Mutex, time::Instant};
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;

/// One synthetic Claude Code transcript line.
fn line(uuid: &str, parent: Option<&str>, kind: &str) -> String {
    let body = json!({"uuid": uuid, "parentUuid": parent, "message": {"content": "synthetic text"}, "type": kind});
    body.to_string() + "\n"
}

/// Events reach the test in the order the companion sent them.
fn collector() -> (Channel<WatchEvent>, Arc<Mutex<Vec<Value>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let channel = Channel::new(move |body| {
        let text = match body {
            tauri::ipc::InvokeResponseBody::Json(text) => text,
            tauri::ipc::InvokeResponseBody::Raw(_) => unreachable!(),
        };
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(&text).unwrap());
        Ok(())
    });
    (channel, seen)
}

async fn until(
    seen: &Arc<Mutex<Vec<Value>>>,
    wanted: impl Fn(&Value) -> bool,
) -> (Value, Duration) {
    let started = Instant::now();
    timeout(Duration::from_secs(8), async {
        let mut taken = 0;
        loop {
            let next = seen.lock().unwrap().get(taken).cloned();
            match next {
                Some(event) if wanted(&event) => return (event, started.elapsed()),
                Some(_) => taken += 1,
                None => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
    })
    .await
    .expect("the expected live event did not arrive")
}

fn frame_of(kind: &'static str) -> impl Fn(&Value) -> bool {
    move |event| event["type"] == "frame" && event["frame"]["type"] == kind
}

fn running(directory: &Path) -> bool {
    // The companion's own process, matched by the unique transcript path in its command line.
    std::process::Command::new("pgrep")
        .args(["-f", &format!("transcript-watch.*{}", directory.display())])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub(super) async fn verify(app: &App, id: &str, directory: &Path) {
    let transcript = directory.join("session.jsonl");
    fs::write(&transcript, line("m0", None, "user")).unwrap();
    let target = || WatchTarget::Path {
        agent: "claude".into(),
        path: transcript.display().to_string(),
    };
    let start = |events| {
        agent_watch_start(
            access_lease(),
            app.state(),
            app.state(),
            id.into(),
            target(),
            events,
        )
    };

    // A new conversation: hello, a snapshot, then only what changed, within a fraction of a second.
    let (events, seen) = collector();
    let token = start(events).await.unwrap().into_inner().unwrap();
    until(&seen, frame_of("hello")).await;
    let (snapshot, _) = until(&seen, frame_of("snapshot")).await;
    assert_eq!(snapshot["frame"]["entries"][0]["id"], "m0");
    let mut latencies = Vec::new();
    for index in 1..=10 {
        let parent = format!("m{}", index - 1);
        let text = line(&format!("m{index}"), Some(&parent), "assistant");
        let appended = Instant::now();
        fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        let (delta, _) = until(&seen, |event| {
            event["type"] == "frame"
                && event["frame"]["type"] == "delta"
                && event["frame"]["upserts"][0]["id"] == format!("m{index}")
        })
        .await;
        latencies.push(appended.elapsed());
        assert_eq!(
            delta["frame"]["upserts"].as_array().unwrap().len(),
            1,
            "only the new entry is sent"
        );
        tokio::time::sleep(Duration::from_millis(137)).await;
    }
    latencies.sort();
    eprintln!("append on the host to the delta in the client over real SSH: min {:?}, median {:?}, max {:?}", latencies[0], latencies[5], latencies[9]);
    assert!(*latencies.last().unwrap() < Duration::from_secs(2));
    assert!(running(directory));

    // Stopping closes the channel, which ends the host process; the client gets a closing event.
    agent_watch_stop(app.state(), id.into(), token)
        .await
        .unwrap();
    until(&seen, |event| event["type"] == "closed").await;
    timeout(Duration::from_secs(5), async {
        while running(directory) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("closing the channel must end the host process");

    // The app lock cancels a running watch.
    let (events, seen) = collector();
    start(events).await.unwrap().into_inner().unwrap();
    until(&seen, frame_of("snapshot")).await;
    app.state::<TranscriptWatches>().cancel_for_lock().await;
    until(&seen, |event| event["type"] == "closed").await;

    // A companion that predates the subcommand answers with a usage error, which the client reports once.
    let executable = directory.join("bin/lazysh-agent");
    let held = directory.join("bin/held-companion");
    fs::rename(&executable, &held).unwrap();
    fs::write(&executable, "#!/bin/sh\nexit 2\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let (events, seen) = collector();
    start(events).await.unwrap().into_inner().unwrap();
    let (unavailable, _) = until(&seen, |event| event["type"] == "unavailable").await;
    assert_eq!(unavailable["reason"], "companion_required");
    fs::remove_file(&executable).unwrap();
    fs::rename(&held, &executable).unwrap();
}
