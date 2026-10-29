//! Display-owned tmux navigation. The retained channel is the server epoch:
//! interruption retires it; it is never replaced by a fresh CLI connection.
use crate::{
    app_lock::AccessLease,
    ssh::{self, AccessResult, AppState, Result, SshError, SshHandle},
};
use russh::{client, ChannelMsg};
use serde::Serialize;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tauri::State;
use tokio::sync::{mpsc, oneshot, watch};

#[path = "tmux_chat.rs"]
pub(crate) mod chat;

const LIMIT: usize = 1024 * 1024;
const ROWS: usize = 4096;
const DEADLINE: Duration = Duration::from_secs(3);
fn unavailable() -> SshError {
    SshError::new(
        "tmux_unavailable",
        "This display no longer has a verified tmux navigation binding",
    )
}
fn protocol() -> SshError {
    SshError::new(
        "tmux_protocol",
        "Invalid or excessive tmux control response; navigation retired",
    )
}

#[derive(Clone, Debug)]
pub(crate) struct Identity {
    pub(crate) pid: u32,
    pub(crate) tty: String,
}
impl Identity {
    fn client_condition(&self) -> String {
        let tuple = format!(
            "#{{&&:#{{==:#{{client_pid}},{}}},#{{==:#{{client_tty}},{}}}}}",
            self.pid, self.tty
        );
        let attached = format!("#{{&&:#{{!=:#{{client_session}},}},{tuple}}}");
        format!("#{{&&:#{{==:#{{client_control_mode}},0}},{attached}}}")
    }
    pub(crate) fn guard(&self) -> String {
        format!("#{{==:#{{L:#{{?{},1,}}}},1}}", self.client_condition())
    }
    fn admission(&self) -> String {
        // Verify both loop operators used by navigation and guarded Chat input.
        // Unknown modifiers can expand to nonempty literals on older servers.
        let condition = format!(
            "#{{&&:{},#{{==:#{{client_session}},#{{session_name}}}}}}",
            self.client_condition()
        );
        format!(
            "{}\t#{{==:#{{S:#{{L:#{{?{condition},1,}}}}}},1}}",
            self.guard()
        )
    }
}
#[derive(Clone)]
pub(crate) struct Binding {
    requests: mpsc::Sender<Request>,
    input_busy: Arc<std::sync::atomic::AtomicBool>,
}
struct Request {
    lease: AccessLease,
    action: Action,
    reply: oneshot::Sender<Result<Reply>>,
    _permit: Option<chat::Permit>,
}
enum Action {
    Navigation(Option<(String, String, String)>),
    Chat(chat::Action),
}
enum Reply {
    Navigation(Snapshot),
    Chat(chat::Reply),
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    session_id: String,
    window_id: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Window {
    id: String,
    index: u32,
    name: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Session {
    id: String,
    name: String,
    #[serde(rename = "restoreName")]
    restore_name: Option<String>,
    windows: Vec<Window>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    generation: String,
    current: Current,
    sessions: Vec<Session>,
}

fn id(value: &str, prefix: u8) -> bool {
    value.len() > 1
        && value.len() < 24
        && value.as_bytes()[0] == prefix
        && value[1..].bytes().all(|b| b.is_ascii_digit())
}
fn identity(pid: &str, tty: &str) -> Option<Identity> {
    let pid = pid.parse::<u32>().ok().filter(|p| *p > 0)?;
    if !tty.starts_with("/dev/")
        || tty.len() > 128
        || !tty
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-".contains(&b))
    {
        return None;
    }
    Some(Identity {
        pid,
        tty: tty.into(),
    })
}

/// Only a complete, validated owned frame is removed. Banners, malformed
/// frames, and terminal bytes after the frame are kept byte-for-byte.
fn take_frame(bytes: &mut Vec<u8>, marker: &str) -> Option<Identity> {
    let mut start = 0;
    while let Some(offset) = bytes[start..].iter().position(|b| *b == b'\n') {
        let end = start + offset;
        let line = &bytes[start..end];
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Ok(line) = std::str::from_utf8(line) {
            let fields = line.split('\t').collect::<Vec<_>>();
            if fields.len() == 3 && fields[0] == marker {
                if let Some(found) = identity(fields[1], fields[2]) {
                    bytes.drain(start..=end);
                    return Some(found);
                }
            }
        }
        start = end + 1;
    }
    None
}
pub(crate) fn attach_command(
    name: &str,
    marker: &str,
    server: &crate::tmux_server::TmuxServer,
) -> String {
    attach_with_prefix(name, marker, &server.prefix())
}
pub(crate) fn attach_with_prefix(name: &str, marker: &str, prefix: &str) -> String {
    // Keep POSIX metadata syntax inside sh rather than the user's login shell.
    // That process's PID survives exec into the displayed tmux client.
    let script = format!(
        "printf '{}\\t%s\\t%s\\n' \"$$\" \"$(tty)\"; exec {} attach-session -t {}",
        marker,
        prefix,
        crate::multiplexer::tmux_arg(&format!("={name}"))
    );
    format!("exec sh -c {}", ssh::quote(&script))
}
pub(crate) async fn handshake(
    channel: &mut russh::Channel<client::Msg>,
    bytes: &mut Vec<u8>,
    marker: &str,
) -> Option<Identity> {
    // A handshake timeout preserves accumulated bytes and the terminal.
    // The caller's close-owned channel handles cancellation of the attachment.
    tokio::time::timeout(DEADLINE, async {
        loop {
            if let Some(found) = take_frame(bytes, marker) {
                return Some(found);
            }
            if bytes.len() >= 64 * 1024 {
                return None;
            }
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    bytes.extend_from_slice(&data)
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close | ChannelMsg::ExitStatus { .. })
                | None => return None,
                _ => {}
            }
        }
    })
    .await
    .ok()
    .flatten()
}

pub(crate) struct Control {
    channel: ssh::OwnedChannel,
    bytes: Vec<u8>,
    identity: Identity,
    generation: String,
    chat: Option<chat::Receipt>,
    #[cfg(test)]
    chat_before_dispatch: Option<chat::Gate>,
}
impl Control {
    async fn line(&mut self, budget: &mut usize) -> Result<String> {
        loop {
            if let Some(end) = self.bytes.iter().position(|b| *b == b'\n') {
                if end > 64 * 1024 || *budget < end + 1 {
                    return Err(protocol());
                }
                *budget -= end + 1;
                let line = self.bytes.drain(..=end).collect::<Vec<_>>();
                return String::from_utf8(line[..line.len() - 1].to_vec()).map_err(|_| protocol());
            }
            if self.bytes.len() > 64 * 1024 {
                return Err(protocol());
            }
            match self.channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if data.len() > LIMIT || self.bytes.len() + data.len() > LIMIT {
                        return Err(protocol());
                    }
                    self.bytes.extend_from_slice(&data);
                }
                Some(ChannelMsg::WindowAdjusted { .. }) => {}
                _ => return Err(unavailable()),
            }
        }
    }
    async fn block(&mut self, budget: &mut usize) -> Result<Vec<String>> {
        let begin = loop {
            let line = self.line(budget).await?;
            if let Some(rest) = line.strip_prefix("%begin ") {
                if !block_id(rest) {
                    return Err(protocol());
                }
                break rest.to_owned();
            }
            notification(&line)?;
        };
        let mut rows = Vec::new();
        loop {
            let line = self.line(budget).await?;
            if line == format!("%end {begin}") {
                return Ok(rows);
            }
            // A command error also retires the actor. Conservatively do not
            // attempt to resynchronize nested command queues after failure.
            if line.starts_with("%error ")
                || line.starts_with("%begin ")
                || line.starts_with("%end ")
                || rows.len() >= ROWS
            {
                return Err(protocol());
            }
            rows.push(line);
        }
    }
    async fn command(&mut self, command: &str, budget: &mut usize) -> Result<Vec<String>> {
        self.channel.data(format!("{command}\n").as_bytes()).await?;
        self.block(budget).await
    }
    async fn current(&mut self, budget: &mut usize) -> Result<Option<Current>> {
        let rows=self.command("list-clients -F '#{client_pid}|#{client_tty}|#{session_id}|#{window_id}|#{client_control_mode}'",budget).await?;
        let mut found = None;
        for row in rows {
            let f = row.split('|').collect::<Vec<_>>();
            if f.len() != 5 {
                return Err(protocol());
            }
            if f[0] == self.identity.pid.to_string() && f[1] == self.identity.tty && f[4] == "0" {
                if found.is_some() || !id(f[2], b'$') || !id(f[3], b'@') {
                    return Err(protocol());
                }
                found = Some(Current {
                    session_id: f[2].into(),
                    window_id: f[3].into(),
                });
            }
        }
        Ok(found)
    }
    async fn snapshot(&mut self, budget: &mut usize) -> Result<Snapshot> {
        // q quotes delimiters/backslashes; control characters are visibly
        // replaced BEFORE tmux's control stream can turn them into framing.
        let rows=self.command("list-windows -a -F '#{session_id}|#{q;s/#{l:[[:cntrl:]]}/?/:session_name}|#{window_id}|#{window_index}|#{q;s/#{l:[[:cntrl:]]}/?/:window_name}|#{m/r:[[:cntrl:]],#{session_name}}'",budget).await?;
        let sessions = parse_tree(&rows)?;
        let current = self.current(budget).await?.ok_or_else(unavailable)?;
        if !sessions.iter().any(|s| {
            s.id == current.session_id && s.windows.iter().any(|w| w.id == current.window_id)
        }) {
            return Err(unavailable());
        }
        Ok(Snapshot {
            generation: self.generation.clone(),
            current,
            sessions,
        })
    }
    async fn jump(&mut self, session: &str, window: &str, budget: &mut usize) -> Result<()> {
        let guard = self.identity.guard();
        let marker = format!("LAZYSH_JUMP_{}", uuid::Uuid::new_v4().simple());
        let action = format!(
            "switch-client -E -c {} -t {}",
            ssh::quote(&self.identity.tty),
            ssh::quote(&format!("{session}:{window}"))
        );
        self.marked_command(&guard, &action, &marker, budget)
            .await?
            .then_some(())
            .ok_or_else(unavailable)
    }
    /// Preserve the same bounded framing for navigation and terminal input.
    /// A negative owned marker is distinct from a malformed/partial stream.
    async fn marked_command(
        &mut self,
        guard: &str,
        action: &str,
        marker: &str,
        budget: &mut usize,
    ) -> Result<bool> {
        let command = format!(
            "if-shell -F {} {{ {action}; display-message -p {} }} {{ display-message -p {} }}",
            ssh::quote(guard),
            ssh::quote(&format!("{marker}:ok")),
            ssh::quote(&format!("{marker}:gone"))
        );
        self.marked_dispatch(&command, marker, budget).await
    }
    async fn marked_dispatch(
        &mut self,
        command: &str,
        marker: &str,
        budget: &mut usize,
    ) -> Result<bool> {
        self.channel.data(format!("{command}\n").as_bytes()).await?;
        for _ in 0..8 {
            let rows = self.block(budget).await?;
            if let Some(completed) = marked_rows(&rows, marker)? {
                return Ok(completed);
            }
        }
        Err(protocol())
    }
}
fn marked_rows(rows: &[String], marker: &str) -> Result<Option<bool>> {
    if rows == [format!("{marker}:ok")] {
        return Ok(Some(true));
    }
    if rows == [format!("{marker}:gone")] {
        return Ok(Some(false));
    }
    if rows.is_empty() {
        Ok(None)
    } else {
        Err(protocol())
    }
}
fn block_id(s: &str) -> bool {
    let f = s.split(' ').collect::<Vec<_>>();
    f.len() == 3
        && f.iter()
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
fn notification(s: &str) -> Result<()> {
    if let Some(target) = s.strip_prefix("%session-window-changed ") {
        let parts = target.split(' ').collect::<Vec<_>>();
        return if parts.len() == 2 && id(parts[0], b'$') && id(parts[1], b'@') {
            Ok(())
        } else {
            Err(protocol())
        };
    }
    // Notifications are bounded and ignored, never interpreted as responses.
    const ALLOWED: &[&str] = &[
        "%session-changed ",
        "%session-renamed ",
        "%sessions-changed",
        "%window-add ",
        "%window-close ",
        "%window-renamed ",
        "%unlinked-window-add ",
        "%unlinked-window-close ",
        "%unlinked-window-renamed ",
        "%layout-change ",
        "%window-pane-changed ",
        "%client-session-changed ",
        "%client-detached ",
        "%client-discarded ",
        "%pane-mode-changed ",
        "%paste-buffer-changed ",
        "%paste-buffer-deleted ",
        "%subscription-changed ",
    ];
    if ALLOWED
        .iter()
        .any(|prefix| s == *prefix || s.starts_with(prefix))
    {
        Ok(())
    } else {
        Err(protocol())
    }
}
fn fields(row: &str) -> Result<Vec<String>> {
    let mut out = vec![String::new()];
    let mut escaped = false;
    for c in row.chars() {
        if c.is_control() {
            return Err(protocol());
        }
        if escaped {
            if !"|&;<>(){}$`\\\"'*?[# =%".contains(c) {
                return Err(protocol());
            }
            out.last_mut().unwrap().push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '|' {
            out.push(String::new());
        } else {
            out.last_mut().unwrap().push(c);
        }
    }
    if escaped {
        return Err(protocol());
    }
    Ok(out)
}
fn parse_tree(rows: &[String]) -> Result<Vec<Session>> {
    let mut sessions: BTreeMap<String, Session> = BTreeMap::new();
    for row in rows {
        let f = fields(row)?;
        if f.len() != 6
            || !id(&f[0], b'$')
            || !id(&f[2], b'@')
            || f[1].len() > 1024
            || f[4].len() > 1024
            || !matches!(f[5].as_str(), "0" | "1")
        {
            return Err(protocol());
        }
        let index = f[3].parse::<u32>().map_err(|_| protocol())?;
        let restore_name = (f[5] == "0"
            && !f[1].is_empty()
            && f[1].len() <= 200
            && !f[1].chars().any(char::is_control))
        .then(|| f[1].clone());
        let entry = sessions.entry(f[0].clone()).or_insert_with(|| Session {
            id: f[0].clone(),
            name: f[1].clone(),
            restore_name: restore_name.clone(),
            windows: Vec::new(),
        });
        if entry.name != f[1]
            || entry.restore_name != restore_name
            || entry
                .windows
                .iter()
                .any(|w| w.id == f[2] || w.index == index)
        {
            return Err(protocol());
        }
        entry.windows.push(Window {
            id: f[2].clone(),
            index,
            name: f[4].clone(),
        });
    }
    for s in sessions.values_mut() {
        s.windows.sort_by_key(|w| w.index);
    }
    Ok(sessions.into_values().collect())
}

pub(crate) async fn prepare(
    handle: &Arc<SshHandle>,
    identity: Identity,
    name: &str,
    server: &crate::tmux_server::TmuxServer,
    lease: &AccessLease,
) -> Option<Control> {
    prepare_command(
        handle,
        identity,
        format!(
            "{} -C attach-session -f no-output,ignore-size -t {}",
            server.prefix(),
            crate::multiplexer::tmux_arg(&format!("={name}"))
        ),
        lease,
    )
    .await
}
pub(crate) async fn prepare_command(
    handle: &Arc<SshHandle>,
    identity: Identity,
    command: String,
    lease: &AccessLease,
) -> Option<Control> {
    let deadline = tokio::time::Instant::now() + DEADLINE;
    let channel = ssh::open_owned_channel(handle, lease, deadline)
        .await
        .ok()?;
    let mut control = Control {
        channel,
        bytes: Vec::new(),
        identity,
        generation: uuid::Uuid::new_v4().to_string(),
        chat: None,
        #[cfg(test)]
        chat_before_dispatch: None,
    };
    let operation = async {
        let channel = &mut control.channel;
        channel.exec(true, command).await?;
        control.bytes = ssh::request_ok(channel).await?;
        let mut budget = LIMIT;
        control.block(&mut budget).await?;
        loop {
            if control.current(&mut budget).await?.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let admission = control.identity.admission();
        let rows = control
            .command(
                &format!("display-message -p {}", ssh::quote(&admission)),
                &mut budget,
            )
            .await?;
        if rows != ["1\t1"] {
            return Err(unavailable());
        }
        Ok::<_, SshError>(())
    };
    let result = tokio::select! {biased; _=lease.cancelled()=>None, result=tokio::time::timeout_at(deadline,operation)=>result.ok().and_then(std::result::Result::ok)};
    result.map(|_| control)
}

pub(crate) fn start(control: Control, cancellation: watch::Receiver<bool>) -> Binding {
    let (requests, rx) = mpsc::channel::<Request>(4);
    spawn_actor(control, cancellation, rx);
    Binding {
        requests,
        input_busy: Arc::default(),
    }
}
fn spawn_actor(
    mut control: Control,
    mut cancellation: watch::Receiver<bool>,
    mut rx: mpsc::Receiver<Request>,
) {
    tauri::async_runtime::spawn(async move {
        let mut idle_budget = LIMIT;
        loop {
            if *cancellation.borrow() {
                break;
            }
            // Drain and validate notifications while idle, detecting server EOF
            // without allowing unbounded unsolicited output or stale responses.
            let request = tokio::select! {biased; _=cancellation.changed()=>break, request=rx.recv()=>match request {Some(r)=>r,None=>break}, line=control.line(&mut idle_budget)=>{match line {Ok(line) if notification(&line).is_ok()=>continue,_=>break}}};
            if request.lease.check().is_err() || request.reply.is_closed() {
                if let Action::Chat(action) = &request.action {
                    control.chat_abandoned(action);
                }
                continue;
            }
            let Request {
                lease,
                action,
                mut reply,
                _permit,
            } = request;
            let chat_request = matches!(&action, Action::Chat(_));
            let operation = async {
                let mut budget = LIMIT;
                let target = match action {
                    Action::Chat(action) => {
                        return control
                            .chat_action(&lease, action, &mut budget)
                            .await
                            .map(Reply::Chat)
                    }
                    Action::Navigation(target) => target,
                };
                if let Some((generation, session, window)) = target {
                    if generation != control.generation || !id(&session, b'$') || !id(&window, b'@')
                    {
                        return Err(SshError::new(
                            "tmux_stale",
                            "Refresh this tmux view before navigating",
                        ));
                    }
                    control.chat = None;
                    control.jump(&session, &window, &mut budget).await?;
                }
                control.snapshot(&mut budget).await.map(Reply::Navigation)
            };
            // Any interruption may have left a partial write/read. Never reuse
            // that stream, even after unlock or a renderer starts another call.
            let result = tokio::select! { biased; _=cancellation.changed()=>break, _=lease.cancelled()=>break, _=reply.closed()=>break, result=tokio::time::timeout(DEADLINE,operation)=>result.unwrap_or_else(|_|Err(unavailable())) };
            let failed = result.as_ref().is_err_and(|error| {
                // Known local/negative-marker rejections consumed no input and
                // leave the framed stream synchronized. Preserve navigation.
                !(chat_request && matches!(error.kind(), "tmux_chat_invalid" | "tmux_chat_stale"))
            });
            if lease.check().is_err() || *cancellation.borrow() {
                break;
            }
            drop(_permit);
            let published = lease
                .with_current(|| {
                    let cancelled = cancellation.borrow();
                    if !*cancelled {
                        reply.send(result).is_ok()
                    } else {
                        false
                    }
                })
                .unwrap_or(false);
            // A waiter may close after the select completes but before reply
            // publication. Never leave newly granted/advanced authority behind.
            if chat_request && !published {
                control.chat = None;
            }
            if failed {
                break;
            }
            idle_budget = LIMIT;
        }
    });
}
async fn request(
    lease: &AccessLease,
    state: &AppState,
    session_id: &str,
    target: Option<(String, String, String)>,
) -> Result<Snapshot> {
    lease.check()?;
    let session = state.session(session_id).await?;
    if *session.cancel.borrow() {
        return Err(unavailable());
    }
    let binding = session
        .tmux
        .lock()
        .map_err(|_| unavailable())?
        .clone()
        .ok_or_else(unavailable)?;
    let mut cancel = session.cancel.subscribe();
    binding.call(lease, &mut cancel, target).await
}
impl Binding {
    #[cfg(test)]
    pub(crate) async fn retired(&self) {
        self.requests.closed().await;
    }
    pub(crate) async fn call(
        &self,
        lease: &AccessLease,
        cancel: &mut watch::Receiver<bool>,
        target: Option<(String, String, String)>,
    ) -> Result<Snapshot> {
        if *cancel.borrow() {
            return Err(unavailable());
        }
        if target
            .as_ref()
            .is_some_and(|(generation, session, window)| {
                generation.len() != 36 || !id(session, b'$') || !id(window, b'@')
            })
        {
            return Err(SshError::new(
                "tmux_stale",
                "Refresh this tmux view before navigating",
            ));
        }
        match self
            .call_action(lease, cancel, Action::Navigation(target), None)
            .await?
        {
            Reply::Navigation(snapshot) => Ok(snapshot),
            _ => Err(protocol()),
        }
    }
    async fn call_action(
        &self,
        lease: &AccessLease,
        cancel: &mut watch::Receiver<bool>,
        action: Action,
        permit: Option<chat::Permit>,
    ) -> Result<Reply> {
        let (reply, response) = oneshot::channel();
        lease.with_current(|| {
            // Hold the watch read guard across synchronous queue admission;
            // local send_replace(true) cannot race past this check.
            let cancelled = cancel.borrow();
            if *cancelled {
                return Err(unavailable());
            }
            self.requests
                .try_send(Request {
                    lease: lease.clone(),
                    action,
                    reply,
                    _permit: permit,
                })
                .map_err(|_| unavailable())
        })??;
        tokio::select! {biased; _=cancel.changed()=>Err(unavailable()), _=lease.cancelled()=>Err(unavailable()), result=tokio::time::timeout(DEADLINE,response)=>result.map_err(|_|unavailable())?.map_err(|_|unavailable())? }
    }
}
#[cfg(test)]
pub(crate) fn start_with_revoked_queue_fixture(
    control: Control,
    cancellation: watch::Receiver<bool>,
    lease: AccessLease,
) -> (Binding, oneshot::Receiver<Result<Snapshot>>) {
    let (requests, rx) = mpsc::channel(4);
    let (reply, response) = oneshot::channel();
    let (old_reply, response_snapshot) = (reply, response);
    requests
        .try_send(Request {
            lease: lease.clone(),
            action: Action::Navigation(None),
            reply: old_reply,
            _permit: None,
        })
        .unwrap_or_else(|_| panic!("empty fixture queue"));
    // Enqueue AND revoke before launching the actual actor loop. A no-await
    // interval on the caller cannot synchronize Tauri's separate runtime.
    lease.state().lock().unwrap();
    spawn_actor(control, cancellation, rx);
    // Preserve the navigation fixture's public result shape.
    let (tx, response) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        if let Ok(value) = response_snapshot.await {
            let _ = tx.send(value.and_then(|value| match value {
                Reply::Navigation(s) => Ok(s),
                _ => Err(protocol()),
            }));
        }
    });
    (
        Binding {
            requests,
            input_busy: Arc::default(),
        },
        response,
    )
}

#[cfg(test)]
pub(crate) fn fixture_control(channel: russh::Channel<client::Msg>, identity: Identity) -> Control {
    Control {
        channel: channel.into(),
        bytes: Vec::new(),
        identity,
        generation: uuid::Uuid::new_v4().to_string(),
        chat: None,
        #[cfg(test)]
        chat_before_dispatch: None,
    }
}
#[tauri::command]
pub async fn tmux_jump_snapshot(
    lease: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
) -> AccessResult<Snapshot> {
    lease.run(request(&lease, &state, &session_id, None)).await
}
#[tauri::command]
pub async fn tmux_jump(
    lease: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    generation: String,
    target_session_id: String,
    window_id: String,
) -> AccessResult<Snapshot> {
    lease
        .run(request(
            &lease,
            &state,
            &session_id,
            Some((generation, target_session_id, window_id)),
        ))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn marked_completion_does_not_misclassify_ambiguous_dispatch_as_safe_rejection() {
        let marker = "OWNED_MARKER";
        assert_eq!(marked_rows(&[], marker).unwrap(), None);
        assert_eq!(
            marked_rows(&[format!("{marker}:ok")], marker).unwrap(),
            Some(true)
        );
        assert_eq!(
            marked_rows(&[format!("{marker}:gone")], marker).unwrap(),
            Some(false)
        );
        for rows in [
            vec![format!("{marker}:ok"), "extra".into()],
            vec![format!("{marker}:gone"), "extra".into()],
            vec![format!("{marker}:unknown")],
            vec!["unrelated".into()],
        ] {
            assert_eq!(
                marked_rows(&rows, marker)
                    .expect_err("ambiguous completion must retire the stream")
                    .kind(),
                "tmux_protocol"
            );
        }
    }
    #[test]
    fn oversized_labels_never_become_restoration_names() {
        let rows = vec![format!("$0|{}|@0|0|shell|0", "a".repeat(201))];
        let tree = parse_tree(&rows).unwrap();
        assert!(tree[0].restore_name.is_none());
        for (label, flag, restorable) in [
            ("work?build".to_owned(), "1", false),
            ("work?build".to_owned(), "0", true),
            ("é".repeat(100), "0", true),
            ("é".repeat(101), "0", false),
        ] {
            let tree = parse_tree(&[format!("$0|{label}|@0|0|shell|{flag}")]).unwrap();
            assert_eq!(tree[0].restore_name.is_some(), restorable);
            if restorable {
                assert_eq!(tree[0].restore_name.as_deref(), Some(label.as_str()));
            }
        }
    }
    #[test]
    fn handshake_keeps_banners_and_terminal_bytes() {
        let mut bytes = b"banner\r\nM\t42\t/dev/pts/3\r\n\x1b[2Jhello".to_vec();
        assert_eq!(take_frame(&mut bytes, "M").unwrap().pid, 42);
        assert_eq!(bytes, b"banner\r\n\x1b[2Jhello");
        let mut malformed = b"M\t0\t/dev/pts/3\nhello".to_vec();
        let old = malformed.clone();
        assert!(take_frame(&mut malformed, "M").is_none());
        assert_eq!(malformed, old);
    }
    #[test]
    fn tree_quotes_do_not_create_rows_or_execute_formats() {
        let tree = parse_tree(&[r"$0|a\|b\ \#{session_name}|@1|2|x\\y\;\'\$|0".into()]).unwrap();
        assert_eq!(tree[0].name, "a|b #{session_name}");
        assert_eq!(tree[0].windows[0].name, "x\\y;'$");
        assert!(parse_tree(&["$0|a|@1|0|line\n%end 1 2 3".into()]).is_err());
        assert!(parse_tree(&["$0|a|@1|0|x|0".into(), "$0|b|@2|1|y|0".into()]).is_err());
        assert!(!id("$", b'$'));
        assert!(!id("@1; kill-server", b'@'));
    }
    #[test]
    fn strict_block_and_notification_framing() {
        assert!(block_id("1 2 3"));
        assert!(!block_id("1 2 3 extra"));
        assert!(notification("%sessions-changed").is_ok());
        assert!(notification("%session-window-changed $1 @2").is_ok());
        assert!(notification("%session-window-changed $1 @2 trailing").is_err());
        assert!(notification("%session-window-changed $1 bad").is_err());
        assert!(notification("%end 1 2 3").is_err());
        assert!(notification("%output %1 arbitrary").is_err());
    }
}
