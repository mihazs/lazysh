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
}
impl Source {
    fn validate(&self) -> Result<()> {
        if self.path.is_empty() || self.path.len() > 4096 || self.path.chars().any(char::is_control)
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
                || text
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
            {
                return Err(invalid());
            }
        }
        Ok(())
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
        keys: &str,
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
        self.marked_command(&guard, keys, &marker, budget)
            .await?
            .then_some(())
            .ok_or_else(stale)
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
                let keys = input.keys(&bound.destination.pane_id)?;
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
                self.chat_dispatch(&bound.destination, &keys, budget)
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
mod tests {
    use super::*;
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
            "",
            "line\nnext",
            "line\r",
            "tab\t",
            "\u{1b}",
            "\0",
            "\u{85}",
            "\u{2028}",
            "\u{2029}",
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
    fn source_context_is_claude_only_and_preserves_literal_path() {
        let value = serde_json::json!({"agent":"claude","path":"/owned/界 ","view":"conversation","inlineImages":false});
        let source: Source = serde_json::from_value(value.clone()).unwrap();
        source.validate().unwrap();
        assert_eq!(source.path, "/owned/界 ");
        for (field, replacement) in [("agent", "codex"), ("view", "active_branch")] {
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
            source: Source {
                agent: Agent::Claude,
                path: "/owned".into(),
                view: View::Records,
                inline_images: false,
            },
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
        for text in ["\n".into(), "x".repeat(4097), "\u{2028}".into()] {
            let action = Action::Input {
                receipt: "00000000-0000-4000-8000-000000000001".into(),
                source: Source {
                    agent: Agent::Claude,
                    path: "/owned".into(),
                    view: View::Records,
                    inline_images: false,
                },
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
