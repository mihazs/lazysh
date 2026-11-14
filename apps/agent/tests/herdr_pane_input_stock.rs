//! The pinned pane input actor against an unchanged stock Herdr binary (`LAZYSH_TEST_HERDR_STOCK`), through owned
//! headless servers with private HOME/XDG directories and PTY receivers that record the exact bytes they get. No
//! operator server, profile or socket is touched.
#![cfg(target_os = "linux")]
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command as Std, Stdio},
    time::{Duration, Instant},
};
use tokio::process::Command;
#[path = "support/binary.rs"]
mod binary;
#[path = "support/pane_input_actor.rs"]
mod pane_input_actor;
use pane_input_actor::Actor;

/// Puts a PTY into raw mode, optionally enables one input mode, announces itself and records every byte it gets.
const RECEIVER: &str = r#"#!/bin/sh
stty raw -echo
case "$LAZYSH_MODE" in
  bracketed) printf '\033[?2004h' ;;
  kitty) printf '\033[>1u' ;;
esac
printf 'READY'
exec cat > "$LAZYSH_RECV_DIR/$LAZYSH_NAME.bin"
"#;

struct Server {
    home: tempfile::TempDir,
    stock: PathBuf,
    child: Option<Child>,
}
struct Receiver {
    pane: String,
    terminal: String,
    file: PathBuf,
}
impl Server {
    fn new() -> Self {
        let stock = PathBuf::from(
            std::env::var_os("LAZYSH_TEST_HERDR_STOCK")
                .expect("LAZYSH_TEST_HERDR_STOCK must name an unchanged stock Herdr"),
        );
        assert!(stock.is_absolute());
        let home = tempfile::tempdir().unwrap();
        let root = home.path();
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("recv")).unwrap();
        symlink(&stock, root.join("bin/herdr")).unwrap();
        fs::write(
            root.join("config.toml"),
            "[update]\nversion_check = false\nmanifest_check = false\n",
        )
        .unwrap();
        fs::write(root.join("receiver.sh"), RECEIVER).unwrap();
        fs::set_permissions(root.join("receiver.sh"), fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            home,
            stock,
            child: None,
        }
    }
    fn root(&self) -> &Path {
        self.home.path()
    }
    fn socket(&self) -> PathBuf {
        let sessions = self.herdr(&["session", "list", "--json"]);
        PathBuf::from(sessions["sessions"][0]["socket_path"].as_str().unwrap())
    }
    /// Environment of every process here: nothing inherited from the operator's Herdr, tmux or shell.
    fn environment(&self) -> Vec<(&'static str, String)> {
        let root = self.root();
        let text = |path: PathBuf| path.to_str().unwrap().to_owned();
        vec![
            ("HOME", text(root.into())),
            ("XDG_CONFIG_HOME", text(root.into())),
            ("HERDR_CONFIG_PATH", text(root.join("config.toml"))),
            ("SHELL", text(root.join("receiver.sh"))),
            ("LAZYSH_RECV_DIR", text(root.join("recv"))),
            (
                "PATH",
                format!(
                    "{}:{}",
                    root.join("bin").display(),
                    std::env::var("PATH").unwrap()
                ),
            ),
        ]
    }
    fn herdr_command(&self) -> Std {
        let mut command = Std::new(&self.stock);
        command.env_clear().envs(self.environment());
        command
    }
    fn start(&mut self) {
        self.child = Some(
            self.herdr_command()
                .arg("server")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.run(&["api", "snapshot"]).is_none() {
            assert!(Instant::now() < deadline, "the owned server did not start");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    /// The server process ends; its socket file stays behind, as after a crash.
    fn kill(&mut self) {
        let mut child = self.child.take().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }
    fn run(&self, args: &[&str]) -> Option<String> {
        let output = self.herdr_command().args(args).output().unwrap();
        output
            .status
            .success()
            .then(|| String::from_utf8(output.stdout).unwrap())
    }
    fn herdr(&self, args: &[&str]) -> Value {
        let output = self.run(args).unwrap_or_else(|| panic!("herdr {args:?}"));
        serde_json::from_str(&output).unwrap_or_else(|_| panic!("herdr {args:?}: {output}"))
    }
    /// One workspace whose only pane runs the receiver in `mode`; the pane is not focused.
    fn receiver(&self, name: &str, mode: &str) -> Receiver {
        let created = self.herdr(&[
            "workspace",
            "create",
            "--cwd",
            self.root().to_str().unwrap(),
            "--label",
            name,
            "--env",
            &format!("LAZYSH_NAME={name}"),
            "--env",
            &format!("LAZYSH_MODE={mode}"),
            "--no-focus",
        ]);
        let pane = created["result"]["root_pane"]["pane_id"].as_str().unwrap();
        let receiver = Receiver {
            pane: pane.into(),
            terminal: created["result"]["root_pane"]["terminal_id"]
                .as_str()
                .unwrap()
                .into(),
            file: self.root().join("recv").join(format!("{name}.bin")),
        };
        // The receiver prints READY after enabling its mode, so Herdr has parsed the mode by then.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let screen = self.run(&["pane", "read", pane, "--source", "visible"]);
            if screen.is_some_and(|screen| screen.contains("READY")) && receiver.file.exists() {
                return receiver;
            }
            assert!(Instant::now() < deadline, "receiver {name} did not start");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn actor(&self) -> Actor {
        let mut command = Command::new(binary::path());
        command.env_clear().envs(self.environment());
        Actor::spawn(command, "default")
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Receiver {
    fn bytes(&self) -> Vec<u8> {
        fs::read(&self.file).unwrap_or_default()
    }
    /// Waits until the receiver holds `expected`, then proves nothing more arrives.
    fn expect(&self, expected: &[u8]) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.bytes().len() < expected.len() {
            assert!(
                Instant::now() < deadline,
                "{} got {:?}",
                self.pane,
                self.bytes()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(self.bytes(), expected, "{}", self.pane);
    }
    fn send(&self, id: u64, text: &str) -> Value {
        json!({"op":"send","id":id,"pane":self.pane,"terminal":self.terminal,"text":text})
    }
    fn escape(&self, id: u64) -> Value {
        json!({"op":"escape","id":id,"pane":self.pane,"terminal":self.terminal})
    }
}
async fn ready(server: &Server) -> Actor {
    let mut actor = server.actor();
    assert_eq!(actor.line().await.unwrap()["event"], "ready");
    actor
}
fn delivered(id: u64) -> Value {
    json!({"id":id,"outcome":"delivered"})
}

#[tokio::test]
#[ignore = "requires an unchanged stock Herdr in LAZYSH_TEST_HERDR_STOCK; runs owned headless servers"]
async fn the_selected_receiver_gets_the_exact_bytes_of_each_input_mode_and_the_others_stay_empty() {
    let mut server = Server::new();
    server.start();
    let legacy = server.receiver("legacy", "legacy");
    let bracketed = server.receiver("bracketed", "bracketed");
    let kitty = server.receiver("kitty", "kitty");
    let bystander = server.receiver("bystander", "legacy");
    let mut actor = ready(&server).await;

    // Sparse input: one character, then a multi-line UTF-8 message.
    assert_eq!(actor.ask(legacy.send(1, "x")).await, delivered(1));
    assert_eq!(
        actor.ask(legacy.send(2, "héllo\nwörld")).await,
        delivered(2)
    );
    assert_eq!(actor.ask(legacy.escape(3)).await, delivered(3));
    legacy.expect("x\rhéllo\nwörld\r\x1b".as_bytes());
    // The whole 4,096-byte UTF-8 draft arrives intact, bracketed when the program asked for paste brackets.
    let dense = "é".repeat(2048);
    assert_eq!(actor.ask(bracketed.send(4, &dense)).await, delivered(4));
    bracketed.expect(format!("\x1b[200~{dense}\x1b[201~\r").as_bytes());
    // Kitty disambiguation keeps Enter as a carriage return and sends Escape as CSI 27 u.
    assert_eq!(actor.ask(kitty.send(5, "go")).await, delivered(5));
    assert_eq!(actor.ask(kitty.escape(6)).await, delivered(6));
    kitty.expect(b"go\r\x1b[27u");
    // Nothing reached the receiver nobody selected.
    assert!(bystander.bytes().is_empty());
    assert!(actor.exit_success().await);
}

#[tokio::test]
#[ignore = "requires an unchanged stock Herdr in LAZYSH_TEST_HERDR_STOCK; runs owned headless servers"]
async fn a_focused_other_pane_neither_receives_nor_redirects_the_input() {
    let mut server = Server::new();
    server.start();
    let target = server.receiver("target", "legacy");
    let focused = server.receiver("focused", "legacy");
    let workspace = |pane: &str| pane.split(':').next().unwrap().to_owned();
    server
        .run(&["workspace", "focus", &workspace(&focused.pane)])
        .unwrap();
    let mut actor = ready(&server).await;
    assert_eq!(actor.ask(target.send(1, "named")).await, delivered(1));
    target.expect(b"named\r");
    assert!(focused.bytes().is_empty());
    // Sending never moved a client: the other workspace is still the focused one.
    let snapshot = server.herdr(&["api", "snapshot"]);
    let focused_workspaces: Vec<_> = snapshot["result"]["snapshot"]["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|workspace| workspace["focused"] == true)
        .map(|workspace| workspace["workspace_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(focused_workspaces, [workspace(&focused.pane)]);
}

#[tokio::test]
#[ignore = "requires an unchanged stock Herdr in LAZYSH_TEST_HERDR_STOCK; runs owned headless servers"]
async fn a_pane_closed_between_confirmation_and_send_is_refused_with_nothing_written() {
    let mut server = Server::new();
    server.start();
    let doomed = server.receiver("doomed", "legacy");
    let other = server.receiver("other", "legacy");
    let mut actor = ready(&server).await;
    assert_eq!(
        actor
            .ask(json!({"op":"preflight","id":1,"pane":doomed.pane}))
            .await["outcome"],
        "occupant"
    );
    server.run(&["pane", "close", &doomed.pane]).unwrap();
    let answer = actor.ask(doomed.send(2, "late")).await;
    assert_eq!(answer["reason"], "pane_not_found", "{answer}");
    assert!(other.bytes().is_empty());
}

#[tokio::test]
#[ignore = "requires an unchanged stock Herdr in LAZYSH_TEST_HERDR_STOCK; runs owned headless servers"]
async fn a_socket_path_taken_over_by_another_server_is_retired_before_any_request_byte() {
    let mut original = Server::new();
    original.start();
    let confirmed = original.receiver("confirmed", "legacy");
    let mut impostor = Server::new();
    impostor.start();
    let intruder = impostor.receiver("intruder", "legacy");
    // The impostor's pane has the very ids of the confirmed one: only the server process tells them apart.
    assert_eq!(intruder.pane, confirmed.pane);
    let mut actor = ready(&original).await;
    assert_eq!(
        actor
            .ask(json!({"op":"preflight","id":1,"pane":confirmed.pane}))
            .await["outcome"],
        "occupant"
    );
    // Between preflight and dispatch the pathname now reaches the other server, which is alive and answers pings.
    fs::rename(impostor.socket(), original.socket()).unwrap();
    let answer = actor.ask(confirmed.send(2, "secret")).await;
    assert_eq!(
        answer,
        json!({"id":2,"outcome":"retired","reason":"server_replaced"})
    );
    assert!(actor.ended_with_failure().await);
    assert!(intruder.bytes().is_empty());
    assert!(confirmed.bytes().is_empty());
}

#[tokio::test]
#[ignore = "requires an unchanged stock Herdr in LAZYSH_TEST_HERDR_STOCK; runs owned headless servers"]
async fn a_restarted_server_retires_the_epoch_and_the_new_server_receives_nothing() {
    let mut server = Server::new();
    server.start();
    let first = server.receiver("first", "legacy");
    let mut actor = ready(&server).await;
    assert_eq!(actor.ask(first.send(1, "before")).await, delivered(1));
    first.expect(b"before\r");
    server.kill();
    server.start();
    let second = server.receiver("second", "legacy");
    assert_eq!(second.pane, first.pane);
    // The retained subscription and pidfd notice the end of the original server without a request.
    let event = actor.line().await.unwrap();
    assert_eq!(event["event"], "retired", "{event}");
    assert!(
        ["server_exited", "subscription_closed"].contains(&event["reason"].as_str().unwrap()),
        "{event}"
    );
    assert!(actor.ended_with_failure().await);
    assert!(second.bytes().is_empty());
}
