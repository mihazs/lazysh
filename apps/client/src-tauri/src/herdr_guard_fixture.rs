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
    history: bool,
) -> u64 {
    let prefix = if history {
        "i=0; while [ $i -lt 512 ]; do printf 'OLD%03d\\n' $i; i=$((i+1)); done; printf 'NEW512\\n'; "
    } else {
        ""
    };
    let script = format!(
        "{prefix}stty raw -echo; echo $$ > {}; exec cat > {}",
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

#[cfg(target_os = "linux")]
struct OwnedMoshRenderer {
    directory: tempfile::TempDir,
    binary: String,
}
#[cfg(target_os = "linux")]
impl OwnedMoshRenderer {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.binary);
        command
            .env("TMUX_TMPDIR", self.directory.path())
            .env_remove("TMUX")
            .args(["-L", "mosh-render"]);
        command
    }
    fn new(fixture: &Fixture) -> Self {
        let renderer = Self {
            directory: tempfile::tempdir_in(fixture.dir.path()).unwrap(),
            binary: fixture.tmux.clone(),
        };
        assert!(renderer
            .command()
            .args([
                "-f",
                "/dev/null",
                "new-session",
                "-d",
                "-s",
                "owned",
                "-x",
                "80",
                "-y",
                "23",
                "stty raw -echo; printf RENDER_READY; exec cat"
            ])
            .status()
            .unwrap()
            .success());
        let deadline = std::time::Instant::now() + BOUND;
        while !renderer.visible().contains("RENDER_READY") {
            assert!(
                std::time::Instant::now() < deadline,
                "owned renderer did not start"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        renderer
    }
    fn feed(&self, bytes: &[u8]) {
        use std::io::Write;
        let mut child = self
            .command()
            .args(["load-buffer", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(self
            .command()
            .args(["paste-buffer", "-dr", "-t", "owned:0.0"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }
    fn visible(&self) -> String {
        let output = self
            .command()
            .args(["capture-pane", "-p", "-t", "owned:0.0"])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap()
    }
}
#[cfg(target_os = "linux")]
impl Drop for OwnedMoshRenderer {
    fn drop(&mut self) {
        let _ = self
            .command()
            .arg("kill-server")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
#[cfg(target_os = "linux")]
async fn render_mosh_until(
    app: &tauri::App<tauri::test::MockRuntime>,
    session_id: &str,
    events: &mut mpsc::UnboundedReceiver<Value>,
    renderer: &OwnedMoshRenderer,
    newest: bool,
) {
    timeout(Duration::from_secs(15), async {
        let mut total = 0usize;
        loop {
            tokio::select! {
                event = events.recv() => {
                    let event = event.expect("owned Mosh stream closed");
                    assert_ne!(event["type"], "closed");
                    if let Some(data) = event["data"].as_array() {
                        let bytes: Vec<u8> = data.iter().map(|value| value.as_u64().unwrap() as u8).collect();
                        total += bytes.len();
                        assert!(total <= 1024 * 1024, "owned Mosh render budget exceeded");
                        renderer.feed(&bytes);
                        let session = app.state::<AppState>().session(session_id).await.unwrap();
                        acknowledge(&session, bytes.len() as u32).unwrap();
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(25)) => {}
            }
            let visible = renderer.visible();
            if visible.contains("NEW512") == newest && visible.contains("OLD480") != newest { break; }
        }
    }).await.expect("owned Rust Mosh renderer did not reach expected history");
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "requires owned OpenSSH, LAZYSH_NATIVE_MOSH_SERVER, FD-capable LAZYSH_TEST_HERDR, and LAZYSH_TEST_TMUX pointing to tmux 3.4"]
async fn real_guarded_mosh_keeps_private_claim_and_exact_display_after_bootstrap_closure() {
    let tmux = std::env::var_os("LAZYSH_TEST_TMUX")
        .expect("LAZYSH_TEST_TMUX must point to the qualified tmux 3.4 renderer");
    let version = Command::new(tmux)
        .arg("-V")
        .output()
        .expect("cannot run qualified tmux renderer");
    assert!(
        version.status.success() && version.stdout == b"tmux 3.4\n",
        "Mosh renderer fixture requires tmux 3.4"
    );
    let binary = PathBuf::from(std::env::var("LAZYSH_TEST_HERDR").unwrap());
    for (user_install, preseed) in [(false, false), (true, false), (false, true), (true, true)] {
        let fixture =
            Fixture::with_mosh_mode_and_user_install(Some(&binary), true, user_install).await;
        owned_herdr_shell_config(&fixture);
        let mut servers = HerdrServers {
            fixture: &fixture,
            binary: &binary,
            processes: Vec::new(),
        };
        let name = "owned-mosh-guard";
        servers.start(name).await;
        let workspace = servers
            .json(
                name,
                &[
                    "workspace",
                    "create",
                    "--label",
                    "MOSH_GUARDED",
                    "--cwd",
                    fixture.dir.path().to_str().unwrap(),
                ],
            )
            .await;
        let capture = fixture.dir.path().join("mosh-guard-input");
        let pid = fixture.dir.path().join("mosh-guard-pid");
        let seeded = if preseed {
            let workspace_id = workspace["result"]["workspace"]["workspace_id"]
                .as_str()
                .unwrap();
            let tab = servers
                .json(
                    name,
                    &[
                        "tab",
                        "create",
                        "--workspace",
                        workspace_id,
                        "--cwd",
                        fixture.dir.path().to_str().unwrap(),
                        "--label",
                        "OWNED_SCROLL",
                        "--no-focus",
                    ],
                )
                .await;
            let tab_id = tab["result"]["tab"]["tab_id"].as_str().unwrap().to_owned();
            let pane = tab["result"]["root_pane"]["pane_id"]
                .as_str()
                .unwrap()
                .to_owned();
            let pid = install_capture(&servers, name, &pane, &capture, &pid, true).await;
            Some((tab_id, pane, pid))
        } else {
            None
        };
        let (app, state) = herdr_native_app(&fixture);
        let (_authority, lease) = unlocked_authority();
        let (source, _) = herdr_echo_source(&fixture, &state, &lease).await;
        let parent = state.session(&source.session_id).await.unwrap();
        assert!(crate::herdr_guard::available(&parent, name, &lease).await);
        let entry = crate::multiplexer::Entry {
            kind: crate::multiplexer::MultiplexerKind::Herdr,
            name: name.into(),
            tmux_server: None,
            create_if_missing: false,
        };
        let (child, mut events) = mosh_entry_child(&app, &lease, &source, entry).await;
        let native = state.session(&child.session_id).await.unwrap();
        assert!(native.herdr.lock().unwrap().is_some());
        assert!(Arc::ptr_eq(&parent.handle, &native.handle));
        disconnect_inner(&state, source.session_id.clone())
            .await
            .unwrap();
        herdr_retired(&state, &source.session_id, &parent, true).await;
        // The Connect dialog retires its bootstrap before publishing/adopting the child.
        adopt(&app, &lease, &child).await;
        let output =
            owned_terminal_output(&app, &child.session_id, &mut events, b"MOSH_GUARDED").await;
        assert!(!output.windows(14).any(|part| part == b"LAZYSH-GUARD-1"));
        let renderer = OwnedMoshRenderer::new(&fixture);
        renderer.feed(&output);
        crate::ssh::resize(lease.clone(), app.state(), child.session_id.clone(), 80, 23)
            .await
            .unwrap()
            .into_inner()
            .unwrap();
        assert_eq!(
            guard(&app, &lease, &child, json!({"kind":"status"}))
                .await
                .unwrap()["available"],
            true
        );
        if let Some((tab, _, _)) = &seeded {
            let focused = servers.json(name, &["tab", "focus", tab]).await;
            assert!(focused.get("error").is_none());
        }
        let source = context("mosh-owned");
        let inspected = guard(
            &app,
            &lease,
            &child,
            json!({"kind":"prepare","source":source}),
        )
        .await
        .unwrap();
        let pane = inspected["destination"]["pane"].as_str().unwrap();
        let original_pid = if let Some((_, expected_pane, pid)) = &seeded {
            assert_eq!(pane, expected_pane);
            *pid
        } else {
            install_capture(&servers, name, pane, &capture, &pid, true).await
        };
        render_mosh_until(&app, &child.session_id, &mut events, &renderer, true).await;
        captured(&capture, b"").await;
        // Allow the focused pre-existing tab's resize and repaint to settle before observation.
        if preseed {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let destination = timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(reply) = guard(&app, &lease, &child, json!({"kind":"observe"})).await {
                    break reply["destination"].clone();
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("owned Mosh display did not settle");
        let pane_info = servers.json(name, &["pane", "get", pane]).await;
        assert_eq!(pane_info["result"]["pane"]["scroll"]["viewport_rows"], 22);
        let x = destination["viewport"]["x"].as_u64().unwrap();
        let y = destination["viewport"]["y"].as_u64().unwrap();
        guard(
            &app,
            &lease,
            &child,
            json!({"kind":"scroll_history","destination":destination,"x":x,"y":y,"lines":-17}),
        )
        .await
        .unwrap();
        render_mosh_until(&app, &child.session_id, &mut events, &renderer, false).await;
        let pane_info = servers.json(name, &["pane", "get", pane]).await;
        assert_eq!(
            pane_info["result"]["pane"]["scroll"]["offset_from_bottom"],
            17
        );
        captured(&capture, b"").await;
        guard(
            &app,
            &lease,
            &child,
            json!({"kind":"scroll_history","destination":destination,"x":x,"y":y,"lines":17}),
        )
        .await
        .unwrap();
        render_mosh_until(&app, &child.session_id, &mut events, &renderer, true).await;
        let pane_info = servers.json(name, &["pane", "get", pane]).await;
        assert_eq!(
            pane_info["result"]["pane"]["scroll"]["offset_from_bottom"],
            0
        );
        captured(&capture, b"").await;
        let binding = confirm(&app, &lease, &child, &source).await;
        guard(&app, &lease, &child, json!({"kind":"input","receipt":binding["receipt"],"source":source,"operation":1,"input":{"kind":"send","text":"MOSH-private-fresh"}})).await.unwrap();
        captured(&capture, b"MOSH-private-fresh\r").await;
        assert_eq!(
            fs::read_to_string(&pid).unwrap().trim(),
            original_pid.to_string()
        );
        servers.assert_running();
        disconnect_inner(&state, child.session_id.clone())
            .await
            .unwrap();
        herdr_retired(&state, &child.session_id, &native, true).await;
        servers.stop().await;
    }
}

#[tokio::test]
#[ignore = "requires owned OpenSSH and LAZYSH_TEST_HERDR built from current guarded source"]
async fn real_guarded_herdr_ssh_binding_keeps_original_connection_source_and_lease() {
    let binary = PathBuf::from(
        std::env::var("LAZYSH_TEST_HERDR").expect("absolute current-source guarded Herdr binary"),
    );
    let mut fixture = Fixture::with_herdr(Some(&binary)).await;
    owned_herdr_shell_config(&fixture);
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
        multiplexer_child(&app, &lease, &source, "guard-left", kind, Some(false)).await;
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
    let original_pid = install_capture(&servers, "guard-left", pane, &bytes, &pid, false).await;
    let (other, mut other_events) =
        multiplexer_child(&app, &lease, &source, "guard-right", kind, Some(false)).await;
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
        false,
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
        Some(false),
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
