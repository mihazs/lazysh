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
#[derive(Clone)]
pub(crate) struct Binding {
    requests: mpsc::Sender<Request>,
}
struct Request {
    lease: AccessLease,
    target: Option<(String, String, String)>,
    reply: oneshot::Sender<Result<Snapshot>>,
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
pub(crate) fn attach_command(name: &str, marker: &str) -> String {
    attach_with_prefix(name, marker, "tmux")
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
    // Cancellation of this future preserves bytes accumulated so far and the
    // original terminal channel. Navigation alone becomes unavailable.
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
    channel: Option<russh::Channel<client::Msg>>,
    bytes: Vec<u8>,
    identity: Identity,
    generation: String,
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
            match self.channel.as_mut().unwrap().wait().await {
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
        self.channel
            .as_ref()
            .unwrap()
            .data(format!("{command}\n").as_bytes())
            .await?;
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
        let rows=self.command("list-windows -a -F '#{session_id}|#{q;s/[[#:cntrl#:]]/?/:session_name}|#{window_id}|#{window_index}|#{q;s/[[#:cntrl#:]]/?/:window_name}'",budget).await?;
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
        let tuple = format!(
            "#{{&&:#{{==:#{{client_pid}},{}}},#{{==:#{{client_tty}},{}}}}}",
            self.identity.pid, self.identity.tty
        );
        let attached = format!("#{{&&:#{{!=:#{{client_session}},}},{tuple}}}");
        let normal = format!("#{{&&:#{{==:#{{client_control_mode}},0}},{attached}}}");
        let guard = format!("#{{L:#{{?{normal},1,}}}}");
        let marker = format!("LAZYSH_JUMP_{}", uuid::Uuid::new_v4().simple());
        let command=format!("if-shell -F {} {{ switch-client -E -c {} -t {}; display-message -p {} }} {{ display-message -p {} }}",ssh::quote(&guard),ssh::quote(&self.identity.tty),ssh::quote(&format!("{session}:{window}")),ssh::quote(&format!("{marker}:ok")),ssh::quote(&format!("{marker}:gone")));
        self.channel
            .as_ref()
            .unwrap()
            .data(format!("{command}\n").as_bytes())
            .await?;
        for _ in 0..8 {
            let rows = self.block(budget).await?;
            if rows == [format!("{marker}:ok")] {
                return Ok(());
            }
            if rows.iter().any(|s| s.starts_with(&marker)) {
                return Err(unavailable());
            }
            if !rows.is_empty() {
                return Err(protocol());
            }
        }
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
        if f.len() != 5
            || !id(&f[0], b'$')
            || !id(&f[2], b'@')
            || f[1].len() > 1024
            || f[4].len() > 1024
        {
            return Err(protocol());
        }
        let index = f[3].parse::<u32>().map_err(|_| protocol())?;
        let entry = sessions.entry(f[0].clone()).or_insert_with(|| Session {
            id: f[0].clone(),
            name: f[1].clone(),
            windows: Vec::new(),
        });
        if entry.name != f[1]
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
    lease: &AccessLease,
) -> Option<Control> {
    prepare_command(
        handle,
        identity,
        format!(
            "tmux -u -C attach-session -f no-output,ignore-size -t {}",
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
    let channel = tokio::select! {biased; _=lease.cancelled()=>return None, result=tokio::time::timeout_at(deadline,handle.channel_open_session())=>result.ok()?.ok()?};
    let mut control = Control {
        channel: Some(channel),
        bytes: Vec::new(),
        identity,
        generation: uuid::Uuid::new_v4().to_string(),
    };
    let operation = async {
        let channel = control.channel.as_mut().unwrap();
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
        Ok::<_, SshError>(())
    };
    let result = tokio::select! {biased; _=lease.cancelled()=>None, result=tokio::time::timeout_at(deadline,operation)=>result.ok().and_then(std::result::Result::ok)};
    result.map(|_| control)
}
impl Drop for Control {
    fn drop(&mut self) {
        if let Some(channel) = self.channel.take() {
            // Dropping a russh Channel does not request remote close. This
            // owned cleanup survives cancellation of bootstrap/operation futures.
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(DEADLINE, channel.close()).await;
            });
        }
    }
}

pub(crate) fn start(mut control: Control, mut cancellation: watch::Receiver<bool>) -> Binding {
    let (requests, mut rx) = mpsc::channel::<Request>(4);
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
                continue;
            }
            let Request {
                lease,
                target,
                mut reply,
            } = request;
            let operation = async {
                let mut budget = LIMIT;
                if let Some((generation, session, window)) = target {
                    if generation != control.generation || !id(&session, b'$') || !id(&window, b'@')
                    {
                        return Err(SshError::new(
                            "tmux_stale",
                            "Refresh this tmux view before navigating",
                        ));
                    }
                    control.jump(&session, &window, &mut budget).await?;
                }
                control.snapshot(&mut budget).await
            };
            // Any interruption may have left a partial write/read. Never reuse
            // that stream, even after unlock or a renderer starts another call.
            let result = tokio::select! { biased; _=cancellation.changed()=>break, _=lease.cancelled()=>break, _=reply.closed()=>break, result=tokio::time::timeout(DEADLINE,operation)=>result.unwrap_or_else(|_|Err(unavailable())) };
            let failed = result.is_err();
            if lease.check().is_err() || *cancellation.borrow() {
                break;
            }
            let _ = lease.with_current(|| {
                let cancelled = cancellation.borrow();
                if !*cancelled {
                    let _ = reply.send(result);
                }
            });
            if failed {
                break;
            }
            idle_budget = LIMIT;
        }
    });
    Binding { requests }
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
    pub(crate) fn queue_fixture_request(
        &self,
        lease: AccessLease,
    ) -> oneshot::Receiver<Result<Snapshot>> {
        let (reply, response) = oneshot::channel();
        self.requests
            .try_send(Request {
                lease,
                target: None,
                reply,
            })
            .unwrap_or_else(|_| panic!("fixture queue unexpectedly unavailable"));
        response
    }
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
                    target,
                    reply,
                })
                .map_err(|_| unavailable())
        })??;
        tokio::select! {biased; _=cancel.changed()=>Err(unavailable()), _=lease.cancelled()=>Err(unavailable()), result=tokio::time::timeout(DEADLINE,response)=>result.map_err(|_|unavailable())?.map_err(|_|unavailable())? }
    }
}
#[cfg(test)]
pub(crate) fn fixture_control(channel: russh::Channel<client::Msg>, identity: Identity) -> Control {
    Control {
        channel: Some(channel),
        bytes: Vec::new(),
        identity,
        generation: uuid::Uuid::new_v4().to_string(),
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
        let tree = parse_tree(&[r"$0|a\|b\ \#{session_name}|@1|2|x\\y\;\'\$".into()]).unwrap();
        assert_eq!(tree[0].name, "a|b #{session_name}");
        assert_eq!(tree[0].windows[0].name, "x\\y;'$");
        assert!(parse_tree(&["$0|a|@1|0|line\n%end 1 2 3".into()]).is_err());
        assert!(parse_tree(&["$0|a|@1|0|x".into(), "$0|b|@2|1|y".into()]).is_err());
        assert!(!id("$", b'$'));
        assert!(!id("@1; kill-server", b'@'));
    }
    #[test]
    fn strict_block_and_notification_framing() {
        assert!(block_id("1 2 3"));
        assert!(!block_id("1 2 3 extra"));
        assert!(notification("%sessions-changed").is_ok());
        assert!(notification("%end 1 2 3").is_err());
        assert!(notification("%output %1 arbitrary").is_err());
    }
}
