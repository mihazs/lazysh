//! Explicit input to one named pane of an unchanged stock Herdr (#655), through the companion's pinned actor.
//!
//! `lazysh-agent herdr-pane-input --session NAME` pins the Herdr server process once and refuses any other server that
//! later appears at the same socket path (docs/multiplexers.md). This side keeps that actor on one retained exec channel
//! per displayed session and one destination at a time: `prepare` reads the pane's current occupant, `confirm` re-reads
//! it and mints the receipt, and each `input` spends one operation number before a single `pane.send_input` request is
//! written. A request is never resent. `refused` (nothing was written) keeps the confirmation and the operation number;
//! `retired` (the pinned server is gone), `uncertain` (the acknowledgement is lost), a stale receipt, source, operation
//! or access lease, and the end of the session or the lease retire the confirmation and end the actor, so the caller
//! must confirm a destination again and keeps its draft. Nothing here focuses, resizes, attaches or resumes anything.
use crate::{
    app_lock::AccessLease,
    ssh::{self, quote, AccessResult, AppState, Result, Session, SshError},
    tmux_jump::chat::{Input, Source},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{future::Future, time::Duration};
use tauri::State;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot, watch},
    time::timeout,
};

/// Printed by the `required_command` wrapper when the host has no `herdr-pane-input`.
const COMPANION_REQUIRED: &str = "lazysh-herdr-pane-input-companion-required-v1";
/// Opening the channel, starting the companion and pinning the server.
const START: Duration = Duration::from_secs(15);
/// One request: the actor bounds each of its server steps at 3 s and a send takes two round trips.
const STEP: Duration = Duration::from_secs(25);
const MAX_LINE: usize = 128 * 1024;

fn error(kind: &'static str, message: impl ToString) -> SshError {
    SshError::new(kind, message)
}
fn invalid() -> SshError {
    error(
        "herdr_pane_input_invalid",
        "Unsupported Herdr pane input or destination",
    )
}
fn stale() -> SshError {
    error(
        "herdr_pane_input_stale",
        "Choose and confirm this Herdr pane again",
    )
}
fn busy() -> SshError {
    error(
        "herdr_pane_input_busy",
        "Herdr pane input is already in progress",
    )
}
fn unsupported(reason: &str) -> SshError {
    error("herdr_pane_input_unsupported", reason)
}
/// The pinned server is gone or the actor ended; nothing was written.
fn retired(reason: &str) -> SshError {
    match reason {
        "peer_pidfd_unsupported" => unsupported("kernel_unsupported"),
        _ => error("herdr_pane_input_retired", reason),
    }
}
fn uncertain() -> SshError {
    error(
        "herdr_pane_input_uncertain",
        "Herdr delivery could not be confirmed; it was not resent",
    )
}
/// Herdr or the actor said no before anything was written.
fn refused(reason: &str) -> SshError {
    error("herdr_pane_input_refused", reason)
}

/// The pane's current occupant, as Herdr reports it.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Occupant {
    pane_id: String,
    terminal_id: String,
    focused: Option<bool>,
    agent: Option<String>,
    cwd: Option<String>,
    label: Option<String>,
    title: Option<String>,
}
impl Occupant {
    fn valid(&self, pane: &str) -> bool {
        self.pane_id == pane
            && !self.terminal_id.is_empty()
            && self.terminal_id.len() <= 256
            && !self.terminal_id.chars().any(char::is_control)
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Prepare {
        herdr_session: String,
        pane: String,
        source: Source,
    },
    Confirm {
        candidate: String,
        source: Source,
    },
    Input {
        receipt: String,
        source: Source,
        operation: u32,
        input: Input,
    },
    Release {
        receipt: String,
    },
}
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Prepared {
        candidate: String,
        occupant: Occupant,
    },
    Bound {
        receipt: String,
        occupant: Occupant,
        next_operation: u32,
    },
    Delivered {
        next_operation: u32,
    },
    Released,
}
impl Action {
    fn validate(&self) -> Result<()> {
        let token = |value: &str| value.len() == 36 && uuid::Uuid::parse_str(value).is_ok();
        let pane = |value: &str| lazysh_common::valid_herdr_id(value, Some('p'));
        let source = |source: &Source| source.validate().map_err(|_| invalid());
        match self {
            Self::Prepare {
                herdr_session,
                pane: id,
                source: value,
            } if crate::multiplexer::validate_text(herdr_session, 200, "").is_ok()
                && !herdr_session.starts_with('-')
                && pane(id) =>
            {
                source(value)
            }
            Self::Confirm {
                candidate,
                source: value,
            } if token(candidate) => source(value),
            Self::Release { receipt } if token(receipt) => Ok(()),
            Self::Input {
                receipt,
                source: value,
                operation,
                input,
            } if token(receipt)
                && (1..u32::MAX).contains(operation)
                // Pane input has no paste buffer and no key profile: dialog answers stay in the terminal.
                && matches!(input, Input::Send { .. } | Input::RequestStop)
                && input.validate().is_ok() =>
            {
                source(value)
            }
            _ => Err(invalid()),
        }
    }
}

/// Why one actor exchange produced no outcome.
#[derive(Debug, PartialEq, Eq)]
enum Lost {
    /// The actor is gone and the request was never written.
    Retired(String),
    /// The request may have been written and no intact answer came back; it is never resent.
    Uncertain,
}
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Occupant(Occupant),
    Delivered,
    /// Nothing was written; the actor keeps serving.
    Refused(String),
    /// The pinned server is gone; nothing was written.
    Retired(String),
    /// The write may have happened; the actor ends.
    Uncertain,
}
impl Outcome {
    fn parse(value: &Value, id: u64) -> Option<Self> {
        let reason = || {
            value["reason"]
                .as_str()
                .filter(|reason| (1..=64).contains(&reason.len()))
                .map(str::to_owned)
        };
        if value["id"] != id {
            return None;
        }
        match value["outcome"].as_str()? {
            "occupant" => serde_json::from_value(value["pane"].clone())
                .ok()
                .map(Self::Occupant),
            "delivered" => Some(Self::Delivered),
            "refused" => reason().map(Self::Refused),
            "retired" => reason().map(Self::Retired),
            "uncertain" => Some(Self::Uncertain),
            _ => None,
        }
    }
}

struct Call {
    id: u64,
    line: Vec<u8>,
    reply: oneshot::Sender<std::result::Result<Value, Lost>>,
}
/// The retained exec channel of one `herdr-pane-input` process. Dropping it ends the process.
pub(crate) struct Actor {
    calls: mpsc::Sender<Call>,
}

/// Newline-framed JSON lines. Every partial line stays in the buffer, so a read can be dropped and resumed.
struct Lines<R> {
    reader: R,
    buffer: Vec<u8>,
}
impl<R: AsyncRead + Unpin> Lines<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: Vec::new(),
        }
    }
    /// The next complete line, `None` once the stream ended, or why the framing is broken.
    async fn next(&mut self) -> std::result::Result<Option<Vec<u8>>, &'static str> {
        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
                line.pop();
                return Ok(Some(line));
            }
            if self.buffer.len() > MAX_LINE {
                return Err("malformed_frame");
            }
            let mut chunk = [0u8; 8192];
            match self.reader.read(&mut chunk).await {
                Ok(0) => return Ok(None),
                Ok(read) => self.buffer.extend_from_slice(&chunk[..read]),
                Err(_) => return Err("io_error"),
            }
        }
    }
}
fn json_line(line: &[u8]) -> Option<Value> {
    serde_json::from_slice::<Value>(line)
        .ok()
        .filter(Value::is_object)
}

impl Actor {
    /// Waits for the actor's `ready` event and then serves requests on `stream` until the actor ends. A host that cannot
    /// run it (no companion, an older kernel, another operating system) is `unsupported`, and nothing else is tried.
    pub(crate) async fn start<S>(
        stream: S,
        owner: AccessLease,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Self>
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        if *cancel.borrow() {
            return Err(retired("session_ended"));
        }
        let (reader, writer) = tokio::io::split(stream);
        let mut lines = Lines::new(Box::pin(reader));
        let ready = async {
            let line = match lines.next().await {
                Ok(Some(line)) => line,
                // The command ended before it pinned a server: a host without the command, or without Linux.
                Ok(None) => return Err(unsupported("actor_exited")),
                Err(reason) => return Err(retired(reason)),
            };
            if line == COMPANION_REQUIRED.as_bytes() {
                return Err(unsupported("companion_required"));
            }
            let event = json_line(&line).ok_or_else(|| retired("malformed_frame"))?;
            match (event["event"].as_str(), event["reason"].as_str()) {
                (Some("ready"), _) => Ok(()),
                (Some("retired"), Some(reason)) => Err(retired(reason)),
                _ => Err(retired("malformed_frame")),
            }
        };
        tokio::select! { biased;
            _ = owner.cancelled() => return Err(retired("lease_ended")),
            _ = cancel.changed() => return Err(retired("session_ended")),
            ready = timeout(START, ready) => ready.map_err(|_| retired("start_timeout"))??,
        }
        let (calls, queue) = mpsc::channel(1);
        tauri::async_runtime::spawn(serve(lines, Box::pin(writer), queue, owner, cancel));
        Ok(Self { calls })
    }
    /// One request and its answer. The request is written at most once.
    async fn ask(&self, id: u64, request: Value) -> std::result::Result<Outcome, Lost> {
        let mut line = serde_json::to_vec(&request).map_err(|_| Lost::Retired("invalid".into()))?;
        line.push(b'\n');
        let (reply, answer) = oneshot::channel();
        self.calls
            .send(Call { id, line, reply })
            .await
            .map_err(|_| Lost::Retired("actor_ended".into()))?;
        let value = answer.await.map_err(|_| Lost::Uncertain)??;
        Outcome::parse(&value, id).ok_or(Lost::Uncertain)
    }
}

/// Owns the channel: writes each request, reads its one answer, and ends on any loss. The pending request of a caller
/// that went away is still answered into the void, never applied to a later one.
async fn serve<R, W>(
    mut lines: Lines<R>,
    mut writer: W,
    mut queue: mpsc::Receiver<Call>,
    owner: AccessLease,
    mut cancel: watch::Receiver<bool>,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let reason = loop {
        let call = tokio::select! { biased;
            _ = owner.cancelled() => break "lease_ended".to_owned(),
            _ = cancel.changed() => break "session_ended".to_owned(),
            // Only an event or the end of the stream arrives between requests.
            idle = lines.next() => break match idle {
                Ok(Some(line)) => json_line(&line)
                    .and_then(|event| event["reason"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "malformed_frame".into()),
                Ok(None) => "actor_ended".into(),
                Err(reason) => reason.into(),
            },
            call = queue.recv() => match call {
                Some(call) => call,
                None => break "released".to_owned(),
            },
        };
        let answer = exchange(&mut lines, &mut writer, &call, &owner, &mut cancel).await;
        let end = answer.as_ref().map_or(true, |value| {
            matches!(value["outcome"].as_str(), Some("retired" | "uncertain"))
        });
        let _ = call.reply.send(answer);
        if end {
            break "actor_ended".to_owned();
        }
    };
    queue.close();
    while let Ok(call) = queue.try_recv() {
        let _ = call.reply.send(Err(Lost::Retired(reason.clone())));
    }
    // End of input is what ends the companion.
    let _ = timeout(Duration::from_secs(2), writer.shutdown()).await;
}

async fn exchange<R, W>(
    lines: &mut Lines<R>,
    writer: &mut W,
    call: &Call,
    owner: &AccessLease,
    cancel: &mut watch::Receiver<bool>,
) -> std::result::Result<Value, Lost>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    // From the first byte on, any failure leaves the delivery unconfirmed.
    let work = async {
        writer
            .write_all(&call.line)
            .await
            .map_err(|_| Lost::Uncertain)?;
        writer.flush().await.map_err(|_| Lost::Uncertain)?;
        let line = lines.next().await.ok().flatten().ok_or(Lost::Uncertain)?;
        json_line(&line)
            .filter(|answer| answer["id"] == call.id)
            .ok_or(Lost::Uncertain)
    };
    tokio::select! { biased;
        _ = owner.cancelled() => Err(Lost::Uncertain),
        _ = cancel.changed() => Err(Lost::Uncertain),
        answer = timeout(STEP, work) => answer.unwrap_or(Err(Lost::Uncertain)),
    }
}

/// An actor and the operation ids it has been given: they strictly increase over every request, so a repeated id
/// can never write twice.
struct Wire {
    actor: Actor,
    last: u64,
}
impl Wire {
    async fn ask(
        &mut self,
        request: impl FnOnce(u64) -> Value,
    ) -> std::result::Result<Outcome, Lost> {
        self.last += 1;
        self.actor.ask(self.last, request(self.last)).await
    }
    async fn read(&mut self, pane: &str) -> Result<Occupant> {
        let outcome = self
            .ask(|id| json!({"op":"preflight","id":id,"pane":pane}))
            .await;
        match outcome {
            Ok(Outcome::Occupant(occupant)) if occupant.valid(pane) => Ok(occupant),
            Ok(Outcome::Refused(reason)) => Err(refused(&reason)),
            Ok(Outcome::Retired(reason)) | Err(Lost::Retired(reason)) => Err(retired(&reason)),
            // A read writes nothing, whatever became of its answer.
            Ok(_) | Err(Lost::Uncertain) => Err(retired("unconfirmed")),
        }
    }
}

/// One confirmed or still unconfirmed destination.
pub(crate) struct Control {
    wire: Wire,
    owner: AccessLease,
    token: String,
    source: Source,
    pane: String,
    occupant: Occupant,
    next: u32,
    confirmed: bool,
}
impl Control {
    async fn prepare(
        actor: Actor,
        owner: AccessLease,
        pane: String,
        source: Source,
    ) -> Result<(Self, Reply)> {
        let mut wire = Wire { actor, last: 0 };
        let occupant = wire.read(&pane).await?;
        owner.check().map_err(|_| stale())?;
        let token = uuid::Uuid::new_v4().to_string();
        let reply = Reply::Prepared {
            candidate: token.clone(),
            occupant: occupant.clone(),
        };
        Ok((
            Self {
                wire,
                owner,
                token,
                source,
                pane,
                occupant,
                next: 1,
                confirmed: false,
            },
            reply,
        ))
    }
    /// Reads the pane again: the occupant the user was shown must still be the one there.
    async fn confirm(mut self, source: &Source) -> Result<(Self, Reply)> {
        if self.confirmed || self.source != *source {
            return Err(stale());
        }
        self.owner.check().map_err(|_| stale())?;
        let occupant = self.wire.read(&self.pane).await?;
        if occupant.terminal_id != self.occupant.terminal_id {
            return Err(stale());
        }
        self.owner.check().map_err(|_| stale())?;
        self.token = uuid::Uuid::new_v4().to_string();
        self.confirmed = true;
        let reply = Reply::Bound {
            receipt: self.token.clone(),
            occupant: occupant.clone(),
            next_operation: 1,
        };
        self.occupant = occupant;
        Ok((self, reply))
    }
    /// The control comes back only when the confirmation still stands.
    async fn input(
        mut self,
        source: &Source,
        operation: u32,
        input: &Input,
    ) -> (Option<Self>, Result<Reply>) {
        if !self.confirmed
            || self.source != *source
            || self.next != operation
            || self.owner.check().is_err()
        {
            return (None, Err(stale()));
        }
        let (pane, terminal) = (self.pane.clone(), self.occupant.terminal_id.clone());
        let outcome = self
            .wire
            .ask(|id| match input {
                Input::Send { text } => {
                    json!({"op":"send","id":id,"pane":pane,"terminal":terminal,"text":text})
                }
                _ => json!({"op":"escape","id":id,"pane":pane,"terminal":terminal}),
            })
            .await;
        // The access lease may have ended while the request was out: nothing can be reported as confirmed.
        let outcome = match self.owner.check() {
            Ok(()) => outcome,
            Err(_) => Err(Lost::Uncertain),
        };
        match outcome {
            Ok(Outcome::Delivered) => {
                self.next += 1;
                let reply = Reply::Delivered {
                    next_operation: self.next,
                };
                (Some(self), Ok(reply))
            }
            // Herdr said no before writing. A pane that is gone or now holds another terminal is no destination any more.
            Ok(Outcome::Refused(reason)) => match reason.as_str() {
                "occupant_changed" | "pane_not_found" => (None, Err(stale())),
                _ => (Some(self), Err(refused(&reason))),
            },
            Ok(Outcome::Retired(reason)) | Err(Lost::Retired(reason)) => {
                (None, Err(retired(&reason)))
            }
            Ok(Outcome::Occupant(_) | Outcome::Uncertain) | Err(Lost::Uncertain) => {
                (None, Err(uncertain()))
            }
        }
    }
}

/// The destination of one displayed session; at most one actor runs, and a second call meanwhile is `busy`.
#[derive(Default)]
pub(crate) struct Slot(tokio::sync::Mutex<Option<Control>>);

async fn drive<F, Open>(
    slot: &mut Option<Control>,
    lease: &AccessLease,
    action: Action,
    open: F,
) -> Result<Reply>
where
    F: FnOnce(String) -> Open,
    Open: Future<Output = Result<Actor>>,
{
    let current = |slot: &Option<Control>, token: &str| {
        slot.as_ref()
            .is_some_and(|control| control.token == token)
            .then_some(())
            .ok_or_else(stale)
    };
    // A control is taken out while it works and put back only when its confirmation stands: a caller that goes away
    // mid-request drops it, which ends the actor and retires the destination.
    match action {
        Action::Prepare {
            herdr_session,
            pane,
            source,
        } => {
            *slot = None;
            let actor = open(herdr_session).await?;
            let (control, reply) = Control::prepare(actor, lease.clone(), pane, source).await?;
            *slot = Some(control);
            Ok(reply)
        }
        Action::Confirm { candidate, source } => {
            current(slot, &candidate)?;
            let (control, reply) = slot.take().ok_or_else(stale)?.confirm(&source).await?;
            *slot = Some(control);
            Ok(reply)
        }
        Action::Input {
            receipt,
            source,
            operation,
            input,
        } => {
            current(slot, &receipt)?;
            let (control, reply) = slot
                .take()
                .ok_or_else(stale)?
                .input(&source, operation, &input)
                .await;
            *slot = control;
            reply
        }
        Action::Release { receipt } => {
            if current(slot, &receipt).is_ok() {
                *slot = None;
            }
            Ok(Reply::Released)
        }
    }
}

async fn open(session: &Session, lease: &AccessLease, name: &str) -> Result<Actor> {
    let unix = crate::herdr_path::admit(session, lease).await?;
    let command = crate::companion::required_command(
        session,
        format!("lazysh-agent herdr-pane-input --session {}", quote(name)),
        COMPANION_REQUIRED,
        lease,
    )
    .await?;
    let deadline = tokio::time::Instant::now() + START;
    let channel = ssh::open_owned_channel(&session.handle, lease, deadline).await?;
    timeout(
        START,
        channel.exec(true, crate::herdr_path::select(&command, unix)),
    )
    .await
    .map_err(|_| error("timeout", "Starting Herdr pane input timed out"))?
    .map_err(SshError::from)?;
    Actor::start(
        channel.into_stream(),
        lease.clone(),
        session.cancel.subscribe(),
    )
    .await
}

#[tauri::command]
pub async fn herdr_pane_input(
    lease: AccessLease,
    session_id: String,
    action: Action,
    state: State<'_, AppState>,
) -> AccessResult<Reply> {
    lease
        .run(async {
            lease.check()?;
            action.validate()?;
            let session = state.session(&session_id).await?;
            let mut slot = session
                .bindings
                .herdr_pane_input
                .0
                .try_lock()
                .map_err(|_| busy())?;
            drive(&mut slot, &lease, action, |name| {
                let (session, lease) = (&session, &lease);
                async move { open(session, lease, &name).await }
            })
            .await
        })
        .await
}

#[cfg(test)]
#[path = "herdr_pane_input_tests.rs"]
mod tests;
