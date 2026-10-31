//! Actual native SSH/display adapter acceptance; only owned servers and PTYs.
use super::super::test_support::{ready_lease, unlocked_access};
use super::*;
use serde_json::{json, Value};

#[derive(Default)]
struct OwnedDisplays(Vec<Arc<Session>>);
impl OwnedDisplays {
    async fn keep(&mut self, state: &AppState, connected: &Connected) {
        self.0
            .push(state.session(&connected.session_id).await.unwrap());
    }
}
impl Drop for OwnedDisplays {
    fn drop(&mut self) {
        for session in &self.0 {
            session.renderer_gone.send_replace(true);
            session.cancel.send_replace(true);
            session.output_credits.close();
        }
    }
}

async fn guard(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    session: &Connected,
    action: Value,
) -> Probe<Value> {
    let result = crate::herdr_guard::herdr_chat(
        lease.clone(),
        app.state(),
        session.session_id.clone(),
        serde_json::from_value(action).unwrap(),
    )
    .await
    .map_err(|error| match error.into_inner() {
        Ok(error) => error.kind().to_owned(),
        Err(_) => "app_locked".to_owned(),
    })?;
    serde_json::to_value(result.into_inner().map_err(|_| "app_locked".to_string())?)
        .map_err(|_| "serialization".into())
}
fn context(selector: &str) -> Value {
    json!({"agent":"hermes","path":"/owned/{literal}<transcript>","view":"records","inlineImages":false,"transcriptSessionId":selector})
}
async fn confirm(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    session: &Connected,
    source: &Value,
) -> Value {
    let prepared = guard(
        app,
        lease,
        session,
        json!({"kind":"prepare","source":source}),
    )
    .await
    .unwrap();
    let bound = guard(
        app,
        lease,
        session,
        json!({"kind":"confirm","candidate":prepared["candidate"],"source":source}),
    )
    .await
    .unwrap();
    assert_eq!(bound["destination"], prepared["destination"]);
    assert_eq!(bound["nextOperation"], 1);
    bound
}
async fn adopt(
    app: &tauri::App<tauri::test::MockRuntime>,
    lease: &AccessLease,
    connected: &Connected,
) {
    adopt_session(
        lease.clone(),
        app.state(),
        app.state(),
        connected.session_id.clone(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
}
async fn adopted_source(
    fixture: &Fixture,
    app: &tauri::App<tauri::test::MockRuntime>,
    state: &AppState,
    displays: &mut OwnedDisplays,
) -> (
    crate::app_lock::AccessState,
    AccessLease,
    Connected,
    mpsc::UnboundedReceiver<Value>,
) {
    let authority = unlocked_access();
    let lease = ready_lease(&authority);
    let (source, events) = herdr_echo_source(fixture, state, &lease).await;
    displays.keep(state, &source).await;
    adopt(app, &lease, &source).await;
    (authority, lease, source, events)
}
async fn captured(path: &std::path::Path, expected: &[u8]) {
    timeout(BOUND, async {
        loop {
            if let Ok(bytes) = tokio::fs::read(path).await {
                assert!(
                    bytes.len() <= expected.len(),
                    "extra or repeated input reached owned PTY"
                );
                if bytes == expected {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned guarded input did not arrive exactly");
}

async fn install_capture(
    servers: &HerdrServers<'_>,
    name: &str,
    pane: &str,
    bytes: &std::path::Path,
    pid: &std::path::Path,
) -> u64 {
    let script = format!(
        "stty raw -echo; echo $$ > {}; exec cat > {}",
        quote(pid.to_str().unwrap()),
        quote(bytes.to_str().unwrap())
    );
    let command = format!("sh -c {}", quote(&script));
    // pane run uses send_ok_request: success intentionally has no JSON body.
    assert!(servers
        .output(name, &["pane", "run", pane, &command])
        .await
        .status
        .success());
    timeout(BOUND, async {
        while herdr_counter(pid).await.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    herdr_counter(pid).await.unwrap()
}

#[tokio::test]
#[ignore = "requires owned OpenSSH and LAZYSH_TEST_HERDR built from current guarded source"]
async fn real_guarded_herdr_ssh_binding_keeps_original_connection_source_and_lease() {
    let binary = PathBuf::from(
        std::env::var("LAZYSH_TEST_HERDR").expect("absolute current-source guarded Herdr binary"),
    );
    let mut fixture = Fixture::with_herdr(Some(&binary)).await;
    let config = fixture
        .dir
        .path()
        .join("config-home")
        .join(if cfg!(debug_assertions) {
            "herdr-dev"
        } else {
            "herdr"
        });
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join("config.toml"), "onboarding = false\n[terminal]\ndefault_shell = '/bin/sh'\nshell_mode = 'non_login'\n[update]\nversion_check = false\nmanifest_check = false\n").unwrap();
    let mut servers = HerdrServers {
        fixture: &fixture,
        binary: &binary,
        processes: Vec::new(),
    };
    let directory = fixture.dir.path().to_str().unwrap();
    for (name, label) in [("guard-left", "GUARD_LEFT"), ("guard-right", "GUARD_RIGHT")] {
        servers.start(name).await;
        servers
            .json(
                name,
                &["workspace", "create", "--label", label, "--cwd", directory],
            )
            .await;
    }
    let (app, state) = herdr_native_app(&fixture);
    let mut displays = OwnedDisplays::default();
    let (authority, lease, source, mut source_events) =
        adopted_source(&fixture, &app, &state, &mut displays).await;
    let source_native = state.session(&source.session_id).await.unwrap();
    assert!(crate::herdr_guard::available(&source_native, "guard-left", &lease).await);
    assert_eq!(
        guard(&app, &lease, &source, json!({"kind":"status"}))
            .await
            .unwrap(),
        json!({"kind":"status","available":false})
    );
    let kind = crate::multiplexer::MultiplexerKind::Herdr;
    let (child, mut events) =
        multiplexer_child(&app, &lease, &source, "guard-left", kind, false).await;
    displays.keep(&state, &child).await;
    let output = owned_terminal_output(&app, &child.session_id, &mut events, b"GUARD_LEFT").await;
    assert!(!output
        .windows(b"LAZYSH-GUARD-1".len())
        .any(|part| part == b"LAZYSH-GUARD-1"));
    adopt(&app, &lease, &child).await;
    let child_native = state.session(&child.session_id).await.unwrap();
    assert!(Arc::ptr_eq(&source_native.handle, &child_native.handle));
    assert_eq!(
        guard(&app, &lease, &child, json!({"kind":"status"}))
            .await
            .unwrap()["available"],
        true
    );

    let source_a = context("A{literal}<selector>");
    let inspected = guard(
        &app,
        &lease,
        &child,
        json!({"kind":"prepare","source":source_a}),
    )
    .await
    .unwrap();
    let pane = inspected["destination"]["pane"].as_str().unwrap();
    let bytes = fixture.dir.path().join("guarded-input-bytes");
    let pid = fixture.dir.path().join("guarded-input-pid");
    let original_pid = install_capture(&servers, "guard-left", pane, &bytes, &pid).await;
    let (other, mut other_events) =
        multiplexer_child(&app, &lease, &source, "guard-right", kind, false).await;
    displays.keep(&state, &other).await;
    owned_terminal_output(&app, &other.session_id, &mut other_events, b"GUARD_RIGHT").await;
    adopt(&app, &lease, &other).await;
    let other_native = state.session(&other.session_id).await.unwrap();
    let other_inspected = guard(
        &app,
        &lease,
        &other,
        json!({"kind":"prepare","source":source_a}),
    )
    .await
    .unwrap();
    assert_eq!(
        other_inspected["destination"]["pane"], inspected["destination"]["pane"],
        "owned servers must overlap public pane IDs"
    );
    let other_bytes = fixture.dir.path().join("other-input-bytes");
    let other_pid = fixture.dir.path().join("other-input-pid");
    let other_original_pid = install_capture(
        &servers,
        "guard-right",
        other_inspected["destination"]["pane"].as_str().unwrap(),
        &other_bytes,
        &other_pid,
    )
    .await;
    let other_binding = confirm(&app, &lease, &other, &source_a).await;
    // pane run sends into the same PTY; a real selected-workspace change is
    // needed to invalidate the inspected target (not the shell's process name).
    servers
        .json(
            "guard-left",
            &[
                "workspace",
                "create",
                "--focus",
                "--label",
                "GUARD_MOVED",
                "--cwd",
                directory,
            ],
        )
        .await;
    owned_terminal_output(&app, &child.session_id, &mut events, b"GUARD_MOVED").await;
    assert!(guard(
        &app,
        &lease,
        &child,
        json!({"kind":"confirm","candidate":inspected["candidate"],"source":source_a})
    )
    .await
    .is_err());
    servers
        .json(
            "guard-left",
            &[
                "workspace",
                "focus",
                inspected["destination"]["workspace"].as_str().unwrap(),
            ],
        )
        .await;
    owned_terminal_output(&app, &child.session_id, &mut events, b"GUARD_LEFT").await;
    let binding = confirm(&app, &lease, &child, &source_a).await;
    let text = "literal{safe}<text>\nsecond\t🙂";
    guard(&app, &lease, &child, json!({"kind":"input","receipt":binding["receipt"],"source":source_a,"operation":1,"input":{"kind":"send","text":text}})).await.unwrap();
    let mut expected = format!("{text}\r").into_bytes();
    captured(&bytes, &expected).await;
    captured(&other_bytes, b"").await;
    assert!(guard(&app, &lease, &other, json!({"kind":"input","receipt":binding["receipt"],"source":source_a,"operation":1,"input":{"kind":"request_stop"}})).await.is_err());
    guard(&app, &lease, &other, json!({"kind":"input","receipt":other_binding["receipt"],"source":source_a,"operation":1,"input":{"kind":"request_stop"}})).await.unwrap();
    captured(&other_bytes, &[0x1b]).await;
    assert!(guard(&app, &lease, &child, json!({"kind":"input","receipt":binding["receipt"],"source":source_a,"operation":1,"input":{"kind":"request_stop"}})).await.is_err());
    captured(&bytes, &expected).await;
    // A fresh receipt is valid here; earlier sequence-rejection checks retired their own receipt.
    let view_binding = confirm(&app, &lease, &child, &source_a).await;
    crate::herdr::herdr_action(
        app.state(),
        child.session_id.clone(),
        "guard-left".into(),
        crate::herdr::HerdrAction::FocusWorkspace {
            target: view_binding["destination"]["workspace"]
                .as_str()
                .unwrap()
                .into(),
        },
        lease.clone(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    assert!(guard(&app,&lease,&child,json!({"kind":"input","receipt":view_binding["receipt"],"source":source_a,"operation":1,"input":{"kind":"request_stop"}})).await.is_err());
    captured(&bytes, &expected).await;
    let source_b = context("B");
    let changed = confirm(&app, &lease, &child, &source_b).await;
    guard(
        &app,
        &lease,
        &child,
        json!({"kind":"release","receipt":binding["receipt"]}),
    )
    .await
    .unwrap();
    guard(&app, &lease, &child, json!({"kind":"input","receipt":changed["receipt"],"source":source_b,"operation":1,"input":{"kind":"request_stop"}})).await.unwrap();
    expected.push(0x1b);
    captured(&bytes, &expected).await;
    let restored = confirm(&app, &lease, &child, &source_a).await;
    assert!(guard(&app, &lease, &child, json!({"kind":"input","receipt":changed["receipt"],"source":source_b,"operation":2,"input":{"kind":"request_stop"}})).await.is_err());
    guard(&app, &lease, &child, json!({"kind":"input","receipt":restored["receipt"],"source":source_a,"operation":1,"input":{"kind":"request_stop"}})).await.unwrap();
    expected.push(0x1b);
    captured(&bytes, &expected).await;

    authority.lock().unwrap();
    assert!(guard(&app, &lease, &child, json!({"kind":"input","receipt":restored["receipt"],"source":source_a,"operation":2,"input":{"kind":"request_stop"}})).await.is_err());
    authority
        .authorize(authority.generation().unwrap())
        .unwrap();
    let fresh = ready_lease(&authority);
    assert!(guard(&app, &fresh, &child, json!({"kind":"input","receipt":restored["receipt"],"source":source_a,"operation":2,"input":{"kind":"request_stop"}})).await.is_err());
    let new_binding = confirm(&app, &fresh, &child, &source_a).await;
    guard(&app, &fresh, &child, json!({"kind":"input","receipt":new_binding["receipt"],"source":source_a,"operation":1,"input":{"kind":"request_stop"}})).await.unwrap();
    expected.push(0x1b);
    captured(&bytes, &expected).await;
    assert_eq!(herdr_counter(&pid).await, Some(original_pid));
    assert_eq!(herdr_counter(&other_pid).await, Some(other_original_pid));
    captured(&other_bytes, &[0x1b]).await;
    assert!(Arc::ptr_eq(&source_native.handle, &child_native.handle));
    herdr_source_probe(
        &app,
        &fresh,
        &source,
        &mut source_events,
        "ORIGINAL_SOURCE_STILL_LIVE",
    )
    .await;
    // Closing the bootstrap shell must leave its attached display/lease usable.
    assert_eq!(
        source_native.creation.generation(),
        child_native.creation.generation()
    );
    disconnect_inner(&state, source.session_id.clone())
        .await
        .unwrap();
    herdr_retired(&state, &source.session_id, &source_native, true).await;
    let after_bootstrap = confirm(&app, &fresh, &child, &source_a).await;
    guard(&app,&fresh,&child,json!({"kind":"input","receipt":after_bootstrap["receipt"],"source":source_a,"operation":1,"input":{"kind":"request_stop"}})).await.unwrap();
    expected.push(0x1b);
    captured(&bytes, &expected).await;
    assert_eq!(herdr_counter(&pid).await, Some(original_pid));
    assert!(Arc::ptr_eq(&source_native.handle, &child_native.handle));
    servers.assert_running();
    disconnect_inner(&state, child.session_id.clone())
        .await
        .unwrap();
    herdr_retired(&state, &child.session_id, &child_native, true).await;
    assert!(guard(
        &app,
        &fresh,
        &child,
        json!({"kind":"prepare","source":source_a})
    )
    .await
    .is_err());
    assert_eq!(herdr_counter(&pid).await, Some(original_pid));
    disconnect_inner(&state, other.session_id.clone())
        .await
        .unwrap();
    herdr_retired(&state, &other.session_id, &other_native, true).await;
    disconnect_inner(&state, source.session_id.clone())
        .await
        .unwrap();
    herdr_retired(&state, &source.session_id, &source_native, true).await;
    servers.stop().await;
    drop(servers);
    fixture
        .handle()
        .disconnect(
            russh::Disconnect::ByApplication,
            "owned guarded fixture complete",
            "en",
        )
        .await
        .unwrap();
    fixture.stop_listener().await;
}

#[tokio::test]
#[ignore = "requires owned OpenSSH and LAZYSH_TEST_HERDR_STOCK built from the unchanged import"]
async fn real_stock_herdr_probe_keeps_ordinary_attachment_without_input_authority() {
    let binary = PathBuf::from(
        std::env::var("LAZYSH_TEST_HERDR_STOCK").expect("absolute unchanged stock Herdr binary"),
    );
    let mut fixture = Fixture::with_herdr(Some(&binary)).await;
    let mut servers = HerdrServers {
        fixture: &fixture,
        binary: &binary,
        processes: Vec::new(),
    };
    servers.start("stock").await;
    servers
        .json(
            "stock",
            &[
                "workspace",
                "create",
                "--label",
                "STOCK_ORDINARY",
                "--cwd",
                fixture.dir.path().to_str().unwrap(),
            ],
        )
        .await;
    let (app, state) = herdr_native_app(&fixture);
    let mut displays = OwnedDisplays::default();
    let (_authority, lease, source, mut source_events) =
        adopted_source(&fixture, &app, &state, &mut displays).await;
    let parent = state.session(&source.session_id).await.unwrap();
    assert!(!crate::herdr_guard::available(&parent, "stock", &lease).await);
    let (child, mut events) = multiplexer_child(
        &app,
        &lease,
        &source,
        "stock",
        crate::multiplexer::MultiplexerKind::Herdr,
        false,
    )
    .await;
    displays.keep(&state, &child).await;
    owned_terminal_output(&app, &child.session_id, &mut events, b"STOCK_ORDINARY").await;
    adopt(&app, &lease, &child).await;
    let native = state.session(&child.session_id).await.unwrap();
    assert!(native.herdr.lock().unwrap().is_none());
    assert_eq!(
        guard(&app, &lease, &child, json!({"kind":"status"}))
            .await
            .unwrap(),
        json!({"kind":"status","available":false})
    );
    assert!(guard(
        &app,
        &lease,
        &child,
        json!({"kind":"prepare","source":context("A")})
    )
    .await
    .is_err());
    herdr_source_probe(
        &app,
        &lease,
        &source,
        &mut source_events,
        "STOCK_SOURCE_STILL_LIVE",
    )
    .await;
    disconnect_inner(&state, child.session_id.clone())
        .await
        .unwrap();
    herdr_retired(&state, &child.session_id, &native, true).await;
    disconnect_inner(&state, source.session_id.clone())
        .await
        .unwrap();
    herdr_retired(&state, &source.session_id, &parent, true).await;
    servers.stop().await;
    drop(servers);
    fixture
        .handle()
        .disconnect(
            russh::Disconnect::ByApplication,
            "owned stock fixture complete",
            "en",
        )
        .await
        .unwrap();
    fixture.stop_listener().await;
}
