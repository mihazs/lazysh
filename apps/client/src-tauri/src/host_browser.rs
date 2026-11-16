//! The host browser bridge (#1704, slice 2 of #1254): the relay `lazysh-agent host-browser serve` run on one SSH
//! exec channel per browser, and the commands the viewer pulls its frames with.
//!
//! The commands are shaped like the Devices tool's `device_stream_*`: the renderer starts a browser, pulls one
//! message at a time (back pressure by pull, one outstanding pull), acknowledges a frame after it decoded it,
//! pauses and resumes the screencast, and stops it. Frames reach the renderer as bytes, never base64: a pull
//! answers with the relay's own tag and message (a JSON object or a frame), or one idle byte.
//!
//! Stopping, a lock, a dropped SSH connection and the end of the session all close the channel, and closing the
//! channel ends the relay's browser, its helpers and its profile. One browser runs per session and two per app.
//! A companion that has no `host-browser serve` or has the host browser switch off is named, not retried.
//! Nothing about a page (its address, its title, a frame) is written to a log, app storage or crash report: an
//! error names an operation and a reason.
use crate::{
    app_lock::{AccessLease, Guarded, GuardedError},
    ssh::{self, AppState, Result, SshError},
};
use outbox::Outbox;
use russh::ChannelMsg;
use serde_json::{json, Value};
use std::{collections::HashMap, future::Future, pin::pin, sync::Arc, time::Duration};
use tauri::{ipc::Response, State};
use tokio::{
    sync::{mpsc, watch, Mutex},
    time::{sleep, timeout, Instant},
};
use wire::{Control, Decoder, Message, Viewport};

mod outbox;
#[cfg(test)]
mod tests;
mod wire;

type Protected<T> = std::result::Result<Guarded<T>, GuardedError<SshError>>;
/// Printed by the `required_command` wrapper when the host has no `host-browser serve`.
pub(crate) const COMPANION_REQUIRED: &str = "lazysh-host-browser-companion-required-v1";
const SERVE: &str = "lazysh-agent host-browser serve";
/// **Keep profile**: the relay uses the one kept profile and leaves it for **Clear browser data**. An older
/// relay answers the option with a usage error, which the wrapper turns into `CompanionRequired`: a session
/// never silently runs without the profile the user asked to keep.
const KEEP_PROFILE: &str = " --keep-profile";

fn serve_command(keep_profile: bool) -> String {
    format!("{SERVE}{}", if keep_profile { KEEP_PROFILE } else { "" })
}
/// One browser per session, two per app.
const MAX_BROWSERS: usize = 2;
/// A cold browser on a loaded host needs well over a second; the relay itself gives up after 90 s.
const START_TIMEOUT: Duration = Duration::from_secs(120);
const IDLE_PULL: Duration = Duration::from_secs(15);
/// After EOF the relay ends its browser and removes its profile, then exits.
const GRACE: Duration = Duration::from_secs(3);
const STOP_WAIT: Duration = Duration::from_secs(8);
const COMMANDS: usize = 16;
const MAX_ADDRESS: usize = 2048;

/// What the relay's channel delivers.
pub(crate) enum Incoming {
    Data(Vec<u8>),
    Exit(u32),
    End,
}

/// The relay's SSH exec channel: its standard input and output.
pub(crate) trait Exec: Send {
    fn send(&mut self, bytes: &[u8]) -> impl Future<Output = Result<()>> + Send;
    fn next(&mut self) -> impl Future<Output = Incoming> + Send;
    /// End of input, so the relay ends its browser, then the channel's close.
    fn finish(&mut self) -> impl Future<Output = ()> + Send;
}

struct Remote(ssh::OwnedChannel);
impl Exec for Remote {
    async fn send(&mut self, bytes: &[u8]) -> Result<()> {
        Ok(self.0.data(bytes).await?)
    }
    async fn next(&mut self) -> Incoming {
        loop {
            match self.0.wait().await {
                Some(ChannelMsg::Data { data }) => return Incoming::Data(data.to_vec()),
                Some(ChannelMsg::ExitStatus { exit_status }) => return Incoming::Exit(exit_status),
                Some(ChannelMsg::Close) | None => return Incoming::End,
                // The relay's error output can name pages: it is never read.
                _ => {}
            }
        }
    }
    async fn finish(&mut self) {
        let _ = timeout(GRACE, async {
            let _ = self.0.eof().await;
            while !matches!(self.next().await, Incoming::End) {}
        })
        .await;
        let _ = timeout(Duration::from_secs(2), self.0.close()).await;
    }
}

struct Browser {
    session_id: String,
    cancel: watch::Sender<bool>,
    outbox: Arc<Outbox>,
    commands: mpsc::Sender<Vec<u8>>,
    done: watch::Receiver<bool>,
}
impl Browser {
    /// The worker ended, or its owner is gone.
    fn ended(&self) -> bool {
        *self.done.borrow() || self.done.has_changed().is_err()
    }
}

#[derive(Default)]
pub struct HostBrowsers(Mutex<HashMap<String, Browser>>);
impl HostBrowsers {
    pub(crate) async fn cancel_for_lock(&self) {
        let mut browsers = self.0.lock().await;
        for browser in browsers.values() {
            browser.outbox.seal();
            browser.cancel.send_replace(true);
        }
        // The slot stays reserved until the worker confirms that its channel is closed.
        browsers.retain(|_, browser| !browser.ended());
    }

    /// Registers a browser of `session_id` and runs `connect`'s channel for it. Fails when the session
    /// already has one or the app has two.
    pub(crate) async fn spawn<E: Exec + 'static>(
        &self,
        access: AccessLease,
        session_id: String,
        open: Vec<u8>,
        disconnected: watch::Receiver<bool>,
        connect: impl Future<Output = Result<E>> + Send + 'static,
    ) -> Result<String> {
        let mut browsers = self.0.lock().await;
        // A renderer reload can lose its token: a finished browser must not hold a slot until stop.
        browsers.retain(|_, browser| !browser.ended());
        if browsers.len() >= MAX_BROWSERS
            || browsers
                .values()
                .any(|browser| browser.session_id == session_id)
        {
            return Err(SshError::new("busy", "Stop the open host browser first"));
        }
        let token = uuid::Uuid::new_v4().to_string();
        let (cancel, cancelled) = watch::channel(false);
        let (done, finished) = watch::channel(false);
        let (commands, queued) = mpsc::channel(COMMANDS);
        let outbox = Arc::new(Outbox::default());
        access.check()?;
        access.with_current(|| {
            browsers.insert(
                token.clone(),
                Browser {
                    session_id,
                    cancel,
                    outbox: outbox.clone(),
                    commands,
                    done: finished,
                },
            );
        })?;
        tokio::spawn(async move {
            run(
                connect,
                open,
                queued,
                &outbox,
                access,
                cancelled,
                disconnected,
            )
            .await;
            done.send_replace(true);
        });
        Ok(token)
    }

    async fn entry(
        &self,
        session_id: &str,
        id: &str,
    ) -> Result<(Arc<Outbox>, mpsc::Sender<Vec<u8>>)> {
        self.0
            .lock()
            .await
            .get(id)
            .filter(|browser| browser.session_id == session_id)
            .map(|browser| (browser.outbox.clone(), browser.commands.clone()))
            .ok_or_else(|| SshError::new("invalid_input", "Unknown host browser"))
    }

    /// Queues one client message for the relay.
    async fn tell(&self, session_id: &str, id: &str, message: Value) -> Result<Arc<Outbox>> {
        let (outbox, commands) = self.entry(session_id, id).await?;
        commands
            .try_send(wire::encode(&message))
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    SshError::new("busy", "The host browser is not keeping up")
                }
                mpsc::error::TrySendError::Closed(_) => {
                    SshError::new("disconnected", "The host browser has ended")
                }
            })?;
        Ok(outbox)
    }
}

/// Why the app, and not the relay, ended a session.
async fn interrupted(
    access: &AccessLease,
    cancel: &mut watch::Receiver<bool>,
    disconnected: &mut watch::Receiver<bool>,
) -> &'static str {
    // A sender that is gone counts as the signal: nothing is left to stop it.
    tokio::select! { biased;
        _ = access.cancelled() => "Stopped",
        _ = cancel.wait_for(|stopped| *stopped) => "Stopped",
        _ = disconnected.wait_for(|gone| *gone) => "Disconnected",
    }
}

/// One browser's whole life: connect, relay until something ends it, close the channel, say why.
async fn run<E: Exec>(
    connect: impl Future<Output = Result<E>>,
    open: Vec<u8>,
    mut commands: mpsc::Receiver<Vec<u8>>,
    outbox: &Outbox,
    access: AccessLease,
    mut cancel: watch::Receiver<bool>,
    mut disconnected: watch::Receiver<bool>,
) {
    let mut interrupt = pin!(interrupted(&access, &mut cancel, &mut disconnected));
    let mut link = tokio::select! { biased;
        reason = &mut interrupt => {
            outbox.control(Control::closed(reason));
            return;
        }
        linked = connect => match linked {
            Ok(link) => link,
            Err(_) => {
                outbox.control(Control::closed("ConnectFailed"));
                return;
            }
        },
    };
    let ending = tokio::select! { biased;
        reason = &mut interrupt => reason,
        ending = pump(&mut link, open, &mut commands, outbox) => ending,
    };
    link.finish().await;
    // Ignored when the relay already said why.
    outbox.control(Control::closed(ending));
}

/// Opens the relay's session, then moves its messages to the outbox and the renderer's commands to it. The
/// value is the class that names how it ended, for a relay that did not say.
async fn pump<E: Exec>(
    link: &mut E,
    open: Vec<u8>,
    commands: &mut mpsc::Receiver<Vec<u8>>,
    outbox: &Outbox,
) -> &'static str {
    if link.send(&open).await.is_err() {
        return "ChannelFailed";
    }
    let required = format!("{COMPANION_REQUIRED}\n");
    let mut decoder = Decoder::default();
    // A stream that starts with anything but a length is a wrapper's text, not the relay.
    let mut text: Option<Vec<u8>> = None;
    let mut started = false;
    let mut began = false;
    let mut exit = None;
    let start = sleep(START_TIMEOUT);
    let mut start = pin!(start);
    loop {
        let incoming = tokio::select! { biased;
            _ = &mut start, if !began => return "StartTimeout",
            Some(bytes) = commands.recv() => {
                if link.send(&bytes).await.is_err() {
                    return "ChannelFailed";
                }
                continue;
            }
            incoming = link.next() => incoming,
        };
        let bytes = match incoming {
            Incoming::Exit(code) => {
                exit = Some(code);
                continue;
            }
            Incoming::End if text.is_some() => return "ProtocolViolation",
            Incoming::End if exit.is_some_and(|code| code != 0) => return "HostCommandFailed",
            Incoming::End => return "ChannelEnded",
            Incoming::Data(bytes) => bytes,
        };
        if !started {
            let Some(&first) = bytes.first() else {
                continue;
            };
            started = true;
            // A length is below 2^24, so its first byte is zero; the wrapper's marker starts with a letter.
            text = (first != 0).then(Vec::new);
        }
        if let Some(text) = &mut text {
            text.extend_from_slice(&bytes);
            if text.as_slice() == required.as_bytes() {
                return "CompanionRequired";
            }
            if !required.as_bytes().starts_with(text) {
                return "ProtocolViolation";
            }
            continue;
        }
        decoder.push(&bytes);
        loop {
            match decoder.next() {
                Err(_) => return "ProtocolViolation",
                Ok(None) => break,
                Ok(Some(Message::Frame(frame))) => outbox.frame(frame),
                Ok(Some(Message::Control(control))) => {
                    began = true;
                    let closed = matches!(control, Control::Closed { .. });
                    outbox.control(control);
                    if closed {
                        return "ChannelEnded";
                    }
                }
            }
        }
    }
}

/// The first message: the page's size, and an address if the caller has one. The relay checks both again.
fn open_message(viewport: Viewport, url: Option<&str>) -> Result<Vec<u8>> {
    let address = |url: &str| {
        url == "about:blank"
            || ((url.starts_with("http://") || url.starts_with("https://"))
                && url.len() <= MAX_ADDRESS
                && url.bytes().all(|byte| byte.is_ascii_graphic()))
    };
    if !viewport.valid() {
        return Err(SshError::new(
            "invalid_input",
            "The host browser's size is out of range",
        ));
    }
    if url.is_some_and(|url| !address(url)) {
        return Err(SshError::new(
            "invalid_input",
            "The host browser opens only http, https and about:blank addresses",
        ));
    }
    let mut open = json!({"type": "open", "browser": "chrome", "viewport": viewport});
    if let Some(url) = url {
        open["url"] = url.into();
    }
    Ok(wire::encode(&open))
}

/// Starts a browser on the host and returns its token. The channel opens in the background: the renderer
/// learns how it went from the messages it pulls, `closed` among them. With `keep_profile` the relay keeps the
/// browser's profile on the host until **Clear browser data**; without it the profile ends with the session.
#[tauri::command]
pub async fn host_browser_start(
    access: AccessLease,
    state: State<'_, AppState>,
    browsers: State<'_, HostBrowsers>,
    session_id: String,
    viewport: Viewport,
    url: Option<String>,
    keep_profile: Option<bool>,
) -> Protected<String> {
    access
        .run(async {
            let open = open_message(viewport, url.as_deref())?;
            let serve = serve_command(keep_profile.unwrap_or(false));
            let session = state.session(&session_id).await?;
            let disconnected = session.cancel.subscribe();
            let lease = access.clone();
            let connect = async move {
                let command =
                    crate::companion::required_command(&session, serve, COMPANION_REQUIRED, &lease)
                        .await?;
                let channel = ssh::open_owned_channel(
                    &session.handle,
                    &lease,
                    Instant::now() + Duration::from_secs(10),
                )
                .await?;
                lease.check()?;
                timeout(Duration::from_secs(10), channel.exec(true, command))
                    .await
                    .map_err(|_| SshError::new("timeout", "Starting the host browser timed out"))?
                    .map_err(SshError::from)?;
                Ok(Remote(channel))
            };
            browsers
                .spawn(access.clone(), session_id, open, disconnected, connect)
                .await
        })
        .await
}

/// The next message, as bytes: the relay's tag (1, a JSON object; 2, a frame) and the message without its
/// length, or a single zero byte when nothing came for a while. Fails once the end was read.
#[tauri::command]
pub async fn host_browser_next(
    access: AccessLease,
    browsers: State<'_, HostBrowsers>,
    session_id: String,
    browser_id: String,
) -> Protected<Response> {
    access
        .run(async {
            let (outbox, _) = browsers.entry(&session_id, &browser_id).await?;
            outbox.pull(IDLE_PULL).await.map(Response::new)
        })
        .await
}

/// The renderer decoded frame `sequence`: the relay may send another.
#[tauri::command]
pub async fn host_browser_ack(
    access: AccessLease,
    browsers: State<'_, HostBrowsers>,
    session_id: String,
    browser_id: String,
    sequence: u32,
    decode_ms: Option<u32>,
) -> Protected<()> {
    access
        .run(async {
            let mut ack = json!({"type": "ack", "sequence": sequence});
            if let Some(decode_ms) = decode_ms {
                ack["decodeMs"] = decode_ms.into();
            }
            browsers.tell(&session_id, &browser_id, ack).await.map(drop)
        })
        .await
}

/// The view is hidden: the relay stops the screencast at the browser and holds nothing.
#[tauri::command]
pub async fn host_browser_pause(
    access: AccessLease,
    browsers: State<'_, HostBrowsers>,
    session_id: String,
    browser_id: String,
) -> Protected<()> {
    access
        .run(async {
            let outbox = browsers
                .tell(&session_id, &browser_id, json!({"type": "pause"}))
                .await?;
            outbox.drop_frames();
            Ok(())
        })
        .await
}

#[tauri::command]
pub async fn host_browser_resume(
    access: AccessLease,
    browsers: State<'_, HostBrowsers>,
    session_id: String,
    browser_id: String,
) -> Protected<()> {
    access
        .run(async {
            browsers
                .tell(&session_id, &browser_id, json!({"type": "resume"}))
                .await
                .map(drop)
        })
        .await
}

/// Closes the channel, which ends the browser, and waits for the worker to confirm it. Needs no unlocked app:
/// ending a browser is always allowed.
#[tauri::command]
pub async fn host_browser_stop(
    browsers: State<'_, HostBrowsers>,
    session_id: String,
    browser_id: String,
) -> Result<()> {
    let (cancel, mut done) = {
        let entries = browsers.0.lock().await;
        match entries.get(&browser_id) {
            None => return Ok(()),
            Some(browser) if browser.session_id != session_id => {
                return Err(SshError::new(
                    "invalid_input",
                    "The host browser belongs to another session",
                ));
            }
            Some(browser) => (browser.cancel.clone(), browser.done.clone()),
        }
    };
    cancel.send_replace(true);
    // A worker that dropped its sender is as finished as one that said so.
    if !*done.borrow() {
        let waited = timeout(STOP_WAIT, async {
            let _ = done.wait_for(|finished| *finished).await;
        });
        if waited.await.is_err() {
            return Err(SshError::new("timeout", "Host browser cleanup timed out"));
        }
    }
    browsers.0.lock().await.remove(&browser_id);
    Ok(())
}
