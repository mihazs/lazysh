//! Explicit pane input to an unchanged stock Herdr, driven through the app command over actual OpenSSH and the real
//! companion actor. Only owned servers, owned PTY receivers and a private HOME: no operator Herdr, tmux or profile.
use super::herdr_guard::{captured, install_capture};
use super::*;
use crate::ssh::test_support::{ready_lease, unlocked_access};
use serde_json::{json, Value};

/// An owned sshd whose remote PATH holds the stock Herdr and the companion (`lazysh-agent`, or the stand-in `agent`).
async fn rig(agent: Option<&str>) -> (Fixture, PathBuf, tempfile::TempDir) {
    let stock = PathBuf::from(
        std::env::var("LAZYSH_TEST_HERDR_STOCK").expect("absolute unchanged stock Herdr binary"),
    );
    let bin = tempfile::tempdir().unwrap();
    let companion = bin.path().join("lazysh-agent");
    match agent {
        Some(script) => {
            fs::write(&companion, script).unwrap();
            fs::set_permissions(&companion, fs::Permissions::from_mode(0o700)).unwrap();
        }
        None => std::os::unix::fs::symlink(
            std::env::var_os("LAZYSH_TEST_AGENT_BIN").expect(
                "build lazysh-agent from this checkout and pass it as LAZYSH_TEST_AGENT_BIN",
            ),
            &companion,
        )
        .unwrap(),
    }
    let fixture = Fixture::with_environment(
        Some(&stock),
        false,
        false,
        vec![("PATH", bin.path().display().to_string())],
    )
    .await;
    (fixture, stock, bin)
}

/// One workspace whose only pane records every byte it is typed, in a file.
struct Receiver {
    pane: String,
    terminal: String,
    bytes: PathBuf,
}
impl Receiver {
    async fn new(servers: &HerdrServers<'_>, session: &str, label: &str) -> Self {
        let directory = servers.fixture.dir.path();
        let created = servers
            .json(
                session,
                &[
                    "workspace",
                    "create",
                    "--cwd",
                    directory.to_str().unwrap(),
                    "--label",
                    label,
                    "--no-focus",
                ],
            )
            .await;
        let root = &created["result"]["root_pane"];
        let receiver = Self {
            pane: root["pane_id"].as_str().unwrap().into(),
            terminal: root["terminal_id"].as_str().unwrap().into(),
            bytes: directory.join(format!("{session}-{label}.bytes")),
        };
        install_capture(
            servers,
            session,
            &receiver.pane,
            &receiver.bytes,
            &directory.join(format!("{session}-{label}.pid")),
            false,
        )
        .await;
        receiver
    }
    fn received(&self) -> Vec<u8> {
        fs::read(&self.bytes).unwrap_or_default()
    }
    /// Waits for exactly `expected`, then proves nothing more arrives.
    async fn expect(&self, expected: &[u8]) {
        captured(&self.bytes, expected).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(self.received(), expected, "{}", self.pane);
    }
    fn workspace(&self) -> &str {
        self.pane.split(':').next().unwrap()
    }
}

struct Bridge {
    app: tauri::App<tauri::test::MockRuntime>,
    state: AppState,
    authority: AccessState,
    lease: AccessLease,
    session: String,
}
impl Bridge {
    async fn new(fixture: &Fixture) -> Self {
        let (app, state) = herdr_native_app(fixture);
        let authority = unlocked_access();
        let lease = ready_lease(&authority);
        let session = fixture.neutral(&state, &lease).await.session_id;
        Self {
            app,
            state,
            authority,
            lease,
            session,
        }
    }
    /// One call of the app command; an error is `kind:message`.
    async fn call(&self, action: Value) -> Probe<Value> {
        crate::herdr_pane_input::herdr_pane_input(
            self.lease.clone(),
            self.session.clone(),
            serde_json::from_value(action).unwrap(),
            self.app.state(),
        )
        .await
        .map_err(|error| match error.into_inner() {
            Ok(error) => format!("{}:{}", error.kind(), error.message()),
            Err(_) => "app_locked".to_owned(),
        })
        .and_then(|reply| reply.into_inner().map_err(|_| "app_locked".to_owned()))
        .map(|reply| serde_json::to_value(reply).unwrap())
    }
    async fn prepare(&self, session: &str, target: &Receiver, source: &Value) -> Value {
        self.call(
            json!({"kind":"prepare","herdrSession":session,"pane":target.pane,"source":source}),
        )
        .await
        .unwrap()
    }
    /// Prepares and confirms `target`; returns the receipt.
    async fn confirm(&self, session: &str, target: &Receiver, source: &Value) -> String {
        let prepared = self.prepare(session, target, source).await;
        assert_eq!(prepared["occupant"]["paneId"], target.pane);
        assert_eq!(prepared["occupant"]["terminalId"], target.terminal);
        let bound = self
            .call(json!({"kind":"confirm","candidate":prepared["candidate"],"source":source}))
            .await
            .unwrap();
        assert_eq!(bound["kind"], "bound");
        assert_eq!(bound["occupant"], prepared["occupant"]);
        assert_eq!(bound["nextOperation"], 1);
        bound["receipt"].as_str().unwrap().into()
    }
    async fn input(
        &self,
        receipt: &str,
        source: &Value,
        operation: u32,
        input: Value,
    ) -> Probe<Value> {
        self.call(json!({"kind":"input","receipt":receipt,"source":source,"operation":operation,"input":input}))
            .await
    }
    /// An input that finds no confirmation to type under: refused as stale, with nothing written.
    async fn stale(&self, receipt: &str, source: &Value, operation: u32) {
        let error = self
            .input(receipt, source, operation, send("x"))
            .await
            .unwrap_err();
        assert!(error.starts_with("herdr_pane_input_stale:"), "{error}");
    }
    async fn finish(self, fixture: &mut Fixture) {
        // Locking the app (one case does) already ended the session.
        if let Ok(parent) = self.state.session(&self.session).await {
            disconnect_inner(&self.state, self.session.clone())
                .await
                .unwrap();
            herdr_retired(&self.state, &self.session, &parent, true).await;
        }
        fixture
            .handle()
            .disconnect(
                russh::Disconnect::ByApplication,
                "owned pane input fixture complete",
                "en",
            )
            .await
            .unwrap();
        fixture.stop_listener().await;
    }
}
fn source(name: &str) -> Value {
    json!({"agent":"claude","path":format!("/owned/{name}.jsonl"),"view":"records","inlineImages":false})
}
fn send(text: &str) -> Value {
    json!({"kind":"send","text":text})
}
/// How many processes of this fixture's host (by its private HOME) run the companion's pane input command.
fn actors(fixture: &Fixture) -> usize {
    let home = format!("HOME={}", fixture.dir.path().display());
    fs::read_dir("/proc")
        .unwrap()
        .flatten()
        .filter(|entry| {
            let read = |name: &str| fs::read(entry.path().join(name)).unwrap_or_default();
            read("cmdline")
                .windows(b"herdr-pane-input".len())
                .any(|window| window == b"herdr-pane-input")
                && read("environ")
                    .split(|byte| *byte == 0)
                    .any(|variable| variable == home.as_bytes())
        })
        .count()
}
async fn no_actors(fixture: &Fixture) {
    timeout(Duration::from_secs(10), async {
        while actors(fixture) > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the companion's pane input actor ended");
}
async fn focused_workspaces(servers: &HerdrServers<'_>, session: &str) -> Vec<String> {
    let snapshot = servers.json(session, &["api", "snapshot"]).await;
    let workspaces = snapshot["result"]["snapshot"]["workspaces"].as_array();
    workspaces
        .unwrap()
        .iter()
        .filter(|row| row["focused"] == true)
        .map(|row| row["workspace_id"].as_str().unwrap().to_owned())
        .collect()
}
async fn socket(servers: &HerdrServers<'_>, session: &str) -> PathBuf {
    let listing = servers.json(session, &["session", "list", "--json"]).await;
    let found = listing["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == session)
        .unwrap();
    PathBuf::from(found["socket_path"].as_str().unwrap())
}
fn servers<'a>(fixture: &'a Fixture, stock: &'a std::path::Path) -> HerdrServers<'a> {
    HerdrServers {
        fixture,
        binary: stock,
        processes: Vec::new(),
    }
}
fn kill(servers: &mut HerdrServers<'_>, name: &str) {
    for (_, process) in servers
        .processes
        .iter_mut()
        .filter(|(owner, _)| *owner == name)
    {
        let _ = process.0.kill();
        let _ = process.0.wait();
    }
}

#[tokio::test]
#[ignore = "requires owned OpenSSH, LAZYSH_TEST_AGENT_BIN and an unchanged stock Herdr in LAZYSH_TEST_HERDR_STOCK"]
async fn real_stock_herdr_pane_input_reaches_only_the_selected_pane_and_never_replays() {
    let (mut fixture, stock, _bin) = rig(None).await;
    let mut servers = servers(&fixture, &stock);
    servers.start("main").await;
    let target = Receiver::new(&servers, "main", "target").await;
    let bystander = Receiver::new(&servers, "main", "bystander").await;
    // The user's own display is on the other workspace; typing into the target must not move it or reach it.
    assert!(servers
        .output("main", &["workspace", "focus", bystander.workspace()])
        .await
        .status
        .success());
    let focus = focused_workspaces(&servers, "main").await;
    assert_eq!(focus, [bystander.workspace()]);
    let bridge = Bridge::new(&fixture).await;
    let a = source("a");

    let receipt = bridge.confirm("main", &target, &a).await;
    assert_eq!(
        bridge
            .input(&receipt, &a, 1, send("héllo\nwörld"))
            .await
            .unwrap(),
        json!({"kind":"delivered","nextOperation":2})
    );
    assert_eq!(
        bridge
            .input(&receipt, &a, 2, json!({"kind":"request_stop"}))
            .await
            .unwrap(),
        json!({"kind":"delivered","nextOperation":3})
    );
    target.expect("héllo\nwörld\r\x1b".as_bytes()).await;
    // A repeated operation retires the confirmation and writes nothing; so does any later use of the receipt.
    bridge.stale(&receipt, &a, 2).await;
    bridge.stale(&receipt, &a, 3).await;
    no_actors(&fixture).await;
    target.expect("héllo\nwörld\r\x1b".as_bytes()).await;
    assert!(bystander.received().is_empty());
    assert_eq!(focused_workspaces(&servers, "main").await, focus);

    // Source A, then B, then A again, each confirmed anew: an earlier receipt never types, even for the same source.
    let (b, a_again) = (source("b"), source("a"));
    let first = bridge.confirm("main", &target, &a).await;
    let second = bridge.confirm("main", &target, &b).await;
    let third = bridge.confirm("main", &target, &a_again).await;
    for (receipt, source) in [(&first, &a), (&second, &b)] {
        bridge.stale(receipt, source, 1).await;
    }
    assert_eq!(
        bridge
            .input(&third, &a_again, 1, send("third"))
            .await
            .unwrap(),
        json!({"kind":"delivered","nextOperation":2})
    );
    // The confirmation belongs to its source: another source retires it.
    bridge.stale(&third, &b, 2).await;
    no_actors(&fixture).await;
    let typed = "héllo\nwörld\r\x1bthird\r";
    target.expect(typed.as_bytes()).await;

    // The destination confirmed under an access lease that ended types nothing and ends its actor.
    let last = bridge.confirm("main", &target, &a).await;
    assert!(actors(&fixture) > 0);
    bridge.authority.lock().unwrap();
    assert_eq!(
        bridge
            .input(&last, &a, 1, send("locked"))
            .await
            .unwrap_err(),
        "app_locked"
    );
    no_actors(&fixture).await;
    target.expect(typed.as_bytes()).await;
    assert!(bystander.received().is_empty());
    servers.stop().await;
    drop(servers);
    bridge.finish(&mut fixture).await;
}

#[tokio::test]
#[ignore = "requires owned OpenSSH, LAZYSH_TEST_AGENT_BIN and an unchanged stock Herdr in LAZYSH_TEST_HERDR_STOCK"]
async fn real_stock_herdr_socket_replacement_and_restart_retire_the_confirmation_before_any_input()
{
    let (mut fixture, stock, _bin) = rig(None).await;
    let mut servers = servers(&fixture, &stock);
    servers.start("main").await;
    servers.start("impostor").await;
    let confirmed = Receiver::new(&servers, "main", "confirmed").await;
    let intruder = Receiver::new(&servers, "impostor", "intruder").await;
    // The other server's pane carries the very ids of the confirmed one: only the server process tells them apart.
    assert_eq!(intruder.pane, confirmed.pane);
    let bridge = Bridge::new(&fixture).await;
    let a = source("a");
    let receipt = bridge.confirm("main", &confirmed, &a).await;
    // Between the confirmation and the dispatch the pathname reaches another live server that answers pings.
    fs::rename(
        socket(&servers, "impostor").await,
        socket(&servers, "main").await,
    )
    .unwrap();
    let error = bridge
        .input(&receipt, &a, 1, send("secret"))
        .await
        .unwrap_err();
    assert_eq!(error, "herdr_pane_input_retired:server_replaced");
    bridge.stale(&receipt, &a, 1).await;
    no_actors(&fixture).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(confirmed.received().is_empty() && intruder.received().is_empty());
    kill(&mut servers, "main");
    kill(&mut servers, "impostor");

    // A restarted server: the retained subscription and process handle notice, and the new server gets nothing.
    servers.start("restarted").await;
    let first = Receiver::new(&servers, "restarted", "first").await;
    let receipt = bridge.confirm("restarted", &first, &a).await;
    assert_eq!(
        bridge.input(&receipt, &a, 1, send("before")).await.unwrap(),
        json!({"kind":"delivered","nextOperation":2})
    );
    first.expect(b"before\r").await;
    kill(&mut servers, "restarted");
    servers.start("restarted").await;
    let second = Receiver::new(&servers, "restarted", "second").await;
    assert_eq!(second.pane, first.pane);
    let error = bridge
        .input(&receipt, &a, 2, send("after"))
        .await
        .unwrap_err();
    assert!(error.starts_with("herdr_pane_input_retired:"), "{error}");
    no_actors(&fixture).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(second.received().is_empty());
    drop(servers);
    bridge.finish(&mut fixture).await;
}

#[tokio::test]
#[ignore = "requires owned OpenSSH, LAZYSH_TEST_AGENT_BIN and an unchanged stock Herdr in LAZYSH_TEST_HERDR_STOCK"]
async fn a_host_whose_companion_lacks_the_command_reports_one_unsupported_state() {
    // An older companion answers an unknown subcommand with exit status 2.
    let (mut fixture, stock, _bin) = rig(Some("#!/bin/sh\nexit 2\n")).await;
    let mut servers = servers(&fixture, &stock);
    servers.start("main").await;
    let target = Receiver::new(&servers, "main", "target").await;
    let bridge = Bridge::new(&fixture).await;
    let error = bridge
        .call(
            json!({"kind":"prepare","herdrSession":"main","pane":target.pane,"source":source("a")}),
        )
        .await
        .unwrap_err();
    assert_eq!(error, "herdr_pane_input_unsupported:companion_required");
    bridge
        .stale(&uuid::Uuid::new_v4().to_string(), &source("a"), 1)
        .await;
    no_actors(&fixture).await;
    assert!(target.received().is_empty());
    servers.stop().await;
    drop(servers);
    bridge.finish(&mut fixture).await;
}
