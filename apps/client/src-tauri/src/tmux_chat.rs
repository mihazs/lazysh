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
    fn validate(&self) -> Result<()> {
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
                && !matches!(&self.agent, Agent::Claude | Agent::GrokAcp))
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
                input.validate()
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Send { text: String },
    RequestStop,
}
impl Input {
    fn validate(&self) -> Result<()> {
        if let Self::Send { text } = self {
            if text.is_empty()
                || text.len() > 4096
                || text.chars().any(|c| {
                    (c.is_control() && !matches!(c, '\n' | '\t'))
                        || matches!(c, '\u{2028}' | '\u{2029}')
                })
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
    fn paste_text(&self) -> Option<&str> {
        match self {
            Self::Send { text } if text.contains(['\n', '\t']) => Some(text),
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
        };
        Ok(command)
    }
}

fn paste_command(
    guard: &str,
    pane: &str,
    text: &str,
    buffer: &str,
    marker: &str,
) -> Result<String> {
    let octal = text
        .as_bytes()
        .iter()
        .map(|b| format!("\\{b:03o}"))
        .collect::<String>();
    let guard = ssh::quote(guard);
    let pane = ssh::quote(pane);
    let report = |state| {
        format!(
            "display-message -p {}",
            ssh::quote(&format!("{marker}:{state}"))
        )
    };
    // Every payload byte is decoded once by tmux, never a shell/control-line token.
    // Both buffer hooks can change context: recheck before paste AND before CR.
    let submit = format!(
        "if-shell -F {guard} {{ send-keys -t {pane} -H 0d; {} }} {{ {} }}",
        report("ok"),
        report("partial")
    );
    let paste = format!(
        "if-shell -F {guard} {{ paste-buffer -p -r -d -b {buffer} -t {pane}; {submit} }} {{ delete-buffer -b {buffer}; {} }}",
        report("gone")
    );
    let command = format!(
        "if-shell -F {guard} {{ set-buffer -b {buffer} -- \"{octal}\"; {paste} }} {{ {} }}",
        report("gone")
    );
    if command.len() + 1 > 32 * 1024 || !command.is_ascii() || command.contains(['\r', '\n']) {
        return Err(invalid());
    }
    Ok(command)
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
    },
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
        let guard = format!("#{{S:#{{?{pane_condition},#{{L:#{{?{client_condition},1,}}}},}}}}");
        let marker = format!("LAZYSH_INPUT_{}", uuid::Uuid::new_v4().simple());
        input.validate()?;
        let delivered = if let Some(text) = input.paste_text() {
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
                input.validate()?;
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
                bound.owner.check()?;
                let next_operation = bound.next;
                self.chat = Some(bound);
                Ok(Reply::Delivered { next_operation })
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
        assert!(
            serde_json::from_str::<Action>(r#"{"kind":"gate","before_dispatch":false}"#).is_err()
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
                    let expected = (view == "records" || matches!(agent, "claude" | "grok-acp"))
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
        for agent in ["gemini", "qwen", "future", "constructor", "qoder_ide"] {
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
