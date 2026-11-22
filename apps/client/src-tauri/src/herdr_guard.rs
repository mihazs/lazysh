//! Private authority for one original Herdr display. No provider identity is inferred.
use crate::{
    app_lock::AccessLease,
    ssh::{self, AccessResult, AppState, OwnedChannel, Result, SshError, SshHandle},
    tmux_jump::chat::{Input, Source},
};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(desktop)]
use std::io;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::State;
use tokio::sync::{mpsc, oneshot, watch, Notify};
use zeroize::{Zeroize, Zeroizing};

const LIMIT: usize = 32768;
const FRAME_BODY: usize = 512;
const STARTUP_LIMIT: usize = PREFIX.len() + 9 + FRAME_BODY + 1 + ssh::OUTPUT_WINDOW as usize;
const PREFIX: &[u8] = b"\x1eLAZYSH-GUARD-1:";
const DEADLINE: Duration = Duration::from_secs(3);
const MAX_OPERATION: u64 = (1u64 << 53) - 1;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(try_from = "String")]
struct Secret(String);
impl TryFrom<String> for Secret {
    type Error = &'static str;
    fn try_from(value: String) -> std::result::Result<Self, Self::Error> {
        if lazysh_common::valid_sha256(&value) {
            Ok(Self(value))
        } else {
            Err("guard_invalid")
        }
    }
}
impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Target {
    workspace: String,
    tab: String,
    pane: String,
    terminal: String,
    runtime_generation: u64,
    viewport: Viewport,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
}
impl Target {
    fn valid(&self) -> bool {
        lazysh_common::valid_guarded_target(
            [&self.workspace, &self.tab, &self.pane, &self.terminal],
            self.runtime_generation,
            self.viewport.width,
            self.viewport.height,
        )
    }
    fn public(&self) -> Destination {
        Destination {
            workspace: self.workspace.clone(),
            tab: self.tab.clone(),
            pane: self.pane.clone(),
            terminal: self.terminal.clone(),
            runtime_generation: self.runtime_generation.to_string(),
            viewport: self.viewport.clone(),
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Destination {
    workspace: String,
    tab: String,
    pane: String,
    terminal: String,
    // A remote u64 must never lose precision in a renderer number.
    runtime_generation: String,
    viewport: Viewport,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Ticket {
    boot: Secret,
    ticket: Secret,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    boot: Secret,
    ownership: Secret,
    last_preparation: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prepared {
    boot: Secret,
    receipt: Secret,
    target: Target,
    preparation: u64,
    source: String,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WireResult {
    Ok {},
    GuardClaimed { owner: Owner },
    GuardPrepared { guard: Prepared },
    GuardObserved { guard: Observed },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Observed {
    target: Target,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Success {
    id: String,
    result: WireResult,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Failure {
    id: String,
    error: WireError,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireError {
    code: String,
    message: String,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Envelope {
    Success(Success),
    Failure(Failure),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    Invalid,
    Stale,
    Busy,
    Unavailable,
    Uncertain,
    Protocol,
}
impl Fault {
    fn error(self) -> SshError {
        let (kind, message) = match self {
            Self::Invalid => (
                "herdr_chat_invalid",
                "Unsupported Herdr terminal input or context",
            ),
            Self::Stale => (
                "herdr_chat_stale",
                "Inspect and confirm this Herdr destination again",
            ),
            Self::Busy => (
                "herdr_chat_busy",
                "Herdr terminal input is already in progress",
            ),
            Self::Uncertain => (
                "herdr_chat_uncertain",
                "Herdr delivery could not be confirmed; it was not resent",
            ),
            _ => (
                "herdr_chat_unavailable",
                "This display has no usable original Herdr input binding",
            ),
        };
        SshError::new(kind, message)
    }
}
type WireOutcome<T> = std::result::Result<T, Fault>;

fn response(status: Option<u32>, output: &[u8], errors: &[u8]) -> WireOutcome<WireResult> {
    let bytes = match status {
        Some(0) if errors.is_empty() => output,
        Some(1) if output.is_empty() => errors,
        _ => return Err(Fault::Protocol),
    };
    if bytes.len() > LIMIT {
        return Err(Fault::Protocol);
    }
    match serde_json::from_slice::<Envelope>(bytes).map_err(|_| Fault::Protocol)? {
        Envelope::Success(reply) if status == Some(0) && reply.id == "guard" => Ok(reply.result),
        Envelope::Failure(reply)
            if status == Some(1)
                && reply.id == "guard"
                && reply.error.code == reply.error.message =>
        {
            Err(match reply.error.code.as_str() {
                "guard_invalid" => Fault::Invalid,
                "guard_stale" => Fault::Stale,
                "guard_busy" => Fault::Busy,
                "guard_unavailable" => Fault::Unavailable,
                "guard_uncertain" => Fault::Uncertain,
                _ => Fault::Protocol,
            })
        }
        _ => Err(Fault::Protocol),
    }
}

/// The argument that makes a Herdr client hand its private first frame to the one that owns it.
pub(crate) const GUARDED_ATTACH: &str = "--guarded-attach";
fn command(name: &str, guarded_attach: bool) -> String {
    format!(
        "herdr --session {} {}",
        ssh::quote(name),
        if guarded_attach {
            GUARDED_ATTACH
        } else {
            "api guarded"
        }
    )
}
pub(crate) fn attach_command(name: &str) -> String {
    command(name, true)
}
/// The Mosh startup command, for a host the caller already identified as POSIX.
pub(crate) fn attach_receipt(
    backend: crate::herdr_backend::HerdrBackend,
    name: &str,
) -> Result<String> {
    backend.wrap(
        &format!(
            "herdr --session {} --guarded-attach --startup-fd 3",
            ssh::quote(name)
        ),
        true,
    )
}
fn startup_fd_capability(output: &str) -> bool {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Capabilities {
        schema_version: u8,
        startup_fd: bool,
    }
    serde_json::from_str::<Capabilities>(output)
        .ok()
        .is_some_and(|value| value.schema_version == 1 && value.startup_fd)
}
pub(crate) async fn require_startup_fd(session: &ssh::Session, lease: &AccessLease) -> Result<()> {
    let output = ssh::exec_bounded(
        session,
        crate::herdr_backend::captured(&session.handle)
            .wrap("herdr --guarded-attach-capabilities", true)?,
        lease,
        DEADLINE,
        256,
        None,
    )
    .await;
    lease.check()?;
    if output
        .ok()
        .is_some_and(|value| startup_fd_capability(&value))
    {
        return Ok(());
    }
    Err(SshError::new("herdr_guard_startup_unsupported", "This guarded Herdr client cannot supply a private Mosh startup receipt. Update the compatible guarded host client or explicitly choose SSH."))
}
#[derive(Serialize)]
struct Request<'a, T> {
    id: &'static str,
    method: &'static str,
    params: &'a T,
}

async fn response_before(
    deadline: tokio::time::Instant,
    work: impl std::future::Future<Output = WireOutcome<WireResult>>,
) -> WireOutcome<WireResult> {
    let result = tokio::time::timeout_at(deadline, work)
        .await
        .unwrap_or(Err(Fault::Uncertain));
    // timeout_at polls a ready inner future first. A resumed worker must still
    // reject a completed response observed at/after its absolute deadline.
    if tokio::time::Instant::now() >= deadline {
        Err(Fault::Uncertain)
    } else {
        result
    }
}

/// Where the guard reaches a Herdr: the SSH host's, or this device's.
#[derive(Clone)]
pub(crate) enum Route {
    Ssh(Arc<SshHandle>),
    #[cfg(desktop)]
    Local(Local),
}
/// Herdr on this device. Only tests carry state: the environment of a private home.
#[cfg(desktop)]
#[derive(Clone, Default)]
pub(crate) struct Local {
    #[cfg(test)]
    pub(crate) env: Vec<(String, String)>,
}

/// One owned exec per RPC. A canceled waiter cannot leave a reusable partial stream.
async fn rpc<T: Serialize>(
    route: &Route,
    name: &str,
    lease: &AccessLease,
    cancel: &mut watch::Receiver<bool>,
    method: &'static str,
    params: &T,
    reply: &mut Option<&mut oneshot::Sender<Result<Reply>>>,
) -> WireOutcome<WireResult> {
    lease.check().map_err(|_| Fault::Stale)?;
    if *cancel.borrow() {
        return Err(Fault::Unavailable);
    }
    let deadline = tokio::time::Instant::now() + DEADLINE;
    let body = Zeroizing::new(
        serde_json::to_vec(&Request {
            id: "guard",
            method,
            params,
        })
        .map_err(|_| Fault::Invalid)?,
    );
    if body.len() > LIMIT {
        return Err(Fault::Invalid);
    }
    // Boxed: every caller embeds this future, and both exchanges inline would overflow the
    // stack of a debug test thread that awaits an attach.
    match route {
        Route::Ssh(handle) => {
            Box::pin(ssh_exchange(
                handle, name, lease, cancel, &body, deadline, reply,
            ))
            .await
        }
        #[cfg(desktop)]
        Route::Local(local) => {
            let work = Box::pin(local_exchange(local, name, &body, lease));
            settle(lease, cancel, reply, deadline, work).await
        }
    }
}
async fn ssh_exchange(
    handle: &Arc<SshHandle>,
    name: &str,
    lease: &AccessLease,
    cancel: &mut watch::Receiver<bool>,
    body: &[u8],
    deadline: tokio::time::Instant,
    reply: &mut Option<&mut oneshot::Sender<Result<Reply>>>,
) -> WireOutcome<WireResult> {
    // The connection's captured Herdr, never another one, runs every owned RPC.
    let command = crate::herdr_backend::resolve_cached(handle, &command(name, false))
        .map_err(|_| Fault::Unavailable)?;
    let mut channel = tokio::select! { biased;
        _ = cancel.changed() => return Err(Fault::Unavailable),
        _ = abandoned(reply) => return Err(Fault::Stale),
        result = ssh::open_owned_channel(handle, lease, deadline) => result.map_err(|_| Fault::Unavailable)?,
    };
    let work = async {
        lease.check().map_err(|_| Fault::Stale)?;
        channel
            .exec(true, command)
            .await
            .map_err(|_| Fault::Unavailable)?;
        lease.check().map_err(|_| Fault::Stale)?;
        channel.data(body).await.map_err(|_| Fault::Uncertain)?;
        channel.eof().await.map_err(|_| Fault::Uncertain)?;
        let mut output = Zeroizing::new(Vec::new());
        let mut errors = Zeroizing::new(Vec::new());
        let mut status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => output.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => errors.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
            if output.len() + errors.len() > LIMIT {
                return Err(Fault::Protocol);
            }
        }
        response(status, &output, &errors)
    };
    let outcome = settle(lease, cancel, reply, deadline, work).await;
    if outcome.is_err() {
        // Only this owned, private CLI process is signalled, never the display/server.
        let _ =
            tokio::time::timeout(Duration::from_secs(1), channel.signal(russh::Sig::TERM)).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
    outcome
}
/// The exchange ends at the first of: access revoked, session closed, waiter gone, deadline.
async fn settle(
    lease: &AccessLease,
    cancel: &mut watch::Receiver<bool>,
    reply: &mut Option<&mut oneshot::Sender<Result<Reply>>>,
    deadline: tokio::time::Instant,
    work: impl std::future::Future<Output = WireOutcome<WireResult>>,
) -> WireOutcome<WireResult> {
    tokio::select! { biased;
        _ = lease.cancelled() => Err(Fault::Stale),
        _ = cancel.changed() => Err(Fault::Unavailable),
        _ = abandoned(reply) => Err(Fault::Stale),
        result = response_before(deadline, work) => result,
    }
}
/// The same one-shot `herdr api guarded` as a child of this app: argv, never a shell, and the
/// child with its whole tree ends when the exchange does.
#[cfg(desktop)]
async fn local_exchange(
    local: &Local,
    name: &str,
    body: &[u8],
    lease: &AccessLease,
) -> WireOutcome<WireResult> {
    use std::process::Stdio;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    lease.check().map_err(|_| Fault::Stale)?;
    let mut herdr = crate::host::local_command("herdr").await;
    herdr
        .args(["--session", name, "api", "guarded"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(test)]
    herdr.envs(local.env.iter().cloned());
    #[cfg(not(test))]
    let _ = local;
    lease.check().map_err(|_| Fault::Stale)?;
    let (mut child, _tree) =
        lazysh_account_usage::spawn_owned(&mut herdr).map_err(|_| Fault::Unavailable)?;
    let (Some(mut stdin), Some(mut stdout), Some(mut stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(Fault::Unavailable);
    };
    stdin.write_all(body).await.map_err(|_| Fault::Uncertain)?;
    // The end of input ends the request.
    drop(stdin);
    let mut output = Zeroizing::new(Vec::new());
    let mut errors = Zeroizing::new(Vec::new());
    let (mut out, mut err) = (Zeroizing::new([0u8; 4096]), Zeroizing::new([0u8; 4096]));
    let (mut out_open, mut err_open) = (true, true);
    while out_open || err_open {
        tokio::select! {
            read = stdout.read(&mut out[..]), if out_open => match read.map_err(|_| Fault::Uncertain)? {
                0 => out_open = false,
                count => output.extend_from_slice(&out[..count]),
            },
            read = stderr.read(&mut err[..]), if err_open => match read.map_err(|_| Fault::Uncertain)? {
                0 => err_open = false,
                count => errors.extend_from_slice(&err[..count]),
            },
        }
        if output.len() + errors.len() > LIMIT {
            return Err(Fault::Protocol);
        }
    }
    let status = child.wait().await.map_err(|_| Fault::Uncertain)?;
    response(
        status.code().and_then(|code| u32::try_from(code).ok()),
        &output,
        &errors,
    )
}
async fn abandoned(reply: &mut Option<&mut oneshot::Sender<Result<Reply>>>) {
    match reply {
        Some(reply) => reply.closed().await,
        None => std::future::pending().await,
    }
}

#[derive(Serialize)]
struct Probe<'a> {
    boot: &'a str,
    ownership: &'a str,
    preparation: u64,
}
pub(crate) async fn available(session: &ssh::Session, name: &str, lease: &AccessLease) -> bool {
    if crate::herdr_path::admit(session, lease).await.is_err() {
        return false;
    }
    probe(
        &Route::Ssh(session.handle.clone()),
        name,
        lease,
        &mut session.cancel.subscribe(),
    )
    .await
}
/// Whether this device's Herdr is the guarded build; `cancel` ends the probe early.
#[cfg(desktop)]
pub(crate) async fn available_local(
    local: Local,
    name: &str,
    lease: &AccessLease,
    cancel: &mut watch::Receiver<bool>,
) -> bool {
    probe(&Route::Local(local), name, lease, cancel).await
}
async fn probe(
    route: &Route,
    name: &str,
    lease: &AccessLease,
    cancel: &mut watch::Receiver<bool>,
) -> bool {
    // The invalid number is rejected before actor lookup/mutation. This is not authority.
    let zero = "0".repeat(64);
    matches!(
        rpc(
            route,
            name,
            lease,
            cancel,
            "lazysh.guard.cancel_preparation",
            &Probe {
                boot: &zero,
                ownership: &zero,
                preparation: 0
            },
            &mut None
        )
        .await,
        Err(Fault::Invalid)
    )
}

fn frame(bytes: &[u8]) -> WireOutcome<Option<(Ticket, usize)>> {
    let matched = bytes.len().min(PREFIX.len());
    if bytes[..matched] != PREFIX[..matched] {
        return Err(Fault::Protocol);
    }
    let start = PREFIX.len() + 9;
    if bytes.len() < start {
        return Ok(None);
    }
    let header = &bytes[PREFIX.len()..PREFIX.len() + 8];
    if bytes[PREFIX.len() + 8] != b':'
        || !header
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(Fault::Protocol);
    }
    let size = usize::from_str_radix(
        std::str::from_utf8(header).map_err(|_| Fault::Protocol)?,
        16,
    )
    .map_err(|_| Fault::Protocol)?;
    if size > FRAME_BODY {
        return Err(Fault::Protocol);
    }
    let end = start + size;
    if bytes.len() <= end {
        return Ok(None);
    }
    if bytes[end] != 0x1f {
        return Err(Fault::Protocol);
    }
    Ok(Some((
        serde_json::from_slice(&bytes[start..end]).map_err(|_| Fault::Protocol)?,
        end + 1,
    )))
}

fn extend_startup(buffer: &mut Vec<u8>, data: &[u8]) -> WireOutcome<()> {
    if buffer.len() > STARTUP_LIMIT || data.len() > STARTUP_LIMIT.saturating_sub(buffer.len()) {
        return Err(Fault::Protocol);
    }
    buffer.extend_from_slice(data);
    Ok(())
}

pub(crate) struct Startup {
    boot: Secret,
    ownership: Secret,
    name: String,
}
#[derive(Serialize)]
struct Claim<'a> {
    boot: &'a Secret,
    ticket: &'a Secret,
}
pub(crate) async fn acquire(
    parent: &ssh::Session,
    lease: &AccessLease,
    name: &str,
    channel: &mut OwnedChannel,
    initial: Vec<u8>,
) -> Result<(Startup, Vec<u8>)> {
    let mut initial = Zeroizing::new(initial);
    if initial.len() > STARTUP_LIMIT {
        return Err(Fault::Protocol.error());
    }
    let mut cancel = parent.cancel.subscribe();
    let stopped = cancel.clone();
    let deadline = tokio::time::Instant::now() + DEADLINE;
    let read = async {
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(Fault::Unavailable);
            }
            lease.check().map_err(|_| Fault::Stale)?;
            if *stopped.borrow() {
                return Err(Fault::Unavailable);
            }
            if let Some((ticket, used)) = frame(&initial)? {
                initial[..used].zeroize();
                initial.drain(..used);
                return Ok(ticket);
            }
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => extend_startup(&mut initial, &data)?,
                // No stderr/banner/EOF can supply or precede a private stdout ticket.
                Some(
                    ChannelMsg::ExtendedData { .. }
                    | ChannelMsg::Eof
                    | ChannelMsg::Close
                    | ChannelMsg::ExitStatus { .. },
                )
                | None => return Err(Fault::Unavailable),
                _ => {}
            }
        }
    };
    let ticket = tokio::select! { biased;
        _ = lease.cancelled() => Err(Fault::Stale),
        _ = cancel.changed() => Err(Fault::Unavailable),
        result = tokio::time::timeout_at(deadline, read) => result.unwrap_or(Err(Fault::Unavailable)),
    }.map_err(Fault::error)?;
    let startup = claim(
        &Route::Ssh(parent.handle.clone()),
        lease,
        name,
        &mut cancel,
        &ticket,
    )
    .await?;
    Ok((startup, std::mem::take(&mut *initial)))
}
/// The private first frame of a local display, delivered once by [`StartupReader`].
#[cfg(desktop)]
pub(crate) async fn acquire_local(
    local: Local,
    lease: &AccessLease,
    name: &str,
    tickets: oneshot::Receiver<Ticket>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Startup> {
    let ticket = tokio::select! { biased;
        _ = lease.cancelled() => Err(Fault::Stale),
        _ = cancel.changed() => Err(Fault::Unavailable),
        // A frame that never comes, or a display that ends first, is no ticket.
        result = tokio::time::timeout(DEADLINE, tickets) => match result {
            Ok(Ok(ticket)) => Ok(ticket),
            _ => Err(Fault::Unavailable),
        },
    }
    .map_err(Fault::error)?;
    claim(&Route::Local(local), lease, name, cancel, &ticket).await
}
/// Claims the connection's ownership once; a lost or uncertain claim is never replayed.
async fn claim(
    route: &Route,
    lease: &AccessLease,
    name: &str,
    cancel: &mut watch::Receiver<bool>,
    ticket: &Ticket,
) -> Result<Startup> {
    let owner = rpc(
        route,
        name,
        lease,
        cancel,
        "lazysh.guard.claim",
        &Claim {
            boot: &ticket.boot,
            ticket: &ticket.ticket,
        },
        &mut None,
    )
    .await
    .map_err(Fault::error)?;
    match owner {
        WireResult::GuardClaimed { owner }
            if owner.boot == ticket.boot && owner.last_preparation == 0 =>
        {
            lease.check()?;
            Ok(Startup {
                boot: owner.boot,
                ownership: owner.ownership,
                name: name.into(),
            })
        }
        _ => Err(Fault::Protocol.error()),
    }
}

/// Takes the guard's private first frame off a local display before any byte reaches the
/// terminal. The frame must open the stream; nothing later is ever searched for a ticket.
#[cfg(desktop)]
pub(crate) struct StartupReader<R> {
    inner: R,
    held: Zeroizing<Vec<u8>>,
    /// Present until the frame has been delivered.
    ticket: Option<oneshot::Sender<Ticket>>,
}
#[cfg(desktop)]
impl<R: io::Read> StartupReader<R> {
    pub(crate) fn new(inner: R, ticket: oneshot::Sender<Ticket>) -> Self {
        Self {
            inner,
            held: Zeroizing::default(),
            ticket: Some(ticket),
        }
    }
}
#[cfg(desktop)]
impl<R: io::Read> io::Read for StartupReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        loop {
            // WouldBlock and Interrupted pass through; the state survives the retry.
            let read = self.inner.read(out)?;
            if self.ticket.is_none() || read == 0 {
                return Ok(read);
            }
            let refused = |_| io::Error::new(io::ErrorKind::InvalidData, "guard_startup_invalid");
            extend_startup(&mut self.held, &out[..read]).map_err(refused)?;
            let Some((ticket, used)) = frame(&self.held).map_err(refused)? else {
                continue;
            };
            // An earlier read held an incomplete frame, so everything after it is from this one.
            let rest = self.held.len() - used;
            out[..rest].copy_from_slice(&self.held[used..]);
            self.held.zeroize();
            if let Some(sender) = self.ticket.take() {
                let _ = sender.send(ticket);
            }
            if rest > 0 {
                return Ok(rest);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Status,
    Observe {},
    ScrollHistory {
        destination: Destination,
        x: u16,
        y: u16,
        lines: i16,
    },
    #[serde(skip)]
    RetireForView,
    Prepare {
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
/// The guard takes `send` and `request_stop` only.
fn guarded_input(input: &Input) -> WireOutcome<()> {
    // Herdr's guard has no paste buffer and no key profile: a long prompt, a dialog answer and a mode cycle stay in the terminal.
    if matches!(
        input,
        Input::SendLong { .. }
            | Input::Type { .. }
            | Input::Select { .. }
            | Input::Submit { .. }
            | Input::Pick { .. }
            | Input::Dismiss { .. }
            | Input::CycleMode {}
    ) {
        return Err(Fault::Invalid);
    }
    input.validate().map_err(|_| Fault::Invalid)
}
impl Action {
    fn validate(&self) -> WireOutcome<()> {
        let token = |value: &str| value.len() == 36 && uuid::Uuid::parse_str(value).is_ok();
        match self {
            Self::Status | Self::Observe {} | Self::RetireForView => Ok(()),
            Self::ScrollHistory {
                destination,
                x,
                y,
                lines,
            } => {
                let target = destination.target()?;
                if *lines == 0
                    || lines.unsigned_abs() > 200
                    || u32::from(*x) < u32::from(target.viewport.x)
                    || u32::from(*y) < u32::from(target.viewport.y)
                    || u32::from(*x)
                        >= u32::from(target.viewport.x) + u32::from(target.viewport.width)
                    || u32::from(*y)
                        >= u32::from(target.viewport.y) + u32::from(target.viewport.height)
                {
                    return Err(Fault::Invalid);
                }
                Ok(())
            }
            Self::Prepare { source } => source.validate().map_err(|_| Fault::Invalid),
            Self::Confirm { candidate, source } if token(candidate) => {
                source.validate().map_err(|_| Fault::Invalid)
            }
            Self::Release { receipt } if token(receipt) => Ok(()),
            Self::Input {
                receipt,
                source,
                operation,
                input,
            } if token(receipt) && *operation > 0 && *operation < u32::MAX => {
                source.validate().map_err(|_| Fault::Invalid)?;
                guarded_input(input)
            }
            _ => Err(Fault::Invalid),
        }
    }
}
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Observed {
        /// The Herdr server this guarded attachment belongs to, so a caller never reads another server's client location.
        server: String,
        destination: Destination,
    },
    Status {
        available: bool,
    },
    Prepared {
        candidate: String,
        destination: Destination,
    },
    Bound {
        receipt: String,
        destination: Destination,
        next_operation: u32,
    },
    Delivered {
        next_operation: u32,
    },
    Released,
}
struct Bound {
    token: String,
    remote: Secret,
    target: Target,
    source: Source,
    owner: AccessLease,
    next: u32,
    confirmed: bool,
}
struct Control {
    startup: Startup,
    route: Route,
    preparation: u64,
    bound: Option<Bound>,
}
#[derive(Serialize)]
struct Prepare<'a> {
    boot: &'a Secret,
    ownership: &'a Secret,
    preparation: u64,
    source: &'a str,
}
#[derive(Serialize)]
struct Observe<'a> {
    boot: &'a Secret,
    ownership: &'a Secret,
}
#[derive(Serialize)]
struct ScrollHistory<'a> {
    boot: &'a Secret,
    ownership: &'a Secret,
    target: Target,
    x: u16,
    y: u16,
    lines: i16,
}

impl Destination {
    fn target(&self) -> WireOutcome<Target> {
        let generation: u64 = self
            .runtime_generation
            .parse()
            .map_err(|_| Fault::Invalid)?;
        if generation.to_string() != self.runtime_generation {
            return Err(Fault::Invalid);
        }
        let target = Target {
            workspace: self.workspace.clone(),
            tab: self.tab.clone(),
            pane: self.pane.clone(),
            terminal: self.terminal.clone(),
            runtime_generation: generation,
            viewport: self.viewport.clone(),
        };
        if !target.valid() {
            return Err(Fault::Invalid);
        }
        Ok(target)
    }
}

#[derive(Serialize)]
struct Release<'a> {
    boot: &'a Secret,
    receipt: &'a Secret,
}
#[derive(Serialize)]
struct SendInput<'a> {
    boot: &'a Secret,
    receipt: &'a Secret,
    source: &'a str,
    operation: u32,
    input: &'a Input,
}
fn source_hash(source: &Source) -> WireOutcome<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(source).map_err(|_| Fault::Invalid)?)
    ))
}
impl Control {
    fn affects_binding(&self, action: &Action) -> bool {
        match action {
            Action::Prepare { .. } | Action::RetireForView => true,
            Action::Confirm {
                candidate: token, ..
            }
            | Action::Input { receipt: token, .. }
            | Action::Release { receipt: token } => self
                .bound
                .as_ref()
                .is_some_and(|bound| &bound.token == token),
            Action::Status | Action::Observe {} | Action::ScrollHistory { .. } => false,
        }
    }
    async fn prepare(
        &mut self,
        source: Source,
        lease: &AccessLease,
        cancel: &mut watch::Receiver<bool>,
        reply: &mut Option<&mut oneshot::Sender<Result<Reply>>>,
    ) -> WireOutcome<Bound> {
        source.validate().map_err(|_| Fault::Invalid)?;
        self.bound = None;
        self.preparation = self
            .preparation
            .checked_add(1)
            .filter(|number| *number <= MAX_OPERATION)
            .ok_or(Fault::Stale)?;
        let source_digest = source_hash(&source)?;
        let params = Prepare {
            boot: &self.startup.boot,
            ownership: &self.startup.ownership,
            preparation: self.preparation,
            source: &source_digest,
        };
        let result = rpc(
            &self.route,
            &self.startup.name,
            lease,
            cancel,
            "lazysh.guard.prepare",
            &params,
            reply,
        )
        .await?;
        match result {
            WireResult::GuardPrepared { guard }
                if guard.boot == self.startup.boot
                    && guard.preparation == self.preparation
                    && guard.source == source_digest
                    && guard.target.valid() =>
            {
                lease.check().map_err(|_| Fault::Stale)?;
                Ok(Bound {
                    token: uuid::Uuid::new_v4().to_string(),
                    remote: guard.receipt,
                    target: guard.target,
                    source,
                    owner: lease.clone(),
                    next: 1,
                    confirmed: false,
                })
            }
            _ => Err(Fault::Protocol),
        }
    }
    async fn release_bound(
        &mut self,
        expected: Option<&str>,
        cancel: &mut watch::Receiver<bool>,
        reply: &mut Option<&mut oneshot::Sender<Result<Reply>>>,
    ) -> WireOutcome<Reply> {
        if self
            .bound
            .as_ref()
            .is_some_and(|bound| expected.is_none_or(|token| bound.token == token))
        {
            let bound = self.bound.take().ok_or(Fault::Stale)?;
            let params = Release {
                boot: &self.startup.boot,
                receipt: &bound.remote,
            };
            match rpc(
                &self.route,
                &self.startup.name,
                &bound.owner,
                cancel,
                "lazysh.guard.release",
                &params,
                reply,
            )
            .await?
            {
                WireResult::Ok {} => {}
                _ => return Err(Fault::Protocol),
            }
        }
        Ok(Reply::Released)
    }
    async fn action(
        &mut self,
        action: Action,
        lease: &AccessLease,
        cancel: &mut watch::Receiver<bool>,
        reply: &mut Option<&mut oneshot::Sender<Result<Reply>>>,
    ) -> WireOutcome<Reply> {
        match action {
            Action::Status => Ok(Reply::Status { available: true }),
            Action::Observe {} => {
                let params = Observe {
                    boot: &self.startup.boot,
                    ownership: &self.startup.ownership,
                };
                match rpc(
                    &self.route,
                    &self.startup.name,
                    lease,
                    cancel,
                    "lazysh.guard.observe",
                    &params,
                    reply,
                )
                .await?
                {
                    WireResult::GuardObserved { guard } if guard.target.valid() => {
                        Ok(Reply::Observed {
                            server: self.startup.name.clone(),
                            destination: guard.target.public(),
                        })
                    }
                    _ => Err(Fault::Protocol),
                }
            }
            Action::ScrollHistory {
                destination,
                x,
                y,
                lines,
            } => {
                let params = ScrollHistory {
                    boot: &self.startup.boot,
                    ownership: &self.startup.ownership,
                    target: destination.target()?,
                    x,
                    y,
                    lines,
                };
                match rpc(
                    &self.route,
                    &self.startup.name,
                    lease,
                    cancel,
                    "lazysh.guard.scroll_history",
                    &params,
                    reply,
                )
                .await?
                {
                    WireResult::Ok {} => Ok(Reply::Released),
                    _ => Err(Fault::Protocol),
                }
            }
            Action::Prepare { source } => {
                let bound = self.prepare(source, lease, cancel, reply).await?;
                let response = Reply::Prepared {
                    candidate: bound.token.clone(),
                    destination: bound.target.public(),
                };
                self.bound = Some(bound);
                Ok(response)
            }
            Action::Confirm { candidate, source } => {
                let previous = self
                    .bound
                    .as_ref()
                    .filter(|bound| {
                        bound.token == candidate && bound.source == source && !bound.confirmed
                    })
                    .ok_or(Fault::Stale)?;
                previous.owner.check().map_err(|_| Fault::Stale)?;
                let target = previous.target.clone();
                let original = previous.owner.clone();
                let mut current = self.prepare(source, &original, cancel, reply).await?;
                if current.target != target {
                    return Err(Fault::Stale);
                }
                current.confirmed = true;
                let response = Reply::Bound {
                    receipt: current.token.clone(),
                    destination: current.target.public(),
                    next_operation: 1,
                };
                self.bound = Some(current);
                Ok(response)
            }
            Action::Release { receipt } => self.release_bound(Some(&receipt), cancel, reply).await,
            Action::RetireForView => self.release_bound(None, cancel, reply).await,
            Action::Input {
                receipt,
                source,
                operation,
                input,
            } => {
                if self
                    .bound
                    .as_ref()
                    .is_none_or(|bound| bound.token != receipt)
                {
                    return Err(Fault::Stale);
                }
                let mut bound = self.bound.take().ok_or(Fault::Stale)?;
                bound.owner.check().map_err(|_| Fault::Stale)?;
                source.validate().map_err(|_| Fault::Invalid)?;
                guarded_input(&input)?;
                if !bound.confirmed || bound.source != source || bound.next != operation {
                    return Err(Fault::Stale);
                }
                bound.next = bound.next.checked_add(1).ok_or(Fault::Stale)?;
                let source_digest = source_hash(&source)?;
                let params = SendInput {
                    boot: &self.startup.boot,
                    receipt: &bound.remote,
                    source: &source_digest,
                    operation,
                    input: &input,
                };
                match rpc(
                    &self.route,
                    &self.startup.name,
                    &bound.owner,
                    cancel,
                    "lazysh.guard.input",
                    &params,
                    reply,
                )
                .await?
                {
                    WireResult::Ok {} => {}
                    _ => return Err(Fault::Protocol),
                }
                bound.owner.check().map_err(|_| Fault::Stale)?;
                let next_operation = bound.next;
                self.bound = Some(bound);
                Ok(Reply::Delivered { next_operation })
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct Binding {
    requests: mpsc::Sender<Work>,
    busy: Arc<AtomicBool>,
    released: Arc<Notify>,
}
pub(crate) struct Permit(Arc<AtomicBool>, Arc<Notify>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
        self.1.notify_waiters();
    }
}
struct Work {
    action: Action,
    lease: AccessLease,
    reply: oneshot::Sender<Result<Reply>>,
    _permit: Arc<Permit>,
}
pub(crate) fn start(startup: Startup, route: Route, mut cancel: watch::Receiver<bool>) -> Binding {
    let (requests, mut queue) = mpsc::channel::<Work>(1);
    tauri::async_runtime::spawn(async move {
        let mut control = Control {
            startup,
            route,
            preparation: 0,
            bound: None,
        };
        loop {
            if *cancel.borrow() {
                break;
            }
            let work = tokio::select! { biased;
                _ = cancel.changed() => break,
                _ = async { match &control.bound { Some(bound) => bound.owner.cancelled().await, None => std::future::pending().await } } => { control.bound = None; continue; },
                work = queue.recv() => match work { Some(work) => work, None => break },
            };
            let Work {
                action,
                lease,
                mut reply,
                _permit,
            } = work;
            let affects_binding = control.affects_binding(&action);
            if lease.check().is_err() || reply.is_closed() {
                if affects_binding {
                    control.bound = None;
                }
                continue;
            }
            let result = control
                .action(action, &lease, &mut cancel, &mut Some(&mut reply))
                .await;
            let retire = matches!(result, Err(Fault::Protocol));
            let published = lease
                .with_current(|| {
                    let cancelled = cancel.borrow();
                    !*cancelled && reply.send(result.map_err(Fault::error)).is_ok()
                })
                .unwrap_or(false);
            if !published && affects_binding {
                control.bound = None;
            }
            if retire {
                break;
            }
        }
    });
    Binding {
        requests,
        busy: Arc::default(),
        released: Arc::default(),
    }
}
/// How long a view change waits for the input turn already in flight before it reports the display busy.
const VIEW_CHANGE_WAIT: Duration = Duration::from_secs(10);
impl Binding {
    async fn call(
        &self,
        lease: &AccessLease,
        cancel: &mut watch::Receiver<bool>,
        action: Action,
    ) -> Result<Reply> {
        let permit = self.reserve()?;
        self.call_reserved(lease, cancel, action, permit).await
    }
    fn reserve(&self) -> Result<Arc<Permit>> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| Fault::Busy.error())?;
        Ok(Arc::new(Permit(self.busy.clone(), self.released.clone())))
    }
    /// Like `reserve`, but a turn already in flight is waited for (it ends by itself) instead of refusing the caller.
    async fn reserve_waiting(&self, limit: Duration) -> Result<Arc<Permit>> {
        let wait = async {
            loop {
                // Registered before the check, so a release between the check and the wait is not missed.
                let released = self.released.notified();
                if let Ok(permit) = self.reserve() {
                    return permit;
                }
                released.await;
            }
        };
        tokio::time::timeout(limit, wait)
            .await
            .map_err(|_| Fault::Busy.error())
    }
    async fn call_reserved(
        &self,
        lease: &AccessLease,
        cancel: &mut watch::Receiver<bool>,
        action: Action,
        permit: Arc<Permit>,
    ) -> Result<Reply> {
        let (reply, response) = oneshot::channel();
        lease.with_current(|| {
            if *cancel.borrow() {
                return Err(Fault::Unavailable.error());
            }
            self.requests
                .try_send(Work {
                    action,
                    lease: lease.clone(),
                    reply,
                    _permit: permit,
                })
                .map_err(|_| Fault::Unavailable.error())
        })??;
        tokio::select! { biased;
            _ = lease.cancelled() => Err(Fault::Stale.error()),
            _ = cancel.changed() => Err(Fault::Unavailable.error()),
            response = response => response.map_err(|_| Fault::Unavailable.error())?,
        }
    }
}

/// Keep the input turn reserved until the caller's view command/channel settles.
pub(crate) async fn retire_for_view(
    session: &ssh::Session,
    lease: &AccessLease,
) -> Result<Option<Arc<Permit>>> {
    let binding = session
        .bindings
        .herdr
        .lock()
        .map_err(|_| Fault::Unavailable.error())?
        .clone();
    let Some(binding) = binding else {
        return Ok(None);
    };
    let permit = binding.reserve_waiting(VIEW_CHANGE_WAIT).await?;
    binding
        .call_reserved(
            lease,
            &mut session.cancel.subscribe(),
            Action::RetireForView,
            permit.clone(),
        )
        .await?;
    Ok(Some(permit))
}

#[tauri::command]
pub async fn herdr_chat(
    lease: AccessLease,
    state: State<'_, AppState>,
    local: State<'_, crate::local::LocalState>,
    session_id: String,
    action: Action,
) -> AccessResult<Reply> {
    lease
        .run(chat(&lease, &state, &local, &session_id, action))
        .await
}
pub(crate) async fn chat(
    lease: &AccessLease,
    state: &AppState,
    local: &crate::local::LocalState,
    session_id: &str,
    action: Action,
) -> Result<Reply> {
    lease.check()?;
    action.validate().map_err(Fault::error)?;
    let (binding, mut cancel) = if session_id.starts_with("local:") {
        crate::local::herdr_binding(local, session_id, lease)
            .map_err(|_| Fault::Unavailable.error())?
    } else {
        let session = state.session(session_id).await?;
        let binding = session
            .bindings
            .herdr
            .lock()
            .map_err(|_| Fault::Unavailable.error())?
            .clone();
        (binding, session.cancel.subscribe())
    };
    if matches!(action, Action::Status) {
        return Ok(Reply::Status {
            available: binding
                .as_ref()
                .is_some_and(|binding| !binding.requests.is_closed()),
        });
    }
    match binding {
        Some(binding) => binding.call(lease, &mut cancel, action).await,
        None => Err(Fault::Unavailable.error()),
    }
}

#[cfg(test)]
#[path = "herdr_guard_tests.rs"]
mod tests;
