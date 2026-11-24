//! A stdio JSON-RPC 2.0 harness over the control plane (#1305), so the client's adapter contract suite can run
//! `NativeTerminalAdapter` over the real libghostty-vt core from a test process
//! (`apps/client/src/nativeTerminalAdapter.realCore.test.ts`). It calls what the app's `terminal_core_*` commands call:
//! a `Hub` session, the `Doorbell` and `control_*`. Test-only: one core per process, no transport and no access lease.
//!
//! One JSON object per line. A request on stdin has `id`, `method` and `params`; its answer is a line with the same `id`
//! and a `result` or an `error`. What the program reported (title, bell, directory, clipboard) and the doorbell are
//! notifications (`method: "event"`, `params` a `ControlEvent`), written before the answer of the request that read the
//! state. Methods, each with an optional `window` where it answers with the state:
//! `open {columns, rows, scrollbackLines, canonicalFrames?}`, `canonical` (a core that was not opened for Mosh becomes one,
//! before its first byte), `feed {data}` (base64; parsed before it answers), `snapshot`, `scroll {action}`,
//! `resize {columns, rows}`, `scrollback {lines}` (the History lines setting changed), `input {text}`, `setActive {active}`, `query {query}` (a `ControlQuery` about the buffer's
//! text, answered with text, a range or a hit), `select {range}` (the cells to highlight, or none) and `close`, which
//! ends the process.
//! `cargo run --example control_stdio`.

use base64::{engine::general_purpose::STANDARD, Engine};
use lazysh_terminal_runtime::{
    control_window, ffi, scrollback_bytes_for_lines, CellRange, Config, ControlQuery,
    ControlSnapshot, Doorbell, Error, Hooks, Hub, HubConfig, KeyInput, Offer, Origin, PtyWriter,
    Refused, ScrollAction, Session, Size, TerminalRuntime,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::io::BufRead;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

/// The transport's chunk and credit window, as the app opens a core.
const CHUNK: usize = 16 * 1024;
const WINDOW: usize = 256 * 1024;
const PARSE_TIMEOUT: Duration = Duration::from_secs(10);
const INVALID_PARAMS: i64 = -32602;
const FAILED: i64 = -32000;

type Failure = (i64, String);

fn failed(error: impl ToString) -> Failure {
    (FAILED, error.to_string())
}

fn params<P: DeserializeOwned>(value: Value) -> Result<P, Failure> {
    serde_json::from_value(value).map_err(|error| (INVALID_PARAMS, error.to_string()))
}

/// Replies and encoded input have no program to reach here: they go nowhere.
struct Nowhere;

impl PtyWriter for Nowhere {
    fn write(&self, _: Origin, _: &[u8]) -> Result<(), Refused> {
        Ok(())
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open {
    columns: u16,
    rows: u16,
    scrollback_lines: usize,
    /// The transport is Mosh: its frames decide the grid's size.
    #[serde(default)]
    canonical_frames: bool,
}

#[derive(Deserialize)]
struct Feed {
    data: String,
    window: Option<usize>,
}

#[derive(Deserialize)]
struct Window {
    window: Option<usize>,
}

#[derive(Deserialize)]
struct Scroll {
    action: ScrollAction,
    window: Option<usize>,
}

#[derive(Deserialize)]
struct Resize {
    columns: u16,
    rows: u16,
    window: Option<usize>,
}

#[derive(Deserialize)]
struct Scrollback {
    lines: usize,
    window: Option<usize>,
}

#[derive(Deserialize)]
struct Input {
    text: String,
}

#[derive(Deserialize)]
struct Query {
    query: ControlQuery,
}

#[derive(Deserialize)]
struct Select {
    range: Option<CellRange>,
}

#[derive(Deserialize)]
struct Active {
    active: bool,
}

/// What the VT has finished parsing, which the hub reports as credit returned.
#[derive(Default)]
struct Parsed {
    bytes: Mutex<usize>,
    changed: Condvar,
}

struct Core {
    request: Open,
    session: Session,
    doorbell: Arc<Doorbell>,
    parsed: Arc<Parsed>,
    fed: usize,
}

impl Core {
    /// Offers one transport chunk and returns once the VT has parsed it, so the answer that follows shows it.
    fn feed(&mut self, chunk: &[u8]) -> Result<(), Failure> {
        match self.session.feed(chunk.to_vec()).map_err(failed)? {
            Offer::Accepted => {}
            other => return Err(failed(format!("the core refused a chunk: {other:?}"))),
        }
        self.fed += chunk.len();
        let guard = self
            .parsed
            .bytes
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let (_parsed, timeout) = self
            .parsed
            .changed
            .wait_timeout_while(guard, PARSE_TIMEOUT, |parsed| *parsed < self.fed)
            .unwrap_or_else(PoisonError::into_inner);
        if timeout.timed_out() {
            return Err(failed("the core did not parse the chunk in time"));
        }
        Ok(())
    }

    /// One control-plane read, as the app's commands do it: the doorbell rearmed first (the reports that arrived go
    /// out now), then the answer under the session lock.
    fn answer(
        &self,
        window: Option<usize>,
        ask: impl FnOnce(&mut TerminalRuntime, usize) -> Result<ControlSnapshot, Error>,
    ) -> Result<Value, Failure> {
        self.doorbell.read();
        let answer = self
            .session
            .with(|runtime| ask(runtime, control_window(window)))
            .map_err(failed)?
            .map_err(failed)?;
        serde_json::to_value(answer).map_err(failed)
    }
}

fn open(hub: &Hub, request: Open) -> Result<Core, Failure> {
    let Open {
        columns,
        rows,
        scrollback_lines,
        canonical_frames,
    } = request;
    let config = Config {
        size: Size::new(columns, rows),
        scrollback_bytes: scrollback_bytes_for_lines(scrollback_lines, columns),
        ingress_bytes: WINDOW,
        canonical_frames,
        ..Config::default()
    };
    let parsed = Arc::new(Parsed::default());
    let credited = parsed.clone();
    let doorbell = Arc::new(Doorbell::new(
        |event| send(json!({"jsonrpc": "2.0", "method": "event", "params": event})),
        || true,
    ));
    let hooks = Hooks {
        writer: Arc::new(Nowhere),
        credit: Box::new(move |bytes| {
            *credited
                .bytes
                .lock()
                .unwrap_or_else(PoisonError::into_inner) += bytes;
            credited.changed.notify_all();
        }),
        changed: Some(doorbell.hook()),
    };
    let session = hub.create("control-stdio", config, hooks).map_err(failed)?;
    doorbell.bind(session.clone());
    session.set_active(true);
    Ok(Core {
        request,
        session,
        doorbell,
        parsed,
        fed: 0,
    })
}

fn call(hub: &Hub, core: &mut Option<Core>, method: &str, input: Value) -> Result<Value, Failure> {
    if method == "open" {
        if core.is_some() {
            return Err(failed("a core is already open"));
        }
        *core = Some(open(hub, params(input)?)?);
        return Ok(Value::Null);
    }
    if method == "canonical" {
        let current = core.as_ref().ok_or_else(|| failed("no core is open"))?;
        if current.fed > 0 {
            return Err(failed("canonical frames must precede the first byte"));
        }
        // The mode is fixed when a session is built, as in the app (`terminal_core_open`'s config): start it again,
        // empty and at the size it has now.
        let size = current
            .session
            .with(|runtime| runtime.size())
            .map_err(failed)?;
        let request = Open {
            columns: size.cols,
            rows: size.rows,
            canonical_frames: true,
            ..current.request.clone()
        };
        current.session.close();
        *core = Some(open(hub, request)?);
        return Ok(Value::Null);
    }
    let core = core.as_mut().ok_or_else(|| failed("no core is open"))?;
    match method {
        "feed" => {
            let Feed { data, window } = params(input)?;
            let bytes = STANDARD
                .decode(data)
                .map_err(|error| (INVALID_PARAMS, error.to_string()))?;
            bytes.chunks(CHUNK).try_for_each(|chunk| core.feed(chunk))?;
            core.answer(window, |runtime, rows| runtime.control_snapshot(rows))
        }
        "snapshot" => {
            let Window { window } = params(input)?;
            core.answer(window, |runtime, rows| runtime.control_snapshot(rows))
        }
        "scroll" => {
            let Scroll { action, window } = params(input)?;
            core.answer(window, |runtime, rows| runtime.control_scroll(action, rows))
        }
        "resize" => {
            let Resize {
                columns,
                rows,
                window,
            } = params(input)?;
            core.answer(window, |runtime, window| {
                runtime.control_resize(columns, rows, window)
            })
        }
        "scrollback" => {
            // The History lines setting changed: the budget for that many rows at the width the grid has now.
            let Scrollback { lines, window } = params(input)?;
            let cols = core
                .session
                .with(|runtime| runtime.size().cols)
                .map_err(failed)?;
            core.session
                .set_scrollback_bytes(scrollback_bytes_for_lines(lines, cols))
                .map_err(failed)?;
            core.answer(window, |runtime, rows| runtime.control_snapshot(rows))
        }
        "input" => {
            let Input { text } = params(input)?;
            let key = KeyInput {
                key: ffi::GhosttyKey_GHOSTTY_KEY_UNIDENTIFIED,
                mods: 0,
                text: Some(text),
                composing: false,
                repeat: false,
                release: false,
            };
            core.session.send_key(&key).map(Value::from).map_err(failed)
        }
        "setActive" => {
            let Active { active } = params(input)?;
            core.session.set_active(active);
            if active {
                core.doorbell.wake();
            }
            Ok(Value::Null)
        }
        "query" => {
            let Query { query } = params(input)?;
            let answer = core
                .session
                .with(|runtime| runtime.control_query(query))
                .map_err(failed)?
                .map_err(failed)?;
            serde_json::to_value(answer).map_err(failed)
        }
        "select" => {
            let Select { range } = params(input)?;
            core.session.set_selection(range);
            Ok(Value::Null)
        }
        "close" => {
            core.session.close();
            Ok(Value::Null)
        }
        other => Err((-32601, format!("no method {other}"))),
    }
}

/// One line on stdout; `println!` holds the lock for the whole line, so a worker's notification never splits an answer.
fn send(message: Value) {
    println!("{message}");
}

fn main() {
    let hub = Hub::new(HubConfig::default());
    let mut core = None;
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        let Ok(Value::Object(mut request)) = serde_json::from_str(&line) else {
            send(
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "not a JSON object"}}),
            );
            continue;
        };
        let id = request.remove("id").unwrap_or(Value::Null);
        let method = request
            .remove("method")
            .and_then(|method| method.as_str().map(str::to_owned))
            .unwrap_or_default();
        let input = request.remove("params").unwrap_or(Value::Null);
        send(match call(&hub, &mut core, &method, input) {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, message)) => {
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
            }
        });
        if method == "close" {
            break;
        }
    }
    if let Some(core) = core {
        core.session.close();
    }
}
