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
/// Conversation streams (the Agent view's) that may run at once.
const MAX_WATCHES: usize = 4;
/// Herdr event streams that may run at once: the inbox monitor follows up to 32 hosts. They are counted apart, so
/// they neither use up the conversation streams nor are refused by them.
const MAX_EVENT_STREAMS: usize = 32;
const EVENTS_SLOT: &str = "herdrEvents";
/// The transcript stream's frames and the Herdr event stream's (`status`, `changed`, `unsupported`).
const FRAME_TYPES: [&str; 8] = [
    "hello",
    "snapshot",
    "delta",
    "heartbeat",
    "end",
    "status",
    "changed",
    "unsupported",
];

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
        #[serde(default)]
        allow_large_history: bool,
        /// OpenCode keeps every session in one database: `path` names it and this picks the session.
        #[serde(default)]
        transcript_session_id: Option<String>,
    },
    /// A Herdr pane's agent session, resolved on the host and re-checked while it is watched.
    #[serde(rename_all = "camelCase")]
    Herdr {
        agent: String,
        agent_session_id: String,
        herdr_session: String,
        pane_id: String,
        terminal_id: String,
        #[serde(default)]
        allow_large_history: bool,
    },
    /// The agent-status changes of one Herdr server (`lazysh-agent herdr-events`, #1692).
    #[serde(rename_all = "camelCase")]
    HerdrEvents { herdr_session: String },
}
impl WatchTarget {
    /// A view's watches replace each other only within the same slot, so the event streams of two Herdr
    /// servers and a conversation stream of one session run side by side.
    fn slot(&self) -> String {
        match self {
            Self::HerdrEvents { herdr_session } => format!("{EVENTS_SLOT}:{herdr_session}"),
            _ => "transcript".into(),
        }
    }
}
/// Whether another watch of this slot's kind would pass the bound of that kind.
fn crowded(entries: &HashMap<String, Watch>, slot: &str) -> bool {
    let events = slot.starts_with(EVENTS_SLOT);
    let same_kind = entries
        .values()
        .filter(|watch| watch.slot.starts_with(EVENTS_SLOT) == events)
        .count();
    let bound = if events {
        MAX_EVENT_STREAMS
    } else {
        MAX_WATCHES
    };
    same_kind >= bound
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
    slot: String,
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
    let (agent, source, large) = match target {
        WatchTarget::HerdrEvents { herdr_session } => {
            crate::herdr::text(herdr_session, 200)?;
            return Ok(format!(
                "lazysh-agent herdr-events --session {}",
                quote(herdr_session)
            ));
        }
        WatchTarget::Path {
            agent,
            path,
            inline_images,
            allow_large_history,
            transcript_session_id,
        } => {
            ssh::check_path(path)?;
            let images = if *inline_images {
                " --inline-images"
            } else {
                ""
            };
            // A database session is the OpenCode source and only that; previews are a transcript file's.
            let session = match (agent.as_str(), transcript_session_id) {
                ("opencode", Some(id))
                    if !*inline_images
                        && !id.is_empty()
                        && id.len() <= 256
                        && !id.chars().any(char::is_control) =>
                {
                    format!(" --database-session {}", quote(id))
                }
                ("opencode", _) | (_, Some(_)) => {
                    return Err(SshError::new(
                        "invalid_input",
                        "Invalid live conversation source",
                    ))
                }
                _ => String::new(),
            };
            (
                agent,
                format!("--path {}{images}{session}", quote(path)),
                *allow_large_history,
            )
        }
        WatchTarget::Herdr {
            agent,
            agent_session_id,
            allow_large_history,
            ..
        } => {
            // A provider session id is Claude Code's and Codex's; OpenCode is read from its database.
            if agent == "opencode"
                || uuid::Uuid::parse_str(agent_session_id)
                    .ok()
                    .is_none_or(|id| id.to_string() != *agent_session_id)
            {
                return Err(SshError::new(
                    "invalid_input",
                    "Invalid agent session reference",
                ));
            }
            (
                agent,
                format!("--session-id {}", quote(agent_session_id)),
                *allow_large_history,
            )
        }
    };
    if !matches!(agent.as_str(), "claude" | "codex" | "opencode") {
        return Err(SshError::new(
            "invalid_input",
            "Live updates cover Claude Code, Codex and OpenCode",
        ));
    }
    if large && agent != "codex" {
        return Err(SshError::new(
            "invalid_input",
            "Large history is only available for Codex",
        ));
    }
    let large = if large { " --allow-large-history" } else { "" };
    Ok(format!(
        "lazysh-agent transcript-watch --agent {agent} {source} --limit 50{large}"
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
    // A Windows host's PowerShell ends every line with CR LF.
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line == COMPANION_REQUIRED.as_bytes() {
        return Ok(Verdict::Unavailable("companion_required"));
    }
    Ok(match frame(line)? {
        None => Verdict::Skip,
        Some(value) if value["type"] == "hello" && value["protocol"] != 1 => {
            Verdict::Unavailable("unsupported_protocol")
        }
        // The host's Herdr cannot stream (an old Herdr, or too many panes): poll, and ask again later.
        Some(value) if value["type"] == "unsupported" => Verdict::Unavailable("events_unsupported"),
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
    herdr_path: Option<bool>,
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
    // `herdr session list` runs in the companion: give it the same PATH fallback as the app's own Herdr reads.
    let command = match herdr_path {
        Some(admitted) => crate::herdr_path::select(&command, admitted),
        None => command,
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

/// A view that rebinds replaces its own watch of that slot; another session's or slot's watch stays.
fn retire(entries: &mut HashMap<String, Watch>, session_id: &str, slot: &str) {
    entries.retain(|_, watch| {
        let same = watch.session_id == session_id && watch.slot == slot;
        if same {
            watch.cancel.send_replace(true);
        }
        !same && !*watch.done.borrow()
    });
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
                    ..
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
                WatchTarget::Path { .. } | WatchTarget::HerdrEvents { .. } => None,
            };
            let herdr_path = match target {
                WatchTarget::HerdrEvents { .. } => {
                    Some(crate::herdr_path::admit(&session, &access).await?)
                }
                _ => None,
            };
            let slot = target.slot();
            let mut entries = watches.0.lock().await;
            retire(&mut entries, &session_id, &slot);
            if crowded(&entries, &slot) {
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
                        slot,
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
                    herdr_path,
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
    fn commands_name_one_source_and_only_the_streamed_agents() {
        let path = WatchTarget::Path {
            agent: "claude".into(),
            path: "/home/o wner/it's.jsonl".into(),
            inline_images: false,
            allow_large_history: false,
            transcript_session_id: None,
        };
        assert_eq!(target_command(&path).unwrap(), "lazysh-agent transcript-watch --agent claude --path '/home/o wner/it'\\''s.jsonl' --limit 50");
        let with_images = WatchTarget::Path {
            agent: "codex".into(),
            path: "/x".into(),
            inline_images: true,
            allow_large_history: false,
            transcript_session_id: None,
        };
        assert_eq!(
            target_command(&with_images).unwrap(),
            "lazysh-agent transcript-watch --agent codex --path '/x' --inline-images --limit 50"
        );
        let database = |agent: &str, images: bool, id: Option<&str>| WatchTarget::Path {
            agent: agent.into(),
            path: "/db/opencode.db".into(),
            inline_images: images,
            allow_large_history: false,
            transcript_session_id: id.map(Into::into),
        };
        assert_eq!(
            target_command(&database("opencode", false, Some("ses_a'b"))).unwrap(),
            "lazysh-agent transcript-watch --agent opencode --path '/db/opencode.db' --database-session 'ses_a'\\''b' --limit 50"
        );
        // An OpenCode watch names its session and takes no previews; a session means nothing to another agent.
        for bad in [
            database("opencode", false, None),
            database("opencode", false, Some("")),
            database("opencode", false, Some("a\nb")),
            database("opencode", false, Some(&"s".repeat(257))),
            database("opencode", true, Some("ses_a")),
            database("claude", false, Some("ses_a")),
        ] {
            assert!(target_command(&bad).is_err());
        }
        let herdr = |agent: &str, id: &str| WatchTarget::Herdr {
            agent: agent.into(),
            agent_session_id: id.into(),
            herdr_session: "s".into(),
            pane_id: "p_1".into(),
            terminal_id: "t".into(),
            allow_large_history: false,
        };
        assert_eq!(
            target_command(&herdr("codex", ID)).unwrap(),
            format!("lazysh-agent transcript-watch --agent codex --session-id '{ID}' --limit 50")
        );
        let mut opted_in = herdr("codex", ID);
        if let WatchTarget::Herdr {
            allow_large_history,
            ..
        } = &mut opted_in
        {
            *allow_large_history = true;
        }
        assert!(target_command(&opted_in)
            .unwrap()
            .ends_with(" --allow-large-history"));
        let mut invalid = herdr("claude", ID);
        if let WatchTarget::Herdr {
            allow_large_history,
            ..
        } = &mut invalid
        {
            *allow_large_history = true;
        }
        assert!(target_command(&invalid).is_err());
        for bad in [
            herdr("pi", ID),
            herdr("opencode", ID),
            herdr("claude", "not-a-uuid"),
            herdr("claude", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
        ] {
            assert!(target_command(&bad).is_err());
        }
        let other = WatchTarget::Path {
            agent: "grok-acp".into(),
            path: "/x".into(),
            inline_images: false,
            allow_large_history: false,
            transcript_session_id: None,
        };
        assert!(target_command(&other).is_err());
    }

    #[test]
    fn the_herdr_event_stream_names_one_quoted_server_and_no_agent() {
        let events = |name: &str| WatchTarget::HerdrEvents {
            herdr_session: name.into(),
        };
        assert_eq!(
            target_command(&events("work")).unwrap(),
            "lazysh-agent herdr-events --session 'work'"
        );
        assert_eq!(
            target_command(&events("a'$(echo x); b")).unwrap(),
            "lazysh-agent herdr-events --session 'a'\\''$(echo x); b'"
        );
        for bad in ["", "a\nb", &"x".repeat(201)] {
            assert!(target_command(&events(bad)).is_err(), "{bad:?}");
        }
        let parsed: WatchTarget =
            serde_json::from_value(json!({"kind":"herdrEvents","herdrSession":"work"})).unwrap();
        assert!(
            matches!(parsed, WatchTarget::HerdrEvents { herdr_session } if herdr_session == "work")
        );
        assert!(serde_json::from_value::<WatchTarget>(
            json!({"kind":"herdrEvents","herdrSession":"work","agent":"claude"})
        )
        .is_err());
    }

    #[test]
    fn herdr_event_frames_pass_and_a_herdr_that_cannot_stream_is_not_retried_soon() {
        for kind in ["status", "changed"] {
            assert!(matches!(
                judge(json!({"type":kind}).to_string().as_bytes()).unwrap(),
                Verdict::Send(_)
            ));
        }
        assert!(matches!(
            judge(
                json!({"type":"unsupported","reason":"events_subscribe"})
                    .to_string()
                    .as_bytes()
            )
            .unwrap(),
            Verdict::Unavailable("events_unsupported")
        ));
    }

    /// A running watch of `slot` for `session`, and the receiver that sees it cancelled.
    fn watching(session: &str, slot: &str) -> (Watch, watch::Receiver<bool>) {
        let (cancel, cancelled) = watch::channel(false);
        let (_done, done) = watch::channel(false);
        let watch = Watch {
            session_id: session.into(),
            slot: slot.into(),
            cancel,
            done,
        };
        (watch, cancelled)
    }
    /// Retires `slot` of `session` among the watches `[(token, session, slot)]` and returns what is left
    /// and which tokens were cancelled.
    fn retired(
        watches: &[(&'static str, &str, &str)],
        session: &str,
        slot: &str,
    ) -> (Vec<String>, Vec<&'static str>) {
        let mut entries = HashMap::new();
        let mut cancels = HashMap::new();
        for (token, owner, kind) in watches {
            let (watch, cancelled) = watching(owner, kind);
            entries.insert(token.to_string(), watch);
            cancels.insert(*token, cancelled);
        }
        retire(&mut entries, session, slot);
        let mut left: Vec<_> = entries.keys().cloned().collect();
        left.sort();
        let mut cancelled: Vec<_> = cancels
            .into_iter()
            .filter(|(_, cancelled)| *cancelled.borrow())
            .map(|(token, _)| token)
            .collect();
        cancelled.sort();
        (left, cancelled)
    }

    #[tokio::test]
    async fn a_rebinding_view_replaces_only_its_own_slot_of_its_own_session() {
        let (left, cancelled) = retired(
            &[
                ("a", "one", "transcript"),
                ("b", "one", "herdrEvents:main"),
                ("c", "two", "herdrEvents:main"),
            ],
            "one",
            "herdrEvents:main",
        );
        assert_eq!(left, ["a", "c"]);
        assert_eq!(cancelled, ["b"]);
    }

    #[tokio::test]
    async fn the_event_streams_of_two_servers_of_one_connection_do_not_replace_each_other() {
        // The inbox follows the attached server while a Herdr view may follow another one.
        let (left, cancelled) = retired(
            &[
                ("a", "one", "herdrEvents:main"),
                ("b", "one", "herdrEvents:other"),
            ],
            "one",
            "herdrEvents:main",
        );
        assert_eq!(left, ["b"]);
        assert_eq!(cancelled, ["a"]);
    }

    #[test]
    fn event_streams_and_conversation_streams_are_bounded_apart() {
        let mut entries = HashMap::new();
        let events = |index: usize| format!("herdrEvents:server-{index}");
        for index in 0..MAX_WATCHES {
            entries.insert(format!("c{index}"), watching("one", "transcript").0);
        }
        // Four conversations refuse a fifth, and leave the event streams alone.
        assert!(crowded(&entries, "transcript"));
        assert!(!crowded(&entries, &events(0)));
        for index in 0..MAX_EVENT_STREAMS {
            entries.insert(format!("e{index}"), watching("two", &events(index)).0);
        }
        assert!(crowded(&entries, &events(99)));
        // Thirty-two event streams do not take a conversation slot.
        entries.remove("c0");
        assert!(!crowded(&entries, "transcript"));
        entries.remove("e0");
        assert!(!crowded(&entries, &events(99)));
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
        for line in [COMPANION_REQUIRED, &format!("{COMPANION_REQUIRED}\r")] {
            assert!(matches!(
                judge(line.as_bytes()).unwrap(),
                Verdict::Unavailable("companion_required")
            ));
        }
        assert!(matches!(
            judge(b"{\"type\":\"hello\",\"protocol\":1}\r").unwrap(),
            Verdict::Send(_)
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
        let database: WatchTarget = serde_json::from_value(
            json!({"kind":"path","agent":"opencode","path":"/a.db","transcriptSessionId":"ses_a"}),
        )
        .unwrap();
        assert!(
            matches!(database, WatchTarget::Path { transcript_session_id: Some(id), .. } if id == "ses_a")
        );
        let herdr: WatchTarget = serde_json::from_value(json!({"kind":"herdr","agent":"codex","agentSessionId":ID,"herdrSession":"s","paneId":"p","terminalId":"t"})).unwrap();
        assert!(matches!(herdr, WatchTarget::Herdr { .. }));
        for bad in [
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
        let (watch, cancelled) = watching("session", "transcript");
        watches.0.lock().await.insert("token".into(), watch);
        watches.cancel_for_lock().await;
        assert!(*cancelled.borrow());
    }
}
