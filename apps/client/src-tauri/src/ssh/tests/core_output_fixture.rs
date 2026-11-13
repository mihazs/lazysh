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

/// A real Mosh session whose output goes to a core. Mosh sends display frames, not the server's
/// byte stream, so the check is that the final screen arrives: a marker only the command's output
/// (never its echo) contains, printed after the whole workload, with the window credited back.
async fn through_mosh(app: &App, parent: &str) -> (usize, usize) {
    // The shell computes the 42, so the typed command line (which a frame may also carry) never
    // contains the marker.
    const DONE: &str = "FIN_42";
    let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let port = udp.local_addr().unwrap().port();
    drop(udp);
    let options =
        serde_json::from_value(serde_json::json!({"portMin":port,"portMax":port})).unwrap();
    let (core, prepared) = ChecksumCore::prepared();
    let (events, _rx) = json_events();
    terminal_core::offer(&events, Box::new(move || Ok(prepared)));
    let (id, session) = attached(
        app,
        connect_mosh(
            access_lease(),
            app.state(),
            parent.into(),
            options,
            None,
            80,
            24,
            events,
        ),
    )
    .await;
    // The first write only starts the Mosh input path; the second is the workload.
    write(app, &id, None).await;
    let workload = format!("seq 1 {MOSH_LINES}; echo FIN_$((40 + 2))");
    write(app, &id, command_line(workload)).await;
    let peak = settle(&core, &session, DONE).await;
    let received = core.seen.lock().unwrap().len();
    terminal_core::close(&id);
    (received, peak)
}

/// The bytes of `seen` between the first `begin` and the first `end` after it.
#[cfg(target_os = "linux")]
fn between<'a>(seen: &'a [u8], begin: &[u8], end: &[u8]) -> Option<&'a [u8]> {
    let start = find(seen, begin, 0)? + begin.len();
    Some(&seen[start..find(seen, end, start)?])
}

/// A real ET session whose output goes to a core. ET carries the PTY's byte stream, so what the
/// workload printed between two markers (which the typed command's echo cannot contain, because the
/// shell computes the 42) must be exactly [`expected`], with the window credited back and no `Data`
/// message on the Channel.
#[cfg(target_os = "linux")]
pub(super) async fn verify_et(app: &App, parent: &str, directory: &std::path::Path) {
    let server = crate::et::tests::Server::start(directory).await;
    let (core, prepared) = ChecksumCore::prepared();
    let (events, data_messages) = data_counting_events();
    terminal_core::offer(&events, Box::new(move || Ok(prepared)));
    let connecting = crate::et::connect_et(
        access_lease(),
        app.state(),
        parent.into(),
        server.options(),
        80,
        24,
        events,
    );
    let (id, session) = attached(app, connecting).await;
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
}

pub(super) async fn verify(app: &App, id: &str) {
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
    }
}
