//! Agent input for a stock Herdr host, which has no `lazysh.guard` RPC.
//!
//! Herdr's own `agent prompt` does the delivery: it resolves the pane to one live agent, refuses a blocked agent,
//! wraps the text in bracketed paste, waits, then presses Enter. This side only re-checks that the pane still shows
//! the agent session the conversation belongs to. The check and the prompt are two host calls, so a pane replaced
//! between them is the one window left open.
use crate::{
    app_lock::AccessLease,
    ssh::{self, quote, Result, Session, SshError},
    tmux_jump::chat::Input,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockTarget {
    herdr_session: String,
    pane: String,
    terminal: String,
    agent: String,
    agent_session_id: String,
}
impl StockTarget {
    pub(crate) fn valid(&self) -> bool {
        let text = |value: &str, max| crate::multiplexer::validate_text(value, max, "").is_ok();
        text(&self.herdr_session, 200)
            && text(&self.terminal, 256)
            && lazysh_common::valid_herdr_id(&self.pane, Some('p'))
            && matches!(self.agent.as_str(), "claude" | "codex")
            && uuid::Uuid::parse_str(&self.agent_session_id)
                .is_ok_and(|id| id.to_string() == self.agent_session_id)
    }
}

fn command(target: &StockTarget, input: &Input) -> Option<String> {
    let rest = match input {
        Input::Send { text } => format!("prompt {} {}", quote(&target.pane), quote(text)),
        Input::RequestStop => format!("send-keys {} esc", quote(&target.pane)),
        // Like the guard, stock input has no option-key profile and no long-paste path: those stay in the terminal.
        Input::Select { .. }
        | Input::Submit { .. }
        | Input::SendLong { .. }
        | Input::Pick { .. }
        | Input::CycleMode {} => return None,
    };
    Some(format!(
        "herdr --session {} agent {rest}",
        quote(&target.herdr_session)
    ))
}

/// The error code of Herdr's one-line JSON failure, when the host printed one.
fn host_code(message: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(message)
        .ok()?
        .pointer("/error/code")?
        .as_str()
        .map(str::to_owned)
}
fn refused(kind: &'static str, message: impl ToString) -> SshError {
    SshError::new(kind, message)
}
/// A failure before anything was written: the host or the target said no, or the host was not reachable.
fn before_send(error: SshError) -> SshError {
    match error.kind() {
        "herdr_target_missing" => refused("herdr_chat_stale", error.message()),
        "remote_command_failed" => refused("herdr_chat_rejected", error.message()),
        _ => error,
    }
}
/// A failure of the delivery call itself. Only Herdr's own error reply proves nothing was written.
fn after_send(error: SshError) -> SshError {
    if error.kind() != "remote_command_failed" {
        return refused(
            "herdr_chat_uncertain",
            "Herdr delivery could not be confirmed; it was not resent",
        );
    }
    match host_code(error.message()).as_deref() {
        Some("agent_blocked") => refused(
            "herdr_chat_blocked",
            "The agent is waiting for an answer in the terminal",
        ),
        Some(
            "agent_not_found" | "agent_not_ready" | "pane_not_found" | "agent_target_ambiguous",
        ) => refused("herdr_chat_stale", error.message()),
        Some("timeout") => refused(
            "herdr_chat_uncertain",
            "Herdr delivery could not be confirmed; it was not resent",
        ),
        _ => refused("herdr_chat_rejected", error.message()),
    }
}

pub(crate) async fn deliver(
    session: &Session,
    lease: &AccessLease,
    target: &StockTarget,
    input: &Input,
) -> Result<()> {
    let invalid = || {
        refused(
            "herdr_chat_invalid",
            "Unsupported Herdr terminal input or context",
        )
    };
    let command = command(target, input).filter(|_| target.valid() && input.validate().is_ok());
    let Some(command) = command else {
        return Err(invalid());
    };
    crate::herdr::check_selected(
        session,
        &target.herdr_session,
        &target.pane,
        &target.terminal,
        &target.agent,
        &target.agent_session_id,
        lease,
    )
    .await
    .map_err(before_send)?;
    let command = crate::herdr_path::select(
        &command,
        crate::herdr_path::admit(session, lease)
            .await
            .map_err(before_send)?,
    );
    ssh::exec_for_access(session, command, lease)
        .await
        .map(drop)
        .map_err(after_send)
}

/// Runs one agent input against the host of `session_id` under the caller's access lease. The stock Herdr and Zellij
/// commands differ only in the target they take and how `deliver` writes to it.
pub(crate) async fn run_agent_input<T>(
    state: &ssh::AppState,
    session_id: &str,
    access: &AccessLease,
    (target, input): (&T, &Input),
    deliver: impl AsyncFnOnce(&Session, &AccessLease, &T, &Input) -> Result<()>,
) -> ssh::AccessResult<()> {
    access
        .run(async {
            let session = state.session(session_id).await?;
            deliver(&session, access, target, input).await
        })
        .await
}

/// Defines the Tauri command that delivers one input to a target type through `run_agent_input`.
macro_rules! agent_input_command {
    ($(#[$doc:meta])* $name:ident, $target:ty, $deliver:path) => {
        $(#[$doc])*
        #[tauri::command]
        pub async fn $name(
            state: tauri::State<'_, ssh::AppState>,
            session_id: String,
            target: $target,
            input: Input,
            access: AccessLease,
        ) -> ssh::AccessResult<()> {
            run_agent_input(&state, &session_id, &access, (&target, &input), $deliver).await
        }
    };
}
pub(crate) use agent_input_command;

agent_input_command!(
    /// Delivers one message (or Escape) to the pane of the followed agent through Herdr's own commands.
    herdr_agent_input,
    StockTarget,
    deliver
);

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> StockTarget {
        StockTarget {
            herdr_session: "it's".into(),
            pane: "w2E:pF".into(),
            terminal: "term-one".into(),
            agent: "claude".into(),
            agent_session_id: "12345678-1234-4234-8234-123456789abc".into(),
        }
    }
    #[test]
    fn builds_herdrs_own_agent_commands_with_every_value_quoted() {
        let text = "two\nlines 'quoted' $(not run) -x";
        assert_eq!(
            command(&target(), &Input::Send { text: text.into() }).unwrap(),
            "herdr --session 'it'\\''s' agent prompt 'w2E:pF' 'two\nlines '\\''quoted'\\'' $(not run) -x'"
        );
        assert_eq!(
            command(&target(), &Input::RequestStop).unwrap(),
            "herdr --session 'it'\\''s' agent send-keys 'w2E:pF' esc"
        );
        // A dialog answer has no stock key profile and never reaches the host.
        assert_eq!(
            command(&target(), &Input::Select { option: 1, of: 3 }),
            None
        );
        assert_eq!(command(&target(), &Input::Submit { of: 3 }), None);
        assert_eq!(
            command(&target(), &Input::SendLong { text: "x".into() }),
            None
        );
        assert_eq!(command(&target(), &Input::CycleMode {}), None);
    }
    #[test]
    fn accepts_only_an_exact_pane_and_a_known_agent_session() {
        assert!(target().valid());
        for broken in [
            StockTarget {
                pane: "pane-one".into(),
                ..target()
            },
            StockTarget {
                pane: "w2E:pF; reboot".into(),
                ..target()
            },
            StockTarget {
                agent: "hermes".into(),
                ..target()
            },
            StockTarget {
                agent_session_id: "not-a-uuid".into(),
                ..target()
            },
            StockTarget {
                terminal: "bad\nterminal".into(),
                ..target()
            },
        ] {
            assert!(!broken.valid());
        }
    }
    #[test]
    fn classifies_what_the_host_said_into_one_actionable_kind() {
        let failed = |code: &str| {
            SshError::new(
                "remote_command_failed",
                format!(r#"{{"error":{{"code":"{code}","message":"x"}},"id":"cli:agent:prompt"}}"#),
            )
        };
        for (code, kind) in [
            ("agent_blocked", "herdr_chat_blocked"),
            ("agent_not_found", "herdr_chat_stale"),
            ("agent_not_ready", "herdr_chat_stale"),
            ("timeout", "herdr_chat_uncertain"),
            ("agent_prompt_failed", "herdr_chat_rejected"),
        ] {
            assert_eq!(after_send(failed(code)).kind(), kind, "{code}");
        }
        // A broken connection after the call began proves nothing, so the send is never reported as refused or repeated.
        for kind in ["timeout", "disconnected", "ssh_error", "app_locked"] {
            assert_eq!(
                after_send(SshError::new(kind, "x")).kind(),
                "herdr_chat_uncertain",
                "{kind}"
            );
        }
        assert_eq!(
            before_send(SshError::new("herdr_target_missing", "x")).kind(),
            "herdr_chat_stale"
        );
        assert_eq!(
            before_send(SshError::new("remote_command_failed", "herdr: not found")).kind(),
            "herdr_chat_rejected"
        );
        assert_eq!(
            before_send(SshError::new("disconnected", "x")).kind(),
            "disconnected"
        );
    }
}
