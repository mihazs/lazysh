//! A client on this machine against a Linux host it did not start (#1747). On windows-latest the
//! host is an OpenSSH server inside WSL (`.github/scripts/external-linux-host.sh`), so a Windows
//! client drives real tmux, Zellij and Herdr. The cases need no POSIX client, so they also run on
//! Linux against the same script.
use super::*;
use crate::herdr::{herdr_action, herdr_tree};
use crate::multiplexer::{multiplexer_sessions, multiplexer_tree, tmux_action, MultiplexerKind};
use crate::ssh::test_support::{json_events, ready_lease, unlocked_access};
use crate::zellij::{zellij_action, zellij_tabs};
use serde_json::{json, Value};
use tauri::Manager;

/// WSL starts processes slowly, and a cold Zellij or Herdr server is the slowest.
const BOUND: Duration = Duration::from_secs(60);

/// Unwraps a product call, naming the host's error instead of the lease's opaque one.
fn done<T>(result: AccessResult<T>) -> T {
    match result {
        Ok(value) => value.into_inner().expect("app access changed"),
        Err(error) => match error.into_inner() {
            Ok(error) => panic!("{}: {}", error.kind(), error.message()),
            Err(_) => panic!("app access changed"),
        },
    }
}

fn setting(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must describe the external host"))
}

struct ExternalHost {
    _authority: AccessState,
    lease: AccessLease,
    app: tauri::App<tauri::test::MockRuntime>,
    state: AppState,
    source: Connected,
    _directory: tempfile::TempDir,
}
struct Attached {
    id: String,
    events: mpsc::UnboundedReceiver<Value>,
    seen: Vec<u8>,
}

impl ExternalHost {
    async fn connect() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().join("config")).unwrap();
        let host = Host {
            default_multiplexer: None,
            default_multiplexer_next: None,
            transport: None,
            mosh: None,
            et: None,
            id: "external-linux-host".into(),
            name: "External Linux host".into(),
            hostname: std::env::var("LAZYSH_TEST_EXTERNAL_SSH_HOST")
                .unwrap_or_else(|_| "127.0.0.1".into()),
            port: setting("LAZYSH_TEST_EXTERNAL_SSH_PORT").parse().unwrap(),
            username: setting("LAZYSH_TEST_EXTERNAL_SSH_USER"),
            fingerprint: Some(setting("LAZYSH_TEST_EXTERNAL_SSH_FINGERPRINT")),
            jump_host_id: None,
            credentials_stored: false,
            client_environment: false,
            biometric_unlock: false,
            forward_agent: false,
        };
        let key = fs::read_to_string(setting("LAZYSH_TEST_EXTERNAL_SSH_KEY")).unwrap();
        let handle = Arc::new(
            authenticate(&state, &host, None, Some(key), None)
                .await
                .unwrap_or_else(|error| {
                    panic!("external host refused the login: {}", error.message())
                }),
        );
        state.config().unwrap().hosts.push(host);
        let authority = unlocked_access();
        let lease = ready_lease(&authority);
        let app = tauri::test::mock_app();
        app.manage(state.clone());
        app.manage(crate::local::LocalState::default());
        let (channel, initial) =
            open_terminal_for(&handle, &lease, 80, 24, Some("exec cat".into()))
                .await
                .unwrap();
        let source = spawn_terminal(
            &state,
            lease.clone(),
            handle,
            channel,
            initial,
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        Self {
            _authority: authority,
            lease,
            app,
            state,
            source,
            _directory: directory,
        }
    }
    fn id(&self) -> String {
        self.source.session_id.clone()
    }
    /// Runs one command on the host over the product's bounded exec and returns its trimmed stdout.
    async fn exec(&self, command: &str) -> String {
        let session = self.state.session(&self.id()).await.unwrap();
        crate::ssh::exec_for_access(&session, command.into(), &self.lease)
            .await
            .unwrap_or_else(|error| panic!("host command `{command}`: {}", error.message()))
            .trim()
            .to_owned()
    }
    async fn tree(&self) -> Value {
        let tree = done(
            multiplexer_tree(
                self.app.state(),
                self.app.state(),
                self.id(),
                None,
                None,
                self.lease.clone(),
            )
            .await,
        );
        serde_json::to_value(tree).unwrap()
    }
    async fn tmux(&self, action: Value) {
        let action = serde_json::from_value(action).unwrap();
        done(
            tmux_action(
                self.app.state(),
                self.app.state(),
                self.id(),
                action,
                None,
                None,
                self.lease.clone(),
            )
            .await,
        );
    }
    async fn tmux_session(&self, name: &str) -> Value {
        self.tree().await["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["name"] == name)
            .unwrap_or_else(|| panic!("tmux session {name:?} is not in the tree"))
            .clone()
    }
    /// Names of the sessions the product lists for a Zellij or Herdr host.
    async fn session_names(&self, kind: MultiplexerKind) -> Vec<Value> {
        let rows = done(
            multiplexer_sessions(
                self.app.state(),
                self.app.state(),
                self.id(),
                kind,
                self.lease.clone(),
            )
            .await,
        );
        let rows = serde_json::to_value(rows).unwrap();
        rows.as_array()
            .unwrap()
            .iter()
            .map(|row| row["name"].clone())
            .collect()
    }
    async fn zellij_tabs(&self, name: &str) -> Vec<Value> {
        let tabs = done(
            zellij_tabs(
                self.app.state(),
                self.app.state(),
                self.id(),
                name.into(),
                self.lease.clone(),
            )
            .await,
        );
        serde_json::to_value(tabs)
            .unwrap()
            .as_array()
            .unwrap()
            .clone()
    }
    async fn zellij(&self, name: &str, action: Value) {
        let action = serde_json::from_value(action).unwrap();
        done(
            zellij_action(
                self.app.state(),
                self.app.state(),
                self.id(),
                name.into(),
                action,
                self.lease.clone(),
            )
            .await,
        );
    }
    async fn herdr_tree(&self, name: &str) -> crate::herdr::HerdrTree {
        done(
            herdr_tree(
                self.app.state(),
                self.app.state(),
                self.id(),
                name.into(),
                self.lease.clone(),
            )
            .await,
        )
    }
    async fn herdr(&self, name: &str, action: Value) {
        let action = serde_json::from_value(action).unwrap();
        done(
            herdr_action(
                self.app.state(),
                self.app.state(),
                self.id(),
                name.into(),
                action,
                self.lease.clone(),
            )
            .await,
        );
    }
    async fn attach(&self, kind: MultiplexerKind, name: &str, create: bool) -> Attached {
        let (events, receiver) = json_events();
        let child = done(
            attach_multiplexer(
                self.lease.clone(),
                self.app.state(),
                self.id(),
                None,
                kind,
                name.into(),
                80,
                24,
                events,
                Some(create),
                None,
            )
            .await,
        );
        Attached {
            id: child.session_id,
            events: receiver,
            seen: Vec::new(),
        }
    }
    /// Reads the attached terminal until `marker` shows, acknowledging each chunk like the renderer does.
    async fn show(&self, attached: &mut Attached, marker: &str) {
        timeout(BOUND, async {
            while !String::from_utf8_lossy(&attached.seen).contains(marker) {
                let event = attached.events.recv().await.expect("event channel closed");
                assert_ne!(event["type"], "closed", "terminal closed before {marker:?}");
                if let Some(data) = event["data"].as_array() {
                    attached
                        .seen
                        .extend(data.iter().map(|byte| byte.as_u64().unwrap() as u8));
                    let session = self.state.session(&attached.id).await.unwrap();
                    acknowledge(&session, data.len() as u32).unwrap();
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "{marker:?} never appeared; last output: {:?}",
                String::from_utf8_lossy(&attached.seen)
            )
        });
    }
    async fn type_line(&self, attached: &Attached, line: &str) {
        done(
            write_stdin(
                self.lease.clone(),
                self.app.state(),
                attached.id.clone(),
                format!("{line}\r"),
                None,
            )
            .await,
        );
    }
    async fn detach(&self, attached: Attached) {
        disconnect_inner(&self.state, attached.id).await.unwrap();
    }
    /// Polls a host command until its output equals `expected`.
    async fn settles_to(&self, command: &str, expected: &str) {
        let mut last = String::new();
        let reached = timeout(BOUND, async {
            loop {
                last = self.exec(command).await;
                if last == expected {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
        .await;
        assert!(
            reached.is_ok(),
            "`{command}` ended at {last:?}, not {expected:?}"
        );
    }
}

#[tokio::test]
#[ignore = "requires an external Linux host (LAZYSH_TEST_EXTERNAL_SSH_*) and LAZYSH_EXPECT_MUX_SUPPORT"]
async fn external_host_discovery_reports_each_multiplexer_version_and_support() {
    let host = ExternalHost::connect().await;
    let discovery = host.tree().await;
    // For example `tmux=full zellij=full herdr=full`; each named tool is installed on the host.
    for pair in setting("LAZYSH_EXPECT_MUX_SUPPORT").split_whitespace() {
        let (kind, support) = pair.split_once('=').unwrap();
        let line = host
            .exec(&format!(
                "{kind} {}",
                if kind == "tmux" { "-V" } else { "--version" }
            ))
            .await;
        let version = line.strip_prefix(kind).unwrap().trim();
        let tool = discovery["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["kind"] == kind)
            .unwrap_or_else(|| panic!("{kind} was not discovered: {}", discovery["tools"]));
        assert_eq!(tool["version"], version, "{kind} version");
        assert_eq!(tool["support"], support, "{kind} support");
        assert_eq!(
            discovery[format!("{kind}Available")],
            true,
            "{kind} available"
        );
    }
}

#[tokio::test]
#[ignore = "requires an external Linux host (LAZYSH_TEST_EXTERNAL_SSH_*) with tmux"]
async fn external_host_tmux_creates_splits_attaches_and_detaches_without_running_names() {
    let host = ExternalHost::connect().await;
    // A run that failed half way leaves its server behind on a host that outlives the test.
    host.exec("tmux -L default kill-server; true").await;
    let work = host.exec("mktemp -d").await;
    // A hostile name must stay one literal word on the host; a command run from it would create `nope`.
    let name = "ext tmux 'literal';$(touch nope)";
    host.tmux(json!({"type": "createSession", "name": name, "directory": work}))
        .await;
    let created = host.tmux_session(name).await;
    assert_eq!(
        host.exec(&format!("test ! -e '{work}/nope' && echo absent"))
            .await,
        "absent"
    );
    let pane = created["windows"][0]["panes"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    host.tmux(json!({"type": "splitPane", "target": pane, "horizontal": true, "directory": work}))
        .await;
    host.tmux(json!({"type": "zoomPane", "target": pane})).await;
    host.tmux(json!({"type": "createWindow", "target": created["id"], "name": "second", "directory": work})).await;
    host.tmux(
        json!({"type": "renameSession", "target": created["id"], "name": "ext tmux renamed"}),
    )
    .await;
    let renamed = host.tmux_session("ext tmux renamed").await;
    let windows = renamed["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0]["panes"].as_array().unwrap().len(), 2);
    assert_eq!(windows[1]["name"], "second");

    let mut shown = host
        .attach(MultiplexerKind::Tmux, "ext tmux renamed", false)
        .await;
    // The echoed command line holds the arithmetic; only the shell's answer holds `EXT_TMUX_42`.
    host.type_line(&shown, "echo EXT_TMUX_$((20+22))").await;
    host.show(&mut shown, "EXT_TMUX_42").await;
    // The display and the control client that follows it both attach to the session.
    let clients = "tmux -L default list-clients -F '#{client_session}' | sort -u";
    assert_eq!(host.exec(clients).await, "ext tmux renamed");
    host.detach(shown).await;
    host.settles_to(clients, "").await;
    assert_eq!(
        host.tmux_session("ext tmux renamed").await["windows"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    host.exec(&format!("tmux -L default kill-server; rm -rf '{work}'"))
        .await;
}

#[tokio::test]
#[ignore = "requires an external Linux host (LAZYSH_TEST_EXTERNAL_SSH_*) with Zellij"]
async fn external_host_zellij_creates_attaches_and_manages_tabs() {
    let host = ExternalHost::connect().await;
    let name = "ext-zellij";
    host.exec(&format!(
        "zellij kill-session {name}; zellij delete-session {name}; true"
    ))
    .await;
    let mut shown = host.attach(MultiplexerKind::Zellij, name, true).await;
    host.show(&mut shown, "ZELLIJ-PANE-READY").await;
    host.type_line(&shown, "echo EXT_ZELLIJ_$((20+22))").await;
    host.show(&mut shown, "EXT_ZELLIJ_42").await;
    assert!(host
        .session_names(MultiplexerKind::Zellij)
        .await
        .contains(&json!(name)));
    assert_eq!(host.zellij_tabs(name).await.len(), 1);
    host.zellij(
        name,
        json!({"type": "newTab", "name": "second tab", "directory": "/tmp"}),
    )
    .await;
    let both = host.zellij_tabs(name).await;
    assert_eq!(both.len(), 2);
    let second = both.iter().find(|tab| tab["name"] == "second tab").unwrap()["id"].clone();
    host.zellij(
        name,
        json!({"type": "renameTab", "id": second, "name": "renamed tab"}),
    )
    .await;
    assert!(host
        .zellij_tabs(name)
        .await
        .iter()
        .any(|tab| tab["name"] == "renamed tab"));
    host.zellij(name, json!({"type": "closeTab", "id": second}))
        .await;
    assert_eq!(host.zellij_tabs(name).await.len(), 1);
    host.detach(shown).await;
    host.exec(&format!(
        "zellij kill-session {name}; zellij delete-session {name}; true"
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires an external Linux host (LAZYSH_TEST_EXTERNAL_SSH_*) with the Herdr server ext-default"]
async fn external_host_herdr_lists_attaches_and_reads_the_workspace_tree() {
    let host = ExternalHost::connect().await;
    let name = "ext-default";
    assert!(host
        .session_names(MultiplexerKind::Herdr)
        .await
        .contains(&json!(name)));
    let mut shown = host.attach(MultiplexerKind::Herdr, name, true).await;
    host.show(&mut shown, "EXT_DEFAULT").await;
    host.detach(shown).await;
    let before = host.herdr_tree(name).await;
    assert!(before
        .workspaces
        .iter()
        .any(|workspace| workspace.label == "EXT_DEFAULT"));
    host.herdr(
        name,
        json!({"type": "createWorkspace", "label": "EXT_SECOND", "directory": "/tmp"}),
    )
    .await;
    let created = host.herdr_tree(name).await;
    assert_eq!(created.workspaces.len(), before.workspaces.len() + 1);
    let target = &created
        .workspaces
        .iter()
        .find(|workspace| workspace.label == "EXT_SECOND")
        .unwrap()
        .workspace_id;
    host.herdr(
        name,
        json!({"type": "renameWorkspace", "target": target, "label": "EXT_RENAMED"}),
    )
    .await;
    assert!(host
        .herdr_tree(name)
        .await
        .workspaces
        .iter()
        .any(|workspace| workspace.label == "EXT_RENAMED"));
}
