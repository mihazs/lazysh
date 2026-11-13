//! Agent input for a stock Herdr host, which has no `lazysh.guard` RPC.
//!
//! Herdr's own `agent prompt` does the delivery: it resolves the pane to one live agent, refuses a blocked agent,
//! wraps the text in bracketed paste, waits, then presses Enter. This side only re-checks that the pane still shows
//! the agent session the conversation belongs to. The check and the prompt are two host calls, so a pane replaced
//! between them is the one window left open.
//!
//! A dialog answer is a few named keys sent with `agent send-keys` (the agent profile's digit, arrows and Enter, nothing else), or one
//! typed line and its Enter written with `pane send-text`, after the same check. `herdr_agent_screen` reads the pane's visible screen with `agent read` so the Agent view can show the dialog that
//! is open and read back the highlight between keys; it grants nothing.
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
        Input::Send { text } => format!("agent prompt {} {}", quote(&target.pane), quote(text)),
        Input::RequestStop => format!("agent send-keys {} esc", quote(&target.pane)),
        // The line and its Enter are one literal write, as tmux's `Send` writes them. `agent prompt` would refuse the agent that waits for this answer.
        Input::Type { text } => format!(
            "pane send-text {} {}",
            quote(&target.pane),
            quote(&format!("{text}\r"))
        ),
        // A dialog answer is the keys a person presses (a digit, arrows, Enter). Herdr names keys in lowercase and refuses one it does not know.
        Input::Select { .. } | Input::Submit { .. } | Input::Pick { .. } => format!(
            "agent send-keys {} {}",
            quote(&target.pane),
            input.dialog_keys().join(" ").to_lowercase()
        ),
        // Stock input has no long-paste path and no mode key profile: those stay in the terminal.
        Input::SendLong { .. } | Input::CycleMode {} => return None,
    };
    Some(format!(
        "herdr --session {} {rest}",
        quote(&target.herdr_session)
    ))
}

/// Rows and columns of the screen read: a terminal is far smaller, so more is not a screen.
const SCREEN_ROWS: usize = 200;
const SCREEN_COLUMNS: usize = 400;
/// The visible screen as rows of text with control characters blanked, bounded.
fn screen_rows(output: &str) -> Vec<String> {
    output
        .lines()
        .take(SCREEN_ROWS)
        .map(|line| {
            line.chars()
                .take(SCREEN_COLUMNS)
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect()
        })
        .collect()
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

/// Reads the visible screen of the pane that runs the followed agent. Display only: the pane is checked again on every key.
pub(crate) async fn screen(
    session: &Session,
    lease: &AccessLease,
    target: &StockTarget,
) -> Result<Vec<String>> {
    if !target.valid() {
        return Err(refused(
            "herdr_chat_invalid",
            "Unsupported Herdr terminal input or context",
        ));
    }
    let command = format!(
        "herdr --session {} agent read {} --source visible --format text",
        quote(&target.herdr_session),
        quote(&target.pane)
    );
    let command = crate::herdr_path::select(
        &command,
        crate::herdr_path::admit(session, lease)
            .await
            .map_err(before_send)?,
    );
    let output = ssh::exec_for_access(session, command, lease)
        .await
        .map_err(before_send)?;
    Ok(screen_rows(&output))
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

/// Reads the visible screen of the followed agent's pane, as rows of text.
#[tauri::command]
pub async fn herdr_agent_screen(
    state: tauri::State<'_, ssh::AppState>,
    session_id: String,
    target: StockTarget,
    access: AccessLease,
) -> ssh::AccessResult<Vec<String>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            screen(&session, &access, &target).await
        })
        .await
}

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
        // A dialog answer is the keys a person presses, named the way Herdr names them.
        for (input, keys) in [
            (Input::Select { option: 3, of: 4 }, "3"),
            (Input::Submit { of: 2 }, "down down down enter"),
            (
                Input::Pick {
                    rows: 2,
                    enter: false,
                },
                "down down",
            ),
            (
                Input::Pick {
                    rows: -1,
                    enter: true,
                },
                "up enter",
            ),
            (
                Input::Pick {
                    rows: 0,
                    enter: true,
                },
                "enter",
            ),
        ] {
            assert_eq!(
                command(&target(), &input).unwrap(),
                format!("herdr --session 'it'\\''s' agent send-keys 'w2E:pF' {keys}")
            );
        }
        assert_eq!(
            command(&target(), &Input::SendLong { text: "x".into() }),
            None
        );
        assert_eq!(command(&target(), &Input::CycleMode {}), None);
    }
    #[test]
    fn a_screen_read_is_bounded_text_without_control_characters() {
        assert_eq!(
            screen_rows("  Pick one\n\u{1b}[31mred\u{7}\n› 1. Yes\n"),
            ["  Pick one", " [31mred ", "› 1. Yes"]
        );
        let long = format!("{}\n", "x".repeat(SCREEN_COLUMNS + 50)).repeat(SCREEN_ROWS + 20);
        let rows = screen_rows(&long);
        assert_eq!(rows.len(), SCREEN_ROWS);
        assert!(rows.iter().all(|row| row.chars().count() == SCREEN_COLUMNS));
        assert!(screen_rows("").is_empty());
    }
    #[test]
    fn a_typed_answer_is_one_literal_line_and_its_enter_never_a_prompt() {
        // `agent prompt` refuses an agent that waits for an answer, so the line goes to the pane as literal text with its carriage return.
        assert_eq!(
            command(
                &target(),
                &Input::Type {
                    text: "-x it's $(no)".into()
                }
            )
            .unwrap(),
            "herdr --session 'it'\\''s' pane send-text 'w2E:pF' '-x it'\\''s $(no)\r'"
        );
        // One line only: a line break, a tab, an escape or nothing at all is not an answer.
        for text in [
            "",
            "two\nlines",
            "tab\there",
            "\u{1b}[A",
            "nul\0",
            &"x".repeat(1001),
        ] {
            assert!(
                Input::Type { text: text.into() }.validate().is_err(),
                "{text:?}"
            );
        }
        assert!(Input::Type {
            text: "x".repeat(1000)
        }
        .validate()
        .is_ok());
        assert!(serde_json::from_str::<Input>(r#"{"kind":"type","text":"Green"}"#).is_ok());
    }
    #[test]
    fn a_dialog_answer_outside_its_bounds_is_never_a_command() {
        // The host refuses what no dialog takes before it is a key: this is what `deliver` checks.
        for input in [
            Input::Select { option: 4, of: 3 },
            Input::Select { option: 1, of: 10 },
            Input::Submit { of: 9 },
            Input::Pick {
                rows: 31,
                enter: true,
            },
            Input::Pick {
                rows: 0,
                enter: false,
            },
        ] {
            assert!(input.validate().is_err());
        }
    }
    /// The commands this module generates, run against a real private Herdr server (its own HOME and socket, never the user's server) whose
    /// pane runs a program named `codex` that writes every byte it reads to a file. Skipped where `herdr` is not on PATH.
    #[test]
    fn a_dialog_answer_reaches_a_real_herdr_pane_as_the_bytes_a_person_types() {
        use std::{process::Command, time::Duration};
        let Ok(found) = Command::new("sh").args(["-c", "command -v herdr"]).output() else {
            return;
        };
        let herdr = String::from_utf8_lossy(&found.stdout).trim().to_owned();
        if herdr.is_empty() {
            eprintln!("herdr is not available; skipped");
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let home = root.path().to_str().unwrap().to_owned();
        let path = std::env::var("PATH").unwrap_or_default();
        // A clean environment: nothing of the caller's HERDR_* variables can point this test at a live server.
        let environment = |command: &mut Command| {
            command.env_clear().envs([
                (
                    "PATH",
                    format!(
                        "{}:{path}",
                        std::path::Path::new(&herdr).parent().unwrap().display()
                    ),
                ),
                ("HOME", home.clone()),
                ("XDG_CONFIG_HOME", home.clone()),
                ("HERDR_SOCKET_PATH", format!("{home}/herdr.sock")),
            ]);
        };
        let run = |script: &str| {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            environment(&mut command);
            command.output().unwrap()
        };
        std::fs::create_dir_all(format!("{home}/herdr")).unwrap();
        std::fs::write(
            format!("{home}/herdr/config.toml"),
            "onboarding = false\n[terminal]\ndefault_shell = '/bin/sh'\nshell_mode = 'non_login'\n[update]\nversion_check = false\nmanifest_check = false\n",
        )
        .unwrap();
        std::fs::create_dir_all(format!("{home}/bin")).unwrap();
        std::os::unix::fs::symlink("/bin/cat", format!("{home}/bin/codex")).unwrap();
        let mut server = Command::new("herdr");
        server.args(["--session", "real", "server"]);
        environment(&mut server);
        let mut child = server
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        // The private server stops with the test, even when an assertion fails.
        struct Stop<F: FnMut()>(F);
        impl<F: FnMut()> Drop for Stop<F> {
            fn drop(&mut self) {
                (self.0)();
            }
        }
        let _stop = Stop(|| {
            let _ = child.kill();
            let _ = child.wait();
        });
        let snapshot = || {
            serde_json::from_slice::<serde_json::Value>(
                &run("herdr --session real api snapshot").stdout,
            )
            .ok()
        };
        let wait = |ready: &dyn Fn() -> bool| {
            for _ in 0..100 {
                if ready() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            false
        };
        assert!(
            wait(&|| snapshot().is_some()),
            "the private Herdr server did not start"
        );
        let created: serde_json::Value = serde_json::from_slice(
            &run(&format!(
                "herdr --session real workspace create --cwd {home}"
            ))
            .stdout,
        )
        .unwrap();
        let pane = created["result"]["root_pane"]["pane_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let bytes = format!("{home}/bytes");
        run(&format!(
            "herdr --session real pane run {pane} 'stty raw -echo; exec {home}/bin/codex > {bytes}'"
        ));
        assert!(
            wait(
                &|| snapshot().is_some_and(|value| value["result"]["snapshot"]["agents"]
                    .as_array()
                    .is_some_and(|agents| agents.iter().any(|agent| agent["pane_id"]
                        == pane.as_str()
                        && agent["agent"] == "codex")))
            ),
            "Herdr did not detect the stand-in agent"
        );
        let target = StockTarget {
            herdr_session: "real".into(),
            pane: pane.clone(),
            terminal: "term".into(),
            agent: "codex".into(),
            agent_session_id: "12345678-1234-4234-8234-123456789abc".into(),
        };
        let received = |expected: &str| {
            wait(&|| {
                std::fs::read(&bytes).is_ok_and(|read| {
                    read.iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<Vec<_>>()
                        .join(" ")
                        == expected
                })
            })
        };
        for (input, expected) in [
            (
                Input::Pick {
                    rows: 2,
                    enter: false,
                },
                "1b 5b 42 1b 5b 42",
            ),
            (
                Input::Pick {
                    rows: 0,
                    enter: true,
                },
                "1b 5b 42 1b 5b 42 0d",
            ),
            (
                Input::Select { option: 2, of: 3 },
                "1b 5b 42 1b 5b 42 0d 32",
            ),
            (
                Input::Type {
                    text: "-x it's".into(),
                },
                "1b 5b 42 1b 5b 42 0d 32 2d 78 20 69 74 27 73 0d",
            ),
        ] {
            let sent = run(&command(&target, &input).unwrap());
            assert!(
                sent.status.success(),
                "{}",
                String::from_utf8_lossy(&sent.stderr)
            );
            assert!(received(expected), "the keys did not arrive as {expected}");
        }
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
