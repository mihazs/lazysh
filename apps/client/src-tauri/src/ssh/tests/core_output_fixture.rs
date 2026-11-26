//! Core-fed terminal output against real OpenSSH, the official mosh-server and the official ET
//! server (#1315). One deterministic workload crosses a real sshd PTY twice, once into the WebView
//! `Channel` (the xterm path) and once into a core stand-in, and the core must receive exactly the
//! bytes the Channel carried, in order, with at most one transport window queued and no `Data`
//! message on the Channel. A real Mosh session then runs the same kind of workload into a core, and
//! a real ET session carries the same bytes between two markers.
use super::*;
use crate::terminal_core::{self, fake::ChecksumCore};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;

const LINES: usize = 300_000;
const MOSH_LINES: usize = 100_000;
#[cfg(target_os = "linux")]
const ET_LINES: usize = 100_000;

/// What the remote PTY prints for [`command`] with `lines` lines: its line feeds become CR LF.
fn expected(lines: usize) -> Vec<u8> {
    (1..=lines)
        .flat_map(|n| format!("{n} 世界 😀\r\n").into_bytes())
        .collect()
}

/// The same bytes from two writers: `sed` flushes every line to the PTY (a program logging as it
/// goes), `cat` writes the block it read (a file dump). How the remote writes sets how many chunks
/// cross the bridge, so the message counts below are per workload, not per transport.
const WORKLOADS: [(&str, &str); 2] = [("line-buffered", ""), ("block", " | cat")];

fn command(lines: usize, suffix: &str) -> String {
    format!("seq 1 {lines} | sed 's/$/ 世界 😀/'{suffix}")
}

/// Waits until the transport has all its credit back: every consumed byte was acknowledged.
async fn all_credit_returned(session: &Session) {
    timeout(Duration::from_secs(10), async {
        while *session.output_inflight.lock().unwrap() != 0
            || session.output_credits.available_permits() != OUTPUT_WINDOW as usize
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("every credit came back");
}

/// Runs the workload in a product-opened PTY channel on `handle` and starts a terminal on it that
/// reports to `events`.
async fn start(
    state: &AppState,
    handle: &Arc<SshHandle>,
    suffix: &str,
    events: Channel<SshEvent>,
) -> (String, Arc<Session>) {
    let (channel, initial) = open_terminal(handle, 80, 24, Some(command(LINES, suffix)))
        .await
        .unwrap();
    let id = spawn_terminal(
        state,
        access_lease(),
        handle.clone(),
        channel,
        initial,
        events,
    )
    .await
    .unwrap()
    .session_id;
    let session = state.session(&id).await.unwrap();
    (id, session)
}

/// The xterm path: a renderer that acknowledges each chunk. Returns the bytes and the number of
/// `Data` messages that crossed the Channel.
async fn through_channel(
    state: &AppState,
    handle: &Arc<SshHandle>,
    suffix: &str,
) -> (Vec<u8>, usize) {
    let (events, mut rx) = json_events();
    let (_, session) = start(state, handle, suffix, events).await;
    let (mut bytes, mut messages) = (Vec::new(), 0);
    timeout(Duration::from_secs(30), async {
        loop {
            let event = rx.recv().await.unwrap();
            if let Some(data) = event["data"].as_array() {
                messages += 1;
                bytes.extend(data.iter().map(|value| value.as_u64().unwrap() as u8));
                acknowledge(&session, data.len() as u32).unwrap();
            } else if event["type"] == "closed" {
                break;
            }
        }
    })
    .await
    .expect("the workload ended");
    (bytes, messages)
}

/// A Channel that counts the `Data` messages sent through it.
fn data_counting_events() -> (Channel<SshEvent>, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let counted = count.clone();
    let events = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = body {
            if serde_json::from_str::<serde_json::Value>(&json).unwrap()["data"].is_array() {
                counted.fetch_add(1, Ordering::SeqCst);
            }
        }
        Ok(())
    });
    (events, count)
}

/// The native path: the same workload into a core. Returns the number of `Data` messages that
/// crossed the Channel (none are expected).
async fn through_core(
    state: &AppState,
    handle: &Arc<SshHandle>,
    suffix: &str,
    expected: &[u8],
) -> usize {
    let (core, prepared) = ChecksumCore::prepared();
    let (events, data_messages) = data_counting_events();
    terminal_core::offer(&events, Box::new(move || Ok(prepared)));
    let (id, session) = start(state, handle, suffix, events).await;
    core.assert_stream(expected).await;
    all_credit_returned(&session).await;
    terminal_core::close(&id);
    data_messages.load(Ordering::SeqCst)
}

/// Writes `steps` to the session's input as the product does: `None` only starts the input path of
/// a Mosh session, `Some` types a command and presses Enter.
async fn write(app: &App, id: &str, steps: Option<Vec<String>>) {
    write_stdin(access_lease(), app.state(), id.into(), String::new(), steps)
        .await
        .unwrap()
        .into_inner()
        .unwrap();
}

fn command_line(command: String) -> Option<Vec<String>> {
    Some(vec![command, "\r".into()])
}

/// The offset of the first `needle` in `haystack[from..]`.
fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| from + at)
}

/// Waits until `core` has seen `marker` anywhere (a shell may print a long prompt or redraw it
/// after the marker), then until every credit is back, and returns the peak of bytes queued
/// unreturned, which must not exceed the window.
async fn settle(core: &ChecksumCore, session: &Session, marker: &str) -> usize {
    timeout(Duration::from_secs(30), async {
        let mut scanned = 0;
        loop {
            {
                let seen = core.seen.lock().unwrap();
                if find(&seen, marker.as_bytes(), scanned).is_some() {
                    break;
                }
                // Only the bytes that arrived since, plus the overlap a marker could straddle.
                scanned = seen.len().saturating_sub(marker.len() - 1);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        let seen = core.seen.lock().unwrap();
        let tail = &seen[seen.len().saturating_sub(200)..];
        panic!(
            "the final output never reached the core: {} bytes seen, ending {:?}",
            seen.len(),
            String::from_utf8_lossy(tail)
        )
    });
    all_credit_returned(session).await;
    let peak = core.peak_queued.load(Ordering::SeqCst);
    assert!(
        peak <= OUTPUT_WINDOW as usize,
        "{peak} bytes queued over the window"
    );
    peak
}

/// Waits for a transport's connect command and returns the session it opened, with the core the
/// renderer offered attached to it.
async fn attached(
    app: &App,
    connecting: impl std::future::Future<Output = AccessResult<Connected>>,
) -> (String, Arc<Session>) {
    let id = connecting.await.unwrap().into_inner().unwrap().session_id;
    let session = app.state::<AppState>().session(&id).await.unwrap();
    assert!(session.core.is_attached());
    (id, session)
}

/// A real Mosh session on a free UDP port whose output goes to the core offered on `events`, with its input path started
/// (the first write only does that).
async fn start_mosh(app: &App, parent: &str, events: Channel<SshEvent>) -> (String, Arc<Session>) {
    let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let port = udp.local_addr().unwrap().port();
    drop(udp);
    let options =
        serde_json::from_value(serde_json::json!({"portMin":port,"portMax":port})).unwrap();
    let (id, session) = attached(
        app,
        connect_mosh_inner(
            access_lease(),
            app.state(),
            parent.into(),
            options,
            None,
            80,
            24,
            events,
            None,
        ),
    )
    .await;
    write(app, &id, None).await;
    (id, session)
}

/// A real Mosh session whose output goes to a core. Mosh sends display frames, not the server's
/// byte stream, so the check is that the final screen arrives: a marker only the command's output
/// (never its echo) contains, printed after the whole workload, with the window credited back.
async fn through_mosh(app: &App, parent: &str) -> (usize, usize) {
    // The shell computes the OK, so the typed command line (which a frame may also carry) never
    // contains the marker. A Mosh frame is a diff of cells: a cell that already holds the right
    // character is skipped, which splits a marker that shares characters with the screen it
    // replaces. The workload only prints digits, so a marker of letters is always written whole.
    const DONE: &str = "FIN_OK";
    let (core, prepared) = ChecksumCore::prepared();
    let (events, _rx) = json_events();
    terminal_core::offer(&events, Box::new(move || Ok(prepared)));
    let (id, session) = start_mosh(app, parent, events).await;
    let workload = format!("seq 1 {MOSH_LINES}; echo FIN_$(echo OK)");
    write(app, &id, command_line(workload)).await;
    let peak = settle(&core, &session, DONE).await;
    let received = core.seen.lock().unwrap().len();
    terminal_core::close(&id);
    (received, peak)
}

/// The real core's grid and the text of its rows, through the control commands the client reads them with.
#[cfg(native_terminal_core)]
async fn core_screen(id: &str) -> ((u64, u64), Vec<String>) {
    let answer = terminal_core::terminal_core_snapshot(access_lease(), id.into(), None)
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    let state = &answer["state"];
    let rows = answer["window"]["rows"].as_array().unwrap();
    (
        (
            state["columns"].as_u64().unwrap(),
            state["rows"].as_u64().unwrap(),
        ),
        rows.iter()
            .map(|row| row.as_str().unwrap().to_owned())
            .collect(),
    )
}

/// A real Mosh session whose output goes to the real core, opened for Mosh frames as the client opens it. The core must follow
/// the server's own display frames: the shell's marker reaches its screen, and after the product's resize command (which the
/// transport sends to the server, the core only recording an intent) the grid becomes the size the server answers with.
/// A frame the core refused would be a `failure` event on the Channel, and none arrives.
#[cfg(native_terminal_core)]
async fn through_mosh_into_real_core(app: &App, parent: &str) {
    const MARKER: &str = "FIN_OK";
    let (events, mut told) = json_events();
    let mosh = terminal_core::CoreConfig {
        canonical_frames: true,
        ..Default::default()
    };
    terminal_core::terminal_core_open(access_lease(), events.clone(), 80, 24, None, Some(mosh))
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    let (id, session) = start_mosh(app, parent, events).await;
    write(app, &id, command_line("echo FIN_$(echo OK)".into())).await;
    let until = |size: (u64, u64)| {
        let id = id.clone();
        async move {
            timeout(Duration::from_secs(30), async {
                loop {
                    let (grid, rows) = core_screen(&id).await;
                    if grid == size && rows.iter().any(|row| row == MARKER) {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("the core never showed {MARKER} on a {size:?} grid"))
        }
    };
    until((80, 24)).await;
    resize(access_lease(), app.state(), id.clone(), 100, 30)
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    until((100, 30)).await;
    while let Ok(event) = told.try_recv() {
        assert_ne!(
            event["type"], "failure",
            "the core refused a frame: {event}"
        );
    }
    eprintln!("real Mosh into the real core: the grid followed the server to 100x30 with {MARKER} on screen");
    verify_live_handback(app, &id, &session, "MOSH", 100, 30).await;
    disconnect(app.state(), id).await.unwrap();
}

/// The bytes of `seen` between the first `begin` and the first `end` after it.
#[cfg(target_os = "linux")]
fn between<'a>(seen: &'a [u8], begin: &[u8], end: &[u8]) -> Option<&'a [u8]> {
    let start = find(seen, begin, 0)? + begin.len();
    Some(&seen[start..find(seen, end, start)?])
}

#[cfg(target_os = "linux")]
async fn start_et(
    app: &App,
    parent: &str,
    server: &crate::et::tests::Server,
    events: Channel<SshEvent>,
) -> (String, Arc<Session>) {
    attached(
        app,
        crate::et::connect_et_inner(
            None,
            access_lease(),
            app.state(),
            parent.into(),
            server.options(),
            80,
            24,
            events,
        ),
    )
    .await
}

/// A real ET session whose output goes to a core. ET carries the PTY's byte stream, so what the
/// workload printed between two markers (which the typed command's echo cannot contain, because the
/// shell computes the 42) must be exactly [`expected`], with the window credited back and no `Data`
/// message on the Channel.
#[cfg(target_os = "linux")]
async fn check_et(app: &App, parent: &str, directory: &std::path::Path) {
    let server = crate::et::tests::Server::start(directory).await;
    let (core, prepared) = ChecksumCore::prepared();
    let (events, data_messages) = data_counting_events();
    terminal_core::offer(&events, Box::new(move || Ok(prepared)));
    let (id, session) = start_et(app, parent, &server, events).await;
    let marker = |name: &str| format!("printf '{name}_%d\\n' $((40 + 2))");
    let workload = format!(
        "{}; {}; {}",
        marker("BEG"),
        command(ET_LINES, ""),
        marker("END")
    );
    write(app, &id, command_line(workload)).await;
    let peak = settle(&core, &session, "END_42").await;
    let seen = core.seen.lock().unwrap().clone();
    let printed = between(&seen, b"BEG_42\r\n", b"END_42\r\n").expect("both markers arrived");
    let expected = expected(ET_LINES);
    assert_eq!(
        terminal_core::fake::sha256(printed),
        terminal_core::fake::sha256(&expected),
        "the core received {} of {} bytes the workload printed",
        printed.len(),
        expected.len()
    );
    assert_eq!(
        data_messages.load(Ordering::SeqCst),
        0,
        "no Data message crossed the Channel"
    );
    eprintln!(
        "real ET, {ET_LINES} lines: {} bytes byte-exact in the core out of {} received, peak {peak} bytes queued, no Data message on the Channel",
        printed.len(),
        seen.len()
    );
    terminal_core::close(&id);
    disconnect(app.state(), id).await.unwrap();
    #[cfg(native_terminal_core)]
    hand_back_live_et(app, parent, &server).await;
}

#[cfg(all(target_os = "linux", native_terminal_core))]
async fn hand_back_live_et(app: &App, parent: &str, server: &crate::et::tests::Server) {
    let (events, _native) = json_events();
    terminal_core::terminal_core_open(access_lease(), events.clone(), 80, 24, None, None)
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    let (id, session) = start_et(app, parent, server, events).await;
    verify_live_handback(app, &id, &session, "ET", 80, 24).await;
    disconnect(app.state(), id).await.unwrap();
}

#[cfg(native_terminal_core)]
async fn verify_live_handback(
    app: &App,
    id: &str,
    session: &Session,
    label: &str,
    columns: u16,
    rows: u16,
) {
    use tauri::ipc::IpcResponse;

    write(
        app,
        id,
        command_line(format!(r#"printf '{label}_BEFORE_%s\n' "$$""#)),
    )
    .await;
    let prefix = format!("{label}_BEFORE_");
    let shell_pid = timeout(Duration::from_secs(12), async {
        loop {
            let (_, rows) = core_screen(id).await;
            if let Some(pid) = rows
                .iter()
                .find_map(|row| row.strip_prefix(&prefix)?.trim().parse::<u32>().ok())
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the native viewport contains the original shell PID");
    let (events, mut web) = json_events();
    let snapshot = terminal_core::terminal_core_release(access_lease(), id.into(), events)
        .await
        .unwrap()
        .body()
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();
    let ansi = snapshot["ansi"]
        .as_str()
        .expect("handback returns a visible ANSI snapshot");
    assert!(ansi.contains(&format!("{prefix}{shell_pid}")));
    assert_eq!(snapshot["columns"], columns);
    assert_eq!(snapshot["rows"], rows);
    assert!(!session.core.is_attached());
    write(
        app,
        id,
        command_line(format!(r#"printf '{label}_AFTER_%s\n' "$$""#)),
    )
    .await;
    let marker = format!("{label}_AFTER_{shell_pid}");
    let mut output = Vec::new();
    let reply = timeout(Duration::from_secs(12), async {
        while let Some(event) = web.recv().await {
            assert_ne!(event["type"], "closed");
            if let Some(data) = event["data"].as_array() {
                output.extend(data.iter().map(|byte| byte.as_u64().unwrap() as u8));
                ack_output(app.state(), id.into(), data.len() as u32)
                    .await
                    .unwrap();
            }
            assert!(output.len() < 64 * 1024);
            if find(&output, marker.as_bytes(), 0).is_some() {
                return;
            }
        }
        panic!("the WebView route closed before the shell replied");
    })
    .await;
    assert!(
        reply.is_ok(),
        "expected {marker:?} after {label} handback, received {:?}",
        String::from_utf8_lossy(&output)
    );
}

async fn check(app: &App, id: &str) {
    let state = app.state::<AppState>();
    let handle = state.session(id).await.unwrap().handle.clone();
    let expected = expected(LINES);
    let mib = expected.len() as f64 / (1024.0 * 1024.0);
    for (writer, suffix) in WORKLOADS {
        let (carried, channel_messages) = through_channel(&state, &handle, suffix).await;
        assert_eq!(
            terminal_core::fake::sha256(&carried),
            terminal_core::fake::sha256(&expected),
            "the {writer} workload is deterministic: the Channel path carried {} of {} bytes",
            carried.len(),
            expected.len()
        );
        let core_data_messages = through_core(&state, &handle, suffix, &expected).await;
        assert_eq!(core_data_messages, 0, "no Data message crossed the Channel");
        eprintln!(
            "real OpenSSH, {mib:.2} MiB, {writer} writer: {channel_messages} Channel Data messages ({:.0} per MiB, one ack_output call each) on the xterm path, {core_data_messages} on the core path",
            channel_messages as f64 / mib
        );
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let (received, peak) = through_mosh(app, id).await;
        eprintln!(
            "real Mosh, {MOSH_LINES} lines printed: {received} bytes of display frames reached the core, peak {peak} bytes queued"
        );
        #[cfg(native_terminal_core)]
        through_mosh_into_real_core(app, id).await;
    }
}

// Boxed like `openssh_interoperability`: a debug build sizes these state machines in the caller's
// poll frame, and `openssh_check` shares that frame (and a 2 MiB test thread) with every check.
pub(super) fn verify<'a>(app: &'a App, id: &'a str) -> impl std::future::Future<Output = ()> + 'a {
    Box::pin(check(app, id))
}

#[cfg(target_os = "linux")]
pub(super) fn verify_et<'a>(
    app: &'a App,
    parent: &'a str,
    directory: &'a std::path::Path,
) -> impl std::future::Future<Output = ()> + 'a {
    Box::pin(check_et(app, parent, directory))
}
