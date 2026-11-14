//! One long-lived `lazysh-agent transcript-watch` exec channel per Agent view (#1124).
//!
//! The channel pushes the companion's frames to the renderer as they arrive. It is closed when the
//! view stops it, the session or the app lock ends, or the host stops talking; the renderer then
//! falls back to polling. A companion that predates the subcommand is reported, never retried.
use crate::{
    app_lock::{AccessLease, Guarded, GuardedError},
    ssh::{self, quote, AppState, Result, Session, SshError},
};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::{ipc::Channel, State};
use tokio::sync::{watch, Mutex};

type Protected<T> = std::result::Result<Guarded<T>, GuardedError<SshError>>;
/// Printed by the `required_command` wrapper when the host has no `transcript-watch`.
pub(crate) const COMPANION_REQUIRED: &str = "lazysh-transcript-watch-companion-required-v1";
/// The companion's frame cap is 1 MiB; one more line of slack for the envelope.
const MAX_LINE: usize = 1024 * 1024 + 4096;
/// The companion sends a heartbeat after 5 s of silence; four missed ones is a dead channel.
const QUIET: Duration = Duration::from_secs(20);
/// How often the selected Herdr agent is checked to still be the same pane's agent.
const RECHECK: Duration = Duration::from_secs(10);
const MAX_WATCHES: usize = 4;
const FRAME_TYPES: [&str; 5] = ["hello", "snapshot", "delta", "heartbeat", "end"];

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum WatchTarget {
    /// A transcript file the hook reports bound to the pane.
    #[serde(rename_all = "camelCase")]
    Path {
        agent: String,
        path: String,
        /// Also carry the bounded previews of the images the user attached.
        #[serde(default)]
        inline_images: bool,
    },
    /// A conversation named by the companion's opaque reference, never by its host path.
    #[serde(rename_all = "camelCase")]
    Reference {
        agent: String,
        reference: String,
        #[serde(default)]
        inline_images: bool,
    },
    /// A Herdr pane's agent session, resolved on the host and re-checked while it is watched.
    #[serde(rename_all = "camelCase")]
    Herdr {
        agent: String,
        agent_session_id: String,
        herdr_session: String,
        pane_id: String,
        terminal_id: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatchEvent {
    /// A companion frame, forwarded unchanged; the renderer validates it strictly.
    Frame { frame: Value },
    /// The host cannot stream: `companion_required` or `unsupported_protocol`. Do not retry.
    Unavailable { reason: &'static str },
    /// The channel ended: an error kind, or `ended`. Poll and try again later.
    Closed { reason: String },
}

#[derive(Default)]
pub struct TranscriptWatches(Mutex<HashMap<String, Watch>>);
struct Watch {
    session_id: String,
    cancel: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}
impl TranscriptWatches {
    pub(crate) async fn cancel_for_lock(&self) {
        let mut watches = self.0.lock().await;
        for watch in watches.values() {
            watch.cancel.send_replace(true);
        }
        watches.retain(|_, watch| !*watch.done.borrow());
    }
}

fn target_command(target: &WatchTarget) -> Result<String> {
    let images = |on: &bool| if *on { " --inline-images" } else { "" };
    let (agent, source) = match target {
        WatchTarget::Path {
            agent,
            path,
            inline_images,
        } => {
            ssh::check_path(path)?;
            (
                agent,
                format!("--path {}{}", quote(path), images(inline_images)),
            )
        }
        WatchTarget::Reference {
            agent,
            reference,
            inline_images,
        } => {
            ssh::check_reference(reference)?;
            (
                agent,
                format!("--reference {}{}", quote(reference), images(inline_images)),
            )
        }
        WatchTarget::Herdr {
            agent,
            agent_session_id,
            ..
        } => {
            if uuid::Uuid::parse_str(agent_session_id)
                .ok()
                .is_none_or(|id| id.to_string() != *agent_session_id)
            {
                return Err(SshError::new(
                    "invalid_input",
                    "Invalid agent session reference",
                ));
            }
            (agent, format!("--session-id {}", quote(agent_session_id)))
        }
    };
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(SshError::new(
            "invalid_input",
            "Live updates cover Claude Code and Codex",
        ));
    }
    Ok(format!(
        "lazysh-agent transcript-watch --agent {agent} {source} --limit 50"
    ))
}

/// The pane whose agent a Herdr watch must keep showing.
struct HerdrCheck {
    server: String,
    pane: String,
    terminal: String,
    agent: String,
    session: String,
}

/// A line is a frame of a type this client knows, or nothing: later protocol versions only add types.
fn frame(line: &[u8]) -> Result<Option<Value>> {
    let value: Value = serde_json::from_slice(line)
        .map_err(|_| SshError::new("invalid_output", "Invalid live update"))?;
    let kind = value["type"]
        .as_str()
        .ok_or_else(|| SshError::new("invalid_output", "Invalid live update"))?;
    Ok(FRAME_TYPES.contains(&kind).then_some(value))
}

enum Verdict {
    Send(Value),
    Skip,
    Unavailable(&'static str),
}
fn judge(line: &[u8]) -> Result<Verdict> {
    if line == COMPANION_REQUIRED.as_bytes() {
        return Ok(Verdict::Unavailable("companion_required"));
    }
    Ok(match frame(line)? {
        None => Verdict::Skip,
        Some(value) if value["type"] == "hello" && value["protocol"] != 1 => {
            Verdict::Unavailable("unsupported_protocol")
        }
        Some(value) => Verdict::Send(value),
    })
}

fn closed(reason: impl ToString) -> WatchEvent {
    WatchEvent::Closed {
        reason: reason.to_string(),
    }
}

async fn run(
    access: AccessLease,
    session: Arc<Session>,
    command: String,
    herdr: Option<HerdrCheck>,
    events: Channel<WatchEvent>,
    mut cancel: watch::Receiver<bool>,
) -> Result<WatchEvent> {
    access.check()?;
    let mut disconnected = session.cancel.subscribe();
    let stopped = |cancel: &watch::Receiver<bool>, gone: &watch::Receiver<bool>| {
        *cancel.borrow() || *gone.borrow()
    };
    if stopped(&cancel, &disconnected) {
        return Ok(closed("stopped"));
    }
    let command = tokio::select! {biased;
        _=access.cancelled()=>return Ok(closed("stopped")),
        _=cancel.changed()=>return Ok(closed("stopped")),
        _=disconnected.changed()=>return Ok(closed("disconnected")),
        result=crate::companion::required_command(&session,command,COMPANION_REQUIRED,&access)=>result?,
    };
    let mut channel = tokio::select! {biased;
        _=access.cancelled()=>return Ok(closed("stopped")),
        _=cancel.changed()=>return Ok(closed("stopped")),
        _=disconnected.changed()=>return Ok(closed("disconnected")),
        result=ssh::open_owned_channel(&session.handle,&access,tokio::time::Instant::now()+Duration::from_secs(10))=>result?,
    };
    let outcome = async {
        tokio::time::timeout(Duration::from_secs(10), channel.exec(true, command))
            .await
            .map_err(|_| SshError::new("timeout", "Starting live updates timed out"))?
            .map_err(SshError::from)?;
        let mut buffer: Vec<u8> = Vec::new();
        let mut recheck = tokio::time::interval_at(tokio::time::Instant::now() + RECHECK, RECHECK);
        let mut last = tokio::time::Instant::now();
        loop {
            let message = tokio::select! {biased;
                _=access.cancelled()=>return Ok(closed("stopped")),
                _=cancel.changed()=>return Ok(closed("stopped")),
                _=disconnected.changed()=>return Ok(closed("disconnected")),
                _=tokio::time::sleep_until(last+QUIET)=>return Err(SshError::new("timeout","The host stopped sending live updates")),
                _=recheck.tick(),if herdr.is_some()=>{
                    if let Some(pane) = &herdr {
                        crate::herdr::check_selected(&session,&pane.server,&pane.pane,&pane.terminal,&pane.agent,&pane.session,&access).await?;
                    }
                    continue;
                },
                message=channel.wait()=>message,
            };
            last = tokio::time::Instant::now();
            match message {
                Some(ChannelMsg::Data { data }) => {
                    for byte in data.iter().copied() {
                        if byte != b'\n' {
                            if buffer.len() >= MAX_LINE {
                                return Err(SshError::new(
                                    "output_too_large",
                                    "A live update exceeds its limit",
                                ));
                            }
                            buffer.push(byte);
                            continue;
                        }
                        access.check()?;
                        let verdict = judge(&buffer)?;
                        buffer.clear();
                        match verdict {
                            Verdict::Send(frame) => events
                                .send(WatchEvent::Frame { frame })
                                .map_err(|_| SshError::new("disconnected", "Live updates closed"))?,
                            Verdict::Skip => {}
                            Verdict::Unavailable(reason) => {
                                return Ok(WatchEvent::Unavailable { reason })
                            }
                        }
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) if exit_status != 0 => {
                    return Err(SshError::new(
                        "remote_command_failed",
                        "The host stopped live updates",
                    ))
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => return Ok(closed("ended")),
                _ => {}
            }
        }
    }
    .await;
    // EOF ends the companion's stdin watcher, which ends the host process.
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        let _ = channel.eof().await;
        channel.close().await
    })
    .await;
    outcome
}

#[tauri::command]
pub async fn agent_watch_start(
    access: AccessLease,
    state: State<'_, AppState>,
    watches: State<'_, TranscriptWatches>,
    session_id: String,
    target: WatchTarget,
    events: Channel<WatchEvent>,
) -> Protected<String> {
    access
        .run(async {
            let command = target_command(&target)?;
            let session = state.session(&session_id).await?;
            let herdr = match &target {
                WatchTarget::Herdr {
                    herdr_session,
                    pane_id,
                    terminal_id,
                    agent,
                    agent_session_id,
                } => {
                    let pane = HerdrCheck {
                        server: herdr_session.clone(),
                        pane: pane_id.clone(),
                        terminal: terminal_id.clone(),
                        agent: agent.clone(),
                        session: agent_session_id.clone(),
                    };
                    crate::herdr::check_selected(
                        &session,
                        &pane.server,
                        &pane.pane,
                        &pane.terminal,
                        &pane.agent,
                        &pane.session,
                        &access,
                    )
                    .await?;
                    Some(pane)
                }
                WatchTarget::Path { .. } | WatchTarget::Reference { .. } => None,
            };
            let mut entries = watches.0.lock().await;
            // A view that rebinds replaces its own watch; another session's watch stays.
            entries.retain(|_, watch| {
                let same = watch.session_id == session_id;
                if same {
                    watch.cancel.send_replace(true);
                }
                !same && !*watch.done.borrow()
            });
            if entries.len() >= MAX_WATCHES {
                return Err(SshError::new(
                    "busy",
                    "Too many live conversations are open",
                ));
            }
            let token = uuid::Uuid::new_v4().to_string();
            let (cancel, request) = watch::channel(false);
            let (done, completion) = watch::channel(false);
            access.check()?;
            access.with_current(|| {
                entries.insert(
                    token.clone(),
                    Watch {
                        session_id,
                        cancel,
                        done: completion,
                    },
                );
            })?;
            let source_access = access.clone();
            tauri::async_runtime::spawn(async move {
                let end = match run(
                    source_access.clone(),
                    session,
                    command,
                    herdr,
                    events.clone(),
                    request,
                )
                .await
                {
                    Ok(event) => event,
                    Err(error) => closed(error.kind()),
                };
                if source_access.check().is_ok() {
                    let _ = events.send(end);
                }
                done.send_replace(true);
            });
            Ok(token)
        })
        .await
}

#[tauri::command]
pub async fn agent_watch_stop(
    watches: State<'_, TranscriptWatches>,
    session_id: String,
    watch_id: String,
) -> Result<()> {
    let mut entries = watches.0.lock().await;
    let Some(watch) = entries.get(&watch_id) else {
        return Ok(());
    };
    if watch.session_id != session_id {
        return Err(SshError::new(
            "invalid_input",
            "Live updates belong to another session",
        ));
    }
    let (cancel, mut done) = (watch.cancel.clone(), watch.done.clone());
    entries.remove(&watch_id);
    drop(entries);
    cancel.send_replace(true);
    if !*done.borrow() {
        let _ = tokio::time::timeout(Duration::from_secs(5), done.changed()).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn commands_name_one_source_and_only_the_two_streamed_agents() {
        let path = WatchTarget::Path {
            agent: "claude".into(),
            path: "/home/o wner/it's.jsonl".into(),
            inline_images: false,
        };
        assert_eq!(target_command(&path).unwrap(), "lazysh-agent transcript-watch --agent claude --path '/home/o wner/it'\\''s.jsonl' --limit 50");
        let with_images = WatchTarget::Path {
            agent: "codex".into(),
            path: "/x".into(),
            inline_images: true,
        };
        assert_eq!(
            target_command(&with_images).unwrap(),
            "lazysh-agent transcript-watch --agent codex --path '/x' --inline-images --limit 50"
        );
        let reference = |agent: &str, id: &str, inline_images| WatchTarget::Reference {
            agent: agent.into(),
            reference: id.into(),
            inline_images,
        };
        assert_eq!(
            target_command(&reference("claude", ID, true)).unwrap(),
            format!("lazysh-agent transcript-watch --agent claude --reference '{ID}' --inline-images --limit 50")
        );
        for bad in [
            reference("pi", ID, false),
            reference("claude", "/home/owner/session.jsonl", false),
            reference("claude", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", false),
        ] {
            assert!(target_command(&bad).is_err());
        }
        let herdr = |agent: &str, id: &str| WatchTarget::Herdr {
            agent: agent.into(),
            agent_session_id: id.into(),
            herdr_session: "s".into(),
            pane_id: "p_1".into(),
            terminal_id: "t".into(),
        };
        assert_eq!(
            target_command(&herdr("codex", ID)).unwrap(),
            format!("lazysh-agent transcript-watch --agent codex --session-id '{ID}' --limit 50")
        );
        for bad in [
            herdr("pi", ID),
            herdr("claude", "not-a-uuid"),
            herdr("claude", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
        ] {
            assert!(target_command(&bad).is_err());
        }
        let other = WatchTarget::Path {
            agent: "grok-acp".into(),
            path: "/x".into(),
            inline_images: false,
        };
        assert!(target_command(&other).is_err());
    }

    #[test]
    fn lines_are_known_frames_the_old_marker_or_an_error() {
        assert!(matches!(
            judge(json!({"type":"hello","protocol":1}).to_string().as_bytes()).unwrap(),
            Verdict::Send(_)
        ));
        assert!(matches!(
            judge(json!({"type":"hello","protocol":2}).to_string().as_bytes()).unwrap(),
            Verdict::Unavailable("unsupported_protocol")
        ));
        // A later companion may add frame types; they are ignored, not errors.
        assert!(matches!(
            judge(json!({"type":"progress"}).to_string().as_bytes()).unwrap(),
            Verdict::Skip
        ));
        assert!(matches!(
            judge(COMPANION_REQUIRED.as_bytes()).unwrap(),
            Verdict::Unavailable("companion_required")
        ));
        for bad in ["{ not json", "[]", "{\"type\":3}", "usage: lazysh-agent"] {
            assert_eq!(
                judge(bad.as_bytes()).err().unwrap().kind(),
                "invalid_output"
            );
        }
    }

    #[test]
    fn targets_arrive_as_the_renderer_sends_them_and_events_leave_as_it_expects() {
        let path: WatchTarget =
            serde_json::from_value(json!({"kind":"path","agent":"claude","path":"/a"})).unwrap();
        assert!(matches!(path, WatchTarget::Path { .. }));
        let herdr: WatchTarget = serde_json::from_value(json!({"kind":"herdr","agent":"codex","agentSessionId":ID,"herdrSession":"s","paneId":"p","terminalId":"t"})).unwrap();
        assert!(matches!(herdr, WatchTarget::Herdr { .. }));
        let reference: WatchTarget =
            serde_json::from_value(json!({"kind":"reference","agent":"claude","reference":ID}))
                .unwrap();
        assert!(matches!(
            reference,
            WatchTarget::Reference {
                inline_images: false,
                ..
            }
        ));
        for bad in [
            json!({"kind":"reference","agent":"claude","reference":ID,"path":"/a"}),
            json!({"kind":"path","agent":"claude","path":"/a","extra":1}),
            json!({"kind":"shell","agent":"claude"}),
        ] {
            assert!(serde_json::from_value::<WatchTarget>(bad).is_err());
        }
        assert_eq!(
            serde_json::to_value(WatchEvent::Frame {
                frame: json!({"type":"hello"})
            })
            .unwrap(),
            json!({"type":"frame","frame":{"type":"hello"}})
        );
        assert_eq!(
            serde_json::to_value(WatchEvent::Unavailable {
                reason: "companion_required"
            })
            .unwrap(),
            json!({"type":"unavailable","reason":"companion_required"})
        );
        assert_eq!(
            serde_json::to_value(closed("ended")).unwrap(),
            json!({"type":"closed","reason":"ended"})
        );
    }

    #[tokio::test]
    async fn lock_cancels_every_watch() {
        let watches = TranscriptWatches::default();
        let (cancel, cancelled) = watch::channel(false);
        let (_done, done) = watch::channel(false);
        watches.0.lock().await.insert(
            "token".into(),
            Watch {
                session_id: "session".into(),
                cancel,
                done,
            },
        );
        watches.cancel_for_lock().await;
        assert!(*cancelled.borrow());
    }
}
