//! The bridge against a scripted relay on a fake exec channel: the test is the relay, so every message the app
//! sends and every way a channel can end is chosen here.
use super::{
    outbox::IDLE,
    wire::{fixtures::*, Viewport},
    *,
};
use crate::{
    app_lock::AccessState,
    ssh::test_support::{ready_lease, unlocked_access},
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::{
    ipc::{InvokeResponseBody, IpcResponse},
    Manager,
};

const JPEG: [u8; 6] = [0xff, 0xd8, 0xff, 0, 1, 0xd9];
const ADDRESS: &str = "http://example.test/";

struct Fake {
    from_relay: mpsc::UnboundedReceiver<Incoming>,
    to_relay: mpsc::UnboundedSender<Vec<u8>>,
    finished: Arc<AtomicBool>,
}
impl Exec for Fake {
    async fn send(&mut self, bytes: &[u8]) -> Result<()> {
        self.to_relay
            .send(bytes.to_vec())
            .map_err(|_| SshError::new("disconnected", "The channel is closed"))
    }
    async fn next(&mut self) -> Incoming {
        self.from_relay.recv().await.unwrap_or(Incoming::End)
    }
    async fn finish(&mut self) {
        self.finished.store(true, Ordering::SeqCst);
    }
}

/// The relay's side of one channel.
struct Relay {
    say: mpsc::UnboundedSender<Incoming>,
    heard: mpsc::UnboundedReceiver<Vec<u8>>,
    finished: Arc<AtomicBool>,
}
impl Relay {
    fn write(&self, bytes: Vec<u8>) {
        self.say.send(Incoming::Data(bytes)).unwrap();
    }
    fn json(&self, value: Value) {
        self.write(json_message(value));
    }
    fn running(&self) {
        self.json(
            json!({"type":"state","state":"running","browser":"Chrome/120.0.0.0",
            "viewport":{"width":412,"height":915,"scale":1.0},
            "capabilities":{"view":true,"control":false,"navigation":false,"tabs":false}}),
        );
    }
    fn frame(&self, sequence: u32) {
        self.write(frame_message(sequence, &JPEG));
    }
    /// The next message the app sent, decoded.
    async fn heard(&mut self) -> Value {
        let bytes = timeout(Duration::from_secs(5), self.heard.recv())
            .await
            .expect("the app sent nothing")
            .expect("the app closed its end");
        client_message(&bytes)
    }
    fn nothing_more_heard(&mut self) -> bool {
        self.heard.try_recv().is_err()
    }
    /// The app ended its side: end of input was sent and the channel closed.
    async fn closed(&self) -> bool {
        for _ in 0..50 {
            if self.finished.load(Ordering::SeqCst) {
                return true;
            }
            sleep(Duration::from_millis(100)).await;
        }
        false
    }
}

struct Harness {
    app: tauri::App<tauri::test::MockRuntime>,
    access: AccessLease,
    connects: Arc<AtomicUsize>,
}
fn viewport() -> Viewport {
    Viewport {
        width: 412,
        height: 915,
        scale: 1.0,
    }
}
impl Harness {
    fn new() -> Self {
        let app = tauri::test::mock_app();
        app.manage(HostBrowsers::default());
        Self {
            app,
            access: AccessState::disabled().lease(None).unwrap(),
            connects: Arc::default(),
        }
    }
    fn browsers(&self) -> State<'_, HostBrowsers> {
        self.app.state()
    }
    async fn start(&self, session: &str, gone: &watch::Sender<bool>) -> Result<(String, Relay)> {
        self.start_with(self.access.clone(), session, gone).await
    }
    /// A browser whose relay already said it is running.
    async fn running(&self, gone: &watch::Sender<bool>) -> (String, Relay) {
        let (id, relay) = self.start("s", gone).await.unwrap();
        relay.running();
        (id, relay)
    }
    async fn start_with(
        &self,
        access: AccessLease,
        session: &str,
        gone: &watch::Sender<bool>,
    ) -> Result<(String, Relay)> {
        let (say, from_relay) = mpsc::unbounded_channel();
        let (to_relay, heard) = mpsc::unbounded_channel();
        let finished = Arc::new(AtomicBool::new(false));
        let fake = Fake {
            from_relay,
            to_relay,
            finished: finished.clone(),
        };
        let connects = self.connects.clone();
        let open = open_message(viewport(), Some(ADDRESS))?;
        let id = self
            .browsers()
            .spawn(access, session.into(), open, gone.subscribe(), async move {
                connects.fetch_add(1, Ordering::SeqCst);
                Ok(fake)
            })
            .await?;
        Ok((
            id,
            Relay {
                say,
                heard,
                finished,
            },
        ))
    }
    /// A pull, as the webview receives it.
    async fn pull(&self, session: &str, id: &str) -> Result<Vec<u8>> {
        let response = host_browser_next(
            self.access.clone(),
            self.app.state(),
            session.into(),
            id.into(),
        )
        .await
        .map_err(|error| error.into_inner().unwrap())?;
        match response.body().unwrap() {
            InvokeResponseBody::Raw(bytes) => Ok(bytes),
            InvokeResponseBody::Json(_) => panic!("a pull must answer with bytes"),
        }
    }
    /// The next JSON message, past any idle pulls.
    async fn json(&self, session: &str, id: &str) -> Value {
        loop {
            let bytes = self.pull(session, id).await.unwrap();
            if bytes != [IDLE] {
                assert_eq!(bytes[0], wire::JSON, "{bytes:?}");
                return serde_json::from_slice(&bytes[1..]).unwrap();
            }
        }
    }
    async fn stop(&self, session: &str, id: &str) -> Result<()> {
        host_browser_stop(self.app.state(), session.into(), id.into()).await
    }
    async fn tell(&self, command: &str, session: &str, id: &str) -> Result<()> {
        let (access, browsers, session, id) = (
            self.access.clone(),
            self.app.state(),
            session.into(),
            id.into(),
        );
        let answer = match command {
            "ack" => host_browser_ack(access, browsers, session, id, 1, Some(4))
                .await
                .map(drop),
            "pause" => host_browser_pause(access, browsers, session, id)
                .await
                .map(drop),
            _ => host_browser_resume(access, browsers, session, id)
                .await
                .map(drop),
        };
        answer.map_err(|error| error.into_inner().unwrap())
    }
}

#[tokio::test(start_paused = true)]
async fn a_browser_runs_from_open_to_stop_with_its_frames_as_bytes() {
    let h = Harness::new();
    let (gone, _) = watch::channel(false);
    let (id, mut relay) = h.start("s", &gone).await.unwrap();

    // The first message is the open: the page's size and its address, nothing else.
    assert_eq!(
        relay.heard().await,
        json!({"type":"open","browser":"chrome","viewport":{"width":412,"height":915,"scale":1.0},"url":ADDRESS})
    );
    relay.running();
    relay.frame(1);
    relay.json(json!({"type":"page","title":"A title","url":ADDRESS}));
    assert_eq!(h.json("s", &id).await["state"], "running");
    let frame = h.pull("s", &id).await.unwrap();
    assert_eq!(frame[0], wire::FRAME);
    assert_eq!(u32::from_be_bytes(frame[1..5].try_into().unwrap()), 1);
    assert_eq!(
        &frame[21..],
        JPEG,
        "the JPEG arrives as the relay sent it, not as base64"
    );
    let page = h.json("s", &id).await;
    assert_eq!(
        (page["title"].as_str(), page["url"].as_str()),
        (Some("A title"), Some(ADDRESS))
    );

    h.tell("ack", "s", &id).await.unwrap();
    assert_eq!(
        relay.heard().await,
        json!({"type":"ack","sequence":1,"decodeMs":4})
    );

    // A frame that was waiting when the view was hidden is not the first thing it shows after it resumes.
    relay.frame(2);
    sleep(Duration::from_millis(10)).await;
    h.tell("pause", "s", &id).await.unwrap();
    assert_eq!(relay.heard().await, json!({"type":"pause"}));
    // The real relay answers a pause and a resume with a `state` that names only `state`.
    relay.json(json!({"type":"state","state":"paused"}));
    assert_eq!(
        h.json("s", &id).await,
        json!({"type":"state","state":"paused"})
    );
    assert_eq!(
        h.pull("s", &id).await.unwrap(),
        vec![IDLE],
        "nothing for 15 s is one idle byte"
    );
    h.tell("resume", "s", &id).await.unwrap();
    assert_eq!(relay.heard().await, json!({"type":"resume"}));
    relay.json(json!({"type":"state","state":"running"}));
    assert_eq!(
        h.json("s", &id).await,
        json!({"type":"state","state":"running"})
    );
    relay.frame(3);
    let frame = h.pull("s", &id).await.unwrap();
    assert_eq!(u32::from_be_bytes(frame[1..5].try_into().unwrap()), 3);

    // Stopping closes the channel and frees the session's slot.
    assert!(!relay.finished.load(Ordering::SeqCst));
    h.stop("s", &id).await.unwrap();
    assert!(
        relay.closed().await,
        "stop must end the channel's input and close it"
    );
    assert!(h.pull("s", &id).await.is_err());
    assert!(h.tell("pause", "s", &id).await.is_err());
    assert_eq!(h.connects.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_slow_renderer_gets_the_newest_frame_and_pulls_one_message_at_a_time() {
    let h = Harness::new();
    let (gone, _) = watch::channel(false);
    let (id, relay) = h.running(&gone).await;
    for sequence in 1..=200 {
        relay.frame(sequence);
        relay.json(json!({"type":"page","title":format!("t{sequence}"),"url":ADDRESS}));
    }
    sleep(Duration::from_millis(10)).await;
    assert_eq!(h.json("s", &id).await["type"], "state");
    let mut messages = 0;
    let mut newest = 0;
    // Everything the relay said is two messages: the newest frame and the newest page.
    while let Ok(bytes) = timeout(Duration::from_secs(1), h.pull("s", &id)).await {
        let bytes = bytes.unwrap();
        messages += 1;
        if bytes[0] == wire::FRAME {
            newest = u32::from_be_bytes(bytes[1..5].try_into().unwrap());
        } else {
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes[1..]).unwrap()["title"],
                "t200"
            );
        }
    }
    assert_eq!((messages, newest), (2, 200));

    // One pull at a time: a second renderer cannot take half the stream.
    let first = h.pull("s", &id);
    let second = h.pull("s", &id);
    let (first, second) = tokio::join!(first, second);
    assert_eq!(
        (
            first.is_ok(),
            second.err().map(|error| error.kind().to_string())
        ),
        (true, Some("busy".into()))
    );
}

#[tokio::test(start_paused = true)]
async fn one_browser_per_session_and_two_per_app() {
    let h = Harness::new();
    let (gone, _) = watch::channel(false);
    let (first, _a) = h.start("a", &gone).await.unwrap();
    assert_eq!(h.start("a", &gone).await.err().unwrap().kind(), "busy");
    let (_second, b) = h.start("b", &gone).await.unwrap();
    assert_eq!(
        h.start("c", &gone).await.err().unwrap().kind(),
        "busy",
        "a third session is refused"
    );
    // The two accepted browsers connect on their own tasks.
    sleep(Duration::from_millis(10)).await;
    assert_eq!(
        h.connects.load(Ordering::SeqCst),
        2,
        "a refused browser opened no channel"
    );

    // Another session cannot use or stop a browser it does not own.
    assert!(h.stop("c", &first).await.is_err());
    assert!(h.pull("c", &first).await.is_err());
    h.stop("a", &first).await.unwrap();
    let (_third, _c) = h.start("c", &gone).await.unwrap();

    // A browser whose channel ended holds no slot, though the renderer never stopped it.
    b.say.send(Incoming::End).unwrap();
    sleep(Duration::from_millis(10)).await;
    let (_fourth, _d) = h.start("d", &gone).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn the_channel_closes_on_lock_disconnect_and_session_end() {
    for how in ["lock", "app access", "disconnect", "session end"] {
        let h = Harness::new();
        let access = unlocked_access();
        let lease = ready_lease(&access);
        let (gone, _) = watch::channel(false);
        let (id, relay) = h.start_with(lease, "s", &gone).await.unwrap();
        relay.running();
        relay.frame(1);
        sleep(Duration::from_millis(10)).await;
        assert!(!relay.finished.load(Ordering::SeqCst), "{how}");
        match how {
            "lock" => h.browsers().cancel_for_lock().await,
            "app access" => access.lock().unwrap(),
            "disconnect" => drop(gone.send_replace(true)),
            _ => drop(gone),
        }
        assert!(relay.closed().await, "{how}: the channel stayed open");
        if how == "lock" {
            assert!(
                h.pull("s", &id).await.is_err(),
                "the frames of a locked app are gone"
            );
            continue;
        }
        // The renderer reads what was waiting, then why it ended.
        let reason = loop {
            let bytes = h.pull("s", &id).await.unwrap();
            if bytes[0] == wire::JSON {
                let message: Value = serde_json::from_slice(&bytes[1..]).unwrap();
                if message["type"] == "closed" {
                    break message["reason"].clone();
                }
            }
        };
        assert_eq!(
            reason,
            if how == "app access" {
                "Stopped"
            } else {
                "Disconnected"
            },
            "{how}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_broken_stream_ends_the_session_and_closes_the_channel() {
    let oversized = {
        let mut bytes = ((1 + 20 + (4 << 20) + 1) as u32).to_be_bytes().to_vec();
        bytes.push(wire::FRAME);
        bytes
    };
    for (name, broken) in [
        ("a length of zero", vec![0, 0, 0, 0]),
        ("an oversized frame", oversized),
        ("an unknown tag", message(9, b"{}")),
    ] {
        let h = Harness::new();
        let (gone, _) = watch::channel(false);
        let (id, relay) = h.running(&gone).await;
        relay.write(broken);
        // What follows a broken message is never read.
        relay.frame(5);
        assert_eq!(h.json("s", &id).await["type"], "state", "{name}");
        let closed = h.json("s", &id).await;
        assert_eq!(
            (closed["type"].as_str(), closed["reason"].as_str()),
            (Some("closed"), Some("ProtocolViolation")),
            "{name}"
        );
        assert!(relay.closed().await, "{name}: the channel stayed open");
        assert!(
            h.pull("s", &id).await.is_err(),
            "{name}: the stream is over"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_companion_without_the_relay_or_with_the_switch_off_is_named_and_not_retried() {
    for (name, speak, reason) in [
        (
            "older companion",
            Some(format!("{COMPANION_REQUIRED}\n").into_bytes()),
            "CompanionRequired",
        ),
        ("switch off", None, "HostBrowserDisabled"),
        (
            "a usage error",
            Some(b"usage: lazysh-agent\n".to_vec()),
            "ProtocolViolation",
        ),
    ] {
        let h = Harness::new();
        let (gone, _) = watch::channel(false);
        let (id, mut relay) = h.start("s", &gone).await.unwrap();
        assert_eq!(relay.heard().await["type"], "open");
        match speak {
            Some(text) => relay.write(text),
            None => {
                relay.json(json!({"type":"closed","reason":"HostBrowserDisabled"}));
                relay.say.send(Incoming::Exit(1)).unwrap();
            }
        }
        assert_eq!(h.json("s", &id).await["reason"], reason, "{name}");
        assert!(relay.closed().await, "{name}");
        assert!(relay.nothing_more_heard(), "{name}: nothing else was sent");
        assert_eq!(
            h.connects.load(Ordering::SeqCst),
            1,
            "{name}: nothing was started again"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn silence_before_the_first_message_times_out_but_a_quiet_page_does_not() {
    let h = Harness::new();
    let (gone, _) = watch::channel(false);
    let (id, relay) = h.start("s", &gone).await.unwrap();
    assert_eq!(h.json("s", &id).await["reason"], "StartTimeout");
    assert!(relay.closed().await);

    // A page that does not change sends nothing; that is not a dead channel.
    let (id, relay) = h.start("t", &gone).await.unwrap();
    relay.running();
    assert_eq!(h.json("t", &id).await["type"], "state");
    sleep(Duration::from_secs(3600)).await;
    assert!(!relay.finished.load(Ordering::SeqCst));
    relay.frame(1);
    assert_eq!(h.pull("t", &id).await.unwrap()[0], wire::FRAME);
}

#[tokio::test(start_paused = true)]
async fn a_browser_that_cannot_connect_says_so_once() {
    let h = Harness::new();
    let (gone, _) = watch::channel(false);
    let id = h
        .browsers()
        .spawn(
            h.access.clone(),
            "s".into(),
            vec![],
            gone.subscribe(),
            async { Err::<Fake, _>(SshError::new("timeout", "private detail")) },
        )
        .await
        .unwrap();
    let closed = h.json("s", &id).await;
    assert_eq!(closed, json!({"type":"closed","reason":"ConnectFailed"}));
    assert!(h.pull("s", &id).await.is_err());
}

/// The command line is the contract with the companion: the option is sent only when the user chose it, and as the
/// companion's own flag, so an older relay refuses it with a usage error instead of dropping it.
#[test]
fn the_relay_is_asked_to_keep_its_profile_only_when_the_user_chose_it() {
    assert_eq!(serve_command(false), "lazysh-agent host-browser serve");
    assert_eq!(
        serve_command(true),
        "lazysh-agent host-browser serve --keep-profile"
    );
}

#[test]
fn the_open_message_carries_a_valid_size_and_a_web_address_only() {
    let message = |viewport, url| {
        open_message(viewport, url)
            .map(|bytes| serde_json::from_slice::<Value>(&bytes[5..]).unwrap())
    };
    assert_eq!(
        message(viewport(), None).unwrap(),
        json!({"type":"open","browser":"chrome","viewport":{"width":412,"height":915,"scale":1.0}})
    );
    for url in ["about:blank", "https://example.test/x?y=1", ADDRESS] {
        assert_eq!(message(viewport(), Some(url)).unwrap()["url"], url);
    }
    let long = format!("http://{}", "a".repeat(2048));
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,x",
        "chrome://settings",
        "http://a b/",
        long.as_str(),
    ] {
        assert_eq!(
            message(viewport(), Some(url)).err().unwrap().kind(),
            "invalid_input",
            "{url}"
        );
    }
    assert_eq!(
        message(
            Viewport {
                width: 50,
                ..viewport()
            },
            None
        )
        .err()
        .unwrap()
        .kind(),
        "invalid_input"
    );
    assert_eq!(
        serde_json::from_value::<Viewport>(json!({"width":412,"height":915})).unwrap(),
        viewport(),
        "a renderer that sends no scale means 1"
    );
}

mod privacy {
    use super::*;

    const CHILD: &str = "LAZYSH_HOST_BROWSER_PRIVACY_DIR";
    const NEEDLES: [&str; 3] = [
        "needle-address.example.test",
        "Needle Title 4242",
        "NEEDLE-FRAME-BYTES",
    ];

    /// The scenario, run in a child process so that everything it prints, its panics included, can be read.
    #[tokio::test(start_paused = true)]
    async fn scenario() {
        let Some(directory) = std::env::var_os(CHILD).map(std::path::PathBuf::from) else {
            return;
        };
        let app = tauri::test::mock_app();
        app.manage(HostBrowsers::default());
        app.manage(AppState::new(directory.join("config")).unwrap());
        let access = AccessState::disabled().lease(None).unwrap();
        let address = format!("https://{}/path?token=1", NEEDLES[0]);
        let jpeg = [
            &[0xff, 0xd8, 0xff][..],
            NEEDLES[2].as_bytes(),
            &[0xff, 0xd9],
        ]
        .concat();
        let mut pulled = 0;
        for broken in [false, true] {
            let (gone, _) = watch::channel(false);
            let (say, from_relay) = mpsc::unbounded_channel();
            let (to_relay, _heard) = mpsc::unbounded_channel();
            let fake = Fake {
                from_relay,
                to_relay,
                finished: Arc::default(),
            };
            let open = open_message(viewport(), Some(&address)).unwrap();
            let id = app
                .state::<HostBrowsers>()
                .spawn(access.clone(), "s".into(), open, gone.subscribe(), async {
                    Ok(fake)
                })
                .await
                .unwrap();
            let page = json!({"type":"page","title":NEEDLES[1],"url":address});
            say.send(Incoming::Data(json_message(json!({"type":"state","state":"running","browser":"Chrome/120","viewport":{"width":412,"height":915},"capabilities":{}})))).unwrap();
            say.send(Incoming::Data(frame_message(1, &jpeg))).unwrap();
            say.send(Incoming::Data(json_message(page))).unwrap();
            if broken {
                // serde's own message for an unknown variant quotes the value: it must not get out.
                let hostile = json!({"type":"state","state":NEEDLES[1],"browser":NEEDLES[0],"viewport":{"width":412,"height":915},"capabilities":{}});
                say.send(Incoming::Data(json_message(hostile))).unwrap();
            }
            for _ in 0..if broken { 4 } else { 3 } {
                let response =
                    host_browser_next(access.clone(), app.state(), "s".into(), id.clone())
                        .await
                        .unwrap();
                assert!(matches!(
                    response.body().unwrap(),
                    InvokeResponseBody::Raw(_)
                ));
                pulled += 1;
            }
            if !broken {
                host_browser_ack(access.clone(), app.state(), "s".into(), id.clone(), 1, None)
                    .await
                    .unwrap();
                host_browser_pause(access.clone(), app.state(), "s".into(), id.clone())
                    .await
                    .unwrap();
                host_browser_resume(access.clone(), app.state(), "s".into(), id.clone())
                    .await
                    .unwrap();
                host_browser_stop(app.state(), "s".into(), id)
                    .await
                    .unwrap();
            } else {
                let error = host_browser_ack(
                    access.clone(),
                    app.state(),
                    "s".into(),
                    "unknown".into(),
                    1,
                    None,
                )
                .await
                .err()
                .unwrap();
                println!("{error:?} {}", serde_json::to_string(&error).unwrap());
                host_browser_stop(app.state(), "s".into(), id)
                    .await
                    .unwrap();
            }
        }
        std::fs::write(directory.join("pulled"), pulled.to_string()).unwrap();
    }

    fn files(directory: &std::path::Path, found: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(directory).unwrap().flatten() {
            if entry.path().is_dir() {
                files(&entry.path(), found);
            } else {
                found.push(entry.path());
            }
        }
    }

    #[test]
    fn nothing_about_a_page_reaches_the_logs_or_app_storage() {
        let directory = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "host_browser::tests::privacy::scenario",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD, directory.path())
            .output()
            .unwrap();
        let logs = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.status.success(), "{logs}");
        // The scenario really ran: it pulled every message of both sessions.
        assert_eq!(
            std::fs::read_to_string(directory.path().join("pulled")).unwrap(),
            "7"
        );
        let mut stored = Vec::new();
        files(directory.path(), &mut stored);
        let mut seen = logs.into_bytes();
        for file in stored {
            seen.extend(std::fs::read(file).unwrap());
        }
        for needle in NEEDLES {
            assert!(
                !seen
                    .windows(needle.len())
                    .any(|window| window == needle.as_bytes()),
                "{needle:?} reached a log or a stored file"
            );
        }
    }
}
