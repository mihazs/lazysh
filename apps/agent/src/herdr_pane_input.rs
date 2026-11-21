//! Explicit input to one named pane of an unchanged stock Herdr server, bound to the server process the user confirmed.
//!
//! Stock Herdr offers `pane.send_input` but nothing that proves a socket path still belongs to the server that was
//! confirmed. This actor keeps one read-only `events.subscribe` connection open and the pidfd of its peer. Every
//! operation then opens its own connection and checks that its peer is that same process before one request byte is
//! written. Replacement, restart, the end of the subscription or any doubt retires the epoch for good: no
//! rediscovery, no retry. An acknowledgement that never arrives after the write is `uncertain` and is never resent.
//!
//! The public API has no terminal-ID/revision compare-and-swap, so the destination is the pane's current occupant:
//! the terminal id read by `pane.get` immediately before the write must still be the one the user confirmed, and a
//! runtime replaced in the instant between that read and the write is the one window left open.
//!
//! Protocol, one JSON object per line. The actor answers `{"event":"ready"}` once pinned, then every request with
//! `{"id":N,"outcome":...}`; ids must strictly increase. Requests:
//! `{"op":"preflight","id":N,"pane":"w1:p2"}` reads the occupant, and `{"op":"send","id":N,"pane":..,"terminal":..,
//! "text":..}` types the text plus Enter, `{"op":"escape","id":N,"pane":..,"terminal":..}` presses Escape.
//! Outcomes: `occupant`, `delivered`, `refused` (nothing was written), `uncertain` and `retired`; the last two end
//! the actor, as does `{"event":"retired"}`. Closing stdin ends it quietly. Linux 6.5 or newer only.
use crate::{Error, Result};

#[cfg(target_os = "linux")]
mod peer;

#[cfg(not(target_os = "linux"))]
pub fn run_stdio(_session: &str) -> Result<()> {
    Err(Error::Herdr("HerdrInputPlatformUnsupported"))
}

#[cfg(target_os = "linux")]
pub use actor::run_stdio;

#[cfg(target_os = "linux")]
mod actor {
    use super::{peer, Error, Result};
    use serde::Deserialize;
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        sync::{atomic::AtomicBool, Arc},
        time::Duration,
    };
    use tokio::{
        io::{
            unix::AsyncFd, AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt,
            BufReader, Interest,
        },
        net::UnixStream,
        sync::watch,
        time::timeout,
    };

    const MAX_TEXT: usize = 4096;
    const MAX_LINE: usize = 64 * 1024;
    const MAX_REPLY: usize = 1024 * 1024;
    const MAX_OPERATION: u64 = (1 << 53) - 1;
    /// One server round trip step: connect, write, or read one reply.
    const STEP: Duration = Duration::from_secs(3);

    #[derive(Deserialize)]
    #[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
    enum Request {
        Preflight {
            id: u64,
            pane: String,
        },
        Send {
            id: u64,
            pane: String,
            terminal: String,
            text: String,
        },
        Escape {
            id: u64,
            pane: String,
            terminal: String,
        },
    }
    impl Request {
        fn id(&self) -> u64 {
            match self {
                Self::Preflight { id, .. } | Self::Send { id, .. } | Self::Escape { id, .. } => *id,
            }
        }
        fn valid(&self) -> bool {
            let (pane, terminal, text) = match self {
                Self::Preflight { pane, .. } => (pane, None, None),
                Self::Send {
                    pane,
                    terminal,
                    text,
                    ..
                } => (pane, Some(terminal), Some(text)),
                Self::Escape { pane, terminal, .. } => (pane, Some(terminal), None),
            };
            lazysh_common::valid_herdr_id(pane, Some('p'))
                && terminal.is_none_or(|terminal| {
                    !terminal.is_empty()
                        && terminal.len() <= 256
                        && !terminal.chars().any(char::is_control)
                })
                && text.is_none_or(|text| chat_text(text))
        }
    }

    /// The draft bound of guarded Herdr input: 1 to 4,096 bytes, newline and tab the only control characters.
    fn chat_text(text: &str) -> bool {
        let plain = |character: char| {
            !matches!(character, '\u{2028}' | '\u{2029}')
                && (!character.is_control() || "\n\t".contains(character))
        };
        (1..=MAX_TEXT).contains(&text.len()) && text.chars().all(plain)
    }

    enum Outcome {
        Occupant(Value),
        Delivered,
        /// Nothing was written.
        Refused(&'static str),
        /// The epoch is gone and nothing was written.
        Retired(&'static str),
        /// The write may have happened; it is never repeated.
        Uncertain,
    }
    impl Outcome {
        fn line(&self, id: u64) -> Value {
            match self {
                Self::Occupant(pane) => json!({"id":id,"outcome":"occupant","pane":pane}),
                Self::Delivered => json!({"id":id,"outcome":"delivered"}),
                Self::Refused(reason) => json!({"id":id,"outcome":"refused","reason":reason}),
                Self::Retired(reason) => json!({"id":id,"outcome":"retired","reason":reason}),
                Self::Uncertain => json!({"id":id,"outcome":"uncertain"}),
            }
        }
        fn ends_epoch(&self) -> bool {
            matches!(self, Self::Retired(_) | Self::Uncertain)
        }
    }

    /// Why one server call did not produce a reply.
    enum Fail {
        /// The epoch is lost; nothing was written.
        Retire(&'static str),
        /// Herdr answered with this error code, which proves nothing was written.
        Host(String),
        /// The request went out and the answer did not come back intact.
        Unconfirmed,
    }

    /// What identifies one process: pid, start time and whether it still runs.
    struct Facts {
        pid: i32,
        ticks: Option<u64>,
        exited: bool,
    }
    impl Facts {
        fn read(peer: &peer::Peer) -> Self {
            Self {
                pid: peer.pid,
                ticks: peer::start_ticks(peer.pid),
                exited: peer::exited(&peer.pidfd),
            }
        }
        /// Two live observations are one process only when pid and start time both agree.
        fn same(&self, other: &Self) -> bool {
            !self.exited
                && !other.exited
                && self.pid == other.pid
                && self.ticks.is_some()
                && self.ticks == other.ticks
        }
    }

    struct Epoch {
        path: PathBuf,
        pinned: peer::Peer,
        ticks: Option<u64>,
        lost: watch::Receiver<Option<&'static str>>,
    }

    async fn read_line<R: AsyncBufRead + Unpin>(
        reader: &mut R,
        maximum: usize,
    ) -> std::result::Result<Option<Vec<u8>>, &'static str> {
        let mut line = Vec::new();
        let read = (&mut *reader)
            .take(maximum as u64 + 1)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| "io_error")?;
        if read == 0 {
            return Ok(None);
        }
        // A line that ends the stream or outgrows the bound is malformed framing.
        if line.pop() != Some(b'\n') {
            return Err("malformed_frame");
        }
        Ok(Some(line))
    }
    async fn emit<W: AsyncWrite + Unpin>(output: &mut W, value: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(value).map_err(|_| Error::InvalidEvent)?;
        line.push(b'\n');
        output.write_all(&line).await?;
        output.flush().await?;
        Ok(())
    }
    fn request_line(id: &str, method: &str, params: &Value) -> Vec<u8> {
        let mut line = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
            .unwrap_or_default();
        line.push(b'\n');
        line
    }
    async fn connect(path: &PathBuf) -> Option<UnixStream> {
        timeout(STEP, UnixStream::connect(path)).await.ok()?.ok()
    }
    /// Reads one reply and returns its `result`, or the code of its `error`.
    async fn reply<R: AsyncBufRead + Unpin>(
        reader: &mut R,
        id: &str,
    ) -> std::result::Result<Value, Fail> {
        let line = timeout(STEP, read_line(reader, MAX_REPLY))
            .await
            .ok()
            .and_then(std::result::Result::ok)
            .flatten()
            .ok_or(Fail::Unconfirmed)?;
        let value: Value = serde_json::from_slice(&line).map_err(|_| Fail::Unconfirmed)?;
        if value.get("id").and_then(Value::as_str) != Some(id) {
            return Err(Fail::Unconfirmed);
        }
        if let Some(error) = value.get("error") {
            let code = error.get("code").and_then(Value::as_str);
            return Err(Fail::Host(code.unwrap_or("unknown").to_owned()));
        }
        value.get("result").cloned().ok_or(Fail::Unconfirmed)
    }

    impl Epoch {
        /// Connects, takes the server's pidfd from that connection and keeps a read-only subscription open.
        async fn pin(path: PathBuf) -> std::result::Result<Self, &'static str> {
            let stream = connect(&path).await.ok_or("server_unreachable")?;
            let pinned = peer::of(&stream)?;
            let mut stream = BufReader::new(stream);
            let request = request_line(
                "lazysh:pane-input:subscribe",
                "events.subscribe",
                &json!({"subscriptions":[{"type":"pane.closed"}]}),
            );
            timeout(STEP, stream.get_mut().write_all(&request))
                .await
                .map_err(|_| "server_unreachable")?
                .map_err(|_| "server_unreachable")?;
            let started = reply(&mut stream, "lazysh:pane-input:subscribe").await;
            if !started.is_ok_and(|result| {
                result.get("type").and_then(Value::as_str) == Some("subscription_started")
            }) {
                return Err("subscription_refused");
            }
            // Start-time metadata is read between two liveness checks of the retained pidfd.
            let alive = !peer::exited(&pinned.pidfd);
            let ticks = peer::start_ticks(pinned.pid);
            if !alive || ticks.is_none() || peer::exited(&pinned.pidfd) {
                return Err("server_exited");
            }
            let duplicate = pinned.pidfd.try_clone().map_err(|_| "peer_unavailable")?;
            // SAFETY: `duplicate` is an owned, open descriptor that stays open as long as the `AsyncFd` owns it.
            let watched = unsafe { AsyncFd::register_with_interest(duplicate, Interest::READABLE) }
                .map_err(|_| "peer_unavailable")?;
            let (sender, lost) = watch::channel(None);
            tokio::spawn(async move {
                let reason = tokio::select! {
                    _ = watched.readable() => "server_exited",
                    reason = drain(stream) => reason,
                };
                let _ = sender.send(Some(reason));
            });
            Ok(Self {
                path,
                pinned,
                ticks,
                lost,
            })
        }

        /// One request on a fresh connection whose peer was proven to be the pinned process before any byte left.
        async fn call(
            &self,
            id: &str,
            method: &str,
            params: &Value,
        ) -> std::result::Result<Value, Fail> {
            if let Some(reason) = *self.lost.borrow() {
                return Err(Fail::Retire(reason));
            }
            let stream = connect(&self.path)
                .await
                .ok_or(Fail::Retire("server_unreachable"))?;
            let candidate = peer::of(&stream).map_err(Fail::Retire)?;
            let pinned = Facts {
                pid: self.pinned.pid,
                ticks: self.ticks,
                exited: peer::exited(&self.pinned.pidfd),
            };
            if !pinned.same(&Facts::read(&candidate)) {
                return Err(Fail::Retire("server_replaced"));
            }
            let mut stream = BufReader::new(stream);
            let written = timeout(
                STEP,
                stream
                    .get_mut()
                    .write_all(&request_line(id, method, params)),
            )
            .await;
            if !written.is_ok_and(|result| result.is_ok()) {
                return Err(Fail::Unconfirmed);
            }
            reply(&mut stream, id).await
        }

        /// The pane's current occupant, as Herdr reports it right now.
        async fn occupant(&self, id: &str, pane: &str) -> std::result::Result<Value, Fail> {
            let result = self
                .call(id, "pane.get", &json!({"pane_id":pane}))
                .await
                // A read cannot have written anything, whatever became of its answer.
                .map_err(|fail| match fail {
                    Fail::Unconfirmed => Fail::Host("occupant_unconfirmed".into()),
                    other => other,
                })?;
            let info = result.get("pane").filter(|info| {
                result.get("type").and_then(Value::as_str) == Some("pane_info")
                    && info.get("pane_id").and_then(Value::as_str) == Some(pane)
                    && info
                        .get("terminal_id")
                        .and_then(Value::as_str)
                        .is_some_and(|terminal| !terminal.is_empty())
            });
            let Some(info) = info else {
                return Err(Fail::Host("occupant_unconfirmed".into()));
            };
            let text = |key: &str| {
                info.get(key)
                    .and_then(Value::as_str)
                    .map(|value| value.chars().take(512).collect::<String>())
            };
            Ok(json!({
                "paneId": pane,
                "terminalId": text("terminal_id"),
                "focused": info.get("focused").and_then(Value::as_bool),
                "agent": text("agent"),
                "cwd": text("cwd"),
                "label": text("label"),
                "title": text("title"),
            }))
        }
    }

    /// Reads and discards the subscription's events; any end or malformed frame ends the epoch.
    async fn drain(mut subscription: BufReader<UnixStream>) -> &'static str {
        loop {
            match read_line(&mut subscription, MAX_REPLY).await {
                Ok(Some(line))
                    if serde_json::from_slice::<Value>(&line)
                        .is_ok_and(|event| event.is_object()) => {}
                Ok(None) => return "subscription_closed",
                _ => return "subscription_malformed",
            }
        }
    }

    fn refused(fail: Fail) -> Outcome {
        match fail {
            Fail::Retire(reason) => Outcome::Retired(reason),
            Fail::Host(code) => Outcome::Refused(match code.as_str() {
                "pane_not_found" => "pane_not_found",
                "occupant_unconfirmed" => "occupant_unconfirmed",
                "pane_send_failed" => "pane_send_failed",
                "invalid_key" => "invalid_key",
                _ => "server_refused",
            }),
            Fail::Unconfirmed => Outcome::Refused("occupant_unconfirmed"),
        }
    }

    async fn execute(epoch: &Epoch, request: &Request) -> Outcome {
        let id = format!("lazysh:pane-input:{}", request.id());
        let (pane, terminal, input) = match request {
            Request::Preflight { pane, .. } => {
                return match epoch.occupant(&id, pane).await {
                    Ok(occupant) => Outcome::Occupant(occupant),
                    Err(fail) => refused(fail),
                };
            }
            Request::Send {
                pane,
                terminal,
                text,
                ..
            } => (
                pane,
                terminal,
                json!({"pane_id":pane,"text":text,"keys":["enter"]}),
            ),
            Request::Escape { pane, terminal, .. } => {
                (pane, terminal, json!({"pane_id":pane,"keys":["esc"]}))
            }
        };
        match epoch.occupant(&id, pane).await {
            Ok(occupant) if occupant["terminalId"].as_str() == Some(terminal) => {}
            Ok(_) => return Outcome::Refused("occupant_changed"),
            Err(fail) => return refused(fail),
        }
        match epoch.call(&id, "pane.send_input", &input).await {
            Ok(result) if result.get("type").and_then(Value::as_str) == Some("ok") => {
                Outcome::Delivered
            }
            Ok(_) | Err(Fail::Unconfirmed) => Outcome::Uncertain,
            Err(fail) => refused(fail),
        }
    }

    async fn retire<W: AsyncWrite + Unpin>(output: &mut W, reason: &str) -> Result<()> {
        emit(output, &json!({"event":"retired","reason":reason})).await?;
        Err(Error::Herdr("HerdrInputRetired"))
    }

    pub(super) async fn run<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
        path: PathBuf,
        mut input: R,
        mut output: W,
    ) -> Result<()> {
        let epoch = match Epoch::pin(path).await {
            Ok(epoch) => epoch,
            Err(reason) => return retire(&mut output, reason).await,
        };
        emit(
            &mut output,
            &json!({"event":"ready","pid":epoch.pinned.pid,"startTicks":epoch.ticks}),
        )
        .await?;
        let mut lost = epoch.lost.clone();
        let mut last = 0;
        loop {
            if let Some(reason) = *lost.borrow() {
                return retire(&mut output, reason).await;
            }
            let line = tokio::select! {
                biased;
                changed = lost.changed() => {
                    if changed.is_err() {
                        return retire(&mut output, "watcher_stopped").await;
                    }
                    continue;
                }
                line = read_line(&mut input, MAX_LINE) => line,
            };
            let line = match line {
                Ok(Some(line)) => line,
                Ok(None) => return Ok(()),
                Err(reason) => return retire(&mut output, reason).await,
            };
            let Ok(request) = serde_json::from_slice::<Request>(&line) else {
                return retire(&mut output, "malformed_request").await;
            };
            let id = request.id();
            let outcome = if id <= last || id > MAX_OPERATION {
                Outcome::Refused("stale_operation")
            } else if !request.valid() {
                Outcome::Refused("invalid_request")
            } else {
                // The id is spent before anything is sent, so a repeat can never write twice.
                last = id;
                execute(&epoch, &request).await
            };
            emit(&mut output, &outcome.line(id)).await?;
            if outcome.ends_epoch() {
                return Err(Error::Herdr("HerdrInputRetired"));
            }
        }
    }

    pub fn run_stdio(session: &str) -> Result<()> {
        let socket = crate::herdr::running_endpoint(session, Arc::new(AtomicBool::new(false)))
            .map_err(|_| Error::Herdr("HerdrInputSessionUnavailable"))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(run(
            PathBuf::from(socket),
            BufReader::new(tokio::io::stdin()),
            tokio::io::stdout(),
        ));
        // A pending stdin read must not hold the exit of a retired actor.
        runtime.shutdown_background();
        result
    }
    #[cfg(test)]
    mod tests {
        use super::*;

        fn facts(pid: i32, ticks: Option<u64>, exited: bool) -> Facts {
            Facts { pid, ticks, exited }
        }
        #[test]
        fn only_a_live_process_with_the_same_pid_and_start_time_is_the_pinned_one() {
            let pinned = facts(7, Some(100), false);
            assert!(pinned.same(&facts(7, Some(100), false)));
            // A restarted server may get the old pid number back, but never the old start time.
            assert!(!pinned.same(&facts(7, Some(101), false)));
            assert!(!pinned.same(&facts(8, Some(100), false)));
            assert!(!pinned.same(&facts(7, None, false)));
            assert!(!facts(7, None, false).same(&facts(7, None, false)));
            assert!(!pinned.same(&facts(7, Some(100), true)));
            assert!(!facts(7, Some(100), true).same(&pinned));
        }
        #[tokio::test]
        async fn frames_are_bounded_and_an_unterminated_line_is_malformed() {
            let mut reader = &b"{\"a\":1}\nsecond\n"[..];
            assert_eq!(
                read_line(&mut reader, 16).await,
                Ok(Some(b"{\"a\":1}".to_vec()))
            );
            assert_eq!(
                read_line(&mut reader, 16).await,
                Ok(Some(b"second".to_vec()))
            );
            assert_eq!(read_line(&mut reader, 16).await, Ok(None));
            assert_eq!(
                read_line(&mut &b"no newline"[..], 16).await,
                Err("malformed_frame")
            );
            assert_eq!(
                read_line(&mut &b"0123456789\n"[..], 9).await,
                Err("malformed_frame")
            );
            assert_eq!(
                read_line(&mut &b"012345678\n"[..], 9).await,
                Ok(Some(b"012345678".to_vec()))
            );
        }
    }
}
