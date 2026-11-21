//! `herdr-events`: one long-lived stream of a Herdr server's agent-status changes (#1692).
//!
//! The command subscribes to the owned session socket with Herdr's `events.subscribe` and prints one
//! JSON frame per line until its stdin closes, so the app reads a transition when it happens instead
//! of polling the tree. The first frame, `hello`, means the subscription runs; a server that cannot
//! stream gets `unsupported` alone. A frame names a pane, its workspace, the agent kind, the new status and the
//! pane's directory; it never carries a pane title, the command that runs there or any screen text.
//! Frames: `hello`, `status`, `changed`, `heartbeat`, `end` and `unsupported`; the contract is in
//! `docs/companion.md`.
use crate::{Error, Result};

/// Frame vocabulary version. Later versions only add frame types and fields.
pub const PROTOCOL: u8 = 1;

/// The command: serves the named session on stdout; stdin closing ends it.
pub fn run_stdio(session: &str) -> Result<()> {
    if !crate::herdr::valid_session(session) {
        return Err(Error::Herdr("HerdrEventsInvalid"));
    }
    #[cfg(unix)]
    {
        engine::run_stdio(session)
    }
    #[cfg(not(unix))]
    {
        Err(Error::Herdr("HerdrEventsPlatformUnsupported"))
    }
}

#[cfg(unix)]
mod engine {
    use super::PROTOCOL;
    use crate::{Error, Result};
    use serde_json::{json, Value};
    use std::{
        collections::{HashMap, VecDeque},
        io::{ErrorKind, Read, Write},
        os::unix::net::UnixStream,
        path::Path,
        sync::{
            atomic::AtomicBool,
            mpsc::{Receiver, TryRecvError},
            Arc,
        },
        time::{Duration, Instant},
    };

    /// More agent panes than this are not subscribed one by one; the app keeps polling.
    const MAX_PANES: usize = 256;
    /// A reply or event line over this size is refused.
    const MAX_LINE: usize = 2 * 1024 * 1024;
    const STATUSES: [&str; 5] = ["idle", "working", "blocked", "done", "unknown"];

    /// What one line of the subscription means for the stream.
    #[derive(Debug, PartialEq)]
    enum Incoming {
        Status {
            pane: String,
            workspace: String,
            status: String,
            agent: Option<String>,
        },
        /// The set of panes may have changed: subscribe again.
        Topology,
        /// Something the tree shows changed (a name, the focus, a tab).
        Change,
        Ignore,
    }

    #[derive(Clone, Debug, PartialEq)]
    struct Pane {
        id: String,
        workspace: String,
        status: String,
        agent: Option<String>,
        cwd: Option<String>,
    }

    fn invalid() -> Error {
        Error::Herdr("HerdrEventsInvalid")
    }
    fn short(value: Option<&Value>, limit: usize) -> Option<String> {
        value
            .and_then(Value::as_str)
            .filter(|text| {
                !text.is_empty() && text.len() <= limit && !text.chars().any(char::is_control)
            })
            .map(str::to_owned)
    }

    /// The panes of a `session.snapshot` reply, with the agent kind Herdr detects in each.
    fn panes(reply: &Value) -> Result<Vec<Pane>> {
        let snapshot = reply.pointer("/result/snapshot").ok_or_else(invalid)?;
        let rows = snapshot["panes"].as_array().ok_or_else(invalid)?;
        let agents = snapshot["agents"].as_array();
        let kind = |pane: &str| {
            agents?
                .iter()
                .find(|agent| agent["pane_id"] == pane)
                .and_then(|agent| short(agent.get("agent"), 64))
        };
        rows.iter()
            .map(|row| {
                let id = short(row.get("pane_id"), 50)
                    .filter(|id| lazysh_common::valid_herdr_id(id, Some('p')))
                    .ok_or_else(invalid)?;
                let workspace = short(row.get("workspace_id"), 50)
                    .filter(|id| lazysh_common::valid_herdr_id(id, None))
                    .ok_or_else(invalid)?;
                let status = row["agent_status"]
                    .as_str()
                    .filter(|status| STATUSES.contains(status))
                    .ok_or_else(invalid)?;
                Ok(Pane {
                    agent: kind(&id),
                    cwd: short(row.get("cwd"), 4096),
                    status: status.to_owned(),
                    id,
                    workspace,
                })
            })
            .collect()
    }

    /// Lifecycle events that change which panes exist or which one holds an agent.
    const TOPOLOGY: [&str; 7] = [
        "pane_created",
        "pane_closed",
        "pane_moved",
        "pane_exited",
        "pane_agent_detected",
        "tab_closed",
        "workspace_closed",
    ];
    /// The lifecycle events a view of the tree follows. `pane.updated` and `workspace.updated` are left
    /// out: they fire for every title or metadata change and would turn the stream into polling.
    const LIFECYCLE: [&str; 17] = [
        "workspace.created",
        "workspace.renamed",
        "workspace.moved",
        "workspace.reordered",
        "workspace.closed",
        "workspace.focused",
        "tab.created",
        "tab.closed",
        "tab.focused",
        "tab.renamed",
        "tab.moved",
        "pane.created",
        "pane.closed",
        "pane.focused",
        "pane.moved",
        "pane.exited",
        "pane.agent_detected",
    ];

    fn subscribe_request(panes: &[Pane]) -> Value {
        let subscriptions: Vec<Value> = LIFECYCLE
            .iter()
            .map(|kind| json!({"type": kind}))
            .chain(
                panes
                    .iter()
                    .map(|pane| json!({"type":"pane.agent_status_changed","pane_id":pane.id})),
            )
            .collect();
        json!({"id":"lazysh:events","method":"events.subscribe","params":{"subscriptions":subscriptions}})
    }

    fn classify(line: &Value) -> Result<Incoming> {
        if let Some(code) = line.pointer("/error/code").and_then(Value::as_str) {
            // History the server no longer holds, or a pane that closed between the list and the subscribe.
            return if matches!(code, "events_lost" | "pane_not_found") {
                Ok(Incoming::Topology)
            } else {
                Err(Error::Herdr("HerdrEventsRefused"))
            };
        }
        let Some(event) = line["event"].as_str() else {
            return Ok(Incoming::Ignore);
        };
        if event.replace('.', "_") == "pane_agent_status_changed" {
            let data = &line["data"];
            return Ok(Incoming::Status {
                pane: short(data.get("pane_id"), 50)
                    .filter(|id| lazysh_common::valid_herdr_id(id, Some('p')))
                    .ok_or_else(invalid)?,
                workspace: short(data.get("workspace_id"), 50)
                    .filter(|id| lazysh_common::valid_herdr_id(id, None))
                    .ok_or_else(invalid)?,
                status: data["agent_status"]
                    .as_str()
                    .filter(|status| STATUSES.contains(status))
                    .ok_or_else(invalid)?
                    .to_owned(),
                agent: short(data.get("agent"), 64),
            });
        }
        Ok(if TOPOLOGY.contains(&event.replace('.', "_").as_str()) {
            Incoming::Topology
        } else {
            Incoming::Change
        })
    }

    fn status_frame(
        pane: &str,
        workspace: &str,
        status: &str,
        agent: Option<&str>,
        cwd: Option<&str>,
    ) -> Value {
        json!({"type":"status","paneId":pane,"workspaceId":workspace,"status":status,"agent":agent,"cwd":cwd})
    }

    #[derive(Clone, Copy)]
    pub(super) struct Timing {
        pub heartbeat: Duration,
        /// The shortest gap between two `changed` frames, and between two subscriptions.
        pub spacing: Duration,
        /// The longest wait for one reply from the server.
        pub reply: Duration,
    }
    impl Default for Timing {
        fn default() -> Self {
            Self {
                heartbeat: Duration::from_secs(5),
                spacing: Duration::from_millis(250),
                reply: Duration::from_secs(5),
            }
        }
    }

    /// Buffered line reader over one server connection.
    struct Lines {
        stream: UnixStream,
        buffer: Vec<u8>,
    }
    enum Read1 {
        Line(Value),
        Quiet,
        Eof,
    }
    impl Lines {
        fn connect(socket: &Path, request: &Value) -> Result<Self> {
            let mut stream = UnixStream::connect(socket)?;
            stream.write_all(format!("{request}\n").as_bytes())?;
            Ok(Self {
                stream,
                buffer: Vec::new(),
            })
        }
        /// The next line within `wait`; `Quiet` when none arrived in time.
        fn next(&mut self, wait: Duration) -> Result<Read1> {
            let deadline = Instant::now() + wait;
            loop {
                if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = self.buffer.drain(..=end).collect();
                    return serde_json::from_slice(&line[..end])
                        .map(Read1::Line)
                        .map_err(|_| invalid());
                }
                if self.buffer.len() > MAX_LINE {
                    return Err(Error::Herdr("HerdrEventsTooLarge"));
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Ok(Read1::Quiet);
                }
                self.stream.set_read_timeout(Some(left))?;
                let mut chunk = [0; 8192];
                match self.stream.read(&mut chunk) {
                    Ok(0) => return Ok(Read1::Eof),
                    Ok(count) => self.buffer.extend_from_slice(&chunk[..count]),
                    Err(error)
                        if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                    {
                        return Ok(Read1::Quiet)
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }

    /// One request on its own connection and its single reply line.
    fn ask(socket: &Path, request: &Value, timing: Timing) -> Result<Value> {
        match Lines::connect(socket, request)?.next(timing.reply)? {
            Read1::Line(reply) if reply["id"] == request["id"] && reply.get("error").is_none() => {
                Ok(reply)
            }
            Read1::Quiet => Err(Error::Herdr("HerdrEventsTimeout")),
            _ => Err(Error::Herdr("HerdrEventsRefused")),
        }
    }
    fn list(socket: &Path, timing: Timing) -> Result<Vec<Pane>> {
        panes(&ask(
            socket,
            &json!({"id":"lazysh:snapshot","method":"session.snapshot","params":{}}),
            timing,
        )?)
    }

    /// Why a subscription pass ended.
    enum Pass {
        Resubscribe,
        Stdin,
        Server,
    }

    struct Stream<'a, W: Write> {
        out: &'a mut W,
        closed: &'a Receiver<()>,
        timing: Timing,
        /// The last status seen per pane: a frame is sent only when it differs.
        known: HashMap<String, String>,
        panes: HashMap<String, Pane>,
        written: Instant,
    }
    impl<W: Write> Stream<'_, W> {
        fn emit(&mut self, frame: &Value) -> Result<()> {
            writeln!(self.out, "{frame}")?;
            self.out.flush()?;
            self.written = Instant::now();
            Ok(())
        }
        fn stdin_closed(&self) -> bool {
            matches!(self.closed.try_recv(), Err(TryRecvError::Disconnected))
        }
        fn status(
            &mut self,
            pane: &str,
            workspace: &str,
            status: &str,
            agent: Option<&str>,
        ) -> Result<()> {
            if self
                .known
                .insert(pane.to_owned(), status.to_owned())
                .as_deref()
                == Some(status)
            {
                return Ok(());
            }
            let known = self.panes.get(pane);
            let agent = agent.or(known.and_then(|pane| pane.agent.as_deref()));
            let cwd = known.and_then(|pane| pane.cwd.as_deref());
            let frame = status_frame(pane, workspace, status, agent, cwd);
            self.emit(&frame)
        }
        /// Sends what changed between the last pass and now, so nothing is lost while resubscribing.
        fn catch_up(&mut self, now: Vec<Pane>, baseline: bool) -> Result<()> {
            self.panes = now
                .iter()
                .map(|pane| (pane.id.clone(), pane.clone()))
                .collect();
            self.known.retain(|id, _| self.panes.contains_key(id));
            for pane in now {
                let silent =
                    baseline || (pane.status == "unknown" && !self.known.contains_key(&pane.id));
                if silent {
                    self.known.insert(pane.id, pane.status);
                } else {
                    self.status(
                        &pane.id,
                        &pane.workspace,
                        &pane.status,
                        pane.agent.as_deref(),
                    )?;
                }
            }
            Ok(())
        }
        fn watch(&mut self, lines: &mut Lines) -> Result<Pass> {
            let mut changed = false;
            let mut last_changed = Instant::now() - self.timing.spacing;
            loop {
                if self.stdin_closed() {
                    return Ok(Pass::Stdin);
                }
                if changed && last_changed.elapsed() >= self.timing.spacing {
                    self.emit(&json!({"type":"changed"}))?;
                    changed = false;
                    last_changed = Instant::now();
                }
                if self.written.elapsed() >= self.timing.heartbeat {
                    self.emit(&json!({"type":"heartbeat"}))?;
                }
                match lines.next(self.timing.spacing.min(Duration::from_millis(250)))? {
                    Read1::Quiet => {}
                    Read1::Eof => return Ok(Pass::Server),
                    Read1::Line(line) => match classify(&line)? {
                        Incoming::Status {
                            pane,
                            workspace,
                            status,
                            agent,
                        } => {
                            self.status(&pane, &workspace, &status, agent.as_deref())?;
                        }
                        Incoming::Topology => return Ok(Pass::Resubscribe),
                        Incoming::Change => changed = true,
                        Incoming::Ignore => {}
                    },
                }
            }
        }
    }

    /// Serves `session` until stdin closes, the server goes away or the server cannot stream.
    pub(super) fn run(
        socket: &Path,
        session: &str,
        out: &mut impl Write,
        closed: &Receiver<()>,
        timing: Timing,
    ) -> Result<()> {
        let mut stream = Stream {
            out,
            closed,
            timing,
            known: HashMap::new(),
            panes: HashMap::new(),
            written: Instant::now(),
        };
        match serve(socket, session, &mut stream) {
            // A server that answers `session.snapshot` or `events.subscribe` with an error cannot stream.
            Err(Error::Herdr("HerdrEventsRefused")) => {
                stream.emit(&json!({"type":"unsupported","reason":"events_subscribe"}))
            }
            other => other,
        }
    }
    fn serve(socket: &Path, session: &str, stream: &mut Stream<'_, impl Write>) -> Result<()> {
        let timing = stream.timing;
        let (mut baseline, mut passes) = (true, VecDeque::<Instant>::new());
        loop {
            let now = Instant::now();
            passes.retain(|at| now.duration_since(*at) < Duration::from_secs(10));
            if passes.len() >= 20 {
                return stream.emit(&json!({"type":"end","reason":"busy"}));
            }
            passes.push_back(now);
            let listed = list(socket, timing)?;
            if listed.len() > MAX_PANES {
                return stream.emit(&json!({"type":"unsupported","reason":"too_many_panes"}));
            }
            let mut lines = Lines::connect(socket, &subscribe_request(&listed))?;
            match lines.next(timing.reply)? {
                Read1::Line(ack)
                    if ack.pointer("/result/type") == Some(&json!("subscription_started")) => {}
                // A pane closed between the list and the subscribe: list again.
                Read1::Line(reply) if matches!(classify(&reply), Ok(Incoming::Topology)) => {
                    std::thread::sleep(timing.spacing);
                    continue;
                }
                Read1::Eof | Read1::Line(_) => return Err(Error::Herdr("HerdrEventsRefused")),
                Read1::Quiet => return Err(Error::Herdr("HerdrEventsTimeout")),
            }
            // Read after the subscription started, so a change in between is a difference, not a gap.
            stream.catch_up(list(socket, timing)?, baseline)?;
            if baseline {
                // The first frame means the subscription runs: what happens from here on is reported.
                stream.emit(&json!({"type":"hello","protocol":PROTOCOL,"session":session}))?;
            }
            baseline = false;
            match stream.watch(&mut lines)? {
                Pass::Resubscribe => {
                    stream.emit(&json!({"type":"changed"}))?;
                    std::thread::sleep(timing.spacing);
                }
                Pass::Stdin => return Ok(()),
                Pass::Server => return stream.emit(&json!({"type":"end","reason":"disconnected"})),
            }
        }
    }

    pub(super) fn run_stdio(session: &str) -> Result<()> {
        // Never set: SIGTERM and SIGINT keep their default effect; stdin closing is the normal end.
        let socket = crate::herdr::running_endpoint(session, Arc::new(AtomicBool::new(false)))?;
        run(
            Path::new(&socket),
            session,
            &mut std::io::stdout().lock(),
            &crate::stdin_closed(),
            Timing::default(),
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            io::{BufRead, BufReader},
            os::unix::net::UnixListener,
            sync::{Arc, Mutex},
        };

        const FAST: Timing = Timing {
            heartbeat: Duration::from_millis(60),
            spacing: Duration::from_millis(5),
            reply: Duration::from_secs(2),
        };
        fn pane(id: &str, status: &str, agent: Option<&str>) -> Value {
            json!({"pane_id":id,"workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_1","cwd":"/work/project",
                "agent_status":status,"title":"rm -rf /private","terminal_title":"secret text","agent":agent})
        }
        fn snapshot(rows: Vec<Value>) -> Value {
            let agents: Vec<Value> = rows
                .iter()
                .filter(|row| row["agent"].is_string())
                .map(|row| json!({"pane_id":row["pane_id"],"agent":row["agent"],"agent_status":row["agent_status"]}))
                .collect();
            json!({"id":"lazysh:snapshot","result":{"type":"session_snapshot","snapshot":{"panes":rows,"agents":agents}}})
        }
        fn event(status: &str, pane: &str) -> Value {
            json!({"event":"pane.agent_status_changed","data":{"pane_id":pane,"workspace_id":"w1","agent_status":status,
                "agent":"codex","title":"rm -rf /private","display_agent":"Codex","state_labels":{"x":"secret text"}}})
        }
        /// A Herdr server that answers snapshots from `snapshots` (the last one repeats) and hands each
        /// subscription to the next script, after the acknowledgement.
        struct Fake {
            socket: std::path::PathBuf,
            subscriptions: Arc<Mutex<Vec<Value>>>,
            _directory: tempfile::TempDir,
        }
        type Script = Box<dyn FnOnce(UnixStream) + Send>;
        fn fake(snapshots: Vec<Value>, ack: Value, scripts: Vec<Script>) -> Fake {
            let directory = tempfile::tempdir().unwrap();
            let socket = directory.path().join("herdr.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let subscriptions = Arc::new(Mutex::new(Vec::new()));
            let seen = subscriptions.clone();
            std::thread::spawn(move || {
                let (mut snapshots, mut scripts) =
                    (VecDeque::from(snapshots), VecDeque::from(scripts));
                for connection in listener.incoming() {
                    let mut stream = connection.unwrap();
                    let mut line = String::new();
                    BufReader::new(stream.try_clone().unwrap())
                        .read_line(&mut line)
                        .unwrap();
                    let request: Value = serde_json::from_str(&line).unwrap();
                    if request["method"] == "session.snapshot" {
                        let reply = if snapshots.len() > 1 {
                            snapshots.pop_front()
                        } else {
                            snapshots.front().cloned()
                        };
                        writeln!(stream, "{}", reply.unwrap()).unwrap();
                    } else {
                        assert_eq!(request["method"], "events.subscribe");
                        seen.lock().unwrap().push(request);
                        writeln!(stream, "{ack}").unwrap();
                        if let Some(script) = scripts.pop_front() {
                            std::thread::spawn(move || script(stream));
                        }
                    }
                }
            });
            Fake {
                socket,
                subscriptions,
                _directory: directory,
            }
        }
        fn started() -> Value {
            json!({"id":"lazysh:events","result":{"type":"subscription_started"}})
        }
        fn send(stream: &mut UnixStream, lines: &[Value]) {
            for line in lines {
                writeln!(stream, "{line}").unwrap();
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        /// Runs the stream until it ends on its own, or until stdin closes after `stdin_after`.
        fn frames(fake: &Fake, stdin_after: Option<Duration>) -> (Result<()>, Vec<Value>) {
            let (sender, closed) = std::sync::mpsc::channel::<()>();
            match stdin_after {
                Some(after) => {
                    std::thread::spawn(move || {
                        std::thread::sleep(after);
                        drop(sender);
                    });
                }
                None => std::mem::forget(sender),
            }
            let mut out = Vec::new();
            let result = run(&fake.socket, "owned", &mut out, &closed, FAST);
            let frames = String::from_utf8(out)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            (result, frames)
        }
        fn without_heartbeats(frames: Vec<Value>) -> Vec<Value> {
            frames
                .into_iter()
                .filter(|frame| frame["type"] != "heartbeat")
                .collect()
        }

        #[test]
        fn lines_mean_a_status_a_new_pane_set_a_changed_tree_or_nothing() {
            for name in ["pane.agent_status_changed", "pane_agent_status_changed"] {
                let mut line = event("blocked", "w1:p1");
                line["event"] = json!(name);
                assert_eq!(
                    classify(&line).unwrap(),
                    Incoming::Status {
                        pane: "w1:p1".into(),
                        workspace: "w1".into(),
                        status: "blocked".into(),
                        agent: Some("codex".into())
                    }
                );
            }
            for name in [
                "pane_created",
                "pane.closed",
                "pane_agent_detected",
                "workspace_closed",
                "tab_closed",
            ] {
                assert_eq!(
                    classify(&json!({"event":name,"data":{}})).unwrap(),
                    Incoming::Topology,
                    "{name}"
                );
            }
            for name in ["workspace_renamed", "tab.focused", "pane_focused"] {
                assert_eq!(
                    classify(&json!({"event":name,"data":{}})).unwrap(),
                    Incoming::Change,
                    "{name}"
                );
            }
            assert_eq!(
                classify(&json!({"id":"x","result":{}})).unwrap(),
                Incoming::Ignore
            );
            for code in ["events_lost", "pane_not_found"] {
                assert_eq!(
                    classify(&json!({"error":{"code":code}})).unwrap(),
                    Incoming::Topology
                );
            }
            assert!(classify(&json!({"error":{"code":"invalid_request"}})).is_err());
            for bad in [
                json!({"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1; rm","workspace_id":"w1","agent_status":"done"}}),
                json!({"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","workspace_id":"w1","agent_status":"exploding"}}),
                json!({"event":"pane.agent_status_changed","data":{"pane_id":"w1:t1","workspace_id":"w1","agent_status":"done"}}),
            ] {
                assert!(classify(&bad).is_err(), "{bad}");
            }
        }

        #[test]
        fn a_snapshot_yields_valid_panes_with_their_agent_and_nothing_else() {
            let listed = panes(&snapshot(vec![
                pane("w1:p1", "working", Some("codex")),
                pane("w1:p2", "unknown", None),
            ]))
            .unwrap();
            assert_eq!(
                listed[0],
                Pane {
                    id: "w1:p1".into(),
                    workspace: "w1".into(),
                    status: "working".into(),
                    agent: Some("codex".into()),
                    cwd: Some("/work/project".into())
                }
            );
            assert_eq!(listed[1].agent, None);
            let frame = status_frame(
                &listed[0].id,
                &listed[0].workspace,
                &listed[0].status,
                listed[0].agent.as_deref(),
                listed[0].cwd.as_deref(),
            );
            let mut keys: Vec<_> = frame.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            assert_eq!(
                keys,
                ["agent", "cwd", "paneId", "status", "type", "workspaceId"]
            );
            for bad in [
                pane("not a pane", "idle", None),
                pane("w1:p1", "exploding", None),
            ] {
                assert!(panes(&snapshot(vec![bad])).is_err());
            }
        }

        #[test]
        fn a_transition_becomes_one_frame_without_command_text_and_the_end_is_reported() {
            let fake = fake(
                vec![snapshot(vec![
                    pane("w1:p1", "working", Some("codex")),
                    pane("w1:p2", "unknown", None),
                ])],
                started(),
                vec![Box::new(|mut stream| {
                    send(
                        &mut stream,
                        &[
                            event("blocked", "w1:p1"),
                            event("blocked", "w1:p1"),
                            json!({"event":"tab_renamed","data":{}}),
                            event("done", "w1:p1"),
                        ],
                    );
                })],
            );
            let (result, frames) = frames(&fake, None);
            result.unwrap();
            let frames = without_heartbeats(frames);
            let kinds: Vec<_> = frames
                .iter()
                .map(|frame| frame["type"].as_str().unwrap())
                .collect();
            assert_eq!(kinds, ["hello", "status", "changed", "status", "end"]);
            assert_eq!(
                frames[0],
                json!({"type":"hello","protocol":1,"session":"owned"})
            );
            assert_eq!(
                frames[1],
                json!({"type":"status","paneId":"w1:p1","workspaceId":"w1","status":"blocked","agent":"codex","cwd":"/work/project"})
            );
            assert_eq!(frames[3]["status"], "done");
            assert_eq!(frames[4]["reason"], "disconnected");
            let all = serde_json::to_string(&frames).unwrap();
            for secret in ["rm -rf", "private", "secret text", "Codex", "title"] {
                assert!(!all.contains(secret), "{secret} reached the stream");
            }
            // One subscription per pane (shells included) and the tree's lifecycle events.
            let request = fake.subscriptions.lock().unwrap()[0].clone();
            let kinds: Vec<_> = request["params"]["subscriptions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| {
                    (
                        row["type"].as_str().unwrap().to_owned(),
                        row["pane_id"].as_str().map(str::to_owned),
                    )
                })
                .collect();
            assert!(kinds.contains(&("pane.agent_status_changed".into(), Some("w1:p1".into()))));
            assert!(kinds.contains(&("pane.agent_status_changed".into(), Some("w1:p2".into()))));
            assert!(kinds.contains(&("workspace.created".into(), None)));
            assert!(!kinds
                .iter()
                .any(|(kind, _)| kind == "pane.updated" || kind == "workspace.updated"));
        }

        #[test]
        fn a_new_pane_resubscribes_and_a_change_during_the_gap_is_not_lost() {
            let before = snapshot(vec![pane("w1:p1", "working", Some("codex"))]);
            let after = snapshot(vec![
                pane("w1:p1", "blocked", Some("codex")),
                pane("w1:p2", "unknown", None),
            ]);
            let fake = fake(
                // First pass: the list and the post-subscribe list; second pass: both show the new state.
                vec![before.clone(), before, after],
                started(),
                vec![
                    Box::new(|mut stream| {
                        send(&mut stream, &[json!({"event":"pane_created","data":{}})])
                    }),
                    Box::new(|mut stream| {
                        std::thread::sleep(Duration::from_millis(100));
                        send(&mut stream, &[event("done", "w1:p1")]);
                    }),
                ],
            );
            let (result, frames) = frames(&fake, Some(Duration::from_millis(600)));
            result.unwrap();
            let frames = without_heartbeats(frames);
            let statuses: Vec<_> = frames
                .iter()
                .filter(|frame| frame["type"] == "status")
                .map(|frame| frame["status"].as_str().unwrap())
                .collect();
            assert_eq!(statuses, ["blocked", "done"], "{frames:?}");
            assert!(frames.iter().any(|frame| frame["type"] == "changed"));
            let requests = fake.subscriptions.lock().unwrap().clone();
            assert_eq!(requests.len(), 2);
            let panes_of = |request: &Value| {
                request["params"]["subscriptions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|row| row["pane_id"].as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            };
            assert_eq!(panes_of(&requests[0]), ["w1:p1"]);
            assert_eq!(panes_of(&requests[1]), ["w1:p1", "w1:p2"]);
        }

        #[test]
        fn quiet_time_sends_heartbeats_and_closing_stdin_ends_the_stream_silently() {
            let fake = fake(
                vec![snapshot(vec![pane("w1:p1", "idle", Some("codex"))])],
                started(),
                vec![Box::new(|stream| {
                    std::thread::sleep(Duration::from_secs(2));
                    drop(stream);
                })],
            );
            let (result, frames) = frames(&fake, Some(Duration::from_millis(400)));
            result.unwrap();
            assert_eq!(frames[0]["type"], "hello");
            assert!(
                frames
                    .iter()
                    .filter(|frame| frame["type"] == "heartbeat")
                    .count()
                    >= 3
            );
            assert!(
                frames[1..].iter().all(|frame| frame["type"] == "heartbeat"),
                "{frames:?}"
            );
        }

        #[test]
        fn a_server_that_refuses_the_subscription_is_reported_as_unable_to_stream() {
            let refused =
                json!({"id":"lazysh:events","error":{"code":"unknown_method","message":"no"}});
            let fake = fake(
                vec![snapshot(vec![pane("w1:p1", "idle", None)])],
                refused,
                vec![],
            );
            let (result, frames) = frames(&fake, None);
            result.unwrap();
            assert_eq!(
                frames,
                [json!({"type":"unsupported","reason":"events_subscribe"})]
            );
        }

        #[test]
        fn a_flood_of_new_panes_ends_the_stream_as_busy_instead_of_resubscribing_forever() {
            let churn = || -> Script {
                Box::new(|mut stream| {
                    send(&mut stream, &[json!({"event":"pane_created","data":{}})])
                })
            };
            let fake = fake(
                vec![snapshot(vec![pane("w1:p1", "idle", None)])],
                started(),
                (0..40).map(|_| churn()).collect(),
            );
            let (result, frames) = frames(&fake, None);
            result.unwrap();
            assert_eq!(
                frames.last().unwrap(),
                &json!({"type":"end","reason":"busy"})
            );
            assert!(fake.subscriptions.lock().unwrap().len() <= 21);
        }

        #[test]
        fn more_panes_than_the_bound_are_left_to_polling() {
            let rows = (1..=MAX_PANES + 1)
                .map(|index| pane(&format!("w1:p{index}"), "idle", None))
                .collect();
            let fake = fake(vec![snapshot(rows)], started(), vec![]);
            let (result, frames) = frames(&fake, None);
            result.unwrap();
            assert_eq!(
                frames,
                [json!({"type":"unsupported","reason":"too_many_panes"})]
            );
            assert!(fake.subscriptions.lock().unwrap().is_empty());
        }
    }
}
