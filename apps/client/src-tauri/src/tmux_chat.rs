//! Explicit terminal destination authority, never an assertion of agent identity.
use super::*;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    agent: Agent,
    path: String,
    view: View,
    inline_images: bool,
    #[serde(
        default,
        deserialize_with = "present_selector",
        skip_serializing_if = "Option::is_none"
    )]
    transcript_session_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum View {
    Records,
    Conversation,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Agent {
    Claude,
    Codex,
    Pi,
    Omp,
    Hermes,
    Opencode,
    Copilot,
    #[serde(rename = "qoder-ide")]
    QoderIde,
    Kimi,
    Jcode,
    Droid,
    Gemini,
    Cursor,
    Omo,
    #[serde(rename = "devin-atif")]
    DevinAtif,
    #[serde(rename = "amp-json")]
    AmpJson,
    #[serde(rename = "grok-acp")]
    GrokAcp,
    #[serde(rename = "antigravity-jsonl")]
    AntigravityJsonl,
}
// A missing selector preserves the legacy four fields; a present null is not absence.
fn present_selector<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}
impl Source {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.path.is_empty() || self.path.len() > 4096 || self.path.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        let database = matches!(&self.agent, Agent::Hermes | Agent::Opencode);
        if database != self.transcript_session_id.is_some()
            || self.transcript_session_id.as_deref().is_some_and(|id| {
                id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)
            })
            || (self.view == View::Conversation
                && !matches!(
                    &self.agent,
                    Agent::Claude | Agent::GrokAcp | Agent::Opencode | Agent::Codex | Agent::Gemini
                ))
            || (self.inline_images
                && !(matches!(&self.agent, Agent::Claude)
                    || (self.view == View::Records
                        && matches!(&self.agent, Agent::Codex | Agent::GrokAcp))))
        {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Destination {
    generation: String,
    session_id: String,
    window_id: String,
    pane_id: String,
}
impl Destination {
    fn validate(&self) -> Result<()> {
        if uuid::Uuid::parse_str(&self.generation).is_err()
            || self.generation.len() != 36
            || !id(&self.session_id, b'$')
            || !id(&self.window_id, b'@')
            || !id(&self.pane_id, b'%')
        {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Snapshot,
    Bind {
        destination: Destination,
        source: Source,
    },
    Release {
        receipt: String,
    },
    Input {
        receipt: String,
        source: Source,
        operation: u32,
        input: Input,
    },
    #[cfg(test)]
    #[serde(skip)]
    Gate {
        before_dispatch: bool,
        ready: oneshot::Sender<()>,
        release: oneshot::Receiver<()>,
    },
}
impl Action {
    fn validate(&self) -> Result<()> {
        match self {
            #[cfg(test)]
            Self::Gate { .. } => Ok(()),
            Self::Snapshot => Ok(()),
            Self::Bind {
                destination,
                source,
            } => {
                destination.validate()?;
                source.validate()
            }
            Self::Release { receipt } | Self::Input { receipt, .. }
                if receipt.len() != 36 || uuid::Uuid::parse_str(receipt).is_err() =>
            {
                Err(invalid())
            }
            Self::Release { .. } => Ok(()),
            Self::Input { source, input, .. } => {
                source.validate()?;
                input.validate_for(source)
            }
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Send {
        text: String,
    },
    RequestStop,
    /// One option of a numbered dialog: Claude Code's key for it is the digit alone, no Enter (verified on 2.1.318).
    Select {
        option: u8,
        of: u8,
    },
    /// Confirms a multi-select list of `of` options: Claude Code puts its Submit row after "Type something".
    Submit {
        of: u8,
    },
    /// A prompt longer than `Send` takes: up to `LONG_MAX` bytes as one bracketed paste, then Enter.
    SendLong {
        text: String,
    },
    /// One Shift+Tab, Claude Code's permission-mode cycle (profile `claude-2.1`). The reply reads the mode back off the status line.
    CycleMode {},
    /// Moves the highlight of a list dialog by `rows` (negative is up) and, with `enter`, presses Enter: how a person chooses a row.
    Pick {
        rows: i8,
        enter: bool,
    },
}
/// What `Send` takes in one tmux command.
const SEND_MAX: usize = 4096;
/// What `SendLong` takes: bounded, never split into several messages. Only tmux has this kind.
pub(crate) const LONG_MAX: usize = 64 * 1024;
/// Payload bytes one tmux command carries while a long prompt is assembled in a private paste buffer.
const CHUNK: usize = 4096;
/// Rows one `pick` may move: far more than any dialog list shows at once.
const PICK_ROWS: i8 = 30;
impl Input {
    pub(crate) fn validate(&self) -> Result<()> {
        if let Self::Send { text } | Self::SendLong { text } = self {
            let range = if matches!(self, Self::Send { .. }) {
                1..=SEND_MAX
            } else {
                SEND_MAX + 1..=LONG_MAX
            };
            if !range.contains(&text.len())
                || text.chars().any(|c| {
                    (c.is_control() && !matches!(c, '\n' | '\t'))
                        || matches!(c, '\u{2028}' | '\u{2029}')
                })
            {
                return Err(invalid());
            }
        }
        // Digits 1-9 are the only option keys; a dialog with more options stays in the terminal.
        match self {
            Self::Select { option, of } if !(1..=9).contains(of) || !(1..=*of).contains(option) => {
                return Err(invalid())
            }
            Self::Submit { of } if !(1..=8).contains(of) => return Err(invalid()),
            Self::Pick { rows, enter }
                if !(-PICK_ROWS..=PICK_ROWS).contains(rows) || (*rows == 0 && !enter) =>
            {
                return Err(invalid())
            }
            _ => {}
        }
        Ok(())
    }
    /// A key profile belongs to one agent: its bytes are never sent to another program.
    pub(crate) fn validate_for(&self, source: &Source) -> Result<()> {
        self.validate()?;
        if matches!(self, Self::CycleMode {}) && source.agent != Agent::Claude {
            return Err(invalid());
        }
        Ok(())
    }
    fn paste_text(&self) -> Option<&str> {
        match self {
            Self::Send { text } if text.contains(['\n', '\t']) => Some(text),
            _ => None,
        }
    }
    /// Only `SendLong` is assembled in chunks; it has no key form.
    fn long_text(&self) -> Option<&str> {
        match self {
            Self::SendLong { text } => Some(text),
            _ => None,
        }
    }
    fn keys(&self, pane: &str) -> Result<String> {
        self.validate()?;
        let command = match self {
            Self::Send { text } => {
                // Only generated ASCII hex enters tmux's newline-framed parser.
                let bytes = text
                    .as_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<Vec<_>>()
                    .join(" ");
                // A literal CR is the terminal's Enter byte. Keep the text and
                // Enter in one bounded send-keys command.
                format!("send-keys -t {pane} -H {bytes} 0d")
            }
            Self::RequestStop => format!("send-keys -t {pane} Escape"),
            Self::Select { option, .. } => format!("send-keys -t {pane} -H {:02x}", b'0' + option),
            Self::Submit { of } => format!(
                "send-keys -t {pane} {}Enter",
                "Down ".repeat(usize::from(*of) + 1)
            ),
            Self::SendLong { .. } => return Err(invalid()),
            Self::CycleMode {} => format!("send-keys -t {pane} -H 1b 5b 5a"),
            Self::Pick { rows, enter } => format!(
                "send-keys -t {pane} {}{}",
                if *rows < 0 { "Up " } else { "Down " }.repeat(usize::from(rows.unsigned_abs())),
                if *enter { "Enter" } else { "" }
            )
            .trim_end()
            .to_owned(),
        };
        Ok(command)
    }
}

/// Every payload byte is decoded once by tmux from `\ooo`, never read as a shell/control-line token.
fn octal(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("\\{b:03o}")).collect()
}
fn report(marker: &str, state: &str) -> String {
    format!(
        "display-message -p {}",
        ssh::quote(&format!("{marker}:{state}"))
    )
}
/// A tmux command line is bounded: whatever carries payload must fit and stay one ASCII line.
fn bounded(command: String) -> Result<String> {
    if command.len() + 1 > 32 * 1024 || !command.is_ascii() || command.contains(['\r', '\n']) {
        return Err(invalid());
    }
    Ok(command)
}
/// Paste the named buffer, then Enter. Both buffer hooks can change context: recheck before paste AND before CR.
fn paste_stage(guard: &str, pane: &str, buffer: &str, marker: &str) -> String {
    let (guard, pane) = (ssh::quote(guard), ssh::quote(pane));
    let submit = format!(
        "if-shell -F {guard} {{ send-keys -t {pane} -H 0d; {} }} {{ {} }}",
        report(marker, "ok"),
        report(marker, "partial")
    );
    format!(
        "if-shell -F {guard} {{ paste-buffer -p -r -d -b {buffer} -t {pane}; {submit} }} {{ delete-buffer -b {buffer}; {} }}",
        report(marker, "gone")
    )
}
fn paste_command(
    guard: &str,
    pane: &str,
    text: &str,
    buffer: &str,
    marker: &str,
) -> Result<String> {
    bounded(format!(
        "if-shell -F {} {{ set-buffer -b {buffer} -- \"{}\"; {} }} {{ {} }}",
        ssh::quote(guard),
        octal(text.as_bytes()),
        paste_stage(guard, pane, buffer, marker),
        report(marker, "gone")
    ))
}
/// One step of a long prompt: add a chunk to the private buffer while the context still matches. Once the buffer exists a
/// changed context deletes it, so nothing of the prompt stays behind when the terminal is no longer the destination.
fn append_command(
    guard: &str,
    buffer: &str,
    chunk: &[u8],
    marker: &str,
    existing: bool,
) -> Result<String> {
    let gone = if existing {
        format!("delete-buffer -b {buffer}; {}", report(marker, "gone"))
    } else {
        report(marker, "gone")
    };
    bounded(format!(
        "if-shell -F {} {{ set-buffer {}-b {buffer} -- \"{}\"; {} }} {{ {gone} }}",
        ssh::quote(guard),
        if existing { "-a " } else { "" },
        octal(chunk),
        report(marker, "ok")
    ))
}
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Destination {
        destination: Destination,
        session_name: String,
        window_name: String,
        pane_index: u32,
    },
    Bound {
        receipt: String,
        destination: Destination,
        next_operation: u32,
    },
    Released,
    Delivered {
        next_operation: u32,
        /// Only for `cycle_mode`: the permission mode the status line showed afterwards.
        #[serde(skip_serializing_if = "Option::is_none")]
        mode: Option<Mode>,
    },
}
/// Claude Code's permission modes as its status line names them; `Unconfirmed` is any screen the profile does not recognise.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Default,
    AcceptEdits,
    Plan,
    Auto,
    BypassPermissions,
    Unconfirmed,
}
/// Profile `claude-2.1` (verified on 2.1.318): the status line under the prompt box starts with a glyph, then the mode.
const MODE_LABELS: [(&str, Mode); 5] = [
    ("manual mode on", Mode::Default),
    ("accept edits on", Mode::AcceptEdits),
    ("plan mode on", Mode::Plan),
    ("auto mode on", Mode::Auto),
    ("bypass permissions on", Mode::BypassPermissions),
];
/// The mode shown on the last few lines of a pane. Text the agent printed higher up is never read, and two different
/// modes on those lines are no answer at all.
fn mode_on_screen(rows: &[String]) -> Mode {
    let mut found = None;
    for row in rows
        .iter()
        .rev()
        .filter(|row| !row.trim().is_empty())
        .take(6)
    {
        let label = row.trim_start_matches(|c: char| c == ' ' || !c.is_ascii());
        for (text, mode) in MODE_LABELS {
            if label.starts_with(text) && row.trim_start() != label {
                if found.is_some_and(|seen| seen != mode) {
                    return Mode::Unconfirmed;
                }
                found = Some(mode);
            }
        }
    }
    found.unwrap_or(Mode::Unconfirmed)
}
pub(super) struct Receipt {
    token: String,
    destination: Destination,
    source: Source,
    owner: AccessLease,
    next: u32,
}
pub(super) struct Permit(Arc<AtomicBool>);
#[cfg(test)]
pub(super) type Gate = (oneshot::Sender<()>, oneshot::Receiver<()>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn invalid() -> SshError {
    SshError::new(
        "tmux_chat_invalid",
        "Unsupported terminal input or destination",
    )
}
fn stale() -> SshError {
    SshError::new("tmux_chat_stale", "Confirm the terminal destination again")
}

impl Control {
    pub(super) fn chat_abandoned(&mut self, action: &Action) {
        let retire = match action {
            #[cfg(test)]
            Action::Gate { .. } => false,
            Action::Input { .. } | Action::Bind { .. } => true,
            Action::Release { receipt } => self.chat.as_ref().is_some_and(|r| r.token == *receipt),
            Action::Snapshot => false,
        };
        if retire {
            self.chat = None;
        }
    }
    async fn chat_destination(&mut self, budget: &mut usize) -> Result<Destination> {
        // list-clients uses each client's session/current window, but tmux 3.4
        // formats use the window's active pane even for independent active-pane
        // clients. Reject that unsupported flag rather than infer their pane.
        let rows = self.command("list-clients -F '#{client_pid}|#{client_tty}|#{client_control_mode}|#{session_id}|#{window_id}|#{pane_id}|#{client_flags}'", budget).await?;
        let mut found = None;
        for row in rows {
            let f = row.split('|').collect::<Vec<_>>();
            if f.len() != 7 {
                return Err(protocol());
            }
            if f[0] == self.identity.pid.to_string() && f[1] == self.identity.tty && f[2] == "0" {
                if found.is_some()
                    || f[6]
                        .split(',')
                        .any(|flag| matches!(flag, "read-only" | "active-pane"))
                {
                    return Err(stale());
                }
                let target = Destination {
                    generation: self.generation.clone(),
                    session_id: f[3].into(),
                    window_id: f[4].into(),
                    pane_id: f[5].into(),
                };
                target.validate()?;
                found = Some(target);
            }
        }
        found.ok_or_else(stale)
    }
    async fn chat_snapshot(&mut self, budget: &mut usize) -> Result<Reply> {
        // Reuse navigation's bounded/escaped labels. They help confirmation;
        // only native IDs and the original client establish the destination.
        let snapshot = self.snapshot(budget).await?;
        let destination = self.chat_destination(budget).await?;
        if snapshot.current.session_id != destination.session_id
            || snapshot.current.window_id != destination.window_id
        {
            return Err(stale());
        }
        let session = snapshot
            .sessions
            .iter()
            .find(|s| s.id == destination.session_id)
            .ok_or_else(stale)?;
        let window = session
            .windows
            .iter()
            .find(|w| w.id == destination.window_id)
            .ok_or_else(stale)?;
        let rows = self
            .command(
                &format!(
                    "display-message -p -t {} '#{{pane_index}}'",
                    destination.pane_id
                ),
                budget,
            )
            .await?;
        if rows.len() != 1 {
            return Err(protocol());
        }
        let pane_index = rows[0].parse::<u32>().map_err(|_| protocol())?;
        Ok(Reply::Destination {
            destination,
            session_name: session.name.clone(),
            window_name: window.name.clone(),
            pane_index,
        })
    }
    async fn chat_ready(&mut self, target: &Destination, budget: &mut usize) -> Result<()> {
        if self.chat_destination(budget).await? != *target {
            return Err(stale());
        }
        // The exact pane/window are server-wide IDs. A linked window can be in
        // several sessions; session ownership comes only from chat_destination.
        let rows = self.command(&format!("display-message -p -t {} '#{{window_id}}|#{{pane_id}}|#{{pane_dead}}|#{{pane_in_mode}}|#{{synchronize-panes}}'", target.pane_id), budget).await?;
        if rows != [format!("{}|{}|0|0|0", target.window_id, target.pane_id)] {
            return Err(stale());
        }
        Ok(())
    }
    async fn chat_dispatch(
        &mut self,
        target: &Destination,
        input: &Input,
        budget: &mut usize,
    ) -> Result<()> {
        let client_checks = [
            format!("#{{==:#{{client_pid}},{}}}", self.identity.pid),
            format!("#{{==:#{{client_tty}},{}}}", self.identity.tty),
            "#{==:#{client_control_mode},0}".into(),
            "#{==:#{m:*read-only*,#{client_flags}},0}".into(),
            "#{==:#{m:*active-pane*,#{client_flags}},0}".into(),
            "#{==:#{client_session},#{session_name}}".into(),
        ];
        let pane_checks = [
            format!("#{{==:#{{session_id}},{}}}", target.session_id),
            format!("#{{==:#{{window_id}},{}}}", target.window_id),
            format!("#{{==:#{{pane_id}},{}}}", target.pane_id),
            "#{==:#{pane_dead},0}".into(),
            "#{==:#{pane_in_mode},0}".into(),
            "#{==:#{synchronize-panes},0}".into(),
        ];
        let all = |checks: Vec<String>| {
            checks
                .into_iter()
                .reduce(|a, b| format!("#{{&&:{a},{b}}}"))
                .unwrap()
        };
        let client_condition = all(client_checks.into());
        let pane_condition = all(pane_checks.into());
        // S resets inherited window/pane to this session's CURRENT context.
        // L then matches the original client, including its actual session name
        // against that same live session (names are unique within one server).
        // User labels are format values, never embedded into format syntax.
        let guard =
            format!("#{{==:#{{S:#{{?{pane_condition},#{{L:#{{?{client_condition},1,}}}},}}}},1}}");
        let marker = format!("LAZYSH_INPUT_{}", uuid::Uuid::new_v4().simple());
        input.validate()?;
        let delivered = if let Some(text) = input.long_text() {
            self.paste_long(&guard, &target.pane_id, text, budget).await
        } else if let Some(text) = input.paste_text() {
            let buffer = format!("lazysh-{}", uuid::Uuid::new_v4().simple());
            let command = paste_command(&guard, &target.pane_id, text, &buffer, &marker)?;
            // Partial/error/cancelled streams still retire; never resync to clean a buffer.
            self.marked_dispatch(&command, &marker, budget).await
        } else {
            self.marked_command(&guard, &input.keys(&target.pane_id)?, &marker, budget)
                .await
        };
        delivered?.then_some(()).ok_or_else(stale)
    }
    /// Fill a private buffer chunk by chunk, each step re-checking the destination, then paste it and press Enter once.
    /// `false` means a step found the destination changed and nothing was pasted.
    async fn paste_long(
        &mut self,
        guard: &str,
        pane: &str,
        text: &str,
        budget: &mut usize,
    ) -> Result<bool> {
        let buffer = format!("lazysh-{}", uuid::Uuid::new_v4().simple());
        for (index, chunk) in text.as_bytes().chunks(CHUNK).enumerate() {
            let marker = format!("LAZYSH_INPUT_{}", uuid::Uuid::new_v4().simple());
            let command = append_command(guard, &buffer, chunk, &marker, index > 0)?;
            if !self.marked_dispatch(&command, &marker, budget).await? {
                return Ok(false);
            }
        }
        let marker = format!("LAZYSH_INPUT_{}", uuid::Uuid::new_v4().simple());
        let command = bounded(paste_stage(guard, pane, &buffer, &marker))?;
        self.marked_dispatch(&command, &marker, budget).await
    }
    /// Read the permission mode back off the pane once the TUI had time to repaint.
    async fn read_mode(&mut self, pane: &str, budget: &mut usize) -> Result<Mode> {
        let mut mode = Mode::Unconfirmed;
        for wait in [300, 500] {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            let rows = self
                .command(&format!("capture-pane -p -t {pane}"), budget)
                .await?;
            mode = mode_on_screen(&rows);
            if mode != Mode::Unconfirmed {
                break;
            }
        }
        Ok(mode)
    }
    pub(super) async fn chat_action(
        &mut self,
        lease: &AccessLease,
        action: Action,
        budget: &mut usize,
    ) -> Result<Reply> {
        match action {
            #[cfg(test)]
            Action::Gate {
                before_dispatch,
                ready,
                release,
            } => {
                if before_dispatch {
                    self.chat_before_dispatch = Some((ready, release));
                } else {
                    let _ = ready.send(());
                    release.await.map_err(|_| unavailable())?;
                }
                Ok(Reply::Released)
            }
            Action::Snapshot => self.chat_snapshot(budget).await,
            Action::Bind {
                destination,
                source,
            } => {
                self.chat = None;
                source.validate()?;
                destination.validate()?;
                self.chat_ready(&destination, budget).await?;
                lease.check()?;
                let token = uuid::Uuid::new_v4().to_string();
                self.chat = Some(Receipt {
                    token: token.clone(),
                    destination: destination.clone(),
                    source,
                    owner: lease.clone(),
                    next: 1,
                });
                Ok(Reply::Bound {
                    receipt: token,
                    destination,
                    next_operation: 1,
                })
            }
            Action::Release { receipt } => {
                if self.chat.as_ref().is_some_and(|r| r.token == receipt) {
                    self.chat = None;
                }
                Ok(Reply::Released)
            }
            Action::Input {
                receipt,
                source,
                operation,
                input,
            } => {
                // Take before any await: every failed/uncertain input retires its
                // authority. Never recover by capturing a new access proof.
                let mut bound = self.chat.take().ok_or_else(stale)?;
                source.validate()?;
                if bound.token != receipt || bound.source != source || operation != bound.next {
                    return Err(stale());
                }
                bound.owner.check().map_err(|_| stale())?;
                input.validate_for(&bound.source)?;
                self.chat_ready(&bound.destination, budget).await?;
                bound.owner.check().map_err(|_| stale())?;
                lease.check()?;
                bound.next = bound.next.checked_add(1).ok_or_else(stale)?;
                #[cfg(test)]
                if let Some((ready, release)) = self.chat_before_dispatch.take() {
                    let _ = ready.send(());
                    release.await.map_err(|_| unavailable())?;
                    bound.owner.check()?;
                    lease.check()?;
                }
                // Dispatch cutoff: after this write begins, cancellation cannot
                // recall bytes. A failed/partial response retires the actor.
                self.chat_dispatch(&bound.destination, &input, budget)
                    .await?;
                // The key has no echo of its own: the status line is the only proof of where the cycle landed.
                let mode = match input {
                    Input::CycleMode {} => {
                        Some(self.read_mode(&bound.destination.pane_id, budget).await?)
                    }
                    _ => None,
                };
                bound.owner.check()?;
                let next_operation = bound.next;
                self.chat = Some(bound);
                Ok(Reply::Delivered {
                    next_operation,
                    mode,
                })
            }
        }
    }
}
impl Binding {
    #[cfg(test)]
    pub(crate) async fn fixture_held_input(
        &self,
        lease: &AccessLease,
        cancel: watch::Receiver<bool>,
        action: serde_json::Value,
    ) -> (oneshot::Sender<()>, tokio::task::JoinHandle<Result<Reply>>) {
        let (ready, release, configured) = self.fixture_gate(lease.clone(), cancel.clone(), true);
        configured.await.unwrap().unwrap();
        let pending = self.fixture_call(lease.clone(), cancel, action);
        tokio::time::timeout(DEADLINE, ready)
            .await
            .unwrap()
            .unwrap();
        (release, pending)
    }
    #[cfg(test)]
    pub(crate) fn fixture_gate(
        &self,
        lease: AccessLease,
        mut cancel: watch::Receiver<bool>,
        before_dispatch: bool,
    ) -> (
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<Result<Reply>>,
    ) {
        let (ready, observed) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        let binding = self.clone();
        let pending = tokio::spawn(async move {
            binding
                .chat_call(
                    &lease,
                    &mut cancel,
                    Action::Gate {
                        before_dispatch,
                        ready,
                        release: wait,
                    },
                )
                .await
        });
        (observed, release, pending)
    }
    #[cfg(test)]
    pub(crate) fn fixture_call(
        &self,
        lease: AccessLease,
        mut cancel: watch::Receiver<bool>,
        action: serde_json::Value,
    ) -> tokio::task::JoinHandle<Result<Reply>> {
        let binding = self.clone();
        tokio::spawn(async move {
            binding
                .chat_call(
                    &lease,
                    &mut cancel,
                    serde_json::from_value(action).expect("valid fixture action"),
                )
                .await
        })
    }
    #[cfg(test)]
    pub(crate) fn fixture_input_pending(&self) -> bool {
        self.input_busy.load(Ordering::SeqCst)
    }
    #[cfg(test)]
    pub(crate) fn fixture_queue_depth(&self) -> usize {
        self.requests.max_capacity() - self.requests.capacity()
    }
    async fn chat_call(
        &self,
        lease: &AccessLease,
        cancel: &mut watch::Receiver<bool>,
        action: Action,
    ) -> Result<Reply> {
        let permit = if matches!(action, Action::Input { .. }) {
            self.input_busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .map_err(|_| {
                    SshError::new("tmux_chat_busy", "Terminal input is already in progress")
                })?;
            Some(Permit(self.input_busy.clone()))
        } else {
            None
        };
        match self
            .call_action(lease, cancel, super::Action::Chat(action), permit)
            .await?
        {
            super::Reply::Chat(reply) => Ok(reply),
            _ => Err(protocol()),
        }
    }
}
#[tauri::command]
pub async fn tmux_chat(
    lease: AccessLease,
    state: State<'_, AppState>,
    session_id: String,
    action: Action,
) -> AccessResult<Reply> {
    lease
        .run(async {
            lease.check()?;
            action.validate()?;
            let session = state.session(&session_id).await?;
            let binding = session
                .tmux
                .lock()
                .map_err(|_| unavailable())?
                .clone()
                .ok_or_else(unavailable)?;
            binding
                .chat_call(&lease, &mut session.cancel.subscribe(), action)
                .await
        })
        .await
}

#[cfg(test)]
pub(crate) const READER_FIXTURE_IDS: &[&str] = &[
    "claude",
    "codex",
    "pi",
    "omp",
    "hermes",
    "opencode",
    "copilot",
    "qoder-ide",
    "kimi",
    "jcode",
    "droid",
    "gemini",
    "cursor",
    "omo",
    "devin-atif",
    "amp-json",
    "grok-acp",
    "antigravity-jsonl",
];

#[cfg(test)]
mod tests {
    use super::*;
    fn ordinary_source() -> Source {
        Source {
            agent: Agent::Claude,
            path: "/owned".into(),
            view: View::Records,
            inline_images: false,
            transcript_session_id: None,
        }
    }
    #[test]
    fn the_mode_cycle_is_one_shift_tab_for_claude_only() {
        assert_eq!(
            Input::CycleMode {}.keys("%12").unwrap(),
            "send-keys -t %12 -H 1b 5b 5a"
        );
        assert!(serde_json::from_str::<Input>(r#"{"kind":"cycle_mode","times":3}"#).is_err());
        let claude = ordinary_source();
        let mut codex = ordinary_source();
        codex.agent = Agent::Codex;
        assert!(Input::CycleMode {}.validate_for(&claude).is_ok());
        assert!(Input::CycleMode {}.validate_for(&codex).is_err());
        assert!(Input::RequestStop.validate_for(&codex).is_ok());
    }
    #[test]
    fn the_mode_is_read_from_the_status_line_and_nowhere_else() {
        let screen = |rows: &[&str]| rows.iter().map(|row| row.to_string()).collect::<Vec<_>>();
        let shows = |status: &str| {
            mode_on_screen(&screen(&[
                "answer text",
                "─────────",
                "❯ ",
                "─────────",
                status,
                "",
                "",
            ]))
        };
        assert_eq!(shows("  ⏸ manual mode on · ? for shortcuts"), Mode::Default);
        assert_eq!(
            shows("  ⏵⏵ accept edits on (shift+tab to cycle)"),
            Mode::AcceptEdits
        );
        assert_eq!(
            shows("  ⏸ plan mode on (shift+tab to cycle)  ◐ medium"),
            Mode::Plan
        );
        assert_eq!(
            shows("  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"),
            Mode::Auto
        );
        assert_eq!(
            shows("  ⏵⏵ bypass permissions on (shift+tab to cycle)"),
            Mode::BypassPermissions
        );
        // Unknown wording, or no status line at all, confirms nothing.
        assert_eq!(shows("  ? for shortcuts"), Mode::Unconfirmed);
        assert_eq!(mode_on_screen(&[]), Mode::Unconfirmed);
        // Words the agent or the user wrote are not a status line: no glyph before them, or too far up the screen.
        assert_eq!(shows("plan mode on"), Mode::Unconfirmed);
        let mut old = screen(&["  ⏸ plan mode on"]);
        old.extend((0..10).map(|n| format!("later line {n}")));
        assert_eq!(mode_on_screen(&old), Mode::Unconfirmed);
        // Two different modes on the last lines are ambiguous.
        assert_eq!(
            mode_on_screen(&screen(&["  ⏸ plan mode on", "  ⏵⏵ auto mode on"])),
            Mode::Unconfirmed
        );
    }
    #[test]
    fn single_line_input_is_literal_and_terminal_keys_are_fixed() {
        let input = Input::Send {
            text: "é; '$#{pane_id}\\ 界".into(),
        };
        let keys = input.keys("%12").unwrap();
        assert_eq!(
            keys,
            "send-keys -t %12 -H c3 a9 3b 20 27 24 23 7b 70 61 6e 65 5f 69 64 7d 5c 20 e7 95 8c 0d"
        );
        assert_eq!(
            Input::RequestStop.keys("%12").unwrap(),
            "send-keys -t %12 Escape"
        );
        for text in [
            "", "line\r", "\u{1b}", "\0", "\u{85}", "\u{2028}", "\u{2029}",
        ] {
            assert!(Input::Send { text: text.into() }.keys("%12").is_err());
        }
        assert!(Input::Send {
            text: "界".repeat(1365)
        }
        .keys("%12")
        .is_ok());
        assert!(Input::Send {
            text: "界".repeat(1366)
        }
        .keys("%12")
        .is_err());
        assert!(Input::Send {
            text: "x".repeat(4096)
        }
        .keys("%12")
        .is_ok());
        assert!(serde_json::from_str::<Input>(r#"{"kind":"send","text":"\ud800"}"#).is_err());
        assert_eq!(
            Input::Select { option: 3, of: 4 }.keys("%12").unwrap(),
            "send-keys -t %12 -H 33"
        );
        for (option, of) in [(0, 3), (4, 3), (1, 0), (10, 10), (1, 10)] {
            assert!(
                Input::Select { option, of }.keys("%12").is_err(),
                "{option} of {of}"
            );
        }
        assert_eq!(
            Input::Submit { of: 3 }.keys("%12").unwrap(),
            "send-keys -t %12 Down Down Down Down Enter"
        );
        for of in [0, 9] {
            assert!(Input::Submit { of }.keys("%12").is_err(), "{of}");
        }
        for (rows, enter, keys) in [
            (2, true, "send-keys -t %12 Down Down Enter"),
            (-1, true, "send-keys -t %12 Up Enter"),
            (0, true, "send-keys -t %12 Enter"),
            (3, false, "send-keys -t %12 Down Down Down"),
            (-2, false, "send-keys -t %12 Up Up"),
        ] {
            assert_eq!(Input::Pick { rows, enter }.keys("%12").unwrap(), keys);
        }
        // Nothing to send, or further than any list is long, is refused.
        for (rows, enter) in [
            (0, false),
            (-31, true),
            (31, false),
            (i8::MIN, true),
            (i8::MAX, true),
        ] {
            assert!(
                Input::Pick { rows, enter }.keys("%12").is_err(),
                "{rows} {enter}"
            );
        }
        assert!(
            serde_json::from_str::<Input>(r#"{"kind":"pick","rows":128,"enter":true}"#).is_err()
        );
        assert!(serde_json::from_str::<Input>(r#"{"kind":"pick","rows":1}"#).is_err());
        assert!(serde_json::from_str::<Input>(
            r#"{"kind":"pick","rows":1,"enter":true,"keys":"x"}"#
        )
        .is_err());
        assert!(
            serde_json::from_str::<Input>(r#"{"kind":"select","option":1,"of":2,"keys":"x"}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<Input>(r#"{"kind":"select","option":-1,"of":2}"#).is_err());
        assert!(
            serde_json::from_str::<Action>(r#"{"kind":"gate","before_dispatch":false}"#).is_err()
        );
    }

    /// The bytes a program reading raw input in a real tmux pane receives when `input` is sent to it.
    fn bytes_received_by_a_real_pane(input: Input, expected: usize) -> Option<String> {
        use std::{
            process::Command,
            time::{Duration, Instant},
        };
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("tmux.sock");
        let tmux = |args: &[&str]| {
            Command::new("tmux")
                .arg("-S")
                .arg(&socket)
                .args(args)
                .output()
        };
        let (ready, output) = (dir.path().join("ready"), dir.path().join("keys.txt"));
        let program = format!(
            "stty raw -echo; touch {}; head -c {expected} | od -An -tx1 > {}; sleep 2",
            ready.display(),
            output.display()
        );
        match tmux(&[
            "new-session",
            "-d",
            "-x",
            "80",
            "-y",
            "24",
            "sh",
            "-c",
            &program,
        ]) {
            Ok(started) if started.status.success() => {}
            _ => {
                eprintln!("tmux is not available; skipped");
                return None;
            }
        }
        let wait = |path: &std::path::Path| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !path.exists()
                || std::fs::read_to_string(path)
                    .is_ok_and(|text| path == output && text.trim().is_empty())
            {
                assert!(
                    Instant::now() < deadline,
                    "{} never appeared",
                    path.display()
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        wait(&ready);
        let keys = input.keys("%0").unwrap();
        let sent = tmux(&keys.split(' ').collect::<Vec<_>>()).unwrap();
        assert!(
            sent.status.success(),
            "{}",
            String::from_utf8_lossy(&sent.stderr)
        );
        wait(&output);
        let received = std::fs::read_to_string(&output).unwrap();
        let _ = tmux(&["kill-server"]);
        Some(received.split_whitespace().collect::<Vec<_>>().join(" "))
    }

    /// The generated command, run by a real tmux, gives a program reading the pane exactly one digit and no Enter.
    #[test]
    fn select_reaches_a_real_pane_as_one_digit_without_enter() {
        if let Some(received) = bytes_received_by_a_real_pane(Input::Select { option: 2, of: 3 }, 1)
        {
            assert_eq!(received, "32", "the option digit and nothing else");
        }
    }

    /// Arrows, then Enter only when asked, and nothing else: the keys a person presses to choose a row of a list dialog.
    #[test]
    fn pick_reaches_a_real_pane_as_arrows_then_enter() {
        if let Some(received) = bytes_received_by_a_real_pane(
            Input::Pick {
                rows: 2,
                enter: true,
            },
            7,
        ) {
            assert_eq!(received, "1b 5b 42 1b 5b 42 0d");
        }
        if let Some(received) = bytes_received_by_a_real_pane(
            Input::Pick {
                rows: -1,
                enter: false,
            },
            3,
        ) {
            assert_eq!(received, "1b 5b 41");
        }
    }

    #[test]
    fn a_long_prompt_is_bounded_chunked_and_has_no_key_form() {
        let at = |len: usize| Input::SendLong {
            text: "x".repeat(len),
        };
        for len in [4097, 4098, LONG_MAX] {
            assert!(at(len).validate().is_ok(), "{len}");
        }
        // Up to 4096 bytes `send` is the kind; past the bound nothing is sent, never a part of it.
        for len in [0, 1, 4096, LONG_MAX + 1] {
            assert!(at(len).validate().is_err(), "{len}");
        }
        assert!(Input::Send {
            text: "x".repeat(4097)
        }
        .validate()
        .is_err());
        for text in ["a\rb", "a\u{1b}b", "a\0b", "a\u{2028}b"] {
            assert!(Input::SendLong {
                text: format!("{}{text}", "x".repeat(5000))
            }
            .validate()
            .is_err());
        }
        assert!(at(5000).keys("%12").is_err());
        assert_eq!(at(5000).long_text().map(str::len), Some(5000));
        assert!(Input::Send { text: "hi".into() }.long_text().is_none());
        assert!(
            serde_json::from_str::<Input>(r#"{"kind":"send_long","text":"a","chunk":9}"#).is_err()
        );
        // Every command that carries payload stays one ASCII line below the 32 KiB command bound, even with the
        // longest guard the format condition can reach, and only the later chunks append.
        let guard = "g".repeat(2000);
        let hard = "\u{ff}".repeat(2048);
        let first = append_command(
            &guard,
            "lazysh-owned",
            &hard.as_bytes()[..CHUNK],
            "OWNED_MARKER",
            false,
        )
        .unwrap();
        let next = append_command(
            &guard,
            "lazysh-owned",
            &hard.as_bytes()[..CHUNK],
            "OWNED_MARKER",
            true,
        )
        .unwrap();
        assert!(first.len() < 32 * 1024 && next.len() < 32 * 1024 && first.is_ascii());
        assert!(first.contains("set-buffer -b lazysh-owned --") && !first.contains("-a"));
        assert!(
            next.contains("set-buffer -a -b lazysh-owned --")
                && next.contains("delete-buffer -b lazysh-owned")
        );
        assert!(!first.contains("delete-buffer"));
        assert_eq!(first.matches(&guard).count(), 1);
        assert!(
            append_command(&guard, "lazysh-owned", &[0xff; 9000], "OWNED_MARKER", true).is_err()
        );
    }
    #[test]
    fn multiline_paste_is_one_bounded_octal_line_with_three_context_guards() {
        let text = "é\n\t; '$#{pane_id}\\ 界";
        let input = Input::Send { text: text.into() };
        input.validate().unwrap();
        assert_eq!(input.paste_text(), Some(text));
        let command = paste_command(
            "original-context",
            "%12",
            text,
            "lazysh-owned",
            "OWNED_MARKER",
        )
        .unwrap();
        assert!(command.is_ascii());
        assert!(!command.contains(['\n', '\r', '\t']));
        assert!(command.contains("\\303\\251\\012\\011\\073"));
        assert!(!command.contains("#{pane_id}"));
        assert_eq!(command.matches("original-context").count(), 3);
        assert_eq!(command.matches("send-keys -t '%12' -H 0d").count(), 1);
        assert!(command.contains("paste-buffer -p -r -d -b lazysh-owned -t '%12';"));
        assert!(command.contains("set-buffer -b lazysh-owned -- "));
        assert!(command.contains("delete-buffer -b lazysh-owned"));
        assert!(super::marked_rows(&["OWNED_MARKER:partial".into()], "OWNED_MARKER").is_err());
        let maximum = format!("{}\n", "x".repeat(4095));
        assert!(Input::Send {
            text: maximum.clone()
        }
        .validate()
        .is_ok());
        assert!(
            paste_command(
                "bounded-guard",
                "%12",
                &maximum,
                "lazysh-owned",
                "OWNED_MARKER"
            )
            .unwrap()
            .len()
                < 32 * 1024
        );
        assert!(paste_command(
            &"g".repeat(11000),
            "%12",
            "one\ntwo",
            "lazysh-owned",
            "OWNED_MARKER"
        )
        .is_err());
        assert!(Input::Send {
            text: maximum + "x"
        }
        .validate()
        .is_err());
    }
    #[test]
    fn every_native_reader_has_a_closed_records_context() {
        for &agent in READER_FIXTURE_IDS {
            let mut value = serde_json::json!({"agent":agent,"path":"/owned/界 ","view":"records","inlineImages":false});
            if matches!(agent, "hermes" | "opencode") {
                value["transcriptSessionId"] = "literal-session".into();
            }
            let source: Source =
                serde_json::from_value(value).unwrap_or_else(|error| panic!("{agent}: {error}"));
            source.validate().unwrap();
        }
    }

    #[test]
    fn source_options_and_selector_presence_are_closed() {
        for &agent in READER_FIXTURE_IDS {
            for view in ["records", "conversation"] {
                for images in [false, true] {
                    let mut value = serde_json::json!({"agent":agent,"path":"/owned/界 ","view":view,"inlineImages":images});
                    if matches!(agent, "hermes" | "opencode") {
                        value["transcriptSessionId"] = "literal-session".into();
                    }
                    let source: Source = serde_json::from_value(value.clone()).unwrap();
                    let expected = (view == "records"
                        || matches!(
                            agent,
                            "claude" | "grok-acp" | "opencode" | "codex" | "gemini"
                        ))
                        && (!images
                            || agent == "claude"
                            || (view == "records" && matches!(agent, "codex" | "grok-acp")));
                    assert_eq!(
                        source.validate().is_ok(),
                        expected,
                        "{agent}/{view}/{images}"
                    );
                    value["transcriptSessionId"] = serde_json::Value::Null;
                    assert!(serde_json::from_value::<Source>(value).is_err());
                }
            }
            let mut context = serde_json::json!({"agent":agent,"path":"/owned","view":"records","inlineImages":false});
            let database = matches!(agent, "hermes" | "opencode");
            assert_eq!(
                serde_json::from_value::<Source>(context.clone())
                    .unwrap()
                    .validate()
                    .is_ok(),
                !database
            );
            context["transcriptSessionId"] = "selector".into();
            assert_eq!(
                serde_json::from_value::<Source>(context.clone())
                    .unwrap()
                    .validate()
                    .is_ok(),
                database
            );
            if database {
                for selector in [
                    "".into(),
                    "x".repeat(257),
                    "😀".repeat(65),
                    "id\n".into(),
                    "\u{85}".into(),
                ] {
                    context["transcriptSessionId"] = selector.into();
                    assert!(serde_json::from_value::<Source>(context.clone())
                        .unwrap()
                        .validate()
                        .is_err());
                }
                for selector in [
                    "  literal $t(id) 界  ".into(),
                    "x".repeat(256),
                    "😀".repeat(64),
                ] {
                    context["transcriptSessionId"] = selector.clone().into();
                    let source: Source = serde_json::from_value(context.clone()).unwrap();
                    source.validate().unwrap();
                    assert_eq!(
                        source.transcript_session_id.as_deref(),
                        Some(selector.as_str())
                    );
                }
                let mut other = serde_json::from_value::<Source>(context.clone()).unwrap();
                other.transcript_session_id = Some("another-session".into());
                assert!(other != serde_json::from_value::<Source>(context).unwrap());
            }
        }
        for agent in ["qwen", "future", "constructor", "qoder_ide"] {
            assert!(serde_json::from_value::<Source>(serde_json::json!({"agent":agent,"path":"/owned","view":"records","inlineImages":false})).is_err());
        }
    }

    #[test]
    fn legacy_claude_context_preserves_the_original_four_fields_and_literal_path() {
        let value = serde_json::json!({"agent":"claude","path":"/owned/界 ","view":"conversation","inlineImages":false});
        let source: Source = serde_json::from_value(value.clone()).unwrap();
        source.validate().unwrap();
        assert_eq!(source.path, "/owned/界 ");
        for (field, replacement) in [("agent", "future"), ("view", "active_branch")] {
            let mut bad = value.clone();
            bad[field] = replacement.into();
            assert!(serde_json::from_value::<Source>(bad).is_err());
        }
        for path in [String::new(), "a".repeat(4097), "/owned/\n".into()] {
            let mut bad = source.clone();
            bad.path = path;
            assert!(bad.validate().is_err());
        }
    }
    #[tokio::test]
    async fn pending_input_permit_survives_a_closed_waiter_and_binding_clone() {
        let access = crate::app_lock::AccessState::disabled();
        let lease = access.lease(None).unwrap();
        let (requests, mut rx) = mpsc::channel(4);
        let binding = Binding {
            requests,
            input_busy: Arc::default(),
        };
        let first = binding.clone();
        let owner = lease.clone();
        let action = || Action::Input {
            receipt: "fixture".into(),
            source: ordinary_source(),
            operation: 1,
            input: Input::RequestStop,
        };
        let input = action();
        let pending = tokio::spawn(async move {
            let (_sender, mut cancel) = watch::channel(false);
            first.chat_call(&owner, &mut cancel, input).await
        });
        let request = rx.recv().await.unwrap();
        pending.abort();
        let _ = pending.await;
        let (_sender, mut cancel) = watch::channel(false);
        assert!(binding
            .chat_call(&lease, &mut cancel, action())
            .await
            .is_err());
        assert!(matches!(
            rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        // Dropping the owned work, not the waiting frontend future, releases it.
        drop(request);
        assert!(!binding.input_busy.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn unsupported_input_is_rejected_before_native_session_lookup() {
        use tauri::Manager;
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(dir.path().join("config")).unwrap());
        let lease = crate::app_lock::AccessState::disabled()
            .lease(None)
            .unwrap();
        for text in ["\r".into(), "x".repeat(4097), "\u{2028}".into()] {
            let action = Action::Input {
                receipt: "00000000-0000-4000-8000-000000000001".into(),
                source: ordinary_source(),
                operation: 1,
                input: Input::Send { text },
            };
            let error =
                match tmux_chat(lease.clone(), app.state(), "absent".into(), action).await {
                    Ok(_) => panic!("unsupported input was admitted"),
                    Err(error) => error,
                }
                .into_inner()
                .unwrap();
            assert_eq!(error.kind(), "tmux_chat_invalid");
        }
    }
}
